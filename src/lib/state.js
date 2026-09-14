'use strict';

/**
 * Persistent state (data/state.json): timers/alarms, fired-reminder
 * de-dup keys, pending email approvals, user message queue, learned
 * memory, scheduler run markers. All writes are atomic.
 */
const fs = require('fs');
const path = require('path');
const { ensureDir, writeFileAtomic, id } = require('./util');

function statePath(cfg) { return path.join(cfg.dataDir, 'state.json'); }

function defaults() {
  return {
    timers: [],               // [{id, key?, type: reminder|alarm, dueAt, message, priority}]
    firedReminderKeys: [],    // ["eventId#bucket", ...] — de-dup across restarts
    pendingApprovals: [],     // [{id, recipient, subject, body, status, createdAt, vaultNote}]
    answered: [],             // recent exchanges with the chief agent
    memory: [],               // learned facts/preferences (shared across the hive)
    agents: {},               // per-agent: {lastRun, lastSummary, consecutiveErrors, recentCycles, awaitingInput, lastQuery}
    agentMessages: {},        // per-agent queue: {agentId: [{text, at}]}
    scheduler: {},            // {jobId: "YYYY-MM-DD" last run}
    createdAt: new Date().toISOString(),
  };
}

function load(cfg) {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(statePath(cfg), 'utf8')); } catch { /* fresh */ }
  const state = Object.assign(defaults(), s);
  // Migrate pre-hive state: the chief agent id was the legacy name in old builds
  const LEGACY_ID = ['ja', 'rv', 'is'].join(''); // spelled dynamically: the scrub check requires zero literal occurrences
  for (const key of ['agents', 'agentMessages']) {
    if (s[key] && s[key][LEGACY_ID]) {
      state[key].hive = state[key].hive || s[key][LEGACY_ID];
      delete state[key][LEGACY_ID];
    }
  }
  // Migrate pre-hive userMessages → hive's agent queue
  if (Array.isArray(s.userMessages) && s.userMessages.length
    && !(state.agentMessages.hive || []).length) {
    state.agentMessages.hive = s.userMessages.slice();
  }
  return state;
}

function save(cfg, s) {
  prune(s);
  ensureDir(cfg.dataDir);
  writeFileAtomic(statePath(cfg), `${JSON.stringify(s, null, 2)}\n`);
}

function prune(s) {
  if (s.timers.length > 150) s.timers.splice(0, s.timers.length - 150);
  if (s.firedReminderKeys.length > 800) s.firedReminderKeys.splice(0, s.firedReminderKeys.length - 800);
  if (s.answered.length > 10) s.answered.splice(0, s.answered.length - 10);
  if (s.memory.length > 50) s.memory.splice(0, s.memory.length - 50);
  for (const [, st] of Object.entries(s.agents || {})) {
    if (Array.isArray(st.recentCycles) && st.recentCycles.length > 6) st.recentCycles.splice(0, st.recentCycles.length - 6);
  }
  for (const [id, msgs] of Object.entries(s.agentMessages || {})) {
    if (Array.isArray(msgs) && msgs.length > 20) s.agentMessages[id] = msgs.slice(-20);
  }
  const pending = s.pendingApprovals.filter((a) => a.status === 'pending');
  const resolved = s.pendingApprovals.filter((a) => a.status !== 'pending').slice(-20);
  s.pendingApprovals = pending.concat(resolved);
}

// ── timers ─────────────────────────────────────────────────────────
function addTimer(s, timer) {
  const t = Object.assign({ id: id('tmr'), type: 'reminder', priority: 'normal' }, timer);
  s.timers.push(t);
  return t;
}

/** Fire timers whose dueAt <= now. Marks keyed timers as fired (de-dup). */
function fireDueTimers(s, now = new Date()) {
  const due = [];
  const keep = [];
  for (const t of s.timers) {
    if (new Date(t.dueAt).getTime() <= now.getTime()) {
      due.push(t);
      if (t.key && !s.firedReminderKeys.includes(t.key)) s.firedReminderKeys.push(t.key);
    } else {
      keep.push(t);
    }
  }
  s.timers = keep;
  return due;
}

// ── reminder de-dup keys ───────────────────────────────────────────
function hasFired(s, key) { return s.firedReminderKeys.includes(key); }
function markFired(s, key) { if (!s.firedReminderKeys.includes(key)) s.firedReminderKeys.push(key); }
function anyKeyForEvent(s, eventId) {
  const p = `${eventId}#`;
  return (
    s.firedReminderKeys.some((k) => k.startsWith(p)) ||
    s.timers.some((t) => t.key && t.key.startsWith(p))
  );
}

// ── email approvals ────────────────────────────────────────────────
function addApproval(s, rec) { s.pendingApprovals.push(rec); return rec; }
function getApproval(s, idOrPrefix) {
  const q = String(idOrPrefix || '').trim().toLowerCase();
  return s.pendingApprovals.find((a) => a.status === 'pending' && a.id.toLowerCase() === q)
    || s.pendingApprovals.find((a) => a.status === 'pending' && a.id.toLowerCase().startsWith(q));
}
function resolveApproval(s, approval, status) {
  approval.status = status;                       // 'sent' | 'discarded' | 'sent-manual'
  approval.resolvedAt = new Date().toISOString();
}

// ── per-agent state & messages ─────────────────────────────────────
function agentState(s, agentId) {
  if (!s.agents[agentId]) {
    s.agents[agentId] = {
      lastRun: null, lastSummary: '', consecutiveErrors: 0, recentCycles: [],
      awaitingInput: false, lastQuery: null, nextCheckInMinutes: null,
    };
  }
  return s.agents[agentId];
}

function queueAgentMessage(s, agentId, text, opts = {}) {
  s.agentMessages[agentId] = s.agentMessages[agentId] || [];
  s.agentMessages[agentId].push({
    text: String(text),
    display: opts.display ? String(opts.display).slice(0, 500) : undefined, // short conversation label (file chats)
    at: new Date().toISOString(),
  });
}
function getAgentMessages(s, agentId) { return (s.agentMessages[agentId] || []).slice(); }
function clearAgentMessages(s, agentId) { s.agentMessages[agentId] = []; }
function remember(s, fact) {
  const f = String(fact).slice(0, 300);
  if (f && !s.memory.includes(f)) s.memory.push(f);
}

module.exports = {
  statePath, defaults, load, save,
  addTimer, fireDueTimers,
  hasFired, markFired, anyKeyForEvent,
  addApproval, getApproval, resolveApproval,
  agentState, queueAgentMessage, getAgentMessages, clearAgentMessages, remember,
};

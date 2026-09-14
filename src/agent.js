'use strict';

/**
 * HIVE agent core.
 *  - processDue(state): fast tick — fires timers/alarms, syncs calendar
 *    reminders, checks scheduled jobs (chief directives + observer
 *    check-ins). No AI involved. Mutates state.
 *  - runAgentCycle(agent, state): one brain cycle for ANY registered
 *    agent — chief (Hive), mentalist, observer, or project agents —
 *    each with its own prompt, context, and model.
 *  Every cycle is recorded to the central memory store (Observer hook).
 */
const logger = require('./lib/logger');
const notify = require('./lib/notify');
const stateLib = require('./lib/state');
const calendar = require('./context/calendar');
const obsidian = require('./context/obsidian');
const email = require('./context/email');
const system = require('./context/system');
const prompt = require('./prompt');
const llm = require('./lib/llm');
const executor = require('../modules/executor');
const mentalistRole = require('../modules/mentalist');
const observer = require('../modules/observer');
const scheduler = require('./scheduler');

/** Fast tick: fire what's due, sync reminders, check scheduled jobs. */
async function processDue(cfg, state) {
  const now = new Date();

  // 1) timers & alarms (LLM reminders, alarms, scheduled calendar reminders)
  const fired = stateLib.fireDueTimers(state, now);
  for (const t of fired) {
    notify.notify(cfg, {
      title: t.type === 'alarm' ? '⏰ Alarm' : '🔔 Reminder',
      message: t.message,
      priority: t.priority,
    });
    observer.recordEvent(cfg, { type: 'notification', source: 'timers', text: t.message, tags: [t.type] });
  }

  // 2) deterministic calendar reminders
  let reminders = { immediate: [], scheduled: 0 };
  try {
    const events = await calendar.getEvents(cfg);
    reminders = calendar.syncEventReminders(events, now, state);
    for (const r of reminders.immediate) {
      notify.notify(cfg, { title: '🔔 Upcoming', message: r.message, priority: r.priority });
      observer.recordEvent(cfg, { type: 'notification', source: 'calendar', text: r.message, tags: ['reminder'] });
    }
    if (reminders.scheduled) {
      logger.info(`scheduled ${reminders.scheduled} calendar reminder(s) for upcoming events`);
    }
  } catch (e) {
    logger.warn(`calendar sync failed: ${e.message}`);
  }

  // 3) scheduled jobs → {module: 'chief'|'observer', directive, label}
  const job = scheduler.checkJobs(cfg, state, now);
  return { firedTimers: fired, reminders, job };
}

/** Is this agent due for a brain cycle? (interval or AI-set next check-in) */
function agentDue(agent, state, now = new Date()) {
  const st = stateLib.agentState(state, agent.id);
  const last = st.lastRun ? Date.parse(st.lastRun) : 0;
  if (!last) return true;
  const interval = (st.nextCheckInMinutes || agent.interval_minutes) * 60000;
  return (now.getTime() - last) >= Math.max(interval, 60000); // ≥1 min between runs
}

/** Run one agent cycle. Never throws — failures are recorded in agent state. */
async function runAgentCycle(cfg, agent, state, opts = {}) {
  const st = stateLib.agentState(state, agent.id);
  try {
    let r;
    if (agent.role === 'mentalist') r = await runMentalist(cfg, agent, state, st, opts);
    else if (agent.role === 'observer') r = await runObserverSweep(cfg, agent, state, st, opts);
    else if (agent.role === 'project') r = await runProject(cfg, agent, state, st, opts);
    else r = await runChief(cfg, agent, state, st, opts);
    observer.recordEvent(cfg, {
      type: 'cycle',
      source: agent.id,
      text: r.summary || `${agent.id} cycle complete`,
      tags: ['cycle', agent.role],
    });
    return r;
  } catch (e) {
    st.consecutiveErrors = (st.consecutiveErrors || 0) + 1;
    st.lastRun = new Date().toISOString();
    // escalating backoff: a dead provider must not burn cycles all night
    // (1st failure → retry in 5 min, then 15, then hourly)
    const backoff = [5, 15, 60];
    st.nextCheckInMinutes = backoff[Math.min(st.consecutiveErrors - 1, 2)];
    logger.error(`${agent.id} cycle failed: ${e.message}`);
    logger.vaultLog(cfg, `${agent.id} (${agent.role}) cycle FAILED — ${e.message}`, 'error');
    if (st.consecutiveErrors === 3) {
      notify.notify(cfg, {
        title: 'Hive problem',
        message: `${agent.name} failed 3 times in a row — check Agent_Logs and the console.`,
        priority: 'high',
      });
    }
    return { ok: false, agent, error: e.message };
  }
}

// ── chief (the Hive voice) ──────────────────────────────────────────
async function runChief(cfg, agent, state, st, opts) {
  const now = new Date();
  const [events, vaultSummary, emails, sys] = await Promise.all([
    calendar.getEvents(cfg).catch(() => []),
    cfg.vaultPath
      ? Promise.resolve(obsidian.summarizeVault(cfg.vaultPath, Math.floor(cfg.maxContextChars / 2)))
      : Promise.resolve(null),
    email.getUnread(cfg).catch(() => []),
    system.status().catch(() => null),
  ]);

  const userMessages = stateLib.getAgentMessages(state, agent.id);
  const userMessage = prompt.buildContextMessage({
    now, events, vaultSummary, emails, sys,
    state: { memory: state.memory, recentCycles: st.recentCycles },
    directive: opts.directive,
    userMessages,
  });

  const result = await llm.askAgent(cfg, {
    system: prompt.buildSystemPrompt(cfg),
    user: userMessage,
    model: agent.model || undefined,
    meta: { agent, directive: opts.directive, events, userMessages, vaultSummary, now },
  });

  const executed = await executor.executeActions(cfg, state, result.actions, agent);

  if (userMessages.length) {
    const lastMsg = userMessages[userMessages.length - 1];
    state.answered.push({
      text: lastMsg.display || lastMsg.text, // display keeps file extractions out of the chat history
      reply: result.summary,
      at: now.toISOString(),
    });
    stateLib.clearAgentMessages(state, agent.id);
  }
  const q = result.actions.find((a) => a && a.type === 'query');
  st.awaitingInput = result.status === 'awaiting_input';
  st.lastQuery = q ? String(q.question) : (st.awaitingInput ? result.summary : null);
  finishCycle(cfg, agent, st, result, executed);
  return { ok: true, agent, summary: result.summary, result, executed, nextCheckInMinutes: result.next_check_in_minutes };
}

// ── project agents ──────────────────────────────────────────────────
function buildProjectContext(cfg, agent, state, st, userMessages) {
  const now = new Date();
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const lines = [];
  lines.push(`CURRENT TIME: ${days[now.getDay()]} ${now.toLocaleString()} (local)`);
  lines.push(`YOUR TERRITORY: ${agent.focus || 'the whole vault'}`);
  lines.push('');
  lines.push('VAULT SUMMARY (your focus folder):');
  const summary = cfg.vaultPath
    ? obsidian.summarizeVault(cfg.vaultPath, Math.floor(cfg.maxContextChars / 2), { focus: agent.focus })
    : null;
  lines.push(summary && summary.text ? summary.text : '(nothing in your territory yet — a fresh start)');
  lines.push('');
  if (state.memory && state.memory.length) {
    lines.push(`LEARNED PREFERENCES (${state.memory.length}):`);
    state.memory.slice(-10).forEach((m) => lines.push(`- ${m}`));
    lines.push('');
  }
  if (st.recentCycles && st.recentCycles.length) {
    lines.push('YOUR RECENT CYCLES (do not repeat yourself):');
    st.recentCycles.slice(-4).forEach((c) => lines.push(`- ${c}`));
    lines.push('');
  }
  if (userMessages.length) {
    lines.push('MESSAGES FROM THE USER (respond to these first):');
    userMessages.forEach((m) => lines.push(`- "${m.text}"`));
    lines.push('');
  }
  lines.push('What should you do right now? Respond with your JSON action plan only.');
  return lines.join('\n');
}

async function runProject(cfg, agent, state, st, opts) {
  const now = new Date();
  const userMessages = stateLib.getAgentMessages(state, agent.id);
  const user = buildProjectContext(cfg, agent, state, st, userMessages);

  const result = await llm.askAgent(cfg, {
    system: prompt.buildProjectPrompt(cfg, agent),
    user,
    model: agent.model || undefined,
    meta: { agent, userMessages, now },
  });

  const executed = await executor.executeActions(cfg, state, result.actions, agent);
  if (userMessages.length) stateLib.clearAgentMessages(state, agent.id);
  const q = result.actions.find((a) => a && a.type === 'query');
  st.awaitingInput = result.status === 'awaiting_input';
  st.lastQuery = q ? String(q.question) : (st.awaitingInput ? result.summary : null);
  finishCycle(cfg, agent, st, result, executed);
  return { ok: true, agent, summary: result.summary, result, executed, nextCheckInMinutes: result.next_check_in_minutes };
}

// ── mentalist ───────────────────────────────────────────────────────
async function runMentalist(cfg, agent, state, st, opts) {
  const msgs = stateLib.getAgentMessages(state, agent.id);
  const query = msgs.length ? msgs[msgs.length - 1].text : (opts.query || mentalistRole.DEFAULT_QUERY);
  if (msgs.length) stateLib.clearAgentMessages(state, agent.id);
  const r = await mentalistRole.runCycle(cfg, agent, state, { query, extraContext: opts.extraContext });
  return {
    ok: true,
    agent,
    summary: r.summary,
    questions: r.questions,
    executed: r.files.map((f) => ({ ok: true, type: 'mentalist_note', detail: f })),
    nextCheckInMinutes: agent.interval_minutes,
  };
}

// ── observer (pattern sweep as an agent cycle) ──────────────────────
async function runObserverSweep(cfg, agent, state, st, opts) {
  const msgs = stateLib.getAgentMessages(state, agent.id);
  if (msgs.length) {
    // messages sent directly to the observer are captures, not sweeps
    const r = await observer.capture(cfg, state, msgs[msgs.length - 1].text);
    stateLib.clearAgentMessages(state, agent.id);
    return {
      ok: r.ok,
      agent,
      summary: r.ok ? `Captured a ${r.entry.type} to memory` : (r.error || 'capture failed'),
      executed: (r.files || []).map((f) => ({ ok: true, type: 'observer_memory', detail: f })),
      questions: r.questions || [],
      nextCheckInMinutes: agent.interval_minutes,
    };
  }
  const r = await observer.sweep(cfg, agent, state);
  st.consecutiveErrors = 0; // sweep() updates its own lastRun/lastSummary — clear any error streak here
  return {
    ok: r.ok,
    agent,
    summary: r.summary,
    executed: [],
    nextCheckInMinutes: agent.interval_minutes,
  };
}

// ── shared bookkeeping ──────────────────────────────────────────────
function finishCycle(cfg, agent, st, result, executed) {
  const clock = new Date().toTimeString().slice(0, 5);
  st.lastRun = new Date().toISOString();
  st.lastSummary = result.summary;
  st.nextCheckInMinutes = result.next_check_in_minutes;
  st.consecutiveErrors = 0;
  st.recentCycles.push(`${clock} — ${result.summary}`);
  const okCount = executed.filter((e) => e.ok).length;
  logger.vaultLog(cfg, `🧠 ${agent.id} (${agent.role}) — ${result.summary} — ${okCount}/${executed.length} actions ok`);
}

module.exports = { processDue, runAgentCycle, agentDue };

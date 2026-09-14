'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const stateLib = require('../src/lib/state');

function tmpCfg() {
  return { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hive-state-')) };
}

test('state save/load round-trips with defaults merged', () => {
  const cfg = tmpCfg();
  const s = stateLib.load(cfg);
  s.memory.push('likes tea');
  stateLib.addTimer(s, { type: 'alarm', dueAt: new Date().toISOString(), message: 'wake' });
  stateLib.agentState(s, 'mentalist').lastSummary = 'asked 3 questions';
  stateLib.queueAgentMessage(s, 'hive', 'hello');
  stateLib.save(cfg, s);

  const s2 = stateLib.load(cfg);
  assert.deepEqual(s2.memory, ['likes tea']);
  assert.equal(s2.timers.length, 1);
  assert.equal(s2.timers[0].message, 'wake');
  assert.equal(s2.agents.mentalist.lastSummary, 'asked 3 questions');
  assert.equal(s2.agentMessages.hive.length, 1);
  assert.deepEqual(stateLib.getAgentMessages(s2, 'startup'), []); // default intact for unknown agents
});

test('approvals: add, find by prefix, resolve', () => {
  const s = stateLib.defaults();
  stateLib.addApproval(s, { id: 'eml-abc123', recipient: 'a@b.c', subject: 'Hi', status: 'pending' });
  const found = stateLib.getApproval(s, 'eml-ab');
  assert.ok(found);
  stateLib.resolveApproval(s, found, 'sent');
  assert.equal(found.status, 'sent');
  assert.ok(found.resolvedAt);
  assert.equal(stateLib.getApproval(s, 'eml'), undefined); // no longer pending
});

test('agent message queues (per-agent isolation)', () => {
  const s = stateLib.defaults();
  stateLib.queueAgentMessage(s, 'hive', 'hello');
  stateLib.queueAgentMessage(s, 'hive', 'again');
  stateLib.queueAgentMessage(s, 'mentalist', 'analyze my patterns');
  assert.equal(stateLib.getAgentMessages(s, 'hive').length, 2);
  assert.equal(stateLib.getAgentMessages(s, 'mentalist').length, 1);
  stateLib.clearAgentMessages(s, 'hive');
  assert.equal(stateLib.getAgentMessages(s, 'hive').length, 0);
  assert.equal(stateLib.getAgentMessages(s, 'mentalist').length, 1); // untouched
});

test('agentState creates per-agent slots on demand', () => {
  const s = stateLib.defaults();
  const st = stateLib.agentState(s, 'mentalist');
  st.lastSummary = '3 questions asked';
  assert.equal(s.agents.mentalist.lastSummary, '3 questions asked');
  assert.equal(stateLib.agentState(s, 'startup').consecutiveErrors, 0);
});

test('scheduler: jobs fire once per occurrence and catch up when missed', () => {
  const scheduler = require('../src/scheduler');
  const cfg = { dailyBriefTime: '07:00', weeklyPlanTime: '08:00', weeklySummaryTime: '16:00', hsChecklistTime: '09:00' };
  const s = stateLib.defaults();

  const drain = (now, max = 14) => {
    const out = [];
    for (let i = 0; i < max; i++) {
      const job = scheduler.checkJobs(cfg, s, now);
      if (!job) break;
      out.push(`${job.module}:${job.directive}`);
    }
    return out;
  };

  // Monday Sep 14 2026, 09:00 — laptop was off all weekend: the four chief
  // jobs catch up (registry order), then the six daily observer check-ins.
  const monday9 = new Date(2026, 8, 14, 9, 0);
  assert.deepEqual(drain(monday9), [
    'chief:daily_brief', 'chief:weekly_plan', 'chief:weekly_summary', 'chief:hs_checklist',
    'observer:observer_checkin', 'observer:observer_checkin', 'observer:observer_checkin',
    'observer:observer_checkin', 'observer:observer_checkin', 'observer:observer_checkin',
  ]);

  // Tuesday 09:00 → daily brief + the six observer check-ins
  const tue9 = new Date(2026, 8, 15, 9, 0);
  const tuesday = drain(tue9);
  assert.equal(tuesday[0], 'chief:daily_brief');
  assert.equal(tuesday.filter((x) => x === 'observer:observer_checkin').length, 6);
  assert.equal(tuesday.length, 7);

  // Friday 17:00 → weekly summary + H&S return alongside the dailies
  const fri17 = new Date(2026, 8, 18, 17, 0);
  const friday = drain(fri17);
  assert.ok(friday.includes('chief:weekly_summary'));
  assert.ok(friday.includes('chief:hs_checklist'));
  assert.equal(friday.filter((x) => x === 'observer:observer_checkin').length, 6);
});

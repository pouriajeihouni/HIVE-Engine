'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const web = require('../src/web/publisher');
const { ensureDir, todayStr } = require('../src/lib/util');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'hive-web-')); }
// fixed "now" for deterministic dates in files AND in the snapshot call
const T0 = new Date('2026-09-13T21:00:00.000Z');
const T0_DATE = todayStr(T0);

function makeCfg(overrides = {}) {
  const root = tmpDir();
  const vault = path.join(root, 'vault');
  ensureDir(path.join(vault, 'Daily'));
  ensureDir(path.join(vault, 'Hive', 'mentalist', 'daily_analysis'));
  fs.writeFileSync(path.join(vault, `Daily/${T0_DATE}.md`),
    '---\ncreated: today\n---\n# Daily\n\n**Good evening!** Tomorrow: 9:30 AM Jane St.\n');
  fs.writeFileSync(path.join(vault, 'Hive/mentalist/precision_questions.md'),
    '# Precision Questions\n\n- **What is TPH specifically?** referenced but never named.\n');
  fs.writeFileSync(path.join(vault, `Hive/mentalist/daily_analysis/${T0_DATE}.md`), '## Analysis\nDetails look thin.\n');
  return Object.assign({
    root,
    vaultPath: vault,
    mockMode: true,
    calendarSource: 'local', // no google/apple in unit tests
    webPublish: { dir: path.join(root, 'web-publish'), minMinutes: 5 },
  }, overrides);
}

function makeState() {
  return {
    timers: [
      { id: 't2', type: 'reminder', dueAt: '2026-09-14T12:00:00.000Z', message: 'later', priority: 'normal' },
      { id: 't1', type: 'reminder', dueAt: '2026-09-14T10:00:00.000Z', message: 'first', priority: 'urgent' },
      { id: 'x', type: 'other', dueAt: '2026-09-14T09:00:00.000Z', message: 'not a reminder' },
    ],
    answered: [{ text: 'remind me to email the prof', reply: 'queued', at: '2026-09-13T20:00:00.000Z' }],
    agents: { hive: { lastRun: '2026-09-13T20:30:00.000Z', lastSummary: 'brief delivered', consecutiveErrors: 0, recentCycles: ['c1'], awaitingInput: true, lastQuery: 'class times?' } },
    agentMessages: {},
    firedReminderKeys: [],
    memory: {},
    scheduler: {},
  };
}

test('collectSnapshot builds a full, guarded snapshot', async () => {
  const cfg = makeCfg();
  const agents = [{ id: 'hive', name: 'Hive', role: 'chief', enabled: true, model: null },
                  { id: 'mentalist', name: 'Mentalist', role: 'mentalist', enabled: true, model: null }];
  const snap = await web.collectSnapshot(cfg, makeState(), agents, { now: new Date('2026-09-13T21:00:00.000Z') });

  assert.equal(snap.schema, 1);
  assert.equal(snap.engine.mode, 'mock');
  assert.match(snap.today.brief_md, /Good evening/);      // frontmatter stripped
  assert.ok(!snap.today.brief_md.includes('created'));
  assert.match(snap.mentalist.questions_md, /What is TPH/);
  assert.equal(snap.mentalist.analysis_md, '## Analysis\nDetails look thin.\n');
  assert.deepEqual(snap.reminders.map((r) => r.message), ['first', 'later']); // sorted, non-reminders filtered
  assert.equal(snap.reminders[0].priority, 'urgent');
  assert.equal(snap.conversation[0].you, 'remind me to email the prof');
  assert.equal(snap.agents[0].lastQuery, 'class times?');
  assert.ok(snap.agents[0].awaitingInput);
  assert.deepEqual(snap.events, []);                       // local calendar missing → empty, no throw
  assert.ok(snap.observer && Array.isArray(snap.observer.recent));
});

test('collectSnapshot tolerates a missing vault entirely', async () => {
  const cfg = makeCfg({ vaultPath: '' });
  const snap = await web.collectSnapshot(cfg, makeState(), [], { now: new Date() });
  assert.equal(snap.today.brief_md, null);
  assert.equal(snap.mentalist.questions_md, null);
});

function gitStub(calls) {
  return (dir, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'diff') return Promise.reject(new Error('exit 1 (changes staged)'));
    return Promise.resolve('');
  };
}

test('maybePublish: publish → skip-unchanged → rate-limit → publish after window', async () => {
  const cfg = makeCfg();
  fs.mkdirSync(path.join(cfg.webPublish.dir, '.git'), { recursive: true }); // pretend repo
  const calls = [];
  const runGit = gitStub(calls);
  const state = makeState();
  const t0 = new Date('2026-09-13T21:00:00.000Z');

  const r1 = await web.maybePublish(cfg, state, { runGit, now: t0 });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.ok(fs.existsSync(path.join(cfg.webPublish.dir, 'docs', 'data.json')));
  assert.ok(fs.existsSync(path.join(cfg.webPublish.dir, 'docs', 'index.html'))); // dashboard synced
  assert.match(calls.join('|'), /commit/);

  const r2 = await web.maybePublish(cfg, state, { runGit, now: t0 });
  assert.equal(r2.skipped, 'unchanged');

  state.answered.push({ text: 'new', reply: 'ok', at: t0.toISOString() });
  const t1 = new Date(t0.getTime() + 60000);
  const r3 = await web.maybePublish(cfg, state, { runGit, now: t1 });
  assert.equal(r3.skipped, 'rate-limited');                 // changed, but window not passed

  const t2 = new Date(t0.getTime() + 6 * 60000);
  const r4 = await web.maybePublish(cfg, state, { runGit, now: t2 });
  assert.equal(r4.ok, true);

  const r5 = await web.maybePublish(cfg, state, { runGit, now: t2, force: true });
  assert.equal(r5.ok, true);                               // force bypasses gates
});

test('maybePublish is a no-op when WEB_PUBLISH_DIR is unset', async () => {
  const cfg = makeCfg();
  cfg.webPublish.dir = null;
  const r = await web.maybePublish(cfg, makeState(), {});
  assert.equal(r.skipped, 'disabled');
});

test('maybePublish skips (no throw) when the dir is not a git repo', async () => {
  const cfg = makeCfg();
  const r = await web.maybePublish(cfg, makeState(), {});
  assert.equal(r.skipped, 'not-a-repo');
});

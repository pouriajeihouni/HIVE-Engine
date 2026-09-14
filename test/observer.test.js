'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const observer = require('../modules/observer');
const memoryStore = require('../core/memory-store');
const stateLib = require('../src/lib/state');
const obsidian = require('../src/context/obsidian');

function tmpCfg() {
  return {
    vaultPath: fs.mkdtempSync(path.join(os.tmpdir(), 'hive-observer-')),
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hive-observer-data-')),
    mockMode: true,
    notificationsEnabled: false,
  };
}

test('observer: capture writes memory entry + records to the store', async () => {
  const cfg = tmpCfg();
  const state = stateLib.defaults();
  const r = await observer.capture(cfg, state,
    'Just talked to Sam at TPH about the quoting template — he said "send it by Friday or the D365 sync breaks", seemed rushed, checked his phone twice.');
  assert.equal(r.ok, true);
  assert.equal(r.entry.type, 'conversation');
  assert.ok(r.entry.persons.some((p) => /sam/i.test(p)));
  // files: events/<today>, persons/sam, conversations/<today>
  assert.ok(r.files.some((f) => f.startsWith('Hive/memories/events/')));
  assert.ok(r.files.some((f) => f.startsWith('Hive/memories/persons/')));
  assert.ok(r.files.some((f) => f.startsWith('Hive/memories/conversations/')));
  assert.ok(fs.existsSync(path.join(cfg.vaultPath, 'Hive', 'memories', 'persons', 'sam.md')));
  // detailed (long + has a quote) → no nagging questions
  assert.equal(r.questions.length, 0);

  const store = memoryStore.load(cfg);
  assert.ok(store.observations.some((o) => o.type === 'memory' && o.text.includes('quoting template')));
});

test('observer: thin captures get precision questions (detail is the point)', async () => {
  const cfg = tmpCfg();
  const state = stateLib.defaults();
  const r = await observer.capture(cfg, state, 'Talked to Alex about the startup.');
  assert.equal(r.ok, true);
  assert.equal(r.entry.thin, true);
  assert.ok(r.questions.length >= 2);
  assert.ok(r.questions.some((q) => /exactly|word for word|EXACTLY/i.test(q)));
});

test('observer: check-in prompts are throttled (no spam after sleep-wake)', () => {
  const cfg = tmpCfg();
  const state = stateLib.defaults();
  const first = observer.checkIn(cfg, state, 'morning');
  assert.equal(first, true);
  const second = observer.checkIn(cfg, state, 'noon'); // within 3h → suppressed
  assert.equal(second, false);
});

test('observer: environment tick records vault deltas only', () => {
  const cfg = tmpCfg();
  const state = stateLib.defaults();
  obsidian.createNote(cfg.vaultPath, 'Notes/a', { title: 'A', content: 'x' });
  observer.onEnvironmentTick(cfg, state); // baseline
  observer.onEnvironmentTick(cfg, state); // no change → no observation
  let store = memoryStore.load(cfg);
  assert.equal(store.observations.filter((o) => o.type === 'environment').length, 0);

  obsidian.createNote(cfg.vaultPath, 'Notes/b', { title: 'B', content: 'y' });
  observer.onEnvironmentTick(cfg, state); // +1 note → one observation
  store = memoryStore.load(cfg);
  const env = store.observations.filter((o) => o.type === 'environment');
  assert.equal(env.length, 1);
  assert.match(env[0].text, /\+1 note/);
});

test('observer: sweep detects repeated-person patterns (mock heuristics)', async () => {
  const cfg = tmpCfg();
  const state = stateLib.defaults();
  const store = memoryStore.load(cfg);
  memoryStore.record(cfg, store, { type: 'memory', text: 'talked to Sam', tags: ['conversation', 'sam'] });
  memoryStore.record(cfg, store, { type: 'memory', text: 'Sam followed up', tags: ['conversation', 'sam'] });
  memoryStore.save(cfg, store);

  const agent = { id: 'observer', role: 'observer', interval_minutes: 360 };
  const r = await observer.sweep(cfg, agent, state);
  assert.equal(r.ok, true);
  assert.ok(r.patterns.some((p) => /sam/i.test(p)));
  assert.ok(fs.existsSync(path.join(cfg.vaultPath, 'Hive', 'memories', 'connections', 'pattern-analysis.md')));
});

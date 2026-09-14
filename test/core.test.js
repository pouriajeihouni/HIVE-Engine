'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const memoryStore = require('../core/memory-store');
const dispatcher = require('../core/dispatcher');

function tmpCfg() {
  return { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hive-core-')) };
}

test('memory store: record → persist → search round-trip', () => {
  const cfg = tmpCfg();
  const store = memoryStore.load(cfg);
  memoryStore.record(cfg, store, { type: 'memory', source: 'observer', text: 'Coffee with Sam — he said "the pricing model needs work"', tags: ['conversation', 'sam'] });
  memoryStore.record(cfg, store, { type: 'dispatch', source: 'dispatcher', text: 'search → knowledge: pricing', tags: ['dispatch'] });
  memoryStore.save(cfg, store);

  const back = memoryStore.load(cfg);
  assert.equal(back.observations.length, 2);
  const hits = memoryStore.search(back, 'pricing sam coffee');
  assert.ok(hits.length >= 1);
  assert.match(hits[0].text, /pricing|Sam/);
  assert.equal(memoryStore.recent(back, 5).length, 2);
});

test('memory store: prunes to the cap', () => {
  const cfg = tmpCfg();
  const store = memoryStore.load(cfg);
  for (let i = 0; i < 2100; i++) {
    memoryStore.record(cfg, store, { type: 'event', source: 'test', text: `obs ${i}` });
  }
  memoryStore.save(cfg, store);
  const back = memoryStore.load(cfg);
  assert.equal(back.observations.length, 2000);
  assert.match(back.observations[0].text, /obs 100$/); // oldest kept is #100
});

test('dispatcher: classifies the four intents', () => {
  assert.equal(dispatcher.classify('remind me to email the professor').module, 'executor');
  assert.equal(dispatcher.classify('create a note about the pricing system').module, 'executor');
  assert.equal(dispatcher.classify('find my notes about the pricing system').module, 'knowledge');
  assert.equal(dispatcher.classify('what did I write about ECON 2450?').module, 'knowledge');
  assert.equal(dispatcher.classify('why do I keep falling behind on problem sets?').module, 'mentalist');
  assert.equal(dispatcher.classify('analyze my patterns and contradictions').module, 'mentalist');
  assert.equal(dispatcher.classify('observe: just talked to Alex about the startup').module, 'observer');
  assert.equal(dispatcher.classify('remember this: Mobina said the timing might be wrong').module, 'observer');
  // question-shape catch-all + phrasing variants (regression: the "say" trap)
  assert.equal(dispatcher.classify('what do my notes say about TPH?').module, 'knowledge');
  assert.equal(dispatcher.classify('what is my name and position?').module, 'knowledge');
  assert.equal(dispatcher.classify('how does the pricing system work?').module, 'knowledge');
  assert.equal(dispatcher.classify('anything about the ZUND cutter?').module, 'knowledge');
  // real tasks still beat question phrasing
  assert.equal(dispatcher.classify('can you remind me to email the professor?').module, 'executor');
  assert.equal(dispatcher.classify('what is my name? create a note answering it').module, 'executor');
  // analyze beats search when both match
  assert.equal(dispatcher.classify('search for contradictions in my notes').module, 'mentalist');
});

test('dispatcher: routes end-to-end through the unified facade (mock brains)', async () => {
  const cfg = { ...require('../src/config'), dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hive-route-')), mockMode: true };
  const stateLib = require('../src/lib/state');
  const state = stateLib.load(cfg);

  // search route (empty vault → graceful)
  const r = await dispatcher.route(cfg, state, 'find my notes about pricing');
  assert.equal(r.module, 'knowledge');
  assert.ok(typeof r.reply === 'string' && r.reply.length > 0);

  // capture route
  const r2 = await dispatcher.route(cfg, state, 'observe: just talked to Sam about the quoting template — he said "send it by Friday"');
  assert.equal(r2.module, 'observer');
  assert.ok(r2.reply.includes('Captured'));

  // the dispatches were observed in the memory store
  const store = memoryStore.load(cfg);
  assert.ok(store.observations.some((o) => o.type === 'dispatch' && o.text.includes('capture')));
  assert.ok(store.observations.some((o) => o.type === 'memory'));
});

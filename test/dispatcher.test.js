'use strict';

/**
 * Unified-conversation + file-display tests for the dispatcher, and the
 * state/agent display-label plumbing. Uses the same light tmp cfg pattern
 * as core.test.js.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dispatcher = require('../core/dispatcher');
const stateLib = require('../src/lib/state');

function tmpCfg() {
  // same pattern as core.test.js: the real config (llm getter etc.) with a
  // scratch dataDir and deterministic mock brains
  return { ...require('../src/config'), dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hive-disp-')), mockMode: true };
}

test('unified conversation: knowledge-route exchanges are recorded to state.answered', async () => {
  const cfg = tmpCfg();
  const state = stateLib.defaults();
  const r = await dispatcher.route(cfg, state, 'find my notes about pricing');
  assert.strictEqual(r.module, 'knowledge');
  assert.ok(typeof r.reply === 'string' && r.reply.length > 0);
  assert.ok(state.answered.length >= 1, 'exchange recorded');
  const last = state.answered[state.answered.length - 1];
  assert.strictEqual(last.text, 'find my notes about pricing');
  assert.strictEqual(last.reply, r.reply);
  assert.ok(last.at);
});

test('unified conversation: observer-route exchanges are recorded too', async () => {
  const cfg = tmpCfg();
  const state = stateLib.defaults();
  const r = await dispatcher.route(cfg, state, 'observe: just talked to Sam about the quoting template — he said "send it by Friday"');
  assert.strictEqual(r.module, 'observer');
  assert.match(r.reply, /Captured/);
  assert.ok(state.answered.some((x) => x.text.includes('quoting template')));
});

test('unified conversation: displayYou overrides the recorded label (no extraction blobs)', async () => {
  const cfg = tmpCfg();
  const state = stateLib.defaults();
  await dispatcher.route(cfg, state, 'find my notes about pricing',
    { displayYou: 'summarize this 📎syllabus.pdf' });
  const last = state.answered[state.answered.length - 1];
  assert.strictEqual(last.text, 'summarize this 📎syllabus.pdf');
  assert.ok(!last.text.includes('find my notes')); // the full text did NOT leak into the record
});

test('unified conversation: answered stays capped at 10', async () => {
  const cfg = tmpCfg();
  const state = stateLib.defaults();
  for (let i = 0; i < 13; i++) {
    await dispatcher.route(cfg, state, `find number ${i}`);
  }
  assert.strictEqual(state.answered.length, 10);
  assert.match(state.answered[0].text, /find number 3$/); // oldest kept is #3
  assert.match(state.answered[9].text, /find number 12$/);
});

test('forced module: opts.module bypasses classification', async () => {
  const cfg = tmpCfg();
  const state = stateLib.defaults();
  // "what did I write" would classify as knowledge; force the executor path
  const r = await dispatcher.route(cfg, state, 'what did I write about pricing?', { module: 'executor' });
  assert.strictEqual(r.module, 'executor');
  assert.strictEqual(r.intent, 'direct');
});

test('queueAgentMessage: display label stored alongside the text', () => {
  const s = stateLib.defaults();
  stateLib.queueAgentMessage(s, 'chief', 'long message with an embedded extraction', { display: 'hi 📎a.pdf' });
  stateLib.queueAgentMessage(s, 'chief', 'plain message');
  const msgs = stateLib.getAgentMessages(s, 'chief');
  assert.strictEqual(msgs[0].display, 'hi 📎a.pdf');
  assert.strictEqual(msgs[0].text, 'long message with an embedded extraction');
  assert.strictEqual(msgs[1].display, undefined);
});

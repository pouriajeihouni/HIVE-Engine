'use strict';

/**
 * Telegram listener tests — two-way chat. Verifies: routing + reply, web
 * visibility (state.answered contract), offset persistence/dedupe, foreign
 * chat rejection, commands, rate limit, backlog cap, error resilience.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const listener = require('../src/lib/telegram-listener');

const MY_CHAT = 424242;
const CFG = { telegram: { token: '123456789:AAEtest-token-abcdef', chatId: String(MY_CHAT) } };

let uidSeq = 100;
const upd = (text, chatId = MY_CHAT) => ({ update_id: uidSeq++, message: { chat: { id: chatId }, from: { first_name: 'P' }, text, date: Math.floor(Date.now() / 1000) } });

/** fetch stub: routes by URL, records everything. */
function makeNet(updatesFn) {
  const calls = { sends: [], typings: 0, getUpdates: [] };
  const f = async (url, opts = {}) => {
    if (url.includes('/getUpdates')) {
      calls.getUpdates.push(String(url));
      const m = String(url).match(/offset=(\d+)/);
      const offset = m ? Number(m[1]) : 0;
      return { ok: true, json: async () => ({ ok: true, result: updatesFn().filter((u) => u.update_id >= offset) }) };
    }
    if (url.includes('/sendChatAction')) { calls.typings++; return { ok: true, json: async () => ({ ok: true }) }; }
    if (url.includes('/sendMessage')) {
      calls.sends.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: false, status: 404, json: async () => ({ ok: false }) };
  };
  return { f, calls };
}

/** deps with a dispatcher-like route that records into state.answered (the web contract). */
function webRoute(spy) {
  return async (cfg, state, text) => {
    const reply = 'echo:' + text;
    state.answered = state.answered || [];
    state.answered.push({ you: text, hive: reply, at: new Date().toISOString() });
    if (spy) spy.push(text);
    return { reply };
  };
}

const freshState = () => ({ scheduler: {} });

test('chat: routes the text, replies in Telegram, and lands in state.answered (web history)', async () => {
  const net = makeNet(() => [upd('what\'s my next class?')]);
  const routes = [];
  const state = freshState();
  const r = await listener.processUpdates(CFG, state, { deps: { route: webRoute(routes), fetch: net.f } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.processed, 1);
  assert.deepStrictEqual(routes, ["what's my next class?"]);
  assert.strictEqual(net.calls.sends.length, 1, 'one telegram reply');
  assert.match(net.calls.sends[0].body.text, /^echo:what's my next class\?$/);
  assert.strictEqual(net.calls.sends[0].body.chat_id, String(MY_CHAT));
  // THE WEB CONTRACT: the exchange is in the conversation the dashboard reads
  assert.strictEqual(state.answered.length, 1);
  assert.strictEqual(state.answered[0].hive, "echo:what's my next class?");
});

test('typing indicator fires before the (slow) route call', async () => {
  const net = makeNet(() => [upd('hello')]);
  const order = [];
  const route = async () => { order.push('route'); return { reply: 'r' }; };
  const f = async (url, opts) => {
    if (url.includes('sendChatAction')) order.push('typing');
    return net.f(url, opts);
  };
  await listener.processUpdates(CFG, freshState(), { deps: { route, fetch: f } });
  assert.deepStrictEqual(order, ['typing', 'route']);
  assert.strictEqual(net.calls.sends.length, 1);
});

test('offset: persisted in state, second poll passes offset=last+1 and dedupes', async () => {
  const batch = [upd('one'), upd('two')];
  const net = makeNet(() => batch);
  const state = freshState();
  await listener.processUpdates(CFG, state, { deps: { route: webRoute(), fetch: net.f } });
  const maxId = Math.max(batch[0].update_id, batch[1].update_id);
  assert.strictEqual(state.telegram.lastUpdateId, maxId);
  await listener.processUpdates(CFG, state, { deps: { route: webRoute(), fetch: net.f } });
  assert.match(net.calls.getUpdates[1], new RegExp('offset=' + (maxId + 1)), 'offset advanced');
  assert.strictEqual(net.calls.sends.length, 2, 'same batch not re-processed');
});

test('foreign chat: ignored and marked seen — no route, no reply', async () => {
  const net = makeNet(() => [upd('let me in', 999)]);
  const routes = [];
  const state = freshState();
  const r = await listener.processUpdates(CFG, state, { deps: { route: webRoute(routes), fetch: net.f } });
  assert.strictEqual(routes.length, 0);
  assert.strictEqual(net.calls.sends.length, 0);
  assert.ok(state.telegram.lastUpdateId > 0, 'marked seen so it never comes back');
  assert.strictEqual(r.processed, 0);
  assert.strictEqual(r.advanced, true);
});

test('/help: replies with the command list, never touches route', async () => {
  const net = makeNet(() => [upd('/help')]);
  const routes = [];
  await listener.processUpdates(CFG, freshState(), { deps: { route: webRoute(routes), fetch: net.f } });
  assert.strictEqual(routes.length, 0);
  assert.match(net.calls.sends[0].body.text, /You're chatting with Hive/);
  assert.match(net.calls.sends[0].body.text, /doctor/);
  assert.match(net.calls.sends[0].body.text, /provider/);
});

test('/doctor: runs the routine and reports back', async () => {
  const net = makeNet(() => [upd('/doctor')]);
  const doctors = [];
  await listener.processUpdates(CFG, freshState(), {
    deps: { route: webRoute(), doctor: async () => { doctors.push(1); return '✅ backups ok, 3 agents healthy'; }, fetch: net.f },
  });
  assert.strictEqual(doctors.length, 1);
  assert.match(net.calls.sends[0].body.text, /backups ok/);
});

test('/provider: hot-switches env + persists; invalid gets usage', async () => {
  const prev = process.env.LLM_PROVIDER;
  const persisted = [];
  const deps = (net) => ({
    route: webRoute(),
    persistProvider: (cfg, p) => { persisted.push(p); return true; },
    fetch: net.f,
  });
  // invalid
  let net = makeNet(() => [upd('/provider openai')]);
  await listener.processUpdates(CFG, freshState(), { deps: deps(net) });
  assert.match(net.calls.sends[0].body.text, /Usage: \/provider groq/);
  assert.strictEqual(persisted.length, 0);
  // valid
  net = makeNet(() => [upd('/provider anthropic')]);
  await listener.processUpdates(CFG, freshState(), { deps: deps(net) });
  assert.strictEqual(process.env.LLM_PROVIDER, 'anthropic');
  assert.deepStrictEqual(persisted, ['anthropic']);
  assert.match(net.calls.sends[0].body.text, /switched to anthropic/);
  if (prev === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = prev;
});

test('non-text message: gentle reply, marked seen', async () => {
  const net = makeNet(() => [{ update_id: uidSeq++, message: { chat: { id: MY_CHAT }, from: {}, date: Math.floor(Date.now() / 1000) } }]);
  const routes = [];
  const state = freshState();
  const r = await listener.processUpdates(CFG, state, { deps: { route: webRoute(routes), fetch: net.f } });
  assert.strictEqual(routes.length, 0);
  assert.match(net.calls.sends[0].body.text, /only read text/);
  assert.ok(state.telegram.lastUpdateId > 0);
  assert.strictEqual(r.processed, 1);
});

test('rate limit: 60 chats per hour, the 61st gets a polite refusal', async () => {
  const routes = [];
  const state = freshState();
  let sent = 0;
  // 6 polls × 10 updates = 60 chats
  for (let round = 0; round < 6; round++) {
    const batch = Array.from({ length: 10 }, (_, i) => upd('m' + round + '-' + i));
    const net = makeNet(() => batch);
    await listener.processUpdates(CFG, state, { deps: { route: webRoute(routes), fetch: net.f } });
    sent += net.calls.sends.length;
  }
  assert.strictEqual(routes.length, 60);
  assert.strictEqual(sent, 60);
  // 61st
  const net = makeNet(() => [upd('one more')]);
  const r = await listener.processUpdates(CFG, state, { deps: { route: webRoute(routes), fetch: net.f } });
  assert.strictEqual(routes.length, 60, '61st was not routed');
  assert.match(net.calls.sends[0].body.text, /faster than I can think/);
  assert.strictEqual(r.processed, 0);
});

test('backlog cap: 15 pending after downtime → 10 newest answered, all 15 marked seen', async () => {
  const batch = Array.from({ length: 15 }, (_, i) => upd('backlog ' + i));
  const net = makeNet(() => batch);
  const routes = [];
  const state = freshState();
  await listener.processUpdates(CFG, state, { deps: { route: webRoute(routes), fetch: net.f } });
  assert.strictEqual(routes.length, 10, 'only 10 answered');
  assert.deepStrictEqual(routes, Array.from({ length: 10 }, (_, i) => 'backlog ' + (5 + i)), 'the NEWEST 10, in order');
  assert.strictEqual(state.telegram.lastUpdateId, Math.max(...batch.map((b) => b.update_id)), 'older ones marked seen, never replayed');
});

test('resilience: getUpdates failure returns error without throwing; empty inbox is a no-op', async () => {
  const bad = async () => ({ ok: false, json: async () => ({ ok: false, description: 'conflict' }) });
  const r = await listener.processUpdates(CFG, freshState(), { deps: { route: webRoute(), fetch: bad } });
  assert.strictEqual(r.error !== undefined, true);
  const net = makeNet(() => []);
  const r2 = await listener.processUpdates(CFG, freshState(), { deps: { route: webRoute(), fetch: net.f } });
  assert.deepStrictEqual(r2, { ok: true, processed: 0, advanced: false });
  assert.strictEqual(net.calls.sends.length, 0);
});

test('unconfigured → skipped without any network call', async () => {
  let called = 0;
  const f = async () => { called++; return { ok: true, json: async () => ({ ok: true, result: [] }) }; };
  const r = await listener.processUpdates({ telegram: {} }, freshState(), { deps: { fetch: f } });
  assert.strictEqual(r.skipped, 'telegram-not-configured');
  assert.strictEqual(called, 0);
  assert.strictEqual(listener.ready({ telegram: {} }), false);
});

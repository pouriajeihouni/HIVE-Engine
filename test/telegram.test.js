'use strict';

/**
 * Telegram notification tests — extractChat parsing, sendMessage behavior
 * (ok / 429 retry / network error / unconfigured), the notify() integration,
 * hello(), and the setup script's env upsert.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const telegram = require('../src/lib/telegram');
const { notify } = require('../src/lib/notify');
const { upsertEnv } = require('../scripts/telegram-setup');

const CFG = { agentName: 'Hive', telegram: { token: '123456789:AAEtest-token-abcdef', chatId: '424242' } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('configured: true only with both token and chatId', () => {
  assert.strictEqual(telegram.configured(CFG), true);
  assert.strictEqual(telegram.configured({ telegram: { token: 'x' } }), false);
  assert.strictEqual(telegram.configured({ telegram: {} }), false);
  assert.strictEqual(telegram.configured({}), false);
});

test('extractChat: newest valid message wins; stale and junk skipped', () => {
  const updates = [
    { update_id: 1, message: { date: 1000, chat: { id: 111 }, from: { first_name: 'Old' } } },
    { update_id: 2, edited_message: { date: 2000, chat: { id: 222 }, from: { first_name: 'Ed' } } },
    { update_id: 3 }, // no message at all
    { update_id: 4, message: { date: 3000, chat: { id: 333 }, from: { first_name: 'New' } } },
  ];
  assert.deepStrictEqual(telegram.extractChat(updates, 0), { chatId: 333, firstName: 'New' });
  assert.deepStrictEqual(telegram.extractChat(updates, 2500), { chatId: 333, firstName: 'New' }, 'edited_message counts as usable');
  assert.deepStrictEqual(telegram.extractChat(updates, 3500), null, 'all older than minDate');
  assert.strictEqual(telegram.extractChat(null), null);
  assert.strictEqual(telegram.extractChat([]), null);
  assert.strictEqual(telegram.extractChat([{ message: { chat: {} } }]), null, 'chat without id');
});

test('sendMessage: posts to the bot API with chat_id + text', async () => {
  const calls = [];
  const f = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200 };
  };
  const ok = await telegram.sendMessage(CFG, 'hello phone', { fetch: f });
  assert.strictEqual(ok, true);
  assert.match(calls[0].url, /bot123456789:AAEtest-token-abcdef\/sendMessage$/);
  const body = JSON.parse(calls[0].opts.body);
  assert.strictEqual(body.chat_id, '424242');
  assert.strictEqual(body.text, 'hello phone');
  assert.match(calls[0].opts.headers['content-type'], /application\/json/);
});

test('sendMessage: 429 retries once then succeeds; hard failure returns false', async () => {
  let n = 0;
  const f = async () => { n++; return n === 1 ? { ok: false, status: 429 } : { ok: true, status: 200 }; };
  assert.strictEqual(await telegram.sendMessage(CFG, 'x', { fetch: f, retryDelayMs: 0 }), true);
  assert.strictEqual(n, 2);
  const f2 = async () => ({ ok: false, status: 400 });
  assert.strictEqual(await telegram.sendMessage(CFG, 'x', { fetch: f2 }), false);
  const f3 = async () => { throw new Error('offline'); };
  assert.strictEqual(await telegram.sendMessage(CFG, 'x', { fetch: f3 }), false, 'network error never throws');
});

test('sendMessage: unconfigured → false, no network call', async () => {
  let called = 0;
  const f = async () => { called++; return { ok: true, status: 200 }; };
  assert.strictEqual(await telegram.sendMessage({ telegram: {} }, 'x', { fetch: f }), false);
  assert.strictEqual(called, 0);
});

test('sendMessage: text capped at 4000 chars', async () => {
  let body = null;
  const f = async (u, opts) => { body = JSON.parse(opts.body); return { ok: true, status: 200 }; };
  await telegram.sendMessage(CFG, 'y'.repeat(9000), { fetch: f });
  assert.strictEqual(body.text.length, 4000);
});

test('notify(): fires a telegram send alongside the normal channels', async () => {
  const origFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; };
  try {
    notify({ ...CFG, vaultPath: null }, { title: 'Reminder', message: 'ECON in 15 min' });
    await sleep(50); // fire-and-forget path
    const tg = calls.find((c) => String(c.url).includes('api.telegram.org'));
    assert.ok(tg, 'telegram API was called');
    const body = JSON.parse(tg.opts.body);
    assert.strictEqual(body.chat_id, '424242');
    assert.match(body.text, /\[Reminder\].*ECON in 15 min/);
  } finally {
    global.fetch = origFetch;
  }
});

test('hello(): mentions Hive and online', async () => {
  let body = null;
  const f = async (u, opts) => { body = JSON.parse(opts.body); return { ok: true, status: 200 }; };
  await telegram.hello({ agentName: 'Hive', mockMode: false, telegram: CFG.telegram }, { fetch: f });
  assert.match(body.text, /Hive is online/);
});

test('upsertEnv: replaces existing keys, appends new ones, keeps the rest', () => {
  const before = '# comment\nFOO=bar\nTELEGRAM_BOT_TOKEN=old\n';
  let txt = upsertEnv(before, 'TELEGRAM_BOT_TOKEN', 'new-token');
  txt = upsertEnv(txt, 'TELEGRAM_CHAT_ID', '999');
  assert.match(txt, /# comment/);
  assert.match(txt, /FOO=bar/);
  assert.match(txt, /TELEGRAM_BOT_TOKEN=new-token/);
  assert.match(txt, /TELEGRAM_CHAT_ID=999/);
  assert.ok(!/old/.test(txt), 'old value gone');
  const lines = txt.trimEnd().split('\n');
  assert.strictEqual(lines.filter((l) => l.startsWith('TELEGRAM_BOT_TOKEN=')).length, 1, 'exactly one token line');
  // empty-file case
  const fresh = upsertEnv('', 'K', 'V');
  assert.strictEqual(fresh, 'K=V\n');
});

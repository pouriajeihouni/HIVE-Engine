'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const relay = require('../src/web/relay');

const CFG = { root: os.tmpdir(), webPublish: { dir: '/tmp/x' }, webRelay: { pin: '1234', token: 'tok' } };

test('pinOk: correct pin passes, wrong/missing fail', () => {
  assert.equal(relay.pinOk(CFG, '1234'), true);
  assert.equal(relay.pinOk(CFG, '0000'), false);
  assert.equal(relay.pinOk(CFG, undefined), false);
  assert.equal(relay.pinOk({ webRelay: { pin: '' } }, ''), false);
});

test('createProcessor: chat routes through the dispatcher and deletes the file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  const file = 'm1.json';
  fs.writeFileSync(path.join(dir, file), JSON.stringify({ id: 'm1', pin: '1234', type: 'chat', text: 'hello' }));
  const calls = [];
  const proc = relay.createProcessor({ route: async (cfg, state, text) => { calls.push(text); return { reply: 'hi back' }; } });
  const r = await proc(CFG, {}, dir, file, null);
  assert.equal(r.delete, true);
  assert.equal(r.reply, 'hi back');
  assert.deepEqual(calls, ['hello']);
});

test('createProcessor: bad pin → file dropped, router never called', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  fs.writeFileSync(path.join(dir, 'm2.json'), JSON.stringify({ id: 'm2', pin: 'WRONG', type: 'chat', text: 'x' }));
  let routed = false;
  const proc = relay.createProcessor({ route: async () => { routed = true; } });
  const r = await proc(CFG, {}, dir, 'm2.json', null);
  assert.equal(r.reason, 'bad-pin');
  assert.equal(routed, false);
});

test('createProcessor: set_provider switches live (env) and persists to .env', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  fs.writeFileSync(path.join(root, '.env'), 'LLM_PROVIDER=groq\nGROQ_API_KEY=gsk_x\n');
  const cfg = { root, webPublish: { dir: '/tmp/x' }, webRelay: { pin: '1234' } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  fs.writeFileSync(path.join(dir, 'm3.json'), JSON.stringify({ id: 'm3', pin: '1234', type: 'set_provider', provider: 'anthropic' }));
  const proc = relay.createProcessor({});
  const r = await proc(cfg, {}, dir, 'm3.json', null);
  assert.equal(r.reply, 'Provider switched to anthropic.');
  assert.equal(process.env.LLM_PROVIDER, 'anthropic');
  const envTxt = fs.readFileSync(path.join(root, '.env'), 'utf8');
  assert.match(envTxt, /^LLM_PROVIDER=anthropic$/m);
  assert.match(envTxt, /GROQ_API_KEY=gsk_x/); // other lines untouched
  assert.ok(fs.existsSync(path.join(root, '.env.relay.bak')));
  process.env.LLM_PROVIDER = 'groq'; // restore
});

test('createProcessor: doctor runs the health routine', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  fs.writeFileSync(path.join(dir, 'm4.json'), JSON.stringify({ id: 'm4', pin: '1234', type: 'doctor' }));
  const proc = relay.createProcessor({ doctor: async () => 'backup ✅ · all healthy' });
  const r = await proc(CFG, {}, dir, 'm4.json', null);
  assert.equal(r.reply, 'backup ✅ · all healthy');
});

test('createProcessor: unknown type and hostile payloads are dropped safely', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  fs.writeFileSync(path.join(dir, 'm5.json'), JSON.stringify({ id: 'm5', pin: '1234', type: 'rm -rf', text: 'x'.repeat(5000) }));
  const r = await relay.createProcessor({})(CFG, {}, dir, 'm5.json', null);
  assert.equal(r.reason, 'unknown-type');
});

'use strict';

/**
 * Cloud engine server tests — auth, lockout, rate limit, every endpoint,
 * body caps, and the fail-closed guarantee. Uses the real http server on an
 * ephemeral port with injectable deps (same pattern as relay tests).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createApp, keyOk, startIfConfigured } = require('../src/web/server');

const ROOT = path.resolve(__dirname, '..');
const KEY = 'test-key-3f9a2c';

function baseDeps(over = {}) {
  const calls = { routes: [], saves: 0, doctors: 0, snaps: 0, providers: [] };
  const deps = Object.assign({
    cfg: { root: ROOT, webServer: { authKey: KEY }, llm: { provider: 'groq' } },
    route: async (cfg, st, text) => { calls.routes.push(text); return { reply: 'echo:' + text }; },
    doctor: async () => { calls.doctors++; return 'doctor ok'; },
    snapshot: async () => { calls.snaps++; return { schema: 1, conversation: [] }; },
    loadState: () => ({ scheduler: {} }),
    saveState: async () => { calls.saves++; },
    persistProvider: (cfg, p) => { calls.providers.push(p); return true; },
    now: () => Date.now(),
  }, over);
  return { deps, calls };
}

async function withServer(deps, fn) {
  const srv = createApp(deps);
  const port = await new Promise((res) => srv.listen(0, '127.0.0.1', () => res(srv.address().port)));
  try { await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise((r) => srv.close(r)); }
}

test('keyOk: right key true, wrong/empty false', () => {
  const cfg = { webServer: { authKey: KEY } };
  assert.strictEqual(keyOk(cfg, KEY), true);
  assert.strictEqual(keyOk(cfg, 'wrong'), false);
  assert.strictEqual(keyOk(cfg, ''), false);
  assert.strictEqual(keyOk(cfg, undefined), false);
  assert.strictEqual(keyOk({}, KEY), false); // no webServer block
});

test('health: 200 with no auth (keep-alive ping)', async () => {
  const { deps } = baseDeps();
  await withServer(deps, async (base) => {
    const r = await fetch(base + '/api/health');
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.provider, 'groq');
  });
});

test('dashboard shell: served without auth, contains no key material', async () => {
  const { deps } = baseDeps();
  await withServer(deps, async (base) => {
    const r = await fetch(base + '/');
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
    const html = await r.text();
    assert.match(html, /<!doctype/i);
    assert.ok(!html.includes(KEY));
  });
});

test('/api/data: 401 without key, 401 wrong key, 200 + snapshot with key, cached', async () => {
  const { deps, calls } = baseDeps();
  await withServer(deps, async (base) => {
    const no = await fetch(base + '/api/data');
    assert.strictEqual(no.status, 401);
    const bad = await fetch(base + '/api/data', { headers: { 'x-hive-key': 'nope' } });
    assert.strictEqual(bad.status, 401);
    const ok = await fetch(base + '/api/data', { headers: { 'x-hive-key': KEY } });
    assert.strictEqual(ok.status, 200);
    const j = await r_await(ok);
    assert.strictEqual(j.schema, 1);
    const again = await fetch(base + '/api/data', { headers: { authorization: 'Bearer ' + KEY } });
    assert.strictEqual(again.status, 200);
    await again.json();
    assert.strictEqual(calls.snaps, 1, 'second GET served from cache');
  });
  function r_await(r) { return r.json(); }
});

test('chat: routes with key, saves state, returns reply; 401 without key', async () => {
  const { deps, calls } = baseDeps();
  await withServer(deps, async (base) => {
    const no = await fetch(base + '/api/chat', { method: 'POST', body: '{}' });
    assert.strictEqual(no.status, 401);
    const r = await fetch(base + '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hive-key': KEY },
      body: JSON.stringify({ text: 'hello hive' }),
    });
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.strictEqual(j.reply, 'echo:hello hive');
    assert.deepStrictEqual(calls.routes, ['hello hive']);
    assert.strictEqual(calls.saves, 1);
    const alias = await fetch(base + '/api/answer', {
      method: 'POST',
      headers: { 'x-hive-key': KEY },
      body: JSON.stringify({ text: 'answer me' }),
    });
    assert.strictEqual(alias.status, 200);
  });
});

test('chat: empty message → 400, malformed json → 400, oversized body → 413', async () => {
  const { deps } = baseDeps();
  await withServer(deps, async (base) => {
    const empty = await fetch(base + '/api/chat', {
      method: 'POST', headers: { 'x-hive-key': KEY }, body: JSON.stringify({ text: '   ' }),
    });
    assert.strictEqual(empty.status, 400);
    const bad = await fetch(base + '/api/chat', {
      method: 'POST', headers: { 'x-hive-key': KEY, 'content-type': 'application/json' }, body: '{not json',
    });
    assert.strictEqual(bad.status, 400);
    const big = await fetch(base + '/api/chat', {
      method: 'POST', headers: { 'x-hive-key': KEY }, body: 'x'.repeat(70 * 1024),
    });
    assert.strictEqual(big.status, 413);
  });
});

test('doctor: runs with key, busts the data cache', async () => {
  const { deps, calls } = baseDeps();
  await withServer(deps, async (base) => {
    await fetch(base + '/api/data', { headers: { 'x-hive-key': KEY } });
    const r = await fetch(base + '/api/doctor', {
      method: 'POST', headers: { 'x-hive-key': KEY }, body: '{}',
    });
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.strictEqual(j.reply, 'doctor ok');
    assert.strictEqual(calls.doctors, 1);
    await fetch(base + '/api/data', { headers: { 'x-hive-key': KEY } });
    assert.strictEqual(calls.snaps, 2, 'cache was busted by the doctor command');
  });
});

test('set_provider: valid hot-switches env + persists; invalid → 400', async () => {
  const { deps, calls } = baseDeps();
  const prev = process.env.LLM_PROVIDER;
  await withServer(deps, async (base) => {
    const bad = await fetch(base + '/api/set_provider', {
      method: 'POST', headers: { 'x-hive-key': KEY }, body: JSON.stringify({ provider: 'openai' }),
    });
    assert.strictEqual(bad.status, 400);
    const r = await fetch(base + '/api/set_provider', {
      method: 'POST', headers: { 'x-hive-key': KEY }, body: JSON.stringify({ provider: 'anthropic' }),
    });
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.match(j.reply, /anthropic/);
    assert.strictEqual(process.env.LLM_PROVIDER, 'anthropic');
    assert.deepStrictEqual(calls.providers, ['anthropic']);
  });
  if (prev === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = prev;
});

test('brute-force lockout: 10 bad keys → 429, correct key also blocked while locked', async () => {
  const { deps } = baseDeps();
  await withServer(deps, async (base) => {
    let last = 0;
    for (let i = 0; i < 10; i++) {
      const r = await fetch(base + '/api/data', { headers: { 'x-hive-key': 'guess-' + i } });
      last = r.status;
    }
    assert.strictEqual(last, 401, '10th bad key is still a plain 401');
    const locked = await fetch(base + '/api/data', { headers: { 'x-hive-key': KEY } });
    assert.strictEqual(locked.status, 429);
    const j = await locked.json();
    assert.ok(j.retry_after_ms > 0);
    const chat = await fetch(base + '/api/chat', {
      method: 'POST', headers: { 'x-hive-key': KEY }, body: '{"text":"x"}',
    });
    assert.strictEqual(chat.status, 429);
  });
});

test('rate limit: 60 commands/hour, the 61st is rejected', async () => {
  const { deps, calls } = baseDeps();
  await withServer(deps, async (base) => {
    let last = 200;
    for (let i = 0; i <= 60; i++) {
      const r = await fetch(base + '/api/chat', {
        method: 'POST', headers: { 'x-hive-key': KEY }, body: JSON.stringify({ text: 'n' + i }),
      });
      last = r.status;
      if (r.status !== 200) break;
    }
    assert.strictEqual(last, 429, '61st command within the hour gets 429');
    assert.ok(calls.routes.length <= 60);
  });
});

test('unknown path → 404; health ignores query strings', async () => {
  const { deps } = baseDeps();
  await withServer(deps, async (base) => {
    const r = await fetch(base + '/nope');
    assert.strictEqual(r.status, 404);
    const h = await fetch(base + '/api/health?ping=1');
    assert.strictEqual(h.status, 200);
  });
});

test('startIfConfigured: fail-closed without a key, skipped when disabled', async () => {
  const disabled = startIfConfigured(baseDeps().deps); // webServer.enabled undefined → null
  assert.strictEqual(disabled, null);
  const enabledNoKey = startIfConfigured({
    cfg: { root: ROOT, webServer: { enabled: true, authKey: '' } },
  });
  assert.strictEqual(enabledNoKey, null, 'refuses to start without WEB_AUTH_KEY');
  // with key + port 0 → a real listening server we then close
  const srv = startIfConfigured(Object.assign(baseDeps().deps, {
    cfg: { root: ROOT, webServer: { enabled: true, authKey: KEY, port: 0, host: '127.0.0.1' } },
  }));
  assert.ok(srv, 'starts when enabled + key present');
  await new Promise((r) => srv.close(r));
});

/* ── file support (upload / download / chat with attachment) ─────────── */
const fs2 = require('fs');
const os2 = require('os');
const path2 = require('path');

function uploadCfg() {
  const root = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'hive-srv-'));
  return { root, webServer: { authKey: KEY, maxUploadMB: 1, fileContextChars: 12000 }, llm: { provider: 'groq' } };
}

test('upload: text file stored + extracted + indexed; 401 without key', async () => {
  const { deps, calls } = baseDeps({ cfg: uploadCfg() });
  await withServer(deps, async (base) => {
    const no = await fetch(base + '/api/upload', { method: 'POST', body: 'x' });
    assert.strictEqual(no.status, 401);
    const r = await fetch(base + '/api/upload', {
      method: 'POST',
      headers: { 'x-hive-key': KEY, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('pricing notes.txt') },
      body: 'Pricing system v2: charge per seat, not per print.',
    });
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.match(j.id, /^[a-f0-9]{16}$/);
    assert.strictEqual(j.name, 'pricing notes.txt');
    assert.strictEqual(j.kind, 'text');
    assert.strictEqual(j.chars, 50);
    const dir = path2.join(deps.cfg.root, 'data', 'uploads');
    assert.ok(fs2.existsSync(path2.join(dir, j.id + '.bin')));
    assert.ok(fs2.existsSync(path2.join(dir, j.id + '.txt')));
    assert.match(fs2.readFileSync(path2.join(dir, j.id + '.txt'), 'utf8'), /charge per seat/);
    const idx = JSON.parse(fs2.readFileSync(path2.join(dir, 'index.json'), 'utf8'));
    assert.strictEqual(idx.length, 1);
    assert.strictEqual(idx[0].id, j.id);
    assert.strictEqual(calls.snaps, 0, 'upload does not touch the snapshot');
  });
});

test('upload: real PDF extracted end-to-end; name traversal sanitized', async () => {
  const { deps } = baseDeps({ cfg: uploadCfg() });
  await withServer(deps, async (base) => {
    const pdf = fs2.readFileSync(path2.join(ROOT, 'test', 'fixtures', 'econ-syllabus.pdf'));
    const r = await fetch(base + '/api/upload', {
      method: 'POST',
      headers: { 'x-hive-key': KEY, 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('../../../../etc/econ syllabus.pdf') },
      body: pdf,
    });
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.strictEqual(j.name, 'econ syllabus.pdf'); // path components stripped
    assert.strictEqual(j.kind, 'pdf');
    assert.strictEqual(j.pages, 1);
    assert.ok(j.chars > 50);
    assert.match(fs2.readFileSync(path2.join(deps.cfg.root, 'data', 'uploads', j.id + '.txt'), 'utf8'), /Lineker/);
  });
});

test('upload: over the size cap → 413 with the limit in the message', async () => {
  const { deps } = baseDeps({ cfg: uploadCfg() }); // maxUploadMB: 1
  await withServer(deps, async (base) => {
    const r = await fetch(base + '/api/upload', {
      method: 'POST',
      headers: { 'x-hive-key': KEY, 'content-type': 'application/octet-stream', 'x-file-name': 'big.bin' },
      body: 'x'.repeat(1024 * 1024 + 100),
    });
    assert.strictEqual(r.status, 413);
    const j = await r.json();
    assert.match(j.error, /1 MB/);
  });
});

test('chat with fileId: extraction composed into the prompt, display label kept short', async () => {
  const seen = [];
  const { deps } = baseDeps({ cfg: uploadCfg() });
  const origRoute = deps.route;
  deps.route = async (cfg, st, text, opts) => {
    seen.push({ text, opts });
    st.answered = st.answered || [];
    st.answered.push({ text: (opts && opts.displayYou) || text, reply: 'file reply', at: new Date().toISOString() });
    return { reply: 'file reply' };
  };
  await withServer(deps, async (base) => {
    const up = await (await fetch(base + '/api/upload', {
      method: 'POST',
      headers: { 'x-hive-key': KEY, 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('econ-syllabus.pdf') },
      body: fs2.readFileSync(path2.join(ROOT, 'test', 'fixtures', 'econ-syllabus.pdf')),
    })).json();
    const r = await fetch(base + '/api/chat', {
      method: 'POST',
      headers: { 'x-hive-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'summarize the grading scheme', fileId: up.id }),
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).reply, 'file reply');
    assert.strictEqual(seen.length, 1);
    assert.match(seen[0].text, /summarize the grading scheme/);
    assert.match(seen[0].text, /Lineker/); // extraction made it into the prompt
    assert.ok(seen[0].text.length > 300);
    assert.strictEqual(seen[0].opts.module, 'executor'); // forced chief path
    assert.strictEqual(seen[0].opts.displayYou, 'summarize the grading scheme 📎econ-syllabus.pdf');
    // the conversation record shows the label, NOT the extraction
    assert.ok(deps.loadState);
  });
});

test('chat with empty text but a file is allowed; unknown fileId → 404; bad id → 400', async () => {
  const { deps } = baseDeps({ cfg: uploadCfg() });
  const seen = [];
  const origRoute = deps.route;
  deps.route = async (cfg, st, text, opts) => { seen.push(text); return { reply: 'ok' }; };
  await withServer(deps, async (base) => {
    const up = await (await fetch(base + '/api/upload', {
      method: 'POST',
      headers: { 'x-hive-key': KEY, 'content-type': 'text/plain', 'x-file-name': 'notes.txt' },
      body: 'hello notes',
    })).json();
    const r = await fetch(base + '/api/chat', {
      method: 'POST',
      headers: { 'x-hive-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ fileId: up.id }),
    });
    assert.strictEqual(r.status, 200);
    assert.match(seen[0], /What should I know from this file\?/);
    const missing = await fetch(base + '/api/chat', {
      method: 'POST',
      headers: { 'x-hive-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x', fileId: 'deadbeefdeadbeefdead' }),
    });
    assert.strictEqual(missing.status, 400); // not a valid id shape
    const ghost = await fetch(base + '/api/chat', {
      method: 'POST',
      headers: { 'x-hive-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x', fileId: 'aabbccddeeff0011' }),
    });
    assert.strictEqual(ghost.status, 404); // valid shape, never uploaded
  });
});

test('files download: serves the original bytes; rejects junk ids', async () => {
  const { deps } = baseDeps({ cfg: uploadCfg() });
  await withServer(deps, async (base) => {
    const body = Buffer.from('%PDF-1.4 fake bytes');
    const up = await (await fetch(base + '/api/upload', {
      method: 'POST',
      headers: { 'x-hive-key': KEY, 'content-type': 'application/pdf', 'x-file-name': 'tiny.pdf' },
      body,
    })).json();
    const no = await fetch(base + '/api/files/' + up.id);
    assert.strictEqual(no.status, 401);
    const r = await fetch(base + '/api/files/' + up.id, { headers: { 'x-hive-key': KEY } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('content-type'), 'application/pdf');
    assert.match(r.headers.get('content-disposition') || '', /tiny\.pdf/);
    const back = Buffer.from(await r.arrayBuffer());
    assert.ok(body.equals(back), 'byte-identical round trip');
    const junk = await fetch(base + '/api/files/..%2F..%2Fetc%2Fpasswd', { headers: { 'x-hive-key': KEY } });
    assert.strictEqual(junk.status, 404);
    const ghost = await fetch(base + '/api/files/aabbccddeeff0011', { headers: { 'x-hive-key': KEY } });
    assert.strictEqual(ghost.status, 404);
  });
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const llm = require('../src/lib/llm');
const { mockComplete, validateResponse } = llm;

const cfg = {
  userName: 'Pouria',
  mockMode: true,
};

test('mock brain: daily brief directive produces brief + note + maybe reminder', () => {
  const now = new Date(2026, 8, 13, 7, 0);
  const meta = {
    now,
    directive: 'daily_brief',
    events: [{ id: 'e1', title: 'ECON 2450 — Lecture', start: new Date(2026, 8, 13, 10, 0).toISOString(), location: 'Room 201', category: 'class' }],
    userMessages: [],
    vaultSummary: { todos: ['Problem set 1  ← School/ECON2450/assignments.md'] },
  };
  const r = validateResponse(mockComplete(cfg, meta));
  assert.equal(r.status, 'ready');
  const types = r.actions.map((a) => a.type);
  assert.ok(types.includes('daily_brief'));
  assert.ok(types.includes('note_create'));
  assert.match(r.actions.find((a) => a.type === 'note_create').vault_path, /^Daily\/2026-09-13$/);
  assert.ok(r.actions.find((a) => a.type === 'daily_brief').brief.includes('ECON 2450'));
});

test('mock brain: user messages are captured and get a query back', () => {
  const meta = {
    now: new Date(),
    events: [],
    userMessages: [{ text: 'remember to ask Prof Adamopoulos about the extension', at: new Date().toISOString() }],
    vaultSummary: null,
  };
  const r = validateResponse(mockComplete(cfg, meta));
  assert.equal(r.status, 'awaiting_input');
  const types = r.actions.map((a) => a.type);
  assert.ok(types.includes('note_create'));
  assert.ok(types.includes('query'));
  // email-looking request also queues a draft
  assert.ok(types.includes('email_draft'));
  const draft = r.actions.find((a) => a.type === 'email_draft');
  assert.equal(draft.needs_approval, true);
});

test('mock brain: hs_checklist nudge', () => {
  const r = validateResponse(mockComplete(cfg, { now: new Date(), directive: 'hs_checklist', events: [], userMessages: [] }));
  const types = r.actions.map((a) => a.type);
  assert.ok(types.includes('reminder'));
  assert.ok(types.includes('note_update'));
});

test('mock brain: idle cycle stays quiet (loop hygiene)', () => {
  const meta = { now: new Date(), events: [], userMessages: [], vaultSummary: null };
  const r = validateResponse(mockComplete(cfg, meta));
  assert.equal(r.status, 'ready');
  assert.deepEqual(r.actions, []);
});

test('validateResponse repairs bad fields', () => {
  const r = validateResponse({ status: 'bogus', actions: 'nope', next_check_in_minutes: 9999 });
  assert.equal(r.status, 'ready');
  assert.deepEqual(r.actions, []);
  assert.equal(r.next_check_in_minutes, 1440);
});

test('mock brain: project agents get their own cycle + capture path', () => {
  const agent = { id: 'startup', name: 'Startup Co-pilot', role: 'project', focus: 'Personal/Ideas', interval_minutes: 240 };
  const idle = validateResponse(mockComplete(cfg, { now: new Date(), events: [], userMessages: [], vaultSummary: null, agent }));
  assert.equal(idle.status, 'ready');
  assert.deepEqual(idle.actions, []);
  assert.match(idle.summary, /Startup Co-pilot/);
  assert.match(idle.summary, /Personal\/Ideas/);

  const msg = validateResponse(mockComplete(cfg, {
    now: new Date(),
    events: [],
    userMessages: [{ text: 'research competitor X', at: new Date().toISOString() }],
    vaultSummary: null,
    agent,
  }));
  assert.equal(msg.status, 'awaiting_input');
  assert.match(msg.actions.find((a) => a.type === 'note_create').vault_path, /^Hive\/startup\//);
});

// ── Groq engine ──────────────────────────────────────────────────────
function res(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}
const GROQ_CFG = {
  llm: { provider: 'groq' },
  groqApiKey: 'gsk_test_key',
  groqModel: 'llama-3.3-70b-versatile',
  claudeModel: 'claude-sonnet-4-5',
  maxTokens: 1000,
};

test('groq: builds an OpenAI-style request with JSON mode and returns content', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return res(200, { choices: [{ message: { content: '{"status":"ready"}' } }] });
  };
  const out = await llm._internals.callGroq(GROQ_CFG, { system: 'SYS', user: 'USR', json: true, fetchImpl, retryDelayMs: 0 });
  assert.equal(out, '{"status":"ready"}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(calls[0].opts.headers.authorization, 'Bearer gsk_test_key');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.model, 'llama-3.3-70b-versatile');
  assert.deepEqual(body.messages, [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'USR' }]);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.max_tokens, 1000);
});

test('groq: repair retry sends the bad reply back as an assistant message', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return res(200, { choices: [{ message: { content: '{"ok":true}' } }] });
  };
  await llm._internals.callGroq(GROQ_CFG, {
    system: 'S', user: 'U', json: true, badReply: '{"trunc', fetchImpl, retryDelayMs: 0,
  });
  assert.equal(calls[0].messages.length, 4); // system, user, assistant(bad reply), user(fix instruction)
  assert.equal(calls[0].messages[0].role, 'system');
  assert.equal(calls[0].messages[1].role, 'user');
  assert.equal(calls[0].messages[2].role, 'assistant');
  assert.equal(calls[0].messages[2].content, '{"trunc');
  assert.equal(calls[0].messages[3].role, 'user');
  assert.match(calls[0].messages[3].content, /not valid JSON/);
});

test('groq: retries once on 429 rate limit', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n++;
    if (n === 1) return res(429, { error: { message: 'Rate limit reached' } });
    return res(200, { choices: [{ message: { content: 'ok-after-retry' } }] });
  };
  const out = await llm._internals.callGroq(GROQ_CFG, { system: 'S', user: 'U', fetchImpl, retryDelayMs: 0 });
  assert.equal(out, 'ok-after-retry');
  assert.equal(n, 2);
});

test('groq: drops response_format and retries when the model rejects JSON mode', async () => {
  const bodies = [];
  const fetchImpl = async (url, opts) => {
    const b = JSON.parse(opts.body);
    bodies.push(b);
    if (!('response_format' in b)) return res(200, { choices: [{ message: { content: '{"ok":1}' } }] });
    return res(400, { error: { message: 'response_format is not supported for this model' } });
  };
  const out = await llm._internals.callGroq(GROQ_CFG, { system: 'S', user: 'U', json: true, fetchImpl, retryDelayMs: 0 });
  assert.equal(out, '{"ok":1}');
  assert.equal(bodies.length, 2);
  assert.ok('response_format' in bodies[0]);
  assert.ok(!('response_format' in bodies[1]));
});

test('groq: surfaces API error messages, no infinite retries', async () => {
  let n = 0;
  const fetchImpl = async () => { n++; return res(401, { error: { message: 'Invalid API Key' } }); };
  await assert.rejects(
    llm._internals.callGroq(GROQ_CFG, { system: 'S', user: 'U', fetchImpl, retryDelayMs: 0 }),
    /Groq 401: Invalid API Key/
  );
  assert.equal(n, 1);
});

test('modelForProvider: wrong-provider pins fall back to the active default', () => {
  assert.equal(llm._internals.modelForProvider(GROQ_CFG, 'claude-opus-4-6'), 'llama-3.3-70b-versatile');
  assert.equal(llm._internals.modelForProvider(GROQ_CFG, 'openai/gpt-oss-120b'), 'openai/gpt-oss-120b');
  assert.equal(llm._internals.modelForProvider(GROQ_CFG, null), 'llama-3.3-70b-versatile');
  const ac = { llm: { provider: 'anthropic' }, groqModel: 'g', claudeModel: 'claude-sonnet-4-5' };
  assert.equal(llm._internals.modelForProvider(ac, 'llama-3.3-70b-versatile'), 'claude-sonnet-4-5');
  assert.equal(llm._internals.modelForProvider(ac, 'claude-opus-4-6'), 'claude-opus-4-6');
});

test('config: provider resolution (explicit wins, auto-detect, mock fallback)', () => {
  const cfgPath = require.resolve('../src/config');
  const saved = {};
  for (const k of ['LLM_PROVIDER', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  const fresh = () => { delete require.cache[cfgPath]; return require('../src/config'); };
  try {
    let c = fresh();
    assert.equal(c.llm.provider, 'anthropic');
    assert.equal(c.mockMode, true);

    process.env.GROQ_API_KEY = 'gsk_x';
    c = fresh();
    assert.equal(c.llm.provider, 'groq');
    assert.equal(c.mockMode, false);

    process.env.ANTHROPIC_API_KEY = 'sk-ant-x'; // both keys, no explicit → back-compat
    c = fresh();
    assert.equal(c.llm.provider, 'anthropic');

    process.env.LLM_PROVIDER = 'groq'; // explicit wins
    c = fresh();
    assert.equal(c.llm.provider, 'groq');
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    delete require.cache[cfgPath];
  }
});

// ── Groq model auto-fallback (catalog drift) ────────────────────────
test('groq: 404 unknown model → auto-switches to best available and retries', async () => {
  llm._internals.resetGroqCache();
  const posts = [];
  // the REAL 2026 account catalog (as pasted from console.groq.com)
  const CATALOG = ['canopylabs/orpheus-arabic-saudi', 'canopylabs/orpheus-v1-english',
    'groq/compound', 'groq/compound-mini', 'meta-llama/llama-prompt-guard-2-22m',
    'meta-llama/llama-prompt-guard-2-86m', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b',
    'openai/gpt-oss-safeguard-20b', 'qwen/qwen3.6-27b', 'qwen/qwen3.8-27b',
    'whisper-large-v3', 'whisper-large-v3-turbo'];
  const fetchImpl = async (url, opts) => {
    if (url.includes('/models')) return res(200, { data: CATALOG.map((id) => ({ id })) });
    posts.push(JSON.parse(opts.body));
    if (posts.length === 1) return res(404, { error: { message: 'The model `llama-3.3-70b-versatile` does not exist or you do not have access to it.' } });
    return res(200, { choices: [{ message: { content: '{"ok":1}' } }] });
  };
  const cfg = Object.assign({}, GROQ_CFG, { groqModel: 'llama-3.3-70b-versatile' });
  const out = await llm._internals.callGroq(cfg, { system: 'S', user: 'U', json: true, fetchImpl, retryDelayMs: 0 });
  assert.equal(out, '{"ok":1}');
  assert.equal(posts.length, 2);
  assert.equal(posts[1].model, 'openai/gpt-oss-120b'); // utility models filtered, best chat model wins
  assert.equal(cfg.groqModel, 'openai/gpt-oss-120b');  // sticky for the process
});

test('groq: overflow on the 2026 catalog lands on qwen, never compound/orpheus', async () => {
  llm._internals.resetGroqCache();
  const CATALOG = ['canopylabs/orpheus-v1-english', 'groq/compound', 'groq/compound-mini',
    'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.6-27b', 'qwen/qwen3.8-27b', 'whisper-large-v3'];
  const posts = [];
  const fetchImpl = async (url, opts) => {
    if (url.includes('/models')) return res(200, { data: CATALOG.map((id) => ({ id })) });
    const body = JSON.parse(opts.body);
    posts.push(body);
    if (body.model === 'openai/gpt-oss-120b') return res(429, { error: { message: RATE_MSG } });
    return res(200, { choices: [{ message: { content: 'qwen-ok' } }] });
  };
  const out = await llm._internals.callGroq(Object.assign({}, GROQ_CFG, { groqModel: 'openai/gpt-oss-120b' }),
    { system: 'S', user: 'U', fetchImpl, retryDelayMs: 0 });
  assert.equal(out, 'qwen-ok');
  assert.equal(posts[posts.length - 1].model, 'qwen/qwen3.8-27b');
});

test('groq: pickGroqModel preference order (gpt-oss over small llama, etc.)', () => {
  const pick = llm._internals.pickGroqModel;
  assert.equal(pick(['openai/gpt-oss-120b', 'llama-3.1-8b-instant']), 'openai/gpt-oss-120b');
  assert.equal(pick(['qwen/qwen3-32b', 'moonshotai/kimi-k2-instruct']), 'qwen/qwen3-32b'); // last resort: first id
  assert.equal(pick([]), null);
});

test('groq: 404 with model list unavailable → original error propagates', async () => {
  llm._internals.resetGroqCache();
  const fetchImpl = async (url) => {
    if (url.includes('/models')) return res(500, {});
    return res(404, { error: { message: 'The model `x` does not exist or you do not have access to it.' } });
  };
  await assert.rejects(
    llm._internals.callGroq(Object.assign({}, GROQ_CFG), { system: 'S', user: 'U', fetchImpl, retryDelayMs: 0 }),
    /does not exist/
  );
});

// ── Groq smart 429 handling (server-honored waits + overflow model) ──
const RATE_MSG = 'Rate limit reached for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000, Used 5004, Requested 4499. Please try again in 11.2725s.';

test('groq429WaitMs parses the server hint from real Groq messages', () => {
  assert.equal(llm._internals.groq429WaitMs(new Error(`Groq 429: ${RATE_MSG}`)), 11273);
  assert.equal(llm._internals.groq429WaitMs({ retryAfterMs: 8500 }), 8500);
  assert.equal(llm._internals.groq429WaitMs(new Error('Groq 429: no hint here')), null);
});

test('groq: persistent 429 → waits twice, then overflows to a separate-budget model', async () => {
  llm._internals.resetGroqCache();
  const posts = [];
  const fetchImpl = async (url, opts) => {
    if (url.includes('/models')) {
      return res(200, { data: [ { id: 'openai/gpt-oss-120b' }, { id: 'meta-llama/llama-4-scout-17b-16e-instruct' }, { id: 'llama-3.1-8b-instant' } ] });
    }
    const body = JSON.parse(opts.body);
    posts.push(body);
    if (body.model === 'openai/gpt-oss-120b' && posts.filter((p) => p.model === 'openai/gpt-oss-120b').length <= 3) {
      return res(429, { error: { message: RATE_MSG } });
    }
    return res(200, { choices: [{ message: { content: 'overflow-ok' } }] });
  };
  const out = await llm._internals.callGroq(Object.assign({}, GROQ_CFG, { groqModel: 'openai/gpt-oss-120b' }),
    { system: 'S', user: 'U', fetchImpl, retryDelayMs: 0 });
  assert.equal(out, 'overflow-ok');
  const used = posts.map((p) => p.model);
  assert.deepEqual(used, ['openai/gpt-oss-120b', 'openai/gpt-oss-120b', 'openai/gpt-oss-120b', 'meta-llama/llama-4-scout-17b-16e-instruct']);
});

test('groq: pickGroqOverflowModel prefers big-TPM models, never the current one', () => {
  const ids = ['openai/gpt-oss-120b', 'llama-3.1-8b-instant', 'meta-llama/llama-4-scout-17b-16e-instruct'];
  assert.equal(llm._internals.pickGroqOverflowModel(ids, 'openai/gpt-oss-120b'), 'meta-llama/llama-4-scout-17b-16e-instruct');
  assert.equal(llm._internals.pickGroqOverflowModel(['only-one-model'], 'only-one-model'), null);
});

// ── interactive mode: humans never wait out daily-budget 429s ────────
test('groq: interactive mode overflows immediately — no long waits on daily-budget 429s', async () => {
  llm._internals.resetGroqCache();
  llm.setInteractive(true);
  try {
    const posts = [];
    const fetchImpl = async (url, opts) => {
      if (url.includes('/models')) {
        return res(200, { data: [ { id: 'openai/gpt-oss-120b' }, { id: 'qwen/qwen3.8-27b' } ] });
      }
      const body = JSON.parse(opts.body);
      posts.push(body);
      if (body.model === 'openai/gpt-oss-120b') {
        return res(429, { error: { message: 'Rate limit reached on tokens per day (TPD). Please try again in 1293.5s.' } });
      }
      return res(200, { choices: [{ message: { content: 'fast-ok' } }] });
    };
    const t0 = Date.now();
    const out = await llm._internals.callGroq(Object.assign({}, GROQ_CFG, { groqModel: 'openai/gpt-oss-120b' }),
      { system: 'S', user: 'U', fetchImpl, retryDelayMs: 5000 });
    assert.equal(out, 'fast-ok');
    assert.equal(posts.length, 2); // one 429 → one immediate overflow, zero waits
    assert.equal(posts[1].model, 'qwen/qwen3.8-27b');
    assert.ok(Date.now() - t0 < 4500, `interactive overflow should be instant, took ${Date.now() - t0}ms`);
  } finally {
    llm.setInteractive(false);
  }
});

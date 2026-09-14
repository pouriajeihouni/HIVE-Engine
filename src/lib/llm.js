'use strict';

/**
 * LLM layer for the HIVE. Every agent can use its own model.
 *   askAgent()  — action-schema agents (chief + project roles)
 *   askJson()   — generic JSON call with one repair retry (used by mentalist)
 * Two engines:
 *   anthropic — Claude via @anthropic-ai/sdk (needs ANTHROPIC_API_KEY)
 *   groq      — Llama/GPT-OSS via GroqCloud's OpenAI-compatible API
 *               (needs GROQ_API_KEY; free tier covers Hive's whole workload)
 * Mock mode (no key for the active provider) → deterministic offline brains
 * per role, so the whole hive is testable and demo-able with zero credentials.
 */
const logger = require('./logger');
const { extractJson, clamp, todayStr, timeStr, isoWeek } = require('./util');
const { parseEventTime } = require('./util');

// Interactive CLI mode: when a human is waiting (say/ask/search/--once),
// never sit out long rate-limit waits — overflow to another model instantly.
let interactive = false;
function setInteractive(v) { interactive = !!v; }

// ── validation of action-schema responses ──────────────────────────
function validateResponse(o) {
  if (!o || typeof o !== 'object') throw new Error('LLM response is not a JSON object');
  return {
    status: ['ready', 'awaiting_input', 'error'].includes(o.status) ? o.status : 'ready',
    actions: Array.isArray(o.actions) ? o.actions : [],
    summary: String(o.summary || '').slice(0, 500),
    next_check_in_minutes: clamp(Number(o.next_check_in_minutes) || 60, 5, 1440),
  };
}

// ── raw Claude call ────────────────────────────────────────────────
async function callClaude(cfg, { system, user, model, maxTokens, badReply }) {
  let Anthropic;
  try {
    const m = require('@anthropic-ai/sdk');
    Anthropic = m.default || m;
  } catch {
    throw new Error('@anthropic-ai/sdk is not installed — run: npm install');
  }
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });
  const messages = [{ role: 'user', content: user }];
  if (badReply) {
    messages.push({ role: 'assistant', content: badReply });
    messages.push({
      role: 'user',
      content: 'Your previous reply was not valid JSON. Respond again with ONLY the JSON object — no prose, no code fences.',
    });
  }
  const res = await client.messages.create({
    model: model || cfg.claudeModel,
    max_tokens: maxTokens || cfg.maxTokens,
    system,
    messages,
  });
  const block = (res.content || []).find((b) => b.type === 'text');
  return block ? block.text : '';
}

// ── Groq engine (OpenAI-compatible, plain HTTPS — zero extra deps) ──
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';

let groqModelsCache = null; // account's model ids, for the life of the process

/** Chat-usable models only (drop whisper/orpheus TTS-STT, guard/safeguard
 *  classifiers, and compound web-search agents — none fit the JSON contract). */
const NON_CHAT_MODEL_RE = /whisper|guard|safeguard|tts|embed|rerank|distil|orpheus|compound/i;

async function listGroqModels(cfg, doFetch) {
  if (groqModelsCache) return groqModelsCache;
  const r = await doFetch(GROQ_MODELS_URL, { headers: { authorization: `Bearer ${cfg.groqApiKey}` } });
  const text = await r.text();
  if (!r.ok) throw new Error(`model list unavailable (HTTP ${r.status})`);
  const j = JSON.parse(text);
  groqModelsCache = (j.data || []).map((m) => m.id).filter((id) => !NON_CHAT_MODEL_RE.test(id));
  return groqModelsCache;
}

/** Pick the best available model: preference-ordered, closest to Hive's needs.
 *  Ordered for the 2026 catalog (gpt-oss + qwen), with llama kept for
 *  accounts that still carry it. */
function pickGroqModel(ids) {
  const prefs = [
    (id) => /gpt-oss-120b/.test(id),
    (id) => /qwen3\.8-27b/.test(id),
    (id) => /qwen3\.6-27b/.test(id),
    (id) => /gpt-oss-20b/.test(id),
    (id) => /llama-3\.3-70b/.test(id),
    (id) => /llama/.test(id),
    () => true, // last resort: whatever the account offers
  ];
  for (const p of prefs) { const hit = ids.find(p); if (hit) return hit; }
  return null;
}

/** Which concrete model id to use for this call? An agent may pin a model
 *  for a provider that isn't active (e.g. claude-* while running groq) —
 *  in that case fall back to the active provider's default. */
function modelForProvider(cfg, model) {
  const m = String(model || '').trim();
  if (cfg.llm.provider === 'groq') return /^claude/i.test(m) ? cfg.groqModel : (m || cfg.groqModel);
  return /^claude/i.test(m) ? (m || cfg.claudeModel) : cfg.claudeModel;
}

/** How long does Groq want us to wait after a 429? (header or message hint) */
function groq429WaitMs(e) {
  if (e && Number.isFinite(e.retryAfterMs) && e.retryAfterMs > 0) return e.retryAfterMs;
  const m = String((e && e.message) || '').match(/try again in ([\d.]+)\s*s/i);
  if (m) return Math.ceil(parseFloat(m[1]) * 1000);
  return null;
}

/** Overflow model for persistent rate limits: prefer smart models on a
 *  SEPARATE token bucket (each model has its own, so switching = fresh budget).
 *  2026-catalog order: qwen pair, then gpt-oss-20b, then any llama. */
function pickGroqOverflowModel(ids, current) {
  const prefs = [/qwen3\.8-27b/i, /qwen3\.6-27b/i, /gpt-oss-20b/i, /llama-4-scout/i, /llama-3\.3-70b/i, /llama/i];
  for (const p of prefs) {
    const hit = ids.find((id) => id !== current && p.test(id));
    if (hit) return hit;
  }
  return ids.find((id) => id !== current) || null;
}

async function callGroq(cfg, { system, user, model, maxTokens, badReply, json, fetchImpl, retryDelayMs }) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw new Error('Groq needs Node 18+ (global fetch) — update Node');
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  if (badReply) {
    messages.push({ role: 'assistant', content: badReply });
    messages.push({
      role: 'user',
      content: 'Your previous reply was not valid JSON. Respond again with ONLY the JSON object — no prose, no code fences.',
    });
  }
  const body = {
    model: modelForProvider(cfg, model),
    messages,
    max_tokens: maxTokens || cfg.maxTokens,
  };
  if (json) body.response_format = { type: 'json_object' }; // strict JSON mode (most Groq instruct models)

  const attempt = async (b) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60000);
    try {
      const r = await doFetch(GROQ_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.groqApiKey}` },
        body: JSON.stringify(b),
        signal: ctl.signal,
      });
      const text = await r.text();
      let j = null;
      try { j = JSON.parse(text); } catch { /* error body may not be JSON */ }
      if (!r.ok) {
        const msg = (j && j.error && j.error.message) || String(text).slice(0, 200) || `HTTP ${r.status}`;
        const err = new Error(`Groq ${r.status}: ${msg}`);
        err.status = r.status;
        try {
          const h = r.headers && (r.headers.get ? r.headers : null);
          if (h) {
            const ms = parseInt(h.get('retry-after-ms'), 10);
            const s = parseFloat(h.get('retry-after'));
            if (Number.isFinite(ms) && ms > 0) err.retryAfterMs = ms;
            else if (Number.isFinite(s) && s > 0) err.retryAfterMs = Math.ceil(s * 1000);
          }
        } catch { /* headers unavailable in some test doubles */ }
        throw err;
      }
      const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      return typeof content === 'string' ? content : '';
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    return await attempt(body);
  } catch (e) {
    if (e.status === 400 && /response_format/i.test(e.message)) { // model without JSON mode
      delete body.response_format;
      return attempt(body);
    }
    if (e.status === 404 && /does not exist|do not have access|not found/i.test(e.message)) {
      // catalog drift: the pinned model was retired/renamed on this account —
      // ask the account's own model list and switch to the best available
      const ids = await listGroqModels(cfg, doFetch).catch(() => null);
      const alt = ids ? pickGroqModel(ids.filter((id) => id !== body.model)) : null;
      if (alt) {
        logger.warn(`Groq model "${body.model}" unavailable — switching to "${alt}"`);
        cfg.groqModel = alt; // sticky for the rest of this process
        body.model = alt;
        return attempt(body);
      }
      throw e;
    }
    if (e.status === 429) {
      // Free-tier limits come in two shapes:
      //  - short TPM squeeze (server hints seconds) → a brief wait is fine
      //  - daily budget exhausted (hints of many minutes) → waiting is
      //    pointless; every model has its OWN daily budget → overflow now.
      const wait = (ms) => new Promise((res) => setTimeout(res, retryDelayMs != null ? Math.min(retryDelayMs, ms) : ms));
      const overflowAll = async () => {
        const ids = (await listGroqModels(cfg, doFetch).catch(() => null)) || [];
        const pool = ids.filter((id) => id !== body.model);
        const ordered = [];
        while (pool.length) {
          const pick = pickGroqOverflowModel(pool, body.model) || pool[0];
          ordered.push(pick);
          pool.splice(pool.indexOf(pick), 1);
        }
        for (const alt of ordered) {
          logger.warn(`Groq rate-limited — overflowing to "${alt}" (separate free-tier daily budget)`);
          body.model = alt;
          try { return await attempt(body); }
          catch (e2) { if (e2.status !== 429) throw e2; }
        }
        throw new Error('Groq free-tier budget exhausted on every model — it refills within 24h (limits: console.groq.com/settings/limits). Try again later.');
      };
      if (interactive) return overflowAll(); // a human is waiting — never sit out a long hint

      const hint = groq429WaitMs(e);
      const cap = (ms) => Math.min(ms, 90000); // never park a daemon tick for 20+ minutes
      const waits = [cap(hint != null ? hint + 1500 : 5000), cap(hint != null ? hint + 10000 : 20000)];
      for (const w of waits) {
        logger.warn(`Groq rate-limited — retrying in ${Math.round(w / 1000)}s`);
        await wait(w);
        try { return await attempt(body); }
        catch (e2) { if (e2.status !== 429) throw e2; }
      }
      return overflowAll();
    }
    throw e;
  }
}

/** Route a call to the active provider. */
async function callLLM(cfg, opts) {
  if (cfg.llm.provider === 'groq') return callGroq(cfg, opts);
  return callClaude(cfg, opts);
}

/** Plain-text ask (used by the knowledge module's RAG answers). */
async function askText(cfg, { system, user, model, maxTokens }) {
  const text = await callLLM(cfg, { system, user, model, maxTokens });
  if (!text.trim()) throw new Error('empty LLM response');
  return text.trim();
}

/** Ask for JSON with one automatic repair retry. Returns the parsed object. */
async function askJson(cfg, { system, user, model, maxTokens }) {
  const first = await callLLM(cfg, { system, user, model, maxTokens, json: true });
  try {
    return extractJson(first);
  } catch (e1) {
    logger.warn(`LLM output was not valid JSON (${e1.message}) — requesting repair`);
    // truncation is the usual culprit — give the repair pass double room
    // (max_tokens is a ceiling, not a cost: unused budget is never billed)
    const repairTokens = Math.min(8000, Math.round((maxTokens || cfg.maxTokens) * 2));
    const second = await callLLM(cfg, { system, user, model, maxTokens: repairTokens, badReply: first, json: true });
    return extractJson(second); // if this throws, caller records the error
  }
}

// ─────────────────────────────────────────────────────────────────────
// MOCK BRAINS — deterministic, offline, free
// ─────────────────────────────────────────────────────────────────────
function mockComplete(cfg, meta) {
  const agent = meta.agent || { id: 'hive', role: 'chief', name: 'Hive', focus: null };
  if (agent.role === 'project') return projectMock(cfg, agent, meta);
  return chiefMock(cfg, meta);
}

function chiefMock(cfg, meta) {
  const now = meta.now instanceof Date ? meta.now : new Date();
  const name = cfg.userName;
  const d = todayStr(now);

  const events = (meta.events || [])
    .map((e) => ({ ...e, _start: parseEventTime(e.start) }))
    .filter((e) => e._start && e._start > now)
    .sort((a, b) => a._start - b._start);
  const todayEvents = events.filter((e) => todayStr(e._start) === d);
  const todos = ((meta.vaultSummary && meta.vaultSummary.todos) || []).slice(0, 5);

  const evLines = (list) => list.slice(0, 6)
    .map((e) => `- [ ] ${timeStr(e._start)} — ${e.title}${e.location ? ` (${e.location})` : ''}`)
    .join('\n');

  // 1) User said something → capture it + respond
  if (meta.userMessages && meta.userMessages.length) {
    const last = String(meta.userMessages[meta.userMessages.length - 1].text);
    const looksLikeEmail = /email|prof|professor|adamopoulos|rogerson|manager|send/i.test(last);
    const actions = [
      {
        type: 'note_create',
        vault_path: `Hive/Captured/${d}`,
        title: `Captured — ${d}`,
        content: `- **${timeStr(now)}** — ${last}`,
        tags: ['inbox', 'captured'],
      },
    ];
    if (looksLikeEmail) {
      actions.push({
        type: 'email_draft',
        recipient: /rogerson/i.test(last) ? 'jrogerson@yorku.ca' : 'adamopoulos@yorku.ca',
        subject: 'Draft (mock brain) — fill in details',
        body: `Dear Professor,\n\n[Mock brain wrote this placeholder — add ANTHROPIC_API_KEY for real drafting.]\n\nOriginal request: ${last}\n\nBest regards,\n${name}`,
        needs_approval: true,
      });
    }
    actions.push({
      type: 'query',
      question: `Got it — saved to Hive/Captured/${d}.${looksLikeEmail ? ' I also queued a placeholder email draft (run "npm run approve" to review).' : ''} (Mock brain: add ANTHROPIC_API_KEY to .env for real intelligence.) Anything else?`,
    });
    return {
      status: 'awaiting_input',
      actions,
      summary: `Captured: "${last.slice(0, 80)}"`,
      next_check_in_minutes: 60,
    };
  }

  // 2) Scheduled jobs
  switch (meta.directive) {
    case 'daily_brief': {
      const brief = todayEvents.length
        ? `Good morning ${name}! Today: ${todayEvents.map((e) => `${e.title} at ${timeStr(e._start)}`).join('; ')}.`
        : `Good morning ${name}! Nothing on the calendar today.`;
      const actions = [
        { type: 'daily_brief', brief: `${brief} ${todos.length ? `${todos.length} open TODO(s), first: ${todos[0].split('←')[0].trim()}.` : 'No open TODOs.'}` },
        {
          type: 'note_create',
          vault_path: `Daily/${d}`,
          title: `Daily Plan — ${d}`,
          tags: ['daily'],
          content: `## Schedule\n${todayEvents.length ? evLines(todayEvents) : '- (nothing on the calendar)'}\n\n## Priorities\n${todos.slice(0, 3).map((t, i) => `${i + 1}. ${t.split('←')[0].trim()}`).join('\n') || '1. Review notes for the next class'}`,
        },
      ];
      // (standard calendar reminders are handled by the deterministic engine)
      return { status: 'ready', actions, summary: `Morning brief generated (${todayEvents.length} events, ${todos.length} TODOs)`, next_check_in_minutes: 60 };
    }
    case 'weekly_plan': {
      const week = isoWeek(now);
      return {
        status: 'ready',
        actions: [{
          type: 'note_create',
          vault_path: `Weekly/${week}-plan`,
          title: `Weekly Plan — ${week}`,
          tags: ['weekly', 'plan'],
          content: `## Week of ${d} (${week})\n\n### Classes & work\n${events.length ? evLines(events) : '- (no calendar events loaded)'}\n\n### Carry-over TODOs\n${todos.map((t) => `- [ ] ${t}`).join('\n') || '- (none)'}\n\n### Focus\n1. Stay ahead of ECON 2450 readings\n2. TPH pricing/quoting system progress\n3. Gym 3× this week`,
        }],
        summary: `Weekly plan ${week} created`,
        next_check_in_minutes: 60,
      };
    }
    case 'weekly_summary': {
      const week = isoWeek(now);
      return {
        status: 'ready',
        actions: [{
          type: 'note_create',
          vault_path: `Weekly/${week}-summary`,
          title: `Weekly Summary — ${week}`,
          tags: ['weekly', 'summary'],
          content: `## Week ${week} summary\n\n### Wins\n- [fill in]\n\n### What slipped\n- [fill in]\n\n### Carry to next week\n${todos.slice(0, 5).map((t) => `- ${t}`).join('\n') || '- (none)'}`,
        }],
        summary: `Weekly summary ${week} created`,
        next_check_in_minutes: 60,
      };
    }
    case 'hs_checklist': {
      return {
        status: 'ready',
        actions: [
          { type: 'reminder', message: '📋 TPH Health & Safety checklist due today — walk the equipment checks (ZUND, printers) and log it.', time_offset_minutes: 0, priority: 'high' },
          {
            type: 'note_update',
            vault_path: 'Work/TPH/health_safety',
            action: 'append',
            content: `## ${d} — weekly checklist\n- [ ] Equipment checks (ZUND, printers)\n- [ ] Workarea walkthrough\n- [ ] Log incidents / near-misses`,
          },
        ],
        summary: 'Health & Safety Friday nudge sent',
        next_check_in_minutes: 60,
      };
    }
    default: {
      const actions = [];
      const next = events[0];
      if (next && (next._start - now) / 60000 <= 30) {
        actions.push({ type: 'reminder', message: `${next.title} starts soon`, time_offset_minutes: 0, priority: 'normal' });
      }
      return {
        status: 'ready',
        actions,
        summary: `Mock brain cycle — ${events.length} upcoming event(s), ${todos.length} open TODO(s). Add ANTHROPIC_API_KEY for real intelligence.`,
        next_check_in_minutes: 60,
      };
    }
  }
}

function projectMock(cfg, agent, meta) {
  const now = meta.now instanceof Date ? meta.now : new Date();
  const d = todayStr(now);
  const todos = ((meta.vaultSummary && meta.vaultSummary.todos) || []).slice(0, 5);

  if (meta.userMessages && meta.userMessages.length) {
    const last = String(meta.userMessages[meta.userMessages.length - 1].text);
    return {
      status: 'awaiting_input',
      actions: [
        {
          type: 'note_create',
          vault_path: `Hive/${agent.id}/captured`,
          title: `Captured — ${d}`,
          content: `- **${timeStr(now)}** — ${last}`,
          tags: ['hive', agent.id, 'captured'],
        },
        { type: 'query', question: `Noted in Hive/${agent.id}/captured. (Mock brain — add ANTHROPIC_API_KEY for the real ${agent.name}.)` },
      ],
      summary: `Captured for ${agent.name}: "${last.slice(0, 60)}"`,
      next_check_in_minutes: 60,
    };
  }
  return {
    status: 'ready',
    actions: [],
    summary: `${agent.name} mock cycle — watching ${agent.focus || 'vault'} (${todos.length} open TODO(s) in focus). Add ANTHROPIC_API_KEY for real intelligence.`,
    next_check_in_minutes: agent.interval_minutes || 60,
  };
}

// ─────────────────────────────────────────────────────────────────────

/** Action-schema agents (chief + project roles). */
async function askAgent(cfg, { system, user, meta = {}, model, maxTokens }) {
  if (cfg.mockMode) {
    return validateResponse(mockComplete(cfg, meta));
  }
  const parsed = await askJson(cfg, { system, user, model, maxTokens });
  return validateResponse(parsed);
}

module.exports = { askAgent, askJson, askText, validateResponse, mockComplete, setInteractive,
  _internals: { callGroq, modelForProvider, pickGroqModel, listGroqModels, pickGroqOverflowModel, groq429WaitMs,
    resetGroqCache: () => { groqModelsCache = null; } } };

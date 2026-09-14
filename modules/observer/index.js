'use strict';

/**
 * HIVE OBSERVER — the detail-capture system (from HIVE_OBSERVER_MODE.md,
 * the "Machine" approach): capture everything with context, store at
 * maximum granularity, connect observations into patterns, keep memory
 * fresh — and run silently in the background across all state
 * transitions without disrupting the main thread.
 *
 * Pieces:
 *   - recordEvent()      → every dispatch/cycle/notification lands in the memory store
 *   - onEnvironmentTick() → background loop: vault/calendar deltas become observations
 *   - checkIn()          → the 6×/day capture prompts (07:00…21:00)
 *   - capture(text)      → rich memory entry from raw text (+ precision questions
 *                          when detail is thin — the Observer never settles for
 *                          "we talked about the project")
 *   - sweep()            → periodic pattern detection across recent observations
 */
const path = require('path');
const logger = require('../../src/lib/logger');
const notify = require('../../src/lib/notify');
const stateLib = require('../../src/lib/state');
const util = require('../../src/lib/util');
const obsidian = require('../../src/context/obsidian');
const profile = require('../../src/profile');
const memoryStore = require('../../core/memory-store');

const MEMORY_ROOT = 'Hive/memories';
const CHECKIN_THROTTLE_MS = 3 * 60 * 60 * 1000; // catch-up never spams 6 prompts at once

// ── background event logging (never throws, never blocks) ───────────
function recordEvent(cfg, { type, source, text, data, tags } = {}) {
  try {
    const store = memoryStore.load(cfg);
    memoryStore.record(cfg, store, { type, source, text, data, tags });
    memoryStore.save(cfg, store);
  } catch (e) {
    logger.warn(`observer record failed: ${e.message}`);
  }
}

/** Background loop: diff the environment and record only what changed. */
function onEnvironmentTick(cfg, state) {
  try {
    if (!cfg.vaultPath) return;
    const st = stateLib.agentState(state, 'observer');
    const notes = obsidian.listNotes(cfg.vaultPath);
    const snapshot = { noteCount: notes.length, takenAt: new Date().toISOString() };
    const prev = st.env || null;

    if (prev && prev.noteCount !== snapshot.noteCount) {
      const delta = snapshot.noteCount - prev.noteCount;
      recordEvent(cfg, {
        type: 'environment',
        source: 'observer',
        text: `Vault changed: ${delta > 0 ? '+' : ''}${delta} note(s) since last check (${snapshot.noteCount} total)`,
        tags: ['vault', 'delta'],
      });
    }
    st.env = snapshot;
  } catch { /* silent by design */ }
}

// ── capture prompts (6×/day) ────────────────────────────────────────
const CHECKINS = {
  morning: '🌅 OBSERVER MORNING CHECK — anything from last night to capture? Ideas, concerns, observations?',
  midmorning: '📍 OBSERVER CONTEXT CHECK — who have you talked to in the last 2 hours? What did you notice?',
  noon: '☀️ OBSERVER MIDDAY CHECK — interesting conversations or observations so far today?',
  afternoon: '🎯 OBSERVER AFTERNOON CHECK — anything happening at work/study worth remembering? Patterns emerging?',
  evening: '🌆 OBSERVER EVENING CHECK — what stood out today? Any insights to capture?',
  night: '🌙 OBSERVER NIGHT REFLECTION — end-of-day consolidation. Important interactions? Context for tomorrow?',
};

/** Fired by the scheduler. Throttled so wake-from-sleep runs one prompt, not six. */
function checkIn(cfg, state, label = 'checkin') {
  const st = stateLib.agentState(state, 'observer');
  const last = st.lastCheckInAt ? Date.parse(st.lastCheckInAt) : 0;
  if (Date.now() - last < CHECKIN_THROTTLE_MS) return false;
  st.lastCheckInAt = new Date().toISOString();

  const msg = CHECKINS[label] || CHECKINS.morning;
  notify.notify(cfg, { title: '🕵️ Observer', message: msg });
  try {
    obsidian.appendTo(cfg.vaultPath, 'Hive/Inbox.md',
      `\n- **${util.ts()}** 🕵️ ${msg}\n  - _capture with: npm run observe -- "what happened, who said what, what you noticed"_`);
  } catch { /* ignore */ }
  recordEvent(cfg, { type: 'checkin', source: 'observer', text: msg, tags: ['checkin', label] });
  return true;
}

// ── capture (raw text → rich memory entry) ──────────────────────────
const COMMON_WORDS = new Set(('the a an and or but i you he she we they it my your our their this that today tomorrow yesterday now then just had have was were said says say met meet meeting with about for from what when where why how ok okay yeah yes no not '
  + 'monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december '
  + 'tph econ math d365 zund obsidian hive york university prof professor manager am pm ok').split(' '));

function detectPersons(text) {
  const found = new Set();
  for (const c of profile.contacts) {
    if (c.name && text.toLowerCase().includes(c.name.split(/\s+/).pop().toLowerCase())) found.add(c.name);
  }
  for (const m of /\b([A-Z][a-z]{2,})\b/g.exec ? text.match(/\b([A-Z][a-z]{2,})\b/g) || [] : []) {
    if (!COMMON_WORDS.has(m.toLowerCase())) found.add(m);
  }
  return [...found].slice(0, 3);
}

function detectType(text) {
  const t = text.toLowerCase();
  if (/talked|spoke|said|conversation|chat|call|meeting|met with|coffee/.test(t)) return 'conversation';
  if (/idea|what if|concept|maybe we|startup|could build|brainstorm/.test(t)) return 'idea';
  if (/deadline|due|shift|class|exam|appointment|schedule/.test(t)) return 'event';
  return 'observation';
}

function extractQuotes(text) {
  return [...text.matchAll(/"([^"]{5,})"/g)].map((m) => m[1]).slice(0, 4);
}

function isThin(text) {
  return text.trim().length < 120 || (extractQuotes(text).length === 0 && text.trim().length < 300);
}

function precisionQuestions(text, persons, type) {
  const who = persons[0] || 'they';
  const qs = [];
  if (type === 'conversation') {
    qs.push(`What EXACTLY did ${who} say? Word for word, if you can recall — "I like it" and "it's interesting" mean different things.`);
    qs.push(`How did ${who} sound — confident, uncertain, dismissive? And body language: leaning in or backing out?`);
    qs.push(`Interest level 1–10, and what would make it a 10?`);
  } else if (type === 'idea') {
    qs.push(`What problem does this idea solve, specifically? Who has that problem today?`);
    qs.push(`What would you need to believe — or learn — to commit to it?`);
  } else {
    qs.push(`What did you notice that others might have missed? Exact details, numbers, wording.`);
    qs.push(`Why does this matter right now — what does it connect to?`);
  }
  qs.push(`Anything you're leaving out because it seemed unimportant? (That's usually the detail that matters.)`);
  return qs.slice(0, 4);
}

/** Mock extraction — deterministic, offline. */
function mockExtract(text) {
  const persons = detectPersons(text);
  const type = detectType(text);
  const quotes = extractQuotes(text);
  const thin = isThin(text);
  return {
    type,
    persons,
    quotes,
    thin,
    questions: thin ? precisionQuestions(text, persons, type) : [],
  };
}

/** Write a structured memory entry (spec format, condensed) to the vault. */
function writeMemoryEntry(cfg, text, ex) {
  const day = util.todayStr();
  const time = util.ts().split(' ')[1];
  const files = [];

  const entry = [
    `## ${time} — ${ex.type}${ex.persons.length ? ` · ${ex.persons.join(', ')}` : ''}`,
    '',
    '**Detailed observation (as captured):**',
    text,
    ex.quotes.length ? `\n**Exact quotes:**\n${ex.quotes.map((q) => `> "${q}"`).join('\n')}` : '',
    `\n**Context:** captured ${util.ts()} · confidence: ${ex.thin ? 'low — needs detail' : 'medium'}`,
    ex.followUps && ex.followUps.length ? `\n**Follow-ups:**\n${ex.followUps.map((f) => `- [ ] ${f}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');

  const w = (rel) => {
    try { obsidian.appendTo(cfg.vaultPath, rel, `\n${entry}\n`); files.push(rel); } catch (e) { logger.warn(`observer write failed (${rel}): ${e.message}`); }
  };
  w(`${MEMORY_ROOT}/events/${day}.md`);
  for (const p of ex.persons) w(`${MEMORY_ROOT}/persons/${util.slug(p)}.md`);
  if (ex.type === 'idea') w(`${MEMORY_ROOT}/ideas/${util.slug(text.slice(0, 40))}.md`);
  if (ex.type === 'conversation') w(`${MEMORY_ROOT}/conversations/${day}.md`);
  return files;
}

/**
 * Capture an observation. Real mode → LLM extracts a rich structured
 * entry; mock mode → heuristics. Either way: vault entry + memory-store
 * record + precision questions when detail is thin.
 */
async function capture(cfg, state, text) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, error: 'nothing to capture' };

  let ex;
  if (cfg.mockMode) {
    ex = mockExtract(raw);
  } else {
    const llm = require('../../src/lib/llm');
    const parsed = await llm.askJson(cfg, {
      system: OBSERVER_EXTRACT_SYSTEM,
      user: `Capture this observation. Respond with JSON only.\n\n"${raw}"`,
      maxTokens: 1200,
    });
    ex = {
      type: /conversation|idea|event|observation/.test(parsed.type) ? parsed.type : 'observation',
      persons: (Array.isArray(parsed.persons) ? parsed.persons : []).slice(0, 3).map(String),
      quotes: (Array.isArray(parsed.exact_quotes) ? parsed.exact_quotes : []).slice(0, 4).map(String),
      thin: Boolean(parsed.needs_more_detail),
      followUps: (Array.isArray(parsed.follow_ups) ? parsed.follow_ups : []).slice(0, 5).map(String),
      questions: (Array.isArray(parsed.precision_questions) ? parsed.precision_questions : []).slice(0, 4).map(String),
    };
  }

  const files = writeMemoryEntry(cfg, raw, ex);
  recordEvent(cfg, {
    type: 'memory',
    source: 'observer',
    text: raw,
    data: { type: ex.type, persons: ex.persons },
    tags: [ex.type, ...ex.persons.map((p) => util.slug(p))],
  });

  return {
    ok: true,
    entry: { type: ex.type, persons: ex.persons, thin: ex.thin },
    files,
    questions: ex.questions || [],
  };
}

const OBSERVER_EXTRACT_SYSTEM = `You are OBSERVER, the detailed-memory mode of HIVE. Extract a structured memory entry from the user's raw observation. Capture EVERY detail provided — never simplify. If the observation is thin (no exact quotes, no tone, no specifics), set needs_more_detail=true and write precision questions that pull out: exact wording, tone/body language, numbers, and what seemed unimportant. Respond ONLY with JSON:
{"type":"conversation|idea|event|observation","persons":["names mentioned"],"exact_quotes":["verbatim quotes"],"needs_more_detail":true|false,"follow_ups":["actions needed"],"precision_questions":["questions that extract missing detail"]}`;

// ── pattern sweep (observer agent cycle) ────────────────────────────
/** Cross-reference recent observations; record and surface patterns. */
async function sweep(cfg, agent, state) {
  const store = memoryStore.load(cfg);
  const recentObs = memoryStore.recent(store, 40).filter((o) => o.type === 'memory' || o.type === 'capture');
  const st = stateLib.agentState(state, agent.id);
  let patterns = [];

  if (cfg.mockMode) {
    // heuristic: person/topic frequency across recent captures
    const freq = {};
    for (const o of recentObs) {
      for (const t of o.tags.filter((x) => x !== 'memory' && x !== 'capture')) {
        freq[t] = (freq[t] || 0) + 1;
      }
    }
    patterns = Object.entries(freq)
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([tag, n]) => `**${tag}** mentioned in ${n} recent observations — a thread worth pulling.`);
  } else {
    const llm = require('../../src/lib/llm');
    const parsed = await llm.askJson(cfg, {
      system: `You are OBSERVER's connection engine. Given recent observation summaries, detect cross-cutting patterns (repeated people/topics/objections, contradictions, evolution). Respond ONLY with JSON: {"patterns":["pattern — evidence"],"follow_ups":["suggested action"]}`,
      user: recentObs.length
        ? recentObs.map((o) => `- [${o.at.slice(0, 10)}] (${o.tags.join(',')}) ${o.text.slice(0, 200)}`).join('\n')
        : '(no observations yet)',
      maxTokens: 800,
    });
    patterns = (Array.isArray(parsed.patterns) ? parsed.patterns : []).slice(0, 5).map(String);
  }

  if (patterns.length) {
    try {
      obsidian.appendTo(cfg.vaultPath, `${MEMORY_ROOT}/connections/pattern-analysis.md`,
        `\n## ${util.ts()}\n${patterns.map((p) => `- ${p}`).join('\n')}`);
    } catch { /* ignore */ }
    recordEvent(cfg, { type: 'pattern', source: 'observer', text: patterns.join(' | '), tags: ['pattern'] });
  }

  st.lastRun = new Date().toISOString();
  st.lastSummary = `Observer sweep: ${recentObs.length} observations reviewed, ${patterns.length} pattern(s) detected`;
  st.recentCycles.push(`${util.timeStr()} — ${st.lastSummary}`);
  logger.vaultLog(cfg, `🕵️ ${st.lastSummary}`);
  return { ok: true, summary: st.lastSummary, patterns };
}

module.exports = { recordEvent, onEnvironmentTick, checkIn, capture, sweep, mockExtract, writeMemoryEntry, CHECKINS };

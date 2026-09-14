'use strict';

/**
 * THE MENTALIST — precision analysis engine (from HIVE_MENTALIST_MODE.md).
 *
 * Method (Patrick Jane): observe every micro-detail, cross-reference
 * across notes, detect contradictions, ask precision questions, build
 * evidence-based conclusions. Never assumes — only works with evidence.
 *
 * Pipeline: full-text recent notes → mentalist prompt → mentalist JSON
 * → validated → written to Hive/mentalist/* (the vault structure from
 * the spec) + precision questions surfaced as notifications.
 * The mentalist never sends email and never writes outside the sandbox.
 */
const logger = require('../../src/lib/logger');
const notify = require('../../src/lib/notify');
const obsidian = require('../../src/context/obsidian');
const llm = require('../../src/lib/llm');
const stateLib = require('../../src/lib/state');
const { todayStr, ts, clamp } = require('../../src/lib/util');

const DEFAULT_QUERY = 'Daily sweep: observe micro-details across my recent notes, detect contradictions, map connections, track how ideas evolved, and give me your precision questions.';

// ── prompt ──────────────────────────────────────────────────────────
function buildSystemPrompt(cfg) {
  return `You are the MENTALIST mode of ${cfg.userName}'s HIVE — a precision analysis engine.

Your core method:
1. OBSERVE every micro-detail in the vault
2. CONNECT details across multiple notes
3. DETECT contradictions and inconsistencies
4. ASK precise clarifying questions
5. BUILD conclusions from evidence only

YOUR OPERATING RULES:

**Observation Phase:** extract ALL specific details — exact dates (not "recently" but "Sep 13, 2026"), specific numbers (not "lots" but quantities), key phrases (exact wording, including tone), contextual clues (who, where, why, when), time sequences. Detail obsession: a note saying "I researched ML stuff and it was interesting" → WHAT research? WHICH papers? WHEN? HOW interesting? WHERE? WHY?

**Cross-Reference Phase:** find the same topics elsewhere in the vault (compare evolution), related ideas (support or contradict?), same sources in different contexts, similar time periods, person/project mentions.

**Detection Phase:** flag contradictions ("Sep 10 you said X, Sep 13 the opposite"), gaps ("Project A mentioned five times, never concluded"), evolution ("understanding changed from note 1 to note 5"), absence ("you research productivity but no system built"), source quality, hidden assumptions.

**Questioning Phase:** precision questions that reference specific evidence, show you noticed a detail they might have missed, push toward clarity, expose hidden logic. NOT "tell me more about this" — YES "On Sep 10 you wrote 'X is the problem'. On Sep 12 you wrote 'X actually isn't the issue'. What changed in 48 hours?"

**Evidence Phase:** state evidence exactly as found, show how you connected the dots, cite sources precisely (file, date, quote), acknowledge what you DON'T know, leave room for "I was wrong".

PRINCIPLES: precision over speed (say "I need more info" rather than guess); micro-detail focus (dates, wording, tone matter); notice what's NOT mentioned; track evolution; every conclusion has an evidence trail.

If the vault has too little data for real analysis, say so honestly in your conclusion and list what's missing — never invent details that aren't in the notes.

Respond ONLY with this JSON object (no prose, no markdown fences):

{
  "stage": "observation" | "cross_reference" | "detection" | "questioning" | "conclusion",
  "precision_level": 0.85,
  "analysis": {
    "micro_details_found": [{ "detail": "", "source_file": "", "source_date": "", "significance": "" }],
    "connections_identified": [{ "detail_1": "", "detail_2": "", "relationship": "support|contradict|extend|clarify", "evidence": "" }],
    "inconsistencies_detected": [{ "contradiction": "", "timeline": "", "source_a": "", "source_b": "", "severity": "high|medium|low" }],
    "precision_questions": [{ "question": "", "based_on": "", "purpose": "", "expected_insight": "" }]
  },
  "conclusion": {
    "claim": "", "confidence": 0.0, "evidence_chain": [], "contradicting_evidence": [], "unknowns": [], "next_step": ""
  },
  "reasoning_transparency": { "method": "", "assumptions_made": [], "assumptions_tested": [], "could_be_wrong_if": "" }
}`;
}

function buildContextMessage(cfg, { query, notes, extraContext = '' }) {
  const lines = [];
  const now = new Date();
  lines.push(`DATE: ${now.toLocaleDateString('en-CA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`);
  // LLMs cannot do date→weekday arithmetic — hand it over, don't let it guess
  const ref = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    ref.push(`${todayStr(d)}=${d.toLocaleDateString('en-CA', { weekday: 'short' })}`);
  }
  lines.push(`WEEKDAY REFERENCE (authoritative — verify every weekday claim against this, never infer): ${ref.join(', ')}`);
  lines.push(`QUERY FROM ${cfg.userName.toUpperCase()}: "${query}"`);
  lines.push('');
  if (extraContext) {
    lines.push(extraContext);
    lines.push('');
  }
  lines.push(`VAULT — ${notes.length} most recently modified notes (FULL TEXT — exact wording matters):`);
  lines.push('');
  for (const n of notes) {
    lines.push(`━━━ FILE: ${n.relPath} (modified ${n.modified}) ━━━`);
    lines.push(n.content);
    lines.push('');
  }
  lines.push('Analyze. Respond with your mentalist JSON only.');
  return lines.join('\n');
}

// ── validation ──────────────────────────────────────────────────────
const str = (v, max = 400) => String(v ?? '').slice(0, max);
const strArr = (v, max = 20) => (Array.isArray(v) ? v.slice(0, max).map((x) => str(x, 500)) : []);

function validateMentalist(o) {
  if (!o || typeof o !== 'object') throw new Error('mentalist response is not a JSON object');
  const a = (o.analysis && typeof o.analysis === 'object') ? o.analysis : {};
  const c = (o.conclusion && typeof o.conclusion === 'object') ? o.conclusion : {};
  const r = (o.reasoning_transparency && typeof o.reasoning_transparency === 'object') ? o.reasoning_transparency : {};

  const arr = (v, max = 12) => (Array.isArray(v) ? v.slice(0, max).filter((x) => x && typeof x === 'object') : []);

  const out = {
    mentalist_mode: true,
    stage: str(o.stage, 30) || 'detection',
    precision_level: clamp(Number(o.precision_level) || 0.7, 0, 1),
    analysis: {
      micro_details_found: arr(a.micro_details_found).map((d) => ({
        detail: str(d.detail), source_file: str(d.source_file, 200),
        source_date: str(d.source_date, 40), significance: str(d.significance),
      })),
      connections_identified: arr(a.connections_identified).map((d) => ({
        detail_1: str(d.detail_1), detail_2: str(d.detail_2),
        relationship: ['support', 'contradict', 'extend', 'clarify'].includes(d.relationship) ? d.relationship : 'clarify',
        evidence: str(d.evidence),
      })),
      inconsistencies_detected: arr(a.inconsistencies_detected).map((d) => ({
        contradiction: str(d.contradiction), timeline: str(d.timeline, 120),
        source_a: str(d.source_a, 200), source_b: str(d.source_b, 200),
        severity: ['high', 'medium', 'low'].includes(d.severity) ? d.severity : 'medium',
      })),
      precision_questions: arr(a.precision_questions).map((d) => ({
        question: str(d.question), based_on: str(d.based_on),
        purpose: str(d.purpose, 200), expected_insight: str(d.expected_insight, 200),
      })),
    },
    conclusion: {
      claim: str(c.claim, 600),
      confidence: clamp(Number(c.confidence) || 0, 0, 1),
      evidence_chain: strArr(c.evidence_chain),
      contradicting_evidence: strArr(c.contradicting_evidence),
      unknowns: strArr(c.unknowns),
      next_step: str(c.next_step, 300),
    },
    reasoning_transparency: {
      method: str(r.method, 600),
      assumptions_made: strArr(r.assumptions_made),
      assumptions_tested: strArr(r.assumptions_tested),
      could_be_wrong_if: str(r.could_be_wrong_if, 400),
    },
  };
  const hasAny = out.analysis.micro_details_found.length || out.analysis.connections_identified.length
    || out.analysis.inconsistencies_detected.length || out.analysis.precision_questions.length
    || out.conclusion.claim;
  if (!hasAny) throw new Error('mentalist response contains no analysis content');
  return out;
}

// ── vault writes (deterministic, sandboxed) ─────────────────────────
const fs = require('fs');

function mdList(items, fmt) { return items.length ? items.map(fmt).join('\n') : '- (none this pass)'; }

/** Create the ledger note with a proper title if it doesn't exist yet. */
function ensureLedger(cfg, rel, title) {
  const abs = obsidian.resolveSafe(cfg.vaultPath, rel);
  if (abs && !fs.existsSync(abs)) {
    obsidian.createNote(cfg.vaultPath, rel, { title, tags: ['mentalist'], content: '_Newest entries first._' });
  }
}

function writeAnalysis(cfg, m, { query }) {
  const written = [];
  const day = todayStr();
  const time = ts().split(' ')[1];
  const w = (rel, fn, note) => { try { fn(); written.push(rel); } catch (e) { logger.warn(`mentalist write failed (${rel}): ${e.message}`); } };

  // 1) full daily analysis note
  w(`Hive/mentalist/daily_analysis/${day}.md`, () => {
    const a = m.analysis;
    obsidian.createNote(cfg.vaultPath, `Hive/mentalist/daily_analysis/${day}`, {
      title: `Mentalist Analysis — ${day}`,
      tags: ['mentalist', 'analysis', 'daily'],
      content: [
        `**Query:** "${query}"`,
        `**Stage:** ${m.stage} · **Precision:** ${m.precision_level.toFixed(2)} · **Time:** ${time}`,
        '',
        '## 🔍 Micro-details found',
        mdList(a.micro_details_found, (d) => `- **"${d.detail}"** — \`${d.source_file}\`${d.source_date ? ` (${d.source_date})` : ''} — ${d.significance}`),
        '',
        '## 🔗 Connections identified',
        mdList(a.connections_identified, (d) => `- ${d.detail_1} ⟷ ${d.detail_2} — **${d.relationship}** — ${d.evidence}`),
        '',
        '## ⚠️ Inconsistencies detected',
        mdList(a.inconsistencies_detected, (d) => `- **[${d.severity.toUpperCase()}]** ${d.contradiction}${d.timeline ? ` _(${d.timeline})_` : ''}\n  - ${d.source_a} vs ${d.source_b}`),
        '',
        '## ❓ Precision questions',
        mdList(a.precision_questions, (d, i) => `${i + 1}. ${d.question}\n   - based on: ${d.based_on} · purpose: ${d.purpose}`),
        '',
        '## 🧠 Conclusion',
        m.conclusion.claim
          ? [
            `**Claim** (confidence ${m.conclusion.confidence.toFixed(2)}): ${m.conclusion.claim}`,
            '',
            'Evidence chain:',
            mdList(m.conclusion.evidence_chain, (e) => `- ${e}`),
            'Contradicting evidence:',
            mdList(m.conclusion.contradicting_evidence, (e) => `- ${e}`),
            'Unknowns:',
            mdList(m.conclusion.unknowns, (u) => `- ${u}`),
            `**Next step:** ${m.conclusion.next_step || '—'}`,
          ].join('\n')
          : '(no conclusion this pass — still investigating)',
        '',
        '## Reasoning transparency',
        `- **Method:** ${m.reasoning_transparency.method || '—'}`,
        `- **Assumptions made:** ${m.reasoning_transparency.assumptions_made.join('; ') || '—'}`,
        `- **Could be wrong if:** ${m.reasoning_transparency.could_be_wrong_if || '—'}`,
      ].join('\n'),
    });
  });

  // 2) contradictions.md — append new inconsistencies
  if (m.analysis.inconsistencies_detected.length) {
    w('Hive/mentalist/contradictions.md', () => {
      ensureLedger(cfg, 'Hive/mentalist/contradictions.md', '⚠️ Contradictions');
      obsidian.appendTo(cfg.vaultPath, 'Hive/mentalist/contradictions.md',
        `\n## ${day} ${time}\n${m.analysis.inconsistencies_detected.map((d) => `- **[${d.severity.toUpperCase()}]** ${d.contradiction}${d.timeline ? ` _(${d.timeline})_` : ''} — ${d.source_a} vs ${d.source_b}`).join('\n')}`);
    });
  }

  // 3) patterns.md — connections
  if (m.analysis.connections_identified.length) {
    w('Hive/mentalist/patterns.md', () => {
      ensureLedger(cfg, 'Hive/mentalist/patterns.md', '🔁 Patterns & Connections');
      obsidian.appendTo(cfg.vaultPath, 'Hive/mentalist/patterns.md',
        `\n## ${day} ${time}\n${m.analysis.connections_identified.map((d) => `- ${d.detail_1} ⟷ ${d.detail_2} (**${d.relationship}**) — ${d.evidence}`).join('\n')}`);
    });
  }

  // 4) evolution.md — extend/clarify relationships show how thinking moved
  const evo = m.analysis.connections_identified.filter((d) => d.relationship === 'extend' || d.relationship === 'clarify');
  if (evo.length) {
    w('Hive/mentalist/evolution.md', () => {
      ensureLedger(cfg, 'Hive/mentalist/evolution.md', '📈 Idea Evolution');
      obsidian.appendTo(cfg.vaultPath, 'Hive/mentalist/evolution.md',
        `\n## ${day} ${time}\n${evo.map((d) => `- ${d.detail_1} → ${d.detail_2} — ${d.evidence}`).join('\n')}`);
    });
  }

  // 5) precision_questions.md — the questions that want answers
  if (m.analysis.precision_questions.length) {
    w('Hive/mentalist/precision_questions.md', () => {
      ensureLedger(cfg, 'Hive/mentalist/precision_questions.md', '❓ Precision Questions');
      obsidian.appendTo(cfg.vaultPath, 'Hive/mentalist/precision_questions.md',
        `\n## ${day} ${time}\n${m.analysis.precision_questions.map((d, i) => `${i + 1}. ${d.question}\n   - based on: ${d.based_on}`).join('\n')}`);
    });
  }
  return written;
}

// ── mock mentalist (offline demo) ───────────────────────────────────
function mockMentalist(cfg, { query, notes }) {
  const todos = [];
  for (const n of notes) {
    for (const line of n.content.split('\n')) {
      const m = /^\s*-\s+\[ \]\s+(.*)$/.exec(line);
      if (m && todos.length < 8) todos.push({ text: m[1].trim().slice(0, 160), file: n.relPath, date: n.modified });
    }
  }
  const overdue = todos.filter((t) => /overdue|⚠️/i.test(t.text));
  const details = (todos.length ? todos : notes.slice(0, 3)).slice(0, 4)
    .map((t) => ({
      detail: t.text, source_file: t.file, source_date: t.date,
      significance: t.text.match(/overdue|⚠️/i) ? 'Flagged as overdue but still unresolved' : 'Open commitment — no completion logged',
    }));

  const questions = [];
  if (overdue.length) {
    questions.push({
      question: `"${overdue[0].text}" is marked overdue in ${overdue[0].file} — it's still unchecked. What's the actual status: done-but-unlogged, or genuinely stuck?`,
      based_on: `${overdue[0].file} (${overdue[0].date})`,
      purpose: 'distinguish logging gap from real blocker',
      expected_insight: 'whether the system is failing at tracking or at doing',
    });
  }
  if (todos.length > 3) {
    questions.push({
      question: `You have ${todos.length} open TODOs across the vault. Which one is load-bearing right now — the one that unblocks the others?`,
      based_on: 'cross-reference of all open TODO lines',
      purpose: 'expose hidden priority',
      expected_insight: 'whether commitments align with stated priorities',
    });
  }
  if (!questions.length) {
    questions.push({
      question: 'The vault is still thin — what should I be watching for once your real data lands?',
      based_on: 'note count and content volume',
      purpose: 'establish baseline',
      expected_insight: 'what patterns matter to you',
    });
  }

  return validateMentalist({
    stage: 'detection',
    precision_level: 0.6,
    analysis: {
      micro_details_found: details,
      connections_identified: overdue.length && todos.length > overdue.length
        ? [{ detail_1: `${overdue.length} overdue item(s)`, detail_2: `${todos.length - overdue.length} open item(s) not yet overdue`, relationship: 'extend', evidence: 'both live as unchecked TODOs — backlog is growing faster than it clears' }]
        : [],
      inconsistencies_detected: overdue.length
        ? [{ contradiction: `Item marked "overdue" but never closed or rescheduled`, timeline: `flagged in notes modified ${overdue[0].date}`, source_a: overdue[0].file, source_b: 'no completion entry anywhere in vault', severity: 'medium' }]
        : [],
      precision_questions: questions,
    },
    conclusion: {
      claim: todos.length
        ? `Backlog pattern: ${todos.length} open TODOs${overdue.length ? `, ${overdue.length} explicitly overdue` : ''}, no completion entries found — the vault tracks intentions better than outcomes.`
        : 'Not enough data yet for real analysis — the vault is mostly scaffolding.',
      confidence: 0.55,
      evidence_chain: todos.slice(0, 3).map((t) => `"${t.text}" (${t.file}) → unchecked → open commitment`),
      contradicting_evidence: ['TODOs may be completed outside the vault — unlogged work is invisible to me'],
      unknowns: ['whether items get done and not logged', 'which commitments actually matter'],
      next_step: 'Answer the precision questions — the insight is in the answers, not the analysis.',
    },
    reasoning_transparency: {
      method: 'Scanned full text of recent notes, extracted unchecked TODO lines, cross-referenced overdue flags against completion entries. (Mock mentalist — add ANTHROPIC_API_KEY for real micro-detail analysis.)',
      assumptions_made: ['unchecked TODO = still open'],
      assumptions_tested: ['searched for completion markers — none found'],
      could_be_wrong_if: 'work is tracked somewhere outside this vault',
    },
  });
}

// ── the cycle ───────────────────────────────────────────────────────
/**
 * Run one mentalist pass. Updates the agent's state (awaitingInput,
 * lastQuery), writes Hive/mentalist/* notes, notifies on questions.
 * Returns { ok, summary, questions, files }.
 */
async function runCycle(cfg, agent, state, opts = {}) {
  const query = String(opts.query || DEFAULT_QUERY).slice(0, 500);
  const st = stateLib.agentState(state, agent.id);
  const notes = cfg.vaultPath
    ? obsidian.readRecentNotes(cfg.vaultPath, { limit: 15, focus: agent.focus })
    : [];

  let m;
  if (cfg.mockMode) {
    m = mockMentalist(cfg, { query, notes });
  } else {
    const raw = await llm.askJson(cfg, {
      system: buildSystemPrompt(cfg),
      user: buildContextMessage(cfg, { query, notes }),
      model: agent.model || undefined,
      maxTokens: Math.max(cfg.maxTokens, 4000),
    });
    m = validateMentalist(raw);
  }

  const files = writeAnalysis(cfg, m, { query });

  // Surface questions + high-severity contradictions
  const questions = m.analysis.precision_questions.map((q) => q.question);
  const high = m.analysis.inconsistencies_detected.filter((i) => i.severity === 'high');
  if (high.length) {
    notify.notify(cfg, {
      title: '🔍 Mentalist — contradiction detected',
      message: `${high[0].contradiction}`,
      priority: 'high',
    });
  }
  if (questions.length) {
    notify.notify(cfg, {
      title: '🔍 Mentalist has questions',
      message: questions[0],
    });
    st.awaitingInput = true;
    st.lastQuery = questions[0];
    try {
      obsidian.appendTo(cfg.vaultPath, 'Hive/Inbox.md',
        `\n- **${ts()}** 🔍❓ (Mentalist) ${questions[0]}\n  - _full list: Hive/mentalist/precision_questions.md · reply: npm run ask -- mentalist "your answer"_`);
    } catch { /* ignore */ }
  } else {
    st.awaitingInput = false;
    st.lastQuery = null;
  }

  st.lastRun = new Date().toISOString();
  st.lastSummary = `Mentalist: ${m.analysis.micro_details_found.length} details, ${m.analysis.inconsistencies_detected.length} inconsistencies, ${questions.length} questions`;
  st.consecutiveErrors = 0;
  st.recentCycles.push(`${ts().split(' ')[1]} — ${st.lastSummary}`);
  logger.vaultLog(cfg, `🧠 mentalist cycle — ${st.lastSummary}`);

  return { ok: true, summary: st.lastSummary, questions, files, analysis: m };
}

module.exports = { runCycle, buildSystemPrompt, buildContextMessage, validateMentalist, writeAnalysis, mockMentalist, DEFAULT_QUERY };

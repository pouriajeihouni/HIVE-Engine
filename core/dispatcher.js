'use strict';

/**
 * HIVE DISPATCHER — the router at the heart of the unified system
 * (the adaptation of the spec's core/dispatcher.py). One conversational
 * facade ("Hive"), many modules:
 *
 *   Intent: Capture/Observe    → modules/observer  (memory capture)
 *   Intent: Search/Retrieve    → modules/knowledge (vector index + RAG)
 *   Intent: Analyze/Synthesize → modules/mentalist (precision analysis)
 *   Intent: Task/Action        → modules/executor  (via the chief agent)
 *
 * The Observer is hooked into every dispatch (background loop: active
 * across all state transitions), so everything the system handles is
 * logged to the central memory store.
 */
const logger = require('../src/lib/logger');
const agentsLib = require('../src/agents');
const stateLib = require('../src/lib/state');
const knowledge = require('../modules/knowledge');
const observer = require('../modules/observer');
const mentalist = require('../modules/mentalist');

// ── intent classification ───────────────────────────────────────────
const RULES = [
  {
    module: 'observer', intent: 'capture',
    re: /\b(observe|log this|capture|remember this|note that|just (talked|spoke|met|saw|had)|met with|caught myself|noticed that)\b/i,
  },
  {
    module: 'mentalist', intent: 'analyze',
    re: /\b(analy[sz]e|analysi[sz]|why do i|why am i|patterns?|contradictions?|inconsistenc\w+|what changed|connect the|synthesi[sz]e|deep dive)\b/i,
  },
  // explicit task verbs beat search phrasing ("create a note about X" is a task, not a query)
  {
    module: 'executor', intent: 'task',
    re: /\b(remind me|email|draft|send|schedule|set (an )?(alarm|reminder)|create|make|plan|brief|summarize my day)\b/i,
  },
  {
    module: 'knowledge', intent: 'search',
    re: /\b(find|search|look up|retrieve|where (is|are|did)|what did i (write|say|note)|notes? (say|about)|any notes|anything about|do i have (anything|notes|a note)|documentation|docs? about|which note|pull up|what do you know about|tell me about|what (is|are) my)\b/i,
  },
  // question-shape catch-all: unmatched questions are queries, not tasks
  // (real tasks/captures/analysis were already matched by the rules above)
  {
    module: 'knowledge', intent: 'search',
    re: /^(what|who|when|where|why|how|which|does|do|is|are|am i|did i|have i|can you tell me)\b/i,
  },
];

function classify(text) {
  const t = String(text || '');
  for (const r of RULES) {
    if (r.re.test(t)) return { module: r.module, intent: r.intent };
  }
  return { module: 'executor', intent: 'task' }; // default: task/action
}

// ── handlers ────────────────────────────────────────────────────────
async function handleTask(cfg, state, text, opts = {}) {
  const agentMod = require('../src/agent'); // late require: avoids any load cycle
  const agents = agentsLib.loadAgentsSafe(cfg);
  const chief = agents.find((a) => a.role === 'chief' && a.enabled)
    || agents.find((a) => a.role === 'chief');
  if (!chief) throw new Error('no chief agent enabled in data/agents.json');

  stateLib.queueAgentMessage(state, chief.id, text, opts.displayYou ? { display: opts.displayYou } : undefined);
  const r = await agentMod.runAgentCycle(cfg, chief, state, {});
  if (!r.ok) return { reply: `Task module failed: ${r.error}`, executed: [] };
  const lines = (r.executed || []).map((e) => `${e.ok ? '✅' : '❌'} ${e.type}${e.detail ? ` — ${String(e.detail).replace(/\s+/g, ' ').slice(0, 120)}` : ''}`);
  return { reply: r.summary || '(done)', executed: lines, agent: chief.id };
}

async function handleSearch(cfg, state, text) {
  const { text: answer, results } = await knowledge.answer(cfg, text);
  return { reply: answer, results };
}

async function handleAnalyze(cfg, state, text) {
  const agents = agentsLib.loadAgentsSafe(cfg);
  const mAgent = agents.find((a) => a.role === 'mentalist' && a.enabled)
    || agents.find((a) => a.role === 'mentalist');
  if (!mAgent) throw new Error('no mentalist agent enabled in data/agents.json');

  // Unified behavior: give the analyst the relevant knowledge first (RAG context)
  let extraContext = '';
  try {
    const hits = knowledge.search(cfg, text, { k: 3, includeMemory: true });
    if (hits.length) {
      extraContext = 'RELATED KNOWLEDGE (retrieved by the knowledge module):\n'
        + hits.map((h) => `- ${h.relPath}${h.heading && h.heading !== '(top)' ? ` (${h.heading})` : ''}: ${h.snippet.slice(0, 180)}`).join('\n');
    }
  } catch { /* knowledge is optional context */ }

  const r = await mentalist.runCycle(cfg, mAgent, state, { query: text, extraContext });
  return {
    reply: r.summary,
    questions: r.questions || [],
    files: r.files || [],
  };
}

async function handleCapture(cfg, state, text) {
  const r = await observer.capture(cfg, state, text);
  if (!r.ok) return { reply: r.error || 'capture failed' };
  const lines = r.files.map((f) => `✅ ${f}`);
  const thin = r.entry.thin
    ? '\nThe detail is thin — answer the questions below and I\'ll deepen the memory.'
    : '';
  return { reply: `Captured a ${r.entry.type}${r.entry.persons.length ? ` (${r.entry.persons.join(', ')})` : ''} to memory.${thin}`, executed: lines, questions: r.questions };
}

const HANDLERS = {
  executor: handleTask,
  knowledge: handleSearch,
  mentalist: handleAnalyze,
  observer: handleCapture,
};

/**
 * Route one user prompt through the hive. Records the exchange to the
 * memory store (observer hook) and returns a unified response.
 */
async function route(cfg, state, text, opts = {}) {
  // opts.module    — force a handler (file-carrying chats go straight to the
  //                  chief so the attachment is answered with full context)
  // opts.displayYou — short label for the conversation record (e.g. "hi 📎syllabus.pdf")
  //                  so an embedded attachment never pollutes the chat history
  const { module, intent } = opts.module ? { module: opts.module, intent: 'direct' } : classify(text);
  observer.recordEvent(cfg, {
    type: 'dispatch',
    source: 'dispatcher',
    text: `${intent} → ${module}: "${String(text).slice(0, 200)}"`,
    tags: ['dispatch', module, intent],
  });

  const handler = HANDLERS[module];
  let out;
  try {
    out = module === 'executor' ? await handler(cfg, state, text, opts) : await handler(cfg, state, text);
  } catch (e) {
    logger.error(`dispatcher ${module} failed: ${e.message}`);
    out = { reply: `The ${module} module hit an error: ${e.message}` };
  }

  // Unified conversation: EVERY exchange is recorded to state.answered so the
  // web dashboard (and any channel) shows one shared history. The executor
  // path records inside the chief's cycle (honoring the display label);
  // the other modules record here.
  if (module !== 'executor' && out && out.reply) {
    state.answered = state.answered || [];
    state.answered.push({
      text: opts.displayYou || String(text).slice(0, 400),
      reply: String(out.reply).slice(0, 4000),
      at: new Date().toISOString(),
    });
    if (state.answered.length > 10) state.answered.splice(0, state.answered.length - 10);
  }

  observer.recordEvent(cfg, {
    type: 'dispatch_result',
    source: module,
    text: String(out.reply || '').slice(0, 300),
    tags: ['dispatch', module],
  });

  return { module, intent, ...out };
}

module.exports = { classify, route };

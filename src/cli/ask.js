'use strict';

/**
 * `hive say "..."`    → the unified facade: the DISPATCHER classifies the
 *                       intent and routes to executor/knowledge/mentalist/
 *                       observer. One voice replies: Hive.
 * `hive ask <id> "..."` → bypass the router, talk to one agent directly.
 */
const agentMod = require('../agent');
const agentsLib = require('../agents');
const stateLib = require('../lib/state');
const dispatcher = require('../../core/dispatcher');
const observer = require('../../modules/observer');

function printReply(r) {
  console.log(`\n🐝 Hive (${r.module}/${r.intent}): ${r.reply}`);
  for (const e of r.executed || []) console.log(`   ${e}`);
  for (const q of (r.questions || []).slice(0, 4)) console.log(`\n❓ ${q}`);
}

async function run(cfg, agentId, text) {
  // ── unified route (say, or "ask hive") ────────────────────────────
  if (!agentId || agentId === 'hive') {
    if (!text) {
      console.log('Usage: npm run say -- "your message to Hive"');
      return;
    }
    console.log(`\n🧑 You: ${text}`);
    const state = stateLib.load(cfg);
    const r = await dispatcher.route(cfg, state, text);
    stateLib.save(cfg, state);
    printReply(r);
    if (r.questions && r.questions.length) {
      console.log('\n   ↪ answer with: npm run say -- "your answer"');
    }
    return;
  }

  // ── direct agent (ask <id>) ───────────────────────────────────────
  const agents = agentsLib.loadAgentsSafe(cfg);
  const agent = agentsLib.getAgent(agents, agentId);
  if (!agent) {
    console.log(`❌ unknown agent "${agentId}" — try one of: ${agents.map((a) => a.id).join(', ')}`);
    return;
  }
  if (!text) {
    console.log(`Usage: npm run ask -- ${agent.id} "your message"`);
    return;
  }

  console.log(`\n🧑 You → ${agent.name}: ${text}`);
  const state = stateLib.load(cfg);
  stateLib.queueAgentMessage(state, agent.id, text);
  const r = await agentMod.runAgentCycle(cfg, agent, state, {});
  stateLib.save(cfg, state);

  if (!r.ok) {
    console.error(`❌ ${agent.name} failed: ${r.error}`);
    return;
  }
  console.log(`\n🐝 Hive (${agent.id}): ${r.summary || '(done)'}`);
  for (const e of r.executed || []) {
    console.log(`   ${e.ok ? '✅' : '❌'} ${e.type}${e.detail ? ` — ${String(e.detail).replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
  }
  for (const q of (r.questions || []).slice(0, 3)) {
    console.log(`   ❓ ${String(q).replace(/\s+/g, ' ').slice(0, 500)}`);
  }
  const st = stateLib.agentState(state, agent.id);
  if (st.awaitingInput && st.lastQuery) {
    console.log(`\n❓ ${st.lastQuery}`);
    console.log(`   ↪ reply with: npm run ask -- ${agent.id} "your answer"`);
  }
}

module.exports = { run };

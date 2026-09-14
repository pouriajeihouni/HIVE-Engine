#!/usr/bin/env node
'use strict';

/**
 * HIVE — a unified personal AI intelligence layer.
 * One conversational facade; four modules behind the dispatcher:
 * executor (tasks) · knowledge (search/RAG) · mentalist (analysis) ·
 * observer (background detail capture). Plus per-agent scheduled loops.
 *
 *   hive                        run the daemon (all enabled agents)
 *   hive --once [--agent id]    one cycle, then exit
 *   hive say "..."              talk to Hive (auto-routed by intent)
 *   hive ask <agent> "..."      talk to a specific agent directly
 *   hive search "..."           query the knowledge module directly
 *   hive observe "..."          capture an observation (Observer module)
 *   hive agents [...]           manage the agent registry
 *   hive status / approve / check / verify
 */
const path = require('path');
const cfg = require('./config');
const agentMod = require('./agent');
const agentsLib = require('./agents');
const stateLib = require('./lib/state');
const logger = require('./lib/logger');
const llm = require('./lib/llm');
const dispatcher = require('../core/dispatcher');
const knowledge = require('../modules/knowledge');
const observer = require('../modules/observer');
const webPublisher = require('./web/publisher');
const relay = require('./web/relay');
const maintenance = require('./lib/maintenance');
const telegram = require('./lib/telegram');
const tgListener = require('./lib/telegram-listener');
const { run: askRun } = require('./cli/ask');
const { run: agentsCli } = require('./cli/agents');
const { run: approve } = require('./cli/approve');
const { run: statusCli } = require('./cli/status');
const { run: checkCli } = require('./cli/check');
const { run: doctorCli } = require('./cli/doctor');

const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function banner() {
  const W = 46;
  const pad = (s) => {
    let w = 0;
    for (const ch of s) w += ch.codePointAt(0) > 0xffff ? 2 : 1;
    return `│${s}${' '.repeat(Math.max(1, W - w))}│`;
  };
  let agents = [];
  try { agents = agentsLib.loadAgentsSafe(cfg); } catch { /* banner only */ }
  const agentsLine = agents.map((a) => `${a.enabled ? '🟢' : '⚪'} ${a.id}`).join('  ');
  const brainLabel = cfg.llm.provider === 'groq' ? `Groq · ${cfg.groqModel}` : 'Claude (per-agent models)';
  const mode = cfg.mockMode ? `${YELLOW}MOCK BRAINS (no API key — deterministic offline)${RESET}` : `${GREEN}${brainLabel}${RESET}`;
  const calSource = { auto: 'auto → Google → Apple → local', google: 'Google Calendar', apple: 'Apple Calendar', local: 'local data/calendar.json' }[cfg.calendarSource] || cfg.calendarSource;
  console.log(`
${CYAN}${'╭' + '─'.repeat(W) + '╮'}
${pad('  🐝 H I V E  —  unified intelligence layer')}
${pad(`     tasks · knowledge · patterns · observations`)}
${pad(`     second brain for ${cfg.userName}`)}
${'╰' + '─'.repeat(W) + '╯'}${RESET}
  Vault      : ${cfg.vaultPath || '(not set)'}${cfg.vaultIsDemo ? `  ${YELLOW}[DEMO]${RESET}` : ''}
  Brain      : ${mode}
  Agents     : ${agentsLine}
  Loop       : tick ${cfg.tickSeconds}s · dispatcher routes: task/search/analyze/capture
  Calendar   : ${calSource}
  Email      : drafts always need approval · sending ${cfg.allowEmailSend ? `${YELLOW}ENABLED${RESET}` : 'disabled (safe)'}
  Web        : ${cfg.webPublish.dir ? 'publishing → GitHub Pages' : 'off (docs/WEB_DASHBOARD.md to enable)'}
${DIM}  Ctrl+C to stop. Logs: <vault>/Agent_Logs/ · hive say "…" to talk.${RESET}
`);
}

function printCycle(r) {
  if (!r || r.skipped) return;
  if (!r.ok) {
    console.error(`   ❌ ${r.agent ? r.agent.id : 'cycle'} failed: ${r.error}`);
    return;
  }
  console.log(`   🧠 ${r.summary}`);
  for (const e of r.executed || []) {
    console.log(`   ${e.ok ? '✅' : '❌'} ${e.type}${e.detail ? ` — ${String(e.detail).replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
  }
  for (const q of (r.questions || []).slice(0, 3)) {
    console.log(`   ❓ ${String(q).replace(/\s+/g, ' ').slice(0, 500)}`);
  }
}

async function startDaemon() {
  // ── single-instance lock ─────────────────────────────────────────
  // Two daemons (e.g. LaunchAgent + a forgotten manual run) double every
  // API call and corrupt tick cadence. The lock makes the second copy exit.
  const fs = require('fs');
  const lockPath = path.join(cfg.dataDir, 'hive.pid');
  try {
    const prev = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
    if (prev && prev !== process.pid) {
      let alive = false;
      try { process.kill(prev, 0); alive = true; } catch { /* stale lock */ }
      if (alive) {
        console.log(`❌ Hive daemon is already running (pid ${prev}) — this copy is exiting.`);
        console.log('   Stop it first:  launchctl unload ~/Library/LaunchAgents/com.hive.agent.plist');
        console.log('   (or kill the other terminal run) · a stale lock clears itself automatically.');
        process.exit(0);
      }
    }
  } catch { /* no lock file yet */ }
  try { fs.mkdirSync(cfg.dataDir, { recursive: true }); } catch { /* exists */ }
  fs.writeFileSync(lockPath, String(process.pid));
  const releaseLock = () => { try { fs.unlinkSync(lockPath); } catch { /* already gone */ } };
  process.on('exit', releaseLock);
  process.on('SIGINT', () => { console.log('\n👋 Hive shutting down.'); releaseLock(); process.exit(0); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

  banner();

  // Cloud engine (Phase 5B, optional): serve the dashboard + direct API from
  // this same process. Off unless WEB_SERVER_ENABLED / PORT — Mac mode untouched.
  if (cfg.webServer && cfg.webServer.enabled) {
    try {
      require('./web/server').startIfConfigured({
        cfg,
        route: (c, st, text, opts) => dispatcher.route(c, st, text, opts), // opts carries file display labels + forced module
        doctor: (c, st) => maintenance.runMaintenance(c, st),
        loadState: () => stateLib.load(cfg),
        saveState: (st) => stateLib.save(cfg, st),
        snapshot: async () => webPublisher.collectSnapshot(
          cfg, stateLib.load(cfg), agentsLib.loadAgentsSafe(cfg)),
      });
    } catch (e) { logger.error(`web server failed to start: ${e.message}`); }
  }

  // Telegram liveness ping (if configured) — one quiet message per boot
  if (telegram.configured(cfg)) telegram.hello(cfg).catch(() => {});

  let lastTickHadError = false;
  let ticking = false;
  let lastRelayAt = 0;
  let lastTgAt = 0;

  const runOne = async (agent, state, opts) => {
    console.log(`\n${DIM}[${new Date().toLocaleTimeString()}] ${agent.name} (${agent.role}) cycle${opts && opts.directive ? ` — ${opts.directive}` : ''}${RESET}`);
    printCycle(await agentMod.runAgentCycle(cfg, agent, state, opts || {}));
  };

  const tick = async () => {
    if (ticking) return; // never overlap ticks — one slow API wait must not double-run agents
    ticking = true;
    let state;
    try {
      state = stateLib.load(cfg);
    } catch (e) {
      logger.error(`state load failed: ${e.message}`);
      ticking = false;
      return;
    }
    try {
      const agents = agentsLib.loadAgentsSafe(cfg);
      const { firedTimers, job } = await agentMod.processDue(cfg, state);

      // Observer background loop — active across ALL state transitions
      observer.onEnvironmentTick(cfg, state);

      const chief = agents.find((a) => a.role === 'chief' && a.enabled);
      if (job && job.module === 'system') {
        const summary = await maintenance.runMaintenance(cfg, state);
        console.log(`\n${DIM}[${new Date().toLocaleTimeString()}] 🛡️ system maintenance — ${summary}${RESET}`);
      } else if (job && job.module === 'observer') {
        if (observer.checkIn(cfg, state, job.label)) {
          console.log(`\n${DIM}[${new Date().toLocaleTimeString()}] 🕵️ observer check-in prompted (${job.label})${RESET}`);
        }
      } else if (job && chief) {
        await runOne(chief, state, { directive: job.directive });
      } else if (!job && firedTimers.length === 0 && chief && agentMod.agentDue(chief, state)) {
        await runOne(chief, state, {});
      }
      for (const a of agents.filter((x) => x.enabled && x.role !== 'chief')) {
        if (agentMod.agentDue(a, state)) await runOne(a, state, {});
      }
      lastTickHadError = false;
    } catch (e) {
      if (!lastTickHadError) { logger.error(`tick error: ${e.message}`); lastTickHadError = true; }
    } finally {
      try { stateLib.save(cfg, state); } catch { /* next tick retries */ }
      // dashboard publish — never blocks or breaks the tick
      webPublisher.maybePublish(cfg, state).catch(() => {});
      // two-way relay (chat/doctor/provider from the dashboard), ~once a minute
      if (Date.now() - lastRelayAt > 55000) {
        lastRelayAt = Date.now();
        relay.processInbox(cfg, state, {
          deps: {
            route: (c, st, text, opts) => dispatcher.route(c, st, text, opts), // opts carries file display labels + forced module
            doctor: (c, st) => maintenance.runMaintenance(c, st),
          },
        }).then((r) => {
          if (r && r.ok && r.processed) {
            console.log(`\n${DIM}[${new Date().toLocaleTimeString()}] 📡 relay processed ${r.processed} dashboard command(s)${RESET}`);
            return stateLib.save(cfg, state);
          }
        }).catch(() => {});
      }
      // Telegram two-way chat — poll inbound messages ~every 25s (replies land
      // in Telegram AND the web dashboard conversation)
      if (tgListener.ready(cfg) && Date.now() - lastTgAt > 25000) {
        lastTgAt = Date.now();
        tgListener.processUpdates(cfg, state, {
          deps: {
            route: (c, st, text, opts) => dispatcher.route(c, st, text, opts), // opts carries file display labels + forced module
            doctor: (c, st) => maintenance.runMaintenance(c, st),
          },
        }).then((r) => {
          if (r && (r.processed || r.advanced)) {
            if (r.processed) console.log(`\n${DIM}[${new Date().toLocaleTimeString()}] 📲 telegram answered ${r.processed} message(s)${RESET}`);
            return stateLib.save(cfg, state); // persists offset + rate bookkeeping
          }
        }).catch(() => {});
      }
      ticking = false;
    }
  };

  await tick(); // immediate first pass
  setInterval(() => { tick(); }, cfg.tickSeconds * 1000);
}

async function onceMode() {
  banner();
  const argv = process.argv.slice(2);
  const onlyIdx = argv.indexOf('--agent');
  const only = onlyIdx !== -1 ? argv[onlyIdx + 1] : null;

  const state = stateLib.load(cfg);
  const agents = agentsLib.loadAgentsSafe(cfg);
  if (only && !agentsLib.getAgent(agents, only)) {
    console.log(`❌ unknown agent "${only}" — try: ${agents.map((a) => a.id).join(', ')}`);
    return;
  }
  const { firedTimers, job } = await agentMod.processDue(cfg, state);
  if (job) console.log(`   ⏰ scheduled job due: ${job.module}:${job.directive}${job.label ? ` (${job.label})` : ''}`);
  if (job && job.module === 'system') {
    console.log(`\n   🛡️ system maintenance — ${await maintenance.runMaintenance(cfg, state)}`);
  }
  if (job && job.module === 'observer') observer.checkIn(cfg, state, job.label);

  for (const a of agents.filter((x) => x.enabled && (!only || x.id === only))) {
    if (a.role === 'observer' && job && job.module === 'observer') continue; // check-in already fired
    if (job && job.module === 'system') continue; // maintenance handled above; agents run on their own cadence
    console.log(`\n${DIM}[${a.name} (${a.role})]${RESET}`);
    printCycle(await agentMod.runAgentCycle(cfg, a, state, a.role === 'chief' && job && job.module === 'chief' ? { directive: job.directive } : {}));
  }
  stateLib.save(cfg, state);
  await webPublisher.maybePublish(cfg, state).catch(() => {});
}

async function searchCmd(query) {
  if (!query) {
    console.log('Usage: npm run search -- "what do my notes say about X"');
    return;
  }
  const t0 = Date.now();
  const built = knowledge.ensureIndex(cfg);
  console.log(`\n📚 knowledge index: ${built.indexed} notes · ${built.chunkCount} chunks (+${built.added} new, ~${built.updated} changed)`);
  const { text, results } = await knowledge.answer(cfg, query);
  console.log(`\n${text}\n`);
  if (results.length) console.log(`sources: ${results.map((r) => r.relPath).join(', ')}\n(${Date.now() - t0}ms)`);
}

async function observeCmd(text) {
  if (!text) {
    console.log('Usage: npm run observe -- "what happened, who said what, what you noticed"');
    return;
  }
  const state = stateLib.load(cfg);
  const r = await observer.capture(cfg, state, text);
  stateLib.save(cfg, state);
  if (!r.ok) {
    console.log(`❌ ${r.error}`);
    return;
  }
  console.log(`\n🕵️ Captured a ${r.entry.type}${r.entry.persons.length ? ` (${r.entry.persons.join(', ')})` : ''}`);
  for (const f of r.files) console.log(`   ✅ ${f}`);
  if (r.questions.length) {
    console.log('\n❓ The detail is thin — answer these to deepen the memory:');
    r.questions.forEach((q, i) => console.log(`   ${i + 1}. ${q}`));
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  // human-facing commands never sit out long rate-limit waits — the LLM layer
  // fast-overflows to a model with remaining free-tier budget instead
  if (cmd || process.argv.includes('--once')) llm.setInteractive(true);
  try {
    switch (cmd) {
      case 'say': return await askRun(cfg, null, rest.join(' ').trim());
      case 'ask': return await askRun(cfg, rest[0], rest.slice(1).join(' ').trim());
      case 'search': return await searchCmd(rest.join(' ').trim());
      case 'observe': return await observeCmd(rest.join(' ').trim());
      case 'agents': return agentsCli(cfg, rest);
      case 'status': return statusCli(cfg);
      case 'approve': return await approve(cfg, rest);
      case 'check': return checkCli(cfg);
      case 'doctor': return doctorCli(cfg, rest);
      case 'verify': {
        const { spawnSync } = require('child_process');
        const r = spawnSync(process.execPath, [path.join(cfg.root, 'scripts', 'verify.js')], { stdio: 'inherit' });
        process.exitCode = r.status || 0;
        return;
      }
      case 'help': case '--help': case '-h': return help();
      default:
        if (process.argv.includes('--once')) return await onceMode();
        return await startDaemon();
    }
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exitCode = 1;
  }
}

function help() {
  console.log(`
HIVE — unified personal intelligence layer

  npm start                              run the daemon (all enabled agents)
  npm run once                           one cycle for everyone, then exit
  node src/index.js --once --agent mentalist    one cycle for one agent
  npm run say -- "text"                  talk to Hive (dispatcher picks the module)
  npm run ask -- <agent> "text"          talk to a specific agent directly
  npm run search -- "query"              semantic search over the vault (knowledge module)
  npm run observe -- "detail..."         capture an observation (observer module)
  npm run agents                         agent registry: list/enable/disable/model/interval/focus
  npm run status                         current state
  npm run approve                        email draft approvals (list|show|send|discard <id>)
  npm run check                          setup diagnostics
  npm run doctor [-- --fix]              diagnostics bundle for your build agent (safe to share)
  npm run verify                         run the integration verification checklist
  npm run seed-demo                      (re)create the demo vault + sample data
  npm run google-auth                    connect Google Calendar & Gmail (optional)
  npm test                               run unit tests

Dispatcher routes: task→executor · search→knowledge · analyze→mentalist · capture→observer
Agents live in data/agents.json — each with its own role, model and interval.
Config lives in .env — see .env.example. Docs in docs/ (start with START_HERE.md).
`);
}

main();

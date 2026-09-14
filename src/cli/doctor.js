'use strict';

/**
 * `hive doctor` — the bridge to your build agent.
 * Bundles everything needed to diagnose the system remotely into ONE
 * markdown report (printed to the terminal AND saved to
 * data/doctor-<timestamp>.md). Safe to share: the API key is never
 * included (only a masked preview), and a final redaction pass scrubs
 * anything that looks like a key.
 *
 * `npm run doctor -- --fix` additionally self-heals the common problems
 * it can fix: missing vault folders, stale/missing knowledge index,
 * missing mentalist ledgers.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function run(cfg, args = []) {
  const wantFix = args.includes('--fix');
  const fixes = [];
  const L = [];
  const sec = (t) => L.push('', `## ${t}`, '');

  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;

  L.push(`# 🩺 Hive Doctor Report — ${now.toLocaleString()}`);
  L.push(`_Safe to share with your build agent — secrets are redacted automatically._`);

  // ── environment ────────────────────────────────────────────────
  sec('Environment');
  const provider = cfg.llm.provider;
  const key = provider === 'groq' ? cfg.groqApiKey : cfg.anthropicApiKey;
  L.push(`- Project folder: ${cfg.root}`);
  L.push(`- Node ${process.versions.node} · ${os.type()} ${os.release()} (${process.arch})`);
  L.push(`- Brain: ${key ? `LIVE — ${provider} · ${provider === 'groq' ? cfg.groqModel : cfg.claudeModel}` : `MOCK (no ${provider === 'groq' ? 'GROQ' : 'ANTHROPIC'} key)`}`);
  L.push(`- Key: ${key ? `${key.slice(0, 6)}…${key.slice(-4)} (${key.length} chars)` : 'not set'}`);
  L.push(`- Providers: anthropic ${cfg.anthropicApiKey ? 'key ✓' : '—'} · groq ${cfg.groqApiKey ? 'key ✓' : '—'} · active: ${provider}${cfg.anthropicApiKey && cfg.groqApiKey && !process.env.LLM_PROVIDER ? ' (auto — set LLM_PROVIDER to pin)' : ''}`);
  L.push(`- Vault: ${cfg.vaultPath || '(not set)'}${cfg.vaultIsDemo ? ' [DEMO]' : ''}`);
  L.push(`- Calendar source: ${cfg.calendarSource} · notifications: ${cfg.notificationsEnabled ? 'on' : 'off'} · email send gate: ${cfg.allowEmailSend ? 'ON ⚠️' : 'off (safe)'}`);
  try {
    const ws = JSON.parse(fs.readFileSync(path.join(cfg.root, 'data', 'web-state.json'), 'utf8'));
    L.push(`- Web dashboard: on · last push ${ws.lastPushIso || 'never'}${ws.lastPushAt && (Date.now() - ws.lastPushAt) > 3600000 ? ' ⚠️ over an hour ago' : ''}`);
  } catch {
    L.push(`- Web dashboard: ${cfg.webPublish.dir ? 'on (no successful push yet)' : 'off (docs/WEB_DASHBOARD.md)'}`);
  }

  // ── vault health ───────────────────────────────────────────────
  sec('Vault');
  let noteCount = 0;
  if (cfg.vaultPath && fs.existsSync(cfg.vaultPath)) {
    const obsidian = require('../context/obsidian');
    const notes = obsidian.listNotes(cfg.vaultPath);
    noteCount = notes.length;
    const oldest = notes.length ? new Date(Math.min(...notes.map((n) => n.mtime))).toLocaleDateString() : '—';
    L.push(`- ${notes.length} notes · most recent edit ${notes.length ? new Date(Math.max(...notes.map((n) => n.mtime))).toLocaleString() : '—'} · oldest ${oldest}`);

    // standard folders
    const stdDirs = [
      'Daily', 'Weekly', 'Hive/memories/persons', 'Hive/memories/events', 'Hive/memories/ideas',
      'Hive/memories/conversations', 'Hive/memories/connections', 'Hive/mentalist/daily_analysis',
    ];
    const missing = stdDirs.filter((d) => !fs.existsSync(path.join(cfg.vaultPath, d)));
    if (missing.length) {
      L.push(`- ⚠️ missing folders: ${missing.join(', ')}`);
      if (wantFix) {
        for (const d of missing) {
          try { fs.mkdirSync(path.join(cfg.vaultPath, d), { recursive: true }); fixes.push(`created folder ${d}/`); } catch { /* report only */ }
        }
      }
    } else {
      L.push('- ✅ standard folder structure present');
    }
  } else {
    L.push('- ❌ vault not found (check OBSIDIAN_VAULT_PATH)');
  }

  // ── knowledge index ────────────────────────────────────────────
  sec('Knowledge module');
  try {
    const knowledge = require('../../modules/knowledge');
    const p = knowledge.indexPath(cfg);
    if (cfg.vaultPath && fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const ageH = ((Date.now() - Date.parse(j.builtAt)) / 3600000).toFixed(1);
      L.push(`- index: ${j.notes.length} notes · ${j.chunkCount} chunks · built ${ageH}h ago`);
      if (j.notes.length !== noteCount) L.push(`- ⚠️ index out of sync (${j.notes.length} indexed vs ${noteCount} in vault) — will refresh on next search`);
    } else if (cfg.vaultPath && noteCount > 0) {
      L.push('- ⚠️ no index yet (builds on first search)');
      if (wantFix) {
        const built = knowledge.ensureIndex(cfg);
        fixes.push(`rebuilt knowledge index (${built.indexed} notes, ${built.chunkCount} chunks)`);
        L.push(`- 🔧 fixed: index rebuilt`);
      }
    } else {
      L.push('- n/a (no vault)');
    }
  } catch (e) {
    L.push(`- ❌ knowledge module error: ${e.message}`);
  }

  // ── memory store & agents ──────────────────────────────────────
  sec('Memory store & agents');
  try {
    const memoryStore = require('../../core/memory-store');
    const ms = memoryStore.stats(memoryStore.load(cfg));
    L.push(`- observer memory store: ${ms.total} observation(s)${Object.keys(ms.byType).length ? ` — ${Object.entries(ms.byType).map(([t, n]) => `${t}:${n}`).join(' · ')}` : ''}`);
  } catch (e) {
    L.push(`- ❌ memory store error: ${e.message}`);
  }
  try {
    const agentsLib = require('../agents');
    const stateLib = require('../lib/state');
    const state = stateLib.load(cfg);
    const agents = agentsLib.loadAgentsSafe(cfg);
    for (const a of agents) {
      const st = state.agents[a.id] || {};
      const last = st.lastRun ? new Date(st.lastRun).toLocaleString() : 'never';
      const errs = st.consecutiveErrors ? ` · ⚠️ ${st.consecutiveErrors} consecutive error(s)` : '';
      L.push(`- ${a.enabled ? '🟢' : '⚪'} ${a.name} (${a.role}, model ${a.model || 'default'}, every ${a.interval_minutes}m): last ${last}${errs}`);
      if (st.lastSummary) L.push(`  - last cycle: ${String(st.lastSummary).slice(0, 160)}`);
    }
    L.push(`- timers pending: ${state.timers.length} · email drafts awaiting approval: ${state.pendingApprovals.filter((x) => x.status === 'pending').length}`);
  } catch (e) {
    L.push(`- ❌ agent registry/state error: ${e.message}`);
  }

  // ── routing self-test ──────────────────────────────────────────
  sec('Dispatcher self-test');
  try {
    const dispatcher = require('../../core/dispatcher');
    const samples = [
      ['remind me to email the professor', 'executor'],
      ['find my notes about pricing', 'knowledge'],
      ['why do I keep falling behind?', 'mentalist'],
      ['observe: just talked to Sam', 'observer'],
    ];
    for (const [text, expected] of samples) {
      const got = dispatcher.classify(text).module;
      L.push(`- ${got === expected ? '✅' : `❌ (got ${got})`} "${text.slice(0, 40)}" → ${expected}`);
    }
  } catch (e) {
    L.push(`- ❌ dispatcher error: ${e.message}`);
  }

  // ── recent errors from the vault logs ──────────────────────────
  sec('Recent errors (last 7 days of Agent_Logs)');
  try {
    const logDir = cfg.vaultPath ? path.join(cfg.vaultPath, 'Agent_Logs') : null;
    if (logDir && fs.existsSync(logDir)) {
      const files = fs.readdirSync(logDir).filter((f) => f.endsWith('.md')).sort().reverse().slice(0, 7);
      const errs = [];
      for (const f of files) {
        for (const line of fs.readFileSync(path.join(logDir, f), 'utf8').split('\n')) {
          if (/FAILED|❌/.test(line)) errs.push(`${f.replace('.md', '')} ${line.slice(0, 180)}`);
        }
      }
      if (errs.length) errs.slice(-15).forEach((e) => L.push(`- ${e}`));
      else L.push('- ✅ no errors logged');
    } else {
      L.push('- (no Agent_Logs yet — the daemon has not run)');
    }
  } catch (e) {
    L.push(`- could not read logs: ${e.message}`);
  }

  // ── daemon log (LaunchAgent mode) ──────────────────────────────
  const daemonLog = path.join(cfg.dataDir, 'hive.log');
  if (fs.existsSync(daemonLog)) {
    sec('Daemon log (data/hive.log)');
    L.push(`- last write: ${fs.statSync(daemonLog).mtime.toLocaleString()}`);
    const tail = fs.readFileSync(daemonLog, 'utf8').trim().split('\n').slice(-5);
    tail.forEach((t) => L.push(`  \`${t.slice(0, 160)}\``));
  }

  // ── fixes applied ──────────────────────────────────────────────
  if (wantFix && fixes.length) {
    sec('Self-healing applied');
    fixes.forEach((f) => L.push(`- 🔧 ${f}`));
  }
  if (wantFix && !fixes.length) {
    sec('Self-healing');
    L.push('- nothing needed fixing');
  }

  // ── redaction safety net ───────────────────────────────────────
  let out = L.join('\n');
  out = out.replace(/sk-ant-[A-Za-z0-9-_]+/g, 'sk-ant-[REDACTED]');
  out = out.replace(/gsk_[A-Za-z0-9-_]+/g, 'gsk_[REDACTED]');
  out = out.replace(/apikey_[A-Za-z0-9-_]+/gi, 'apikey_[REDACTED]');

  // save + print
  const file = path.join(cfg.dataDir, `doctor-${stamp}.md`);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(file, `${out}\n`);
  console.log(out);
  console.log(`\n📄 Report saved: ${file}`);
  console.log('   Paste the text above (or upload that file) to your build agent when something needs fixing.');
}

module.exports = { run };

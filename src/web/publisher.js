'use strict';

/**
 * WEB PUBLISHER — pushes Hive's state to the GitHub Pages dashboard.
 *
 * Architecture (docs/WEB_DASHBOARD.md):
 *   Mac daemon (this code) ──git push──> GitHub repo /docs ──> GitHub Pages
 *                                     └─ docs/data.json    └─ pouria.github.io/<repo>
 *
 * Every daemon tick calls maybePublish(): it collects a snapshot (brief,
 * events, reminders, mentalist/observer output, agent health), and if the
 * content changed AND the rate-limit window has passed, writes
 * docs/data.json + docs/index.html into the local repo checkout and pushes.
 * Everything is best-effort: the daemon NEVER breaks because publishing fails.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { ensureDir, writeFileAtomic, todayStr } = require('../lib/util');
const logger = require('../lib/logger');
const calendar = require('../context/calendar');
const memoryStore = require('../../core/memory-store');
const agentsLib = require('../agents');
const relay = require('./relay');
const pkg = require('../../package.json');

const DASHBOARD_SRC = path.join(__dirname, '..', '..', 'web', 'dashboard.html');
const SCHEMA = 1;

// ── helpers ──────────────────────────────────────────────────────────
function sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }

function readVaultFile(vaultPath, rel) {
  try {
    const abs = path.resolve(vaultPath, rel);
    const root = path.resolve(vaultPath);
    if (!abs.startsWith(root + path.sep)) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch { return null; }
}

function stripFrontmatter(md) {
  return String(md || '').replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
}

function webStatePath(cfg) { return path.join(cfg.root, 'data', 'web-state.json'); }

function loadWebState(cfg) {
  try { return JSON.parse(fs.readFileSync(webStatePath(cfg), 'utf8')) || {}; }
  catch { return {}; }
}

function saveWebState(cfg, ws) {
  try {
    ensureDir(path.dirname(webStatePath(cfg)));
    writeFileAtomic(webStatePath(cfg), JSON.stringify(ws, null, 2));
  } catch (e) { logger.warn(`web: state save failed: ${e.message}`); }
}

function defaultRunGit(dir, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd: dir,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      env: Object.assign({}, process.env, {
        GIT_TERMINAL_PROMPT: '0', // daemon context: never hang asking for credentials
      }),
    }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr || ''; reject(err); } else resolve(stdout);
    });
  });
}

let failStreak = 0;
function noteFailure(where) {
  failStreak++;
  if (failStreak === 1 || failStreak % 12 === 0) {
    logger.warn(`web: publish failed (${where})${failStreak > 1 ? ` — streak ${failStreak}, will keep retrying` : ''}`);
  }
}

// ── snapshot collection ──────────────────────────────────────────────
/** Walk the vault: file tree, tags, wikilinks (for the map view), snippets. */
function collectVault(vaultPath, opts = {}) {
  if (!vaultPath) return { files: [] };
  const maxFiles = 150;
  const snippets = opts.snippets !== false;
  const SKIP = new Set(['.obsidian', '.trash', 'Agent_Logs']);
  const files = [];
  const byPath = new Map();
  (function walk(dir, rel) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.has(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(abs, r);
      else if (ent.name.endsWith('.md') && files.length < maxFiles) {
        let content = '';
        try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
        const fm = content.match(/^---\n([\s\S]*?)\n---\n?/);
        const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '');
        const fmTitle = fm ? (fm[1].match(/^title:\s*(.+)$/m) || [])[1] : null;
        const tags = fm ? [...fm[1].matchAll(/^tags:[^[]*\[(.*)\]/gm)][0] : null;
        const links = [...body.matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1].trim()).slice(0, 12);
        const st = fs.statSync(abs);
        const f = {
          path: r.replace(/\.md$/, ''),
          name: (fmTitle || ent.name.replace(/\.md$/, '')).slice(0, 80),
          tags: tags ? tags[1].split(',').map((t) => t.trim()).filter(Boolean).slice(0, 6) : [],
          links,
          modified: st.mtime.toISOString(),
          size: st.size,
          snippet: snippets ? body.trim().replace(/\s+/g, ' ').slice(0, 280) : null,
        };
        files.push(f);
        byPath.set(f.path, f);
      }
    }
  })(vaultPath, '');
  // resolve links to file paths where possible (graph edges)
  for (const f of files) {
    f.links = f.links
      .map((l) => {
        const lp = l.replace(/\.md$/, '');
        if (byPath.has(lp)) return lp;
        const hit = files.find((x) => x.path.endsWith('/' + lp) || x.name === l);
        return hit ? hit.path : null;
      })
      .filter(Boolean);
  }
  return { files };
}

/** Build the JSON object the dashboard renders. Best-effort: every source is
 *  guarded, so a missing vault file or a dead calendar yields null/[] — never a throw. */
async function collectSnapshot(cfg, state, agents, opts = {}) {
  const now = opts.now || new Date();
  const vault = cfg.vaultPath || '';
  const today = todayStr(now);

  // Agents health (registry + per-agent runtime state)
  const agentCards = (agents || []).map((a) => {
    const st = (state.agents && state.agents[a.id]) || {};
    return {
      id: a.id, name: a.name, role: a.role,
      enabled: !!a.enabled, model: a.model || null,
      lastRun: st.lastRun || null,
      lastSummary: st.lastSummary || null,
      consecutiveErrors: st.consecutiveErrors || 0,
      awaitingInput: !!st.awaitingInput,
      lastQuery: st.lastQuery || null,
      recentCycles: (st.recentCycles || []).slice(-4),
    };
  });

  // Today's brief (the daemon writes Daily/<date>.md each morning)
  const briefMd = vault ? stripFrontmatter(readVaultFile(vault, `Daily/${today}.md`)) : null;

  // Upcoming events (calendar connector — cached upstream, so this is cheap)
  let events = [];
  try {
    const raw = await calendar.getEvents(cfg, { days: 35 }); // month calendar needs a wide window
    events = (Array.isArray(raw) ? raw : []).slice(0, 40).map((e) => ({
      start: e.start instanceof Date ? e.start.toISOString() : String(e.start || ''),
      title: String(e.title || '(untitled)'),
      location: e.location ? String(e.location) : null,
      category: e.category || 'personal',
    }));
  } catch { /* dashboard shows what it has */ }

  // Scheduled reminders not yet fired
  const reminders = (state.timers || [])
    .filter((t) => t && t.type === 'reminder' && t.dueAt)
    .map((t) => ({ dueAt: t.dueAt, message: String(t.message || ''), priority: t.priority || 'normal' }))
    .sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)))
    .slice(0, 12);

  // Mentalist ledgers (written by the mentalist module into the vault)
  const mentalist = {
    questions_md: vault ? readVaultFile(vault, 'Hive/mentalist/precision_questions.md') : null,
    analysis_md: vault ? readVaultFile(vault, `Hive/mentalist/daily_analysis/${today}.md`) : null,
  };

  // Observer — recent observations + stats from the central memory store
  let observer = { recent: [], stats: { total: 0, byType: {}, oldest: null } };
  try {
    const store = memoryStore.load(cfg);
    observer = {
      recent: memoryStore.recent(store, 8).map((o) => ({
        at: o.at || null, type: o.type || 'note', text: String(o.text || '').slice(0, 300),
      })),
      stats: memoryStore.stats(store),
    };
  } catch { /* optional */ }

  // Recent conversation with the chief (say/ask exchanges)
  const conversation = (state.answered || []).slice(-12).reverse().map((x) => ({
    you: String(x.text || '').slice(0, 400),
    hive: String(x.reply || '').slice(0, 600),
    at: x.at || null,
  }));

  return {
    schema: SCHEMA,
    generated_at: now.toISOString(),
    user: cfg.userName || 'Pouria',
    engine: {
      version: pkg.version,
      host: os.hostname(),
      mode: cfg.mockMode ? 'mock' : 'live',
      provider: (cfg.llm || {}).provider || null,
      model: ((cfg.llm || {}).provider === 'groq') ? (cfg.groqModel || null) : (cfg.claudeModel || null),
      relay: !!(cfg.webRelay && cfg.webRelay.pin),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    },
    agents: agentCards,
    vault: collectVault(vault, { snippets: process.env.WEB_VAULT_SNIPPETS !== 'false' }),
    doctor_md: (() => {
      try {
        const dir = path.join(cfg.root, 'data');
        const reports = fs.readdirSync(dir).filter((f) => /^doctor-.*\.md$/.test(f)).sort();
        if (!reports.length) return null;
        return fs.readFileSync(path.join(dir, reports[reports.length - 1]), 'utf8').slice(0, 4000);
      } catch { return null; }
    })(),
    today: { date: today, brief_md: briefMd },
    events,
    reminders,
    mentalist,
    observer,
    conversation,
  };
}

// ── publishing ───────────────────────────────────────────────────────
/** Rate-limited, change-detecting publish. Returns {ok} / {skipped: reason} / {error}.
 *  NEVER throws — call freely from the daemon loop. */
async function maybePublish(cfg, state, opts = {}) {
  try {
    if (!cfg.webPublish || !cfg.webPublish.dir) return { skipped: 'disabled' };
    const dir = cfg.webPublish.dir;
    if (!fs.existsSync(path.join(dir, '.git'))) {
      noteFailure('WEB_PUBLISH_DIR is not a git repo — run scripts/setup-web.sh');
      return { skipped: 'not-a-repo' };
    }

    const now = opts.now || new Date();
    const ws = loadWebState(cfg);
    const agents = agentsLib.loadAgentsSafe(cfg);
    const snap = await collectSnapshot(cfg, state, agents, { now });
    const json = JSON.stringify(snap, null, 2);
    const hash = sha1(json);

    // Keep the dashboard page itself in sync with app updates
    let dashChanged = false;
    const dashDst = path.join(dir, 'docs', 'index.html');
    try {
      const want = fs.readFileSync(DASHBOARD_SRC);
      const have = fs.existsSync(dashDst) ? fs.readFileSync(dashDst) : null;
      if (!have || !want.equals(have)) {
        ensureDir(path.dirname(dashDst));
        fs.writeFileSync(dashDst, want);
        dashChanged = true;
      }
    } catch (e) { logger.warn(`web: dashboard sync failed: ${e.message}`); }

    if (!opts.force && hash === ws.lastHash && !dashChanged) return { skipped: 'unchanged' };
    if (!opts.force && ws.lastPushAt && (now.getTime() - ws.lastPushAt) < cfg.webPublish.minMinutes * 60000) {
      return { skipped: 'rate-limited' };
    }

    ensureDir(path.join(dir, 'docs'));
    writeFileAtomic(path.join(dir, 'docs', 'data.json'), json);
    try { relay.writeRelayConfig(cfg); } catch { /* optional */ }

    const runGit = opts.runGit || defaultRunGit;
    await runGit(dir, ['add', '-A']);
    const hasStaged = await runGit(dir, ['diff', '--cached', '--quiet'])
      .then(() => false).catch(() => true);
    if (!hasStaged) {
      saveWebState(cfg, Object.assign(ws, { lastHash: hash }));
      return { skipped: 'nothing-staged' };
    }
    const msg = `hive update ${now.toISOString()}`;
    await runGit(dir, ['commit', '-m', msg]);
    try { await runGit(dir, ['push']); }
    catch (e) {
      if (/No configured push destination|No such remote/i.test(String((e && e.stderr) || e.message))) {
        throw new Error('no git remote — run scripts/setup-web.sh to connect this folder to GitHub');
      }
      throw e;
    }
    saveWebState(cfg, { lastHash: hash, lastPushAt: now.getTime(), lastPushIso: now.toISOString() });
    failStreak = 0;
    logger.info('web: published to GitHub Pages');
    return { ok: true, committed: msg };
  } catch (e) {
    noteFailure(e.message);
    return { error: e.message };
  }
}

// ── CLI: `npm run web` — one manual publish (for setup + testing) ────
if (require.main === module) {
  const cfg = require('../config');
  const stateLib = require('../lib/state');
  (async () => {
    if (!cfg.webPublish.dir) {
      console.log('❌ WEB_PUBLISH_DIR not set in .env — run scripts/setup-web.sh (docs/WEB_DASHBOARD.md)');
      process.exit(1);
    }
    const r = await maybePublish(cfg, stateLib.load(cfg), { force: process.argv.includes('--force') });
    if (r.ok) {
      console.log('✅ published — your dashboard updates in ~1 minute');
      console.log('   (GitHub Pages caches briefly; hard-refresh on your phone if needed)');
    } else if (r.error) {
      console.log(`❌ publish failed: ${r.error}`);
      if (/no git remote/.test(r.error)) {
        console.log('   → run:  bash scripts/setup-web.sh   (docs/WEB_DASHBOARD.md)');
      } else {
        console.log('   most common cause: GitHub credentials not stored yet —\n   run:  git -C web-publish push   once manually, enter username + token, retry');
      }
      process.exit(1);
    } else {
      console.log(`ℹ️ skipped (${r.skipped}) — nothing new to publish`);
    }
    process.exit(0);
  })();
}

module.exports = { collectSnapshot, maybePublish, _internals: { readVaultFile, stripFrontmatter, sha1 } };

'use strict';

/** `hive check` — setup diagnostics with actionable hints. */
const fs = require('fs');
const path = require('path');
const cfg = require('../config');
const googleAuth = require('../context/google');
const { getNotifier } = require('../lib/notify');

function run() {
  const rows = [];
  const ok = (label, detail = '') => rows.push(`✅ ${label}${detail ? ` — ${detail}` : ''}`);
  const warn = (label, detail = '') => rows.push(`⚠️  ${label}${detail ? ` — ${detail}` : ''}`);
  const bad = (label, detail = '') => rows.push(`❌ ${label}${detail ? ` — ${detail}` : ''}`);

  // Node
  const [major] = process.versions.node.split('.').map(Number);
  if (major >= 18) ok(`Node ${process.versions.node}`); else bad(`Node ${process.versions.node}`, 'need 18+');

  // .env
  if (fs.existsSync(path.join(cfg.root, '.env'))) ok('.env found'); else warn('no .env', 'copy .env.example → .env (currently running on defaults/demo)');

  // Vault
  if (cfg.vaultPath && fs.existsSync(cfg.vaultPath)) {
    if (cfg.vaultIsDemo) warn('using demo-vault', 'set OBSIDIAN_VAULT_PATH to your real vault when ready');
    else ok('vault found', cfg.vaultPath);
    try {
      const probe = path.join(cfg.vaultPath, 'Hive', '.write-test');
      fs.mkdirSync(path.dirname(probe), { recursive: true });
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      ok('vault is writable');
    } catch (e) {
      bad('vault not writable', e.message);
    }
  } else {
    bad('vault not found', cfg.vaultPath || 'OBSIDIAN_VAULT_PATH not set — or run: npm run seed-demo');
  }

  // Brain
  const provider = cfg.llm.provider;
  const brainKey = provider === 'groq' ? cfg.groqApiKey : cfg.anthropicApiKey;
  if (brainKey) {
    if (provider === 'groq') {
      ok('Groq engine ready', `model ${cfg.groqModel} · key set (free tier, no SDK needed)`);
    } else {
      ok('Anthropic API key set', `model ${cfg.claudeModel}`);
      try { require('@anthropic-ai/sdk'); ok('@anthropic-ai/sdk installed'); }
      catch { bad('dependencies missing', 'run: npm install'); }
    }
    if (cfg.anthropicApiKey && cfg.groqApiKey && !process.env.LLM_PROVIDER) {
      warn('both keys set, no LLM_PROVIDER', `defaulting to ${provider} — add LLM_PROVIDER=groq (or anthropic) to .env to pin it`);
    }
  } else {
    warn(`no ${provider === 'groq' ? 'GROQ_API_KEY' : 'ANTHROPIC_API_KEY'}`, 'running with the offline mock brain (fine for demo)');
  }

  // Google
  if (googleAuth.hasCredentials(cfg)) {
    ok('credentials.json found');
    if (googleAuth.hasToken(cfg)) ok('Google authorized (data/token.json)');
    else warn('Google not authorized yet', 'run: npm run google-auth');
  } else {
    warn('no Google credentials', 'optional — see docs/GOOGLE_SETUP.md');
  }

  // Local calendar
  if (fs.existsSync(path.join(cfg.dataDir, 'calendar.json'))) ok('local calendar.json present');
  else warn('no data/calendar.json', 'local calendar will be empty until Google/Apple is connected');

  // Agents registry
  try {
    const agents = require('../agents').loadAgentsSafe(cfg);
    ok(`agent registry (${agents.filter((a) => a.enabled).length} enabled of ${agents.length})`, agents.filter((a) => a.enabled).map((a) => a.id).join(', '));
  } catch (e) {
    bad('agents.json unreadable', e.message);
  }

  // Knowledge module
  if (cfg.vaultPath) {
    try {
      const knowledge = require('../../modules/knowledge');
      const p = knowledge.indexPath(cfg);
      if (fs.existsSync(p)) {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        ok('knowledge index present', `${j.notes.length} notes · ${j.chunkCount} chunks · built ${String(j.builtAt).slice(0, 16).replace('T', ' ')}`);
      } else {
        warn('knowledge index not built yet', 'run: npm run search -- "test" (or it builds on first routed search)');
      }
    } catch (e) {
      bad('knowledge module failed', e.message);
    }
  }

  // Observer / memory store
  try {
    const memoryStore = require('../../core/memory-store');
    const st = memoryStore.stats(memoryStore.load(cfg));
    ok('observer memory store', `${st.total} observation(s)${st.oldest ? ` · since ${String(st.oldest).slice(0, 10)}` : ''}`);
  } catch (e) {
    bad('memory store failed', e.message);
  }

  // Notifications
  if (getNotifier()) ok('node-notifier installed (OS notifications)');
  else warn('node-notifier missing', 'run: npm install — reminders will still be logged to the vault');

  console.log(`
🩺 HIVE SETUP CHECK
──────────────────────────────────────────────
${rows.join('\n')}

Next steps:
  npm run once        test one cycle
  npm start           run the daemon
  docs/RUN_AS_SERVICE.md   install as a background service
`);
}

module.exports = { run };

'use strict';

/** `hive status` — snapshot of the hive: agents, approvals, timers. */
const fs = require('fs');
const path = require('path');
const stateLib = require('../lib/state');
const agentsLib = require('../agents');
const googleAuth = require('../context/google');
const obsidian = require('../context/obsidian');

function run(cfg) {
  const state = stateLib.load(cfg);
  let agents = [];
  try { agents = agentsLib.loadAgentsSafe(cfg); } catch { /* shown below */ }

  const calendarSource = googleAuth.hasCredentials(cfg) && googleAuth.hasToken(cfg)
    ? 'Google Calendar (connected)'
    : cfg.calendarSource === 'apple'
      ? 'Apple Calendar (Calendar.app)'
      : fs.existsSync(path.join(cfg.dataDir, 'calendar.json'))
        ? 'local data/calendar.json'
        : 'none (empty)';

  const gmail = googleAuth.hasCredentials(cfg) && googleAuth.hasToken(cfg)
    ? 'Gmail (connected)'
    : fs.existsSync(path.join(cfg.dataDir, 'mock-inbox.json'))
      ? 'mock data/mock-inbox.json'
      : 'none';

  const notes = cfg.vaultPath ? obsidian.listNotes(cfg.vaultPath).length : 0;
  const pending = state.pendingApprovals.filter((a) => a.status === 'pending');
  const timers = state.timers.slice().sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));

  console.log(`
🐝 HIVE STATUS
──────────────────────────────────────────────
Brain        : ${cfg.mockMode ? 'MOCK (no ANTHROPIC_API_KEY)' : `Claude (default model ${cfg.claudeModel})`}
Vault        : ${cfg.vaultPath || '(not set)'}${cfg.vaultIsDemo ? '  [DEMO]' : ''} (${notes} notes)
Calendar     : ${calendarSource}
Email read   : ${gmail}
Email send   : ${cfg.allowEmailSend ? 'ENABLED ⚠️' : 'disabled (safe — drafts need manual approval)'}
`);

  console.log('🤖 Agents:');
  for (const a of agents) {
    const st = state.agents[a.id] || {};
    const last = st.lastRun ? st.lastRun.replace('T', ' ').slice(5, 16) : 'never';
    console.log(`   ${a.enabled ? '🟢' : '⚪'} ${a.name} (${a.id}) — ${a.role} · model ${a.model || '(default)'} · every ${a.interval_minutes}m · last: ${last}`);
    if (st.lastSummary) console.log(`      ${String(st.lastSummary).slice(0, 120)}`);
    if (st.awaitingInput && st.lastQuery) console.log(`      ❓ awaiting you: "${String(st.lastQuery).slice(0, 100)}"`);
  }

  console.log('');
  if (pending.length) {
    console.log(`📬 Pending approvals (${pending.length}):`);
    for (const a of pending) console.log(`   ${a.id} → ${a.recipient} — ${a.subject}`);
  } else {
    console.log('📭 No pending approvals.');
  }

  try {
    const memoryStore = require('../../core/memory-store');
    const ms = memoryStore.stats(memoryStore.load(cfg));
    console.log(`\n🕵️  Observer · memory store: ${ms.total} observation(s)` +
      (Object.keys(ms.byType).length ? ` — ${Object.entries(ms.byType).map(([t, n]) => `${t}:${n}`).join(' · ')}` : ''));
  } catch { /* optional */ }

  try {
    const knowledge = require('../../modules/knowledge');
    if (cfg.vaultPath && fs.existsSync(knowledge.indexPath(cfg))) {
      const j = JSON.parse(fs.readFileSync(knowledge.indexPath(cfg), 'utf8'));
      console.log(`📚 Knowledge · index: ${j.notes.length} notes · ${j.chunkCount} chunks`);
    } else {
      console.log('📚 Knowledge · index not built yet (npm run search -- "anything")');
    }
  } catch { /* optional */ }

  console.log(`\n⏱  Active timers/alarms (${timers.length}):`);
  if (!timers.length) console.log('   (none)');
  for (const t of timers.slice(0, 8)) {
    console.log(`   ${new Date(t.dueAt).toLocaleString()} [${t.type}] ${String(t.message).slice(0, 80)}`);
  }
  if (timers.length > 8) console.log(`   … +${timers.length - 8} more`);
  console.log('');
}

module.exports = { run };

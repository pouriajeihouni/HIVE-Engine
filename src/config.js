'use strict';

/**
 * Central configuration. Loads .env from the project root (with tilde
 * expansion), applies defaults, and exposes a single `config` object.
 * With no .env and no API key the agent runs in DEMO/MOCK mode so it
 * can be tried with zero setup.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadEnv } = require('./lib/env-loader');

const ROOT = path.resolve(__dirname, '..');
loadEnv(path.join(ROOT, '.env'));

const bool = (v, d) =>
  v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && String(v).trim() !== '' ? n : d;
};
const expandHome = (p) => (p && p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

// Vault: explicit .env value → demo-vault fallback (if present)
let vaultPath = process.env.OBSIDIAN_VAULT_PATH
  ? path.resolve(expandHome(process.env.OBSIDIAN_VAULT_PATH.trim()))
  : '';
let vaultIsDemo = false;
const demoVault = path.join(ROOT, 'demo-vault');
if (!vaultPath && fs.existsSync(demoVault)) {
  vaultPath = demoVault;
  vaultIsDemo = true;
}

const config = {
  root: ROOT,
  dataDir: path.join(ROOT, 'data'),
  backupDir: path.join(ROOT, 'data', 'backups'),

  agentName: process.env.AGENT_NAME || 'Hive',
  userName: process.env.USER_NAME || 'Pouria',

  // Brain — two engines: anthropic (Claude) and groq (Llama 3.3 70B etc.).
  // LLM_PROVIDER=anthropic|groq picks explicitly; with no LLM_PROVIDER,
  // groq wins only when it's the ONLY key present (back-compat).
  anthropicApiKey: (process.env.ANTHROPIC_API_KEY || '').trim(),
  claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-4-5',
  groqApiKey: (process.env.GROQ_API_KEY || '').trim(),
  groqModel: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
  get llm() {
    const explicit = (process.env.LLM_PROVIDER || '').toLowerCase();
    if (explicit === 'groq' || explicit === 'anthropic') return { provider: explicit };
    if (this.groqApiKey && !this.anthropicApiKey) return { provider: 'groq' };
    return { provider: 'anthropic' };
  },
  maxTokens: Math.min(4096, Math.max(256, num(process.env.MAX_TOKENS, 2400))), // 1600→2400: Pouria reads everything — detailed replies (brief §4)
  get mockMode() {
    return this.llm.provider === 'groq' ? !this.groqApiKey : !this.anthropicApiKey;
  },

  // Obsidian
  vaultPath,
  vaultIsDemo,
  maxContextChars: num(process.env.MAX_CONTEXT_CHARS, 8000), // halved from 14000 — free-tier daily token budgets

  // Loop timing
  brainIntervalMinutes: Math.min(1440, Math.max(5, num(process.env.BRAIN_INTERVAL_MINUTES, 60))),
  tickSeconds: Math.max(5, num(process.env.TICK_SECONDS, 15)),

  // Scheduled jobs (HH:MM local)
  dailyBriefTime: process.env.DAILY_BRIEF_TIME || '07:00',
  weeklyPlanTime: process.env.WEEKLY_PLAN_TIME || '08:00',       // Mondays
  weeklySummaryTime: process.env.WEEKLY_SUMMARY_TIME || '16:00', // Fridays
  hsChecklistTime: process.env.HS_CHECKLIST_TIME || '09:00',     // Fridays

  // Notifications
  notificationsEnabled: bool(process.env.NOTIFICATIONS, true),
  notificationSound: bool(process.env.NOTIFICATION_SOUND, true),

  // Calendar source: auto | google | apple | local (Apple↔Google sync = same events)
  calendarSource: (process.env.CALENDAR_SOURCE || 'auto').toLowerCase(),

  // Google
  google: {
    credentialsPath: process.env.GOOGLE_CREDENTIALS
      ? path.resolve(ROOT, expandHome(process.env.GOOGLE_CREDENTIALS.trim()))
      : '',
    tokenPath: path.join(ROOT, 'data', 'token.json'),
    calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
    calendarEnabled: bool(process.env.GOOGLE_CALENDAR_ENABLED, true),
    gmailEnabled: bool(process.env.GMAIL_ENABLED, true),
    maxEvents: num(process.env.GOOGLE_MAX_EVENTS, 25),
    redirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:37452/callback',
  },

  // Safety: drafts ALWAYS need approval; this gates actual Gmail sending.
  allowEmailSend: bool(process.env.ALLOW_EMAIL_SEND, false),

  // Resilience: daily vault backup + log hygiene (docs/BACKUP_AND_RESTORE.md)
  backupTime: process.env.BACKUP_TIME || '23:30',
  backupDir: process.env.BACKUP_DIR
    ? path.resolve(expandHome(process.env.BACKUP_DIR.trim()))
    : path.join(os.homedir(), 'Documents', 'HIVE-Backups'),

  // Web dashboard publishing (GitHub Pages). Off unless WEB_PUBLISH_DIR is set —
  // see docs/WEB_DASHBOARD.md. The daemon pushes docs/data.json + the dashboard
  // into a local checkout of your GitHub repo, then `git push`es (rate-limited).
  webPublish: {
    dir: process.env.WEB_PUBLISH_DIR
      ? path.resolve(ROOT, expandHome(process.env.WEB_PUBLISH_DIR.trim()))
      : null,
    minMinutes: Math.min(60, Math.max(1, num(process.env.WEB_PUBLISH_MINUTES, 5))),
  },

  // Two-way relay (optional): the dashboard writes messages into the GitHub
  // repo (docs/inbox/*.json); the daemon pulls, verifies the PIN, and
  // processes them (chat / doctor / provider switch). No secrets ever leave
  // the Mac except the repo-scoped write token below.
  webRelay: {
    pin: (process.env.WEB_RELAY_PIN || '').trim(),
    token: (process.env.WEB_RELAY_TOKEN || '').trim(), // GitHub PAT (contents:write, this repo only) — published in docs/relay.json so the site can send
  },

  // Cloud engine (Phase 5B — docs/CLOUD_ENGINE.md): the daemon itself serves
  // the dashboard + a direct JSON API (no GitHub relay round trip; chat
  // replies come back instantly). Enabled when WEB_SERVER_ENABLED is set, or
  // automatically on hosts that provide PORT (Render etc.). WEB_AUTH_KEY is a
  // long random string — the dashboard asks for it once, like the relay PIN
  // but strong enough for a public URL. Fail-closed: no key → no server.
  // Phone notifications via Telegram (docs/CLOUD_ENGINE.md) — works on the
  // Mac AND in the cloud. Setup: `npm run telegram-setup` (~1 min on your phone).
  telegram: {
    token: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
    chatId: String(process.env.TELEGRAM_CHAT_ID || '').trim(),
  },

  // File support (cloud engine — docs/CLOUD_ENGINE.md): uploads land in
  // data/uploads/, extracted text is cached beside them, and this many chars
  // of extraction ride along with the chat message to the LLM.
  uploadMaxMB: Math.min(100, Math.max(1, num(process.env.UPLOAD_MAX_MB, 25))),
  fileContextChars: num(process.env.FILE_CONTEXT_CHARS, 12000),

  webServer: {
    enabled: bool(process.env.WEB_SERVER_ENABLED, false) || Boolean(process.env.PORT),
    authKey: (process.env.WEB_AUTH_KEY || '').trim(),
    port: num(process.env.PORT, 3000),
    host: process.env.HOST || '0.0.0.0',
  },
};

module.exports = config;

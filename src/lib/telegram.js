'use strict';

/**
 * Telegram notifications — how Hive reaches your phone (works from the Mac
 * today and from the cloud engine later). Setup: `npm run telegram-setup`
 * (walkthrough in docs/CLOUD_ENGINE.md).
 *
 * Design notes:
 *  - plain text only, no parse_mode — briefs contain markdown that would
 *    break Telegram's parser; plain text always delivers
 *  - every call is best-effort: a failed send logs a warning and returns
 *    false, never throws into the caller (notifications must not break
 *    the daemon, same rule as the publisher)
 *  - fetch is injectable for tests; Node 18+ has global fetch
 */
const logger = require('./logger');

const MAX_LEN = 4000; // Telegram's hard cap is 4096 — leave headroom

const api = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

function configured(cfg) {
  return !!(cfg.telegram && cfg.telegram.token && cfg.telegram.chatId);
}

/**
 * Send one message. Returns true/false. `opts.fetch` and `opts.retryDelayMs`
 * are for tests.
 */
async function sendMessage(cfg, text, opts = {}) {
  const doFetch = opts.fetch || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch || !configured(cfg)) return false;
  const body = {
    chat_id: cfg.telegram.chatId,
    text: String(text || '').slice(0, MAX_LEN),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await doFetch(api(cfg.telegram.token, 'sendMessage'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.ok) return true;
      if (r.status === 429 && attempt === 0) {
        await new Promise((res) => setTimeout(res, opts.retryDelayMs != null ? opts.retryDelayMs : 1500));
        continue;
      }
      logger.warn(`telegram: sendMessage failed (HTTP ${r.status})`);
      return false;
    } catch (e) {
      logger.warn(`telegram: sendMessage error: ${e.message}`);
      return false;
    }
  }
  return false;
}

/**
 * Pull the newest usable {chatId, firstName} out of a getUpdates payload.
 * `minDate` (unix seconds) filters stale messages from before setup started.
 */
function extractChat(updates, minDate = 0) {
  if (!Array.isArray(updates)) return null;
  let best = null;
  for (const u of updates) {
    const m = u && (u.message || u.edited_message);
    if (!m || !m.chat || !m.chat.id) continue;
    if (m.date && m.date < minDate) continue;
    best = { chatId: m.chat.id, firstName: (m.from && m.from.first_name) || '' };
  }
  return best;
}

/** Liveness ping on daemon boot (quiet, best-effort). */
async function hello(cfg, opts) {
  const mode = cfg.mockMode ? ' (mock brains — no API key yet)' : '';
  return sendMessage(cfg, `🐝 ${cfg.agentName || 'Hive'} is online${mode}. Briefs, reminders and answers will arrive here.`, opts);
}

module.exports = { sendMessage, extractChat, configured, hello };

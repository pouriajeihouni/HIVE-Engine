'use strict';

/**
 * TELEGRAM LISTENER — two-way chat with Hive from your phone.
 *
 * The daemon periodically polls getUpdates (short poll, no webhooks, no
 * open ports — works behind NAT at home and on Render alike). Each inbound
 * text message from YOU is routed through the dispatcher exactly like the
 * dashboard relay, so:
 *   - the reply lands in Telegram (seconds)
 *   - the exchange appears in the web dashboard chat history automatically
 *     (GitHub mode: data.json · cloud mode: /api/data)
 *
 * Commands (anything else is a normal chat message):
 *   /help            — what I can do
 *   /doctor          — run the health routine, report back
 *   /provider groq|anthropic — hot-switch brains (no restart)
 *
 * Security model:
 *   - only the configured TELEGRAM_CHAT_ID is processed; anything else is
 *     marked seen and ignored (your chat with the bot is the secret channel)
 *   - offset persisted in state → restarts never replay old messages
 *   - rate limit 60 msgs/hour, 1000 chars per message
 *   - backlog cap: after downtime, at most the 10 most recent pending
 *     messages are answered (older ones are marked seen — consistent with
 *     the scheduler's catch-up-once philosophy)
 */
const logger = require('./logger');
const telegram = require('./telegram');
const relay = require('../web/relay');

const MAX_MSG_CHARS = 1000;
const MAX_PER_HOUR = 60;
const MAX_PER_POLL = 10;

const HELP = [
  '🐝 You\'re chatting with Hive.',
  'Just send a message — I\'ll answer here, and it shows up in the web dashboard chat too.',
  '',
  '/doctor — run a health check',
  '/provider groq|anthropic — switch brains (no restart)',
  '/help — this message',
].join('\n');

function ready(cfg) {
  return telegram.configured(cfg);
}

function apiUrl(token, method) {
  return `https://api.telegram.org/bot${token}/${method}`;
}

/**
 * One polling pass. Mutates state.telegram (lastUpdateId, recent) — the
 * CALLER saves state (mirrors relay.processInbox semantics). Returns
 * { ok, processed, advanced } — advanced = offset moved even if nothing
 * was answerable.
 */
async function processUpdates(cfg, state, opts = {}) {
  if (!ready(cfg)) return { skipped: 'telegram-not-configured' };
  const deps = opts.deps || {};
  const route = deps.route || null;            // async (cfg, state, text) => {reply}
  const doctor = deps.doctor || null;          // async (cfg, state) => summary
  const persistProvider = deps.persistProvider || relay.persistProvider;
  const doFetch = deps.fetch || (typeof fetch === 'function' ? fetch : null);
  const now = deps.now || (() => Date.now());
  if (!doFetch) return { skipped: 'no-fetch' };

  const token = cfg.telegram.token;
  const myChat = Number(cfg.telegram.chatId);

  state.telegram = state.telegram || {};
  const t = state.telegram;
  const offset = t.lastUpdateId ? t.lastUpdateId + 1 : 0;

  let updates;
  try {
    const r = await doFetch(`${apiUrl(token, 'getUpdates')}?offset=${offset}&timeout=0&allowed_updates=%5B%22message%22%5D`);
    const j = await r.json();
    if (!j || !j.ok || !Array.isArray(j.result)) return { error: 'getUpdates failed' };
    updates = j.result;
  } catch (e) {
    logger.warn(`telegram: poll error: ${e.message}`);
    return { error: e.message };
  }
  if (!updates.length) return { ok: true, processed: 0, advanced: false };

  // backlog cap: answer the newest MAX_PER_POLL, mark everything seen
  let skippedOld = 0;
  if (updates.length > MAX_PER_POLL) {
    skippedOld = updates.length - MAX_PER_POLL;
    updates = updates.slice(-MAX_PER_POLL);
    logger.info(`telegram: ${skippedOld} backlog message(s) marked seen without processing`);
  }

  const send = (text) => telegram.sendMessage(cfg, String(text || '').slice(0, 4000), { fetch: doFetch });
  const typing = () => {
    doFetch(apiUrl(token, 'sendChatAction'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: myChat, action: 'typing' }),
    }).catch(() => { /* cosmetic */ });
  };

  // rate limit bookkeeping (rolling hour)
  t.recent = Array.isArray(t.recent) ? t.recent : [];
  const cutoff = now() - 3600000;
  t.recent = t.recent.filter((ts) => ts > cutoff);

  let processed = 0;
  for (const u of updates) {
    const uid = u && u.update_id;
    if (typeof uid === 'number' && uid > (t.lastUpdateId || 0)) t.lastUpdateId = uid;

    const m = u && u.message;
    if (!m || !m.chat || m.chat.id !== myChat) {
      if (m && m.chat) logger.warn(`telegram: ignored message from chat ${m.chat.id} (not the configured chat)`);
      continue;
    }
    const text = String(m.text || '').trim();
    if (!text) {
      await send('For now I can only read text messages 🙂');
      processed++;
      continue;
    }
    if (t.recent.length >= MAX_PER_HOUR) {
      await send('You\'re sending faster than I can think — give me a minute and try again.');
      continue;
    }
    t.recent.push(now());

    try {
      if (text === '/start' || text === '/help') {
        await send(HELP);
      } else if (text === '/doctor') {
        if (!doctor) { await send('Doctor isn\'t wired on this process.'); continue; }
        typing();
        const summary = await doctor(cfg, state);
        await send(summary || 'Doctor run complete.');
      } else if (text.startsWith('/provider')) {
        const provider = text.split(/\s+/)[1] || '';
        if (!['groq', 'anthropic'].includes(provider)) {
          await send('Usage: /provider groq   or   /provider anthropic');
        } else {
          process.env.LLM_PROVIDER = provider; // cfg.llm getter reads this live → hot switch
          persistProvider(cfg, provider);
          logger.info(`telegram: provider switched to ${provider} (hot)`);
          await send(`Provider switched to ${provider}.`);
        }
      } else {
        if (!route) { await send('Chat isn\'t wired on this process.'); continue; }
        typing();
        const out = await route(cfg, state, text.slice(0, MAX_MSG_CHARS));
        processed++;
        await send((out && out.reply) || '…');
      }
    } catch (e) {
      logger.warn(`telegram: command failed: ${e.message}`);
      await send('That didn\'t work — I logged it. Try again in a moment.');
    }
  }

  return { ok: true, processed, advanced: true };
}

module.exports = { processUpdates, ready, HELP };

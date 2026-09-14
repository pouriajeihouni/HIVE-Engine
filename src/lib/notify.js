'use strict';

/**
 * OS notifications (node-notifier, lazy-loaded) with a guaranteed
 * persistent fallback copy written to VAULT/Hive/Notifications.md —
 * so a missed toast never loses a reminder.
 */
const logger = require('./logger');
const { ts } = require('./util');
const obsidian = require('../context/obsidian');
const telegram = require('./telegram');

let notifier = null;
let tried = false;

function getNotifier() {
  if (tried) return notifier;
  tried = true;
  try { notifier = require('node-notifier'); } catch { notifier = null; }
  return notifier;
}

function notify(cfg, { title = 'Hive', message = '', sound = true, priority = 'normal' } = {}) {
  if (!message) return;
  const prefix = priority === 'high' ? '🚨 ' : '';
  console.log(`🔔 [${title}] ${prefix}${String(message).replace(/\s+/g, ' ').slice(0, 500)}`);

  // Persistent copy in the vault
  try {
    if (cfg.vaultPath) {
      obsidian.appendTo(
        cfg.vaultPath,
        'Hive/Notifications.md',
        `\n- **${ts()}** — **${title}**: ${prefix}${String(message).replace(/\s+/g, ' ').slice(0, 1500)}`
      );
    }
  } catch { /* ignore */ }

  logger.vaultLog(cfg, `notify — ${title}: ${String(message).replace(/\s+/g, ' ').slice(0, 160)}`);

  // Telegram (phone notifications — works from the Mac and the cloud engine)
  if (cfg.telegram && cfg.telegram.token && cfg.telegram.chatId) {
    telegram
      .sendMessage(cfg, `[${title}] ${prefix}${String(message).replace(/\s+/g, ' ').slice(0, 1500)}`)
      .catch(() => { /* best-effort */ });
  }

  // Native toast
  if (cfg.notificationsEnabled !== false) {
    const n = getNotifier();
    if (n) {
      try {
        n.notify({
          title: `[${cfg.agentName}] ${title}`,
          message: String(message).replace(/\s+/g, ' ').slice(0, 240),
          sound: Boolean(sound && cfg.notificationSound),
          wait: false,
        });
      } catch (e) {
        logger.warn(`native notification failed: ${e.message}`);
      }
    }
  }
}

module.exports = { notify, getNotifier };

#!/usr/bin/env node
'use strict';

/**
 * Connect Hive to your phone via Telegram (docs/CLOUD_ENGINE.md).
 *
 *   1. you create a bot with @BotFather (about a minute, on your phone)
 *   2. this script verifies the token and waits for you to message the bot
 *   3. it sends a test message and saves TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
 *      to .env (reloading the daemon afterwards is the only manual step)
 *
 * Everything here is optional infrastructure — the daemon works fine
 * without it; you just don't get phone notifications.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const cfg = require('../src/config');
const { extractChat } = require('../src/lib/telegram');

function ask(q) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); res(String(a || '').trim()); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Upsert a KEY=value line in an env file, preserving everything else. */
function upsertEnv(txt, key, value) {
  const line = `${key}=${value}`;
  if (new RegExp(`^${key}=.*$`, 'm').test(txt)) {
    return txt.replace(new RegExp(`^${key}=.*$`, 'm'), line);
  }
  return (txt.trimEnd() ? txt.trimEnd() + '\n' : '') + line + '\n';
}

async function telegramApi(token, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

async function main() {
  console.log('\n📱 Hive ↔ Telegram setup\n');
  console.log('On your phone (about a minute):');
  console.log('  1. install Telegram if you haven\'t');
  console.log('  2. open a chat with @BotFather and send:  /newbot');
  console.log('     (name it anything, e.g. "Hive"; the username must end in "bot")');
  console.log('  3. BotFather replies with a token like  123456789:AAE4x…  — copy it\n');

  let token = cfg.telegram.token;
  if (token) {
    console.log(`✔ found an existing token in .env (${token.slice(0, 10)}…)`);
    const reuse = (await ask('  use it? [Y/n]: ')).toLowerCase();
    if (reuse && reuse !== 'y') token = '';
  }
  while (!token) {
    token = await ask('Paste the bot token: ');
    if (token && !/^\d+:[\w-]{20,}$/.test(token)) {
      console.log('  ⚠ that doesn\'t look like a bot token (expected 123456789:AAE4x…) — try again.');
      token = '';
    }
  }

  let me;
  try { me = await telegramApi(token, 'getMe'); }
  catch (e) { console.error(`❌ network error talking to Telegram: ${e.message}`); process.exit(1); }
  if (!me || !me.ok) { console.error('❌ Telegram rejected that token — paste the full token BotFather gave you.'); process.exit(1); }
  const bot = me.result.username;
  console.log(`\n✔ token works — your bot is @${bot}\n`);

  if (cfg.telegram.chatId) {
    const re = (await ask(`chat_id already saved (${cfg.telegram.chatId}). Re-detect? [y/N]: `)).toLowerCase();
    if (re !== 'y') { console.log('\n✅ nothing to change — you\'re all set.'); process.exit(0); }
  }

  console.log(`Now open a chat with @${bot} (search in Telegram) and send it any message — e.g.  hi`);
  console.log('Waiting (up to 2 minutes)…');
  const start = Math.floor(Date.now() / 1000);
  let chat = null;
  const deadline = Date.now() + 120000;
  while (!chat && Date.now() < deadline) {
    await sleep(4000);
    try {
      const j = await telegramApi(token, 'getUpdates?timeout=0&allowed_updates=%5B%22message%22%5D');
      chat = extractChat(j && j.result, start - 30);
    } catch { /* keep waiting */ }
  }
  if (!chat) { console.error(`\n❌ no message seen. Make sure you messaged @${bot}, then run me again.`); process.exit(1); }
  console.log(`\n✔ got it — hello ${chat.firstName || 'there'} (chat_id ${chat.chatId})`);

  // persist to .env
  const envPath = path.join(cfg.root, '.env');
  let txt = '';
  try { txt = fs.readFileSync(envPath, 'utf8'); } catch { /* may not exist */ }
  txt = upsertEnv(txt, 'TELEGRAM_BOT_TOKEN', token);
  txt = upsertEnv(txt, 'TELEGRAM_CHAT_ID', String(chat.chatId));
  fs.writeFileSync(envPath, txt, { mode: 0o600 });
  console.log('✔ saved TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID to .env');

  // test message
  try {
    const j = await telegramApi(token, 'sendMessage',
      { chat_id: chat.chatId, text: '🐝 Hive is connected — briefs, reminders and answers will arrive here.' });
    console.log(j && j.ok ? '✅ test message sent — check your phone!' : '⚠ test message failed (settings are saved; the daemon retries).');
  } catch (e) {
    console.log(`⚠ test message failed (${e.message}) — settings are saved; the daemon retries.`);
  }

  console.log('\nLast step — reload the daemon so it picks up the new settings:');
  console.log('  launchctl unload ~/Library/LaunchAgents/com.hive.agent.plist && launchctl load ~/Library/LaunchAgents/com.hive.agent.plist');
  console.log('(cloud engine: just restart the service — Stage 3 docs cover this.)');
}

if (require.main === module) {
  main().catch((e) => { console.error('setup failed:', e.message); process.exit(1); });
}

module.exports = { upsertEnv };

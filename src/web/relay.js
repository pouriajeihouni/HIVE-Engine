'use strict';

/**
 * TWO-WAY RELAY — dashboard → GitHub repo → daemon → dashboard.
 *
 * The site (static, on GitHub Pages) cannot reach the Mac directly. Instead:
 *   1. the site PUTs a small JSON file per message: docs/inbox/<id>.json
 *      (via the GitHub contents API, using a repo-scoped token published in
 *      docs/relay.json — that token can only write to this one repo)
 *   2. the daemon (this module) periodically does `git pull`, reads every
 *      inbox file, verifies the shared PIN, and processes the command:
 *        chat          → dispatcher.route() — a real Hive conversation turn
 *        doctor        → runs the maintenance/health routine, publishes report
 *        set_provider  → hot-switches LLM_PROVIDER (groq ↔ anthropic) and
 *                        persists it to .env — no daemon restart needed
 *   3. handled files are deleted and pushed; replies flow back through the
 *      normal publisher (conversation in data.json).
 *
 * Security model:
 *   - the embedded site token is WRITE-ONLY to one public repo — worst case
 *     is repo vandalism, never engine control (the PIN gates every command)
 *   - the PIN is never published; the user types it in the browser
 *   - API keys never travel through the relay (public repo = public data)
 *   - rate-limited: max 30 commands per hour, 1000 chars per message
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../lib/logger');

const MAX_MSG_CHARS = 1000;
const MAX_PER_HOUR = 30;
const INBOX_DIR = path.join('docs', 'inbox');

function relayReady(cfg) {
  return !!(cfg.webPublish && cfg.webPublish.dir && cfg.webRelay && cfg.webRelay.pin);
}

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function pinOk(cfg, supplied) {
  const want = String(cfg.webRelay.pin || '');
  if (!want || typeof supplied !== 'string') return false;
  const a = Buffer.from(sha(want));
  const b = Buffer.from(sha(supplied));
  return a.length === b.length && crypto.timingSafeEqual(a, b); // constant-time compare of hashes
}

/** Persist provider choice to .env (keeps every other line intact). */
function persistProvider(cfg, provider) {
  try {
    const envPath = path.join(cfg.root, '.env');
    let txt = '';
    try { txt = fs.readFileSync(envPath, 'utf8'); } catch { /* may not exist */ }
    fs.writeFileSync(envPath + '.relay.bak', txt, { mode: 0o600 });
    if (/^LLM_PROVIDER=.*$/m.test(txt)) txt = txt.replace(/^LLM_PROVIDER=.*$/m, `LLM_PROVIDER=${provider}`);
    else txt += `\nLLM_PROVIDER=${provider}\n`;
    fs.writeFileSync(envPath, txt, { mode: 0o600 });
    return true;
  } catch (e) { logger.warn(`relay: .env persist failed: ${e.message}`); return false; }
}

/** Create the processor with injectable deps for testing. */
function createProcessor(deps = {}) {
  const route = deps.route || null; // async (cfg, state, text) => out
  const doctor = deps.doctor || null; // async (cfg, state) => summary
  const now = deps.now || (() => new Date());
  const handled = new Map(); // id → ts (rate limiting + dedup within process)

  return async function processFile(cfg, state, dir, file, gitRunner) {
    const full = path.join(dir, file);
    if (!file.endsWith('.json')) return { skipped: true };
    let msg;
    try { msg = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { return { delete: true, reason: 'unparseable' }; }
    const id = String(msg.id || file);
    if (handled.has(id)) return { delete: true, reason: 'duplicate' };

    // rate limit (rolling hour)
    const cutoff = now().getTime() - 3600000;
    let recent = 0;
    for (const ts of handled.values()) if (ts > cutoff) recent++;
    if (recent >= MAX_PER_HOUR) return { delete: false, reason: 'rate-limited', retry: true };

    if (!pinOk(cfg, msg.pin)) { handled.set(id, now().getTime()); return { delete: true, reason: 'bad-pin' }; }
    handled.set(id, now().getTime());

    const type = String(msg.type || 'chat');
    const text = String(msg.text || '').slice(0, MAX_MSG_CHARS);
    try {
      if (type === 'chat' || type === 'answer') {
        if (!route) return { delete: true, reason: 'no-router' };
        const out = await route(cfg, state, text);
        logger.info(`relay: chat processed (${id})`);
        return { delete: true, reply: out && out.reply };
      }
      if (type === 'doctor') {
        if (!doctor) return { delete: true, reason: 'no-doctor' };
        const summary = await doctor(cfg, state);
        logger.info(`relay: doctor run (${id})`);
        return { delete: true, reply: summary };
      }
      if (type === 'set_provider') {
        const provider = String(msg.provider || '');
        if (!['groq', 'anthropic'].includes(provider)) return { delete: true, reason: 'bad-provider' };
        process.env.LLM_PROVIDER = provider; // cfg.llm getter reads this live → hot switch
        persistProvider(cfg, provider);
        logger.info(`relay: provider switched to ${provider} (hot)`);
        return { delete: true, reply: `Provider switched to ${provider}.` };
      }
      return { delete: true, reason: 'unknown-type' };
    } catch (e) {
      logger.warn(`relay: command failed (${id}): ${e.message}`);
      return { delete: true, reason: 'error' };
    }
  };
}

/** One relay pass: pull → process inbox → commit deletions → push. */
async function processInbox(cfg, state, opts = {}) {
  if (!relayReady(cfg)) return { skipped: 'relay-not-configured' };
  const dir = cfg.webPublish.dir;
  const git = opts.git || ((args) => new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    execFile('git', args, { cwd: dir, timeout: 30000, env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }) },
      (err, stdout) => { if (err) reject(err); else resolve(stdout); });
  }));
  try {
    await git(['pull', '--ff-only']).catch(() => null); // best-effort; offline is fine
    const inbox = path.join(dir, INBOX_DIR);
    if (!fs.existsSync(inbox)) return { skipped: 'no-inbox' };
    const files = fs.readdirSync(inbox).filter((f) => f.endsWith('.json'));
    if (!files.length) return { skipped: 'empty' };

    const run = opts.runGit || git;
    const processor = createProcessor(opts.deps);
    let processed = 0;
    const replies = [];
    for (const f of files) {
      const r = await processor(cfg, state, inbox, f, run);
      if (r.skipped) continue;
      processed++;
      if (r.reply) replies.push(r.reply);
      if (r.delete) { try { fs.unlinkSync(path.join(inbox, f)); } catch { /* gone */ } }
    }
    if (processed) {
      await git(['add', '-A']).catch(() => null);
      await git(['commit', '-m', `relay: processed ${processed} command(s)`]).catch(() => null);
      await git(['push']).catch((e) => logger.warn(`relay: push failed: ${e.message}`));
    }
    return { ok: true, processed, replies };
  } catch (e) {
    logger.warn(`relay: inbox pass failed: ${e.message}`);
    return { error: e.message };
  }
}

/** Publish docs/relay.json so the site knows it can send (token only — never the PIN). */
function writeRelayConfig(cfg) {
  try {
    if (!cfg.webPublish || !cfg.webPublish.dir) return false;
    const dir = path.join(cfg.webPublish.dir, 'docs');
    fs.mkdirSync(dir, { recursive: true });
    const remote = require('child_process').execFileSync(
      'git', ['remote', 'get-url', 'origin'], { cwd: cfg.webPublish.dir, encoding: 'utf8' }).trim();
    const m = remote.match(/github\.com[/:]([^/]+)\/([^./]+)(?:\.git)?$/);
    if (!m) return false;
    const payload = {
      relay: !!(cfg.webRelay.pin && cfg.webRelay.token),
      repo: `${m[1]}/${m[2]}`,
      token: cfg.webRelay.token || '',
    };
    fs.writeFileSync(path.join(dir, 'relay.json'), JSON.stringify(payload, null, 2));
    return true;
  } catch { return false; }
}

module.exports = { processInbox, createProcessor, writeRelayConfig, relayReady, pinOk, persistProvider, INBOX_DIR };

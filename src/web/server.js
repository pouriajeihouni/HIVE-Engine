'use strict';

/**
 * CLOUD ENGINE — the dashboard talks to this server directly (no GitHub
 * relay). When Hive runs on a host (Render, a VPS, …) this serves the same
 * dashboard file plus a small JSON API, so chat replies come back in the
 * SAME request — seconds, not the relay's ~1-minute round trip.
 *
 * Endpoints (all JSON unless noted):
 *   GET  /               no auth — the dashboard shell (same file as Pages;
 *                        it contains no secrets and detects cloud mode)
 *   GET  /api/health     no auth — {"ok":true} keep-alive ping (Render's
 *                        free tier sleeps after ~15 min idle; external
 *                        pings keep it awake, and the scheduler's catch-up
 *                        fires any job missed while asleep)
 *   GET  /api/data       auth    — live snapshot (publisher.collectSnapshot)
 *   POST /api/chat       auth    — {text, fileId?} → dispatcher.route → {reply}
 *   POST /api/answer     auth    — alias of chat (Answer buttons)
 *   POST /api/upload     auth    — raw file bytes (+ x-file-name header) →
 *                                  stored + text extracted → {id, name, ...}
 *   GET  /api/files/:id  auth    — download a stored upload
 *   POST /api/doctor     auth    — run maintenance → {reply}
 *   POST /api/set_provider auth  — {provider:"groq"|"anthropic"} hot switch
 *
 * Security model (docs/CLOUD_ENGINE.md):
 *   - auth = X-Hive-Key (or Authorization: Bearer) vs WEB_AUTH_KEY, compared
 *     in constant time; a long random key, NOT a short PIN — the URL is public
 *   - fail-closed: enabled without a key → the server refuses to start
 *   - brute-force lockout: 10 bad keys in 10 min → 15-minute lockout
 *   - commands rate-limited (rolling hour); bodies capped at 64 KB
 *   - API keys never appear in any response; errors are generic
 *   - same-origin only (no CORS) — the dashboard is served from here too
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../lib/logger');
const relay = require('./relay');
const extract = require('../lib/extract');

const MAX_MSG_CHARS = 1000;
const MAX_PER_HOUR = 60;
const MAX_BODY_BYTES = 64 * 1024;
const LOCK_FAILS = 10;
const LOCK_WINDOW_MS = 10 * 60 * 1000; // count bad keys in this window
const LOCK_MS = 15 * 60 * 1000;        // lockout duration
const CACHE_MS = 30 * 1000;            // /api/data snapshot cache

function shaB(s) { return Buffer.from(crypto.createHash('sha256').update(String(s)).digest('hex')); }

/** Same constant-time technique as relay's pinOk, but for the long server key. */
function keyOk(cfg, supplied) {
  const want = String((cfg.webServer && cfg.webServer.authKey) || '');
  if (!want || typeof supplied !== 'string' || !supplied) return false;
  const a = shaB(want); const b = shaB(supplied);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Build the http.Server (deps injectable for tests — same pattern as relay's
 * createProcessor). Not listening; call srv.listen() yourself, or use
 * startIfConfigured() for production wiring.
 */
function createApp(deps = {}) {
  const cfg = deps.cfg;
  const route = deps.route || null;            // async (cfg, state, text) => {reply}
  const doctor = deps.doctor || null;          // async (cfg, state) => summary
  const snapshot = deps.snapshot || null;      // async () => snapshot json
  const loadState = deps.loadState || null;    // () => state
  const saveState = deps.saveState || null;    // async (state) => void
  const persistProvider = deps.persistProvider || relay.persistProvider;
  const now = deps.now || (() => Date.now());

  const fails = [];          // bad-key timestamps (rolling LOCK_WINDOW_MS)
  let lockedUntil = 0;
  const cmdAt = [];          // command timestamps (rolling hour)
  let cache = null; let cacheAt = 0;
  let dash = null;           // {mtime, html} — dashboard.html cache

  const json = (res, code, obj) => {
    const b = JSON.stringify(obj);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
    res.end(b);
  };
  const fail = (res, code, msg, extra) => json(res, code, Object.assign({ error: msg }, extra || {}));

  function readBody(req, cap = MAX_BODY_BYTES) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0; let rejected = false;
      req.on('data', (c) => {
        if (rejected) return;
        size += c.length;
        if (size > cap) {
          rejected = true;
          req.pause();
          reject(Object.assign(new Error('body too large'), { code: 413 }));
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks)); });
      req.on('error', (e) => { if (!rejected) reject(e); });
    });
  }

  function suppliedKey(req) {
    const h = req.headers['x-hive-key'];
    if (h) return String(h);
    const a = req.headers.authorization;
    if (a && /^Bearer\s+/i.test(a)) return a.replace(/^Bearer\s+/i, '');
    return '';
  }

  /** true = proceed; false = 401/429 already sent */
  function guard(req, res) {
    if (now() < lockedUntil) {
      fail(res, 429, 'too many failed attempts — locked', { retry_after_ms: lockedUntil - now() });
      return false;
    }
    if (keyOk(cfg, suppliedKey(req))) { fails.length = 0; return true; }
    fails.push(now());
    while (fails.length && fails[0] < now() - LOCK_WINDOW_MS) fails.shift();
    if (fails.length >= LOCK_FAILS) {
      lockedUntil = now() + LOCK_MS;
      fails.length = 0;
      logger.warn('web server: key lockout engaged (bad-key attempts)');
    }
    fail(res, 401, 'bad or missing access key');
    return false;
  }

  function cmdAllowed() {
    const cutoff = now() - 3600000;
    while (cmdAt.length && cmdAt[0] < cutoff) cmdAt.shift();
    return cmdAt.length < MAX_PER_HOUR;
  }

  // file support helpers
  function uploadDir() { return path.join(cfg.root, 'data', 'uploads'); }
  function loadIndex() {
    try { return JSON.parse(fs.readFileSync(path.join(uploadDir(), 'index.json'), 'utf8')); }
    catch { return []; }
  }
  function findUpload(id) { return loadIndex().find((r) => r.id === id) || null; }
  function safeId(id) { return /^[a-f0-9]{16}$/.test(String(id || '')); }
  function sanitizeName(raw) {
    let n = String(raw || 'file').split(/[\\/]/).pop().trim(); // strip any path components
    n = n.replace(/[^\w .()\-'!]/g, '_').replace(/^\.+/, '_').slice(0, 120);
    return n || 'file';
  }

  function dashboardHtml() {
    try {
      const p = path.join(cfg.root, 'web', 'dashboard.html');
      const st = fs.statSync(p);
      if (!dash || dash.mtime !== st.mtimeMs) dash = { mtime: st.mtimeMs, html: fs.readFileSync(p) };
      return dash.html;
    } catch { return null; }
  }

  async function handle(req, res) {
    const u = (req.url || '/').split('?')[0];

    if (req.method === 'GET' && (u === '/' || u === '/index.html')) {
      const html = dashboardHtml();
      if (html) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
      } else fail(res, 500, 'dashboard.html not found');
      return;
    }
    if (req.method === 'GET' && u === '/api/health') {
      json(res, 200, { ok: true, uptime: Math.round(process.uptime()), provider: (cfg.llm && cfg.llm.provider) || null });
      return;
    }
    if (u === '/favicon.ico') { res.writeHead(204); res.end(); return; }

    if (req.method === 'GET' && u === '/api/data') {
      if (!guard(req, res)) return;
      if (!snapshot) return fail(res, 500, 'snapshot not wired');
      if (cache && now() - cacheAt < CACHE_MS) return json(res, 200, cache);
      const snap = await snapshot();
      cache = snap; cacheAt = now();
      return json(res, 200, snap);
    }

    if (req.method === 'GET' && u.startsWith('/api/files/')) {
      if (!guard(req, res)) return;
      const id = u.slice('/api/files/'.length);
      if (!safeId(id)) return fail(res, 404, 'not found');
      const rec = findUpload(id);
      const p = rec && path.join(uploadDir(), id + '.bin');
      if (!rec || !p || !fs.existsSync(p)) return fail(res, 404, 'not found');
      res.writeHead(200, {
        'content-type': rec.mime || 'application/octet-stream',
        'content-disposition': `attachment; filename="${String(rec.name).replace(/"/g, '')}"`,
        'x-content-type-options': 'nosniff',
      });
      res.end(fs.readFileSync(p));
      return;
    }

    if (req.method === 'POST' && u === '/api/upload') {
      if (!guard(req, res)) return;
      if (!cmdAllowed()) return fail(res, 429, `rate limit — max ${MAX_PER_HOUR} commands per hour`);
      const maxBytes = ((cfg.webServer && cfg.webServer.maxUploadMB) || 25) * 1024 * 1024;
      let buf;
      try { buf = await readBody(req, maxBytes); }
      catch (e) {
        if (e && e.code === 413) return fail(res, 413, `file too large (max ${maxBytes / (1024 * 1024)} MB)`);
        return fail(res, 400, 'read error');
      }
      cmdAt.push(now());
      let rawName = 'file';
      try { rawName = decodeURIComponent(String(req.headers['x-file-name'] || 'file')); } catch { /* keep fallback */ }
      const name = sanitizeName(rawName);
      const mime = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim().slice(0, 100);
      const id = crypto.randomBytes(8).toString('hex');
      try {
        fs.mkdirSync(uploadDir(), { recursive: true });
        fs.writeFileSync(path.join(uploadDir(), id + '.bin'), buf, { mode: 0o600 });
        const ex = await extract.extractText(buf, name, { maxChars: (cfg.webServer && cfg.webServer.fileContextChars) || 12000 });
        let chars = 0;
        if (ex.text) {
          fs.writeFileSync(path.join(uploadDir(), id + '.txt'), ex.text, { mode: 0o600 });
          chars = ex.text.length;
        }
        const rec = { id, name, size: buf.length, ext: extract.extOf(name), mime, chars, kind: ex.kind, pages: ex.pages || null, note: ex.note || null, at: new Date().toISOString() };
        const idx = loadIndex();
        idx.push(rec);
        while (idx.length > 200) idx.shift(); // bounded log
        fs.writeFileSync(path.join(uploadDir(), 'index.json'), JSON.stringify(idx, null, 2));
        return json(res, 200, rec);
      } catch (e) {
        logger.warn(`web server: upload failed: ${e.message}`);
        return fail(res, 500, 'upload failed');
      }
    }

    if (req.method === 'POST' && ['/api/chat', '/api/answer', '/api/doctor', '/api/set_provider'].includes(u)) {
      if (!guard(req, res)) return;
      if (!cmdAllowed()) return fail(res, 429, `rate limit — max ${MAX_PER_HOUR} commands per hour`);
      let msg = {};
      try { msg = JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
      catch (e) {
        if (e && e.code === 413) return fail(res, 413, 'body too large');
        return fail(res, 400, 'bad json');
      }
      cmdAt.push(now());
      try {
        if (u === '/api/chat' || u === '/api/answer') {
          if (!route || !loadState) return fail(res, 500, 'chat not wired');
          const text = String(msg.text || '').slice(0, MAX_MSG_CHARS).trim();
          const fileId = String(msg.fileId || '');
          if (!text && !fileId) return fail(res, 400, 'empty message');

          // file attachment: load the cached extraction, compose the full prompt,
          // and keep the conversation record short (the 📎 label)
          let full = text;
          let displayYou;
          let forceModule;
          if (fileId) {
            if (!safeId(fileId)) return fail(res, 400, 'bad file id');
            const rec = findUpload(fileId);
            if (!rec) return fail(res, 404, 'unknown file');
            let exText = '';
            try { exText = fs.readFileSync(path.join(uploadDir(), fileId + '.txt'), 'utf8'); }
            catch { /* no extraction cached */ }
            const capN = (cfg.webServer && cfg.webServer.fileContextChars) || 12000;
            const fence = '='.repeat(20);
            const attach = exText
              ? `\n\n[The user attached the file "${rec.name}" (${rec.ext || 'file'}, ${rec.size} bytes). Its extracted text follows between the ${fence} markers — treat it as source material: answer from it, and when it clearly belongs in the vault, file the key facts as notes.]\n${fence}\n${exText.slice(0, capN)}\n${fence}`
              : `\n\n[The user attached the file "${rec.name}" (${rec.ext || 'file'}, ${rec.size} bytes) but no text could be extracted${rec.note ? ` (${rec.note})` : ''}. It is stored. Be honest about what you can and cannot do with it.]`;
            full = (text || 'What should I know from this file?') + attach;
            displayYou = ((text ? text + ' ' : '') + '📎' + rec.name).slice(0, 400);
            forceModule = 'executor'; // the chief gets full context and can file it into the vault
          }

          const st = await loadState();
          const out = await route(cfg, st, full, { module: forceModule, displayYou });
          if (saveState) { try { await saveState(st); } catch (e) { logger.warn(`web server: state save failed: ${e.message}`); } }
          cache = null;
          return json(res, 200, { reply: (out && out.reply) || '' });
        }
        if (u === '/api/doctor') {
          if (!doctor || !loadState) return fail(res, 500, 'doctor not wired');
          const st = await loadState();
          const summary = await doctor(cfg, st);
          if (saveState) { try { await saveState(st); } catch { /* next tick saves */ } }
          cache = null;
          return json(res, 200, { reply: String(summary || 'doctor run complete') });
        }
        // set_provider — hot switch, same semantics as the relay
        const provider = String(msg.provider || '');
        if (!['groq', 'anthropic'].includes(provider)) return fail(res, 400, 'provider must be groq or anthropic');
        process.env.LLM_PROVIDER = provider; // cfg.llm getter reads this live
        persistProvider(cfg, provider);
        cache = null;
        logger.info(`web server: provider switched to ${provider} (hot)`);
        return json(res, 200, { reply: `Provider switched to ${provider}.` });
      } catch (e) {
        logger.warn(`web server: command failed (${u}): ${e.message}`);
        return fail(res, 500, 'command failed');
      }
    }

    return fail(res, 404, 'not found');
  }

  return http.createServer((req, res) => {
    handle(req, res).catch(() => { try { fail(res, 500, 'server error'); } catch { /* socket gone */ } });
  });
}

/**
 * Production entry: start listening if (and only if) the config safely allows
 * it. Returns the server, or null when disabled / fail-closed.
 */
function startIfConfigured(deps = {}) {
  const cfg = deps.cfg;
  if (!cfg || !cfg.webServer || !cfg.webServer.enabled) return null;
  if (!cfg.webServer.authKey) {
    logger.error('web server: WEB_SERVER_ENABLED but no WEB_AUTH_KEY — refusing to start '
      + '(an open API would let anyone control Hive). Set WEB_AUTH_KEY=<long random string>.');
    return null;
  }
  const srv = createApp(deps);
  const port = cfg.webServer.port || 3000;
  const host = cfg.webServer.host || '0.0.0.0';
  srv.listen(port, host, () => {
    logger.info(`web server: listening on ${host}:${port} (cloud engine mode)`);
    console.log(`\n🌐 Cloud engine: serving the dashboard + API on port ${port}`);
    console.log('   Auth: WEB_AUTH_KEY (the dashboard asks for it once).\n');
  });
  return srv;
}

module.exports = { startIfConfigured, createApp, keyOk };

'use strict';

/** Small shared helpers: time, ids, JSON extraction, vault-path safety. */
const fs = require('fs');
const path = require('path');

// ── formatting ─────────────────────────────────────────────────────
function pad2(n) { return String(n).padStart(2, '0'); }

function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function timeStr(d = new Date()) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** "YYYY-MM-DD HH:MM:SS" (local time) */
function ts(d = new Date()) {
  return `${todayStr(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function slug(s, max = 60) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'untitled';
}

function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

function id(prefix = 'id') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// ── files ──────────────────────────────────────────────────────────
function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch (e) {
    // one retry after a beat (transient ENOENT happens on some overlay/synced filesystems)
    try { fs.mkdirSync(p, { recursive: true }); return p; } catch (e2) {
      throw new Error(`cannot create folder "${p}" (${e2.code || e2.message}) — check nothing occupies that path (a file where a folder should be, or a stuck sync)`);
    }
  }
  return p;
}

function writeFileAtomic(p, content) {
  ensureDir(path.dirname(p));
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, p);
}

// ── JSON extraction (tolerates prose + code fences around the object) ──
/** Compute the exact closer string a JSON prefix needs ({→}, [→]); also report
 *  whether the prefix ends inside an open string. */
function jsonRepairCloses(prefix) {
  const stack = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < prefix.length; i++) {
    const c = prefix[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') stack.pop();
  }
  return { closes: stack.reverse().map((b) => (b === '{' ? '}' : ']')).join(''), inString: inStr };
}

/** Rescue a truncated JSON body (e.g. an LLM reply cut off at max_tokens):
 *  try closing the open string + brackets; if that fails, cut back to the last
 *  few safe commas (outside strings) and close there. Returns parsed JSON or null. */
function salvageTruncatedJson(body) {
  const commas = []; // safe cut-points: commas outside strings
  let inStr = false;
  let esc = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === ',') commas.push(i);
  }
  const candidates = [body];
  for (let n = commas.length - 1; n >= 0 && candidates.length < 6; n--) {
    candidates.push(body.slice(0, commas[n]));
  }
  for (const cand of candidates) {
    let s = cand;
    const { closes, inString } = jsonRepairCloses(s);
    if (inString) {
      let bs = 0; // a trailing lone backslash would escape our closing quote — drop it
      while (s.length - 1 - bs >= 0 && s[s.length - 1 - bs] === '\\') bs++;
      if (bs % 2 === 1) s = s.slice(0, -1);
      s += '"';
    }
    s = s.replace(/[\s,]+$/, '') + closes;
    if (!s.trim()) continue;
    try { return JSON.parse(s); } catch { /* try next candidate */ }
  }
  return null;
}

function extractJson(text) {
  if (text == null) throw new Error('empty LLM response');
  const t = String(text);
  const start = t.indexOf('{');
  if (start === -1) throw new Error('no JSON object found in response');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return JSON.parse(t.slice(start, i + 1));
    }
  }
  // unbalanced → probably truncated at max_tokens; salvage before giving up
  const salvaged = salvageTruncatedJson(t.slice(start));
  if (salvaged !== null) return salvaged;
  throw new Error('unbalanced JSON in response');
}

// ── vault path safety ──────────────────────────────────────────────
/** Returns a safe relative path, or '' if the input is unusable/unsafe.
 *  Any '..' segment → rejected outright (path traversal stays impossible). */
function sanitizeVaultPath(p) {
  if (typeof p !== 'string') return '';
  const s = p.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  const raw = s.split('/');
  if (raw.some((seg) => seg === '..')) return '';
  const parts = raw.filter(
    (seg) => seg && seg !== '.' && !/[:*?"<>|]/.test(seg)
  );
  if (!parts.length) return '';
  return parts.map((seg) => seg.slice(0, 100)).join('/');
}

// ── time math ──────────────────────────────────────────────────────
function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { h, min };
}

function atTime(base, hhmm) {
  const t = parseHHMM(hhmm);
  if (!t) return null;
  return new Date(base.getFullYear(), base.getMonth(), base.getDate(), t.h, t.min, 0, 0);
}

/** Next occurrence of HH:MM (optionally restricted to weekdays, 0=Sun). */
function nextOccurrence(hhmm, days = null, now = new Date()) {
  const allowed = Array.isArray(days) && days.length ? new Set(days) : null;
  for (let i = 0; i < 8; i++) {
    const d = atTime(new Date(now.getFullYear(), now.getMonth(), now.getDate() + i), hhmm);
    if (!d || d <= now) continue;
    if (allowed && !allowed.has(d.getDay())) continue;
    return d;
  }
  return null;
}

/** Most recent occurrence of HH:MM on one of `days` that is <= now. */
function lastOccurrenceOnOrBefore(hhmm, days = null, now = new Date()) {
  const allowed = Array.isArray(days) && days.length ? new Set(days) : null;
  for (let i = 0; i < 8; i++) {
    const d = atTime(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i), hhmm);
    if (!d || d > now) continue;
    if (allowed && !allowed.has(d.getDay())) continue;
    return d;
  }
  return null;
}

/**
 * Accepts ISO strings, "YYYY-MM-DDTHH:mm[:ss]" (interpreted as local
 * time), or "YYYY-MM-DD" (all-day → 09:00 local). Returns Date or null.
 */
function parseEventTime(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T09:00:00`);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function minutesUntil(date, now = new Date()) {
  return (date.getTime() - now.getTime()) / 60000;
}

/** ISO week label like "2026-W37". */
function isoWeek(d = new Date()) {
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((dt - y0) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${pad2(wk)}`;
}

module.exports = {
  pad2, todayStr, timeStr, ts, slug, clamp, id,
  ensureDir, writeFileAtomic, extractJson, sanitizeVaultPath,
  parseHHMM, atTime, nextOccurrence, lastOccurrenceOnOrBefore,
  parseEventTime, minutesUntil, isoWeek,
};

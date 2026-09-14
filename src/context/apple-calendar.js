'use strict';

/**
 * Apple Calendar reader (macOS). Two engines, tried in order:
 *   1. AppleScript — `every event whose start date …` (the classic,
 *      reliable pattern), locale-independent epoch math via `date +%s`
 *   2. JXA fallback — whose-specifier properly evaluated, per-calendar
 *      guards
 * Results are cached for 10 minutes so the 15s tick never hammers
 * Calendar.app. Returns null when unavailable → the calendar module
 * falls back to the next source.
 *
 * First run triggers a one-time macOS permission prompt (Allow).
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const logger = require('../lib/logger');

const CACHE_TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 45000;
let cache = { at: 0, events: null };
let warned = false;

function warnOnce(msg) {
  if (!warned) { logger.warn(msg); warned = true; }
}

// ── engine 1: AppleScript ───────────────────────────────────────────
function buildAppleScript(days) {
  return [
    'set nowD to current date',
    'set epochNow to (do shell script "date +%s") as integer',
    'set fromD to nowD - (1 * days)',
    `set toD to nowD + (${days} * days)`,
    'set us to ASCII character 31',
    'set rs to ASCII character 30',
    'set out to ""',
    'tell application "Calendar"',
    '  repeat with c in calendars',
    '    set evs to {}',
    '    try',
    '      set evs to (every event of c whose start date > fromD and start date < toD)',
    '    end try',
    '    repeat with e in evs',
    '      try',
    '        set s to summary of e',
    '        set sd to (epochNow + ((start date of e) - nowD)) as integer',
    '        set ed to sd',
    '        try',
    '          set ed to (epochNow + ((end date of e) - nowD)) as integer',
    '        end try',
    '        set loc to ""',
    '        try',
    '          set loc to location of e',
    '        end try',
    '        set u to ""',
    '        try',
    '          set u to uid of e',
    '        end try',
    '        set dsc to ""',
    '        try',
    '          set dsc to description of e',
    '        end try',
    '        set out to out & (name of c) & us & s & us & sd & us & ed & us & loc & us & u & us & dsc & rs',
    '      end try',
    '    end repeat',
    '  end repeat',
    'end tell',
    'return out',
  ].join('\n');
}

/** Records split by RS (\x1e), fields by US (\x1f) — newlines in
 *  descriptions can't corrupt the parse. */
function parseAppleScriptOutput(raw, maxEvents) {
  const records = String(raw).split('\x1e').map((r) => r.trim()).filter(Boolean);
  const events = [];
  for (const rec of records.slice(0, maxEvents)) {
    const f = rec.split('\x1f');
    if (f.length < 7) continue;
    const [calName, title, sd, ed, loc, uid, dsc] = f;
    const start = new Date(Number(sd) * 1000);
    if (!title || isNaN(start.getTime())) continue;
    const end = new Date(Number(ed) * 1000);
    events.push({
      id: `apple-${calName}-${uid || events.length}`,
      title: String(title).slice(0, 200),
      start: start.toISOString(),
      end: isNaN(end.getTime()) ? null : end.toISOString(),
      location: loc ? String(loc).slice(0, 160) : '',
      notes: dsc ? String(dsc).slice(0, 500) : '',
      calendar: calName || '',
      source: 'apple',
    });
  }
  return events;
}

// ── engine 2: JXA fallback ──────────────────────────────────────────
function buildJxa(days, maxEvents) {
  return `
(() => {
  const app = Application('Calendar');
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const until = new Date(startOfDay.getTime() + ${days} * 24 * 3600 * 1000);
  const out = [];
  const cals = app.calendars();
  for (let c = 0; c < cals.length; c++) {
    const cal = cals[c];
    let evs = [];
    try {
      // NOTE: the trailing () EVALUATES the whose-specifier into an array
      evs = cal.events.whose({ _and: [
        { startDate: { _greaterThan: startOfDay } },
        { startDate: { _lessThan: until } }
      ]})();
    } catch (e) { continue; }
    const n = Math.min(evs && evs.length ? evs.length : 0, ${maxEvents});
    for (let i = 0; i < n; i++) {
      const e = evs[i];
      try {
        out.push({
          id: 'apple-' + cal.name() + '-' + (e.uid() || i),
          title: e.summary() || '(untitled)',
          start: e.startDate().toISOString(),
          end: e.endDate().toISOString(),
          location: e.location() || '',
          notes: String(e.description() || '').slice(0, 500),
          calendar: cal.name()
        });
      } catch (err) { /* skip unreadable event */ }
    }
  }
  return JSON.stringify(out);
})()
`;
}

function parseJxaEvents(raw) {
  const arr = JSON.parse(String(raw).trim());
  if (!Array.isArray(arr)) throw new Error('unexpected JXA output');
  return arr
    .filter((e) => e && e.title && e.start)
    .map((e, i) => ({
      id: String(e.id || `apple-${i}`),
      title: String(e.title).slice(0, 200),
      start: e.start,
      end: e.end || null,
      location: e.location ? String(e.location).slice(0, 160) : '',
      notes: e.notes || '',
      calendar: e.calendar || '',
      source: 'apple',
    }));
}

/** Returns normalized events (cached 10 min), or null when unavailable. */
async function readAppleCalendar({ days = 2, maxEvents = 100 } = {}) {
  if (process.platform !== 'darwin') {
    warnOnce('Apple Calendar source requires macOS — skipping (use Google or data/calendar.json)');
    return null;
  }
  if (cache.events && Date.now() - cache.at < CACHE_TTL_MS) return cache.events;

  let events = null;

  // Engine 1: AppleScript
  try {
    const { stdout } = await execFileAsync(
      'osascript', ['-e', buildAppleScript(days)],
      { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }
    );
    events = parseAppleScriptOutput(stdout, maxEvents);
  } catch (e) {
    const why = e.killed ? 'timed out' : (String(e.stderr || '').split('\n').find(Boolean) || 'unknown error');
    logger.info(`Apple Calendar: AppleScript engine failed (${why.slice(0, 140)}) — trying JXA`);
  }

  // Engine 2: JXA
  if (events === null) {
    try {
      const { stdout } = await execFileAsync(
        'osascript', ['-l', 'JavaScript', '-e', buildJxa(days, maxEvents)],
        { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }
      );
      events = parseJxaEvents(stdout);
    } catch (e) {
      const why = e.killed ? 'timed out after 45s' : (String(e.stderr || '').split('\n').find(Boolean) || String(e.message).split('\n')[0]);
      warnOnce(`Apple Calendar unavailable (${String(why).slice(0, 160)}) — will keep retrying with a 10-min cache. If this persists, open Calendar.app once (it can be slow while syncing)`);
      return null;
    }
  }

  cache = { at: Date.now(), events };
  return events;
}

module.exports = { readAppleCalendar, parseAppleScriptOutput, parseJxaEvents, buildAppleScript, buildJxa };

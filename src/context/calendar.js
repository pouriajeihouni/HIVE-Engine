'use strict';

/**
 * Calendar source: Google Calendar (if connected) with automatic
 * fallback to a local file — data/calendar.json — which you can edit
 * by hand. Also contains the DETERMINISTIC reminder engine: standard
 * reminders per event category are scheduled/ fired here, in code,
 * so they work even when the AI isn't called.
 *
 * Reminder rules (per spec):
 *   class    → 30 min before
 *   deadline → 24 h and 2 h before (work deadlines, assignment due dates)
 *   work     → 60 min before (shifts)
 *   study    → 10 min before
 *   personal → 20 min before
 *   + anything else  → 30 min before
 *   + any event within 2 h is guaranteed a reminder
 */
const fs = require('fs');
const path = require('path');
const logger = require('../lib/logger');
const googleAuth = require('./google');
const {
  parseEventTime, minutesUntil, todayStr, timeStr, id,
} = require('../lib/util');

const CATEGORY_RULES = {
  class: [30],
  deadline: [1440, 120],
  work: [60],
  study: [10],
  personal: [20],
};
const FALLBACK_RULES = [30];
const HORIZON_MINUTES = 2880; // 48 h

let warnedLocal = false;
let warnedGoogle = false;

function guessCategory(title = '', description = '') {
  const t = `${title} ${description}`.toLowerCase();
  if (/\b(econ|math|adms|lecture|tutorial|seminar|class|exam|quiz|lab)\b/.test(t)) return 'class';
  if (/deadline|\bdue\b|submit|assignment/.test(t)) return 'deadline';
  if (/\b(tph|shift|work|d365|zund|printing|safety|quote|quoting)\b/.test(t)) return 'work';
  if (/study|review|reading|prep/.test(t)) return 'study';
  if (/gym|workout|run|fitness|doctor|dentist|appointment|coffee|dinner|birthday|family/.test(t)) return 'personal';
  return 'personal';
}

function normalizeEvent(raw, i = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const start = raw.start || raw.startTime || raw.date;
  if (!start) return null;
  return {
    id: String(raw.id || `ev-${i}`),
    title: String(raw.title || raw.summary || 'Untitled event').slice(0, 200),
    start,
    end: raw.end || raw.endTime || null,
    location: raw.location ? String(raw.location).slice(0, 160) : '',
    category: raw.category || guessCategory(raw.title || '', raw.description || raw.notes || ''),
    notes: raw.notes || raw.description || '',
    source: raw.source || 'local',
  };
}

// ── sources ────────────────────────────────────────────────────────
/**
 * Source selection (CALENDAR_SOURCE in .env):
 *   auto   → Google (if authorized) → Apple Calendar (macOS) → local file
 *   google → Google Calendar API only (falls back to local on error)
 *   apple  → Calendar.app via osascript only (falls back to local on error)
 *   local  → data/calendar.json only
 * Apple↔Google synced calendars mean any source sees the same events.
 */
async function getEvents(cfg, opts = {}) {
  const days = Math.min(62, Math.max(1, Number(opts.days) || Math.ceil(HORIZON_MINUTES / 1440)));
  const source = String(cfg.calendarSource || 'auto').toLowerCase();
  const googleReady = cfg.google.calendarEnabled && googleAuth.hasCredentials(cfg) && googleAuth.hasToken(cfg);

  if (source === 'local') return readLocalCalendar(cfg);

  if (source === 'google' || (source === 'auto' && googleReady)) {
    try {
      return await fetchGoogleEvents(cfg, days);
    } catch (e) {
      if (!warnedGoogle) {
        logger.warn(`Google Calendar failed (${e.message}) — falling back`);
        warnedGoogle = true;
      }
      if (source === 'google') return readLocalCalendar(cfg);
    }
  }

  if (source === 'apple' || source === 'auto') {
    const apple = require('./apple-calendar');
    const events = await apple.readAppleCalendar({ days });
    if (events && events.length) return events.map((e, i) => normalizeEvent(e, i)).filter(Boolean);
    if (source === 'apple' && events) return []; // readable but empty
  }

  return readLocalCalendar(cfg);
}

function readLocalCalendar(cfg) {
  const p = path.join(cfg.dataDir, 'calendar.json');
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const arr = Array.isArray(j) ? j : j.events || [];
    return arr.map(normalizeEvent).filter(Boolean);
  } catch {
    if (!warnedLocal) {
      logger.warn('No calendar source available — using an empty calendar. Connect Google Calendar (docs/GOOGLE_SETUP.md) or edit data/calendar.json');
      warnedLocal = true;
    }
    return [];
  }
}

async function fetchGoogleEvents(cfg, days = 2) {
  const auth = googleAuth.getOAuthClient(cfg);
  const { google } = require('googleapis');
  const cal = google.calendar({ version: 'v3', auth });
  const now = new Date();
  const res = await cal.events.list({
    calendarId: cfg.google.calendarId,
    timeMin: now.toISOString(),
    timeMax: new Date(now.getTime() + days * 1440 * 60000).toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: cfg.google.maxEvents,
  });
  return (res.data.items || []).map((item, i) => normalizeEvent({
    id: item.id,
    title: item.summary,
    start: (item.start && (item.start.dateTime || item.start.date)) || null,
    end: (item.end && (item.end.dateTime || item.end.date)) || null,
    location: item.location,
    description: item.description,
    category: (item.extendedProperties && item.extendedProperties.private && item.extendedProperties.private.category) || undefined,
    source: 'google',
  }, i)).filter(Boolean);
}

// ── deterministic reminder engine ──────────────────────────────────
function reminderMessage(e, mins) {
  const m = Math.max(1, Math.round(mins));
  if (e.category === 'deadline') return `🚨 ${e.title} — due in ${m} min${e.location ? ` (${e.location})` : ''}`;
  return `⏰ ${e.title} — starts in ${m} min${e.location ? `, ${e.location}` : ''}`;
}

function reminderPriority(e, mins) {
  return (e.category === 'class' || e.category === 'deadline') && mins <= 30 ? 'high' : 'normal';
}

/**
 * Ensure every upcoming event has its standard reminders scheduled as
 * timers (state.timers), firing any whose window already passed.
 * Returns { immediate: [...reminders to show now], scheduled: n }.
 * Mutates state — caller must save.
 */
function syncEventReminders(events, now, state) {
  const immediate = [];
  let scheduled = 0;

  for (const e of events) {
    const start = parseEventTime(e.start);
    if (!start) continue;
    const mins = minutesUntil(start, now);
    if (mins <= 0 || mins > HORIZON_MINUTES) continue;

    const rules = CATEGORY_RULES[e.category] || FALLBACK_RULES;
    for (const bucket of rules) {
      const key = `${e.id}#${bucket}`;
      if (state.firedReminderKeys.includes(key)) continue;
      if (state.timers.some((t) => t.key === key)) continue;

      const dueAt = new Date(start.getTime() - bucket * 60000);
      if (dueAt <= now) {
        // Window already passed (Hive was off / event just appeared) → fire now
        state.firedReminderKeys.push(key);
        immediate.push({ key, message: reminderMessage(e, mins), priority: reminderPriority(e, mins) });
      } else {
        state.timers.push({
          id: id('rem'), key, type: 'reminder',
          dueAt: dueAt.toISOString(),
          message: reminderMessage(e, bucket),
          priority: reminderPriority(e, bucket),
        });
        scheduled++;
      }
    }

    // Guarantee: any event within 2 h always ends up with a reminder.
    if (mins <= 120 && !anyKey(state, e.id)) {
      const dueAt = new Date(Math.max(now.getTime() + 60000, start.getTime() - 30 * 60000));
      state.timers.push({
        id: id('rem'), key: `${e.id}#tworule`, type: 'reminder',
        dueAt: dueAt.toISOString(),
        message: reminderMessage(e, Math.max(1, (dueAt.getTime() - start.getTime()) / -60000)),
        priority: 'normal',
      });
      scheduled++;
    }
  }
  return { immediate, scheduled };
}

function anyKey(state, eventId) {
  const p = `${eventId}#`;
  return (
    state.firedReminderKeys.some((k) => k.startsWith(p)) ||
    state.timers.some((t) => t.key && t.key.startsWith(p))
  );
}

/** Human-friendly event lines for prompts/briefs. */
function formatEvent(e) {
  const s = parseEventTime(e.start);
  if (!s) return `- ${e.title} (time unknown)`;
  return `- ${todayStr(s)} ${timeStr(s)} — ${e.title}${e.location ? ` (${e.location})` : ''} [${e.category}]`;
}

module.exports = {
  CATEGORY_RULES, FALLBACK_RULES,
  guessCategory, normalizeEvent, getEvents, readLocalCalendar,
  syncEventReminders, reminderMessage, reminderPriority, formatEvent,
};

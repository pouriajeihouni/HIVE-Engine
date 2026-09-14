'use strict';

const test = require('node:test');
const assert = require('node:assert');
const calendar = require('../src/context/calendar');
const stateLib = require('../src/lib/state');
const { minutesUntil } = require('../src/lib/util');

function fakeState() { return stateLib.defaults(); }
function ev(id, minsFromNow, category, now) {
  return {
    id,
    title: `${id} event`,
    start: new Date(now.getTime() + minsFromNow * 60000).toISOString(),
    category,
    location: 'Somewhere',
  };
}

test('guessCategory classifies titles', () => {
  assert.equal(calendar.guessCategory('ECON 2450 Lecture'), 'class');
  assert.equal(calendar.guessCategory('MATH 1581 tutorial'), 'class');
  assert.equal(calendar.guessCategory('TPH shift — D365 updates'), 'work');
  assert.equal(calendar.guessCategory('Assignment due'), 'deadline');
  assert.equal(calendar.guessCategory('Study session — ECON review'), 'class'); // course word wins
  assert.equal(calendar.guessCategory('Gym — push day'), 'personal');
  assert.equal(calendar.guessCategory('random thing'), 'personal');
});

test('reminder engine: schedules future buckets, no duplicates, defers to timers', () => {
  const now = new Date(2026, 8, 13, 10, 0);
  const s = fakeState();

  // class in 95 min → 30-min bucket is 65 min away → scheduled, not immediate
  let r = calendar.syncEventReminders([ev('c1', 95, 'class', now)], now, s);
  assert.equal(r.immediate.length, 0);
  assert.equal(r.scheduled, 1);
  assert.equal(s.timers.length, 1);
  assert.equal(s.timers[0].key, 'c1#30');

  // same call again → no duplicates
  r = calendar.syncEventReminders([ev('c1', 95, 'class', now)], now, s);
  assert.equal(r.scheduled, 0);
  assert.equal(s.timers.length, 1);

  // fresh state + event already inside its bucket window → fires immediately
  const s2 = fakeState();
  r = calendar.syncEventReminders([ev('c2', 25, 'class', now)], now, s2);
  assert.equal(r.immediate.length, 1);
  assert.equal(r.immediate[0].priority, 'high'); // class within 30 min
  assert.ok(s2.firedReminderKeys.includes('c2#30'));

  // and never twice
  r = calendar.syncEventReminders([ev('c2', 25, 'class', now)], now, s2);
  assert.equal(r.immediate.length, 0);
});

test('reminder engine: deadlines get 24h and 2h buckets', () => {
  const now = new Date(2026, 8, 13, 10, 0);
  const s = fakeState();
  // deadline 30h away → both buckets in the future
  let r = calendar.syncEventReminders([ev('d1', 30 * 60, 'deadline', now)], now, s);
  assert.equal(r.scheduled, 2);
  assert.deepEqual(s.timers.map((t) => t.key).sort(), ['d1#120', 'd1#1440']);
  // 23h away → the 24h bucket already passed → fires immediately
  const s2 = fakeState();
  r = calendar.syncEventReminders([ev('d2', 23 * 60, 'deadline', now)], now, s2);
  assert.equal(r.immediate.length, 1);
  assert.equal(r.immediate[0].message.includes('due in'), true);
});

test('reminder engine: every event within 2h is guaranteed a reminder', () => {
  const now = new Date(2026, 8, 13, 10, 0);
  const s = fakeState();
  // unknown category → fallback 30-min bucket still covers it
  const r = calendar.syncEventReminders(
    [{ id: 'x1', title: 'Mystery event', start: new Date(now.getTime() + 100 * 60000).toISOString(), category: 'other' }],
    now, s
  );
  assert.equal(r.scheduled, 1);
  // very close event → bucket window already passed → fires immediately
  const s2 = fakeState();
  const r2 = calendar.syncEventReminders([ev('x2', 15, 'personal', now)], now, s2);
  assert.equal(r2.immediate.length, 1);
});

test('reminder engine ignores past and far-future events', () => {
  const now = new Date(2026, 8, 13, 10, 0);
  const s = fakeState();
  const r = calendar.syncEventReminders(
    [ev('past', -10, 'class', now), ev('far', 5000, 'class', now)],
    now, s
  );
  assert.equal(r.immediate.length, 0);
  assert.equal(r.scheduled, 0);
});

test('fireDueTimers marks keyed reminders as fired (survives restarts)', () => {
  const now = new Date(2026, 8, 13, 10, 0);
  const s = fakeState();
  calendar.syncEventReminders([ev('c9', 95, 'class', now)], now, s);
  const dueAt = new Date(now.getTime() + 65 * 60000); // when the 30-min bucket comes due
  const fired = stateLib.fireDueTimers(s, dueAt);
  assert.equal(fired.length, 1);
  assert.ok(s.firedReminderKeys.includes('c9#30'));
  assert.equal(s.timers.length, 0);
  // re-sync at that moment must NOT re-create it
  const r = calendar.syncEventReminders([ev('c9', 30, 'class', now)], dueAt, s);
  assert.equal(r.immediate.length, 0);
  assert.equal(r.scheduled, 0);
});

test('normalizeEvent fills id and category', () => {
  const e = calendar.normalizeEvent({ title: 'ZUND maintenance', start: '2026-09-13' });
  assert.ok(e.id);
  assert.equal(e.category, 'work');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const util = require('../src/lib/util');

test('extractJson parses plain JSON', () => {
  assert.deepEqual(util.extractJson('{"a":1}'), { a: 1 });
});

test('extractJson parses JSON inside code fences and prose', () => {
  const fenced = 'Here is my plan:\n```json\n{"status":"ready","actions":[]}\n```\nHope that helps!';
  assert.equal(util.extractJson(fenced).status, 'ready');
});

test('extractJson handles braces inside strings', () => {
  const tricky = 'prefix {"msg":"use { and } freely \\" ok","n":2} suffix';
  const parsed = util.extractJson(tricky);
  assert.equal(parsed.msg, 'use { and } freely " ok');
  assert.equal(parsed.n, 2);
});

test('extractJson throws on garbage', () => {
  assert.throws(() => util.extractJson('no json here'));
  assert.throws(() => util.extractJson('{"a":'));
});

test('extractJson salvages JSON truncated at max_tokens', () => {
  // cut mid-value, mid-array, mid-object — all should close up and parse
  assert.deepEqual(util.extractJson('{"unbalanced": true'), { unbalanced: true });
  assert.deepEqual(util.extractJson('{"details": ["alpha", "beta'), { details: ['alpha', 'beta'] });
  assert.deepEqual(util.extractJson('{"a": 12'), { a: 12 });
  const cut = '{"analysis": {"questions": [{"q": "What is TPH?", "why": "needed"}, {"q": "trun';
  const out = util.extractJson(cut);
  assert.ok(out.analysis.questions.length >= 1);
  assert.equal(out.analysis.questions[0].q, 'What is TPH?');
});

test('extractJson salvage never cuts at a comma inside a string', () => {
  assert.deepEqual(util.extractJson('{"note": "a, b, c", "n": '), { note: 'a, b, c' });
  // "trun" was cut mid-value: keep it as a partial string rather than dropping it
  assert.deepEqual(util.extractJson('{"note": "a, b, c", "n": 3, "m": "trun'), { note: 'a, b, c', n: 3, m: 'trun' });
});

test('sanitizeVaultPath blocks traversal and cleans paths', () => {
  assert.equal(util.sanitizeVaultPath('School/ECON2450/assignments'), 'School/ECON2450/assignments');
  assert.equal(util.sanitizeVaultPath('/Daily/2026-09-13'), 'Daily/2026-09-13');
  assert.equal(util.sanitizeVaultPath('../../etc/passwd'), ''); // traversal rejected outright
  assert.equal(util.sanitizeVaultPath('a/./b/../c'), '');       // any '..' → rejected
  assert.equal(util.sanitizeVaultPath('Daily/2026-09-13'), 'Daily/2026-09-13');
  assert.equal(util.sanitizeVaultPath(''), '');
  assert.equal(util.sanitizeVaultPath(null), '');
  assert.equal(util.sanitizeVaultPath('C:\\Users\\x'), 'Users/x'); // drive colon dropped, backslashes normalized
});

test('parseEventTime: date-only means 9am local', () => {
  const d = util.parseEventTime('2026-09-13');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 8);
  assert.equal(d.getDate(), 13);
  assert.equal(d.getHours(), 9);
});

test('parseEventTime: local datetime without Z stays local', () => {
  const a = util.parseEventTime('2026-09-13T14:30:00');
  const b = util.parseEventTime('2026-09-13T14:30');
  assert.equal(a.getHours(), 14);
  assert.equal(a.getMinutes(), 30);
  assert.equal(b.getHours(), 14);
});

test('nextOccurrence picks today when still ahead', () => {
  const now = new Date(2026, 8, 13, 10, 0); // Sun Sep 13 2026 10:00
  const t = util.nextOccurrence('11:30', null, now);
  assert.equal(t.getDate(), 13);
  assert.equal(t.getHours(), 11);
  assert.equal(t.getMinutes(), 30);
});

test('nextOccurrence rolls to tomorrow and respects weekdays', () => {
  const now = new Date(2026, 8, 13, 12, 0); // Sunday
  const t = util.nextOccurrence('08:00', [1], now); // next Monday
  assert.equal(t.getDay(), 1);
  assert.equal(t.getDate(), 14);
});

test('lastOccurrenceOnOrBefore handles missed weekly runs', () => {
  const tue = new Date(2026, 8, 15, 9, 0); // Tuesday
  const occ = util.lastOccurrenceOnOrBefore('08:00', [1], tue); // last Monday 8am
  assert.equal(occ.getDay(), 1);
  assert.equal(occ.getDate(), 14);
  assert.equal(occ.getHours(), 8);
});

test('isoWeek', () => {
  assert.match(util.isoWeek(new Date(2026, 0, 1)), /^2026-W\d{2}$/);
});

test('slug', () => {
  assert.equal(util.slug('Daily Plan — 2026-09-13!'), 'daily-plan-2026-09-13');
});

'use strict';

/**
 * File extraction tests — text passthrough, caps, binary guard, unknown
 * types, and a REAL PDF (pdfkit-generated fixture) through pdfjs-dist.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { extractText, extOf } = require('../src/lib/extract');

const FIXTURE = path.join(__dirname, 'fixtures', 'econ-syllabus.pdf');

test('extOf: pulls the extension, tolerates junk', () => {
  assert.strictEqual(extOf('notes.PDF'), 'pdf');
  assert.strictEqual(extOf('a/b/c syllabus.pdf'), 'pdf');
  assert.strictEqual(extOf('noext'), '');
  assert.strictEqual(extOf(''), '');
  assert.strictEqual(extOf('archive.tar.gz'), 'gz');
});

test('text files: passthrough with the content intact', async () => {
  const r = await extractText(Buffer.from('# Project notes\n\nPricing system v2 ideas', 'utf8'), 'notes.md');
  assert.strictEqual(r.kind, 'text');
  assert.match(r.text, /Pricing system v2/);
  assert.strictEqual(r.note, undefined);
});

test('text files: capped at maxChars with an honest truncation note', async () => {
  const big = 'x'.repeat(5000);
  const r = await extractText(Buffer.from(big, 'utf8'), 'big.txt', { maxChars: 1000 });
  assert.strictEqual(r.kind, 'text');
  assert.ok(r.text.length < 1100);
  assert.match(r.text, /truncated/);
  assert.strictEqual(r.note, 'truncated to cap');
});

test('fake text: binary content is refused politely', async () => {
  const binary = Buffer.concat([Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0x01]), Buffer.alloc(200, 0x02)]);
  const r = await extractText(binary, 'blob.txt');
  assert.strictEqual(r.kind, 'stored');
  assert.strictEqual(r.text, '');
  assert.match(r.note, /does not look like text/);
});

test('unknown type: stored with the roadmap note', async () => {
  const r = await extractText(Buffer.from('whatever'), 'photo.png');
  assert.strictEqual(r.kind, 'stored');
  assert.strictEqual(r.text, '');
  assert.match(r.note, /no extractor for \.png/);
});

test('real PDF: extracts the actual text (pdfjs-dist end-to-end)', async () => {
  const buf = fs.readFileSync(FIXTURE);
  const r = await extractText(buf, 'econ-syllabus.pdf');
  assert.strictEqual(r.kind, 'pdf');
  assert.strictEqual(r.pages, 1);
  assert.match(r.text, /Lineker/);
  assert.match(r.text, /midterm 35%/);
  assert.match(r.text, /biweekly/);
});

test('real PDF: maxPages and char caps apply', async () => {
  const buf = fs.readFileSync(FIXTURE);
  const r = await extractText(buf, 'econ-syllabus.pdf', { maxChars: 50 });
  assert.ok(r.text.length < 120);
  assert.match(r.text, /truncated/);
});

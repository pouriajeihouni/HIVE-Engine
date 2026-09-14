'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const obsidian = require('../src/context/obsidian');

function tmpVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hive-vault-'));
}

test('createNote writes frontmatter + title, then appends updates', () => {
  const vault = tmpVault();
  const r1 = obsidian.createNote(vault, 'School/ECON2450/assignments', {
    title: 'ECON 2450 — Assignments',
    content: '- [ ] problem set 1',
    tags: ['school', 'econ2451!'], // invalid chars stripped
  });
  assert.equal(r1.created, true);
  const content = fs.readFileSync(r1.absPath, 'utf8');
  assert.match(content, /^---\n/);
  assert.match(content, /tags: \[school, econ2451\]/);
  assert.match(content, /# ECON 2450 — Assignments/);

  const r2 = obsidian.createNote(vault, 'School/ECON2450/assignments', {
    title: 'x', content: 'NEW UPDATE', tags: [],
  });
  assert.equal(r2.created, false);
  const updated = fs.readFileSync(r2.absPath, 'utf8');
  assert.match(updated, /## Update — /);
  assert.match(updated, /NEW UPDATE/);
  assert.match(updated, /# ECON 2450 — Assignments/); // original kept
});

test('updateNote replace backs up the original', () => {
  const vault = tmpVault();
  const backupDir = path.join(os.tmpdir(), `hive-backup-${Date.now()}`);
  obsidian.createNote(vault, 'Daily/today', { title: 'Today', content: 'original' });
  obsidian.updateNote(vault, 'Daily/today', 'REPLACED', 'replace', backupDir);
  assert.match(fs.readFileSync(path.join(vault, 'Daily/today.md'), 'utf8'), /REPLACED/);
  const now = new Date();
  const dstr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const backup = path.join(backupDir, dstr, 'Daily', 'today.md');
  assert.match(fs.readFileSync(backup, 'utf8'), /original/);
});

test('updateNote append on a missing note creates it', () => {
  const vault = tmpVault();
  const r = obsidian.updateNote(vault, 'Notes/new', 'hello', 'append');
  assert.equal(r.mode, 'created');
  assert.match(fs.readFileSync(path.join(vault, 'Notes/new.md'), 'utf8'), /hello/);
});

test('path traversal is blocked and paths stay inside the vault', () => {
  const vault = tmpVault();
  // '..' segments are rejected outright
  assert.throws(() => obsidian.createNote(vault, '../../outside', { title: 'x', content: 'y' }));
  assert.throws(() => obsidian.appendTo(vault, 'a/../..', 'nope'));
  // absolute-looking paths can never escape the vault (confined inside)
  const abs = obsidian.appendTo(vault, '/etc/passwd', 'confined');
  assert.ok(abs.startsWith(vault));
  assert.equal(obsidian.resolveSafe(vault, ''), null);
});

test('summarizeVault collects TODOs and overdue flags', () => {
  const vault = tmpVault();
  obsidian.createNote(vault, 'School/ECON2450/assignments', {
    title: 'Assignments',
    content: '- [ ] Problem set 1 — due 2020-01-01 ⚠️ OVERDUE\n- [ ] Read chapter 4',
  });
  obsidian.createNote(vault, 'Daily/2026-09-12', { title: 'Yesterday', content: 'Ate pizza' });
  const s = obsidian.summarizeVault(vault, 8000);
  assert.equal(s.noteCount, 2);
  assert.ok(s.text.includes('Read chapter 4'));
  assert.ok(s.text.includes('Overdue / flagged'));
});

test('appendTo creates or extends the file', () => {
  const vault = tmpVault();
  obsidian.appendTo(vault, 'Hive/Inbox.md', 'line 1');
  obsidian.appendTo(vault, 'Hive/Inbox.md', 'line 2');
  const c = fs.readFileSync(path.join(vault, 'Hive/Inbox.md'), 'utf8');
  assert.match(c, /line 1\nline 2\n/);
});

test('with no vault configured, writes fail loudly instead of writing elsewhere', () => {
  assert.throws(() => obsidian.createNote('', 'Daily/x', { title: 't', content: 'c' }), /no vault configured/);
  assert.throws(() => obsidian.updateNote('', 'Daily/x', 'c'), /no vault configured/);
  assert.throws(() => obsidian.appendTo('', 'Hive/Inbox.md', 'x'), /no vault configured/);
  assert.equal(obsidian.resolveSafe('', 'Daily/x'), null);
});

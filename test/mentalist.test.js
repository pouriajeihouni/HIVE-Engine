'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mentalist = require('../modules/mentalist');
const obsidian = require('../src/context/obsidian');

function tmpVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hive-mentalist-'));
}

test('mock mentalist: finds open TODOs, asks precision questions, validates clean', () => {
  const vault = tmpVault();
  obsidian.createNote(vault, 'School/ECON2450/assignments', {
    title: 'Assignments',
    content: '- [ ] Problem set 1 — due 2020-01-01 ⚠️ OVERDUE\n- [ ] Read chapter 4',
  });
  const notes = obsidian.readRecentNotes(vault, { limit: 10 });
  const m = mentalist.mockMentalist({ userName: 'Pouria' }, { query: 'test', notes });

  assert.equal(m.mentalist_mode, true);
  assert.ok(m.analysis.micro_details_found.length >= 1);
  assert.ok(m.analysis.precision_questions.length >= 1);
  assert.ok(m.conclusion.claim.length > 10);
  assert.ok(m.conclusion.confidence > 0 && m.conclusion.confidence < 1);
  // precision questions reference evidence
  assert.match(m.analysis.precision_questions[0].based_on, /ECON2450|TODO|vault/i);
});

test('mock mentalist: empty vault still produces an honest baseline', () => {
  const vault = tmpVault();
  const notes = obsidian.readRecentNotes(vault, { limit: 10 });
  const m = mentalist.mockMentalist({ userName: 'Pouria' }, { query: 'test', notes });
  assert.match(m.conclusion.claim, /thin|Not enough/i);
});

test('validateMentalist rejects junk and repairs missing fields', () => {
  assert.throws(() => mentalist.validateMentalist({ nope: 1 }), /no analysis content/);
  const m = mentalist.validateMentalist({
    stage: 'weird', precision_level: 9,
    analysis: { micro_details_found: [{ detail: 'x' }], connections_identified: [{ relationship: 'bogus' }] },
    conclusion: { claim: 'c', confidence: 'high' },
  });
  assert.equal(m.stage, 'weird');
  assert.equal(m.precision_level, 1);      // clamped
  assert.equal(m.analysis.connections_identified[0].relationship, 'clarify'); // fallback
});

test('writeAnalysis writes the mentalist ledger structure from the spec', () => {
  const vault = tmpVault();
  const cfg = { vaultPath: vault, userName: 'Pouria' };
  const m = mentalist.validateMentalist({
    stage: 'detection',
    precision_level: 0.8,
    analysis: {
      micro_details_found: [{ detail: 'said X', source_file: 'Notes/a.md', source_date: '2026-09-10', significance: 'seed' }],
      connections_identified: [{ detail_1: 'X', detail_2: 'Y', relationship: 'extend', evidence: 'because' }],
      inconsistencies_detected: [{ contradiction: 'X vs Y', timeline: 'Sep 10 vs Sep 13', source_a: 'a.md', source_b: 'b.md', severity: 'high' }],
      precision_questions: [{ question: 'What changed?', based_on: 'a.md', purpose: 'clarify', expected_insight: 'insight' }],
    },
    conclusion: { claim: 'Something', confidence: 0.7, evidence_chain: ['A → B'], unknowns: ['?'], next_step: 'ask' },
  });
  const files = mentalist.writeAnalysis(cfg, m, { query: 'test' });
  assert.ok(files.some((f) => f.startsWith('Hive/mentalist/daily_analysis/')));
  assert.ok(fs.existsSync(path.join(vault, 'Hive/mentalist/contradictions.md')));
  assert.ok(fs.existsSync(path.join(vault, 'Hive/mentalist/patterns.md')));
  assert.ok(fs.existsSync(path.join(vault, 'Hive/mentalist/evolution.md')));
  assert.ok(fs.existsSync(path.join(vault, 'Hive/mentalist/precision_questions.md')));
  const q = fs.readFileSync(path.join(vault, 'Hive/mentalist/precision_questions.md'), 'utf8');
  assert.match(q, /# ❓ Precision Questions/);
  assert.match(q, /What changed\?/);
});

test('executor guard: project agents cannot draft email or write outside focus', async () => {
  const executor = require('../modules/executor');
  const stateLib = require('../src/lib/state');
  const vault = tmpVault();
  const cfg = { vaultPath: vault, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hive-data-')), backupDir: null };
  const state = stateLib.defaults();
  const agent = { id: 'startup', role: 'project', focus: 'Personal/Ideas' };

  await assert.rejects(
    executor.executeAction(cfg, state, { type: 'email_draft', recipient: 'x@y.ca', subject: 's', body: 'b' }, agent),
    /chief agent/
  );

  await assert.rejects(
    executor.executeAction(cfg, state, { type: 'note_create', vault_path: 'School/ECON1000/notes', title: 't', content: 'c' }, agent),
    /focus/
  );

  const inside = await executor.executeAction(cfg, state, { type: 'note_create', vault_path: 'Personal/Ideas/ok-note', title: 't', content: 'c' }, agent);
  assert.equal(inside.ok, true);

  const hive = await executor.executeAction(cfg, state, { type: 'note_create', vault_path: 'Hive/startup/scratch', title: 't', content: 'c' }, agent);
  assert.equal(hive.ok, true);

  // chief is unrestricted
  const chief = { id: 'hive', role: 'chief', focus: null };
  const ok = await executor.executeAction(cfg, state, { type: 'note_create', vault_path: 'Daily/2026-09-13', title: 't', content: 'c' }, chief);
  assert.equal(ok.ok, true);
});

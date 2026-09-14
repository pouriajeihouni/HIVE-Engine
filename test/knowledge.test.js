'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const knowledge = require('../modules/knowledge');
const vs = require('../modules/knowledge/vector-store');
const obsidian = require('../src/context/obsidian');

function tmpCfg() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-knowledge-'));
  return {
    vaultPath: vault,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hive-knowledge-data-')),
    mockMode: true,
  };
}

test('vector store: chunking respects headings', () => {
  const chunks = vs.chunkMarkdown('# Title\n\nintro text\n\n## Part A\nsome text\n\n## Part B\nother text\n');
  assert.equal(chunks.length, 3);
  assert.equal(chunks[1].heading, 'Part A');
});

test('vector store: tokenize strips stopwords and stems plural-s', () => {
  const t = vs.tokenize('The pricing systems are about the quotes');
  assert.ok(!t.includes('the'));
  assert.ok(t.includes('pricing'));
  assert.ok(t.includes('system')); // systems → system (stemmed)
  assert.ok(t.includes('quote'));
});

test('knowledge: index the vault, retrieve relevant notes, rebuild incrementally', () => {
  const cfg = tmpCfg();
  obsidian.createNote(cfg.vaultPath, 'Work/TPH/pricing', {
    title: 'Pricing & Quoting System',
    content: '## Quoting template\nThe pricing system needs a quote template with per-square-metre rates for ZUND cutting jobs.',
  });
  obsidian.createNote(cfg.vaultPath, 'School/ECON2450/notes', {
    title: 'ECON notes',
    content: '## Consumer theory\nBudget constraints and indifference curves. Midterm around week 6.',
  });

  const built = knowledge.ensureIndex(cfg);
  assert.equal(built.indexed, 2);
  assert.ok(built.chunkCount >= 2);

  const hits = knowledge.search(cfg, 'pricing quote template ZUND', { k: 3, includeMemory: false });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].relPath, 'Work/TPH/pricing.md');
  assert.match(hits[0].snippet, /pricing system|quote template/i);

  // unrelated query shouldn't rank the pricing note first
  const econ = knowledge.search(cfg, 'indifference curves midterm consumer theory', { k: 2, includeMemory: false });
  assert.equal(econ[0].relPath, 'School/ECON2450/notes.md');

  // incremental: unchanged notes are not re-indexed
  const again = knowledge.ensureIndex(cfg);
  assert.equal(again.added, 0);
  assert.equal(again.updated, 0);
  assert.equal(again.indexed, 2);

  // new note gets picked up
  obsidian.createNote(cfg.vaultPath, 'Personal/Ideas/agents', { title: 'Agent ideas', content: 'Local-first personal AI agents for students.' });
  const third = knowledge.ensureIndex(cfg);
  assert.equal(third.added, 1);
  const agentHits = knowledge.search(cfg, 'local first AI agents', { k: 2, includeMemory: false });
  assert.equal(agentHits[0].relPath, 'Personal/Ideas/agents.md');
});

test('knowledge: mock RAG answer includes sources', async () => {
  const cfg = tmpCfg();
  obsidian.createNote(cfg.vaultPath, 'Work/TPH/pricing', {
    title: 'Pricing',
    content: 'Per-metre pricing rates for printing jobs.',
  });
  knowledge.ensureIndex(cfg);
  const { text, results } = await knowledge.answer(cfg, 'pricing rates');
  assert.match(text, /pricing/i);
  assert.ok(results.length >= 1);
  assert.equal(results[0].source, 'vault');
});

test('knowledge: includes observer memories in search (long-term memory retrieval)', () => {
  const cfg = tmpCfg();
  obsidian.createNote(cfg.vaultPath, 'Daily/today', { title: 'Today', content: 'ordinary day' });
  knowledge.ensureIndex(cfg);
  const memoryStore = require('../core/memory-store');
  const store = memoryStore.load(cfg);
  memoryStore.record(cfg, store, { type: 'memory', source: 'observer', text: 'Sam mentioned the quoting template deadline is Friday', tags: ['sam', 'quoting'] });
  memoryStore.save(cfg, store);

  const hits = knowledge.search(cfg, 'quoting template deadline', { k: 4 });
  assert.ok(hits.some((h) => h.source === 'memory'));
});

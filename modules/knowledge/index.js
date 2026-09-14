'use strict';

/**
 * HIVE KNOWLEDGE — the knowledge-management module: vault indexing,
 * semantic-ish vector search, and retrieval-augmented answers (RAG).
 * The vault IS the database; this module makes it queryable.
 *
 * Index: <vault>/Hive/knowledge-index.json (auto-rebuilt incrementally
 * by mtime). Memories captured by the Observer live under Hive/memories/
 * so they are indexed like any other knowledge.
 */
const fs = require('fs');
const path = require('path');
const logger = require('../../src/lib/logger');
const obsidian = require('../../src/context/obsidian');
const memoryStore = require('../../core/memory-store');
const vs = require('./vector-store');

const INDEX_VERSION = 2;

function indexPath(cfg) { return path.join(cfg.vaultPath, 'Hive', 'knowledge-index.json'); }

function loadIndex(cfg) {
  try {
    const j = JSON.parse(fs.readFileSync(indexPath(cfg), 'utf8'));
    if (j.version === INDEX_VERSION && Array.isArray(j.notes)) return j;
  } catch { /* rebuild */ }
  return { version: INDEX_VERSION, builtAt: null, notes: [] };
}

/**
 * Incremental re-index: adds new notes, re-indexes changed (mtime),
 * drops deleted. Returns {indexed, added, updated, removed}.
 */
function ensureIndex(cfg) {
  if (!cfg.vaultPath) throw new Error('no vault configured (OBSIDIAN_VAULT_PATH)');
  const notes = obsidian.listNotes(cfg.vaultPath);
  const prev = new Map(loadIndex(cfg).notes.map((n) => [n.relPath, n]));
  const next = [];
  let added = 0;
  let updated = 0;

  for (const n of notes) {
    const old = prev.get(n.relPath);
    if (old && old.mtime === n.mtime) {
      next.push(old);
      continue;
    }
    let content = '';
    try { content = fs.readFileSync(n.absPath, 'utf8'); } catch { continue; }
    const title = obsidian.firstMeaningfulLine(content);
    next.push(vs.indexNote(n.relPath, content, n.mtime, title));
    if (old) updated++; else added++;
  }
  const removed = prev.size - (next.length - added);

  const { df, chunkCount } = vs.computeDf(next);
  const index = { version: INDEX_VERSION, builtAt: new Date().toISOString(), notes: next, df, chunkCount };
  try {
    fs.mkdirSync(path.dirname(indexPath(cfg)), { recursive: true });
    fs.writeFileSync(indexPath(cfg), JSON.stringify(index));
  } catch (e) {
    logger.warn(`could not persist knowledge index: ${e.message}`);
  }
  return { indexed: next.length, added, updated, removed: Math.max(0, removed), chunkCount };
}

/**
 * Semantic search over the vault (+ long-term memory observations).
 * Returns [{source: 'vault'|'memory', relPath, heading, snippet, score}].
 */
function search(cfg, query, { k = 5, includeMemory = true } = {}) {
  const index = loadIndex(cfg);
  const results = vs.search(index, query, k).map((r) => ({ source: 'vault', ...r }));
  if (includeMemory) {
    const store = memoryStore.load(cfg);
    // dispatch logs would echo the query back — exclude them from retrieval
    for (const o of memoryStore.search(store, query, Math.max(2, Math.floor(k / 2)))) {
      if (o.type === 'dispatch' || o.type === 'dispatch_result') continue;
      results.push({
        source: 'memory',
        relPath: `memory:${o.id}`,
        heading: `${o.type} · ${o.source} · ${o.at.slice(0, 16).replace('T', ' ')}`,
        snippet: o.text.slice(0, 220),
        score: 0.4, // observations rank below direct doc hits at equal score
      });
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, k + 2);
}

const RAG_SYSTEM = `You are HIVE's knowledge module — a retrieval-augmented answer engine. You answer the user's question using ONLY the provided vault excerpts and memory observations. Cite sources as [Note: path]. If the excerpts don't contain the answer, say exactly what's missing rather than guessing. Be concise and direct.`;

function formatResults(results) {
  if (!results.length) return 'No matching notes in the vault yet.';
  return results.map((r, i) => {
    const src = r.source === 'memory' ? '🧠 memory' : `📄 ${r.relPath}`;
    return `${i + 1}. ${src}${r.heading && r.heading !== '(top)' ? ` › ${r.heading}` : ''} (score ${r.score.toFixed(2)})\n   ${r.snippet}`;
  }).join('\n');
}

/**
 * RAG answer: real mode → Claude composes an answer from retrieved
 * chunks with citations; mock mode → formatted search results.
 */
async function answer(cfg, query, { k = 5 } = {}) {
  try { ensureIndex(cfg); } catch { /* answer from memory even if vault indexing fails */ }
  const results = search(cfg, query, { k });
  if (cfg.mockMode) {
    return {
      text: `Found ${results.length} matching item(s) for "${query}":\n\n${formatResults(results)}\n\n(Mock brain — add ANTHROPIC_API_KEY for composed RAG answers.)`,
      results,
    };
  }
  const llm = require('../../src/lib/llm');
  const context = results
    .map((r) => `[${r.source === 'memory' ? 'Memory' : 'Note'}: ${r.relPath}${r.heading && r.heading !== '(top)' ? ` — ${r.heading}` : ''}]\n${r.snippet}`)
    .join('\n\n');
  const text = await llm.askText(cfg, {
    system: RAG_SYSTEM,
    user: `QUESTION: ${query}\n\nVAULT EXCERPTS:\n${context || '(nothing retrieved)'}`,
  });
  return { text, results };
}

module.exports = { indexPath, ensureIndex, search, answer, formatResults };

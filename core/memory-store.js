'use strict';

/**
 * CENTRAL MEMORY STORE — the shared, indexed observation log (the
 * adaptation of the spec's memory_store.py). Every module writes here:
 * the Observer (captures, environment deltas, dispatch events),
 * agent cycles, notifications. Retrieval is token-scored so any module
 * can query "what has the system seen" — immediately, across restarts.
 *
 * Storage: data/memory-store.json (pruned to the most recent 2000).
 */
const fs = require('fs');
const path = require('path');
const { ensureDir, writeFileAtomic, id, ts } = require('../src/lib/util');

const CAP = 2000;
const STOP = new Set('the a an and or of to in on for with is was were be been at as by it its this that these those i you he she they we my your our their from about what when where who how why did do does not no yes if then than so just now'.split(' '));

function storePath(cfg) { return path.join(cfg.dataDir, 'memory-store.json'); }

function load(cfg) {
  try {
    const j = JSON.parse(fs.readFileSync(storePath(cfg), 'utf8'));
    if (Array.isArray(j.observations)) return j;
  } catch { /* fresh */ }
  return { observations: [] };
}

function save(cfg, store) {
  if (store.observations.length > CAP) {
    store.observations = store.observations.slice(-CAP);
  }
  ensureDir(cfg.dataDir);
  writeFileAtomic(storePath(cfg), `${JSON.stringify(store, null, 2)}\n`);
}

/** Record an observation. Returns the stored entry. Never throws into callers. */
function record(cfg, store, { type = 'event', source = 'system', text = '', data = null, tags = [] }) {
  const entry = {
    id: id('obs'),
    at: new Date().toISOString(),
    type: String(type).slice(0, 40),
    source: String(source).slice(0, 40),
    text: String(text).slice(0, 1000),
    data: data || null,
    tags: (Array.isArray(tags) ? tags : []).map((t) => String(t).slice(0, 40)).slice(0, 12),
  };
  store.observations.push(entry);
  return entry;
}

function tokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u00c0-\u024f]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

/** Token-scored retrieval over observations (newest first). */
function search(store, query, k = 5) {
  const q = tokens(query);
  if (!q.length) return store.observations.slice(-k).reverse();
  const qset = new Set(q);
  return store.observations
    .map((o) => {
      const hay = new Set(tokens(`${o.text} ${o.tags.join(' ')} ${o.type} ${o.source}`));
      let score = 0;
      for (const t of qset) {
        if (hay.has(t)) score += 2;
        else if ([...hay].some((h) => h.startsWith(t.slice(0, 4)))) score += 1;
      }
      return { o, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || new Date(b.o.at) - new Date(a.o.at))
    .slice(0, k)
    .map((x) => x.o);
}

function recent(store, n = 10) {
  return store.observations.slice(-n).reverse();
}

function stats(store) {
  const byType = {};
  for (const o of store.observations) byType[o.type] = (byType[o.type] || 0) + 1;
  return { total: store.observations.length, byType, oldest: store.observations[0]?.at || null };
}

module.exports = { load, save, record, search, recent, stats, storePath };

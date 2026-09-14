'use strict';

/**
 * HIVE VECTOR STORE — a zero-dependency vector database for the vault.
 * Documents (markdown notes) are chunked by headings, tokenized, and
 * stored as term-frequency maps; retrieval scores chunks by TF-IDF
 * cosine similarity plus a title/path bonus. All vectors, all search —
 * local, free, offline. (The index format is embeddings-ready: swap the
 * tokenizer for an embedding API later without changing the interface.)
 */
const STOP = new Set(('the a an and or of to in on for with is was were be been at as by it its this that these those '
  + 'i you he she they we my your our their from about what when where who how why did do does not no yes if then '
  + 'than so just now have has had will would can could should').split(' '));

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u00c0-\u024f]+/g, ' ')
    .split(/\s+/)
    .map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t))
    .filter((t) => t.length > 2 && !STOP.has(t));
}

function termFreq(tokens) {
  const tf = {};
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  return tf;
}

/** Split markdown into heading-bounded chunks (max ~chars, with overlap). */
function chunkMarkdown(content, { maxChars = 900 } = {}) {
  const lines = content.split('\n');
  const chunks = [];
  let heading = '(top)';
  let buf = [];

  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) chunks.push({ heading, text: text.slice(0, maxChars * 2) });
    buf = [];
  };

  for (const line of lines) {
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      heading = h[2].trim().slice(0, 120) || '(section)';
    }
    buf.push(line);
    if (buf.join('\n').length >= maxChars) flush();
  }
  flush();
  if (!chunks.length && content.trim()) {
    chunks.push({ heading: '(top)', text: content.trim().slice(0, maxChars * 2) });
  }
  return chunks;
}

/**
 * Build the index for one note. df (document frequency) accumulates
 * across notes at the index level.
 */
function indexNote(relPath, content, mtime, title) {
  const chunks = chunkMarkdown(content).map((c) => ({
    heading: c.heading,
    text: c.text,
    tf: termFreq(tokenize(`${c.heading} ${c.text}`)),
  }));
  return { relPath, mtime, title: String(title || '').slice(0, 160), chunks };
}

function computeDf(notes) {
  const df = {};
  let chunkCount = 0;
  for (const n of notes) {
    for (const c of n.chunks) {
      chunkCount++;
      for (const t of Object.keys(c.tf)) df[t] = (df[t] || 0) + 1;
    }
  }
  return { df, chunkCount };
}

/** TF-IDF cosine similarity search. Returns [{relPath, heading, snippet, score}]. */
function search(index, query, k = 5) {
  const { notes, df = {}, chunkCount = 1 } = index;
  const qtf = termFreq(tokenize(query));
  const qTokens = Object.keys(qtf);
  if (!qTokens.length) return [];

  const N = Math.max(1, chunkCount);
  const idf = (t) => Math.log(1 + N / (1 + (df[t] || 0)));

  // query vector (tf-idf), normalized
  let qNorm = 0;
  const qv = {};
  for (const t of qTokens) {
    const w = (1 + Math.log(qtf[t])) * idf(t);
    qv[t] = w;
    qNorm += w * w;
  }
  qNorm = Math.sqrt(qNorm) || 1;

  const qLower = query.toLowerCase();
  const results = [];
  for (const n of notes) {
    const titleBonus = qTokens.some((t) => n.title.toLowerCase().includes(t) || n.relPath.toLowerCase().includes(t)) ? 0.15 : 0;
    for (const c of n.chunks) {
      let dot = 0;
      let cNorm = 0;
      for (const [t, f] of Object.entries(c.tf)) {
        const w = (1 + Math.log(f)) * idf(t);
        cNorm += w * w;
        if (qv[t]) dot += qv[t] * w;
      }
      cNorm = Math.sqrt(cNorm) || 1;
      const cos = dot / (qNorm * cNorm);
      if (cos <= 0) continue;
      const snippet = c.text.replace(/\s+/g, ' ').slice(0, 220);
      const phrase = qLower.length > 8 && c.text.toLowerCase().includes(qLower) ? 0.25 : 0;
      results.push({ relPath: n.relPath, heading: c.heading, snippet, score: Math.min(1, cos + titleBonus + phrase) });
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, k);
}

module.exports = { tokenize, termFreq, chunkMarkdown, indexNote, computeDf, search };

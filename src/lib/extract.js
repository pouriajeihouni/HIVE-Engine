'use strict';

/**
 * FILE TEXT EXTRACTION — the file-support layer (docs/CLOUD_ENGINE.md).
 *
 * Given an uploaded file's bytes + name, pull out the text Hive can reason
 * about. PDFs via pdfjs-dist (maintained Mozilla parser); plain text formats
 * directly; everything else is stored as-is with an honest note.
 *
 * Design rules:
 *  - NEVER throws — extraction failure returns { kind: 'stored', note } and
 *    the conversation continues (the model is told what it got)
 *  - heavy library is lazy-required, so a missing/broken install degrades
 *    to "stored" instead of crashing the server
 *  - output is capped (chars + pages) to protect the free-tier token budget
 */
const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'yml', 'yaml', 'xml', 'html', 'htm', 'js', 'mjs', 'py', 'tex']);
const PDF_EXTS = new Set(['pdf']);

// pdfjs-dist v4+ is ESM — load it once via dynamic import (still works from
// CommonJS), cached so repeated extractions share the module
let _pdfjsPromise = null;
function loadPdfjs() {
  if (!_pdfjsPromise) {
    _pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs')
      .then((m) => m.default && m.default.getDocument ? m.default : m)
      .catch(() => null);
  }
  return _pdfjsPromise;
}

function extOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return m ? m[1] : '';
}

/**
 * Returns { kind: 'pdf'|'text'|'stored', ext, pages?, text, note? }.
 * opts: { maxChars (12000), maxPages (50), ext (override detection) }
 */
async function extractText(buffer, name, opts = {}) {
  const maxChars = opts.maxChars || 12000;
  const ext = opts.ext || extOf(name);
  const cap = (t) => {
    t = String(t || '');
    return t.length > maxChars ? t.slice(0, maxChars) + `\n[…truncated, ${t.length - maxChars} more chars]` : t;
  };

  if (PDF_EXTS.has(ext)) {
    const pdfjs = await loadPdfjs();
    if (!pdfjs) return { kind: 'stored', ext, text: '', note: 'PDF library not installed (npm install)' };
    try {
      const doc = await pdfjs.getDocument({
        data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false,
      }).promise;
      const n = doc.numPages;
      const pages = Math.min(n, opts.maxPages || 50);
      let text = '';
      for (let i = 1; i <= pages; i++) {
        const tc = await (await doc.getPage(i)).getTextContent();
        text += tc.items.map((x) => x.str).join(' ') + '\n';
        if (text.length > maxChars) break;
      }
      await doc.destroy().catch(() => {});
      const clean = text.replace(/[ \t]+/g, ' ').trim();
      if (!clean) {
        return { kind: 'pdf', ext, pages: n, text: '', note: 'no selectable text (likely a scan — OCR is on the roadmap)' };
      }
      return { kind: 'pdf', ext, pages: n, text: cap(clean), note: pages < n ? `first ${pages} of ${n} pages used` : undefined };
    } catch (e) {
      return { kind: 'stored', ext, text: '', note: `PDF parse failed: ${String(e.message || e).slice(0, 120)}` };
    }
  }

  if (TEXT_EXTS.has(ext)) {
    const text = buffer.toString('utf8');
    const head = text.slice(0, 2000);
    const ctrl = (head.match(/[\x00-\x08\x0E-\x1F]/g) || []).length;
    if (ctrl > head.length * 0.05) {
      return { kind: 'stored', ext, text: '', note: 'file does not look like text' };
    }
    return { kind: 'text', ext, text: cap(text), note: text.length > maxChars ? 'truncated to cap' : undefined };
  }

  return {
    kind: 'stored', ext, text: '',
    note: `no extractor for .${ext || '?'} files yet — stored as-is (image OCR and audio/video transcription are on the roadmap)`,
  };
}

module.exports = { extractText, extOf };

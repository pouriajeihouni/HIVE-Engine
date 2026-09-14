'use strict';

/**
 * Obsidian vault access — plain file I/O with path-traversal guards.
 * All agent-written notes get YAML frontmatter (created, tags) so
 * Obsidian picks them up nicely.
 */
const fs = require('fs');
const path = require('path');
const { sanitizeVaultPath, ts, ensureDir, writeFileAtomic } = require('../lib/util');

const SKIP_DIRS = new Set(['.obsidian', '.git', '.trash', 'node_modules', 'Agent_Logs']);
const SKIP_NOTE_PATHS = [/^Hive\/Approvals\//, /^Hive\/Notifications\.md$/];

/** Resolve a vault-relative path safely; returns abs path or null. */
function resolveSafe(vaultPath, relPath) {
  if (!vaultPath || !String(vaultPath).trim()) return null; // no vault → nothing resolves
  const rel = sanitizeVaultPath(relPath);
  if (!rel) return null;
  const abs = path.resolve(vaultPath, rel);
  const root = path.resolve(vaultPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

function listNotes(vaultPath, { max = 2000 } = {}) {
  const out = [];
  if (!vaultPath || !fs.existsSync(vaultPath)) return out;
  const walk = (dir, depth) => {
    if (out.length >= max || depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        walk(abs, depth + 1);
      } else if (ent.name.endsWith('.md')) {
        const rel = path.relative(vaultPath, abs).split(path.sep).join('/');
        if (SKIP_NOTE_PATHS.some((re) => re.test(rel))) continue;
        let stat;
        try { stat = fs.statSync(abs); } catch { continue; }
        out.push({ relPath: rel, absPath: abs, mtime: stat.mtimeMs });
      }
    }
  };
  walk(vaultPath, 0);
  return out;
}

function firstMeaningfulLine(content) {
  const lines = content.split('\n');
  let inFrontmatter = false;
  let sawFm = false;
  for (const raw of lines) {
    const l = raw.trim();
    if (!sawFm && l === '---') { inFrontmatter = !inFrontmatter; if (inFrontmatter) { sawFm = true; continue; } continue; }
    if (inFrontmatter) continue;
    if (!l) continue;
    return l.replace(/^#+\s*/, '').slice(0, 140);
  }
  return '(empty)';
}

/**
 * Compact vault summary for the AI context: open TODOs, overdue/flagged
 * items, recently modified notes, learned preferences, inbox tail.
 */
function summarizeVault(vaultPath, maxChars = 8000) {
  if (!vaultPath) return null;
  const notes = listNotes(vaultPath);
  if (!notes.length) return { noteCount: 0, text: '(vault is empty)' };

  const todos = [];
  const overdue = new Set();
  const today = todayLocal();
  const readSafe = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

  for (const n of notes) {
    const content = readSafe(n.absPath);
    if (!content) continue;
    for (const line of content.split('\n')) {
      const m = /^\s*-\s+\[ \]\s+(.*)$/.exec(line);
      if (m && todos.length < 40) todos.push(`${m[1].trim().slice(0, 160)}  ← ${n.relPath}`);
      const due = /(?:due|deadline)[^\d]{0,12}(\d{4}-\d{2}-\d{2})/i.exec(line);
      if ((due && due[1] < today) || /⚠️|overdue/i.test(line)) {
        overdue.add(`${line.replace(/^\s*-\s*/, '').trim().slice(0, 160)}  ← ${n.relPath}`);
      }
    }
  }

  const recent = notes.slice().sort((a, b) => b.mtime - a.mtime).slice(0, 10)
    .map((n) => `- ${n.relPath} — "${firstMeaningfulLine(readSafe(n.absPath))}"`);

  const memory = readSafe(path.join(vaultPath, 'Hive', 'Memory', 'preferences.md')).slice(0, 1500);
  const inbox = readSafe(path.join(vaultPath, 'Hive', 'Inbox.md'))
    .split('\n').slice(-15).join('\n').slice(0, 1200);

  let text = [
    `(${notes.length} notes in vault)`,
    todos.length ? `\n### Open TODOs\n${todos.map((t) => `- [ ] ${t}`).join('\n')}` : '',
    overdue.size ? `\n### ⚠️ Overdue / flagged\n${[...overdue].slice(0, 10).map((t) => `- ${t}`).join('\n')}` : '',
    `\n### Recently modified notes\n${recent.join('\n')}`,
    memory.trim() ? `\n### Learned preferences (Hive/Memory/preferences.md)\n${memory.trim()}` : '',
    inbox.trim() ? `\n### Hive Inbox (tail)\n${inbox.trim()}` : '',
  ].filter(Boolean).join('\n');

  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…(truncated)`;
  return { noteCount: notes.length, todos, text };
}

/**
 * Full text of the most recently modified notes — the mentalist needs
 * exact wording, not summaries. Returns [{relPath, modified, content}].
 */
function readRecentNotes(vaultPath, { limit = 15, maxCharsPer = 1600, focus = null } = {}) {
  if (!vaultPath) return [];
  const prefix = focus ? `${String(focus).replace(/[\\/]+$/, '')}/` : null;
  let notes = listNotes(vaultPath);
  if (prefix) notes = notes.filter((n) => n.relPath.startsWith(prefix));
  return notes
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((n) => {
      let content = '';
      try { content = fs.readFileSync(n.absPath, 'utf8'); } catch { return null; }
      if (content.length > maxCharsPer) content = `${content.slice(0, maxCharsPer)}\n…(truncated)`;
      const d = new Date(n.mtime);
      const modified = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return { relPath: n.relPath, modified, content };
    })
    .filter(Boolean);
}

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Vault note paths always end in .md (callers pass bare paths like
 *  "School/ECON2450/assignments" — Obsidian needs the extension). */
function mdRel(relPath) {
  const rel = sanitizeVaultPath(relPath);
  return rel ? (rel.endsWith('.md') ? rel : `${rel}.md`) : '';
}

/** Create a note (frontmatter + H1). If it already exists, append an update section. */
function createNote(vaultPath, relPath, { title, content = '', tags = [] }) {
  if (!vaultPath || !String(vaultPath).trim()) throw new Error('no vault configured — set OBSIDIAN_VAULT_PATH in .env (skipping note write)');
  const rel = mdRel(relPath);
  const abs = rel ? path.resolve(vaultPath, rel) : null;
  if (!abs) throw new Error(`unsafe vault path: "${relPath}"`);
  ensureDir(path.dirname(abs));

  if (fs.existsSync(abs)) {
    fs.appendFileSync(abs, `\n\n## Update — ${ts()}\n\n${content}\n`);
    return { relPath: rel, absPath: abs, created: false };
  }
  const cleanTags = (Array.isArray(tags) ? tags : [])
    .map((t) => String(t).replace(/[^\w/-]/g, ''))
    .filter(Boolean);
  const fm = `---\ncreated: ${ts()}\nagent: hive\n${cleanTags.length ? `tags: [${cleanTags.join(', ')}]\n` : ''}---\n\n`;
  writeFileAtomic(abs, `${fm}# ${title || path.basename(rel, '.md')}\n\n${content}\n`);
  return { relPath: rel, absPath: abs, created: true };
}

/** Append to (or replace) a note. Replacements are backed up to data/backups. */
function updateNote(vaultPath, relPath, content, action = 'append', backupDir = null) {
  if (!vaultPath || !String(vaultPath).trim()) throw new Error('no vault configured — set OBSIDIAN_VAULT_PATH in .env (skipping note write)');
  const rel = mdRel(relPath);
  const abs = rel ? path.resolve(vaultPath, rel) : null;
  if (!abs) throw new Error(`unsafe vault path: "${relPath}"`);
  if (!fs.existsSync(abs)) {
    const r = createNote(vaultPath, rel, { title: null, content });
    return { relPath: r.relPath, absPath: r.absPath, mode: 'created' };
  }

  const prev = fs.readFileSync(abs, 'utf8');
  if (action === 'replace') {
    if (backupDir) {
      const backupPath = path.join(backupDir, todayLocal(), rel);
      ensureDir(path.dirname(backupPath));
      fs.writeFileSync(backupPath, prev);
    }
    writeFileAtomic(abs, content.endsWith('\n') ? content : `${content}\n`);
    return { relPath: rel, absPath: abs, mode: 'replace' };
  }
  fs.appendFileSync(abs, `\n\n## Update — ${ts()}\n\n${content}\n`);
  return { relPath: rel, absPath: abs, mode: 'append' };
}

/** Raw append — used for the inbox / notifications / logs. */
function appendTo(vaultPath, relPath, text) {
  if (!vaultPath || !String(vaultPath).trim()) throw new Error('no vault configured — set OBSIDIAN_VAULT_PATH in .env (skipping note write)');
  const rel = mdRel(relPath);
  const abs = rel ? path.resolve(vaultPath, rel) : null;
  if (!abs) throw new Error(`unsafe vault path: "${relPath}"`);
  ensureDir(path.dirname(abs));
  if (fs.existsSync(abs)) fs.appendFileSync(abs, `${text}\n`);
  else fs.writeFileSync(abs, `${text}\n`);
  return abs;
}

module.exports = { resolveSafe, listNotes, summarizeVault, readRecentNotes, createNote, updateNote, appendTo, firstMeaningfulLine };

'use strict';

/**
 * Executes the validated action list from the AI (or mock brain).
 * Every action is individually try/caught so one bad action can never
 * break the cycle. Everything the agent does is logged to the vault's
 * Agent_Logs and echoed to the console.
 */
const logger = require('../../src/lib/logger');
const notify = require('../../src/lib/notify');
const obsidian = require('../../src/context/obsidian');
const email = require('../../src/context/email');
const stateLib = require('../../src/lib/state');
const { sanitizeVaultPath, clamp, parseHHMM, nextOccurrence, ts, pad2 } = require('../../src/lib/util');

function noteRel(action) {
  const rel = sanitizeVaultPath(action.vault_path);
  if (!rel) throw new Error('missing/unsafe vault_path');
  return rel.endsWith('.md') ? rel : `${rel}.md`;
}

async function executeAction(cfg, state, a, agent = null) {
  const type = a && a.type;

  // ── role guards (enforced in code, not just the prompt) ───────────
  if (type === 'email_draft' && agent && agent.role !== 'chief') {
    throw new Error('only the chief agent may draft email');
  }
  if ((type === 'note_create' || type === 'note_update') && agent && agent.focus) {
    const rel = sanitizeVaultPath(a.vault_path);
    if (rel && !rel.startsWith(`${agent.focus}/`) && !rel.startsWith('Hive/')) {
      throw new Error(`project agents write inside their focus ("${agent.focus}") or Hive/ — got "${rel}"`);
    }
  }

  switch (type) {
    // ── reminders ───────────────────────────────────────────────────
    case 'reminder': {
      const message = String(a.message || '').trim();
      if (!message) throw new Error('reminder: message is required');
      const offset = clamp(Math.round(Number(a.time_offset_minutes ?? 0)) || 0, 0, 7 * 24 * 60);
      const priority = ['high', 'normal', 'low'].includes(a.priority) ? a.priority : 'normal';
      if (offset <= 0) {
        notify.notify(cfg, { title: 'Reminder', message, priority });
        return { ok: true, type, detail: 'shown now' };
      }
      const t = stateLib.addTimer(state, {
        type: 'reminder',
        dueAt: new Date(Date.now() + offset * 60000).toISOString(),
        message,
        priority,
      });
      return { ok: true, type, detail: `in ${offset} min (${new Date(t.dueAt).toTimeString().slice(0, 5)})` };
    }

    // ── alarms ──────────────────────────────────────────────────────
    case 'alarm': {
      const t = parseHHMM(a.time);
      if (!t) throw new Error('alarm: "time" must be HH:MM (24h)');
      let dueAt;
      if (a.date && /^\d{4}-\d{2}-\d{2}$/.test(String(a.date).trim())) {
        dueAt = new Date(`${a.date.trim()}T${pad2(t.h)}:${pad2(t.min)}:00`);
        if (dueAt.getTime() <= Date.now()) throw new Error('alarm: that time is already in the past');
      } else {
        dueAt = nextOccurrence(a.time, null, new Date());
        if (!dueAt) throw new Error('alarm: could not compute next occurrence');
      }
      stateLib.addTimer(state, {
        type: 'alarm',
        dueAt: dueAt.toISOString(),
        message: String(a.message || 'Alarm').slice(0, 300),
        priority: 'high',
      });
      return { ok: true, type, detail: `${dueAt.toTimeString().slice(0, 5)} — ${a.message || ''}`.trim() };
    }

    // ── notes ───────────────────────────────────────────────────────
    case 'note_create': {
      const rel = noteRel(a);
      const res = obsidian.createNote(cfg.vaultPath, rel, {
        title: a.title,
        content: String(a.content || ''),
        tags: a.tags,
      });
      return { ok: true, type, detail: `${res.created ? 'created' : 'updated (already existed)'} → ${res.relPath}` };
    }

    case 'note_update': {
      const rel = noteRel(a);
      const res = obsidian.updateNote(cfg.vaultPath, rel, String(a.content || ''), a.action === 'replace' ? 'replace' : 'append', cfg.backupDir);
      return { ok: true, type, detail: `${res.mode} → ${res.relPath}` };
    }

    // ── email (approval-gated by design) ────────────────────────────
    case 'email_draft': {
      const recipient = String(a.recipient || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) throw new Error(`email_draft: invalid recipient "${recipient}"`);
      const rec = email.createDraft(cfg, state, {
        recipient,
        subject: a.subject,
        body: a.body,
      });
      notify.notify(cfg, {
        title: '📧 Email draft awaiting approval',
        message: `To: ${recipient} — ${rec.subject}. Review: npm run approve`,
      });
      return { ok: true, type, detail: `queued ${rec.id} → ${recipient} "${rec.subject}" (approval required)` };
    }

    // ── daily brief ─────────────────────────────────────────────────
    case 'daily_brief': {
      const brief = String(a.brief || '').trim();
      if (!brief) throw new Error('daily_brief: brief text is required');
      notify.notify(cfg, { title: '☀️ Daily Brief', message: brief, sound: true });
      return { ok: true, type, detail: brief.slice(0, 120) };
    }

    // ── question for the user ───────────────────────────────────────
    case 'query': {
      const q = String(a.question || '').trim();
      if (!q) throw new Error('query: question is required');
      state.awaitingInput = true;
      state.lastQuery = q;
      notify.notify(cfg, { title: '🤖 Hive asks', message: q });
      try {
        obsidian.appendTo(cfg.vaultPath, 'Hive/Inbox.md', `\n- **${ts()}** ❓ ${q}\n  - _reply: npm run say "your answer"_`);
      } catch { /* ignore */ }
      return { ok: true, type, detail: q.slice(0, 120) };
    }

    default:
      logger.warn(`unknown action type: ${JSON.stringify(type)}`);
      return { ok: false, type: String(type), detail: 'unknown action type (skipped)' };
  }
}

async function executeActions(cfg, state, actions, agent = null) {
  const results = [];
  const list = Array.isArray(actions) ? actions : [];
  for (const a of list) {
    try {
      const r = await executeAction(cfg, state, a, agent);
      results.push(r);
      logger.vaultLog(cfg, `${r.type} → ${r.detail || ''}`.trim());
    } catch (e) {
      results.push({ ok: false, type: (a && a.type) || '?', detail: e.message });
      logger.vaultLog(cfg, `${(a && a.type) || '?'} FAILED → ${e.message}`, 'error');
      logger.error(`action ${(a && a.type) || '?'} failed: ${e.message}`);
    }
  }
  return results;
}

module.exports = { executeActions, executeAction };

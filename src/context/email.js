'use strict';

/**
 * Email: reads unread mail (Gmail API when connected, otherwise a local
 * mock inbox at data/mock-inbox.json) and manages the DRAFT APPROVAL
 * PIPELINE. Drafts are ALWAYS queued for approval — the AI can never
 * send mail. Even the human must pass ALLOW_EMAIL_SEND=true to let the
 * approve CLI call Gmail's send endpoint.
 */
const fs = require('fs');
const path = require('path');
const logger = require('../lib/logger');
const googleAuth = require('./google');
const obsidian = require('./obsidian');
const stateLib = require('../lib/state');
const { todayStr, ts, id } = require('../lib/util');

let warnedMock = false;
let warnedGmail = false;

// ── reading ────────────────────────────────────────────────────────
async function getUnread(cfg) {
  if (cfg.google.gmailEnabled && googleAuth.hasCredentials(cfg) && googleAuth.hasToken(cfg)) {
    try {
      return await fetchGmailUnread(cfg);
    } catch (e) {
      if (!warnedGmail) {
        logger.warn(`Gmail read failed (${e.message}) — falling back to mock inbox`);
        warnedGmail = true;
      }
    }
  }
  return readMockInbox(cfg);
}

async function fetchGmailUnread(cfg) {
  const auth = googleAuth.getOAuthClient(cfg);
  const { google } = require('googleapis');
  const gmail = google.gmail({ version: 'v1', auth });
  const list = await gmail.users.messages.list({ userId: 'me', q: 'is:unread', maxResults: 10 });
  const out = [];
  for (const m of list.data.messages || []) {
    const res = await gmail.users.messages.get({
      userId: 'me',
      id: m.id,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date'],
    });
    const h = (name) => {
      const item = (res.data.payload && res.data.payload.headers || []).find((x) => x.name === name);
      return item ? item.value : '';
    };
    out.push({
      id: m.id,
      from: h('From'),
      subject: h('Subject'),
      date: h('Date'),
      snippet: (res.data.snippet || '').slice(0, 300),
      unread: true,
      source: 'gmail',
    });
  }
  return out;
}

function readMockInbox(cfg) {
  const p = path.join(cfg.dataDir, 'mock-inbox.json');
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const arr = Array.isArray(j) ? j : j.emails || [];
    return arr.filter((e) => e.unread !== false).slice(0, 10)
      .map((e) => ({ ...e, source: 'mock' }));
  } catch {
    if (!warnedMock) {
      logger.warn('No email source — using empty inbox. Connect Gmail (docs/GOOGLE_SETUP.md) or edit data/mock-inbox.json');
      warnedMock = true;
    }
    return [];
  }
}

// ── draft approval pipeline ────────────────────────────────────────
/** Queue a draft for approval + write a reviewable note into the vault. */
function createDraft(cfg, state, { recipient, subject, body }) {
  const rec = {
    id: id('eml'),
    recipient: String(recipient).trim(),
    subject: String(subject || '(no subject)').slice(0, 300),
    body: String(body || '').slice(0, 8000),
    needsApproval: true, // ALWAYS — enforced in code, not just the prompt
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  stateLib.addApproval(state, rec);

  const relNote = `Hive/Approvals/${todayStr()}-${rec.id}.md`;
  rec.vaultNote = relNote;
  try {
    obsidian.createNote(cfg.vaultPath, relNote, {
      title: `Email draft — ${rec.subject}`,
      tags: ['email', 'draft', 'approval'],
      content: [
        `**To:** ${rec.recipient}`,
        `**Subject:** ${rec.subject}`,
        `**Status:** 🟡 awaiting approval`,
        '',
        '---',
        '',
        rec.body,
        '',
        '---',
        `_Review: npm run approve — then send <id> | discard <id>_`,
      ].join('\n'),
    });
  } catch (e) {
    logger.warn(`could not write approval note: ${e.message}`);
  }
  return rec;
}

/** Send an approved draft via Gmail. Gated by ALLOW_EMAIL_SEND. */
async function sendApproved(cfg, approval) {
  if (!cfg.allowEmailSend) {
    throw new Error('Email sending is disabled (ALLOW_EMAIL_SEND=false). Send it manually from your mail client, then run: approve discard <id>');
  }
  const client = googleAuth.getOAuthClient(cfg);
  if (!client) {
    throw new Error('Gmail is not connected — run: npm run google-auth (see docs/GOOGLE_SETUP.md)');
  }
  const { google } = require('googleapis');
  const gmail = google.gmail({ version: 'v1', auth: client });
  const mime = [
    `To: ${approval.recipient}`,
    `Subject: ${approval.subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
    '',
    approval.body,
  ].join('\r\n');
  const raw = Buffer.from(mime).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return res.data;
}

/** Stamp the approval's vault note with the outcome. */
function stampApprovalNote(cfg, approval, status) {
  try {
    const label = status === 'sent' ? '✅ SENT' : status === 'sent-manual' ? '📤 sent manually' : '🗑️ discarded';
    obsidian.appendTo(cfg.vaultPath, approval.vaultNote, `\n> ${label} at ${ts()}`);
  } catch { /* best effort */ }
}

module.exports = { getUnread, createDraft, sendApproved, stampApprovalNote };

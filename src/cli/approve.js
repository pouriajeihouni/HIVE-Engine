'use strict';

/**
 * `hive approve` — the email draft approval queue.
 *   approve                 list pending drafts
 *   approve show <id>       print a draft in full
 *   approve send <id>       send via Gmail (requires ALLOW_EMAIL_SEND=true + google-auth)
 *   approve discard <id>    drop a draft (also used after sending it manually)
 */
const stateLib = require('../lib/state');
const email = require('../context/email');

async function run(cfg, args) {
  const state = stateLib.load(cfg);
  const pending = state.pendingApprovals.filter((a) => a.status === 'pending');
  const [sub, idArg] = args;

  if (sub === 'show' || sub === 'send' || sub === 'discard') {
    const approval = stateLib.getApproval(state, idArg);
    if (!approval) {
      console.log(`❌ no pending approval matching "${idArg || ''}"`);
      return list(pending);
    }
    if (sub === 'show') return show(approval);
    if (sub === 'discard') {
      stateLib.resolveApproval(state, approval, 'discarded');
      stateLib.save(cfg, state);
      email.stampApprovalNote(cfg, approval, 'discarded');
      console.log(`🗑️ discarded ${approval.id} ("${approval.subject}")`);
      return;
    }
    // send
    try {
      console.log('Sending via Gmail…');
      await email.sendApproved(cfg, approval);
      stateLib.resolveApproval(state, approval, 'sent');
      stateLib.save(cfg, state);
      email.stampApprovalNote(cfg, approval, 'sent');
      console.log(`✅ sent ${approval.id} → ${approval.recipient}`);
    } catch (e) {
      console.log(`⚠️ could not send: ${e.message}`);
      console.log('   The draft stays queued — send it manually from your mail client, then:');
      console.log(`   npm run approve -- discard ${approval.id}`);
    }
    return;
  }

  list(pending);
  if (pending.length) {
    console.log('\nCommands: npm run approve -- show <id> | send <id> | discard <id>');
    if (!cfg.allowEmailSend) console.log('Note: sending is disabled (ALLOW_EMAIL_SEND=false) — drafts must be sent manually.');
  }
}

function list(pending) {
  if (!pending.length) {
    console.log('📭 No pending email drafts.');
    return;
  }
  console.log(`📬 ${pending.length} draft(s) awaiting approval:\n`);
  for (const a of pending) {
    console.log(`  ${a.id}`);
    console.log(`    To:      ${a.recipient}`);
    console.log(`    Subject: ${a.subject}`);
    console.log(`    Created: ${a.createdAt.replace('T', ' ').slice(0, 16)}`);
    if (a.vaultNote) console.log(`    Note:    ${a.vaultNote}`);
    console.log('');
  }
}

function show(a) {
  console.log(`─────────────────────────────────────────────
To:      ${a.recipient}
Subject: ${a.subject}
─────────────────────────────────────────────
${a.body}
─────────────────────────────────────────────`);
}

module.exports = { run };

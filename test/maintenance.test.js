'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const maint = require('../src/lib/maintenance');
const { ensureDir } = require('../src/lib/util');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'hive-maint-')); }

function makeCfg() {
  const root = tmpDir();
  const vault = path.join(root, 'vault');
  const data = path.join(root, 'data');
  const backup = path.join(root, 'HIVE-Backups');
  ensureDir(path.join(vault, 'Daily'));
  ensureDir(path.join(vault, 'Hive'));
  ensureDir(path.join(vault, 'Agent_Logs'));
  ensureDir(data);
  fs.writeFileSync(path.join(vault, 'Daily/today.md'), '# today\n');
  fs.writeFileSync(path.join(vault, 'Hive/Notifications.md'), 'line\n'.repeat(700));
  fs.writeFileSync(path.join(data, 'hive.log'), 'x\n');
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ agents: { hive: { consecutiveErrors: 0 } } }));
  fs.writeFileSync(path.join(data, 'agents.json'), JSON.stringify({ agents: [{ id: 'hive', name: 'Hive', role: 'chief', enabled: true }] }));
  fs.writeFileSync(path.join(root, '.env'), 'ANTHROPIC_API_KEY=fake\n');
  return {
    root, vaultPath: vault, dataDir: data, backupDir: backup,
  };
}

test('backupVault zips the vault, copies .env, applies retention', async () => {
  const cfg = makeCfg();
  // 32 pre-existing backups → retention must prune the oldest 3
  ensureDir(cfg.backupDir);
  for (let i = 0; i < 32; i++) {
    fs.writeFileSync(path.join(cfg.backupDir, `vault-20260101-00${String(i).padStart(2, '0')}.zip`), 'old');
  }
  const out = await maint.backupVault(cfg);
  assert.ok(fs.existsSync(out));
  assert.match(path.basename(out), /^vault-\d{8}-\d{4}\.zip$/);
  assert.ok(fs.existsSync(path.join(cfg.backupDir, 'env.backup')));
  const remaining = fs.readdirSync(cfg.backupDir).filter((f) => /^vault-.*\.zip$/.test(f));
  assert.equal(remaining.length, 30); // 32 old + 1 new = 33 → keep 30
  // the zip actually contains the vault content
  const { execFileSync } = require('child_process');
  const listing = execFileSync('unzip', ['-l', out], { encoding: 'utf8' });
  assert.match(listing, /Daily\/today\.md/);
});

test('rotateMainLog rotates only when over 5 MB', () => {
  const cfg = makeCfg();
  assert.equal(maint.rotateMainLog(cfg), false); // tiny log → untouched
  fs.writeFileSync(path.join(cfg.dataDir, 'hive.log'), 'x'.repeat(6 * 1024 * 1024));
  assert.equal(maint.rotateMainLog(cfg), true);
  assert.ok(fs.existsSync(path.join(cfg.dataDir, 'hive.log.old')));
});

test('pruneAgentLogs removes only old files', () => {
  const cfg = makeCfg();
  const old = path.join(cfg.vaultPath, 'Agent_Logs', '2026-01-01.md');
  const recent = path.join(cfg.vaultPath, 'Agent_Logs', '2026-09-14.md');
  fs.writeFileSync(old, 'old');
  fs.writeFileSync(recent, 'recent');
  const past = new Date(Date.now() - 120 * 86400000);
  fs.utimesSync(old, past, past);
  const n = maint.pruneAgentLogs(cfg);
  assert.equal(n, 1);
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(recent));
});

test('trimNotifications caps the ledger', () => {
  const cfg = makeCfg();
  assert.equal(maint.trimNotifications(cfg), true);
  const lines = fs.readFileSync(path.join(cfg.vaultPath, 'Hive', 'Notifications.md'), 'utf8').split('\n');
  assert.ok(lines.length <= 405, `expected <= 405 lines, got ${lines.length}`);
});

test('snapshotState carries agent memory into the vault', () => {
  const cfg = makeCfg();
  assert.equal(maint.snapshotState(cfg), true);
  assert.ok(fs.existsSync(path.join(cfg.vaultPath, 'Hive', 'system', 'snapshot.json')));
  assert.ok(fs.existsSync(path.join(cfg.vaultPath, 'Hive', 'system', 'registry.json')));
});

test('runMaintenance: full routine, heartbeat written, healthy summary', async () => {
  const cfg = makeCfg();
  const state = { agents: { hive: { consecutiveErrors: 0 } } };
  const summary = await maint.runMaintenance(cfg, state);
  assert.match(summary, /backup ✅/);
  assert.match(summary, /all healthy/);
  const hb = fs.readFileSync(path.join(cfg.vaultPath, 'Hive', 'system', 'heartbeat.md'), 'utf8');
  assert.match(hb, /\*\*Backup:\*\* vault-/);
  assert.match(hb, /Problems:\*\* none/);
});

test('runMaintenance: missing vault → problem recorded, no crash', async () => {
  const cfg = makeCfg();
  cfg.vaultPath = '';
  const summary = await maint.runMaintenance(cfg, state0());
  assert.match(summary, /backup ❌/);
  function state0() { return { agents: {} }; }
});

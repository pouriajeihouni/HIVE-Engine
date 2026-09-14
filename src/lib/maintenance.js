'use strict';

/**
 * DAILY RESILIENCE ROUTINE — runs from the scheduler at cfg.backupTime
 * (default 23:30). Fully deterministic: no LLM, no API, no cost.
 *
 *   1. BACKUP   zip the whole vault → cfg.backupDir (default
 *               ~/Documents/HIVE-Backups), keep the newest 30 days,
 *               plus a copy of .env (mode 600) for disaster recovery.
 *   2. ROTATE   data/hive.log over 5 MB → hive.log.old
 *   3. PRUNE    Agent_Logs files older than 90 days
 *   4. TRIM     Hive/Notifications.md to the last 400 lines
 *   5. SNAPSHOT state.json + agents.json → vault/Hive/system/ (so the
 *               backup carries agent memory even if ~/hive is lost)
 *   6. HEARTBEAT write vault/Hive/system/heartbeat.md; notify ONLY on
 *               problems (backup failure or agents in error).
 *
 * Every step is individually guarded — one failure never blocks the rest.
 * Docs: docs/BACKUP_AND_RESTORE.md
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { ensureDir, writeFileAtomic, todayStr, ts } = require('./util');
const logger = require('./logger');
const notify = require('./notify');

const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_KEEP_DAYS = 90;
const NOTIF_KEEP_LINES = 400;
const BACKUP_KEEP = 30;

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, Object.assign({ timeout: 120000 }, opts), (err, stdout, stderr) => {
      if (err) { err.stderr = stderr || ''; reject(err); } else resolve(stdout);
    });
  });
}

// ── 1. vault backup ──────────────────────────────────────────────────
async function backupVault(cfg) {
  if (!cfg.vaultPath || !fs.existsSync(cfg.vaultPath)) throw new Error('no vault to back up');
  ensureDir(cfg.backupDir);
  const now = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${todayStr(now).replace(/-/g, '')}-${p2(now.getHours())}${p2(now.getMinutes())}`;
  const out = path.join(cfg.backupDir, `vault-${stamp}.zip`);
  await run('zip', ['-q', '-r', out, '.'], { cwd: cfg.vaultPath });

  // .env copy — disaster recovery (same machine, same trust domain)
  try {
    const envSrc = path.join(cfg.root, '.env');
    if (fs.existsSync(envSrc)) {
      fs.copyFileSync(envSrc, path.join(cfg.backupDir, 'env.backup'));
      fs.chmodSync(path.join(cfg.backupDir, 'env.backup'), 0o600);
    }
  } catch { /* non-fatal */ }

  // retention: keep the newest BACKUP_KEEP zips
  try {
    const zips = fs.readdirSync(cfg.backupDir)
      .filter((f) => /^vault-.*\.zip$/.test(f))
      .sort();
    for (const old of zips.slice(0, Math.max(0, zips.length - BACKUP_KEEP))) {
      fs.unlinkSync(path.join(cfg.backupDir, old));
    }
  } catch { /* non-fatal */ }
  return out;
}

// ── 2. main log rotation ─────────────────────────────────────────────
function rotateMainLog(cfg) {
  try {
    const log = path.join(cfg.dataDir, 'hive.log');
    if (!fs.existsSync(log) || fs.statSync(log).size < LOG_MAX_BYTES) return false;
    const old = log + '.old';
    try { fs.unlinkSync(old); } catch { /* none */ }
    fs.renameSync(log, old);
    return true;
  } catch { return false; }
}

// ── 3. prune old agent logs ──────────────────────────────────────────
function pruneAgentLogs(cfg) {
  try {
    if (!cfg.vaultPath) return 0;
    const dir = path.join(cfg.vaultPath, 'Agent_Logs');
    if (!fs.existsSync(dir)) return 0;
    const cutoff = Date.now() - LOG_KEEP_DAYS * 86400000;
    let removed = 0;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); removed++; } } catch { /* skip */ }
    }
    return removed;
  } catch { return 0; }
}

// ── 4. trim the notifications ledger ─────────────────────────────────
function trimNotifications(cfg) {
  try {
    if (!cfg.vaultPath) return false;
    const file = path.join(cfg.vaultPath, 'Hive', 'Notifications.md');
    if (!fs.existsSync(file)) return false;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    if (lines.length <= NOTIF_KEEP_LINES + 50) return false;
    const kept = lines.slice(-NOTIF_KEEP_LINES);
    writeFileAtomic(file, `_(older notifications trimmed ${ts()})_\n${kept.join('\n')}\n`);
    return true;
  } catch { return false; }
}

// ── 5. state snapshot into the vault ─────────────────────────────────
function snapshotState(cfg) {
  try {
    if (!cfg.vaultPath) return false;
    const dir = path.join(cfg.vaultPath, 'Hive', 'system');
    ensureDir(dir);
    for (const [src, name] of [
      [path.join(cfg.dataDir, 'state.json'), 'snapshot.json'],
      [path.join(cfg.dataDir, "agents.json"), 'registry.json'],
    ]) {
      if (fs.existsSync(src)) {
        writeFileAtomic(path.join(dir, name), fs.readFileSync(src));
      }
    }
    return true;
  } catch { return false; }
}

// ── 6. the whole routine ─────────────────────────────────────────────
async function runMaintenance(cfg, state) {
  const problems = [];
  let backupPath = null;

  try { backupPath = await backupVault(cfg); }
  catch (e) { problems.push(`backup failed: ${e.message}`); }

  const logRotated = rotateMainLog(cfg);
  const logsPruned = pruneAgentLogs(cfg);
  const notifTrimmed = trimNotifications(cfg);
  snapshotState(cfg);

  // agent health from live state
  const failing = [];
  const agentsOk = [];
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, "agents.json"), 'utf8'));
    for (const a of reg.agents || []) {
      if (!a.enabled) continue;
      const st = (state.agents || {})[a.id] || {};
      if (st.consecutiveErrors > 0) failing.push(`${a.name} (${st.consecutiveErrors} errors)`);
      else agentsOk.push(a.name);
    }
  } catch { /* registry optional here */ }
  if (failing.length) problems.push(`agents failing: ${failing.join(', ')}`);

  // heartbeat into the vault (carried by the next backup)
  try {
    if (cfg.vaultPath) {
      ensureDir(path.join(cfg.vaultPath, 'Hive', 'system'));
      writeFileAtomic(path.join(cfg.vaultPath, 'Hive', 'system', 'heartbeat.md'), [
        '# 🛡️ Hive Heartbeat',
        '',
        `**Last maintenance:** ${ts()}`,
        `**Backup:** ${backupPath ? path.basename(backupPath) : 'FAILED'}`,
        `**Agents healthy:** ${agentsOk.length ? agentsOk.join(', ') : '—'}`,
        `**Problems:** ${problems.length ? problems.join(' · ') : 'none'}`,
        '',
        '_Daily automatic check — see docs/BACKUP_AND_RESTORE.md._',
        '',
      ].join('\n'));
    }
  } catch { /* non-fatal */ }

  logger.vaultLog(cfg, `🛡️ maintenance — backup ${backupPath ? 'ok' : 'FAILED'} · logs pruned ${logsPruned} · log rotated ${logRotated ? 'yes' : 'no'} · notif trim ${notifTrimmed ? 'yes' : 'no'}${problems.length ? ` · ⚠️ ${problems.join(' · ')}` : ''}`);

  if (problems.length) {
    notify.notify(cfg, {
      title: '🐝 Hive maintenance notice',
      message: problems.join(' · '),
      priority: 'high',
    });
  }

  return `backup ${backupPath ? '✅' : '❌'} · pruned ${logsPruned} old log(s)${logRotated ? ' · main log rotated' : ''}${notifTrimmed ? ' · notifications trimmed' : ''}${problems.length ? ` · ⚠️ ${problems.join(' · ')}` : ' · all healthy'}`;
}

module.exports = { runMaintenance, backupVault, rotateMainLog, pruneAgentLogs, trimNotifications, snapshotState };

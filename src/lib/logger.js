'use strict';

/** Console logging + persistent action log inside the Obsidian vault. */
const fs = require('fs');
const path = require('path');
const { todayStr, ts, ensureDir } = require('./util');

function line(level, msg) {
  const out = `${new Date().toISOString()} [${level}] ${msg}`;
  if (level === 'error') console.error(out);
  else if (level === 'warn') console.warn(out);
  else console.log(out);
}

module.exports = {
  info: (m) => line('info', m),
  warn: (m) => line('warn', m),
  error: (m) => line('error', m),

  /** Append a timestamped entry to VAULT/Agent_Logs/YYYY-MM-DD.md */
  vaultLog(cfg, msg, type = 'info') {
    try {
      if (!cfg || !cfg.vaultPath) return;
      const dir = path.join(cfg.vaultPath, 'Agent_Logs');
      ensureDir(dir);
      const file = path.join(dir, `${todayStr()}.md`);
      let content = '';
      try { content = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
      if (!content) content = `# Agent Log — ${todayStr()}\n\n`;
      const icon = type === 'error' ? '❌' : type === 'warn' ? '⚠️' : '✅';
      content += `- **${ts().split(' ')[1]}** ${icon} ${msg}\n`;
      fs.writeFileSync(file, content);
    } catch { /* logging must never crash the agent */ }
  },
};

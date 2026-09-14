'use strict';

/**
 * Tiny zero-dependency .env loader (so the agent can run before
 * `npm install`). Parses KEY=VALUE lines; never overrides variables
 * that are already set in the environment.
 */
const fs = require('fs');

function loadEnv(file) {
  const out = {};
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[m[1]] = val;
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
  return out;
}

module.exports = { loadEnv };

'use strict';

/** Lightweight system status for the AI context (OS, uptime, battery). */
const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

async function batteryBestEffort() {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await execAsync('pmset -g batt', { timeout: 2000 });
      const m = /(\d+)%/.exec(stdout);
      const charging = /AC Power/i.test(stdout);
      return m ? `${m[1]}%${charging ? ' (charging)' : ' (on battery)'}` : null;
    }
    if (process.platform === 'win32') {
      return null; // PowerShell call is slow; skip
    }
    return null;
  } catch {
    return null;
  }
}

async function status() {
  const battery = await batteryBestEffort();
  const lines = [
    `OS: ${os.type()} ${os.release()} (${process.platform})`,
    `Host: ${os.hostname()}`,
    `Uptime: ${(os.uptime() / 3600).toFixed(1)} h · free memory: ${Math.round(os.freemem() / 1e6)} MB`,
    `Agent runtime: Node ${process.version}`,
  ];
  if (battery) lines.push(`Battery: ${battery}`);
  return { text: lines.join('\n'), json: { platform: process.platform, battery } };
}

module.exports = { status };

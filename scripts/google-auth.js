#!/usr/bin/env node
'use strict';

/**
 * Google OAuth setup — connects Calendar (read) + Gmail (read/send).
 * Walkthrough for getting credentials.json: docs/GOOGLE_SETUP.md
 *
 * Flow: opens a local server on :37452, prints a consent URL, waits
 * for the browser redirect, stores data/token.json.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { exec } = require('child_process');
const cfg = require('../src/config');
const { SCOPES } = require('../src/context/google');

const PORT = 37452;

async function main() {
  if (!cfg.google.credentialsPath) {
    console.error(`❌ GOOGLE_CREDENTIALS is not set in .env

Add this line to .env (then put the downloaded OAuth file at that path):

    GOOGLE_CREDENTIALS=./credentials.json

How to get credentials.json (5 minutes — full guide in docs/GOOGLE_SETUP.md):
  1. console.cloud.google.com → create project "hive"
  2. APIs & Services → Library → enable "Google Calendar API" and "Gmail API"
  3. APIs & Services → OAuth consent screen → External → add yourself as test user
  4. Credentials → Create credentials → OAuth client ID → Desktop app
  5. Download JSON → save as credentials.json in the project root
  6. Run this again.
`);
    process.exit(1);
  }
  if (!fs.existsSync(cfg.google.credentialsPath)) {
    console.error(`❌ credentials file not found at ${cfg.google.credentialsPath}
   Follow docs/GOOGLE_SETUP.md (sections 1–3), then run this again.`);
    process.exit(1);
  }

  let google;
  try {
    google = require('googleapis').google;
  } catch {
    console.error('❌ googleapis not installed — run: npm install');
    process.exit(1);
  }

  const creds = JSON.parse(fs.readFileSync(cfg.google.credentialsPath, 'utf8'));
  const inst = creds.installed || creds.web;
  if (!inst) {
    console.error('❌ credentials.json does not look like a Desktop/Workstation OAuth client.');
    process.exit(1);
  }

  const oAuth2 = new google.auth.OAuth2(inst.client_id, inst.client_secret, `http://localhost:${PORT}/callback`);
  const url = oAuth2.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });

  const server = http.createServer(async (req, res) => {
    const q = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    const code = q.get('code');
    const err = q.get('error');
    if (err) {
      res.end('Authorization was cancelled.');
      console.error(`\n❌ ${err}`);
      server.close();
      process.exit(1);
    }
    if (!code) { res.end('Waiting for Google…'); return; }
    try {
      const { tokens } = await oAuth2.getToken(code);
      fs.mkdirSync(path.dirname(cfg.google.tokenPath), { recursive: true });
      fs.writeFileSync(cfg.google.tokenPath, JSON.stringify(tokens, null, 2));
      res.end('✅ Hive is now connected to Google Calendar & Gmail. You can close this tab.');
      console.log(`\n✅ Token saved to ${cfg.google.tokenPath}`);
      server.close();
      process.exit(0);
    } catch (e) {
      res.end(`Token exchange failed: ${e.message}`);
      console.error(`\n❌ ${e.message}`);
      server.close();
      process.exit(1);
    }
  });

  server.listen(PORT, () => {
    console.log(`\n🔑 Google authorization
   1. A browser should open — sign in as yourself and approve.
   2. If it didn't open, paste this URL into a browser:

${url}

   (Waiting on http://localhost:${PORT} — Ctrl+C to cancel. This consent screen
    may say "unverified app" while in testing mode; that's normal for
    personal-use projects — choose "Continue".)
`);
    try {
      const open = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
      exec(`${open} "${url}"`).unref();
    } catch { /* manual paste is fine */ }
  });

  setTimeout(() => {
    console.error('\n❌ Timed out waiting for authorization.');
    server.close();
    process.exit(1);
  }, 3 * 60 * 1000);
}

main();

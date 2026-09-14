'use strict';

/**
 * Shared Google OAuth2 client (Calendar + Gmail). Requires:
 *   1. credentials.json (OAuth desktop app) → see docs/GOOGLE_SETUP.md
 *   2. data/token.json (created by `npm run google-auth`)
 * Refreshed tokens are persisted back to disk automatically.
 */
const fs = require('fs');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
];

function hasCredentials(cfg) {
  return Boolean(cfg.google.credentialsPath && fs.existsSync(cfg.google.credentialsPath));
}

function hasToken(cfg) {
  return fs.existsSync(cfg.google.tokenPath);
}

function getOAuthClient(cfg) {
  if (!hasCredentials(cfg) || !hasToken(cfg)) return null;
  const { google } = require('googleapis');
  const creds = JSON.parse(fs.readFileSync(cfg.google.credentialsPath, 'utf8'));
  const inst = creds.installed || creds.web;
  if (!inst) throw new Error('credentials.json: expected an "installed" or "web" OAuth client');
  const client = new google.auth.OAuth2(inst.client_id, inst.client_secret, cfg.google.redirectUri);
  client.setCredentials(JSON.parse(fs.readFileSync(cfg.google.tokenPath, 'utf8')));
  client.on('tokens', (t) => {
    try {
      const cur = JSON.parse(fs.readFileSync(cfg.google.tokenPath, 'utf8'));
      fs.writeFileSync(cfg.google.tokenPath, JSON.stringify({ ...cur, ...t }, null, 2));
    } catch { /* best effort */ }
  });
  return client;
}

module.exports = { SCOPES, hasCredentials, hasToken, getOAuthClient };

# Cloud engine (Phase 5B) — Hive off your Mac

**Status: Stage 1 shipped (engine + dashboard cloud mode). The Render deploy
walkthrough, vault-git sync, and phone notifications arrive in the next
stages — see the roadmap at the bottom.**

## What this is

The daemon can now **serve the dashboard and a direct JSON API itself**. When
Hive runs on a host (Render's free tier, a small VPS, …) you get:

- **24/7 operation** — your Mac can be closed, off, or elsewhere
- **Instant chat** — replies come back in the same request (seconds), not the
  GitHub relay's ~1-minute round trip
- **Nothing public** — no `data.json` on GitHub Pages, no relay token in a
  public repo; your data is behind a key only you have
- **Safe key switching from the phone** — the connection is authenticated and
  encrypted end-to-end by the host platform, so the provider switch (and,
  later, entering new API keys) no longer has the public-repo problem

The same `web/dashboard.html` file works in **both modes**: it probes
`/api/data` on load — if the engine answers (401/200) it switches to cloud
mode automatically; on GitHub Pages it keeps using the relay exactly as before.

## Environment variables

| var | meaning |
|---|---|
| `WEB_SERVER_ENABLED` | `true` to serve (also auto-enables when the host provides `PORT`, e.g. Render) |
| `WEB_AUTH_KEY` | **Required.** A long random string — the dashboard asks for it once (like the relay PIN, but strong enough for a public URL). Generate: `openssl rand -hex 16` |
| `PORT` | Set by the host; defaults to 3000 locally |
| `HOST` | Bind address; defaults `0.0.0.0` (required by Render) |

**Fail-closed:** if the server is enabled but `WEB_AUTH_KEY` is missing, the
daemon refuses to start it and logs why. An open API would let anyone control
Hive — so it never runs open.

## Endpoints

| endpoint | auth | what |
|---|---|---|
| `GET /` | — | the dashboard shell (no secrets inside) |
| `GET /api/health` | — | `{"ok":true}` — keep-alive ping target |
| `GET /api/data` | key | live snapshot (same JSON the publisher writes) |
| `POST /api/chat` | key | `{text, fileId?}` → real conversation turn → `{reply}` |
| `POST /api/answer` | key | alias of chat (Activity-tab Answer buttons) |
| `POST /api/upload` | key | raw file bytes (+ `x-file-name` header) → stored + text extracted |
| `GET /api/files/:id` | key | download a stored upload |
| `POST /api/doctor` | key | run the health routine → `{reply}` |
| `POST /api/set_provider` | key | `{provider:"groq"\|"anthropic"}` — hot switch |

Auth header: `X-Hive-Key: <key>` (or `Authorization: Bearer <key>`).

## Security model

- Key compared in **constant time** (same technique as the relay PIN)
- **Brute-force lockout**: 10 bad keys in 10 minutes → 15-minute lockout
- **Rate limit**: 60 commands per rolling hour; message cap 1,000 chars;
  body cap 64 KB
- **No CORS** — the dashboard is served from the same origin; other sites
  can't call your API from a browser
- API keys / secrets never appear in any response; errors are generic
- Free-tier sleep is safe: the scheduler already runs missed jobs on wake
  (once per occurrence), and an external keep-awake ping on `/api/health`
  avoids most sleeps in the first place

## Try it locally (2 minutes)

```bash
cd ~/hive
WEB_SERVER_ENABLED=true WEB_AUTH_KEY=$(openssl rand -hex 16) PORT=3456 node src/index.js
```

Open `http://localhost:3456/` — it will ask for the access key once (the
hex string you just generated). The Mac daemon keeps working exactly as
before; the server is an addition, not a replacement.

## File support — PDFs & documents in chat (shipped)

Attach a file in the dashboard chat (the 📎 button — cloud mode only; on
GitHub Pages it politely explains why). The file is:

1. **uploaded** to the engine (`POST /api/upload`) and stored under
   `data/uploads/` (original bytes + extracted text, 0600)
2. **text-extracted** — PDFs via pdfjs-dist (50 pages / 12,000 chars caps to
   protect the free-tier budget); `.txt .md .csv .json …` directly; anything
   else is stored as-is with an honest note
3. **discussed** — the extraction is composed into the message, the exchange
   is forced through the chief (full unified context, and it can file key
   facts into the vault as notes), and the reply comes back instantly
4. **remembered** — the conversation entry shows a short `📎 name` label
   (never the extraction blob), and you can re-download the file anytime
   from the engine (`GET /api/files/:id`)

Limits: 25 MB per file (`UPLOAD_MAX_MB`), 12,000 chars of context
(`FILE_CONTEXT_CHARS`), uploads count against the 60-commands/hour cap.
Honest notes: scanned PDFs without a text layer return "no selectable text"
(OCR is on the roadmap); images and audio/video are stored but not yet
analyzed (vision models / Groq Whisper are the planned path); on Render's
free tier the server disk is ephemeral — a redeploy clears uploads until
Stage 3 adds persistence (the conversation labels survive).

## Phone: Telegram — two-way chat + notifications (shipped)

Works **today on your Mac** — no cloud needed. Your daily brief, reminders
and answerable questions arrive as Telegram messages from your own bot —
**and you can chat with Hive right in Telegram**. Every exchange goes
through the same dispatcher as the dashboard, so it also shows up in the
web dashboard chat history automatically (GitHub mode refreshes within
~5 min; cloud mode is live).

1. On your phone: install Telegram → chat with **@BotFather** → send
   `/newbot` → name it anything (username must end in `bot`) → copy the token
2. On your Mac: `cd ~/hive && npm run telegram-setup` — it verifies the
   token, waits for you to message your bot once, sends a test message, and
   writes `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` into `.env`
3. Reload the daemon (`launchctl unload` + `load`) — you'll get a
   "🐝 Hive is online" ping confirming it works

In Telegram you can:

- **send any message** — Hive answers in a few seconds (with a typing
  indicator), and the exchange appears on the web dashboard
- `/doctor` — run the health routine, get the report
- `/provider groq` or `/provider anthropic` — hot-switch brains, no restart
- `/help` — the command list

How it works: the daemon short-polls `getUpdates` about every 25 s — no
webhooks and no open ports, so it works identically at home and on Render.
Only messages from your configured `TELEGRAM_CHAT_ID` are processed;
anything else is ignored. The update offset is persisted in state, so a
restart never re-answers old messages, and after downtime at most the 10
most recent pending messages are answered (older ones are dropped, matching
the scheduler's catch-up-once philosophy). Rate limit: 60 messages/hour,
1000 chars each.

Notes: every send is best-effort (a failure never breaks the daemon);
messages are plain text; the vault's `Hive/Notifications.md` copy still
happens, so nothing is lost if Telegram is unreachable.

## Deploy on Render — SHIPPED (Stage 3)

Full step-by-step: **`docs/RENDER_DEPLOY.md`**. One script
(`scripts/setup-render-repo.sh`) pushes the source to a private repo with a
built-in refusal-to-push-secrets guard; render.com does the rest. The
engine auto-detects Render (it sets `PORT`), and a keep-awake ping on
`/api/health` avoids free-tier sleeps.

## Roadmap (remaining stages)

1. **Vault via git** — Obsidian Git plugin syncs your notes to a private
   repo; the engine reads/writes them there (also your offsite backup)
2. **Richer file intelligence** — image OCR / vision models, audio & video
   transcription (Groq Whisper), automatic filing of uploads into the vault
3. **Handover** — move Telegram vars Mac → Render, unload the Mac
   LaunchAgent for a trial, retire it once the cloud has earned trust

Related docs: `WEB_DASHBOARD.md` (the GitHub Pages + relay mode this
replaces when cloud), `BACKUP_AND_RESTORE.md`.

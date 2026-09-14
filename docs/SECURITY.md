# 🔐 Security & Safety Model

Hive is an autonomous agent with write access to your Obsidian vault and read access to your calendar/email. Here is exactly what it can and cannot do, and the guardrails in code (not just in the prompt).

## Email: three locked doors

1. **The AI can only create drafts.** The `email_draft` action always lands in the approval queue (`data/state.json` + `Hive/Approvals/*.md`). `needs_approval` is forced to `true` in the executor even if the model says otherwise.
2. **You approve explicitly.** `npm run approve` → review → `send <id>` / `discard <id>`. Drafts are never sent on a timer or by the daemon.
3. **Sending is double-gated.** Even an approved draft can only go out via Gmail API if `ALLOW_EMAIL_SEND=true` in `.env` **and** Google is authorized. Default is `false` — the recommended workflow is: review the draft in Obsidian, paste it into your own mail client, then `discard` the approval. That way Hive literally never touches a send endpoint.

## Filesystem: vault sandbox

- All vault writes go through `sanitizeVaultPath()`: `..` segments → rejected outright; absolute paths are confined inside the vault; reserved characters stripped. There is no code path that writes outside `OBSIDIAN_VAULT_PATH` (plus `data/` for its own state).
- `note_update … replace` saves a backup of the original to `data/backups/<date>/<note>.md`.
- Note *creates* never clobber: if the file exists, the content is appended as a timestamped `## Update` section.

## API keys

- Keys live in `.env` (gitignored) and `data/token.json` (gitignored). Never commit them.
- Google scopes are the minimum that work: `calendar.readonly`, `gmail.readonly`, `gmail.send` (the last one only matters if you enable sending).
- The Anthropic key is only used by `src/lib/llm.js`.

## What the AI sees

Calendar events (48 h), unread email **subjects + snippets** (max 10), a compact vault **summary** (TODO lines, first lines of recent notes, memory file), system info. Full mailbox/attachment/vault-file access is never sent to the API.

## What the AI controls

Its JSON response is schema-validated; unknown action types are skipped and logged. Every executed action (and every failure) is appended to `<vault>/Agent_Logs/YYYY-MM-DD.md` — a complete audit trail. `npm run status` shows everything pending.

## Blast-radius reduction

- Brain failures never kill the daemon; after 3 consecutive failures Hive notifies you and keeps retrying every 5 minutes.
- Reminder de-dup keys persist across restarts, so a crash-looping agent can't spam notifications.
- `MAX_CONTEXT_CHARS` caps how much of your vault goes into any single API call.

## If you ever want it fully offline

Leave `ANTHROPIC_API_KEY` empty. The deterministic layer (calendar reminders, alarms, scheduled jobs) keeps working; the mock brain exercises the same pipeline safely.

## Dependency audit — 2026-09-14 (documented decision)

`npm audit` after the file-support build showed findings. What we did about
each, and why:

**FIXED — pdfjs-dist (PDF parser, GHSA-wgrm-67xf-hhpq, "arbitrary JavaScript
execution upon opening a malicious PDF").** This one was treated as real:
Hive parses user-uploaded PDFs. Upgraded 3.11.174 → **4.8.69, pinned exact**
(newest patched release that still supports Node 18; 4.9+ requires Node 20;
pinning prevents silent drift onto a Node-20-only release). All extraction
tests and a live upload→chat smoke pass on 4.8.69.

**ACCEPTED — uuid (GHSA-w5hq-g745-h8pq, "missing buffer bounds check in
v3/v5/v6 when buf is provided", moderate)** and its googleapis / gaxios /
node-notifier chains. The vulnerable API is only reachable when a caller
hands uuid a manually-managed buffer for v3/v5/v6 parsing. In this stack
those libraries only *generate* v4 IDs; nothing parses attacker-controlled
buffers, and Hive is a local personal tool — no untrusted input reaches the
code path. `npm audit fix --force` is deliberately NOT used: the only fix it
offers downgrades node-notifier to 6.0.0 (2019), breaking macOS
notifications. Revisit this decision if uuid usage ever changes or a
network-facing path starts feeding uuid.

The `tar`/`canvas`/`node-pre-gyp` findings some platforms show come from
pdfjs-dist's *optional* `canvas` module (pixel rendering — Hive only
extracts text). They are install-time-only toolchain warnings and disappear
with the 4.8.69 resolution; they never affect runtime.

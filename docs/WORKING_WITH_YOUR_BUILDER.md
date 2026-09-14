# 🔧 Working With Your Build Agent

You (on your Mac) + your build agent (in its workspace) are a two-machine team. There is no live wire between them — the bridge is this chat plus one command each way. Here's the fastest loop:

## The Bug-Fix Loop (when something breaks or misbehaves)

**Your side (1 command):**
```bash
npm run doctor
```
This bundles *everything* needed to diagnose the system remotely into one report — environment, vault health, knowledge index, every agent's last cycle, dispatcher self-test, the last 7 days of errors, daemon log tail. **Your API key is never included** (masked preview only, plus an automatic redaction pass). It prints to the terminal and saves to `data/doctor-<timestamp>.md`.

Paste the terminal output (or upload the saved file) into the chat.

**Agent's side:** diagnoses the problem, patches the code in the master copy, and hands you an updated `hive.zip` (or a single changed file).

**Your side (apply the fix):**
```bash
# unzip the new hive.zip OVER your existing folder — it's safe:
unzip -o ~/Downloads/hive.zip -d ~/Downloads/
```
Your `.env`, `data/` (state, memory store, calendar), and `node_modules` are **never touched** — the zip deliberately excludes them. Then re-run whatever failed.

## The Quality-Tuning Loop (when output is meh, not broken)

Claude's work — daily briefs, mentalist analyses, email drafts — is steered by prompts in the master copy (`src/prompt.js`, `modules/mentalist/index.js`, etc.). When you don't like an output:

1. Paste the output + one line on what's wrong ("too vague", "wrong tone", "stop asking me this every morning")
2. The agent tunes the prompts
3. Apply the update the same way (unzip over)

This is how the system learns your preferences at the code level — it gets sharper with every round.

## Self-Healing (fix it before shipping the problem)

Many problems don't need the round trip:
```bash
npm run doctor -- --fix
```
auto-repairs: missing vault folders, stale/missing knowledge index, missing ledgers. And the runtime already self-recovers: malformed AI responses get one automatic repair retry, a corrupted `agents.json` falls back to defaults, failed cycles retry in 5 minutes, missed scheduled jobs catch up on wake.

## What NOT to share

- Your full API key (`npm run doctor` already redacts it — keep it that way)
- Anything from your vault you'd rather not send. The doctor report contains system health, not note contents (only file counts/timestamps + error lines the system itself logged).

## Optional: a live status bridge (advanced, later)

If you ever want the agent to *check on* your Hive on demand (rather than you pasting), a small read-only status endpoint + a tunnel (Tailscale/ngrok) can do it — the agent could then `curl` your Hive's status when you ask. It's feasible but exposes a door to your Mac; only build it if you want it, with a token and read-only routes.

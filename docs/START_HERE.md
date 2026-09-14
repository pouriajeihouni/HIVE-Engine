# 🚀 START HERE — Making Hive Operational on Your MacBook Air M2

Every step below was validated on a fresh copy of `hive.zip`. Each step shows **what to type** and **what you should see**. Nothing needs an API key until Step 8 — everything before that is safe and free.

---

## Step 0 — Get Hive onto your Mac

1. Download **`hive.zip`** from the workspace
2. Double-click to unzip it (or: `unzip hive.zip`)
3. Open **Terminal** and go to the folder:
   ```bash
   cd ~/Downloads/hive        # adjust if you unzipped elsewhere
   ```
4. Check Node (need 18+):
   ```bash
   node --version
   ```
   Missing or under 18? Install the **LTS** from https://nodejs.org (or `brew install node`).

## Step 1 — Install dependencies (one time, ~10 seconds)

```bash
npm install
```
✅ You should see: `added 75 packages` with no `ERR` lines.

## Step 2 — Health check

```bash
npm run check
```
On a fresh copy you'll see warnings — **all expected at this stage**:
```
⚠️  no .env …
❌ vault not found — OBSIDIAN_VAULT_PATH not set — or run: npm run seed-demo
⚠️  no ANTHROPIC_API_KEY …
✅ agent registry (3 enabled of 5) — hive, mentalist, observer
✅ observer memory store — 0 observation(s)
```
These disappear as you go live. This is also your "something's wrong" tool later.

## Step 3 — Run the test suite + integration checklist

```bash
npm test
npm run verify
```
✅ You should see: `# pass 58  # fail 0` then `🐝 ALL CHECKS PASS — 6 passed, 0 failed`.

`npm run verify` runs your build checklist for real: legacy-name scrub, observer → memory store, knowledge index + retrieval, dispatcher routing, unified facade.

## Step 4 — Create the demo world (safe sandbox)

```bash
npm run seed-demo
```
Creates `demo-vault/` (a mini vault modelled on your life), a sample calendar with events **starting ~25 minutes from now** (so reminders actually fire), a mock inbox, and `.env` pointing at the demo vault. **Your real vault is never touched.**

## Step 5 — First full cycle

```bash
node src/index.js --once
```
✅ You should see the Hive banner, then:
- **Hive (chief)**: daily brief + `Daily/<today>.md` created
- **Mentalist**: reads your notes → ❓ precision questions, ledgers written to `Hive/mentalist/`
- **Observer**: pattern sweep summary

## Step 6 — Explore in Obsidian

Open Obsidian → **Open folder as vault** → choose `hive/demo-vault`. Look at:
- `Daily/…` — the plan Hive wrote
- `Hive/mentalist/` — contradictions, patterns, evolution, precision questions
- `Hive/memories/` — where your captured observations will live
- `Agent_Logs/…` — every action by every module, timestamped

## Step 7 — Talk to it (still offline, free)

The dispatcher picks the module from your intent:

```bash
npm run say -- "remind me to email Prof Adamopoulos about the ECON 2450 deadline"  # → executor
npm run say -- "find my notes about the pricing and quoting system"               # → knowledge
npm run say -- "why do I keep falling behind on problem sets?"                    # → mentalist
npm run say -- "observe: just talked to Sam — he said \"send it by Friday\""      # → observer
```

Or hit modules directly:

```bash
npm run search -- "pricing system"             # semantic search (builds the vector index)
npm run observe -- "any detail worth keeping"  # capture a memory (with precision questions if thin)
npm run ask -- mentalist "analyze my patterns"
npm run agents                                 # the team: hive · mentalist · observer · startup · econ
npm run status                                 # agents, memory store, knowledge index, timers
```

✅ Each `say` reply starts with `🐝 Hive (module/intent):` — one voice, four modules behind it.

---

# 🟢 GOING LIVE (Step 8–11) — real intelligence, real vault, 24/7

## Step 8 — Connect the real brain

Two engines are supported. **Groq is the default — its free tier covers Hive's entire workload** (no credit card, ~1,000 requests/day free; Hive uses ~50–150).

**Option A — Groq (recommended, $0):**
1. **API key**: [console.groq.com/keys](https://console.groq.com/keys) → Create API Key → copy it (starts with `gsk_`).
2. Add to `.env`:
   ```
   LLM_PROVIDER=groq
   GROQ_API_KEY=gsk_...your key...
   ```
   That's it. The default model (`llama-3.3-70b-versatile`) is already set for you.

**Option B — Anthropic Claude (smarter per token, pay-per-use):**
1. **API key**: [console.anthropic.com](https://console.anthropic.com) → Settings → API keys → Create. (Add a payment method / credit if you haven't — see cost note below.)
2. Add to `.env`:
   ```
   LLM_PROVIDER=anthropic
   ANTHROPIC_API_KEY=sk-ant-...your key...
   ```

**Either way**, also set in `.env`:
```
OBSIDIAN_VAULT_PATH=/Users/pouria/Documents/YourVault
```
**Finding your vault path:** in Obsidian, click your vault name (bottom-left) → **Reveal in Finder** → drag the folder from Finder into Terminal — the path pastes itself.

3. **Test with one cycle**:
   ```bash
   node src/index.js --once
   ```
   - **macOS will pop: "node wants to access information from Calendar" → click Allow.** That's your Apple Calendar — since it's synced with Google, you get all your events with zero setup.
   - First run in Terminal also triggers a **notification permission** prompt for your terminal app → Allow.
4. **Confirm it's real**: the banner's Brain line should say `Groq · llama-3.3-70b-versatile` (or `Claude (per-agent models)`), and the daily brief should mention *your actual* events and notes.

💡 **Cost sanity check**: Groq free tier → **$0** (if you ever hit rate limits, `GROQ_MODEL=meta-llama/llama-4-scout-17b-16e-instruct` has bigger token budgets). Claude Sonnet at hourly chief cycles ≈ **$0.30–0.80/day**. You can switch engines any time by editing one line in `.env` — both stay installed.

## Step 9 — Feed it your data

The vault folders are pre-scaffolded (`School/`, `Work/TPH/`, `Personal/`, `Hive/memories/`…). Just start dropping your real notes in — imperfect organization is fine:
- The **knowledge module** indexes everything automatically (search works within one cycle)
- The **Mentalist** starts connecting details across notes
- The **Observer** builds person/topic files as you capture interactions
- Course/semester changes → edit `src/profile.js` (one file, clearly commented)

The more notes land, the smarter every module gets — that's the whole design.

## Step 10 — Turn on the rest of the team

```bash
npm run agents -- enable startup                      # your agent-startup co-pilot (Personal/Ideas)
npm run agents -- enable econ                         # coursework tracker (School)
npm run agents -- model mentalist claude-opus-4-6     # strongest model for analysis
npm run agents -- interval observer 180               # pattern sweeps every 3h instead of 6h
npm run agents                                        # review the team
```
Every agent can have its **own model and interval** — cheap fast models for frequent loops, strong models for deep work.

## Step 11 — Run 24/7 (starts at login, auto-restarts)

```bash
bash scripts/install-macos.sh
```
That's it. Hive now starts whenever you log in and restarts if it ever crashes.

- **First time only**: also run `npm start` once in Terminal and grant the notification prompt, so background notifications are permitted.
- **Logs**: `tail -f data/hive.log` (and `data/hive.err.log`), plus `<vault>/Agent_Logs/` in Obsidian.
- **Stop / start**:
  ```bash
  launchctl unload ~/Library/LaunchAgents/com.hive.agent.plist
  launchctl load   ~/Library/LaunchAgents/com.hive.agent.plist
  ```
- **Uninstall**: `launchctl unload … && rm ~/Library/LaunchAgents/com.hive.agent.plist`

**Sleep behavior**: when the MacBook wakes, missed jobs (morning brief, check-ins, weekly plan) catch up automatically — once per occurrence, never spammed. On battery, macOS may delay background work; if you want reminders while the lid's closed on AC: System Settings → Battery → Options → *Prevent automatic sleeping on power adapter*.

---

## Daily life with Hive (once operational)

| Moment | What happens |
|---|---|
| 07:00 (or on wake) | ☀️ daily brief + `Daily/<date>.md` plan |
| 6× per day (07:00–21:00) | 🕵️ Observer check-in prompt ("what did you notice?") — capture with `npm run observe -- "…"` |
| Before events | 🔔 reminders (class 30 min · deadlines 24 h + 2 h · TPH shifts 60 min · gym/personal 20 min) |
| Whenever you want | `npm run say -- "…"` — routed to the right module |
| Every 6 h | 🔍 Mentalist sweep → new contradictions, patterns, precision questions in `Hive/mentalist/` |
| Monday 08:00 | weekly plan · Friday 16:00 weekly summary · Friday 09:00 TPH H&S nudge |
| Email drafted | always waits in `npm run approve` — Hive never sends by itself |

## Troubleshooting

| Symptom | Fix |
|---|---|
| No calendar events | System Settings → Privacy & Security → Calendars → allow `node`/Terminal. (`CALENDAR_SOURCE=apple|google|auto|local` in `.env` if you want to force a source) |
| No notifications | System Settings → Notifications → allow your terminal app. Everything is also written to `<vault>/Hive/Notifications.md` |
| Search finds nothing | `npm run search -- "anything"` — builds/refreshes the index |
| `Model not found` | `npm run agents -- model <id> default` |
| Costs too high | `npm run agents -- interval hive 120` etc. — deterministic features are unaffected |
| Anything else | `npm run check` → `npm run verify` → `docs/` (SECURITY, CUSTOMIZING, GOOGLE_SETUP, RUN_AS_SERVICE) |

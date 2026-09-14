# Stage 3 — Deploy the cloud engine on Render (free)

**Outcome:** Hive runs 24/7 on Render's free tier. Your laptop can be closed.
The dashboard is served BY the engine — instant chat, file uploads, nothing
public. ~$0/month.

**Before you start:** update your Mac first (`unzip -o` the latest hive.zip,
`npm install`, reload the LaunchAgent) — this walkthrough uses
`scripts/setup-render-repo.sh`, which only exists in recent builds.

## What you need

- ~30 minutes
- The GitHub CLI logged in on your Mac (`gh auth status` says ok)
- Your `GROQ_API_KEY` value (it's in `~/hive/.env` on your Mac)

## 1. Push the engine source to a private repo (2 min, on your Mac)

```bash
bash scripts/setup-render-repo.sh
```

This git-inits `~/hive`, verifies **no secrets are included** (`.env`,
`data/`, `web-publish/`, `node_modules/` are excluded — the script refuses to
push if any of them somehow get staged), creates a **private** GitHub repo,
and pushes.

## 2. Create the service on render.com (~10 min, browser)

1. **render.com → Get Started** → sign up **with GitHub** (approve the
   connection when GitHub asks)
2. Dashboard → **New + → Web Service**
3. Select the `hive-engine-…` repo (private is fine — Render reads it via
   the GitHub connection) → **Connect**
4. Settings:
   - **Name:** `hive` (any name — it becomes part of your URL)
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `node src/index.js`
   - **Instance type:** **Free**
5. Before deploying, open **Environment** and add variables:

   | key | value |
   |---|---|
   | `WEB_AUTH_KEY` | a long random key — generate on your Mac: `openssl rand -hex 16` — this is your dashboard login |
   | `GROQ_API_KEY` | your Groq key (copy the value from `~/hive/.env` on your Mac) |

   Optional: `ANTHROPIC_API_KEY` (second brain), `AGENT_NAME`, `USER_NAME`.
   Telegram vars come later (Stage 4 handover — see below).
6. **Deploy Web Service**

The engine auto-detects Render (it sets `PORT`) and serves the dashboard +
API on it. Watch the logs for:

```
🐝 HIVE — unified intelligence layer
🌐 Cloud engine: serving the dashboard + API on port 30000
```

Render's health check pings `/api/health` — no auth needed, always green
when the daemon is up.

## 3. First login (1 min, any device)

Open the URL Render gives you (`https://hive-xxxx.onrender.com`). The
dashboard loads, asks once for your **access key** (the `WEB_AUTH_KEY`
value — it's saved on the device after that), and you're in **cloud mode**:
live data, instant chat, 📎 file uploads that actually work from your phone.

Test, in order: send `hey` in Chat (reply in seconds, not minutes) → attach
any PDF and ask a question about it → System tab → Run Doctor.

## 4. Keep-awake (5 min, optional but recommended)

Render's free tier sleeps the service after ~15 min without traffic.
Sleeping is **safe** (the scheduler catches up missed jobs on wake), but it
means: first chat after a sleep takes ~30–60 s (cold start), and a brief
scheduled while asleep fires late. To keep it awake:

1. Create a free account at **cron-job.org** (or UptimeRobot)
2. Add a job: URL `https://hive-xxxx.onrender.com/api/health`, every **10
   minutes**
3. Done — the ping keeps the instance warm

## What to expect during the parallel run

Your Mac agent and the cloud engine now run side by side (by design — the
old setup keeps working until the new one earns trust):

- **Mac:** keeps doing everything it did — briefs, reminders, Telegram (if
  configured), dashboard publishing. Nothing changes until you decide.
- **Cloud:** 24/7, instant chat, file uploads. Its local memory starts
  empty (fresh conversation) and **resets on every deploy/restart** — that's
  the free tier's ephemeral disk. The durable brain stays on your Mac until
  Stage 4 (vault via git) moves it.
- **Don't put the Telegram vars on Render while the Mac has them** — two
  processes polling the same bot conflicts. Keep Telegram on the Mac for
  now; when you're ready to hand over, remove `TELEGRAM_BOT_TOKEN` /
  `TELEGRAM_CHAT_ID` from the Mac's `.env` (and reload) BEFORE adding them
  on Render.
- Expect **double agent activity** (both instances run their cycles) — token
  spend stays well inside the free budget (~2× of ~170K/day against ~800K).

## Handover checklist (when you trust the cloud — Stage 4)

1. Vault synced to a private repo, engine reads/writes it there
2. Telegram vars moved Mac → Render
3. Mac LaunchAgent unloaded for a few days' trial
4. If nothing misses: the Mac becomes just another door (browser/CLI)

## Troubleshooting

- **"Open API would let anyone control Hive"** in the logs → `WEB_AUTH_KEY`
  isn't set in Render's Environment. Set it, deploy again.
- **Build fails at `npm install`** → check the Node version (Render's
  default is fine; the app needs Node 18+).
- **Service sleeps anyway** → verify the cron job actually runs
  (cron-job.org shows each hit).
- **Chat replies are mock-brained** → `GROQ_API_KEY` missing/invalid on
  Render (the reply will say so; System tab shows the provider).
- **Updates:** apply a new hive.zip on the Mac, then
  `cd ~/hive && git add -A && git commit -m update && git push` — Render
  redeploys automatically.

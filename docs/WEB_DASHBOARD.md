# 🐝 Hive Web Dashboard — your second brain in your pocket

Your Mac does the thinking; this puts the **output on a website you can open from
anywhere** — phone, laptop, a friend's computer. Free forever on GitHub Pages.

```
┌───────────────────┐  git push   ┌──────────────────┐   serves    ┌─────────────────────┐
│  Mac (the engine) │ ──────────► │  GitHub repo     │ ──────────► │  pouria.github.io/  │
│  daemon + vault   │  every ~5m  │  /docs/data.json │             │  your dashboard     │
└───────────────────┘             └──────────────────┘             └─────────────────────┘
```

What lands on the dashboard: today's brief · upcoming events · armed reminders ·
the mentalist's precision questions · recent observations · recent conversation ·
agent health. It auto-refreshes every 60 s and tells you when the engine was last
heard from (so you can tell "asleep Mac" from "offline").

---

## Part 1 — GitHub account (skip if you have one)

1. Go to **github.com** → Sign up (free plan).
2. Verify your email.

> **Cloud alternative:** the daemon can now serve this same dashboard itself
> with instant chat and nothing public — see **`docs/CLOUD_ENGINE.md`** (Phase
> 5B). The GitHub Pages + relay flow below remains the Mac-powered mode.

## Part 2 — create the repo (2 minutes)

> **Have GitHub CLI (`gh`) installed and logged in?** Skip Parts 2 and 4 —
> run the script in Part 3 and just press **Enter** when it offers to create
> the repo. It creates the repo, pushes with your `gh` login (nothing to
> type), seeds your Keychain so the daemon can push too, and turns on
> GitHub Pages automatically. The fine-grained token walkthrough below only
> applies to the no-`gh` flow (and to `WEB_RELAY_TOKEN` in the relay setup).

1. Go to **github.com/new** (you must be logged in).
2. **Repository name:** something random, e.g. `hive-k7m2qx`
   (type a few letters/numbers — the randomness is deliberate, see
   [Privacy](#privacy) below).
3. Leave it **Public** — required for free GitHub Pages.
4. **Do not** tick "Add a README". Click **Create repository**.
5. Copy the URL it shows: `https://github.com/YOURNAME/hive-xxxxxx.git`

## Part 3 — run the setup script (3 minutes)

In Terminal, inside your hive folder:

```bash
cd ~/hive
bash scripts/setup-web.sh
```

It will ask you to paste the repo URL, then:

- clones it into `~/hive/web-publish/`
- installs the dashboard page and pushes it — **this first push is where you
  enter your GitHub credentials**:
  - **Username:** your GitHub username
  - **Password:** NOT your GitHub password — a **Personal Access Token** (below)
- macOS saves both into **Keychain**; you will never be asked again.

**Creating the token (one time):**
1. github.com → click your avatar (top-right) → **Settings**
2. Left sidebar, all the way down: **Developer settings**
3. **Personal access tokens → Fine-grained tokens → Generate new token**
4. Name: `hive` · Expiration: 90 days or custom
5. **Repository access → Only select repositories →** pick your `hive-…` repo
6. **Permissions → Repository permissions → Contents → Read and write**
7. Generate → copy the token (starts with `github_pat_`) → paste into Terminal
   when asked. Treat it like a password.

## Part 4 — turn on the website (2 clicks)

1. Open **github.com/YOURNAME/hive-xxxxxx/settings/pages**
2. Under *Build and deployment* → Branch: **main** · folder: **/docs** → **Save**

Wait ~1 minute, then visit:

```
https://YOURNAME.github.io/hive-xxxxxx/
```

You'll see the dashboard in **sample-data mode** (amber banner) — that's
intentional: no real data has been published yet.

## Part 5 — publish real data

```bash
cd ~/hive
npm run web
```

Refresh the site — your **actual** brief, events, reminders, and questions
appear. From now on the daemon republishes automatically whenever content
changes (at most every 5 minutes — `WEB_PUBLISH_MINUTES` in `.env` to tune).

**On your phone:** open the site in Safari → Share → **Add to Home Screen**.
Hive becomes an app icon.

---

## Privacy ⚠

A public GitHub Pages URL is **viewable by anyone who has it**. That's why the
repo name is random — guessing `hive-k7m2qx` is effectively impossible, and
nothing links your name to it. The data shown is the same class of information
as your Obsidian vault: schedule, tasks, analyses. **No** API keys, emails
bodies, or `.env` contents are ever published — the publisher only exports the
dashboard fields listed at the top.

If you ever want a password on it (still free): put the site behind Cloudflare
Pages + Access (free for 50 users) — ask your builder when you're ready.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `publish failed … could not read Username` | Credentials not in Keychain yet → `git -C ~/hive/web-publish push` manually once, then `npm run web` |
| Site 404s | Settings → Pages: branch **main**, folder **/docs**, saved; wait 1–2 min; URL matches `username.github.io/REPO/` exactly |
| Site shows old data | GitHub Pages caches briefly — pull-to-refresh; also check `updated` time in the dashboard header |
| Dashboard says "engine offline" | Mac asleep or daemon stopped → check `tail -f ~/hive/data/hive.log` |
| `npm run web` says `skipped (unchanged)` | Nothing new happened — working as designed |

## How updates work

The dashboard page itself is part of Hive. When you update Hive
(`unzip -o hive.zip -d ~`), the next publish automatically syncs the newest
`web/dashboard.html` into your repo. Nothing extra to do.

## The road to Phase 5B (engine in the cloud)

This dashboard is the front-end of the future cloud version too. When you're
ready to stop depending on the Mac being awake: the engine moves to a small
server (Google Calendar already supported), the vault becomes a git repo, and
this same dashboard points at the live engine. Ask your builder when ready.

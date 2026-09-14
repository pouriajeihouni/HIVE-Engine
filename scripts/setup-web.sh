#!/usr/bin/env bash
#
# HIVE — web dashboard setup (GitHub Pages)
# Walkthrough: docs/WEB_DASHBOARD.md
#
# What this does:
#   0. GitHub CLI fast-path: if `gh` is installed and logged in, everything
#      is automatic — repo created for you, push uses your gh login (no
#      passwords to type, ever), Pages enabled via the API. No browser.
#      Without gh, the manual flow below works exactly as before.
#   1. sanity checks (git, .env)
#   2. clones your GitHub repo → web-publish/ inside the hive folder
#   3. installs the dashboard page (docs/index.html) and pushes it
#      (no gh? this first push is where macOS stores your GitHub
#       credentials in Keychain — one time, username + token)
#   4. writes WEB_PUBLISH_DIR into .env
#   5. enables GitHub Pages (automatic with gh, otherwise two clicks)
#   6. reminds you about the two-way relay vars if they're not set yet
#
set -euo pipefail

B="\033[1;34m"; G="\033[1;32m"; Y="\033[1;33m"; R="\033[1;31m"; D="\033[2m"; N="\033[0m"
say() { echo -e "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEBDIR="$ROOT/web-publish"
ENVF="$ROOT/.env"

say "${B}🐝 Hive — web dashboard setup${N}"

# 1 ── sanity checks ────────────────────────────────────────────────────
if ! command -v git >/dev/null 2>&1; then
  say "${R}✖ git not found.${N} Install it with:  xcode-select --install   then re-run."
  exit 1
fi
if [ ! -f "$ENVF" ]; then
  say "${R}✖ No .env found at $ENVF${N} — configure Hive first (docs/START_HERE.md)."
  exit 1
fi
say "${G}✔ git found, .env found${N}"

# 1b ── GitHub CLI fast-path (optional, everything still works without it) ─
GH_OK=0; GH_USER=""
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  GH_USER="$(gh api user --jq .login 2>/dev/null || true)"
  if [ -n "$GH_USER" ]; then
    GH_OK=1
    say "${G}✔ GitHub CLI found — logged in as ${Y}${GH_USER}${N}"
    # Lend git your gh login and save it to the macOS Keychain (the same
    # place gh itself keeps it). This is what lets the daemon push later
    # without you ever typing a password — and without needing gh running.
    GHTOK="$(gh auth token 2>/dev/null || true)"
    if [ -n "$GHTOK" ]; then
      printf 'protocol=https\nhost=github.com\nusername=%s\npassword=%s\n' \
        "$GH_USER" "$GHTOK" | git credential approve 2>/dev/null || true
      say "${G}✔ git credentials seeded from gh (stored in Keychain)${N}"
    fi
  fi
fi
if [ "$GH_OK" != "1" ]; then
  say "${D}ℹ no GitHub CLI — manual mode (works fine, a little more typing)${N}"
fi

# 2 ── repo URL ─────────────────────────────────────────────────────────
RAND="hive-$(LC_ALL=C tr -dc a-z0-9 </dev/urandom | head -c 6 || true)"   # || true: tr dies of SIGPIPE under pipefail
if [ "$GH_OK" = "1" ]; then
  say ""
  say "I can create a fresh repo for you: ${Y}${RAND}${N} (public · random name = nobody stumbles on it)"
  read -r -p "Press Enter to create it — or paste an existing repo URL: " REPO
  if [ -z "$REPO" ]; then
    if gh repo create "$RAND" --public --disable-issues >/dev/null 2>&1; then
      REPO="https://github.com/${GH_USER}/${RAND}.git"
      say "${G}✔ created ${REPO}${N}"
    else
      say "${Y}⚠ gh couldn't create the repo (token scopes?) — paste a URL instead.${N}"
      read -r -p "Repo URL (https://github.com/USERNAME/REPO.git): " REPO
    fi
  fi
else
  say ""
  say "You need an EMPTY-or-fresh GitHub repo. If you haven't created one yet:"
  say "  → github.com/new   ·   Name: ${Y}${RAND}${N}   ·   Public   ·   no README needed"
  say "  ${D}(random name = nobody stumbles on your dashboard URL; see the privacy note in docs/WEB_DASHBOARD.md)${N}"
  say ""
  read -r -p "Paste your repo URL (https://github.com/USERNAME/REPO.git): " REPO
fi
if [[ ! "$REPO" =~ ^https://github\.com/ ]]; then
  say "${R}✖ That doesn't look like a GitHub https URL.${N} Expected: https://github.com/USERNAME/REPO.git"
  exit 1
fi

# 3 ── clone (or refresh) ───────────────────────────────────────────────
if [ -d "$WEBDIR/.git" ]; then
  say "${Y}→ web-publish/ already exists — refreshing from remote…${N}"
  git -C "$WEBDIR" remote set-url origin "$REPO"
  git -C "$WEBDIR" pull --ff-only 2>/dev/null || true
else
  say "→ cloning into web-publish/ …"
  git clone "$REPO" "$WEBDIR" 2>/dev/null || {
    say "${R}✖ clone failed.${N} Check the URL (and that the repo exists)."
    exit 1
  }
fi

# commit identity for this repo only (GitHub needs *something*)
git -C "$WEBDIR" config user.name  >/dev/null 2>&1 || git -C "$WEBDIR" config user.name  "Hive"
git -C "$WEBDIR" config user.email >/dev/null 2>&1 || git -C "$WEBDIR" config user.email "hive@localhost"

# 4 ── install dashboard + first push ───────────────────────────────────
mkdir -p "$WEBDIR/docs"
cp "$ROOT/web/dashboard.html" "$WEBDIR/docs/index.html"
# placeholder data so the site never 404s before the first real publish
if [ ! -f "$WEBDIR/docs/data.json" ]; then
  printf '{"schema":1,"generated_at":"%s","_sample":true,"agents":[],"events":[],"reminders":[],"conversation":[],"observer":{"recent":[],"stats":{"total":0}},"mentalist":{"questions_md":null,"analysis_md":null},"today":{"brief_md":null}}' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$WEBDIR/docs/data.json"
fi

git -C "$WEBDIR" add -A
if git -C "$WEBDIR" diff --cached --quiet 2>/dev/null; then
  say "${G}✔ dashboard already up to date in the repo${N}"
else
  git -C "$WEBDIR" commit -q -m "hive: dashboard installed"
  if [ "$GH_OK" = "1" ]; then
    say "→ pushing (using your gh login — nothing to type)"
  else
    say "→ pushing (first time: macOS may ask for your GitHub username + a Personal Access Token)"
    say "  ${D}token = github.com → Settings → Developer settings → Personal access tokens → Fine-grained${N}"
    say "  ${D}scope: only this repo · Contents: Read and write · it gets saved to Keychain, you won't be asked again${N}"
  fi
  if ! git -C "$WEBDIR" push 2>/dev/null; then
    git -C "$WEBDIR" push || true   # second attempt keeps the interactive prompt visible on failure
    say ""
    say "${Y}⚠ push didn't complete.${N} Run:  git -C web-publish push   · enter username + token · then re-run this script."
    exit 1
  fi
  say "${G}✔ pushed${N}"
fi

# 5 ── config ───────────────────────────────────────────────────────────
if grep -q "^WEB_PUBLISH_DIR=" "$ENVF" 2>/dev/null; then
  say "${G}✔ WEB_PUBLISH_DIR already set${N}"
else
  printf '\n# Web dashboard (docs/WEB_DASHBOARD.md)\nWEB_PUBLISH_DIR=%s\n' "$WEBDIR" >> "$ENVF"
  say "${G}✔ WEB_PUBLISH_DIR added to .env${N}"
fi

# 6 ── enable Pages (automatic with gh) ─────────────────────────────────
USER_REPO="${REPO#https://github.com/}"     # USERNAME/REPO.git
USER_REPO="${USER_REPO%.git}"
BRANCH="$(git -C "$WEBDIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
PAGES=0
if [ "$GH_OK" = "1" ]; then
  printf '{"source":{"branch":"%s","path":"/docs"}}' "$BRANCH" \
    | gh api --method POST "repos/${USER_REPO}/pages" \
        -H 'Content-Type: application/json' --input - >/dev/null 2>&1 && PAGES=1
  if [ "$PAGES" != "1" ] && gh api "repos/${USER_REPO}/pages" >/dev/null 2>&1; then
    PAGES=2   # already enabled (e.g. re-run)
  fi
fi
say ""
if [ "$PAGES" = "1" ]; then
  say "${G}✔ GitHub Pages enabled (${BRANCH} · /docs)${N}"
elif [ "$PAGES" = "2" ]; then
  say "${G}✔ GitHub Pages already enabled${N}"
else
  say "${B}Two clicks left — on github.com:${N}"
  say "  1. Open  ${Y}https://github.com/${USER_REPO}/settings/pages${N}"
  say "  2. Under “Build and deployment” → Branch: ${Y}${BRANCH}${N} · folder: ${Y}/docs${N} → Save"
fi
say ""
say "Your dashboard (live ~1 min after Pages is on):"
say "  ${G}https://${USER_REPO%%/*}.github.io/${USER_REPO#*/}/${N}"

# 7 ── relay reminder (chat from your phone) ────────────────────────────
if ! grep -q "^WEB_RELAY_PIN=" "$ENVF" 2>/dev/null; then
  say ""
  say "${B}One last thing — to chat with Hive from the dashboard, add to .env:${N}"
  say "  ${Y}WEB_RELAY_PIN=<your passcode>${N}"
  say "  ${Y}WEB_RELAY_TOKEN=<fine-grained token · this repo only · Contents: Read and write>${N}"
  say "  ${D}gh can't create this one for you — github.com → Settings → Developer settings →${N}"
  say "  ${D}Personal access tokens → Fine-grained tokens → Generate. Then reload the agent.${N}"
  say "  ${D}Full guide: docs/WEB_DASHBOARD.md → “Two-way relay”${N}"
fi
say ""
say "Then publish real data:   ${B}cd $ROOT && npm run web${N}"
say "After that the daemon keeps it fresh automatically (every ~5 min when things change)."

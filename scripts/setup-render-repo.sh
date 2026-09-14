#!/usr/bin/env bash
#
# HIVE — prepare the private engine repo for Render (Stage 3).
# Walkthrough: docs/RENDER_DEPLOY.md
#
# What this does:
#   1. checks gh is installed + logged in
#   2. git-inits ~/hive (if needed) and commits the source — secrets are
#      double-checked to be EXCLUDED (.env*, data/, web-publish/, node_modules/)
#   3. creates a PRIVATE GitHub repo (hive-engine-<random>) and pushes
#   4. prints the exact clicks left on render.com
#
set -euo pipefail

B="\033[1;34m"; G="\033[1;32m"; Y="\033[1;33m"; R="\033[1;31m"; D="\033[2m"; N="\033[0m"
say() { echo -e "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

say "${B}🐝 Hive — Render engine repo setup${N}"

# 1 ── gh check ────────────────────────────────────────────────────────
if ! command -v gh >/dev/null 2>&1 || ! gh auth status >/dev/null 2>&1; then
  say "${R}✖ GitHub CLI needed but not logged in.${N} Run:  gh auth login   then re-run this script."
  exit 1
fi
GH_USER="$(gh api user --jq .login 2>/dev/null || true)"
[ -n "$GH_USER" ] || { say "${R}✖ couldn't read your GitHub user (gh api user).${N}"; exit 1; }
say "${G}✔ GitHub CLI — logged in as ${Y}${GH_USER}${N}"

# 2 ── git init + commit (secrets excluded by .gitignore, verified below) ──
if [ ! -d "$ROOT/.git" ]; then
  git -C "$ROOT" init -q
  say "✔ git repository initialized"
fi
git -C "$ROOT" config user.name  >/dev/null 2>&1 || git -C "$ROOT" config user.name  "Hive"
git -C "$ROOT" config user.email >/dev/null 2>&1 || git -C "$ROOT" config user.email "hive@localhost"

git -C "$ROOT" add -A

# safety net: nothing secret may ever be staged, even if .gitignore drifts
# (.env.example is documentation and legitimately ships)
BAD="$(git -C "$ROOT" diff --cached --name-only | grep -E '(^|/)\.env($|\.)|^data/|^web-publish/|^node_modules/|(^|/)demo-vault/' | grep -v '^\.env\.example$' || true)"
if [ -n "$BAD" ]; then
  say "${R}✖ REFUSING TO PUSH — these files look private but got staged:${N}"
  say "$BAD"
  say "Check .gitignore, then re-run."
  exit 1
fi
say "${G}✔ staged $(git -C "$ROOT" diff --cached --name-only | wc -l | tr -d ' ') files — no secrets included${N}"

if git -C "$ROOT" diff --cached --quiet 2>/dev/null && [ "$(git -C "$ROOT" rev-list --count HEAD 2>/dev/null || echo 0)" != "0" ]; then
  say "${G}✔ nothing new to commit${N}"
else
  git -C "$ROOT" commit -q -m "hive: engine source for Render deploy"
  say "✔ committed"
fi

# 3 ── private repo + push ─────────────────────────────────────────────
RAND="engine-$(LC_ALL=C tr -dc a-z0-9 </dev/urandom | head -c 6 || true)"   # || true: tr dies of SIGPIPE under pipefail
if git -C "$ROOT" remote get-url origin >/dev/null 2>&1; then
  REPO="$(git -C "$ROOT" remote get-url origin)"
  say "${Y}→ origin already exists (${REPO}) — pushing to it${N}"
  git -C "$ROOT" push -q origin HEAD
else
  say "Creating a private repo: ${Y}hive-${RAND}${N} …"
  if ! gh repo create "hive-${RAND}" --private --source "$ROOT" --remote origin --push >/dev/null 2>&1; then
    say "${R}✖ repo creation failed.${N} Create one manually at github.com/new (PRIVATE, no README), then:"
    say "   git -C $ROOT remote add origin https://github.com/${GH_USER}/YOUR-REPO.git && git -C $ROOT push -u origin HEAD"
    exit 1
  fi
  REPO="https://github.com/${GH_USER}/hive-${RAND}.git"
fi
say "${G}✔ pushed to ${REPO} (private)${N}"

# 4 ── what's left (on render.com) ─────────────────────────────────────
say ""
say "${B}Now the cloud part — on render.com (~10 minutes, docs/RENDER_DEPLOY.md):${N}"
say "  1. Sign up with GitHub → New + → Web Service → connect ${Y}$(basename "$REPO" .git)${N}"
say "  2. Runtime Node · Build: ${Y}npm install${N} · Start: ${Y}node src/index.js${N} · Instance: ${Y}Free${N}"
say "  3. Environment → add ${Y}WEB_AUTH_KEY${N} (generate yours:  openssl rand -hex 16)"
say "     and ${Y}GROQ_API_KEY${N} (copy the value from your Mac's ~/hive/.env)"
say "  4. Deploy → open the URL → log in with your WEB_AUTH_KEY"
say ""
say "Future updates from your Mac:"
say "  cd ~/hive && git add -A && git commit -m update && git push"
say "  (Render redeploys automatically on push)"

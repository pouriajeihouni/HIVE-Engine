# 🛡️ Backup & Restore — Hive's safety net

Hive writes to your real vault every day, so it takes its own safety seriously.
Every night at **23:30** (configurable), a deterministic maintenance job runs —
no AI, no cost, nothing to configure. `docs/` you are reading now explains what
it does and how to recover if anything ever goes wrong.

## What the nightly job does

| Step | What | Where |
|---|---|---|
| Backup | full zip of your vault | `~/Documents/HIVE-Backups/vault-YYYYMMDD-HHMM.zip` (newest 30 kept) |
| Config copy | your `.env` (API keys, paths) | `~/Documents/HIVE-Backups/env.backup` (private, mode 600) |
| Log hygiene | rotates `data/hive.log` over 5 MB · deletes `Agent_Logs` older than 90 days · trims `Hive/Notifications.md` to the last 400 lines | in place |
| State snapshot | `state.json` + `agents.json` copied into the vault | `Hive/system/` (rides along with backups) |
| Heartbeat | one status note — backup result, agent health, problems | `Hive/system/heartbeat.md` |

You only hear about it when something is wrong (a macOS notification). Silence = healthy.

Settings (in `.env`): `BACKUP_TIME=23:30` · `BACKUP_DIR=~/Documents/HIVE-Backups`.

**Tip:** also keep **Obsidian's own File Recovery** on (Settings → File Recovery
→ on, default 7-day history). It catches per-file mistakes the nightly zip
might miss, minute by minute.

## Restore scenarios

### "A note got mangled / I deleted something by accident"
1. Open the newest zip in `~/Documents/HIVE-Backups/` (double-click)
2. Drag the file(s) you need back into the vault — or the whole folder if unsure.

### "My vault is gone / corrupted"
```bash
rm -rf ~/Documents/HIVE            # only if replacing wholesale
cd ~/Documents && unzip ~/Documents/HIVE-Backups/vault-<newest>.zip -d HIVE
```
You lose at most one day. Obsidian re-opens it as if nothing happened.

### "My hive app folder is gone" (the folder-shuffle classic)
```bash
# 1. reinstall the app
cd ~ && unzip ~/Downloads/hive.zip -d ~        # latest hive.zip
cd ~/hive && npm install
# 2. restore your config
cp ~/Documents/HIVE-Backups/env.backup ~/hive/.env
# 3. restore agent memory (optional — agents rebuild themselves without it)
cp ~/Documents/HIVE/Hive/system/snapshot.json ~/hive/data/state.json
cp ~/Documents/HIVE/Hive/system/registry.json ~/hive/data/agents.json
# 4. restart the service
launchctl load ~/Library/LaunchAgents/com.hive.agent.plist
```

### "Everything is gone (new Mac / wiped drive)"
You need three things, in order: **hive.zip** (the app), **env.backup** (your
keys/paths), **a vault zip** (your knowledge). If you keep copies of
`~/Documents/HIVE-Backups` somewhere else (a USB stick, iCloud — the backups
folder is small: ~30 zips), even a lost machine is a 10-minute recovery.

## What is NOT backed up automatically

- `data/token.json` (Google authorization) — re-run `npm run google-auth` if you use Gmail/Google Calendar
- The knowledge index — rebuilt automatically on first search
- Obsidian settings (`.obsidian/`) — actually IS inside the vault zip ✓

## Manual run

```bash
cd ~/hive && node -e "require('./src/lib/maintenance').runMaintenance(require('./src/config'), require('./src/lib/state').load(require('./src/config')))"
```

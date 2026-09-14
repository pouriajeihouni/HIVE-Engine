# ⚙️ Run Hive as a Background Service

So Hive is always on: starts at login, restarts if it crashes, keeps its reminders firing while you work.

## macOS — LaunchAgent (recommended)

```bash
bash scripts/install-macos.sh
```

That's it. It installs `~/Library/LaunchAgents/com.hive.agent.plist` with your paths substituted, loads it, and starts Hive now.

- Logs: `tail -f data/hive.log` and `data/hive.err.log` in the project folder (plus `<vault>/Agent_Logs/`).
- Stop/start:
  ```bash
  launchctl unload ~/Library/LaunchAgents/com.hive.agent.plist
  launchctl load   ~/Library/LaunchAgents/com.hive.agent.plist
  ```
- Uninstall: `launchctl unload … && rm ~/Library/LaunchAgents/com.hive.agent.plist`
- **Notifications:** LaunchAgents inherit notification permission from `node` — the first time, also run `npm start` once in your terminal and grant the prompt, so toasts are allowed.

## Windows — Task Scheduler

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

Registers a task **HiveAgent** that runs at logon and restarts on failure.

- Start now: `Start-ScheduledTask HiveAgent`
- Stop: `Stop-ScheduledTask HiveAgent`
- Remove: `Unregister-ScheduledTask HiveAgent`
- Toasts on Windows 10/11 come through node-notifier's PowerShell bridge; if they're silent, check Settings → Notifications for PowerShell.

## Alternative — pm2 (cross-platform)

```bash
npm install -g pm2
pm2 start src/index.js --name hive
pm2 save
pm2 startup        # follow the printed instruction for boot persistence
```

Logs: `pm2 logs hive`.

## Sleeping laptops

- **macOS:** System Settings → Battery → Options → *Prevent automatic sleeping on power adapter* if you want reminders while lid-closed on AC. Or accept catch-up: when the laptop wakes, missed jobs (morning brief, weekly plan) run immediately — that's built in.
- The agent state (`data/state.json`) makes everything idempotent across sleeps/restarts — no duplicate reminders, no lost alarms.

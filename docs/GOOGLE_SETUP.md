# 📅 Google Calendar + Gmail Setup (optional, ~10 minutes)

Hive works without Google (local `data/calendar.json` + mock inbox). Connect Google for your real calendar and unread mail.

## 1. Create the Google project

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → **Create project** → name it `hive`.
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. Same place → enable **Gmail API**.

## 2. OAuth consent screen

1. **APIs & Services → OAuth consent screen** → User type **External** → Create.
2. Fill the minimal fields (app name `Hive`, your email).
3. **Scopes**: skip (we request them in code). **Test users**: add your own Gmail address. Keep the app in *Testing* mode — that's fine for personal use, tokens last 7 days in testing mode, and Hive auto-refreshes… but see the note below.

> **Testing vs Publishing:** in *Testing* mode, refresh tokens expire after 7 days and you'd re-auth weekly. For a personal agent, you can avoid this by clicking **Publish app** (it stays unverified — only you use it, and only you see the consent warning). Publishing an app with only these read scopes is low-risk and common for personal projects.

## 3. OAuth credentials

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Application type: **Desktop app** → Create.
3. **Download JSON** → save it as `hive/credentials.json`.

## 4. Authorize Hive

```bash
npm install          # if you haven't
npm run google-auth  # opens a browser → sign in → approve
```

This stores `data/token.json` (gitignored). Re-run it any time; delete `data/token.json` first to switch accounts.

## 5. Point Hive at your calendar

In `.env`:

```
GOOGLE_CREDENTIALS=./credentials.json
GOOGLE_CALENDAR_ID=primary        # or a specific calendar's ID from its settings
```

That's it — `npm run once` will now pull your next 48 hours of real events. Event categories (class / work / deadline / study / personal → reminder timings) are auto-detected from titles; you can force one by adding `"category": "class"` to an event's description… or simply keep the local `data/calendar.json` for things Google doesn't have. Both sources can coexist: Google is primary, local is the fallback.

## Troubleshooting

- **`invalid_grant` / auth loop** — delete `data/token.json`, re-run `npm run google-auth`. If it persists, your refresh token expired (Testing mode, 7 days) — publish the app or re-auth weekly.
- **Port 37452 busy** — something else is using it; kill it or set `GOOGLE_REDIRECT_URI` in `.env` to `http://localhost:<other-port>/callback` and edit the same port in `scripts/google-auth.js`.
- **Events not showing** — check the calendar ID; `primary` = your default calendar.

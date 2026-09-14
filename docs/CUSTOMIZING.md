# 🛠 Customizing Hive

## Your life changes — edit one file

`src/profile.js` holds everything personal: courses, contacts (TPH manager's email goes here), work duties, vault layout, recurring jobs. It feeds both the AI prompt and the demo seed. Semester over? Update the course list; Hive's behavior follows.

## The system prompt

`src/prompt.js` builds the full prompt (personality + rules + response JSON schema). Tuning tips:

- **Behavior nudges** belong in `## Behavioral rules` — e.g. add *"always suggest a study block the evening before ECON 1000 deadlines"*.
- **Output discipline**: the JSON repair retry is automatic; if you see frequent repairs, strengthen the *"ONLY JSON"* instruction or lower `MAX_TOKENS`.
- Keep prompt edits concise — every cycle pays for those tokens.

## Reminder timings

`src/context/calendar.js` → `CATEGORY_RULES`. Change any bucket, e.g. classes 15 min instead of 30:

```js
const CATEGORY_RULES = { class: [15], deadline: [1440, 120], work: [60], study: [10], personal: [20] };
```

Category detection is the `guessCategory()` regex list right above it — add keywords as your life evolves (e.g. `physio`, `tutorial`, `client call`).

## Scheduled jobs

`src/scheduler.js` defines the jobs (daily brief, Monday plan, Friday summary + H&S nudge). Times come from `.env`. Add a new one:

```js
{ id: 'sunday_reset', time: '19:00', days: [0], directive: 'sunday_reset' },
```

…and handle the `sunday_reset` directive in the prompt (real brain) or `mockComplete` (mock brain).

## Vault layout

Hive writes wherever the AI decides, guided by the vault-structure section of the prompt. Restrict or extend folders there. Agent-owned folders: `Hive/` (memory, inbox, captured notes, approvals, notifications) and `Agent_Logs/` — both safe to read anytime; Hive skips them when summarizing (except memory/inbox).

## Local calendar file

`data/calendar.json` is a plain, editable calendar (used until Google is connected). Format:

```json
{ "events": [
  { "id": "gym-1", "title": "Gym — push day", "start": "2026-09-15T18:00",
    "end": "2026-09-15T19:15", "location": "Fit4Less", "category": "personal" }
] }
```

`start` accepts `YYYY-MM-DDTHH:mm` (local), ISO with timezone, or `YYYY-MM-DD` (all-day → 09:00). `category` is optional — auto-detected otherwise.

## Memory / learning

Two layers: `Hive/Memory/preferences.md` (human-readable, you can edit it, Hive reads it every cycle) and `state.memory` (facts the AI asks to remember via its actions). Wipe either to make Hive "forget".

## Extending with new actions

Add the type to the response schema in `src/prompt.js`, then a `case` in `src/actions/executor.js`. Good first candidates: `event_create` (calendar writes), `open_url`, `run_command` (⚠️ think hard before giving an LLM shell access).

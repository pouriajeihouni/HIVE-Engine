# 🐝 HIVE — Unified Personal Intelligence Layer

A local, multi-module AI system for **Pouria** — built for a MacBook Air M2. One entity (**Hive**) with four capabilities behind a router: **tasks** (executor), **knowledge** (vector-indexed vault + RAG), **patterns** (mentalist analysis), and **observations** (the Observer's detail capture). Your Obsidian vault is the collective brain — everything the Hive knows lives in it.

```
┌────────────────────────── Your MacBook (M2) ──────────────────────────┐
│                          ┌────────────────┐                           │
│  Obsidian Vault ────────▶│  core/         │   🐝 one voice: HIVE     │
│   (the collective brain) │  dispatcher.js │───▶ tasks    → executor   │
│   notes · memories ·     │  memory-store  │───▶ search  → knowledge   │
│   mentalist ledgers      └───────▲────────┘───▶ analyze → mentalist   │
│                                  │       └───▶ capture → observer     │
│  Apple Calendar (synced Google)  │  observer: background loop across  │
│  Gmail (optional)                │  ALL state transitions → memory    │
│  macOS notifications ◀───────────┘  store (indexed, persistent)       │
└───────────────────────────────────────────────────────────────────────┘
```

**Design principles** (from the HIVE specs in `docs/`)
- **The vault is the database** — no text is sent anywhere until needed; the knowledge module indexes it locally.
- **Token efficiency** — searches read indexed chunks, not whole notes; summaries over raw content.
- **Deterministic core** — reminders, alarms, briefs, and check-in prompts run in *code* (15s tick), with catch-up after sleep. They work with no API key.
- **One facade** — you talk to Hive; the dispatcher picks the module. Direct module access is available when you want it.
- **Safety in code** — email drafts ALWAYS queue for approval; vault writes are sandboxed; project agents stay in their lane.

---

## ⚡ Quick start (60 seconds, zero API keys)

```bash
cd hive
npm run seed-demo        # demo vault + sample calendar/inbox/memories + .env
node src/index.js --once # one cycle of every agent (offline mock brains)
npm run verify           # run the integration checklist — expect ALL ✅
npm start                # the daemon — Ctrl+C to stop
```

Talk to the unified facade — the dispatcher routes by intent:

```bash
npm run say -- "remind me to email Prof Adamopoulos about the ECON 2450 deadline"   # → executor
npm run say -- "find my notes about the pricing and quoting system"                 # → knowledge
npm run say -- "why do I keep falling behind on problem sets?"                      # → mentalist
npm run say -- "observe: just talked to Sam — he said \"send it by Friday\""        # → observer
```

Or hit a module directly:

```bash
npm run search -- "pricing system"            # knowledge module (builds/reuses the vector index)
npm run observe -- "any detail worth keeping" # observer capture (rich memory entry)
npm run ask -- mentalist "analyze my patterns"
npm run ask -- observer "what have you noticed lately?"
npm run agents                               # the agent registry
```

## 🔑 Go live

1. `npm install`
2. `.env` → brain key (Groq free tier: `console.groq.com/keys`, or Anthropic: `console.anthropic.com`) + `OBSIDIAN_VAULT_PATH` (your real vault)
3. First run on macOS: allow the **Calendar** permission prompt (your Apple Calendar, already synced with Google)
4. `npm run check` → `npm run verify` → all ✅ → `npm start`
5. When it feels right: `bash scripts/install-macos.sh` (starts at login, auto-restarts)

Full walkthrough: **`docs/START_HERE.md`**

## The modules (`core/` + `modules/`)

| Path | Role |
|---|---|
| `core/dispatcher.js` | The router: classifies intent (task / search / analyze / capture) and routes to the right module behind one facade |
| `core/memory-store.js` | Central, indexed observation log — the Observer writes, every module reads |
| `modules/executor/` | Tasks & actions: reminders, alarms, notes, email drafts (approval-gated), briefs |
| `modules/knowledge/` | Vector index (`Hive/knowledge-index.json`, TF-IDF + cosine), semantic search, RAG answers with citations, long-term memory retrieval |
| `modules/mentalist/` | Precision analysis: micro-details, contradictions, patterns, evolution, precision questions → `Hive/mentalist/` |
| `modules/observer/` | Detail capture ("the Machine"): 6×/day check-ins, rich memory entries → `Hive/memories/`, pattern sweeps, background environment logging |

The scheduled agents (`data/agents.json`) run on their own intervals with their own models:

```bash
npm run agents                                  # hive · mentalist · observer · startup · econ
npm run agents -- model mentalist claude-opus-4-6
npm run agents -- enable startup
```

## Commands

| Command | What it does |
|---|---|
| `npm start` / `npm run once` | daemon / one cycle (`--agent <id>` to pick one) |
| `npm run say -- "…"` | talk to Hive — auto-routed by intent |
| `npm run ask -- <agent> "…"` | talk to one agent directly |
| `npm run search -- "…"` | semantic vault search (knowledge module) |
| `npm run observe -- "…"` | capture an observation (observer module) |
| `npm run agents […]` | list / enable / disable / model / interval / focus |
| `npm run status` | agents, memory store, knowledge index, approvals, timers |
| `npm run approve` | email approvals: `show <id>` / `send <id>` / `discard <id>` |
| `npm run check` / `npm run verify` | setup diagnostics / integration checklist |
| `npm run doctor [-- --fix]` | diagnostics bundle for your build agent (safe to share — see `docs/WORKING_WITH_YOUR_BUILDER.md`) |
| `bash scripts/setup-web.sh` / `npm run web` | publish the free web dashboard (GitHub Pages — see `docs/WEB_DASHBOARD.md`) |
| `npm run seed-demo` / `npm test` | demo data / unit tests |

## What lands where in your vault

```
Hive/
  knowledge-index.json      vector index (auto-generated)
  memories/                 Observer captures: persons/ · events/ · ideas/
                            conversations/ · connections/pattern-analysis.md
  mentalist/                contradictions · patterns · evolution ·
                            precision_questions · daily_analysis/
  Inbox.md                  questions from the hive awaiting your answer
  Memory/preferences.md     learned preferences (edit freely)
  Approvals/                email drafts awaiting review
Agent_Logs/                 timestamped log of every action by every module
Daily/ · Weekly/           briefs, plans, summaries
```

## 🔒 Safety (docs/SECURITY.md)

- Email: three locked doors — AI can only draft → you approve → `ALLOW_EMAIL_SEND` gate (default **false**).
- Vault writes sandboxed (`..` rejected, replaces backed up, project agents confined to their focus).
- The AI sees summaries/excerpts; output is schema-validated; every action is logged and auditable.

## Cost

Mock mode: free. Live: Sonnet hourly ≈ $0.30–0.80/day + Mentalist/Observer a few times daily. Tune per agent with `npm run agents -- interval <id> <min>`.

## Project layout

```
core/          dispatcher · memory-store
modules/       executor · knowledge (vector-store) · mentalist · observer
src/           daemon & CLI (index, agent, agents registry, scheduler, prompt,
               profile) · lib (util, state, llm, logger, notify) · context
               (obsidian, calendar + apple-calendar, email, google, system) · cli
scripts/       seed-demo · google-auth · verify · install-macos.sh · install-windows.ps1
docs/          START_HERE · HIVE_SYSTEM_GENERIC · HIVE_OBSERVER_MODE ·
               HIVE_MENTALIST_MODE · GOOGLE_SETUP · RUN_AS_SERVICE · SECURITY · CUSTOMIZING
test/          58 unit tests (node --test)
launchd/       com.hive.agent.plist template
```

## Troubleshooting

- **No calendar events** → grant Calendar permission (System Settings → Privacy & Security → Calendars).
- **Search finds nothing** → `npm run search -- "anything"` builds the index; it refreshes automatically.
- **`Model not found`** → `npm run agents -- model <id> default`.
- Everything else → `npm run check`, `npm run verify`, then `docs/`.

MIT licensed. The more notes you feed the vault, the smarter the Hive gets. 🐝

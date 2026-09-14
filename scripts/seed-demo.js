#!/usr/bin/env node
'use strict';

/**
 * Seeds a runnable DEMO environment (no API keys needed):
 *   demo-vault/   — a miniature Obsidian vault modelled on Pouria's
 *   data/calendar.json    — events relative to *now* (so reminders fire)
 *   data/mock-inbox.json  — sample unread emails
 *   .env                  — created only if missing, pointing at demo-vault
 *
 * Re-running refreshes the demo data. It never touches a real vault.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VAULT = path.join(ROOT, 'demo-vault');
const DATA = path.join(ROOT, 'data');

const pad2 = (n) => String(n).padStart(2, '0');
const dateStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const dateTime = (d) => `${dateStr(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:00`;
const daysFromNow = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return dateStr(d);
};
const minutesFromNow = (min) => new Date(Date.now() + min * 60000);

function write(file, content) {
  const abs = path.join(VAULT, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content.endsWith('\n') ? content : `${content}\n`);
  console.log(`  📄 demo-vault/${file}`);
}

// ── 1. demo vault ───────────────────────────────────────────────────
console.log('\n🌱 Seeding demo vault…');
const today = dateStr(new Date());

write('School/ECON2450/assignments.md', `---
tags: [school, econ2450, assignments]
---

# ECON 2450 — Assignments

## Problem sets
- [ ] Problem set 1 — due ${daysFromNow(-3)} ⚠️ OVERDUE
- [ ] Read chapter 4 before Wednesday lecture
- [ ] Form study group for midterm prep

## Notes
- Prof Adamopoulos said late submissions lose 10%.
`);

write('School/ECON2450/notes.md', `---
tags: [school, econ2450, notes]
---

# ECON 2450 — Lecture Notes

## Week 2 — Consumer theory
- Budget constraints & indifference curves
- Midterm: ~week 6 (date TBA)
`);

write('School/ECON1000/notes.md', `---
tags: [school, econ1000]
---

# ECON 1000 — Notes

- Intro macro: GDP, inflation, unemployment
- Assignment due next week — [ ] start it
`);

write('School/MATH1581/notes.md', `---
tags: [school, math1581]
---

# MATH 1581 — Business Math

- annuities & loan schedules this unit
- practice problems every Thursday
`);

write('Work/TPH/projects.md', `---
tags: [work, tph, pricing]
---

# TPH — Projects

## Pricing / quoting system
- [ ] Draft the quote template structure
- [ ] Get manager feedback on v1
`);

write('Work/TPH/D365.md', `---
tags: [work, tph, d365]
---

# TPH — D365 / Dynamics 365

## Open items
- [ ] Enter this week's job tickets
- Weekly sync notes go here
`);

write('Work/TPH/health_safety.md', `---
tags: [work, tph, health-safety]
---

# TPH — Health & Safety

_You are the workplace H&S representative — weekly checklist due Fridays._

## ${daysFromNow(2)} — weekly checklist
- [ ] Equipment checks (ZUND, printers)
- [ ] Workarea walkthrough
- [ ] Log incidents / near-misses
`);

write('Personal/Fitness/2026-log.md', `---
tags: [personal, fitness]
---

# Fitness Log

## ${daysFromNow(-6)}
- Push day — chest/triceps, 55 min
## ${daysFromNow(-5)}
- 5 km run
## ${daysFromNow(-4)}
- (rest)
`);

write('Personal/Ideas/agent-startup.md', `---
tags: [personal, ideas, startup]
---

# Personal AI Agent Startup — Ideas

- The prototype (this agent) proves: local-first, Obsidian as second brain
- Open question: who else wants a "Hive"? Students? Freelancers?
- [ ] Read "The Mom Test" for customer-interview approach
- [ ] Sketch MVP feature set
`);

write(`Daily/${daysFromNow(-1)}.md`, `---
tags: [daily]
---

# Daily — ${daysFromNow(-1)}

- [x] ECON 2450 lecture
- [ ] Gym (skipped 😞)
- [x] TPH shift 1–5 PM
`);

write('Hive/Memory/preferences.md', `# Hive Memory — Learned Preferences

Edit freely; Hive reads this every cycle and may add learned facts here.

- Prefers Farsi with family, English for school/work
- Classes: Mon/Wed/Thu · TPH shifts: Tue/Thu/Fri afternoons
- Reminders: 30 min before classes feels right
`);

write('Hive/Inbox.md', `# Hive Inbox

Questions from the hive land here. Reply with:

    npm run say -- "your answer"          (to Hive)
    npm run ask -- mentalist "your answer" (to the Mentalist)
`);

write('Hive/README.md', `---
tags: [hive]
---

# 🐝 The Hive — Unified Intelligence Layer

One entity, four modules behind the dispatcher (\`core/dispatcher.js\`):

- **executor** — tasks & actions: reminders, notes, email drafts (approval-gated), briefs
- **knowledge** — vector index + semantic search + RAG answers (\`Hive/knowledge-index.json\`)
- **mentalist** — precision analysis: contradictions, patterns, evolution → \`Hive/mentalist/\`
- **observer** — detail capture & background logging → \`Hive/memories/\` + memory store

## Talk to the Hive
    npm run say -- "find my notes about pricing"     (auto-routed by intent)
    npm run search -- "pricing system"               (knowledge module directly)
    npm run observe -- "just talked to X about Y"    (capture a memory)
    npm run ask -- mentalist "analyze my patterns"   (one module directly)

## The vault is the database
Everything the Hive knows lives here — notes, memories, mentalist ledgers.
The knowledge module indexes all of it; the more you add, the smarter Hive gets.
`);

// Observer memory folders (HIVE_OBSERVER_MODE.md structure)
write('Hive/memories/events/' + dateStr(new Date()) + '.md', `# Observations — ${dateStr(new Date())}

_Captured observations land here (npm run observe -- "..."). Persons, ideas and
conversations get their own files under persons/ · ideas/ · conversations/._
`);

write('Hive/memories/persons/README.md', `# Persons

One file per person the Observer tracks — appended every time you capture an
interaction with them. Detail is the point: exact words, tone, body language.
`);

write('Hive/memories/connections/pattern-analysis.md', `# Pattern Analysis

_Cross-cutting patterns the Observer detects across your observations and memories._
`);

// ── 2. demo calendar (relative to NOW so reminders actually fire) ──
console.log('\n🌱 Seeding demo calendar (data/calendar.json)…');
const events = [
  {
    id: 'demo-personal-1',
    title: 'Coffee with Mobina',
    start: dateTime(minutesFromNow(25)),
    end: dateTime(minutesFromNow(85)),
    location: 'Vaughan',
    category: 'personal',
  },
  {
    id: 'demo-class-1',
    title: 'ECON 2450 — Lecture',
    start: dateTime(minutesFromNow(95)),
    end: dateTime(minutesFromNow(215)),
    location: 'York University — Room 201',
    category: 'class',
  },
  {
    id: 'demo-work-1',
    title: 'TPH shift — D365 updates + ZUND cutting',
    start: dateTime(minutesFromNow(300)),
    end: dateTime(minutesFromNow(540)),
    location: 'TPH Toronto',
    category: 'work',
  },
  {
    id: 'demo-deadline-1',
    title: 'ECON 1000 assignment due',
    start: dateTime(minutesFromNow(1500)),
    category: 'deadline',
  },
  {
    id: 'demo-gym-1',
    title: 'Gym — push day',
    start: dateTime(minutesFromNow(2760)),
    end: dateTime(minutesFromNow(2835)),
    category: 'personal',
  },
];
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'calendar.json'), `${JSON.stringify({ events }, null, 2)}\n`);
console.log(`  📅 ${events.length} events (first: ${events[0].title} in 25 min)`);

// ── 3. mock inbox ───────────────────────────────────────────────────
console.log('🌱 Seeding mock inbox (data/mock-inbox.json)…');
fs.writeFileSync(path.join(DATA, 'mock-inbox.json'), `${JSON.stringify({
  emails: [
    {
      id: 'm1',
      from: 'Prof. Adamopoulos <adamopoulos@yorku.ca>',
      subject: 'Office hours this week',
      date: daysFromNow(-1),
      snippet: 'Reminder that office hours are Wednesday 2–4 PM. If you want to discuss your project or the problem set, come prepared with…',
      unread: true,
    },
    {
      id: 'm2',
      from: 'TPH Manager <manager@tph.ca>',
      subject: 'Pricing system — quoting template',
      date: daysFromNow(-2),
      snippet: 'Can you send the updated quoting template by Friday? Also need the D365 update notes for the team meeting…',
      unread: true,
    },
  ],
}, null, 2)}\n`);
console.log('  📧 2 unread emails (Prof. Adamopoulos, TPH manager)');

// ── 4. .env (only if missing) ───────────────────────────────────────
const envPath = path.join(ROOT, '.env');
if (!fs.existsSync(envPath)) {
  fs.writeFileSync(envPath, `# Created by seed-demo — DEMO configuration.
# Point OBSIDIAN_VAULT_PATH at your real vault and add ANTHROPIC_API_KEY when ready.

OBSIDIAN_VAULT_PATH=${VAULT}
AGENT_NAME=Hive
USER_NAME=Pouria
BRAIN_INTERVAL_MINUTES=60
DAILY_BRIEF_TIME=07:00
ALLOW_EMAIL_SEND=false
`);
  console.log('\n🌱 Created .env pointing at the demo vault.');
} else {
  console.log('\n🌱 .env already exists — left untouched.');
}

console.log(`
✅ Demo ready! Try it:

   node src/index.js --once                                  # one cycle (mock brain)
   node src/index.js say "remind me to email Prof Adamopoulos"
   node src/index.js status
   npm start                                                  # full daemon
`);

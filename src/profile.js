'use strict';

/**
 * Everything Hive knows about Pouria. This is the single file to edit
 * when your courses, work projects, or contacts change — it feeds both
 * the AI system prompt and the demo seed.
 *
 * Schedule below is the authoritative Fall 2026 timetable (given by
 * Pouria on 2026-09-14, from the York course timetable).
 */
module.exports = {
  user: {
    name: 'Pouria',
    student: {
      school: 'York University (Keele campus) — LA&PS faculty',
      program: 'Financial & Business Economics (FBEC)',
      classDays: 'Tuesday, Thursday (evenings)',
      courses: [
        'ECON 2350 — Tue 15:00–17:00, Keele CLH K (Lecture, Section A)',
        'ADMS 2500 — Tue 19:00–21:00, Keele ACE 001 (Lecture, Section A)',
        'ECON 2500 — Thu 16:00–18:00, Keele ACW 205 (Lecture, Section D)',
        'MATH 1581 — Thu 19:00–21:00, Keele CB 121 (Lecture, Section A)',
      ],
      coursesShort: ['ECON 2350', 'ADMS 2500', 'ECON 2500', 'MATH 1581'],
      // NOTE: earlier mentions of "ECON 1000" / "ECON 2450" were outdated —
      // the Fall 2026 courses are the four above. (User confirmed 2026-09-14.)
      contacts: [
        { name: 'Prof. Adamopoulos', email: 'adamopoulos@yorku.ca', role: 'ECON academic advisor' },
        { name: 'Prof. Jesse Rogerson', email: 'jrogerson@yorku.ca', role: 'Course instructor' },
      ],
    },
    work: {
      company: 'The Printing House (TPH) — tph.ca — Canadian printing brand; branch 079 (Jane Street, Toronto), Finishing & Fabrication',
      role: 'Technician — part-time',
      duties: [
        'D365 / Microsoft Dynamics 365 updates',
        'Equipment operation (ZUND digital cutting, large/small format printing)',
        'Health & Safety checks — workplace H&S representative',
        'Pricing/quoting system work',
      ],
      shifts: 'Monday, Wednesday, Friday 9:30–18:00 (per user, 2026-09-14)',
      // Schedule logic: TPH Mon/Wed/Fri (9:30–18:00) never overlaps York
      // classes (Tue/Thu evenings) — a clean weekly split.
    },
    personal: {
      location: 'Vaughan / Toronto area',
      languages: 'Persian (Farsi) native, English',
      interests: ['fitness', 'tech', 'business ideas'],
      currentProject: 'Brainstorming a personal AI agent startup (this agent is the prototype)',
    },
  },

  contacts: [
    { name: 'Prof. Adamopoulos', email: 'adamopoulos@yorku.ca', role: 'ECON advisor (emails ALWAYS need approval)' },
    { name: 'Prof. Jesse Rogerson', email: 'jrogerson@yorku.ca', role: 'Course instructor (emails need approval)' },
    { name: 'TPH Manager', email: '', role: 'ADD EMAIL HERE — work contact (drafts need approval)' },
    { name: 'Mobina', email: '', role: 'Personal contact — handle carefully per user preference' },
  ],

  vaultStructure: `
/School/           (ECON2350, ADMS2500, ECON2500, MATH1581 → assignments, notes)
/Work/TPH/         (projects, D365, health_safety)
/Personal/         (Fitness, Ideas)
/Daily/            (one note per day)
/Weekly/           (weekly plans & summaries)
/Hive/             (agent workspaces: mentalist/ ledgers, <agent>/captured)
/Hive/           (chief agent memory, inbox, captured notes, approvals)
/Agent_Logs/       (timestamped log of everything every agent did)`,

  recurring: [
    'Every day ~07:00 — daily brief',
    'Every Monday ~08:00 — weekly plan',
    'Every Friday ~16:00 — weekly summary',
    'Every Friday — TPH Health & Safety checklist nudge',
    'Class days: Tue & Thu evenings — remind 30 min before each lecture',
    'TPH shifts Mon/Wed/Fri 9:30–18:00 — remind 60 min before',
  ],
};

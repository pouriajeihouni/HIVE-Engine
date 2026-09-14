'use strict';

/**
 * HIVE scheduler — cron-like recurring jobs with catch-up (a job missed
 * while the laptop slept runs on wake, once per occurrence).
 * Jobs return {id, time, days, module, directive}:
 *   module 'chief'   → the chief agent runs a brain cycle with the directive
 *   module 'observer'→ the Observer fires a capture check-in prompt
 */
const { lastOccurrenceOnOrBefore, todayStr } = require('./lib/util');

// day numbers: 0=Sunday … 6=Saturday
const JOBS = (cfg) => [
  { id: 'daily_brief', time: cfg.dailyBriefTime, days: null, module: 'chief', directive: 'daily_brief' },
  { id: 'weekly_plan', time: cfg.weeklyPlanTime, days: [1], module: 'chief', directive: 'weekly_plan' },        // Monday
  { id: 'weekly_summary', time: cfg.weeklySummaryTime, days: [5], module: 'chief', directive: 'weekly_summary' }, // Friday
  { id: 'hs_checklist', time: cfg.hsChecklistTime, days: [5], module: 'chief', directive: 'hs_checklist' },      // Friday

  // Resilience: daily backup + log hygiene + heartbeat (no LLM — deterministic)
  { id: 'system_maintenance', time: cfg.backupTime, days: null, module: 'system', directive: 'system_maintenance' },
  // Observer capture prompts — 6×/day (HIVE_OBSERVER_MODE.md)
  { id: 'observer_morning', time: '07:00', days: null, module: 'observer', directive: 'observer_checkin', label: 'morning' },
  { id: 'observer_midmorning', time: '10:00', days: null, module: 'observer', directive: 'observer_checkin', label: 'midmorning' },
  { id: 'observer_noon', time: '12:30', days: null, module: 'observer', directive: 'observer_checkin', label: 'noon' },
  { id: 'observer_afternoon', time: '15:00', days: null, module: 'observer', directive: 'observer_checkin', label: 'afternoon' },
  { id: 'observer_evening', time: '18:00', days: null, module: 'observer', directive: 'observer_checkin', label: 'evening' },
  { id: 'observer_night', time: '21:00', days: null, module: 'observer', directive: 'observer_checkin', label: 'night' },
];

/**
 * Returns the next due job (and marks its occurrence handled), or null.
 * state.scheduler[jobId] stores the occurrence date last handled.
 * Mutates state — caller must save.
 */
function checkJobs(cfg, state, now = new Date()) {
  state.scheduler = state.scheduler || {};
  for (const job of JOBS(cfg)) {
    const occ = lastOccurrenceOnOrBefore(job.time, job.days, now);
    if (!occ) continue;
    const occKey = todayStr(occ);
    if (String(state.scheduler[job.id] || '') < occKey) {
      state.scheduler[job.id] = occKey;
      return job;
    }
  }
  return null;
}

module.exports = { JOBS, checkJobs };

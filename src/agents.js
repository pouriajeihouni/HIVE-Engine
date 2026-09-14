'use strict';

/**
 * HIVE agent registry (data/agents.json). Multiple agents run side by
 * side in one daemon — each with its own ROLE, MODEL, interval and
 * optional vault FOCUS folder. Edit the file to add a project agent.
 *
 * Roles:
 *   chief     — Hive: proactive life management (reminders, notes,
 *               email drafts, daily briefs, scheduled jobs)
 *   mentalist — precision analysis engine (docs/HIVE_MENTALIST_MODE.md):
 *               micro-details, contradictions, patterns, precision questions
 *   project   — a specialized watcher for one vault folder/mission
 */
const fs = require('fs');
const path = require('path');
const { ensureDir, clamp } = require('./lib/util');
const logger = require('./lib/logger');

const ROLES = ['chief', 'mentalist', 'project', 'observer'];

const DEFAULT_AGENTS = [
  {
    id: 'hive',
    name: 'Hive',
    role: 'chief',
    model: '',                    // '' = CLAUDE_MODEL from .env
    interval_minutes: 60,
    enabled: true,
    focus: null,
    mission: 'The unified voice: proactive life management — calendar, reminders, Obsidian notes, email drafts, daily briefs, weekly plans. Coordinates tasks, knowledge, patterns, and observations.',
  },
  {
    id: 'mentalist',
    name: 'Mentalist',
    role: 'mentalist',
    model: '',                    // analysis benefits from a strong model — set e.g. "claude-opus-4-6"
    interval_minutes: 720,
    enabled: true,
    focus: null,
    mission: 'Precision analysis through micro-detail observation: detect contradictions, map connections, track idea evolution, ask precision questions.',
  },
  {
    id: 'observer',
    name: 'Observer',
    role: 'observer',
    model: '',
    interval_minutes: 360,
    enabled: true,
    focus: null,
    mission: 'Detail-capture system: records everything with context, prompts 6×/day captures, cross-references observations into patterns. Runs silently in the background across all state transitions.',
  },
  {
    id: 'startup',
    name: 'Startup Co-pilot',
    role: 'project',
    model: 'claude-sonnet-4-5',
    interval_minutes: 240,
    enabled: false,
    focus: 'Personal/Ideas',
    mission: 'Develop the personal-agent startup idea: research angles, competitive notes, MVP scope, next experiments. Challenge vague thinking.',
  },
  {
    id: 'econ',
    name: 'Econ Tutor',
    role: 'project',
    model: 'claude-opus-4-6',
    interval_minutes: 240,
    enabled: false,
    focus: 'School',
    mission: 'Track ECON 1000 / ECON 2450 / MATH 1581 coursework: flag upcoming deadlines, summarize weak spots, suggest study blocks.',
  },
];

function agentsFile(cfg) { return path.join(cfg.dataDir, 'agents.json'); }

/** Normalize + validate one agent record. Throws on unusable input. */
function normalizeAgent(raw, i) {
  if (!raw || typeof raw !== 'object') throw new Error(`agent #${i}: not an object`);
  const id = String(raw.id || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!id) throw new Error(`agent #${i}: missing id`);
  const role = ROLES.includes(raw.role) ? raw.role : 'project';
  return {
    id,
    name: String(raw.name || id).slice(0, 60),
    role,
    model: String(raw.model || '').trim(),
    interval_minutes: clamp(Math.round(Number(raw.interval_minutes) || 60), 5, 1440),
    enabled: raw.enabled !== false,
    focus: raw.focus ? String(raw.focus).replace(/[\\/]+$/, '') : null,
    mission: String(raw.mission || '').slice(0, 500),
  };
}

/**
 * Load the registry. Creates data/agents.json with the defaults on
 * first run. Throws on invalid JSON (callers decide how to fall back).
 */
function loadAgents(cfg) {
  const file = agentsFile(cfg);
  if (!fs.existsSync(file)) {
    ensureDir(cfg.dataDir);
    fs.writeFileSync(file, `${JSON.stringify({ agents: DEFAULT_AGENTS }, null, 2)}\n`);
    logger.info(`created agent registry: ${file}`);
    return DEFAULT_AGENTS.slice();
  }
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const arr = Array.isArray(j) ? j : j.agents;
  if (!Array.isArray(arr) || !arr.length) throw new Error(`${file}: no agents defined`);
  const agents = arr.map(normalizeAgent);
  const ids = new Set(agents.map((a) => a.id));
  if (ids.size !== agents.length) throw new Error(`${file}: duplicate agent ids`);
  if (!agents.some((a) => a.role === 'chief' && a.enabled)) {
    logger.warn('no enabled chief agent — scheduled jobs (briefs/summaries) will not run');
  }
  return agents;
}

/** Fall back to defaults if the registry is broken (daemon must survive). */
function loadAgentsSafe(cfg) {
  try {
    return loadAgents(cfg);
  } catch (e) {
    logger.error(`agents.json invalid (${e.message}) — falling back to defaults until fixed`);
    return DEFAULT_AGENTS.slice();
  }
}

function getAgent(agents, id) {
  const q = String(id || '').trim().toLowerCase();
  return agents.find((a) => a.id === q) || null;
}

function saveAgents(cfg, agents) {
  ensureDir(cfg.dataDir);
  fs.writeFileSync(agentsFile(cfg), `${JSON.stringify({ agents }, null, 2)}\n`);
}

function describe(agent) {
  const model = agent.model || '(env default)';
  const bits = [
    `${agent.enabled ? '🟢' : '⚪'} ${agent.id}`,
    `role: ${agent.role}`,
    `model: ${model}`,
    `every ${agent.interval_minutes}m`,
  ];
  if (agent.focus) bits.push(`focus: ${agent.focus}`);
  return bits.join('  ·  ');
}

module.exports = { ROLES, DEFAULT_AGENTS, loadAgents, loadAgentsSafe, getAgent, saveAgents, normalizeAgent, agentsFile, describe };

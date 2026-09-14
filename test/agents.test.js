'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const agentsLib = require('../src/agents');

function tmpCfg() {
  return { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hives-')) };
}

test('normalizeAgent applies defaults and strips bad input', () => {
  const a = agentsLib.normalizeAgent({ id: 'My Agent!', role: 'wizard', interval_minutes: 3 }, 0);
  assert.equal(a.id, 'my-agent');
  assert.equal(a.role, 'project');       // unknown role → project
  assert.equal(a.interval_minutes, 5);   // clamped to min
  assert.equal(a.enabled, true);
  assert.throws(() => agentsLib.normalizeAgent({}, 1), /missing id/);
});

test('registry: created on first load, round-trips, getAgent works', () => {
  const cfg = tmpCfg();
  const first = agentsLib.loadAgents(cfg);
  assert.ok(fs.existsSync(agentsLib.agentsFile(cfg)));
  assert.ok(first.some((a) => a.role === 'chief'));
  assert.ok(first.some((a) => a.role === 'mentalist'));

  first.find((a) => a.id === 'mentalist').model = 'claude-opus-4-6';
  agentsLib.saveAgents(cfg, first);
  const second = agentsLib.loadAgents(cfg);
  assert.equal(agentsLib.getAgent(second, 'Mentalist').model, 'claude-opus-4-6'); // case-insensitive
  assert.equal(agentsLib.getAgent(second, 'nope'), null);
});

test('registry: duplicate ids rejected, broken JSON falls back to defaults', () => {
  const cfg = tmpCfg();
  const { agentsFile } = agentsLib;
  fs.writeFileSync(agentsFile(cfg), JSON.stringify({ agents: [{ id: 'x' }, { id: 'x' }] }));
  assert.throws(() => agentsLib.loadAgents(cfg), /duplicate agent ids/);

  fs.writeFileSync(agentsFile(cfg), '{ not json');
  const fallback = agentsLib.loadAgentsSafe(cfg);
  assert.ok(fallback.some((a) => a.role === 'chief')); // daemon survives a broken registry
});

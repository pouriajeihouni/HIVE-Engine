'use strict';

/**
 * `hive agents` — manage the agent registry (data/agents.json).
 *   agents                          list
 *   agents enable|disable <id>
 *   agents model <id> <model|default>
 *   agents interval <id> <minutes>
 *   agents focus <id> <folder|none>
 * (Adding brand-new agents = editing data/agents.json — see docs/CUSTOMIZING.md)
 */
const agentsLib = require('../agents');

async function run(cfg, args) {
  const [cmd, idArg, ...rest] = args;

  if (!cmd || cmd === 'list') {
    const agents = agentsLib.loadAgentsSafe(cfg);
    console.log(`\n🐝 HIVE — ${agents.filter((a) => a.enabled).length} of ${agents.length} agents enabled\n`);
    for (const a of agents) {
      console.log(`  ${agentsLib.describe(a)}`);
      if (a.mission) console.log(`      ${a.mission.slice(0, 110)}`);
    }
    console.log('\nEdit data/agents.json to add agents · commands: enable/disable/model/interval/focus\n');
    return;
  }

  let agents;
  try {
    agents = agentsLib.loadAgents(cfg); // strict — show real errors when editing
  } catch (e) {
    console.log(`❌ ${e.message}`);
    return;
  }

  const agent = agentsLib.getAgent(agents, idArg);
  if (!agent && cmd !== 'help') {
    console.log(`❌ unknown agent "${idArg || ''}" — try: ${agents.map((a) => a.id).join(', ')}`);
    return;
  }

  switch (cmd) {
    case 'enable':
    case 'disable':
      agent.enabled = cmd === 'enable';
      agentsLib.saveAgents(cfg, agents);
      console.log(`${agent.enabled ? '🟢' : '⚪'} ${agent.id} ${cmd}d`);
      break;

    case 'model': {
      const model = rest.join(' ').trim();
      agent.model = /^(default|none|-)$/i.test(model) ? '' : model;
      agentsLib.saveAgents(cfg, agents);
      console.log(`🔁 ${agent.id} model → ${agent.model || '(env default: ' + cfg.claudeModel + ')'}`);
      break;
    }

    case 'interval': {
      const mins = Number(rest[0]);
      if (!Number.isFinite(mins) || mins < 5 || mins > 1440) {
        console.log('interval must be 5–1440 minutes');
        return;
      }
      agent.interval_minutes = Math.round(mins);
      agentsLib.saveAgents(cfg, agents);
      console.log(`⏱  ${agent.id} interval → every ${mins} min`);
      break;
    }

    case 'focus': {
      const focus = rest.join(' ').trim();
      agent.focus = /^(none|-)$/i.test(focus) ? null : focus;
      agentsLib.saveAgents(cfg, agents);
      console.log(`🎯 ${agent.id} focus → ${agent.focus || '(whole vault)'}`);
      break;
    }

    default:
      console.log('Commands: agents [list] | enable <id> | disable <id> | model <id> <m|default> | interval <id> <min> | focus <id> <folder|none>');
  }
}

module.exports = { run };

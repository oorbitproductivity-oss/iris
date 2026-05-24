// lib/cli/agents.js — `iris agents [kill <id>]`
//
// Inspect / kill agents shared with the GUI. The GUI is the authoritative
// owner of subprocesses (it has the per-agent pool); the CLI reads
// `agents.json` and `messages-<id>.json` straight from the shared data
// dir and offers a "kill" path that touches a sentinel file the GUI's
// AgentManager picks up on next event poll.
//
// (If the GUI isn't running, `kill` falls back to attempting to terminate
// any orphaned process by pid stored in the agent record.)

'use strict';

const fs = require('fs');
const path = require('path');
const ui = require('./ui.js');

async function run(args) {
  const sub = args._[1];
  if (!sub || sub === 'list') return list();
  if (sub === 'kill') return kill(args._[2]);
  if (sub === 'show') return show(args._[2]);
  ui.err(`usage: iris agents [list|show <id>|kill <id>]`);
  process.exit(2);
}

function loadAgents() {
  const file = path.join(ui.ensureDataDir(), 'agents.json');
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function list() {
  const all = Object.values(loadAgents());
  if (!all.length) { ui.info('(no agents — the GUI hasn\'t created any yet)'); return; }
  all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  for (const a of all) {
    const status = (a.status === 'running' ? ui.green : a.status === 'error' ? ui.red : ui.dim)(a.status || '?');
    const tag = a.id === 'iris' ? ui.gold('★ ') : '  ';
    ui.out(`${tag}${a.id.slice(0, 8).padEnd(8)}  ${status.padEnd(8)}  ${(a.name || '').padEnd(28)}  ${ui.dim(a.cwd || '')}`);
  }
}

function show(id) {
  if (!id) { ui.err('usage: iris agents show <id>'); process.exit(2); }
  const agents = loadAgents();
  const found = agents[id] || Object.values(agents).find((a) => a.id.startsWith(id));
  if (!found) { ui.err(`no agent matching "${id}"`); process.exit(2); }
  ui.out(JSON.stringify(found, null, 2));
  const msgFile = path.join(ui.ensureDataDir(), `messages-${found.id}.json`);
  if (fs.existsSync(msgFile)) {
    const msgs = JSON.parse(fs.readFileSync(msgFile, 'utf8'));
    ui.out(ui.rule());
    ui.out(ui.dim(`${msgs.length} messages on disk`));
  }
}

function kill(id) {
  if (!id) { ui.err('usage: iris agents kill <id>'); process.exit(2); }
  const agents = loadAgents();
  const found = agents[id] || Object.values(agents).find((a) => a.id.startsWith(id));
  if (!found) { ui.err(`no agent matching "${id}"`); process.exit(2); }
  // Write a sentinel — the GUI's AgentManager polls for these.
  const dir = path.join(ui.ensureDataDir(), 'control');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `kill-${found.id}.json`), JSON.stringify({ id: found.id, requestedAt: Date.now(), by: 'cli' }, null, 2), 'utf8');
  ui.ok(`requested kill for ${found.id}; the GUI will pick this up on next tick`);
  if (found.pid) {
    try { process.kill(found.pid); ui.ok(`also sent SIGTERM to pid ${found.pid}`); }
    catch (err) { ui.info(`pid ${found.pid} not reachable (${err.message})`); }
  }
}

module.exports = { run };

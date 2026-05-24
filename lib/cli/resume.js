// lib/cli/resume.js — `iris resume <session-id> [prompt]`
//
// Continue a previous claude session. The session-id is the one printed
// by claude on the first turn (also surfaced by `iris chat`).

'use strict';

const path = require('path');
const ui = require('./ui.js');
const { runClaude } = require('./claude-runner.js');

async function run(args) {
  const id = args._[1];
  if (!id) { ui.err('usage: iris resume <session-id> [prompt]'); process.exit(2); }
  const prompt = args._.slice(2).join(' ').trim() || 'continue';
  const cwd = args.flags.cwd ? path.resolve(args.flags.cwd) : process.cwd();
  const stream = runClaude({
    prompt,
    cwd,
    sessionId: id,
    permissionMode: 'bypassPermissions',
    effort: args.flags.effort || 'high',
  });
  for await (const ev of stream) {
    if (ev.type === 'text' && !ev.partial) process.stdout.write(ev.delta);
    else if (ev.type === 'tool_use') process.stdout.write(ui.dim(`\n[${ev.name}] ${JSON.stringify(ev.input).slice(0,120)}\n`));
    else if (ev.type === 'error') process.stderr.write(`error ${ev.error}\n`);
    else if (ev.type === 'stop') { process.stdout.write('\n'); break; }
  }
}

module.exports = { run };

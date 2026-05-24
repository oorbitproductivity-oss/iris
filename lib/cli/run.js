// lib/cli/run.js — `iris run <prompt>`
//
// Fire-and-forget non-interactive: streams the assistant's text to stdout
// and exits when claude is done. Useful in shell scripts and CI:
//
//   iris run "summarize CHANGELOG.md" > summary.txt
//   echo "$DIFF" | iris pipe "explain this diff"

'use strict';

const path = require('path');
const ui = require('./ui.js');
const { runClaude } = require('./claude-runner.js');

async function run(args) {
  const prompt = args._.slice(1).join(' ').trim();
  if (!prompt) { ui.err('usage: iris run <prompt>'); process.exit(2); }

  const cwd = args.flags.cwd ? path.resolve(args.flags.cwd) : process.cwd();
  const stream = runClaude({
    prompt,
    cwd,
    model: args.flags.model || undefined,
    effort: args.flags.effort || 'high',
    permissionMode: args.flags['no-bypass'] ? 'acceptEdits' : 'bypassPermissions',
    sessionId: args.flags.resume || undefined,
    tools: args.flags.tools ? String(args.flags.tools).split(',') : undefined,
  });

  const json = !!args.flags.json;
  let saw = false;
  let exitCode = 0;

  for await (const ev of stream) {
    if (json) { process.stdout.write(JSON.stringify(ev) + '\n'); saw = true; continue; }
    if (ev.type === 'text') {
      // For pipe-friendliness we suppress partials and only emit the final blocks.
      if (!ev.partial) { process.stdout.write(ev.delta); saw = true; }
    } else if (ev.type === 'error') {
      process.stderr.write(`error ${ev.error}\n`);
      exitCode = 1;
    } else if (ev.type === 'stop') {
      if (!json && saw) process.stdout.write('\n');
      break;
    }
  }
  process.exit(exitCode);
}

module.exports = { run };

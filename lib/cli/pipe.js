// lib/cli/pipe.js — `iris pipe [instruction]`
//
// Read all of stdin, pass it to claude with an optional instruction,
// stream the reply to stdout. Designed for shell pipelines:
//
//   git diff | iris pipe "write a commit message"
//   cat error.log | iris pipe "what's the root cause?"
//   curl -s api/data | iris pipe --json "summarize as a table"

'use strict';

const path = require('path');
const ui = require('./ui.js');
const { runClaude } = require('./claude-runner.js');

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    if (process.stdin.isTTY) resolve('');   // no piped input
  });
}

async function run(args) {
  const stdin = await readStdin();
  if (!stdin.trim()) {
    ui.err('iris pipe expects content on stdin. example:  git diff | iris pipe "write a commit message"');
    process.exit(2);
  }
  const instruction = args._.slice(1).join(' ').trim() || 'process the following input';
  const prompt = `${instruction}\n\n---\n\n${stdin}`;
  const cwd = args.flags.cwd ? path.resolve(args.flags.cwd) : process.cwd();

  const stream = runClaude({
    prompt,
    cwd,
    model: args.flags.model || undefined,
    effort: args.flags.effort || 'low',
    permissionMode: 'bypassPermissions',
    tools: args.flags.tools ? String(args.flags.tools).split(',') : ['Read', 'Grep', 'Glob'],
  });

  let exitCode = 0;
  for await (const ev of stream) {
    if (ev.type === 'text' && !ev.partial) process.stdout.write(ev.delta);
    else if (ev.type === 'error') { process.stderr.write(`error ${ev.error}\n`); exitCode = 1; }
    else if (ev.type === 'stop') { process.stdout.write('\n'); break; }
  }
  process.exit(exitCode);
}

module.exports = { run };

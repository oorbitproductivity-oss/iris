// lib/cli/exec.js — `iris exec <bash-command...>`
//
// Ask claude to execute a bash command autonomously, with bypass
// permissions and the Bash tool whitelisted. Returns claude's
// commentary + the command output verbatim. Power-user shortcut for
// "do this thing and tell me what you found."
//
//   iris exec "find . -name '*.test.js' -newer src/main.js"
//   iris exec --cwd ./services/api "npm test -- --reporter=min"

'use strict';

const path = require('path');
const ui = require('./ui.js');
const { runClaude } = require('./claude-runner.js');

async function run(args) {
  const command = args._.slice(1).join(' ').trim();
  if (!command) { ui.err('usage: iris exec <bash command>'); process.exit(2); }

  const cwd = args.flags.cwd ? path.resolve(args.flags.cwd) : process.cwd();
  const prompt = `Run this bash command and report the output:\n\n\`\`\`\n${command}\n\`\`\`\n\nUse the Bash tool. Do not explain; show me the command output and any non-zero exit code.`;

  const stream = runClaude({
    prompt,
    cwd,
    permissionMode: 'bypassPermissions',
    tools: ['Bash'],
    effort: 'low',
  });

  let exitCode = 0;
  for await (const ev of stream) {
    if (ev.type === 'text' && !ev.partial) process.stdout.write(ev.delta);
    else if (ev.type === 'tool_use') process.stdout.write(ui.dim(`\n[bash] ${shortJson(ev.input)}\n`));
    else if (ev.type === 'tool_result') {
      const text = typeof ev.output === 'string' ? ev.output
        : Array.isArray(ev.output) ? ev.output.map((b) => b.text || '').join('') : '';
      process.stdout.write(text + '\n');
    } else if (ev.type === 'error') {
      process.stderr.write(`error ${ev.error}\n`);
      exitCode = 1;
    } else if (ev.type === 'stop') {
      process.stdout.write('\n');
      break;
    }
  }
  process.exit(exitCode);
}

function shortJson(o) { try { return JSON.stringify(o).slice(0, 120); } catch { return '(...)'; } }

module.exports = { run };

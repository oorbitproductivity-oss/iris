// lib/cli/dispatch.js
//
// Top-level argv parser + subcommand dispatcher for `iris`.

'use strict';

const PKG = require('../../package.json');
const ui = require('./ui.js');

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      args._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const eq = k.indexOf('=');
      if (eq !== -1) {
        args.flags[k.slice(0, eq)] = k.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        args.flags[k] = true;
      } else {
        args.flags[k] = next;
        i++;
      }
    } else if (a === '-h') {
      args.flags.help = true;
    } else if (a === '-v') {
      args.flags.version = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

const SUBCOMMANDS = {
  doctor:  './doctor.js',
  chat:    './chat.js',
  run:     './run.js',
  exec:    './exec.js',
  pipe:    './pipe.js',
  resume:  './resume.js',
  agents:  './agents.js',
  memory:  './memory-cmd.js',
  skills:  './skills-cmd.js',
  route:   './route.js',
  key:     './key.js',
  model:   './model.js',
  api:     './api.js',
};

async function dispatch(argv, ctx) {
  const args = parseArgs(argv);

  if (args.flags.version) { console.log(ctx.version); return; }
  if (args.flags.help || args._.length === 0) { printHelp(); return; }

  const cmd = args._[0];
  const modPath = SUBCOMMANDS[cmd];
  if (!modPath) {
    ui.err(`unknown command: ${cmd}`);
    printHelp();
    process.exit(2);
  }
  const mod = require(modPath);
  await mod.run(args);
}

function printHelp() {
  const v = PKG.version;
  const out = `${ui.bold('iris')} ${ui.dim('—')} Iris Code power-user CLI ${ui.dim('v' + v)}

${ui.gold('Subscription mode (default)')} — runs through your installed \`claude\` CLI.
${ui.dim('No API key needed; auth flows through your Claude Code subscription.')}

  ${ui.bold('iris doctor')}                       ${ui.dim('check env: claude on PATH, auth, versions')}
  ${ui.bold('iris chat')} [prompt]                ${ui.dim('REPL (or one-shot), bypass-permissions, current cwd')}
  ${ui.bold('iris run')} <prompt>                 ${ui.dim('fire-and-forget; pipes to stdout, exits when done')}
  ${ui.bold('iris exec')} <bash...>               ${ui.dim('have claude execute a bash command autonomously')}
  ${ui.bold('iris pipe')} [instruction]           ${ui.dim('stdin → claude → stdout; shell-pipeline friendly')}
  ${ui.bold('iris resume')} <session-id> [prompt] ${ui.dim('continue a previous session')}

${ui.gold('Power tools')}

  ${ui.bold('iris agents')}                       ${ui.dim('list agents shared with the GUI')}
  ${ui.bold('iris agents kill')} <id>             ${ui.dim('terminate a running agent')}
  ${ui.bold('iris memory')} dump|wipe|search <q>  ${ui.dim('inspect Hermes memory')}
  ${ui.bold('iris skills')} list|edit|rm|reflect  ${ui.dim('manage learned skills')}
  ${ui.bold('iris route')} <text>                 ${ui.dim('print router decision for a prompt')}

${ui.gold('BYOK fallback')} — provider layer for users without a subscription.

  ${ui.bold('iris key')} add|list|test <provider> ${ui.dim('manage encrypted API keys')}
  ${ui.bold('iris model')} [set <prov:model>]     ${ui.dim('default for \`iris api\`')}
  ${ui.bold('iris api chat')} [prompt]            ${ui.dim('chat through the provider abstraction')}

${ui.dim('Flags: --cwd <dir>  --model <id>  --effort <level>  --resume <sid>')}
${ui.dim('       --tools <a,b>  --add-dir <d>  --plan  --no-bypass  --dry-run')}
${ui.dim('       --hermes  --no-memory  --skills <pat>  --json')}
${ui.dim('REPL slash: /gui /hermes /manual /quick /agent /model /skills /memory /cost /tools /allow /deny /resume /export /clear /help /exit')}
`;
  process.stdout.write(out);
}

module.exports = dispatch;
module.exports.parseArgs = parseArgs;

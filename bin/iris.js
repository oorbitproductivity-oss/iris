#!/usr/bin/env node
// bin/iris.js
//
// Iris Code — the power-user CLI.
//
// CLI philosophy:
//   - The default execution path is the user's locally installed
//     `claude` CLI, authenticated via the Pro/Max OAuth subscription
//     the user already pays for. No API keys, no per-token billing,
//     no GUI in the way.
//   - Tool calls run with --permission-mode=bypassPermissions by
//     default. The GUI prompts for approval on risky tool calls; the
//     CLI assumes you are a dev on your own machine and gets out of
//     the way.
//   - BYOK (provider abstraction) is the fallback for users without
//     a subscription, and lives under `iris api …` instead of being
//     the default.
//
// Subcommands:
//   iris --version
//   iris doctor                       diagnose env (claude on PATH? auth? versions?)
//   iris chat [prompt]                REPL or one-shot, subscription default
//   iris run <prompt>                 fire-and-forget, pipe-friendly, exits when done
//   iris exec <bash...>               ask claude to run a bash command (autonomous)
//   iris pipe [instruction]           stdin → claude → stdout, for shell pipelines
//   iris resume <session-id> [prompt] resume a previous claude session
//   iris agents                       list agents the GUI knows about
//   iris agents kill <id>             kill a running agent
//   iris memory dump|wipe|search <q>  inspect Hermes memory
//   iris skills list|edit|rm|reflect  manage learned skills
//   iris route <text>                 print what the router would do with that prompt
//   iris key add|list|test            BYOK key management (only needed for `iris api`)
//   iris model [set <prov:model>]     default for `iris api`
//   iris api chat [prompt]            BYOK chat through the provider layer
//
// REPL slash commands:
//   /gui /hermes /manual /quick /agent /model /skills /memory /cost
//   /tools /allow /deny /resume /export /clear /help /exit

'use strict';

const PKG = require('../package.json');
const dispatch = require('../lib/cli/dispatch.js');

dispatch(process.argv.slice(2), { version: PKG.version }).catch((err) => {
  process.stderr.write(`error ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});

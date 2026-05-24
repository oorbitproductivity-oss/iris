// lib/cli/route.js — `iris route <text>` print the router's decision.

'use strict';

const ui = require('./ui.js');
const { Router } = require('../router');

async function run(args) {
  const text = args._.slice(1).join(' ').trim();
  if (!text) { ui.err('usage: iris route <text>'); process.exit(2); }
  const r = new Router();
  const fast = r.fastClassify(text);
  if (fast) { ui.out(`${ui.gold(fast)}  ${ui.dim('(fast heuristic)')}`); return; }
  ui.out(ui.dim('(no heuristic match — would fall through to LLM classifier in chat mode)'));
}

module.exports = { run };

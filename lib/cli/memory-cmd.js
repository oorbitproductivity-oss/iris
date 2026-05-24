// lib/cli/memory-cmd.js — `iris memory dump|wipe|search <q>`

'use strict';

const fs = require('fs');
const path = require('path');
const ui = require('./ui.js');
const { Memory } = require('../memory');

async function run(args) {
  const sub = args._[1];
  const m = new Memory({ dataDir: ui.ensureDataDir() });

  if (sub === 'dump') {
    for (const r of m.recent(10000)) {
      ui.out(`${ui.dim(new Date(r.ts).toISOString())}  ${ui.gold(r.kind)}  ${r.summary}`);
    }
    return;
  }
  if (sub === 'search') {
    const q = args._.slice(2).join(' ');
    if (!q) { ui.err('usage: iris memory search <query>'); process.exit(2); }
    const res = await m.recall(q, { limit: 20 });
    if (!res.length) { ui.info('(no matches)'); return; }
    for (const r of res) ui.out(`${ui.dim(new Date(r.ts).toISOString())}  ${r.summary}`);
    return;
  }
  if (sub === 'wipe') {
    const ans = await ui.prompt(`${ui.red('!')} wipe ALL Hermes memory? [y/N] `);
    if (ans.trim().toLowerCase() !== 'y') { ui.info('aborted'); return; }
    const dir = path.join(ui.ensureDataDir(), 'memory');
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      try { fs.unlinkSync(path.join(dir, f)); } catch {}
    }
    ui.ok('memory wiped');
    return;
  }
  ui.err('usage: iris memory dump|search <q>|wipe');
  process.exit(2);
}

module.exports = { run };

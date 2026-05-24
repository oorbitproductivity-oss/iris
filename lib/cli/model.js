// lib/cli/model.js — `iris model [set <prov:model>]` (BYOK default).

'use strict';

const ui = require('./ui.js');
const { Store } = require('../store.js');
const { KNOWN_PROVIDERS, DEFAULT_MODELS } = require('../providers');

async function run(args) {
  const store = new Store(ui.ensureDataDir());
  if (args._[1] === 'set') {
    const spec = args._[2];
    if (!spec || !spec.includes(':')) { ui.err('iris model set <provider>:<model>'); process.exit(2); }
    const [prov, ...rest] = spec.split(':');
    if (!KNOWN_PROVIDERS.includes(prov)) { ui.err(`unknown provider "${prov}"`); process.exit(2); }
    store.setSettings({ lastProvider: prov, lastModel: rest.join(':') });
    ui.ok(`default set to ${prov}:${rest.join(':')}`);
    return;
  }
  const s = store.getSettings();
  const prov = s.lastProvider;
  if (!prov) {
    ui.out(ui.dim('(no BYOK default; subscription mode in use)'));
    return;
  }
  ui.out(`${ui.gold(prov)}:${ui.cyan(s.lastModel || DEFAULT_MODELS[prov])}`);
}

module.exports = { run };

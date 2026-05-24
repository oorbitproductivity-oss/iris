// lib/cli/key.js — `iris key add|list|test` (BYOK only).

'use strict';

const ui = require('./ui.js');
const { Store } = require('../store.js');
const { createProvider, KNOWN_PROVIDERS } = require('../providers');

async function run(args) {
  const sub = args._[1];
  const store = new Store(ui.ensureDataDir());
  if (sub === 'add') {
    const provider = args._[2];
    if (!provider) { ui.err('iris key add <provider>'); process.exit(2); }
    if (!KNOWN_PROVIDERS.includes(provider)) {
      ui.err(`unknown provider "${provider}". Known: ${KNOWN_PROVIDERS.join(', ')}`); process.exit(2);
    }
    const value = await ui.prompt(`${provider} API key: `);
    if (!value.trim()) { ui.err('empty, aborted'); process.exit(2); }
    const rec = store.addApiKey({ name: provider, value: value.trim() });
    store.setSettings({ defaultApiKeyId: rec.id, lastProvider: provider });
    ui.ok(`saved ${rec.name} (${rec.hint})`);
    return;
  }
  if (sub === 'list') {
    const keys = store.getApiKeys();
    if (!keys.length) { ui.info('(no keys — `iris` defaults to your Claude Code subscription)'); return; }
    for (const k of keys) ui.out(`  ${ui.gold(k.name.padEnd(20))} ${ui.dim(k.hint)}`);
    return;
  }
  if (sub === 'test') {
    const provider = args._[2];
    if (!provider) { ui.err('iris key test <provider>'); process.exit(2); }
    const keys = store.getApiKeys();
    const k = keys.find((x) => x.name === provider);
    const apiKey = k ? store.getApiKeyValue(k.id) : null;
    if (!apiKey && provider !== 'ollama') { ui.err(`no key for ${provider}`); process.exit(2); }
    const p = createProvider({ name: provider, apiKey });
    const res = await p.test();
    if (res.ok) ui.ok(res.info || 'ok'); else { ui.err(res.error); process.exit(1); }
    return;
  }
  ui.err('usage: iris key add|list|test <provider>');
  process.exit(2);
}

module.exports = { run };

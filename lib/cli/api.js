// lib/cli/api.js — `iris api chat [prompt]` BYOK fallback.
//
// For users without a Claude Code subscription, or who want to talk to a
// non-Anthropic model directly. This is the previous CLI behavior, now
// living under `iris api …` instead of being the default.

'use strict';

const readline = require('readline');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const ui = require('./ui.js');
const { Store } = require('../store.js');
const { createProvider, DEFAULT_MODELS } = require('../providers');

async function run(args) {
  if (args._[1] !== 'chat') { ui.err('usage: iris api chat [prompt]'); process.exit(2); }

  const store = new Store(ui.ensureDataDir());
  const settings = store.getSettings();
  const provider = args.flags.provider || settings.lastProvider || 'anthropic';
  const model = args.flags.model || settings.lastModel || DEFAULT_MODELS[provider];

  const keys = store.getApiKeys();
  const k = keys.find((x) => x.name === provider);
  const apiKey = k ? store.getApiKeyValue(k.id) : null;
  if (!apiKey && provider !== 'ollama') {
    ui.err(`no key for ${provider}. run: iris key add ${provider}`);
    process.exit(2);
  }
  const p = createProvider({ name: provider, apiKey, model });

  const session = { id: crypto.randomUUID(), messages: [], cost: { i: 0, o: 0 } };
  const oneShot = args._.slice(2).join(' ').trim();

  async function turn(text) {
    session.messages.push({ role: 'user', content: text });
    process.stdout.write(`${ui.dim('iris:')} `);
    let buf = '';
    const stream = p.chat({ messages: session.messages, options: { model } });
    for await (const ev of stream) {
      if (ev.type === 'text') { process.stdout.write(ev.delta); buf += ev.delta; }
      else if (ev.type === 'usage') { session.cost.i += ev.input_tokens; session.cost.o += ev.output_tokens; }
      else if (ev.type === 'error') ui.err(ev.error);
      else if (ev.type === 'stop') { process.stdout.write('\n'); break; }
    }
    session.messages.push({ role: 'assistant', content: buf });
  }

  if (oneShot) { await turn(oneShot); return; }

  ui.out(`${ui.bold('iris api')} ${ui.dim('—')} ${provider}:${model}`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${ui.gold('api>')} ` });
  rl.prompt();
  rl.on('line', async (line) => {
    const t = line.trim();
    if (!t) { rl.prompt(); return; }
    if (t === '/exit' || t === '/quit') { rl.close(); return; }
    rl.pause();
    try { await turn(t); } catch (err) { ui.err(err.message); }
    rl.resume();
    rl.prompt();
  });
  rl.on('close', () => process.exit(0));
}

module.exports = { run };

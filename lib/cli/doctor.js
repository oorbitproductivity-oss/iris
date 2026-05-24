// lib/cli/doctor.js — `iris doctor` env diagnostics.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ui = require('./ui.js');

function which(name) {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  const pathParts = (process.env.PATH || '').split(path.delimiter);
  for (const p of pathParts) {
    for (const ext of exts) {
      const cand = path.join(p, name + ext);
      try { if (fs.existsSync(cand)) return cand; } catch {}
    }
  }
  return null;
}

async function run(/* args */) {
  ui.out(ui.bold('iris doctor'));
  ui.out(ui.rule());

  // node
  ui.out(`  ${ui.dim('node          ')} ${process.version}`);

  // claude
  const claudePath = which('claude');
  if (!claudePath) {
    ui.out(`  ${ui.dim('claude CLI    ')} ${ui.red('not found on PATH')}`);
    ui.out(`     ${ui.dim('install:')} https://docs.claude.com/en/docs/claude-code/overview`);
  } else {
    ui.out(`  ${ui.dim('claude CLI    ')} ${ui.green(claudePath)}`);
    try {
      const v = spawnSync('claude', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
      const ver = (v.stdout || '').trim().split('\n')[0] || '(unknown)';
      ui.out(`  ${ui.dim('claude ver    ')} ${ver}`);
    } catch (err) {
      ui.out(`  ${ui.dim('claude ver    ')} ${ui.red('error: ' + err.message)}`);
    }
  }

  // data dir
  const d = ui.dataDir();
  ui.out(`  ${ui.dim('data dir      ')} ${d} ${fs.existsSync(d) ? ui.green('(exists)') : ui.dim('(will be created)')}`);

  // subscription vs BYOK
  const { Store } = require('../store.js');
  fs.mkdirSync(d, { recursive: true });
  const store = new Store(d);
  const keys = store.getApiKeys();
  if (keys.length) {
    ui.out(`  ${ui.dim('byok keys     ')} ${keys.length} configured: ${keys.map((k) => k.name).join(', ')}`);
  } else {
    ui.out(`  ${ui.dim('byok keys     ')} ${ui.dim('none (default = subscription)')}`);
  }

  // memory + skills
  const memDir = path.join(d, 'memory');
  const skillsDir = path.join(d, 'skills');
  const memFile = path.join(memDir, 'turns.jsonl');
  const memCount = fs.existsSync(memFile)
    ? (fs.readFileSync(memFile, 'utf8').match(/\n/g) || []).length
    : 0;
  const skillCount = fs.existsSync(skillsDir)
    ? fs.readdirSync(skillsDir).filter((f) => f.endsWith('.md')).length
    : 0;
  ui.out(`  ${ui.dim('hermes memory ')} ${memCount} records`);
  ui.out(`  ${ui.dim('hermes skills ')} ${skillCount} learned`);

  // model
  const settings = store.getSettings();
  const modelStr = settings.lastProvider
    ? `${settings.lastProvider}:${settings.lastModel}`
    : `${ui.dim('(subscription default)')}`;
  ui.out(`  ${ui.dim('default model ')} ${modelStr}`);

  // permissions
  ui.out(`  ${ui.dim('permission    ')} ${ui.gold('bypassPermissions')} ${ui.dim('(CLI default — power-user mode)')}`);

  ui.out(ui.rule());
  if (!claudePath) {
    ui.warn('claude CLI not found — subscription mode disabled. Either install Claude Code or use `iris api chat`.');
    process.exit(1);
  } else {
    ui.ok('ready');
  }
}

module.exports = { run };

// tests/run-all.js — node-runnable suite for the new lib/* modules.
// Run: node tests/run-all.js

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const suites = [
  'providers.test.js',
  'memory.test.js',
  'journal.test.js',
  'skills.test.js',
  'router.test.js',
  'browser.test.js',
  'cli.test.js',
  'remote.test.js',
  'telegram.test.js',
  'mcp.test.js',
  'terminal.test.js',
  'markdown.test.js',
  // v0.5.1 features
  'slash-commands.test.js',
  'cost-tracker.test.js',
];

let failed = 0;
for (const s of suites) {
  process.stdout.write(`\n— ${s} —\n`);
  const res = spawnSync(process.execPath, [path.join(__dirname, s)], { stdio: 'inherit' });
  if (res.status !== 0) failed++;
}
if (failed) {
  console.error(`\n${failed}/${suites.length} suites failed`);
  process.exit(1);
}
console.log(`\nall ${suites.length} suites passed`);

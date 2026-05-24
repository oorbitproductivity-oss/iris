// tests/skills.test.js — Skills unit tests.
// Run: node tests/skills.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Skills } = require('../lib/skills');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'iris-skills-'));
}

async function testSaveLoadList() {
  const s = new Skills({ dataDir: tmpDir() });
  s.save({ name: 'refactor-react-component', description: 'Split a fat component', tags: ['react', 'refactor'], body: '1. Find the file\n2. Pull state up\n3. Extract subtree' });
  const got = s.load('refactor-react-component');
  assert.ok(got);
  assert.strictEqual(got.description, 'Split a fat component');
  assert.deepStrictEqual(got.tags, ['react', 'refactor']);
  assert.match(got.body, /Pull state up/);
  const all = s.list();
  assert.strictEqual(all.length, 1);
}

async function testMatchByTerm() {
  const s = new Skills({ dataDir: tmpDir() });
  s.save({ name: 'add-eslint', description: 'Configure eslint for a node project', tags: ['lint'], body: 'install eslint then run init' });
  s.save({ name: 'set-up-vitest', description: 'Add vitest unit tests', tags: ['testing'], body: 'pnpm add -D vitest' });
  const m = await s.match('I want lint config');
  assert.ok(m.length >= 1);
  assert.strictEqual(m[0].name, 'add-eslint');
}

async function testReflectGoldenPath() {
  const s = new Skills({ dataDir: tmpDir() });
  const userText = 'How do I split a fat React component into smaller pieces in our codebase?';
  const assistantText = `Here's a procedure:
1. Identify state that doesn't need to live at the top.
2. Extract a child component for each visual region.
3. Pass props down explicitly; no context shortcuts.
4. Verify with a render test.`;
  const proposal = await s.reflect({ userText, assistantText });
  assert.ok(proposal);
  assert.match(proposal.name, /^learned-/);
  assert.ok(Array.isArray(proposal.tags));
  assert.match(proposal.body, /Identify state/);
}

async function testReflectSkipsShortTrivia() {
  const s = new Skills({ dataDir: tmpDir() });
  const p = await s.reflect({ userText: 'hi', assistantText: 'hi back' });
  assert.strictEqual(p, null);
}

async function run() {
  const tests = [
    ['save/load/list a skill', testSaveLoadList],
    ['match retrieves by term overlap', testMatchByTerm],
    ['reflect proposes a skill from a numbered procedure', testReflectGoldenPath],
    ['reflect skips short trivial turns', testReflectSkipsShortTrivia],
  ];
  let passed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}`); console.error('   ', err && err.stack ? err.stack : err); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
}

run();

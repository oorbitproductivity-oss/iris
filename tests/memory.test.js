// tests/memory.test.js — Memory unit tests.
// Run: node tests/memory.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Memory, tokenize } = require('../lib/memory');

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-mem-'));
  return d;
}

async function testRememberAndRecall() {
  const d = tmpDir();
  const m = new Memory({ dataDir: d });
  await m.remember({ kind: 'turn', summary: 'fixed the auth bug in login handler', body: 'replaced JWT verify' });
  await m.remember({ kind: 'turn', summary: 'updated readme', body: 'wrote about screenshots' });
  await m.remember({ kind: 'turn', summary: 'auth flow refactor done', body: 'split into module' });

  const r = await m.recall('auth bug login');
  assert.ok(r.length >= 1);
  assert.ok(r[0].summary.includes('auth'));
}

async function testRecallEmptyOnNothing() {
  const d = tmpDir();
  const m = new Memory({ dataDir: d });
  const r = await m.recall('anything');
  assert.deepStrictEqual(r, []);
}

async function testDisabledIsNoOp() {
  const d = tmpDir();
  const m = new Memory({ dataDir: d, enabled: false });
  const rec = await m.remember({ kind: 'turn', summary: 'x', body: 'y' });
  assert.strictEqual(rec, null);
  assert.deepStrictEqual(await m.recall('x'), []);
}

async function testTokenizerDropsStopwords() {
  const t = tokenize('The quick brown fox jumps over the lazy dog');
  assert.ok(!t.includes('the'));
  assert.ok(t.includes('quick'));
  assert.ok(t.includes('fox'));
}

async function testRecencyBoost() {
  const d = tmpDir();
  const m = new Memory({ dataDir: d });
  // Two records with identical text; only timestamps differ. The newer one should win.
  await m.remember({ kind: 'turn', summary: 'auth bug', body: '', ts: Date.now() - 60 * 86400000 });
  await m.remember({ kind: 'turn', summary: 'auth bug', body: '', ts: Date.now() });
  const r = await m.recall('auth bug', { limit: 1 });
  assert.strictEqual(r.length, 1);
  assert.ok(Math.abs(r[0].ts - Date.now()) < 60000);
}

async function run() {
  const tests = [
    ['remember/recall returns matching records', testRememberAndRecall],
    ['recall returns [] when nothing stored', testRecallEmptyOnNothing],
    ['disabled memory is a no-op', testDisabledIsNoOp],
    ['tokenizer drops stopwords', testTokenizerDropsStopwords],
    ['recency boosts identical matches', testRecencyBoost],
  ];
  let passed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}`); console.error('   ', err && err.stack ? err.stack : err); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
}

run();

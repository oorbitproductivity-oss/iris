// tests/router.test.js — Router unit + golden-prompt tests.
// Run: node tests/router.test.js

'use strict';

const assert = require('assert');
const { Router } = require('../lib/router');

const GOLDEN = [
  // manual
  ['rename foo to bar', 'manual'],
  ['rename this variable to snake_case', 'manual'],
  ['explain what this regex does', 'manual'],
  ['what is the syntax for an arrow function in TypeScript?', 'manual'],
  ['what does the spread operator do', 'manual'],
  ['summarize this paragraph', 'manual'],
  ['define encapsulation', 'manual'],
  ['tldr the readme', 'manual'],
  ['why does react re-render here', 'manual'],
  ['please explain the cap theorem', 'manual'],

  // quick-tool
  ['find every TODO in src/', 'quick-tool'],
  ['grep for the User type definition', 'quick-tool'],
  ['search for the error message in the repo', 'quick-tool'],
  ['list all files modified in the last commit', 'quick-tool'],
  ['run the tests', 'quick-tool'],
  ['run tests and show failures', 'quick-tool'],
  ['open the auth handler', 'quick-tool'],
  ['show me the function signature', 'quick-tool'],
  ['where is the login handler defined', 'quick-tool'],
  ['which file declares the Foo class', 'quick-tool'],

  // agentic
  ['build me the auth flow with email verification', 'agentic'],
  ['implement a search bar with debounce and tests', 'agentic'],
  ['scaffold a new express app', 'agentic'],
  ['set up the CI pipeline', 'agentic'],
  ['add a feature flag system', 'agentic'],
  ['add support for postgres', 'agentic'],
  ['wire up the websocket client', 'agentic'],
  ['migrate this to TypeScript', 'agentic'],
  ['port to vite', 'agentic'],
  ['refactor the whole router module to support streaming and add tests', 'agentic'],
];

async function testGoldenSet() {
  const r = new Router({ provider: null });
  let correct = 0;
  const wrong = [];
  for (const [text, expected] of GOLDEN) {
    const got = r.fastClassify(text);
    if (got === expected) correct++;
    else wrong.push(`  expected=${expected}  got=${got}  for "${text}"`);
  }
  const pct = (correct / GOLDEN.length) * 100;
  console.log(`  golden classifier: ${correct}/${GOLDEN.length} = ${pct.toFixed(0)}%`);
  if (wrong.length) console.log(wrong.join('\n'));
  assert.ok(pct >= 85, `golden routing accuracy ${pct}% < 85% target`);
}

async function testEmptyDefaults() {
  const r = new Router();
  // Empty/odd input falls through to default.
  const got = r.fastClassify('');
  assert.strictEqual(got, 'quick-tool');
}

async function testLLMFallback() {
  // When fastClassify returns null we expect the LLM path to run.
  const r = new Router({
    provider: {
      chat: () => (async function* () {
        yield { type: 'text', delta: 'agentic' };
        yield { type: 'stop', reason: 'end_turn' };
      })(),
    },
  });
  const got = await r.classify('please assist with this thing');
  assert.strictEqual(got, 'agentic');
}

async function testLLMTimeoutFallsBack() {
  const r = new Router({
    provider: { chat: () => (async function* () { throw new Error('network down'); })() },
  });
  const got = await r.classify('please assist with this thing');
  assert.strictEqual(got, 'quick-tool'); // DEFAULT_ROUTE
}

async function run() {
  const tests = [
    ['30-prompt golden set ≥85% accurate', testGoldenSet],
    ['empty input falls back to default', testEmptyDefaults],
    ['LLM fallback parses single-word reply', testLLMFallback],
    ['LLM error falls back to default route', testLLMTimeoutFallsBack],
  ];
  let passed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}`); console.error('   ', err && err.stack ? err.stack : err); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
}

run();

// tests/browser.test.js — BrowserTestRunner unit tests with a mocked RPC client.

'use strict';

const assert = require('assert');
const { BrowserTestRunner } = require('../lib/browser');

function fakeStore({ keys = [] } = {}) {
  return {
    getApiKeys() { return keys; },
    getApiKeyValue() { return null; },
  };
}

function fakeClient() {
  return {
    navigate: async () => ({ ok: true }),
    click: async () => ({ ok: true }),
    type: async () => ({ ok: true }),
    read: async ({ selector }) => ({ text: selector === '#list li' ? 'milk\nbread' : '' }),
    screenshot: async () => ({ ok: true, data: 'binary' }),
    console: async () => ({ logs: [] }),
  };
}

async function testPreflightFailsWithoutAnthropic() {
  const r = new BrowserTestRunner({ store: fakeStore({ keys: [] }), client: fakeClient() });
  const res = await r.runBrowserTask({ url: 'http://localhost:3000' });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /Anthropic API key/);
}

async function testAllowlistRejection() {
  const r = new BrowserTestRunner({ store: fakeStore({ keys: [{ name: 'anthropic' }] }), client: fakeClient() });
  const res = await r.runBrowserTask({ url: 'https://evil.example.com' });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /not allowed/);
}

async function testGoldenPath() {
  const r = new BrowserTestRunner({ store: fakeStore({ keys: [{ name: 'anthropic' }] }), client: fakeClient() });
  const res = await r.runBrowserTask({
    url: 'http://localhost:3000',
    steps: [
      { action: 'navigate', url: 'http://localhost:3000' },
      { action: 'type', selector: '#todo-input', text: 'milk' },
      { action: 'click', selector: '#add' },
    ],
    expect: [{ selector: '#list li', contains: 'milk' }],
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.result.ok, true);
  assert.strictEqual(res.result.expectations.length, 1);
  assert.strictEqual(res.result.expectations[0].pass, true);
}

async function testRecoverableRetries() {
  let calls = 0;
  const flakeyClient = {
    ...fakeClient(),
    navigate: async () => {
      calls++;
      if (calls < 2) throw new Error('extension not ready');
      return { ok: true };
    },
  };
  const r = new BrowserTestRunner({
    store: fakeStore({ keys: [{ name: 'anthropic' }] }),
    client: flakeyClient,
  });
  const res = await r.runBrowserTask({
    url: 'http://localhost:3000',
    steps: [{ action: 'navigate', url: 'http://localhost:3000' }],
    retries: 3,
  });
  assert.strictEqual(res.ok, true);
  assert.ok(calls >= 2);
}

async function testAddAllowedDomain() {
  const r = new BrowserTestRunner({ store: fakeStore({ keys: [{ name: 'anthropic' }] }), client: fakeClient() });
  r.addAllowedDomain('example.test');
  const res = await r.runBrowserTask({ url: 'http://api.example.test:8000', steps: [] });
  assert.strictEqual(res.ok, true);
}

async function run() {
  const tests = [
    ['preflight fails when no Anthropic key is configured', testPreflightFailsWithoutAnthropic],
    ['allowlist rejects non-local hosts', testAllowlistRejection],
    ['golden-path task passes', testGoldenPath],
    ['recoverable failures retry with backoff', testRecoverableRetries],
    ['addAllowedDomain extends the allowlist', testAddAllowedDomain],
  ];
  let passed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}`); console.error('   ', err && err.stack ? err.stack : err); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
}

run();

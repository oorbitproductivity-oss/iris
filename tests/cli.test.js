// tests/cli.test.js — CLI dispatcher + claude-runner unit tests.

'use strict';

const assert = require('assert');
const { parseArgs } = require('../lib/cli/dispatch.js');
const { buildArgs, normalize } = require('../lib/cli/claude-runner.js');

async function testParseArgsSimple() {
  const r = parseArgs(['chat', 'hi', '--cwd', '/tmp', '--hermes']);
  assert.deepStrictEqual(r._, ['chat', 'hi']);
  assert.strictEqual(r.flags.cwd, '/tmp');
  assert.strictEqual(r.flags.hermes, true);
}

async function testParseArgsEqualsForm() {
  const r = parseArgs(['run', '--model=gpt-4o', 'foo']);
  assert.strictEqual(r.flags.model, 'gpt-4o');
  assert.deepStrictEqual(r._, ['run', 'foo']);
}

async function testParseArgsDoubleDash() {
  const r = parseArgs(['exec', '--', '--something-that-looks-like-a-flag', '-x']);
  assert.deepStrictEqual(r._, ['exec', '--something-that-looks-like-a-flag', '-x']);
}

async function testParseArgsVersion() {
  assert.strictEqual(parseArgs(['--version']).flags.version, true);
  assert.strictEqual(parseArgs(['-v']).flags.version, true);
}

async function testBuildArgsHasSubscriptionDefaults() {
  const a = buildArgs({ prompt: 'hi' });
  assert.ok(a.includes('-p'));
  assert.ok(a.includes('--output-format'));
  assert.ok(a.includes('stream-json'));
  assert.ok(a.includes('--permission-mode'));
  const i = a.indexOf('--permission-mode');
  assert.strictEqual(a[i + 1], 'bypassPermissions');
  assert.ok(a.includes('--effort'));
}

async function testBuildArgsRespectsOverrides() {
  const a = buildArgs({
    prompt: 'hi',
    permissionMode: 'plan',
    model: 'claude-opus-4-7',
    effort: 'low',
    sessionId: 'abc-123',
    tools: ['Bash', 'Read'],
    addDirs: ['/extra'],
    appendSystem: 'extra',
  });
  assert.ok(a.includes('plan'));
  assert.ok(a.includes('claude-opus-4-7'));
  assert.ok(a.includes('low'));
  assert.ok(a.includes('abc-123'));
  const ti = a.indexOf('--tools');
  assert.strictEqual(a[ti + 1], 'Bash,Read');
  const adi = a.indexOf('--add-dir');
  assert.strictEqual(a[adi + 1], '/extra');
  assert.ok(a.includes('--append-system-prompt'));
}

async function testNormalizeAssistantText() {
  const evts = normalize({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'hello' }] },
  });
  assert.strictEqual(evts.length, 1);
  assert.strictEqual(evts[0].type, 'text');
  assert.strictEqual(evts[0].delta, 'hello');
}

async function testNormalizeToolUse() {
  const evts = normalize({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
  });
  assert.strictEqual(evts[0].type, 'tool_use');
  assert.strictEqual(evts[0].name, 'Bash');
  assert.deepStrictEqual(evts[0].input, { command: 'ls' });
}

async function testNormalizeToolResult() {
  const evts = normalize({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'hi' }] },
  });
  assert.strictEqual(evts[0].type, 'tool_result');
  assert.strictEqual(evts[0].id, 't1');
}

async function testNormalizeUsageAndCost() {
  const evts = normalize({
    type: 'result',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 25 },
    total_cost_usd: 0.0012,
  });
  const usage = evts.find((e) => e.type === 'usage');
  const cost = evts.find((e) => e.type === 'cost');
  assert.strictEqual(usage.input_tokens, 100);
  assert.strictEqual(usage.output_tokens, 50);
  assert.strictEqual(usage.cache_read, 25);
  assert.strictEqual(cost.usd, 0.0012);
}

async function testNormalizeSessionId() {
  const evts = normalize({ type: 'system', session_id: 'sess-9' });
  assert.strictEqual(evts[0].type, 'session');
  assert.strictEqual(evts[0].id, 'sess-9');
}

async function testNormalizePartialDelta() {
  const evts = normalize({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
  });
  assert.strictEqual(evts[0].type, 'text');
  assert.strictEqual(evts[0].delta, 'partial');
  assert.strictEqual(evts[0].partial, true);
}

async function run() {
  const tests = [
    ['parseArgs: simple positionals + flags', testParseArgsSimple],
    ['parseArgs: --key=value form', testParseArgsEqualsForm],
    ['parseArgs: -- ends flag parsing', testParseArgsDoubleDash],
    ['parseArgs: --version / -v', testParseArgsVersion],
    ['buildArgs: subscription defaults (bypassPermissions, stream-json)', testBuildArgsHasSubscriptionDefaults],
    ['buildArgs: overrides flow through', testBuildArgsRespectsOverrides],
    ['normalize: assistant text', testNormalizeAssistantText],
    ['normalize: tool_use', testNormalizeToolUse],
    ['normalize: tool_result from user role', testNormalizeToolResult],
    ['normalize: usage + cost from result event', testNormalizeUsageAndCost],
    ['normalize: session id from system event', testNormalizeSessionId],
    ['normalize: partial text delta', testNormalizePartialDelta],
  ];
  let passed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}`); console.error('   ', err && err.stack ? err.stack : err); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
}

run();

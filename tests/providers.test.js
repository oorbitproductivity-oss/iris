// tests/providers.test.js
//
// Unit tests for provider adapters using the mock fetch transport.
// Run: `node tests/providers.test.js`

'use strict';

const assert = require('assert');
const { createProvider, KNOWN_PROVIDERS, DEFAULT_MODELS } = require('../lib/providers');
const { mockFetch } = require('./_helpers/mock-fetch.js');

async function collect(stream) {
  const events = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

async function testFactoryAcceptsKnown() {
  for (const name of KNOWN_PROVIDERS) {
    const p = createProvider({ name, apiKey: 'x', fetchImpl: () => { throw new Error('unused'); } });
    assert.strictEqual(p.name, name);
    assert.ok(p.model === DEFAULT_MODELS[name]);
  }
}

async function testFactoryRejectsUnknown() {
  assert.throws(() => createProvider({ name: 'nope' }));
}

async function testAnthropicStream() {
  const fetchImpl = mockFetch([
    {
      match: /\/v1\/messages$/,
      sse: [
        { type: 'message_start', message: {} },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', usage: { input_tokens: 3, output_tokens: 2 } },
        { type: 'message_stop' },
      ],
    },
  ]);
  const p = createProvider({ name: 'anthropic', apiKey: 'x', fetchImpl });
  const events = await collect(p.chat({ messages: [{ role: 'user', content: 'hi' }] }));
  const text = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
  assert.strictEqual(text, 'Hello world');
  const usage = events.find((e) => e.type === 'usage');
  assert.deepStrictEqual({ in: usage.input_tokens, out: usage.output_tokens }, { in: 3, out: 2 });
  assert.ok(events.some((e) => e.type === 'stop' && e.reason === 'end_turn'));
}

async function testAnthropicToolUse() {
  const fetchImpl = mockFetch([
    {
      match: /\/v1\/messages$/,
      sse: [
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'lookup' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"hello"}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_stop' },
      ],
    },
  ]);
  const p = createProvider({ name: 'anthropic', apiKey: 'x', fetchImpl });
  const events = await collect(p.chat({ messages: [{ role: 'user', content: 'hi' }] }));
  const tu = events.find((e) => e.type === 'tool_use');
  assert.strictEqual(tu.name, 'lookup');
  assert.deepStrictEqual(tu.input, { q: 'hello' });
}

async function testOpenAIStream() {
  const fetchImpl = mockFetch([
    {
      match: /\/v1\/chat\/completions$/,
      sse: [
        { choices: [{ delta: { content: 'foo' }, finish_reason: null }] },
        { choices: [{ delta: { content: 'bar' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
      ],
    },
  ]);
  const p = createProvider({ name: 'openai', apiKey: 'x', fetchImpl });
  const events = await collect(p.chat({ messages: [{ role: 'user', content: 'hi' }] }));
  const text = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
  assert.strictEqual(text, 'foobar');
}

async function testOpenAIToolUseAccretes() {
  const fetchImpl = mockFetch([
    {
      match: /\/v1\/chat\/completions$/,
      sse: [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'search', arguments: '{"q":"' } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'iris"}' } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ],
    },
  ]);
  const p = createProvider({ name: 'openai', apiKey: 'x', fetchImpl });
  const events = await collect(p.chat({ messages: [{ role: 'user', content: 'hi' }] }));
  const tu = events.find((e) => e.type === 'tool_use');
  assert.strictEqual(tu.name, 'search');
  assert.deepStrictEqual(tu.input, { q: 'iris' });
  assert.ok(events.some((e) => e.type === 'stop' && e.reason === 'tool_use'));
}

async function testOpenRouterAddsHeaders() {
  let captured = null;
  const inner = (url, init) => { captured = init.headers; return { ok: true, status: 200, async text() { return ''; }, body: null }; };
  const p = createProvider({ name: 'openrouter', apiKey: 'x', fetchImpl: inner });
  // Touch fetchImpl directly with a simple GET via .test() which uses /v1/models.
  await p.test().catch(() => {});
  // The inner fetch should have been called with the OpenRouter headers wrapped in.
  assert.ok(captured, 'inner fetch should have run');
  assert.ok(captured.get('http-referer'));
  assert.ok(captured.get('x-title'));
}

async function testOllamaNdjson() {
  const fetchImpl = mockFetch([
    {
      match: /\/api\/chat$/,
      ndjson: [
        { message: { role: 'assistant', content: 'hi ' } },
        { message: { role: 'assistant', content: 'there' } },
        { done: true, prompt_eval_count: 5, eval_count: 2 },
      ],
    },
  ]);
  const p = createProvider({ name: 'ollama', apiKey: '', fetchImpl });
  const events = await collect(p.chat({ messages: [{ role: 'user', content: 'hi' }] }));
  const text = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
  assert.strictEqual(text, 'hi there');
  const usage = events.find((e) => e.type === 'usage');
  assert.deepStrictEqual({ in: usage.input_tokens, out: usage.output_tokens }, { in: 5, out: 2 });
}

async function testGoogleStream() {
  const fetchImpl = mockFetch([
    {
      match: /streamGenerateContent/,
      sse: [
        { candidates: [{ content: { parts: [{ text: 'Gemini ' }] }, finishReason: null }] },
        { candidates: [{ content: { parts: [{ text: 'rocks' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 } },
      ],
    },
  ]);
  const p = createProvider({ name: 'google', apiKey: 'x', fetchImpl });
  const events = await collect(p.chat({ messages: [{ role: 'user', content: 'hi' }] }));
  const text = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
  assert.strictEqual(text, 'Gemini rocks');
  assert.ok(events.some((e) => e.type === 'stop' && e.reason === 'end_turn'));
}

async function testErrorsAreCaught() {
  const fetchImpl = () => { throw new Error('boom'); };
  const p = createProvider({ name: 'anthropic', apiKey: 'x', fetchImpl });
  const events = await collect(p.chat({ messages: [{ role: 'user', content: 'hi' }] }));
  assert.ok(events.some((e) => e.type === 'error'));
  assert.ok(events.some((e) => e.type === 'stop' && e.reason === 'error'));
}

async function run() {
  const tests = [
    ['factory accepts known providers', testFactoryAcceptsKnown],
    ['factory rejects unknown providers', testFactoryRejectsUnknown],
    ['anthropic text stream', testAnthropicStream],
    ['anthropic tool_use accretes input_json', testAnthropicToolUse],
    ['openai text stream', testOpenAIStream],
    ['openai tool_calls accrete arguments', testOpenAIToolUseAccretes],
    ['openrouter wraps fetch with extra headers', testOpenRouterAddsHeaders],
    ['ollama ndjson stream', testOllamaNdjson],
    ['google sse stream', testGoogleStream],
    ['errors are caught and become events', testErrorsAreCaught],
  ];
  let passed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error('   ', err && err.stack ? err.stack : err);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed}/${tests.length} passed`);
}

run();

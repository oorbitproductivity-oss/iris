// tests/terminal.test.js — PtyManager unit tests.
// Run: node tests/terminal.test.js
//
// We don't actually spawn a PTY (node-pty isn't installed in CI; the
// whole point of PtyManager's graceful-degradation path is that it
// works in that environment). Instead we inject a fake node-pty via
// the requireFn hook, plus exercise the ring buffer and listing logic
// directly.

'use strict';

const assert = require('assert');
const { PtyManager, RingBuffer, MAX_BUFFER_LINES } = require('../lib/terminal/pty-manager');

// ──────────────────────────────────────────────────────────────
// Fake node-pty for tests
// ──────────────────────────────────────────────────────────────
function makeFakePty() {
  const procs = [];
  const fake = {
    spawn(shell, args, opts) {
      const dataHandlers = [];
      const exitHandlers = [];
      const writes = [];
      const proc = {
        _writes: writes,
        _opts: opts,
        _shell: shell,
        cols: (opts && opts.cols) || 80,
        rows: (opts && opts.rows) || 24,
        onData(cb) { dataHandlers.push(cb); },
        onExit(cb) { exitHandlers.push(cb); },
        write(chunk) { writes.push(chunk); },
        resize(c, r) { proc.cols = c; proc.rows = r; },
        kill() {
          for (const cb of exitHandlers) {
            try { cb({ exitCode: 0, signal: null }); } catch {}
          }
        },
        _emitData(chunk) {
          for (const cb of dataHandlers) {
            try { cb(chunk); } catch {}
          }
        },
        _emitExit(payload = { exitCode: 0, signal: null }) {
          for (const cb of exitHandlers) {
            try { cb(payload); } catch {}
          }
        },
      };
      procs.push(proc);
      return proc;
    },
  };
  return { fake, procs };
}

function requireWith(map) {
  return function fakeRequire(name) {
    if (Object.prototype.hasOwnProperty.call(map, name)) {
      const v = map[name];
      if (v instanceof Error) throw v;
      return v;
    }
    // Fall back to real require for anything else.
    return require(name);
  };
}

// ──────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────

async function testUnavailableWhenNodePtyMissing() {
  // Simulate the "node-pty isn't installed" case.
  const mgr = new PtyManager({
    requireFn: requireWith({ 'node-pty': new Error("Cannot find module 'node-pty'") }),
  });
  assert.strictEqual(mgr.isAvailable(), false, 'isAvailable should be false');
  const create = mgr.create({ agentId: 'a1' });
  assert.strictEqual(create.ok, false, 'create should refuse');
  assert.ok(create.error, 'create should return an error string');
  assert.deepStrictEqual(mgr.list(), [], 'list should be empty');
  // history/kill on bogus id should not throw and should return a structured response
  const hist = mgr.getHistory('bogus');
  assert.strictEqual(hist.ok, false, 'getHistory on unknown id should be { ok: false }');
}

async function testUnavailableWhenNodePtyHasNoSpawn() {
  // Loaded but missing the spawn() function.
  const mgr = new PtyManager({ requireFn: requireWith({ 'node-pty': {} }) });
  assert.strictEqual(mgr.isAvailable(), false);
  assert.match(mgr.unavailableReason() || '', /spawn/i);
}

async function testCreateListAndFilterByAgent() {
  const { fake, procs } = makeFakePty();
  const events = [];
  const mgr = new PtyManager({
    requireFn: requireWith({ 'node-pty': fake }),
    broadcast: (e) => events.push(e),
  });
  assert.strictEqual(mgr.isAvailable(), true);

  const r1 = mgr.create({ agentId: 'a1', cwd: process.cwd() });
  const r2 = mgr.create({ agentId: 'a1', cwd: process.cwd() });
  const r3 = mgr.create({ agentId: 'a2', cwd: process.cwd() });
  assert.ok(r1.ok && r2.ok && r3.ok, 'all three creates should succeed');
  assert.ok(r1.terminalId && r2.terminalId && r3.terminalId, 'terminalIds should be assigned');

  const all = mgr.list();
  assert.strictEqual(all.length, 3, 'list() should return all three terminals');

  const a1 = mgr.list({ agentId: 'a1' });
  assert.strictEqual(a1.length, 2, 'agentId filter should narrow to two');
  for (const t of a1) assert.strictEqual(t.agentId, 'a1');

  const a2 = mgr.list({ agentId: 'a2' });
  assert.strictEqual(a2.length, 1, 'agentId filter should narrow to one');
  assert.strictEqual(a2[0].agentId, 'a2');

  // Emit some data and verify the broadcast carries the right shape.
  procs[0]._emitData('hello\n');
  const dataEvent = events.find((e) => e.type === 'terminal:data');
  assert.ok(dataEvent, 'should have broadcast a terminal:data event');
  assert.strictEqual(dataEvent.terminalId, r1.terminalId);
  assert.strictEqual(dataEvent.data, 'hello\n');

  // Emit an exit and verify shape.
  procs[2]._emitExit({ exitCode: 137, signal: 'SIGKILL' });
  const exitEvent = events.find((e) => e.type === 'terminal:exit' && e.terminalId === r3.terminalId);
  assert.ok(exitEvent, 'should have broadcast a terminal:exit event');
  assert.strictEqual(exitEvent.code, 137);
  assert.strictEqual(exitEvent.signal, 'SIGKILL');

  // shutdown cleans up everything.
  mgr.shutdown();
  assert.strictEqual(mgr.list().length, 0, 'shutdown should clear all terminals');
}

async function testGetHistoryGracefulForUnknownId() {
  const { fake } = makeFakePty();
  const mgr = new PtyManager({ requireFn: requireWith({ 'node-pty': fake }) });
  const r = mgr.getHistory('does-not-exist', 50);
  assert.strictEqual(r.ok, false, 'should return ok:false');
  assert.ok(r.error, 'should include an error string');
}

async function testGetHistoryReturnsBufferedLines() {
  const { fake, procs } = makeFakePty();
  const mgr = new PtyManager({ requireFn: requireWith({ 'node-pty': fake }) });
  const r = mgr.create({ agentId: 'a1' });
  procs[0]._emitData('line one\nline two\nline three\n');
  const hist = mgr.getHistory(r.terminalId, 10);
  assert.strictEqual(hist.ok, true);
  assert.deepStrictEqual(hist.lines, ['line one', 'line two', 'line three']);
}

async function testRingBufferCapsAt10000Lines() {
  const ring = new RingBuffer(); // default = MAX_BUFFER_LINES = 10_000
  assert.strictEqual(MAX_BUFFER_LINES, 10000, 'cap constant should be 10000');
  // Push 10,500 lines.
  let chunk = '';
  for (let i = 0; i < 10500; i++) chunk += `line ${i}\n`;
  ring.push(chunk);
  assert.strictEqual(ring.size(), 10000, 'ring buffer should cap at 10,000 lines');
  // The OLDEST 500 lines should be gone; the NEWEST line should be last.
  const tail1 = ring.tail(1);
  assert.deepStrictEqual(tail1, ['line 10499']);
  // tail(10000) should be the most-recent 10000 entries.
  const tailAll = ring.tail(10000);
  assert.strictEqual(tailAll.length, 10000);
  assert.strictEqual(tailAll[0], 'line 500');
  assert.strictEqual(tailAll[tailAll.length - 1], 'line 10499');
}

async function testRingBufferIncludesPartialLine() {
  const ring = new RingBuffer(10);
  ring.push('alpha\nbeta\ngamma'); // gamma has no trailing newline
  const t = ring.tail(5);
  assert.deepStrictEqual(t, ['alpha', 'beta', 'gamma'],
    'partial trailing chunk should be included in tail()');
  // Once finished by a later newline, it merges cleanly.
  ring.push(' continues\n');
  const t2 = ring.tail(5);
  assert.deepStrictEqual(t2, ['alpha', 'beta', 'gamma continues']);
}

async function testWriteResizeKillOnLiveTerminal() {
  const { fake, procs } = makeFakePty();
  const mgr = new PtyManager({ requireFn: requireWith({ 'node-pty': fake }) });
  const r = mgr.create({ agentId: 'a1' });
  assert.ok(mgr.write(r.terminalId, 'echo hi\r'), 'write should succeed on live terminal');
  assert.deepStrictEqual(procs[0]._writes, ['echo hi\r']);

  assert.ok(mgr.resize(r.terminalId, 132, 50), 'resize should succeed');
  assert.strictEqual(procs[0].cols, 132);
  assert.strictEqual(procs[0].rows, 50);

  assert.ok(mgr.kill(r.terminalId), 'kill should succeed');
  // After kill, the underlying entry is marked exited; further writes silently no-op.
  assert.strictEqual(mgr.write(r.terminalId, 'late'), false);
}

async function testWriteResizeNoOpOnUnknownId() {
  const { fake } = makeFakePty();
  const mgr = new PtyManager({ requireFn: requireWith({ 'node-pty': fake }) });
  assert.strictEqual(mgr.write('nope', 'x'), false);
  assert.strictEqual(mgr.resize('nope', 80, 24), false);
  assert.strictEqual(mgr.kill('nope'), false);
}

// ──────────────────────────────────────────────────────────────
// Runner
// ──────────────────────────────────────────────────────────────
async function run() {
  const tests = [
    ['isAvailable() is false when node-pty fails to load', testUnavailableWhenNodePtyMissing],
    ['isAvailable() is false when node-pty has no spawn()', testUnavailableWhenNodePtyHasNoSpawn],
    ['create + list + agentId filter + broadcast events', testCreateListAndFilterByAgent],
    ['getHistory() returns ok:false for unknown terminalId', testGetHistoryGracefulForUnknownId],
    ['getHistory() returns buffered lines', testGetHistoryReturnsBufferedLines],
    ['ring buffer caps at 10,000 lines', testRingBufferCapsAt10000Lines],
    ['ring buffer includes a trailing partial line', testRingBufferIncludesPartialLine],
    ['write/resize/kill on live terminal', testWriteResizeKillOnLiveTerminal],
    ['write/resize/kill no-op on unknown terminalId', testWriteResizeNoOpOnUnknownId],
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

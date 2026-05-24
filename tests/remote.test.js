// tests/remote.test.js — Tests for the remote-access server, fs-browser, and
// claude-md-memory helpers added for the iris-mobile companion app.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const remoteServer = require('../lib/server.js');
const fsBrowser = require('../lib/fs-browser.js');
const claudeMdMemory = require('../lib/claude-md-memory.js');

// ── Helpers ──

function makeTempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-remote-test-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'README.md'), '# hello world');
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'console.log(42);');
  fs.writeFileSync(path.join(dir, 'src', 'binary.bin'), Buffer.from([0, 1, 2, 0, 3]));
  fs.writeFileSync(path.join(dir, 'node_modules', 'junk.js'), 'should be ignored');
  return dir;
}

function rmTempWorkspace(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function jsonGet(port, path, token) {
  return new Promise((resolve, reject) => {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const r = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json;
        try { json = JSON.parse(buf); } catch { json = buf; }
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

function jsonPost(port, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = http.request({ method: 'POST', host: '127.0.0.1', port, path, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json;
        try { json = JSON.parse(buf); } catch { json = buf; }
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('error', reject);
    r.write(data);
    r.end();
  });
}

let nextPort = 19000;
function pickPort() { return nextPort++; }

// ── fs-browser tests ──

async function testFsBrowserAllowsDescendant() {
  const root = makeTempWorkspace();
  try {
    const target = path.join(root, 'src', 'index.js');
    assert.strictEqual(fsBrowser.isPathUnder(target, root), true);
    assert.strictEqual(fsBrowser.isPathUnder(root, root), true);
  } finally { rmTempWorkspace(root); }
}

async function testFsBrowserRejectsTraversal() {
  const root = makeTempWorkspace();
  try {
    const outside = path.resolve(root, '..');
    assert.strictEqual(fsBrowser.isPathUnder(outside, root), false);
  } finally { rmTempWorkspace(root); }
}

async function testListTreeIgnoresNodeModules() {
  const root = makeTempWorkspace();
  try {
    const result = fsBrowser.listTree(root, { roots: [root], depth: 2 });
    assert.strictEqual(result.ok, true);
    const childNames = (result.tree.children || []).map((c) => c.name);
    assert.ok(childNames.includes('src'), 'src should appear');
    assert.ok(childNames.includes('README.md'), 'README.md should appear');
    assert.ok(!childNames.includes('node_modules'), 'node_modules should be hidden');
  } finally { rmTempWorkspace(root); }
}

async function testListTreeDirsBeforeFiles() {
  const root = makeTempWorkspace();
  try {
    const result = fsBrowser.listTree(root, { roots: [root], depth: 1 });
    const types = (result.tree.children || []).map((c) => c.type);
    const firstFile = types.indexOf('file');
    const lastDir = types.lastIndexOf('dir');
    if (firstFile !== -1 && lastDir !== -1) {
      assert.ok(lastDir < firstFile, 'dirs should sort before files');
    }
  } finally { rmTempWorkspace(root); }
}

async function testListTreeNotAllowed() {
  const root = makeTempWorkspace();
  try {
    const result = fsBrowser.listTree('/etc', { roots: [root], depth: 1 });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'not_allowed');
  } finally { rmTempWorkspace(root); }
}

async function testReadFileText() {
  const root = makeTempWorkspace();
  try {
    const result = fsBrowser.readFileForRemote(
      path.join(root, 'README.md'),
      { roots: [root] },
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.encoding, 'utf8');
    assert.strictEqual(result.content, '# hello world');
  } finally { rmTempWorkspace(root); }
}

async function testReadFileBinary() {
  const root = makeTempWorkspace();
  try {
    const result = fsBrowser.readFileForRemote(
      path.join(root, 'src', 'binary.bin'),
      { roots: [root] },
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.encoding, 'base64');
    // Round-trip the content
    const decoded = Buffer.from(result.content, 'base64');
    assert.deepStrictEqual([...decoded], [0, 1, 2, 0, 3]);
  } finally { rmTempWorkspace(root); }
}

async function testReadFileTooLarge() {
  const root = makeTempWorkspace();
  try {
    const big = path.join(root, 'big.bin');
    fs.writeFileSync(big, Buffer.alloc(fsBrowser.MAX_FILE_BYTES + 1, 'a'));
    const result = fsBrowser.readFileForRemote(big, { roots: [root] });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'too_large');
  } finally { rmTempWorkspace(root); }
}

// ── claude-md-memory tests ──

async function testReadMemoryMissing() {
  const root = makeTempWorkspace();
  try {
    const r = claudeMdMemory.readMemory(root);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.existed, false);
    assert.strictEqual(r.content, '');
  } finally { rmTempWorkspace(root); }
}

async function testWriteThenReadMemory() {
  const root = makeTempWorkspace();
  try {
    const w = claudeMdMemory.writeMemory(root, '# project notes');
    assert.strictEqual(w.ok, true);
    const r = claudeMdMemory.readMemory(root);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.existed, true);
    assert.strictEqual(r.content, '# project notes');
  } finally { rmTempWorkspace(root); }
}

async function testMemoryRejectsRelative() {
  const r = claudeMdMemory.readMemory('relative/path');
  assert.strictEqual(r.ok, false);
}

// ── Server tests ──

async function withServer(opts, fn) {
  const port = pickPort();
  await remoteServer.startServer({ port, host: '127.0.0.1', ...opts });
  try {
    await fn(port);
  } finally {
    await remoteServer.stopServer();
  }
}

async function testHealthUnauthenticated() {
  await withServer(
    { manager: null, store: null, version: '1.2.3', getAuth: () => ({ enabled: false, token: null }) },
    async (port) => {
      const r = await jsonGet(port, '/health');
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.ok, true);
      assert.strictEqual(r.json.version, '1.2.3');
      assert.strictEqual(r.json.requiresToken, false);
    },
  );
}

async function testApiRequiresToken() {
  await withServer(
    { manager: null, store: null, version: 't', getAuth: () => ({ enabled: true, token: 'abc' }) },
    async (port) => {
      const r1 = await jsonGet(port, '/api/v1/app/version');
      assert.strictEqual(r1.status, 401);
      const r2 = await jsonGet(port, '/api/v1/app/version', 'wrong');
      assert.strictEqual(r2.status, 401);
      const r3 = await jsonGet(port, '/api/v1/app/version', 'abc');
      assert.strictEqual(r3.status, 200);
      assert.strictEqual(r3.json.version, 't');
    },
  );
}

async function testApi503WhenDisabled() {
  await withServer(
    { manager: null, store: null, version: 't', getAuth: () => ({ enabled: false, token: 'abc' }) },
    async (port) => {
      const r = await jsonGet(port, '/api/v1/app/version', 'abc');
      assert.strictEqual(r.status, 503);
      // Health still works when disabled.
      const h = await jsonGet(port, '/health');
      assert.strictEqual(h.status, 200);
      assert.strictEqual(h.json.requiresToken, false);
    },
  );
}

async function testAgentsRoute() {
  const root = makeTempWorkspace();
  try {
    const mockManager = {
      list: () => [{ id: 'a1', name: 'A1', cwd: root, model: 'sonnet', status: 'idle', sandboxDir: null }],
      get: (id) => id === 'a1' ? { id, name: 'A1', cwd: root, messages: [{ role: 'user', text: 'hi', ts: 1 }] } : null,
      sendMessage: () => {},
      stop: () => {},
      resume: () => {},
    };
    await withServer(
      { manager: mockManager, store: null, version: 't', getAuth: () => ({ enabled: true, token: 'tok' }) },
      async (port) => {
        const r = await jsonGet(port, '/api/v1/agents', 'tok');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json.agents.length, 1);
        assert.strictEqual(r.json.agents[0].id, 'a1');

        const r2 = await jsonGet(port, '/api/v1/agents/a1', 'tok');
        assert.strictEqual(r2.status, 200);
        assert.strictEqual(r2.json.agent.messages.length, 1);

        const r3 = await jsonGet(port, '/api/v1/agents/missing', 'tok');
        assert.strictEqual(r3.status, 404);
      },
    );
  } finally { rmTempWorkspace(root); }
}

async function testFsRoutesScopedToAgents() {
  const root = makeTempWorkspace();
  try {
    const mockManager = {
      list: () => [{ id: 'a1', name: 'A1', cwd: root, sandboxDir: null }],
      get: () => null,
      sendMessage: () => {}, stop: () => {}, resume: () => {},
    };
    await withServer(
      { manager: mockManager, store: null, version: 't', getAuth: () => ({ enabled: true, token: 'tok' }) },
      async (port) => {
        const tree = await jsonGet(port, '/api/v1/fs/tree?cwd=' + encodeURIComponent(root), 'tok');
        assert.strictEqual(tree.status, 200);
        assert.strictEqual(tree.json.ok, true);

        // Trying to read outside the agent root should be forbidden.
        const forbidden = await jsonGet(
          port,
          '/api/v1/fs/file?path=' + encodeURIComponent(path.join(os.tmpdir(), 'unrelated.txt')),
          'tok',
        );
        assert.strictEqual(forbidden.status, 403);
      },
    );
  } finally { rmTempWorkspace(root); }
}

async function testMutationsCallManager() {
  const root = makeTempWorkspace();
  try {
    const calls = { send: null, stop: null, resume: null };
    const mockManager = {
      list: () => [{ id: 'a1', name: 'A1', cwd: root, sandboxDir: null }],
      get: (id) => id === 'a1' ? { id, name: 'A1', cwd: root, messages: [] } : null,
      sendMessage: (id, msg) => { calls.send = { id, msg }; },
      stop: (id) => { calls.stop = id; },
      resume: (id) => { calls.resume = id; },
    };
    await withServer(
      { manager: mockManager, store: null, version: 't', getAuth: () => ({ enabled: true, token: 'tok' }) },
      async (port) => {
        // Send message
        const s = await jsonPost(port, '/api/v1/agents/a1/messages', { message: 'hi there' }, 'tok');
        assert.strictEqual(s.status, 200);
        assert.deepStrictEqual(calls.send, { id: 'a1', msg: 'hi there' });

        // Empty message rejected
        const e = await jsonPost(port, '/api/v1/agents/a1/messages', { message: '   ' }, 'tok');
        assert.strictEqual(e.status, 400);

        // Unknown agent
        const u = await jsonPost(port, '/api/v1/agents/none/messages', { message: 'x' }, 'tok');
        assert.strictEqual(u.status, 404);

        // Stop
        const st = await jsonPost(port, '/api/v1/agents/a1/stop', {}, 'tok');
        assert.strictEqual(st.status, 200);
        assert.strictEqual(calls.stop, 'a1');
      },
    );
  } finally { rmTempWorkspace(root); }
}

// ── Runner ──

async function run() {
  const tests = [
    ['fs-browser: descendant under root', testFsBrowserAllowsDescendant],
    ['fs-browser: traversal blocked', testFsBrowserRejectsTraversal],
    ['fs-browser: listTree hides node_modules', testListTreeIgnoresNodeModules],
    ['fs-browser: listTree sorts dirs before files', testListTreeDirsBeforeFiles],
    ['fs-browser: listTree refuses outside roots', testListTreeNotAllowed],
    ['fs-browser: readFile returns utf8 for text', testReadFileText],
    ['fs-browser: readFile returns base64 for binary', testReadFileBinary],
    ['fs-browser: readFile blocks files >1MB', testReadFileTooLarge],
    ['claude-md-memory: missing file -> {existed:false}', testReadMemoryMissing],
    ['claude-md-memory: write then read round-trip', testWriteThenReadMemory],
    ['claude-md-memory: relative cwd rejected', testMemoryRejectsRelative],
    ['server: /health is unauthenticated', testHealthUnauthenticated],
    ['server: /api requires bearer token', testApiRequiresToken],
    ['server: /api returns 503 when remote access disabled', testApi503WhenDisabled],
    ['server: agents list/get routes', testAgentsRoute],
    ['server: fs routes scoped to agent roots', testFsRoutesScopedToAgents],
    ['server: POST mutations call the manager', testMutationsCallManager],
  ];
  let passed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}`); console.error('   ', err && err.stack ? err.stack : err); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
}

run();

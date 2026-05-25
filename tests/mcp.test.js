// tests/mcp.test.js — MCP marketplace unit tests.
// Run: node tests/mcp.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { Registry, loadBundled, mergeCatalogs } = require('../lib/mcp/registry');
const { Installer } = require('../lib/mcp/installer');
const { Store } = require('../lib/store');

function tmpDir() {
  const d = path.join(os.tmpdir(), 'iris-mcp-' + crypto.randomBytes(8).toString('hex'));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const cleanupDirs = [];
function trackDir(d) {
  cleanupDirs.push(d);
  return d;
}

function cleanupAll() {
  for (const d of cleanupDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
}

async function testBundledLoads() {
  const bundled = loadBundled();
  assert.ok(bundled && typeof bundled === 'object', 'bundled should be an object');
  assert.ok(Array.isArray(bundled.servers), 'bundled.servers should be an array');
  assert.strictEqual(bundled.servers.length, 8, 'expected exactly 8 bundled servers');
  for (const s of bundled.servers) {
    assert.ok(typeof s.slug === 'string' && s.slug.length > 0, `slug missing on ${JSON.stringify(s)}`);
    assert.ok(typeof s.name === 'string' && s.name.length > 0, `name missing on ${s.slug}`);
    assert.ok(typeof s.command === 'string' && s.command.length > 0, `command missing on ${s.slug}`);
    assert.ok(Array.isArray(s.args), `args missing on ${s.slug}`);
  }
}

async function testMergeCatalogsPrecedence() {
  const bundled = {
    version: 1,
    servers: [
      { slug: 'x', name: 'X', command: 'good', args: ['a'], description: 'old desc' },
    ],
  };
  const remote = {
    version: 2,
    servers: [
      { slug: 'x', name: 'X-evil', command: 'evil', args: ['payload'], description: 'new desc' },
    ],
  };
  const merged = mergeCatalogs(bundled, remote);
  const x = merged.servers.find((s) => s.slug === 'x');
  assert.ok(x, 'merged catalog should keep slug x');
  assert.strictEqual(x.command, 'good', 'command must NOT be overridable by remote');
  assert.deepStrictEqual(x.args, ['a'], 'args must NOT be overridable by remote');
  assert.strictEqual(x.description, 'new desc', 'description should be refreshed from remote');
  assert.strictEqual(x.source, 'bundled', 'bundled entry should retain source: bundled');
}

async function testMergeCatalogsRemoteAddsNew() {
  const bundled = {
    version: 1,
    servers: [
      { slug: 'x', name: 'X', command: 'good', args: ['a'] },
    ],
  };
  const remote = {
    version: 2,
    servers: [
      { slug: 'x', name: 'X', command: 'evil', args: ['payload'], description: 'new desc' },
      { slug: 'y', name: 'Y', command: 'npx', args: ['-y', 'something'], description: 'new server' },
    ],
  };
  const merged = mergeCatalogs(bundled, remote);
  const y = merged.servers.find((s) => s.slug === 'y');
  assert.ok(y, 'merged catalog should include new slug y from remote');
  assert.strictEqual(y.source, 'remote', 'new entry should be marked as source: remote');
  assert.strictEqual(y.command, 'npx');
}

async function testStoreMcpSecretRoundTrip() {
  const dir = trackDir(tmpDir());
  const store = new Store(dir);
  const rec = store.addMcpSecret({ name: 'github/PAT', value: 'ghp_abc' });
  assert.ok(rec && rec.id, 'addMcpSecret should return a record with an id');
  assert.strictEqual(rec.name, 'github/PAT');
  assert.ok(typeof rec.hint === 'string' && rec.hint.length > 0, 'record should have a hint');
  assert.ok(!('value' in rec), 'returned record must not include plaintext value');
  assert.ok(!('ciphertext' in rec), 'returned record must not include ciphertext');

  assert.strictEqual(store.getMcpSecretValue(rec.id), 'ghp_abc');

  const list = store.getMcpSecrets();
  assert.strictEqual(list.length, 1);
  const summary = list[0];
  assert.strictEqual(summary.id, rec.id);
  assert.strictEqual(summary.name, 'github/PAT');
  assert.ok(typeof summary.hint === 'string' && summary.hint.length > 0);
  assert.ok(!('value' in summary), 'public summary must not include value');
  assert.ok(!('ciphertext' in summary), 'public summary must not include ciphertext');

  assert.strictEqual(store.deleteMcpSecret(rec.id), true);
  assert.deepStrictEqual(store.getMcpSecrets(), []);
  assert.strictEqual(store.getMcpSecretValue(rec.id), null);
}

async function testInstallerInstallListUninstall() {
  const dir = trackDir(tmpDir());
  const store = new Store(dir);
  const registry = new Registry(dir);
  const installer = new Installer({ dataDir: dir, registry, store });

  const rec = installer.install({ slug: 'playwright', scope: 'global' });
  assert.ok(rec && rec.id, 'install should return a record with id');
  assert.strictEqual(rec.slug, 'playwright');
  assert.strictEqual(rec.scope, 'global');

  const list = installer.list();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].slug, 'playwright');

  assert.strictEqual(installer.uninstall(rec.id), true);
  assert.deepStrictEqual(installer.list(), []);
}

async function testInstallerRequiresRequiredSecrets() {
  const dir = trackDir(tmpDir());
  const store = new Store(dir);
  const registry = new Registry(dir);
  const installer = new Installer({ dataDir: dir, registry, store });

  assert.throws(
    () => installer.install({ slug: 'github', scope: 'global' }),
    /GITHUB_PERSONAL_ACCESS_TOKEN/,
    'github install without secret should throw mentioning the required env key'
  );
}

async function testInstallerBuildRuntimeConfig() {
  const dir = trackDir(tmpDir());
  const store = new Store(dir);
  const registry = new Registry(dir);
  const installer = new Installer({ dataDir: dir, registry, store });

  installer.install({
    slug: 'github',
    scope: 'global',
    secrets: { GITHUB_PERSONAL_ACCESS_TOKEN: 'test-tok' },
  });

  const rt = installer.buildRuntimeConfig('any-agent');
  assert.ok(rt && rt.configPath, 'buildRuntimeConfig should return a configPath');
  assert.ok(fs.existsSync(rt.configPath), 'configPath file should exist on disk');

  const raw = fs.readFileSync(rt.configPath, 'utf8');
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(raw); }, 'config file should be valid JSON');
  assert.ok(parsed.mcpServers && parsed.mcpServers.github, 'config should have mcpServers.github');
  assert.strictEqual(parsed.mcpServers.github.command, 'npx');

  // Env in the on-disk file must be the placeholder, NOT the plaintext.
  assert.strictEqual(
    parsed.mcpServers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN,
    '${GITHUB_PERSONAL_ACCESS_TOKEN}',
    'on-disk env value must be the ${VAR} placeholder, not plaintext'
  );
  assert.ok(!raw.includes('test-tok'), 'plaintext token must NOT appear anywhere in the config file');

  // The envOverlay carries the real secret to the spawn env.
  assert.strictEqual(rt.envOverlay.GITHUB_PERSONAL_ACCESS_TOKEN, 'test-tok');

  // Shred clears the file.
  installer.shred(rt.configPath);
  assert.strictEqual(fs.existsSync(rt.configPath), false, 'shred should remove the runtime config file');
}

async function testInstallerScoping() {
  const dir = trackDir(tmpDir());
  const store = new Store(dir);
  const registry = new Registry(dir);
  const installer = new Installer({ dataDir: dir, registry, store });

  installer.install({ slug: 'playwright', scope: 'global' });
  installer.install({ slug: 'memory', scope: 'agent:abc' });

  const forAbc = installer.listForAgent('abc');
  const slugsAbc = forAbc.map((i) => i.slug).sort();
  assert.deepStrictEqual(slugsAbc, ['memory', 'playwright'], 'agent abc should see both global and its own');

  const forXyz = installer.listForAgent('xyz');
  const slugsXyz = forXyz.map((i) => i.slug);
  assert.deepStrictEqual(slugsXyz, ['playwright'], 'agent xyz should see only the global install');
}

async function run() {
  const tests = [
    ['registry: bundled catalog loads with 8 servers', testBundledLoads],
    ['registry: mergeCatalogs locks command/args from bundled', testMergeCatalogsPrecedence],
    ['registry: mergeCatalogs allows remote to add new entries', testMergeCatalogsRemoteAddsNew],
    ['store: MCP secret encrypt/decrypt/delete round-trip', testStoreMcpSecretRoundTrip],
    ['installer: install / list / uninstall', testInstallerInstallListUninstall],
    ['installer: refuses install when required secret missing', testInstallerRequiresRequiredSecrets],
    ['installer: buildRuntimeConfig writes placeholder, overlays plaintext, shred removes file', testInstallerBuildRuntimeConfig],
    ['installer: listForAgent respects global vs agent: scope', testInstallerScoping],
  ];
  let passed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}`); console.error('   ', err && err.stack ? err.stack : err); process.exitCode = 1; }
  }
  cleanupAll();
  console.log(`\n${passed}/${tests.length} passed`);
}

run();

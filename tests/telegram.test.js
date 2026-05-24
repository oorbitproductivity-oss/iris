// tests/telegram.test.js — pure-logic tests for the Telegram bridge.
//
// Hits no network and never spawns a real claude. The TelegramService is
// exercised against a stub manager + store; routing, pairing, allowlist,
// and MarkdownV2 formatting are all checked here.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const md = require('../lib/telegram/markdown.js');
const { TelegramService } = require('../lib/telegram/index.js');

// ── Fixtures ──────────────────────────────────────────────

function makeTempDir(prefix = 'iris-telegram-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function rmTempDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function makeStubStore({ initial = {}, tempDir } = {}) {
  const dir = tempDir || makeTempDir('iris-telegram-store-');
  let settings = {
    defaultCwd: dir,
    model: 'sonnet',
    telegram: { enabled: false, botUsername: null, allowedChatId: null, chatAgentId: null },
    ...initial,
  };
  let token = null;
  return {
    _dir: dir,
    getSettings: () => JSON.parse(JSON.stringify(settings)),
    setSettings: (patch) => { settings = { ...settings, ...(patch || {}) }; return settings; },
    getTelegramToken: () => token,
    setTelegramToken: (v) => { token = v == null || v === '' ? null : String(v); },
  };
}

function makeStubManager() {
  // Use a plain object to match the real AgentManager's `this.agents = {}`
  // shape — TelegramService reaches into manager.agents directly when
  // resetting stale sessionIds.
  const agents = {};
  let nextId = 1;
  const calls = { create: [], send: [], stop: [], del: [] };
  const stub = {
    agents,
    calls,
    create: (opts) => {
      const id = 'a' + (nextId++);
      const rec = { ...opts, id, status: 'idle', createdAt: Date.now() + nextId };
      agents[id] = rec;
      calls.create.push(rec);
      return { ...rec };
    },
    list: () => Object.values(agents).map((a) => ({ ...a })),
    get: (id) => agents[id] ? { ...agents[id] } : null,
    sendMessage: (id, msg) => {
      calls.send.push({ id, msg });
      const a = agents[id];
      if (a) a.status = 'running';
    },
    stop: (id) => {
      calls.stop.push(id);
      const a = agents[id];
      if (a) a.status = 'idle';
    },
    delete: (id) => {
      calls.del.push(id);
      delete agents[id];
      return true;
    },
  };
  return stub;
}

// ── MarkdownV2 ────────────────────────────────────────────

function testEscapesAllSpecials() {
  // Each special must appear as backslash-prefixed in the output. We test
  // them in isolation (with a non-special prefix/suffix so position is
  // unambiguous) instead of scanning a smushed-together string.
  const specials = '_*[]()~`>#+-=|{}.!';
  for (const c of specials) {
    const out = md.escapeMarkdownV2('x' + c + 'y');
    assert.strictEqual(out, 'x\\' + c + 'y',
      'expected x\\' + c + 'y for ' + JSON.stringify('x' + c + 'y') + ' got ' + JSON.stringify(out));
  }
  // Backslash is its own escape target — a literal '\' becomes '\\'.
  assert.strictEqual(md.escapeMarkdownV2('a\\b'), 'a\\\\b');
}

function testCodeBlockEscapesBackticksAndBackslash() {
  const out = md.codeBlock('foo `bar` \\baz');
  assert.ok(out.startsWith('```\n'));
  assert.ok(out.endsWith('\n```'));
  assert.ok(out.includes('\\`bar\\`'));
  assert.ok(out.includes('\\\\baz'));
}

function testInlineCodeOnePair() {
  const out = md.inlineCode('echo `hi`');
  assert.strictEqual(out, '`echo \\`hi\\``');
}

function testChunkSplitsLongMessages() {
  const block = 'x'.repeat(6000);
  const chunks = md.chunkMarkdownV2(block, 4096);
  assert.ok(chunks.length >= 2, 'expected at least 2 chunks');
  for (const c of chunks) {
    assert.ok(c.length <= 4096, 'chunk exceeded max length: ' + c.length);
  }
  // Concatenation must include the entire original character set.
  const total = chunks.reduce((n, c) => n + c.replace(/```\n|\n```/g, '').length, 0);
  assert.ok(total >= block.length, 'lost characters across chunks');
}

function testChunkPreservesShortMessages() {
  const r = md.chunkMarkdownV2('hello world', 4096);
  assert.deepStrictEqual(r, ['hello world']);
}

function testFormatToolAnnouncementSkipsReadonly() {
  assert.strictEqual(md.formatToolAnnouncement('Read', { file_path: '/x' }), null);
  assert.strictEqual(md.formatToolAnnouncement('Grep', { pattern: 'x' }), null);
  const bash = md.formatToolAnnouncement('Bash', { command: 'echo hi' });
  assert.ok(bash && bash.includes('Bash'));
  assert.ok(bash.includes('echo hi'));
}

function testFormatErrorEscapes() {
  const e = md.formatError('a.b.c (bad)');
  // dots, parens, and the leading icon all present.
  assert.ok(e.startsWith('❌ '));
  assert.ok(e.includes('a\\.b\\.c'));
  assert.ok(e.includes('\\('));
}

// ── Service: pairing + allowlist ──────────────────────────

async function testHandleUpdateRequiresPairing() {
  const store = makeStubStore();
  const manager = makeStubManager();
  const svc = new TelegramService({ manager, store, dataDir: store._dir });
  // No pairing, no allowlist → message is dropped, no agent created.
  svc.token = 'fake'; // skip getMe — we test routing only.
  svc._safeSend = async () => {}; // suppress the "not paired" hint
  await svc._handleUpdate({ message: { chat: { id: 42 }, text: 'hello' } });
  assert.strictEqual(manager.calls.create.length, 0);
  assert.strictEqual(manager.calls.send.length, 0);
  rmTempDir(store._dir);
}

async function testPairingCodeClaimsChat() {
  const store = makeStubStore();
  const manager = makeStubManager();
  const svc = new TelegramService({ manager, store, dataDir: store._dir });
  svc.token = 'fake';
  // Stub the network send so we don't hit Telegram.
  const sent = [];
  svc._safeSend = async (chatId, text) => { sent.push({ chatId, text }); };

  const pairing = svc.startPairing();
  assert.ok(/^\d{6}$/.test(pairing.code));

  // Send the right code from chat 99.
  await svc._handleUpdate({ message: { chat: { id: 99 }, text: pairing.code } });

  assert.strictEqual(svc.allowedChatId, 99, 'allowedChatId should be set');
  assert.strictEqual(svc.pairing, null, 'pairing should clear after success');
  assert.ok(sent.length === 1 && /Paired/.test(sent[0].text), 'should reply "Paired"');

  rmTempDir(store._dir);
}

async function testAllowlistRejectsOtherChats() {
  const store = makeStubStore({ initial: {
    telegram: { enabled: true, botUsername: null, allowedChatId: 99, chatAgentId: null },
  }});
  const manager = makeStubManager();
  const svc = new TelegramService({ manager, store, dataDir: store._dir });
  svc.token = 'fake';
  const sent = [];
  svc._safeSend = async (chatId, text) => { sent.push({ chatId, text }); };

  // chat 1234 is NOT the allowed one → silent drop (no reply, no agent).
  await svc._handleUpdate({ message: { chat: { id: 1234 }, text: 'do a thing' } });
  assert.strictEqual(manager.calls.create.length, 0);
  assert.strictEqual(manager.calls.send.length, 0);
  assert.strictEqual(sent.length, 0, 'allowlist should be silent for strangers');

  rmTempDir(store._dir);
}

async function testRoutesMessagesToAgent() {
  const store = makeStubStore({ initial: {
    telegram: { enabled: true, botUsername: null, allowedChatId: 99, chatAgentId: null },
  }});
  const manager = makeStubManager();
  const svc = new TelegramService({ manager, store, dataDir: store._dir });
  svc.token = 'fake';
  svc._safeSend = async () => {};

  await svc._handleUpdate({ message: { chat: { id: 99 }, text: 'first task' } });
  assert.strictEqual(manager.calls.create.length, 1, 'first message should spawn an agent');
  assert.deepStrictEqual(manager.calls.send[0], { id: svc.chatAgentId, msg: 'first task' });

  // Second message reuses the agent (no second create), but the stub leaves
  // it 'running', so the service should refuse with a busy message rather
  // than queueing.
  await svc._handleUpdate({ message: { chat: { id: 99 }, text: 'second' } });
  assert.strictEqual(manager.calls.create.length, 1, 'should not double-create');

  rmTempDir(store._dir);
}

async function testSlashNewUnbindsButKeepsAgent() {
  // /new starts a fresh session but PRESERVES the previous one so the user
  // can /switch back to it later. The old behavior (delete on /new) lost
  // the in-progress thread and was changed when channel-style navigation
  // was added.
  const store = makeStubStore({ initial: {
    telegram: { enabled: true, botUsername: null, allowedChatId: 99, chatAgentId: 'pre-existing' },
  }});
  const manager = makeStubManager();
  manager.create({ name: 'Telegram', cwd: store._dir, model: 'sonnet' });
  const seededId = manager.calls.create[0].id;
  const svc = new TelegramService({ manager, store, dataDir: store._dir });
  svc.token = 'fake';
  svc.chatAgentId = seededId;
  svc._ourAgentIds.add(seededId);
  svc._safeSend = async () => {};

  await svc._handleUpdate({ message: { chat: { id: 99 }, text: '/new' } });
  assert.strictEqual(svc.chatAgentId, null, 'agent binding should clear');
  assert.ok(!manager.calls.del.includes(seededId), 'old agent must NOT be deleted');
  assert.ok(manager.calls.stop.includes(seededId), 'old agent should be stopped');

  rmTempDir(store._dir);
}

async function testSpawnedAgentsAreSandboxed() {
  // Set defaultCwd to something OUTSIDE the dataDir so we can prove the
  // Telegram agent's cwd never lands there.
  const userProjects = makeTempDir('user-projects-');
  const store = makeStubStore({ initial: {
    defaultCwd: userProjects,
    telegram: { enabled: true, botUsername: null, allowedChatId: 99, chatAgentId: null },
  }});
  const manager = makeStubManager();
  const svc = new TelegramService({ manager, store, dataDir: store._dir });
  svc.token = 'fake';
  svc._safeSend = async () => {};

  await svc._handleUpdate({ message: { chat: { id: 99 }, text: 'do a thing' } });
  assert.strictEqual(manager.calls.create.length, 1);
  const opts = manager.calls.create[0];
  assert.strictEqual(opts.sandbox, true, 'sandbox flag should be forced on');
  assert.ok(Array.isArray(opts.importFiles) && opts.importFiles.length === 0,
    'no files should be auto-imported into the sandbox');
  assert.ok(/Telegram|do a thing/.test(opts.name),
    'agent name should be derived from the first prompt');
  // The hard isolation requirement: cwd is INSIDE dataDir, not in the
  // user's project tree. agent-manager will then add-dir this — but it
  // points back into our own sandbox tree, so no leak.
  assert.ok(opts.cwd.startsWith(store._dir),
    'Telegram agent cwd must live under dataDir, got: ' + opts.cwd);
  assert.ok(!opts.cwd.startsWith(userProjects),
    'Telegram agent cwd must NEVER touch the user defaultCwd');
  assert.ok(opts.cwd.includes('telegram-workspaces'),
    'cwd should be in the telegram-workspaces tree, got: ' + opts.cwd);

  rmTempDir(userProjects);
  rmTempDir(store._dir);
}

async function testControlMenuShowsNumberedOptions() {
  const store = makeStubStore({ initial: {
    telegram: { enabled: true, botUsername: null, allowedChatId: 99, chatAgentId: null },
  }});
  const manager = makeStubManager();
  const svc = new TelegramService({ manager, store, dataDir: store._dir });
  svc.token = 'fake';
  const sent = [];
  svc._safeSend = async (cid, text) => { sent.push({ cid, text }); };

  await svc._handleUpdate({ message: { chat: { id: 99 }, text: '/control' } });
  assert.strictEqual(sent.length, 1, '/control should reply with one menu message');
  assert.ok(/What would you like to do/i.test(sent[0].text));
  // At least two numbered options visible.
  assert.ok(sent[0].text.includes('*1\\.*'));
  assert.ok(sent[0].text.includes('*2\\.*'));
  // Menu should be primed.
  assert.ok(svc._menu, 'menu state should be primed after /control');
  assert.ok(svc._menu.options.length >= 2);

  rmTempDir(store._dir);
}

async function testNumberReplyTriggersMenuAction() {
  const store = makeStubStore({ initial: {
    telegram: { enabled: true, botUsername: null, allowedChatId: 99, chatAgentId: null },
  }});
  const manager = makeStubManager();
  const svc = new TelegramService({ manager, store, dataDir: store._dir });
  svc.token = 'fake';
  svc._safeSend = async () => {};

  // Open the control menu.
  await svc._handleUpdate({ message: { chat: { id: 99 }, text: '/control' } });
  const optionCount = svc._menu.options.length;

  // Out-of-range pick → menu stays, no action.
  await svc._handleUpdate({ message: { chat: { id: 99 }, text: String(optionCount + 5) } });
  assert.ok(svc._menu, 'menu should stay primed after invalid selection');

  // Picking "1" runs the first option (New session). Should unbind any
  // agent — manager.calls.create shouldn't grow either, because New
  // session doesn't itself spawn.
  await svc._handleUpdate({ message: { chat: { id: 99 }, text: '1' } });
  assert.strictEqual(svc._menu, null, 'menu should clear after a valid selection');

  rmTempDir(store._dir);
}

async function testHelpAndMenuAliasControl() {
  const store = makeStubStore({ initial: {
    telegram: { enabled: true, botUsername: null, allowedChatId: 99, chatAgentId: null },
  }});
  const manager = makeStubManager();
  const svc = new TelegramService({ manager, store, dataDir: store._dir });
  svc.token = 'fake';
  const sent = [];
  svc._safeSend = async (cid, text) => { sent.push({ cid, text }); };

  for (const cmd of ['/help', '/menu', '/start']) {
    sent.length = 0;
    svc._menu = null;
    await svc._handleUpdate({ message: { chat: { id: 99 }, text: cmd } });
    assert.strictEqual(sent.length, 1, cmd + ' should reply once');
    assert.ok(/What would you like to do/i.test(sent[0].text),
      cmd + ' should show the control menu');
    assert.ok(svc._menu, cmd + ' should prime the menu state');
  }

  rmTempDir(store._dir);
}

async function testSwitchMenuListsSessions() {
  const store = makeStubStore({ initial: {
    telegram: { enabled: true, botUsername: null, allowedChatId: 99, chatAgentId: null },
  }});
  const manager = makeStubManager();
  const svc = new TelegramService({ manager, store, dataDir: store._dir });
  svc.token = 'fake';
  const sent = [];
  svc._safeSend = async (cid, text) => { sent.push({ cid, text }); };

  // /switch with no args & no sessions → friendly message, no menu.
  await svc._handleUpdate({ message: { chat: { id: 99 }, text: '/switch' } });
  assert.ok(/No sessions yet/.test(sent[sent.length - 1].text));
  assert.strictEqual(svc._menu, null);

  // Make two sessions, then /switch should present a numbered picker.
  await svc._handleUpdate({ message: { chat: { id: 99 }, text: 'first task' } });
  await svc._handleUpdate({ message: { chat: { id: 99 }, text: '/new' } });
  await svc._handleUpdate({ message: { chat: { id: 99 }, text: 'second task' } });
  const second = svc.chatAgentId;

  sent.length = 0;
  await svc._handleUpdate({ message: { chat: { id: 99 }, text: '/switch' } });
  assert.ok(/Switch to:/i.test(sent[0].text));
  assert.ok(svc._menu && svc._menu.options.length === 2);

  // Picking option 2 should switch to the older session.
  await svc._handleUpdate({ message: { chat: { id: 99 }, text: '2' } });
  assert.notStrictEqual(svc.chatAgentId, second, 'should have switched');
  assert.strictEqual(svc._menu, null, 'menu clears on selection');

  rmTempDir(store._dir);
}

async function testSlashListShowsSessions() {
  const store = makeStubStore({ initial: {
    telegram: { enabled: true, botUsername: null, allowedChatId: 99, chatAgentId: null },
  }});
  const manager = makeStubManager();
  const svc = new TelegramService({ manager, store, dataDir: store._dir });
  svc.token = 'fake';
  const sent = [];
  svc._safeSend = async (cid, text) => { sent.push({ cid, text }); };

  // Spawn two sessions.
  await svc._handleUpdate({ message: { chat: { id: 99 }, text: 'task one' } });
  const a1 = svc.chatAgentId;
  await svc._handleUpdate({ message: { chat: { id: 99 }, text: '/new' } });
  await svc._handleUpdate({ message: { chat: { id: 99 }, text: 'task two' } });
  const a2 = svc.chatAgentId;
  assert.notStrictEqual(a1, a2, 'second /new should create a fresh agent');

  sent.length = 0;
  await svc._handleUpdate({ message: { chat: { id: 99 }, text: '/list' } });
  assert.strictEqual(sent.length, 1, '/list should reply once');
  assert.ok(/recent sessions/i.test(sent[0].text), '/list should mention sessions');
  // Both agents present, newer first.
  assert.ok(sent[0].text.includes('1\\.'));
  assert.ok(sent[0].text.includes('2\\.'));

  rmTempDir(store._dir);
}

async function testSlashSwitchChangesBoundAgent() {
  const store = makeStubStore({ initial: {
    telegram: { enabled: true, botUsername: null, allowedChatId: 99, chatAgentId: null },
  }});
  const manager = makeStubManager();
  const svc = new TelegramService({ manager, store, dataDir: store._dir });
  svc.token = 'fake';
  svc._safeSend = async () => {};

  await svc._handleUpdate({ message: { chat: { id: 99 }, text: 'first' } });
  const first = svc.chatAgentId;
  await svc._handleUpdate({ message: { chat: { id: 99 }, text: '/new' } });
  await svc._handleUpdate({ message: { chat: { id: 99 }, text: 'second' } });
  const second = svc.chatAgentId;

  // /list orders newest first → "1" is `second`, "2" is `first`.
  await svc._handleUpdate({ message: { chat: { id: 99 }, text: '/switch 2' } });
  assert.strictEqual(svc.chatAgentId, first, '/switch 2 should jump to the older session');

  // Invalid index → no change.
  await svc._handleUpdate({ message: { chat: { id: 99 }, text: '/switch 99' } });
  assert.strictEqual(svc.chatAgentId, first, 'invalid /switch should not change binding');

  rmTempDir(store._dir);
}

async function testSlashStopHaltsAgent() {
  const store = makeStubStore({ initial: {
    telegram: { enabled: true, botUsername: null, allowedChatId: 99, chatAgentId: null },
  }});
  const manager = makeStubManager();
  const svc = new TelegramService({ manager, store, dataDir: store._dir });
  svc.token = 'fake';
  svc._safeSend = async () => {};
  // Seed an active agent.
  await svc._handleUpdate({ message: { chat: { id: 99 }, text: 'kick off' } });
  const agentId = svc.chatAgentId;

  await svc._handleUpdate({ message: { chat: { id: 99 }, text: '/stop' } });
  assert.ok(manager.calls.stop.includes(agentId), '/stop should call manager.stop');

  rmTempDir(store._dir);
}

async function testSilentDoneClearsSessionAndNotifies() {
  const store = makeStubStore({ initial: {
    telegram: { enabled: true, botUsername: null, allowedChatId: 99, chatAgentId: null },
  }});
  const manager = makeStubManager();
  // Seed an agent record with a sessionId, as if it had completed runs
  // earlier. The 'silent done' handler should null out sessionId.
  manager.create({ name: '📱 prev', cwd: store._dir, model: 'sonnet', sandbox: true, importFiles: [] });
  const id = manager.calls.create[0].id;
  // Stamp a sessionId on the existing record (mutate in place — preserves
  // the manager.agents object reference TelegramService reads).
  manager.agents[id].sessionId = 'stale-session-abc';
  manager.store = { saveAgents: () => {} };
  const svc = new TelegramService({ manager, store, dataDir: store._dir });
  svc.token = 'fake';
  svc._ourAgentIds.add(id);
  const sent = [];
  svc._safeSend = async (cid, text) => { sent.push({ cid, text }); };

  // 'done' arrives without a preceding 'result' — silent failure.
  svc.handleAgentEvent({ type: 'done', id, code: 0 });
  await new Promise((r) => setImmediate(r));

  assert.ok(sent.some((m) => /stale session/i.test(m.text)),
    'should warn the user about the silent finish');
  assert.strictEqual(manager.agents[id].sessionId, null,
    'sessionId should be cleared so the next run starts fresh');

  rmTempDir(store._dir);
}

async function testResultBeforeDoneDoesNotWarn() {
  const store = makeStubStore({ initial: {
    telegram: { enabled: true, botUsername: null, allowedChatId: 99, chatAgentId: null },
  }});
  const manager = makeStubManager();
  const svc = new TelegramService({ manager, store, dataDir: store._dir });
  svc.token = 'fake';
  svc._ourAgentIds.add('a1');
  const sent = [];
  svc._safeSend = async (cid, text) => { sent.push({ cid, text }); };

  svc.handleAgentEvent({ type: 'session', id: 'a1', sessionId: 's', model: 'sonnet' });
  svc.handleAgentEvent({ type: 'result', id: 'a1', text: 'hello' });
  svc.handleAgentEvent({ type: 'done', id: 'a1', code: 0 });
  await new Promise((r) => setImmediate(r));

  assert.ok(!sent.some((m) => /stale session/i.test(m.text)),
    'normal result + done should NOT trigger the stale warning');
  assert.ok(sent.some((m) => /hello/.test(m.text)),
    'result text should reach Telegram');

  rmTempDir(store._dir);
}

async function testOwnedAgentIdsPersistAcrossRestart() {
  const store = makeStubStore();
  const manager = makeStubManager();
  const svc = new TelegramService({ manager, store, dataDir: store._dir });
  svc.token = 'fake';
  svc._safeSend = async () => {};

  // Pair, send a message → spawns an agent and persists its id.
  store.setSettings({ telegram: { ...store.getSettings().telegram, enabled: true, allowedChatId: 99 } });
  svc.allowedChatId = 99;
  await svc._handleUpdate({ message: { chat: { id: 99 }, text: 'one' } });
  const a1 = svc.chatAgentId;
  await svc._handleUpdate({ message: { chat: { id: 99 }, text: '/new' } });
  await svc._handleUpdate({ message: { chat: { id: 99 }, text: 'two' } });
  const a2 = svc.chatAgentId;
  assert.ok(a1 && a2 && a1 !== a2);

  // Settings should now include both agent ids in ownedAgentIds.
  const persisted = store.getSettings().telegram.ownedAgentIds;
  assert.ok(persisted.includes(a1), 'older session id should be persisted');
  assert.ok(persisted.includes(a2), 'active session id should be persisted');

  // Simulate restart: build a fresh service from the same store + manager.
  const svc2 = new TelegramService({ manager, store, dataDir: store._dir });
  assert.ok(svc2._ourAgentIds.has(a1),
    'older session should rehydrate from persisted ownedAgentIds');
  assert.ok(svc2._ourAgentIds.has(a2));

  rmTempDir(store._dir);
}

async function testHandleAgentEventFiltersForeignAgents() {
  const store = makeStubStore({ initial: {
    telegram: { enabled: true, botUsername: null, allowedChatId: 99, chatAgentId: null },
  }});
  const manager = makeStubManager();
  const svc = new TelegramService({ manager, store, dataDir: store._dir });
  svc.token = 'fake';
  const sent = [];
  svc._safeSend = async (cid, text) => { sent.push({ cid, text }); };

  // Foreign agent id → no forward.
  svc.handleAgentEvent({ type: 'result', id: 'foreign', text: 'hello world' });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(sent.length, 0, 'should ignore non-owned agents');

  // Owned agent id → forwarded.
  svc._ourAgentIds.add('mine');
  svc.handleAgentEvent({ type: 'result', id: 'mine', text: 'hello world' });
  await new Promise((r) => setImmediate(r));
  assert.ok(sent.length >= 1, 'should forward result for owned agent');
  assert.ok(/hello world/.test(sent[0].text), 'message body should reach Telegram');

  rmTempDir(store._dir);
}

// ── NEW: user-chosen cwd + Iris orchestrator routing ──────

async function testSetDefaultCwdValidates() {
  const store = makeStubStore();
  const manager = makeStubManager();
  const svc = new TelegramService({ manager, store, dataDir: store._dir });

  // Relative paths must be rejected (Windows + POSIX both).
  assert.throws(() => svc.setDefaultCwd('relative/dir'),
    /absolute/, 'should reject relative path');

  // Non-existent absolute path must be rejected.
  const ghost = path.join(store._dir, 'does-not-exist-' + Date.now());
  assert.throws(() => svc.setDefaultCwd(ghost),
    /does not exist/, 'should reject missing folder');

  // A real folder is accepted and persists into settings.
  const real = makeTempDir('user-real-');
  const status = svc.setDefaultCwd(real);
  assert.strictEqual(status.defaultCwd, real);
  assert.strictEqual(store.getSettings().telegram.defaultCwd, real,
    'defaultCwd must be persisted into settings.telegram');

  // Clearing with null returns to the sandboxed default.
  const cleared = svc.setDefaultCwd(null);
  assert.strictEqual(cleared.defaultCwd, null);
  assert.strictEqual(store.getSettings().telegram.defaultCwd, null);

  rmTempDir(real);
  rmTempDir(store._dir);
}

async function testCustomCwdSpawnsUnsandboxed() {
  // The headline behavior change: when defaultCwd is set, new Telegram
  // sessions run UNSANDBOXED inside that folder so they can edit the
  // user's real files.
  const userProjects = makeTempDir('user-projects-cwd-');
  const store = makeStubStore({ initial: {
    telegram: { enabled: true, botUsername: null, allowedChatId: 99,
      chatAgentId: null, defaultCwd: userProjects, chatMode: 'worker' },
  }});
  const manager = makeStubManager();
  const svc = new TelegramService({ manager, store, dataDir: store._dir });
  svc.token = 'fake';
  svc._safeSend = async () => {};

  await svc._handleUpdate({ message: { chat: { id: 99 }, text: 'edit my code' } });
  assert.strictEqual(manager.calls.create.length, 1);
  const opts = manager.calls.create[0];
  assert.strictEqual(opts.sandbox, false,
    'sandbox must be OFF when user picked a default cwd');
  assert.strictEqual(opts.cwd, userProjects,
    'cwd must be the exact user-chosen folder');

  rmTempDir(userProjects);
  rmTempDir(store._dir);
}

async function testCwdCommandPersistsAndUnbinds() {
  const real = makeTempDir('user-real-cwd-');
  const store = makeStubStore({ initial: {
    telegram: { enabled: true, botUsername: null, allowedChatId: 99, chatAgentId: 'old-bound', chatMode: 'worker' },
  }});
  const manager = makeStubManager();
  const svc = new TelegramService({ manager, store, dataDir: store._dir });
  svc.token = 'fake';
  svc.allowedChatId = 99;
  svc.chatAgentId = 'old-bound';
  manager.agents['old-bound'] = { id: 'old-bound', status: 'idle' };
  const sent = [];
  svc._safeSend = async (cid, text) => { sent.push({ cid, text }); };

  await svc._handleUpdate({ message: { chat: { id: 99 }, text: '/cwd ' + real } });
  assert.strictEqual(svc.defaultCwd, real, '/cwd should set defaultCwd');
  assert.strictEqual(store.getSettings().telegram.defaultCwd, real,
    'persisted into settings');
  assert.strictEqual(svc.chatAgentId, null,
    '/cwd should unbind the previous session so the next message lands in the new folder');
  assert.ok(manager.calls.stop.includes('old-bound'),
    'previous bound agent should be stopped');
  assert.ok(/Workspace set/i.test(sent[sent.length - 1].text));

  // /cwd clear resets defaultCwd.
  sent.length = 0;
  await svc._handleUpdate({ message: { chat: { id: 99 }, text: '/cwd clear' } });
  assert.strictEqual(svc.defaultCwd, null, '/cwd clear should null defaultCwd');
  assert.strictEqual(store.getSettings().telegram.defaultCwd, null);
  assert.ok(/sandboxed/i.test(sent[sent.length - 1].text));

  rmTempDir(real);
  rmTempDir(store._dir);
}

async function testCwdCommandRejectsBadPaths() {
  const store = makeStubStore({ initial: {
    telegram: { enabled: true, botUsername: null, allowedChatId: 99, chatAgentId: null, chatMode: 'worker' },
  }});
  const manager = makeStubManager();
  const svc = new TelegramService({ manager, store, dataDir: store._dir });
  svc.token = 'fake';
  const sent = [];
  svc._safeSend = async (cid, text) => { sent.push({ cid, text }); };

  await svc._handleUpdate({ message: { chat: { id: 99 }, text: '/cwd relative/path' } });
  assert.ok(/absolute/i.test(sent[sent.length - 1].text),
    'should reject relative path');
  assert.strictEqual(svc.defaultCwd, null, 'defaultCwd untouched on rejection');

  const ghost = path.join(store._dir, 'never-existed-' + Date.now());
  sent.length = 0;
  await svc._handleUpdate({ message: { chat: { id: 99 }, text: '/cwd ' + ghost } });
  assert.ok(/does not exist/i.test(sent[sent.length - 1].text));

  rmTempDir(store._dir);
}

async function testIrisModeRoutesToOrchestrator() {
  // /iris flips the chat into orchestrator mode — messages go to manager
  // agent id 'iris' (not a spawned worker), no new session is created.
  const store = makeStubStore({ initial: {
    telegram: { enabled: true, botUsername: null, allowedChatId: 99, chatAgentId: null, chatMode: 'worker' },
  }});
  const manager = makeStubManager();
  // Seed an Iris agent (mimics AgentManager.bootstrap()).
  manager.agents['iris'] = { id: 'iris', role: 'iris', name: 'Iris', status: 'idle' };
  const svc = new TelegramService({ manager, store, dataDir: store._dir });
  svc.token = 'fake';
  const sent = [];
  svc._safeSend = async (cid, text) => { sent.push({ cid, text }); };

  // Flip mode.
  await svc._handleUpdate({ message: { chat: { id: 99 }, text: '/iris' } });
  assert.strictEqual(svc.chatMode, 'iris');
  assert.strictEqual(store.getSettings().telegram.chatMode, 'iris',
    'chatMode must be persisted');

  // Next non-command message routes to Iris.
  await svc._handleUpdate({ message: { chat: { id: 99 }, text: 'plan the migration' } });
  assert.strictEqual(manager.calls.create.length, 0,
    'Iris mode must NEVER spawn a worker');
  assert.deepStrictEqual(manager.calls.send[manager.calls.send.length - 1],
    { id: 'iris', msg: 'plan the migration' });

  // /worker flips back.
  await svc._handleUpdate({ message: { chat: { id: 99 }, text: '/worker' } });
  assert.strictEqual(svc.chatMode, 'worker');
  assert.strictEqual(store.getSettings().telegram.chatMode, 'worker');

  // Now messages spawn a worker again.
  await svc._handleUpdate({ message: { chat: { id: 99 }, text: 'after switching' } });
  assert.strictEqual(manager.calls.create.length, 1,
    'worker mode should spawn after the switch');

  rmTempDir(store._dir);
}

async function testIrisEventsForwardOnlyInIrisMode() {
  // Worker mode: Iris events do NOT reach Telegram (Iris is shared with
  // the desktop UI; we don't want to spam the chat with desktop work).
  // Iris mode: Iris events DO reach Telegram so the user sees her replies.
  const store = makeStubStore({ initial: {
    telegram: { enabled: true, botUsername: null, allowedChatId: 99, chatAgentId: null, chatMode: 'worker' },
  }});
  const manager = makeStubManager();
  manager.agents['iris'] = { id: 'iris', role: 'iris', name: 'Iris', status: 'idle' };
  const svc = new TelegramService({ manager, store, dataDir: store._dir });
  svc.token = 'fake';
  const sent = [];
  svc._safeSend = async (cid, text) => { sent.push({ cid, text }); };

  // Worker mode → drop Iris events.
  svc.handleAgentEvent({ type: 'result', id: 'iris', text: 'desktop reply' });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(sent.length, 0,
    'worker mode must NOT forward Iris events to Telegram');

  // Flip to Iris mode → forward.
  svc.chatMode = 'iris';
  svc.handleAgentEvent({ type: 'result', id: 'iris', text: 'phone reply' });
  await new Promise((r) => setImmediate(r));
  assert.ok(sent.some((m) => /phone reply/.test(m.text)),
    'Iris mode must forward Iris result events to Telegram');

  rmTempDir(store._dir);
}

async function testNewCommandSwitchesBackToWorker() {
  // /new in Iris mode flips back to worker mode AND unbinds — the next
  // message starts a fresh worker session.
  const store = makeStubStore({ initial: {
    telegram: { enabled: true, botUsername: null, allowedChatId: 99, chatAgentId: null, chatMode: 'iris' },
  }});
  const manager = makeStubManager();
  manager.agents['iris'] = { id: 'iris', role: 'iris', name: 'Iris', status: 'idle' };
  const svc = new TelegramService({ manager, store, dataDir: store._dir });
  svc.token = 'fake';
  svc._safeSend = async () => {};

  assert.strictEqual(svc.chatMode, 'iris', 'preconfigured into iris mode');
  await svc._handleUpdate({ message: { chat: { id: 99 }, text: '/new' } });
  assert.strictEqual(svc.chatMode, 'worker',
    '/new should always land in worker mode');

  rmTempDir(store._dir);
}

async function testStopInIrisModeStopsIris() {
  const store = makeStubStore({ initial: {
    telegram: { enabled: true, botUsername: null, allowedChatId: 99, chatAgentId: null, chatMode: 'iris' },
  }});
  const manager = makeStubManager();
  manager.agents['iris'] = { id: 'iris', role: 'iris', name: 'Iris', status: 'running' };
  const svc = new TelegramService({ manager, store, dataDir: store._dir });
  svc.token = 'fake';
  svc._safeSend = async () => {};

  await svc._handleUpdate({ message: { chat: { id: 99 }, text: '/stop' } });
  assert.ok(manager.calls.stop.includes('iris'),
    '/stop in Iris mode should stop Iris, not the bound worker');

  rmTempDir(store._dir);
}

async function testStatusExposesNewFields() {
  const real = makeTempDir('user-status-cwd-');
  const store = makeStubStore({ initial: {
    telegram: { enabled: true, botUsername: null, allowedChatId: 99,
      chatAgentId: null, defaultCwd: real, chatMode: 'iris' },
  }});
  const manager = makeStubManager();
  const svc = new TelegramService({ manager, store, dataDir: store._dir });
  const s = svc.getStatus();
  assert.strictEqual(s.chatMode, 'iris');
  assert.strictEqual(s.defaultCwd, real);
  assert.ok('pendingWorkerCwd' in s,
    'getStatus must expose pendingWorkerCwd (the one-shot override)');

  rmTempDir(real);
  rmTempDir(store._dir);
}

async function testEnabledFlagPersistsThroughStore() {
  const store = makeStubStore();
  const manager = makeStubManager();
  const svc = new TelegramService({ manager, store, dataDir: store._dir });
  // No token + no enable → start is a no-op.
  await svc.start();
  assert.strictEqual(svc.connection, 'stopped');

  rmTempDir(store._dir);
}

// ── Runner ────────────────────────────────────────────────

async function run() {
  const tests = [
    ['markdown: escapes every MarkdownV2 special', testEscapesAllSpecials],
    ['markdown: code block escapes backticks + backslash', testCodeBlockEscapesBackticksAndBackslash],
    ['markdown: inline code escapes a single pair', testInlineCodeOnePair],
    ['markdown: chunk splits long messages under 4096', testChunkSplitsLongMessages],
    ['markdown: chunk preserves short messages', testChunkPreservesShortMessages],
    ['markdown: tool announcement skips read-only tools', testFormatToolAnnouncementSkipsReadonly],
    ['markdown: error escapes dots and parens', testFormatErrorEscapes],
    ['service: unpaired chat is dropped', testHandleUpdateRequiresPairing],
    ['service: pairing code claims the chat', testPairingCodeClaimsChat],
    ['service: allowlist silently drops other chats', testAllowlistRejectsOtherChats],
    ['service: messages route to a spawned agent', testRoutesMessagesToAgent],
    ['service: /new unbinds (but keeps) the agent', testSlashNewUnbindsButKeepsAgent],
    ['service: /stop halts the active agent', testSlashStopHaltsAgent],
    ['service: spawned agents are sandboxed (cwd outside user projects)', testSpawnedAgentsAreSandboxed],
    ['service: /list shows recent sessions', testSlashListShowsSessions],
    ['service: /switch <n> jumps between sessions', testSlashSwitchChangesBoundAgent],
    ['service: /control opens numbered menu', testControlMenuShowsNumberedOptions],
    ['service: bare number reply triggers menu action', testNumberReplyTriggersMenuAction],
    ['service: /help, /menu, /start all open control menu', testHelpAndMenuAliasControl],
    ['service: /switch with no arg shows picker menu', testSwitchMenuListsSessions],
    ['service: foreign agent events are ignored', testHandleAgentEventFiltersForeignAgents],
    ['service: silent done clears sessionId + notifies', testSilentDoneClearsSessionAndNotifies],
    ['service: normal result+done does NOT trigger stale warning', testResultBeforeDoneDoesNotWarn],
    ['service: ownedAgentIds persist across restart', testOwnedAgentIdsPersistAcrossRestart],
    ['service: setDefaultCwd validates absolute + existing path', testSetDefaultCwdValidates],
    ['service: custom cwd spawns UNSANDBOXED at that path', testCustomCwdSpawnsUnsandboxed],
    ['service: /cwd persists, unbinds session, and accepts clear', testCwdCommandPersistsAndUnbinds],
    ['service: /cwd rejects relative + missing paths', testCwdCommandRejectsBadPaths],
    ['service: /iris routes messages to the orchestrator', testIrisModeRoutesToOrchestrator],
    ['service: Iris events forward only in Iris mode', testIrisEventsForwardOnlyInIrisMode],
    ['service: /new always lands in worker mode', testNewCommandSwitchesBackToWorker],
    ['service: /stop in Iris mode stops Iris', testStopInIrisModeStopsIris],
    ['service: getStatus exposes chatMode + defaultCwd + pendingWorkerCwd', testStatusExposesNewFields],
    ['service: start() is a no-op without token/enable', testEnabledFlagPersistsThroughStore],
  ];
  let passed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}`); console.error('   ', err && err.stack ? err.stack : err); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
}

run();

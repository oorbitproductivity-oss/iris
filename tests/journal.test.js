// tests/journal.test.js — Journal store + remote routes.
// Run: node tests/journal.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { Journal } = require('../lib/memory/journal.js');
const remoteServer = require('../lib/server.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'iris-journal-'));
}

function jsonReq(method, port, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    let data;
    if (body !== undefined) {
      data = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const r = http.request({ method, host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json;
        try { json = JSON.parse(buf); } catch { json = buf; }
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('error', reject);
    if (data !== undefined) r.write(data);
    r.end();
  });
}

let nextPort = 19500;
const pickPort = () => nextPort++;

async function withServer(opts, fn) {
  const port = pickPort();
  await remoteServer.startServer({ port, host: '127.0.0.1', ...opts });
  try { await fn(port); }
  finally { await remoteServer.stopServer(); }
}

// ── Journal store unit tests ──

async function testPeopleUpsertAndNote() {
  const j = new Journal({ dataDir: tmpDir() });
  const sarah = j.upsertPerson('Sarah', { relationship: 'ex-partner' });
  assert.strictEqual(sarah.name, 'Sarah');
  assert.strictEqual(sarah.relationship, 'ex-partner');
  assert.strictEqual(sarah.key, 'sarah');

  j.addPersonNote('Sarah', 'we broke up amicably in spring 2026');
  j.addPersonNote('sarah', 'still on good terms');

  const after = j.getPerson('SARAH');
  assert.strictEqual(after.notes.length, 2);
  assert.match(after.notes[0].text, /broke up/);
}

async function testPeopleBadRelationshipCoercedToOther() {
  const j = new Journal({ dataDir: tmpDir() });
  const p = j.upsertPerson('Alex', { relationship: 'bogus' });
  assert.strictEqual(p.relationship, 'other');
}

async function testPeopleNoteOnUnknownPersonThrows() {
  const j = new Journal({ dataDir: tmpDir() });
  assert.throws(() => j.addPersonNote('Nobody', 'hi'), /unknown person/);
}

async function testGoalsCRUD() {
  const j = new Journal({ dataDir: tmpDir() });
  const g = j.createGoal({ title: 'ship Iris remote journal' });
  assert.strictEqual(g.status, 'active');
  assert.ok(g.id);

  j.addGoalNote(g.id, 'sketched the store');
  j.addGoalNote(g.id, 'wired into chat REPL');
  const after = j.getGoal(g.id);
  assert.strictEqual(after.notes.length, 2);
  assert.strictEqual(after.status, 'active');

  const done = j.updateGoal(g.id, { status: 'done' });
  assert.strictEqual(done.status, 'done');
  assert.ok(done.completedAt);

  // Re-opening a done goal clears completedAt.
  const reopened = j.updateGoal(g.id, { status: 'active' });
  assert.strictEqual(reopened.completedAt, null);
}

async function testGoalsListFilteredByStatus() {
  const j = new Journal({ dataDir: tmpDir() });
  j.createGoal({ title: 'a' });
  const b = j.createGoal({ title: 'b' });
  j.updateGoal(b.id, { status: 'done' });
  assert.strictEqual(j.listGoals({ status: 'active' }).length, 1);
  assert.strictEqual(j.listGoals({ status: 'done' }).length, 1);
  assert.strictEqual(j.listGoals().length, 2);
}

async function testGoalShortIdLookup() {
  const j = new Journal({ dataDir: tmpDir() });
  const g = j.createGoal({ title: 'short id resolve' });
  const found = j.getGoal(g.id.slice(0, 8));
  assert.ok(found);
  assert.strictEqual(found.id, g.id);
}

async function testNotesAndSummary() {
  const j = new Journal({ dataDir: tmpDir() });
  j.addNote('feeling decent today', { tags: ['feel'] });
  j.addNote('shipped a thing', { tags: ['win'] });
  const recent = j.recentNotes(10);
  assert.strictEqual(recent.length, 2);
  // Newest first.
  assert.match(recent[0].text, /shipped/);

  j.upsertPerson('Sarah', { relationship: 'ex-partner' });
  j.addPersonNote('Sarah', 'still friends');
  j.createGoal({ title: 'finish the journal' });
  const sum = j.buildSummary();
  assert.strictEqual(sum.goals.length, 1);
  assert.strictEqual(sum.people[0].name, 'Sarah');
}

async function testDisabledJournalNoOp() {
  const j = new Journal({ dataDir: tmpDir(), enabled: false });
  assert.strictEqual(j.upsertPerson('x'), null);
  assert.strictEqual(j.createGoal({ title: 't' }), null);
  assert.strictEqual(j.addNote('x'), null);
  assert.deepStrictEqual(j.listPeople(), []);
  assert.deepStrictEqual(j.listGoals(), []);
}

async function testPersistenceAcrossInstances() {
  const dir = tmpDir();
  const j1 = new Journal({ dataDir: dir });
  const g = j1.createGoal({ title: 'persist me' });
  j1.upsertPerson('Sarah', { relationship: 'partner' });
  j1.addGoalNote(g.id, 'progress');

  // Carrying over a bunch of time: a brand-new instance still sees it.
  const j2 = new Journal({ dataDir: dir });
  assert.strictEqual(j2.listGoals().length, 1);
  assert.strictEqual(j2.listGoals()[0].notes.length, 1);
  assert.strictEqual(j2.getPerson('sarah').relationship, 'partner');
}

// ── Remote-server integration tests ──

async function testRemoteJournalSummaryAndCreate() {
  const dataDir = tmpDir();
  await withServer(
    { dataDir, manager: null, store: null, version: 't', getAuth: () => ({ enabled: true, token: 'tok' }) },
    async (port) => {
      // Empty journal: summary still 200, but lists are empty.
      const empty = await jsonReq('GET', port, '/api/v1/journal/summary', undefined, 'tok');
      assert.strictEqual(empty.status, 200);
      assert.deepStrictEqual(empty.json.goals, []);
      assert.deepStrictEqual(empty.json.people, []);

      // POST a goal then verify it shows up.
      const created = await jsonReq('POST', port, '/api/v1/journal/goals', { title: 'remote check' }, 'tok');
      assert.strictEqual(created.status, 200);
      assert.strictEqual(created.json.goal.title, 'remote check');

      const list = await jsonReq('GET', port, '/api/v1/journal/goals', undefined, 'tok');
      assert.strictEqual(list.status, 200);
      assert.strictEqual(list.json.goals.length, 1);

      // POST a progress note.
      const id = created.json.goal.id;
      const noted = await jsonReq('POST', port, `/api/v1/journal/goals/${id}/notes`, { text: 'going well' }, 'tok');
      assert.strictEqual(noted.status, 200);
      assert.match(noted.json.note.text, /going well/);

      // Summary now includes the note.
      const sum = await jsonReq('GET', port, '/api/v1/journal/summary', undefined, 'tok');
      assert.strictEqual(sum.status, 200);
      assert.strictEqual(sum.json.goals.length, 1);
      assert.match(sum.json.goals[0].lastNote, /going well/);
    },
  );
}

async function testRemoteJournalPersonNoteWithoutMeetReturns404() {
  const dataDir = tmpDir();
  await withServer(
    { dataDir, manager: null, store: null, version: 't', getAuth: () => ({ enabled: true, token: 'tok' }) },
    async (port) => {
      const r = await jsonReq('POST', port, '/api/v1/journal/people/Sarah/notes', { text: 'hi' }, 'tok');
      assert.strictEqual(r.status, 404);
    },
  );
}

async function testRemoteJournalRequiresToken() {
  const dataDir = tmpDir();
  await withServer(
    { dataDir, manager: null, store: null, version: 't', getAuth: () => ({ enabled: true, token: 'tok' }) },
    async (port) => {
      const r = await jsonReq('GET', port, '/api/v1/journal/summary');
      assert.strictEqual(r.status, 401);
    },
  );
}

async function testRemoteJournal503WhenDataDirMissing() {
  await withServer(
    { manager: null, store: null, version: 't', getAuth: () => ({ enabled: true, token: 'tok' }) },
    async (port) => {
      const r = await jsonReq('GET', port, '/api/v1/journal/summary', undefined, 'tok');
      assert.strictEqual(r.status, 503);
    },
  );
}

async function run() {
  const tests = [
    ['journal: upsert person + add notes', testPeopleUpsertAndNote],
    ['journal: bad relationship coerced to "other"', testPeopleBadRelationshipCoercedToOther],
    ['journal: note on unknown person throws', testPeopleNoteOnUnknownPersonThrows],
    ['journal: create/update/done goals', testGoalsCRUD],
    ['journal: list goals filtered by status', testGoalsListFilteredByStatus],
    ['journal: short id resolves to full goal', testGoalShortIdLookup],
    ['journal: notes + summary round-trip', testNotesAndSummary],
    ['journal: disabled = no-op', testDisabledJournalNoOp],
    ['journal: persists across instances', testPersistenceAcrossInstances],
    ['remote: /journal summary + create + note', testRemoteJournalSummaryAndCreate],
    ['remote: note on unknown person = 404', testRemoteJournalPersonNoteWithoutMeetReturns404],
    ['remote: /journal requires bearer token', testRemoteJournalRequiresToken],
    ['remote: /journal 503 when dataDir absent', testRemoteJournal503WhenDataDirMissing],
  ];
  let passed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}`); console.error('   ', err && err.stack ? err.stack : err); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
}

run();

// lib/memory/journal.js
//
// Structured personal-context store layered on top of Memory. Keeps:
//   - people:  named entities with a relationship label and a history of notes
//              (e.g. current/ex partners, family, friends, coworkers). Each
//              person's notes carry over indefinitely so a future Iris session
//              still knows who "Sarah" or "my ex" is.
//   - goals:   long-running objectives with a status (active/done/dropped)
//              and an append-only list of progress notes. Goals are the
//              backbone of remote check-ins ("how's the gold progress?").
//   - notes:   timestamped free-form journal entries (mood, observations).
//
// Storage is plain JSON under <dataDir>/memory/journal/{people,goals,notes}.json.
// Mirrors the JSON-store pattern already used elsewhere in iris-app so the
// remote server and CLI can share a single source of truth.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RELATIONSHIPS = new Set([
  'partner', 'ex-partner', 'spouse', 'family', 'friend',
  'coworker', 'mentor', 'roommate', 'crush', 'other',
]);

const GOAL_STATUSES = new Set(['active', 'paused', 'done', 'dropped']);

class Journal {
  constructor({ dataDir, enabled = true } = {}) {
    if (!dataDir) throw new Error('Journal: dataDir is required');
    this.enabled = !!enabled;
    this.root = path.join(dataDir, 'memory', 'journal');
    if (this.enabled && !fs.existsSync(this.root)) {
      fs.mkdirSync(this.root, { recursive: true });
    }
    this.peopleFile = path.join(this.root, 'people.json');
    this.goalsFile = path.join(this.root, 'goals.json');
    this.notesFile = path.join(this.root, 'notes.jsonl');
  }

  // ── people ─────────────────────────────────────────────────────────────

  listPeople() {
    return this._readJson(this.peopleFile, []);
  }

  getPerson(name) {
    const key = normalizeName(name);
    if (!key) return null;
    return this.listPeople().find((p) => p.key === key) || null;
  }

  /**
   * Upsert a person. `patch` may contain name, relationship, aliases (array).
   * Returns the stored record.
   */
  upsertPerson(name, patch = {}) {
    if (!this.enabled) return null;
    const key = normalizeName(name);
    if (!key) throw new Error('upsertPerson: name required');
    const all = this.listPeople();
    let rec = all.find((p) => p.key === key);
    const now = Date.now();
    if (!rec) {
      rec = {
        id: crypto.randomUUID(),
        key,
        name: String(name).trim(),
        relationship: 'other',
        aliases: [],
        notes: [],
        createdAt: now,
        updatedAt: now,
      };
      all.push(rec);
    }
    if (patch.name) rec.name = String(patch.name).trim();
    if (patch.relationship) {
      const r = String(patch.relationship).trim().toLowerCase();
      rec.relationship = RELATIONSHIPS.has(r) ? r : 'other';
    }
    if (Array.isArray(patch.aliases)) {
      rec.aliases = [...new Set(patch.aliases.map((a) => String(a).trim()).filter(Boolean))];
    }
    rec.updatedAt = now;
    this._writeJson(this.peopleFile, all);
    return rec;
  }

  /**
   * Append a free-form note to a person's history. Notes are immutable; the
   * point is to build a timeline that "carries over a bunch of time".
   */
  addPersonNote(name, text) {
    if (!this.enabled) return null;
    const all = this.listPeople();
    const key = normalizeName(name);
    const rec = all.find((p) => p.key === key);
    if (!rec) throw new Error(`unknown person: ${name}`);
    const note = { id: crypto.randomUUID(), text: String(text || '').slice(0, 4000), ts: Date.now() };
    rec.notes.push(note);
    rec.updatedAt = note.ts;
    this._writeJson(this.peopleFile, all);
    return note;
  }

  removePerson(name) {
    if (!this.enabled) return false;
    const all = this.listPeople();
    const key = normalizeName(name);
    const next = all.filter((p) => p.key !== key);
    if (next.length === all.length) return false;
    this._writeJson(this.peopleFile, next);
    return true;
  }

  // ── goals ──────────────────────────────────────────────────────────────

  listGoals({ status } = {}) {
    const all = this._readJson(this.goalsFile, []);
    if (!status) return all;
    return all.filter((g) => g.status === status);
  }

  getGoal(id) {
    if (!id) return null;
    const needle = String(id);
    return this.listGoals().find((g) => g.id === needle || g.id.startsWith(needle)) || null;
  }

  /**
   * Create a goal. `title` is required; everything else is optional. Status
   * defaults to "active" so the goal shows up in remote check-ins right away.
   */
  createGoal({ title, description, status, dueAt } = {}) {
    if (!this.enabled) return null;
    if (!title || !String(title).trim()) throw new Error('createGoal: title required');
    const now = Date.now();
    const rec = {
      id: crypto.randomUUID(),
      title: String(title).trim().slice(0, 240),
      description: description ? String(description).slice(0, 2000) : '',
      status: GOAL_STATUSES.has(status) ? status : 'active',
      dueAt: dueAt ? Number(dueAt) : null,
      notes: [],
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    const all = this.listGoals();
    all.push(rec);
    this._writeJson(this.goalsFile, all);
    return rec;
  }

  updateGoal(id, patch = {}) {
    if (!this.enabled) return null;
    const all = this.listGoals();
    const rec = all.find((g) => g.id === id || g.id.startsWith(String(id)));
    if (!rec) throw new Error(`unknown goal: ${id}`);
    if (patch.title) rec.title = String(patch.title).trim().slice(0, 240);
    if (patch.description !== undefined) rec.description = String(patch.description || '').slice(0, 2000);
    if (patch.status) {
      const s = String(patch.status).trim().toLowerCase();
      if (!GOAL_STATUSES.has(s)) throw new Error(`bad goal status: ${s}`);
      rec.status = s;
      if (s === 'done' && !rec.completedAt) rec.completedAt = Date.now();
      if (s !== 'done') rec.completedAt = null;
    }
    if (patch.dueAt !== undefined) rec.dueAt = patch.dueAt ? Number(patch.dueAt) : null;
    rec.updatedAt = Date.now();
    this._writeJson(this.goalsFile, all);
    return rec;
  }

  /**
   * Append a progress note to a goal. This is what powers remote check-ins —
   * the most recent note is the "how's it going" answer.
   */
  addGoalNote(id, text) {
    if (!this.enabled) return null;
    const all = this.listGoals();
    const rec = all.find((g) => g.id === id || g.id.startsWith(String(id)));
    if (!rec) throw new Error(`unknown goal: ${id}`);
    const note = { id: crypto.randomUUID(), text: String(text || '').slice(0, 4000), ts: Date.now() };
    rec.notes.push(note);
    rec.updatedAt = note.ts;
    this._writeJson(this.goalsFile, all);
    return note;
  }

  removeGoal(id) {
    if (!this.enabled) return false;
    const all = this.listGoals();
    const next = all.filter((g) => g.id !== id && !g.id.startsWith(String(id)));
    if (next.length === all.length) return false;
    this._writeJson(this.goalsFile, next);
    return true;
  }

  // ── notes (free-form journal) ──────────────────────────────────────────

  /** Append a timestamped note. `tags` is an optional list. */
  addNote(text, { tags } = {}) {
    if (!this.enabled) return null;
    const rec = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      text: String(text || '').slice(0, 4000),
      tags: Array.isArray(tags) ? tags.map((t) => String(t).trim()).filter(Boolean) : [],
    };
    fs.appendFileSync(this.notesFile, JSON.stringify(rec) + '\n', 'utf8');
    return rec;
  }

  recentNotes(limit = 20) {
    if (!this.enabled || !fs.existsSync(this.notesFile)) return [];
    const raw = fs.readFileSync(this.notesFile, 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch {}
    }
    return out.slice(-limit).reverse();
  }

  /**
   * One-shot summary used by the Iris orchestrator context and the remote
   * /journal/summary endpoint. Kept small enough to inline in every turn.
   */
  buildSummary({ goalLimit = 5, peopleLimit = 6 } = {}) {
    const goals = this.listGoals({ status: 'active' }).slice(0, goalLimit).map((g) => ({
      id: g.id.slice(0, 8),
      title: g.title,
      lastNote: g.notes.length ? g.notes[g.notes.length - 1].text.slice(0, 160) : null,
      updatedAt: g.updatedAt,
    }));
    const people = this.listPeople()
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, peopleLimit)
      .map((p) => ({
        name: p.name,
        relationship: p.relationship,
        lastNote: p.notes.length ? p.notes[p.notes.length - 1].text.slice(0, 160) : null,
      }));
    return { goals, people };
  }

  // ── internals ──────────────────────────────────────────────────────────

  _readJson(file, fallback) {
    if (!this.enabled || !fs.existsSync(file)) return fallback;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  }

  _writeJson(file, value) {
    fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
  }
}

function normalizeName(name) {
  if (!name) return '';
  return String(name).trim().toLowerCase().replace(/\s+/g, ' ');
}

module.exports = { Journal, RELATIONSHIPS, GOAL_STATUSES, normalizeName };

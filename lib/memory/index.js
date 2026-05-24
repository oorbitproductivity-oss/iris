// lib/memory/index.js
//
// Hermes-style persistent memory for Iris Code.
//
// Three layers:
//   1. session  — short-lived; lives inside a session object, not persisted here.
//   2. prefs    — durable facts about the user (their role, machines, projects).
//   3. turn     — append-only log of (userText, assistantText) summaries.
//
// Storage: plain JSON files under <dataDir>/memory/. We chose JSON over a real
// SQLite/FTS5 store for now because (a) Node has no built-in sqlite without a
// native build step, (b) iris-app already ships a JSON-store pattern, and
// (c) the recall paths are bounded by the *size of a single user's memory*,
// which on a normal workstation is small enough that a linear scan is fine.
// The Phase-3 plan calls for FTS5; when the vendored Hermes drop lands we
// will swap the storage backend behind this same interface without changing
// any callers.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Memory {
  constructor({ dataDir, enabled = true } = {}) {
    if (!dataDir) throw new Error('Memory: dataDir is required');
    this.enabled = !!enabled;
    this.root = path.join(dataDir, 'memory');
    if (this.enabled && !fs.existsSync(this.root)) {
      fs.mkdirSync(this.root, { recursive: true });
    }
    this.prefsFile = path.join(this.root, 'prefs.json');
    this.turnsFile = path.join(this.root, 'turns.jsonl');
    this.indexFile = path.join(this.root, 'index.json');
  }

  // ── prefs ──────────────────────────────────────────────────────────────

  getPrefs() {
    if (!this.enabled || !fs.existsSync(this.prefsFile)) return {};
    try { return JSON.parse(fs.readFileSync(this.prefsFile, 'utf8')); } catch { return {}; }
  }

  setPref(key, value) {
    if (!this.enabled) return;
    const cur = this.getPrefs();
    cur[key] = value;
    fs.writeFileSync(this.prefsFile, JSON.stringify(cur, null, 2), 'utf8');
  }

  // ── turn log ───────────────────────────────────────────────────────────

  /**
   * Append a memory record. `record` has shape:
   *   { kind: 'turn'|'pref'|'skill-ref', summary: string, body?: string, ts: number }
   */
  async remember(record) {
    if (!this.enabled) return null;
    const rec = {
      id: crypto.randomUUID(),
      ts: record.ts || Date.now(),
      kind: record.kind || 'turn',
      summary: String(record.summary || '').slice(0, 1000),
      body: String(record.body || '').slice(0, 8000),
    };
    fs.appendFileSync(this.turnsFile, JSON.stringify(rec) + '\n', 'utf8');
    this._indexRecord(rec);
    return rec;
  }

  /**
   * Recall the top-N records whose summary/body has the highest term-overlap
   * score with `query`. Linear scan; fine for typical personal memory sizes.
   */
  async recall(query, { limit = 5 } = {}) {
    if (!this.enabled) return [];
    const all = this._readAll();
    if (!all.length) return [];
    const qTerms = tokenize(query);
    if (!qTerms.length) return all.slice(-limit).reverse();
    const scored = all.map((r) => ({ r, s: score(qTerms, r) })).filter((x) => x.s > 0);
    scored.sort((a, b) => b.s - a.s || b.r.ts - a.r.ts);
    return scored.slice(0, limit).map((x) => x.r);
  }

  recent(limit = 10) {
    if (!this.enabled) return [];
    return this._readAll().slice(-limit).reverse();
  }

  _readAll() {
    if (!fs.existsSync(this.turnsFile)) return [];
    const raw = fs.readFileSync(this.turnsFile, 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return out;
  }

  _indexRecord(rec) {
    // Simple inverted-index of terms → record ids, for future O(log n) recall.
    let idx;
    try { idx = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')); } catch { idx = { terms: {} }; }
    const terms = new Set(tokenize(rec.summary + ' ' + rec.body));
    for (const t of terms) {
      if (!idx.terms[t]) idx.terms[t] = [];
      idx.terms[t].push(rec.id);
      if (idx.terms[t].length > 200) idx.terms[t] = idx.terms[t].slice(-200);
    }
    try { fs.writeFileSync(this.indexFile, JSON.stringify(idx), 'utf8'); } catch {}
  }
}

// ── shared tokenizer + scorer ──────────────────────────────────────────────

const STOPWORDS = new Set([
  'the','a','an','and','or','of','to','in','on','for','with','is','are','was','were',
  'be','been','being','this','that','it','its','as','at','by','from','i','you','we',
  'they','he','she','my','your','our','their','do','does','did','have','has','had',
  'but','not','no','if','then','else','so','can','could','would','should','will',
]);

function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9_/.\-]+/)
    .filter((t) => t && t.length >= 2 && !STOPWORDS.has(t));
}

function score(qTerms, rec) {
  const docTerms = new Set(tokenize(rec.summary + ' ' + rec.body));
  if (!docTerms.size) return 0;
  let s = 0;
  for (const q of qTerms) if (docTerms.has(q)) s += 1;
  // Recency bonus: ~+1 for the last day, decaying.
  const ageDays = Math.max(0, (Date.now() - rec.ts) / 86400000);
  s += Math.max(0, 1 - ageDays / 30) * 0.5;
  return s;
}

module.exports = { Memory, tokenize, score };

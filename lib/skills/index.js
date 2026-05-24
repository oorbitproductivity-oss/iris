// lib/skills/index.js
//
// Hermes-style auto-learned skills. Stored as standalone markdown files in
// <dataDir>/skills/<slug>.md, with YAML frontmatter that follows the
// agentskills.io spec so files can be exported to other Hermes-compatible
// runtimes.
//
// File format:
//   ---
//   name: refactor-react-component
//   description: Split a fat React component into smaller pieces.
//   tags: [react, refactor]
//   created: 2026-05-19T10:23:45Z
//   ---
//   <body — the procedural instructions the agent should follow>
//
// The match() function returns the top-N skills whose name/description/tags
// overlap with the user's query.

'use strict';

const fs = require('fs');
const path = require('path');
const { tokenize, score } = require('../memory/index.js');

class Skills {
  constructor({ dataDir } = {}) {
    if (!dataDir) throw new Error('Skills: dataDir is required');
    this.root = path.join(dataDir, 'skills');
    if (!fs.existsSync(this.root)) fs.mkdirSync(this.root, { recursive: true });
  }

  list() {
    const files = fs.existsSync(this.root)
      ? fs.readdirSync(this.root).filter((f) => f.endsWith('.md'))
      : [];
    return files.map((f) => this._parseFile(path.join(this.root, f))).filter(Boolean);
  }

  load(name) {
    const file = path.join(this.root, `${slugify(name)}.md`);
    if (!fs.existsSync(file)) return null;
    return this._parseFile(file);
  }

  /** Save a skill. Overwrites if a skill with the same slugged name exists. */
  save({ name, description, tags = [], body }) {
    if (!name) throw new Error('Skills.save: name is required');
    if (!body) throw new Error('Skills.save: body is required');
    const slug = slugify(name);
    const file = path.join(this.root, `${slug}.md`);
    const fm = [
      '---',
      `name: ${name}`,
      `description: ${(description || '').replace(/\n/g, ' ')}`,
      `tags: [${tags.map((t) => String(t)).join(', ')}]`,
      `created: ${new Date().toISOString()}`,
      '---',
      '',
      body.trim(),
      '',
    ].join('\n');
    fs.writeFileSync(file, fm, 'utf8');
    return { name, description, tags, body, slug };
  }

  remove(name) {
    const file = path.join(this.root, `${slugify(name)}.md`);
    if (fs.existsSync(file)) { fs.unlinkSync(file); return true; }
    return false;
  }

  /** Top-N skills whose searchable text overlaps with `query`. */
  async match(query, { limit = 3, filter = null } = {}) {
    const qTerms = tokenize(query);
    let all = this.list();
    if (filter) {
      const pat = filter.toLowerCase();
      all = all.filter((s) =>
        s.name.toLowerCase().includes(pat) ||
        (s.tags || []).some((t) => String(t).toLowerCase().includes(pat))
      );
    }
    if (!qTerms.length) return all.slice(0, limit);
    const scored = all
      .map((s) => ({ s, score: score(qTerms, { summary: s.name + ' ' + s.description, body: s.body + ' ' + (s.tags || []).join(' '), ts: Date.parse(s.created) || Date.now() }) }))
      .filter((x) => x.score > 0);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((x) => x.s);
  }

  /**
   * Reflection pass: given a completed turn (userText + assistantText),
   * propose a candidate skill if the turn looks like it taught a repeatable
   * procedure. This is a heuristic; the GUI/CLI surfaces it for user approval
   * before persisting.
   *
   * Returns a candidate `{name, description, tags, body}` or null.
   */
  async reflect({ userText, assistantText }) {
    if (!userText || !assistantText) return null;
    // Heuristic: the assistant produced numbered steps or a recipe-like
    // structure, and the user's ask wasn't trivially short.
    const hasSteps = /\n\s*(\d+\.|-)\s/.test(assistantText);
    const stepCount = (assistantText.match(/\n\s*(\d+\.|-)\s/g) || []).length;
    if (!hasSteps || stepCount < 3 || userText.length < 30) return null;
    // Derive a name from the first noun-phrase-ish chunk of the user ask.
    const headline = userText
      .replace(/^[^a-z0-9]+/i, '')
      .split(/[.!?\n]/)[0]
      .trim()
      .slice(0, 80);
    if (!headline) return null;
    const name = `learned-${slugify(headline)}`.slice(0, 60);
    return {
      name,
      description: `Procedure for: ${headline}`,
      tags: ['auto', 'reflection'],
      body: assistantText.trim().slice(0, 4000),
    };
  }

  _parseFile(file) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      if (!m) return null;
      const fm = parseFrontmatter(m[1]);
      return {
        name: fm.name || path.basename(file, '.md'),
        description: fm.description || '',
        tags: Array.isArray(fm.tags) ? fm.tags : parseTagList(fm.tags),
        created: fm.created || null,
        body: (m[2] || '').trim(),
        file,
      };
    } catch {
      return null;
    }
  }
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function parseFrontmatter(yamlish) {
  const out = {};
  for (const line of yamlish.split('\n')) {
    const m = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].trim();
  }
  return out;
}

function parseTagList(s) {
  if (!s) return [];
  const m = String(s).match(/^\[(.*)\]$/);
  if (!m) return s.split(/[,\s]+/).filter(Boolean);
  return m[1].split(',').map((t) => t.trim()).filter(Boolean);
}

module.exports = { Skills };

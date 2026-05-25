// lib/terminal/pty-manager.js
//
// v0.5 Feature 3 — Integrated Terminal pane.
//
// Spawns and supervises real PTYs via node-pty. Designed so the whole
// module is *graceful when node-pty fails to load*: the native add-on
// needs `electron-rebuild` against the running Electron's Node ABI, and
// fresh dev checkouts often won't have rebuilt yet. Rather than crash
// the renderer when somebody clicks the Terminal pill, we set
// `_unavailable = true` and have every method return a structured
// `{ ok: false, error: ... }` so the renderer can paint a clear "feature
// unavailable" message in place of the terminal.
//
// Ownership model:
//   • Terminals are *not* tied to an agent's lifecycle. The user opens
//     a terminal *next to* an agent's chat; killing the agent does NOT
//     kill the terminal, and vice versa. `agentId` is purely a tag so
//     the renderer can scope its list view per-thread.
//   • Buffer of the last 10,000 lines is held in memory (NOT bytes; we
//     split on \n so "share last 50 lines" works no matter how chatty
//     the program is). The ring is a simple sliding array — bound to
//     `MAX_BUFFER_LINES` so a runaway `yes` won't blow up the heap.
//   • PTYs survive renderer reloads. The renderer subscribes to broadcast
//     events and rehydrates from getHistory() on mount.
//   • shutdown() is called from main.js's before-quit so we don't leak
//     a subprocess on app quit.
//
// Event surface (broadcast through the same channel as agent:event so the
// preload can ride the existing pipe):
//   { type: "terminal:data", terminalId, data }
//   { type: "terminal:exit", terminalId, code, signal }

'use strict';

const crypto = require('crypto');

const MAX_BUFFER_LINES = 10000;
const MAX_LINE_CHARS = 8192; // cap pathological single-line spam (eg `cat /dev/urandom`)

function defaultShell() {
  if (process.platform === 'win32') {
    return process.env.ComSpec || 'powershell.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

function defaultCwd() {
  return process.env.USERPROFILE || process.env.HOME || process.cwd();
}

/**
 * Try to require node-pty. We swallow ANY failure — missing module,
 * missing native binding, ABI mismatch, etc. — and surface it as
 * `_unavailable = true`. The caller can then refuse to spawn and
 * inform the user the feature needs `electron-rebuild`.
 */
function tryLoadNodePty(requireFn = require) {
  try {
    const mod = requireFn('node-pty');
    if (!mod || typeof mod.spawn !== 'function') {
      return { ok: false, error: 'node-pty loaded but has no spawn()' };
    }
    return { ok: true, pty: mod };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

class RingBuffer {
  constructor(max = MAX_BUFFER_LINES) {
    this.max = max;
    this.lines = [];
    this._partial = '';
  }

  /** Push a chunk of raw PTY output. Splits on \n and pushes whole lines. */
  push(chunk) {
    if (chunk == null) return;
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    // node-pty hands us mixed \r\n; normalize so we only split on \n.
    const joined = this._partial + text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const parts = joined.split('\n');
    // Last element is whatever didn't end with \n — buffer it until the next chunk.
    this._partial = parts.pop() || '';
    for (let line of parts) {
      if (line.length > MAX_LINE_CHARS) line = line.slice(0, MAX_LINE_CHARS);
      this.lines.push(line);
      if (this.lines.length > this.max) {
        // Drop in batches when over-budget so we're not shifting on every push.
        const over = this.lines.length - this.max;
        this.lines.splice(0, over);
      }
    }
  }

  /** Return the last N lines, INCLUDING the current partial if any. */
  tail(n) {
    const count = Math.max(0, Math.min(this.max, Number(n) || 0));
    if (count === 0) return [];
    const all = this._partial ? this.lines.concat([this._partial]) : this.lines.slice();
    return all.slice(-count);
  }

  size() {
    return this.lines.length;
  }
}

class PtyManager {
  /**
   * @param {object} opts
   * @param {string} [opts.dataDir]
   * @param {(event: object) => void} [opts.broadcast]
   * @param {Function} [opts.requireFn]  Injection point for tests so we can
   *                                     simulate a missing node-pty.
   */
  constructor({ dataDir = null, broadcast = null, requireFn = require } = {}) {
    this.dataDir = dataDir;
    this.broadcast = typeof broadcast === 'function' ? broadcast : null;

    const loaded = tryLoadNodePty(requireFn);
    this._unavailable = !loaded.ok;
    this._unavailableReason = loaded.ok ? null : loaded.error;
    this._pty = loaded.ok ? loaded.pty : null;

    // terminalId -> { proc, agentId, cwd, shell, cols, rows, buffer, createdAt, exited }
    this._terminals = new Map();
  }

  isAvailable() {
    return !this._unavailable;
  }

  unavailableReason() {
    return this._unavailableReason;
  }

  /**
   * Spawn a new PTY.
   * @returns {{ok:true, terminalId, agentId, cwd, shell} | {ok:false, error}}
   */
  create(opts = {}) {
    if (this._unavailable) {
      return { ok: false, error: this._unavailableReason || 'node-pty unavailable' };
    }
    const agentId = opts.agentId || null;
    const cwd = opts.cwd && typeof opts.cwd === 'string' ? opts.cwd : defaultCwd();
    const shell = opts.shell && typeof opts.shell === 'string' ? opts.shell : defaultShell();
    const cols = Number.isFinite(opts.cols) && opts.cols > 0 ? Math.floor(opts.cols) : 80;
    const rows = Number.isFinite(opts.rows) && opts.rows > 0 ? Math.floor(opts.rows) : 24;
    const terminalId = crypto.randomUUID();

    let proc;
    try {
      proc = this._pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: process.env,
      });
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }

    const entry = {
      terminalId,
      agentId,
      cwd,
      shell,
      cols,
      rows,
      proc,
      buffer: new RingBuffer(MAX_BUFFER_LINES),
      createdAt: Date.now(),
      exited: false,
    };
    this._terminals.set(terminalId, entry);

    proc.onData((data) => {
      try { entry.buffer.push(data); } catch {}
      this._emit({ type: 'terminal:data', terminalId, data });
    });

    proc.onExit(({ exitCode, signal }) => {
      entry.exited = true;
      this._emit({
        type: 'terminal:exit',
        terminalId,
        code: typeof exitCode === 'number' ? exitCode : null,
        signal: signal || null,
      });
    });

    return { ok: true, terminalId, agentId, cwd, shell };
  }

  write(terminalId, data) {
    const entry = this._terminals.get(terminalId);
    if (!entry || entry.exited) return false;
    try {
      entry.proc.write(typeof data === 'string' ? data : String(data || ''));
      return true;
    } catch {
      return false;
    }
  }

  resize(terminalId, cols, rows) {
    const entry = this._terminals.get(terminalId);
    if (!entry || entry.exited) return false;
    const c = Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : entry.cols;
    const r = Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : entry.rows;
    try {
      entry.proc.resize(c, r);
      entry.cols = c;
      entry.rows = r;
      return true;
    } catch {
      return false;
    }
  }

  kill(terminalId) {
    const entry = this._terminals.get(terminalId);
    if (!entry) return false;
    try {
      if (!entry.exited) entry.proc.kill();
    } catch {}
    entry.exited = true;
    // Drop from the map after a tick so any pending onExit can fire first.
    setTimeout(() => this._terminals.delete(terminalId), 50);
    return true;
  }

  list({ agentId } = {}) {
    const out = [];
    for (const e of this._terminals.values()) {
      if (agentId != null && e.agentId !== agentId) continue;
      out.push({
        terminalId: e.terminalId,
        agentId: e.agentId,
        cwd: e.cwd,
        shell: e.shell,
        createdAt: e.createdAt,
        exited: !!e.exited,
        cols: e.cols,
        rows: e.rows,
      });
    }
    return out;
  }

  getHistory(terminalId, lines = 50) {
    const entry = this._terminals.get(terminalId);
    if (!entry) return { ok: false, error: 'unknown terminalId' };
    const n = Number.isFinite(lines) && lines > 0 ? Math.floor(lines) : 50;
    return { ok: true, lines: entry.buffer.tail(n) };
  }

  shutdown() {
    for (const entry of this._terminals.values()) {
      try { if (!entry.exited) entry.proc.kill(); } catch {}
      entry.exited = true;
    }
    this._terminals.clear();
  }

  _emit(event) {
    if (!this.broadcast) return;
    try { this.broadcast(event); } catch {}
  }
}

module.exports = { PtyManager, RingBuffer, MAX_BUFFER_LINES };

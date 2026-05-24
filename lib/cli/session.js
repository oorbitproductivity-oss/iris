// lib/cli/session.js
//
// A long-lived `claude` subprocess driven over stream-json IPC.
//
// This is the "real Claude Code feel" path: one `claude` process stays
// alive for the whole REPL session, user messages stream in over stdin
// as JSON, assistant turns stream out over stdout. No cold-start per
// turn, full continuity, instant follow-ups.
//
// The shape mirrors what the upstream Claude Code CLI does internally
// for its own REPL.

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { normalize } = require('./claude-runner.js');

class ClaudeSession {
  /**
   * @param {object} opts
   * @param {string} opts.cwd
   * @param {string} [opts.model]
   * @param {string} [opts.effort]           'high' | 'low' | 'default'
   * @param {string} [opts.permissionMode]   'bypassPermissions' | 'plan' | 'acceptEdits'
   * @param {string} [opts.sessionId]        Resume an existing claude session
   * @param {string} [opts.appendSystem]
   * @param {string[]} [opts.addDirs]
   * @param {boolean} [opts.yolo]            Pass --dangerously-skip-permissions
   * @param {Function} [opts.onLog]          Stderr line listener.
   */
  constructor(opts = {}) {
    this.cwd = opts.cwd || process.cwd();
    this.model = opts.model || null;
    this.effort = opts.effort || 'high';
    this.permissionMode = opts.permissionMode || 'bypassPermissions';
    this.sessionId = opts.sessionId || null;
    this.appendSystem = opts.appendSystem || null;
    this.addDirs = opts.addDirs || null;
    this.yolo = !!opts.yolo;
    this.onLog = opts.onLog || null;

    this.proc = null;
    this.stdoutBuf = '';
    this.stderrTail = [];

    // Turn coordination — one in-flight turn at a time.
    this.turn = null;             // { queue, resolveWaiter, finished }
    this.startedAt = 0;
    this.totalUsage = { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_creation: 0, usd: 0 };
  }

  /** Start the subprocess. Resolves when claude is ready to accept input. */
  async start() {
    if (this.proc) return;
    if (!fs.existsSync(this.cwd)) {
      throw new Error(`cwd does not exist: ${this.cwd}`);
    }

    const args = this._buildArgs();
    const env = this._buildEnv();

    this.proc = trySpawn(args, { cwd: this.cwd, env });
    if (this.proc instanceof Error) {
      const err = this.proc;
      this.proc = null;
      throw new Error(`could not start \`claude\`: ${err.message}. Is the Claude Code CLI on your PATH?`);
    }

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => this._onStderr(chunk));
    this.proc.on('close', (code) => this._onClose(code));
    this.proc.on('error', (err) => this._onError(err));

    // claude is ready once it accepts the first stdin write — no init
    // handshake is required.
  }

  /**
   * Send a user message and yield normalized events until end-of-turn.
   * @param {string} text
   * @returns {AsyncIterable}
   */
  send(text) {
    if (!this.proc) throw new Error('session not started');
    if (this.turn && !this.turn.finished) {
      throw new Error('a turn is already in progress; wait for it to finish or interrupt()');
    }
    this.turn = { queue: [], resolveWaiter: null, finished: false };
    this.startedAt = Date.now();

    const payload = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: String(text) }],
      },
    }) + '\n';
    try {
      this.proc.stdin.write(payload);
    } catch (err) {
      this.turn.queue.push({ type: 'error', error: 'stdin write failed: ' + err.message });
      this.turn.queue.push({ type: 'stop', reason: 'error' });
      this.turn.finished = true;
    }

    const self = this;
    return (async function* () {
      while (true) {
        while (self.turn && self.turn.queue.length) {
          const ev = self.turn.queue.shift();
          yield ev;
        }
        if (!self.turn || self.turn.finished) return;
        await new Promise((r) => { self.turn.resolveWaiter = r; });
      }
    })();
  }

  /** Try to interrupt the current turn without killing the whole session. */
  interrupt() {
    if (!this.proc || !this.turn || this.turn.finished) return false;
    // The stream-json protocol accepts an interrupt control event.
    try {
      this.proc.stdin.write(JSON.stringify({ type: 'control', subtype: 'interrupt' }) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  /** Terminate the subprocess. */
  close() {
    if (!this.proc) return;
    try { this.proc.stdin.end(); } catch {}
    try { this.proc.kill(); } catch {}
    this.proc = null;
  }

  // ── internals ──

  _buildArgs() {
    const args = [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', this.permissionMode,
    ];
    if (this.model) args.push('--model', this.model);
    if (this.effort && this.effort !== 'default') args.push('--effort', this.effort);
    if (this.sessionId) args.push('--resume', this.sessionId);
    if (this.appendSystem) args.push('--append-system-prompt', this.appendSystem);
    if (this.addDirs) for (const d of this.addDirs) args.push('--add-dir', d);
    if (this.yolo) args.push('--dangerously-skip-permissions');
    return args;
  }

  _buildEnv() {
    return {
      ...process.env,
      PATH: (process.env.PATH || '') + path.delimiter +
        path.join(process.env.USERPROFILE || process.env.HOME || '', '.local', 'bin'),
      CLAUDE_CODE_MAX_OUTPUT_TOKENS:
        process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || '64000',
    };
  }

  _onStdout(chunk) {
    this.stdoutBuf += chunk;
    let idx;
    while ((idx = this.stdoutBuf.indexOf('\n')) !== -1) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let json;
      try { json = JSON.parse(line); } catch { continue; }
      for (const ev of normalize(json)) this._enqueue(ev);
    }
  }

  _enqueue(ev) {
    if (ev.type === 'session') this.sessionId = ev.id;
    if (ev.type === 'usage') {
      this.totalUsage.input_tokens += ev.input_tokens || 0;
      this.totalUsage.output_tokens += ev.output_tokens || 0;
      this.totalUsage.cache_read += ev.cache_read || 0;
      this.totalUsage.cache_creation += ev.cache_creation || 0;
    }
    if (ev.type === 'cost') this.totalUsage.usd += ev.usd || 0;

    if (!this.turn) return;
    if (ev.type === 'turn_end') {
      // Convert to the public 'stop' event so callers see the same shape
      // as the one-shot runner.
      this.turn.queue.push({ type: 'stop', reason: 'end_turn' });
      this.turn.finished = true;
    } else {
      this.turn.queue.push(ev);
    }
    if (this.turn.resolveWaiter) {
      const r = this.turn.resolveWaiter;
      this.turn.resolveWaiter = null;
      r();
    }
  }

  _onStderr(chunk) {
    for (const line of String(chunk).split('\n')) {
      if (!line.trim()) continue;
      this.stderrTail.push(line);
      while (this.stderrTail.length > 50) this.stderrTail.shift();
      if (this.onLog) this.onLog(line);
    }
  }

  _onClose(code) {
    const tail = this.stderrTail.join('\n');
    if (this.turn && !this.turn.finished) {
      const msg = code === 0 ? 'claude exited' : `claude exited (${code})`;
      this.turn.queue.push({ type: 'error', error: tail ? `${msg}:\n${tail}` : msg });
      this.turn.queue.push({ type: 'stop', reason: 'error' });
      this.turn.finished = true;
      if (this.turn.resolveWaiter) { const r = this.turn.resolveWaiter; this.turn.resolveWaiter = null; r(); }
    }
    this.proc = null;
  }

  _onError(err) {
    if (this.turn && !this.turn.finished) {
      this.turn.queue.push({ type: 'error', error: 'subprocess error: ' + err.message });
      this.turn.queue.push({ type: 'stop', reason: 'error' });
      this.turn.finished = true;
      if (this.turn.resolveWaiter) { const r = this.turn.resolveWaiter; this.turn.resolveWaiter = null; r(); }
    }
  }
}

function trySpawn(args, opts) {
  try {
    return spawn('claude', args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  } catch (err) {
    try {
      return spawn('claude', args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'], shell: true });
    } catch {
      return err;
    }
  }
}

/** Find the most recent saved session id for a cwd (so we can /resume cleanly). */
function findLastSessionFor(cwd, sessionsDir) {
  try {
    if (!fs.existsSync(sessionsDir)) return null;
    const files = fs.readdirSync(sessionsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8'));
          return { file: f, cwd: j.cwd, claudeSessionId: j.claudeSessionId, mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs };
        } catch { return null; }
      })
      .filter((x) => x && x.cwd === cwd && x.claudeSessionId);
    files.sort((a, b) => b.mtime - a.mtime);
    return files[0] ? files[0].claudeSessionId : null;
  } catch {
    return null;
  }
}

module.exports = { ClaudeSession, findLastSessionFor };

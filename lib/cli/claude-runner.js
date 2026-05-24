// lib/cli/claude-runner.js
//
// The CLI's default execution path: spawn the user's locally installed
// `claude` CLI as a subprocess and pipe its stream-json over stdout. No
// API key required — auth flows through the user's existing Claude Code
// subscription (Pro/Max OAuth), the same way `claude` itself does it.
//
// This file is the headless twin of lib/agent-manager.js (which is the
// GUI's per-agent subprocess pool). The two share the same spawn flags,
// the same stream-json parser, and the same fallback retry-with-shell
// quirk on Windows. The difference is this one is a single-shot, prints
// to a TTY, and assumes power-user permissions by default.

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const DEFAULT_PERMISSION_MODE = 'bypassPermissions';
const DEFAULT_EFFORT = 'high';
const DEFAULT_OUTPUT_TOKENS = '64000';

/**
 * Run a single Claude Code turn and yield normalized stream events.
 *
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} [opts.cwd]           Defaults to process.cwd().
 * @param {string} [opts.model]
 * @param {string} [opts.effort]        'high' | 'low' | 'default'.
 * @param {string} [opts.permissionMode]  default 'bypassPermissions'.
 * @param {string} [opts.sessionId]     Resume an existing session.
 * @param {string} [opts.systemPrompt]  Replaces the default system prompt.
 * @param {string} [opts.appendSystem]  Appended to the default.
 * @param {string[]} [opts.tools]       Whitelist of tool names.
 * @param {string[]} [opts.addDirs]     Extra workspaces to expose.
 * @param {string} [opts.apiKey]        Optional ANTHROPIC_API_KEY (BYOK).
 * @returns {AsyncIterable} normalized events
 */
function runClaude(opts) {
  const args = buildArgs(opts);
  const env = buildEnv(opts);
  const cwd = opts.cwd || process.cwd();

  if (!fs.existsSync(cwd)) {
    return errorStream(`cwd does not exist: ${cwd}`);
  }

  return (async function* () {
    const proc = trySpawn(args, { cwd, env });
    if (proc instanceof Error) {
      yield { type: 'error', error: `could not start \`claude\`: ${proc.message}. Is the Claude Code CLI on your PATH?` };
      yield { type: 'stop', reason: 'error' };
      return;
    }

    let buf = '';
    const queue = [];
    let resolveWaiter = null;
    let done = false;

    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let json;
        try { json = JSON.parse(line); } catch { continue; }
        for (const ev of normalize(json)) {
          queue.push(ev);
          if (resolveWaiter) { resolveWaiter(); resolveWaiter = null; }
        }
      }
    });

    let stderrBuf = '';
    proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString('utf8'); });

    proc.on('close', (code) => {
      if (code !== 0) {
        const tail = stderrBuf.trim().split('\n').slice(-4).join('\n');
        queue.push({ type: 'error', error: `claude exited ${code}${tail ? ':\n' + tail : ''}` });
      }
      queue.push({ type: 'stop', reason: code === 0 ? 'end_turn' : 'error' });
      done = true;
      if (resolveWaiter) { resolveWaiter(); resolveWaiter = null; }
    });

    proc.on('error', (err) => {
      queue.push({ type: 'error', error: err.message });
      queue.push({ type: 'stop', reason: 'error' });
      done = true;
      if (resolveWaiter) { resolveWaiter(); resolveWaiter = null; }
    });

    while (true) {
      while (queue.length) yield queue.shift();
      if (done) return;
      await new Promise((r) => { resolveWaiter = r; });
    }
  })();
}

function buildArgs(opts) {
  const args = [
    '-p', opts.prompt || '',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode', opts.permissionMode || DEFAULT_PERMISSION_MODE,
  ];
  if (opts.model) args.push('--model', opts.model);
  const effort = opts.effort || DEFAULT_EFFORT;
  if (effort && effort !== 'default') args.push('--effort', effort);
  if (opts.sessionId) args.push('--resume', opts.sessionId);
  if (opts.systemPrompt) args.push('--system-prompt', opts.systemPrompt);
  if (opts.appendSystem) args.push('--append-system-prompt', opts.appendSystem);
  if (opts.tools && opts.tools.length) args.push('--tools', opts.tools.join(','));
  if (opts.addDirs && opts.addDirs.length) {
    for (const d of opts.addDirs) args.push('--add-dir', d);
  }
  return args;
}

function buildEnv(opts) {
  const env = {
    ...process.env,
    PATH: (process.env.PATH || '') + path.delimiter +
      path.join(process.env.USERPROFILE || process.env.HOME || '', '.local', 'bin'),
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || DEFAULT_OUTPUT_TOKENS,
  };
  if (opts.apiKey) {
    env.ANTHROPIC_API_KEY = opts.apiKey;
  } else {
    // Subscription mode: never touch the env var, let the user's OAuth flow.
    delete env.ANTHROPIC_API_KEY;
  }
  return env;
}

function trySpawn(args, { cwd, env }) {
  try {
    return spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  } catch (err) {
    // Windows quirk: `claude.cmd` only resolves through the shell.
    try {
      return spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: true });
    } catch {
      return err;
    }
  }
}

function errorStream(msg) {
  return (async function* () {
    yield { type: 'error', error: msg };
    yield { type: 'stop', reason: 'error' };
  })();
}

/**
 * Normalize one parsed stream-json event from the `claude` CLI into the
 * provider-event shape used elsewhere in Iris Code.
 *
 * The claude CLI emits a few event types; we only care about the user-
 * visible bits here. tool calls and tool results are surfaced verbatim so
 * the CLI can pretty-print them.
 */
function normalize(evt) {
  const out = [];
  if (!evt || typeof evt !== 'object') return out;

  const t = evt.type;
  if (t === 'system' && evt.session_id) {
    out.push({ type: 'session', id: evt.session_id });
  } else if (t === 'assistant' && evt.message && evt.message.content) {
    for (const c of evt.message.content) {
      if (c.type === 'text' && c.text) {
        out.push({ type: 'text', delta: c.text });
      } else if (c.type === 'tool_use') {
        out.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input || {} });
      }
    }
  } else if (t === 'user' && evt.message && evt.message.content) {
    for (const c of evt.message.content) {
      if (c.type === 'tool_result') {
        out.push({ type: 'tool_result', id: c.tool_use_id, output: c.content });
      }
    }
  } else if (t === 'result') {
    if (evt.usage) {
      out.push({
        type: 'usage',
        input_tokens: evt.usage.input_tokens || 0,
        output_tokens: evt.usage.output_tokens || 0,
        cache_read: evt.usage.cache_read_input_tokens || 0,
        cache_creation: evt.usage.cache_creation_input_tokens || 0,
      });
    }
    if (typeof evt.total_cost_usd === 'number') {
      out.push({ type: 'cost', usd: evt.total_cost_usd });
    }
    // End-of-turn signal for persistent sessions. The one-shot runner has its
    // own synthetic stop on process close; this one is for stream-json mode
    // where the process keeps running across turns.
    out.push({ type: 'turn_end', subtype: evt.subtype || 'success' });
  } else if (t === 'stream_event' && evt.event) {
    // partial messages — text deltas during streaming.
    const inner = evt.event;
    if (inner.type === 'content_block_delta' && inner.delta && inner.delta.type === 'text_delta') {
      out.push({ type: 'text', delta: inner.delta.text || '', partial: true });
    }
  }
  return out;
}

module.exports = { runClaude, buildArgs, normalize };

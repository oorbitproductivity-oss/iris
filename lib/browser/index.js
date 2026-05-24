// lib/browser/index.js
//
// Wraps Iris Code's browser-test loop. Iris Code commits to Claude in
// Chrome as the single browser-automation path (per Phase 6 of the build
// plan). This module:
//
//  1. Gates the feature behind an Anthropic-key precondition (other
//     providers are fine in general, but the Claude in Chrome extension
//     is Anthropic-only).
//  2. Enforces a per-project domain allowlist (default: localhost +
//     127.0.0.1).
//  3. Treats extension failures as recoverable: retry with backoff,
//     surface a clear error to the caller, never crash the session.
//  4. Exposes a single `runBrowserTask({task})` API that the CLI's
//     `/test-in-browser` command and the GUI button both call into.
//
// The actual extension RPC surface is abstracted behind a small `Client`
// object. The default client is an HTTP shim that talks to a local proxy
// the user has configured (e.g. a small companion app exposing the
// claude-in-chrome MCP tools over HTTP). Tests can pass their own client
// for deterministic unit testing without a real browser.

'use strict';

const DEFAULT_ALLOWLIST = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];
const DEFAULT_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 750;

class BrowserTestRunner {
  /**
   * @param {object} deps
   * @param {object} deps.store              Store with getApiKeys/getApiKeyValue.
   * @param {object} [deps.client]           Override RPC client (for tests).
   * @param {string[]} [deps.allowlist]      Domain allowlist.
   * @param {boolean} [deps.featureEnabled]  Force-enable for tests.
   */
  constructor({ store, client = null, allowlist = DEFAULT_ALLOWLIST, featureEnabled = null } = {}) {
    this.store = store;
    this.client = client;
    this.allowlist = allowlist.slice();
    this.featureEnabledOverride = featureEnabled;
  }

  /** Returns {ok, reason} — never throws. */
  preflight() {
    if (this.featureEnabledOverride === true) return { ok: true };
    if (this.featureEnabledOverride === false) return { ok: false, reason: 'feature flag off' };
    if (!this.store) return { ok: false, reason: 'no key store available' };
    const keys = this.store.getApiKeys ? this.store.getApiKeys() : [];
    const hasAnthropic = keys.some((k) => k.name && k.name.toLowerCase().includes('anthropic'));
    if (!hasAnthropic) {
      return { ok: false, reason: 'Claude in Chrome requires an Anthropic API key. Run: iris key add anthropic' };
    }
    return { ok: true };
  }

  /** Check a URL's host against the allowlist. */
  isHostAllowed(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      return this.allowlist.some((entry) => {
        const e = String(entry).toLowerCase();
        if (e.endsWith(':*')) return host === e.slice(0, -2);
        return host === e || host.endsWith('.' + e);
      });
    } catch {
      return false;
    }
  }

  addAllowedDomain(domain) {
    if (!domain) return;
    if (!this.allowlist.includes(domain)) this.allowlist.push(domain);
  }

  /**
   * Run a browser task. Returns
   *   { ok: true, result } | { ok: false, error, recoverable }
   *
   * The task object shape:
   *   { url, steps: [{action, ...}], expect: [...] }
   * Steps map to client RPCs (navigate, click, type, read, screenshot).
   */
  async runBrowserTask(task) {
    const pre = this.preflight();
    if (!pre.ok) return { ok: false, error: pre.reason, recoverable: false };
    if (!task || !task.url) return { ok: false, error: 'task.url required', recoverable: false };
    if (!this.isHostAllowed(task.url)) {
      return {
        ok: false,
        recoverable: false,
        error: `domain not allowed: ${task.url}. Add to project allowlist or use localhost.`,
      };
    }
    const client = this.client || (await this._lazyClient());
    if (!client) {
      return {
        ok: false,
        recoverable: false,
        error: 'no claude-in-chrome client wired up. Install the extension and the local proxy first.',
      };
    }

    const retries = task.retries == null ? DEFAULT_RETRIES : task.retries;
    let lastErr = null;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const result = await this._runOnce(client, task);
        return { ok: true, result };
      } catch (err) {
        lastErr = err && err.message ? err.message : String(err);
        if (attempt < retries - 1) {
          await sleep(DEFAULT_BACKOFF_MS * Math.pow(2, attempt));
        }
      }
    }
    return { ok: false, error: lastErr || 'unknown', recoverable: true };
  }

  async _runOnce(client, task) {
    await client.navigate({ url: task.url });
    const traces = [];
    for (const step of task.steps || []) {
      switch (step.action) {
        case 'navigate':
          traces.push({ step, out: await client.navigate({ url: step.url }) });
          break;
        case 'click':
          traces.push({ step, out: await client.click({ selector: step.selector }) });
          break;
        case 'type':
          traces.push({ step, out: await client.type({ selector: step.selector, text: step.text }) });
          break;
        case 'read':
          traces.push({ step, out: await client.read({ selector: step.selector }) });
          break;
        case 'screenshot':
          traces.push({ step, out: await client.screenshot({}) });
          break;
        case 'console':
          traces.push({ step, out: await client.console({ pattern: step.pattern }) });
          break;
        default:
          throw new Error(`unknown browser step: ${step.action}`);
      }
    }
    const expectations = [];
    for (const exp of task.expect || []) {
      const v = await client.read({ selector: exp.selector });
      const text = (v && v.text) || '';
      const pass = exp.contains ? text.includes(exp.contains) : !!text;
      expectations.push({ ...exp, pass, actual: text });
    }
    return { traces, expectations, ok: expectations.every((e) => e.pass) };
  }

  async _lazyClient() {
    // In the real product this would discover the local Claude in Chrome
    // proxy and return a configured client. Left as null in this module so
    // the runner can be unit-tested without a running browser; the GUI
    // wires the real client in.
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { BrowserTestRunner, DEFAULT_ALLOWLIST };

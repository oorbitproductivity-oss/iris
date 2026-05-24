// lib/telegram/index.js
//
// TelegramService — bridges Telegram DMs to the Iris agent runtime.
//
// Bring-your-own-bot model: one user, one bot, one paired chat. No shared
// infrastructure, no server side, just long-polling against api.telegram.org
// from the user's own desktop.
//
// Lifecycle
//   const svc = new TelegramService({ manager, store, dataDir, onStatus });
//   svc.start();                  // boot polling iff a token is configured
//   svc.handleAgentEvent(event);  // called from main.js's broadcast()
//   svc.stop();                   // for app shutdown / token clear
//
// State stored in store.settings.telegram:
//   { enabled, botUsername, allowedChatId, chatAgentId, defaultCwd, chatMode }
// The token itself never lives in plaintext on disk — it goes through
// store.setTelegramToken() / getTelegramToken() (safeStorage → AES-GCM fallback).
//
// Per-chat behavior (only one chat is ever allowed):
//   - First message AFTER user clicks "Pair my phone" → check it against the
//     pending 6-digit code. Match → save chat_id as allowedChatId, reply "✅".
//   - Once paired, every text message either runs as a new agent task or, if
//     an agent already exists for that chat, is sent to it.
//   - /new resets the bound agent (deletes it and creates a fresh one on the
//     next message). /stop cancels the current run. /help shows usage.
//   - Any message from a chat_id ≠ allowedChatId is silently dropped — the
//     allowlist is the security boundary.
//
// Workspace selection (worker mode):
//   - Default: each /new gets a fresh sandboxed dir under
//     dataDir/telegram-workspaces/<random>/. Safe — the agent can read/write
//     only inside Telegram-owned storage.
//   - settings.telegram.defaultCwd (or in-chat /cwd <abs path>) overrides the
//     default with a user-chosen folder. NEW SESSIONS RUN UNSANDBOXED in that
//     folder, so the agent can edit the user's real files. This is the user
//     trading "safety against a stolen chat" for "do real work from my phone".
//
// Iris orchestrator mode:
//   - /iris (or the /control menu) flips the chat into orchestrator mode.
//     Messages from then on go to the always-on master Iris agent — same one
//     the desktop sidebar talks to — so the user can plan, delegate to
//     workers, and see suggested actions, all from their phone.
//   - /worker flips back to spawn-a-worker mode.
//
// Resilience
//   - getUpdates loops with exponential backoff (1s → 30s) on any error.
//   - One polling "tick" failure never crashes the loop.
//   - Outgoing sendMessage failures are logged but never thrown; the agent
//     stream keeps running locally even if Telegram is unreachable.

'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');

const api = require('./api.js');
const md = require('./markdown.js');

const POLL_TIMEOUT_S = 25;     // Telegram-side long-poll seconds.
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MENU_TTL_MS = 5 * 60 * 1000;          // numbered menu validity window

function now() { return Date.now(); }

function newPairingCode() {
  // Six decimal digits, zero-padded. crypto.randomInt is sync-safe and
  // uniform across the 0–999999 range.
  const n = crypto.randomInt(0, 1000000);
  return String(n).padStart(6, '0');
}

class TelegramService {
  /**
   * @param {object} opts
   * @param {object} opts.manager  — AgentManager
   * @param {object} opts.store    — Store (with getTelegramToken/setTelegramToken)
   * @param {string} opts.dataDir  — used to pick a default working directory
   *                                 for Telegram-spawned agents
   * @param {(status: object) => void} [opts.onStatus] — called whenever
   *                                 status changes; main wires this to the UI
   */
  constructor({ manager, store, dataDir, onStatus } = {}) {
    if (!manager) throw new Error('TelegramService: manager required');
    if (!store) throw new Error('TelegramService: store required');
    if (!dataDir) throw new Error('TelegramService: dataDir required');
    this.manager = manager;
    this.store = store;
    this.dataDir = dataDir;
    this.onStatus = typeof onStatus === 'function' ? onStatus : () => {};

    /** @type {string|null} */
    this.token = null;
    /** @type {string|null} */
    this.botUsername = null;
    /** @type {number|string|null} */
    this.allowedChatId = null;
    /**
     * Pairing state. While `code` is set, the very next text message from any
     * chat that matches `code` claims the chat as the allowed one.
     * @type {null | { code: string, expiresAt: number }}
     */
    this.pairing = null;
    /** Agent currently bound to the paired chat (worker mode only). */
    this.chatAgentId = null;
    /**
     * Routing mode for inbound messages from the paired chat.
     *   "worker" — route to (or spawn) a sandboxed worker agent (default).
     *   "iris"   — route to the always-on Iris master orchestrator.
     * Toggled by /iris and /worker commands and by the /control menu.
     */
    this.chatMode = 'worker';
    /**
     * User-chosen working directory for NEW worker sessions. When set,
     * overrides the default sandboxed telegram-workspaces/<random>/ dir
     * AND turns the sandbox OFF so the agent works in the user's real
     * folder. Persisted as settings.telegram.defaultCwd.
     */
    this.defaultCwd = null;
    /**
     * One-shot cwd override for the next worker session (set by /cwd
     * <path>). Takes precedence over defaultCwd for one /new, then
     * clears. Not persisted — only valid for the current run of the app.
     */
    this.pendingWorkerCwd = null;

    /** Polling loop control. */
    this._running = false;
    this._stopRequested = false;
    this._updateOffset = null;
    this._backoff = MIN_BACKOFF_MS;
    /** Last error surfaced to the UI (for the status panel). */
    this.lastError = null;
    /** Connection state: "stopped" | "connecting" | "online" | "error" */
    this.connection = 'stopped';

    // For routing stream events: which agent ids did Telegram create / adopt?
    // We only forward events for those — never spam the chat with desktop
    // worker output.
    this._ourAgentIds = new Set();
    // Pending numbered menu (per paired chat — we only allow one chat, so
    // a single field is enough). When set, the next bare-number message
    // selects an option from this menu instead of routing to the agent.
    // Cleared on selection, on any non-digit message, or after MENU_TTL_MS.
    this._menu = null;
    // Per-agent "got at least one result event this turn" tracking. When
    // a 'done' event arrives without a 'result' having fired first, the
    // claude subprocess finished silently — most often because a stale
    // sessionId from before an app restart couldn't be resumed. We surface
    // an error to Telegram AND clear the sessionId so the next message
    // starts a fresh session.
    this._turnGotResult = new Set();
    // Buffer the most recent assistant text per agent so we can fall back to
    // it if a `result` event ever lacks payload.
    this._lastResultByAgent = new Map();

    this._loadStateFromStore();
  }

  // ── Status / config ───────────────────────────────────────

  getStatus() {
    return {
      enabled: this._enabled(),
      hasToken: !!this.token,
      botUsername: this.botUsername || null,
      paired: !!this.allowedChatId,
      allowedChatId: this.allowedChatId || null,
      pairing: this.pairing
        ? { code: this.pairing.code, expiresAt: this.pairing.expiresAt }
        : null,
      connection: this.connection,
      lastError: this.lastError,
      chatAgentId: this.chatAgentId,
      chatMode: this.chatMode,
      defaultCwd: this.defaultCwd,
      pendingWorkerCwd: this.pendingWorkerCwd,
    };
  }

  _enabled() {
    const s = this.store.getSettings();
    return !!(s.telegram && s.telegram.enabled);
  }

  _emitStatus() {
    try { this.onStatus(this.getStatus()); } catch (err) {
      console.error('[telegram] onStatus listener threw:', err);
    }
  }

  _loadStateFromStore() {
    const s = this.store.getSettings();
    const t = (s && s.telegram) || {};
    this.botUsername = t.botUsername || null;
    this.allowedChatId = (t.allowedChatId != null) ? t.allowedChatId : null;
    this.chatAgentId = t.chatAgentId || null;
    if (this.chatAgentId) this._ourAgentIds.add(this.chatAgentId);
    // Routing mode + user-chosen workspace. Defensive: any unknown value
    // falls back to safe defaults (worker mode, sandboxed workspace).
    this.chatMode = (t.chatMode === 'iris') ? 'iris' : 'worker';
    this.defaultCwd = (typeof t.defaultCwd === 'string' && t.defaultCwd.trim())
      ? t.defaultCwd.trim()
      : null;
    // Restore the list of every agent Telegram has ever spawned, so /list
    // and /switch survive an app restart. Filter against the live agent
    // registry — agents the user deleted from the desktop UI are gone for
    // good and shouldn't reappear in the picker.
    const stored = Array.isArray(t.ownedAgentIds) ? t.ownedAgentIds : [];
    for (const id of stored) {
      if (typeof id === 'string' && this.manager && this.manager.agents && this.manager.agents[id]) {
        this._ourAgentIds.add(id);
      }
    }
    try { this.token = this.store.getTelegramToken(); }
    catch (err) {
      console.error('[telegram] failed to load token:', err);
      this.token = null;
    }
  }

  /** Save the current set of Telegram-owned agent ids back to settings. */
  _persistOwnedAgentIds() {
    const ids = Array.from(this._ourAgentIds);
    const s = this.store.getSettings();
    const next = { ...(s.telegram || {}), ownedAgentIds: ids };
    this.store.setSettings({ telegram: next });
  }

  _saveState(patch) {
    const s = this.store.getSettings();
    const next = { ...(s.telegram || {}), ...(patch || {}) };
    this.store.setSettings({ telegram: next });
  }

  // ── Public API used by main.js IPC handlers ──────────────

  /**
   * Persist a new bot token, verify it with getMe(), and (if enabled) start
   * polling. Returns the new status.
   */
  async setToken(rawToken) {
    const tok = String(rawToken || '').trim();
    if (!tok) throw new Error('token required');
    if (!/^\d{5,}:[\w-]{30,}$/.test(tok)) {
      throw new Error('That doesn\'t look like a Telegram bot token. Expected format: 12345:abcdefg…');
    }
    // Verify before saving so a typo doesn't replace a good token.
    let me;
    try {
      me = await api.getMe(tok);
    } catch (err) {
      throw new Error('Telegram rejected the token: ' + (err.message || err));
    }
    this.store.setTelegramToken(tok);
    this.token = tok;
    this.botUsername = me && me.username ? me.username : null;
    this._saveState({ botUsername: this.botUsername });

    // Wipe pairing & allowlist when the token changes — a new bot is a new
    // identity, the old pairing belongs to a different bot.
    this.pairing = null;
    this.allowedChatId = null;
    this.chatAgentId = null;
    this._saveState({ allowedChatId: null, chatAgentId: null });

    // Best-effort: a webhook would silently break long-polling, so always clear it.
    try { await api.deleteWebhook(tok); } catch (err) {
      console.warn('[telegram] deleteWebhook failed (continuing):', err.message || err);
    }

    this._emitStatus();
    if (this._enabled()) await this.start();
    return this.getStatus();
  }

  /** Remove the stored token and stop polling. Clears pairing too. */
  async clearToken() {
    this.stop();
    try { this.store.setTelegramToken(null); } catch (err) {
      console.error('[telegram] clearTelegramToken failed:', err);
    }
    this.token = null;
    this.botUsername = null;
    this.allowedChatId = null;
    this.pairing = null;
    this.chatAgentId = null;
    // Clear the per-Telegram agent set on token wipe — those agents belong
    // to the old bot. We leave the agent RECORDS alone (user might still
    // want them via the desktop UI) but drop our claim on them.
    this._ourAgentIds.clear();
    this._saveState({ botUsername: null, allowedChatId: null, chatAgentId: null, ownedAgentIds: [] });
    this._emitStatus();
    return this.getStatus();
  }

  async setEnabled(enabled) {
    this._saveState({ enabled: !!enabled });
    if (enabled) {
      await this.start();
    } else {
      this.stop();
    }
    this._emitStatus();
    return this.getStatus();
  }

  /**
   * Begin pairing: generate a 6-digit code and return it. The next text
   * message from a chat that matches the code becomes the allowed chat.
   */
  startPairing() {
    if (!this.token) throw new Error('Set a bot token first.');
    if (!this._running) {
      // Pairing requires the polling loop to actually receive the user's
      // code message — if the user hasn't enabled the service yet, enable
      // it implicitly here so pairing works in one step.
      this._saveState({ enabled: true });
      this.start().catch((err) => console.error('[telegram] start during pair failed:', err));
    }
    this.pairing = {
      code: newPairingCode(),
      expiresAt: now() + PAIRING_CODE_TTL_MS,
    };
    this._emitStatus();
    return this.pairing;
  }

  cancelPairing() {
    this.pairing = null;
    this._emitStatus();
    return this.getStatus();
  }

  /**
   * Persist a user-chosen default working directory for Telegram-spawned
   * worker agents. Pass null/empty to clear it (returns to sandboxed default).
   *
   * When set, the path is validated (must be absolute and exist on disk) so
   * we don't silently swallow typos. New worker sessions started AFTER this
   * call will run in that folder UNSANDBOXED — the agent gets real write
   * access to the user's files there. Existing chatAgentId is left alone
   * (the user can /new to start a session in the new cwd).
   */
  setDefaultCwd(rawPath) {
    const v = (rawPath == null) ? null : String(rawPath).trim();
    if (!v) {
      this.defaultCwd = null;
      this._saveState({ defaultCwd: null });
      this._emitStatus();
      return this.getStatus();
    }
    if (!path.isAbsolute(v)) {
      throw new Error('Default folder must be an absolute path.');
    }
    if (!fs.existsSync(v)) {
      throw new Error('That folder does not exist on disk.');
    }
    let stat;
    try { stat = fs.statSync(v); }
    catch (err) { throw new Error('Could not access that folder: ' + (err.message || err)); }
    if (!stat.isDirectory()) {
      throw new Error('That path is a file, not a folder.');
    }
    this.defaultCwd = v;
    this._saveState({ defaultCwd: v });
    this._emitStatus();
    return this.getStatus();
  }

  /**
   * Flip routing mode between worker (default) and iris (orchestrator).
   * Persists across restarts.
   */
  setChatMode(mode) {
    const next = (mode === 'iris') ? 'iris' : 'worker';
    if (next === this.chatMode) return this.getStatus();
    this.chatMode = next;
    this._saveState({ chatMode: next });
    this._emitStatus();
    return this.getStatus();
  }

  /** Send a test message to the paired chat. Errors propagate. */
  async sendTestMessage() {
    if (!this.token) throw new Error('No bot token configured.');
    if (!this.allowedChatId) throw new Error('Not paired yet.');
    const text =
      '✅ *Iris Code* is connected\\.\n' +
      'Send any message and it\'ll run as a Claude Code task on your desktop\\.';
    await api.sendMessage(this.token, {
      chat_id: this.allowedChatId,
      text,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
    });
    return { ok: true };
  }

  // ── Lifecycle ────────────────────────────────────────────

  /** Boot polling if there's a token and the service is enabled. */
  async start() {
    if (this._running) return;
    if (!this.token) {
      this.connection = 'stopped';
      this._emitStatus();
      return;
    }
    if (!this._enabled()) {
      this.connection = 'stopped';
      this._emitStatus();
      return;
    }
    this._running = true;
    this._stopRequested = false;
    this._backoff = MIN_BACKOFF_MS;
    this.connection = 'connecting';
    this.lastError = null;
    this._emitStatus();

    // Refresh botUsername at boot — handy when the user has rotated the bot
    // name through @BotFather.
    api.getMe(this.token).then((me) => {
      if (me && me.username && me.username !== this.botUsername) {
        this.botUsername = me.username;
        this._saveState({ botUsername: this.botUsername });
        this._emitStatus();
      }
    }).catch(() => { /* surfaced by the polling loop */ });

    // Best-effort: clear webhook in case the user pointed the bot at one.
    api.deleteWebhook(this.token).catch(() => {});

    this._pollLoop().catch((err) => {
      console.error('[telegram] poll loop unexpectedly threw:', err);
      this._running = false;
      this.connection = 'error';
      this.lastError = String(err && err.message ? err.message : err);
      this._emitStatus();
    });
  }

  stop() {
    if (!this._running && this.connection === 'stopped') return;
    this._stopRequested = true;
    this._running = false;
    this.connection = 'stopped';
    this._emitStatus();
  }

  async _pollLoop() {
    while (this._running && !this._stopRequested) {
      const tok = this.token;
      if (!tok) { this._running = false; this.connection = 'stopped'; break; }
      try {
        const updates = await api.getUpdates(tok, {
          offset: this._updateOffset,
          timeout: POLL_TIMEOUT_S,
          allowed_updates: ['message'],
        });
        // Successful round trip — reset backoff and surface "online".
        this._backoff = MIN_BACKOFF_MS;
        if (this.connection !== 'online') {
          this.connection = 'online';
          this.lastError = null;
          this._emitStatus();
        }
        if (Array.isArray(updates) && updates.length > 0) {
          for (const upd of updates) {
            if (upd && Number.isFinite(upd.update_id)) {
              this._updateOffset = upd.update_id + 1;
            }
            try {
              await this._handleUpdate(upd);
            } catch (err) {
              console.error('[telegram] handleUpdate threw:', err);
            }
          }
        }
      } catch (err) {
        if (this._stopRequested) break;
        // Telegram returns 409 if another getUpdates is in flight (e.g. two
        // copies of Iris running with the same token). Don't hammer.
        const desc = String((err && err.message) || err);
        const code = err && err.code;
        const isConflict = code === 409 || /Conflict/i.test(desc);
        const isUnauthorized = code === 401 || /Unauthorized/i.test(desc);
        if (isUnauthorized) {
          // Token revoked or rotated. Stop the loop — the user has to provide
          // a new token. Don't keep retrying or we'll flood the network.
          this.lastError = 'Bot token rejected by Telegram (revoked or invalid).';
          this.connection = 'error';
          this._running = false;
          this._emitStatus();
          break;
        }
        this.lastError = desc;
        this.connection = isConflict ? 'error' : 'connecting';
        this._emitStatus();
        await this._sleep(this._backoff);
        this._backoff = Math.min(this._backoff * 2, MAX_BACKOFF_MS);
      }
    }
    this._running = false;
    if (this.connection !== 'error') this.connection = 'stopped';
    this._emitStatus();
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      if (typeof t.unref === 'function') t.unref();
    });
  }

  // ── Inbound: routing Telegram updates → agent runtime ────

  async _handleUpdate(upd) {
    if (!upd || !upd.message) return;
    const m = upd.message;
    const chatId = m.chat && m.chat.id;
    if (chatId == null) return;
    const text = typeof m.text === 'string' ? m.text.trim() : '';
    if (!text) return; // ignore stickers, media, etc.

    // Pairing path — accept any chat that sends the active code.
    if (this.pairing) {
      if (now() > this.pairing.expiresAt) {
        this.pairing = null;
        this._emitStatus();
      } else if (text === this.pairing.code) {
        this.allowedChatId = chatId;
        this.pairing = null;
        // Wipe any leftover chat-agent from a previous pairing.
        this.chatAgentId = null;
        this._saveState({ allowedChatId: chatId, chatAgentId: null });
        this._emitStatus();
        await this._safeSend(chatId,
          '✅ *Paired\\!*\n\n' +
          'Send any message → it runs as a sandboxed Claude Code task on your desktop\\.\n\n' +
          'Type `/control` any time for a numbered menu of actions \\(switch sessions, stop, etc\\.\\)\\.\n' +
          'Or use direct commands: `/new`, `/list`, `/switch`, `/stop`\\.',
        );
        return;
      }
    }

    // Allowlist gate — silently ignore any chat that isn't the paired one.
    if (this.allowedChatId == null || chatId !== this.allowedChatId) {
      // Hint helpfully if it's a NEW chat (no pairing active, no allowlist
      // set). Stay silent if there IS an allowlist — that means a stranger.
      if (this.allowedChatId == null && !this.pairing) {
        await this._safeSend(chatId,
          'This Iris Code bot isn\'t paired yet\\. Open the desktop app and click *Pair my phone*\\.');
      }
      return;
    }

    // ── Numbered menu interception ───────────────────────
    // If a menu was just shown and the user replied with a bare number,
    // treat it as a selection. Any other text drops the menu and falls
    // through to normal handling.
    if (this._menu && now() > this._menu.expiresAt) this._menu = null;
    if (this._menu && /^[0-9]+$/.test(text)) {
      const n = parseInt(text, 10);
      const options = this._menu.options;
      if (!Number.isFinite(n) || n < 1 || n > options.length) {
        await this._safeSend(chatId,
          `Pick a number from 1 to ${options.length}\\.`);
        return;
      }
      const choice = options[n - 1];
      this._menu = null;
      try { await choice.run(); }
      catch (err) {
        console.error('[telegram] menu action threw:', err);
        await this._safeSend(chatId, md.formatError(err.message || 'menu action failed'));
      }
      return;
    }
    // Anything else clears any stale menu before normal routing kicks in.
    if (this._menu && !text.startsWith('/')) this._menu = null;

    // ── Built-in commands ───────────────────────────────
    if (/^\/(start|help|control|menu)\b/i.test(text)) {
      await this._showControlMenu(chatId);
      return;
    }
    if (/^\/new\b/i.test(text)) {
      // Don't *delete* the previous session — just unbind it. The user can
      // /list and /switch back to it. This is the "channels" semantics: each
      // /new is a new persistent thread the user can return to.
      this._unbindAgent();
      // /new also implies "back to worker mode" — Iris mode never spawns
      // workers, so starting a new one only makes sense in worker mode.
      if (this.chatMode !== 'worker') {
        this.chatMode = 'worker';
        this._saveState({ chatMode: 'worker' });
        this._emitStatus();
      }
      const ws = this._previewNextWorkspace();
      await this._safeSend(chatId,
        '🆕 New worker session\\. Send a message to start it\\.\n' +
        ws + '\n' +
        'Your previous session is still around — use `/list` and `/switch` to return to it\\.');
      return;
    }
    if (/^\/list\b/i.test(text)) {
      await this._sendSessionList(chatId);
      return;
    }
    const switchMatch = /^\/switch(?:\s+(\S+))?/i.exec(text);
    if (switchMatch) {
      // Two flavors:
      //   /switch        → show a numbered picker menu (next bare number selects)
      //   /switch <n>    → switch directly
      if (switchMatch[1]) {
        await this._handleSwitch(chatId, switchMatch[1]);
      } else {
        await this._showSwitchMenu(chatId);
      }
      return;
    }
    if (/^\/stop\b/i.test(text)) {
      await this._actionStop(chatId);
      return;
    }
    if (/^\/iris\b/i.test(text)) {
      await this._actionSwitchToIris(chatId);
      return;
    }
    if (/^\/worker\b/i.test(text)) {
      await this._actionSwitchToWorker(chatId);
      return;
    }
    if (/^\/mode\b/i.test(text)) {
      await this._sendModeStatus(chatId);
      return;
    }
    // /cwd                → show current workspace settings
    // /cwd <abs path>     → use this folder for the NEXT new worker session
    // /cwd clear|default  → forget all custom paths, go back to sandboxed
    const cwdMatch = /^\/cwd(?:\s+(.+))?$/i.exec(text);
    if (cwdMatch) {
      const arg = cwdMatch[1] ? cwdMatch[1].trim() : '';
      await this._handleCwdCommand(chatId, arg);
      return;
    }

    // Anything else → route to the agent (worker or iris, per chatMode).
    await this._routeToAgent(text);
  }

  /**
   * One-line MarkdownV2 description of where the NEXT new worker session
   * will run, used for /new and /cwd confirmation messages.
   */
  _previewNextWorkspace() {
    if (this.pendingWorkerCwd) {
      return '_Workspace: \\(once\\) ' + md.escapeMarkdownV2(this.pendingWorkerCwd) + '_';
    }
    if (this.defaultCwd) {
      return '_Workspace: ' + md.escapeMarkdownV2(this.defaultCwd) +
        ' \\(direct, no sandbox\\)_';
    }
    return '_Workspace: fresh sandboxed dir under Iris data folder_';
  }

  /** Unbind the current chat→agent mapping WITHOUT deleting the agent. */
  _unbindAgent() {
    if (this.chatAgentId) {
      try { this.manager.stop(this.chatAgentId); } catch (err) {
        console.error('[telegram] stop on unbind failed:', err);
      }
    }
    this.chatAgentId = null;
    this._saveState({ chatAgentId: null });
  }

  /** Return up-to-5 most recent Telegram-spawned agents, newest first. */
  _listOurAgents(limit = 5) {
    const all = this.manager.list();
    const ours = all.filter((a) => this._ourAgentIds.has(a.id));
    // Manager.list already sorts workers by createdAt desc, but be defensive
    // in case that contract ever changes.
    ours.sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
    return ours.slice(0, limit);
  }

  async _sendSessionList(chatId) {
    const ours = this._listOurAgents(5);
    if (ours.length === 0) {
      await this._safeSend(chatId,
        'No Telegram sessions yet\\. Send a message to start one\\.');
      return;
    }
    const lines = ['*Your recent sessions:*', ''];
    ours.forEach((a, i) => {
      const n = i + 1;
      const active = a.id === this.chatAgentId ? ' ← *active*' : '';
      const status = a.status === 'running' ? ' \\(running\\)' : '';
      const name = md.truncate(a.name || 'Telegram', 50);
      lines.push(`${n}\\. ${md.escapeMarkdownV2(name)}${md.escapeMarkdownV2(status)}${active}`);
    });
    lines.push('');
    lines.push('Use `/switch <n>` to jump to one\\.');
    await this._safeSend(chatId, lines.join('\n'));
  }

  /**
   * Show the central numbered menu — single entry point for all actions
   * so the user doesn't have to remember command names. `/help`, `/start`,
   * `/menu`, and `/control` all land here.
   */
  async _showControlMenu(chatId) {
    const hasAgent = !!this.chatAgentId;
    const ours = this._listOurAgents(5);
    const inIris = this.chatMode === 'iris';
    const options = [];

    // Top: the mode toggle. Iris orchestrator vs. plain worker — this is
    // the headline new affordance, so put it first.
    if (inIris) {
      options.push({
        label: '🔨 Switch to worker mode',
        run: () => this._actionSwitchToWorker(chatId),
      });
    } else {
      options.push({
        label: '✨ Talk to Iris orchestrator',
        run: () => this._actionSwitchToIris(chatId),
      });
    }

    // Worker-only options. In Iris mode these don't apply — Iris is a
    // singleton; /new and the session list belong to worker mode.
    if (!inIris) {
      options.push(
        { label: '🆕 New worker session', run: () => this._actionNewSession(chatId) },
        { label: '📋 List sessions', run: () => this._sendSessionList(chatId) },
      );
      if (ours.length > 1) {
        options.push({ label: '🔀 Switch session', run: () => this._showSwitchMenu(chatId) });
      }
      options.push({ label: '📁 Set workspace folder', run: () => this._actionShowCwdHelp(chatId) });
    }

    if (hasAgent || inIris) {
      options.push({ label: '⏹️ Stop current task', run: () => this._actionStop(chatId) });
    }
    options.push({ label: 'ℹ️ About this bot', run: () => this._actionAbout(chatId) });

    const mode = inIris ? '_Mode: Iris orchestrator_' : '_Mode: worker_';
    await this._presentMenu(chatId,
      '*What would you like to do?*\n' + mode, options);
  }

  async _sendModeStatus(chatId) {
    const mode = this.chatMode === 'iris' ? 'Iris orchestrator' : 'worker';
    const lines = [
      '*Current mode:* ' + md.escapeMarkdownV2(mode),
    ];
    if (this.chatMode === 'worker') {
      lines.push(this._previewNextWorkspace());
    }
    await this._safeSend(chatId, lines.join('\n'));
  }

  async _actionSwitchToIris(chatId) {
    if (this.chatMode === 'iris') {
      await this._safeSend(chatId, 'Already talking to Iris\\.');
      return;
    }
    // Don't stop the bound worker — the user can /worker to come back to it.
    this.chatMode = 'iris';
    this._saveState({ chatMode: 'iris' });
    this._emitStatus();
    await this._safeSend(chatId,
      '✨ Now talking to *Iris*, the master orchestrator\\.\n' +
      'She can see every agent on your desktop and suggest delegations\\.\n' +
      'Use `/worker` to go back to spawning worker sessions\\.');
  }

  async _actionSwitchToWorker(chatId) {
    if (this.chatMode === 'worker') {
      await this._safeSend(chatId, 'Already in worker mode\\.');
      return;
    }
    this.chatMode = 'worker';
    this._saveState({ chatMode: 'worker' });
    this._emitStatus();
    const ws = this._previewNextWorkspace();
    const bound = this.chatAgentId
      ? '_Bound to your previous worker — send a message to continue it, or `/new` for a fresh session\\._'
      : '_No active worker — send a message and I\'ll spawn one\\._';
    await this._safeSend(chatId,
      '🔨 Switched to *worker* mode\\.\n' + ws + '\n' + bound);
  }

  /**
   * /cwd command. Three forms:
   *   /cwd            → show current cwd settings + how to change.
   *   /cwd clear      → unset both pendingWorkerCwd and defaultCwd (sandboxed default).
   *   /cwd <abs path> → set defaultCwd (persists). New sessions run UNSANDBOXED there.
   */
  async _handleCwdCommand(chatId, arg) {
    if (!arg) {
      const lines = [
        '*Worker workspace*',
        '',
        this._previewNextWorkspace(),
      ];
      if (this.defaultCwd || this.pendingWorkerCwd) {
        lines.push('', 'Use `/cwd clear` to go back to the sandboxed default\\.');
      }
      lines.push('', 'Set a folder with `/cwd <absolute path>` — new sessions will work directly in that folder\\.');
      lines.push('_Example:_ `/cwd C:\\\\Users\\\\you\\\\projects\\\\my-app`');
      lines.push('', '⚠️ Custom folders run *unsandboxed* — the agent gets real write access\\.');
      await this._safeSend(chatId, lines.join('\n'));
      return;
    }
    if (/^(clear|default|reset|none|off)$/i.test(arg)) {
      this.pendingWorkerCwd = null;
      try { this.setDefaultCwd(null); }
      catch (err) {
        await this._safeSend(chatId, md.formatError(err.message || 'Could not clear cwd'));
        return;
      }
      await this._safeSend(chatId,
        '✅ Workspace reset\\. New sessions will use the sandboxed default again\\.');
      return;
    }
    // Treat the arg as an absolute path. Validate before storing.
    let candidate = arg;
    // Strip surrounding quotes that some keyboards add when pasting paths.
    if ((candidate.startsWith('"') && candidate.endsWith('"')) ||
        (candidate.startsWith("'") && candidate.endsWith("'"))) {
      candidate = candidate.slice(1, -1);
    }
    if (!path.isAbsolute(candidate)) {
      await this._safeSend(chatId, md.formatError(
        'Folder must be an absolute path (e.g. starts with C:\\ or /).'));
      return;
    }
    let stat;
    try {
      if (!fs.existsSync(candidate)) throw new Error('Folder does not exist on disk.');
      stat = fs.statSync(candidate);
    } catch (err) {
      await this._safeSend(chatId, md.formatError(err.message || String(err)));
      return;
    }
    if (!stat.isDirectory()) {
      await this._safeSend(chatId, md.formatError('That path is a file, not a folder.'));
      return;
    }
    try { this.setDefaultCwd(candidate); }
    catch (err) {
      await this._safeSend(chatId, md.formatError(err.message || String(err)));
      return;
    }
    // /cwd sets the *persistent* default. Wipe any one-shot override so it
    // doesn't quietly shadow what the user just chose.
    this.pendingWorkerCwd = null;
    // Unbind the current chat so the next message spawns a fresh session
    // in the new folder — otherwise the user would have to remember to /new.
    this._unbindAgent();
    await this._safeSend(chatId,
      '✅ Workspace set to ' + md.inlineCode(candidate) + '\\.\n' +
      'New sessions will run *unsandboxed* in that folder\\.\n' +
      'Send any message to start one\\.');
  }

  async _actionShowCwdHelp(chatId) {
    await this._handleCwdCommand(chatId, '');
  }

  /**
   * /switch with no argument → numbered list of sessions; the next bare
   * number picks one.
   */
  async _showSwitchMenu(chatId) {
    const ours = this._listOurAgents(9);
    if (ours.length === 0) {
      await this._safeSend(chatId, 'No sessions yet\\. Send a message to start one\\.');
      return;
    }
    const options = ours.map((a) => ({
      label: (a.id === this.chatAgentId ? '✓ ' : '') +
        md.truncate(a.name || 'Telegram', 50) +
        (a.status === 'running' ? ' (running)' : ''),
      run: () => this._switchToAgent(chatId, a.id),
    }));
    await this._presentMenu(chatId, '*Switch to:*', options);
  }

  async _switchToAgent(chatId, agentId) {
    if (agentId === this.chatAgentId) {
      await this._safeSend(chatId, 'Already on that session\\.');
      return;
    }
    const target = this.manager.get(agentId);
    if (!target) {
      await this._safeSend(chatId, 'That session no longer exists\\.');
      return;
    }
    this.chatAgentId = agentId;
    this._saveState({ chatAgentId: agentId });
    this._emitStatus();
    const name = md.truncate(target.name || 'Telegram', 50);
    await this._safeSend(chatId,
      '🔀 Switched to *' + md.escapeMarkdownV2(name) + '*\\.');
  }

  async _actionNewSession(chatId) {
    this._unbindAgent();
    await this._safeSend(chatId,
      '🆕 New session\\. Send a message to start it\\.');
  }

  async _actionStop(chatId) {
    // In Iris mode the "current task" is the Iris turn — stop that instead.
    if (this.chatMode === 'iris') {
      try { this.manager.stop('iris'); } catch (err) {
        console.error('[telegram] iris stop failed:', err);
      }
      await this._safeSend(chatId, '⏹️ Stopped Iris\\.');
      return;
    }
    if (this.chatAgentId) {
      try { this.manager.stop(this.chatAgentId); } catch (err) {
        console.error('[telegram] stop failed:', err);
      }
      await this._safeSend(chatId, '⏹️ Stopped the current task\\.');
    } else {
      await this._safeSend(chatId, 'Nothing running\\.');
    }
  }

  async _actionAbout(chatId) {
    await this._safeSend(chatId,
      '*Iris Code bot*\n\n' +
      'Two modes\\, switch any time:\n' +
      '• *Worker* \\(default\\) — every message spawns or continues a Claude Code task\\.\n' +
      '• *Iris* — your messages go to the master orchestrator who can see all desktop agents and suggest delegations\\.\n\n' +
      '*Mode commands:*\n' +
      '• `/iris` — talk to the master orchestrator\n' +
      '• `/worker` — back to spawning worker sessions\n' +
      '• `/mode` — show current mode + workspace\n\n' +
      '*Worker commands:*\n' +
      '• `/new` — start a fresh session\n' +
      '• `/list` — show recent sessions\n' +
      '• `/switch <n>` — jump to session n\n' +
      '• `/cwd` — show workspace folder \\(or set with `/cwd <path>`\\)\n' +
      '• `/stop` — cancel running task\n\n' +
      '*Menus:*\n' +
      '• `/control` \\(or `/help`, `/menu`\\) — main numbered menu\n' +
      '• `/switch` — numbered session picker\n\n' +
      '_Worker sessions default to sandboxed dirs Iris controls\\. Set `/cwd <abs path>` to point at your real project files instead\\._');
  }

  /**
   * Send a numbered options list and prime the menu state so the next
   * bare-number message selects one. Options auto-expire after MENU_TTL_MS.
   */
  async _presentMenu(chatId, title, options) {
    if (!options || options.length === 0) return;
    const lines = [title, ''];
    options.forEach((o, i) => {
      lines.push(`*${i + 1}\\.* ${md.escapeMarkdownV2(o.label)}`);
    });
    lines.push('');
    lines.push('_Reply with the number\\._');
    this._menu = {
      options,
      expiresAt: now() + MENU_TTL_MS,
    };
    await this._safeSend(chatId, lines.join('\n'));
  }

  async _handleSwitch(chatId, arg) {
    const ours = this._listOurAgents(5);
    if (ours.length === 0) {
      await this._safeSend(chatId, 'No sessions to switch to\\. Send a message to start one\\.');
      return;
    }
    const n = parseInt(arg || '', 10);
    if (!Number.isFinite(n) || n < 1 || n > ours.length) {
      await this._safeSend(chatId,
        'Usage: `/switch <n>` where n is from `/list`\\.');
      return;
    }
    const target = ours[n - 1];
    if (target.id === this.chatAgentId) {
      await this._safeSend(chatId, 'Already on that session\\.');
      return;
    }
    this.chatAgentId = target.id;
    this._saveState({ chatAgentId: target.id });
    this._emitStatus();
    const name = md.truncate(target.name || 'Telegram', 50);
    await this._safeSend(chatId,
      '🔀 Switched to *' + md.escapeMarkdownV2(name) + '*\\.');
  }

  /**
   * Allocate a fresh, fully-isolated working directory for a new Telegram
   * agent. CRITICAL: the default path here MUST NOT be (or be derived from)
   * the user's defaultCwd. The agent-manager passes the agent's `cwd`
   * argument through as `--add-dir` when sandbox=true, so a returned path
   * becomes read-mountable inside the worker. Returning the user's projects
   * dir for the SANDBOXED case would let a remote prompt cat secrets, ssh
   * keys, browser history, etc.
   *
   * By rooting the workspace under dataDir/telegram-workspaces/<random>/,
   * every sandboxed Telegram agent is contained to a Telegram-owned tree.
   * The agent can still freely `mkdir`, `cd`, and create files INSIDE that
   * tree — which is what "you can change folders inside the session" means —
   * but it can never `cd ..` into anything you didn't put there.
   */
  _allocTelegramWorkspace() {
    const baseRoot = path.join(this.dataDir, 'telegram-workspaces');
    try { fs.mkdirSync(baseRoot, { recursive: true }); } catch {}
    const slug = crypto.randomBytes(4).toString('hex');
    const dir = path.join(baseRoot, slug);
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    return dir;
  }

  /**
   * Decide where the next worker session should run AND whether it should
   * be sandboxed. Priority:
   *   1. `pendingWorkerCwd` (one-shot /cwd <path> override) — UNSANDBOXED.
   *   2. `defaultCwd` (settings.telegram.defaultCwd) — UNSANDBOXED.
   *   3. Fresh telegram-workspaces/<random>/ dir — SANDBOXED.
   *
   * Unsandboxed paths are validated (must be absolute and exist) so we
   * never silently swallow a stale value and spawn into a missing dir.
   * On validation failure, we fall back to the safe sandboxed default.
   */
  _resolveWorkerWorkspace() {
    const candidates = [
      { source: 'pending', path: this.pendingWorkerCwd },
      { source: 'default', path: this.defaultCwd },
    ];
    for (const c of candidates) {
      if (!c.path) continue;
      try {
        if (path.isAbsolute(c.path) && fs.existsSync(c.path)
            && fs.statSync(c.path).isDirectory()) {
          return { cwd: c.path, sandbox: false, source: c.source };
        }
      } catch (err) {
        console.warn(`[telegram] ${c.source} cwd "${c.path}" invalid, falling back:`, err.message || err);
      }
    }
    return { cwd: this._allocTelegramWorkspace(), sandbox: true, source: 'sandbox' };
  }

  async _routeToAgent(message) {
    // Iris orchestrator mode: always route to the always-on master agent.
    // No workspace allocation, no /new semantics, no chatAgentId binding —
    // Iris is a singleton owned by AgentManager. We still gate "busy" so
    // we don't pile messages onto an in-progress turn.
    if (this.chatMode === 'iris') {
      const iris = this.manager.get('iris');
      if (!iris) {
        await this._safeSend(this.allowedChatId,
          md.formatError('Iris orchestrator is not available.'));
        return;
      }
      if (iris.status === 'running') {
        await this._safeSend(this.allowedChatId,
          '⏳ Iris is still working\\. Send `/stop` to cancel or wait for the current turn to finish\\.');
        return;
      }
      try {
        this.manager.sendMessage('iris', message);
      } catch (err) {
        console.error('[telegram] iris sendMessage threw:', err);
        await this._safeSend(this.allowedChatId,
          md.formatError('Could not send to Iris: ' + (err.message || err)));
      }
      return;
    }

    // Worker mode — current behavior, but with configurable cwd / sandbox.
    let agent = this.chatAgentId ? this.manager.get(this.chatAgentId) : null;
    if (!agent) {
      // Spawn a fresh worker. Workspace selection prefers user-chosen
      // folders (defaultCwd / pendingWorkerCwd) over the sandboxed default
      // — so the user can ask the agent to edit their real project files
      // from their phone, OR fall back to a contained sandbox if they
      // didn't pick a folder. Choice made by _resolveWorkerWorkspace().
      try {
        const settings = this.store.getSettings();
        const workspace = this._resolveWorkerWorkspace();
        const created = this.manager.create({
          // Name with a snippet of the first prompt so /list is meaningful.
          name: this._nameFromPrompt(message),
          // For sandboxed sessions this is a Telegram-owned dir; for
          // user-chosen sessions it's the user's actual folder and the
          // agent gets direct write access to it.
          cwd: workspace.cwd,
          model: settings.model || 'sonnet',
          sandbox: workspace.sandbox,
          importFiles: [],
        });
        this.chatAgentId = created.id;
        this._ourAgentIds.add(created.id);
        this._saveState({ chatAgentId: created.id });
        this._persistOwnedAgentIds();
        // /cwd is one-shot — clear after it's been used.
        if (workspace.source === 'pending') this.pendingWorkerCwd = null;
        this._emitStatus();
      } catch (err) {
        console.error('[telegram] failed to create agent:', err);
        await this._safeSend(this.allowedChatId,
          md.formatError('Could not create agent: ' + (err.message || err)));
        return;
      }
    } else if (agent.status === 'running') {
      await this._safeSend(this.allowedChatId,
        '⏳ I\'m still working on the previous task\\. Send `/stop` to cancel or wait for the current run to finish\\.');
      return;
    }

    try {
      this.manager.sendMessage(this.chatAgentId, message);
    } catch (err) {
      console.error('[telegram] sendMessage threw:', err);
      await this._safeSend(this.allowedChatId,
        md.formatError('Could not send message: ' + (err.message || err)));
    }
  }

  _nameFromPrompt(message) {
    const snippet = String(message || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return snippet ? `📱 ${snippet}` : '📱 Telegram';
  }

  // ── Outbound: agent broadcast events → Telegram ──────────

  /**
   * Called by main.js's broadcast() for every event. Forward events that:
   *   - belong to a worker we spawned (sandboxed or user-cwd) — always; OR
   *   - belong to Iris AND the chat is currently in Iris mode — so the
   *     user actually sees the orchestrator's replies.
   * We never spam the chat with the user's *desktop* work (Iris events
   * when in worker mode, or other workers' events).
   */
  handleAgentEvent(event) {
    if (!event || !this.allowedChatId) return;
    const id = event.id;
    if (!id) return;
    const isOurs = this._ourAgentIds.has(id);
    const isIrisInIrisMode = id === 'iris' && this.chatMode === 'iris';
    if (!isOurs && !isIrisInIrisMode) return;
    // Cheap, async-safe: send-and-forget. We never await inside the
    // broadcast handler — Telegram outages must not block the local UI.
    this._handleEventAsync(event).catch((err) =>
      console.error('[telegram] handleEventAsync threw:', err));
  }

  async _handleEventAsync(event) {
    switch (event.type) {
      case 'session': {
        // New turn starting — clear the "got result" flag so we can detect
        // a silent finish below.
        this._turnGotResult.delete(event.id);
        await this._safeSend(this.allowedChatId,
          '🚀 *Started*\\.');
        return;
      }
      case 'tool': {
        const txt = md.formatToolAnnouncement(event.tool, event.input);
        if (txt) await this._safeSend(this.allowedChatId, txt);
        return;
      }
      case 'tool_result': {
        const txt = md.formatToolResult(event.tool, !!event.ok);
        if (txt) await this._safeSend(this.allowedChatId, txt);
        return;
      }
      case 'tool_dangerous': {
        await this._safeSend(this.allowedChatId,
          '🛑 *Halted* \\(safety check\\)\n' +
          md.escapeMarkdownV2(String(event.reason || 'unspecified')) +
          '\nSend `/stop` then a new prompt to continue\\.');
        return;
      }
      case 'result': {
        const text = String(event.text || '').trim();
        this._lastResultByAgent.set(event.id, text);
        this._turnGotResult.add(event.id);
        const chunks = md.formatResult(text);
        for (const c of chunks) {
          await this._safeSend(this.allowedChatId, c);
        }
        return;
      }
      case 'error': {
        // Treat error as a turn outcome too — don't also fire the "silent"
        // warning on done.
        this._turnGotResult.add(event.id);
        await this._safeSend(this.allowedChatId,
          md.formatError(event.message || 'Unknown error'));
        return;
      }
      case 'done': {
        // The subprocess exited. If no 'result' or 'error' fired this turn,
        // claude finished silently — typically a stale --resume sessionId
        // from before an app restart. Warn the user AND reset the agent's
        // sessionId so the NEXT message starts a fresh session that does
        // produce output.
        if (this._turnGotResult.has(event.id)) {
          this._turnGotResult.delete(event.id);
          return;
        }
        try {
          const a = this.manager.agents && this.manager.agents[event.id];
          if (a && a.sessionId) {
            a.sessionId = null;
            try { this.manager.store.saveAgents(this.manager.agents); }
            catch (err) { console.error('[telegram] failed to clear sessionId:', err); }
          }
        } catch (err) {
          console.error('[telegram] sessionId reset threw:', err);
        }
        await this._safeSend(this.allowedChatId,
          '⚠️ The agent finished without producing a reply\\. ' +
          'This usually means a stale session\\. ' +
          'I cleared it — send your message again to retry on a fresh session\\.');
        return;
      }
      // Ignore "delta", "thinking", "tool_input", "agent:updated", etc. —
      // sending those over Telegram would be wildly chatty. The user gets
      // tool announcements and the final result, which is the right
      // information density for a chat channel.
      default:
        return;
    }
  }

  // ── Send helpers ─────────────────────────────────────────

  async _safeSend(chatId, text) {
    if (!this.token || chatId == null || !text) return;
    try {
      await api.sendMessage(this.token, {
        chat_id: chatId,
        text,
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
      });
    } catch (err) {
      // Surface the issue to the UI but never to the agent runtime.
      console.error('[telegram] sendMessage failed:', err && err.message ? err.message : err);
      // If the error references a parse failure, retry once as plain text so
      // the user at least sees something. (MarkdownV2 is strict — a stray
      // bracket in tool output can sink an otherwise valid message.)
      const msg = String(err && err.message || '');
      if (/can't parse/i.test(msg) || /entities/i.test(msg)) {
        try {
          await api.sendMessage(this.token, {
            chat_id: chatId,
            text: stripMarkdown(text),
            disable_web_page_preview: true,
          });
        } catch (err2) {
          console.error('[telegram] plain-text fallback also failed:', err2 && err2.message ? err2.message : err2);
        }
      }
    }
  }
}

function stripMarkdown(s) {
  // Best-effort: drop backslash-escapes and code fences for the fallback.
  return String(s || '')
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/^```\w*\n?/, '').replace(/\n?```$/, ''))
    .replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, '$1');
}

module.exports = { TelegramService };

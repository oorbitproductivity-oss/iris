// lib/store.js
// Disk persistence for Iris Code.
// Stores JSON files in the data dir passed to the constructor:
//   - settings.json
//   - agents.json
//   - api-keys.json    (values encrypted via electron safeStorage when available)
//   - messages-<id>.json (one per agent)

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_SETTINGS = {
  defaultCwd: null,
  recentFolders: [],
  model: "sonnet",
  mode: "subscription",          // default: use existing claude CLI subscription
  apiKey: null,                  // legacy; superseded by named keys
  theme: "dark",
  irisModel: "sonnet",
  systemPromptExtras: "",
  sandboxByDefault: false,
  // Avoid Ctrl+Shift+I which Chromium reserves for DevTools.
  spotlightHotkey: "CommandOrControl+Shift+Space",
  // One-press screen capture → send to active agent with a prompt.
  screenshotHotkey: "CommandOrControl+Alt+S",
  effort: "high",                // claude --effort flag for stronger reasoning
  defaultApiKeyId: null,         // id from getApiKeys() to use when none specified
  onboarded: false,              // first-run wizard completes -> true
  // "bypassPermissions" — every tool call (including Bash) runs immediately
  // with no prompts. This is the default because the GUI can't surface
  // claude's interactive approval prompts (we run claude in one-shot -p
  // mode), so any other mode causes Bash calls to fail outright.
  // Users who want stricter behavior can flip this to "acceptEdits" in
  // Settings — but then they'll have to live with Bash calls failing.
  permissionMode: "bypassPermissions",
  // Safety guardrails. "halt" stops the agent the moment a destructive tool
  // input is detected (rm -rf, git reset --hard, writing to system paths,
  // SQL drops, etc). "warn" only surfaces a red banner without halting.
  // "off" disables the check entirely.
  safetyMode: "halt",
  // System notifications when an agent finishes a turn while the app is in
  // the background. User can disable in Settings.
  notifications: true,
  // Snippet library: prompts the user can `/`-insert in any textarea.
  // Seeded with defaults on first run by the snippets feature module.
  snippets: [],
  // Custom slash commands (v0.5 Feature 4). Each entry:
  //   { id, trigger, name, description, template }
  // Trigger is the bare command word (no leading slash). Template supports
  //   {{selection}} — replaced with the textarea's currently-selected text.
  //   {{cursor}}    — removed from the body; the textarea caret lands here.
  // Built-ins live in app/js/ui/slash-commands.js; user entries merge in.
  slashCommands: [],
  // Default per-thread cost budget (USD). When set, copied into each new
  // agent's `costBudgetUsd`. null = no default budget.
  defaultCostBudgetUsd: null,
  // Per-agent "skip the next cost warning" flag, keyed by agent id. Set by
  // the cost-tracker modal's "Continue once" button; reset by the agent
  // manager after the next turn fires.
  agentBudgetSkipByAgent: {},
  // IDs (in order) of agents pinned to the top of the sidebar.
  pinnedAgentIds: [],
  // Remote access (mobile companion). Off by default; user must explicitly
  // enable. The token is generated lazily the first time the user turns
  // remote access on. Host of "0.0.0.0" reaches LAN + Tailscale; pick
  // "127.0.0.1" for local-only.
  remoteAccess: {
    enabled: false,
    port: 8765,
    host: "0.0.0.0",
    token: null,
  },
  // Telegram bridge — one user, one bot, one paired chat. The bot token
  // itself is NOT stored here; it lives in telegram-token.json encrypted
  // via safeStorage/AES-GCM (see getTelegramToken/setTelegramToken).
  // `botUsername` is cached only for UI display; `allowedChatId` is the
  // sole authorized chat (set during pairing); `chatAgentId` remembers
  // which Iris agent is currently bound to that chat.
  telegram: {
    enabled: false,
    botUsername: null,
    allowedChatId: null,
    chatAgentId: null,
    // Boot-time prompt policy. "ask" (default) → show a yes/no dialog at
    // launch when a token is configured. "always" → silently start the
    // bridge. "never" → silently leave it off. The user picks via a
    // "Don't ask again" checkbox on the dialog.
    startupPrompt: "ask",
    // Persisted list of agent ids that Telegram spawned. /list and /switch
    // need this to survive restarts — without it the user loses access to
    // all their previous Telegram sessions every time Iris reopens.
    ownedAgentIds: [],
    // Where Telegram-spawned worker agents should live. When null, a fresh
    // sandboxed dir under dataDir/telegram-workspaces/<random>/ is allocated
    // for each /new session (safe default — a stranger with the chat can't
    // touch the user's real files). When set to an absolute path, new
    // sessions run DIRECTLY in that folder with no sandbox — so the user
    // can ask the agent to edit their real project files from their phone.
    defaultCwd: null,
    // Routing mode for inbound chat messages.
    //   "worker" — each message routes to a worker agent (current behavior).
    //   "iris"   — messages route to the always-on Iris orchestrator so
    //              the user can plan/delegate from their phone exactly like
    //              they would in the desktop sidebar.
    // Toggled in-chat with /iris and /worker (and via the /control menu).
    chatMode: "worker",
  },
  // MCP (Model Context Protocol) marketplace. When enabled, the per-agent
  // .mcp.json runtime config is passed to claude at spawn time and secrets
  // are injected via the spawn env. Dark-shipped flag — install UI is only
  // shown when this is on. See lib/mcp/* and docs/mcp-marketplace.md.
  mcpEnabled: true,
  // Embedded browser pane (v0.5 Feature 2). When enabled, agents get a
  // "Browser" toggle in the chat header that mounts a side webview with
  // its own URL bar, back/forward, refresh, and a "Send screenshot to
  // agent" button. Per-agent state (open/closed + last URL) is in
  // browserPaneStateByAgent below.
  browserPaneEnabled: true,
  // Per-agent pane state: { [agentId]: { open: bool, url: string } }
  browserPaneStateByAgent: {},
  // Integrated terminal pane (v0.5 Feature 3). Master switch — when off,
  // the chat header omits the Terminal pill and no PTYs are spawned. Falls
  // back to off automatically when node-pty fails to load (see PtyManager).
  terminalEnabled: true,
  // Translucent window chrome (v0.5 Feature 7). Off by default — the native
  // Mica / vibrancy material is GATED on OS support (Windows 11 build 22000+
  // or macOS) and on the active theme being a DARK variant. The toggle in
  // the theme picker is auto-disabled with a tooltip on Win10 / Linux so the
  // user never enables a feature that silently does nothing. Setting this to
  // true on an unsupported OS is a no-op: createMainWindow ignores it.
  translucentWindow: false,
};

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  const raw = fs.readFileSync(file, "utf8");
  if (!raw.trim()) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[store] Failed to parse ${file}:`, err);
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function sanitizeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, "_");
}

// Lazy-load electron safeStorage. Falls back to a per-data-dir AES key if
// safeStorage isn't available (e.g. running under plain node for tests).
function getSafeStorage() {
  try {
    const { safeStorage } = require("electron");
    if (safeStorage && typeof safeStorage.isEncryptionAvailable === "function" && safeStorage.isEncryptionAvailable()) {
      return safeStorage;
    }
  } catch {}
  return null;
}

class Store {
  constructor(dataDir) {
    if (!dataDir) throw new Error("Store: dataDir is required");
    this.dataDir = dataDir;
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    this.settingsFile = path.join(this.dataDir, "settings.json");
    this.agentsFile = path.join(this.dataDir, "agents.json");
    this.keysFile = path.join(this.dataDir, "api-keys.json");
    this.fallbackSeedFile = path.join(this.dataDir, ".key-seed");
    this.telegramTokenFile = path.join(this.dataDir, "telegram-token.json");
    this.mcpSecretsFile = path.join(this.dataDir, "mcp-secrets.json");
  }

  // ── Settings ──
  getSettings() {
    const stored = readJson(this.settingsFile, {});
    // Migration: replace the old conflict-prone DevTools hotkey with the new default.
    if (stored && stored.spotlightHotkey === "CommandOrControl+Shift+I") {
      stored.spotlightHotkey = DEFAULT_SETTINGS.spotlightHotkey;
    }
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  setSettings(patch) {
    const current = this.getSettings();
    const merged = { ...current, ...(patch || {}) };
    writeJson(this.settingsFile, merged);
    return merged;
  }

  // ── Agents ──
  getAgents() {
    const stored = readJson(this.agentsFile, {});
    for (const id of Object.keys(stored)) {
      if (stored[id]) stored[id].status = "idle";
    }
    return stored;
  }

  saveAgents(agents) {
    const cleaned = {};
    for (const [id, a] of Object.entries(agents || {})) {
      if (!a) continue;
      cleaned[id] = {
        id: a.id,
        role: a.role,
        name: a.name,
        cwd: a.cwd,
        model: a.model,
        status: "idle",
        lastActivity: a.lastActivity || 0,
        lastText: a.lastText || "",
        createdAt: a.createdAt || Date.now(),
        sessionId: a.sessionId || null,
        apiKeyId: a.apiKeyId || null,
        sandbox: !!a.sandbox,
        sandboxDir: a.sandboxDir || null,
        sourceDir: a.sourceDir || null,
        // Per-thread cost budget (v0.5 Feature 5). null = no ceiling.
        costBudgetUsd: typeof a.costBudgetUsd === "number" ? a.costBudgetUsd : null,
        costBudgetAction: a.costBudgetAction === "pause" || a.costBudgetAction === "warn" ? a.costBudgetAction : null,
      };
    }
    writeJson(this.agentsFile, cleaned);
  }

  // ── Messages ──
  _messagesPath(id) {
    return path.join(this.dataDir, `messages-${sanitizeId(id)}.json`);
  }

  getMessages(id) {
    return readJson(this._messagesPath(id), []);
  }

  saveMessages(id, messages) {
    writeJson(this._messagesPath(id), messages || []);
  }

  deleteAgent(id) {
    const agents = this.getAgents();
    if (agents[id]) {
      delete agents[id];
      this.saveAgents(agents);
    }
    const mfile = this._messagesPath(id);
    if (fs.existsSync(mfile)) {
      fs.unlinkSync(mfile);
    }
  }

  // ── API key vault ──
  //
  // Stored as { keys: [{ id, name, createdAt, ciphertext }] }
  // - ciphertext is base64. We try electron safeStorage first; otherwise
  //   we fall back to AES-256-GCM with a seed key persisted to .key-seed
  //   (least-bad option that works in tests; not a security guarantee).
  _loadKeys() {
    const data = readJson(this.keysFile, { keys: [] });
    if (!Array.isArray(data.keys)) data.keys = [];
    return data;
  }

  _saveKeys(data) {
    writeJson(this.keysFile, data);
  }

  _fallbackKey() {
    if (fs.existsSync(this.fallbackSeedFile)) {
      return fs.readFileSync(this.fallbackSeedFile);
    }
    const buf = crypto.randomBytes(32);
    fs.writeFileSync(this.fallbackSeedFile, buf);
    try { fs.chmodSync(this.fallbackSeedFile, 0o600); } catch {}
    return buf;
  }

  _encrypt(plaintext) {
    const safe = getSafeStorage();
    if (safe) {
      return { mode: "safe", value: safe.encryptString(plaintext).toString("base64") };
    }
    const key = this._fallbackKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const combined = Buffer.concat([iv, tag, enc]).toString("base64");
    return { mode: "aes", value: combined };
  }

  _decrypt(rec) {
    if (!rec || !rec.value) return null;
    if (rec.mode === "safe") {
      const safe = getSafeStorage();
      if (!safe) return null;
      return safe.decryptString(Buffer.from(rec.value, "base64"));
    }
    if (rec.mode === "aes") {
      const key = this._fallbackKey();
      const buf = Buffer.from(rec.value, "base64");
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(12, 28);
      const enc = buf.subarray(28);
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
    }
    return null;
  }

  /** Public summaries (no secrets) */
  getApiKeys() {
    return this._loadKeys().keys.map((k) => ({
      id: k.id,
      name: k.name,
      createdAt: k.createdAt,
      hint: k.hint || "",
    }));
  }

  /** Returns the decrypted secret for use by the agent runtime. */
  getApiKeyValue(id) {
    const data = this._loadKeys();
    const rec = data.keys.find((k) => k.id === id);
    if (!rec) return null;
    return this._decrypt({ mode: rec.mode, value: rec.ciphertext });
  }

  addApiKey({ name, value }) {
    if (!name || !value) throw new Error("name and value required");
    const data = this._loadKeys();
    const enc = this._encrypt(value);
    const id = crypto.randomUUID();
    const hint = value.length > 8 ? value.slice(0, 4) + "…" + value.slice(-4) : "…";
    data.keys.push({ id, name, createdAt: Date.now(), hint, mode: enc.mode, ciphertext: enc.value });
    this._saveKeys(data);
    return { id, name, hint };
  }

  updateApiKey(id, { name, value } = {}) {
    const data = this._loadKeys();
    const rec = data.keys.find((k) => k.id === id);
    if (!rec) return null;
    if (typeof name === "string") rec.name = name;
    if (typeof value === "string" && value.length > 0) {
      const enc = this._encrypt(value);
      rec.mode = enc.mode;
      rec.ciphertext = enc.value;
      rec.hint = value.length > 8 ? value.slice(0, 4) + "…" + value.slice(-4) : "…";
    }
    this._saveKeys(data);
    return { id: rec.id, name: rec.name, hint: rec.hint };
  }

  deleteApiKey(id) {
    const data = this._loadKeys();
    data.keys = data.keys.filter((k) => k.id !== id);
    this._saveKeys(data);
    return true;
  }

  // ── MCP secrets vault ──
  //
  // Same encryption path as the API key vault. Stored in a separate file so
  // a corruption / format-change in one vault never takes down the other.
  // Records are referenced by id from lib/mcp/installer.js install records;
  // values are only ever read at spawn time and merged into the spawn env.
  _loadMcpSecrets() {
    const data = readJson(this.mcpSecretsFile, { secrets: [] });
    if (!Array.isArray(data.secrets)) data.secrets = [];
    return data;
  }

  _saveMcpSecrets(data) {
    writeJson(this.mcpSecretsFile, data);
    try { fs.chmodSync(this.mcpSecretsFile, 0o600); } catch {}
  }

  /** Public summaries (no plaintext, no ciphertext). */
  getMcpSecrets() {
    return this._loadMcpSecrets().secrets.map((s) => ({
      id: s.id,
      name: s.name,
      createdAt: s.createdAt,
      hint: s.hint || "",
    }));
  }

  /** Returns decrypted secret for use by the MCP installer's buildRuntimeConfig. */
  getMcpSecretValue(id) {
    const data = this._loadMcpSecrets();
    const rec = data.secrets.find((s) => s.id === id);
    if (!rec) return null;
    return this._decrypt({ mode: rec.mode, value: rec.ciphertext });
  }

  addMcpSecret({ name, value }) {
    if (!name || !value) throw new Error("name and value required");
    const data = this._loadMcpSecrets();
    const enc = this._encrypt(String(value));
    const id = crypto.randomUUID();
    const hint = value.length > 8 ? value.slice(0, 4) + "…" + value.slice(-4) : "…";
    data.secrets.push({
      id,
      name: String(name),
      createdAt: Date.now(),
      hint,
      mode: enc.mode,
      ciphertext: enc.value,
    });
    this._saveMcpSecrets(data);
    return { id, name, hint };
  }

  deleteMcpSecret(id) {
    const data = this._loadMcpSecrets();
    const before = data.secrets.length;
    data.secrets = data.secrets.filter((s) => s.id !== id);
    if (data.secrets.length === before) return false;
    this._saveMcpSecrets(data);
    return true;
  }

  // ── Telegram bot token vault ──
  //
  // The token is the only Telegram secret we hold (chat IDs aren't sensitive
  // and live in plain settings.json). Stored in its own file so encryption
  // backend changes don't risk corrupting unrelated settings, and so the
  // file can be deleted in isolation if the user wants to wipe the secret.

  getTelegramToken() {
    if (!fs.existsSync(this.telegramTokenFile)) return null;
    const data = readJson(this.telegramTokenFile, null);
    if (!data || !data.value) return null;
    try {
      return this._decrypt({ mode: data.mode, value: data.value });
    } catch (err) {
      console.error("[store] failed to decrypt telegram token:", err);
      return null;
    }
  }

  setTelegramToken(token) {
    if (token == null || token === "") {
      if (fs.existsSync(this.telegramTokenFile)) {
        try { fs.unlinkSync(this.telegramTokenFile); } catch (err) {
          console.error("[store] failed to remove telegram token file:", err);
        }
      }
      return;
    }
    const enc = this._encrypt(String(token));
    writeJson(this.telegramTokenFile, { mode: enc.mode, value: enc.value, updatedAt: Date.now() });
    try { fs.chmodSync(this.telegramTokenFile, 0o600); } catch {}
  }
}

module.exports = { Store };

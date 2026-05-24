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

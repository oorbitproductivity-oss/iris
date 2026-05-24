const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  nativeTheme,
  shell,
  globalShortcut,
  Tray,
  Menu,
  Notification,
  nativeImage,
  desktopCapturer,
  screen,
} = require("electron");
const path = require("path");
const fs = require("fs");

const crypto = require("crypto");
const os = require("os");

const { Store } = require("./lib/store.js");
const { AgentManager } = require("./lib/agent-manager.js");
const remoteServer = require("./lib/server.js");
const memoryHelper = require("./lib/claude-md-memory.js");
const { TelegramService } = require("./lib/telegram/index.js");

app.setName("Iris Code");
nativeTheme.themeSource = "dark";

const DATA_DIR = path.join(app.getPath("userData"), "iris-data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const store = new Store(DATA_DIR);
let manager = null;
/** @type {TelegramService|null} */
let telegram = null;
/** @type {Set<Electron.BrowserWindow>} */
const windows = new Set();
let registeredHotkey = null;

// Background-mode state. When the user closes the last visible window while
// agents are still working, we offer to "continue in the background" — the
// window is hidden (not closed), a tray icon appears so the app remains
// reachable, and the AgentManager keeps streaming. `isQuitting` short-circuits
// the close-prompt for clean shutdowns (Quit menu, before-quit, etc.).
let tray = null;
let isQuitting = false;
let backgroundConfirmInFlight = false;
let claudePreflightDone = false;

function isDev() {
  return process.argv.includes("--dev") || process.env.IRIS_DEBUG === "1";
}

// Resolve `claude` on PATH the same way doctor.js does — with Windows .cmd/.exe
// extension expansion. Returns the absolute path or null.
function whichClaude() {
  const exts = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  const extraPath = path.join(
    process.env.USERPROFILE || process.env.HOME || "",
    ".local",
    "bin"
  );
  const parts = ((process.env.PATH || "") + path.delimiter + extraPath).split(path.delimiter);
  for (const p of parts) {
    if (!p) continue;
    for (const ext of exts) {
      const cand = path.join(p, "claude" + ext);
      try { if (fs.existsSync(cand)) return cand; } catch {}
    }
  }
  return null;
}

async function preflightClaudeCli(parentWin) {
  if (whichClaude()) return;
  const opts = {
    type: "warning",
    buttons: ["Open install docs", "I'll install it later"],
    defaultId: 0,
    cancelId: 1,
    title: "Iris Code — Claude CLI not found",
    message: "Claude Code CLI is not installed on this machine.",
    detail:
      "Iris Code runs your sessions through the official `claude` CLI, but it isn't on this computer's PATH yet.\n\n" +
      "To install it (one-time setup):\n" +
      "  1. Install Node.js from https://nodejs.org if you don't have it.\n" +
      "  2. Open a terminal and run:  npm install -g @anthropic-ai/claude-code\n" +
      "  3. Run `claude` once to sign in with your Pro/Max subscription.\n" +
      "  4. Restart Iris Code.\n\n" +
      "You can keep using settings, but starting a session will fail until the CLI is installed.",
  };
  try {
    const r = parentWin
      ? await dialog.showMessageBox(parentWin, opts)
      : await dialog.showMessageBox(opts);
    if (r.response === 0) {
      shell.openExternal("https://docs.claude.com/en/docs/claude-code/overview");
    }
  } catch (err) {
    console.error("[main] claude preflight dialog failed:", err);
  }
}

function broadcast(event) {
  for (const w of windows) {
    if (!w.isDestroyed()) {
      try { w.webContents.send("agent:event", event); } catch {}
    }
  }
  try { remoteServer.broadcast(event); } catch (err) {
    console.warn("[main] remote broadcast failed:", err);
  }
  // Forward to the Telegram bridge — the service filters to events for
  // its own paired chat, so this is cheap when nothing's connected.
  if (telegram) {
    try { telegram.handleAgentEvent(event); } catch (err) {
      console.warn("[main] telegram forward failed:", err);
    }
  }
  maybeNotify(event);
}

function broadcastTelegramStatus(status) {
  for (const w of windows) {
    if (!w.isDestroyed()) {
      try { w.webContents.send("ui:telegram-status", status); } catch {}
    }
  }
}

// Fire a system notification when an agent finishes a turn (event.type ===
// "result") AND no Iris Code window currently has focus. Suppresses noise for
// Iris itself (the orchestrator emits results constantly) and respects the
// settings.notifications toggle.
function maybeNotify(event) {
  if (!event || event.type !== "result") return;
  if (event.id === "iris") return;
  if (!Notification.isSupported()) return;
  const settings = store.getSettings();
  if (settings.notifications === false) return;
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && windows.has(focused) && focused.isVisible() && !focused.isMinimized()) return;

  const agents = manager ? manager.list() : [];
  const agent = agents.find((a) => a.id === event.id);
  const name = agent ? agent.name : "Agent";
  const snippet = (event.text || "").replace(/\s+/g, " ").trim().slice(0, 140) || "Finished.";

  try {
    const n = new Notification({
      title: `${name} finished`,
      body: snippet,
      icon: path.join(__dirname, "app", "assets", "iris-icon-square.png"),
      silent: false,
    });
    n.on("click", () => {
      showAllOrCreate();
      const w = activeWindow();
      if (w) {
        try { w.webContents.send("ui:focus-agent", event.id); } catch {}
      }
    });
    n.show();
  } catch (err) {
    console.warn("[main] notification failed:", err);
  }
}

// Pick whichever window is currently focused, falling back to the first one
// in the set (so hotkeys / "open another" land on the user's active window).
function activeWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && windows.has(focused)) return focused;
  return windows.values().next().value || null;
}

function createMainWindow() {
  const w = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    titleBarStyle: "hidden",
    backgroundColor: "#0b0b0f",
    show: false,
    icon: path.join(__dirname, "app", "assets", "iris-icon-square.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  windows.add(w);

  w.loadFile(path.join(__dirname, "app", "index.html"));
  w.once("ready-to-show", async () => {
    w.show();
    // Preflight the claude CLI before any other modal so a fresh-install user
    // gets the install instructions first. Show once per launch.
    if (!claudePreflightDone) {
      claudePreflightDone = true;
      try { await preflightClaudeCli(w); } catch (err) {
        console.error("[main] claude preflight failed:", err);
      }
    }
    // Fire the Telegram boot prompt once the window is actually visible.
    // Doing it earlier (right after createMainWindow returns) attaches the
    // modal dialog to a still-hidden window on Windows, which can leave
    // the main window in a weird focus state where it accepts no input
    // until the user clicks somewhere else first.
    if (telegram && !telegram.__bootPromptDone) {
      telegram.__bootPromptDone = true;
      maybePromptForTelegramBridge(w).catch((err) =>
        console.error("[main] telegram boot prompt failed:", err));
    }
  });

  if (isDev()) {
    w.webContents.on("console-message", (_e, level, message, line, sourceId) => {
      const lvl = ["log", "warn", "error", "info"][level] || "log";
      console.log(`[main:${lvl}] ${sourceId}:${line} ${message}`);
    });
    w.webContents.openDevTools({ mode: "detach" });
  }
  w.webContents.on("render-process-gone", (_e, details) => {
    if (details.reason !== "clean-exit") console.error("[main:renderer] gone:", details);
  });

  w.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Close interception: if this is the last visible window AND the agent
  // manager has active subprocesses, ask the user whether to keep running
  // in the background. Choosing "yes" hides the window and ensures the tray
  // icon is mounted; "no" cleanly quits the app.
  w.on("close", (e) => {
    if (isQuitting) return;

    const otherVisible = [...windows].filter(
      (x) => x !== w && !x.isDestroyed() && x.isVisible()
    );
    if (otherVisible.length > 0) return;
    if (!manager || !managerHasActiveWork()) return;

    if (backgroundConfirmInFlight) { e.preventDefault(); return; }
    e.preventDefault();
    backgroundConfirmInFlight = true;

    dialog.showMessageBox(w, {
      type: "question",
      buttons: ["Continue in background", "Quit"],
      defaultId: 0,
      cancelId: 1,
      title: "Iris Code",
      message: "Tasks are still running.",
      detail:
        "Keep them running in the background? The app will stay live in the system tray — click the tray icon to reopen.",
    }).then(({ response }) => {
      backgroundConfirmInFlight = false;
      if (response === 0) {
        ensureTray();
        w.hide();
      } else {
        isQuitting = true;
        app.quit();
      }
    }).catch((err) => {
      backgroundConfirmInFlight = false;
      console.error("[main] close-prompt dialog failed:", err);
    });
  });

  w.on("closed", () => { windows.delete(w); });
  return w;
}

function managerHasActiveWork() {
  if (!manager) return false;
  // Any live subprocess counts as active work. Iris turns and worker turns
  // both spawn a fresh subprocess that lives only for the duration of the
  // turn, so non-zero size = "something is in flight right now."
  return manager.procs && manager.procs.size > 0;
}

function ensureTray() {
  if (tray) return tray;
  const iconPath = path.join(__dirname, "app", "assets", "iris-icon-square.png");
  let image;
  try {
    image = nativeImage.createFromPath(iconPath);
    if (!image.isEmpty()) {
      image = image.resize({ width: 16, height: 16 });
    }
  } catch (err) {
    console.warn("[main] tray icon load failed, using empty image:", err);
    image = nativeImage.createEmpty();
  }
  tray = new Tray(image);
  tray.setToolTip("Iris Code — running in background");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show Iris Code", click: () => showAllOrCreate() },
    { label: "New window", click: () => createMainWindow() },
    { type: "separator" },
    { label: "Quit Iris Code", click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on("click", () => showAllOrCreate());
  return tray;
}

function showAllOrCreate() {
  const all = [...windows].filter((w) => !w.isDestroyed());
  if (all.length === 0) {
    createMainWindow();
    return;
  }
  for (const w of all) {
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  }
}

function focusMainWindow() {
  let w = activeWindow();
  if (!w) w = createMainWindow();
  if (w) {
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  }
  return w;
}

// Iris chat lives INSIDE the main window now. The hotkey just tells the
// (focused, or first) window to toggle its embedded overlay.
function toggleEmbeddedIris() {
  const w = focusMainWindow();
  if (w) w.webContents.send("ui:iris-toggle");
}

// ── Unified hotkey validation ────────────────────────────────────────
// Every globally-registered hotkey is declared in one table. On boot (and
// on any settings change that touches a hotkey) we re-validate the whole
// set against the OS and against each other. If the user's chosen
// accelerator is already taken — by another app, by the OS, or by another
// Iris feature — we auto-pick the first working alternate from a per-
// feature fallback list AND notify the renderer so the user can choose a
// different one if they don't like our auto-pick.
const HOTKEY_DEFS = [
  {
    id: "spotlight",
    label: "Open Iris overlay",
    settingKey: "spotlightHotkey",
    default: "CommandOrControl+Shift+Space",
    alternates: [
      "CommandOrControl+Shift+Space",
      "CommandOrControl+Alt+Space",
      "CommandOrControl+Shift+J",
      "CommandOrControl+Shift+Period",
      "CommandOrControl+Alt+I",
      "F8",
      "F13",
    ],
    handler: () => toggleEmbeddedIris(),
  },
  {
    id: "screenshot",
    label: "Capture screenshot to active agent",
    settingKey: "screenshotHotkey",
    default: "CommandOrControl+Alt+S",
    alternates: [
      "CommandOrControl+Alt+S",
      "CommandOrControl+Shift+Y",
      "CommandOrControl+Alt+P",
      "CommandOrControl+Shift+H",
      "CommandOrControl+Alt+G",
      "F9",
      "F14",
    ],
    handler: () => captureScreenshotAndPrompt(),
  },
];

const liveHotkeys = new Map(); // id -> accelerator

function tryRegisterShortcut(accelerator, handler) {
  if (!accelerator) return false;
  try {
    return globalShortcut.register(accelerator, handler) === true;
  } catch {
    return false;
  }
}

function probeShortcut(accelerator) {
  // Test whether an accelerator can be claimed right now, then immediately
  // release it. Returns true if the combo is currently free.
  if (!accelerator) return false;
  try {
    const ok = globalShortcut.register(accelerator, () => {});
    if (ok) globalShortcut.unregister(accelerator);
    return ok === true;
  } catch {
    return false;
  }
}

function validateAndRegisterAllHotkeys({ notify = true } = {}) {
  // Tear everything down so probes don't see leftover registrations.
  for (const [, acc] of liveHotkeys) {
    try { globalShortcut.unregister(acc); } catch {}
  }
  liveHotkeys.clear();

  const settings = store.getSettings();
  const conflicts = [];
  const used = new Set();
  const updates = {};

  for (const def of HOTKEY_DEFS) {
    const preferred = settings[def.settingKey] || def.default;
    let assigned = null;
    let reason = null;

    if (used.has(preferred)) {
      reason = "duplicate of another Iris hotkey";
    } else if (tryRegisterShortcut(preferred, def.handler)) {
      assigned = preferred;
    } else {
      reason = "already claimed by the OS or another app";
    }

    if (!assigned) {
      // Build a list of three working candidates the user can pick from.
      const candidates = [];
      for (const alt of def.alternates) {
        if (alt === preferred) continue;
        if (used.has(alt)) continue;
        if (candidates.length >= 3) break;
        if (probeShortcut(alt)) candidates.push(alt);
      }

      // Auto-pick the first working alternate so the feature still works
      // even if the user dismisses the conflict banner.
      let autoPick = null;
      for (const alt of def.alternates) {
        if (alt === preferred) continue;
        if (used.has(alt)) continue;
        if (tryRegisterShortcut(alt, def.handler)) {
          autoPick = alt;
          break;
        }
      }

      conflicts.push({
        id: def.id,
        label: def.label,
        attempted: preferred,
        reason,
        candidates,
        autoPicked: autoPick,
      });

      if (autoPick) {
        assigned = autoPick;
        updates[def.settingKey] = autoPick;
      }
    }

    if (assigned) {
      liveHotkeys.set(def.id, assigned);
      used.add(assigned);
      console.log(`[main] hotkey "${def.id}" → ${assigned}`);
    } else {
      console.warn(`[main] hotkey "${def.id}" could not be registered`);
    }
  }

  if (Object.keys(updates).length) {
    store.setSettings(updates);
  }

  if (notify && conflicts.length > 0) {
    const w = focusMainWindow();
    if (w) {
      // Wait until the renderer is most likely mounted.
      setTimeout(() => {
        try { w.webContents.send("ui:hotkey-conflicts", { conflicts }); } catch {}
      }, 1500);
    }
  }
}

function setHotkeyExplicit(id, accelerator) {
  const def = HOTKEY_DEFS.find(d => d.id === id);
  if (!def) return { ok: false, error: "Unknown hotkey id" };

  // Reject duplicates against other live bindings.
  for (const [otherId, otherAcc] of liveHotkeys) {
    if (otherId !== id && otherAcc === accelerator) {
      return { ok: false, error: `Already used by "${otherId}"` };
    }
  }

  const old = liveHotkeys.get(id);
  if (old) {
    try { globalShortcut.unregister(old); } catch {}
    liveHotkeys.delete(id);
  }

  if (!tryRegisterShortcut(accelerator, def.handler)) {
    // Restore old binding on failure so the user isn't stranded.
    if (old) tryRegisterShortcut(old, def.handler);
    if (old) liveHotkeys.set(id, old);
    return { ok: false, error: "Could not register that combo — try another" };
  }

  liveHotkeys.set(id, accelerator);
  store.setSettings({ [def.settingKey]: accelerator });
  return { ok: true, accelerator };
}

ipcMain.handle("hotkey:set", (_e, { id, accelerator } = {}) =>
  setHotkeyExplicit(id, accelerator));
ipcMain.handle("hotkey:recheck", () => {
  validateAndRegisterAllHotkeys({ notify: true });
  return { ok: true };
});
ipcMain.handle("hotkey:list", () => {
  const out = {};
  for (const [id, acc] of liveHotkeys) out[id] = acc;
  return out;
});

// Back-compat stub: any old callers of registerHotkey/registerScreenshotHotkey
// trigger a full re-validation so the unified path handles everything.
function registerHotkey() { validateAndRegisterAllHotkeys({ notify: false }); }

// ── Screenshot capture + send-to-agent hotkey ──
// One press: capture the primary screen, save to a temp PNG, and pop a small
// modal in the focused window. The user types a prompt and the screenshot is
// dispatched to the active agent with a "look at this image" instruction.
let registeredScreenshotHotkey = null;
const SCREENSHOT_DIR = path.join(DATA_DIR, "screenshots");
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function captureScreenshotAndPrompt() {
  const win = focusMainWindow();
  function sendError(msg) {
    console.error("[main] screenshot:", msg);
    if (win) win.webContents.send("ui:screenshot-error", { error: msg });
  }

  let sources;
  try {
    // Pick a thumbnail size from the actual primary display, but cap it to a
    // sane upper bound so high-DPI multi-monitor rigs don't silently produce
    // an empty image. Electron's docs say large thumbnails can fail to
    // capture; 2560×1440 covers 99% of consumer displays.
    const primary = screen.getPrimaryDisplay();
    const size = primary.size || { width: 1920, height: 1080 };
    const cappedW = Math.min(Math.max(size.width, 800), 2560);
    const cappedH = Math.min(Math.max(size.height, 600), 1440);
    sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: cappedW, height: cappedH },
    });
  } catch (err) {
    return sendError("Capture API threw: " + (err.message || err));
  }

  if (!sources || sources.length === 0) {
    return sendError("No screen sources available — check OS screen-capture permission");
  }
  const source = sources[0];
  if (!source || !source.thumbnail) {
    return sendError("Capture returned no thumbnail");
  }

  let pngBuffer;
  try {
    pngBuffer = source.thumbnail.toPNG();
  } catch (err) {
    return sendError("Failed to encode PNG: " + (err.message || err));
  }
  if (!pngBuffer || pngBuffer.length === 0) {
    return sendError("Capture produced an empty image");
  }

  try {
    const filename = `iris-${Date.now()}.png`;
    const filepath = path.join(SCREENSHOT_DIR, filename);
    fs.writeFileSync(filepath, pngBuffer);

    const dataUrl = `data:image/png;base64,${pngBuffer.toString("base64")}`;
    if (win) win.webContents.send("ui:screenshot-taken", { filepath, dataUrl });
  } catch (err) {
    return sendError("Failed to save screenshot: " + (err.message || err));
  }
}

// Retained for IPC compatibility; routes through the unified validator.
function registerScreenshotHotkey() {
  validateAndRegisterAllHotkeys({ notify: false });
}

ipcMain.handle("screenshot:capture", () => captureScreenshotAndPrompt());

// ── Remote access (mobile companion) ──
// The token, enable flag, port, and host live in store settings under
// `remoteAccess`. A token is generated lazily the first time the user
// enables remote access. The server reads auth state live via getAuth()
// so regen takes effect without a restart.

function getRemoteAuth() {
  const s = store.getSettings();
  const r = s.remoteAccess || {};
  return { enabled: !!r.enabled, token: r.token || null };
}

function ensureRemoteToken() {
  const s = store.getSettings();
  const r = s.remoteAccess || {};
  if (r.token) return r.token;
  const token = crypto.randomBytes(32).toString("base64url");
  store.setSettings({ remoteAccess: { ...r, token } });
  return token;
}

function getReachableHosts() {
  const ifs = os.networkInterfaces();
  const hosts = [];
  for (const [name, addrs] of Object.entries(ifs)) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) {
        hosts.push({ iface: name, address: a.address });
      }
    }
  }
  return hosts;
}

async function startRemoteIfEnabled() {
  const s = store.getSettings();
  const r = s.remoteAccess || {};
  if (!r.enabled) return false;
  if (!r.token) ensureRemoteToken();
  try {
    await remoteServer.startServer({
      port: r.port || 8765,
      host: r.host || "0.0.0.0",
      manager,
      store,
      dataDir: DATA_DIR,
      version: APP_VERSION,
      getAuth: getRemoteAuth,
    });
    return true;
  } catch (err) {
    console.error("[main] remote server failed to start:", err);
    return false;
  }
}

async function applyRemoteConfig(patch) {
  const s = store.getSettings();
  const prev = s.remoteAccess || {};
  const next = { ...prev, ...patch };
  // Generate token automatically when enabling for the first time.
  if (next.enabled && !next.token) {
    next.token = crypto.randomBytes(32).toString("base64url");
  }
  store.setSettings({ remoteAccess: next });

  // Decide what to do with the server based on the diff.
  const wasRunning = remoteServer.isRunning();
  const shouldRun = !!next.enabled;
  const networkChanged =
    prev.port !== next.port || prev.host !== next.host;

  if (wasRunning && (!shouldRun || networkChanged)) {
    await remoteServer.stopServer();
  }
  if (shouldRun && (!wasRunning || networkChanged)) {
    await startRemoteIfEnabled();
  }
  return getRemoteStatus();
}

function getRemoteStatus() {
  const s = store.getSettings();
  const r = s.remoteAccess || {};
  const status = remoteServer.getStatus();
  return {
    enabled: !!r.enabled,
    token: r.token || null,
    port: r.port || 8765,
    host: r.host || "0.0.0.0",
    running: status.running,
    connections: status.connections,
    clientInfo: status.clientInfo || [],
    reachableHosts: getReachableHosts(),
  };
}

app.whenReady().then(() => {
  manager = new AgentManager({ store, dataDir: DATA_DIR, broadcast });
  manager.bootstrap();

  // Telegram bridge. Construct unconditionally so IPC works even when the
  // user hasn't enabled it yet; start() is a no-op without a token + flag.
  telegram = new TelegramService({
    manager,
    store,
    dataDir: DATA_DIR,
    onStatus: broadcastTelegramStatus,
  });

  createMainWindow();

  // Validate every global hotkey at boot. If anything conflicts with the OS
  // or with another Iris hotkey, auto-fall-back to a working alternate and
  // notify the renderer so the user can pick a different one.
  validateAndRegisterAllHotkeys({ notify: true });

  // Auto-start the remote server iff the user previously enabled it.
  startRemoteIfEnabled();
  // NOTE: maybePromptForTelegramBridge is deferred to ready-to-show inside
  // createMainWindow (see the once("ready-to-show") handler), so the modal
  // dialog has a visible parent window. Triggering it here races the
  // window's first paint and left the main window unresponsive.
});

// ── Telegram boot-time prompt ────────────────────────────────
//
// Three policies:
//   "ask"   — show a modal yes/no on every launch (default)
//   "always" — silently start the bridge
//   "never"  — silently leave it stopped
//
// Stored at settings.telegram.startupPrompt. The dialog has a "Don't ask
// again" checkbox that flips ask → always (yes) or ask → never (no).
async function maybePromptForTelegramBridge(parentWin) {
  if (!telegram) return;
  const status = telegram.getStatus();
  if (!status.hasToken) return; // nothing to start

  const settings = store.getSettings();
  const policy = (settings.telegram && settings.telegram.startupPrompt) || "ask";

  if (policy === "never") return;
  if (policy === "always") {
    await telegram.setEnabled(true);
    return;
  }

  // "ask" — fire a question dialog. Prefer the explicit parent window from
  // ready-to-show; fall back to whichever window is active.
  const w = parentWin || activeWindow();
  const opts = {
    type: "question",
    buttons: ["Yes — start Telegram bridge", "No — desktop only"],
    defaultId: 0,
    cancelId: 1,
    title: "Iris Code",
    message: "Start Iris Code with the Telegram bridge?",
    detail:
      "Pick Yes and you'll be able to message your paired bot from anywhere — every DM runs as a sandboxed agent on this desktop.\n" +
      "Pick No and only the desktop UI starts; you can still enable the bridge later from Settings.",
    checkboxLabel: "Don't ask again",
    checkboxChecked: false,
  };

  let result;
  try {
    result = w
      ? await dialog.showMessageBox(w, opts)
      : await dialog.showMessageBox(opts);
  } catch (err) {
    console.error("[main] telegram boot dialog failed:", err);
    return;
  }

  const yes = result.response === 0;
  if (result.checkboxChecked) {
    // Remember the choice forever.
    const tg = (store.getSettings().telegram) || {};
    store.setSettings({ telegram: { ...tg, startupPrompt: yes ? "always" : "never" } });
  }
  if (yes) {
    try { await telegram.setEnabled(true); }
    catch (err) { console.error("[main] telegram setEnabled failed:", err); }
  }
}

// Only quit when window-all-closed AND user explicitly asked to quit. If the
// last window was simply hidden (background mode), no close event fires for
// it, so this handler doesn't run. If the user closed every window without
// active work, isQuitting will be false but there's nothing to keep alive —
// quit normally.
app.on("window-all-closed", () => {
  if (manager) manager.shutdown();
  if (tray) { try { tray.destroy(); } catch {} tray = null; }
  // Best-effort shutdown of the remote server. app.quit() runs immediately;
  // sockets will be force-closed by the process exit if not done in time.
  try { remoteServer.stopServer(); } catch {}
  try { if (telegram) telegram.stop(); } catch {}
  app.quit();
});

app.on("before-quit", () => { isQuitting = true; });

app.on("will-quit", () => {
  if (registeredHotkey) {
    try { globalShortcut.unregister(registeredHotkey); } catch {}
  }
  globalShortcut.unregisterAll();
});

app.on("activate", () => {
  if (windows.size === 0) createMainWindow();
});

// ── IPC: Settings ──
ipcMain.handle("settings:get", () => store.getSettings());
ipcMain.handle("settings:set", (_e, patch) => {
  const merged = store.setSettings(patch);
  const touchedHotkey = patch && (
    Object.prototype.hasOwnProperty.call(patch, "spotlightHotkey") ||
    Object.prototype.hasOwnProperty.call(patch, "screenshotHotkey")
  );
  if (touchedHotkey) {
    validateAndRegisterAllHotkeys({ notify: true });
  }
  return merged;
});

// ── IPC: Folder / file pickers ──
ipcMain.handle("folder:pick", async (e) => {
  const sender = BrowserWindow.fromWebContents(e.sender) || win;
  const r = await dialog.showOpenDialog(sender, {
    properties: ["openDirectory"],
    title: "Pick working directory",
  });
  if (r.canceled || !r.filePaths.length) return null;
  const f = r.filePaths[0];
  const s = store.getSettings();
  s.defaultCwd = f;
  s.recentFolders = [f, ...(s.recentFolders || []).filter((x) => x !== f)].slice(0, 10);
  store.setSettings(s);
  return f;
});

ipcMain.handle("files:pick", async (e) => {
  const sender = BrowserWindow.fromWebContents(e.sender) || win;
  const r = await dialog.showOpenDialog(sender, {
    properties: ["openFile", "multiSelections"],
    title: "Pick files to import into sandbox",
  });
  if (r.canceled) return [];
  return r.filePaths;
});

// ── IPC: Agents ──
ipcMain.handle("agents:list", () => manager.list());
ipcMain.handle("agents:get", (_e, id) => manager.get(id));
ipcMain.handle("agents:create", (_e, opts) => manager.create(opts));
ipcMain.handle("agents:update", (_e, { id, patch }) => manager.update(id, patch));
ipcMain.handle("agents:delete", (_e, id) => manager.delete(id));

ipcMain.on("agents:send", (_e, { id, message }) => manager.sendMessage(id, message));
ipcMain.on("agents:stop", (_e, id) => manager.stop(id));
ipcMain.on("agents:resume", (_e, id) => manager.resume(id));

// ── IPC: Sandbox ──
ipcMain.handle("sandbox:list", (_e, id) => manager.listSandboxFiles(id));
ipcMain.handle("sandbox:export", (_e, { id, targetDir, files }) =>
  manager.exportSandbox(id, targetDir, files)
);

// ── IPC: API keys ──
ipcMain.handle("keys:list", () => store.getApiKeys());
ipcMain.handle("keys:add", (_e, { name, value }) => store.addApiKey({ name, value }));
ipcMain.handle("keys:update", (_e, { id, name, value }) => store.updateApiKey(id, { name, value }));
ipcMain.handle("keys:delete", (_e, id) => store.deleteApiKey(id));

// ── IPC: Shell ──
ipcMain.handle("shell:openExternal", (_e, url) => {
  if (typeof url !== "string") return false;
  if (!/^(https?:|mailto:|file:)/i.test(url)) return false;
  shell.openExternal(url);
  return true;
});
ipcMain.handle("shell:openPath", async (_e, p) => {
  if (typeof p !== "string" || !p) return { ok: false, error: "no path" };
  const r = await shell.openPath(p);
  return { ok: !r, error: r || null };
});
ipcMain.handle("shell:showInFolder", (_e, p) => {
  if (typeof p !== "string") return false;
  shell.showItemInFolder(p);
  return true;
});

// ── IPC: Iris embedded overlay (renderer → main → renderer) ──
ipcMain.on("iris:toggle", () => toggleEmbeddedIris());

// ── IPC: Window ──
// Each handler resolves the window from the sender so multi-window setups
// control the right one. The singleton "win" of the old design got the wrong
// window when multiple were open.
ipcMain.on("win:min", (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.on("win:max", (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
});
ipcMain.on("win:fullscreen", (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  w.setFullScreen(!w.isFullScreen());
});
ipcMain.on("win:close", (e) => BrowserWindow.fromWebContents(e.sender)?.close());
ipcMain.on("win:new", () => { createMainWindow(); });

// ── IPC: Conversation export ──
ipcMain.handle("export:thread", async (e, { id, format } = {}) => {
  if (!id) return { ok: false, error: "no agent id" };
  const sender = BrowserWindow.fromWebContents(e.sender) || activeWindow();
  const agent = manager ? manager.get(id) : null;
  if (!agent) return { ok: false, error: "agent not found" };
  const fmt = format === "json" ? "json" : "markdown";
  const safe = String(agent.name || "thread").replace(/[^a-zA-Z0-9-_ ]+/g, "").slice(0, 80) || "thread";
  const ext = fmt === "json" ? "json" : "md";
  const defaultPath = path.join(app.getPath("downloads") || app.getPath("desktop") || DATA_DIR, `${safe}.${ext}`);

  const r = await dialog.showSaveDialog(sender, {
    title: `Export ${agent.name}`,
    defaultPath,
    filters: fmt === "json"
      ? [{ name: "JSON", extensions: ["json"] }]
      : [{ name: "Markdown", extensions: ["md"] }, { name: "Text", extensions: ["txt"] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };

  let content;
  if (fmt === "json") {
    content = JSON.stringify({
      id: agent.id, name: agent.name, model: agent.model, cwd: agent.cwd,
      createdAt: agent.createdAt, messages: agent.messages,
    }, null, 2);
  } else {
    content = buildMarkdownExport(agent);
  }
  try {
    fs.writeFileSync(r.filePath, content, "utf8");
    return { ok: true, path: r.filePath };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

function buildMarkdownExport(agent) {
  const lines = [];
  const title = agent.name || "Untitled thread";
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`> Exported from **Iris Code** on ${new Date().toISOString()}`);
  lines.push("");
  const meta = [];
  if (agent.model) meta.push(`- **Model**: ${agent.model}`);
  if (agent.cwd) meta.push(`- **Working directory**: \`${agent.cwd}\``);
  if (agent.sessionId) meta.push(`- **Session**: \`${agent.sessionId}\``);
  if (agent.createdAt) meta.push(`- **Created**: ${new Date(agent.createdAt).toISOString()}`);
  if (agent.sandbox) meta.push(`- **Sandbox**: yes`);
  if (meta.length) {
    lines.push(...meta);
    lines.push("");
  }
  lines.push("---");
  lines.push("");

  const messages = Array.isArray(agent.messages) ? agent.messages : [];
  if (messages.length === 0) {
    lines.push("_(no messages)_");
    return lines.join("\n");
  }
  for (const m of messages) {
    const ts = m.ts ? new Date(m.ts).toISOString() : "";
    if (m.role === "user") {
      lines.push(`## 🧑 You — ${ts}`);
    } else if (m.role === "assistant") {
      lines.push(`## ✨ Assistant — ${ts}`);
    } else {
      lines.push(`## ⚙️ System — ${ts}`);
    }
    lines.push("");
    lines.push(m.text || "_(empty)_");
    lines.push("");
    if (m.tools && m.tools.length) {
      lines.push("<details><summary>Tool calls</summary>");
      lines.push("");
      for (const t of m.tools) {
        const status = t.status === "done" ? "✓" : t.status === "error" ? "✗" : "…";
        const head = `**${t.name || "tool"}** \`${status}\``;
        lines.push(head);
        if (t.input != null) {
          let s = typeof t.input === "string" ? t.input : JSON.stringify(t.input, null, 2);
          if (s.length > 4000) s = s.slice(0, 4000) + "\n…(truncated)";
          lines.push("```json");
          lines.push(s);
          lines.push("```");
        }
        if (t.result) {
          let r = typeof t.result === "string" ? t.result : JSON.stringify(t.result, null, 2);
          if (r.length > 4000) r = r.slice(0, 4000) + "\n…(truncated)";
          lines.push("<sub>result:</sub>");
          lines.push("```");
          lines.push(r);
          lines.push("```");
        }
      }
      lines.push("");
      lines.push("</details>");
      lines.push("");
    }
    lines.push("---");
    lines.push("");
  }
  return lines.join("\n");
}

// ── IPC: CLAUDE.md memory file (v0.3 memory editor) ──
// Logic lives in lib/memory.js so the remote-access server can reuse it.
ipcMain.handle("memory:read", (_e, cwd) => memoryHelper.readMemory(cwd));
ipcMain.handle("memory:write", (_e, { cwd, content } = {}) => memoryHelper.writeMemory(cwd, content));

// ── IPC: Generic file read / write for the inline editor ──
// Used by the tool-card "Open editor" feature so the user can review and
// hand-edit any file claude touched. Paths are not sandboxed because the
// renderer is trusted; we just bubble any fs error back.
ipcMain.handle("file:read", async (_e, filepath) => {
  if (!filepath || typeof filepath !== "string") {
    return { ok: false, error: "Invalid file path" };
  }
  try {
    const content = await fs.promises.readFile(filepath, "utf8");
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});
ipcMain.handle("file:write", async (_e, { filepath, content } = {}) => {
  if (!filepath || typeof filepath !== "string") {
    return { ok: false, error: "Invalid file path" };
  }
  if (typeof content !== "string") {
    return { ok: false, error: "Content must be a string" };
  }
  try {
    await fs.promises.writeFile(filepath, content, "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// ── IPC: Auto-update check (v0.3) ──
//
// Returns the latest published version and a download URL, if any. The remote
// JSON lives at https://iris-code.dev/latest.json (placeholder; the maintainer
// can publish it via the marketing site). If the network is unreachable, the
// renderer keeps quiet. We never auto-install — the user clicks through to
// download.
const https = require("https");
const APP_VERSION = require("./package.json").version;
ipcMain.handle("update:check", async () => {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };
    try {
      const req = https.get("https://iris-code.dev/latest.json", { timeout: 4000 }, (res) => {
        if (res.statusCode !== 200) { finish({ ok: false, error: `http ${res.statusCode}` }); return; }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; if (body.length > 16 * 1024) { req.destroy(); finish({ ok: false, error: "body too large" }); } });
        res.on("end", () => {
          try {
            const data = JSON.parse(body);
            const latest = String(data.version || "");
            const url = typeof data.url === "string" ? data.url : null;
            const notes = typeof data.notes === "string" ? data.notes : "";
            finish({
              ok: true,
              currentVersion: APP_VERSION,
              latestVersion: latest,
              hasUpdate: isNewerVersion(latest, APP_VERSION),
              url,
              notes,
            });
          } catch (err) {
            finish({ ok: false, error: "invalid json" });
          }
        });
      });
      req.on("error", (err) => finish({ ok: false, error: String(err.message || err) }));
      req.on("timeout", () => { req.destroy(); finish({ ok: false, error: "timeout" }); });
    } catch (err) {
      finish({ ok: false, error: String(err.message || err) });
    }
  });
});

function isNewerVersion(a, b) {
  if (!a || !b) return false;
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

// ── IPC: Remote access (mobile companion) ──
ipcMain.handle("remote:status", () => getRemoteStatus());
ipcMain.handle("remote:set-config", async (_e, patch) => {
  if (!patch || typeof patch !== "object") return getRemoteStatus();
  const clean = {};
  if (typeof patch.enabled === "boolean") clean.enabled = patch.enabled;
  if (typeof patch.port === "number" && patch.port > 0 && patch.port < 65536) clean.port = patch.port;
  if (typeof patch.host === "string" && /^[\d.]+$|^localhost$/.test(patch.host)) clean.host = patch.host;
  return applyRemoteConfig(clean);
});
ipcMain.handle("remote:regenerate-token", async () => {
  const s = store.getSettings();
  const r = s.remoteAccess || {};
  const token = crypto.randomBytes(32).toString("base64url");
  store.setSettings({ remoteAccess: { ...r, token } });
  // Existing WS clients keep their socket open but will get rejected on next
  // call. Restart the server to force re-auth across the board.
  if (remoteServer.isRunning()) {
    await remoteServer.stopServer();
    await startRemoteIfEnabled();
  }
  return getRemoteStatus();
});

// ── IPC: Telegram bridge ──
ipcMain.handle("telegram:status", () => {
  if (!telegram) return { enabled: false, hasToken: false, connection: "stopped" };
  return telegram.getStatus();
});
ipcMain.handle("telegram:set-token", async (_e, token) => {
  if (!telegram) return { ok: false, error: "service not ready" };
  try { return { ok: true, status: await telegram.setToken(token) }; }
  catch (err) { return { ok: false, error: String(err.message || err) }; }
});
ipcMain.handle("telegram:clear-token", async () => {
  if (!telegram) return { ok: true };
  try { return { ok: true, status: await telegram.clearToken() }; }
  catch (err) { return { ok: false, error: String(err.message || err) }; }
});
ipcMain.handle("telegram:set-enabled", async (_e, enabled) => {
  if (!telegram) return { ok: false, error: "service not ready" };
  try { return { ok: true, status: await telegram.setEnabled(!!enabled) }; }
  catch (err) { return { ok: false, error: String(err.message || err) }; }
});
ipcMain.handle("telegram:start-pairing", () => {
  if (!telegram) return { ok: false, error: "service not ready" };
  try {
    const p = telegram.startPairing();
    return { ok: true, code: p.code, expiresAt: p.expiresAt, status: telegram.getStatus() };
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});
ipcMain.handle("telegram:cancel-pairing", () => {
  if (!telegram) return { ok: false };
  try { return { ok: true, status: telegram.cancelPairing() }; }
  catch (err) { return { ok: false, error: String(err.message || err) }; }
});
ipcMain.handle("telegram:test-message", async () => {
  if (!telegram) return { ok: false, error: "service not ready" };
  try { await telegram.sendTestMessage(); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err.message || err) }; }
});
ipcMain.handle("telegram:set-startup-prompt", (_e, value) => {
  if (!["ask", "always", "never"].includes(value)) {
    return { ok: false, error: "invalid value" };
  }
  const tg = store.getSettings().telegram || {};
  store.setSettings({ telegram: { ...tg, startupPrompt: value } });
  return { ok: true, value };
});
// Persist the user-chosen default working directory for Telegram-spawned
// worker agents. Pass null/empty to clear and fall back to the sandboxed
// default. The TelegramService validates the path before saving — typos
// surface as a returned error instead of a silently-broken spawn later.
ipcMain.handle("telegram:set-default-cwd", async (_e, cwd) => {
  if (!telegram) return { ok: false, error: "service not ready" };
  try { return { ok: true, status: telegram.setDefaultCwd(cwd) }; }
  catch (err) { return { ok: false, error: String(err.message || err) }; }
});
// Flip between routing inbound chat messages to a worker (default) vs the
// Iris orchestrator. Mostly used by the in-chat /iris and /worker
// commands; exposed as IPC so the desktop UI can also toggle it.
ipcMain.handle("telegram:set-chat-mode", async (_e, mode) => {
  if (!telegram) return { ok: false, error: "service not ready" };
  if (mode !== "iris" && mode !== "worker") {
    return { ok: false, error: "invalid mode (use 'iris' or 'worker')" };
  }
  try { return { ok: true, status: telegram.setChatMode(mode) }; }
  catch (err) { return { ok: false, error: String(err.message || err) }; }
});

// ── IPC: Misc ──
ipcMain.handle("app:dataDir", () => DATA_DIR);
ipcMain.handle("app:version", () => APP_VERSION);

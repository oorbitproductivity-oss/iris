const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("iris", {
  // ── Settings ──
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (patch) => ipcRenderer.invoke("settings:set", patch),

  // ── Folder / file pickers ──
  pickFolder: () => ipcRenderer.invoke("folder:pick"),
  pickFiles: () => ipcRenderer.invoke("files:pick"),

  // ── Agents ──
  listAgents: () => ipcRenderer.invoke("agents:list"),
  getAgent: (id) => ipcRenderer.invoke("agents:get", id),
  createAgent: (opts) => ipcRenderer.invoke("agents:create", opts),
  updateAgent: (id, patch) => ipcRenderer.invoke("agents:update", { id, patch }),
  deleteAgent: (id) => ipcRenderer.invoke("agents:delete", id),
  sendToAgent: (id, message) => ipcRenderer.send("agents:send", { id, message }),
  stopAgent: (id) => ipcRenderer.send("agents:stop", id),
  resumeAgent: (id) => ipcRenderer.send("agents:resume", id),
  sendToIris: (message) => ipcRenderer.send("agents:send", { id: "iris", message }),

  // ── API keys ──
  listKeys: () => ipcRenderer.invoke("keys:list"),
  addKey: (name, value) => ipcRenderer.invoke("keys:add", { name, value }),
  updateKey: (id, name, value) => ipcRenderer.invoke("keys:update", { id, name, value }),
  deleteKey: (id) => ipcRenderer.invoke("keys:delete", id),

  // ── Sandbox ──
  listSandboxFiles: (id) => ipcRenderer.invoke("sandbox:list", id),
  exportSandbox: (id, targetDir, files) =>
    ipcRenderer.invoke("sandbox:export", { id, targetDir, files }),

  // ── Shell ──
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  openPath: (p) => ipcRenderer.invoke("shell:openPath", p),
  showInFolder: (p) => ipcRenderer.invoke("shell:showInFolder", p),

  // ── Iris embedded overlay (renderer-only state, plus hotkey signal) ──
  toggleIris: () => ipcRenderer.send("iris:toggle"),
  onIrisToggle: (cb) => {
    const listener = () => cb();
    ipcRenderer.on("ui:iris-toggle", listener);
    return () => ipcRenderer.removeListener("ui:iris-toggle", listener);
  },

  // ── Conversation export ──
  exportThread: (id, format) => ipcRenderer.invoke("export:thread", { id, format }),

  // ── CLAUDE.md memory file (v0.3) ──
  readMemoryFile: (cwd) => ipcRenderer.invoke("memory:read", cwd),
  writeMemoryFile: (cwd, content) => ipcRenderer.invoke("memory:write", { cwd, content }),

  // ── Auto-update (v0.3) ──
  checkForUpdates: () => ipcRenderer.invoke("update:check"),
  appVersion: () => ipcRenderer.invoke("app:version"),

  // ── Remote access (mobile companion) ──
  getRemoteStatus: () => ipcRenderer.invoke("remote:status"),
  setRemoteConfig: (patch) => ipcRenderer.invoke("remote:set-config", patch),
  regenerateRemoteToken: () => ipcRenderer.invoke("remote:regenerate-token"),

  // ── Telegram bridge ──
  getTelegramStatus: () => ipcRenderer.invoke("telegram:status"),
  setTelegramToken: (token) => ipcRenderer.invoke("telegram:set-token", token),
  clearTelegramToken: () => ipcRenderer.invoke("telegram:clear-token"),
  setTelegramEnabled: (enabled) => ipcRenderer.invoke("telegram:set-enabled", enabled),
  startTelegramPairing: () => ipcRenderer.invoke("telegram:start-pairing"),
  cancelTelegramPairing: () => ipcRenderer.invoke("telegram:cancel-pairing"),
  sendTelegramTest: () => ipcRenderer.invoke("telegram:test-message"),
  setTelegramStartupPrompt: (value) => ipcRenderer.invoke("telegram:set-startup-prompt", value),
  setTelegramDefaultCwd: (cwd) => ipcRenderer.invoke("telegram:set-default-cwd", cwd),
  setTelegramChatMode: (mode) => ipcRenderer.invoke("telegram:set-chat-mode", mode),
  onTelegramStatus: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on("ui:telegram-status", listener);
    return () => ipcRenderer.removeListener("ui:telegram-status", listener);
  },

  // ── Notification → focus agent (fired when user clicks a system toast) ──
  onFocusAgent: (cb) => {
    const listener = (_e, id) => cb(id);
    ipcRenderer.on("ui:focus-agent", listener);
    return () => ipcRenderer.removeListener("ui:focus-agent", listener);
  },

  // ── Events ──
  onAgentEvent: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on("agent:event", listener);
    return () => ipcRenderer.removeListener("agent:event", listener);
  },

  // ── Window controls ──
  windowMin: () => ipcRenderer.send("win:min"),
  windowMax: () => ipcRenderer.send("win:max"),
  windowFullscreen: () => ipcRenderer.send("win:fullscreen"),
  windowClose: () => ipcRenderer.send("win:close"),
  windowNew: () => ipcRenderer.send("win:new"),

  // ── Generic file IO for the inline editor ──
  fileRead: (filepath) => ipcRenderer.invoke("file:read", filepath),
  fileWrite: (filepath, content) => ipcRenderer.invoke("file:write", { filepath, content }),

  // ── Hotkey validator ──
  hotkeySet: (id, accelerator) => ipcRenderer.invoke("hotkey:set", { id, accelerator }),
  hotkeyRecheck: () => ipcRenderer.invoke("hotkey:recheck"),
  hotkeyList: () => ipcRenderer.invoke("hotkey:list"),
  onHotkeyConflicts: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on("ui:hotkey-conflicts", listener);
    return () => ipcRenderer.removeListener("ui:hotkey-conflicts", listener);
  },

  // ── Screenshot ──
  captureScreenshot: () => ipcRenderer.invoke("screenshot:capture"),
  saveScreenshotDataUrl: (dataUrl) => ipcRenderer.invoke("screenshot:save-data-url", dataUrl),
  onScreenshot: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on("ui:screenshot-taken", listener);
    return () => ipcRenderer.removeListener("ui:screenshot-taken", listener);
  },
  onScreenshotError: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on("ui:screenshot-error", listener);
    return () => ipcRenderer.removeListener("ui:screenshot-error", listener);
  },

  // ── MCP marketplace ──
  mcp: {
    catalog: (opts) => ipcRenderer.invoke("mcp:catalog", opts || {}),
    installs: () => ipcRenderer.invoke("mcp:installs"),
    install: (opts) => ipcRenderer.invoke("mcp:install", opts || {}),
    uninstall: (id) => ipcRenderer.invoke("mcp:uninstall", id),
  },

  // ── Integrated terminal (v0.5 Feature 3) ──
  // PTY events ride on the existing "agent:event" broadcast channel so we
  // don't have to plumb a second pipe; onData/onExit filter by event.type.
  terminal: {
    available: () => ipcRenderer.invoke("terminal:available"),
    create: (opts) => ipcRenderer.invoke("terminal:create", opts || {}),
    list: (opts) => ipcRenderer.invoke("terminal:list", opts || {}),
    history: (terminalId, lines) =>
      ipcRenderer.invoke("terminal:history", { terminalId, lines }),
    write: (terminalId, data) =>
      ipcRenderer.send("terminal:write", { terminalId, data }),
    resize: (terminalId, cols, rows) =>
      ipcRenderer.send("terminal:resize", { terminalId, cols, rows }),
    kill: (terminalId) => ipcRenderer.send("terminal:kill", terminalId),
    onData: (cb) => {
      const listener = (_e, payload) => {
        if (payload && payload.type === "terminal:data") cb(payload);
      };
      ipcRenderer.on("agent:event", listener);
      return () => ipcRenderer.removeListener("agent:event", listener);
    },
    onExit: (cb) => {
      const listener = (_e, payload) => {
        if (payload && payload.type === "terminal:exit") cb(payload);
      };
      ipcRenderer.on("agent:event", listener);
      return () => ipcRenderer.removeListener("agent:event", listener);
    },
  },

  // ── Translucent window (v0.5 Feature 7) ──
  // Async invoke avoids needing a sync IPC pathway in the renderer; the
  // result is { supported: bool, reason: string|null }. The theme picker
  // awaits this on mount to decide whether to show the option as enabled
  // or as a disabled checkbox with an explanatory tooltip.
  translucentSupported: () => ipcRenderer.invoke("translucent:support"),
  onTranslucentChanged: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on("ui:translucent-changed", listener);
    return () => ipcRenderer.removeListener("ui:translucent-changed", listener);
  },

  // ── Misc ──
  dataDir: () => ipcRenderer.invoke("app:dataDir"),
  platform: process.platform,
});

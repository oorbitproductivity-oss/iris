// app.js -- Iris Code entry point

import { createState } from "./lib/state.js";
import { mountSidebar } from "./ui/sidebar.js";
import { mountChatView } from "./ui/chat-view.js";
import { mountIrisView } from "./ui/iris-view.js";
import { showNewSessionModal } from "./ui/new-session.js";
import { showSettingsModal } from "./ui/settings.js";
import { showOverlay as showIris, hideOverlay as hideIris, toggleOverlay as toggleIris } from "./ui/iris-overlay.js";
import { showOnboarding } from "./ui/onboarding.js";
import { showToast } from "./ui/util.js";

// v0.2 features
import { initCommandPalette } from "./ui/command-palette.js";
import { initTemplates } from "./ui/templates.js";
import { initSnippets } from "./ui/snippets.js";
import { initStats } from "./ui/stats-view.js";
import { initPinning } from "./ui/pinning.js";

// v0.3 features
import { initThemes, showThemePicker } from "./ui/theme-picker.js";
import { initSearch, showSearch } from "./ui/search.js";
import { initTags } from "./ui/tags.js";
import { initVoice } from "./ui/voice.js";
import { initDiffViewer } from "./ui/diff-viewer.js";
import { initMemoryEditor, showMemoryEditor } from "./ui/memory-editor.js";
import { initCostTracker } from "./ui/cost-tracker.js";
import { initTour, showTour } from "./ui/tour.js";
import { initPlanMode } from "./ui/plan-mode.js";
import { initUpdateCheck } from "./ui/update-banner.js";
import { openScreenshotModal } from "./ui/screenshot-modal.js";
import { initHotkeyConflicts } from "./ui/hotkey-conflicts.js";
import { initMcpMarketplace } from "./ui/mcp-marketplace.js";
import { initBrowserPane } from "./ui/browser-pane.js";
import { initTerminalPane } from "./ui/terminal-pane.js";

// Top-level error visibility: in packaged builds DevTools is closed, so a
// silent renderer crash leaves the user staring at a blank page. Paint any
// boot error into a SMALL banner at the bottom of the screen — small enough
// to never block the UI, with a close button so the user can dismiss it
// once they've read (or copied) the message.
(function installCrashBanner() {
  function paint(msg, stack) {
    try {
      let banner = document.getElementById("__iris_crash");
      if (!banner) {
        banner = document.createElement("div");
        banner.id = "__iris_crash";
        banner.setAttribute(
          "style",
          "position:fixed;left:12px;right:12px;bottom:12px;z-index:99999;max-height:200px;padding:10px 14px;background:#1a0a0a;border:1px solid #aa3030;color:#ffd0d0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:1.45;border-radius:8px;overflow:auto;white-space:pre-wrap;box-shadow:0 8px 32px rgba(0,0,0,0.5);pointer-events:auto;"
        );
        const header = document.createElement("div");
        header.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;";
        const title = document.createElement("div");
        title.textContent = "Iris renderer error";
        title.style.cssText = "font-size:12px;font-weight:600;color:#ff8080;";
        const close = document.createElement("button");
        close.textContent = "✕";
        close.title = "Dismiss";
        close.style.cssText = "background:transparent;border:0;color:#ff8080;cursor:pointer;font-size:14px;padding:0 6px;";
        close.addEventListener("click", () => banner.remove());
        header.appendChild(title);
        header.appendChild(close);
        banner.appendChild(header);
        const body = document.createElement("div");
        body.id = "__iris_crash_body";
        banner.appendChild(body);
        if (document.body) document.body.appendChild(banner);
        else document.addEventListener("DOMContentLoaded", () => document.body.appendChild(banner));
      }
      const body = banner.querySelector("#__iris_crash_body");
      if (body) {
        const line = document.createElement("div");
        line.textContent = (msg || "") + (stack ? "\n" + stack : "");
        line.style.marginBottom = "6px";
        body.appendChild(line);
      }
    } catch {}
  }
  window.addEventListener("error", (e) => {
    paint(e.message || String(e.error || e), e.error && e.error.stack);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    paint("Unhandled promise rejection: " + (r && r.message ? r.message : String(r)), r && r.stack);
  });
})();

const state = createState();
if (typeof window !== "undefined") window.__iris_state = state;

// Expose overlay controls globally so sidebar / home view can call them.
window.__iris_toggle = toggleIris;
window.__iris_show = showIris;
window.__iris_hide = hideIris;

function setupWindowControls() {
  const controls = document.getElementById("window-controls");
  if (!controls) return;
  controls.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.getAttribute("data-act");
    try {
      if (act === "min") window.iris?.windowMin?.();
      else if (act === "max") window.iris?.windowMax?.();
      else if (act === "close") window.iris?.windowClose?.();
    } catch (err) {
      console.warn("[app] window control failed", err);
    }
  });

  // Mac-style traffic-light trio fades when the window loses focus.
  const titlebar = document.getElementById("titlebar");
  if (titlebar) {
    window.addEventListener("focus", () => titlebar.classList.remove("blurred"));
    window.addEventListener("blur", () => titlebar.classList.add("blurred"));
    if (!document.hasFocus()) titlebar.classList.add("blurred");
  }
}

function setupGlobalDelegates() {
  document.addEventListener("click", (e) => {
    const a = e.target.closest("[data-url]");
    if (!a) return;
    e.preventDefault();
    const url = a.getAttribute("data-url");
    if (url) {
      try { window.iris?.openExternal?.(url); }
      catch (err) { console.warn("[app] open failed", err); }
    }
  });

  // Action chips from Iris overlay can request agent focus
  window.addEventListener("iris:select-agent", (e) => {
    const id = e.detail;
    if (id) state.actions.selectAgent(id);
  });

  // Action chips from Iris overlay can request a new session pre-filled
  window.addEventListener("iris:create-agent", (e) => {
    showNewSessionModal(state, e.detail || {});
  });

  // v0.2: command palette dispatches "iris:export-current" — save the active
  // thread to disk as Markdown via the main-process IPC.
  window.addEventListener("iris:export-current", async () => {
    const id = state.get().activeId;
    if (!id || id === "iris") {
      showToast("Select a thread first to export", { error: true });
      return;
    }
    try {
      const r = await window.iris.exportThread(id, "markdown");
      if (r && r.ok) showToast("Exported to " + r.path);
      else if (r && r.canceled) {} // user cancelled save dialog — silent
      else showToast("Export failed: " + (r && r.error || "unknown"), { error: true });
    } catch (err) {
      showToast("Export failed: " + (err.message || err), { error: true });
    }
  });

  // v0.2: clicking a system notification asks main to focus the firing agent.
  if (window.iris?.onFocusAgent) {
    window.iris.onFocusAgent((id) => {
      if (id) state.actions.selectAgent(id);
    });
  }

  // Iris auto-create: full setup with sensible defaults, then jump into chat.
  // No modal — Iris has already specified name/cwd/prompt/model.
  window.addEventListener("iris:create-agent-auto", async (e) => {
    const d = e.detail || {};
    const settings = state.get().settings || {};
    try {
      const agent = await window.iris.createAgent({
        name: d.name || "Untitled thread",
        cwd: d.cwd || settings.defaultCwd || undefined,
        initialPrompt: d.prompt || undefined,
        model: d.model || settings.model || "sonnet",
        apiKeyId: settings.defaultApiKeyId || null,
        sandbox: !!settings.sandboxByDefault,
      });
      if (agent && agent.id && state.actions.selectAgent) {
        try { await state.actions.selectAgent(agent.id); } catch {}
      }
    } catch (err) {
      console.error("[app] auto-create failed", err);
      showToast("Failed to start agent: " + (err.message || err), { error: true });
    }
  });
}

function setupKeyboard() {
  document.addEventListener("keydown", (e) => {
    // Ctrl/Cmd+N — new session
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
      e.preventDefault();
      showNewSessionModal(state);
      return;
    }
    // Ctrl/Cmd+K — toggle Iris overlay
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      toggleIris();
      return;
    }
    // Ctrl/Cmd+, — settings
    if ((e.ctrlKey || e.metaKey) && e.key === ",") {
      e.preventDefault();
      showSettingsModal(state);
      return;
    }
    // F11 — fullscreen toggle
    if (e.key === "F11") {
      e.preventDefault();
      window.iris?.windowFullscreen?.();
      return;
    }
  });
}

function setupIrisHotkeyFromMain() {
  // Main process forwards the global hotkey here
  window.iris?.onIrisToggle?.(() => toggleIris());
}

function setupScreenshotHotkey() {
  if (!window.iris?.onScreenshot) return;
  window.iris.onScreenshot((payload) => {
    if (payload && payload.filepath && payload.dataUrl) openScreenshotModal(payload);
  });
  window.iris.onScreenshotError?.(({ error }) => {
    showToast("Screenshot failed: " + error, { error: true });
  });
}

// Main router: home view (Iris dashboard / welcome) when activeId is "iris" or
// no worker selected; chat view for a selected worker.
function setupRouter() {
  const main = document.getElementById("main");
  let currentKind = null;
  let currentId = null;

  function renderMain() {
    const s = state.get();
    const isWorker = s.activeId && s.activeId !== "iris";
    const kind = isWorker ? "worker" : "home";
    const id = isWorker ? s.activeId : "home";

    if (kind === currentKind && id === currentId) return;
    currentKind = kind;
    currentId = id;

    if (main.__unmount) try { main.__unmount(); } catch {}
    if (kind === "home") mountIrisView(main, state);
    else mountChatView(main, state);
  }

  renderMain();
  state.subscribe(renderMain);
}

async function boot() {
  if (typeof window.iris === "undefined") {
    console.warn("[app] window.iris not available — running in stub mode");
    window.iris = {
      getSettings: async () => ({
        defaultCwd: null, recentFolders: [], model: "sonnet",
        mode: "subscription", apiKey: null, theme: "dark",
        irisModel: "sonnet", systemPromptExtras: "",
        spotlightHotkey: "CommandOrControl+Shift+Space",
        onboarded: true,
      }),
      setSettings: async (p) => p,
      pickFolder: async () => null,
      pickFiles: async () => [],
      listAgents: async () => [{
        id: "iris", role: "iris", name: "Iris", cwd: "",
        model: "sonnet", status: "idle", lastActivity: Date.now(),
        lastText: "", createdAt: Date.now(), sessionId: null,
      }],
      getAgent: async (id) => ({ id, messages: [] }),
      createAgent: async (opts) => ({
        id: `agent-${Date.now()}`,
        role: "worker", name: opts.name || "Untitled",
        cwd: opts.cwd || "", model: opts.model || "sonnet",
        status: "idle", lastActivity: Date.now(),
        lastText: "", createdAt: Date.now(), sessionId: null,
      }),
      deleteAgent: async () => true,
      sendToAgent: () => {},
      sendToIris: () => {},
      stopAgent: () => {},
      resumeAgent: () => {},
      listKeys: async () => [],
      addKey: async () => ({ id: "stub", name: "Stub" }),
      updateKey: async () => {},
      deleteKey: async () => {},
      openExternal: async () => true,
      openPath: async () => ({ ok: true }),
      toggleIris: () => {},
      onAgentEvent: () => () => {},
      onIrisToggle: () => () => {},
      exportThread: async () => ({ ok: false, error: "stub mode" }),
      onFocusAgent: () => () => {},
      readMemoryFile: async () => ({ ok: false, error: "stub mode" }),
      writeMemoryFile: async () => ({ ok: false, error: "stub mode" }),
      checkForUpdates: async () => ({ ok: false }),
      appVersion: async () => "0.0.0-stub",
      windowMin: () => {}, windowMax: () => {}, windowClose: () => {},
      platform: "stub",
    };
  }

  setupWindowControls();
  setupGlobalDelegates();
  setupKeyboard();
  setupIrisHotkeyFromMain();
  setupScreenshotHotkey();
  initHotkeyConflicts();

  await state.actions.loadSettings();
  await state.actions.loadAgents();

  // Sidebar mount
  const sb = document.getElementById("sidebar");
  if (sb) mountSidebar(sb, state);

  setupRouter();

  // v0.2 feature modules. Each registers its own listeners; safe to call once.
  try { initCommandPalette(state); } catch (e) { console.error("[app] command palette init failed", e); }
  try { initTemplates(state); } catch (e) { console.error("[app] templates init failed", e); }
  try { initSnippets(state); } catch (e) { console.error("[app] snippets init failed", e); }
  try { initStats(state); } catch (e) { console.error("[app] stats init failed", e); }
  try { initPinning(state); } catch (e) { console.error("[app] pinning init failed", e); }

  // v0.3 feature modules.
  try { initThemes(state); } catch (e) { console.error("[app] themes init failed", e); }
  try { initSearch(state); } catch (e) { console.error("[app] search init failed", e); }
  try { initTags(state); } catch (e) { console.error("[app] tags init failed", e); }
  try { initVoice(state); } catch (e) { console.error("[app] voice init failed", e); }
  try { initDiffViewer(state); } catch (e) { console.error("[app] diff viewer init failed", e); }
  try { initMemoryEditor(state); } catch (e) { console.error("[app] memory editor init failed", e); }
  try { initCostTracker(state); } catch (e) { console.error("[app] cost tracker init failed", e); }
  try { initPlanMode(state); } catch (e) { console.error("[app] plan mode init failed", e); }
  try { initUpdateCheck(state); } catch (e) { console.error("[app] update check init failed", e); }
  try { initTour(state); } catch (e) { console.error("[app] tour init failed", e); }
  try { initMcpMarketplace(state); } catch (e) { console.error("[mcp-marketplace] init failed:", e); }
  try { initBrowserPane(state); } catch (e) { console.error("[app] browser pane init failed", e); }
  try { initTerminalPane(state); } catch (e) { console.error("[app] terminal pane init failed", e); }

  // Bridge custom-events fired by the command palette (and the tour) to the
  // matching show… modal functions. Listeners are idempotent — registering
  // once per boot is enough.
  window.addEventListener("iris:show-theme-picker", () => { try { showThemePicker(state); } catch (err) { console.error(err); } });
  window.addEventListener("iris:show-search", () => { try { showSearch(state); } catch (err) { console.error(err); } });
  window.addEventListener("iris:show-memory", () => { try { showMemoryEditor(state); } catch (err) { console.error(err); } });
  window.addEventListener("iris:show-tour", () => { try { showTour(state); } catch (err) { console.error(err); } });
  window.addEventListener("iris:show-tags", (e) => {
    const id = (e && e.detail) || state.get().activeId;
    try { window.__iris_show_tags_manager?.(id); } catch (err) { console.error(err); }
  });
  // Command-palette dispatches this to programmatically open itself (from the tour).
  window.addEventListener("iris:show-command-palette", () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "P", code: "KeyP", ctrlKey: true, shiftKey: true, bubbles: true }));
  });

  // First-run onboarding. Shown once; settings.onboarded gates it forever
  // after. Runs after the main UI is mounted so the wizard floats above it.
  if (state.get().settings && state.get().settings.onboarded === false) {
    try { await showOnboarding(state); }
    catch (err) { console.error("[app] onboarding failed:", err); }
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

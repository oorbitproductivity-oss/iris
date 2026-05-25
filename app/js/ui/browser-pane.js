// ═══════════════════════════════════════════════════════════
// browser-pane.js — v0.5 embedded browser pane
// ═══════════════════════════════════════════════════════════
//
// Renderer-only feature. The main process already enables `webviewTag: true`
// on the BrowserWindow and seeds the relevant defaults in settings:
//   • settings.browserPaneEnabled        (default true)
//   • settings.browserPaneStateByAgent   ({ [agentId]: { open, url } })
//   • settings.browserPaneWidth          (number, default 480)
//
// This module owns the chrome around an Electron <webview>:
//   • A "Browser" pill toggle in the chat header (mounted by chat-view.js).
//   • A side pane next to the chat: URL bar, nav buttons, footer actions,
//     and a vertical drag handle that resizes both panels.
//   • One <webview> element per agent (cached in a Map); switching agents
//     hides the previous one and shows the next. We can't reuse a single
//     webview because the `partition=` attribute is locked once the element
//     is in the DOM, and we want per-agent cookie isolation.
//
// The agent CANNOT drive this pane in v0.5.0 (no CDP attachment yet) — the
// pane is for the *human* to research alongside the agent and ship the
// occasional screenshot. Agents that need their own browser should install
// the Playwright MCP from the marketplace.
// ═══════════════════════════════════════════════════════════

import { h, svgIcon, showToast } from "./util.js";

const PANE_HOST_ID = "browser-pane-host";
const SPLITTER_ID = "browser-pane-splitter";
const DEFAULT_WIDTH = 480;
const MIN_WIDTH = 300;
const PERSIST_DEBOUNCE_MS = 300;

let stateRef = null;          // module-scoped state store
let hostEl = null;            // <div id="browser-pane-host">
let splitterEl = null;        // drag handle
let urlInput = null;          // URL bar input
let backBtn = null;
let fwdBtn = null;
let reloadBtn = null;
let webviewSlot = null;       // container the per-agent webviews live in
let loadingBar = null;
let errorBanner = null;

// Map<agentId, { webview: HTMLElement, lastUrl: string, ready: boolean }>
const webviewsByAgent = new Map();
let currentAgentId = null;

// Debounced persistence for pane state (open + url).
const pendingPersist = new Map(); // agentId -> timeoutHandle

// ────────────────────────────────────────────────────────────
// URL sanitization
// ────────────────────────────────────────────────────────────
function sanitizeUrl(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return { ok: false, error: "Enter a URL." };
  // Reject obvious non-http schemes outright.
  if (/^(file|javascript|data|chrome|chrome-extension|about):/i.test(trimmed)) {
    return { ok: false, error: "Only http(s) URLs are allowed." };
  }
  let candidate = trimmed;
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = "https://" + candidate;
  }
  try {
    const u = new URL(candidate);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { ok: false, error: "Only http(s) URLs are allowed." };
    }
    return { ok: true, url: u.toString() };
  } catch {
    return { ok: false, error: "Not a valid URL." };
  }
}

// ────────────────────────────────────────────────────────────
// Settings helpers
// ────────────────────────────────────────────────────────────
function getSettings() {
  const s = stateRef ? stateRef.get() : null;
  return (s && s.settings) || {};
}

function getPaneStateFor(agentId) {
  const all = getSettings().browserPaneStateByAgent || {};
  return all[agentId] || { open: false, url: "" };
}

function isPaneEnabled() {
  const s = getSettings();
  return s.browserPaneEnabled !== false;
}

function getPaneWidth() {
  const w = Number(getSettings().browserPaneWidth);
  if (!Number.isFinite(w) || w <= 0) return DEFAULT_WIDTH;
  return clampWidth(w);
}

function clampWidth(w) {
  const max = Math.max(MIN_WIDTH + 1, Math.floor(window.innerWidth * 0.7));
  return Math.max(MIN_WIDTH, Math.min(max, Math.floor(w)));
}

function persistPaneState(agentId, patch) {
  if (!agentId || agentId === "iris") return;
  // Coalesce updates per agent so rapid navigation doesn't hammer setSettings.
  if (pendingPersist.has(agentId)) {
    clearTimeout(pendingPersist.get(agentId));
  }
  const t = setTimeout(async () => {
    pendingPersist.delete(agentId);
    try {
      const cur = getSettings().browserPaneStateByAgent || {};
      const prev = cur[agentId] || { open: false, url: "" };
      const next = { ...prev, ...patch };
      // Drop the no-op write (avoids touching disk when nothing changed).
      if (next.open === prev.open && next.url === prev.url) return;
      const merged = { ...cur, [agentId]: next };
      await window.iris.setSettings({ browserPaneStateByAgent: merged });
      // Settings store will fire its own update through getSettings later;
      // we don't bother re-reading here.
    } catch (err) {
      console.warn("[browser-pane] failed to persist pane state", err);
    }
  }, PERSIST_DEBOUNCE_MS);
  pendingPersist.set(agentId, t);
}

async function persistPaneWidth(width) {
  try {
    await window.iris.setSettings({ browserPaneWidth: clampWidth(width) });
  } catch (err) {
    console.warn("[browser-pane] failed to persist pane width", err);
  }
}

// ────────────────────────────────────────────────────────────
// Webview lifecycle (one per agent)
// ────────────────────────────────────────────────────────────
function getOrCreateWebview(agentId) {
  if (webviewsByAgent.has(agentId)) return webviewsByAgent.get(agentId);

  // <webview> tag must be created via createElement so we can set
  // partition BEFORE attach. Once attached, partition is immutable.
  const wv = document.createElement("webview");
  wv.setAttribute("partition", `persist:agent-${agentId}`);
  wv.setAttribute("allowpopups", "false");
  // Explicitly DO NOT touch disablewebsecurity / nodeintegration — defaults
  // (off) are correct and the CSP review forbids loosening them.
  wv.style.display = "none";
  wv.style.flex = "1";
  wv.style.width = "100%";
  wv.style.background = "white";

  const entry = { webview: wv, lastUrl: "", ready: false };

  wv.addEventListener("dom-ready", () => { entry.ready = true; });

  wv.addEventListener("did-start-loading", () => {
    if (agentId !== currentAgentId) return;
    setLoading(true);
    hideError();
  });

  wv.addEventListener("did-stop-loading", () => {
    if (agentId !== currentAgentId) return;
    setLoading(false);
  });

  const syncNavState = () => {
    if (agentId !== currentAgentId) return;
    try {
      backBtn.disabled = !entry.ready || !wv.canGoBack();
      fwdBtn.disabled = !entry.ready || !wv.canGoForward();
    } catch {
      backBtn.disabled = true;
      fwdBtn.disabled = true;
    }
  };

  wv.addEventListener("did-navigate", (e) => {
    entry.lastUrl = e.url || entry.lastUrl;
    if (agentId === currentAgentId) urlInput.value = entry.lastUrl;
    persistPaneState(agentId, { url: entry.lastUrl, open: true });
    syncNavState();
  });

  wv.addEventListener("did-navigate-in-page", (e) => {
    // In-page nav (SPA route changes) — same handling, different event.
    entry.lastUrl = e.url || entry.lastUrl;
    if (agentId === currentAgentId) urlInput.value = entry.lastUrl;
    persistPaneState(agentId, { url: entry.lastUrl, open: true });
    syncNavState();
  });

  wv.addEventListener("page-title-updated", () => {
    syncNavState();
  });

  wv.addEventListener("did-fail-load", (e) => {
    // Ignore aborted loads (-3) — these fire on user-initiated navigation
    // before a real failure code arrives.
    if (e && e.errorCode === -3) return;
    if (agentId !== currentAgentId) return;
    setLoading(false);
    const why = e && e.errorDescription ? e.errorDescription : "Load failed";
    showError(`Couldn't load page — ${why}`);
  });

  // The webview prevents new windows because allowpopups="false"; route any
  // outbound link a user opens to the system browser instead of silently
  // dropping it.
  wv.addEventListener("new-window", (e) => {
    if (e && e.url) {
      try { window.iris?.openExternal?.(e.url); } catch {}
    }
  });

  webviewsByAgent.set(agentId, entry);
  webviewSlot.append(wv);
  return entry;
}

function showWebviewFor(agentId) {
  for (const [id, entry] of webviewsByAgent) {
    entry.webview.style.display = id === agentId ? "flex" : "none";
  }
}

function destroyWebviewFor(agentId) {
  const entry = webviewsByAgent.get(agentId);
  if (!entry) return;
  try { entry.webview.remove(); } catch {}
  webviewsByAgent.delete(agentId);
}

// ────────────────────────────────────────────────────────────
// URL bar / nav actions
// ────────────────────────────────────────────────────────────
function navigateTo(rawUrl) {
  if (!currentAgentId || currentAgentId === "iris") return;
  const result = sanitizeUrl(rawUrl);
  if (!result.ok) {
    showError(result.error);
    return;
  }
  hideError();
  const entry = getOrCreateWebview(currentAgentId);
  entry.lastUrl = result.url;
  urlInput.value = result.url;
  try {
    if (entry.ready && typeof entry.webview.loadURL === "function") {
      entry.webview.loadURL(result.url);
    } else {
      entry.webview.setAttribute("src", result.url);
    }
  } catch (err) {
    showError("Navigation failed: " + (err.message || err));
  }
  persistPaneState(currentAgentId, { url: result.url, open: true });
}

function setLoading(loading) {
  if (!loadingBar) return;
  loadingBar.classList.toggle("loading", !!loading);
}

function showError(msg) {
  if (!errorBanner) return;
  errorBanner.textContent = msg;
  errorBanner.hidden = false;
}

function hideError() {
  if (!errorBanner) return;
  errorBanner.hidden = true;
  errorBanner.textContent = "";
}

// ────────────────────────────────────────────────────────────
// Screenshot → chat composer
// ────────────────────────────────────────────────────────────
async function captureAndAttach() {
  if (!currentAgentId || currentAgentId === "iris") return;
  const entry = webviewsByAgent.get(currentAgentId);
  if (!entry || !entry.ready) {
    showToast("Page not ready yet", { error: true });
    return;
  }
  let dataUrl = "";
  try {
    const img = await entry.webview.capturePage();
    if (!img) throw new Error("empty capture");
    dataUrl = img.toDataURL("image/png");
  } catch (err) {
    console.warn("[browser-pane] capturePage failed", err);
    showToast("Screenshot failed: " + (err.message || err), { error: true });
    return;
  }
  if (!dataUrl) {
    showToast("Screenshot was empty", { error: true });
    return;
  }
  // Save the data URL to disk via the main process so the agent can Read it
  // by absolute path. A data-URL-in-markdown alone isn't readable by Claude's
  // built-in tools, so we land it on the filesystem first (under SCREENSHOT_DIR)
  // and reference the path.
  let filepath = null;
  try {
    const r = await window.iris.saveScreenshotDataUrl(dataUrl);
    if (r && r.ok && r.filepath) filepath = r.filepath;
    else throw new Error((r && r.error) || "unknown save error");
  } catch (err) {
    console.warn("[browser-pane] save screenshot failed", err);
    showToast("Save failed: " + (err.message || err), { error: true });
    return;
  }
  const ta = document.querySelector(".chat-view .composer textarea");
  if (!ta) {
    showToast("Couldn't find the chat input", { error: true });
    return;
  }
  const fromHint = entry.lastUrl ? ` from ${entry.lastUrl}` : "";
  const attachment = `I attached a screenshot${fromHint}. Please read it: ${filepath}`;
  const cur = ta.value || "";
  ta.value = cur ? `${cur}\n\n${attachment}` : attachment;
  // Force the autosizer + send-enabled state to re-evaluate.
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.focus();
  showToast("Screenshot attached to the chat input");
}

// ────────────────────────────────────────────────────────────
// Drag splitter
// ────────────────────────────────────────────────────────────
function attachSplitterHandlers() {
  let dragging = false;
  let startX = 0;
  let startW = 0;

  splitterEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX;
    startW = hostEl.getBoundingClientRect().width;
    splitterEl.setPointerCapture(e.pointerId);
    splitterEl.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    e.preventDefault();
  });

  splitterEl.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    // The pane is on the right of the splitter, so dragging LEFT widens it.
    const delta = startX - e.clientX;
    const next = clampWidth(startW + delta);
    hostEl.style.width = next + "px";
    hostEl.style.flex = `0 0 ${next}px`;
  });

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    try { splitterEl.releasePointerCapture(e.pointerId); } catch {}
    splitterEl.classList.remove("dragging");
    document.body.style.cursor = "";
    persistPaneWidth(hostEl.getBoundingClientRect().width);
  };
  splitterEl.addEventListener("pointerup", endDrag);
  splitterEl.addEventListener("pointercancel", endDrag);
}

// ────────────────────────────────────────────────────────────
// Pane open/close
// ────────────────────────────────────────────────────────────
function setPaneOpen(agentId, open) {
  if (!agentId || agentId === "iris") return;
  if (!isPaneEnabled()) open = false;
  currentAgentId = agentId;

  const main = document.getElementById("main");
  if (!main) return;
  main.classList.toggle("browser-pane-open", !!open);

  if (open) {
    const width = getPaneWidth();
    hostEl.style.width = width + "px";
    hostEl.style.flex = `0 0 ${width}px`;
    hostEl.hidden = false;
    splitterEl.hidden = false;

    const entry = getOrCreateWebview(agentId);
    showWebviewFor(agentId);
    // Hydrate URL from persisted state or default to current src.
    const persisted = getPaneStateFor(agentId);
    const initialUrl = entry.lastUrl || persisted.url || "https://www.google.com";
    if (!entry.lastUrl) {
      entry.lastUrl = initialUrl;
      try {
        entry.webview.setAttribute("src", initialUrl);
      } catch {}
    }
    urlInput.value = entry.lastUrl;
    hideError();
    persistPaneState(agentId, { open: true, url: entry.lastUrl });
  } else {
    hostEl.hidden = true;
    splitterEl.hidden = true;
    persistPaneState(agentId, { open: false });
  }

  // Refresh the toggle pill (if mounted) so the on/off state is correct.
  refreshToggleStates(agentId);
}

function isPaneOpenFor(agentId) {
  if (!agentId || agentId === "iris") return false;
  if (!isPaneEnabled()) return false;
  return !!(getPaneStateFor(agentId).open);
}

// Track toggle buttons mounted by chat-view so we can keep them in sync when
// the user switches agents or settings flip.
const activeToggles = new Set();
function refreshToggleStates(agentId) {
  for (const btn of activeToggles) {
    const id = btn.dataset.agentId;
    const enabled = isPaneEnabled();
    if (!enabled || id === "iris") {
      btn.hidden = true;
      continue;
    }
    btn.hidden = false;
    const on = id === agentId && isPaneOpenFor(id);
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
}

// ────────────────────────────────────────────────────────────
// Host DOM construction
// ────────────────────────────────────────────────────────────
function buildHost() {
  hostEl = h("div", { class: "browser-pane-host", id: PANE_HOST_ID, hidden: true });

  // ── URL / nav bar ──
  const bar = h("div", { class: "bp-bar" });
  backBtn = h("button", { class: "bp-icon-btn", type: "button", title: "Back", "aria-label": "Back" },
    svgIcon("chevRight", 14));
  backBtn.firstChild.style.transform = "rotate(180deg)";
  fwdBtn = h("button", { class: "bp-icon-btn", type: "button", title: "Forward", "aria-label": "Forward" },
    svgIcon("chevRight", 14));
  reloadBtn = h("button", { class: "bp-icon-btn", type: "button", title: "Reload", "aria-label": "Reload" },
    svgIcon("spark", 14));

  const form = h("form", { class: "bp-urlform" });
  urlInput = h("input", {
    class: "bp-url",
    type: "text",
    spellcheck: "false",
    autocomplete: "off",
    placeholder: "https://…",
  });
  const goBtn = h("button", { class: "bp-go", type: "submit" }, "Go");
  form.append(urlInput, goBtn);

  bar.append(backBtn, fwdBtn, reloadBtn, form);

  // ── Loading indicator (thin animated bar under the URL row) ──
  loadingBar = h("div", { class: "bp-loadbar" });

  // ── Inline error banner (URL parse + did-fail-load) ──
  errorBanner = h("div", { class: "bp-error", hidden: true });

  // ── Webview slot ──
  webviewSlot = h("div", { class: "bp-webview-slot" });

  // ── Footer ──
  const footer = h("div", { class: "bp-footer" });
  const openExtBtn = h("button", { class: "bp-foot-btn", type: "button" },
    svgIcon("arrowRight", 12),
    h("span", null, "Open in external browser"));
  const shotBtn = h("button", { class: "bp-foot-btn", type: "button" },
    svgIcon("spark", 12),
    h("span", null, "Send screenshot to agent"));
  footer.append(openExtBtn, shotBtn);

  hostEl.append(bar, loadingBar, errorBanner, webviewSlot, footer);

  // ── Wire events ──
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    navigateTo(urlInput.value);
  });
  backBtn.addEventListener("click", () => {
    if (!currentAgentId) return;
    const entry = webviewsByAgent.get(currentAgentId);
    if (entry && entry.ready) { try { entry.webview.goBack(); } catch {} }
  });
  fwdBtn.addEventListener("click", () => {
    if (!currentAgentId) return;
    const entry = webviewsByAgent.get(currentAgentId);
    if (entry && entry.ready) { try { entry.webview.goForward(); } catch {} }
  });
  reloadBtn.addEventListener("click", () => {
    if (!currentAgentId) return;
    const entry = webviewsByAgent.get(currentAgentId);
    if (entry && entry.ready) { try { entry.webview.reload(); } catch {} }
  });
  openExtBtn.addEventListener("click", () => {
    if (!currentAgentId) return;
    const entry = webviewsByAgent.get(currentAgentId);
    const url = (entry && entry.lastUrl) || urlInput.value;
    if (url) {
      try { window.iris?.openExternal?.(url); }
      catch (err) { showToast("Couldn't open external browser", { error: true }); }
    }
  });
  shotBtn.addEventListener("click", () => { captureAndAttach(); });
}

function buildSplitter() {
  splitterEl = h("div", {
    class: "browser-pane-splitter",
    id: SPLITTER_ID,
    role: "separator",
    "aria-orientation": "vertical",
    hidden: true,
  });
}

// Pane host + splitter mount as siblings INSIDE #main. Since chat-view's
// mount empties #main on every router transition, we rebuild the host nodes
// alongside the new chat each time. The Map of webviews per agent persists
// across remounts so cookies & navigation history stay intact.
function ensureMountedInMain() {
  const main = document.getElementById("main");
  if (!main) return;
  // Force #main to be a row so chat + splitter + pane sit side-by-side.
  main.classList.add("with-browser-pane");
  if (!main.contains(splitterEl)) main.append(splitterEl);
  if (!main.contains(hostEl)) main.append(hostEl);
  // Re-parent webviews into the (possibly new) slot.
  for (const entry of webviewsByAgent.values()) {
    if (entry.webview.parentNode !== webviewSlot) {
      webviewSlot.append(entry.webview);
    }
  }
}

// ────────────────────────────────────────────────────────────
// Public exports
// ────────────────────────────────────────────────────────────

export function initBrowserPane(state) {
  if (stateRef) return; // idempotent boot
  stateRef = state;
  buildHost();
  buildSplitter();
  attachSplitterHandlers();

  // Mount on every state change — chat-view re-renders #main when the active
  // agent flips between worker and iris, so the splitter + host nodes need
  // to be re-appended after each remount.
  state.subscribe(() => {
    const s = state.get();
    const id = s.activeId;
    if (id && id !== "iris") {
      ensureMountedInMain();
      currentAgentId = id;
      // Restore per-agent open state.
      const open = isPaneOpenFor(id);
      setPaneOpen(id, open);
    } else {
      // On Iris home, hide everything but keep webviews alive in the Map.
      currentAgentId = null;
      if (hostEl) hostEl.hidden = true;
      if (splitterEl) splitterEl.hidden = true;
    }
    refreshToggleStates(s.activeId);
  });

  // Also reflow if the window resizes past the 70vw cap.
  window.addEventListener("resize", () => {
    if (!hostEl || hostEl.hidden) return;
    const w = clampWidth(hostEl.getBoundingClientRect().width);
    hostEl.style.width = w + "px";
    hostEl.style.flex = `0 0 ${w}px`;
  });
}

/**
 * Create a "Browser" toggle pill for the chat header. Returns an HTMLElement
 * (the button) and tracks it for state syncs. Returns null when the master
 * switch is off or the agent is Iris.
 */
export function getBrowserPaneToggle(agentId) {
  if (!agentId || agentId === "iris") return null;
  if (!isPaneEnabled()) return null;

  const btn = h("button", {
    class: "pill browser-pill",
    type: "button",
    title: "Toggle embedded browser pane",
    "aria-label": "Toggle browser pane",
    "aria-pressed": "false",
    "data-agent-id": agentId,
  },
    h("span", { class: "browser-pill-icon", "aria-hidden": "true" }, svgIcon("focus", 12)),
    h("span", { class: "browser-pill-label" }, "Browser"),
  );

  btn.addEventListener("click", () => {
    if (!isPaneEnabled()) return;
    const open = isPaneOpenFor(agentId);
    setPaneOpen(agentId, !open);
  });

  // Track so refreshToggleStates can keep on/off pressed-state in sync.
  activeToggles.add(btn);

  // Best-effort cleanup when the button leaves the DOM. Chat-view tears
  // down #main on transitions, which orphans the button; we sweep the set
  // every time we refresh so the cleanup is opportunistic.
  const observer = new MutationObserver(() => {
    if (!btn.isConnected) {
      activeToggles.delete(btn);
      observer.disconnect();
    }
  });
  try { observer.observe(document.body, { childList: true, subtree: true }); } catch {}

  // Initial paint of on/off.
  setTimeout(() => refreshToggleStates(stateRef ? stateRef.get().activeId : null), 0);

  return btn;
}

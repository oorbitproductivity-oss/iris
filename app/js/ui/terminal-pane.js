// ═══════════════════════════════════════════════════════════
// terminal-pane.js — v0.5 Feature 3: integrated terminal pane
// ═══════════════════════════════════════════════════════════
//
// A real PTY-backed terminal that mounts at the bottom of the chat
// view, beneath the message list and above the composer. One terminal
// is visible at a time (the active agent's); switching agents flips
// to that agent's terminal without killing the PTY.
//
// Visible chrome:
//   • Header row inside the pane: "Terminal — <cwd>" on the left;
//     "Share last 50 lines" / "New tab" (stubbed for now) / "Close"
//     on the right.
//   • Body: an xterm.js Terminal attached to a real PTY (via
//     iris.terminal.create + onData/onExit + write/resize).
//   • Horizontal drag handle at the top so the user can resize the
//     pane height (persisted to settings.terminalPaneHeight).
//
// Graceful degradation:
//   • If iris.terminal.available() returns false (node-pty failed to
//     load), the pill is hidden and the pane refuses to mount.
//   • If xterm.js isn't vendored yet (fresh checkout that hasn't run
//     postinstall), the pane shows a static "feature unavailable" note
//     instead of crashing.
// ═══════════════════════════════════════════════════════════

import { h, svgIcon, showToast } from "./util.js";
import { loadXterm } from "../lib/load-xterm.js";

const PANE_HOST_ID = "terminal-pane-host";
const SPLITTER_ID = "terminal-pane-splitter";
const DEFAULT_HEIGHT = 280;
const MIN_HEIGHT = 140;
const MAX_HEIGHT_VH = 0.7;

let stateRef = null;
let hostEl = null;
let splitterEl = null;
let headerCwdEl = null;
let xtermSlot = null;
let unavailableEl = null;

// Per-agent state.
// Map<agentId, {
//   terminalId: string | null,
//   term: xterm.Terminal | null,
//   fit: FitAddon | null,
//   container: HTMLElement,
//   ready: boolean,
//   exited: boolean,
//   cwd: string,
//   creating: Promise | null,
// }>
const sessionsByAgent = new Map();
let currentAgentId = null;
let xtermLoaded = null; // memoized { ok, Terminal, FitAddon } | { ok:false, error }
let backendAvailable = null; // tri-state: null=unknown, true/false
let cssInjected = false;
let dataSubscription = null;
let exitSubscription = null;

// Toggle pills we've handed out to chat headers — kept so we can sync
// pressed state on agent switches / settings changes.
const activeToggles = new Set();

// ────────────────────────────────────────────────────────────
// Settings helpers
// ────────────────────────────────────────────────────────────
function getSettings() {
  const s = stateRef ? stateRef.get() : null;
  return (s && s.settings) || {};
}

function isPaneEnabled() {
  return getSettings().terminalEnabled !== false;
}

function getPaneHeight() {
  const h = Number(getSettings().terminalPaneHeight);
  if (!Number.isFinite(h) || h <= 0) return DEFAULT_HEIGHT;
  return clampHeight(h);
}

function clampHeight(h) {
  const max = Math.max(MIN_HEIGHT + 1, Math.floor(window.innerHeight * MAX_HEIGHT_VH));
  return Math.max(MIN_HEIGHT, Math.min(max, Math.floor(h)));
}

let pendingHeightPersist = null;
function persistPaneHeight(height) {
  if (pendingHeightPersist) clearTimeout(pendingHeightPersist);
  pendingHeightPersist = setTimeout(async () => {
    pendingHeightPersist = null;
    try {
      await window.iris.setSettings({ terminalPaneHeight: clampHeight(height) });
    } catch (err) {
      console.warn("[terminal-pane] failed to persist pane height", err);
    }
  }, 200);
}

function getPaneStateFor(agentId) {
  const all = getSettings().terminalPaneStateByAgent || {};
  return all[agentId] || { open: false };
}

function setPaneStateFor(agentId, patch) {
  if (!agentId || agentId === "iris") return;
  const cur = getSettings().terminalPaneStateByAgent || {};
  const next = { ...cur, [agentId]: { ...(cur[agentId] || { open: false }), ...patch } };
  try { window.iris.setSettings({ terminalPaneStateByAgent: next }); }
  catch (err) { console.warn("[terminal-pane] failed to persist open state", err); }
}

function isPaneOpenFor(agentId) {
  if (!agentId || agentId === "iris") return false;
  if (!isPaneEnabled()) return false;
  return !!getPaneStateFor(agentId).open;
}

// ────────────────────────────────────────────────────────────
// CSS injection — the xterm vendor stylesheet lives next to the JS.
// ────────────────────────────────────────────────────────────
function ensureXtermCss() {
  if (cssInjected) return;
  cssInjected = true;
  try {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "js/lib/xterm/xterm.css";
    document.head.append(link);
  } catch (err) {
    console.warn("[terminal-pane] could not inject xterm.css", err);
  }
}

// ────────────────────────────────────────────────────────────
// Per-agent session
// ────────────────────────────────────────────────────────────
function getSessionFor(agentId) {
  let entry = sessionsByAgent.get(agentId);
  if (entry) return entry;
  const container = h("div", { class: "tp-xterm" });
  container.style.display = "none";
  entry = {
    terminalId: null,
    term: null,
    fit: null,
    container,
    ready: false,
    exited: false,
    cwd: "",
    creating: null,
  };
  sessionsByAgent.set(agentId, entry);
  if (xtermSlot) xtermSlot.append(container);
  return entry;
}

async function ensureSession(agentId, agentCwd) {
  const entry = getSessionFor(agentId);
  if (entry.terminalId && entry.term) return entry;
  if (entry.creating) return entry.creating;

  entry.creating = (async () => {
    if (!xtermLoaded) xtermLoaded = await loadXterm();
    if (!xtermLoaded.ok) {
      throw new Error(xtermLoaded.error || "xterm unavailable");
    }
    ensureXtermCss();
    const { Terminal, FitAddon } = xtermLoaded;
    const term = new Terminal({
      cols: 80,
      rows: 24,
      fontFamily: "ui-monospace, Menlo, Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      theme: { background: "#0b0d12", foreground: "#e7e7ea", cursor: "#e7e7ea" },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(entry.container);
    try { fit.fit(); } catch {}
    entry.term = term;
    entry.fit = fit;

    const r = await window.iris.terminal.create({
      agentId,
      cwd: agentCwd || undefined,
      cols: term.cols,
      rows: term.rows,
    });
    if (!r || !r.ok) {
      throw new Error((r && r.error) || "terminal create failed");
    }
    entry.terminalId = r.terminalId;
    entry.cwd = r.cwd || "";
    entry.ready = true;

    // User input -> PTY.
    term.onData((input) => {
      if (!entry.terminalId || entry.exited) return;
      try { window.iris.terminal.write(entry.terminalId, input); } catch {}
    });

    // User-driven resize from xterm (e.g. fit on container resize).
    term.onResize(({ cols, rows }) => {
      if (!entry.terminalId || entry.exited) return;
      try { window.iris.terminal.resize(entry.terminalId, cols, rows); } catch {}
    });

    // Update the header cwd label if this is the active session.
    if (agentId === currentAgentId && headerCwdEl) {
      headerCwdEl.textContent = entry.cwd || "—";
    }
    return entry;
  })();

  try {
    return await entry.creating;
  } finally {
    entry.creating = null;
  }
}

function destroySession(agentId) {
  const entry = sessionsByAgent.get(agentId);
  if (!entry) return;
  try { if (entry.terminalId) window.iris.terminal.kill(entry.terminalId); } catch {}
  try { if (entry.term) entry.term.dispose(); } catch {}
  try { entry.container.remove(); } catch {}
  sessionsByAgent.delete(agentId);
}

function showSessionFor(agentId) {
  for (const [id, entry] of sessionsByAgent) {
    entry.container.style.display = id === agentId ? "block" : "none";
  }
  const entry = sessionsByAgent.get(agentId);
  if (entry && entry.term && entry.fit) {
    // Re-fit on swap so we pick up any layout changes that happened while
    // this session was hidden.
    requestAnimationFrame(() => {
      try { entry.fit.fit(); } catch {}
    });
  }
  if (entry && headerCwdEl) headerCwdEl.textContent = entry.cwd || "—";
}

// ────────────────────────────────────────────────────────────
// Pane open/close
// ────────────────────────────────────────────────────────────
async function openPaneFor(agentId, agentCwd) {
  if (!agentId || agentId === "iris") return;
  if (backendAvailable === null) {
    try { backendAvailable = !!(await window.iris.terminal.available()); }
    catch { backendAvailable = false; }
  }
  if (!backendAvailable) {
    paintUnavailable(
      "Terminal feature unavailable — node-pty isn't built for this Electron. Run `npx electron-rebuild -f -w node-pty` and restart."
    );
    showHostShell(true);
    setPaneStateFor(agentId, { open: true });
    refreshToggleStates(agentId);
    return;
  }
  showHostShell(true);
  setPaneStateFor(agentId, { open: true });
  try {
    await ensureSession(agentId, agentCwd);
    showSessionFor(agentId);
    paintUnavailable(null);
  } catch (err) {
    console.error("[terminal-pane] failed to start terminal", err);
    paintUnavailable("Couldn't start terminal: " + (err.message || err));
  }
  refreshToggleStates(agentId);
}

function closePane(agentId) {
  if (!agentId || agentId === "iris") return;
  showHostShell(false);
  setPaneStateFor(agentId, { open: false });
  refreshToggleStates(agentId);
}

function showHostShell(visible) {
  if (!hostEl || !splitterEl) return;
  hostEl.hidden = !visible;
  splitterEl.hidden = !visible;
}

function paintUnavailable(msg) {
  if (!unavailableEl) return;
  if (!msg) {
    unavailableEl.hidden = true;
    unavailableEl.textContent = "";
    if (xtermSlot) xtermSlot.hidden = false;
  } else {
    unavailableEl.hidden = false;
    unavailableEl.textContent = msg;
    if (xtermSlot) xtermSlot.hidden = true;
  }
}

// ────────────────────────────────────────────────────────────
// "Share last 50 lines" — drop a fenced code block into the composer.
// ────────────────────────────────────────────────────────────
async function shareLastLines() {
  if (!currentAgentId) return;
  const entry = sessionsByAgent.get(currentAgentId);
  if (!entry || !entry.terminalId) {
    showToast("No terminal output yet", { error: true });
    return;
  }
  let lines = [];
  try {
    const r = await window.iris.terminal.history(entry.terminalId, 50);
    if (r && r.ok) lines = r.lines || [];
    else throw new Error((r && r.error) || "history failed");
  } catch (err) {
    showToast("Couldn't read history: " + (err.message || err), { error: true });
    return;
  }
  if (lines.length === 0) {
    showToast("Terminal buffer is empty");
    return;
  }
  const ta = document.querySelector(".chat-view .composer textarea");
  if (!ta) {
    showToast("Couldn't find the chat input", { error: true });
    return;
  }
  // Strip the most common ANSI / CSI / OSC noise so the agent sees readable
  // text. This is best-effort — pathological escape sequences may leak
  // through; that's fine, the agent can interpret them.
  const cleaned = lines.map(stripAnsi).join("\n");
  const fence = "```";
  const block = `Here's the last ${lines.length} lines from my terminal:\n${fence}\n${cleaned}\n${fence}`;
  const cur = ta.value || "";
  ta.value = cur ? `${cur}\n\n${block}` : block;
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.focus();
  showToast(`Attached ${lines.length} lines to the chat input`);
}

// Minimal ANSI escape stripper. Covers CSI (ESC [ … letter), OSC (ESC ]
// … BEL or ESC \), and lone ESC sequences. Doesn't try to be a full
// terminal emulator — just enough to make `ls`/`git status` output
// readable in a markdown code block.
function stripAnsi(line) {
  if (!line) return "";
  return String(line)
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")           // OSC
    .replace(/\x1B\[[0-9;?]*[A-Za-z]/g, "")                  // CSI
    .replace(/\x1B[@-_]/g, "");                               // other ESC
}

// ────────────────────────────────────────────────────────────
// Splitter (drag handle on top of the pane to resize height)
// ────────────────────────────────────────────────────────────
function attachSplitterHandlers() {
  let dragging = false;
  let startY = 0;
  let startH = 0;

  splitterEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startY = e.clientY;
    startH = hostEl.getBoundingClientRect().height;
    splitterEl.setPointerCapture(e.pointerId);
    splitterEl.classList.add("dragging");
    document.body.style.cursor = "row-resize";
    e.preventDefault();
  });

  splitterEl.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    // Pane sits BELOW the splitter, so dragging UP grows it.
    const delta = startY - e.clientY;
    const next = clampHeight(startH + delta);
    hostEl.style.height = next + "px";
    hostEl.style.flex = `0 0 ${next}px`;
    // Re-fit the visible terminal so it tracks the new size live.
    const entry = sessionsByAgent.get(currentAgentId);
    if (entry && entry.fit) {
      try { entry.fit.fit(); } catch {}
    }
  });

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    try { splitterEl.releasePointerCapture(e.pointerId); } catch {}
    splitterEl.classList.remove("dragging");
    document.body.style.cursor = "";
    persistPaneHeight(hostEl.getBoundingClientRect().height);
  };
  splitterEl.addEventListener("pointerup", endDrag);
  splitterEl.addEventListener("pointercancel", endDrag);
}

// ────────────────────────────────────────────────────────────
// Build pane DOM
// ────────────────────────────────────────────────────────────
function buildHost() {
  hostEl = h("div", { class: "terminal-pane-host", id: PANE_HOST_ID, hidden: true });

  const header = h("div", { class: "tp-header" });
  const titleWrap = h("div", { class: "tp-title" });
  const titleLabel = h("span", { class: "tp-title-label" }, "Terminal");
  const titleSep = h("span", { class: "tp-title-sep" }, "—");
  headerCwdEl = h("span", { class: "tp-title-cwd" }, "—");
  titleWrap.append(titleLabel, titleSep, headerCwdEl);

  const actions = h("div", { class: "tp-actions" });
  const newTabBtn = h("button", { class: "tp-btn", type: "button", title: "New tab (coming soon)" },
    svgIcon("plus", 12), h("span", null, "New tab"));
  newTabBtn.disabled = true;
  const shareBtn = h("button", { class: "tp-btn tp-btn-primary", type: "button", title: "Append the last 50 lines to the chat input" },
    svgIcon("arrowRight", 12), h("span", null, "Share last 50 lines"));
  const closeBtn = h("button", { class: "tp-btn", type: "button", title: "Close terminal pane" },
    svgIcon("x", 12), h("span", null, "Close"));
  actions.append(newTabBtn, shareBtn, closeBtn);

  header.append(titleWrap, actions);

  xtermSlot = h("div", { class: "tp-xterm-slot" });
  unavailableEl = h("div", { class: "tp-unavailable", hidden: true });

  hostEl.append(header, unavailableEl, xtermSlot);

  shareBtn.addEventListener("click", () => { shareLastLines(); });
  closeBtn.addEventListener("click", () => {
    if (currentAgentId) closePane(currentAgentId);
  });
}

function buildSplitter() {
  splitterEl = h("div", {
    class: "terminal-pane-splitter",
    id: SPLITTER_ID,
    role: "separator",
    "aria-orientation": "horizontal",
    hidden: true,
  });
}

// Pane mounts INSIDE the chat-view, between .chat-scroll and .composer-wrap.
// Chat-view tears its DOM down on every router transition, so we re-mount on
// every state change.
function ensureMountedInChatView() {
  const chat = document.querySelector(".chat-view");
  if (!chat) return false;
  const composerWrap = chat.querySelector(".composer-wrap");
  if (!composerWrap) return false;
  if (!chat.contains(splitterEl)) chat.insertBefore(splitterEl, composerWrap);
  if (!chat.contains(hostEl)) chat.insertBefore(hostEl, composerWrap);
  // Re-parent xterm containers into the (possibly new) slot.
  for (const entry of sessionsByAgent.values()) {
    if (entry.container.parentNode !== xtermSlot) {
      xtermSlot.append(entry.container);
    }
  }
  return true;
}

// ────────────────────────────────────────────────────────────
// Toggle pill (chat header)
// ────────────────────────────────────────────────────────────
function refreshToggleStates(activeId) {
  for (const btn of activeToggles) {
    const id = btn.dataset.agentId;
    if (!isPaneEnabled() || id === "iris") {
      btn.hidden = true;
      continue;
    }
    if (backendAvailable === false) {
      // Keep the pill visible but flag it so the user can click and see
      // the inline "feature unavailable" message — silent disappearance
      // is more confusing than an honest error.
      btn.hidden = false;
      btn.classList.add("disabled");
      btn.title = "Terminal unavailable — run `npx electron-rebuild -f -w node-pty`";
    } else {
      btn.classList.remove("disabled");
      btn.title = "Toggle integrated terminal";
    }
    btn.hidden = false;
    const on = id === activeId && isPaneOpenFor(id);
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
}

// ────────────────────────────────────────────────────────────
// PTY events -> xterm
// ────────────────────────────────────────────────────────────
function wireGlobalSubscriptions() {
  if (dataSubscription || !window.iris || !window.iris.terminal) return;
  dataSubscription = window.iris.terminal.onData(({ terminalId, data }) => {
    for (const entry of sessionsByAgent.values()) {
      if (entry.terminalId === terminalId && entry.term) {
        try { entry.term.write(data); } catch {}
        return;
      }
    }
  });
  exitSubscription = window.iris.terminal.onExit(({ terminalId, code, signal }) => {
    for (const entry of sessionsByAgent.values()) {
      if (entry.terminalId === terminalId) {
        entry.exited = true;
        if (entry.term) {
          const tag = signal ? `signal ${signal}` : `exit ${code}`;
          try { entry.term.write(`\r\n[2m[process exited — ${tag}][0m\r\n`); } catch {}
        }
        return;
      }
    }
  });
}

// ────────────────────────────────────────────────────────────
// Public exports
// ────────────────────────────────────────────────────────────
export function initTerminalPane(state) {
  if (stateRef) return; // idempotent
  stateRef = state;
  buildHost();
  buildSplitter();
  attachSplitterHandlers();
  wireGlobalSubscriptions();

  // Probe backend availability eagerly so the toggle pill renders with
  // the right disabled state on first paint.
  (async () => {
    try { backendAvailable = !!(await window.iris.terminal.available()); }
    catch { backendAvailable = false; }
    refreshToggleStates(state.get().activeId);
  })();

  state.subscribe(() => {
    const s = state.get();
    const id = s.activeId;
    if (id && id !== "iris") {
      currentAgentId = id;
      const ok = ensureMountedInChatView();
      if (ok) {
        const agent = (s.agents || []).find((a) => a.id === id);
        const wantsOpen = isPaneOpenFor(id);
        if (wantsOpen) {
          // Re-open on remount (chat-view tore down the DOM).
          openPaneFor(id, agent && agent.cwd);
        } else {
          showHostShell(false);
        }
        // Make the corresponding session visible even when the pane stays
        // hidden — so a quick switch back doesn't re-fit-flash.
        showSessionFor(id);
        // Apply persisted height.
        const ht = getPaneHeight();
        hostEl.style.height = ht + "px";
        hostEl.style.flex = `0 0 ${ht}px`;
      }
    } else {
      currentAgentId = null;
      showHostShell(false);
    }
    refreshToggleStates(s.activeId);
  });

  window.addEventListener("resize", () => {
    if (!hostEl || hostEl.hidden) return;
    const ht = clampHeight(hostEl.getBoundingClientRect().height);
    hostEl.style.height = ht + "px";
    hostEl.style.flex = `0 0 ${ht}px`;
    const entry = sessionsByAgent.get(currentAgentId);
    if (entry && entry.fit) {
      try { entry.fit.fit(); } catch {}
    }
  });
}

/**
 * Returns a chat-header pill that toggles the terminal pane for `agentId`.
 * Returns null when the master switch is off or the agent is Iris.
 */
export function getTerminalPaneToggle(agentId) {
  if (!agentId || agentId === "iris") return null;
  if (!isPaneEnabled()) return null;

  const btn = h("button", {
    class: "pill terminal-pill",
    type: "button",
    title: "Toggle integrated terminal",
    "aria-label": "Toggle integrated terminal",
    "aria-pressed": "false",
    "data-agent-id": agentId,
  },
    h("span", { class: "terminal-pill-icon", "aria-hidden": "true" }, svgIcon("send", 12)),
    h("span", { class: "terminal-pill-label" }, "Terminal"),
  );

  btn.addEventListener("click", async () => {
    if (!isPaneEnabled()) return;
    const s = stateRef ? stateRef.get() : null;
    const agent = (s && s.agents || []).find((a) => a.id === agentId);
    const open = isPaneOpenFor(agentId);
    if (open) closePane(agentId);
    else await openPaneFor(agentId, agent && agent.cwd);
  });

  activeToggles.add(btn);

  // Sweep stale buttons from the registry when chat-view tears down #main.
  const observer = new MutationObserver(() => {
    if (!btn.isConnected) {
      activeToggles.delete(btn);
      observer.disconnect();
    }
  });
  try { observer.observe(document.body, { childList: true, subtree: true }); } catch {}

  setTimeout(() => refreshToggleStates(stateRef ? stateRef.get().activeId : null), 0);
  return btn;
}

// Test hook — exposed only for unit tests / debugging. NOT part of the
// stable preload API. Lets a test stub the xterm loader.
export const __test = {
  _resetForTesting() {
    for (const id of sessionsByAgent.keys()) destroySession(id);
    sessionsByAgent.clear();
    activeToggles.clear();
    xtermLoaded = null;
    backendAvailable = null;
    cssInjected = false;
    stateRef = null;
    hostEl = splitterEl = headerCwdEl = xtermSlot = unavailableEl = null;
    currentAgentId = null;
  },
  stripAnsi,
};

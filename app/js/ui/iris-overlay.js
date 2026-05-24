// iris-overlay.js -- Embedded Iris chat panel inside the main window.
//
// Lives in index.html as #iris-overlay (hidden by default). Toggled by the
// sidebar "Open Iris" CTA, the home view CTA, the global hotkey (forwarded
// from main process via window.iris.onIrisToggle), or programmatically.

import { renderMarkdown, extractActions } from "../lib/markdown.js";
import { mountActivityLog } from "./activity-log.js";
import { createRotator, shortElapsed } from "../lib/verbs.js";

const $ = (id) => document.getElementById(id);

const overlay     = $("iris-overlay");
const backdrop    = $("iro-backdrop");
const closeBtn    = $("iro-close");
const thread      = $("iro-thread");
const threadInner = $("iro-thread-inner");
const welcome     = $("iro-welcome");
const input       = $("iro-input");
const sendBtn     = $("iro-send");
const statusEl    = $("iro-status");

const messages = [];
let draft = null;
let isSending = false;
let initialized = false;
let isOpen = false;
let unsubscribeEvents = null;
let streamStartedAt = null;
let firstDeltaAt = null;
let irisRotator = null;
let irisTimerHandle = null;

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") el.className = v;
      else if (k === "html") el.innerHTML = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v);
    }
  }
  for (const c of children) {
    if (c == null) continue;
    if (typeof c === "string") el.append(document.createTextNode(c));
    else el.append(c);
  }
  return el;
}

function scrollToBottom() {
  requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; });
}

function renderMessage(m) {
  const role = m.role || "system";
  const wrap = h("div", { class: `iro-msg ${role}` });
  const bubble = h("div", { class: "iro-bubble" });
  if (role === "assistant") {
    const { cleanedText, actions } = extractActions(m.text || "");
    bubble.append(h("div", { class: "iro-author" }, "Iris"));
    const md = h("div", { class: "iro-md" });
    md.innerHTML = renderMarkdown(cleanedText);
    bubble.append(md);
    if (actions && actions.length) {
      const row = h("div", { class: "iro-actions-row" });
      for (const { action } of actions) row.append(renderActionChip(action));
      bubble.append(row);
    }
  } else {
    bubble.textContent = m.text || "";
  }
  wrap.append(bubble);
  return wrap;
}

function renderToolMini(t) {
  const wrap = h("div", { class: `iro-tool ${t.status || "started"}` });
  const dot = h("span", { class: "iro-tool-dot" });
  const name = h("span", { class: "iro-tool-name" }, t.name || "tool");
  const inp = h("span", { class: "iro-tool-input" }, toolInputSnippet(t.input));
  wrap.append(dot, name, inp);
  return wrap;
}

function toolInputSnippet(input) {
  if (input == null) return "";
  if (typeof input === "string") return input;
  try {
    const s = JSON.stringify(input);
    return s.length > 120 ? s.slice(0, 119) + "…" : s;
  } catch {
    return String(input);
  }
}

function renderDraft() {
  if (!draft) return null;
  const wrap = h("div", { class: "iro-msg assistant iro-draft" });
  const bubble = h("div", { class: "iro-bubble" });
  bubble.append(h("div", { class: "iro-author" }, "Iris"));
  const md = h("div", { class: "iro-md" });
  if (draft.text) {
    const { cleanedText } = extractActions(draft.text);
    md.innerHTML = renderMarkdown(cleanedText || "");
  } else if (!draft.tools || draft.tools.length === 0) {
    md.innerHTML = "<p style='color: var(--text-3); font-style: italic;'>Thinking...</p>";
  }
  bubble.append(md);
  if (draft.tools && draft.tools.length) {
    const tools = h("div", { class: "iro-tools" });
    for (const t of draft.tools) tools.append(renderToolMini(t));
    bubble.append(tools);
  }
  bubble.append(h("span", { class: "iro-cursor" }));
  wrap.append(bubble);
  return wrap;
}

function renderActionChip(action) {
  const chip = h("button", { class: "iro-chip", type: "button" });
  chip.append(h("span", null, "▶"));
  let label = "Run action";
  let detail = "";
  switch (action.type) {
    case "create_agent":  label = action.auto ? "Create & start" : "Create agent"; detail = action.name || ""; break;
    case "send_to_agent": label = `Send to ${action.id || "agent"}`; detail = (action.message || "").slice(0, 40); break;
    case "stop_agent":    label = `Stop ${action.id || "agent"}`; break;
    case "focus_agent":   label = `Focus ${action.id || "agent"}`; break;
    case "open_url":      label = `Open ${action.label || "link"}`; detail = action.url || ""; break;
    case "open_path":     label = `Open ${action.label || "file"}`; detail = action.path || ""; break;
    default:              label = action.type || "action";
  }
  chip.append(h("span", null, label));
  if (detail) chip.append(h("span", { class: "iro-chip-detail" }, `"${detail}"`));

  chip.addEventListener("click", async () => {
    try {
      switch (action.type) {
        case "open_url":  if (action.url)  await window.iris?.openExternal?.(action.url); break;
        case "open_path": if (action.path) await window.iris?.openPath?.(action.path); break;
        case "create_agent":
          hideOverlay();
          if (action.auto) {
            // Iris-blessed full setup: create immediately with sensible defaults
            // and drop the user straight into the new agent's chat. The main
            // window listens via "iris:create-agent-auto" and handles the rest.
            window.dispatchEvent(new CustomEvent("iris:create-agent-auto", { detail: {
              name: action.name,
              cwd: action.cwd,
              prompt: action.prompt,
              model: action.model,
            }}));
          } else {
            window.dispatchEvent(new CustomEvent("iris:create-agent", { detail: {
              name: action.name,
              cwd: action.cwd,
              prompt: action.prompt,
              model: action.model,
            }}));
          }
          break;
        case "send_to_agent":
          if (action.id && action.message) window.iris?.sendToAgent?.(action.id, action.message);
          break;
        case "stop_agent":
          if (action.id) window.iris?.stopAgent?.(action.id);
          break;
        case "focus_agent":
          // Hand off to main UI
          hideOverlay();
          window.dispatchEvent(new CustomEvent("iris:select-agent", { detail: action.id }));
          break;
      }
      chip.disabled = true;
      chip.style.opacity = "0.5";
    } catch (e) {
      console.error("[iris-overlay] action failed", e);
    }
  });
  return chip;
}

let activityHost = null;
let activityHandle = null;

function ensureActivityMounted() {
  if (activityHost) return;
  activityHost = document.createElement("div");
  activityHost.className = "iro-activity-host";
  if (welcome && welcome.appendChild) welcome.appendChild(activityHost);
  activityHandle = mountActivityLog(activityHost);
}

function renderAll() {
  threadInner.innerHTML = "";
  if (messages.length === 0 && !draft) {
    threadInner.append(welcome);
    ensureActivityMounted();
    return;
  }
  for (const m of messages) threadInner.append(renderMessage(m));
  if (draft) threadInner.append(renderDraft());
  scrollToBottom();
}

function updateDraft() {
  let el = threadInner.querySelector(".iro-draft");
  if (!el) {
    el = renderDraft();
    if (el) threadInner.append(el);
    scrollToBottom();
    return;
  }
  if (!draft) return;
  const bubble = el.querySelector(".iro-bubble");
  const md = el.querySelector(".iro-md");
  if (draft.text) {
    const { cleanedText } = extractActions(draft.text);
    md.innerHTML = renderMarkdown(cleanedText || "");
  } else if (!draft.tools || draft.tools.length === 0) {
    md.innerHTML = "<p style='color: var(--text-3); font-style: italic;'>Thinking...</p>";
  } else {
    md.innerHTML = "";
  }
  // Rebuild tool strip in place so input/status updates appear live.
  let toolsHost = bubble.querySelector(".iro-tools");
  if (draft.tools && draft.tools.length) {
    if (!toolsHost) {
      toolsHost = h("div", { class: "iro-tools" });
      // Insert before the trailing cursor.
      const cursor = bubble.querySelector(".iro-cursor");
      if (cursor) bubble.insertBefore(toolsHost, cursor);
      else bubble.append(toolsHost);
    }
    toolsHost.innerHTML = "";
    for (const t of draft.tools) toolsHost.append(renderToolMini(t));
  } else if (toolsHost) {
    toolsHost.remove();
  }
  scrollToBottom();
}

function showError(msg) {
  const banner = h("div", { class: "iro-error" }, "Error: " + msg);
  threadInner.append(banner);
}

function startIrisStatus() {
  streamStartedAt = Date.now();
  firstDeltaAt = null;
  if (!irisRotator) {
    irisRotator = createRotator({
      intervalMs: 2500,
      onTick: (word) => paintIrisStatus(word),
    });
  }
  irisRotator.start("thinking");
  if (!irisTimerHandle) irisTimerHandle = setInterval(() => paintIrisStatus(), 1000);
}

function stopIrisStatus() {
  streamStartedAt = null;
  firstDeltaAt = null;
  if (irisRotator) irisRotator.stop();
  if (irisTimerHandle) { clearInterval(irisTimerHandle); irisTimerHandle = null; }
  if (statusEl) statusEl.textContent = "Orchestrator";
}

let _irisVerb = "Thinking";
function paintIrisStatus(word) {
  if (word) _irisVerb = word;
  if (!streamStartedAt) return;
  const elapsed = shortElapsed(Date.now() - streamStartedAt);
  statusEl.textContent = `${_irisVerb}… · ${elapsed}`;
}

function onEvent(e) {
  if (!e || e.id !== "iris") return;
  switch (e.type) {
    case "user": {
      const last = messages[messages.length - 1];
      if (last && last.role === "user" && last.text === e.text && Date.now() - last.ts < 5000) break;
      messages.push({ role: "user", text: e.text, ts: Date.now() });
      draft = null;
      renderAll();
      startIrisStatus();
      break;
    }
    case "delta":
      if (!draft) draft = { text: "", tools: [] };
      draft.text += e.text || "";
      if (!firstDeltaAt) {
        firstDeltaAt = Date.now();
        if (irisRotator) irisRotator.setMode("doing");
      }
      updateDraft();
      break;
    case "tool":
      if (!draft) draft = { text: "", tools: [] };
      draft.tools.push({
        useId: e.useId,
        name: e.tool,
        input: e.input,
        status: "started",
      });
      updateDraft();
      break;
    case "tool_input":
      if (draft && draft.tools) {
        for (let i = draft.tools.length - 1; i >= 0; i--) {
          if (draft.tools[i].useId === e.useId) {
            draft.tools[i] = { ...draft.tools[i], input: e.input };
            break;
          }
        }
        updateDraft();
      }
      break;
    case "tool_result":
      if (draft && draft.tools) {
        for (let i = draft.tools.length - 1; i >= 0; i--) {
          if (draft.tools[i].useId === e.useId) {
            draft.tools[i] = {
              ...draft.tools[i],
              status: e.ok ? "done" : "error",
              result: e.result,
            };
            break;
          }
        }
        updateDraft();
      }
      break;
    case "result":
      messages.push({
        role: "assistant",
        text: (draft && draft.text) || e.text || "",
        ts: Date.now(),
        tools: draft ? draft.tools : [],
      });
      draft = null;
      setSendingUI(false);
      stopIrisStatus();
      renderAll();
      break;
    case "error":
      showError(e.message || "Something went wrong.");
      draft = null;
      setSendingUI(false);
      stopIrisStatus();
      renderAll();
      break;
    case "done":
      if (draft) {
        messages.push({
          role: "assistant",
          text: draft.text || "",
          ts: Date.now(),
          tools: draft.tools,
        });
        draft = null;
        renderAll();
      }
      setSendingUI(false);
      stopIrisStatus();
      break;
  }
}

function setSendingUI(sending) {
  isSending = sending;
  if (sending) {
    sendBtn.classList.add("is-stopping");
    sendBtn.disabled = false;
    sendBtn.title = "Stop Iris";
    sendBtn.setAttribute("aria-label", "Stop");
  } else {
    sendBtn.classList.remove("is-stopping");
    sendBtn.disabled = !input.value.trim();
    sendBtn.title = "Send (Enter)";
    sendBtn.setAttribute("aria-label", "Send");
  }
}

function stopIris() {
  try {
    window.iris?.stopAgent?.("iris");
  } catch (e) {
    console.error("[iris-overlay] stopAgent failed", e);
  }
  // Optimistically reset the composer; the eventual "done" event will
  // confirm. If draft has any partial text, persist it so the user can
  // see what Iris said before being interrupted.
  if (draft && (draft.text || (draft.tools && draft.tools.length))) {
    messages.push({
      role: "assistant",
      text: (draft.text || "") + (draft.text ? "\n\n_(stopped)_" : "_(stopped)_"),
      ts: Date.now(),
      tools: draft.tools || [],
    });
  }
  draft = null;
  setSendingUI(false);
  stopIrisStatus();
  renderAll();
}

function send() {
  const text = input.value.trim();
  if (!text || isSending) return;
  setSendingUI(true);
  startIrisStatus();
  messages.push({ role: "user", text, ts: Date.now() });
  draft = { text: "", tools: [] };
  renderAll();
  input.value = "";
  autoResize();
  try {
    window.iris?.sendToIris?.(text);
  } catch (e) {
    console.error("[iris-overlay] sendToIris failed", e);
    showError("Could not send message.");
    setSendingUI(false);
    stopIrisStatus();
  }
}

function autoResize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
}

export function showOverlay() {
  ensureInit();
  if (isOpen) return;
  overlay.hidden = false;
  isOpen = true;
  // Defer focus until layout settles
  requestAnimationFrame(() => {
    input.focus();
    scrollToBottom();
  });
}

export function hideOverlay() {
  if (!isOpen) return;
  overlay.hidden = true;
  isOpen = false;
}

export function toggleOverlay() {
  if (isOpen) hideOverlay();
  else showOverlay();
}

function ensureInit() {
  if (initialized) return;
  initialized = true;

  // Composer wiring
  input.addEventListener("input", () => {
    autoResize();
    // While streaming, the button is the Stop button — stay enabled regardless.
    if (isSending) sendBtn.disabled = false;
    else sendBtn.disabled = !input.value.trim();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); return; }
    if (e.key === "Escape")               { e.preventDefault(); hideOverlay(); }
  });
  sendBtn.addEventListener("click", () => {
    if (isSending) stopIris();
    else send();
  });
  sendBtn.disabled = true;

  // Header X + backdrop click
  closeBtn.addEventListener("click", hideOverlay);
  backdrop.addEventListener("click", hideOverlay);

  // Suggestion pills
  for (const pill of overlay.querySelectorAll(".iro-pill")) {
    pill.addEventListener("click", () => {
      const q = pill.getAttribute("data-q") || pill.textContent;
      input.value = q;
      send();
    });
  }

  // Global Escape (when overlay open)
  window.addEventListener("keydown", (e) => {
    if (isOpen && e.key === "Escape") hideOverlay();
  });

  // Subscribe to Iris event stream
  if (window.iris?.onAgentEvent) {
    unsubscribeEvents = window.iris.onAgentEvent(onEvent);
  }

  // Load existing iris message history
  (async () => {
    try {
      const full = await window.iris?.getAgent?.("iris");
      if (full && Array.isArray(full.messages) && full.messages.length > 0) {
        for (const m of full.messages) messages.push(m);
        renderAll();
      }
    } catch (e) {
      console.warn("[iris-overlay] could not load iris history:", e);
    }
  })();
}

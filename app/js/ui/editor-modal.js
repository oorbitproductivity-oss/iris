// app/js/ui/editor-modal.js
//
// A minimalist in-app code editor. Loads any file by absolute path, lets the
// user hand-edit it, and on save:
//   1. Writes the new content back to disk via the file:write IPC.
//   2. Sends a system-style message to Iris explaining what the user changed,
//      so the orchestrator agent can reason about it without re-reading.
//
// The right rail hosts a tiny "assistant" — a chat scoped to the file in view.
// Each message the user sends to the assistant goes to Iris with the file path
// + current content prepended, so the answer is grounded in what's on screen.

import { h, openModal, showToast } from "./util.js";

export async function openEditorModal(filepath) {
  if (!filepath) {
    showToast("No file path provided", { error: true });
    return;
  }
  if (!window.iris || typeof window.iris.fileRead !== "function") {
    showToast("Editor unavailable in this build", { error: true });
    return;
  }

  // Build the shell first so the user sees something immediately while we
  // load the file — feels faster than a blocking spinner.
  const root = h("div", { class: "modal editor-modal" });

  // Header: filename, save state, action buttons
  const header = h("div", { class: "editor-header" });
  const pathBlock = h("div", { class: "editor-path-block" });
  pathBlock.append(
    h("div", { class: "editor-filename" }, basenameOf(filepath)),
    h("div", { class: "editor-path", title: filepath }, filepath),
  );
  const dirtyDot = h("span", { class: "editor-dirty-dot", "aria-hidden": "true", hidden: true });
  pathBlock.append(dirtyDot);

  const headerActions = h("div", { class: "editor-header-actions" });
  const saveBtn = h("button", { class: "btn btn-primary", type: "button" }, "Save");
  saveBtn.disabled = true;
  const closeBtn = h("button", { class: "editor-close-btn", type: "button", "aria-label": "Close editor", title: "Close (Esc)" });
  closeBtn.innerHTML = `<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3.5 3.5 L10.5 10.5 M10.5 3.5 L3.5 10.5"/></svg>`;
  headerActions.append(saveBtn, closeBtn);
  header.append(pathBlock, headerActions);

  // Body: two-pane split (editor + assistant rail)
  const body = h("div", { class: "editor-body" });

  // ── Left pane: editor with gutter line numbers ─────────────
  const editorPane = h("div", { class: "editor-pane" });
  const gutter = h("div", { class: "editor-gutter" });
  const textarea = h("textarea", {
    class: "editor-textarea",
    spellcheck: "false",
    autocorrect: "off",
    autocapitalize: "off",
    placeholder: "Loading…",
  });
  textarea.disabled = true;
  editorPane.append(gutter, textarea);

  // ── Right pane: assistant rail ─────────────────────────────
  const rail = h("div", { class: "editor-rail" });
  const railHead = h("div", { class: "editor-rail-head" });
  railHead.append(
    h("div", { class: "editor-rail-title" }, "Ask the assistant"),
    h("div", { class: "editor-rail-sub" }, "Scoped to this file. Press Enter to send."),
  );
  const railThread = h("div", { class: "editor-rail-thread" });
  const railWelcome = h("div", { class: "editor-rail-welcome" },
    h("p", null, "I'll answer with the current contents of this file in view."),
    h("p", { class: "editor-rail-hint" }, "Try: “What's happening here?”, “What does this function do?”, “Is there a bug in lines 40–60?”"),
  );
  railThread.append(railWelcome);

  const railComposer = h("div", { class: "editor-rail-composer" });
  const railInput = h("textarea", {
    class: "editor-rail-input",
    placeholder: "What's happening here?",
    rows: 2,
  });
  const railSend = h("button", { class: "editor-rail-send", type: "button", "aria-label": "Send" });
  railSend.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8 L14 2 L9 14 L7.5 9 Z"/></svg>`;
  railComposer.append(railInput, railSend);
  rail.append(railHead, railThread, railComposer);

  body.append(editorPane, rail);
  root.append(header, body);

  const { close } = openModal(root, {
    onClose: () => { try { unsubscribe(); } catch {} },
  });

  // ── State ──────────────────────────────────────────────────
  let originalContent = "";
  let dirty = false;

  function refreshGutter() {
    const lines = textarea.value.split("\n").length;
    let html = "";
    for (let i = 1; i <= lines; i++) html += `<div>${i}</div>`;
    gutter.innerHTML = html;
  }

  function setDirty(d) {
    dirty = d;
    dirtyDot.hidden = !d;
    saveBtn.disabled = !d;
  }

  textarea.addEventListener("input", () => {
    setDirty(textarea.value !== originalContent);
    refreshGutter();
  });
  textarea.addEventListener("scroll", () => {
    gutter.scrollTop = textarea.scrollTop;
  });

  // Tab key inserts spaces instead of leaving the textarea.
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const v = textarea.value;
      textarea.value = v.slice(0, start) + "  " + v.slice(end);
      textarea.selectionStart = textarea.selectionEnd = start + 2;
      setDirty(textarea.value !== originalContent);
      refreshGutter();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
    }
  });

  closeBtn.addEventListener("click", () => {
    if (dirty && !confirm("You have unsaved changes. Discard?")) return;
    close();
  });

  saveBtn.addEventListener("click", save);

  async function save() {
    if (!dirty) return;
    saveBtn.disabled = true;
    try {
      const res = await window.iris.fileWrite(filepath, textarea.value);
      if (!res || !res.ok) {
        showToast("Save failed: " + (res && res.error || "unknown"), { error: true });
        saveBtn.disabled = false;
        return;
      }
      const diffSummary = summarizeDiff(originalContent, textarea.value);
      originalContent = textarea.value;
      setDirty(false);

      // Tell Iris what just happened so the orchestrator's mental model stays
      // consistent with the actual file contents. Fire-and-forget — the user
      // shouldn't have to wait for a response, and Iris's reply will land in
      // her own thread (visible if the user opens the overlay).
      try {
        const message = [
          `I just manually edited \`${filepath}\` in Iris Code's inline editor.`,
          "",
          "Summary of my change:",
          diffSummary || "(no diff available)",
          "",
          "Please update your understanding of this file. No action needed unless you spot something I should know.",
        ].join("\n");
        window.iris.sendToIris(message);
      } catch (err) {
        console.warn("[editor-modal] failed to notify Iris:", err);
      }
      showToast("Saved");
    } catch (err) {
      showToast("Save failed: " + (err.message || err), { error: true });
      saveBtn.disabled = false;
    }
  }

  // ── Assistant rail behavior ────────────────────────────────
  let askInFlight = false;
  function appendRailMessage(role, text) {
    if (railWelcome.parentNode) railWelcome.remove();
    const node = h("div", { class: `editor-rail-msg ${role}` });
    node.append(
      h("div", { class: "editor-rail-msg-role" }, role === "user" ? "You" : "Iris"),
      h("div", { class: "editor-rail-msg-text" }, text),
    );
    railThread.append(node);
    railThread.scrollTop = railThread.scrollHeight;
    return node;
  }

  async function ask() {
    const q = railInput.value.trim();
    if (!q || askInFlight) return;
    askInFlight = true;
    appendRailMessage("user", q);
    railInput.value = "";
    autoSizeRail();

    const acknowledgement = appendRailMessage("assistant",
      "Sent to Iris — open the Iris overlay (Ctrl+K) to follow the answer.",
    );
    acknowledgement.classList.add("editor-rail-msg-ack");

    // Compose a tightly-scoped prompt with the live file contents.
    const content = textarea.value;
    const trimmed = content.length > 20000
      ? content.slice(0, 20000) + "\n…(truncated)"
      : content;
    const composed = [
      `Question about the file \`${filepath}\`:`,
      "",
      q,
      "",
      "Current contents in my editor:",
      "```",
      trimmed,
      "```",
    ].join("\n");
    try {
      window.iris.sendToIris(composed);
    } catch (err) {
      showToast("Ask failed: " + (err.message || err), { error: true });
    } finally {
      askInFlight = false;
    }
  }

  function autoSizeRail() {
    railInput.style.height = "auto";
    railInput.style.height = Math.min(railInput.scrollHeight, 120) + "px";
  }
  railInput.addEventListener("input", autoSizeRail);
  railInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      ask();
    }
  });
  railSend.addEventListener("click", ask);

  // No-op until something to unsubscribe is plumbed in (e.g., agent-event
  // stream into the rail). Leaves the close handler safe.
  function unsubscribe() {}

  // ── Load file ─────────────────────────────────────────────
  try {
    const res = await window.iris.fileRead(filepath);
    if (!res || !res.ok) {
      textarea.placeholder = "Failed to load file: " + (res && res.error || "unknown");
      return;
    }
    originalContent = res.content || "";
    textarea.value = originalContent;
    textarea.disabled = false;
    textarea.placeholder = "";
    refreshGutter();
    setTimeout(() => textarea.focus(), 60);
  } catch (err) {
    textarea.placeholder = "Failed to load file: " + (err.message || err);
  }
}

function basenameOf(p) {
  if (!p) return "";
  const norm = String(p).replace(/\\/g, "/");
  const parts = norm.split("/");
  return parts[parts.length - 1] || norm;
}

// Produce a small unified-diff style summary. Not a real diff library — just a
// line-by-line comparison good enough to give Iris and the user a sense of
// what changed.
function summarizeDiff(oldStr, newStr) {
  const oldLines = String(oldStr || "").split("\n");
  const newLines = String(newStr || "").split("\n");
  const out = [];
  let added = 0, removed = 0;
  // Walk in parallel, skipping unchanged context to keep the summary short.
  let i = 0, j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      i++; j++; continue;
    }
    // Look ahead to find next sync point.
    let k = j;
    while (k < newLines.length && k - j < 60 && (i >= oldLines.length || oldLines[i] !== newLines[k])) k++;
    let l = i;
    while (l < oldLines.length && l - i < 60 && (j >= newLines.length || newLines[j] !== oldLines[l])) l++;
    while (i < l) { out.push("- " + oldLines[i++]); removed++; }
    while (j < k) { out.push("+ " + newLines[j++]); added++; }
  }
  const header = `+${added} / -${removed} line${(added + removed) === 1 ? "" : "s"}`;
  if (out.length === 0) return header;
  const body = out.slice(0, 40).join("\n");
  const more = out.length > 40 ? `\n…(${out.length - 40} more lines omitted)` : "";
  return header + "\n" + body + more;
}

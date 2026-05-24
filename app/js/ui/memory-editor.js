// ═══════════════════════════════════════════════════════════
// memory-editor.js — Edit per-thread CLAUDE.md memory file
// ═══════════════════════════════════════════════════════════
//
// CLAUDE.md is a per-project memory file that the Claude Code CLI reads
// automatically. This modal lets the user view/edit it without leaving
// Iris Code. IPC for reading/writing the file is intentionally NOT added
// here — we call `window.iris.readMemoryFile` / `writeMemoryFile` if
// present, and fall back gracefully when the host hasn't wired them yet.

import { h, svgIcon, openModal, showToast } from "./util.js";

const FALLBACK_MSG = "(IPC not available — file read not yet wired)";

export function initMemoryEditor(state) {
  window.addEventListener("iris:show-memory", () => {
    try { showMemoryEditor(state); }
    catch (e) { console.error("[memory-editor] open failed", e); }
  });
}

export function showMemoryEditor(state) {
  const s = state.get?.() || {};
  const activeId = s.activeId;
  const agent = (s.agents || []).find((a) => a.id === activeId);
  const cwd = agent && agent.cwd ? String(agent.cwd) : "";

  if (!agent || !cwd) {
    showToast("Select a thread first");
    return;
  }

  const memoryPath = joinPath(cwd, "CLAUDE.md");

  // ── Build modal ────────────────────────────────────────────
  const modal = h("div", { class: "modal memory-modal", style: { width: "min(820px, calc(100vw - 32px))" } });

  const header = h("div", { class: "modal-header" });
  const closeBtn = h("button", { class: "modal-close", "aria-label": "Close" }, svgIcon("x", 14));
  header.append(h("div", { class: "modal-title" }, "Memory · CLAUDE.md"), closeBtn);

  const body = h("div", { class: "modal-body" });

  const pathRow = h("div", { class: "memory-path" });
  const pathText = h("code", { class: "memory-path-text", title: memoryPath }, memoryPath);
  const openBtn = h("button", { class: "btn btn-ghost btn-sm", type: "button", title: "Open containing folder" },
    svgIcon("folder", 12),
    h("span", null, "Open folder"),
  );
  openBtn.addEventListener("click", () => {
    try { window.iris?.openPath?.(cwd); }
    catch (e) { console.warn("[memory-editor] openPath failed", e); }
  });
  pathRow.append(pathText, openBtn);

  const textarea = h("textarea", {
    class: "memory-textarea",
    spellcheck: "false",
    placeholder: "# Project notes for Claude\n\nFile not loaded.",
  });
  textarea.value = "Loading…";
  textarea.disabled = true;

  const hint = h("div", { class: "hint memory-hint" }, "Saved to disk in the project's working directory. Claude reads this file automatically each session.");

  body.append(pathRow, textarea, hint);

  const footer = h("div", { class: "modal-footer" });
  const cancelBtn = h("button", { class: "btn btn-ghost", type: "button" }, "Cancel");
  const saveBtn = h("button", { class: "btn btn-primary", type: "button" }, "Save");
  saveBtn.disabled = true;
  footer.append(cancelBtn, saveBtn);

  modal.append(header, body, footer);

  const handle = openModal(modal);
  closeBtn.addEventListener("click", () => handle.close());
  cancelBtn.addEventListener("click", () => handle.close());

  // ── Load ─────────────────────────────────────────────────
  (async () => {
    const reader = window.iris?.readMemoryFile;
    if (typeof reader !== "function") {
      textarea.value = "";
      textarea.placeholder = FALLBACK_MSG;
      textarea.disabled = false;
      saveBtn.disabled = false;
      showToast(FALLBACK_MSG);
      return;
    }
    try {
      const result = await reader(cwd);
      const content = typeof result === "string"
        ? result
        : (result && typeof result.content === "string" ? result.content : "");
      textarea.value = content || "";
      textarea.disabled = false;
      saveBtn.disabled = false;
      textarea.focus();
    } catch (e) {
      console.warn("[memory-editor] read failed", e);
      textarea.value = "";
      textarea.disabled = false;
      saveBtn.disabled = false;
      showToast("Could not read CLAUDE.md", { error: true });
    }
  })();

  // ── Save ─────────────────────────────────────────────────
  saveBtn.addEventListener("click", async () => {
    const writer = window.iris?.writeMemoryFile;
    if (typeof writer !== "function") {
      showToast("(IPC not available — file write not yet wired)", { error: true });
      return;
    }
    saveBtn.disabled = true;
    try {
      await writer(cwd, textarea.value);
      showToast("Saved");
      handle.close();
    } catch (e) {
      console.error("[memory-editor] write failed", e);
      showToast("Failed to save CLAUDE.md", { error: true });
      saveBtn.disabled = false;
    }
  });
}

// Cross-platform path join without bringing in `path`. Trims trailing
// separators and uses the parent's existing separator style if any.
function joinPath(dir, leaf) {
  if (!dir) return leaf;
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  const trimmed = String(dir).replace(/[\\/]+$/, "");
  return `${trimmed}${sep}${leaf}`;
}

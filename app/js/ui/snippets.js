// ═══════════════════════════════════════════════════════════
// snippets.js — Slash-triggered prompt snippets
// ═══════════════════════════════════════════════════════════

import { h, svgIcon, openModal, showToast } from "./util.js";

const DEFAULT_SNIPPETS = [
  { name: "explain",  body: "Explain what this code does, like I'm a senior engineer joining the project." },
  { name: "fix",      body: "Find and fix bugs in this file. Show me the diff before applying." },
  { name: "test",     body: "Write tests for this. Use the existing test framework." },
  { name: "review",   body: "Review this for code quality issues: naming, complexity, error handling, edge cases." },
  { name: "plan",     body: "Don't write code yet. Propose a step-by-step plan I can approve." },
  { name: "refactor", body: "Refactor this for readability without changing behavior." },
];

function uid() {
  return "sn_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
}

function getSnippets(state) {
  const s = state.get().settings || {};
  return Array.isArray(s.snippets) ? s.snippets : [];
}

function caretLineStart(textarea) {
  const pos = textarea.selectionStart || 0;
  const before = textarea.value.slice(0, pos);
  return pos === 0 || before.endsWith("\n");
}

// ─── Floating popup ─────────────────────────────────────────
function showPopup(state, textarea) {
  closePopup();
  const list = getSnippets(state);
  if (!list.length) return;

  const popup = h("div", { class: "sn-popup", id: "iris-sn-popup" });
  let activeIdx = 0;
  let items = list.slice();

  function render(filter = "") {
    popup.innerHTML = "";
    items = list.filter((s) => !filter || s.name.toLowerCase().includes(filter.toLowerCase()));
    if (!items.length) {
      popup.append(h("div", { class: "sn-pop-empty" }, "No snippets match"));
      return;
    }
    if (activeIdx >= items.length) activeIdx = 0;
    items.forEach((s, i) => {
      const row = h("div", { class: `sn-item${i === activeIdx ? " active" : ""}` });
      row.append(
        h("div", { class: "sn-item-name" }, "/" + s.name),
        h("div", { class: "sn-item-body" }, s.body),
      );
      row.addEventListener("mousedown", (e) => {
        // mousedown (not click) — avoid losing textarea focus first
        e.preventDefault();
        insert(s);
      });
      row.addEventListener("mousemove", () => {
        if (activeIdx !== i) {
          activeIdx = i;
          render(currentFilter());
        }
      });
      popup.append(row);
    });
  }

  function currentFilter() {
    // The "/" already in the textarea + any chars typed after it become the filter.
    const pos = textarea.selectionStart || 0;
    const before = textarea.value.slice(0, pos);
    const slash = before.lastIndexOf("/");
    if (slash < 0) return "";
    return before.slice(slash + 1);
  }

  function insert(snippet) {
    const pos = textarea.selectionStart || 0;
    const v = textarea.value;
    const slash = v.slice(0, pos).lastIndexOf("/");
    if (slash < 0) {
      close();
      return;
    }
    const next = v.slice(0, slash) + snippet.body + v.slice(pos);
    textarea.value = next;
    const caret = slash + snippet.body.length;
    textarea.setSelectionRange(caret, caret);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    close();
    textarea.focus();
  }

  function close() {
    popup.remove();
    textarea.removeEventListener("keydown", onKey, true);
    textarea.removeEventListener("input", onInput);
    textarea.removeEventListener("blur", onBlur);
  }

  function onKey(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIdx = Math.min(items.length - 1, activeIdx + 1);
      render(currentFilter());
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIdx = Math.max(0, activeIdx - 1);
      render(currentFilter());
    } else if (e.key === "Enter") {
      if (items[activeIdx]) {
        e.preventDefault();
        insert(items[activeIdx]);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  function onInput() {
    // Cancel if the "/" was deleted.
    const pos = textarea.selectionStart || 0;
    const v = textarea.value;
    const slash = v.slice(0, pos).lastIndexOf("/");
    if (slash < 0) { close(); return; }
    // Cancel if the user wandered past a space.
    const after = v.slice(slash + 1, pos);
    if (/\s/.test(after)) { close(); return; }
    render(currentFilter());
  }

  function onBlur() {
    // Slight delay so click handlers on items still fire.
    setTimeout(close, 80);
  }

  textarea.addEventListener("keydown", onKey, true);
  textarea.addEventListener("input", onInput);
  textarea.addEventListener("blur", onBlur);

  // Position under the textarea's caret-ish location.
  const rect = textarea.getBoundingClientRect();
  popup.style.left = `${rect.left + 12}px`;
  popup.style.top = `${rect.top + 28}px`;
  document.body.append(popup);
  render(currentFilter());
}

function closePopup() {
  const existing = document.getElementById("iris-sn-popup");
  if (existing) existing.remove();
}

// ─── Manager modal ──────────────────────────────────────────
export function showSnippetsManager(state) {
  const modal = h("div", { class: "modal sn-mgr-modal" });

  const header = h("div", { class: "modal-header" });
  const closeBtn = h("button", { class: "modal-close", "aria-label": "Close" }, svgIcon("x", 14));
  header.append(h("div", { class: "modal-title" }, "Prompt snippets"), closeBtn);

  const body = h("div", { class: "modal-body" });
  const listEl = h("div", { class: "sn-mgr-list" });

  let working = getSnippets(state).map((s) => ({ ...s }));

  function render() {
    listEl.innerHTML = "";
    if (!working.length) {
      listEl.append(h("div", { class: "hint" }, "No snippets yet. Click \"Add snippet\" below."));
    }
    for (const sn of working) {
      const row = h("div", { class: "sn-mgr-row" });
      const head = h("div", { class: "sn-mgr-row-head" });
      const nameInput = h("input", {
        class: "input",
        type: "text",
        placeholder: "name",
        value: sn.name || "",
      });
      nameInput.addEventListener("input", () => { sn.name = nameInput.value; });
      const delBtn = h("button", { class: "btn btn-ghost", type: "button", "aria-label": "Delete" }, svgIcon("trash", 14));
      delBtn.addEventListener("click", () => {
        working = working.filter((x) => x !== sn);
        render();
      });
      head.append(nameInput, delBtn);
      const bodyTa = h("textarea", {
        class: "textarea",
        rows: "3",
        placeholder: "snippet body",
      });
      bodyTa.value = sn.body || "";
      bodyTa.addEventListener("input", () => { sn.body = bodyTa.value; });
      row.append(head, bodyTa);
      listEl.append(row);
    }
  }

  const addBtn = h("button", { class: "btn btn-ghost", type: "button" }, svgIcon("plus", 12), h("span", null, "Add snippet"));
  addBtn.addEventListener("click", () => {
    working.push({ id: uid(), name: "", body: "", createdAt: Date.now() });
    render();
  });

  body.append(listEl, addBtn);

  const footer = h("div", { class: "modal-footer" });
  const cancelBtn = h("button", { class: "btn btn-ghost", type: "button" }, "Cancel");
  const saveBtn = h("button", { class: "btn btn-primary", type: "button" }, "Save");
  footer.append(cancelBtn, saveBtn);

  modal.append(header, body, footer);

  const handle = openModal(modal);
  closeBtn.addEventListener("click", () => handle.close());
  cancelBtn.addEventListener("click", () => handle.close());

  saveBtn.addEventListener("click", async () => {
    const cleaned = working
      .filter((s) => s.name && s.name.trim() && s.body && s.body.trim())
      .map((s) => ({
        id: s.id || uid(),
        name: s.name.trim(),
        body: s.body,
        createdAt: s.createdAt || Date.now(),
      }));
    try {
      await state.actions.saveSettings({ snippets: cleaned });
      showToast("Snippets saved");
      handle.close();
    } catch (e) {
      showToast("Failed to save snippets", { error: true });
    }
  });

  render();
}

// ─── Init: seed defaults + global keydown listener ─────────
export function initSnippets(state) {
  // Seed defaults if absent. Wait for settings to be ready.
  function maybeSeed() {
    const s = state.get().settings;
    if (!s) return false;
    if (!Array.isArray(s.snippets) || s.snippets.length === 0) {
      const seeded = DEFAULT_SNIPPETS.map((d) => ({
        id: uid(),
        name: d.name,
        body: d.body,
        createdAt: Date.now(),
      }));
      state.actions.saveSettings({ snippets: seeded });
    }
    return true;
  }
  if (!maybeSeed()) {
    const unsub = state.subscribe(() => {
      if (maybeSeed()) unsub();
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key !== "/") return;
    const t = e.target;
    if (!(t instanceof HTMLTextAreaElement)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!caretLineStart(t)) return;
    // The worker chat composer (.composer textarea) has its own slash-command
    // engine (/help, /model, etc.) — defer to it there to avoid double-popup.
    if (t.closest(".composer")) return;
    // Don't fire if popup is already open.
    if (document.getElementById("iris-sn-popup")) return;
    // Defer so the "/" character itself is inserted first.
    setTimeout(() => showPopup(state, t), 0);
  });
}

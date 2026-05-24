// ═══════════════════════════════════════════════════════════
// diff-viewer.js — Inline side-by-side diff for Edit/Write/MultiEdit tool cards
// ═══════════════════════════════════════════════════════════
//
// Observes the document for new `.tool-card` elements (mounted lazily by
// chat-view.js). When a card represents an Edit/Write/MultiEdit tool, we
// parse its rendered input JSON and append a `.diff-viewer` panel below
// the existing body. Cards are marked with `data-diff-rendered="1"` once
// upgraded so we never re-render the same card.
//
// Cross-module access is fully guarded: if anything looks off, we bail
// silently so the original tool-card UI keeps working.

import { h, basename } from "./util.js";

const SUPPORTED = new Set(["Edit", "Write", "MultiEdit"]);

export function initDiffViewer(state) {
  if (typeof document === "undefined") return;

  const obs = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches?.(".tool-card")) tryUpgrade(node);
        // Descendants too — tool cards usually arrive as descendants of
        // the .draft-tools / .msg-tools wrappers.
        const nested = node.querySelectorAll?.(".tool-card");
        if (nested && nested.length) {
          for (const c of nested) tryUpgrade(c);
        }
      }
      // Attribute / character data changes inside a tool card mean the
      // streaming JSON has updated — try again if we haven't rendered yet.
      if (m.type === "characterData" || m.type === "childList") {
        const card = m.target instanceof HTMLElement
          ? m.target.closest?.(".tool-card")
          : null;
        if (card) tryUpgrade(card);
      }
    }
  });

  obs.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // Sweep pre-existing cards on init (e.g. when re-rendering history).
  for (const card of document.querySelectorAll(".tool-card")) tryUpgrade(card);
}

// ─── Card upgrade ──────────────────────────────────────────
function tryUpgrade(card) {
  if (!card || card.dataset.diffRendered === "1") return;

  const name = readToolName(card);
  if (!name || !SUPPORTED.has(name)) return;

  const input = readToolInput(card);
  if (!input || typeof input !== "object") return; // wait for more JSON

  // Defensive: each tool needs specific fields. If they're not there yet
  // (still streaming), bail and let the next mutation try again.
  if (name === "Edit") {
    if (typeof input.old_string !== "string" || typeof input.new_string !== "string") return;
  } else if (name === "Write") {
    if (typeof input.content !== "string") return;
  } else if (name === "MultiEdit") {
    if (!Array.isArray(input.edits) || input.edits.length === 0) return;
  }

  const viewer = renderViewer(name, input);
  if (!viewer) return;

  card.append(viewer);
  card.dataset.diffRendered = "1";
}

function readToolName(card) {
  // Prefer an explicit attribute if/when the chat-view adds one.
  const attr = card.getAttribute?.("data-tool-name");
  if (attr) return attr;
  const nameEl = card.querySelector?.(".tool-name");
  if (nameEl) return (nameEl.textContent || "").trim();
  return "";
}

function readToolInput(card) {
  // chat-view writes the pretty-printed JSON into the FIRST <pre> inside
  // .tool-body. (The second <pre.tool-result> holds the result.)
  const body = card.querySelector?.(".tool-body");
  if (!body) return null;
  const pres = body.querySelectorAll(":scope > pre");
  // Pick the first non-result <pre>.
  let pre = null;
  for (const p of pres) {
    if (!p.classList.contains("tool-result")) { pre = p; break; }
  }
  if (!pre) return null;
  const txt = (pre.textContent || "").trim();
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

// ─── Rendering ─────────────────────────────────────────────
function renderViewer(name, input) {
  const viewer = h("div", { class: "diff-viewer" });
  const filePath = input.file_path || input.path || "";

  if (name === "Write") {
    const content = String(input.content || "");
    const lines = content.split("\n");
    viewer.append(
      renderHeader(filePath, `creating new file · ${lines.length} line${lines.length === 1 ? "" : "s"}`),
      renderSinglePane(lines, "new"),
    );
    return viewer;
  }

  if (name === "Edit") {
    viewer.append(renderHeader(filePath, "edit"));
    viewer.append(renderEditCols(String(input.old_string || ""), String(input.new_string || "")));
    return viewer;
  }

  if (name === "MultiEdit") {
    viewer.append(renderHeader(filePath, `${input.edits.length} edit${input.edits.length === 1 ? "" : "s"}`));
    input.edits.forEach((e, i) => {
      const block = h("div", { class: "diff-block" });
      block.append(h("div", { class: "diff-block-label" }, `Edit ${i + 1} of ${input.edits.length}`));
      block.append(renderEditCols(String(e.old_string || ""), String(e.new_string || "")));
      viewer.append(block);
    });
    return viewer;
  }

  return null;
}

function renderHeader(filePath, sub) {
  const head = h("div", { class: "diff-header" });
  const left = h("div", { class: "diff-header-left" });
  left.append(
    h("span", { class: "diff-header-file", title: filePath || "" }, basename(filePath) || filePath || "(no path)"),
  );
  if (filePath && basename(filePath) !== filePath) {
    left.append(h("span", { class: "diff-header-path" }, filePath));
  }
  const right = h("div", { class: "diff-header-sub" });
  right.append(h("span", null, sub || ""));

  // "Open editor" — opens the file in a minimalist in-app editor with an
  // assistant sidebar. Only meaningful when we have an absolute path.
  if (filePath) {
    const editorBtn = h("button", {
      class: "diff-open-editor",
      type: "button",
      title: "Open in editor",
      "aria-label": "Open in editor",
    });
    editorBtn.innerHTML = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2 H14 V7"/><path d="M14 2 L8.5 7.5"/><path d="M13.5 9 V13 a1 1 0 0 1 -1 1 H3 a1 1 0 0 1 -1 -1 V3 a1 1 0 0 1 1 -1 H7"/></svg>`;
    editorBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        const { openEditorModal } = await import("./editor-modal.js");
        openEditorModal(filePath);
      } catch (err) {
        console.error("[diff-viewer] failed to open editor:", err);
      }
    });
    right.append(editorBtn);
  }
  head.append(left, right);
  return head;
}

function renderEditCols(oldStr, newStr) {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const tags = diffLines(oldLines, newLines); // { oldTags, newTags } per-line: "del"|"add"|"context"

  const cols = h("div", { class: "diff-cols" });
  cols.append(
    renderCol(oldLines, tags.oldTags, "old"),
    renderCol(newLines, tags.newTags, "new"),
  );
  return cols;
}

function renderCol(lines, tags, side) {
  const col = h("div", { class: `diff-col ${side}` });
  for (let i = 0; i < lines.length; i++) {
    const cls = tags[i] || "context";
    const row = h("div", { class: `diff-line ${cls}` });
    row.append(
      h("span", { class: "diff-line-no" }, String(i + 1)),
      h("span", { class: "diff-line-text" }, lines[i] || " "),
    );
    col.append(row);
  }
  return col;
}

function renderSinglePane(lines, side) {
  const cols = h("div", { class: "diff-cols single" });
  const col = h("div", { class: `diff-col ${side}` });
  for (let i = 0; i < lines.length; i++) {
    const row = h("div", { class: `diff-line ${side === "new" ? "add" : "context"}` });
    row.append(
      h("span", { class: "diff-line-no" }, String(i + 1)),
      h("span", { class: "diff-line-text" }, lines[i] || " "),
    );
    col.append(row);
  }
  cols.append(col);
  return cols;
}

// ─── LCS-based line diff (compact) ─────────────────────────
// Returns per-line tags for both sides.
function diffLines(a, b) {
  const n = a.length, m = b.length;
  // Build LCS length matrix (small; old/new strings are usually <200 lines).
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const oldTags = new Array(n).fill("del");
  const newTags = new Array(m).fill("add");
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      oldTags[i] = "context";
      newTags[j] = "context";
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      // a[i] deleted
      i++;
    } else {
      // b[j] added
      j++;
    }
  }
  return { oldTags, newTags };
}

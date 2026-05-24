// ═══════════════════════════════════════════════════════════
// tags.js — Colored tags per agent. Dots render in the sidebar
// rows; a manager modal edits a single agent's tags or browses
// every tag in the workspace and filters the list.
// ═══════════════════════════════════════════════════════════

import { h, svgIcon, openModal, showToast } from "./util.js";

const PALETTE = [35, 145, 200, 280, 320, 0, 50, 100];

function colorForHue(hue) {
  return `hsl(${hue}, 60%, 55%)`;
}

function getAgentTags(state) {
  const s = state.get().settings || {};
  return s.agentTags && typeof s.agentTags === "object" ? s.agentTags : {};
}

function getTagColors(state) {
  const s = state.get().settings || {};
  return s.tagColors && typeof s.tagColors === "object" ? s.tagColors : {};
}

function ensureColor(tag, existing) {
  if (existing[tag]) return existing[tag];
  // Auto-assign next palette slot — wrap if more than 8 tags exist.
  const used = Object.values(existing).length;
  const hue = PALETTE[used % PALETTE.length];
  return colorForHue(hue);
}

function tagsForAgent(state, agentId) {
  const all = getAgentTags(state);
  return Array.isArray(all[agentId]) ? all[agentId].slice() : [];
}

async function saveAgentTags(state, agentId, tags) {
  const all = { ...getAgentTags(state) };
  if (!tags.length) delete all[agentId];
  else all[agentId] = tags;
  // Compute the color map: keep existing colors, add missing.
  const colors = { ...getTagColors(state) };
  for (const t of tags) {
    if (!colors[t]) colors[t] = ensureColor(t, colors);
  }
  await state.actions.saveSettings({ agentTags: all, tagColors: colors });
}

function allTags(state) {
  const all = getAgentTags(state);
  const counts = new Map();
  for (const ids of Object.values(all)) {
    if (!Array.isArray(ids)) continue;
    for (const t of ids) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

// ─── Sidebar dot decoration ─────────────────────────────────
function renderDots(item, tags, colors) {
  let host = item.querySelector(":scope > .tags");
  if (!host) {
    host = h("div", { class: "tags" });
    item.append(host);
  }
  // Build a signature so we only repaint when something changed.
  const sig = tags.slice(0, 3).join("|");
  if (host.dataset.sig === sig) return;
  host.dataset.sig = sig;
  host.innerHTML = "";
  for (const t of tags.slice(0, 3)) {
    const dot = h("span", { class: "dot", title: t });
    dot.style.background = colors[t] || colorForHue(0);
    host.append(dot);
  }
}

// ─── Public init ────────────────────────────────────────────
export function initTags(state) {
  const colors = () => getTagColors(state);
  const tagsMap = () => getAgentTags(state);

  function repaintAll() {
    const map = tagsMap();
    const cm = colors();
    document.querySelectorAll(".sb-item[data-id]").forEach((item) => {
      const id = item.getAttribute("data-id");
      if (!id || id === "iris") return;
      renderDots(item, Array.isArray(map[id]) ? map[id] : [], cm);
    });
  }

  // Watch the sidebar for new items so freshly-built rows pick up dots.
  const mo = new MutationObserver(() => repaintAll());
  if (document.body) {
    mo.observe(document.body, { subtree: true, childList: true });
  } else {
    document.addEventListener("DOMContentLoaded", () => {
      mo.observe(document.body, { subtree: true, childList: true });
      repaintAll();
    });
  }

  // Re-render whenever settings change (tags or colors edited).
  let lastSig = "";
  state.subscribe(() => {
    const sig = JSON.stringify(tagsMap()) + "|" + JSON.stringify(colors());
    if (sig === lastSig) return;
    lastSig = sig;
    repaintAll();
  });

  // Cross-module hook so right-click / context menus can launch the manager.
  window.__iris_show_tags_manager = (id) => showTagsManager(state, id);

  // Filter wiring — set display:none on items whose agent lacks the tag.
  window.addEventListener("iris:filter-tag", (e) => {
    const tag = e.detail;
    if (!tag) return;
    const map = tagsMap();
    document.querySelectorAll(".sb-item[data-id]").forEach((item) => {
      const id = item.getAttribute("data-id");
      const has = id && Array.isArray(map[id]) && map[id].includes(tag);
      item.style.display = has ? "" : "none";
    });
  });
  window.addEventListener("iris:clear-filter", () => {
    document.querySelectorAll(".sb-item[data-id]").forEach((item) => {
      item.style.display = "";
    });
  });

  repaintAll();
}

// ─── Single-agent manager modal ─────────────────────────────
function showSingleManager(state, agentId) {
  const agent = state.get().agents.find((a) => a.id === agentId);
  const name = agent ? agent.name || "Untitled" : agentId;

  const modal = h("div", { class: "modal tag-manager" });
  const header = h("div", { class: "modal-header" });
  const closeBtn = h("button", { class: "modal-close", "aria-label": "Close" }, svgIcon("x", 14));
  header.append(h("div", { class: "modal-title" }, `Tags for ${name}`), closeBtn);

  const body = h("div", { class: "modal-body" });
  const chipsRow = h("div", { class: "row" });
  const inputRow = h("div", { class: "row" });
  const input = h("input", { class: "input", type: "text", placeholder: "Add tag…" });
  inputRow.append(input);

  let working = tagsForAgent(state, agentId);

  function renderChips() {
    chipsRow.innerHTML = "";
    if (!working.length) {
      chipsRow.append(h("span", { class: "hint" }, "No tags yet. Type below to add one."));
      return;
    }
    const cm = getTagColors(state);
    for (const t of working) {
      const chip = h("span", { class: "tag-chip" });
      const dot = h("span", { class: "dot" });
      dot.style.background = cm[t] || ensureColor(t, cm);
      const x = h("button", { class: "x", type: "button", "aria-label": `Remove ${t}` }, "×");
      x.addEventListener("click", () => {
        working = working.filter((y) => y !== t);
        renderChips();
        persist();
      });
      chip.append(dot, h("span", null, t), x);
      chipsRow.append(chip);
    }
  }

  async function persist() {
    try { await saveAgentTags(state, agentId, working); }
    catch { showToast("Failed to save tags", { error: true }); }
  }

  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return;
    if (!working.includes(v)) working.push(v);
    input.value = "";
    renderChips();
    persist();
  });

  body.append(chipsRow, inputRow);
  modal.append(header, body);

  renderChips();

  const handle = openModal(modal);
  closeBtn.addEventListener("click", () => handle.close());
}

// ─── All-tags browser ───────────────────────────────────────
function showAllTagsBrowser(state) {
  const modal = h("div", { class: "modal tag-manager" });
  const header = h("div", { class: "modal-header" });
  const closeBtn = h("button", { class: "modal-close", "aria-label": "Close" }, svgIcon("x", 14));
  header.append(h("div", { class: "modal-title" }, "All tags"), closeBtn);

  const body = h("div", { class: "modal-body" });
  const list = h("div", { class: "row" });

  const entries = allTags(state);
  if (!entries.length) {
    body.append(h("div", { class: "hint" }, "No tags yet. Right-click a thread to add one."));
  } else {
    const cm = getTagColors(state);
    for (const [t, count] of entries) {
      const chip = h("button", { class: "tag-chip", type: "button" });
      const dot = h("span", { class: "dot" });
      dot.style.background = cm[t] || colorForHue(0);
      chip.append(dot, h("span", null, t), h("span", { class: "hint" }, ` ${count}`));
      chip.addEventListener("click", () => {
        window.dispatchEvent(new CustomEvent("iris:filter-tag", { detail: t }));
        handle.close();
      });
      list.append(chip);
    }
    body.append(list);
  }

  const footer = h("div", { class: "modal-footer" });
  const clear = h("button", { class: "btn btn-ghost", type: "button" }, "Clear filter");
  clear.addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent("iris:clear-filter"));
    handle.close();
  });
  footer.append(clear);

  modal.append(header, body, footer);
  const handle = openModal(modal);
  closeBtn.addEventListener("click", () => handle.close());
}

export function showTagsManager(state, agentId) {
  if (agentId) showSingleManager(state, agentId);
  else showAllTagsBrowser(state);
}

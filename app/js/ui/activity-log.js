// activity-log.js -- Chronological feed of every thread event.
//
// Subscribes directly to window.iris.onAgentEvent (the same stream the
// state machine reads) and renders the newest-first list. Lives inside
// the Iris overlay welcome card.

import { renderMarkdown } from "../lib/markdown.js";

const ICON_BY_KIND = {
  tool:   "⚙",
  result: "✓",
  error:  "✕",
  user:   "›",
  start:  "▸",
  stop:   "⏹",
};

const COLOR_BY_KIND = {
  tool:   "var(--text-2)",
  result: "var(--green)",
  error:  "var(--red)",
  user:   "var(--blue)",
  start:  "var(--accent)",
  stop:   "var(--text-3)",
};

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    if (c instanceof Node) el.append(c);
    else el.append(document.createTextNode(String(c)));
  }
  return el;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

const MAX_ROWS = 80;

/**
 * Mount the activity log into `rootEl`.
 * Returns { unmount } to tear down listeners.
 */
export function mountActivityLog(rootEl, opts = {}) {
  rootEl.innerHTML = "";
  rootEl.classList.add("ac-log");

  const head = h("div", { class: "ac-log-head" });
  const title = h("div", { class: "ac-log-title" }, "Activity");
  const sub = h("div", { class: "ac-log-sub" }, "live feed across all threads");
  const clearBtn = h("button", { class: "ac-log-clear", type: "button", title: "Clear log" }, "Clear");
  head.append(
    h("div", { style: { display: "flex", flexDirection: "column" } }, title, sub),
    clearBtn,
  );
  const list = h("div", { class: "ac-log-list" });
  const empty = h("div", { class: "ac-log-empty" }, "No activity yet. Send a message to a thread and updates land here in real time.");
  list.append(empty);

  rootEl.append(head, list);

  const rows = []; // newest-first cap of MAX_ROWS

  function paint() {
    list.innerHTML = "";
    if (rows.length === 0) { list.append(empty); return; }
    for (const r of rows) list.append(renderRow(r));
  }

  function renderRow(r) {
    const row = h("div", { class: `ac-row ac-${r.kind}` });
    const icon = h("span", { class: "ac-icon", style: { color: COLOR_BY_KIND[r.kind] || "var(--text-2)" } }, ICON_BY_KIND[r.kind] || "·");
    const meta = h("div", { class: "ac-meta" });
    const time = h("span", { class: "ac-time" }, fmtTime(r.ts));
    const who = h("span", { class: "ac-who" }, r.name || r.id || "—");
    meta.append(time, who);
    const text = h("div", { class: "ac-text" }, r.text || "");
    row.append(icon, meta, text);
    return row;
  }

  function push(entry) {
    rows.unshift({ ...entry, ts: entry.ts || Date.now() });
    if (rows.length > MAX_ROWS) rows.length = MAX_ROWS;
    paint();
  }

  // Subscribe to event stream
  let unsub = null;
  if (window.iris && typeof window.iris.onAgentEvent === "function") {
    unsub = window.iris.onAgentEvent((e) => {
      if (!e || !e.id) return;
      switch (e.type) {
        case "user":
          push({ kind: "user", id: e.id, name: nameFor(e.id), text: e.text });
          break;
        case "session":
          push({ kind: "start", id: e.id, name: nameFor(e.id), text: "session started" });
          break;
        case "tool":
          push({ kind: "tool", id: e.id, name: nameFor(e.id), text: `used ${e.tool}` });
          break;
        case "result":
          push({ kind: "result", id: e.id, name: nameFor(e.id), text: (e.text || "").slice(0, 100) });
          break;
        case "error":
          push({ kind: "error", id: e.id, name: nameFor(e.id), text: e.message || "error" });
          break;
        case "done":
          // covered by result; ignore to avoid duplicates
          break;
      }
    });
  }

  function nameFor(id) {
    try {
      const s = (window.__iris_state && window.__iris_state.get) ? window.__iris_state.get() : null;
      const a = s && s.agents.find((x) => x.id === id);
      return a ? a.name : id;
    } catch { return id; }
  }

  clearBtn.addEventListener("click", () => { rows.length = 0; paint(); });

  // Seed from existing state.activityLog if present
  try {
    const s = window.__iris_state && window.__iris_state.get();
    if (s && Array.isArray(s.activityLog) && s.activityLog.length > 0) {
      for (const e of s.activityLog) rows.push(e);
      paint();
    }
  } catch {}

  return {
    unmount() { try { unsub && unsub(); } catch {} },
  };
}

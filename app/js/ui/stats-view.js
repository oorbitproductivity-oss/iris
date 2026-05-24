// ═══════════════════════════════════════════════════════════
// stats-view.js — Live stats dashboard
// ═══════════════════════════════════════════════════════════

import { h, svgIcon, openModal, relativeTime } from "./util.js";

function computeStats(state) {
  const s = state.get();
  const agents = (s.agents || []).filter((a) => a.id !== "iris");
  const messagesByAgent = s.messagesByAgent || {};
  const activityLog = s.activityLog || [];

  // Count messages + tools across ALL agents (including Iris).
  let totalMessages = 0;
  let totalTools = 0;
  const toolCounts = {};
  for (const a of s.agents || []) {
    const msgs = messagesByAgent[a.id] || [];
    totalMessages += msgs.length;
    for (const m of msgs) {
      if (m.role !== "assistant" || !Array.isArray(m.tools)) continue;
      totalTools += m.tools.length;
      for (const t of m.tools) {
        const name = t.name || "unknown";
        toolCounts[name] = (toolCounts[name] || 0) + 1;
      }
    }
  }

  const running = agents.filter((a) => a.status === "running").length;

  // Per-agent breakdown
  const perAgent = agents.map((a) => ({
    id: a.id,
    name: a.name || "Untitled",
    status: a.status || "idle",
    msgs: (messagesByAgent[a.id] || []).length,
    lastActivity: a.lastActivity,
  })).sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));

  // Tool ranking — top 8
  const topTools = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  // Activity bucket: 24 hourly bars from `now - 24h` → now.
  const now = Date.now();
  const buckets = new Array(24).fill(0);
  const HOUR = 60 * 60 * 1000;
  for (const e of activityLog) {
    if (!e.ts) continue;
    const age = now - e.ts;
    if (age < 0 || age >= 24 * HOUR) continue;
    const idx = 23 - Math.floor(age / HOUR);
    if (idx >= 0 && idx < 24) buckets[idx]++;
  }

  return {
    threadCount: agents.length,
    running,
    totalMessages,
    totalTools,
    perAgent,
    topTools,
    buckets,
  };
}

function kpi(label, value) {
  return h("div", { class: "st-kpi" },
    h("div", { class: "st-kpi-label" }, label),
    h("div", { class: "st-kpi-value" }, String(value)),
  );
}

function renderBody(body, state) {
  body.innerHTML = "";
  const stats = computeStats(state);

  // KPIs
  const kpis = h("div", { class: "st-kpis" });
  kpis.append(
    kpi("Threads", stats.threadCount),
    kpi("Running", stats.running),
    kpi("Messages", stats.totalMessages),
    kpi("Tools used", stats.totalTools),
  );
  body.append(kpis);

  // Two columns
  const cols = h("div", { class: "st-cols" });

  // Agent breakdown
  const left = h("div", { class: "st-panel" });
  left.append(h("div", { class: "st-panel-title" }, "Thread breakdown"));
  if (!stats.perAgent.length) {
    left.append(h("div", { class: "hint" }, "No worker threads yet."));
  } else {
    for (const a of stats.perAgent) {
      const row = h("div", { class: "st-agent-row" });
      const name = h("div", { class: "st-agent-name", title: a.name },
        a.name,
        h("div", {
          class: "st-agent-msgs",
          style: { fontSize: "10px", color: "var(--text-3)" },
        }, a.lastActivity ? `active ${relativeTime(a.lastActivity)}` : "—"),
      );
      const count = h("div", { class: "st-agent-msgs" }, `${a.msgs} msg`);
      const pill = h("div", { class: `st-agent-pill ${a.status}` }, a.status);
      row.append(name, count, pill);
      left.append(row);
    }
  }

  // Tool usage
  const right = h("div", { class: "st-panel" });
  right.append(h("div", { class: "st-panel-title" }, "Most-used tools"));
  if (!stats.topTools.length) {
    right.append(h("div", { class: "hint" }, "No tool invocations yet."));
  } else {
    const max = stats.topTools[0][1] || 1;
    for (const [name, count] of stats.topTools) {
      const row = h("div", { class: "st-tool-row" });
      const bar = h("div", { class: "st-tool-bar" });
      const fill = h("div", { class: "st-tool-fill" });
      fill.style.width = `${(count / max) * 100}%`;
      bar.append(fill);
      row.append(
        h("div", { class: "st-tool-name", title: name }, name),
        bar,
        h("div", { class: "st-tool-count" }, String(count)),
      );
      right.append(row);
    }
  }
  cols.append(left, right);
  body.append(cols);

  // Activity 24h
  const actPanel = h("div", { class: "st-panel" });
  actPanel.append(h("div", { class: "st-panel-title" }, "Activity (last 24 hours)"));
  const maxBucket = Math.max(1, ...stats.buckets);
  const chart = h("div", { class: "st-activity" });
  stats.buckets.forEach((count, i) => {
    const bar = h("div", {
      class: `st-act-bar${count > 0 ? " has-data" : ""}`,
      title: `${count} event${count === 1 ? "" : "s"} · ${23 - i}h ago`,
    });
    bar.style.height = `${(count / maxBucket) * 100}%`;
    chart.append(bar);
  });
  const labels = h("div", { class: "st-act-labels" });
  labels.append(h("span", null, "24h ago"), h("span", null, "12h"), h("span", null, "now"));
  actPanel.append(chart, labels);
  body.append(actPanel);
}

export function showStatsModal(state) {
  const modal = h("div", { class: "modal st-modal" });
  const header = h("div", { class: "modal-header" });
  const closeBtn = h("button", { class: "modal-close", "aria-label": "Close" }, svgIcon("x", 14));
  header.append(h("div", { class: "modal-title" }, "Stats"), closeBtn);

  const body = h("div", { class: "modal-body" });
  modal.append(header, body);
  renderBody(body, state);

  // Live re-render while open — rAF-coalesced to avoid flicker during streams.
  let pending = false;
  const unsub = state.subscribe(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      renderBody(body, state);
    });
  });

  const handle = openModal(modal, { onClose: () => unsub() });
  closeBtn.addEventListener("click", () => handle.close());
}

export function initStats(state) {
  window.addEventListener("iris:show-stats", () => showStatsModal(state));
}

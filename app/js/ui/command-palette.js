// ═══════════════════════════════════════════════════════════
// command-palette.js — Ctrl/Cmd+Shift+P fuzzy command launcher
// ═══════════════════════════════════════════════════════════

import { h, svgIcon } from "./util.js";

/**
 * Fuzzy subsequence match. Returns null if `query` is not a subsequence of
 * `text` (both lowercased); otherwise a score in (0, 1] where a tighter
 * match (smaller span between first and last matched char) scores higher.
 */
function fuzzyScore(query, text) {
  if (!query) return 0.5;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let firstMatch = -1;
  let lastMatch = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (firstMatch === -1) firstMatch = ti;
      lastMatch = ti;
      qi++;
    }
  }
  if (qi < q.length) return null;
  const span = lastMatch - firstMatch + 1;
  return q.length / Math.max(span, 1);
}

function buildCommands(state) {
  const s = state.get();
  const settings = s.settings || {};
  const cmds = [
    {
      label: "New thread…",
      icon: "plus",
      hint: "Ctrl+N",
      run: () => import("./new-session.js").then((m) => m.showNewSessionModal(state)),
    },
    {
      label: "Open Iris",
      icon: "iris",
      hint: "Ctrl+K",
      run: () => window.__iris_toggle?.(),
    },
    {
      label: "Settings",
      icon: "settings",
      hint: "Ctrl+,",
      run: () => import("./settings.js").then((m) => m.showSettingsModal(state)),
    },
    {
      label: "Toggle light/dark theme",
      icon: "spark",
      run: () =>
        state.actions.saveSettings({
          theme: settings.theme === "light" ? "dark" : "light",
        }),
    },
    {
      label: "Switch to Iris",
      icon: "iris",
      run: () => state.actions.selectAgent("iris"),
    },
  ];

  // Per-agent switch commands
  for (const a of s.agents || []) {
    if (a.id === "iris") continue;
    cmds.push({
      label: `Switch to: ${a.name || "Untitled"}`,
      icon: "arrowRight",
      run: () => state.actions.selectAgent(a.id),
    });
  }

  // Stop current thread (only if running)
  const active = (s.agents || []).find((a) => a.id === s.activeId);
  if (active && active.status === "running" && active.id !== "iris") {
    cmds.push({
      label: "Stop current thread",
      icon: "stop",
      run: () => state.actions.stopAgent(active.id),
    });
  }

  cmds.push(
    { label: "New window", icon: "copy", run: () => window.iris?.windowNew?.() },
    {
      label: "Show stats",
      icon: "focus",
      run: () => window.dispatchEvent(new CustomEvent("iris:show-stats")),
    },
    {
      label: "Export current thread…",
      icon: "send",
      run: () => window.dispatchEvent(new CustomEvent("iris:export-current")),
    },
    {
      label: "Browse templates",
      icon: "zap",
      run: () => window.dispatchEvent(new CustomEvent("iris:show-templates")),
    },
    // v0.3 additions
    {
      label: "Pick theme…",
      icon: "spark",
      run: () => window.dispatchEvent(new CustomEvent("iris:show-theme-picker")),
    },
    {
      label: "Search all threads…",
      icon: "focus",
      hint: "Ctrl+Shift+F",
      run: () => window.dispatchEvent(new CustomEvent("iris:show-search")),
    },
    {
      label: "Edit thread tags…",
      icon: "spark",
      run: () => window.dispatchEvent(new CustomEvent("iris:show-tags")),
    },
    {
      label: "Edit CLAUDE.md memory…",
      icon: "folder",
      run: () => window.dispatchEvent(new CustomEvent("iris:show-memory")),
    },
    {
      label: "Take the v0.3 tour",
      icon: "iris",
      run: () => window.dispatchEvent(new CustomEvent("iris:show-tour")),
    },
    {
      label: "Manage snippets…",
      icon: "copy",
      run: () => import("./snippets.js").then((m) => m.showSnippetsManager(state)),
    },
    {
      label: "Toggle plan mode for this thread",
      icon: "check",
      run: () => import("./plan-mode.js").then((m) => m.togglePlanMode(state)),
    },
    {
      label: "Turn OFF plan mode for ALL threads",
      icon: "x",
      run: () => import("./plan-mode.js").then((m) => m.clearAllPlanModes(state)),
    },
    {
      label: "Telegram bridge settings…",
      icon: "paperPlane",
      run: () => import("./telegram-panel.js").then((m) => m.showTelegramPanel()),
    },
  );
  return cmds;
}

function openPalette(state) {
  if (document.querySelector(".cp-overlay")) return; // already open

  const overlay = h("div", { class: "cp-overlay" });
  const panel = h("div", { class: "cp-panel", role: "dialog", "aria-label": "Command palette" });

  // Search bar
  const search = h("div", { class: "cp-search" });
  const icon = h("span", { class: "cp-search-icon" }, svgIcon("spark", 14));
  const input = h("input", {
    type: "text",
    placeholder: "Type a command…",
    autocomplete: "off",
    spellcheck: "false",
  });
  search.append(icon, input);

  const listEl = h("div", { class: "cp-list" });
  const foot = h("div", { class: "cp-foot" });
  foot.append(
    h("span", null, h("kbd", null, "↑"), h("kbd", null, "↓"), " navigate"),
    h("span", null, h("kbd", null, "↵"), " run"),
    h("span", null, h("kbd", null, "Esc"), " close"),
  );

  panel.append(search, listEl, foot);
  overlay.append(panel);
  document.body.append(overlay);

  const allCmds = buildCommands(state);
  let filtered = allCmds.map((c) => ({ cmd: c, score: 0 }));
  let activeIdx = 0;

  function render() {
    listEl.innerHTML = "";
    if (filtered.length === 0) {
      listEl.append(h("div", { class: "cp-empty" }, "No matching commands"));
      return;
    }
    filtered.forEach(({ cmd }, i) => {
      const item = h("div", {
        class: `cp-item${i === activeIdx ? " active" : ""}`,
        "data-idx": i,
      });
      item.append(
        h("div", { class: "cp-item-icon" }, svgIcon(cmd.icon || "spark", 14)),
        h("div", { class: "cp-item-label" }, cmd.label),
        cmd.hint ? h("div", { class: "cp-item-hint" }, cmd.hint) : null,
      );
      item.addEventListener("click", () => runAt(i));
      item.addEventListener("mousemove", () => {
        if (activeIdx !== i) {
          activeIdx = i;
          render();
        }
      });
      listEl.append(item);
    });
    // Scroll active into view
    const activeEl = listEl.querySelector(".cp-item.active");
    if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
  }

  function refilter(q) {
    if (!q.trim()) {
      filtered = allCmds.map((c) => ({ cmd: c, score: 0 }));
    } else {
      filtered = allCmds
        .map((c) => {
          const score = fuzzyScore(q, c.label);
          return score == null ? null : { cmd: c, score };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);
    }
    activeIdx = 0;
    render();
  }

  function runAt(i) {
    const sel = filtered[i];
    close();
    if (sel) {
      try { sel.cmd.run(); } catch (e) { console.error("[cp] run failed", e); }
    }
  }

  function close() {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
  }

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIdx = Math.min(filtered.length - 1, activeIdx + 1);
      render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIdx = Math.max(0, activeIdx - 1);
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAt(activeIdx);
    }
  }

  input.addEventListener("input", () => refilter(input.value));
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onKey, true);

  render();
  setTimeout(() => input.focus(), 30);
}

export function initCommandPalette(state) {
  window.addEventListener("keydown", (e) => {
    // Ctrl/Cmd+Shift+P — using code so layouts behave the same regardless of
    // active language.
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && (e.key === "P" || e.key === "p" || e.code === "KeyP")) {
      e.preventDefault();
      openPalette(state);
    }
  });
}

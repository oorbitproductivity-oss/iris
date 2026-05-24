// ═══════════════════════════════════════════════════════════
// tour.js — One-time welcome tour for v0.3 upgrades. Skipped
// for first-run users (the onboarding wizard handles them) and
// marked seen via settings.tourSeenVersion.
// ═══════════════════════════════════════════════════════════

import { h } from "./util.js";

const VERSION = "0.3";

const STEPS = [
  {
    title: "Welcome to v0.3",
    body:
      "Ten new things have landed since v0.2. Take 90 seconds to see what's " +
      "new — or skip and explore yourself.",
    actions: [{ kind: "skip", label: "Skip" }, { kind: "next", label: "Next" }],
  },
  {
    title: "Command palette",
    body:
      "Press Ctrl/Cmd+Shift+P from anywhere. Fuzzy-search new threads, themes, " +
      "agent switching, snippets, templates.",
    actions: [
      { kind: "fire", label: "Try it", event: "iris:show-command-palette" },
      { kind: "next", label: "Next" },
    ],
  },
  {
    title: "Themes",
    body:
      "Five themes shipped: Codex Dark, Codex Light, Midnight, Solarized, Forest. " +
      "Find one that fits your day.",
    actions: [
      { kind: "fire", label: "Try it", event: "iris:show-theme-picker" },
      { kind: "next", label: "Next" },
    ],
  },
  {
    title: "Templates, snippets, tags",
    body:
      "Workflow templates start agents with battle-tested prompts. Snippets " +
      "recall saved prompts with `/`. Tags color-code your sidebar.",
    actions: [{ kind: "next", label: "Next" }],
  },
  {
    title: "Plan mode + diff viewer + costs",
    body:
      "Toggle plan mode to make an agent propose before acting. Edits render " +
      "as inline diffs. Token costs track per-thread.",
    actions: [{ kind: "finish", label: "Start building" }],
  },
];

export function initTour(state) {
  let armed = false;

  function maybeShow() {
    if (armed) return;
    const s = state.get().settings;
    if (!s) return;
    if (s.onboarded === false) return; // wizard handles first-run
    if (s.tourSeenVersion === VERSION) return;
    armed = true;
    setTimeout(() => showTour(state), 600);
  }

  maybeShow();
  const unsub = state.subscribe(() => maybeShow());
  // Allow re-launch from command palette / settings even after dismiss.
  window.addEventListener("iris:show-tour", () => showTour(state));
  // Best-effort cleanup if state ever unmounts (it doesn't today, but cheap).
  return () => { try { unsub(); } catch {} };
}

export function showTour(state) {
  if (document.querySelector(".tour-overlay")) return;

  let idx = 0;

  const overlay = h("div", { class: "tour-overlay" });
  const card = h("div", { class: "tour-card" });
  overlay.append(card);

  async function markSeen() {
    try { await state.actions.saveSettings({ tourSeenVersion: VERSION }); }
    catch {}
  }

  function close({ markFinished = true } = {}) {
    overlay.classList.add("closing");
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    if (markFinished) markSeen();
  }

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onKey, true);

  function render() {
    const step = STEPS[idx];
    card.innerHTML = "";
    card.style.animation = "none";
    // Re-trigger the fade-in keyframe by forcing reflow.
    // eslint-disable-next-line no-unused-expressions
    card.offsetHeight;
    card.style.animation = "";

    const meta = h("div", { class: "tour-meta" }, `Step ${idx + 1} of ${STEPS.length}`);

    const progress = h("div", { class: "tour-progress" });
    const bar = h("div", { class: "tour-progress-bar" });
    bar.style.width = `${((idx + 1) / STEPS.length) * 100}%`;
    progress.append(bar);

    const title = h("div", { class: "tour-title" }, step.title);
    const body = h("div", { class: "tour-body" }, step.body);

    const actions = h("div", { class: "tour-actions" });
    for (const a of step.actions) {
      const isPrimary = a.kind === "next" || a.kind === "finish" || a.kind === "fire";
      const btn = h("button", {
        class: `btn ${isPrimary ? "btn-primary" : "btn-ghost"}`,
        type: "button",
      }, a.label);
      btn.addEventListener("click", () => {
        if (a.kind === "skip") close();
        else if (a.kind === "next") {
          idx = Math.min(STEPS.length - 1, idx + 1);
          render();
        } else if (a.kind === "finish") {
          close();
        } else if (a.kind === "fire") {
          try { window.dispatchEvent(new CustomEvent(a.event)); } catch {}
          // Advance after firing so the user lands back on the tour.
          idx = Math.min(STEPS.length - 1, idx + 1);
          render();
        }
      });
      actions.append(btn);
    }

    card.append(meta, progress, title, body, actions);
  }

  render();
  document.body.append(overlay);
}

// ═══════════════════════════════════════════════════════════
// plan-mode.js — Per-agent "plan first, then act" toggle
// ═══════════════════════════════════════════════════════════
//
// Mirrors Claude Code's native plan mode: when ON for a worker, the next CLI
// turn spawns with `--permission-mode plan`, which restricts the agent to
// read-only tools (Read/Glob/Grep/WebFetch/WebSearch) and exposes the
// ExitPlanMode tool the agent uses to present its plan.
//
// State lives in settings.planModeByAgent: { [agentId]: boolean } and is read
// by lib/agent-manager.js when building spawn args — there's no client-side
// prompt prefix or wrapping anymore.
//
// UI surface area:
//   - chat-header pill (`.plan-pill`) toggles state
//   - banner across the top of the chat (`.plan-banner`) makes the state
//     unmistakable, with an Exit button right there
//   - command-palette: toggle for this thread + nuclear "clear all"
//   - global hotkey: Ctrl/Cmd + Shift + M
//   - ExitPlanMode tool card gets the approval treatment via renderPlanCard()
//     (used by chat-view.js when rendering tool cards)

import { h, svgIcon, showToast } from "./util.js";
import { renderMarkdown } from "../lib/markdown.js";

function getPlanMap(state) {
  const s = state.get().settings || {};
  return s.planModeByAgent && typeof s.planModeByAgent === "object" ? s.planModeByAgent : {};
}

export function isPlanOn(state, agentId) {
  return !!getPlanMap(state)[agentId];
}

async function setPlan(state, agentId, on) {
  const m = { ...getPlanMap(state) };
  if (on) m[agentId] = true;
  else delete m[agentId];
  await state.actions.saveSettings({ planModeByAgent: m });
}

export async function togglePlanMode(state, agentId) {
  const id = agentId || state.get().activeId;
  if (!id || id === "iris") {
    showToast("Plan mode applies to worker threads, not Iris", { error: true });
    return null;
  }
  const next = !isPlanOn(state, id);
  await setPlan(state, id, next);
  showToast(next ? "Plan mode ON — agent will plan before acting" : "Plan mode OFF");
  return next;
}

export async function clearAllPlanModes(state) {
  await state.actions.saveSettings({ planModeByAgent: {} });
  showToast("Plan mode turned OFF for every thread");
}

/**
 * User approved the plan. Turn plan mode OFF for the thread (so the next
 * spawn drops --permission-mode plan and the agent regains write tools) and
 * send a short continuation prompt so the agent can begin executing.
 */
export async function approvePlan(state, agentId) {
  const id = agentId || state.get().activeId;
  if (!id) return;
  await setPlan(state, id, false);
  showToast("Plan approved — agent has write access for the next turn");
  state.actions.sendMessage("Approved. Proceed with the plan.", id);
}

/**
 * User wants the agent to keep refining. Plan mode stays ON; we just nudge
 * the agent to revise. If `feedback` is provided, it's appended.
 */
export function keepPlanning(state, agentId, feedback) {
  const id = agentId || state.get().activeId;
  if (!id) return;
  const fb = (feedback || "").trim();
  const msg = fb
    ? `Keep planning. Refine the plan with this feedback: ${fb}`
    : "Keep planning — refine the plan before we execute.";
  state.actions.sendMessage(msg, id);
}

export function initPlanMode(state) {
  // Decorate the chat header with the toggle pill, and mount the persistent
  // banner above the chat scroll. The chat view re-mounts when the active
  // thread changes, so we observe DOM and re-decorate idempotently.
  const observer = new MutationObserver(() => decorate(state));
  observer.observe(document.body, { childList: true, subtree: true });

  state.subscribe(() => decorate(state));

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "m") {
      e.preventDefault();
      togglePlanMode(state);
    }
  });

  decorate(state);
}

function decorate(state) {
  decoratePill(state);
  decorateBanner(state);
}

function decoratePill(state) {
  const headerSub = document.querySelector(".chat-header-sub");
  if (!headerSub) return;
  const activeId = state.get().activeId;
  if (!activeId || activeId === "iris") {
    const existing = headerSub.querySelector(".plan-pill");
    if (existing) existing.remove();
    return;
  }

  let pill = headerSub.querySelector(".plan-pill");
  if (!pill) {
    pill = h("button", { class: "plan-pill", type: "button", title: "Plan mode — agent proposes a plan before acting" });
    pill.append(svgIcon("check", 11), h("span", { class: "plan-pill-label" }, "Plan"));
    pill.addEventListener("click", async () => {
      await togglePlanMode(state);
      decorate(state);
    });
    headerSub.append(pill);
  }
  const on = isPlanOn(state, activeId);
  pill.classList.toggle("on", on);
  pill.title = on
    ? "Plan mode is ON — click to disable"
    : "Plan mode is OFF — click to require a plan before acting";
}

function decorateBanner(state) {
  const chatView = document.querySelector(".chat-view");
  if (!chatView) return;
  const activeId = state.get().activeId;
  const on = activeId && activeId !== "iris" && isPlanOn(state, activeId);

  let banner = chatView.querySelector(":scope > .plan-banner");
  if (!on) {
    if (banner) banner.remove();
    return;
  }
  if (!banner) {
    banner = h("div", { class: "plan-banner", role: "status" });
    const icon = h("div", { class: "plan-banner-icon" }, svgIcon("check", 14));
    const text = h("div", { class: "plan-banner-text" },
      h("div", { class: "plan-banner-title" }, "Plan mode"),
      h("div", { class: "plan-banner-sub" }, "Agent is read-only. It will explore the codebase, propose a plan, and wait for your approval before changing anything."),
    );
    const exitBtn = h("button", { class: "plan-banner-exit", type: "button", title: "Turn plan mode off for this thread" }, "Exit plan mode");
    exitBtn.addEventListener("click", () => togglePlanMode(state));
    banner.append(icon, text, exitBtn);
    // Mount between the header and the scroll feed.
    const header = chatView.querySelector(":scope > .chat-header");
    if (header && header.nextSibling) chatView.insertBefore(banner, header.nextSibling);
    else chatView.prepend(banner);
  }
}

// ── ExitPlanMode tool card renderer ──────────────────────────
// Called by chat-view.js renderToolCard when t.name === "ExitPlanMode".
// Renders the proposed plan as readable markdown with Approve / Keep
// planning actions. The state arg is optional during cold renders (replays
// from messagesByAgent on tab switch) — when missing, the buttons are still
// rendered but they no-op so we don't crash the render path.

export function isExitPlanModeTool(t) {
  return t && (t.name === "ExitPlanMode" || t.name === "exit_plan_mode");
}

export function renderPlanCard(t, opts) {
  const state = opts && opts.state;
  const agentId = (opts && opts.agentId) || (state ? state.get().activeId : null);
  const planText = (t.input && typeof t.input === "object" && typeof t.input.plan === "string")
    ? t.input.plan
    : (typeof t.input === "string" ? t.input : "");

  const card = h("div", { class: "tool-card plan-card open" });
  if (t.useId) card.dataset.useId = t.useId;

  const head = h("div", { class: "plan-card-head" });
  const icon = h("div", { class: "plan-card-icon" }, svgIcon("check", 14));
  const title = h("div", { class: "plan-card-title" }, "Proposed plan");
  const status = t.status === "done"
    ? h("div", { class: "plan-card-status" }, "ready for approval")
    : h("div", { class: "plan-card-status pulsing" }, "writing plan…");
  head.append(icon, title, status);

  const body = h("div", { class: "plan-card-body" });
  if (planText) {
    body.innerHTML = renderMarkdown(planText);
  } else {
    body.append(h("div", { class: "plan-card-empty" }, "Plan is empty — keep planning to add detail."));
  }

  const actions = h("div", { class: "plan-card-actions" });
  const approveBtn = h("button", { class: "btn btn-primary plan-approve", type: "button" });
  approveBtn.append(svgIcon("check", 12), h("span", null, "Approve & run"));
  const keepBtn = h("button", { class: "btn plan-keep", type: "button" }, "Keep planning");
  approveBtn.addEventListener("click", () => {
    if (!state || !agentId) return;
    approveBtn.disabled = true;
    keepBtn.disabled = true;
    approvePlan(state, agentId);
  });
  keepBtn.addEventListener("click", () => {
    if (!state || !agentId) return;
    keepBtn.disabled = true;
    approveBtn.disabled = true;
    keepPlanning(state, agentId);
  });
  actions.append(approveBtn, keepBtn);

  card.append(head, body, actions);
  return card;
}

/**
 * Patch an existing plan card in place. Mirrors chat-view's patchToolCard
 * pattern: never rebuild, only update what changed. Called by chat-view's
 * reconciler each streaming tick.
 */
export function patchPlanCard(card, t) {
  if (!card) return;
  const planText = (t.input && typeof t.input === "object" && typeof t.input.plan === "string")
    ? t.input.plan
    : (typeof t.input === "string" ? t.input : "");

  // Status pill toggles "writing plan…" → "ready for approval" when t.status flips.
  const status = card.querySelector(".plan-card-status");
  if (status) {
    const want = t.status === "done" ? "ready for approval" : "writing plan…";
    if (status.textContent !== want) status.textContent = want;
    status.classList.toggle("pulsing", t.status !== "done");
  }

  // Body markdown: re-parse only when text changed (renderMarkdown isn't free).
  const body = card.querySelector(".plan-card-body");
  if (body && body.dataset.lastPlan !== planText) {
    if (planText) {
      body.innerHTML = renderMarkdown(planText);
    } else {
      body.innerHTML = "";
      body.append(h("div", { class: "plan-card-empty" }, "Plan is empty — keep planning to add detail."));
    }
    body.dataset.lastPlan = planText;
  }
}

// ═══════════════════════════════════════════════════════════
// cost-tracker.js — Per-agent token accounting. Reads `usage`
// from result events, decorates the chat header with a pill
// (with a budget progress overlay when set), persists a running
// global total every 5 turns, and reacts to the agent manager's
// cost:warn / cost:exceeded events to surface a toast/modal.
// ═══════════════════════════════════════════════════════════

import { h, openModal, showToast } from "./util.js";

const PERSIST_EVERY = 5;

function formatTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(1) + "k";
  return (n / 1e6).toFixed(2) + "M";
}

function formatUsd(n) {
  if (!Number.isFinite(n)) return "$0.00";
  if (n < 0.005) return "$" + n.toFixed(4);
  if (n < 1) return "$" + n.toFixed(3);
  return "$" + n.toFixed(2);
}

function emptyCost() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheCreate: 0,
    turnCount: 0,
    lastTurnMs: 0,
    // v0.5 Feature 5 — running session USD (authoritative source = main process
    // cost:session events; this is just the latest broadcast value).
    sessionUsd: 0,
  };
}

export function initCostTracker(state) {
  /** @type {Map<string, ReturnType<typeof emptyCost>>} */
  const costs = new Map();
  let sincePersist = 0;
  let pill = null;
  // Tracked agent id for the currently-rendered pill so we only repaint
  // when the active thread changes or when its own row changes.
  let pillFor = null;
  let lastPillSig = "";
  // Suppresses a duplicate "exceeded" modal when multiple events fire on the
  // same agent in quick succession.
  const modalOpenFor = new Set();

  function record(event) {
    if (!event) return;
    const id = event.id;
    if (!id) return;
    if (event.type === "result") {
      const u = event.usage || {};
      const c = costs.get(id) || emptyCost();
      c.inputTokens += Number(u.input_tokens || 0);
      c.outputTokens += Number(u.output_tokens || 0);
      c.cacheRead += Number(u.cache_read_input_tokens || 0);
      c.cacheCreate += Number(u.cache_creation_input_tokens || 0);
      c.turnCount += 1;
      if (Number.isFinite(event.durationMs)) c.lastTurnMs = event.durationMs;
      costs.set(id, c);

      sincePersist += 1;
      if (sincePersist >= PERSIST_EVERY) {
        sincePersist = 0;
        persistTotals();
      }
      updatePill();
      return;
    }
    if (event.type === "cost:session") {
      const c = costs.get(id) || emptyCost();
      c.sessionUsd = Number(event.currentUsd) || 0;
      costs.set(id, c);
      updatePill();
      return;
    }
    if (event.type === "cost:warn") {
      const agent = state.get().agents.find((a) => a.id === id);
      const name = agent ? agent.name : "Thread";
      showToast(
        `${name} is at 80% of its ${formatUsd(event.budgetUsd)} budget ` +
        `(${formatUsd(event.currentUsd)} so far).`,
        { duration: 4500 },
      );
      // Mirror the value into our local store so the pill turns orange.
      const c = costs.get(id) || emptyCost();
      c.sessionUsd = Number(event.currentUsd) || c.sessionUsd;
      costs.set(id, c);
      updatePill();
      return;
    }
    if (event.type === "cost:exceeded") {
      const c = costs.get(id) || emptyCost();
      c.sessionUsd = Number(event.currentUsd) || c.sessionUsd;
      costs.set(id, c);
      updatePill();
      if (!modalOpenFor.has(id)) {
        modalOpenFor.add(id);
        showBudgetExceededModal(state, id, event)
          .finally(() => modalOpenFor.delete(id));
      }
      return;
    }
  }

  function persistTotals() {
    let totalIn = 0, totalOut = 0, cacheR = 0, cacheC = 0, turns = 0;
    for (const c of costs.values()) {
      totalIn += c.inputTokens;
      totalOut += c.outputTokens;
      cacheR += c.cacheRead;
      cacheC += c.cacheCreate;
      turns += c.turnCount;
    }
    const totalUsage = {
      inputTokens: totalIn,
      outputTokens: totalOut,
      cacheRead: cacheR,
      cacheCreate: cacheC,
      turnCount: turns,
      updatedAt: Date.now(),
    };
    try { state.actions.saveSettings({ totalUsage }); } catch {}
  }

  function ensurePill() {
    // The chat-header-sub element is rebuilt whenever the chat view remounts,
    // so we re-attach if our pill has gone missing.
    const host = document.querySelector(".chat-header-sub");
    if (!host) return null;
    if (pill && pill.isConnected && pill.parentNode === host) return pill;
    pill = document.createElement("span");
    pill.className = "cost-pill";
    // Inline styling for the progress bar overlay — kept here so we don't
    // need to touch the global stylesheet for one tiny v0.5 visual.
    pill.style.position = "relative";
    pill.style.overflow = "hidden";
    // Bar element — width set dynamically based on usd/budget.
    const bar = document.createElement("span");
    bar.className = "cost-pill-bar";
    bar.style.position = "absolute";
    bar.style.left = "0";
    bar.style.bottom = "0";
    bar.style.height = "2px";
    bar.style.width = "0%";
    bar.style.background = "currentColor";
    bar.style.opacity = "0.0";
    bar.style.pointerEvents = "none";
    bar.style.transition = "width 240ms ease, background 200ms ease";
    pill.append(bar);
    host.append(pill);
    return pill;
  }

  function updatePill() {
    const activeId = state.get().activeId;
    const p = ensurePill();
    if (!p) return;
    if (!activeId || activeId === "iris") {
      // Wipe text but leave the bar element in place.
      for (const node of [...p.childNodes]) {
        if (!(node instanceof Element) || !node.classList.contains("cost-pill-bar")) p.removeChild(node);
      }
      pillFor = null;
      lastPillSig = "";
      paintBar(p, 0, 0);
      return;
    }
    const c = costs.get(activeId);
    if (!c || (c.turnCount === 0 && !c.sessionUsd)) {
      for (const node of [...p.childNodes]) {
        if (!(node instanceof Element) || !node.classList.contains("cost-pill-bar")) p.removeChild(node);
      }
      pillFor = activeId;
      lastPillSig = "";
      paintBar(p, 0, 0);
      return;
    }
    const agent = state.get().agents.find((a) => a.id === activeId) || {};
    const budget = typeof agent.costBudgetUsd === "number" ? agent.costBudgetUsd : 0;
    const sig = `${c.inputTokens}|${c.outputTokens}|${c.turnCount}|${c.sessionUsd.toFixed(4)}|${budget}`;
    if (pillFor === activeId && sig === lastPillSig) return;
    pillFor = activeId;
    lastPillSig = sig;

    // Re-render text content (preserving the bar overlay element).
    for (const node of [...p.childNodes]) {
      if (!(node instanceof Element) || !node.classList.contains("cost-pill-bar")) p.removeChild(node);
    }
    const frag = document.createDocumentFragment();
    frag.append(
      document.createTextNode(formatTokens(c.inputTokens) + " in"),
      span("sep", " · "),
      document.createTextNode(formatTokens(c.outputTokens) + " out"),
      span("sep", " · "),
      document.createTextNode(`${c.turnCount} turn${c.turnCount === 1 ? "" : "s"}`),
    );
    if (c.sessionUsd > 0) {
      frag.append(
        span("sep", " · "),
        document.createTextNode(
          budget > 0
            ? `${formatUsd(c.sessionUsd)} / ${formatUsd(budget)}`
            : formatUsd(c.sessionUsd),
        ),
      );
    }
    // Insert text BEFORE the bar element (which is the last child) so the bar
    // sits behind the text visually.
    const bar = p.querySelector(".cost-pill-bar");
    if (bar) p.insertBefore(frag, bar);
    else p.append(frag);
    paintBar(p, c.sessionUsd, budget);
  }

  // Color the progress bar overlay: green <70%, orange 70-100%, red >100%.
  function paintBar(pillEl, usd, budget) {
    const bar = pillEl.querySelector(".cost-pill-bar");
    if (!bar) return;
    if (!budget || budget <= 0) {
      bar.style.width = "0%";
      bar.style.opacity = "0";
      return;
    }
    const pct = Math.max(0, usd / budget);
    bar.style.width = Math.min(100, pct * 100).toFixed(1) + "%";
    bar.style.opacity = "0.9";
    if (pct >= 1) {
      bar.style.background = "#ff6464";
    } else if (pct >= 0.7) {
      bar.style.background = "#ffb060";
    } else {
      bar.style.background = "#5fd49a";
    }
  }

  function span(cls, text) {
    const s = document.createElement("span");
    s.className = cls;
    s.textContent = text;
    return s;
  }

  // Subscribe to broadcast events. Be defensive — the IPC bridge may not be
  // available in stub mode.
  try {
    window.iris?.onAgentEvent?.((event) => record(event));
  } catch (e) {
    console.warn("[cost-tracker] onAgentEvent subscribe failed", e);
  }

  // Watch for chat header to (re)appear after view swaps.
  const mo = new MutationObserver(() => updatePill());
  if (document.body) {
    mo.observe(document.body, { subtree: true, childList: true });
  }

  // Active-thread changes should refresh the pill text.
  state.subscribe(() => updatePill());

  // Public probe for other modules / debugging.
  window.__iris_costs_for = (id) => costs.get(id) || null;
}

// ── Modal: budget exceeded ────────────────────────────────
// Three buttons: Raise budget · Continue once · Stop agent.
function showBudgetExceededModal(state, agentId, evt) {
  return new Promise((resolve) => {
    const agent = state.get().agents.find((a) => a.id === agentId) || {};
    const name = agent.name || "Thread";

    const modal = h("div", { class: "modal", style: { width: "min(440px, calc(100vw - 32px))" } });

    const header = h("div", { class: "modal-header" });
    header.append(
      h("div", { class: "modal-title" }, "Cost budget reached"),
      h("button", { class: "modal-close", "aria-label": "Close" }, "✕"),
    );

    const body = h("div", { class: "modal-body" });
    body.append(
      h("p", null,
        `"${name}" has reached ${formatUsd(evt.currentUsd)} — `,
        `over its configured ceiling of ${formatUsd(evt.budgetUsd)}. `,
        `Decide what to do before sending another turn.`,
      ),
      h("p", { class: "hint" },
        "Raising the budget resets the warning so you won't be prompted again until the new ceiling is crossed.",
      ),
    );

    const raiseRow = h("div", {
      style: {
        display: "none",
        gap: "8px",
        marginTop: "10px",
        alignItems: "center",
      },
    });
    const raiseInput = h("input", {
      class: "input",
      type: "number",
      min: "0",
      step: "0.01",
      placeholder: "New ceiling, e.g. 10.00",
      style: { flex: "1" },
    });
    const raiseSubmit = h("button", { class: "btn btn-primary", type: "button" }, "Apply");
    raiseRow.append(raiseInput, raiseSubmit);
    body.append(raiseRow);

    const footer = h("div", { class: "modal-footer" });
    const raiseBtn = h("button", { class: "btn btn-ghost", type: "button" }, "Raise budget…");
    const continueBtn = h("button", { class: "btn btn-ghost", type: "button" }, "Continue once");
    const stopBtn = h("button", { class: "btn btn-danger", type: "button" }, "Stop agent");
    footer.append(raiseBtn, continueBtn, stopBtn);

    modal.append(header, body, footer);
    const { close } = openModal(modal, { onClose: () => resolve() });
    header.querySelector(".modal-close").addEventListener("click", () => { close(); resolve(); });

    raiseBtn.addEventListener("click", () => {
      raiseRow.style.display = "flex";
      raiseInput.focus();
    });

    raiseSubmit.addEventListener("click", async () => {
      const v = Number(raiseInput.value);
      if (!Number.isFinite(v) || v <= 0) {
        showToast("Enter a positive number", { error: true });
        return;
      }
      try {
        await state.actions.updateAgent(agentId, { costBudgetUsd: v });
        showToast(`Budget raised to ${formatUsd(v)}`);
        close();
        resolve();
      } catch (e) {
        showToast("Couldn't update budget: " + (e.message || e), { error: true });
      }
    });

    continueBtn.addEventListener("click", async () => {
      // Persist a per-agent "skip next warn" flag so a follow-up turn doesn't
      // re-trigger the modal. The renderer also locally bumps the agent's
      // costBudgetUsd by `currentUsd - budgetUsd + 0.01` so the next turn
      // doesn't immediately re-cross the threshold; the user can re-enable
      // budget enforcement by editing it back later.
      try {
        const s = state.get().settings || {};
        const prev = s.agentBudgetSkipByAgent || {};
        await state.actions.saveSettings({
          agentBudgetSkipByAgent: { ...prev, [agentId]: true },
        });
        showToast("Will warn again on the next budget crossing.");
        close();
        resolve();
      } catch (e) {
        showToast("Couldn't save preference: " + (e.message || e), { error: true });
      }
    });

    stopBtn.addEventListener("click", () => {
      try { window.iris?.stopAgent?.(agentId); } catch {}
      showToast("Agent stopped.");
      close();
      resolve();
    });
  });
}

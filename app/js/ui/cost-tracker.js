// ═══════════════════════════════════════════════════════════
// cost-tracker.js — Per-agent token accounting. Reads `usage`
// from result events, decorates the chat header with a pill,
// persists a running global total every 5 turns.
// ═══════════════════════════════════════════════════════════

const PERSIST_EVERY = 5;

function formatTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(1) + "k";
  return (n / 1e6).toFixed(2) + "M";
}

function emptyCost() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheCreate: 0,
    turnCount: 0,
    lastTurnMs: 0,
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

  function record(event) {
    if (!event || event.type !== "result") return;
    const id = event.id;
    if (!id) return;
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
    host.append(pill);
    return pill;
  }

  function updatePill() {
    const activeId = state.get().activeId;
    const p = ensurePill();
    if (!p) return;
    if (!activeId || activeId === "iris") {
      if (p.textContent !== "") p.textContent = "";
      pillFor = null;
      lastPillSig = "";
      return;
    }
    const c = costs.get(activeId);
    if (!c || c.turnCount === 0) {
      if (p.textContent !== "") p.textContent = "";
      pillFor = activeId;
      lastPillSig = "";
      return;
    }
    const sig = `${c.inputTokens}|${c.outputTokens}|${c.turnCount}`;
    if (pillFor === activeId && sig === lastPillSig) return;
    pillFor = activeId;
    lastPillSig = sig;

    p.innerHTML = "";
    p.append(
      document.createTextNode(formatTokens(c.inputTokens) + " in"),
      span("sep", " · "),
      document.createTextNode(formatTokens(c.outputTokens) + " out"),
      span("sep", " · "),
      document.createTextNode(`${c.turnCount} turn${c.turnCount === 1 ? "" : "s"}`),
    );
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

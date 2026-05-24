// ═══════════════════════════════════════════════════════════
// pinning.js — Pin/star agents in the sidebar
// ═══════════════════════════════════════════════════════════

function getPinned(state) {
  const s = state.get().settings || {};
  return Array.isArray(s.pinnedAgentIds) ? s.pinnedAgentIds : [];
}

function isPinned(state, id) {
  return getPinned(state).includes(id);
}

async function togglePin(state, id) {
  if (!id || id === "iris") return;
  const cur = getPinned(state);
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  await state.actions.saveSettings({ pinnedAgentIds: next });
}

// Track which agent ids were pinned last decoration so we only reorder when
// pin state actually changes.
const lastPinState = new Map();

function decorate(state) {
  const pinnedSet = new Set(getPinned(state));
  const items = document.querySelectorAll(".sb-item");

  // Group items by parent so we only reorder within each group. We reorder
  // whenever a parent contains a pinned item whose DOM is freshly built
  // (no .pinned class yet) OR whose pin state diverges from our last record.
  const dirtyParents = new Set();

  items.forEach((item) => {
    const id = item.getAttribute("data-id");
    if (!id) return;
    const shouldPin = pinnedSet.has(id) && id !== "iris";
    const wasPinned = !!lastPinState.get(id);
    const isCurrent = item.classList.contains("pinned");

    // Detect freshly-rebuilt sidebar items (class is missing but state says pinned).
    const needsReorder = (shouldPin !== wasPinned) || (shouldPin && !isCurrent);

    if (shouldPin) {
      if (!isCurrent) item.classList.add("pinned");
      let badge = item.querySelector(":scope > .pin-badge");
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "pin-badge";
        badge.title = "Unpin";
        badge.textContent = "★";
        badge.addEventListener("click", (e) => {
          e.stopPropagation();
          togglePin(state, id);
        });
        item.prepend(badge);
      }
    } else {
      if (isCurrent) item.classList.remove("pinned");
      const badge = item.querySelector(":scope > .pin-badge");
      if (badge) badge.remove();
    }

    lastPinState.set(id, shouldPin);
    if (needsReorder && shouldPin && item.parentElement) {
      dirtyParents.add(item.parentElement);
    }
  });

  // For every parent that gained a newly-pinned item, hoist all its pinned
  // children to the top (preserving relative order among themselves).
  for (const parent of dirtyParents) {
    const pinned = Array.from(parent.querySelectorAll(":scope > .sb-item.pinned"));
    // Reverse so prepending one-by-one preserves the original order.
    for (let i = pinned.length - 1; i >= 0; i--) {
      parent.prepend(pinned[i]);
    }
  }
}

export function initPinning(state) {
  // Globally callable helpers — the sidebar context menu wires through these.
  window.__iris_isPinned = (id) => isPinned(state, id);
  window.__iris_togglePin = (id) => togglePin(state, id);

  // Re-decorate on every state change. Sidebar rebuilds frequently and items
  // get patched in place; this catches every variant cheaply since the work
  // is just attribute / classList tweaks unless something actually changed.
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      try { decorate(state); } catch (e) { console.error("[pinning] decorate", e); }
    });
  }
  state.subscribe(schedule);
  // Initial pass once DOM is ready
  schedule();
}

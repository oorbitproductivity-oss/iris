// app/js/ui/hotkey-conflicts.js
//
// Surfaced when main-process hotkey validation detects a conflict — either
// the user's chosen accelerator was already claimed by the OS/another app,
// or two Iris hotkeys collide. The main process auto-falls-back to a
// working alternate so the feature stays alive; this UI lets the user
// either accept that auto-pick or choose a different one from a short list
// of pre-validated candidates.

import { h, openModal, showToast } from "./util.js";

let bannerEl = null;
let pendingConflicts = null;

export function initHotkeyConflicts() {
  if (!window.iris || typeof window.iris.onHotkeyConflicts !== "function") return;
  window.iris.onHotkeyConflicts((payload) => {
    const conflicts = payload && Array.isArray(payload.conflicts) ? payload.conflicts : [];
    if (conflicts.length === 0) return;
    pendingConflicts = conflicts;
    showBanner(conflicts);
  });
}

function showBanner(conflicts) {
  if (bannerEl) bannerEl.remove();

  const banner = h("div", { class: "hotkey-banner" });
  const icon = h("div", { class: "hotkey-banner-icon" }, "⌘");
  const text = h("div", { class: "hotkey-banner-text" });
  const summary = conflicts.length === 1
    ? `Hotkey conflict for "${conflicts[0].label}"`
    : `${conflicts.length} hotkey conflicts detected`;
  text.append(
    h("div", { class: "hotkey-banner-title" }, summary),
    h("div", { class: "hotkey-banner-sub" },
      conflicts.some(c => c.autoPicked)
        ? "Auto-switched to a working alternate. Click to review."
        : "Some shortcuts couldn't be assigned. Click to resolve."),
  );
  const actions = h("div", { class: "hotkey-banner-actions" });
  const reviewBtn = h("button", { class: "hotkey-banner-btn primary", type: "button" }, "Review");
  const dismissBtn = h("button", { class: "hotkey-banner-btn", type: "button", "aria-label": "Dismiss" });
  dismissBtn.innerHTML = `<svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3.5 3.5 L10.5 10.5 M10.5 3.5 L3.5 10.5"/></svg>`;
  actions.append(reviewBtn, dismissBtn);

  banner.append(icon, text, actions);
  document.body.append(banner);
  bannerEl = banner;

  // Small entrance animation handled by CSS — just mount it.
  reviewBtn.addEventListener("click", () => {
    openResolutionModal(conflicts);
    dismissBanner();
  });
  dismissBtn.addEventListener("click", dismissBanner);
}

function dismissBanner() {
  if (!bannerEl) return;
  bannerEl.classList.add("dismiss");
  const el = bannerEl;
  bannerEl = null;
  setTimeout(() => { try { el.remove(); } catch {} }, 220);
}

function openResolutionModal(conflicts) {
  const root = h("div", { class: "modal hotkey-modal" });

  const header = h("div", { class: "hotkey-modal-header" });
  header.append(
    h("h3", null, "Resolve hotkey conflicts"),
    h("p", { class: "hotkey-modal-sub" },
      "Iris auto-picked a working alternate so nothing breaks. " +
      "You can accept it, choose another, or recheck after closing the conflicting app."),
  );
  root.append(header);

  for (const c of conflicts) {
    root.append(renderConflictRow(c));
  }

  const footer = h("div", { class: "hotkey-modal-footer" });
  const recheckBtn = h("button", { class: "btn btn-ghost", type: "button" }, "Re-check");
  const doneBtn = h("button", { class: "btn btn-primary", type: "button" }, "Done");
  footer.append(recheckBtn, doneBtn);
  root.append(footer);

  const { close } = openModal(root);

  recheckBtn.addEventListener("click", async () => {
    try {
      await window.iris.hotkeyRecheck();
      close();
      showToast("Re-checking hotkeys…");
    } catch (err) {
      showToast("Re-check failed: " + (err.message || err), { error: true });
    }
  });
  doneBtn.addEventListener("click", () => close());
}

function renderConflictRow(c) {
  const row = h("div", { class: "hotkey-conflict-row" });

  const head = h("div", { class: "hotkey-conflict-head" });
  head.append(
    h("div", { class: "hotkey-conflict-label" }, c.label || c.id),
    h("div", { class: "hotkey-conflict-reason" }, c.reason || "could not register"),
  );
  row.append(head);

  const attempted = h("div", { class: "hotkey-conflict-line" });
  attempted.append(
    h("span", { class: "hotkey-conflict-line-key" }, "You tried"),
    renderAccelerator(c.attempted, { strike: true }),
  );
  row.append(attempted);

  if (c.autoPicked) {
    const auto = h("div", { class: "hotkey-conflict-line auto" });
    auto.append(
      h("span", { class: "hotkey-conflict-line-key" }, "Now using"),
      renderAccelerator(c.autoPicked, { highlighted: true }),
    );
    row.append(auto);
  }

  if (Array.isArray(c.candidates) && c.candidates.length > 0) {
    const choices = h("div", { class: "hotkey-conflict-choices" });
    choices.append(h("div", { class: "hotkey-conflict-choices-label" }, "Or pick another:"));
    const list = h("div", { class: "hotkey-conflict-choice-list" });
    for (const cand of c.candidates) {
      const btn = h("button", { class: "hotkey-conflict-choice", type: "button" });
      btn.append(renderAccelerator(cand));
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          const res = await window.iris.hotkeySet(c.id, cand);
          if (res && res.ok) {
            btn.classList.add("applied");
            showToast(`${c.label}: ${cand}`);
            // Update the "Now using" line in place.
            const autoLine = row.querySelector(".hotkey-conflict-line.auto");
            if (autoLine) {
              autoLine.innerHTML = "";
              autoLine.append(
                h("span", { class: "hotkey-conflict-line-key" }, "Now using"),
                renderAccelerator(cand, { highlighted: true }),
              );
            } else {
              const inserted = h("div", { class: "hotkey-conflict-line auto" });
              inserted.append(
                h("span", { class: "hotkey-conflict-line-key" }, "Now using"),
                renderAccelerator(cand, { highlighted: true }),
              );
              row.insertBefore(inserted, choices);
            }
          } else {
            btn.disabled = false;
            showToast("Couldn't apply: " + (res && res.error || "unknown"), { error: true });
          }
        } catch (err) {
          btn.disabled = false;
          showToast("Apply failed: " + (err.message || err), { error: true });
        }
      });
      list.append(btn);
    }
    choices.append(list);
    row.append(choices);
  }

  return row;
}

function renderAccelerator(accel, { strike = false, highlighted = false } = {}) {
  const wrap = h("span", { class: `accel${strike ? " strike" : ""}${highlighted ? " highlighted" : ""}` });
  if (!accel) {
    wrap.append(h("span", { class: "kbd" }, "—"));
    return wrap;
  }
  const parts = String(accel).split("+");
  parts.forEach((p, i) => {
    wrap.append(h("span", { class: "kbd" }, prettyKey(p)));
    if (i < parts.length - 1) wrap.append(h("span", { class: "accel-plus" }, "+"));
  });
  return wrap;
}

function prettyKey(k) {
  const lookup = {
    "CommandOrControl": navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl",
    "Command": "⌘",
    "Control": "Ctrl",
    "Ctrl": "Ctrl",
    "Shift": "Shift",
    "Alt": navigator.platform.toLowerCase().includes("mac") ? "⌥" : "Alt",
    "Option": "⌥",
    "Space": "Space",
    "Period": ".",
    "PrintScreen": "PrtSc",
  };
  return lookup[k] || k;
}

// ═══════════════════════════════════════════════════════════
// update-banner.js — Background check for a newer version
// ═══════════════════════════════════════════════════════════
//
// On boot, queries window.iris.checkForUpdates() (which hits the marketing
// site's latest.json). If a newer version is available AND the user hasn't
// already dismissed this version, shows a small banner pinned to the bottom
// of the window with a "What's new" link + "Download" + "Dismiss".

import { h, svgIcon } from "./util.js";

const DISMISS_KEY = "updateDismissedVersion";

export function initUpdateCheck(state) {
  if (typeof window === "undefined" || !window.iris?.checkForUpdates) return;

  // Stagger the check so it doesn't pile on top of the boot sequence.
  setTimeout(async () => {
    let res;
    try {
      res = await window.iris.checkForUpdates();
    } catch {
      return;
    }
    if (!res || !res.ok || !res.hasUpdate) return;

    const dismissed = (state.get().settings || {})[DISMISS_KEY];
    if (dismissed && dismissed === res.latestVersion) return;

    showBanner(state, res);
  }, 2500);
}

function showBanner(state, info) {
  // Don't double-show.
  if (document.getElementById("iris-update-banner")) return;

  const banner = h("div", { id: "iris-update-banner", class: "update-banner", role: "status" });
  const left = h("div", { class: "update-banner-left" });
  const dot = h("span", { class: "update-banner-dot" });
  const text = h("div", { class: "update-banner-text" });
  text.append(
    h("strong", null, `Iris Code v${info.latestVersion} is available.`),
    h("span", { class: "update-banner-sub" },
      info.notes
        ? truncateNotes(info.notes)
        : `You're on v${info.currentVersion}. Click to see what's new.`),
  );
  left.append(dot, text);

  const actions = h("div", { class: "update-banner-actions" });
  if (info.url) {
    const a = h("button", { class: "btn btn-primary", type: "button" }, "Download");
    a.addEventListener("click", () => {
      try { window.iris?.openExternal?.(info.url); } catch {}
    });
    actions.append(a);
  }
  const dismiss = h("button", { class: "update-banner-x", type: "button", title: "Dismiss" }, svgIcon("x", 12));
  dismiss.addEventListener("click", async () => {
    try { await state.actions.saveSettings({ [DISMISS_KEY]: info.latestVersion }); } catch {}
    banner.remove();
  });
  actions.append(dismiss);

  banner.append(left, actions);
  document.body.append(banner);
}

function truncateNotes(notes) {
  const flat = String(notes).replace(/\s+/g, " ").trim();
  return flat.length > 110 ? flat.slice(0, 110) + "…" : flat;
}

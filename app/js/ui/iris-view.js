// iris-view.js -- Main page welcome / "home" view.
//
// The main center pane shows this when no worker agent is selected.
// Iris chat itself lives in the Spotlight overlay (Ctrl+Shift+I or
// the gold Iris icon top-left of the titlebar). This view is a calm
// landing screen with quick actions.

import { h, svgIcon } from "./util.js";
import { showNewSessionModal } from "./new-session.js";
import { showSettingsModal } from "./settings.js";

function getHotkeyLabel(state) {
  const raw = state.get().settings?.spotlightHotkey || "CommandOrControl+Shift+I";
  const isMac = (window.iris?.platform || "").startsWith("darwin");
  return raw
    .replace(/CommandOrControl/i, isMac ? "Cmd" : "Ctrl")
    .replace(/CmdOrCtrl/i, isMac ? "Cmd" : "Ctrl")
    .replace(/Command/i, "Cmd")
    .replace(/Control/i, "Ctrl")
    .replace(/Alt/i, isMac ? "Option" : "Alt")
    .replace(/\+/g, " + ");
}

export function mountIrisView(rootEl, state) {
  rootEl.innerHTML = "";

  const view = h("div", { class: "home-view" });

  // Hero card
  const hero = h("div", { class: "home-hero" });
  const halo = h("div", { class: "home-halo" });
  const mark = h("div", { class: "home-mark" }, svgIcon("iris", 48));
  halo.append(mark);

  const title = h("h1", { class: "home-title" },
    h("span", { class: "grad" }, "Iris"),
    " is ready.",
  );
  const sub = h("p", { class: "home-sub" },
    "Open Iris from the gold mark in the top-left, or with ",
    h("kbd", { class: "home-kbd" }, "Hotkey"),
    ". Iris coordinates your sub-agents — start one with ",
    h("strong", null, "New session"),
    " on the right.",
  );

  const cta = h("div", { class: "home-cta-row" });
  const ctaOpen = h("button", { class: "btn btn-primary btn-lg" });
  ctaOpen.append(svgIcon("zap", 14), h("span", null, "Open Iris"));
  ctaOpen.addEventListener("click", () => window.__iris_toggle?.());
  const ctaNew = h("button", { class: "btn btn-ghost btn-lg" });
  ctaNew.append(svgIcon("plus", 14), h("span", null, "New session"));
  ctaNew.addEventListener("click", () => showNewSessionModal(state));
  const ctaSettings = h("button", { class: "btn btn-ghost btn-lg" });
  ctaSettings.append(svgIcon("settings", 14), h("span", null, "Settings"));
  ctaSettings.addEventListener("click", () => showSettingsModal(state));
  cta.append(ctaOpen, ctaNew, ctaSettings);

  hero.append(halo, title, sub, cta);
  view.append(hero);

  // Status strip — small live count of running agents
  const strip = h("div", { class: "home-strip" });
  const stripDot = h("div", { class: "home-strip-dot" });
  const stripText = h("span", { class: "home-strip-text" }, "—");
  strip.append(stripDot, stripText);
  view.append(strip);

  rootEl.append(view);

  function render() {
    if (state.get().activeId !== "iris") return;

    const s = state.get();
    const workers = s.agents.filter((a) => a.id !== "iris");
    const running = workers.filter((a) => a.status === "running").length;

    if (workers.length === 0) {
      stripDot.className = "home-strip-dot";
      stripText.textContent = "No sessions yet. Click “New session” to spin one up.";
    } else if (running > 0) {
      stripDot.className = "home-strip-dot running";
      stripText.textContent = `${running} of ${workers.length} session${workers.length === 1 ? "" : "s"} running.`;
    } else {
      stripDot.className = "home-strip-dot idle";
      stripText.textContent = `${workers.length} session${workers.length === 1 ? "" : "s"} idle. Pick one on the right or ask Iris.`;
    }

    // Live hotkey label
    const hk = getHotkeyLabel(state);
    for (const kbd of view.querySelectorAll(".home-kbd")) kbd.textContent = hk;
  }

  render();
  const unsubscribe = state.subscribe(render);
  if (rootEl.__unmount) try { rootEl.__unmount(); } catch {}
  rootEl.__unmount = () => { try { unsubscribe(); } catch {} };
}

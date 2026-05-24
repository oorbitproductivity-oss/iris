// ═══════════════════════════════════════════════════════════
// sidebar.js — Iris pill + worker session list + footer
// ═══════════════════════════════════════════════════════════

import { showNewSessionModal } from "./new-session.js";
import { showSettingsModal } from "./settings.js";
import { showTelegramPanel } from "./telegram-panel.js";
import { h, svgIcon, relativeTime, basename, showToast } from "./util.js";

// Anything not touched in this long migrates to the collapsed "Archived"
// section so the main list is the stuff the user is currently working on.
const ARCHIVE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function mountSidebar(rootEl, state) {
  rootEl.innerHTML = "";

  // ── Iris CTA block (opens the chat overlay) ─────────────
  const irisBlock = h("div", { class: "sb-iris-block" });
  const irisRow = h("button", { class: "sb-iris-cta", type: "button", "aria-label": "Open Iris chat" });
  const irisMark = h("div", { class: "sb-iris-mark" }, svgIcon("iris", 16));
  const irisText = h("div", { class: "sb-iris-text" });
  const irisName = h("div", { class: "sb-iris-name" }, "Open Iris");
  const irisSub = h("div", { class: "sb-iris-sub" }, "Watching 0 agents");
  irisText.append(irisName, irisSub);
  const irisHotkey = h("div", { class: "sb-iris-hk" }, "Hotkey");
  irisRow.append(irisMark, irisText, irisHotkey);
  irisBlock.append(irisRow);
  irisRow.addEventListener("click", () => window.__iris_toggle?.());

  // ── Threads header ──────────────────────────────────────
  const sectionHeader = h("div", { class: "sb-header" });
  sectionHeader.append(h("span", null, "Threads"));

  // Group-mode toggle (folder vs. recent). Persisted in settings as
  // `sidebarGroupMode` ("folder" | "recent"); defaults to "folder".
  const modeToggle = h("div", { class: "sb-mode-toggle", role: "group", "aria-label": "Group threads" });
  const modeBtnFolder = h("button", {
    class: "sb-mode-btn", type: "button",
    title: "Group by folder", "aria-label": "Group by folder", "data-mode": "folder",
  }, svgIcon("folder", 11));
  const modeBtnRecent = h("button", {
    class: "sb-mode-btn", type: "button",
    title: "Sort by recent", "aria-label": "Sort by recent", "data-mode": "recent",
  }, svgIcon("focus", 11));
  modeToggle.append(modeBtnFolder, modeBtnRecent);

  // Quick-add: primary button creates immediately on folder pick. The small
  // chevron right beside it opens the full modal for advanced setup.
  const addGroup = h("div", { class: "sb-add-group" });
  const addBtn = h("button", { class: "sb-add-btn", "aria-label": "New thread", title: "New thread — pick a folder (Ctrl+N)" });
  addBtn.append(svgIcon("plus", 12), h("span", null, "New"));
  addBtn.addEventListener("click", () => quickCreate(state));
  const addMoreBtn = h("button", {
    class: "sb-add-more", type: "button",
    title: "More options (advanced new-thread)", "aria-label": "More new-thread options",
  }, svgIcon("chevDown", 10));
  addMoreBtn.addEventListener("click", (e) => { e.stopPropagation(); showNewSessionModal(state); });
  addGroup.append(addBtn, addMoreBtn);

  sectionHeader.append(modeToggle, addGroup);

  // ── List ────────────────────────────────────────────────
  const list = h("div", { class: "sb-list" });
  // Active threads container (groups or flat) — re-laid-out when group
  // mode changes or when agents are added/removed/regrouped. Items keep
  // their DOM identity across re-layouts via the `items` registry, so
  // streaming-state updates patch in place without flashing.
  const activeHost = h("div", { class: "sb-active-host" });
  // Collapsible archive section pinned to the bottom.
  const archiveSection = h("div", { class: "sb-archive" });
  const archiveHeader = h("button", { class: "sb-archive-header", type: "button" });
  archiveHeader.append(
    svgIcon("chevRight", 11),
    h("span", { class: "sb-archive-label" }, "Archived"),
    h("span", { class: "sb-archive-count" }, "0"),
  );
  const archiveList = h("div", { class: "sb-archive-list", hidden: true });
  archiveSection.append(archiveHeader, archiveList);

  let archiveOpen = false;
  archiveHeader.addEventListener("click", () => {
    archiveOpen = !archiveOpen;
    archiveList.hidden = !archiveOpen;
    archiveHeader.classList.toggle("open", archiveOpen);
    render();
  });

  list.append(activeHost, archiveSection);

  // ── Footer ──────────────────────────────────────────────
  const footer = h("div", { class: "sb-footer" });
  const newWindowBtn = h("button", { class: "sb-foot-btn", title: "Open another Iris Code window" });
  newWindowBtn.append(svgIcon("copy", 14), h("span", null, "New window"));
  newWindowBtn.addEventListener("click", () => window.iris?.windowNew?.());

  // Telegram bridge quick-toggle. Icon-only square button so the footer
  // still fits "New window" + "Settings" comfortably on narrow sidebars.
  // The status dot floats on the icon corner: green = paired & online,
  // amber = token saved but bridge off / not paired, grey = no token.
  // Click → confirm + toggle. Double-click → open the full panel.
  const telegramBtn = h("button", {
    class: "sb-foot-btn sb-foot-tg sb-foot-icon-only",
    title: "Telegram bridge",
    "aria-label": "Telegram bridge",
  });
  telegramBtn.append(svgIcon("paperPlane", 14));
  const tgDot = h("span", { class: "sb-foot-tg-dot" });
  telegramBtn.append(tgDot);

  const settingsBtn = h("button", { class: "sb-foot-btn", title: "Settings (Ctrl+,)" });
  settingsBtn.append(svgIcon("settings", 14), h("span", null, "Settings"));
  settingsBtn.addEventListener("click", () => showSettingsModal(state));
  footer.append(newWindowBtn, telegramBtn, settingsBtn);

  // ── Telegram quick-toggle behaviour ─────────────────────
  let tgStatus = null;
  async function refreshTelegramBadge() {
    try { tgStatus = await window.iris?.getTelegramStatus?.(); }
    catch (e) { tgStatus = null; }
    paintTelegramBadge();
  }
  function paintTelegramBadge() {
    tgDot.classList.remove("ok", "warn", "off");
    if (!tgStatus || !tgStatus.hasToken) {
      tgDot.classList.add("off");
      telegramBtn.title = "Telegram bridge — click to set up";
    } else if (tgStatus.enabled && tgStatus.paired && tgStatus.connection === "online") {
      tgDot.classList.add("ok");
      telegramBtn.title = `Telegram bridge — online (@${tgStatus.botUsername || "bot"}). Click to stop.`;
    } else {
      tgDot.classList.add("warn");
      telegramBtn.title = "Telegram bridge — click to start";
    }
  }
  telegramBtn.addEventListener("click", async (e) => {
    // Double-click → open the full panel.
    if (e.detail >= 2) { showTelegramPanel(); return; }
    if (!tgStatus || !tgStatus.hasToken) {
      showTelegramPanel();
      return;
    }
    // CAPTURE the current enabled state BEFORE awaiting anything — the
    // status listener may mutate `tgStatus` while we're toggling, which
    // would otherwise make the toast read the *new* state and lie about
    // what just happened ("Stopped" right after starting and vice versa).
    const wasEnabled = !!tgStatus.enabled;
    const ok = wasEnabled
      ? confirm("Stop the Telegram bridge? Your phone won't be able to reach Iris until you restart it.")
      : confirm("Start the Telegram bridge? Your paired phone will be able to send tasks to this desktop.");
    if (!ok) return;
    try {
      const r = await window.iris.setTelegramEnabled(!wasEnabled);
      if (r && r.ok) {
        showToast(wasEnabled ? "Telegram bridge stopped" : "Telegram bridge started");
      } else {
        showToast(r?.error || "Failed", { error: true });
      }
    } catch (err) {
      showToast("Failed: " + (err.message || err), { error: true });
    } finally {
      refreshTelegramBadge();
    }
  });
  // Live-refresh badge whenever the service emits a status update.
  if (typeof window.iris?.onTelegramStatus === "function") {
    window.iris.onTelegramStatus((s) => { tgStatus = s; paintTelegramBadge(); });
  }
  refreshTelegramBadge();

  rootEl.append(irisBlock, sectionHeader, list, footer);

  // ── Keyed item registry — item DOM survives re-layouts ──
  /** @type {Map<string, {el: HTMLElement, refs: any, agent: any, lastActivity: number}>} */
  const items = new Map();
  let emptyEl = null;

  // Current group mode — kicked off from settings once they load.
  let groupMode = "folder";

  function applyModeToggleUI() {
    modeBtnFolder.classList.toggle("active", groupMode === "folder");
    modeBtnRecent.classList.toggle("active", groupMode === "recent");
  }
  applyModeToggleUI();

  modeBtnFolder.addEventListener("click", () => setGroupMode("folder"));
  modeBtnRecent.addEventListener("click", () => setGroupMode("recent"));

  async function setGroupMode(mode) {
    if (mode === groupMode) return;
    groupMode = mode;
    applyModeToggleUI();
    try { await state.actions.saveSettings({ sidebarGroupMode: mode }); } catch {}
    render();
  }

  // ── Build / patch a single thread item ─────────────────
  function buildItem(agent, active) {
    const item = h("div", {
      class: `sb-item appearing${active ? " active" : ""}`,
      role: "button",
      tabindex: "0",
      "data-id": agent.id,
    });
    item.addEventListener("animationend", () => item.classList.remove("appearing"), { once: true });

    const dot = h("div", { class: `sb-dot ${agent.status || "idle"}` });

    const body = h("div", { class: "sb-item-body" });
    const nameEl = h("div", { class: "sb-item-name" }, agent.name || "Untitled");
    const meta = h("div", { class: "sb-item-meta" });
    const cwdEl = h("span", { class: "sb-item-cwd" });
    const timeEl = h("span", { class: "sb-item-time" });
    meta.append(cwdEl, timeEl);
    body.append(nameEl, meta);

    const menu = h("button", { class: "sb-item-menu", "aria-label": "More", title: "More" });
    menu.append(svgIcon("more", 14));

    item.append(dot, body, menu);

    item.addEventListener("click", (e) => {
      if (e.target.closest(".sb-item-menu")) return;
      const id = item.getAttribute("data-id");
      if (id) state.actions.selectAgent(id);
    });
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const id = item.getAttribute("data-id");
        if (id) state.actions.selectAgent(id);
      }
    });
    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const id = item.getAttribute("data-id");
      const current = id ? state.get().agents.find((a) => a.id === id) : null;
      if (current) showContextMenu(e.clientX, e.clientY, current, state);
    });
    menu.addEventListener("click", (e) => {
      e.stopPropagation();
      const r = menu.getBoundingClientRect();
      const id = item.getAttribute("data-id");
      const current = id ? state.get().agents.find((a) => a.id === id) : null;
      if (current) showContextMenu(r.left, r.bottom + 4, current, state);
    });

    return { el: item, refs: { dot, nameEl, cwdEl, timeEl }, agent, lastActivity: agent.lastActivity };
  }

  function patchItem(rec, agent, active) {
    const { el, refs } = rec;
    if (active && !el.classList.contains("active")) el.classList.add("active");
    else if (!active && el.classList.contains("active")) el.classList.remove("active");
    const wantDot = `sb-dot ${agent.status || "idle"}`;
    if (refs.dot.className !== wantDot) refs.dot.className = wantDot;
    const wantName = agent.name || "Untitled";
    if (refs.nameEl.textContent !== wantName) refs.nameEl.textContent = wantName;
    const wantCwd = agent.sandbox ? "Sandbox" : (basename(agent.cwd || "") || "—");
    if (refs.cwdEl.textContent !== wantCwd) refs.cwdEl.textContent = wantCwd;
    if (rec.lastActivity !== agent.lastActivity) {
      rec.lastActivity = agent.lastActivity;
      refs.timeEl.textContent = relativeTime(agent.lastActivity);
    }
    rec.agent = agent;
  }

  function upsertItem(agent, active) {
    let rec = items.get(agent.id);
    if (!rec) {
      rec = buildItem(agent, active);
      items.set(agent.id, rec);
    }
    patchItem(rec, agent, active);
    return rec;
  }

  function updateTimes() {
    for (const [id, rec] of items) {
      const a = rec.agent;
      if (!a) continue;
      const wantTime = relativeTime(a.lastActivity);
      if (rec.refs.timeEl.textContent !== wantTime) {
        rec.refs.timeEl.textContent = wantTime;
      }
    }
  }

  // ── Layout: arrange items into groups or a flat list ───
  function layoutActive(active, activeId) {
    if (groupMode === "folder") {
      // Group by cwd (or "(no folder)"). Each group sorted internally by
      // recency; groups sorted by their most-recent activity.
      //
      // Sandboxed agents are pooled into a single "Sandbox" group rather
      // than splintering one-per-UUID-folder. Each sandbox is isolated from
      // your machine — commands run in private workspaces — and we want
      // that property to read clearly in the sidebar instead of as a wall
      // of opaque UUID folder names.
      const groups = new Map();
      for (const a of active) {
        const key = a.sandbox
          ? "__sandbox__"
          : (a.cwd || "__no_folder__");
        if (!groups.has(key)) {
          groups.set(key, {
            cwd: a.sandbox ? "" : (a.cwd || ""),
            isSandbox: !!a.sandbox,
            agents: [],
          });
        }
        groups.get(key).agents.push(a);
      }
      for (const g of groups.values()) {
        g.agents.sort((x, y) => (y.lastActivity || 0) - (x.lastActivity || 0));
      }
      const sortedGroups = [...groups.values()].sort((a, b) => {
        const aR = Math.max(...a.agents.map((x) => x.lastActivity || 0));
        const bR = Math.max(...b.agents.map((x) => x.lastActivity || 0));
        return bR - aR;
      });

      // Rebuild activeHost group structure. Items are re-parented from the
      // registry — their DOM identity (and any streaming-state animations)
      // are preserved.
      activeHost.innerHTML = "";
      for (const g of sortedGroups) {
        const groupEl = h("div", { class: `sb-group${g.isSandbox ? " sb-group-sandbox" : ""}` });
        const labelText = g.isSandbox
          ? "Sandbox"
          : (g.cwd ? basename(g.cwd) : "(no folder)");
        const titleText = g.isSandbox
          ? "Sandbox — each thread runs in its own isolated workspace; commands can't touch your real files"
          : (g.cwd || "(no folder)");
        const header = h("div", { class: "sb-group-header", title: titleText });
        header.append(
          svgIcon(g.isSandbox ? "shield" : "folder", 11),
          h("span", { class: "sb-group-name" }, labelText),
        );
        if (g.isSandbox) {
          header.append(h("span", { class: "sb-group-tag" }, "isolated"));
        }
        header.append(h("span", { class: "sb-group-count" }, String(g.agents.length)));
        const sub = h("div", { class: "sb-group-list" });
        for (const a of g.agents) {
          const rec = upsertItem(a, activeId === a.id);
          sub.append(rec.el);
        }
        groupEl.append(header, sub);
        activeHost.append(groupEl);
      }
    } else {
      // Flat list sorted by recency.
      activeHost.innerHTML = "";
      const sorted = [...active].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
      for (const a of sorted) {
        const rec = upsertItem(a, activeId === a.id);
        activeHost.append(rec.el);
      }
    }
  }

  function layoutArchive(archived, activeId) {
    archiveSection.hidden = archived.length === 0;
    archiveHeader.querySelector(".sb-archive-count").textContent = String(archived.length);
    if (!archiveOpen) {
      // Don't render the list when collapsed — saves DOM churn.
      // But keep entries in `items` so when expanded, identity is preserved.
      return;
    }
    archiveList.innerHTML = "";
    const sorted = [...archived].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
    for (const a of sorted) {
      const rec = upsertItem(a, activeId === a.id);
      archiveList.append(rec.el);
    }
  }

  // ── Master render ──────────────────────────────────────
  function render() {
    const s = state.get();
    const activeId = s.activeId;

    // Sync group mode from settings (first render after load).
    const settingMode = s.settings?.sidebarGroupMode;
    if (settingMode && settingMode !== groupMode) {
      groupMode = settingMode;
      applyModeToggleUI();
    }

    // Hotkey label
    const raw = s.settings?.spotlightHotkey || "CommandOrControl+Shift+Space";
    const isMac = (window.iris?.platform || "").startsWith("darwin");
    const hk = raw
      .replace(/CommandOrControl/i, isMac ? "Cmd" : "Ctrl")
      .replace(/CmdOrCtrl/i, isMac ? "Cmd" : "Ctrl")
      .replace(/Command/i, "Cmd")
      .replace(/Control/i, "Ctrl")
      .replace(/Alt/i, isMac ? "⌥" : "Alt");
    if (irisHotkey.textContent !== hk) irisHotkey.textContent = hk;

    const watching = s.agents.filter((a) => a.id !== "iris").length;
    const subText = watching === 0
      ? "Iris — your orchestrator"
      : `Watching ${watching} agent${watching === 1 ? "" : "s"}`;
    if (irisSub.textContent !== subText) irisSub.textContent = subText;

    const workers = s.agents.filter((a) => a.id !== "iris");
    const now = Date.now();
    const active = workers.filter((a) => (now - (a.lastActivity || 0)) < ARCHIVE_AFTER_MS);
    const archived = workers.filter((a) => (now - (a.lastActivity || 0)) >= ARCHIVE_AFTER_MS);

    // Empty-state shown only when no workers exist at all (active or archived).
    if (workers.length === 0) {
      if (items.size) {
        for (const rec of items.values()) rec.el.remove();
        items.clear();
      }
      activeHost.innerHTML = "";
      archiveSection.hidden = true;
      if (!emptyEl) {
        emptyEl = h("div", { class: "sb-empty" });
        emptyEl.append(
          h("div", null, "No threads yet."),
          h("button", { class: "sb-empty-cta" }, "+ Pick a folder"),
        );
        emptyEl.querySelector(".sb-empty-cta")
          .addEventListener("click", () => quickCreate(state));
        list.insertBefore(emptyEl, activeHost);
      }
      return;
    }

    if (emptyEl) { emptyEl.remove(); emptyEl = null; }

    layoutActive(active, activeId);
    layoutArchive(archived, activeId);

    // Drop registry entries for agents that no longer exist anywhere.
    const livingIds = new Set(workers.map((a) => a.id));
    for (const [id, rec] of items) {
      if (!livingIds.has(id)) {
        rec.el.remove();
        items.delete(id);
      }
    }
  }

  // Throttle render — same rationale as before.
  let scheduled = false;
  function scheduleRender() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      render();
    });
  }

  render();
  const unsubscribe = state.subscribe(scheduleRender);
  const timeTimer = setInterval(updateTimes, 30 * 1000);
  if (rootEl.__unmount) try { rootEl.__unmount(); } catch {}
  rootEl.__unmount = () => {
    try { unsubscribe(); } catch {}
    clearInterval(timeTimer);
  };
}

// ── Quick-create: click "+ New" → pick folder → done with defaults ──
// Pulls model / apiKeyId / sandbox from settings, derives the thread name
// from the folder basename. Anything can be edited later via the cog icon
// on the thread or the `/thread` slash command.
async function quickCreate(state) {
  let folder;
  try {
    folder = await state.actions.pickFolder();
  } catch (e) {
    console.error("[sidebar] pickFolder threw", e);
    showToast("Folder picker failed", { error: true });
    return;
  }
  if (!folder) return; // user cancelled the dialog

  const settings = state.get().settings || {};
  const name = basename(folder) || "Untitled thread";
  try {
    await state.actions.createAgent({
      name,
      cwd: folder,
      model: settings.model || "sonnet",
      apiKeyId: settings.defaultApiKeyId || null,
      sandbox: !!settings.sandboxByDefault,
    });
    // createAgent → selectAgent → router switches to the chat view automatically.
  } catch (e) {
    console.error("[sidebar] quickCreate failed", e);
    showToast("Failed to create thread: " + (e.message || e), { error: true });
  }
}

function showContextMenu(x, y, agent, state) {
  document.querySelectorAll(".ctx-menu").forEach((el) => el.remove());

  const menu = h("div", { class: "ctx-menu" });

  const focusItem = h("button", { class: "ctx-item" });
  focusItem.append(svgIcon("focus", 14), h("span", null, "Open"));
  focusItem.addEventListener("click", () => {
    state.actions.selectAgent(agent.id);
    menu.remove();
  });
  menu.append(focusItem);

  if (agent.status === "running") {
    const stop = h("button", { class: "ctx-item" });
    stop.append(svgIcon("stop", 14), h("span", null, "Stop"));
    stop.addEventListener("click", () => { state.actions.stopAgent(agent.id); menu.remove(); });
    menu.append(stop);
  } else {
    const resume = h("button", { class: "ctx-item" });
    resume.append(svgIcon("play", 14), h("span", null, "Resume"));
    resume.addEventListener("click", () => { state.actions.resumeAgent(agent.id); menu.remove(); });
    menu.append(resume);
  }

  menu.append(h("div", { class: "ctx-sep" }));

  const del = h("button", { class: "ctx-item danger" });
  del.append(svgIcon("trash", 14), h("span", null, "Delete"));
  del.addEventListener("click", () => {
    state.actions.deleteAgent(agent.id);
    menu.remove();
  });
  menu.append(del);

  document.body.append(menu);
  const w = menu.offsetWidth, hgt = menu.offsetHeight;
  const px = Math.min(x, window.innerWidth - w - 8);
  const py = Math.min(y, window.innerHeight - hgt - 8);
  menu.style.left = px + "px";
  menu.style.top = py + "px";

  const dismiss = (e) => {
    if (e.type === "keydown" && e.key !== "Escape") return;
    if (e.type === "click" && menu.contains(e.target)) return;
    menu.remove();
    document.removeEventListener("click", dismiss, true);
    document.removeEventListener("keydown", dismiss, true);
  };
  setTimeout(() => {
    document.addEventListener("click", dismiss, true);
    document.addEventListener("keydown", dismiss, true);
  }, 0);
}

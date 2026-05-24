// chat-view.js -- Chat surface for worker threads.

import { h, svgIcon, irisImg, basename, relativeTime, showToast } from "./util.js";
import { renderMarkdown } from "../lib/markdown.js";
import { showSessionSettingsModal } from "./session-settings.js";
import { createRotator, shortElapsed, pickWord, THINKING, DOING } from "../lib/verbs.js";
import { COMMANDS, MODELS, filter as filterCommands, execute as executeSlash } from "./slash-commands.js";
import { isExitPlanModeTool, renderPlanCard, patchPlanCard } from "./plan-mode.js";

const MILESTONE_FAST_MS = 30 * 1000;   // first 3 minutes: one line every 30s
const MILESTONE_SLOW_MS = 60 * 1000;   // after 3 minutes: one line every 60s
const MILESTONE_SLOWDOWN_AFTER_MS = 3 * 60 * 1000;

const STATUS_LABEL = {
  running: "weaving",
  idle: "idle",
  error: "stalled",
};

export function mountChatView(rootEl, state) {
  rootEl.innerHTML = "";
  const view = h("div", { class: "chat-view" });

  // ── Header ─────────────────────────────────────────────
  const header = h("div", { class: "chat-header" });
  const headerMark = h("div", { class: "chat-header-mark" }, svgIcon("zap", 14));
  const headerText = h("div", { class: "chat-header-text" });
  const headerName = h("div", { class: "chat-header-name" });
  const headerSub = h("div", { class: "chat-header-sub" });
  headerText.append(headerName, headerSub);

  const headerActions = h("div", { class: "chat-header-actions" });
  const modelPill = h("button", {
    class: "pill model-pill",
    type: "button",
    title: "Click to switch model",
    style: { fontFamily: "var(--font-mono)", cursor: "pointer" },
  },
    h("span", { class: "model-text" }, "sonnet"),
    h("span", { class: "model-chev", "aria-hidden": "true" }, "▾"),
  );
  // Lazy-mount the dropdown the first time the pill is clicked.
  let modelMenu = null;
  function ensureModelMenu() {
    if (modelMenu) return modelMenu;
    modelMenu = h("div", { class: "model-menu", hidden: true });
    for (const m of MODELS) {
      const row = h("button", { class: "model-menu-row", type: "button", "data-model": m });
      row.append(h("span", { class: "model-menu-name" }, m));
      row.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = state.get().activeId;
        if (!id || id === "iris") return;
        modelMenu.hidden = true;
        await state.actions.updateAgent(id, { model: m });
        showToast(`Model switched to ${m}`);
      });
      modelMenu.append(row);
    }
    document.body.append(modelMenu);
    return modelMenu;
  }
  modelPill.addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = ensureModelMenu();
    if (!menu.hidden) { menu.hidden = true; return; }
    const rect = modelPill.getBoundingClientRect();
    menu.style.position = "fixed";
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.right = `${window.innerWidth - rect.right}px`;
    // Mark the currently active model.
    const cur = (state.get().agents.find((a) => a.id === state.get().activeId) || {}).model || "sonnet";
    for (const row of menu.querySelectorAll(".model-menu-row")) {
      row.classList.toggle("active", row.dataset.model === cur);
    }
    menu.hidden = false;
  });
  document.addEventListener("click", () => { if (modelMenu) modelMenu.hidden = true; });
  const statusPill = h("div", { class: "pill idle" },
    h("div", { class: "dot" }),
    h("span", { class: "label-text" }, "idle"),
  );
  const stopBtn = h("button", { class: "btn btn-danger btn-sm", title: "Stop weaving" });
  stopBtn.append(svgIcon("stop", 14), h("span", null, "Stop"));
  stopBtn.style.display = "none";
  stopBtn.addEventListener("click", () => {
    const id = state.get().activeId;
    if (id) state.actions.stopAgent(id);
  });
  // ── View controls: scroll-to-bottom, expand/collapse all, fullscreen ──
  const expandAllBtn = h("button", { class: "icon-btn", title: "Open all tool cards", "aria-label": "Open all tool cards" });
  expandAllBtn.append(svgIcon("expandAll", 14));
  expandAllBtn.addEventListener("click", () => {
    for (const card of feed.querySelectorAll(".tool-card")) card.classList.add("open");
  });

  const collapseAllBtn = h("button", { class: "icon-btn", title: "Close all tool cards", "aria-label": "Close all tool cards" });
  collapseAllBtn.append(svgIcon("collapseAll", 14));
  collapseAllBtn.addEventListener("click", () => {
    for (const card of feed.querySelectorAll(".tool-card.open")) card.classList.remove("open");
  });

  const scrollBottomBtn = h("button", { class: "icon-btn", title: "Scroll to bottom", "aria-label": "Scroll to bottom" });
  scrollBottomBtn.append(svgIcon("chevDoubleDown", 14));
  scrollBottomBtn.addEventListener("click", () => {
    scroll.scrollTop = scroll.scrollHeight;
  });

  const fsBtn = h("button", { class: "icon-btn", title: "Toggle fullscreen (F11)", "aria-label": "Toggle fullscreen" });
  fsBtn.append(svgIcon("maximize", 14));
  fsBtn.addEventListener("click", () => {
    if (window.iris && window.iris.windowFullscreen) window.iris.windowFullscreen();
  });

  const cogBtn = h("button", { class: "icon-btn", title: "Thread settings", "aria-label": "Thread settings" });
  cogBtn.append(svgIcon("settings", 14));
  cogBtn.addEventListener("click", () => {
    const id = state.get().activeId;
    if (id) showSessionSettingsModal(state, id);
  });
  headerActions.append(modelPill, statusPill, stopBtn, expandAllBtn, collapseAllBtn, scrollBottomBtn, fsBtn, cogBtn);
  header.append(headerMark, headerText, headerActions);

  // ── Scroll log ─────────────────────────────────────────
  const scroll = h("div", { class: "chat-scroll" });
  const feed = h("div", { class: "chat-feed" });
  scroll.append(feed);

  // ── Came-back banner (above composer) ──────────────────
  const banner = h("div", { class: "came-back-banner", hidden: true });
  const bannerIcon = h("div", { class: "cbb-icon" }, svgIcon("check", 12));
  const bannerText = h("div", { class: "cbb-text" });
  const bannerDismiss = h("button", { class: "cbb-dismiss", "aria-label": "Mark read" }, svgIcon("x", 12));
  banner.append(bannerIcon, bannerText, bannerDismiss);
  bannerDismiss.addEventListener("click", () => {
    const id = state.get().activeId;
    if (id) state.actions.markViewed(id);
    banner.hidden = true;
  });

  // ── Live activity strip (just above composer) ──────────
  const activityStrip = h("div", { class: "activity-strip", hidden: true });
  const asDot = h("div", { class: "as-dot" });
  const asText = h("span", { class: "as-text" }, "");
  const asTimer = h("span", { class: "as-timer" }, "0s");
  activityStrip.append(asDot, asText, h("span", { class: "as-spacer" }), asTimer);

  // ── Composer ──────────────────────────────────────────
  const composerWrap = h("div", { class: "composer-wrap" });
  const composerInner = h("div", { class: "composer-inner" });
  const composer = h("div", { class: "composer" });
  const textarea = h("textarea", {
    rows: "1",
    placeholder: "Send to this thread… (type / for commands)",
    spellcheck: "false",
  });
  const sendBtn = h("button", { class: "composer-send", title: "Send (Enter)" }, svgIcon("send", 14));
  composer.append(textarea, sendBtn);

  // Slash-command popover — sits above the composer, only shown while the
  // textarea starts with "/". Arrow keys navigate; Tab/Enter pick.
  const slashPop = h("div", { class: "slash-pop", hidden: true });

  // Footer info bar (left: keys, right: live status)
  const footer = h("div", { class: "composer-footer" });
  const footL = h("div", { class: "cf-left" });
  footL.innerHTML = `<kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline`;
  const footR = h("div", { class: "cf-right" });
  const footModel = h("span", { class: "cf-pill cf-model" }, "sonnet");
  const footStateText = h("span", { class: "cf-pill cf-state" }, "idle");
  const footAgents = h("span", { class: "cf-pill cf-agents" }, "0 weaving");
  footR.append(footModel, footStateText, footAgents);
  footer.append(footL, footR);

  composerInner.append(banner, activityStrip, slashPop, composer, footer);
  composerWrap.append(composerInner);

  view.append(header, scroll, composerWrap);
  rootEl.append(view);

  // ── Composer behavior ─────────────────────────────────
  function autoResize() {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 220) + "px";
  }
  textarea.addEventListener("input", autoResize);

  // ── Slash command popover wiring ──────────────────────
  // selectedIdx is the highlighted row in the popover, -1 = none.
  let slashMatches = [];
  let slashSelectedIdx = 0;

  function renderSlashPop() {
    slashPop.innerHTML = "";
    if (!slashMatches.length) { slashPop.hidden = true; return; }
    let selectedEl = null;
    for (let i = 0; i < slashMatches.length; i++) {
      const c = slashMatches[i];
      const row = h("div", {
        class: `slash-row${i === slashSelectedIdx ? " selected" : ""}`,
        "data-idx": String(i),
      });
      if (i === slashSelectedIdx) selectedEl = row;
      row.append(
        h("code", { class: "slash-usage" }, c.usage),
        h("span", { class: "slash-desc" }, c.desc),
      );
      row.addEventListener("mouseenter", () => {
        slashSelectedIdx = i;
        for (const r of slashPop.querySelectorAll(".slash-row")) r.classList.remove("selected");
        row.classList.add("selected");
      });
      row.addEventListener("click", () => {
        // Auto-fill the command. If it takes an argument, leave the user to type it.
        const c2 = slashMatches[i];
        textarea.value = c2.usage.includes("<") ? `/${c2.name} ` : `/${c2.name}`;
        textarea.focus();
        refreshSlash();
        autoResize();
        // If no argument needed, execute immediately on click.
        if (!c2.usage.includes("<")) trySend();
      });
      slashPop.append(row);
    }
    slashPop.hidden = false;
    // Keep the highlighted row visible — arrow-key nav must scroll the
    // popup's overflow region, not just shift the highlight off-screen.
    if (selectedEl) {
      requestAnimationFrame(() => selectedEl.scrollIntoView({ block: "nearest" }));
    }
  }

  function refreshSlash() {
    const v = textarea.value;
    if (!v.startsWith("/")) { slashMatches = []; slashPop.hidden = true; return; }
    slashMatches = filterCommands(v);
    if (slashSelectedIdx >= slashMatches.length) slashSelectedIdx = 0;
    if (slashSelectedIdx < 0) slashSelectedIdx = 0;
    renderSlashPop();
  }

  async function trySend() {
    const text = textarea.value.trim();
    if (!text) return;

    // Local slash command takes precedence — never sent to claude.
    if (text.startsWith("/")) {
      const handled = await executeSlash(text, state);
      if (handled) {
        textarea.value = "";
        slashMatches = [];
        slashPop.hidden = true;
        autoResize();
        return;
      }
      // unknown /foo — fall through and let claude see it
    }

    const s = state.get();
    const id = s.activeId;
    if (!id) return;
    const agent = s.agents.find((a) => a.id === id);
    if (agent && agent.status === "running") return;
    state.actions.sendMessage(text);
    textarea.value = "";
    slashMatches = [];
    slashPop.hidden = true;
    autoResize();
    // Sending a message is an explicit "I want to watch this now" gesture.
    // Re-engage the bottom-follow lock so the stream pulls the viewport
    // along even if the user had scrolled up earlier.
    followBottom = true;
    newPill.hidden = true;
    requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
  }

  textarea.addEventListener("input", refreshSlash);

  textarea.addEventListener("keydown", (e) => {
    // Popover navigation when visible.
    if (!slashPop.hidden && slashMatches.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        slashSelectedIdx = (slashSelectedIdx + 1) % slashMatches.length;
        renderSlashPop();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        slashSelectedIdx = (slashSelectedIdx - 1 + slashMatches.length) % slashMatches.length;
        renderSlashPop();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const c = slashMatches[slashSelectedIdx];
        if (c) {
          textarea.value = c.usage.includes("<") ? `/${c.name} ` : `/${c.name}`;
          autoResize();
          refreshSlash();
        }
        return;
      }
      if (e.key === "Escape") {
        slashMatches = [];
        slashPop.hidden = true;
        e.preventDefault();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      trySend();
    }
  });

  sendBtn.addEventListener("click", trySend);

  // ── Rotating verbs + elapsed timer ────────────────────
  let currentVerb = pickWord(THINKING);
  const rotator = createRotator({
    list: THINKING,
    intervalMs: 2500,
    onTick: (word) => {
      currentVerb = word;
      paintActivity();
    },
  });

  let timerHandle = null;
  function startTimer() {
    if (timerHandle) return;
    timerHandle = setInterval(paintActivity, 1000);
  }
  function stopTimer() {
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
  }

  // ── Milestone timeline ──
  // Append-only log of what the agent did in each window. Cadence: one line
  // every 30 seconds for the first 3 minutes, then one line every 60 seconds.
  // This replaces the raw-thinking dump — the chain-of-thought never goes to
  // the bubble; we just summarize what changed in the window.
  let mStartedAt = 0;
  let mTimer = null;
  let mPrevThinkLen = 0;
  let mPrevToolCount = 0;
  let mActiveAgentId = null;
  let mRotIdx = 0;

  function startThinkTimer() {
    const s = state.get();
    const id = s.activeId;
    if (!id) return;
    if (mActiveAgentId === id && mTimer) return;
    stopThinkTimer();
    mActiveAgentId = id;
    mStartedAt = Date.now();
    mPrevThinkLen = 0;
    mPrevToolCount = 0;
    mRotIdx = 0;
    scheduleNextMilestone();
  }
  function stopThinkTimer() {
    if (mTimer) { clearTimeout(mTimer); mTimer = null; }
    mActiveAgentId = null;
    mStartedAt = 0;
  }
  function scheduleNextMilestone() {
    const sinceStart = Date.now() - mStartedAt;
    const interval = sinceStart > MILESTONE_SLOWDOWN_AFTER_MS
      ? MILESTONE_SLOW_MS
      : MILESTONE_FAST_MS;
    mTimer = setTimeout(milestoneTick, interval);
  }
  function milestoneTick() {
    mTimer = null;
    const s = state.get();
    const id = s.activeId;
    if (id !== mActiveAgentId) return;
    const draft = s.draftByAgent[id];
    if (!draft) return;
    appendMilestone(draft);
    scheduleNextMilestone();
  }
  function appendMilestone(draft) {
    const slot = feed.querySelector(".think-status-slot");
    if (!slot) return;
    let timeline = slot.querySelector(".think-timeline");
    if (!timeline) {
      timeline = h("div", { class: "think-timeline" });
      slot.append(timeline);
    }
    const thinking = draft.thinking || "";
    const tools = draft.tools || [];
    const newThinking = thinking.slice(mPrevThinkLen);
    const newTools = tools.slice(mPrevToolCount);
    mPrevThinkLen = thinking.length;
    mPrevToolCount = tools.length;
    const text = summarizeWindow(newTools, newThinking);
    if (!text) return;
    const line = h("div", { class: "think-milestone" },
      h("span", { class: "think-tick" }, shortElapsed(Date.now() - mStartedAt)),
      h("span", { class: "think-dot" }),
      h("span", { class: "think-text" }, text),
    );
    timeline.append(line);
    // Auto-scroll only if the user hasn't scrolled away.
    requestAnimationFrame(() => {
      const room = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
      if (room < 60) scroll.scrollTop = scroll.scrollHeight;
    });
  }
  function summarizeWindow(newTools, newThinking) {
    if (newTools && newTools.length > 0) {
      const t = newTools[newTools.length - 1];
      const hint = toolHint(t.input);
      const label = `${t.name}${hint ? " " + hint : ""}`.trim();
      return label;
    }
    if (newThinking && newThinking.trim().length > 20) {
      return summarizeThinking(newThinking);
    }
    // Nothing distinctive happened — fall back to a slowly-rotating verb so
    // the user still gets a heartbeat line.
    const verb = THINKING[mRotIdx % THINKING.length];
    mRotIdx++;
    return `${verb}…`;
  }

  function paintActivity() {
    const s = state.get();
    const id = s.activeId;
    if (!id) return;
    const meta = s.streamMeta[id];
    const agent = s.agents.find((a) => a.id === id);
    const running = agent && agent.status === "running";

    if (!running || !meta) {
      activityStrip.hidden = true;
      return;
    }
    activityStrip.hidden = false;
    // If a tool is mid-flight, name it instead of cycling a generic verb.
    const draft = s.draftByAgent[id];
    let live = null;
    if (draft && draft.tools && draft.tools.length) {
      for (let i = draft.tools.length - 1; i >= 0; i--) {
        if (draft.tools[i].status === "started") { live = draft.tools[i]; break; }
      }
    }
    if (live) {
      asText.textContent = `${live.name} ${toolHint(live.input)}`.trim();
      asDot.className = "as-dot doing";
    } else {
      asText.textContent = `${currentVerb}…`;
      asDot.className = `as-dot ${meta.mode || "thinking"}`;
    }
    const ms = Date.now() - (meta.startedAt || Date.now());
    asTimer.textContent = shortElapsed(ms);
  }

  function toolHint(input) {
    if (input == null) return "";
    if (typeof input === "string") return `· ${input.slice(0, 60)}`;
    if (typeof input !== "object") return "";
    const k = input.file_path || input.path || input.command || input.pattern || input.url || input.query;
    if (typeof k === "string" && k) {
      const short = k.length > 60 ? "…" + k.slice(-58) : k;
      return `· ${short}`;
    }
    return "";
  }

  // ── Came-back banner detection ────────────────────────
  function paintBanner() {
    const s = state.get();
    const id = s.activeId;
    if (!id) { banner.hidden = true; return; }
    const lastA = s.lastActivityAt[id];
    const lastV = s.lastViewedAt[id];
    const agent = s.agents.find((a) => a.id === id);
    const isIdleOrError = agent && (agent.status === "idle" || agent.status === "error");
    // Banner if there's been activity since the last view, the thread isn't
    // currently weaving, and we have a recorded "last viewed" (i.e. user came
    // back after switching away or just opened the thread fresh).
    if (lastA && (!lastV || lastA > lastV) && isIdleOrError) {
      const ago = shortElapsed(Date.now() - lastA);
      bannerText.textContent = agent.status === "error"
        ? `Stalled ${ago} ago — open and inspect`
        : `Finished ${ago} ago`;
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  }

  // ── Render messages ───────────────────────────────────
  let lastRenderedAgentId = null;
  let lastMessageCount = 0;
  let lastDraftLen = 0;

  // Per-agent cache of the last text we wrote into .md, so we can skip the
  // innerHTML re-parse when nothing changed (avoids subtle relayout flashes).
  let lastDraftText = "";

  function render() {
    const s = state.get();
    const id = s.activeId;
    if (!id || id === "iris") {
      rotator.stop();
      stopTimer();
      return;
    }
    const agent = s.agents.find((a) => a.id === id);
    if (!agent) return;

    headerName.textContent = agent.name || "Untitled";
    headerSub.innerHTML = "";
    if (agent.sandbox) {
      const tag = h("span", { class: "sub-tag" }, "Sandbox");
      const link = h("button", {
        class: "sub-link",
        type: "button",
        title: "Open sandbox folder",
      }, "open folder");
      link.addEventListener("click", () => {
        if (agent.cwd) window.iris?.openPath?.(agent.cwd);
      });
      headerSub.append(tag, link);
    } else {
      headerSub.textContent = agent.cwd || "—";
    }

    const status = agent.status || "idle";
    statusPill.className = `pill ${status}`;
    statusPill.querySelector(".label-text").textContent = STATUS_LABEL[status] || status;
    stopBtn.style.display = status === "running" ? "" : "none";
    modelPill.querySelector(".model-text").textContent = agent.model || "sonnet";

    const running = status === "running";
    textarea.disabled = running;
    sendBtn.disabled = running || !textarea.value.trim();
    textarea.placeholder = running ? "Iris is weaving…" : "Send to this thread…";

    // Footer live info
    footModel.textContent = agent.model || "sonnet";
    footStateText.textContent = STATUS_LABEL[status] || status;
    footStateText.className = `cf-pill cf-state cf-state-${status}`;
    const runningCount = s.agents.filter((a) => a.status === "running").length;
    footAgents.textContent = `${runningCount} weaving`;

    // Rotator mode + timer
    if (running) {
      const meta = s.streamMeta[id];
      const mode = (meta && meta.mode) || "thinking";
      if (!rotator.isActive()) rotator.start(mode);
      else rotator.setMode(mode);
      startTimer();
      startThinkTimer();
    } else {
      rotator.stop();
      stopTimer();
      stopThinkTimer();
    }
    paintActivity();
    paintBanner();

    const messages = s.messagesByAgent[id] || [];
    const draft = s.draftByAgent[id] || null;

    // Full re-render only when the agent actually changes. Anything else —
    // streaming text, new tools, a message being committed — is patched in
    // place so we never tear down existing DOM (which was the source of the
    // tool-card flashing the user was seeing).
    if (id !== lastRenderedAgentId) {
      feed.innerHTML = "";
      if (messages.length === 0 && !draft) {
        feed.append(renderEmpty(agent));
      } else {
        for (const m of messages) feed.append(renderMessage(m, "worker"));
        if (draft) feed.append(renderDraft(draft, "worker"));
      }
      lastRenderedAgentId = id;
      lastMessageCount = messages.length;
      lastDraftLen = draft ? draft.text.length : 0;
      lastDraftText = draft ? draft.text : "";
      scrollToBottom();
      return;
    }

    // Same agent — incremental updates only.

    // Drop the empty-state placeholder once real content arrives.
    const emptyEl = feed.querySelector(".chat-empty");
    if (emptyEl && (messages.length > 0 || draft)) emptyEl.remove();

    // Messages grew: append the new ones at the end. If the last DOM child
    // is still a draft, remove it first — its content is now embedded in the
    // newly-committed assistant message.
    if (messages.length > lastMessageCount) {
      const stale = feed.querySelector(".msg.draft");
      if (stale) stale.remove();
      for (let i = lastMessageCount; i < messages.length; i++) {
        feed.append(renderMessage(messages[i], "worker"));
      }
      lastMessageCount = messages.length;
      lastDraftText = "";
      lastDraftLen = 0;
      scrollToBottom();
    }

    // Draft handling: mount once, then patch in place every tick.
    if (draft) {
      let draftEl = feed.querySelector(".msg.draft");
      if (!draftEl) {
        draftEl = renderDraft(draft, "worker");
        feed.append(draftEl);
        lastDraftText = draft.text || "";
        lastDraftLen = lastDraftText.length;
        scrollToBottom();
      } else {
        patchDraftEl(draftEl, draft);
        if (draft.text.length !== lastDraftLen) {
          lastDraftLen = draft.text.length;
          scrollToBottom(true);
        }
      }
    } else {
      // No draft expected — clean up any orphaned one.
      const orphan = feed.querySelector(".msg.draft");
      if (orphan) orphan.remove();
      lastDraftText = "";
      lastDraftLen = 0;
    }
  }

  function patchDraftEl(el, draft) {
    // Markdown: only re-parse when text changed. innerHTML on a long body is
    // cheap but the parse + relayout can flash sub-pixel — skip when stable.
    const text = draft.text || "";
    if (text !== lastDraftText) {
      const md = el.querySelector(".md");
      if (md) md.innerHTML = renderMarkdown(text);
      lastDraftText = text;
    }

    const toolsHost = el.querySelector(".draft-tools");
    if (toolsHost) reconcileToolCards(toolsHost, draft.tools || []);
  }

  // Bottom-follow state machine.
  //   • true  → every stream tick yanks the viewport to the bottom (lock-on).
  //   • false → user scrolled up; we leave them alone and pop the "new"
  //             pill instead. Sending a message or clicking the pill flips
  //             it back to true.
  let followBottom = true;
  let suppressNextScroll = 0; // tick counter; programmatic scrolls don't disengage follow

  function scrollToBottom(force = false) {
    requestAnimationFrame(() => {
      if (force || followBottom) {
        suppressNextScroll = 2;
        scroll.scrollTop = scroll.scrollHeight;
        followBottom = true;
        newPill.hidden = true;
      } else {
        showNewContentPill();
      }
    });
  }

  // ── "new content below" pill ──
  const newPill = h("button", { class: "new-content-pill", hidden: true, title: "Jump to bottom & follow" });
  newPill.append(svgIcon("chevDoubleDown", 12), h("span", null, "new"));
  newPill.addEventListener("click", () => {
    followBottom = true;
    suppressNextScroll = 2;
    scroll.scrollTop = scroll.scrollHeight;
    newPill.hidden = true;
  });
  scroll.append(newPill);
  function showNewContentPill() {
    newPill.hidden = false;
  }

  scroll.addEventListener("scroll", () => {
    if (suppressNextScroll > 0) { suppressNextScroll--; return; }
    const room = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
    // 6px of slop so a sub-pixel render bump doesn't flip the state.
    if (room < 6) {
      followBottom = true;
      newPill.hidden = true;
    } else {
      // The user scrolled up themselves → drop the lock. Stream ticks won't
      // pull them back down until they send a message or hit the pill.
      followBottom = false;
    }
  });

  // The header "scroll to bottom" button: also re-engages follow.
  scrollBottomBtn.addEventListener("click", () => {
    followBottom = true;
    suppressNextScroll = 2;
    newPill.hidden = true;
  });

  function reconcileToolCards(host, tools) {
    // Match existing tool-card DOM nodes to their corresponding tool objects
    // by useId, patching status/input/result in place. New tools are
    // appended; vanished tools are removed. Critically, we never wipe the
    // host — destroying a card every tick is what was making them flash and
    // strobe as the user typed/streamed.
    const existing = new Map();
    for (const node of host.querySelectorAll(":scope > .tool-card")) {
      const key = node.dataset.useId || "";
      existing.set(key, node);
    }

    const seen = new Set();
    let cursor = host.firstElementChild;
    for (const t of tools) {
      const key = t.useId || "";
      seen.add(key);
      let card = existing.get(key);
      if (!card) {
        card = renderToolCard(t);
        card.dataset.useId = key;
        if (cursor) host.insertBefore(card, cursor);
        else host.append(card);
      } else {
        patchToolCard(card, t);
        // Reorder if the card isn't where we expect (rare, but keeps
        // visual order matching the tools array).
        if (card !== cursor) host.insertBefore(card, cursor);
        cursor = card.nextElementSibling;
      }
    }

    // Remove anything that was in the DOM but no longer in the tools array.
    for (const [key, node] of existing) {
      if (!seen.has(key)) node.remove();
    }
  }

  function patchToolCard(card, t) {
    // Plan cards have an entirely different shape (no .tool-icon, no .tool-body
    // pres) — delegate to the plan-mode patcher instead of fighting the DOM.
    if (card.classList.contains("plan-card")) {
      patchPlanCard(card, t);
      return;
    }

    // Status icon — swap only when the status word actually changed, so the
    // running spinner stays mounted across ticks instead of being recreated.
    const icon = card.querySelector(".tool-icon");
    if (icon) {
      const want = t.status || "started";
      const currentStatus = icon.dataset.status || "";
      if (currentStatus !== want) {
        icon.dataset.status = want;
        icon.className = `tool-icon ${want}`;
        icon.innerHTML = "";
        if (want === "done") icon.append(svgIcon("check", 11));
        else if (want === "error") icon.append(svgIcon("x", 11));
        else icon.append(h("div", { class: "tool-spin" }));
      }
    }

    // Name (rarely changes after the first input event, but keep correct).
    const nameEl = card.querySelector(".tool-name");
    if (nameEl) {
      const wantName = t.name || "tool";
      if (nameEl.textContent !== wantName) nameEl.textContent = wantName;
    }

    // Input snippet in the header.
    const inputEl = card.querySelector(".tool-input");
    if (inputEl) {
      const snippet = inputToString(t.input);
      if (inputEl.textContent !== snippet) inputEl.textContent = snippet;
    }

    // Body: pretty-printed input + optional result block. Patch only the
    // text content of the existing <pre> nodes; never rebuild the body.
    const body = card.querySelector(".tool-body");
    if (body) {
      const pres = body.querySelectorAll("pre");
      const inputPretty = inputToString(t.input, true);
      if (pres[0] && pres[0].textContent !== inputPretty) {
        pres[0].textContent = inputPretty;
      }
      const hasResultPre = !!body.querySelector("pre.tool-result");
      if (t.result && !hasResultPre) {
        body.append(
          h("div", { class: "tool-result-label" }, "Result"),
          (() => { const p = document.createElement("pre"); p.className = "tool-result"; p.textContent = t.result; return p; })()
        );
      } else if (t.result && hasResultPre) {
        const rp = body.querySelector("pre.tool-result");
        if (rp.textContent !== t.result) rp.textContent = t.result;
      }
    }

    // Open/closed state belongs to the user. Patches never touch `.open`.

    // Danger banner — inject once if newly flagged.
    if (t.dangerous && !card.querySelector(".tool-danger-banner")) {
      card.classList.add("tool-danger");
      const banner = h("div", { class: "tool-danger-banner" });
      banner.append(
        h("div", { class: "tool-danger-icon" }, "!"),
        h("div", { class: "tool-danger-text" },
          h("div", { class: "tool-danger-title" }, t.dangerous.halted ? "Halted — destructive command detected" : "Destructive command detected"),
          h("div", { class: "tool-danger-reason" }, t.dangerous.reason || "Unsafe operation"),
        ),
      );
      card.insertBefore(banner, card.firstChild);
    }
  }

  render();
  const unsubscribe = state.subscribe(render);

  textarea.addEventListener("input", () => {
    const s = state.get();
    const agent = s.agents.find((a) => a.id === s.activeId);
    const running = agent && agent.status === "running";
    sendBtn.disabled = running || !textarea.value.trim();
  });

  if (rootEl.__unmount) try { rootEl.__unmount(); } catch {}
  rootEl.__unmount = () => {
    try { unsubscribe(); } catch {}
    rotator.stop();
    stopTimer();
    stopThinkTimer();
  };
}

function renderEmpty(agent) {
  const wrap = h("div", { class: "chat-empty" });
  const where = agent.sandbox
    ? "a sandbox"
    : (basename(agent.cwd) || agent.cwd || "—");
  wrap.append(
    svgIcon("zap", 28),
    h("h3", null, agent.name || "New thread"),
    h("p", null, `Weaving in ${where}. Send a message to get started.`),
  );
  return wrap;
}

function renderMessage(m, kind /* "worker" | "iris" */) {
  const role = m.role || "system";
  const wrap = h("div", { class: `msg ${role}${kind === "iris" && role === "assistant" ? " iris" : ""}` });
  const bubble = h("div", { class: "bubble" });

  if (role === "assistant") {
    const author = h("div", { class: "msg-author" });
    author.append(h("span", { class: "author-mark" }, irisImg(14)), h("span", null, kind === "iris" ? "Iris" : "Assistant"));
    bubble.append(author);
    const md = h("div", { class: "md" });
    md.innerHTML = renderMarkdown(m.text || "");
    bubble.append(md);
  } else if (role === "user") {
    bubble.textContent = m.text || "";
  } else {
    bubble.textContent = m.text || "";
  }

  wrap.append(bubble);

  if (m.tools && m.tools.length) {
    const container = h("div", { class: "msg-tools", style: { width: "100%", maxWidth: "80ch" } });
    for (const t of m.tools) container.append(renderToolCard(t));
    const col = h("div", { style: { display: "flex", flexDirection: "column", alignItems: "flex-start", maxWidth: "100%" } });
    col.append(bubble, container);
    wrap.innerHTML = "";
    wrap.append(col);
  }

  return wrap;
}

function renderDraft(draft, kind) {
  const wrap = h("div", { class: `msg assistant draft${kind === "iris" ? " iris" : ""}` });
  const col = h("div", { style: { display: "flex", flexDirection: "column", alignItems: "flex-start", maxWidth: "100%" } });
  const bubble = h("div", { class: "bubble" });
  const author = h("div", { class: "msg-author" });
  author.append(h("span", { class: "author-mark" }), h("span", null, kind === "iris" ? "Iris" : "Assistant"));
  bubble.append(author);
  // Slot for the think-status line. Created/updated by the chat-view's
  // slow-tick timer, not by the per-delta render. Stays stable across
  // updates so it doesn't flicker.
  bubble.append(h("div", { class: "think-status-slot" }));
  const md = h("div", { class: "md" });
  md.innerHTML = renderMarkdown(draft.text || "");
  bubble.append(md);
  bubble.append(h("span", { class: "cursor" }));

  const toolsHost = h("div", { class: "draft-tools", style: { width: "100%", maxWidth: "80ch" } });
  for (const t of draft.tools) toolsHost.append(renderToolCard(t));

  col.append(bubble, toolsHost);
  wrap.append(col);
  return wrap;
}

// Distil a streaming chain-of-thought into a short status phrase that feels
// like "Contemplating the cwd structure…" or "Developing the next step…".
// Updated on a slow timer to avoid the flicker of per-delta refreshes.
function summarizeThinking(text) {
  if (!text) return "";
  const flat = String(text).replace(/\s+/g, " ").trim();
  if (!flat) return "";
  // Take the last complete sentence; if none, the whole tail.
  const m = flat.match(/[^.!?]+[.!?]\s+([^.!?]*)$/);
  let chunk = (m ? m[1] : flat).trim();
  if (!chunk) chunk = flat.slice(-80);
  if (chunk.length > 80) {
    chunk = chunk.slice(-80);
    const sp = chunk.indexOf(" ");
    if (sp > 0 && sp < 20) chunk = chunk.slice(sp + 1);
    chunk = "…" + chunk;
  }
  if (chunk && /[a-z]/.test(chunk[0])) {
    chunk = chunk[0].toUpperCase() + chunk.slice(1);
  }
  return chunk;
}

export function renderToolCard(t) {
  // ExitPlanMode gets the dedicated approval-card treatment: the plan body is
  // rendered as markdown with Approve / Keep-planning actions. The state is
  // pulled from the global window.__iris_state so callers (renderMessage,
  // renderDraft, reconcileToolCards) don't need to thread it through.
  if (isExitPlanModeTool(t)) {
    const state = (typeof window !== "undefined" && window.__iris_state) || null;
    const agentId = state ? state.get().activeId : null;
    return renderPlanCard(t, { state, agentId });
  }

  // Cards default to collapsed. The header (icon + name + input snippet) already
  // tells the user what's happening; the body is opt-in. User clicks are sticky —
  // patch passes never override the open/closed state.
  const card = h("div", { class: `tool-card${t.dangerous ? " tool-danger" : ""}` });
  if (t.useId) card.dataset.useId = t.useId;
  if (t.dangerous) {
    const banner = h("div", { class: "tool-danger-banner" });
    banner.append(
      h("div", { class: "tool-danger-icon" }, "!"),
      h("div", { class: "tool-danger-text" },
        h("div", { class: "tool-danger-title" }, t.dangerous.halted ? "Halted — destructive command detected" : "Destructive command detected"),
        h("div", { class: "tool-danger-reason" }, t.dangerous.reason || "Unsafe operation"),
      ),
    );
    card.append(banner);
  }
  // For diff-supporting tools, the filename becomes the click target; the
  // chevron stays for the raw input/result body.
  const toolName = t.name || "tool";
  const isDiffTool = /^(Edit|Write|MultiEdit)$/.test(toolName);
  const filePath = t.input && typeof t.input === "object"
    ? (t.input.file_path || t.input.notebook_path || t.input.path || "")
    : "";

  const head = h("div", { class: "tool-head" });
  const icon = h("div", { class: `tool-icon ${t.status || "started"}` });
  icon.dataset.status = t.status || "started";
  if (t.status === "done") icon.append(svgIcon("check", 11));
  else if (t.status === "error") icon.append(svgIcon("x", 11));
  else icon.append(h("div", { class: "tool-spin" }));

  const name = h("div", { class: "tool-name" }, toolName);

  let filenamePill = null;
  if (isDiffTool && filePath) {
    filenamePill = h("button", {
      class: "tool-filename",
      type: "button",
      "aria-expanded": "false",
      title: `Click to expand diff for ${filePath}`,
    });
    filenamePill.append(
      h("span", { class: "tool-filename-text" }, basename(filePath) || filePath),
      svgIcon("chevRight", 12),
    );
  }

  const inputSnippet = inputToString(t.input);
  const input = h("div", { class: "tool-input" }, isDiffTool && filePath ? "" : inputSnippet);
  const chev = h("div", { class: "tool-chev", "aria-hidden": "true", title: "Show raw input" }, svgIcon("chevRight", 14));
  if (filenamePill) head.append(icon, name, filenamePill, input, chev);
  else head.append(icon, name, input, chev);

  // The raw input + result body — toggled by chevron click.
  const body = h("div", { class: "tool-body" });
  const pre = document.createElement("pre");
  pre.textContent = inputToString(t.input, true);
  body.append(pre);
  if (t.result) {
    const sep = h("div", { class: "tool-result-label" }, "Result");
    const rpre = document.createElement("pre");
    rpre.className = "tool-result";
    rpre.textContent = t.result;
    body.append(sep, rpre);
  }

  function toggleBody() {
    const open = card.classList.toggle("open");
    chev.setAttribute("aria-expanded", open ? "true" : "false");
  }

  // Chevron toggles body; clicks on body-internal regions of the head do too,
  // EXCEPT the filename pill which has its own behavior.
  head.addEventListener("click", (e) => {
    if (filenamePill && filenamePill.contains(e.target)) return;
    toggleBody();
  });

  // The diff panel is mounted lazily by diff-viewer.js, but the filename pill
  // toggles its visibility. We add a class on the card to drive CSS.
  if (filenamePill) {
    filenamePill.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = card.classList.toggle("diff-open");
      filenamePill.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  card.append(head, body);
  return card;
}

function inputToString(input, pretty = false) {
  if (input == null) return "";
  if (typeof input === "string") return input;
  try {
    return pretty ? JSON.stringify(input, null, 2) : JSON.stringify(input);
  } catch {
    return String(input);
  }
}

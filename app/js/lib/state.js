// ═══════════════════════════════════════════════════════════
// state.js — Tiny reactive store for Iris Code
// ═══════════════════════════════════════════════════════════

export function createState() {
  /** @type {{
   *  settings: any,
   *  agents: any[],
   *  activeId: string,
   *  messagesByAgent: Record<string, any[]>,
   *  draftByAgent: Record<string, { text: string, tools: any[] }>,
   *  ready: boolean,
   * }} */
  let state = {
    settings: null,
    agents: [],
    activeId: "iris",
    messagesByAgent: {},
    draftByAgent: {},
    ready: false,
    // Per-thread last-time-this-view-was-focused. Used to detect "came back"
    // moments and surface a "finished while you were away" banner.
    lastViewedAt: {},
    // Per-thread timestamp of the most recent activity (set on result/error/done).
    lastActivityAt: {},
    // Per-thread streaming meta: { startedAt, firstDeltaAt, mode: "thinking"|"doing" }
    streamMeta: {},
    // Chronological event log (capped). Newest first.
    activityLog: [],
  };

  const ACTIVITY_LOG_MAX = 200;

  const listeners = new Set();

  function get() {
    return state;
  }

  function notify() {
    for (const fn of listeners) {
      try { fn(state); } catch (e) { console.error("[state] listener error", e); }
    }
  }

  function set(patch) {
    state = { ...state, ...patch };
    notify();
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  // ── Helpers ────────────────────────────────────────────
  function upsertAgent(agent) {
    const idx = state.agents.findIndex(a => a.id === agent.id);
    let agents;
    if (idx === -1) {
      agents = [...state.agents, agent];
    } else {
      agents = state.agents.slice();
      agents[idx] = { ...agents[idx], ...agent };
    }
    return agents;
  }

  function getDraft(id) {
    return state.draftByAgent[id] || { text: "", tools: [] };
  }

  function setDraft(id, draft) {
    return { ...state.draftByAgent, [id]: draft };
  }

  function clearDraft(id) {
    const next = { ...state.draftByAgent };
    delete next[id];
    return next;
  }

  function appendMessage(id, msg) {
    const prev = state.messagesByAgent[id] || [];
    return { ...state.messagesByAgent, [id]: [...prev, msg] };
  }

  function setMessages(id, msgs) {
    return { ...state.messagesByAgent, [id]: msgs };
  }

  // ── Activity log helpers ───────────────────────────────
  function pushLog(entry) {
    const next = [{ ...entry, ts: entry.ts || Date.now() }, ...state.activityLog];
    if (next.length > ACTIVITY_LOG_MAX) next.length = ACTIVITY_LOG_MAX;
    return next;
  }

  function agentNameOf(id) {
    const a = state.agents.find((x) => x.id === id);
    return a ? a.name : id;
  }

  // ── Event dispatch ─────────────────────────────────────
  function dispatch(event) {
    if (!event || !event.type) return;

    switch (event.type) {
      case "agent:created": {
        set({ agents: upsertAgent(event.agent) });
        break;
      }
      case "agent:deleted": {
        const agents = state.agents.filter(a => a.id !== event.id);
        const messagesByAgent = { ...state.messagesByAgent };
        delete messagesByAgent[event.id];
        const draftByAgent = { ...state.draftByAgent };
        delete draftByAgent[event.id];
        const activeId = state.activeId === event.id ? "iris" : state.activeId;
        set({ agents, messagesByAgent, draftByAgent, activeId });
        break;
      }
      case "agent:updated": {
        set({ agents: upsertAgent(event.agent) });
        break;
      }
      case "session": {
        // Record sessionId on the agent summary
        const agent = state.agents.find(a => a.id === event.id);
        if (agent) {
          set({ agents: upsertAgent({ ...agent, sessionId: event.sessionId, model: event.model || agent.model }) });
        }
        break;
      }
      case "user": {
        const list = state.messagesByAgent[event.id] || [];
        const last = list[list.length - 1];
        if (last && last.role === "user" && last.text === event.text && Date.now() - last.ts < 5000) {
          break; // already there
        }
        set({ messagesByAgent: appendMessage(event.id, { role: "user", text: event.text, ts: Date.now() }) });
        // Start streamMeta — initially "thinking" until first delta.
        const meta = { startedAt: Date.now(), firstDeltaAt: null, mode: "thinking" };
        set({ streamMeta: { ...state.streamMeta, [event.id]: meta } });
        break;
      }
      case "delta": {
        const draft = getDraft(event.id);
        const next = { text: draft.text + event.text, tools: draft.tools, thinking: draft.thinking || "" };
        set({ draftByAgent: setDraft(event.id, next) });
        const agent = state.agents.find(a => a.id === event.id);
        if (agent && agent.status !== "running") {
          set({ agents: upsertAgent({ ...agent, status: "running", lastActivity: Date.now() }) });
        }
        const meta = state.streamMeta[event.id];
        if (meta && !meta.firstDeltaAt) {
          set({
            streamMeta: {
              ...state.streamMeta,
              [event.id]: { ...meta, firstDeltaAt: Date.now(), mode: "doing" },
            },
          });
        }
        break;
      }
      case "thinking": {
        const draft = getDraft(event.id);
        const next = {
          text: draft.text,
          tools: draft.tools,
          thinking: (draft.thinking || "") + (event.text || ""),
        };
        set({ draftByAgent: setDraft(event.id, next) });
        const meta = state.streamMeta[event.id];
        if (meta && !meta.firstDeltaAt) {
          set({
            streamMeta: {
              ...state.streamMeta,
              [event.id]: { ...meta, firstDeltaAt: Date.now(), mode: "thinking" },
            },
          });
        }
        break;
      }
      case "tool": {
        const draft = getDraft(event.id);
        const tool = {
          useId: event.useId,
          name: event.tool,
          input: event.input,
          status: "started",
          ts: Date.now(),
        };
        const next = { text: draft.text, tools: [...draft.tools, tool], thinking: draft.thinking || "" };
        set({ draftByAgent: setDraft(event.id, next) });
        set({ activityLog: pushLog({
          kind: "tool",
          id: event.id,
          name: agentNameOf(event.id),
          text: `used ${event.tool}`,
        }) });
        break;
      }
      case "tool_input": {
        const draft = getDraft(event.id);
        const tools = draft.tools.slice();
        for (let i = tools.length - 1; i >= 0; i--) {
          if (tools[i].useId === event.useId) {
            tools[i] = { ...tools[i], input: event.input };
            break;
          }
        }
        set({ draftByAgent: setDraft(event.id, { text: draft.text, tools, thinking: draft.thinking || "" }) });
        break;
      }
      case "tool_dangerous": {
        const draft = getDraft(event.id);
        const tools = draft.tools.slice();
        for (let i = tools.length - 1; i >= 0; i--) {
          if (tools[i].useId === event.useId) {
            tools[i] = {
              ...tools[i],
              dangerous: { reason: event.reason, kind: event.kind, halted: !!event.halted },
            };
            break;
          }
        }
        set({ draftByAgent: setDraft(event.id, { text: draft.text, tools, thinking: draft.thinking || "" }) });
        break;
      }
      case "tool_result": {
        const draft = getDraft(event.id);
        const tools = draft.tools.slice();
        for (let i = tools.length - 1; i >= 0; i--) {
          const match = event.useId
            ? tools[i].useId === event.useId
            : (tools[i].name === event.tool && tools[i].status === "started");
          if (match) {
            tools[i] = {
              ...tools[i],
              status: event.ok ? "done" : "error",
              result: event.result || tools[i].result,
            };
            break;
          }
        }
        set({ draftByAgent: setDraft(event.id, { text: draft.text, tools, thinking: draft.thinking || "" }) });
        break;
      }
      case "result": {
        const draft = getDraft(event.id);
        const text = draft.text || event.text || "";
        const tools = draft.tools;
        const msg = { role: "assistant", text, ts: Date.now(), tools: tools.length ? tools : undefined };
        const messagesByAgent = appendMessage(event.id, msg);
        const draftByAgent = clearDraft(event.id);
        const agent = state.agents.find(a => a.id === event.id);
        const agents = agent
          ? upsertAgent({ ...agent, status: "idle", lastActivity: Date.now(), lastText: text.slice(0, 120) })
          : state.agents;
        const nextStreamMeta = { ...state.streamMeta };
        delete nextStreamMeta[event.id];
        set({
          messagesByAgent,
          draftByAgent,
          agents,
          streamMeta: nextStreamMeta,
          lastActivityAt: { ...state.lastActivityAt, [event.id]: Date.now() },
          activityLog: pushLog({
            kind: "result",
            id: event.id,
            name: agentNameOf(event.id),
            text: text.slice(0, 100),
            durationMs: event.durationMs,
          }),
        });
        break;
      }
      case "done": {
        // Just ensure agent is idle if we never got a result event
        const agent = state.agents.find(a => a.id === event.id);
        if (agent && agent.status === "running") {
          set({ agents: upsertAgent({ ...agent, status: "idle", lastActivity: Date.now() }) });
        }
        // If draft still exists, flush it as a result-like message
        const draft = state.draftByAgent[event.id];
        if (draft && (draft.text || draft.tools.length)) {
          const msg = { role: "assistant", text: draft.text, ts: Date.now(), tools: draft.tools.length ? draft.tools : undefined };
          set({
            messagesByAgent: appendMessage(event.id, msg),
            draftByAgent: clearDraft(event.id),
          });
        }
        break;
      }
      case "error": {
        const msg = { role: "system", text: `Error: ${event.message}`, ts: Date.now() };
        const messagesByAgent = appendMessage(event.id, msg);
        const draftByAgent = clearDraft(event.id);
        const agent = state.agents.find(a => a.id === event.id);
        const agents = agent
          ? upsertAgent({ ...agent, status: "error", lastActivity: Date.now() })
          : state.agents;
        const nextStreamMeta = { ...state.streamMeta };
        delete nextStreamMeta[event.id];
        set({
          messagesByAgent,
          draftByAgent,
          agents,
          streamMeta: nextStreamMeta,
          lastActivityAt: { ...state.lastActivityAt, [event.id]: Date.now() },
          activityLog: pushLog({
            kind: "error",
            id: event.id,
            name: agentNameOf(event.id),
            text: String(event.message || "error"),
          }),
        });
        break;
      }
      default:
        // Unknown event — ignore but log
        console.warn("[state] unknown event", event);
    }
  }

  // ── Side-effects of settings ────────────────────────────
  function applyThemeFromSettings(settings) {
    if (typeof document === "undefined") return;
    const theme = settings && settings.theme === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", theme);
  }

  // ── High-level actions ──────────────────────────────────
  const actions = {
    async loadSettings() {
      try {
        const settings = await window.iris.getSettings();
        set({ settings });
        applyThemeFromSettings(settings);
        return settings;
      } catch (e) {
        console.error("[state] loadSettings failed", e);
        const fallback = {
          defaultCwd: null,
          recentFolders: [],
          model: "sonnet",
          mode: "subscription",
          apiKey: null,
          theme: "dark",
          irisModel: "sonnet",
          systemPromptExtras: "",
        };
        set({ settings: fallback });
        applyThemeFromSettings(fallback);
      }
    },

    async saveSettings(patch) {
      try {
        const settings = await window.iris.setSettings(patch);
        set({ settings });
        applyThemeFromSettings(settings);
        return settings;
      } catch (e) {
        console.error("[state] saveSettings failed", e);
        const merged = { ...(state.settings || {}), ...patch };
        set({ settings: merged });
        applyThemeFromSettings(merged);
      }
    },

    async loadAgents() {
      try {
        const agents = await window.iris.listAgents();
        // Ensure Iris pseudo-agent exists in the list even if backend doesn't return it
        const hasIris = agents.some(a => a.id === "iris");
        const finalAgents = hasIris
          ? agents
          : [
              {
                id: "iris",
                role: "iris",
                name: "Iris",
                cwd: "",
                model: state.settings?.irisModel || "sonnet",
                status: "idle",
                lastActivity: Date.now(),
                lastText: "",
                createdAt: Date.now(),
                sessionId: null,
              },
              ...agents,
            ];
        set({ agents: finalAgents, ready: true });
        // Eagerly load messages for active agent
        if (state.activeId) {
          await actions.loadMessages(state.activeId);
        }
      } catch (e) {
        console.error("[state] loadAgents failed", e);
        // Fallback: just an Iris stub so the UI renders
        set({
          agents: [{
            id: "iris", role: "iris", name: "Iris", cwd: "",
            model: "sonnet", status: "idle", lastActivity: Date.now(),
            lastText: "", createdAt: Date.now(), sessionId: null,
          }],
          ready: true,
        });
      }
    },

    async loadMessages(id) {
      try {
        const full = await window.iris.getAgent(id);
        if (full && Array.isArray(full.messages)) {
          set({ messagesByAgent: setMessages(id, full.messages) });
        }
      } catch (e) {
        console.warn("[state] loadMessages failed for", id, e);
      }
    },

    async selectAgent(id) {
      if (!id) return;
      const prev = state.activeId;
      const patch = {};
      if (prev && prev !== id) {
        patch.lastViewedAt = { ...state.lastViewedAt, [prev]: Date.now() };
      }
      patch.activeId = id;
      set(patch);
      // If the new thread is idle/error (not currently weaving), they are
      // looking at the current state — mark viewed so the "came back" banner
      // doesn't fire from a previous run's activity.
      const a = state.agents.find((x) => x.id === id);
      if (a && a.status !== "running") {
        set({ lastViewedAt: { ...state.lastViewedAt, [id]: Date.now() } });
      }
      if (!state.messagesByAgent[id]) {
        await actions.loadMessages(id);
      }
    },

    /** Mark a thread as just-viewed (clears the "came back" banner). */
    markViewed(id) {
      if (!id) return;
      set({ lastViewedAt: { ...state.lastViewedAt, [id]: Date.now() } });
    },

    async createAgent(opts = {}) {
      const { name, cwd, initialPrompt, model, apiKeyId, sandbox, importFiles } = opts;
      try {
        const agent = await window.iris.createAgent({
          name, cwd, initialPrompt, model, apiKeyId, sandbox, importFiles,
        });
        // Backend will also emit agent:created; upsert here as a safety net
        set({ agents: upsertAgent(agent) });
        // If initialPrompt provided, optimistically append user message
        if (initialPrompt) {
          set({
            messagesByAgent: appendMessage(agent.id, {
              role: "user", text: initialPrompt, ts: Date.now(),
            }),
          });
        }
        await actions.selectAgent(agent.id);
        return agent;
      } catch (e) {
        console.error("[state] createAgent failed", e);
        throw e;
      }
    },

    async deleteAgent(id) {
      if (!id || id === "iris") return;
      try {
        await window.iris.deleteAgent(id);
        // Backend will emit agent:deleted
      } catch (e) {
        console.error("[state] deleteAgent failed", e);
      }
    },

    async updateAgent(id, patch) {
      if (!id) return null;
      try {
        const updated = await window.iris.updateAgent(id, patch);
        if (updated) set({ agents: upsertAgent(updated) });
        return updated;
      } catch (e) {
        console.error("[state] updateAgent failed", e);
        return null;
      }
    },

    sendMessage(text, targetId) {
      const id = targetId || state.activeId;
      if (!id || !text || !text.trim()) return;
      // Optimistically append user message
      set({
        messagesByAgent: appendMessage(id, { role: "user", text, ts: Date.now() }),
      });
      // Mark agent running
      const agent = state.agents.find(a => a.id === id);
      if (agent) {
        set({ agents: upsertAgent({ ...agent, status: "running", lastActivity: Date.now() }) });
      }
      // Initialize empty draft so the streaming bubble appears immediately
      set({ draftByAgent: setDraft(id, { text: "", tools: [] }) });
      try {
        if (id === "iris") window.iris.sendToIris(text);
        else window.iris.sendToAgent(id, text);
      } catch (e) {
        console.error("[state] sendMessage failed", e);
      }
    },

    sendToIris(text) {
      return actions.sendMessage(text, "iris");
    },

    stopAgent(id) {
      try { window.iris.stopAgent(id); } catch (e) { console.warn(e); }
    },

    resumeAgent(id) {
      try { window.iris.resumeAgent(id); } catch (e) { console.warn(e); }
    },

    async pickFolder() {
      try { return await window.iris.pickFolder(); }
      catch (e) { console.error(e); return null; }
    },
  };

  // ── Wire global event listener ──────────────────────────
  if (typeof window !== "undefined" && window.iris && typeof window.iris.onAgentEvent === "function") {
    window.iris.onAgentEvent((payload) => {
      dispatch(payload);
    });
  }

  return { get, set, subscribe, dispatch, actions };
}

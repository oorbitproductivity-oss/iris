// ═══════════════════════════════════════════════════════════
// slash-commands.js — Local slash command engine for the worker chat.
// Commands run inside the app (state actions, modals, etc.) — they are NOT
// passed through to the claude CLI. To send a literal `/foo` to claude,
// type it after any other character (e.g. " /foo").
// ═══════════════════════════════════════════════════════════

import { showSettingsModal } from "./settings.js";
import { showNewSessionModal } from "./new-session.js";
import { showSessionSettingsModal } from "./session-settings.js";
import { showToast } from "./util.js";

export const MODELS = ["sonnet", "opus", "haiku"];

// Each command:
//   name        — without the leading slash
//   desc        — single-line summary shown in the popover and /help modal
//   usage       — what the user types (with optional argument hint)
//   needsAgent  — true if it requires a selected worker thread
//   run(ctx)    — handler. ctx: { state, agentId, agent, arg, rawInput }
//                 must return true if it handled the input (so the composer
//                 knows not to send the text to claude).
export const COMMANDS = [
  {
    name: "help",
    desc: "List every slash command",
    usage: "/help",
    needsAgent: false,
    run: ({ state }) => { showHelpModal(state); return true; },
  },
  {
    name: "model",
    desc: "Swap this thread's model (sonnet · opus · haiku)",
    usage: "/model <sonnet|opus|haiku>",
    needsAgent: true,
    run: async ({ state, agentId, arg }) => {
      const choice = (arg || "").trim().toLowerCase();
      if (!choice) { showToast("Usage: /model <sonnet|opus|haiku>", { error: true }); return true; }
      if (!MODELS.includes(choice)) {
        showToast(`Unknown model: ${choice}. Try one of: ${MODELS.join(", ")}`, { error: true });
        return true;
      }
      await state.actions.updateAgent(agentId, { model: choice });
      showToast(`Model switched to ${choice}`);
      return true;
    },
  },
  {
    name: "cwd",
    desc: "Show this thread's working directory",
    usage: "/cwd",
    needsAgent: true,
    run: ({ agent }) => { showToast(agent.cwd || "(no working directory)"); return true; },
  },
  {
    name: "open",
    desc: "Reveal the working directory in the OS file explorer",
    usage: "/open",
    needsAgent: true,
    run: ({ agent }) => {
      if (!agent.cwd) { showToast("This thread has no working directory.", { error: true }); return true; }
      window.iris?.openPath?.(agent.cwd);
      return true;
    },
  },
  {
    name: "stop",
    desc: "Stop the current turn",
    usage: "/stop",
    needsAgent: true,
    run: ({ state, agentId }) => { state.actions.stopAgent(agentId); return true; },
  },
  {
    name: "new",
    desc: "Open the new-thread modal",
    usage: "/new",
    needsAgent: false,
    run: ({ state }) => { showNewSessionModal(state); return true; },
  },
  {
    name: "iris",
    desc: "Toggle the Iris orchestrator overlay",
    usage: "/iris",
    needsAgent: false,
    run: () => { if (typeof window !== "undefined" && window.__iris_toggle) window.__iris_toggle(); return true; },
  },
  {
    name: "settings",
    desc: "Open Settings",
    usage: "/settings",
    needsAgent: false,
    run: ({ state }) => { showSettingsModal(state); return true; },
  },
  {
    name: "thread",
    desc: "Open this thread's settings (rename, model, etc.)",
    usage: "/thread",
    needsAgent: true,
    run: ({ state, agentId }) => { showSessionSettingsModal(state, agentId); return true; },
  },
  {
    name: "rename",
    desc: "Rename this thread",
    usage: "/rename <new name>",
    needsAgent: true,
    run: async ({ state, agentId, arg }) => {
      const name = (arg || "").trim();
      if (!name) { showToast("Usage: /rename <new name>", { error: true }); return true; }
      await state.actions.updateAgent(agentId, { name });
      showToast(`Renamed to "${name}"`);
      return true;
    },
  },
  {
    name: "new-window",
    desc: "Open another Iris Code window",
    usage: "/new-window",
    needsAgent: false,
    run: () => { window.iris?.windowNew?.(); return true; },
  },
];

// Match a leading `/word[ args]` and return { cmd, arg } if recognized.
export function parse(input) {
  if (!input || input[0] !== "/") return null;
  const m = input.match(/^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const arg = m[2] || "";
  const cmd = COMMANDS.find((c) => c.name === name);
  if (!cmd) return null;
  return { cmd, arg };
}

// Filter commands by typed prefix (everything after the leading `/`, before space).
export function filter(input) {
  if (!input || input[0] !== "/") return [];
  const idx = input.indexOf(" ");
  const head = idx === -1 ? input.slice(1) : input.slice(1, idx);
  const q = head.toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(q));
}

export async function execute(input, state) {
  const parsed = parse(input);
  if (!parsed) return false;
  const { cmd, arg } = parsed;
  const agentId = state.get().activeId;
  const agent = state.get().agents.find((a) => a.id === agentId);
  if (cmd.needsAgent && (!agentId || agentId === "iris")) {
    showToast(`/${cmd.name} needs a worker thread selected.`, { error: true });
    return true;
  }
  try {
    await cmd.run({ state, agentId, agent, arg, rawInput: input });
  } catch (e) {
    console.error(`[slash:${cmd.name}]`, e);
    showToast(`/${cmd.name} failed: ${e.message || e}`, { error: true });
  }
  return true;
}

function showHelpModal(state) {
  import("./util.js").then(({ h, openModal }) => {
    const modal = document.createElement("div");
    modal.className = "modal";
    const header = h("div", { class: "modal-header" },
      h("div", { class: "modal-title" }, "Slash commands"),
      h("button", { class: "modal-close", "aria-label": "Close" }, "✕"),
    );
    const body = h("div", { class: "modal-body" });
    const list = h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } });
    for (const c of COMMANDS) {
      const row = h("div", { class: "field", style: { paddingBottom: "8px", borderBottom: "1px solid rgba(255,255,255,0.06)" } });
      const head = h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "12px" } });
      head.append(
        h("code", { style: { color: "var(--accent)", fontFamily: "var(--font-mono)" } }, c.usage),
        c.needsAgent ? h("span", { class: "hint" }, "thread only") : null,
      );
      const desc = h("div", { class: "hint", style: { marginTop: "4px" } }, c.desc);
      row.append(head, desc);
      list.append(row);
    }
    body.append(list);
    modal.append(header, body);
    const { close } = openModal(modal, {});
    header.querySelector(".modal-close").addEventListener("click", () => close());
  });
}

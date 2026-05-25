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

// Build a "user command" runtime shape from a stored {id,trigger,name,description,template}
// record. Mirrors the built-in COMMANDS entry interface so parse/filter/execute can
// treat both pools uniformly.
function toRuntimeUserCommand(record) {
  if (!record || !record.trigger || !record.template) return null;
  const trigger = String(record.trigger).toLowerCase();
  return {
    name: trigger,
    desc: record.description || record.name || `Custom: /${trigger}`,
    usage: `/${trigger}`,
    needsAgent: false,
    custom: true,
    template: String(record.template),
    run: ({ state, rawInput }) => {
      // The composer is the active textarea — replace the "/trigger ...args"
      // prefix with the rendered template, place caret on {{cursor}}.
      const ta = (typeof document !== "undefined" && document.activeElement instanceof HTMLTextAreaElement)
        ? document.activeElement
        : null;
      const selectionText = ta && ta.selectionStart !== ta.selectionEnd
        ? ta.value.substring(ta.selectionStart, ta.selectionEnd)
        : "";
      const { text, cursor } = renderTemplate(String(record.template), { selection: selectionText });
      if (ta) {
        const v = ta.value;
        // Find the `/trigger[ args]` prefix and replace it with the rendered template.
        const m = v.match(/^\s*\/[a-zA-Z][\w-]*(?:\s+[\s\S]*)?$/);
        if (m) {
          ta.value = text;
        } else {
          // Fallback: just append. Shouldn't happen because execute() only fires
          // when the input begins with `/`.
          ta.value = text;
        }
        const caret = cursor != null ? cursor : ta.value.length;
        try { ta.setSelectionRange(caret, caret); } catch {}
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        ta.focus();
      }
      // User commands NEVER auto-send — they just transform the composer text
      // so the user can review and hit Enter. Return true to mark handled.
      return true;
    },
  };
}

/**
 * Pure template renderer. Substitutes `{{selection}}` with the provided
 * selection text and `{{cursor}}` with empty string (returning its
 * post-substitution offset so callers can position the caret).
 *
 * Returns `{ text, cursor }`. `cursor` is `null` when the template has no
 * `{{cursor}}` marker — callers should treat that as "caret at end".
 *
 * Exported so tests/slash-commands.test.js can exercise it in plain Node.
 */
export function renderTemplate(template, { selection = "", cursor = "" } = {}) {
  if (typeof template !== "string") return { text: "", cursor: null };
  const sel = selection == null ? "" : String(selection);
  const cur = cursor == null ? "" : String(cursor);
  // Substitute {{selection}} first. {{cursor}} substitution is tracked so we
  // can compute the resulting caret offset accurately.
  let text = template.replace(/\{\{selection\}\}/g, sel);
  const cursorMarker = "{{cursor}}";
  const idx = text.indexOf(cursorMarker);
  if (idx === -1) {
    return { text, cursor: null };
  }
  // Replace ALL occurrences with `cur` (typically empty). The caret lands on
  // the FIRST occurrence — multiple {{cursor}} tokens in one template would be
  // a user mistake, but we still substitute cleanly.
  text = text.split(cursorMarker).join(cur);
  // Caret offset = the index of the first marker in the post-selection text,
  // plus the length of the substitution (so the caret lands AFTER the
  // substituted value — important when `cursor` is non-empty).
  return { text, cursor: idx + cur.length };
}

/**
 * Validate a single user slash command record. Returns `null` if valid, or an
 * error string otherwise. Triggers must match the same pattern parse() uses
 * for matching, names + templates must be non-empty.
 */
export function validateUserCommand(record, { existingTriggers = [] } = {}) {
  if (!record || typeof record !== "object") return "Not an object";
  const trigger = String(record.trigger || "").trim();
  if (!trigger) return "Missing trigger";
  if (!/^[a-zA-Z][\w-]*$/.test(trigger)) return `Invalid trigger "${trigger}" (use letters/digits/-/_, starting with a letter)`;
  const name = String(record.name || "").trim();
  if (!name) return "Missing name";
  const template = String(record.template || "");
  if (!template.trim()) return "Missing template";
  if (existingTriggers.some((t) => String(t).toLowerCase() === trigger.toLowerCase())) {
    return `Duplicate trigger "${trigger}"`;
  }
  return null;
}

/**
 * Validate an imported JSON payload of user commands. Returns
 * `{ ok: boolean, commands?: Array, errors?: Array<{ index, error }> }`.
 * Accepts either a bare array OR `{ commands: [...] }` (so import is
 * symmetric with the export shape).
 */
export function parseImportedCommands(json) {
  const errors = [];
  let raw = json;
  if (raw && typeof raw === "object" && !Array.isArray(raw) && Array.isArray(raw.commands)) {
    raw = raw.commands;
  }
  if (!Array.isArray(raw)) return { ok: false, errors: [{ index: -1, error: "Expected array of commands" }] };
  const out = [];
  const seen = [];
  for (let i = 0; i < raw.length; i++) {
    const rec = raw[i];
    const err = validateUserCommand(rec, { existingTriggers: seen });
    if (err) { errors.push({ index: i, error: err }); continue; }
    seen.push(rec.trigger);
    out.push({
      id: rec.id || `usr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      trigger: String(rec.trigger).trim(),
      name: String(rec.name).trim(),
      description: rec.description ? String(rec.description) : "",
      template: String(rec.template),
    });
  }
  if (errors.length) return { ok: false, errors, commands: out };
  return { ok: true, commands: out };
}

/**
 * Read user-defined slash commands out of state.settings.slashCommands and
 * return them as runtime command entries (same shape as COMMANDS). User
 * commands whose trigger collides with a built-in are dropped (built-in wins).
 */
function userCommands(state) {
  try {
    const s = state && state.get && state.get();
    const raw = (s && s.settings && Array.isArray(s.settings.slashCommands)) ? s.settings.slashCommands : [];
    const builtinNames = new Set(COMMANDS.map((c) => c.name));
    const out = [];
    const seen = new Set();
    for (const rec of raw) {
      const rt = toRuntimeUserCommand(rec);
      if (!rt) continue;
      if (builtinNames.has(rt.name)) continue;
      if (seen.has(rt.name)) continue;
      seen.add(rt.name);
      out.push(rt);
    }
    return out;
  } catch {
    return [];
  }
}

// Match a leading `/word[ args]` and return { cmd, arg } if recognized.
export function parse(input, state) {
  if (!input || input[0] !== "/") return null;
  const m = input.match(/^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const arg = m[2] || "";
  const all = [...COMMANDS, ...userCommands(state)];
  const cmd = all.find((c) => c.name === name);
  if (!cmd) return null;
  return { cmd, arg };
}

// Filter commands by typed prefix (everything after the leading `/`, before space).
export function filter(input, state) {
  if (!input || input[0] !== "/") return [];
  const idx = input.indexOf(" ");
  const head = idx === -1 ? input.slice(1) : input.slice(1, idx);
  const q = head.toLowerCase();
  const all = [...COMMANDS, ...userCommands(state)];
  return all.filter((c) => c.name.startsWith(q));
}

export async function execute(input, state) {
  const parsed = parse(input, state);
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

# Iris Code — IPC Protocol Contract

This is the contract between the Electron renderer (frontend) and the main process (backend). All parallel work must respect these names and shapes.

---

## Renderer → Main (invoke / send)

### Settings
- `invoke("settings:get")` → `Settings`
- `invoke("settings:set", patch)` → `Settings`

```ts
type Settings = {
  defaultCwd: string | null;        // default working directory for new agents
  recentFolders: string[];          // last 10 picked folders
  model: string;                    // "sonnet" | "opus" | "haiku" | full id
  mode: "subscription" | "apikey";  // Mode A vs Mode B (Mode B is stub for MVP)
  apiKey: string | null;            // only used in apikey mode
  theme: "dark" | "light";
  irisModel: string;                // model used for Iris orchestrator
  systemPromptExtras: string;       // appended to every agent's system prompt
};
```

### Folder picker
- `invoke("folder:pick")` → `string | null` (absolute path)

### Agents
- `invoke("agents:list")` → `AgentSummary[]`
- `invoke("agents:create", { name, cwd, initialPrompt?, model? })` → `AgentSummary`
- `invoke("agents:delete", id)` → `true`
- `invoke("agents:get", id)` → `AgentFull` (includes full message log)
- `send("agents:send", { id, message })` — fire-and-forget; renderer subscribes to `agent:event`
- `send("agents:stop", id)` — kill running subprocess but keep session
- `send("agents:resume", id)` — relaunch on resume (no-op if already running)

```ts
type AgentRole = "iris" | "worker";
type AgentStatus = "idle" | "running" | "error";

type AgentSummary = {
  id: string;                  // uuid
  role: AgentRole;
  name: string;                // display name
  cwd: string;                 // working dir (Iris has cwd = userData/iris-home)
  model: string;
  status: AgentStatus;
  lastActivity: number;        // epoch ms
  lastText: string;            // short snippet of last assistant message
  createdAt: number;
  sessionId: string | null;    // claude session id (resumable)
};

type AgentFull = AgentSummary & {
  messages: Message[];
};

type Message =
  | { role: "user"; text: string; ts: number }
  | { role: "assistant"; text: string; ts: number; tools?: ToolCall[] }
  | { role: "system"; text: string; ts: number };

type ToolCall = { name: string; input?: any; status: "started" | "done" | "error"; ts: number };
```

### Iris-specific
- `send("iris:send", { message })` — sends to the Iris orchestrator (always has id `"iris"`)
- The Iris agent receives an auto-injected context block on every message describing the current agent state (names, status, last activity).

---

## Main → Renderer (event broadcast)

All events are sent via `webContents.send("agent:event", payload)`. The renderer attaches one global listener and dispatches by `payload.type`.

```ts
type AgentEvent =
  // Agent lifecycle
  | { type: "agent:created"; agent: AgentSummary }
  | { type: "agent:deleted"; id: string }
  | { type: "agent:updated"; agent: AgentSummary } // status/lastText changed
  // Streaming from claude subprocess
  | { type: "session"; id: string; sessionId: string; model: string }
  | { type: "delta"; id: string; text: string }              // assistant token
  | { type: "tool"; id: string; tool: string; input?: any }  // tool call started
  | { type: "tool_result"; id: string; tool: string; ok: boolean }
  | { type: "result"; id: string; text: string; durationMs?: number }
  | { type: "error"; id: string; message: string }
  | { type: "done"; id: string; code: number }
  // User message echoed back (so all open windows stay in sync)
  | { type: "user"; id: string; text: string };
```

---

## Iris orchestrator behavior

- Iris is launched on app start with `--system-prompt` describing its role.
- On every user message to Iris, the main process prepends a `<iris-context>` block listing all sub-agents and their summaries.
- Iris can emit ```action ... ``` fenced blocks in its response, which the renderer renders as clickable suggestion buttons. Supported action types:
  - `{"type":"create_agent","name":"...","cwd":"...","prompt":"..."}`
  - `{"type":"send_to_agent","id":"...","message":"..."}`
  - `{"type":"stop_agent","id":"..."}`
  - `{"type":"focus_agent","id":"..."}`

The user must click the button to actually execute — Iris suggests, the user confirms.

---

## File layout

```
iris-app/
├── package.json
├── main.js                      # Electron main; wires IPC; spawns AgentManager
├── preload.js                   # contextBridge -> window.iris
├── lib/
│   ├── agent-manager.js         # Manages N claude subprocesses; emits events
│   ├── iris.js                  # Iris context injection + action parsing
│   └── store.js                 # Disk persistence (settings, sessions)
└── app/
    ├── index.html               # Shell
    ├── css/
    │   ├── tokens.css           # Colors, spacing, typography vars
    │   ├── layout.css           # Three-pane grid, titlebar
    │   ├── components.css       # Buttons, inputs, modals, sidebar
    │   └── chat.css             # Bubbles, tool cards, streaming cursor
    ├── js/
    │   ├── app.js               # Entry point, global state, event router
    │   ├── ui/
    │   │   ├── sidebar.js
    │   │   ├── chat-view.js
    │   │   ├── iris-view.js
    │   │   ├── new-session.js
    │   │   └── settings.js
    │   └── lib/
    │       ├── markdown.js      # Tiny markdown renderer
    │       └── state.js         # Reactive store
    └── vendor/                  # (empty; everything inlined for MVP)
```

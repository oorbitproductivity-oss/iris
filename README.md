# Iris Code

[![MIT License](https://img.shields.io/badge/license-MIT-c89b3c.svg)](LICENSE)
[![Open source](https://img.shields.io/badge/open--source-yes-c89b3c.svg)](https://github.com/oorbitproductivity-oss/iris)

> The god of sub-messaging. A premium open-source desktop GUI for Claude Code with a Spotlight-style master orchestrator (Iris), parallel sub-agents, a command palette, workflow templates, conversation export, a live stats dashboard, themes, voice input, tags, a diff viewer, a memory editor, plan mode, sandboxed working directories, per-chat API keys, and a polished dark theme.

Open source · [Docs](https://iris-code.pages.dev/docs.html)

**v0.4.0** — adds the **Telegram Remote Agent** bridge: DM your personal bot, every message becomes a Claude Code task on your desktop, results stream back as bot replies. Bring-your-own-bot, encrypted at rest, no shared infrastructure. See [`docs/telegram.md`](docs/telegram.md) for setup.

**v0.3.0** — ten new features land on top of v0.2's seven, and the project is now open source under MIT with full contributor docs. See `site/index.html` for the product page, `site/download.html` for installation, and `site/sponsor.html` to support the project.

## What it is

Iris Code wraps the Claude Code CLI in a desktop app that gives you two ways to talk to your agents:

1. **The main window** — sidebar of every sub-agent, full chat view, action chips, settings, file/folder pickers.
2. **Spotlight overlay** — press `Ctrl/Cmd + Shift + I` from anywhere and a floating glass card pops up. Type a question, Iris streams back her response with markdown + clickable action suggestions. `Ctrl+Enter` expands the conversation into the main window.

## Core features

| Feature | Status |
|---|---|
| Iris orchestrator with always-on context injection | ✅ |
| Spotlight overlay (global hotkey, frameless glass card) | ✅ |
| Multi-agent runtime (N parallel `claude` subprocesses) | ✅ |
| Stream-json parsing — token-by-token chat | ✅ |
| Action chips (Iris suggests, you click) — create / send / stop / focus / **open_url / open_path** | ✅ |
| **Per-agent API key picker** — Subscription or named key, set at session creation | ✅ |
| **Named API key vault** — settings UI for CRUD, encrypted at rest (safeStorage / AES-GCM fallback) | ✅ |
| **Sandboxed working directories** — opt-in per agent; auto-copies source files into a private workspace; exportable back | ✅ |
| Session persistence + resume by `session_id` | ✅ |
| Sidebar with status dots, relative time, right-click menu | ✅ |
| Settings: default cwd, default model, Iris model, system-prompt extras, sandbox-by-default, hotkey, theme | ✅ |
| Codex-grade visual polish (warm dark, gold accent, micro-motion) | ✅ |
| **Command palette** (Ctrl/Cmd+Shift+P) — fuzzy search every action | ✅ v0.2 |
| **Workflow templates** — one-click Code Review / Refactor / Tests / Bug Hunt / Docs / Migration / Perf / Onboarding | ✅ v0.2 |
| **Conversation export** — Markdown or JSON for any thread | ✅ v0.2 |
| **Stats dashboard** — threads / messages / tool usage / 24 h activity | ✅ v0.2 |
| **System notifications** — toast when an agent finishes while you're in another app | ✅ v0.2 |
| **Pinned threads + prompt snippets** — pin favorites, type `/` for saved prompts | ✅ v0.2 |
| **Five themes** — Codex Dark, Codex Light, Midnight, Solarized, Forest | ✅ v0.3 |
| **Global search** — `Ctrl/Cmd+Shift+F` across every thread's history | ✅ v0.3 |
| **Thread tags** — color-coded sidebar tags + filtering | ✅ v0.3 |
| **Voice input** — Web Speech API mic in the Iris overlay | ✅ v0.3 |
| **Inline diff viewer** — file edits render as side-by-side diffs | ✅ v0.3 |
| **CLAUDE.md memory editor** — read/edit project memory from inside the app | ✅ v0.3 |
| **Per-thread cost tracker** — input / output / cache tokens, turns per thread | ✅ v0.3 |
| **Plan mode** — toggle to require a plan before the agent acts | ✅ v0.3 |
| **Auto-update check** — non-blocking banner when a new version ships | ✅ v0.3 |
| **Interactive welcome tour** — 5-step orientation for new and upgrading users | ✅ v0.3 |
| **Telegram Remote Agent** — DM your personal bot to run Claude Code tasks on your desktop; bring-your-own-bot, encrypted token, 6-digit pairing | ✅ v0.4 |
| Mode B "Use a non-Anthropic API" (ACP / LiteLLM) | 📋 v0.3 |
| Live browser pane (Playwright MCP) | 📋 v0.3 |
| Diff viewer for file edits | 📋 v0.3 |

## Contributing & support

- **Read the guide**: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- **Be excellent to each other**: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)
- **Found a security issue?** See [`SECURITY.md`](SECURITY.md). Please email — don't open a public issue.
- **Join the community**: [GitHub Discussions](https://github.com/oorbitproductivity-oss/iris/discussions)

## Requirements

- Windows / macOS / Linux
- Node.js 20+
- `claude` CLI on your PATH (`claude auth login` for subscription mode; an Anthropic API key for the named-key mode)

## Run

```bash
cd iris-app
npm install
npm start            # production mode
npm run dev          # DevTools + console forwarding (--dev flag)
npm test             # backend smoke test (real claude subprocess + key vault + sandbox)
```

## Releasing

End-to-end build → upload → deploy → verify recipe is in [`docs/release.md`](docs/release.md). Read it before cutting a Windows release — it covers the per-arch rename dance, hash regeneration, GitHub release upload, Cloudflare Pages deploy, and the two known issues (long-description shortcut corruption, SmartScreen on the unsigned exe).

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| **`Ctrl/Cmd + Shift + I`** | Toggle Spotlight overlay (global — works anywhere) |
| `Ctrl/Cmd + N` | New session (main window) |
| `Ctrl/Cmd + K` | Focus Iris view (main window) |
| `Ctrl/Cmd + ,` | Settings (main window) |
| `Enter` | Send |
| `Shift + Enter` | Newline |
| `Ctrl/Cmd + Enter` | (Spotlight) Hide overlay + expand conversation into main window |
| `Esc` | (Spotlight) Hide |

The Spotlight hotkey is configurable in Settings.

## How it works

```
┌──────────────────────────────────────────────────────────────┐
│  Electron main process                                       │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  AgentManager                                        │    │
│  │  - one claude subprocess per agent (keyed by id)     │    │
│  │  - "iris" is special: always-present, read-only      │    │
│  │    toolset, custom system prompt                     │    │
│  │  - per-agent apiKeyId → injects ANTHROPIC_API_KEY    │    │
│  │  - per-agent sandbox → cwd is private temp dir       │    │
│  │  Store: settings, agents, messages, api-keys (enc)   │    │
│  └──────────────────────────────────────────────────────┘    │
│                          ↓                                   │
│                   broadcast("agent:event")                   │
│         ↙─────────────────────────────────────↘              │
│  ┌──────────────────────────────┐  ┌─────────────────────┐   │
│  │  Main window renderer        │  │  Spotlight renderer │   │
│  │  - sidebar, chat, iris view  │  │  - floating glass   │   │
│  │  - settings, new-session     │  │    overlay          │   │
│  │  - markdown + action chips   │  │  - same Iris stream │   │
│  └──────────────────────────────┘  └─────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

## Iris's action vocabulary

Iris emits fenced JSON blocks:

```action
{"type":"create_agent","name":"Refactor auth","cwd":"C:/projects/foo","prompt":"Find the login handler and split it..."}
```

| Action | Effect when clicked |
|---|---|
| `create_agent` | Opens new-session modal pre-filled |
| `send_to_agent` | Sends message to existing agent id |
| `stop_agent` | Terminates the subprocess (session preserved) |
| `focus_agent` | Switches to that agent's tab |
| `open_url` | Opens URL in default browser |
| `open_path` | Opens path with the OS default handler |

In Spotlight, `open_url` / `open_path` execute inline; the others auto-expand into the main window.

## API keys

- Settings → API Keys → `+ Add key`. Name + value.
- Values are encrypted via `electron.safeStorage` (OS keychain on macOS/Windows, libsecret on Linux). Falls back to local AES-256-GCM with a 600-perm seed file if safeStorage is unavailable.
- Per-agent picker in the new-session modal: choose Subscription OR a named key.
- Settings has a "Default key for new agents" dropdown.

## Sandbox mode

- Toggle in new-session modal.
- Backing directory: `userData/iris-data/sandboxes/<agent-id>/`.
- On creation, if a "source folder" is provided, the agent's regular files (not dotfiles, not subdirs) are shallow-copied in.
- The agent runs as if that directory IS its project root. Anything it writes stays in the sandbox.
- "Export back" via `window.iris.exportSandbox(id, targetDir?)` copies files back to the source folder (or any target). Wire this into the UI as a follow-up — the backend is ready.

## File layout

```
iris-app/
├── main.js                  Electron main; spawns AgentManager; spotlight window; global hotkey
├── preload.js               contextBridge → window.iris
├── lib/
│   ├── agent-manager.js     subprocess pool, stream-json, sandbox, key injection
│   ├── iris.js              system prompt + <iris-context> builder
│   └── store.js             settings / agents / messages / encrypted api-keys
├── app/
│   ├── index.html           main window shell
│   ├── spotlight.html       overlay shell
│   ├── css/
│   │   ├── tokens.css       design tokens (colors, spacing, type scale)
│   │   ├── layout.css       titlebar + app grid + sidebar internals
│   │   ├── components.css   buttons, inputs, modals, pills, chips
│   │   ├── chat.css         message bubbles, tool cards, composer
│   │   └── spotlight.css    overlay glass card + entry animation
│   └── js/
│       ├── app.js           main entry + router
│       ├── spotlight.js     overlay entry + stream handler
│       ├── lib/             state.js (reactive store), markdown.js
│       └── ui/              sidebar / chat-view / iris-view / new-session / settings / util
├── PROTOCOL.md              the contract used during the parallel build
├── smoke-test.js            backend integration test
└── README.md                this file
```

## Limitations / next

- One in-flight turn per agent (you'll see "Agent is busy" if you stack messages).
- No live "interactive mode" yet — each turn is `-p` style. To get full slash-command parity with the bare `claude` REPL, the next iteration should refactor agent-manager to use `--input-format stream-json` and keep the subprocess alive between turns.
- Sandbox is a directory-scoped contain — not a true OS sandbox. Docker / Windows Sandbox integration is on the roadmap.
- Spotlight ignores tool-call events to stay clean; tool cards only appear in the main window.

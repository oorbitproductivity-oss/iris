# CLAUD — Implementation Plan

> A full end-to-end document explaining each feature in Iris v0.5: what it is, what its purpose is, how it works, and how it plugs into the existing app.

---

## Architecture spine (read this first)

Every feature in v0.5 follows the same four-layer shape that the rest of Iris already uses. This is non-negotiable — it is what keeps the codebase navigable.

| Layer | Where | Responsibility |
|---|---|---|
| **Main-process module** | `lib/<feature>/` | Pure Node.js logic. No Electron-renderer imports. |
| **IPC handler block** | `main.js` (`// ── <Feature> ──`) | `ipcMain.handle(...)` / `ipcMain.on(...)` registrations. |
| **Preload accessor** | `preload.js` (`iris.<feature> = { ... }`) | Exposes safe methods to the renderer via `contextBridge`. |
| **Renderer UI module** | `app/js/ui/<feature>.js` | Self-contained DOM widget. Exports `init(rootEl)`. |

Shared rules:
- All persistent state goes through `Store` in `lib/store.js`.
- All secrets go through the encrypted key vault (`safeStorage` with AES-GCM fallback).
- All streaming events use `broadcast(event)` so they reach the renderer, the remote bridge, and the Telegram service simultaneously.
- Every feature ships behind a settings flag so it can be dark-shipped and smoke-tested before being shown in the UI.
- New runtime dependencies require written justification. Approved for v0.5: `node-pty`, `xterm`, `xterm-addon-fit`.

---

# Tier 1 — The Three Key Features

## Feature 1 — MCP Server Marketplace

### Purpose
Right now, installing a Model Context Protocol server (the standard way to give an AI agent new capabilities) means hand-editing JSON config files and looking up commands on GitHub. The marketplace turns that into a one-click experience inside Iris, like an app store for AI extensions.

This is the **prerequisite** for the browser pane (Feature 2), because the browser pane is itself an MCP server (Playwright). Building the marketplace first means Feature 2 just becomes "click install" rather than its own custom plumbing.

### What it does
- Opens a new "MCP" tab in Settings.
- Lists ~8+ curated, vetted MCP servers (Playwright, GitHub, Postgres, Fetch, Filesystem, Memory, Sequential-Thinking, Time).
- Each server has a card: name, description, install count, category, and an "Install globally" or "Install for this agent" button.
- If the server needs a secret (e.g. GitHub Personal Access Token), the install dialog asks for it and stores it encrypted.
- After install, the next agent run picks up the server automatically — the agent gains new tools transparently.

### How it works
- The catalog lives as a static JSON file at `iris-code.pages.dev/mcp-catalog.json` (same Cloudflare Pages surface as the existing `latest.json`). No backend, no auth. Refresh on app launch with 24-hour cache.
- A bundled fallback catalog ships inside the app so it works offline.
- Iris's existing `agent-manager.js` is extended to pass `--mcp-config <path>` to the `claude` subprocess at spawn time.
- Secrets are stored in the existing encrypted key vault and injected via environment variables at spawn — never written to plaintext `.mcp.json` files on disk.

### Files
- New: `lib/mcp/registry.js`, `lib/mcp/installer.js`, `lib/mcp/catalog-bundled.json`, `app/js/ui/mcp-marketplace.js`
- Modify: `main.js` (IPC), `preload.js` (bridge), `lib/agent-manager.js`, `lib/store.js`
- Docs: `docs/mcp-marketplace.md`
- Test: `tests/mcp-marketplace.test.js`

### Done when
A user opens Settings → MCP → installs GitHub with a PAT → creates an agent → asks "list my open PRs" → the agent uses the new MCP tool transparently.

---

## Feature 2 — Embedded Browser Pane (Playwright)

### Purpose
This is the headline Codex-parity feature. The agent should not have to describe what a webpage looks like — the user should *see the agent browsing*. A live, side-by-side browser pane the agent controls (and the user can take over) is the single biggest "this feels premium" lever.

### What it does
- A user toggles the browser pane on any agent — a webview opens on the right side of the chat with a draggable splitter.
- The agent can navigate, click, fill forms, and take screenshots using the Playwright MCP server (installed via Feature 1).
- Screenshots stream back into the chat as inline images so the conversation remains the canonical record.
- The user can take over the mouse and keyboard at any time — it is a real browser, not a sandbox.
- Each agent gets its own cookie jar so sessions never bleed across threads.

### How it works
- Electron's built-in `<webview>` tag is used with `partition="persist:agent-<id>"` for per-agent isolation. No new runtime dependency.
- A small main-process bridge (`lib/browser/playwright-bridge.js`) lazy-spawns the Playwright MCP server only when the pane is actually opened, and kills it after 5 minutes of being hidden to reclaim memory.
- Security: `nodeIntegration: false`, `contextIsolation: true`, `allowpopups: false`, plus a strict CSP on the host page.

### Files
- New: `lib/browser/playwright-bridge.js`, `app/js/ui/browser-pane.js`
- Modify: `main.js` (IPC), `preload.js`, `app/index.html`, `app/css/*.css`
- Docs: `docs/browser-pane.md`
- Test: `tests/browser-pane.test.js`

### Done when
Open a new agent → toggle browser pane → ask "go to news.ycombinator.com and tell me the top story" → the webview navigates visibly, the agent screenshots, the reply names the headline.

---

## Feature 3 — Integrated Terminal Pane

### Purpose
Today, anyone using Iris still has to alt-tab to PowerShell to run `git status`, start a dev server, or check what file the agent just touched. A real terminal inside Iris erases that friction. It also lays the foundation for future features like background tasks and "open terminal here from the jump list."

### What it does
- Each agent can open one or more terminal tabs (xterm.js front-end, real PTY back-end).
- Default shell is the platform default (PowerShell on Windows, `$SHELL` elsewhere).
- Terminals survive renderer reloads — the PTY stays alive in the main process.
- An explicit "share last 50 lines with agent" button copies output into the chat input as a fenced code block. Sharing is deliberate, not automatic, so the agent's context window stays clean.

### How it works
- `node-pty` provides the PTY on all platforms; xterm.js + `xterm-addon-fit` render it in the renderer.
- One PTY per `(agentId, terminalId)` pair, tracked in `lib/terminal/pty-manager.js`.
- History capped at 10,000 lines per terminal to bound memory.
- If `node-pty` fails to load (e.g. prebuilt binary missing on an exotic platform), the feature disables itself with a clear toast — the app never crashes.

### Files
- New: `lib/terminal/pty-manager.js`, `app/js/ui/terminal-pane.js`
- Modify: `main.js` (IPC), `preload.js`, `package.json` (add `node-pty`, `xterm`, `xterm-addon-fit`, `electron-rebuild`), `DEPLOY.md`
- Docs: `docs/terminal.md`
- Test: `tests/terminal.test.js`

### Done when
Open a Claude agent → click terminal tab → run `git status` interactively → click "share last 50 lines" → output lands in the chat input ready to send.

---

# Tier 2 — The Four Polish Features

## Feature 4 — Custom Slash Commands

### Purpose
Iris already supports built-in slash commands and prompt snippets. Letting users define their own — `/standup`, `/fix-pr`, `/journal`, anything — turns Iris into a personal power-user tool. Custom commands are also exportable, so a team can share their library.

### What it does
- Define a command with a trigger (e.g. `/standup`), a name, a description, and a template prompt.
- The prompt supports `{{selection}}` (replaced with currently-selected text in the input) and `{{cursor}}` (final cursor position).
- Commands can be scoped globally or to a specific agent.
- Commands export and import as JSON for sharing.

### How it works
- Extends the existing `app/js/ui/slash-commands.js` module (no new module needed).
- Stores commands as a new `slashCommands: []` collection in `lib/store.js`.
- Reuses the trigger-detection logic already shared with the snippet system.
- Entirely client-side — no security model to design.

### Files
- Modify: `lib/store.js`, `app/js/ui/slash-commands.js`, `app/js/ui/snippets.js`
- Test: extend `tests/slash-commands.test.js`

### Done when
A user defines `/standup` → types it in any thread → it expands to the template with `{{selection}}` filled from the currently-selected text → round-trips through JSON export/import.

---

## Feature 5 — Per-Thread Cost Budgets

### Purpose
Long-running agent threads can quietly burn dollars. The existing cost tracker shows spend but does nothing about it. A budget turns the tracker into a guardrail.

### What it does
- Each thread can have a dollar ceiling.
- At 80% of the budget, a non-blocking toast warns the user.
- At 100%, the agent hard-pauses before sending the next message — a modal offers "Raise budget", "Continue once", or "Stop agent".
- A thin progress bar appears inside the cost pill, orange at 80%, red at 100%.

### How it works
- Adds two fields to each thread in `lib/store.js`: `costBudgetUsd` and `costBudgetAction`.
- `lib/agent-manager.js` already computes cost per turn — extend it to emit `cost:warn` and `cost:exceeded` events.
- The existing `app/js/ui/cost-tracker.js` listens for the new events and shows the UI.

### Files
- Modify: `lib/store.js`, `lib/agent-manager.js`, `app/js/ui/cost-tracker.js`
- Test: extend `tests/cost-tracker.test.js`

### Done when
Set a $0.50 budget → run an expensive task → see warning at $0.40, hard pause at $0.50 → raise to $1 → agent continues.

---

## Feature 6 — Rich Web Search Result Cards

### Purpose
When the Iris orchestrator returns web search citations as plain markdown links, they read as a wall of blue text. Codex (and good search UIs in general) render hits as visual cards with favicon, title, and snippet. This is a small change with a big premium-feel payoff.

### What it does
- When the orchestrator emits a web source, it wraps it in a custom `<iris-web-result url=... title=...>snippet</iris-web-result>` block.
- The renderer turns each block into a card: favicon, title, snippet, "Open in browser" button — and, when Feature 2 is active, "Open in pane" button.
- Plain markdown links still work for inline references; this only affects citations.

### How it works
- The Iris orchestrator's prompt (`lib/router/prompts.md`) is extended with one paragraph teaching it to emit the custom block.
- The existing markdown renderer (`app/js/lib/markdown.js`) detects the custom tag and swaps in a DOM card.
- Favicons fetched from `https://www.google.com/s2/favicons` (documented on `site/safety.html` as a new outbound call).

### Files
- Modify: `lib/router/prompts.md`, `app/js/lib/markdown.js`, `app/css/*.css`, `site/safety.html`
- Test: extend `tests/markdown.test.js`

### Done when
Ask Iris a question that triggers web search → answer renders as 3–5 source cards with favicons → clicking opens in the default browser (or in the browser pane if enabled).

---

## Feature 7 — Native Mica/Acrylic Window Chrome

### Purpose
Pure polish. The single change that makes the most screenshots. Windows 11 and macOS both support a translucent backdrop that picks up the user's wallpaper softly. Enabling it on Iris is the kind of detail that signals "premium native app" instantly.

### What it does
- A new toggle in the theme picker: "Translucent window (Windows 11 / macOS)".
- On Windows 11, the window picks up the Mica effect — wallpaper softly visible behind a tinted panel.
- On macOS, equivalent `under-window` vibrancy with active state.
- On unsupported OSes (Windows 10, Linux), the toggle is disabled with a tooltip; the app behaves exactly as today.

### How it works
- `main.js` `createMainWindow()` adds `backgroundMaterial: "mica"` on Win11 (detected via `os.release()` ≥ 22000) or `vibrancy: "under-window"` on macOS.
- Theme CSS gains a `[data-translucent="true"]` variant that swaps solid panel backgrounds for `rgba()` with conservative alpha (must hit WCAG AA on body text).
- Initially enabled only for the darker themes (Codex Dark, Midnight) where alpha is safer.

### Files
- Modify: `main.js`, `app/js/ui/theme-picker.js`, `app/css/themes/codex-dark.css`, `app/css/themes/midnight.css`
- Test: manual checklist in `docs/themes.md`

### Done when
A Windows 11 user enables the toggle → the window picks up the wallpaper softly behind a tinted dark panel → toggling off restores the current solid background exactly.

---

# Sequencing and Release Plan

| Week | Feature | Release |
|---|---|---|
| 1 | MCP marketplace (#1) | — |
| 2 | Browser pane (#2) | — |
| 3 | Terminal (#3) | **v0.5.0** |
| 4 | Slash commands (#4) + cost budgets (#5) | **v0.5.1** |
| 5 | Web cards (#6) + Mica chrome (#7) | **v0.5.2** |

For every release:
1. Bump `version` in `package.json`.
2. Update `CHANGELOG.md` and the feature table in `README.md`.
3. Follow `docs/release.md` exactly: per-arch builds, hash regeneration, GitHub release upload, `site/latest.json` refresh, Cloudflare Pages deploy.

---

# What this plan does NOT do

- Does not rewrite the agent manager, the store, or the router. Each feature extends them.
- Does not introduce TypeScript, a bundler, or any UI framework. Iris stays plain ES modules + plain DOM.
- Does not add telemetry, crash reporting, or analytics.
- Does not commit anything that ties the project to the maintainer's personal identity. Commits ship as `oorbitproductivity-oss <oorbitproductivity@gmail.com>`.

---

# Related documents

- **The "why"** — `CLAUD-GOAL.md`
- **The hand-off prompt for Gemini** — `docs/v0.5-implementation-prompt.md`
- **The auto-memory entry** — `~/.claude/.../memory/project_iris-v0.5-premium-plan.md`

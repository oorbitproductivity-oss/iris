# Changelog

## v0.5.2 — Rich web cards + native translucent chrome

Released TBD (cut after v0.5.1).

**The two final v0.5 polish moves.** Both small in code, big in "feels premium" payoff.

### 6. Rich web search result cards

- **When the Iris orchestrator returns a web citation**, it now emits a custom `<iris-web-result url="…" title="…">snippet</iris-web-result>` block. The renderer detects the tag and swaps in a visual card with favicon (from `https://www.google.com/s2/favicons`), title, snippet, host, and a hover-revealed "Open ↗" chip.
- **Strict URL sanitization** in `app/js/lib/markdown.js` — only `http:` and `https:` schemes render as links. `javascript:`, `data:`, `file:`, `vbscript:` and CRLF-injection attempts are dropped silently.
- **Plain markdown links are untouched** — this only kicks in for the explicit citation tag.
- **CSP updated** in `app/index.html` to allow images from `https://www.google.com` (favicons only) with an inline comment explaining the narrow grant.
- **Disclosure:** `site/safety.html` gained a new "Outbound network calls" section listing every third-party endpoint, including the favicon call.
- **Modified:** `lib/router/prompts.md`, `app/js/lib/markdown.js`, `app/index.html`, `site/safety.html`.
- **New files:** `app/css/web-cards.css`, `tests/markdown.test.js` (7 tests).

### 7. Native Mica / Acrylic window chrome

- **Translucent backdrop on Windows 11 and macOS.** Toggle in the theme picker. On Win11 (build 22000+) the window picks up Mica — wallpaper softly visible behind a tinted dark panel. On macOS, equivalent `under-window` vibrancy with active state. On Win10 / Linux the toggle is disabled with a tooltip explaining why.
- **Dark themes only.** `[data-translucent="true"]` variants land on `codex-dark` and `midnight`; light themes stay solid because alpha-on-light reads badly. Per-token alpha was tuned for WCAG AA body text contrast over a colorful wallpaper.
- **Code blocks, inputs, and modals stay fully opaque** so reading and editing aren't degraded.
- **Modified:** `main.js` (createMainWindow detects platform + reads `settings.translucentWindow`, sets `backgroundMaterial`/`vibrancy` + `transparent: true` + transparent `backgroundColor` when on), `preload.js` (`iris.translucentSupported`, `iris.onTranslucentChanged`), `lib/store.js` (`translucentWindow: false` default), `app/js/ui/theme-picker.js`, `app/css/themes.css`, `app/css/components.css`.
- **New file:** `docs/themes.md` with the full translucent-window guide and a 9-step manual verification checklist.

### Under the hood

- 7 new markdown tests; `node tests/run-all.js` → 14 suites, 160 tests, 100% pass.
- No new runtime dependencies — Mica/vibrancy use Electron's built-in `BrowserWindow` options.

## v0.5.1 — Custom slash commands + per-thread cost budgets

Released TBD (cut after v0.5.0).

**Two polish wins on top of the v0.5.0 foundation.** Both extend existing modules — no new runtime dependencies, no architectural shifts.

### 4. Custom slash commands

- **Define your own `/standup`, `/fix-pr`, `/journal`, `/anything`.** Each command has a trigger, name, description, and template prompt. Manage from `Settings → Custom slash commands → Manage commands…`.
- **Template substitutions:** `{{selection}}` is replaced with whatever text was highlighted in the active textarea; `{{cursor}}` is removed but the caret lands at its original position after insert.
- **Built-ins win on trigger collision** — a user command with a built-in's trigger is dropped from the merged list, so you can never accidentally shadow a system command.
- **JSON export / import** for sharing a library across machines or with a team.
- **Storage:** `settings.slashCommands` — a new collection in `lib/store.js` defaults to `[]`.
- **New files:** `app/js/ui/slash-command-editor.js`, `tests/slash-commands.test.js`.
- **Modified:** `app/js/ui/slash-commands.js` (merge user commands into parse/filter/execute), `app/js/ui/settings.js`, `app/js/ui/chat-view.js`.

### 5. Per-thread cost budgets

- **Optional dollar ceiling per agent.** Set via the new "Cost budget (USD)" field on agent creation, or via `Settings → Default cost budget (USD)` for all new agents.
- **80% warning** — a non-blocking toast surfaces when this turn pushes the session past 80% of the budget. Fires once per session.
- **100% modal** — a blocking dialog with three buttons: "Raise budget", "Continue once", or "Stop agent". "Stop agent" calls the existing `iris.stopAgent`; "Continue once" persists a `agentBudgetSkipByAgent[id]=true` flag in settings; "Raise budget" patches the agent record with a new ceiling.
- **Progress bar overlay** on the cost pill — green below 70%, orange 70-100%, red above 100%.
- **Cost math** moved into `lib/agent-manager.js` as `computeTurnCostUsd(usage, model)` — exported for testability. Tracks Sonnet/Opus/Haiku rates (per million tokens) with cache-read at 10% of base and cache-create at 125%. Unknown models fall back to Sonnet pricing — under-warning beats failing loud mid-turn.
- **New files:** `tests/cost-tracker.test.js` (17 tests).
- **Modified:** `lib/agent-manager.js`, `lib/store.js` (persist `costBudgetUsd` + `costBudgetAction` on each agent), `app/js/ui/cost-tracker.js`, `app/js/ui/settings.js`.

### Known gap

- "Continue once" surfaces the modal but does NOT hard-pause the agent — the main-process agent manager only emits the threshold events; the renderer decides. If you dismiss the modal and send another message, it will go through (the modal will pop again on the next turn). A true hard-pause is a follow-up: the agent manager would need to consult `agentBudgetSkipByAgent[id]` in its `sendMessage` path.

### Under the hood

- 32 new tests across 2 new suites — `node tests/run-all.js` → 14 suites pass.

## v0.5.0 — Codex-parity tier-1 features

Released 2026-05-25.

**Three premium-tier features land in one release** — the three moves that make this feel like an "app store + dev environment + browser" instead of a chat window with a fancy sidebar.

### 1. MCP Server Marketplace

- **One-click install for Model Context Protocol servers.** Open `Settings → MCP Servers → Open marketplace…` to browse a curated catalog (Playwright, GitHub, Postgres, Fetch, Filesystem, Memory, Sequential-Thinking, Time). Click Install, drop in any required secrets (PATs, connection strings), and the next agent run automatically gets the new tools.
- **Catalog refresh in the background.** Bundled catalog ships inside the app so the marketplace works offline; the remote catalog at `iris-code.pages.dev/mcp-catalog.json` refreshes on launch with a 24-hour cache. Compromised remote can update display fields but never overrides the bundled `command`/`args`.
- **Encrypted secret vault.** Secrets ride through the same `safeStorage` / AES-256-GCM-fallback path the API key vault already uses. The per-spawn `.mcp.json` references env vars as `${NAME}` placeholders; the actual values ride in the spawn env and the file is chmod-600 + shredded after the agent process closes.
- **New files:** `lib/mcp/{registry.js, installer.js, catalog-bundled.json}`, `app/js/ui/mcp-marketplace.js`, `app/css/mcp.css`, `tests/mcp.test.js`, `docs/mcp-marketplace.md`, `site/mcp-catalog.json`.

### 2. Embedded Browser Pane

- **Per-agent embedded webview** with URL bar, back/forward/refresh/external-open. Toggle from the "Browser" pill in the chat header. Each agent gets its own `partition="persist:agent-<id>"` so cookies and logins never bleed across threads.
- **Draggable splitter** between chat and pane with persistence (`settings.browserPaneWidth`).
- **"Send screenshot to agent"** captures the pane, saves the PNG via main-process IPC under `iris-data/screenshots/`, and drops a `Please read it: <abs path>` line into the chat composer — Claude can `Read` the file directly.
- **Master switch in Settings** to hide the pill for users who don't want it.
- **Limitation noted up front:** the agent cannot drive *this* pane in v0.5.0 (no CDP attach yet). Install **Playwright** from the MCP marketplace for fully agent-controlled browsing (separate Chromium). CDP-attached agent control of the embedded pane is planned for v0.5.x.
- **New files:** `app/js/ui/browser-pane.js`, `app/css/browser-pane.css`, `docs/browser-pane.md`.

### 3. Integrated Terminal Pane

- **Real PTY per agent** via `node-pty` + `xterm.js`. Default shell is the platform default (PowerShell on Windows, `$SHELL` elsewhere). Terminals survive renderer reloads because the PTY lives in the main process.
- **10,000-line ring buffer** per terminal bounds memory.
- **"Share last 50 lines with agent"** copies the buffered output into the chat composer as a fenced code block — sharing is deliberate, not automatic, so the agent's context stays clean.
- **Graceful disable** if `node-pty` fails to load (e.g. the native binding wasn't rebuilt for your Electron version): the Terminal pill disappears with a clear inline message instead of crashing the app.
- **New files:** `lib/terminal/pty-manager.js`, `app/js/ui/terminal-pane.js`, `app/css/terminal-pane.css`, `tests/terminal.test.js`, `docs/terminal.md`.
- **Native dep:** `package.json` adds `node-pty`, `xterm`, `xterm-addon-fit`, plus dev-dep `electron-rebuild`. Contributors must run `npm install` (which runs `electron-rebuild` post-install) before `npm start`. See `docs/terminal.md` if you hit `Cannot find module ... pty.node`.

### Under the hood

- `lib/agent-manager.js` — constructor now accepts `mcpInstaller`; on spawn it resolves the per-agent runtime config and appends `--mcp-config <path>` to argv + merges `envOverlay` into spawn env. Shred-on-close clears the file from disk.
- `lib/store.js` — new `mcpSecrets` encrypted vault (separate JSON file so a corruption can't take down the API-key vault). New `DEFAULT_SETTINGS` keys: `mcpEnabled`, `browserPaneEnabled`, `browserPaneStateByAgent`, `terminalEnabled`.
- `main.js` — `webviewTag: true` on the BrowserWindow; new IPC blocks `// ── IPC: MCP ──`, `// ── IPC: Terminal ──`; new `screenshot:save-data-url` handler with 8 MB cap.
- `preload.js` — `iris.mcp`, `iris.terminal`, `iris.saveScreenshotDataUrl`.
- 19 new tests across 2 new suites (8 MCP + 9 terminal) — `node tests/run-all.js` → 11 suites, 100% pass.

### Compatibility

- Pre-v0.5 settings auto-upgrade. All three new features default to ON but install nothing until the user clicks into the marketplace / toggles the pane / opens a terminal — existing users see no behavior change.

## v0.4.1 — Windows spawn race fix

Released 2026-05-24.

**Bug fixes:**

- **Fixed `claude exited with code -4058` on Windows.** When `claude` was installed via npm as `claude.cmd`, the first `spawn('claude', ..., { shell: false })` would fail with ENOENT (Node's CVE-2024-27980 mitigation refuses `.cmd` without shell). The retry path correctly reran with `shell: true`, but the dead first proc's async `close` event (libuv code `-4058` / UV_ENOENT) raced the retry and clobbered the live session with a bogus exit broadcast. Thanks to Riley for the detailed bug report.
- **Resolve the `claude` binary upfront** via PATHEXT walk in `lib/agent-manager.js`. When the resolved path is a Windows `.cmd`/`.bat`, spawn with `shell: true` from the first attempt — bypasses the broken-spawn-then-retry path entirely.
- **Stale-close guard** in `_onClose`. Even if the retry path somehow triggers, a close event from a proc that no longer matches `this.procs.get(id)` is now ignored with a warning instead of broadcasting a phantom exit code.
- **Listeners detached on dead proc** before kicking off the retry, as belt-and-suspenders.

**UX improvements:**

- **Friendly preflight dialog** at app boot if the `claude` CLI is missing from PATH, with one-line install instructions and a button to open the docs.
- **Clearer in-session error message** when spawn truly fails because the CLI isn't installed — replaces raw `ENOENT` / "not recognized as an internal or external command" with the npm install command and a docs link.

## v0.4.0 — Telegram Remote Agent

Released 2026-05-23.

**One new headline feature:**

- **Telegram Remote Agent** — DM your personal Telegram bot to run Claude Code tasks on your desktop. Bring-your-own-bot — one user, one bot, no shared infrastructure. Token encrypted at rest (Electron `safeStorage` → AES-GCM fallback). Per-chat allowlist enforced on every inbound message. Auto-reconnect with exponential backoff on network/API failures. 6-digit pairing flow — no copy-pasting chat IDs. Replies formatted as MarkdownV2, chunked at the 4096-char ceiling. See `docs/telegram.md` for the full guide.

  - **Hard sandbox lockdown.** Telegram-spawned agents are contained to a Telegram-owned workspace tree under `iris-data/telegram-workspaces/`. They have NO read or write access to your real `defaultCwd` or anything else outside that tree — a remote prompt physically cannot enumerate or touch your projects, keys, or home dir.
  - **Channel-style sessions.** `/new` starts a fresh session WITHOUT discarding the previous one. `/list` shows your recent sessions, `/switch <n>` jumps between them — like tabs over Telegram.
  - **Numbered-menu UX.** `/control` (or `/help`, `/menu`) shows a numbered list of actions; reply with the digit. `/switch` with no arg shows a numbered session picker. No command memorization required.
  - **Boot prompt.** At launch, Iris asks *"Start with Telegram bridge?"* (yes/no, with "Don't ask again"). Policy stored in `settings.telegram.startupPrompt` (`ask` | `always` | `never`).
  - **Sidebar quick-toggle.** ✈ Telegram button in the sidebar footer with a status dot (green/amber/grey). Click to start/stop; double-click to open settings.
  - **Slash commands:** `/control`, `/new`, `/list`, `/switch`, `/switch <n>`, `/stop`, `/help`, `/menu`, `/start`.

**Under the hood:**

- New module: `lib/telegram/` (`index.js`, `api.js`, `markdown.js`). The Bot API client uses only Node's built-in `https` — no new runtime dependencies.
- New `Store` methods: `getTelegramToken()`, `setTelegramToken()`. Token persisted to its own `telegram-token.json` (chmod 600 on POSIX) so encryption-backend changes can't corrupt unrelated settings.
- New settings key: `telegram` (`enabled`, `botUsername`, `allowedChatId`, `chatAgentId`). The bot token itself never lives in `settings.json`.
- New IPC: `telegram:status`, `telegram:set-token`, `telegram:clear-token`, `telegram:set-enabled`, `telegram:start-pairing`, `telegram:cancel-pairing`, `telegram:test-message`. Plus push event `ui:telegram-status` for live panel updates.
- New preload bindings: `getTelegramStatus`, `setTelegramToken`, `clearTelegramToken`, `setTelegramEnabled`, `startTelegramPairing`, `cancelTelegramPairing`, `sendTelegramTest`, `onTelegramStatus`.
- New UI: `app/js/ui/telegram-panel.js` (settings modal mirroring `remote-access.js`).
- New onboarding step: "Set up with Telegram for easy agent access (optional)" — deep-links to the panel.
- New test suite: `tests/telegram.test.js` (15 tests covering MarkdownV2 escaping, chunking, pairing, allowlist, agent routing).
- New doc: `docs/telegram.md`.

**Compatibility:** v0.3.0 settings auto-upgrade. The `telegram` block defaults to disabled, no token, no paired chat — existing users see no behavior change until they enable the bridge.

## v0.3.0 — Open-source launch

Released 2026-05-18.

**Ten new features:**

- **Five themes** — Codex Dark (default), Codex Light, Midnight, Solarized, Forest. Pick via command palette → "Pick theme".
- **Global search** — `Ctrl/Cmd+Shift+F` searches every message across every thread. Click a result to jump to that thread.
- **Thread tags** — color-coded tags appear as small dots on sidebar items. Manage via command palette → "Edit thread tags".
- **Voice input** — Microphone button next to the Iris overlay send button. Uses Web Speech API (works in Electron's Chromium when online).
- **Inline diff viewer** — When the agent runs Edit / Write / MultiEdit, the tool card renders a side-by-side line-numbered diff with red/green highlights.
- **CLAUDE.md memory editor** — Open via command palette → "Edit CLAUDE.md memory". Reads/writes the active thread's project memory file.
- **Per-thread cost tracker** — A `12.4k in · 3.1k out · 5 turns` pill next to the chat header. Backend forwards token usage from `claude`'s result events.
- **Plan mode** — Toggle on the chat header. When ON, the next user message gets a "propose a plan, wait for approval" preamble. Persisted per agent.
- **Auto-update check** — A non-blocking banner appears if `https://iris-code.dev/latest.json` advertises a newer version. Dismissable per version.
- **Interactive welcome tour** — 5-step orientation on first launch of v0.3, also accessible from the command palette.

**Open-source release:**

- `LICENSE` (MIT), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`.
- `.github/`: `FUNDING.yml`, issue templates (bug / feature), PR template, CI workflow.
- Sponsor page at `site/sponsor.html` with three monthly tiers + one-time donation row.
- All site pages now show a Sponsor link in the main nav + community/sponsor links in the footer.
- README updated with badges (MIT, open-source, sponsor, Discord) and a new Contributing & support section.

**Under the hood:**

- New main-process IPC: `memory:read`, `memory:write`, `update:check`, `app:version`.
- `lib/agent-manager.js` now forwards `usage` (token counts) on `result` events; persisted on the message and broadcast to the renderer.
- New settings keys: `themeName`, `agentTags`, `tagColors`, `planModeByAgent`, `totalUsage`, `tourSeenVersion`, `updateDismissedVersion`.
- New CSS files: `app/css/themes.css`, `app/css/features-v3.css`, `app/css/features-v3-b.css`.
- 10 new renderer modules under `app/js/ui/`.
- Command palette gets 6 new entries (Pick theme, Search all threads, Edit thread tags, Edit CLAUDE.md memory, Take v0.3 tour, Manage snippets).

## v0.2.0 — Premium features

Released 2026-05-18.

**Seven new headline features:**

- **Command palette** — `Ctrl/Cmd+Shift+P` opens a fuzzy-searchable list of every action: new thread, switch agents, settings, theme toggle, stop current, browse templates, show stats, export current, new window.
- **Workflow templates** — One-click starts for **Code Review**, **Refactor for Clarity**, **Add Test Coverage**, **Bug Hunter**, **Documentation Pass**, **Migration Plan**, **Performance Profile**, **Onboarding Buddy**. Each template ships with a battle-tested prompt and a sensible model choice (Opus for deep work, Haiku for light passes).
- **Prompt snippets** — Type `/` at the start of any composer textarea to open a snippet menu. Defaults shipped: `explain`, `fix`, `test`, `review`, `plan`, `refactor`. CRUD lives in Settings.
- **Stats dashboard** — A live KPI view of your sessions: total threads, currently running, total messages, total tools used. Plus a top-tools bar chart and a 24-hour activity strip.
- **Pinned threads** — Right-click → Pin (or use the command palette). Pinned threads float to the top of the sidebar with a small gold star badge.
- **Conversation export** — Markdown or JSON for any thread. Includes message timestamps, role icons, and a collapsible `<details>` block per assistant turn with the full tool call log.
- **System notifications** — When an agent finishes a turn while Iris Code is in the background, fire a native toast. Click it to bring the app forward and focus that thread. Toggle in Settings.

**Under the hood:**
- New IPC: `export:thread`.
- New main-process listener: `maybeNotify` on every broadcast `result` event.
- New preload bindings: `exportThread`, `onFocusAgent`.
- New settings keys: `notifications` (default `true`), `snippets` (default-seeded), `pinnedAgentIds`.
- New CSS: `app/css/features.css` (added after `chat.css` in the load order).
- New marketing site under `site/` — landing, product, download, docs pages; all static HTML/CSS/vanilla JS, no build step.

**Compatibility:** v0.1.0 settings auto-upgrade. No migrations required.

## v0.1.0 — Initial release

The original Iris Code MVP: Electron shell, orchestrator + workers, Spotlight overlay, sandbox mode, encrypted key vault, onboarding wizard, NSIS installer.

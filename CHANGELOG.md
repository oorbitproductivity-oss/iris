# Changelog

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

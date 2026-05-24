# Iris Code — Handoff

A handoff document for the next agent picking up this project. Written 2026-05-16 after a long building session.

---

## What this app is

A native Electron desktop app that wraps the `claude` Code CLI into a multi-agent GUI:

- **Iris** — a master orchestrator agent that watches all sub-agents and suggests next actions to the user.
- **Sub-agents (workers)** — each is a separate `claude` subprocess spawned with `--output-format stream-json --include-partial-messages`, running in its own working directory (or sandbox).
- **Live UI** — streaming text deltas, tool cards that fill in as `input_json_delta` events arrive, tool results, and an append-only "milestone timeline" for long-running turns.

Project root: `<your-user>\OneDrive\Desktop\code\Iris code\iris-app`.

---

## The installer (the thing the user wanted built)

Built and ready:

```
<your-user>\OneDrive\Desktop\code\Iris code\iris-app\dist\Iris Code Setup 0.1.0.exe
```

~84 MB, NSIS installer, unsigned (warning at run will be normal — "Windows protected your PC → More info → Run anyway").

It installs:
- Per-user (no admin required)
- Allows changing the install directory
- Creates a Desktop shortcut and a Start-menu shortcut, both named **Iris Code**.

Unpacked binary also lives in `dist\win-unpacked\Iris Code.exe` if you want to test without running the installer.

### Rebuilding the installer

```bash
cd "<your-user>/OneDrive/Desktop/code/Iris code/iris-app"
npm run dist:win
```

`package.json` has three build scripts:
- `npm run dist` — all configured targets for the host OS
- `npm run dist:win` — Windows NSIS only
- `npm run dist:dir` — unpacked directory (fastest, for smoke-testing)

### Prerequisite: `claude` CLI

The installer **does not bundle** the `claude` CLI. The app shells out to whatever `claude` is on the user's `PATH`. They need Claude Code installed and logged in (`claude auth login`) for subscription mode. If they're using API-key mode, the wizard lets them paste a key.

---

## First-run flow

`lib/store.js` defines `DEFAULT_SETTINGS.onboarded = false`. On boot, `app/js/app.js` checks this and triggers the wizard from `app/js/ui/onboarding.js`.

Six steps:
1. **Welcome** — icon + intro.
2. **Auth** — Subscription (uses local `claude` login) or API key (with name + value form). API keys are encrypted via Electron `safeStorage` in `lib/store.js`.
3. **Default working directory** — picker, written to `settings.defaultCwd`.
4. **Model + effort** — sonnet/opus/haiku + low/medium/high. Effort is passed to `claude --effort`.
5. **Hotkey** — global shortcut to open the Iris overlay. Default `Ctrl+Shift+Space` (the previous default `Ctrl+Shift+I` conflicts with Chromium DevTools and was migrated automatically in `store.getSettings`).
6. **Done** — summary card + "Get started" flips `onboarded: true`.

Each step persists immediately, so the user can quit mid-wizard and resume from where they were.

`app/css/components.css` (very bottom) contains all the wizard styles, prefixed `.ob-`.

---

## What's in this session's work (chronological recap)

### Streaming + tool display fixes
- `lib/agent-manager.js` `_handleEvent` was rewritten to handle the full `--include-partial-messages` event stream:
  - `system.init` → emits `session`
  - `stream_event.message_start` → resets per-message block tracking
  - `content_block_start` (text or tool_use) → registers; if tool_use, broadcasts `tool` with `useId`
  - `content_block_delta`:
    - `text_delta` → broadcasts `delta`
    - `thinking_delta` → broadcasts `thinking` (used by the timeline below)
    - `input_json_delta` → accumulates partial JSON for the tool, broadcasts `tool_input` after each parse pass
  - `content_block_stop` → finalizes tool input (full JSON parse), broadcasts `tool_input` with `final: true`
  - `user` message with `tool_result` content → broadcasts `tool_result` (with `useId`, `ok`, snippet)
  - `result` → final assistant text, persisted to disk, broadcasts `result`
- Frontend reducer in `app/js/lib/state.js` consumes those events with cases for `tool`, `tool_input`, `tool_result`, `thinking`, `delta`, `result`. Tools are keyed by `useId` for correct matching when multiple tool calls run in one turn.
- Tool cards in `app/js/ui/chat-view.js` (`renderToolCard`) auto-open while `status === "started"` so the live input is visible, then collapse after completion.

### Activity strip — names the live tool
`app/js/ui/chat-view.js` `paintActivity` reads the latest draft tool with `status === "started"` and shows `ToolName · <hint>` (extracts `file_path` / `command` / `pattern` / etc. via `toolHint`). Falls back to a rotating verb when no tool is running.

### Sidebar flashing
The threads list was rebuilding from scratch on every state notify (one per delta). Now:
- Keyed reconciliation in `app/js/ui/sidebar.js` — `items` Map of agent id → DOM record. Only patches text content when it actually differs.
- The "time ago" label is only updated when `agent.lastActivity` changes, plus a 30 s interval — no longer recomputed on every render.
- Renders are coalesced with `requestAnimationFrame` so streaming bursts collapse to one DOM pass per frame.
- `.sb-item { animation: fadeUpSmall … }` was moved off the base class into `.sb-item.appearing`. The class is added on item creation and removed on `animationend` so re-renders don't replay the fade.

### Thinking display — milestone timeline
The original "stream the chain-of-thought into the bubble" caused two problems: a constantly-flickering pulse line and (later) the `Claude's response exceeded the 32000 output token maximum` API error. Replaced with:
- `lib/agent-manager.js` sets `CLAUDE_CODE_MAX_OUTPUT_TOKENS=64000` in the spawn env (overrides if user already set one).
- `app/js/ui/chat-view.js` shows an append-only timeline inside the assistant draft bubble:
  - One line every **30 s** for the first 3 minutes, then one line every **60 s** thereafter.
  - Each line summarizes what happened in that window: the most recent tool + args, or the last meaningful clause of new thinking, or a fallback rotating verb.
  - The most recent milestone pulses; older ones go quiet.
- CSS: `.bubble .think-timeline`, `.bubble .think-milestone` in `app/css/chat.css`.

### Sandbox UX
- `.sb-item-cwd` shows `Sandbox` instead of the UUID basename for sandboxed sessions.
- The chat header's `.chat-header-sub` shows a `SANDBOX` pill + an **open folder** link that opens the sandbox dir via `shell.openPath`.
- The empty-chat message reads "Weaving in a sandbox".
- `app/js/ui/session-settings.js` shows a `Sandbox` pill + "Open folder" / "Reveal source" buttons rather than the long unreadable path.

### Brand mark / icon
- The hand-drawn ornate gold-on-black icon (eye + I) lives at `app/assets/iris-icon.png`. It came from the user's screenshot and was copied verbatim — wider than tall.
- `app/js/ui/util.js` exports `irisImg(size)` which returns an `<img src="assets/iris-icon.png">`. `svgIcon("iris", …)` was patched to delegate to `irisImg` so existing callers keep working.
- All the `.tb-brand-mark`, `.sb-iris-mark`, `.iro-mark`, `.iro-welcome-mark`, `.home-mark`, and `.msg-author .author-mark` now render the image on a dark rounded chip with a gold ring.
- `app/index.html` has `<link rel="icon" href="assets/iris-icon.png">` and the three remaining inline iris SVGs (titlebar, overlay header, overlay welcome) were replaced with `<img>` tags.
- `main.js` passes `icon: path.join(__dirname, "app", "assets", "iris-icon.png")` to every `BrowserWindow`. Same icon resized to 16×16 is used for the tray.

### Multi-window + background tray (added externally during the session)
`main.js` now keeps a `Set` of `BrowserWindow`s, prompts the user when they close the last visible one while agents are running, and offers "Continue in background" → hides the window and mounts a `Tray` icon with `Show / New window / Quit` menu items. `isQuitting` short-circuits the prompt on clean shutdowns.

### Quality / config
- `lib/store.js` `DEFAULT_SETTINGS`:
  - `spotlightHotkey` default → `CommandOrControl+Shift+Space` (with auto-migration of the old `…+Shift+I` value).
  - New `effort: "high"`.
  - New `onboarded: false`.
- `lib/agent-manager.js` `_buildArgs`:
  - Passes `--effort <settings.effort>` when not "default".
  - For sandbox workers, passes `--add-dir <agent.sourceDir>` so CLAUDE.md and reference files in the original workspace stay reachable.

---

## Architecture cheat sheet

```
main.js                        Electron main process. Spawns AgentManager,
                               manages windows + tray + global hotkey,
                               wires IPC handlers.
preload.js                     contextBridge — exposes window.iris.
lib/store.js                   JSON-on-disk persistence (settings, agents,
                               messages-*.json, encrypted api-keys.json).
lib/agent-manager.js           N concurrent `claude` subprocesses keyed by
                               agent id. Parses stream-json events and
                               broadcasts UI events. Iris (id "iris") is
                               always present with read-only tools.
lib/iris.js                    Iris orchestrator system prompt + the
                               <iris-context> block prepended to every Iris
                               user message.
app/index.html                 Single-window shell + iris-overlay markup.
app/js/app.js                  Entry point; boot order; first-run gate.
app/js/lib/state.js            Tiny reactive store. dispatch() reduces
                               agent:event payloads from main into UI state.
app/js/lib/markdown.js         Tiny markdown renderer + extractAction blocks.
app/js/lib/verbs.js            THINKING / DOING verb lists + rotator.
app/js/ui/sidebar.js           Iris CTA + workers list (keyed reconciler).
app/js/ui/chat-view.js         Chat surface for a single worker, including
                               the milestone timeline & activity strip.
app/js/ui/iris-view.js         Home screen (welcome / quick CTA).
app/js/ui/iris-overlay.js      Spotlight-style Iris chat overlay.
app/js/ui/new-session.js       "New thread" modal.
app/js/ui/session-settings.js  Per-thread settings (name, model, cwd, key).
app/js/ui/settings.js          App-wide settings.
app/js/ui/onboarding.js        ★ first-run wizard (new this session).
app/js/ui/util.js              h(), svgIcon, irisImg, openModal, showToast.
app/css/*                      tokens / layout / components / chat.
app/assets/iris-icon.png       Brand mark (wide gold-on-black).
```

### IPC contract (renderer → main, main → renderer)
Defined in `PROTOCOL.md`. The only addition this session was the implicit `onboarded` settings key — the existing `settings:get` / `settings:set` handlers carry it transparently.

---

## Known issues / things the next agent might want to tackle

1. **Icon aspect ratio**: `iris-icon.png` is wider than tall (~600×420). On the Windows taskbar this means a slight letterbox. If perfect square is wanted, generate a square padded variant at `app/assets/iris-icon-square.png` (e.g. via `sharp` or ImageMagick — neither is installed) and switch `main.js` + `package.json build.win.icon` + `index.html` favicon to point at it.
2. **`--include-partial-messages` is a `--print`-only flag**. We always run with `-p`, so we're fine. If anyone ever swaps in interactive mode, this would break.
3. **No code signing**. `electron-builder` reports `no signing info identified, signing is skipped` — installer triggers SmartScreen warnings. To sign, set env vars `CSC_LINK` (cert) + `CSC_KEY_PASSWORD` and re-run `dist:win`.
4. **No auto-update**. Not configured. If wanted, add `publish` config in `package.json` + an update server.
5. **Onboarding doesn't validate the API key**. It just stores whatever the user types. Could add a probe ping.
6. **Background tray icon**: built from the same wide PNG resized to 16×16. Looks OK but a dedicated 32×32 tray asset would be sharper.

---

## Running the installer (instructions for the next AI / human)

1. Double-click `dist\Iris Code Setup 0.1.0.exe`.
2. Windows SmartScreen will warn — click **More info → Run anyway**.
3. The NSIS wizard appears: confirm install location (per-user by default, no admin), click **Install**.
4. Installer adds Desktop + Start-menu shortcuts named **Iris Code**.
5. Launch it. First run shows the onboarding wizard (Welcome → Auth → Folder → Model → Hotkey → Done).
6. After finishing onboarding, the main UI appears. Open Iris with `Ctrl+Shift+Space` or click **Open Iris** in the sidebar. Click **+ New** in the sidebar to spin up a sub-agent.

To uninstall: Windows Settings → Apps → Iris Code → Uninstall. Per-user data lives in `%APPDATA%\Iris Code\iris-data\` (settings, agents, encrypted keys, message logs); the uninstaller does **not** wipe that.

---

## Folder pointers for quick navigation

| Thing you want | Path |
|---|---|
| Project root | `<your-user>\OneDrive\Desktop\code\Iris code\iris-app` |
| Built installer | `iris-app\dist\Iris Code Setup 0.1.0.exe` |
| Unpacked binary | `iris-app\dist\win-unpacked\Iris Code.exe` |
| Brand mark | `iris-app\app\assets\iris-icon.png` |
| Icon preview gallery | `iris-app\app\assets\icon-preview.html` (open in browser) |
| Settings on disk | `%APPDATA%\Iris Code\iris-data\settings.json` |
| Agent message logs | `%APPDATA%\Iris Code\iris-data\messages-*.json` |

— end of handoff —

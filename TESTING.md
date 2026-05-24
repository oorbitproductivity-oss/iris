# Iris Code v0.3.0 — Test Plan

A manual test plan for the **v0.2.0** release. Run through each section in order. Each test is short — most are under a minute.

You don't need to run every test before shipping. The "Golden path" sections are the smoke test; the "Edge cases" sections are for thoroughness.

---

## How to launch

```powershell
cd "G:\Other computers\My Computer\code\Iris code\iris-app"
npm start
```

Or install the new build from `dist\Iris Code Setup 0.2.0 (ARM64).exe` (it lives in the project's `dist/` folder after `npm run dist:win`).

If you're testing the installer end-to-end, uninstall any previous version first via Settings → Apps → Iris Code → Uninstall. User data at `%APPDATA%\Iris Code\iris-data\` survives the uninstall — if you want a true fresh install, delete that folder too.

---

## 1. Command palette (Ctrl+Shift+P)

**Golden path**
1. From any view, press **Ctrl+Shift+P**.
2. A centered floating panel opens with a search input focused.
3. Type `theme` — the "Toggle light/dark theme" command should rise to the top.
4. Press **Enter** — the app switches theme. Run again to switch back.
5. Open the palette, type `new` — both "New thread…" and "New window" should match. Press ↓ to navigate, Enter to run.
6. Open the palette, type `switch` — every existing agent shows up as "Switch to: …". Pick one with Enter.

**Edge cases**
- Esc closes the palette. Click outside it closes it.
- Ctrl+Shift+P must NOT collide with Ctrl+K (Iris overlay) or the global hotkey (Ctrl+Shift+Space).
- "Stop current thread" only shows up when the active agent is `running`.

---

## 2. Workflow templates

**Golden path**
1. Open the command palette and search "templates", or right-click any sidebar item (left blank for now — easier path: command palette → "Browse templates").
2. A modal grid of 8 template cards appears: Code Review, Refactor for Clarity, Add Test Coverage, Bug Hunter, Documentation Pass, Migration Plan, Performance Profile, Onboarding Buddy.
3. Click "Use template" on **Code Review**.
4. The templates modal closes and the regular new-thread modal opens with the prompt and model pre-filled.
5. Pick a folder, click "Create session". An agent is spun up with the template prompt as its first message.

**Edge cases**
- The model picker should respect the template's preferred model (Opus for Code Review and Performance Profile, Haiku for Documentation Pass, Sonnet for the rest).
- Closing the templates modal (Esc / click outside) does not pollute state.

---

## 3. Prompt snippets (the `/` trigger)

**Golden path**
1. Open any thread's composer (the textarea at the bottom of the chat view), OR open the Iris overlay (Ctrl+K) — both should work.
2. Make sure the textarea is empty, then type **`/`** as the very first character.
3. A floating menu appears below the caret with default snippets: **explain**, **fix**, **test**, **review**, **plan**, **refactor**.
4. ↓ to navigate, Enter to insert. The `/` is replaced with the snippet body.
5. Open Settings (Ctrl+,) — there should be a "Snippets" section where you can edit/add/delete snippets. Add a new one named `summarize` with body "Summarize this in 3 bullets."
6. Type `/` again — the new snippet appears in the menu.

**Edge cases**
- Typing `/` mid-line (after a non-newline character) does NOT open the menu. Only at start-of-textarea or right after a newline.
- Esc dismisses the menu without inserting.
- Deleting a snippet from Settings persists across restarts.

---

## 4. Stats dashboard

**Golden path**
1. Open the command palette and run "Show stats", OR press Ctrl+Shift+P then type "stats".
2. A modal opens with four KPI cards: total threads, currently running, total messages, total tools used.
3. Below: agent breakdown table (one row per agent), tool usage bar chart (top 8), 24 h activity bars.
4. Spin up an agent and send it 1–2 messages — close the stats modal and reopen it; counts should reflect the new activity.

**Edge cases**
- With zero agents (fresh install), the dashboard renders all zeros without crashing.
- The 24 h chart should show bars where activity actually occurred, empty bars otherwise.

---

## 5. Pinning + system notifications

**Pinning — golden path**
1. Right-click a sidebar thread → "Pin to top" (or use the command palette to toggle it via `Toggle pin: <thread>`).
2. The thread moves to the top of its group with a small gold star badge to the left.
3. Pin a second thread — both stay at the top, in pin order.
4. Click the star badge directly — the thread unpins, drops back to recency order.
5. Restart the app — pins persist.

**Notifications — golden path**
1. Start a long-running agent task (e.g. "Read every file in this repo and summarize them").
2. While the agent is running, switch to **another application** (browser, terminal, anything that takes focus away from Iris Code).
3. When the agent finishes its turn, a system toast appears with the agent name and a 1-line snippet of the result.
4. Click the toast — Iris Code comes to the foreground with that thread focused.
5. Open Settings → flip "System notifications" to off → repeat the test — no toast should appear.

**Edge cases**
- The Iris agent (orchestrator) does NOT trigger notifications — only worker agents.
- If the Iris Code window is focused, no toast (you can already see the result).

---

## 6. Conversation export

**Golden path**
1. Open any thread that has at least 1 user + 1 assistant message.
2. Open the command palette → "Export current thread…".
3. A save dialog opens with a default filename `<thread name>.md`.
4. Save it. Open the file in a Markdown viewer (VS Code preview, GitHub gist, etc.).
5. The export should include: a title, metadata (model, cwd, sessionId, createdAt), then each message with role icons (🧑 / ✨ / ⚙️), timestamps, and a collapsible `<details>` block per assistant turn that contains tool calls + inputs + results.

**Edge cases**
- Exporting an empty thread (no messages) writes a valid `_(no messages)_` body.
- Tool inputs / results longer than 4 KB get truncated with a `…(truncated)` marker.
- Cancel the save dialog — no file is written, no error.
- (Optional) JSON export: dispatch the event manually with `format: "json"` and verify the JSON structure.

---

## 7. Marketing website

The site lives at `site/` and is a static set of HTML/CSS/JS. Open these in your browser:

1. `site/index.html` — landing page. Check: hero CTA, bento feature grid, fake app-window mock, all anchor links, scroll micro-motion.
2. `site/product.html` — feature deep dive. Each marquee feature has its own section. Scroll to the bottom — there's a roadmap and an architecture diagram.
3. `site/download.html` — download page. The big **Download for Windows (x64)** button must link to `../dist/Iris Code Setup 0.2.0.exe`. Click it after running `npm run dist:win`.
4. `site/docs.html` — docs single-pager with sticky TOC on wide screens. Click each TOC link — they scroll to the matching section.

**Edge cases**
- Resize the browser narrow (mobile width) — the TOC on docs collapses, header nav collapses, sections stack.
- Right-click → "View page source" — there should be no broken `<img>` references, no CDN URLs (everything is local).
- Test the download link with the file present and with it missing — when missing, the browser shows a "file not found" page (expected; build the installer first).

---

## 8. Themes (v0.3)

1. Open command palette (Ctrl+Shift+P) → "Pick theme" → modal shows 5 swatch cards.
2. Click "Apply" on **Midnight** — the whole app shifts to a deeper blue-black.
3. Try **Forest** — green accents replace gold.
4. Reset to **Codex Dark** — original look restored.
5. Restart the app — theme persists.

## 9. Global search (v0.3)

1. Make sure at least one thread has messages in it.
2. Press **Ctrl+Shift+F** (or run "Search all threads…" from the palette).
3. Type a word that appears in your messages — results appear, grouped by agent, with the match highlighted in gold.
4. Click a result — the modal closes and the corresponding thread is selected.
5. Search a word that doesn't exist — empty state with a quiet message.

## 10. Thread tags (v0.3)

1. Command palette → "Edit thread tags" — opens the tag manager for the active thread.
2. Type "important" + Enter — a colored chip appears.
3. Add a second tag "wip". Save.
4. Sidebar item now shows 2 colored dots after the thread name.
5. Open the manager again with no agent active — shows the global tag overview. Click a tag to filter the sidebar. Click "Clear filter" to restore.

## 11. Voice input (v0.3)

1. Open the Iris overlay (Ctrl+K).
2. A small microphone button appears immediately left of the send button.
3. Click it — the button pulses gold, browser may request mic permission (grant it).
4. Speak: "What can you do?" — the textarea fills in with what you said.
5. Click the mic again to stop early. Alternatively, the recognition auto-stops on pause.
6. If your network is offline, an error toast appears explaining voice input needs connectivity.

## 12. Inline diff viewer (v0.3)

1. Start a thread with a real folder. Send: "Add a single-line comment at the top of one of these files. Use the Edit tool."
2. When the agent fires the Edit tool, the tool card expands with a side-by-side diff: left column (red-tinted) shows old content, right column (green-tinted) shows new content. Line numbers are visible.
3. For Write (creating a new file) the viewer shows the new content with a "creating new file" header.

## 13. CLAUDE.md memory editor (v0.3)

1. Open a thread that has a real `cwd`.
2. Command palette → "Edit CLAUDE.md memory".
3. A modal opens showing the file path and a monospace textarea. If the file doesn't exist yet, the textarea is empty.
4. Type a line like `# Project notes\n- Always use TypeScript`.
5. Save — toast confirms.
6. Verify the file exists on disk: in the same cwd, you should find `CLAUDE.md` with the content.
7. Open the editor again — the content round-trips.

## 14. Per-thread cost tracker (v0.3)

1. Start a thread and send a message. After the agent replies, a small pill should appear in the chat header showing something like `1.2k in · 540 out · 1 turn`.
2. Send a second message — counts increment.
3. Switch threads via the sidebar — the pill updates to show that thread's costs.
4. Costs are zero/absent until the FIRST result event from claude. If your claude CLI version doesn't include usage data, the pill stays at `0 turns`.

## 15. Plan mode (v0.3)

1. Open a thread. In the chat header, click the gold "Plan" pill.
2. Pill turns active (gold-filled). Send: "Refactor the entry point."
3. The agent should respond with a numbered plan instead of writing code.
4. Click the pill again to turn plan mode off — next message goes through unmodified.
5. Plan mode persists per agent — switch threads, come back, the toggle reflects what you set.

## 16. Auto-update banner (v0.3)

1. This relies on `https://iris-code.dev/latest.json` returning a higher version than the installed one. Hard to test locally without mocking.
2. To self-test: in DevTools console (npm run dev), run:
   ```js
   window.dispatchEvent(new CustomEvent("iris:show-tour"));  // (just a sanity check the UI works)
   ```
3. To test the banner directly, you can temporarily edit `lib/store.js` default to make the current version look older, or stub `window.iris.checkForUpdates` in DevTools to return `{ ok: true, hasUpdate: true, currentVersion: "0.3.0", latestVersion: "0.4.0", url: "https://github.com/oorbitproductivity-oss/iris/releases", notes: "Tons of new things." }`. Banner should appear at the bottom of the window. Click Dismiss — banner stays gone across restarts (until a newer version is announced).

## 17. Interactive welcome tour (v0.3)

1. To force the tour, in DevTools console:
   ```js
   await window.iris.setSettings({ tourSeenVersion: null });
   location.reload();
   ```
2. After the boot completes the tour overlay appears. 5 steps with a thin gold progress bar.
3. Walk through each step. The "Try it" buttons on steps 2 (palette) and 3 (themes) should fire those flows.
4. Final step ("Start building") closes the tour and saves `tourSeenVersion: "0.3"`.
5. Reload — the tour does NOT re-show.
6. Re-launch from the command palette → "Take the v0.3 tour" any time.

## 18. Open-source repo readiness

Pure desktop work — verify these files exist and read sensibly:

- `LICENSE` (MIT)
- `CONTRIBUTING.md`
- `CODE_OF_CONDUCT.md`
- `SECURITY.md`
- `.github/FUNDING.yml`
- `.github/ISSUE_TEMPLATE/bug_report.yml`, `feature_request.yml`, `config.yml`
- `.github/PULL_REQUEST_TEMPLATE.md`
- `.github/workflows/ci.yml`
- `site/sponsor.html` — open it in a browser and click each tier link (they go to GitHub Sponsors — expected, the placeholder handle won't resolve until you create the real account).

## 19. Smoke test the existing core

After all the new feature work, verify the original flows still work:

- App starts. Onboarding wizard shows once for fresh installs.
- Sidebar: create a thread via "+ New", pick a folder, send a message, see streaming reply.
- Iris overlay: Ctrl+K → ask "What can you do?" → streamed reply.
- Sandbox mode: enable sandbox in new-thread modal, verify the thread runs and the chat header shows the SANDBOX pill.
- Settings (Ctrl+,) — round-trip every field: theme, default cwd, model, hotkey, API keys CRUD.

---

## What to report back

If anything fails or feels wrong, capture:
1. Which numbered test step (e.g. "Test 3, step 4").
2. What you saw vs. what you expected.
3. The DevTools console output if a JS error appeared — open via Ctrl+Shift+I after launching with `npm run dev` (NOT a packaged build — DevTools is disabled there).

---

— end of test plan —

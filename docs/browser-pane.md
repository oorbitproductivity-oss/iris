# Browser pane

The browser pane is a side-by-side webview that mounts inside any worker
agent's chat view. It lets you keep documentation, dashboards, ticketing
tools, or a staging environment open while you collaborate with the agent —
no second window, no alt-tabbing.

> _Screenshot placeholder: chat thread on the left, browser pane on the right with the URL bar and "Send screenshot to agent" footer visible._

## Toggle it

Open any worker thread and look for the **Browser** pill in the chat header
(between the status pill and the Stop button). Click it to slide the pane
in; click again to slide it out. The button is hidden on the **Iris**
orchestrator thread — Iris doesn't have a pane of her own.

You can disable the whole feature in **Settings → Browser pane**. With the
master switch off, the pill never renders, and any persisted per-agent open
state is ignored until you flip the switch back on.

## Per-agent cookie isolation

Each worker gets its own `partition="persist:agent-<id>"` storage bucket.
That means cookies, localStorage, IndexedDB, and login sessions are scoped
to a single agent — sign into GitHub in one thread and you stay anonymous
in every other thread. The data persists between launches: close the pane,
restart Iris, reopen it, and you're still logged in.

> _Screenshot placeholder: two agents open in tabs, each signed in to a different account on the same site._

## Persistent state

For every worker, Iris remembers whether the pane was open and the last
URL you visited. Switching to another thread hides the previous pane and
shows the new agent's state instantly. You can also resize the pane by
dragging the vertical handle between the chat and the pane — the width is
saved globally (default 480px, minimum 300px, maximum 70% of the window).

## Footer actions

- **Open in external browser** — hands the current URL to your default OS
  browser via the existing `openExternal` IPC.
- **Send screenshot to agent** — captures the visible page via
  `webview.capturePage()` and attaches a markdown image (data URL) to the
  chat composer. Edit the message, hit send, and the agent sees the
  screenshot inline.

## Limitations in v0.5.0

The agent **cannot drive this pane** in v0.5.0. The browser is a human-only
tool: you navigate, you ship screenshots into chat. If you want the agent
itself to have a browser, install the **Playwright MCP** from the
**Settings → MCP marketplace** — it gives the agent its own headless
browser with full navigation, screenshot, and selector APIs.

CDP-attached agent control of this exact pane (so the agent can read the
URL, click elements, and observe the same DOM the human sees) is on the
roadmap for a v0.5.x release.

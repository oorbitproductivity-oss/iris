# CLAUD — The Goal

## What we are building

We are taking **Iris Code** (currently v0.4.0) — the open-source Electron desktop GUI that wraps the Claude Code CLI — and pushing it into **premium territory** so it feels as polished and powerful as OpenAI Codex.

## Why

Iris is already feature-rich, but Codex sets the visible bar for what a "premium" AI coding desktop app looks like. Three Codex moves in particular make it feel premium:

1. **It opens a browser inside the app** so the agent can navigate the web visibly.
2. **It has a terminal you never need to leave** the app for.
3. **It makes installing extensions (MCP servers) feel effortless.**

If Iris matches those three and adds polish on top, Iris stops being "a nice open-source GUI" and starts being a tool people pick because it is the best.

## The single goal

**Ship Iris v0.5 — a release that lands seven concrete features that close the Codex gap and unlock the next two years of growth.**

Seven features, split into two tiers:

### Tier 1 — The three that matter most (must ship in v0.5.0)
1. **MCP server marketplace** — one-click install of curated AI extensions.
2. **Embedded browser pane** — Playwright-driven web view next to the chat.
3. **Integrated terminal** — real PTY shell inside the app.

### Tier 2 — Four polish wins (v0.5.1 and v0.5.2)
4. **Custom slash commands** — user-defined `/standup`, `/fix-pr`, etc.
5. **Per-thread cost budgets** — hard $ ceilings with warn + pause.
6. **Rich web-result cards** — search hits render as visual cards.
7. **Translucent Mica/Acrylic chrome** — native Windows 11 / macOS window backdrop.

## The deadline

Five weeks of focused work — one week per phase:

- **Week 1** — MCP marketplace
- **Week 2** — Browser pane
- **Week 3** — Terminal *→ ship v0.5.0*
- **Week 4** — Custom slash commands + cost budgets *→ ship v0.5.1*
- **Week 5** — Web cards + Mica chrome *→ ship v0.5.2*

## What "done" looks like

- v0.5.0, v0.5.1, and v0.5.2 are tagged on GitHub Releases.
- `latest.json` is updated and the Cloudflare Pages site advertises the new version.
- The README feature table has seven new green checkmarks.
- A first-time user opening Iris v0.5 says "this feels like Codex" within ten minutes.

## What this is NOT

- Not a rewrite. Iris's architecture is good — we extend it, never replace it.
- Not a kitchen-sink release. Seven features, no scope creep.
- Not a closed-source pivot. Stays MIT, stays public.
- Not a Codex clone. Iris keeps its own identity (Spotlight, Telegram bridge, sandbox dirs, journal subsystem). Codex parity is the visual + interaction bar, not the soul of the product.

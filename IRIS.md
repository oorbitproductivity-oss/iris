# IRIS.md

Iris Code reads this file as the project-level context for every agent
session it starts in this directory, in the same way the upstream Claude
Code CLI reads `CLAUDE.md`. If both files exist, `IRIS.md` wins; if only
`CLAUDE.md` exists, that is loaded as a fallback so users migrating from
plain Claude Code do not lose their context.

This is the canonical context file for Iris Code itself (the meta case —
when an agent is working on the Iris Code source).

## Project

Iris Code is a desktop GUI on top of the open Claude Code harness, with
bring-your-own-key support for many providers, vendored Hermes-style
persistent memory and skills, a smart router, and a Claude-in-Chrome
browser-test loop. See `README.md` for the user-facing description and
[`PROJECT_BUILD_PLAN.md`](../PROJECT_BUILD_PLAN.md) for the full execution
plan (kept one level up alongside the working copy).

## Code layout

- `main.js` — Electron main process. Spawns `AgentManager`, owns the
  Spotlight window and global hotkey.
- `preload.js` — Renderer-side `window.iris` bridge.
- `lib/agent-manager.js` — subprocess pool, stream-json parsing,
  sandbox, key injection.
- `lib/iris.js` — Iris orchestrator system prompt + `<iris-context>`.
- `lib/store.js` — settings / agents / messages / encrypted key vault.
- `lib/providers/` — Phase 1 provider abstraction (Anthropic, OpenAI,
  OpenRouter, Google, Ollama, generic OpenAI-compatible).
- `lib/memory/` — Phase 3 Hermes-style memory store.
- `lib/skills/` — Phase 3 skill load/save in agentskills.io format.
- `lib/router/` — Phase 4 smart router (manual / quick-tool / agentic).
- `lib/browser/` — Phase 6 Claude-in-Chrome wrapper.
- `bin/iris.js` — Phase 1 CLI entrypoint.
- `app/` — renderer source (HTML/CSS/JS).
- `tests/` — node-runnable smoke + unit tests.

## Conventions

- Plain Node modules (`require`/`module.exports`), Node 20+. No TypeScript
  in the core; the GUI is plain HTML/CSS/JS.
- Two-space indent. Single-quote strings in the lib; double-quote is fine
  in renderer code where it's already established.
- Public functions get a one-line JSDoc summarising contract and shape.
- Tests live under `tests/<module>.test.js` and are runnable via plain
  `node`. They must not require network or real API keys; use the mocked
  provider transport.
- Anything that touches the file system must be path-safe on Windows
  (the canonical dev environment is Windows 11).

## Don'ts

- Don't add Anthropic logos or marks anywhere.
- Don't put product implementation prompts ("write code for me") inside
  the Iris orchestrator's system prompt — Iris delegates, workers
  implement. See `lib/iris.js`.
- Don't write secrets to disk in plaintext; route through `Store`'s
  encrypted key vault.

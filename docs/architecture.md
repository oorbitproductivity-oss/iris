# Architecture

Iris Code is two front-ends over one shared core:

```
┌─────────────────────────────────────────────────────────────┐
│                    iris CLI (bin/iris.js)                   │
│                                                             │
│           ─ key add/list/test  ─ model  ─ chat REPL ─       │
│           slash: /gui /hermes /manual /quick /agent ...     │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           │  shared modules (same Node lib)
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                Iris Code GUI (Electron, app/)               │
│   chat │ file tree │ terminal │ skill browser │ logs        │
└─────────────────────────────────────────────────────────────┘
                           │
       ┌───────────────────┼────────────────────────────┐
       ▼                   ▼                            ▼
┌──────────────┐  ┌─────────────────┐  ┌───────────────────┐
│ Smart Router │  │ Tool Layer      │  │ Provider Layer    │
│ lib/router/  │  │ (claude CLI +   │  │ lib/providers/    │
│              │  │ subagents,      │  │  anthropic        │
│              │  │ sandboxing)     │  │  openai           │
└──────────────┘  └─────────────────┘  │  openrouter       │
                                       │  google           │
┌──────────────┐  ┌─────────────────┐  │  ollama           │
│ Memory       │  │ Skills          │  │  openai-          │
│ lib/memory/  │  │ lib/skills/     │  │   compatible      │
└──────────────┘  └─────────────────┘  └───────────────────┘

                           │
                  ┌────────▼─────────┐
                  │ Browser Test     │
                  │ lib/browser/     │  ─► Claude in Chrome
                  └──────────────────┘
```

## Why a shared core + two front-ends

The CLI and GUI both `require('../lib/providers')`, `lib/memory`,
`lib/skills`, `lib/router`, and `lib/browser`. State lives on disk under
`<userData>/iris-code/` (`%APPDATA%/iris-code` on Windows,
`~/Library/Application Support/iris-code` on macOS,
`~/.config/iris-code` on Linux), so the same conversations, skills,
memory, and API keys are visible to both surfaces.

The CLI's `/gui` slash command serializes the live conversation to
`<userData>/iris-code/cli-sessions/<uuid>.json` and spawns the GUI
pointed at it via `--resume=<uuid>`. The reverse direction (GUI →
terminal) is not implemented in v1 because users who start in the GUI
are already where the rich UI lives.

## Module map

| Module | Purpose |
|---|---|
| `bin/iris.js` | CLI entrypoint. `--version`, `key`, `model`, `chat`. |
| `main.js` | Electron main process. Spawns AgentManager. |
| `preload.js` | Renderer-side `window.iris` bridge. |
| `lib/agent-manager.js` | Per-agent `claude` subprocess pool. |
| `lib/iris.js` | Orchestrator system prompt + `<iris-context>`. |
| `lib/store.js` | Settings / agents / messages / encrypted keys. |
| `lib/providers/` | Wire-format adapters for 6 providers. |
| `lib/memory/` | Three-layer memory store (Hermes-style). |
| `lib/skills/` | agentskills.io-format skill files + reflection. |
| `lib/router/` | manual / quick-tool / agentic classifier. |
| `lib/browser/` | Claude-in-Chrome wrapper with allowlist + retries. |
| `app/` | Renderer HTML/CSS/JS. |
| `tests/` | Node-runnable unit tests, all suites pass under `node tests/run-all.js`. |

## Provider event model

Every provider's `chat()` returns an async iterable that yields:

```
{ type: 'text',     delta: string }
{ type: 'tool_use', id, name, input }
{ type: 'usage',    input_tokens, output_tokens }
{ type: 'stop',     reason: 'end_turn'|'tool_use'|'length'|'error' }
{ type: 'error',    error: string }
```

This is the only contract callers see. Adapters translate Anthropic
Messages SSE, OpenAI Chat Completions SSE, Gemini SSE, and Ollama
NDJSON into these normalized events. New providers add one file to
`lib/providers/` and one entry in `index.js`.

## Routing model

Slash overrides and `--manual|--quick|--agentic` flags always win. When
the user gives a plain message the router applies its fast heuristic
ruleset first (literal phrase matching against a short list of
manual-leaning verbs, quick-tool triggers, and agentic triggers). If
that's inconclusive the router falls back to a single LLM classifier
call with a one-shot prompt. The classifier prompt is editable at
`lib/router/prompts.md` so users can tune.

## Memory + Skills (Hermes-style)

- **Memory** (`lib/memory/index.js`) is an append-only JSONL log plus an
  inverted-index file. Every assistant turn under agentic or
  `--hermes` mode writes a record. `recall(query)` returns the top-N
  records by term-overlap + recency. The Phase-3 plan calls for SQLite
  + FTS5; the current implementation has the same interface but uses
  plain files so it works without a native sqlite build. Swap the
  storage backend later without touching callers.
- **Skills** (`lib/skills/index.js`) are markdown files with YAML
  frontmatter in agentskills.io format, stored under
  `<userData>/iris-code/skills/`. The `reflect()` pass scans completed
  agentic turns for "numbered-procedure" shape and proposes a candidate
  skill; the user accepts or rejects via the REPL prompt or a GUI
  dialog.

## Browser test loop

`lib/browser/index.js` is the single browser-automation path. Features:

- **Preflight gate** — feature stays hidden unless an Anthropic key is
  configured.
- **Domain allowlist** — defaults to `localhost`, `127.0.0.1`,
  `0.0.0.0`, `::1`. Per-project additions via
  `BrowserTestRunner.addAllowedDomain(domain)`.
- **Recoverable retries** — extension failures retry with exponential
  backoff and never crash the host session. The result object always
  resolves to `{ok:true, result}` or `{ok:false, error, recoverable}`.

The Phase-6 exit fixture is `tests/sample-app/` — a small page with a
seeded "input not cleared on submit" bug for the agent to identify.

## Data layout on disk

```
<userData>/iris-code/
├── settings.json
├── agents.json
├── api-keys.json         (encrypted via electron.safeStorage / AES-256-GCM)
├── messages-<id>.json
├── cli-sessions/         (CLI ↔ GUI handoff)
│   └── <uuid>.json
├── memory/
│   ├── prefs.json
│   ├── turns.jsonl
│   └── index.json
└── skills/
    └── <slug>.md
```

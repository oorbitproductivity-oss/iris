# MCP Marketplace

[Model Context Protocol](https://modelcontextprotocol.io) servers extend
Claude with new tools — browsers, databases, GitHub, filesystems, and more.
Iris ships a small marketplace so you can install, configure, and remove
MCP servers from the GUI without hand-editing any `.mcp.json` file.

## Opening the marketplace

In Iris: **Settings → MCP Servers → Open marketplace**.

The marketplace shows the bundled catalog plus any extra entries Iris
pulled from the public CDN catalog (refreshed every 24 hours; **Refresh
catalog** forces a fetch). Bundled entries are vetted and their
executable surface — `command` and `args` — is locked locally, so a
compromised CDN cannot redirect `github` at `npx evil-payload`.

## Bundled servers

Eight servers ship in-box and work offline on first launch:

| Server | What it does | Needs |
|---|---|---|
| **Playwright** | Drive a real Chromium browser: navigate, click, fill, screenshot. | Node 18+ (downloads ~150 MB of Chromium on first run) |
| **GitHub** | Read and write GitHub repos: issues, PRs, comments, code search, workflows. | Node 18+, a [Personal Access Token](https://github.com/settings/tokens) with `repo, read:user, workflow` |
| **Postgres** | Query Postgres: list schemas, run SELECTs, inspect tables. Read-only by default. | Node 18+, a `postgresql://…` connection URL |
| **Fetch** | Fetch any HTTP(S) URL and convert HTML to markdown for the agent to read. | [`uv`](https://github.com/astral-sh/uv) (`pip install uv`) |
| **Filesystem** | Browse and edit files in a directory outside the agent's working dir. | Node 18+, an absolute "allowed directory" path |
| **Memory** | Long-term knowledge graph the agent can write to and recall across sessions. | Node 18+ |
| **Sequential Thinking** | Structured step-by-step reasoning tool for hard questions. | Node 18+ |
| **Time** | Get the current time in any IANA timezone, convert between zones. | `uv` |

## Installing a server

1. Click a server card to open its detail panel.
2. Pick a **scope** — *Global* (every agent on this machine sees it) or
   *This agent only* (scoped to the agent the marketplace was opened from).
3. Fill in any required secrets and config. Required fields are starred;
   the install button stays disabled until they're filled.
4. Click **Install**. The server appears under **Installed servers** at
   the top of the panel and is available the next time an in-scope agent
   spawns.

_(screenshot: install dialog for GitHub MCP)_

## How secrets are stored

Secrets are encrypted with Electron `safeStorage` (OS keychain on macOS,
DPAPI on Windows, libsecret on Linux) — or an AES-256-GCM fallback with a
per-install key under `iris-data/.key-seed` when `safeStorage` is
unavailable. They are only ever decrypted in plaintext for the few
milliseconds the agent process is spawned, and they are **never written
to plaintext `.mcp.json` files on disk**.

The per-spawn runtime config (written to
`iris-data/mcp-runtime/agent-<id>.json`, chmod 600) contains only
`${VAR}` placeholders. The real values ride into the spawned process
through an env-var overlay and are shredded along with the runtime file
after the spawn returns.

## Uninstalling

In **Settings → MCP Servers**, find the install under **Installed
servers** and click **Remove**. This deletes the install record *and*
shreds every secret it owned from the vault. The server is gone from
any agent that spawns after that point — currently-running agents keep
their already-loaded MCP subprocess until they finish their turn.

## Troubleshooting

- **"command not found: npx"** — Install Node.js 18+ from
  [nodejs.org](https://nodejs.org). `npx` ships with it.
- **"command not found: uvx"** — The Fetch and Time servers need
  Astral's `uv` runner: `pip install uv` (or
  `pipx install uv`). Restart Iris after installing.
- **Server installs cleanly but doesn't appear in the agent's tools** —
  Stop and restart the agent. MCP servers are loaded at agent spawn
  time; existing agents won't pick up a newly installed server until
  their next turn begins after a restart.
- **GitHub server errors with 401** — Your PAT is missing a scope or
  expired. Open the install panel, paste a fresh token, and click
  **Update** — the old secret is rotated out of the vault automatically.
- **Filesystem server refuses paths** — Confirm the "Allowed directory"
  is an absolute path that exists, and that the agent isn't running
  under a sandbox profile that blocks it.

## Going further

For protocol details, the full server registry, and instructions on
building your own MCP server, see the official docs at
[modelcontextprotocol.io](https://modelcontextprotocol.io).

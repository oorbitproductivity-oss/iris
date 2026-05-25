# Integrated Terminal (v0.5 Feature 3)

Iris Code ships with a real, PTY-backed terminal that mounts beneath the
chat for any worker agent. It's an everyday shell — bash on macOS/Linux,
PowerShell on Windows — and it lives one click away from the agent that
spawned it, so you can run a build, watch its output, then hand the
result back to the agent without leaving the app.

## Where to find it

Open any worker thread. In the chat header, next to the "Browser" pill,
you'll see a "Terminal" pill. Click it to open a terminal pane at the
bottom of the chat. Click again to close it.

The terminal is hidden for the Iris orchestrator — Iris doesn't have a
single working directory, so the terminal would have no meaningful
home to start in.

## Default shell and working directory

| Platform | Default shell |
|---|---|
| Windows | `%ComSpec%` (usually `cmd.exe`), falling back to `powershell.exe` |
| macOS / Linux | `$SHELL`, falling back to `/bin/bash` |

The terminal starts in the agent's working directory — the same folder
the agent itself was spawned in — so `ls` or `dir` will show the same
files the agent is editing. If the agent has no cwd (rare), the
terminal falls back to your home directory.

## "Share last 50 lines with agent"

The pane header includes a "Share last 50 lines" button. Click it and
Iris will:

1. Grab the last 50 lines from the terminal's scrollback buffer
2. Strip the most common ANSI color codes so it renders cleanly
3. Wrap them in a fenced ` ``` ` code block
4. Drop the block into the chat composer

You then add your own question ("why is this failing?", "summarize",
etc.) and hit send. The agent reads the terminal output as part of the
next turn — no copying, no pasting.

The buffer holds the last **10,000 lines** per terminal, so even a
long-running test or build won't lose history. Single lines longer
than ~8 KB are truncated (a guard against pathological output like
`cat /dev/urandom`).

## Lifecycle

Terminals survive across:

- Switching between agents — your terminal is still there when you
  flip back.
- Renderer reloads — the PTY runs in the main process; the UI just
  re-attaches.

Terminals are killed when:

- You click "Close" in the pane header.
- You quit Iris Code (a `before-quit` hook shuts every PTY down so
  you don't leak shell subprocesses).

Killing an agent does *not* kill its terminal, and vice versa. They're
independent.

## Native-deps caveat

The terminal is backed by [node-pty](https://github.com/microsoft/node-pty),
which has a native binding compiled against a specific Node.js ABI.
Electron ships its own ABI, so node-pty has to be rebuilt against it.
`npm install` runs `electron-rebuild` automatically (via the
`postinstall` script) to handle this. If for some reason the rebuild
didn't run, or you see this in DevTools:

```
Cannot find module ... pty.node
```

…then run this once and restart Iris Code:

```
npx electron-rebuild -f -w node-pty
```

If node-pty still fails to load (some Linux distros without a usable
C++ toolchain, locked-down corporate Macs, etc.), the terminal pane
**self-disables**: the pill in the chat header stays visible but is
greyed out, and clicking it shows a clear inline message telling you
to run `electron-rebuild`. The rest of the app keeps working.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Pill is greyed out, "Terminal unavailable" message | Run `npx electron-rebuild -f -w node-pty` and relaunch. |
| Pane opens but the screen is blank / "feature unavailable — run npm install" | The xterm vendor files weren't copied. Run `npm install` (the `postinstall` script copies them) or manually run `node tools/copy-xterm.js`. |
| Terminal output gets truncated mid-line | Lines longer than 8 KB are clipped in the history buffer. The live terminal still shows them — only "Share last 50 lines" sees the clipped version. |
| Shell isn't the one I expected | Override the default by exporting `SHELL` (Unix) or `ComSpec` (Windows) before launching Iris Code. |
| Process exits as soon as it starts | Check the agent's working directory exists. The PTY won't spawn if cwd is invalid. |

## Implementation pointers

| Layer | File |
|---|---|
| Native PTY manager | [`lib/terminal/pty-manager.js`](../lib/terminal/pty-manager.js) |
| IPC glue | [`main.js`](../main.js) (look for `// ── IPC: Terminal ──`) |
| Preload accessor | [`preload.js`](../preload.js) (`iris.terminal = { ... }`) |
| Renderer UI | [`app/js/ui/terminal-pane.js`](../app/js/ui/terminal-pane.js) |
| xterm loader | [`app/js/lib/load-xterm.js`](../app/js/lib/load-xterm.js) |
| Vendor copy script | [`tools/copy-xterm.js`](../tools/copy-xterm.js) |
| Tests | [`tests/terminal.test.js`](../tests/terminal.test.js) |

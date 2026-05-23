# Contributing to Iris Code

Thanks for caring about this project. Iris Code is a small indie tool — every issue, doc fix, and PR moves it forward.

## Quick links

- Issues: <https://github.com/oorbitproductivity-oss/iriscode/issues>
- Discussions: <https://github.com/oorbitproductivity-oss/iriscode/discussions>

## Ways to contribute

You don't need to write code to help.

- **File issues.** Bugs, weird states, confusing UI — open one. Use the templates.
- **Propose features.** Use the feature template. Explain the problem, not just the fix.
- **Send PRs.** Small focused diffs land fastest. See the checklist below.
- **Write docs.** README, `site/docs.html`, inline comments — anything that would have helped past-you.
- **Share workflows / templates.** Custom prompt templates and snippets are gold; drop them in Discussions.
## Local development setup

```bash
git clone https://github.com/oorbitproductivity-oss/iriscode.git
cd iriscode
npm install
npm run dev          # Electron + DevTools + console forwarding
npm test             # backend smoke test (real claude subprocess + key vault + sandbox)
npm run dist:win     # build a Windows installer into ./dist/
```

You'll need Node.js 20+ and the `claude` CLI on your PATH.

## Code style

Match the existing codebase. In short:

- 2-space indentation, no tabs.
- Semicolons — yes, we use them. Don't omit them.
- Prefer small, single-purpose functions over big ones with flags.
- Comments only when the *why* is non-obvious. The *what* should be readable from the code.
- Renderer code is plain ES modules + `window.iris` IPC; no framework.
- Main-process modules live under `lib/`. Keep IPC handlers thin — push logic into `lib/`.

## Architecture overview

Iris Code is an Electron app: one main process spawns N `claude` subprocesses via `lib/agent-manager.js`, exposes them to a renderer through `preload.js` / `window.iris`, and the renderer drives a sidebar + chat UI plus a global Spotlight overlay. The full contract lives in [`PROTOCOL.md`](PROTOCOL.md); the parallel-build handoff notes are in [`HANDOFF.md`](HANDOFF.md). Read both before touching `lib/agent-manager.js` or `preload.js`.

## PR checklist

Before requesting review, please confirm:

- [ ] `npm test` passes (the smoke test in `smoke-test.js`)
- [ ] Manual smoke: launch with `npm run dev`, create an agent, send a message
- [ ] Screenshot or short clip attached for any UI change
- [ ] `CHANGELOG.md` updated under `## [Unreleased]`
- [ ] No breaking IPC changes without prior discussion in an issue
- [ ] Commits are signed off (see below)

## DCO / Signed-off-by

This project uses the [Developer Certificate of Origin v1.1](https://developercertificate.org/). By signing off on a commit you certify that you wrote the code, or have the right to submit it under the project's MIT license.

Sign off with:

```bash
git commit -s -m "your message"
```

That appends a `Signed-off-by: Your Name <your@email>` trailer. Configure your name/email in git once and you're set:

```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

If you forget, amend with `git commit -s --amend --no-edit` and force-push your branch.

## Community tone

- Be kind. Assume good faith.
- Be direct. "This is wrong because X" beats vague hedging.
- Effort is expected, gatekeeping is not. New contributors get help, not lectures.
- Disagreement is fine; rudeness isn't. See [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

That's it. Welcome aboard.

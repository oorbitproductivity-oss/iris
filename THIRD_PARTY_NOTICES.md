# Third-Party Notices

Iris Code bundles, vendors, or runtime-loads the following third-party
components. Each retains its original copyright and license. This file is
maintained alongside source changes; if you add a dependency, add it here.

---

## Runtime dependencies (npm)

### electron
- License: MIT
- Copyright (c) Electron contributors
- Copyright (c) 2013-2020 GitHub Inc.
- Used as the desktop shell.

### electron-builder
- License: MIT
- Used at build time to produce installers.

A full transitive license report is generated on each release into
`dist/THIRD_PARTY_LICENSES.txt` by `npm run dist`.

---

## External CLIs (not bundled — loaded at runtime if installed)

### Claude Code CLI (`claude`)
- Distributed by Anthropic PBC under its own terms.
- Iris Code spawns the user's installed `claude` binary as a subprocess
  when running in Subscription Bridge mode (Mode A). It is not vendored
  or redistributed by Iris Code.
- Refer to https://docs.claude.com/en/docs/claude-code/overview for the
  CLI's own license and terms.

### Claude in Chrome extension
- Distributed by Anthropic PBC under its own terms.
- Iris Code's browser-testing feature (Phase 6) communicates with this
  extension via its public MCP/RPC surface when the user has it
  installed. It is not vendored or redistributed by Iris Code.

---

## Vendored source

### Hermes Agent (Nous Research) — memory & skills subsystem
- License: MIT
- Upstream: https://github.com/NousResearch/hermes-agent (planned)
- Status: **Not yet vendored.** Phase 3 of the build plan will vendor a
  specific git SHA of Hermes' memory and skill modules into
  `lib/memory/` and `lib/skills/` and preserve their `LICENSE` file
  under `vendor/hermes/LICENSE`. Until Phase 3 ships, the corresponding
  Iris Code modules implement an interface-compatible reimplementation
  authored from scratch by the Iris Code contributors and licensed under
  the MIT outbound license of this project.

---

## Trademark notice

See [NOTICE.md](NOTICE.md) for trademark-use disclosures.

# Provider: Anthropic

Iris Code's primary provider. Streams via the Messages API.

## Setup

```bash
iris key add anthropic
# paste your sk-ant-... key when prompted
iris key test anthropic
```

Or via the GUI: **Settings → API Keys → + Add key → Anthropic**.

Keys are encrypted at rest via `electron.safeStorage` (OS keychain on
macOS/Windows, libsecret on Linux), with an AES-256-GCM fallback when
the keychain isn't available.

## Default model

`claude-sonnet-4-6`. Override per call:

```bash
iris chat --model claude-opus-4-7 "build me X"
```

Or persist via:

```bash
iris model set anthropic:claude-opus-4-7
```

## What it powers

- Default `iris chat` REPL.
- Subscription Bridge mode (Mode A) via the bundled `claude` CLI — the
  Anthropic provider isn't called directly in that mode; the CLI
  subprocess handles auth.
- **Required for Phase-6 browser testing** (Claude in Chrome
  extension).

# Security policy

## Supported versions

Only the latest minor release receives security fixes. Right now that's **v0.4.x**.

| Version | Status |
|---------|--------|
| 0.4.x   | Supported |
| 0.3.x   | Best-effort, please upgrade |
| < 0.3   | No longer supported |

## Reporting a vulnerability

**Do not open a public GitHub issue for security reports.** Open a **private security advisory** at
<https://github.com/oorbitproductivity-oss/iriscode/security/advisories/new> instead. Reports route directly to the maintainers and stay confidential until coordinated disclosure.

Include:

- A short description of the issue.
- Steps to reproduce, ideally with a minimal repro repo or screenshot.
- The version of Iris Code and your OS.
- Any thoughts on impact or fix direction.

## What to expect

- **Within 72 hours**: a human acknowledgement, plus a tracking identifier.
- **Within 14 days**: a fix, mitigation, or written timeline for high-severity issues. Lower-severity issues land on the normal release cadence.
- **Credit**: if you'd like to be credited in the CHANGELOG, say so in the report. We'll honor anonymous reports too.

If you don't hear back within the SLA above, escalate by adding a follow-up comment on the same advisory with the prefix `[ESCALATION]`.

## Scope

In scope:

- The Iris Code Electron app (`main.js`, `lib/`, `app/`).
- The IPC layer between renderer and main.
- The encrypted API-key vault (`lib/store.js`).
- The sandbox isolation model (`lib/agent-manager.js`).
- The installer (`dist/`).

Out of scope:

- The bundled `claude` CLI itself — report those to Anthropic directly at <https://docs.claude.com/en/docs/claude-code>.
- Third-party dependencies — report to the upstream maintainer; we'll bump our pin if/when a fix lands.
- Vulnerabilities in the user's own working directory or its tools.

## Disclosure

We follow coordinated disclosure. We'll work with you on a timeline that gives users a reasonable window to update before details land in a public advisory (typically 30 days after a fix ships).

## Thank you

If you're reading this and considering reporting something — thank you. Security reports are some of the most valuable contributions a small project can receive.

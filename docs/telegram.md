# Telegram Remote Agent

DM your own Telegram bot to run Claude Code tasks on your desktop, with
progress and results streamed back as bot replies. Bring-your-own-bot — one
user, one bot, no shared servers, no third-party infrastructure.

## Quick start

1. **Create the bot.** Message [@BotFather](https://t.me/BotFather) → `/newbot`
   → pick a display name → copy the token it gives you. The token looks like
   `12345:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`.
2. **Save the token.** In Iris: **Settings → Telegram Remote Agent → Bot
   token**. Paste, click **Save token**. Iris verifies the token against
   Telegram before saving.
3. **Pair your phone.** Click **Pair my phone**. Iris shows a 6-digit code.
4. **Send the code from Telegram.** Open your bot in Telegram and send the
   6-digit code as a regular message. The bot replies **✅ Paired** — you're
   done.

You can now message your bot from anywhere. Each message becomes a new
Claude Code task running on the paired desktop.

### Number-driven menus

If you don't want to memorize commands, send `/control` (or `/help` /
`/menu`). The bot replies with a numbered list — just reply with the
digit to pick. Same for `/switch` with no argument: it shows your
sessions as numbers, you reply `2` to jump to session 2.

```
What would you like to do?

1. 🆕 New session
2. 📋 List sessions
3. 🔀 Switch session
4. ⏹️ Stop current task
5. ℹ️ About this bot

Reply with the number.
```

Menus expire after 5 minutes — after that, a stray number is treated as
a normal message and sent to the agent.

### Direct commands

- **Any non-command text** → runs as a task (or continues the current
  session).
- `/control` (aliases: `/help`, `/menu`, `/start`) → numbered main menu.
- `/new` → starts a fresh session. The previous one stays around so you
  can return to it via `/switch`.
- `/list` → shows your last five sessions, newest first.
- `/switch` → numbered session picker; reply with the digit.
- `/switch <n>` → jumps directly to session `n` from `/list`.
- `/stop` → cancels the running task in the current session.

Iris must be running on the desktop. If the desktop is asleep or offline,
your messages queue at Telegram and the bot picks them up next time the
bridge is online.

## How it works

```
phone (Telegram)
  ↓  long-poll
api.telegram.org
  ↑  long-poll
your desktop Iris  ──▶  AgentManager  ──▶  `claude` CLI subprocess
```

- Iris long-polls `api.telegram.org/bot<token>/getUpdates`. There is no
  inbound port to open on your firewall; the desktop is always the client.
- Incoming messages route through the same `AgentManager` that runs your
  GUI sessions — so safety guardrails, working-directory rules, sandbox
  mode, API-key selection, and effort settings all apply unchanged.
- The bot's reply stream is formatted as Telegram MarkdownV2: one message
  per agent turn (chunked at 4096 chars), short tool-use announcements for
  destructive operations, and concise error messages.

## Security model

- **Token at rest.** The bot token is encrypted on disk via Electron's
  `safeStorage` (OS keychain on macOS, DPAPI on Windows, libsecret on Linux).
  If `safeStorage` reports unavailable, Iris falls back to AES-256-GCM with
  a per-install key in `~/.config/iris-code/iris-data/.key-seed` (chmod 600).
  The token file lives at `~/.config/iris-code/iris-data/telegram-token.json`.
- **Chat allowlist.** Only the chat you paired with can drive agents. Every
  inbound message is gated on `chat.id === allowedChatId`. Messages from any
  other chat are dropped silently — strangers get no response, no agent, no
  hint of what's running.
- **Sandbox lockdown.** Every Telegram-spawned agent is contained to a
  Telegram-owned workspace under
  `~/.config/iris-code/iris-data/telegram-workspaces/<random>/` plus a
  per-agent sandbox under `iris-data/sandboxes/<id>/`. Both roots live
  inside the Iris data directory — **not** in your real project tree. The
  agent CAN freely create folders, edit files, and reorganize content
  inside that workspace ("you can change folders within the session"), but
  it has no read or write access to anything you didn't put there. Your
  `defaultCwd`, SSH keys, browser profile, Documents folder, etc. are
  invisible. This isolation cannot be relaxed from Telegram — the GUI is
  the only path to an unsandboxed agent.
- **Dangerous-command halt.** Telegram-driven agents inherit the same
  destructive-command detector as desktop agents (`rm -rf`, `git reset
  --hard`, writes to system paths, SQL `DROP`, etc.). A flagged command
  halts the run and pings the chat: 🛑 *Halted (safety check)*.
- **Network surface.** Outbound HTTPS to `api.telegram.org` only. No inbound
  ports. No data leaves the desktop except through the chat thread you
  control.

## Day-to-day use

- **Boot prompt.** When Iris starts and a bot token is configured, it asks
  *"Start Iris Code with the Telegram bridge?"* — pick **Yes** to run the
  bridge in the background, **No** to launch desktop-only. Tick **Don't ask
  again** on either choice to remember it forever (you can clear the
  remembered choice from the Telegram panel).
- **Sidebar quick-toggle.** A small ✈ Telegram button lives in the
  sidebar footer next to **Settings**. The status dot reads at a glance:
  - 🟢 green = paired + bridge online
  - 🟡 amber = token saved, bridge currently off / not paired
  - ⚪ grey  = no token configured
  Single-click prompts to start/stop the bridge. Double-click opens the
  full setup panel.
- **Multiple sessions.** Each `/new` from Telegram creates a separate
  agent (visible in the desktop sidebar with a 📱 marker). Use `/list` and
  `/switch <n>` to navigate between them — they all stay live in the
  background until you delete them from the desktop UI.

## Troubleshooting

| Symptom | Probable cause | Fix |
|---|---|---|
| "Telegram rejected the token" on save | Typo or stale token | Re-copy from @BotFather; tokens look like `12345:ABC…` |
| "Bot token rejected by Telegram (revoked or invalid)" in status | Token was regenerated in @BotFather | Save the new token in the panel |
| Bot doesn't reply to the pairing code | Bridge isn't running, OR your phone clock skew expired the code | Toggle **Run the Telegram bridge** ON; codes expire in 10 minutes |
| "Conflict" error in connection status | Another Iris (or a webhook) is polling the same token | Stop the other instance, or `/revoke` and re-issue a new token |
| Messages get truncated | Telegram's per-message limit is 4096 characters | Iris splits long replies automatically; a very long single line may still cut on a word boundary |
| Bot replies as plain text instead of markdown | Iris's MarkdownV2 fallback kicked in (one of the formatting characters wasn't escaped properly for a particular message) | Cosmetic only — content is intact |

## Limits

- **One chat per bot.** This is intentional: the pairing claims a single
  `allowedChatId`. To pair a different chat, click **Pair my phone** again
  and send a new code from that chat (the previous one is dropped).
- **One agent per chat.** Each Telegram chat gets one bound agent. Use
  `/new` to swap it for a fresh one — the previous agent's history is
  discarded.
- **Iris must be running.** This is a desktop client of Telegram's polling
  API, not a server. Telegram queues your messages for up to 24 hours.
- **No file uploads (yet).** Only text messages are routed. Stickers,
  voice, photos, and files are ignored. A future version could surface
  uploads as input attachments.

## FAQ

**Why not webhooks?** Webhooks require Iris to expose an inbound HTTPS
endpoint, which means port forwarding, dynamic DNS, and certificate
management for one user with one bot. Long-polling works behind any NAT
with zero config.

**Why a 6-digit pairing code?** Telegram chat IDs aren't human-typeable.
The pairing flow lets you claim the chat without copy-pasting numeric IDs.

**Can I use the same bot from two desktops?** No — Telegram serves each
`getUpdates` to whichever instance asks first, so two desktops would
race for messages. Use a separate `/newbot` per machine.

**Can my friend use my bot?** Only if you re-pair from their chat. There
is only ever one authorized chat.

# Remote Access (mobile companion)

Iris Code can serve a small HTTP/WebSocket API alongside the desktop app so a
companion mobile app (`iris-mobile/`) can connect from your phone and:

- Browse the working directories of your agents
- View files (read-only) with the same path-safety scoping the desktop uses
- Chat with any agent — streaming responses, tool calls, results in real time

All compute (Claude Code subprocesses, file I/O, agent state) stays on the
desktop. The phone is a thin client.

> **Security:** the bearer token is the only thing between an attacker on your
> network and your filesystem. Treat it like a password. Don't paste it into
> chat or email. If you suspect it leaked, regenerate it (Settings →
> Remote access → Regenerate).

## Quick start (same WiFi)

1. **Enable on desktop**
   - Open Iris Code → Settings → "Open remote access settings…"
   - Toggle **Enable remote access** on. A bearer token is generated
     automatically; copy it to the clipboard.
   - Note the LAN address shown (e.g. `http://192.168.1.42:8765`).
2. **Open the firewall (Windows)**
   - The first time you enable, Windows may prompt to allow Iris through the
     firewall. Click **Allow**.
   - If you missed the prompt, open an elevated PowerShell and run:
     ```powershell
     New-NetFirewallRule -DisplayName "Iris Code remote" `
       -Direction Inbound -Action Allow -Protocol TCP `
       -LocalPort 8765
     ```
   - Replace `8765` with whatever port you configured.
3. **On the phone**
   - Install [Expo Go](https://expo.dev/go) from the App Store / Play Store.
   - Start the mobile app dev server from `iris-mobile/`:
     ```bash
     cd iris-mobile
     npx expo start
     ```
   - Scan the QR with Expo Go.
   - In the Iris Mobile **Connect** screen, paste the URL and token. Tap
     **Test connection**, then **Save & connect**.

## Connecting from outside the home WiFi (Tailscale)

For coding on cellular or from a coffee shop, use [Tailscale](https://tailscale.com).
It puts both devices on a private encrypted network — you don't need to open
your router or expose anything publicly.

1. Install **Tailscale** on your PC and your phone. Sign in with the same
   account on both.
2. Find your PC's Tailscale hostname (in the Tailscale app on your phone, your
   PC will appear in the list — tap to copy its name like
   `your-pc.tail-scale.ts.net`).
3. In Iris Mobile's Connect screen, use:
   `http://your-pc.tail-scale.ts.net:8765`
4. The same token still applies.

## Verifying from the desktop

The token works against any HTTP client. To sanity-check from your PC:

```bash
TOKEN="paste-your-token-here"
curl -H "Authorization: Bearer $TOKEN" http://localhost:8765/api/v1/agents
```

Or just `/health` (unauthenticated):

```bash
curl http://localhost:8765/health
# {"ok":true,"version":"0.3.0","requiresToken":true}
```

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Liveness probe (unauthenticated) |
| `GET` | `/api/v1/app/version` | Iris version |
| `GET` | `/api/v1/agents` | List all agents |
| `GET` | `/api/v1/agents/:id` | Single agent + full message history |
| `POST` | `/api/v1/agents/:id/messages` | Send a message; body `{"message": "..."}` |
| `POST` | `/api/v1/agents/:id/stop` | Interrupt a running turn |
| `POST` | `/api/v1/agents/:id/resume` | Mark idle so next message resumes the session |
| `GET` | `/api/v1/fs/tree?cwd=&depth=` | Directory tree (must be under an agent's cwd) |
| `GET` | `/api/v1/fs/file?path=` | Single file content (must be under an agent's cwd; 1 MB max) |
| `GET` | `/api/v1/memory?cwd=` | `CLAUDE.md` contents for that workspace |
| `WS` | `/ws?token=<...>` | Event stream; subscribe with `{type:"subscribe",agentIds:[...] | "*"}` |

## What the server WON'T let remote clients do

By design, the v1 API only exposes read-only filesystem access — and only for
paths under an agent's working directory (or sandbox directory). Even with a
valid token, an attacker cannot:

- Read files outside any agent's working dir (e.g. `C:\Windows\...`)
- Manage API keys
- Edit files
- Create or delete agents
- Open arbitrary paths

These restrictions live in `lib/fs-browser.js` and the route handlers in
`lib/server.js`.

## Troubleshooting

**Phone says "Couldn't reach the server."**
- Are both devices on the same WiFi? Check the phone hasn't fallen back to
  cellular.
- Did you accept the Windows firewall prompt for Iris? See the PowerShell
  command above to add the rule manually.
- Try `curl` from the desktop to confirm the server is actually listening:
  `curl http://localhost:8765/health`.

**Phone says "Remote access is disabled on the desktop."**
- The toggle in Iris isn't on, or Iris isn't running. Open Iris → Settings →
  Remote access → enable.

**Phone says "Token rejected."**
- The token was regenerated, or you copied it wrong. Open the Remote Access
  panel in Iris, hit the eye icon to reveal the token, copy it, and paste
  again in the mobile Connect screen (or the Settings → Disconnect →
  reconnect flow).

**Connections panel in Iris shows 0 even though my phone is connected**
- The Remote Access modal in Iris polls on demand. Hit **Refresh** in the
  Connections row to recount.

**Want to move to a different port**
- Change the port in the Remote Access panel. The server restarts within ~1s
  on the new port. Don't forget to update the firewall rule and the URL
  saved on the phone.

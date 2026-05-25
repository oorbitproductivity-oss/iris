# Deploy to Cloudflare Pages — runbook

This is the one-page checklist for going live. Everything is staged; the only
manual steps are auth, GitHub Releases upload, and `wrangler pages deploy`.

## 1. Authenticate Cloudflare (one-time)

Open a fresh PowerShell or `cmd` window in this project and run:

```
npx wrangler login
```

A browser tab opens — sign in to your Cloudflare account and authorize the
Wrangler client. Credentials are cached at `%USERPROFILE%\.wrangler\`.

Verify it took:

```
npx wrangler whoami
```

## 2. Upload the Windows installers to GitHub Releases

The site is configured to redirect download buttons to GitHub Releases. Two
installers need to be uploaded:

- `dist/Iris Code Setup 0.4.0.exe` (x64)
- `dist/Iris Code Setup 0.4.0 (ARM64).exe` (ARM64)

Steps:

1. Create a public GitHub repo named `iris-code/iris-code` (or update the URLs
   in `site/_redirects` and `site/latest.json` to match the actual owner/repo).
2. Tag and create a release named `v0.4.0`.
3. Upload both `.exe` files as release assets. Keep the filenames exactly as
   they appear in `_redirects`:
   - `Iris-Code-Setup-0.4.0.exe`
   - `Iris-Code-Setup-0.4.0-ARM64.exe` (rename from "Iris Code Setup 0.4.0 (ARM64).exe")
4. (Recommended) Generate SHA-256 sums and attach them as `SHA256SUMS.txt`:
   ```
   Get-FileHash "dist\Iris Code Setup 0.4.0.exe" -Algorithm SHA256
   Get-FileHash "dist\Iris Code Setup 0.4.0 (ARM64).exe" -Algorithm SHA256
   ```

## 3. Deploy the site

From the project root (`iris-app/`):

```
npx wrangler pages deploy site --project-name iris-code
```

First-time deploy will prompt to confirm the project name and pick a production
branch. Subsequent deploys reuse those settings.

Output ends with a URL like `https://iris-code.pages.dev`. That is your live
site.

## 4. (Optional) Custom domain

In the Cloudflare dashboard:
1. Pages → `iris-code` project → Custom domains → Set up a custom domain.
2. Add `iris-code.dev` (or whatever you own).
3. Cloudflare provides DNS records to add at your registrar.

## 5. Verify everything works

After deploy:

- [ ] Landing page loads, icon appears in the header.
- [ ] `/download.html` shows both x64 and ARM64 buttons.
- [ ] Clicking each button redirects to the GitHub Releases download.
- [ ] `/share.html` opens; "Copy link" works; channel buttons open the right apps.
- [ ] The footer "Share this with a friend" bar appears on every page except `/share.html`.
- [ ] `/latest.json` returns valid JSON.

## 6. Sharing

Once the URL is confirmed working, paste it into Gmail / iMessage / Discord
yourself — or use the `/share.html` page on the site to open a prefilled
share sheet.

## 7. Local dev setup (contributors)

`npm install` does everything you need — it pulls dependencies AND runs
the `postinstall` script which:

1. Copies the xterm.js renderer files into `app/js/lib/xterm/` so the
   integrated terminal pane (v0.5 Feature 3) can load them without a
   bundler.
2. Runs `electron-rebuild -f -w node-pty` so node-pty's native binding
   matches Electron's Node ABI.

Then start the app with `npm start`.

### Troubleshooting

- **`Cannot find module ... pty.node`** — node-pty wasn't rebuilt
  against this Electron. Run `npx electron-rebuild -f -w node-pty`
  manually and restart.
- **Terminal pane says "feature unavailable — run npm install"** — the
  xterm vendor files weren't copied. Run `node tools/copy-xterm.js`
  manually.

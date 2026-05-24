# Release & verification playbook

End-to-end recipe for cutting a Windows release of Iris Code: build → upload → deploy → verify. Followed for v0.4.0 on 2026-05-23/24.

## Quick reference

| Thing | Where |
|---|---|
| Repo root | `G:\Other computers\My Computer\code\Iris code\iris-app` |
| Installers output | `dist\` |
| Site source | `site\` |
| GitHub repo | `oorbitproductivity-oss/iris` |
| Cloudflare Pages project | `iris-code` (publishes `site/`) |
| Live site | https://iris-code.pages.dev |
| Release URL | https://github.com/oorbitproductivity-oss/iris/releases/tag/vX.Y.Z |
| gh CLI | `C:\Program Files\GitHub CLI\gh.exe` |

## Pre-release checklist

Before touching the build:

1. Bump `version` in `package.json` if cutting a new version.
2. Verify `description` in `package.json` is **short** (one sentence ≤ ~100 chars). A long description corrupts NSIS shortcut fields and breaks the Desktop / Start Menu shortcuts. Marketing copy lives in `site/` and `README.md`, NOT in `package.json`.
3. Run tests:
   ```powershell
   npm test
   ```
   All 8 suites must pass before building.

## Build both arch installers (the rename dance)

electron-builder's NSIS target won't produce two distinct per-arch installers from one invocation — passing `--x64 --arm64` together collapses them into a single ~180 MB multi-arch installer, which is NOT what we ship.

Run the two builds separately, with a temporary rename in between:

```powershell
# 1. x64 build → writes "Iris Code Setup X.Y.Z.exe"
npm run dist:win

# 2. Save the x64 build out of the way
Move-Item -LiteralPath "dist\Iris Code Setup X.Y.Z.exe" "dist\Iris-Code-x64-temp.exe"
Move-Item -LiteralPath "dist\Iris Code Setup X.Y.Z.exe.blockmap" "dist\Iris-Code-x64-temp.exe.blockmap"

# 3. arm64 build → also writes "Iris Code Setup X.Y.Z.exe"
npm run dist:win:arm64

# 4. Move arm64 to its final name, restore x64
Move-Item -LiteralPath "dist\Iris Code Setup X.Y.Z.exe" "dist\Iris Code Setup X.Y.Z (ARM64).exe"
Move-Item -LiteralPath "dist\Iris Code Setup X.Y.Z.exe.blockmap" "dist\Iris Code Setup X.Y.Z (ARM64).exe.blockmap"
Move-Item -LiteralPath "dist\Iris-Code-x64-temp.exe" "dist\Iris Code Setup X.Y.Z.exe"
Move-Item -LiteralPath "dist\Iris-Code-x64-temp.exe.blockmap" "dist\Iris Code Setup X.Y.Z.exe.blockmap"
```

End state: `dist\` contains `Iris Code Setup X.Y.Z.exe` (x64) and `Iris Code Setup X.Y.Z (ARM64).exe` (arm64).

> Each build takes ~60–90 s on the ARM Snapdragon host. Build duration is dominated by `@electron/rebuild` of native deps. Total build time for both archs is ~3 minutes.

## Compute hashes and update site files

```powershell
$dist = "G:\Other computers\My Computer\code\Iris code\iris-app\dist"
$x64Path = Join-Path $dist 'Iris Code Setup X.Y.Z.exe'
$armPath = Join-Path $dist 'Iris Code Setup X.Y.Z (ARM64).exe'
$x64Hash = (Get-FileHash -LiteralPath $x64Path -Algorithm SHA256).Hash.ToLower()
$armHash = (Get-FileHash -LiteralPath $armPath -Algorithm SHA256).Hash.ToLower()
$x64Size = (Get-Item -LiteralPath $x64Path).Length
$armSize = (Get-Item -LiteralPath $armPath).Length

# Regenerate SHA256SUMS.txt with hyphen-renamed filenames (the names used on GitHub)
"$x64Hash  Iris-Code-Setup-X.Y.Z.exe`n$armHash  Iris-Code-Setup-X.Y.Z-ARM64.exe`n" |
  Set-Content -LiteralPath (Join-Path $dist 'SHA256SUMS.txt') -NoNewline -Encoding ascii
```

Then hand-edit (or scripted):
- `site\latest.json` — replace `windows.x64.size`, `windows.x64.sha256`, `windows.arm64.size`, `windows.arm64.sha256` with the new values. Keep the `url` fields as-is — they point at the hyphen-style GitHub asset names.
- `site\download.html` — replace the two SHA256 `<code>` blocks in the checksum table.

> The website expects hyphen-style filenames (`Iris-Code-Setup-X.Y.Z.exe`, `Iris-Code-Setup-X.Y.Z-ARM64.exe`) because the 90 MB installers exceed Cloudflare Pages' 25 MB asset limit and are hosted via 302 redirects in `site\_redirects` to GitHub Releases.

## Upload to GitHub Releases

`gh` should already be authenticated (`C:\Program Files\GitHub CLI\gh.exe` — token in Windows credential store). If `gh auth status` says you're not logged in, run `gh auth login` and pick GitHub.com → HTTPS → Login with a web browser → enter the displayed code at https://github.com/login/device within ~15 minutes.

Make hyphen-renamed copies (the GitHub URLs use hyphens, the local builds use spaces):

```powershell
cd "G:\Other computers\My Computer\code\Iris code\iris-app\dist"
Copy-Item "Iris Code Setup X.Y.Z.exe"          "Iris-Code-Setup-X.Y.Z.exe"
Copy-Item "Iris Code Setup X.Y.Z (ARM64).exe"  "Iris-Code-Setup-X.Y.Z-ARM64.exe"

& "C:\Program Files\GitHub CLI\gh.exe" release upload vX.Y.Z `
  "Iris-Code-Setup-X.Y.Z.exe" `
  "Iris-Code-Setup-X.Y.Z-ARM64.exe" `
  "SHA256SUMS.txt" `
  --repo oorbitproductivity-oss/iris --clobber
```

`--clobber` overwrites existing assets with the same name. Useful when re-shipping a fix without bumping the version.

## Deploy the site to Cloudflare Pages

This is the step that the previous Claude session could not automate. Pick one:

**Drag-drop (easiest):**
1. https://dash.cloudflare.com/ → Workers & Pages → `iris-code` project
2. Create deployment → Upload assets
3. Drag the `site` folder onto the drop zone → Save and deploy (~30 s)

**Wrangler CLI:**
```powershell
npm install -g wrangler
wrangler login
wrangler pages deploy "G:\Other computers\My Computer\code\Iris code\iris-app\site" --project-name=iris-code
```

**Git auto-deploy (best long-term):**
Pages project → Settings → Builds → Connect to Git → publish directory `site`. Every push that touches `site/` then auto-publishes.

## Verification

After the Pages deploy completes, confirm the site is serving the new files:

```powershell
# Live latest.json should match what's in site/ locally
curl https://iris-code.pages.dev/latest.json

# GitHub release assets should resolve (200 OK on the redirected URL)
curl -sIL "https://iris-code.pages.dev/download/win-x64"   | findstr "HTTP Content-Length"
curl -sIL "https://iris-code.pages.dev/download/win-arm64" | findstr "HTTP Content-Length"

# SHA256SUMS.txt on the GitHub release should equal dist/SHA256SUMS.txt
curl -sL "https://github.com/oorbitproductivity-oss/iris/releases/download/vX.Y.Z/SHA256SUMS.txt"
Get-Content "G:\Other computers\My Computer\code\Iris code\iris-app\dist\SHA256SUMS.txt"
```

End-to-end smoke test on a clean machine (or your own, after uninstalling the prior version):
1. Open https://iris-code.pages.dev/download.html
2. Click "Download for Windows (x64)" or "(ARM64)" depending on your CPU (Win+Pause → "System type")
3. Run the downloaded .exe
4. Pass the SmartScreen blue prompt (More info → Run anyway — unsigned, see "Known issues" below)
5. Complete the install. Launch from the Desktop or Start Menu shortcut.
6. Confirm the app window opens and shows the welcome / first-run UI.

## Known issues and gotchas

### Corrupted shortcuts ("Cannot find shortcut")
**Cause:** A long `description` in `package.json` overflows the NSIS `CreateShortCut` description field, scrambling `WorkingDirectory` and `IconLocation` on the resulting .lnk. Looks like an installer bug but is a build-config bug.
**Detection:**
```powershell
$s = (New-Object -ComObject WScript.Shell).CreateShortcut("$env:USERPROFILE\Desktop\Iris Code.lnk")
$s.TargetPath; $s.WorkingDirectory; $s.IconLocation
```
If `WorkingDirectory` or `IconLocation` contains chunks of the description string, the bug is back. Fix by shortening `package.json` description to one sentence, rebuilding.
**Quick repair without rebuild:**
```powershell
$sh = New-Object -ComObject WScript.Shell
$target = 'C:\Users\<you>\AppData\Local\Programs\Iris Code\Iris Code.exe'
foreach ($p in @("$env:USERPROFILE\Desktop\Iris Code.lnk", "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Iris Code.lnk")) {
  $s = $sh.CreateShortcut($p)
  $s.TargetPath = $target
  $s.WorkingDirectory = Split-Path $target -Parent
  $s.IconLocation = $target + ',0'
  $s.Description = 'Iris Code'
  $s.Save()
}
```

### SmartScreen blocks the unsigned exe
Iris Code installers are not code-signed yet. Windows SmartScreen / Defender intermittently blocks both the installer and the installed exe when launched from a shortcut, sometimes with a misleading "Cannot find shortcut" wording.
**Diagnostic:** if `Start-Process "<path to>\Iris Code.exe"` from PowerShell launches the app cleanly but double-clicking the shortcut shows an error, it's SmartScreen, not a real bug. Click **More info → Run anyway** once.

### `dist\Iris Code Setup X.Y.Z.exe` is suddenly 180 MB
The two builds were started with `--x64 --arm64` together. electron-builder packed both architectures into one installer. Discard it and follow the rename-dance recipe above to get two ~90 MB per-arch installers.

### Live site still shows old hashes after Pages deploy
Cloudflare's CDN caches `latest.json` for 5 minutes (see `site\_headers`). Bust with `?cb=<timestamp>` query string when verifying immediately after deploy.

## File-by-file change log for v0.4.0 fix (2026-05-23 → 24)

For reference next time:
- `package.json` — `description` shortened from 462-char marketing blob to one sentence.
- `package.json` — `build.win.target.arch` left as `["x64"]`; new script `dist:win:arm64` added.
- `dist/SHA256SUMS.txt` — regenerated.
- `site/latest.json` — `size` + `sha256` updated for both archs.
- `site/download.html` — checksum table SHA256 cells updated for both archs.
- GitHub release `v0.4.0` — three assets re-uploaded with `--clobber` (download counts reset to 0).
- Cloudflare Pages — manual drag-drop redeploy of `site/`.

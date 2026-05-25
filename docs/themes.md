# Themes

Iris Code ships five named themes, switchable from the Theme Picker
modal (Command Palette → "Pick a theme" or the gear menu in Settings).

| Name           | Family | Accent                |
|----------------|--------|-----------------------|
| `codex-dark`   | dark   | warm gold (#c89b3c)   |
| `codex-light`  | light  | deeper gold (#a67c1f) |
| `midnight`     | dark   | cyan (#58a6ff)        |
| `solarized`    | dark   | yellow (#b58900)      |
| `forest`       | dark   | leaf green (#6fbf73)  |

Each theme overrides only the color tokens (`--bg-*`, `--text-*`,
`--accent*`). Spacing, radii, typography, and motion stay shared, so a
theme switch never re-flows layout.

The active theme is persisted in `settings.themeName` and applied to
`<html>` as `data-theme-name="<name>"`. CSS variables in
`app/css/themes.css` key off that attribute, so adding a new theme is a
matter of dropping in another `:root[data-theme-name="..."] { ... }`
block — no JS changes required.

---

## Translucent window (Mica / vibrancy)

A "Translucent window (Windows 11 / macOS)" checkbox in the Theme Picker
turns on the native OS material behind the app chrome:

- **Windows 11 build 22000+** — `BrowserWindow.backgroundMaterial = "mica"`
- **macOS** — `vibrancy = "under-window"` with `visualEffectState = "active"`
- **Windows 10 / Linux** — checkbox is disabled with a tooltip
  ("Available on Windows 11 (build 22000+) and macOS only."). The setting
  may still be flipped via storage, but `createMainWindow()` ignores it
  on unsupported OSes; nothing breaks.

### Why dark themes only

The translucent CSS variant is **only applied to dark themes**
(`codex-dark`, `midnight`). Two reasons:

1. **Contrast.** Light themes already use dark text on a near-white
   surface. Pulling that surface down to ~75% alpha lets whatever the
   user's wallpaper is bleed through, and text contrast against the
   blended result is unpredictable — sometimes below WCAG AA, sometimes
   above, never consistent. Dark themes use light text on a dark
   surface; even when the wallpaper bleeds through, the dark tint stays
   dark enough to keep contrast above the floor.
2. **Aesthetics.** The "frosted-glass over a colorful desktop" look is
   the established Win11 / macOS design language for dark surfaces. The
   light-mode equivalent (rgba over white) tends to look washed-out and
   sickly on the same wallpaper.

If you switch to a light theme while translucency is on, the setting
stays in storage but the CSS attribute (`data-translucent`) on `<html>`
is dropped so the page renders fully opaque. Switching back to a dark
theme re-applies it without re-toggling the checkbox.

### Contrast tradeoffs

Alpha values were picked conservatively:

- `--bg-1` (sidebar, header, panel bodies) → `rgba(..., 0.75)`
- `--bg-2` (chat surface, tool cards) → `rgba(..., 0.85)`
- `--bg-3` / `--bg-4` (code blocks, inputs, chips, modal interiors) →
  fully opaque (see `[data-translucent="true"] .modal, pre, input { ... }`
  in `themes.css`)

This keeps the busiest reading surfaces — code blocks, the composer,
inputs, modal dialogs — at full opacity, while the larger empty fields
(sidebar, chat scrollback) breathe with the OS material behind them.

### Limitations

- The native material attaches at **window creation time** on Windows.
  Flipping the setting at runtime updates the CSS variant immediately so
  existing surfaces match, but the Mica material itself only takes
  effect on the **next** window you open. The toast nudges the user to
  reopen the window for the full effect.
- macOS vibrancy can be set live, but the `vibrancy` property on
  `BrowserWindow` is set at construction in our codebase; flipping mid
  session likewise takes effect on next window.

### Manual verification checklist

There is no good way to assert "the OS material is rendering correctly"
from a headless test. Verify by hand:

1. On Windows 11 (or macOS), open Settings → Theme Picker.
2. Pick `codex-dark` (or `midnight`).
3. Tick **Translucent window**. Confirm the toast.
4. Quit and relaunch Iris Code (or close the window and pick "New
   window" from the tray) so the Mica/vibrancy material attaches.
5. Set a colorful wallpaper (high-saturation photo, not a flat color)
   and drag the Iris window over it.
6. Confirm:
   - The window background tints with the wallpaper behind it.
   - Sidebar item text is readable.
   - Body text in the chat thread is readable.
   - Code blocks and the composer input are NOT translucent (they stay
     solid for readability).
   - Modal dialogs are NOT translucent.
7. Switch to `codex-light`. Confirm the translucent variant disappears
   (the page becomes fully opaque) without un-ticking the setting.
8. Switch back to `codex-dark`. Confirm translucency re-applies.
9. Untick **Translucent window**. Reopen the window. Confirm the
   material is gone and the dark fill returns.

If you're on Windows 10 or Linux, confirm step 3 is impossible — the
checkbox should be disabled with the tooltip "Available on Windows 11
(build 22000+) and macOS only."

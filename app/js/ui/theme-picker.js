// ═══════════════════════════════════════════════════════════
// theme-picker.js — Named theme variants (codex-dark, codex-light,
// midnight, solarized, forest). The coarse `theme` setting still
// drives light/dark classification; `themeName` selects the
// specific variant.
// ═══════════════════════════════════════════════════════════

import { h, svgIcon, openModal, showToast } from "./util.js"

const THEMES = [
  {
    name: "codex-dark",
    label: "Codex Dark",
    coarse: "dark",
    swatches: ["#0c0c10", "#17171e", "#c89b3c"],
  },
  {
    name: "codex-light",
    label: "Codex Light",
    coarse: "light",
    swatches: ["#fafaf7", "#eaeae3", "#a67c1f"],
  },
  {
    name: "midnight",
    label: "Midnight",
    coarse: "dark",
    swatches: ["#07080c", "#131623", "#58a6ff"],
  },
  {
    name: "solarized",
    label: "Solarized",
    coarse: "dark",
    swatches: ["#002b36", "#073642", "#b58900"],
  },
  {
    name: "forest",
    label: "Forest",
    coarse: "dark",
    swatches: ["#0d1410", "#1a261f", "#6fbf73"],
  },
]

const DEFAULT_NAME = "codex-dark"

// Coarse-classification table for which named theme is "dark". Translucent
// chrome is only offered on dark themes — alpha-over-light reads badly.
const DARK_THEMES = new Set(["codex-dark", "midnight", "solarized", "forest"])

function currentName(state) {
  const s = state.get().settings || {}
  return s.themeName || DEFAULT_NAME
}

function applyName(name) {
  document.documentElement.setAttribute("data-theme-name", name)
}

// Mirror the translucentWindow setting onto an HTML attribute so the CSS
// variant in themes.css can opt-in surfaces with [data-translucent="true"].
function applyTranslucentAttr(enabled) {
  document.documentElement.setAttribute(
    "data-translucent",
    enabled ? "true" : "false"
  )
}

export function initThemes(state) {
  // Apply on boot once settings load; re-apply whenever they change.
  let lastName = null
  let lastTranslucent = null
  function maybeApply() {
    const s = state.get().settings || {}
    const name = s.themeName || DEFAULT_NAME
    const translucent = !!s.translucentWindow && DARK_THEMES.has(name)
    if (name !== lastName) {
      lastName = name
      applyName(name)
    }
    if (translucent !== lastTranslucent) {
      lastTranslucent = translucent
      applyTranslucentAttr(translucent)
    }
  }
  maybeApply()
  state.subscribe(maybeApply)

  // The main process broadcasts when the setting flips (so other windows
  // catch up too). The CSS attribute is the cheap source of truth.
  if (window.iris && typeof window.iris.onTranslucentChanged === "function") {
    window.iris.onTranslucentChanged(({ enabled } = {}) => {
      const name = currentName(state)
      applyTranslucentAttr(!!enabled && DARK_THEMES.has(name))
    })
  }

  window.addEventListener("iris:show-theme-picker", () => showThemePicker(state))
}

export function showThemePicker(state) {
  const modal = h("div", { class: "modal theme-picker" })

  const header = h("div", { class: "modal-header" })
  const closeBtn = h("button", { class: "modal-close", "aria-label": "Close" }, svgIcon("x", 14))
  header.append(h("div", { class: "modal-title" }, "Pick a theme"), closeBtn)

  const body = h("div", { class: "modal-body" })
  const grid = h("div", { class: "theme-grid" })

  function renderCards() {
    grid.innerHTML = ""
    const active = currentName(state)
    for (const t of THEMES) {
      const card = h("div", {
        class: `theme-card${t.name === active ? " active" : ""}`,
        "data-theme": t.name,
      })
      const swatches = h("div", { class: "theme-swatches" })
      for (const c of t.swatches) {
        const sw = h("span", { class: "theme-swatch" })
        sw.style.background = c
        swatches.append(sw)
      }
      const title = h("div", { class: "theme-card-title" }, t.label)
      const sub = h("div", { class: "theme-card-sub" }, t.coarse === "dark" ? "Dark" : "Light")
      const applyBtn = h(
        "button",
        { class: "btn btn-ghost theme-apply-btn", type: "button" },
        t.name === active ? "Active" : "Apply",
      )
      applyBtn.addEventListener("click", async () => {
        // Apply immediately for instant feedback, then persist.
        applyName(t.name)
        try {
          await state.actions.saveSettings({ themeName: t.name, theme: t.coarse })
          showToast(`Theme: ${t.label}`)
          renderCards()
        } catch {
          showToast("Failed to save theme", { error: true })
        }
      })
      card.append(swatches, title, sub, applyBtn)
      grid.append(card)
    }
  }
  renderCards()

  // ── Translucent window toggle ─────────────────────────────
  //
  // Renders an opt-in checkbox row beneath the theme grid. The row is
  // auto-disabled on platforms without OS support (Win10, Linux), with a
  // tooltip explaining why. The setting is also conceptually "dark themes
  // only" — the change handler still writes the setting on a light theme
  // so it takes effect the moment the user switches back to a dark one;
  // applyTranslucentAttr filters by current theme so light themes never
  // get the visual variant even if the bit is set.
  const translucentRow = h("div", { class: "theme-translucent-row" })
  const tCheckbox = h("input", { type: "checkbox", id: "theme-translucent-cb" })
  const tLabel = h(
    "label",
    { for: "theme-translucent-cb", class: "theme-translucent-label" },
    "Translucent window (Windows 11 / macOS)",
  )
  const tHint = h(
    "div",
    { class: "theme-translucent-hint" },
    "Uses native Mica on Win11 or under-window vibrancy on macOS. Applied on dark themes only — light themes stay solid for readability.",
  )

  // Reflect current value while we wait for the support check.
  tCheckbox.checked = !!(state.get().settings || {}).translucentWindow

  // Gate the row on OS support. Disabled + tooltip when unsupported.
  let supported = false
  let supportReason = null
  ;(async () => {
    try {
      const r = await (window.iris && window.iris.translucentSupported
        ? window.iris.translucentSupported()
        : Promise.resolve({ supported: false, reason: "Bridge unavailable" }))
      supported = !!(r && r.supported)
      supportReason = (r && r.reason) || null
    } catch {
      supported = false
      supportReason = "Could not check OS support."
    }
    if (!supported) {
      tCheckbox.disabled = true
      const msg = supportReason
        || "Available on Windows 11 (build 22000+) and macOS only."
      tCheckbox.title = msg
      tLabel.title = msg
      translucentRow.classList.add("disabled")
    }
  })()

  tCheckbox.addEventListener("change", async () => {
    const checked = !!tCheckbox.checked
    try {
      await state.actions.saveSettings({ translucentWindow: checked })
      // Apply immediately for the current page. The main process broadcast
      // arrives a beat later; setting the attribute now avoids any flicker.
      const activeName = currentName(state)
      const okForTheme = DARK_THEMES.has(activeName)
      document.documentElement.setAttribute(
        "data-translucent",
        checked && okForTheme ? "true" : "false",
      )
      if (checked && supported) {
        showToast("Translucent window enabled — reopen the window to see the native material")
      } else if (checked && !supported) {
        showToast("Translucent saved, but your OS doesn't support it", { error: true })
      } else {
        showToast("Translucent window disabled")
      }
    } catch {
      // Roll back the checkbox to match the persisted value.
      tCheckbox.checked = !checked
      showToast("Failed to save translucent setting", { error: true })
    }
  })

  translucentRow.append(tCheckbox, tLabel, tHint)
  body.append(grid, translucentRow)
  modal.append(header, body)

  const handle = openModal(modal)
  closeBtn.addEventListener("click", () => handle.close())
}

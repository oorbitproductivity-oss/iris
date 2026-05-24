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

function currentName(state) {
  const s = state.get().settings || {}
  return s.themeName || DEFAULT_NAME
}

function applyName(name) {
  document.documentElement.setAttribute("data-theme-name", name)
}

export function initThemes(state) {
  // Apply on boot once settings load; re-apply whenever they change.
  let last = null
  function maybeApply() {
    const name = currentName(state)
    if (name === last) return
    last = name
    applyName(name)
  }
  maybeApply()
  state.subscribe(maybeApply)

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

  body.append(grid)
  modal.append(header, body)

  const handle = openModal(modal)
  closeBtn.addEventListener("click", () => handle.close())
}

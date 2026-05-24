// ═══════════════════════════════════════════════════════════
// search.js — Global message search across all agents
// Ctrl/Cmd+Shift+F opens. Substring match, case-insensitive,
// grouped by agent, capped at 200 results.
// ═══════════════════════════════════════════════════════════

import { h, svgIcon, showToast } from "./util.js"

const MAX_RESULTS = 200
const SNIPPET_RADIUS = 60 // chars on each side of match
const DEBOUNCE_MS = 80

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function snippetWithMark(text, queryLc, matchIdx) {
  const start = Math.max(0, matchIdx - SNIPPET_RADIUS)
  const end = Math.min(text.length, matchIdx + queryLc.length + SNIPPET_RADIUS)
  const head = start > 0 ? "…" : ""
  const tail = end < text.length ? "…" : ""
  const before = escapeHtml(text.slice(start, matchIdx))
  const hit = escapeHtml(text.slice(matchIdx, matchIdx + queryLc.length))
  const after = escapeHtml(text.slice(matchIdx + queryLc.length, end))
  return `${head}${before}<mark>${hit}</mark>${after}${tail}`
}

function roleBadge(role) {
  if (role === "user") return "you"
  if (role === "assistant") return "iris" // any assistant; differentiated below if it's the orchestrator
  return role || "system"
}

function search(state, query) {
  const q = query.trim().toLowerCase()
  if (!q) return { groups: [], total: 0, truncated: false }

  const s = state.get()
  const agents = (s.agents || []).slice().sort(
    (a, b) => (b.lastActivity || 0) - (a.lastActivity || 0),
  )
  const messagesByAgent = s.messagesByAgent || {}

  const groups = []
  let total = 0
  let truncated = false

  for (const agent of agents) {
    const msgs = messagesByAgent[agent.id] || []
    const hits = []
    for (const m of msgs) {
      if (!m || typeof m.text !== "string" || !m.text) continue
      const tLc = m.text.toLowerCase()
      const idx = tLc.indexOf(q)
      if (idx < 0) continue
      // For the assistant role, mark "iris" specifically for the orchestrator agent.
      const role =
        m.role === "assistant" && agent.id === "iris"
          ? "iris"
          : m.role === "assistant"
            ? "assistant"
            : m.role
      hits.push({
        agentId: agent.id,
        role,
        ts: m.ts || 0,
        snippetHtml: snippetWithMark(m.text, q, idx),
      })
      total++
      if (total >= MAX_RESULTS) {
        truncated = true
        break
      }
    }
    if (hits.length) {
      groups.push({ agent, hits })
    }
    if (truncated) break
  }

  return { groups, total, truncated }
}

function openSearchModal(state) {
  if (document.querySelector(".search-modal-overlay")) return

  const overlay = h("div", { class: "search-modal-overlay" })
  const modal = h("div", { class: "search-modal", role: "dialog", "aria-label": "Search messages" })

  const head = h("div", { class: "search-head" })
  head.append(svgIcon("focus", 14))
  const input = h("input", {
    class: "search-input",
    type: "text",
    placeholder: "Search across all threads…",
    autocomplete: "off",
    spellcheck: "false",
  })
  const closeBtn = h("button", { class: "modal-close", "aria-label": "Close" }, svgIcon("x", 14))
  head.append(input, closeBtn)

  const meta = h("div", { class: "search-meta" }, "Type to search messages")
  const list = h("div", { class: "search-results" })

  modal.append(head, meta, list)
  overlay.append(modal)
  document.body.append(overlay)

  function close() {
    overlay.remove()
    document.removeEventListener("keydown", onKey, true)
  }

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault()
      close()
    }
  }

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close()
  })
  closeBtn.addEventListener("click", close)
  document.addEventListener("keydown", onKey, true)

  function render(query) {
    if (!query.trim()) {
      meta.textContent = "Type to search messages"
      list.innerHTML = ""
      return
    }
    const { groups, total, truncated } = search(state, query)
    if (!total) {
      meta.textContent = "No matches"
      list.innerHTML = ""
      return
    }
    meta.textContent = truncated
      ? `Showing first ${MAX_RESULTS} matches`
      : `${total} match${total === 1 ? "" : "es"}`

    list.innerHTML = ""
    for (const group of groups) {
      const groupEl = h("div", { class: "search-agent-group" })
      const header = h(
        "div",
        { class: "search-agent-header" },
        h("span", { class: "search-agent-name" }, group.agent.name || "Untitled"),
        h("span", { class: "search-agent-count" }, `${group.hits.length}`),
      )
      groupEl.append(header)
      for (const hit of group.hits) {
        const row = h("button", {
          class: "search-result",
          type: "button",
          "data-agent": hit.agentId,
        })
        const role = h("span", { class: `search-result-role role-${hit.role}` }, roleBadge(hit.role))
        const snippet = h("span", { class: "search-result-snippet", html: hit.snippetHtml })
        row.append(role, snippet)
        row.addEventListener("click", () => {
          try {
            state.actions.selectAgent(hit.agentId)
          } catch (e) {
            console.error("[search] selectAgent failed", e)
            showToast("Could not switch thread", { error: true })
          }
          close()
        })
        groupEl.append(row)
      }
      list.append(groupEl)
    }
  }

  let timer = null
  input.addEventListener("input", () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => render(input.value), DEBOUNCE_MS)
  })

  setTimeout(() => input.focus(), 20)
}

export function showSearch(state, _opts) {
  openSearchModal(state)
}

export function initSearch(state) {
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.shiftKey && (e.key === "F" || e.key === "f" || e.code === "KeyF")) {
      e.preventDefault()
      showSearch(state)
    }
  })
  window.addEventListener("iris:show-search", () => showSearch(state))
}

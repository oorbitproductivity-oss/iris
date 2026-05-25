// ═══════════════════════════════════════════════════════════
// mcp-marketplace.js — MCP Server Marketplace (renderer UI)
// ═══════════════════════════════════════════════════════════
//
// Talks to the main-process MCP service via window.iris.mcp.* (preload bridge).
// Renders a full-screen modal with a catalog grid, per-server cards, and a
// nested install dialog. State for installs is refreshed after every install
// or uninstall so card buttons stay accurate without a page reload.
//
// Public API:
//   initMcpMarketplace(state)  — register state on the module so other
//                                modules can open the marketplace without
//                                having a reference to state lying around.
//   openMcpMarketplace(state)  — open the modal. `state` is optional if
//                                init has already run.

import { h, svgIcon, openModal, showToast } from "./util.js";

let registeredState = null;

export function initMcpMarketplace(state) {
  registeredState = state;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function formatInstallCount(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num <= 0) return "—";
  if (num < 1000) return `${num} install${num === 1 ? "" : "s"}`;
  if (num < 1_000_000) {
    const k = num / 1000;
    return `${k >= 10 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}k installs`;
  }
  const m = num / 1_000_000;
  return `${m >= 10 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, "")}M installs`;
}

function sortServers(servers) {
  const list = Array.isArray(servers) ? servers.slice() : [];
  list.sort((a, b) => {
    const af = a.featured ? 1 : 0;
    const bf = b.featured ? 1 : 0;
    if (af !== bf) return bf - af;
    const ai = Number(a.installCount || 0);
    const bi = Number(b.installCount || 0);
    return bi - ai;
  });
  return list;
}

function safe(value, fallback = "") {
  if (value == null) return fallback;
  return String(value);
}

// ─────────────────────────────────────────────────────────────
// Public open
// ─────────────────────────────────────────────────────────────

export function openMcpMarketplace(state) {
  const s = state || registeredState;
  if (!s) {
    showToast("Marketplace not initialized yet", { error: true });
    return null;
  }
  if (!window.iris || !window.iris.mcp) {
    showToast("MCP marketplace unavailable in this build", { error: true });
    return null;
  }

  // ── Modal shell ────────────────────────────────────────
  const modal = h("div", { class: "modal mcp-modal" });

  // Header: title + search + refresh + close
  const header = h("div", { class: "mcp-header" });
  const titleBlock = h("div", { class: "mcp-title-block" });
  titleBlock.append(
    h("div", { class: "mcp-title" }, "MCP Server Marketplace"),
    h("div", { class: "mcp-subtitle" },
      "Browse and install Model Context Protocol servers — tool extensions for your agents."),
  );

  const headerActions = h("div", { class: "mcp-header-actions" });
  const searchWrap = h("div", { class: "mcp-search-wrap" });
  const searchInput = h("input", {
    class: "mcp-search-input",
    type: "search",
    placeholder: "Search by name, tag, or publisher…",
    "aria-label": "Search marketplace",
    spellcheck: "false",
    autocomplete: "off",
  });
  searchWrap.append(
    h("span", { class: "mcp-search-icon", "aria-hidden": "true" },
      // Magnifier glyph drawn in the same stroke style as util.js icons.
      ((() => {
        const ns = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(ns, "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("width", "14");
        svg.setAttribute("height", "14");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "1.8");
        svg.setAttribute("stroke-linecap", "round");
        svg.setAttribute("stroke-linejoin", "round");
        svg.innerHTML = '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>';
        return svg;
      })()),
    ),
    searchInput,
  );

  const refreshBtn = h("button", { class: "btn btn-ghost mcp-refresh-btn", type: "button", title: "Re-fetch the catalog from the registry" });
  refreshBtn.append(
    ((() => {
      const ns = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(ns, "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("width", "14");
      svg.setAttribute("height", "14");
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", "currentColor");
      svg.setAttribute("stroke-width", "1.8");
      svg.setAttribute("stroke-linecap", "round");
      svg.setAttribute("stroke-linejoin", "round");
      svg.innerHTML = '<path d="M3 12a9 9 0 0 1 15.5-6.3L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16"/><path d="M3 21v-5h5"/>';
      return svg;
    })()),
    h("span", null, "Refresh catalog"),
  );
  const closeBtn = h("button", { class: "modal-close", "aria-label": "Close" }, svgIcon("x", 14));

  headerActions.append(searchWrap, refreshBtn, closeBtn);
  header.append(titleBlock, headerActions);

  // Banner row (for inline messages — install confirmation, errors)
  const banner = h("div", { class: "mcp-banner", hidden: true });

  // Body: filter bar + grid
  const body = h("div", { class: "mcp-body" });

  const filterBar = h("div", { class: "mcp-filter-bar" });
  const catChips = h("div", { class: "mcp-cat-chips" });
  const resultMeta = h("div", { class: "mcp-result-meta" }, "");
  filterBar.append(catChips, resultMeta);

  const grid = h("div", { class: "mcp-grid" });
  body.append(filterBar, grid);

  modal.append(header, banner, body);

  const { close } = openModal(modal, {
    onClose: () => {
      // No cleanup needed — listeners are owned by the modal subtree.
    },
  });
  closeBtn.addEventListener("click", () => close());

  // ── State held inside the modal closure ───────────────
  let allServers = [];
  let installs = [];            // [{ id, slug, scope, ... }]
  let installsBySlug = new Map(); // slug -> [installRow]
  let activeCategory = "all";
  let searchTerm = "";
  let isLoading = false;

  function setBanner(message, kind = "info") {
    if (!message) {
      banner.hidden = true;
      banner.textContent = "";
      banner.className = "mcp-banner";
      return;
    }
    banner.hidden = false;
    banner.textContent = message;
    banner.className = `mcp-banner mcp-banner-${kind}`;
  }

  function rebuildInstallIndex() {
    installsBySlug = new Map();
    for (const row of installs || []) {
      if (!row || !row.slug) continue;
      if (!installsBySlug.has(row.slug)) installsBySlug.set(row.slug, []);
      installsBySlug.get(row.slug).push(row);
    }
  }

  function getGlobalInstall(slug) {
    const rows = installsBySlug.get(slug) || [];
    return rows.find((r) => r.scope === "global") || null;
  }

  // ── Loading state ─────────────────────────────────────
  function renderLoading() {
    grid.innerHTML = "";
    const card = h("div", { class: "mcp-loading" });
    card.append(
      h("div", { class: "mcp-spinner", "aria-hidden": "true" }),
      h("div", { class: "mcp-loading-text" }, "Loading the catalog…"),
    );
    grid.append(card);
    resultMeta.textContent = "";
  }

  function renderError(err) {
    grid.innerHTML = "";
    const box = h("div", { class: "mcp-empty" });
    box.append(
      h("div", { class: "mcp-empty-title" }, "Couldn't load the catalog"),
      h("div", { class: "mcp-empty-body" }, safe(err && err.message ? err.message : err, "Unknown error") +
        ". Check your connection and try again."),
    );
    const retry = h("button", { class: "btn btn-primary", type: "button" }, "Try refresh");
    retry.addEventListener("click", () => refresh(true));
    box.append(retry);
    grid.append(box);
    resultMeta.textContent = "";
  }

  function renderEmpty(message) {
    grid.innerHTML = "";
    const box = h("div", { class: "mcp-empty" });
    box.append(
      h("div", { class: "mcp-empty-title" }, "Nothing to show"),
      h("div", { class: "mcp-empty-body" }, message || "The catalog is empty right now."),
    );
    const retry = h("button", { class: "btn btn-ghost", type: "button" }, "Try refresh");
    retry.addEventListener("click", () => refresh(true));
    box.append(retry);
    grid.append(box);
    resultMeta.textContent = "0 results";
  }

  // ── Category filter ───────────────────────────────────
  function rebuildCategoryChips() {
    catChips.innerHTML = "";
    const counts = new Map();
    for (const s of allServers) {
      const cat = s.category || "uncategorized";
      counts.set(cat, (counts.get(cat) || 0) + 1);
    }
    const orderedCats = ["all", ...Array.from(counts.keys()).sort()];
    for (const cat of orderedCats) {
      const label = cat === "all"
        ? `All · ${allServers.length}`
        : `${prettifyCategory(cat)} · ${counts.get(cat) || 0}`;
      const chip = h("button", {
        class: `mcp-chip${cat === activeCategory ? " active" : ""}`,
        type: "button",
        "data-cat": cat,
      }, label);
      chip.addEventListener("click", () => {
        activeCategory = cat;
        rebuildCategoryChips();
        renderGrid();
      });
      catChips.append(chip);
    }
  }

  function prettifyCategory(cat) {
    return String(cat || "")
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" ");
  }

  // ── Card rendering ────────────────────────────────────
  function renderCard(server) {
    const card = h("article", {
      class: `mcp-card${server.featured ? " featured" : ""}`,
      "data-slug": server.slug,
    });

    // Top row: name + category pill
    const topRow = h("div", { class: "mcp-card-top" });
    const nameBlock = h("div", { class: "mcp-card-name-block" });
    nameBlock.append(
      h("h3", { class: "mcp-card-name", title: server.name }, safe(server.name, server.slug)),
      h("div", { class: "mcp-card-publisher" }, safe(server.publisher, "Community")),
    );
    const meta = h("div", { class: "mcp-card-meta" });
    if (server.featured) {
      meta.append(h("span", { class: "mcp-pill mcp-pill-featured", title: "Editor's pick" }, "Featured"));
    }
    if (server.category) {
      meta.append(h("span", { class: "mcp-pill mcp-pill-category" }, prettifyCategory(server.category)));
    }
    topRow.append(nameBlock, meta);

    // Description (clamped to 2 lines via CSS)
    const desc = h("p", { class: "mcp-card-desc" }, safe(server.description, "No description provided."));

    // Stats row: install count + tags
    const statsRow = h("div", { class: "mcp-card-stats" });
    statsRow.append(
      h("span", { class: "mcp-stat-installs" }, formatInstallCount(server.installCount)),
    );
    if (Array.isArray(server.tags) && server.tags.length) {
      const tagList = h("div", { class: "mcp-tag-list" });
      for (const t of server.tags.slice(0, 4)) {
        tagList.append(h("span", { class: "mcp-tag" }, "#" + t));
      }
      statsRow.append(tagList);
    }

    // Prereqs (small hint text)
    let prereqEl = null;
    if (Array.isArray(server.prereqs) && server.prereqs.length) {
      prereqEl = h("div", { class: "mcp-card-prereqs", title: "Required before installing" },
        "Requires: " + server.prereqs.join(", "));
    }

    // Action row
    const actionRow = h("div", { class: "mcp-card-actions" });
    const install = getGlobalInstall(server.slug);

    // Per-card inline confirm state for uninstall — kept here so each card
    // has its own state without a shared map.
    let confirmTimer = null;

    function paintActions() {
      actionRow.innerHTML = "";
      const installNow = getGlobalInstall(server.slug);
      if (installNow) {
        const installedPill = h("span", { class: "mcp-installed-pill", title: "Installed for all agents" });
        installedPill.append(
          ((() => {
            const ns = "http://www.w3.org/2000/svg";
            const svg = document.createElementNS(ns, "svg");
            svg.setAttribute("viewBox", "0 0 24 24");
            svg.setAttribute("width", "12");
            svg.setAttribute("height", "12");
            svg.setAttribute("fill", "none");
            svg.setAttribute("stroke", "currentColor");
            svg.setAttribute("stroke-width", "2");
            svg.setAttribute("stroke-linecap", "round");
            svg.setAttribute("stroke-linejoin", "round");
            svg.innerHTML = '<path d="M20 6L9 17l-5-5"/>';
            return svg;
          })()),
          h("span", null, "Installed"),
        );
        const uninstallBtn = h("button", { class: "btn btn-ghost mcp-uninstall-btn", type: "button" }, "Uninstall");
        uninstallBtn.addEventListener("click", async () => {
          if (confirmTimer) {
            // Confirmed — perform the uninstall.
            clearTimeout(confirmTimer);
            confirmTimer = null;
            uninstallBtn.disabled = true;
            uninstallBtn.textContent = "Removing…";
            try {
              const r = await window.iris.mcp.uninstall(installNow.id);
              if (r && r.ok === false) {
                showToast("Uninstall failed: " + safe(r.error, "unknown"), { error: true });
              } else {
                setBanner(`Removed ${safe(server.name, server.slug)}. New agent runs won't load it anymore.`, "ok");
                setTimeout(() => setBanner(null), 4000);
              }
            } catch (err) {
              showToast("Uninstall failed: " + (err.message || err), { error: true });
            } finally {
              await refreshInstalls();
              paintActions();
            }
          } else {
            // Arm — 3-second confirm window.
            uninstallBtn.textContent = "Click to confirm";
            uninstallBtn.classList.add("mcp-uninstall-armed");
            confirmTimer = setTimeout(() => {
              confirmTimer = null;
              uninstallBtn.textContent = "Uninstall";
              uninstallBtn.classList.remove("mcp-uninstall-armed");
            }, 3000);
          }
        });
        actionRow.append(installedPill, uninstallBtn);
      } else {
        const installBtn = h("button", { class: "btn btn-primary mcp-install-btn", type: "button" }, "Install");
        installBtn.addEventListener("click", () => {
          openInstallDialog(server);
        });
        if (server.homepage) {
          const homepageLink = h("button", { class: "btn btn-ghost mcp-homepage-btn", type: "button", title: "Open homepage" }, "Docs");
          homepageLink.addEventListener("click", (e) => {
            e.preventDefault();
            try { window.iris?.openExternal?.(server.homepage); } catch {}
          });
          actionRow.append(homepageLink, installBtn);
        } else {
          actionRow.append(installBtn);
        }
      }
    }
    paintActions();

    card.append(topRow, desc, statsRow);
    if (prereqEl) card.append(prereqEl);
    card.append(actionRow);
    return card;
  }

  function filterServers() {
    const term = searchTerm.trim().toLowerCase();
    return allServers.filter((s) => {
      if (activeCategory !== "all" && s.category !== activeCategory) return false;
      if (!term) return true;
      const hay = [
        s.name, s.slug, s.publisher, s.description,
        ...(Array.isArray(s.tags) ? s.tags : []),
        s.category,
      ].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(term);
    });
  }

  function renderGrid() {
    if (isLoading) {
      renderLoading();
      return;
    }
    const filtered = sortServers(filterServers());
    grid.innerHTML = "";
    if (!filtered.length) {
      if (!allServers.length) {
        renderEmpty("The marketplace is empty right now.");
      } else {
        const box = h("div", { class: "mcp-empty" });
        box.append(
          h("div", { class: "mcp-empty-title" }, "No servers match that filter"),
          h("div", { class: "mcp-empty-body" }, "Try clearing the search or picking a different category."),
        );
        grid.append(box);
        resultMeta.textContent = `0 of ${allServers.length}`;
      }
      return;
    }
    for (const server of filtered) {
      grid.append(renderCard(server));
    }
    resultMeta.textContent = filtered.length === allServers.length
      ? `${filtered.length} server${filtered.length === 1 ? "" : "s"}`
      : `${filtered.length} of ${allServers.length}`;
  }

  // ── Refresh data ──────────────────────────────────────
  async function refreshInstalls() {
    try {
      installs = await window.iris.mcp.installs();
      if (!Array.isArray(installs)) installs = [];
    } catch (err) {
      console.error("[mcp-marketplace] installs() failed", err);
      installs = [];
    }
    rebuildInstallIndex();
  }

  async function refresh(force) {
    isLoading = true;
    renderLoading();
    refreshBtn.disabled = true;
    const wasLabel = refreshBtn.querySelector("span")?.textContent;
    try {
      const catalog = await window.iris.mcp.catalog({ refresh: !!force });
      const servers = catalog && Array.isArray(catalog.servers) ? catalog.servers : [];
      allServers = servers;
      await refreshInstalls();
      isLoading = false;
      rebuildCategoryChips();
      renderGrid();
      if (force) {
        setBanner(`Catalog refreshed — ${servers.length} server${servers.length === 1 ? "" : "s"} available.`, "ok");
        setTimeout(() => setBanner(null), 2500);
      }
    } catch (err) {
      isLoading = false;
      console.error("[mcp-marketplace] catalog() failed", err);
      renderError(err);
    } finally {
      refreshBtn.disabled = false;
      if (wasLabel) {
        const span = refreshBtn.querySelector("span");
        if (span) span.textContent = wasLabel;
      }
    }
  }

  // ── Search debounce ───────────────────────────────────
  let searchTimer = null;
  searchInput.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTerm = searchInput.value || "";
      renderGrid();
    }, 80);
  });

  refreshBtn.addEventListener("click", () => refresh(true));

  // ── Install dialog ────────────────────────────────────
  function openInstallDialog(server) {
    const dialog = h("div", { class: "modal mcp-install-dialog", style: { width: "min(520px, calc(100vw - 32px))" } });

    const dHeader = h("div", { class: "modal-header" });
    dHeader.append(
      h("div", { class: "modal-title" }, `Install ${safe(server.name, server.slug)}`),
      h("button", { class: "modal-close", "aria-label": "Close" }, svgIcon("x", 14)),
    );

    const dBody = h("div", { class: "modal-body" });

    // Summary card — read-only context
    const summary = h("div", { class: "mcp-install-summary" });
    summary.append(
      h("div", { class: "mcp-install-summary-row" },
        h("span", { class: "mcp-install-summary-label" }, "Publisher"),
        h("span", { class: "mcp-install-summary-value" }, safe(server.publisher, "Community")),
      ),
      h("p", { class: "mcp-install-summary-desc" }, safe(server.description, "No description provided.")),
    );
    if (Array.isArray(server.prereqs) && server.prereqs.length) {
      summary.append(
        h("div", { class: "mcp-install-prereqs" },
          h("span", { class: "mcp-install-prereqs-label" }, "Requires"),
          h("span", null, server.prereqs.join(", ")),
        ),
      );
    }
    dBody.append(summary);

    // Scope (only one option in v0.5.0)
    const scopeField = h("div", { class: "field" });
    scopeField.append(h("label", { class: "label" }, "Where to install"));
    const scopeSelect = h("select", { class: "select" });
    scopeSelect.append(h("option", { value: "global" }, "Available to all agents (global)"));
    scopeField.append(scopeSelect);
    scopeField.append(h("div", { class: "hint" },
      "Per-agent install will arrive in a later version."));
    dBody.append(scopeField);

    // Secrets — one password input each
    const secretInputs = [];
    if (Array.isArray(server.secrets) && server.secrets.length) {
      const secHead = h("div", { class: "mcp-section-head" }, "Secrets");
      dBody.append(secHead);
      for (const sec of server.secrets) {
        const f = h("div", { class: "field" });
        const labelText = safe(sec.label, sec.key) + (sec.required ? "" : "  (optional)");
        f.append(h("label", { class: "label" }, labelText));
        const row = h("div", { class: "field-row" });
        const inp = h("input", {
          class: "input",
          type: "password",
          placeholder: sec.hint || `Enter ${safe(sec.label, sec.key)}…`,
          autocomplete: "off",
          spellcheck: "false",
          "data-key": sec.key,
        });
        const eye = h("button", { class: "btn btn-ghost", type: "button", title: "Show / hide value" }, "👁");
        eye.addEventListener("click", () => {
          inp.type = inp.type === "password" ? "text" : "password";
        });
        row.append(inp, eye);
        f.append(row);
        if (sec.hint) f.append(h("div", { class: "hint" }, sec.hint));
        dBody.append(f);
        secretInputs.push({ key: sec.key, required: !!sec.required, label: safe(sec.label, sec.key), input: inp });
      }
    }

    // Config — text inputs
    const configInputs = [];
    if (Array.isArray(server.config) && server.config.length) {
      const cfgHead = h("div", { class: "mcp-section-head" }, "Configuration");
      dBody.append(cfgHead);
      for (const cfg of server.config) {
        const f = h("div", { class: "field" });
        const labelText = safe(cfg.label, cfg.key) + (cfg.required ? "" : "  (optional)");
        f.append(h("label", { class: "label" }, labelText));
        const isPath = (cfg.type === "path");
        const placeholder = cfg.hint || (isPath ? "C:\\path\\to\\folder" : `Enter ${safe(cfg.label, cfg.key)}…`);
        const inp = h("input", {
          class: "input",
          type: "text",
          placeholder,
          autocomplete: "off",
          spellcheck: "false",
          "data-key": cfg.key,
        });
        if (isPath && window.iris?.pickFolder) {
          const row = h("div", { class: "field-row" });
          const browse = h("button", { class: "btn btn-filled", type: "button" });
          browse.append(svgIcon("folder", 14), h("span", null, "Browse"));
          browse.addEventListener("click", async () => {
            try {
              const picked = await window.iris.pickFolder();
              if (picked) inp.value = picked;
            } catch {}
          });
          row.append(inp, browse);
          f.append(row);
        } else {
          f.append(inp);
        }
        if (cfg.hint) f.append(h("div", { class: "hint" }, cfg.hint));
        dBody.append(f);
        configInputs.push({ key: cfg.key, required: !!cfg.required, label: safe(cfg.label, cfg.key), input: inp });
      }
    }

    // Error area
    const errorBox = h("div", { class: "mcp-install-error", hidden: true });
    dBody.append(errorBox);

    // Footer
    const footer = h("div", { class: "modal-footer" });
    const cancelBtn = h("button", { class: "btn btn-ghost", type: "button" }, "Cancel");
    const submitBtn = h("button", { class: "btn btn-primary", type: "button" }, "Install");
    footer.append(cancelBtn, submitBtn);

    dialog.append(dHeader, dBody, footer);

    const { close: closeDialog } = openModal(dialog);
    dHeader.querySelector(".modal-close").addEventListener("click", () => closeDialog());
    cancelBtn.addEventListener("click", () => closeDialog());

    function showError(msg) {
      errorBox.hidden = !msg;
      errorBox.textContent = msg || "";
    }

    submitBtn.addEventListener("click", async () => {
      showError(null);

      // Validate required fields up-front.
      const secrets = {};
      const config = {};
      for (const s of secretInputs) {
        const v = (s.input.value || "").trim();
        if (s.required && !v) {
          showError(`${s.label} is required.`);
          s.input.focus();
          return;
        }
        if (v) secrets[s.key] = v;
      }
      for (const c of configInputs) {
        const v = (c.input.value || "").trim();
        if (c.required && !v) {
          showError(`${c.label} is required.`);
          c.input.focus();
          return;
        }
        if (v) config[c.key] = v;
      }

      submitBtn.disabled = true;
      cancelBtn.disabled = true;
      submitBtn.textContent = "Installing…";
      try {
        const result = await window.iris.mcp.install({
          slug: server.slug,
          scope: scopeSelect.value || "global",
          secrets,
          config,
        });
        if (result && result.ok === false) {
          showError(safe(result.error, "Install failed."));
          submitBtn.disabled = false;
          cancelBtn.disabled = false;
          submitBtn.textContent = "Install";
          return;
        }
        // Success — close dialog, refresh card state, banner.
        closeDialog();
        await refreshInstalls();
        renderGrid();
        setBanner(`Installed ${safe(server.name, server.slug)} — next agent run will use it.`, "ok");
        setTimeout(() => setBanner(null), 4500);
      } catch (err) {
        showError(err && err.message ? err.message : String(err));
        submitBtn.disabled = false;
        cancelBtn.disabled = false;
        submitBtn.textContent = "Install";
      }
    });
  }

  // ── Kick it off ───────────────────────────────────────
  refresh(false);

  return { close };
}

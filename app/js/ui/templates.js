// ═══════════════════════════════════════════════════════════
// templates.js — Workflow template gallery
// ═══════════════════════════════════════════════════════════

import { h, svgIcon, openModal } from "./util.js";

const TEMPLATES = [
  {
    name: "Code Review",
    icon: "spark",
    desc: "Find bugs, security issues, and code quality problems across the codebase.",
    prompt:
      "Review the current codebase for bugs, security issues, and code quality. " +
      "Start by listing the files, then read the main entry points.",
    model: "opus",
  },
  {
    name: "Refactor for Clarity",
    icon: "zap",
    desc: "Improve readability of the most complex file without changing behavior.",
    prompt:
      "Pick the most complex file in this directory and refactor it for readability " +
      "without changing behavior. Show me the diff before applying.",
  },
  {
    name: "Add Test Coverage",
    icon: "focus",
    desc: "Identify untested paths and write tests for the most critical gaps.",
    prompt:
      "Identify untested code paths in this project. Propose a test plan, then start " +
      "writing tests for the most critical gaps.",
  },
  {
    name: "Bug Hunter",
    icon: "folder",
    desc: "Hunt races, off-by-ones, null derefs, and missing error handling.",
    prompt:
      "Hunt for bugs: race conditions, off-by-one errors, unchecked nulls, missing " +
      "error handling. Start with the recently changed files.",
  },
  {
    name: "Documentation Pass",
    icon: "check",
    desc: "Audit READMEs, stale comments, and undocumented functions.",
    prompt:
      "Audit the documentation. Missing READMEs, stale comments, undocumented " +
      "functions. Propose updates as a checklist.",
    model: "haiku",
  },
  {
    name: "Migration Plan",
    icon: "iris",
    desc: "Propose a phased migration plan with risk levels.",
    prompt:
      "I want to migrate this codebase. Ask me what target I want to migrate to, " +
      "then propose a phased migration plan with risk levels.",
  },
  {
    name: "Performance Profile",
    icon: "copy",
    desc: "Find N+1 queries, sync I/O hot paths, and inefficient data structures.",
    prompt:
      "Analyze this codebase for performance issues: N+1 queries, sync I/O in hot " +
      "paths, inefficient data structures. Propose fixes ordered by impact.",
    model: "opus",
  },
  {
    name: "Onboarding Buddy",
    icon: "settings",
    desc: "Walk through the codebase: architecture, entry points, gotchas.",
    prompt:
      "Pretend you're onboarding a new engineer. Walk me through the codebase: " +
      "architecture, entry points, conventions, gotchas.",
  },
];

export function showTemplatesModal(state) {
  const modal = h("div", { class: "modal tpl-modal" });

  const header = h("div", { class: "modal-header" });
  const closeBtn = h("button", { class: "modal-close", "aria-label": "Close" }, svgIcon("x", 14));
  header.append(h("div", { class: "modal-title" }, "Workflow templates"), closeBtn);

  const body = h("div", { class: "modal-body" });
  const grid = h("div", { class: "tpl-grid" });

  for (const t of TEMPLATES) {
    const card = h("button", { class: "tpl-card", type: "button", title: t.name });
    card.append(
      h("div", { class: "tpl-card-icon" }, svgIcon(t.icon, 18)),
      h("div", { class: "tpl-card-title" }, t.name),
      h("div", { class: "tpl-card-desc" }, t.desc),
      h("span", { class: "tpl-card-use" },
        "Use template ",
        svgIcon("arrowRight", 12),
      ),
    );
    card.addEventListener("click", () => {
      handle.close();
      import("./new-session.js").then((m) => {
        m.showNewSessionModal(state, {
          name: t.name,
          prompt: t.prompt,
          model: t.model,
        });
      });
    });
    grid.append(card);
  }

  body.append(grid);
  modal.append(header, body);

  const handle = openModal(modal);
  closeBtn.addEventListener("click", () => handle.close());
}

export function initTemplates(state) {
  window.addEventListener("iris:show-templates", () => showTemplatesModal(state));
}

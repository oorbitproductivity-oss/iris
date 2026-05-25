// ═══════════════════════════════════════════════════════════
// slash-command-editor.js — Manage user-defined slash commands.
// Add / edit / delete, plus JSON import & export. Built-ins live in
// slash-commands.js and are NEVER edited here.
// ═══════════════════════════════════════════════════════════

import { h, svgIcon, openModal, showToast } from "./util.js";
import { COMMANDS, validateUserCommand, parseImportedCommands } from "./slash-commands.js";

function uid() {
  return "usr_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
}

function getUserCommands(state) {
  const s = state.get().settings || {};
  return Array.isArray(s.slashCommands) ? s.slashCommands : [];
}

export function openSlashCommandEditor(state) {
  const modal = h("div", { class: "modal", style: { width: "min(680px, calc(100vw - 32px))" } });

  const header = h("div", { class: "modal-header" });
  const closeBtn = h("button", { class: "modal-close", "aria-label": "Close" }, svgIcon("x", 14));
  header.append(h("div", { class: "modal-title" }, "Custom slash commands"), closeBtn);

  const body = h("div", { class: "modal-body" });

  // Working copy — mutated as the user adds/edits/deletes; saved on Save.
  let working = getUserCommands(state).map((c) => ({ ...c }));

  const listEl = h("div", { class: "slash-cmd-list" });
  const errEl = h("div", { class: "hint", style: { color: "#ff8080", marginTop: "6px", display: "none" } });

  // Built-in trigger names — used to flag collisions inline so the user knows
  // why their command silently fails to fire.
  const builtinTriggers = new Set(COMMANDS.map((c) => c.name));

  function render() {
    listEl.innerHTML = "";
    if (!working.length) {
      listEl.append(h("div", { class: "hint" }, "No custom commands yet. Click \"Add command\" below."));
    }
    for (const rec of working) {
      const row = h("div", {
        class: "slash-cmd-row",
        style: {
          display: "flex",
          flexDirection: "column",
          gap: "6px",
          padding: "10px",
          marginBottom: "8px",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: "8px",
          background: "rgba(255,255,255,0.02)",
        },
      });

      const headRow = h("div", { style: { display: "flex", gap: "6px", alignItems: "center" } });
      const slashLabel = h("span", { style: { opacity: "0.6", fontFamily: "var(--font-mono)" } }, "/");
      const triggerInput = h("input", {
        class: "input",
        type: "text",
        placeholder: "trigger",
        value: rec.trigger || "",
        style: { flex: "0 0 160px", fontFamily: "var(--font-mono)" },
      });
      triggerInput.addEventListener("input", () => {
        rec.trigger = triggerInput.value.trim();
        showCollision(rec);
      });
      const nameInput = h("input", {
        class: "input",
        type: "text",
        placeholder: "Display name (e.g. Daily standup)",
        value: rec.name || "",
        style: { flex: "1" },
      });
      nameInput.addEventListener("input", () => { rec.name = nameInput.value; });
      const delBtn = h("button", { class: "btn btn-ghost", type: "button", "aria-label": "Delete", title: "Delete" }, svgIcon("trash", 14));
      delBtn.addEventListener("click", () => {
        working = working.filter((x) => x !== rec);
        render();
      });
      headRow.append(slashLabel, triggerInput, nameInput, delBtn);

      const descInput = h("input", {
        class: "input",
        type: "text",
        placeholder: "Short description (shown in the / popover)",
        value: rec.description || "",
      });
      descInput.addEventListener("input", () => { rec.description = descInput.value; });

      const tplTa = h("textarea", {
        class: "textarea",
        rows: "4",
        placeholder: "Template body — supports {{selection}} and {{cursor}}",
      });
      tplTa.value = rec.template || "";
      tplTa.addEventListener("input", () => { rec.template = tplTa.value; });

      const collisionHint = h("div", { class: "hint", style: { display: "none", color: "#ffb060" } });
      row.__collisionHint = collisionHint;

      function showCollision(r) {
        const t = String(r.trigger || "").toLowerCase();
        if (t && builtinTriggers.has(t)) {
          collisionHint.style.display = "block";
          collisionHint.textContent = `"/${t}" is a built-in command and will be ignored.`;
        } else {
          collisionHint.style.display = "none";
        }
      }
      showCollision(rec);

      const tplHint = h("div", { class: "hint" },
        "Use ", h("code", null, "{{selection}}"), " to insert the currently-selected text in the composer, ",
        "and ", h("code", null, "{{cursor}}"), " to place the caret after the template expands.",
      );

      row.append(headRow, descInput, tplTa, collisionHint, tplHint);
      listEl.append(row);
    }
  }

  const addBtn = h("button", { class: "btn btn-ghost", type: "button" });
  addBtn.append(svgIcon("plus", 12), h("span", null, "Add command"));
  addBtn.addEventListener("click", () => {
    working.push({ id: uid(), trigger: "", name: "", description: "", template: "" });
    render();
    // Focus the new trigger input.
    setTimeout(() => {
      const rows = listEl.querySelectorAll(".slash-cmd-row");
      const lastRow = rows[rows.length - 1];
      const firstInput = lastRow && lastRow.querySelector("input");
      if (firstInput) firstInput.focus();
    }, 30);
  });

  // ── Import / Export ─────────────────────────────────────
  const exportBtn = h("button", { class: "btn btn-ghost", type: "button" }, "Export JSON");
  exportBtn.addEventListener("click", () => {
    const payload = JSON.stringify(
      { commands: working.map((c) => ({
        id: c.id,
        trigger: c.trigger,
        name: c.name,
        description: c.description || "",
        template: c.template || "",
      })) },
      null, 2,
    );
    try {
      const blob = new Blob([payload], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "iris-slash-commands.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Free the object URL on next tick.
      setTimeout(() => URL.revokeObjectURL(url), 0);
      showToast(`Exported ${working.length} command${working.length === 1 ? "" : "s"}`);
    } catch (e) {
      showToast("Export failed: " + (e.message || e), { error: true });
    }
  });

  const importInput = h("input", {
    type: "file",
    accept: ".json,application/json",
    style: { display: "none" },
  });
  const importBtn = h("button", { class: "btn btn-ghost", type: "button" }, "Import JSON");
  importBtn.addEventListener("click", () => importInput.click());
  importInput.addEventListener("change", () => {
    const file = importInput.files && importInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const json = JSON.parse(String(reader.result || ""));
        const result = parseImportedCommands(json);
        if (!result.ok) {
          errEl.style.display = "block";
          errEl.textContent = `Import had ${result.errors.length} error(s): ` +
            result.errors.slice(0, 3).map((e) => `[#${e.index + 1}] ${e.error}`).join("; ") +
            (result.errors.length > 3 ? "…" : "");
          showToast("Some entries skipped — see message above.", { error: true });
        } else {
          errEl.style.display = "none";
        }
        const accepted = result.commands || [];
        if (accepted.length === 0) {
          showToast("Nothing to import.", { error: true });
          return;
        }
        // Append to working set, skipping triggers that already exist.
        const existing = new Set(working.map((c) => String(c.trigger || "").toLowerCase()));
        let added = 0;
        for (const c of accepted) {
          if (existing.has(c.trigger.toLowerCase())) continue;
          working.push({ ...c });
          existing.add(c.trigger.toLowerCase());
          added++;
        }
        render();
        showToast(`Imported ${added} command${added === 1 ? "" : "s"}`);
      } catch (e) {
        showToast("Couldn't parse JSON: " + (e.message || e), { error: true });
      } finally {
        // Reset so the same file can be re-picked later.
        importInput.value = "";
      }
    };
    reader.onerror = () => showToast("Read failed", { error: true });
    reader.readAsText(file);
  });

  const toolbar = h("div", { style: { display: "flex", gap: "8px", marginBottom: "10px", flexWrap: "wrap" } });
  toolbar.append(addBtn, h("span", { style: { flex: "1" } }), importBtn, exportBtn, importInput);

  body.append(toolbar, listEl, errEl);

  const footer = h("div", { class: "modal-footer" });
  const cancelBtn = h("button", { class: "btn btn-ghost", type: "button" }, "Cancel");
  const saveBtn = h("button", { class: "btn btn-primary", type: "button" }, "Save");
  footer.append(cancelBtn, saveBtn);

  modal.append(header, body, footer);

  const handle = openModal(modal);
  closeBtn.addEventListener("click", () => handle.close());
  cancelBtn.addEventListener("click", () => handle.close());

  saveBtn.addEventListener("click", async () => {
    // Validate everything before persisting. Drop entries with empty trigger
    // AND empty template silently (user added a blank row, then changed
    // their mind). Otherwise hard-fail with a toast.
    const seen = [];
    const cleaned = [];
    const errors = [];
    for (let i = 0; i < working.length; i++) {
      const rec = working[i];
      const trigger = String(rec.trigger || "").trim();
      const template = String(rec.template || "").trim();
      // Skip totally-blank rows.
      if (!trigger && !template && !String(rec.name || "").trim()) continue;
      const err = validateUserCommand({
        trigger,
        name: rec.name,
        template: rec.template,
      }, { existingTriggers: seen });
      if (err) { errors.push(`Row ${i + 1}: ${err}`); continue; }
      seen.push(trigger);
      cleaned.push({
        id: rec.id || uid(),
        trigger,
        name: String(rec.name || "").trim(),
        description: rec.description ? String(rec.description) : "",
        template: rec.template,
      });
    }
    if (errors.length) {
      errEl.style.display = "block";
      errEl.textContent = errors.join(" · ");
      showToast(`Fix ${errors.length} error${errors.length === 1 ? "" : "s"} above`, { error: true });
      return;
    }
    try {
      await state.actions.saveSettings({ slashCommands: cleaned });
      showToast("Slash commands saved");
      handle.close();
    } catch (e) {
      showToast("Save failed: " + (e.message || e), { error: true });
    }
  });

  render();
}

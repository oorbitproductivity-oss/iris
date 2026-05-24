// ═══════════════════════════════════════════════════════════
// settings.js — Settings modal
// ═══════════════════════════════════════════════════════════

import { h, svgIcon, openModal, showToast } from "./util.js";
import { showRemoteAccessModal } from "./remote-access.js";
import { showTelegramPanel } from "./telegram-panel.js";

const MODELS = [
  { value: "sonnet", label: "Sonnet · balanced, fast" },
  { value: "opus", label: "Opus · maximum reasoning" },
  { value: "haiku", label: "Haiku · light & quick" },
];

const THEMES = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

function formatDate(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

export function showSettingsModal(state) {
  return new Promise((resolve) => {
    const settings = state.get().settings || {};

    const modal = h("div", { class: "modal", style: { width: "min(620px, calc(100vw - 32px))" } });

    // Header
    const header = h("div", { class: "modal-header" });
    header.append(
      h("div", { class: "modal-title" }, "Settings"),
      h("button", { class: "modal-close", "aria-label": "Close" }, svgIcon("x", 14)),
    );

    const body = h("div", { class: "modal-body" });

    // ── Mode ────────────────────────────────────────────
    const modeField = h("div", { class: "field" });
    modeField.append(h("label", { class: "label" }, "Mode"));
    const radioGroup = h("div", { class: "radio-group" });
    let currentMode = settings.mode || "subscription";

    const subRow = h("button", {
      class: `radio-row${currentMode === "subscription" ? " selected" : ""}`,
      type: "button",
    });
    subRow.append(
      h("div", { class: "radio-circle" }),
      h("div", { class: "radio-text" },
        h("div", { class: "radio-title" }, "Subscription Bridge"),
        h("div", { class: "radio-desc" }, "Uses your installed claude CLI and your Pro/Max subscription. No extra cost."),
      ),
    );
    subRow.addEventListener("click", () => {
      currentMode = "subscription";
      subRow.classList.add("selected");
      apiRow.classList.remove("selected");
    });

    const apiRow = h("button", {
      class: `radio-row${currentMode === "apikey" ? " selected" : ""}`,
      type: "button",
    });
    apiRow.append(
      h("div", { class: "radio-circle" }),
      h("div", { class: "radio-text" },
        h("div", { class: "radio-title" }, "API Key"),
        h("div", { class: "radio-desc" }, "Use a saved API key by default (manage keys below)."),
      ),
    );
    apiRow.addEventListener("click", () => {
      currentMode = "apikey";
      apiRow.classList.add("selected");
      subRow.classList.remove("selected");
    });

    radioGroup.append(subRow, apiRow);
    modeField.append(radioGroup);

    // ── Default cwd ─────────────────────────────────────
    const cwdField = h("div", { class: "field" });
    cwdField.append(h("label", { class: "label" }, "Default working directory"));
    const cwdRow = h("div", { class: "field-row" });
    let chosenCwd = settings.defaultCwd || "";
    const cwdDisplay = h("div", { class: `path-display${chosenCwd ? "" : " placeholder"}` },
      chosenCwd || "No default set");
    const browseBtn = h("button", { class: "btn btn-filled", type: "button" });
    browseBtn.append(svgIcon("folder", 14), h("span", null, "Browse"));
    cwdRow.append(cwdDisplay, browseBtn);
    cwdField.append(cwdRow);

    browseBtn.addEventListener("click", async () => {
      try {
        const picked = await state.actions.pickFolder();
        if (picked) {
          chosenCwd = picked;
          cwdDisplay.textContent = picked;
          cwdDisplay.classList.remove("placeholder");
        }
      } catch (e) {
        showToast("Folder picker failed", { error: true });
      }
    });

    // ── Default model ──────────────────────────────────
    const modelField = h("div", { class: "field" });
    modelField.append(h("label", { class: "label" }, "Default model"));
    const modelSelect = h("select", { class: "select" });
    for (const m of MODELS) {
      const opt = h("option", { value: m.value }, m.label);
      if (m.value === (settings.model || "sonnet")) opt.selected = true;
      modelSelect.append(opt);
    }
    modelField.append(modelSelect);

    // ── Iris model ─────────────────────────────────────
    const irisField = h("div", { class: "field" });
    irisField.append(h("label", { class: "label" }, "Iris model"));
    const irisSelect = h("select", { class: "select" });
    for (const m of MODELS) {
      const opt = h("option", { value: m.value }, m.label);
      if (m.value === (settings.irisModel || "sonnet")) opt.selected = true;
      irisSelect.append(opt);
    }
    irisField.append(irisSelect);
    irisField.append(h("div", { class: "hint" },
      "Iris is the orchestrator. Sonnet is usually the right balance; Opus for tricky multi-step planning."));

    // ── API Keys ───────────────────────────────────────
    const keysField = h("div", { class: "field" });
    const keysHeader = h("div", {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: "8px",
      },
    });
    keysHeader.append(
      h("label", { class: "label", style: { margin: "0" } }, "API Keys"),
    );
    const addKeyBtn = h("button", { class: "btn btn-ghost", type: "button" });
    addKeyBtn.append(svgIcon("plus", 12), h("span", null, "Add key"));
    keysHeader.append(addKeyBtn);

    const keysListBox = h("div", {
      style: {
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: "8px",
        padding: "6px",
        background: "rgba(255,255,255,0.02)",
        minHeight: "44px",
      },
    });

    const addKeyForm = h("div", {
      style: {
        display: "none",
        flexDirection: "column",
        gap: "8px",
        padding: "10px",
        marginTop: "8px",
        border: "1px dashed rgba(255,255,255,0.15)",
        borderRadius: "8px",
        background: "rgba(255,255,255,0.03)",
      },
    });
    const addKeyName = h("input", {
      class: "input",
      type: "text",
      placeholder: "Name (e.g. Personal, Work)",
    });
    const addKeyValueRow = h("div", {
      style: { display: "flex", gap: "6px", alignItems: "stretch" },
    });
    const addKeyValue = h("input", {
      class: "input",
      type: "password",
      placeholder: "sk-...",
      style: { flex: "1" },
    });
    const addKeyEye = h("button", {
      class: "btn btn-ghost",
      type: "button",
      "aria-label": "Toggle visibility",
      title: "Show/hide value",
    }, "👁");
    addKeyEye.addEventListener("click", () => {
      addKeyValue.type = addKeyValue.type === "password" ? "text" : "password";
    });
    addKeyValueRow.append(addKeyValue, addKeyEye);
    const addKeyButtons = h("div", { style: { display: "flex", gap: "8px", justifyContent: "flex-end" } });
    const addKeyCancel = h("button", { class: "btn btn-ghost", type: "button" }, "Cancel");
    const addKeySave = h("button", { class: "btn btn-primary", type: "button" }, "Save key");
    addKeyButtons.append(addKeyCancel, addKeySave);
    addKeyForm.append(addKeyName, addKeyValueRow, addKeyButtons);

    function showAddForm(show) {
      addKeyForm.style.display = show ? "flex" : "none";
      if (show) {
        addKeyName.value = "";
        addKeyValue.value = "";
        addKeyValue.type = "password";
        setTimeout(() => addKeyName.focus(), 30);
      }
    }
    addKeyBtn.addEventListener("click", () => showAddForm(addKeyForm.style.display === "none"));
    addKeyCancel.addEventListener("click", () => showAddForm(false));
    addKeySave.addEventListener("click", async () => {
      const name = addKeyName.value.trim();
      const value = addKeyValue.value.trim();
      if (!name || !value) {
        showToast("Name and value required", { error: true });
        return;
      }
      addKeySave.disabled = true;
      try {
        await window.iris.addKey(name, value);
        showAddForm(false);
        await refreshKeys();
        showToast("Key saved");
      } catch (e) {
        showToast("Failed to save key: " + (e.message || e), { error: true });
      } finally {
        addKeySave.disabled = false;
      }
    });

    // Default key dropdown
    const defaultKeyField = h("div", {
      style: {
        marginTop: "10px",
        display: "flex",
        alignItems: "center",
        gap: "10px",
        flexWrap: "wrap",
      },
    });
    defaultKeyField.append(
      h("label", { class: "label", style: { margin: "0", whiteSpace: "nowrap" } }, "Default key for new agents:"),
    );
    const defaultKeySelect = h("select", { class: "select", style: { flex: "1", minWidth: "180px" } });
    defaultKeyField.append(defaultKeySelect);

    let currentDefaultKeyId = settings.defaultApiKeyId || null;
    defaultKeySelect.addEventListener("change", async () => {
      const v = defaultKeySelect.value || null;
      currentDefaultKeyId = v || null;
      try {
        await state.actions.saveSettings({ defaultApiKeyId: currentDefaultKeyId });
      } catch (e) {
        showToast("Failed to save default key", { error: true });
      }
    });

    keysField.append(keysHeader, keysListBox, addKeyForm, defaultKeyField);

    // ── Renaming/delete state ──
    const pendingDeletes = new Map(); // keyId -> timeoutHandle

    function renderKeyRow(key) {
      const row = h("div", {
        style: {
          display: "flex",
          alignItems: "center",
          gap: "10px",
          padding: "8px 10px",
          borderRadius: "6px",
        },
      });
      row.addEventListener("mouseenter", () => { row.style.background = "rgba(255,255,255,0.04)"; });
      row.addEventListener("mouseleave", () => { row.style.background = "transparent"; });

      const swatch = h("div", {
        style: {
          width: "4px",
          height: "26px",
          background: "linear-gradient(180deg, #6aa3ff, #b06aff)",
          borderRadius: "2px",
          flexShrink: "0",
        },
      });

      const nameEl = h("div", {
        style: {
          flex: "1",
          fontWeight: "500",
          fontSize: "0.92rem",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        },
      }, key.name);

      const hintEl = h("div", {
        style: {
          fontFamily: "monospace",
          fontSize: "0.82rem",
          opacity: "0.65",
          minWidth: "80px",
        },
      }, key.hint || "");

      const dateEl = h("div", {
        style: {
          fontSize: "0.78rem",
          opacity: "0.55",
          whiteSpace: "nowrap",
          minWidth: "90px",
          textAlign: "right",
        },
      }, formatDate(key.createdAt));

      const menuBtn = h("button", {
        class: "btn btn-ghost",
        type: "button",
        "aria-label": "More actions",
        style: { padding: "4px 6px" },
      }, svgIcon("more", 14));

      const renameBtn = h("button", {
        class: "btn btn-ghost",
        type: "button",
        "aria-label": "Rename",
        style: { padding: "4px 8px", fontSize: "0.78rem", display: "none" },
      }, "Rename");

      const deleteBtn = h("button", {
        class: "btn btn-ghost",
        type: "button",
        "aria-label": "Delete",
        style: { padding: "4px 8px", fontSize: "0.78rem", display: "none", color: "#ff8080" },
      }, "Delete");

      menuBtn.addEventListener("click", () => {
        const showing = renameBtn.style.display !== "none";
        renameBtn.style.display = showing ? "none" : "inline-flex";
        deleteBtn.style.display = showing ? "none" : "inline-flex";
      });

      renameBtn.addEventListener("click", () => {
        // Swap name display for an input
        const input = h("input", {
          class: "input",
          type: "text",
          value: key.name,
          style: { flex: "1", padding: "4px 6px", fontSize: "0.9rem" },
        });
        nameEl.replaceWith(input);
        input.focus();
        input.select();
        const commit = async () => {
          const newName = input.value.trim();
          if (newName && newName !== key.name) {
            try {
              await window.iris.updateKey(key.id, newName, undefined);
              await refreshKeys();
              showToast("Renamed");
              return;
            } catch (e) {
              showToast("Rename failed", { error: true });
            }
          }
          await refreshKeys();
        };
        input.addEventListener("blur", commit, { once: true });
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); input.blur(); }
          if (e.key === "Escape") { e.preventDefault(); refreshKeys(); }
        });
      });

      deleteBtn.addEventListener("click", async () => {
        if (pendingDeletes.has(key.id)) {
          // Confirmed — perform delete
          clearTimeout(pendingDeletes.get(key.id));
          pendingDeletes.delete(key.id);
          try {
            await window.iris.deleteKey(key.id);
            // If the deleted key was the default, clear it
            if (currentDefaultKeyId === key.id) {
              currentDefaultKeyId = null;
              try { await state.actions.saveSettings({ defaultApiKeyId: null }); } catch {}
            }
            await refreshKeys();
            showToast("Key deleted");
          } catch (e) {
            showToast("Delete failed", { error: true });
          }
        } else {
          // First click — arm with 3s window
          deleteBtn.textContent = "Click to confirm";
          deleteBtn.style.background = "rgba(255,80,80,0.15)";
          const t = setTimeout(() => {
            pendingDeletes.delete(key.id);
            deleteBtn.textContent = "Delete";
            deleteBtn.style.background = "";
          }, 3000);
          pendingDeletes.set(key.id, t);
        }
      });

      row.append(swatch, nameEl, hintEl, dateEl, renameBtn, deleteBtn, menuBtn);
      return row;
    }

    async function refreshKeys() {
      let keys = [];
      try {
        keys = await window.iris.listKeys();
      } catch (e) {
        console.error("[settings] listKeys failed", e);
      }
      keysListBox.innerHTML = "";
      if (!keys || keys.length === 0) {
        const empty = h("div", {
          style: {
            padding: "12px",
            textAlign: "center",
            opacity: "0.55",
            fontSize: "0.88rem",
            fontStyle: "italic",
          },
        }, "No keys saved. Click + Add key.");
        keysListBox.append(empty);
      } else {
        for (const k of keys) {
          keysListBox.append(renderKeyRow(k));
        }
      }
      // Rebuild default-key select
      defaultKeySelect.innerHTML = "";
      const noneOpt = h("option", { value: "" }, "none (use subscription)");
      if (!currentDefaultKeyId) noneOpt.selected = true;
      defaultKeySelect.append(noneOpt);
      for (const k of (keys || [])) {
        const opt = h("option", { value: k.id }, k.name);
        if (k.id === currentDefaultKeyId) opt.selected = true;
        defaultKeySelect.append(opt);
      }
    }

    // Initial population (deferred to next tick)
    setTimeout(refreshKeys, 0);

    // ── Sandbox ────────────────────────────────────────
    const sandboxField = h("div", { class: "field" });
    sandboxField.append(h("label", { class: "label" }, "Sandbox"));
    const sandboxRow = h("label", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: "10px",
        cursor: "pointer",
        padding: "6px 0",
      },
    });
    const sandboxCheck = h("input", { type: "checkbox" });
    sandboxCheck.checked = !!settings.sandboxByDefault;
    sandboxRow.append(
      sandboxCheck,
      h("span", null, "Use sandboxed working directory by default for new agents"),
    );
    sandboxField.append(sandboxRow);
    sandboxField.append(h("div", { class: "hint" },
      "Files are copied into a private dir; Iris exports changes back when you're done."));

    // ── Permission mode ─────────────────────────────────
    const permField = h("div", { class: "field" });
    permField.append(h("label", { class: "label" }, "Shell command approval"));
    const permRow = h("label", {
      style: { display: "flex", alignItems: "center", gap: "10px", cursor: "pointer", padding: "6px 0" },
    });
    const permCheck = h("input", { type: "checkbox" });
    permCheck.checked = settings.permissionMode === "bypassPermissions";
    permRow.append(
      permCheck,
      h("span", null, "Auto-run shell commands without asking (bypass permissions)"),
    );
    permField.append(permRow);
    permField.append(h("div", { class: "hint" },
      "Off (safe): edits auto-approve but Bash commands require approval — which the GUI can't surface, so they fail. " +
      "On: every tool call (including Bash) runs immediately with no prompts. Only enable in trusted workspaces."));

    // ── Spotlight ──────────────────────────────────────
    const spotlightField = h("div", { class: "field" });
    spotlightField.append(h("label", { class: "label" }, "Spotlight"));
    const spotRow = h("div", { class: "field-row" });
    const spotInput = h("input", {
      class: "input",
      type: "text",
      placeholder: "CommandOrControl+Shift+I",
      value: settings.spotlightHotkey || "CommandOrControl+Shift+I",
      style: { flex: "1" },
    });
    spotRow.append(
      h("span", { style: { minWidth: "90px", opacity: "0.8" } }, "Global hotkey:"),
      spotInput,
    );
    spotlightField.append(spotRow);
    spotlightField.append(h("div", { class: "hint" },
      "Electron accelerator format. Default: CommandOrControl+Shift+I"));

    // ── System prompt extras ───────────────────────────
    const extrasField = h("div", { class: "field" });
    extrasField.append(h("label", { class: "label" }, "System prompt extras"));
    const extrasInput = h("textarea", {
      class: "textarea",
      rows: "4",
      placeholder: "Appended to every agent's system prompt. Use for project conventions, style guides, etc.",
    });
    extrasInput.value = settings.systemPromptExtras || "";
    extrasField.append(extrasInput);

    // ── Theme ──────────────────────────────────────────
    const themeField = h("div", { class: "field" });
    themeField.append(h("label", { class: "label" }, "Theme"));
    const themeSelect = h("select", { class: "select" });
    for (const t of THEMES) {
      const opt = h("option", { value: t.value }, t.label);
      if (t.value === (settings.theme || "dark")) opt.selected = true;
      themeSelect.append(opt);
    }
    themeField.append(themeSelect);

    // ── Remote access (mobile companion) ────────────────
    const remoteField = h("div", { class: "field" });
    remoteField.append(h("label", { class: "label" }, "Remote access (mobile)"));
    const remoteBtn = h("button", { class: "btn btn-ghost", type: "button" });
    remoteBtn.append(svgIcon("arrowRight", 14), h("span", { style: { marginLeft: "6px" } }, "Open remote access settings…"));
    remoteBtn.addEventListener("click", () => showRemoteAccessModal());
    remoteField.append(remoteBtn);
    remoteField.append(h("div", { class: "hint" },
      "Let an Iris Mobile app on your phone connect to this PC."));

    // ── Telegram Remote Agent ───────────────────────────
    const telegramField = h("div", { class: "field" });
    telegramField.append(h("label", { class: "label" }, "Telegram Remote Agent"));
    const telegramBtn = h("button", { class: "btn btn-ghost", type: "button" });
    telegramBtn.append(svgIcon("arrowRight", 14), h("span", { style: { marginLeft: "6px" } }, "Open Telegram bridge settings…"));
    telegramBtn.addEventListener("click", () => showTelegramPanel());
    telegramField.append(telegramBtn);
    telegramField.append(h("div", { class: "hint" },
      "DM your personal bot to run agent tasks on this PC from your phone."));

    body.append(
      modeField,
      cwdField,
      modelField,
      irisField,
      keysField,
      sandboxField,
      permField,
      spotlightField,
      extrasField,
      themeField,
      remoteField,
      telegramField,
    );

    // Footer
    const footer = h("div", { class: "modal-footer" });
    const cancelBtn = h("button", { class: "btn btn-ghost", type: "button" }, "Cancel");
    const saveBtn = h("button", { class: "btn btn-primary", type: "button" }, "Save");
    footer.append(cancelBtn, saveBtn);

    modal.append(header, body, footer);

    const { close } = openModal(modal, { onClose: () => resolve(null) });
    header.querySelector(".modal-close").addEventListener("click", () => { close(); resolve(null); });
    cancelBtn.addEventListener("click", () => { close(); resolve(null); });

    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";
      try {
        const patch = {
          mode: currentMode,
          defaultCwd: chosenCwd || null,
          model: modelSelect.value,
          irisModel: irisSelect.value,
          systemPromptExtras: extrasInput.value,
          theme: themeSelect.value,
          sandboxByDefault: !!sandboxCheck.checked,
          permissionMode: permCheck.checked ? "bypassPermissions" : "acceptEdits",
          spotlightHotkey: (spotInput.value || "").trim() || "CommandOrControl+Shift+I",
          defaultApiKeyId: currentDefaultKeyId,
        };
        await state.actions.saveSettings(patch);
        showToast("Settings saved");
        close();
        resolve(patch);
      } catch (e) {
        console.error(e);
        showToast("Failed to save: " + (e.message || e), { error: true });
        saveBtn.disabled = false;
        saveBtn.textContent = "Save";
      }
    });
  });
}

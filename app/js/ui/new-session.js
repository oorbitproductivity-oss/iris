// ═══════════════════════════════════════════════════════════
// new-session.js — Modal for creating a new worker agent
// ═══════════════════════════════════════════════════════════

import { h, svgIcon, openModal, showToast } from "./util.js";

const MODELS = [
  { value: "sonnet", label: "Sonnet · balanced, fast" },
  { value: "opus", label: "Opus · maximum reasoning" },
  { value: "haiku", label: "Haiku · light & quick" },
];

export function showNewSessionModal(state, prefill = {}) {
  return new Promise((resolve) => {
    const settings = state.get().settings || {};
    const defaultCwd = prefill.cwd || settings.defaultCwd || "";
    const recent = Array.isArray(settings.recentFolders) ? settings.recentFolders : [];
    const defaultModel = prefill.model || settings.model || "sonnet";

    const modal = h("div", { class: "modal" });

    // Header
    const header = h("div", { class: "modal-header" });
    header.append(
      h("div", { class: "modal-title" }, "New thread"),
      h("button", { class: "modal-close", "aria-label": "Close" }, svgIcon("x", 14)),
    );

    // Body
    const body = h("div", { class: "modal-body" });

    // Name
    const nameField = h("div", { class: "field" });
    nameField.append(h("label", { class: "label" }, "Name"));
    const nameInput = h("input", {
      class: "input",
      type: "text",
      placeholder: "Untitled thread",
      value: prefill.name || "",
    });
    nameField.append(nameInput);

    // Cwd
    const cwdField = h("div", { class: "field" });
    const cwdLabel = h("label", { class: "label" }, "Working directory");
    cwdField.append(cwdLabel);
    const cwdRow = h("div", { class: "field-row" });
    let chosenCwd = defaultCwd;
    const cwdDisplay = h("div", { class: `path-display${chosenCwd ? "" : " placeholder"}` },
      chosenCwd || "Pick a folder...");
    const browseBtn = h("button", { class: "btn btn-filled", type: "button" });
    browseBtn.append(svgIcon("folder", 14), h("span", null, "Browse"));
    cwdRow.append(cwdDisplay, browseBtn);
    cwdField.append(cwdRow);

    const cwdHint = h("div", {
      class: "hint",
      style: { display: "none", marginTop: "6px" },
    }, "Files from this folder will be copied into a private sandbox. Iris exports changes back when you're done.");
    cwdField.append(cwdHint);

    if (recent.length > 0) {
      const recentRow = h("div", { class: "recent-folders" });
      for (const folder of recent.slice(0, 6)) {
        const chip = h("button", { class: "recent-chip", type: "button", title: folder },
          svgIcon("folder", 11),
          h("span", null, folder),
        );
        chip.addEventListener("click", () => {
          chosenCwd = folder;
          cwdDisplay.textContent = folder;
          cwdDisplay.classList.remove("placeholder");
        });
        recentRow.append(chip);
      }
      cwdField.append(recentRow);
    }

    browseBtn.addEventListener("click", async () => {
      try {
        const picked = await state.actions.pickFolder();
        if (picked) {
          chosenCwd = picked;
          cwdDisplay.textContent = picked;
          cwdDisplay.classList.remove("placeholder");
        }
      } catch (e) {
        console.error(e);
        showToast("Folder picker failed", { error: true });
      }
    });

    // Model
    const modelField = h("div", { class: "field" });
    modelField.append(h("label", { class: "label" }, "Model"));
    const modelSelect = h("select", { class: "select" });
    for (const m of MODELS) {
      const opt = h("option", { value: m.value }, m.label);
      if (m.value === defaultModel) opt.selected = true;
      modelSelect.append(opt);
    }
    modelField.append(modelSelect);

    // ── Auth ────────────────────────────────────────
    const authField = h("div", { class: "field" });
    authField.append(h("label", { class: "label" }, "Auth"));

    let savedKeys = []; // populated async

    const authRadioGroup = h("div", {
      style: { display: "flex", flexDirection: "column", gap: "6px" },
    });

    let authMode = "subscription"; // or "apikey"
    let chosenKeyId = settings.defaultApiKeyId || null;

    const subRadio = h("label", {
      style: { display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", padding: "4px 0" },
    });
    const subInput = h("input", { type: "radio", name: "auth-mode", value: "subscription" });
    subInput.checked = true;
    subRadio.append(subInput, h("span", null, "Use Claude Code subscription"));

    const apiRadio = h("label", {
      style: { display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", padding: "4px 0", flexWrap: "wrap" },
    });
    const apiInput = h("input", { type: "radio", name: "auth-mode", value: "apikey" });
    apiRadio.append(apiInput, h("span", null, "Use API key:"));
    const keySelect = h("select", { class: "select", style: { marginLeft: "8px", minWidth: "180px" } });
    keySelect.disabled = true;
    apiRadio.append(keySelect);

    const addKeyLink = h("button", {
      type: "button",
      class: "btn btn-ghost",
      style: {
        display: "none",
        marginLeft: "8px",
        padding: "2px 8px",
        fontSize: "0.82rem",
      },
    }, "+ Add a key first");
    apiRadio.append(addKeyLink);

    authRadioGroup.append(subRadio, apiRadio);
    authField.append(authRadioGroup);

    // Inline add-key form (shown only when "+ Add a key first" clicked)
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
    const newKeyName = h("input", { class: "input", type: "text", placeholder: "Name (e.g. Personal)" });
    const newKeyValueRow = h("div", { style: { display: "flex", gap: "6px" } });
    const newKeyValue = h("input", { class: "input", type: "password", placeholder: "sk-...", style: { flex: "1" } });
    const newKeyEye = h("button", { class: "btn btn-ghost", type: "button", "aria-label": "Toggle visibility" }, "👁");
    newKeyEye.addEventListener("click", () => {
      newKeyValue.type = newKeyValue.type === "password" ? "text" : "password";
    });
    newKeyValueRow.append(newKeyValue, newKeyEye);
    const newKeyButtons = h("div", { style: { display: "flex", gap: "8px", justifyContent: "flex-end" } });
    const newKeyCancel = h("button", { class: "btn btn-ghost", type: "button" }, "Cancel");
    const newKeySave = h("button", { class: "btn btn-primary", type: "button" }, "Save key");
    newKeyButtons.append(newKeyCancel, newKeySave);
    addKeyForm.append(newKeyName, newKeyValueRow, newKeyButtons);
    authField.append(addKeyForm);

    function setAuthMode(mode) {
      authMode = mode;
      subInput.checked = mode === "subscription";
      apiInput.checked = mode === "apikey";
      keySelect.disabled = mode !== "apikey" || savedKeys.length === 0;
      // Show "+ Add a key first" if apikey selected with zero keys
      addKeyLink.style.display = (mode === "apikey" && savedKeys.length === 0) ? "inline-flex" : "none";
    }

    subInput.addEventListener("change", () => setAuthMode("subscription"));
    apiInput.addEventListener("change", () => setAuthMode("apikey"));
    subRadio.addEventListener("click", (e) => {
      if (e.target !== subInput) { subInput.checked = true; setAuthMode("subscription"); }
    });
    apiRadio.addEventListener("click", (e) => {
      // Don't hijack clicks on the select / link
      if (e.target === keySelect || e.target === addKeyLink) return;
      if (e.target !== apiInput) { apiInput.checked = true; setAuthMode("apikey"); }
    });

    keySelect.addEventListener("change", () => {
      chosenKeyId = keySelect.value || null;
    });

    addKeyLink.addEventListener("click", () => {
      const showing = addKeyForm.style.display !== "none";
      addKeyForm.style.display = showing ? "none" : "flex";
      if (!showing) setTimeout(() => newKeyName.focus(), 30);
    });
    newKeyCancel.addEventListener("click", () => { addKeyForm.style.display = "none"; });
    newKeySave.addEventListener("click", async () => {
      const name = newKeyName.value.trim();
      const value = newKeyValue.value.trim();
      if (!name || !value) {
        showToast("Name and value required", { error: true });
        return;
      }
      newKeySave.disabled = true;
      try {
        const created = await window.iris.addKey(name, value);
        addKeyForm.style.display = "none";
        newKeyName.value = "";
        newKeyValue.value = "";
        await refreshKeys();
        if (created && created.id) {
          chosenKeyId = created.id;
          keySelect.value = created.id;
        }
        setAuthMode("apikey");
        showToast("Key saved");
      } catch (e) {
        showToast("Failed to save key: " + (e.message || e), { error: true });
      } finally {
        newKeySave.disabled = false;
      }
    });

    async function refreshKeys() {
      try {
        savedKeys = await window.iris.listKeys();
      } catch {
        savedKeys = [];
      }
      keySelect.innerHTML = "";
      if (!savedKeys || savedKeys.length === 0) {
        const opt = h("option", { value: "" }, "(no saved keys)");
        keySelect.append(opt);
      } else {
        for (const k of savedKeys) {
          const opt = h("option", { value: k.id }, `${k.name} · ${k.hint || ""}`);
          if (k.id === chosenKeyId) opt.selected = true;
          keySelect.append(opt);
        }
        // If chosenKeyId wasn't in the list, pick first
        if (!savedKeys.find((k) => k.id === chosenKeyId)) {
          chosenKeyId = savedKeys[0].id;
          keySelect.value = chosenKeyId;
        }
      }
      // Re-evaluate disabled state / "+ Add a key first" visibility
      setAuthMode(authMode);
    }

    // Initial: choose default radio based on settings & keys
    (async () => {
      await refreshKeys();
      if (savedKeys.length > 0 && settings.defaultApiKeyId &&
          savedKeys.find((k) => k.id === settings.defaultApiKeyId)) {
        chosenKeyId = settings.defaultApiKeyId;
        keySelect.value = chosenKeyId;
        setAuthMode("apikey");
      } else {
        setAuthMode("subscription");
      }
    })();

    // Initial prompt
    const promptField = h("div", { class: "field" });
    promptField.append(h("label", { class: "label" }, "Initial prompt (optional)"));
    const promptInput = h("textarea", {
      class: "textarea",
      rows: "4",
      placeholder: "Describe what this agent should do first...",
    });
    if (prefill.prompt) promptInput.value = prefill.prompt;
    promptField.append(promptInput);

    // ── Sandbox ─────────────────────────────────────
    const sandboxField = h("div", { class: "field" });
    sandboxField.append(h("label", { class: "label" }, "Sandbox mode"));
    const sandboxRow = h("div", {
      style: { display: "flex", gap: "16px", alignItems: "center" },
    });
    let sandboxOn = !!settings.sandboxByDefault;

    const sbOnLabel = h("label", {
      style: { display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" },
    });
    const sbOnInput = h("input", { type: "radio", name: "sandbox-mode", value: "on" });
    sbOnLabel.append(sbOnInput, h("span", null, "On"));

    const sbOffLabel = h("label", {
      style: { display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" },
    });
    const sbOffInput = h("input", { type: "radio", name: "sandbox-mode", value: "off" });
    sbOffLabel.append(sbOffInput, h("span", null, "Off"));

    sbOnInput.checked = sandboxOn;
    sbOffInput.checked = !sandboxOn;

    sandboxRow.append(sbOnLabel, sbOffLabel);
    sandboxField.append(sandboxRow);

    function applySandboxUI() {
      if (sandboxOn) {
        cwdLabel.textContent = "Source folder (optional)";
        cwdHint.style.display = "block";
        if (!chosenCwd) {
          cwdDisplay.textContent = "Pick a folder or leave empty for blank sandbox";
        }
      } else {
        cwdLabel.textContent = "Working directory";
        cwdHint.style.display = "none";
        if (!chosenCwd) {
          cwdDisplay.textContent = "Pick a folder...";
        }
      }
    }
    sbOnInput.addEventListener("change", () => { sandboxOn = true; applySandboxUI(); });
    sbOffInput.addEventListener("change", () => { sandboxOn = false; applySandboxUI(); });
    applySandboxUI();

    body.append(nameField, cwdField, modelField, authField, promptField, sandboxField);

    // Footer
    const footer = h("div", { class: "modal-footer" });
    const cancelBtn = h("button", { class: "btn btn-ghost", type: "button" }, "Cancel");
    const createBtn = h("button", { class: "btn btn-primary", type: "button" });
    createBtn.append(h("span", null, "Create session"), svgIcon("arrowRight", 14));
    footer.append(cancelBtn, createBtn);

    modal.append(header, body, footer);

    const { close } = openModal(modal, {
      onClose: () => resolve(null),
    });

    header.querySelector(".modal-close").addEventListener("click", () => { close(); resolve(null); });
    cancelBtn.addEventListener("click", () => { close(); resolve(null); });

    async function submit() {
      const name = nameInput.value.trim() || "Untitled session";
      // Sandbox-off requires a working dir; sandbox-on does not.
      if (!sandboxOn && !chosenCwd) {
        cwdDisplay.classList.add("placeholder");
        cwdDisplay.textContent = "Pick a folder first";
        cwdDisplay.animate(
          [{ transform: "translateX(-2px)" }, { transform: "translateX(2px)" }, { transform: "translateX(0)" }],
          { duration: 180, iterations: 2 },
        );
        return;
      }
      createBtn.disabled = true;
      createBtn.textContent = "Creating…";
      try {
        const apiKeyId = authMode === "apikey" ? (chosenKeyId || null) : null;
        const opts = {
          name,
          cwd: chosenCwd || undefined,
          initialPrompt: promptInput.value.trim() || undefined,
          model: modelSelect.value,
          apiKeyId,
          sandbox: !!sandboxOn,
        };
        // state.actions.createAgent in the current state.js only destructures
        // { name, cwd, initialPrompt, model } and would drop apiKeyId/sandbox.
        // Call window.iris.createAgent directly to pass them through, then
        // select the agent via state.actions for the optimistic UI swap.
        const agent = await window.iris.createAgent(opts);
        if (state.actions.selectAgent && agent && agent.id) {
          try { await state.actions.selectAgent(agent.id); } catch {}
        }
        close();
        resolve(agent);
      } catch (e) {
        console.error(e);
        showToast("Failed to create session: " + (e.message || e), { error: true });
        createBtn.disabled = false;
        createBtn.innerHTML = "";
        createBtn.append(h("span", null, "Create session"), svgIcon("arrowRight", 14));
      }
    }

    createBtn.addEventListener("click", submit);
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
    });

    // Auto-focus name input
    setTimeout(() => nameInput.focus(), 60);
  });
}

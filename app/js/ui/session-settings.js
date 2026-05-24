// session-settings.js -- Edit an existing thread (name, model, cwd, API key).
//
// Opened from the chat-view header settings cog.

import { h, svgIcon, openModal, showToast } from "./util.js";

const MODELS = [
  { id: "sonnet", label: "Sonnet · balanced" },
  { id: "opus", label: "Opus · maximum reasoning" },
  { id: "haiku", label: "Haiku · light & quick" },
];

export async function showSessionSettingsModal(state, agentId) {
  const agent = state.get().agents.find((a) => a.id === agentId);
  if (!agent) return;
  if (agent.role === "iris") {
    showToast?.("Iris settings live in the main Settings panel.");
    return;
  }

  const keys = (await window.iris?.listKeys?.()) || [];

  const card = h("div", { class: "modal", style: { width: "min(520px, calc(100vw - 32px))" } });

  // Header
  const header = h("div", { class: "modal-header" });
  const closeBtn = h("button", { class: "modal-close", "aria-label": "Close" }, svgIcon("x", 14));
  header.append(
    h("div", null,
      h("div", { class: "modal-title" }, "Thread settings"),
      h("div", { style: { fontSize: "var(--text-xs)", color: "var(--text-3)", marginTop: "2px" } }, agent.name || "Untitled"),
    ),
    closeBtn,
  );
  card.append(header);

  const body = h("div", { class: "modal-body" });

  // Name
  const nameField = h("div", { class: "field" });
  nameField.append(h("label", { class: "label" }, "Name"));
  const nameInput = h("input", {
    class: "input",
    type: "text",
    value: agent.name || "",
    spellcheck: "false",
  });
  nameField.append(nameInput);
  body.append(nameField);

  // Model
  const modelField = h("div", { class: "field" });
  modelField.append(h("label", { class: "label" }, "Model"));
  const modelSelect = h("select", { class: "select" });
  for (const m of MODELS) {
    const opt = h("option", { value: m.id }, m.label);
    if (m.id === agent.model) opt.setAttribute("selected", "");
    modelSelect.append(opt);
  }
  modelField.append(modelSelect);
  body.append(modelField);

  // Working directory
  const cwdField = h("div", { class: "field" });
  let cwdInput; // used by save handler below
  if (agent.sandbox) {
    cwdField.append(h("label", { class: "label" }, "Workspace"));
    const sbRow = h("div", { class: "field-row" });
    const tag = h("span", { class: "pill" }, h("span", null, "Sandbox"));
    const openBtn = h("button", { class: "btn btn-ghost", type: "button" }, "Open folder");
    openBtn.addEventListener("click", () => {
      if (agent.cwd) window.iris?.openPath?.(agent.cwd);
    });
    sbRow.append(tag, openBtn);
    if (agent.sourceDir) {
      const exportBtn = h("button", { class: "btn btn-ghost", type: "button" }, "Reveal source");
      exportBtn.addEventListener("click", () => {
        window.iris?.openPath?.(agent.sourceDir);
      });
      sbRow.append(exportBtn);
    }
    cwdField.append(sbRow);
    cwdField.append(h("div", { class: "hint" },
      "Isolated workspace for this thread. Click “Open folder” to see the files."
    ));
  } else {
    cwdField.append(h("label", { class: "label" }, "Working directory"));
    const cwdRow = h("div", { class: "field-row" });
    cwdInput = h("input", {
      class: "input",
      type: "text",
      value: agent.cwd || "",
      spellcheck: "false",
    });
    cwdRow.append(cwdInput);
    const browse = h("button", { class: "btn btn-ghost", type: "button" }, "Browse");
    browse.addEventListener("click", async () => {
      const f = await window.iris?.pickFolder?.();
      if (f) cwdInput.value = f;
    });
    cwdRow.append(browse);
    cwdField.append(cwdRow);
    cwdField.append(h("div", { class: "hint" }, "Takes effect on the next message."));
  }
  body.append(cwdField);

  // Auth (subscription or named API key)
  const keyField = h("div", { class: "field" });
  keyField.append(h("label", { class: "label" }, "Auth"));
  const keySelect = h("select", { class: "select" });
  const subOpt = h("option", { value: "" }, "Subscription (Claude Code default)");
  if (!agent.apiKeyId) subOpt.setAttribute("selected", "");
  keySelect.append(subOpt);
  for (const k of keys) {
    const o = h("option", { value: k.id }, `Key — ${k.name}${k.hint ? ` (${k.hint})` : ""}`);
    if (agent.apiKeyId === k.id) o.setAttribute("selected", "");
    keySelect.append(o);
  }
  keyField.append(keySelect);
  keyField.append(h("div", { class: "hint" }, "Subscription uses your OAuth login. Keys swap in the Anthropic API instead. Either way the same Claude Code harness runs your thread."));
  body.append(keyField);

  // Status (read-only)
  const statusField = h("div", { class: "field" });
  statusField.append(h("label", { class: "label" }, "Status"));
  const statusRow = h("div", { style: { display: "flex", alignItems: "center", gap: "10px" } });
  const pill = h("span", { class: `pill ${agent.status || "idle"}` },
    h("span", { class: "dot" }),
    h("span", null, agent.status || "idle"),
  );
  const sessHint = h("span", {
    style: { fontSize: "var(--text-xs)", color: "var(--text-3)", fontFamily: "var(--font-mono)" },
  }, agent.sessionId ? `session: ${String(agent.sessionId).slice(0, 8)}…` : "no session id yet");
  statusRow.append(pill, sessHint);
  statusField.append(statusRow);
  body.append(statusField);

  card.append(body);

  // Footer
  const footer = h("div", { class: "modal-footer" });
  const dangerLeft = h("div", { style: { marginRight: "auto" } });
  const deleteBtn = h("button", { class: "btn btn-danger", type: "button" });
  deleteBtn.append(svgIcon("trash", 14), h("span", null, "Delete thread"));
  let armed = false;
  let armTimer = null;
  deleteBtn.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      deleteBtn.innerHTML = "";
      deleteBtn.append(h("span", null, "Click again to confirm"));
      armTimer = setTimeout(() => {
        armed = false;
        deleteBtn.innerHTML = "";
        deleteBtn.append(svgIcon("trash", 14), h("span", null, "Delete thread"));
      }, 3000);
      return;
    }
    clearTimeout(armTimer);
    await state.actions.deleteAgent(agent.id);
    close();
  });
  dangerLeft.append(deleteBtn);
  footer.append(dangerLeft);

  const cancel = h("button", { class: "btn btn-ghost", type: "button" }, "Cancel");
  const save = h("button", { class: "btn btn-primary", type: "button" }, "Save");
  footer.append(cancel, save);
  card.append(footer);

  let close;
  await new Promise((resolve) => {
    const handle = openModal(card, { onClose: resolve });
    close = handle.close;
    closeBtn.addEventListener("click", () => close());
    cancel.addEventListener("click", () => close());
    save.addEventListener("click", async () => {
      const patch = {
        name: nameInput.value.trim() || agent.name,
        model: modelSelect.value || agent.model,
        cwd: agent.sandbox ? agent.cwd : ((cwdInput && cwdInput.value.trim()) || agent.cwd),
        apiKeyId: keySelect.value || null,
      };
      const updated = await state.actions.updateAgent(agent.id, patch);
      if (updated) showToast?.(`Saved “${updated.name}”`);
      close();
    });
  });
}

// app/js/ui/screenshot-modal.js
// Pops when the screenshot hotkey fires. Shows a preview of the capture and a
// short prompt textarea. On submit, the screenshot is sent to the currently
// active agent — Iris if no worker is selected — as a file-path reference the
// agent's Read tool can pick up.

import { h, openModal, showToast } from "./util.js";

export function openScreenshotModal({ filepath, dataUrl }) {
  if (!filepath) {
    showToast("Screenshot captured but no file path was returned", { error: true });
    return;
  }

  // Resolve the active agent via the global state singleton (set in app.js).
  // Guard every step in case state isn't ready yet.
  let activeId = "iris";
  let agentName = "Iris";
  try {
    const store = (typeof window !== "undefined" && window.__iris_state) || null;
    const s = store && typeof store.get === "function" ? store.get() : null;
    if (s) {
      activeId = s.activeId || "iris";
      const agents = Array.isArray(s.agents) ? s.agents : [];
      const agent = agents.find((a) => a && a.id === activeId);
      if (agent && agent.name) agentName = agent.name;
    }
  } catch (err) {
    console.warn("[screenshot-modal] state read failed", err);
  }

  const root = h("div", { class: "modal screenshot-modal" });

  // Header
  const header = h("div", { class: "modal-header" });
  const title = h("h3", { class: "screenshot-title" });
  title.append(
    document.createTextNode("Send screenshot to "),
    h("span", { class: "screenshot-target" }, agentName),
  );
  header.append(
    title,
    h("div", { class: "screenshot-path", title: filepath }, filepath),
  );

  // Preview (or fallback if dataUrl is empty/broken)
  const preview = h("div", { class: "screenshot-preview" });
  if (dataUrl && dataUrl.startsWith("data:image/") && dataUrl.length > 64) {
    const img = h("img", { src: dataUrl, alt: "Screenshot preview" });
    img.addEventListener("error", () => {
      preview.innerHTML = "";
      preview.append(h("div", { class: "screenshot-fallback" },
        "Preview unavailable — image saved to disk at the path above.",
      ));
    });
    preview.append(img);
  } else {
    preview.append(h("div", { class: "screenshot-fallback" },
      "Preview unavailable — image saved to disk at the path above.",
    ));
  }

  // Prompt
  const textarea = h("textarea", {
    class: "screenshot-prompt",
    placeholder: "What should I do with this? (Enter to send, Shift+Enter for newline)",
    rows: 3,
  });

  // Actions
  const actions = h("div", { class: "modal-actions" });
  const cancelBtn = h("button", { class: "btn btn-ghost", type: "button" }, "Cancel");
  const sendBtn = h("button", { class: "btn btn-primary", type: "button" }, "Send");
  actions.append(cancelBtn, sendBtn);

  root.append(header, preview, textarea, actions);

  const { close } = openModal(root);

  function submit() {
    const userPrompt = textarea.value.trim();
    const composed = [
      `I just captured a screenshot. It's saved at: ${filepath}`,
      "Use your Read tool on that path to view the image.",
      userPrompt ? `\nMy question / task:\n${userPrompt}` : "",
    ].join("\n").trim();
    try {
      if (activeId === "iris") {
        window.iris.sendToIris(composed);
      } else {
        window.iris.sendToAgent(activeId, composed);
      }
      showToast(`Screenshot sent to ${agentName}`);
      close();
    } catch (err) {
      console.error("[screenshot-modal] send failed", err);
      showToast("Failed to send screenshot: " + (err.message || err), { error: true });
    }
  }

  cancelBtn.addEventListener("click", () => close());
  sendBtn.addEventListener("click", submit);
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  setTimeout(() => textarea.focus(), 60);
}

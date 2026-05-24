// ═══════════════════════════════════════════════════════════
// telegram-panel.js — "Telegram Remote Agent" settings panel
// ═══════════════════════════════════════════════════════════
//
// Lets the user paste a bot token (encrypted at rest via Electron
// safeStorage in the main process), toggle the bridge on/off, run a 6-digit
// pairing flow with their phone, and send a test message. Mirrors the layout
// of remote-access.js so the two "remote control" panels feel like siblings.

import { h, svgIcon, openModal, showToast } from "./util.js";

export function showTelegramPanel() {
  return new Promise((resolve) => {
    const modal = h("div", { class: "modal", style: { width: "min(580px, calc(100vw - 32px))" } });

    const header = h("div", { class: "modal-header" });
    header.append(
      h("div", { class: "modal-title" }, "Telegram Remote Agent"),
      h("button", { class: "modal-close", "aria-label": "Close" }, svgIcon("x", 14)),
    );

    const body = h("div", { class: "modal-body" });

    // ── Intro / how-to ──────────────────────────────────
    const intro = h("div", { class: "field" });
    intro.append(
      h("div", { class: "hint", style: { lineHeight: "1.55" } },
        "DM your personal bot from anywhere — every message runs as a Claude Code task on this desktop, and the bot replies with progress and results. Iris must be running.",
      ),
      h("ol", { style: { paddingLeft: "20px", marginTop: "8px", lineHeight: "1.55", fontSize: "0.92rem" } },
        h("li", null, "Message ",
          h("a", { href: "https://t.me/BotFather", "data-external": "1" }, "@BotFather"),
          " → ", h("code", null, "/newbot"), " → name it → copy the token."),
        h("li", null, "Paste the token below and click ", h("strong", null, "Save token"), "."),
        h("li", null, "Click ", h("strong", null, "Pair my phone"), " → open your bot in Telegram and send the 6-digit code shown."),
        h("li", null, "Done. Any message = new task. ",
          h("code", null, "/new"), " resets context. ", h("code", null, "/stop"), " cancels."),
      ),
    );
    // Externalize anchor clicks so they open in the user's real browser.
    intro.querySelectorAll('a[data-external="1"]').forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        window.iris?.openExternal?.(a.getAttribute("href"));
      });
    });

    // ── Token ───────────────────────────────────────────
    const tokenField = h("div", { class: "field" });
    tokenField.append(h("label", { class: "label" }, "Bot token"));
    const tokenRow = h("div", { class: "field-row" });
    const tokenInput = h("input", {
      class: "input",
      type: "password",
      placeholder: "12345:ABC-DEF…  (from @BotFather)",
      style: { flex: "1", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.85rem" },
      autocomplete: "off",
      spellcheck: "false",
    });
    const eyeBtn = h("button", { class: "btn btn-ghost", type: "button", title: "Show / hide" }, "👁");
    tokenRow.append(tokenInput, eyeBtn);
    tokenField.append(tokenRow);

    const tokenActions = h("div", { style: { display: "flex", gap: "8px", marginTop: "8px", flexWrap: "wrap" } });
    const saveTokenBtn = h("button", { class: "btn btn-primary", type: "button" }, "Save token");
    const clearTokenBtn = h("button", { class: "btn btn-ghost", type: "button" }, "Clear token");
    tokenActions.append(saveTokenBtn, clearTokenBtn);
    tokenField.append(tokenActions);
    tokenField.append(h("div", { class: "hint" },
      "The token is encrypted at rest with your OS keychain (Electron safeStorage). Iris never sends it anywhere except Telegram's API."));

    // ── Connection state ────────────────────────────────
    const stateField = h("div", { class: "field" });
    stateField.append(h("label", { class: "label" }, "Bridge"));
    const enableRow = h("label", {
      style: { display: "flex", alignItems: "center", gap: "10px", cursor: "pointer", padding: "6px 0" },
    });
    const enableCheck = h("input", { type: "checkbox" });
    enableRow.append(enableCheck, h("span", null, "Run the Telegram bridge"));
    stateField.append(enableRow);

    const statusLine = h("div", { class: "hint", style: { marginTop: "4px" } }, "—");
    stateField.append(statusLine);

    // ── Pairing ─────────────────────────────────────────
    const pairField = h("div", { class: "field" });
    pairField.append(h("label", { class: "label" }, "Phone pairing"));
    const pairRow = h("div", {
      style: { display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" },
    });
    const pairBtn = h("button", { class: "btn btn-filled", type: "button" }, "Pair my phone");
    const cancelPairBtn = h("button", { class: "btn btn-ghost", type: "button", style: { display: "none" } }, "Cancel pairing");
    pairRow.append(pairBtn, cancelPairBtn);
    pairField.append(pairRow);

    const codeBox = h("div", {
      style: {
        display: "none",
        marginTop: "10px",
        padding: "16px 18px",
        background: "var(--bg-elev-1, rgba(255,255,255,0.04))",
        border: "1px dashed var(--border, rgba(255,255,255,0.15))",
        borderRadius: "10px",
        textAlign: "center",
      },
    });
    const codeText = h("div", {
      style: {
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: "1.8rem",
        letterSpacing: "0.4em",
        fontWeight: "600",
      },
    }, "------");
    const codeHint = h("div", { class: "hint", style: { marginTop: "8px" } },
      "Open your bot in Telegram and send this code as a message.");
    codeBox.append(codeText, codeHint);
    pairField.append(codeBox);

    const pairedLine = h("div", { class: "hint", style: { marginTop: "6px", display: "none" } }, "");
    pairField.append(pairedLine);

    // ── Workspace folder ────────────────────────────────
    // Default behavior: each /new spawns a sandboxed worker that can only
    // touch a Telegram-owned dir under the Iris data folder. That's safe
    // (a stolen phone session can't nuke real files) but limits what the
    // user can do from their phone. Picking a folder here turns the
    // sandbox OFF for new sessions and points them at the chosen folder
    // instead — so the user can ask the agent to edit their real project
    // files from anywhere.
    const cwdField = h("div", { class: "field" });
    cwdField.append(h("label", { class: "label" }, "Worker workspace"));
    const cwdRow = h("div", { class: "field-row" });
    const cwdInput = h("input", {
      class: "input",
      type: "text",
      placeholder: "(default — sandboxed dir, agent can't touch your real files)",
      style: { flex: "1", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.85rem" },
      autocomplete: "off",
      spellcheck: "false",
      readOnly: true,
    });
    const pickFolderBtn = h("button", { class: "btn btn-ghost", type: "button" }, "Pick folder…");
    const clearCwdBtn = h("button", { class: "btn btn-ghost", type: "button" }, "Use sandbox");
    cwdRow.append(cwdInput, pickFolderBtn, clearCwdBtn);
    cwdField.append(cwdRow);
    cwdField.append(h("div", { class: "hint" },
      "When set, new Telegram-spawned sessions run UNSANDBOXED in this folder — the agent gets real write access. ",
      "Leave blank for the safe default (sandboxed dir per session)."));

    // ── Chat mode (worker vs Iris orchestrator) ────────
    const modeField = h("div", { class: "field" });
    modeField.append(h("label", { class: "label" }, "Inbound chat mode"));
    const modeRow = h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } });
    const workerModeBtn = h("button", { class: "btn btn-ghost", type: "button" }, "Worker (default)");
    const irisModeBtn = h("button", { class: "btn btn-ghost", type: "button" }, "Iris orchestrator");
    modeRow.append(workerModeBtn, irisModeBtn);
    modeField.append(modeRow);
    modeField.append(h("div", { class: "hint" },
      "Worker mode: each message spawns / continues a sandboxed Claude Code task. ",
      "Iris mode: messages go to your always-on Iris orchestrator (same one as the desktop sidebar). ",
      "You can also flip in-chat with /iris and /worker."));

    // ── Test message ────────────────────────────────────
    const testField = h("div", { class: "field" });
    const testBtn = h("button", { class: "btn btn-ghost", type: "button" }, "Send test message");
    testField.append(testBtn);
    testField.append(h("div", { class: "hint" }, "Sends a small ping to confirm the bot can reach your paired phone."));

    body.append(intro, tokenField, stateField, pairField, cwdField, modeField, testField);

    const footer = h("div", { class: "modal-footer" });
    const doneBtn = h("button", { class: "btn btn-primary", type: "button" }, "Done");
    footer.append(doneBtn);

    modal.append(header, body, footer);

    let status = null;
    let busy = false;
    let pairTimer = null;

    function describeConnection(s) {
      if (!s.hasToken) return ["No token saved", ""];
      if (!s.enabled) return ["Disabled", ""];
      switch (s.connection) {
        case "online":     return [`Online — connected as @${s.botUsername || "(bot)"}`, "var(--accent, #6bd968)"];
        case "connecting": return ["Connecting…", "var(--warn, #e0a040)"];
        case "error":      return [`Error: ${s.lastError || "unknown"}`, "var(--danger, #ff7070)"];
        default:           return ["Idle", ""];
      }
    }

    async function refresh() {
      try { status = await window.iris.getTelegramStatus(); }
      catch (e) { showToast("Failed to load Telegram status", { error: true }); return; }
      render();
    }

    function render() {
      if (!status) return;
      enableCheck.checked = !!status.enabled;
      enableCheck.disabled = busy || !status.hasToken;

      // Token row
      tokenInput.placeholder = status.hasToken
        ? "•••••••••••••••  (saved — paste again to replace)"
        : "12345:ABC-DEF…  (from @BotFather)";
      clearTokenBtn.disabled = busy || !status.hasToken;
      saveTokenBtn.disabled = busy;

      const [statusText, statusColor] = describeConnection(status);
      statusLine.textContent = statusText;
      statusLine.style.color = statusColor;

      // Pairing block
      if (status.pairing) {
        codeBox.style.display = "block";
        codeText.textContent = status.pairing.code;
        pairBtn.style.display = "none";
        cancelPairBtn.style.display = "inline-flex";
        startPairCountdown(status.pairing.expiresAt);
      } else {
        codeBox.style.display = "none";
        pairBtn.style.display = "inline-flex";
        cancelPairBtn.style.display = "none";
        stopPairCountdown();
      }
      pairBtn.disabled = busy || !status.hasToken;

      if (status.paired) {
        pairedLine.style.display = "block";
        pairedLine.textContent = "Paired ✔  (chat id: " + status.allowedChatId + ")";
        pairBtn.textContent = "Re-pair phone";
      } else {
        pairedLine.style.display = "none";
        pairBtn.textContent = "Pair my phone";
      }

      testBtn.disabled = busy || !status.paired || !status.hasToken || !status.enabled;

      // Workspace folder display.
      cwdInput.value = status.defaultCwd || "";
      cwdInput.placeholder = status.defaultCwd
        ? status.defaultCwd
        : "(default — sandboxed dir, agent can't touch your real files)";
      pickFolderBtn.disabled = busy;
      clearCwdBtn.disabled = busy || !status.defaultCwd;

      // Mode buttons — highlight the active one. We don't have a primary
      // variant for "toggle pill" so we swap the base class on each render.
      const isIris = status.chatMode === "iris";
      workerModeBtn.className = "btn " + (isIris ? "btn-ghost" : "btn-filled");
      irisModeBtn.className   = "btn " + (isIris ? "btn-filled" : "btn-ghost");
      workerModeBtn.disabled = busy;
      irisModeBtn.disabled = busy;
    }

    function startPairCountdown(expiresAt) {
      stopPairCountdown();
      const update = () => {
        const remain = Math.max(0, expiresAt - Date.now());
        const mins = Math.floor(remain / 60000);
        const secs = Math.floor((remain % 60000) / 1000);
        codeHint.textContent =
          remain === 0
            ? "Code expired — click Cancel and try again."
            : `Open your bot in Telegram and send this code. Expires in ${mins}:${String(secs).padStart(2, "0")}.`;
        if (remain === 0) stopPairCountdown();
      };
      update();
      pairTimer = setInterval(update, 1000);
    }
    function stopPairCountdown() {
      if (pairTimer) { clearInterval(pairTimer); pairTimer = null; }
    }

    // ── Event wiring ─────────────────────────────────────
    eyeBtn.addEventListener("click", () => {
      tokenInput.type = tokenInput.type === "password" ? "text" : "password";
    });

    saveTokenBtn.addEventListener("click", async () => {
      const v = tokenInput.value.trim();
      if (!v) { showToast("Paste a token first", { error: true }); return; }
      busy = true; saveTokenBtn.textContent = "Verifying…"; render();
      try {
        const r = await window.iris.setTelegramToken(v);
        if (r && r.ok) {
          showToast("Token saved");
          tokenInput.value = "";
          status = r.status || status;
        } else {
          showToast(r?.error || "Failed to save token", { error: true });
        }
      } catch (e) {
        showToast("Failed: " + (e.message || e), { error: true });
      } finally {
        busy = false; saveTokenBtn.textContent = "Save token";
        await refresh();
      }
    });

    clearTokenBtn.addEventListener("click", async () => {
      if (!confirm("Remove the saved token? The bridge will stop and your phone will need re-pairing.")) return;
      busy = true; render();
      try {
        const r = await window.iris.clearTelegramToken();
        showToast("Token cleared");
        if (r && r.status) status = r.status;
      } catch (e) {
        showToast("Failed: " + (e.message || e), { error: true });
      } finally { busy = false; await refresh(); }
    });

    enableCheck.addEventListener("change", async () => {
      if (busy) { enableCheck.checked = !enableCheck.checked; return; }
      busy = true; render();
      try {
        const r = await window.iris.setTelegramEnabled(enableCheck.checked);
        if (r && r.ok) {
          showToast(enableCheck.checked ? "Bridge started" : "Bridge stopped");
          if (r.status) status = r.status;
        } else {
          showToast(r?.error || "Failed", { error: true });
          await refresh();
        }
      } catch (e) {
        showToast("Failed: " + (e.message || e), { error: true });
        await refresh();
      } finally { busy = false; render(); }
    });

    pairBtn.addEventListener("click", async () => {
      busy = true; render();
      try {
        const r = await window.iris.startTelegramPairing();
        if (r && r.ok) {
          showToast("Pairing started — check Telegram");
          if (r.status) status = r.status;
        } else {
          showToast(r?.error || "Failed to start pairing", { error: true });
        }
      } catch (e) {
        showToast("Failed: " + (e.message || e), { error: true });
      } finally { busy = false; await refresh(); }
    });

    cancelPairBtn.addEventListener("click", async () => {
      busy = true; render();
      try {
        const r = await window.iris.cancelTelegramPairing();
        if (r && r.status) status = r.status;
      } catch (e) { /* swallow */ }
      finally { busy = false; await refresh(); }
    });

    pickFolderBtn.addEventListener("click", async () => {
      if (busy) return;
      const folder = await window.iris.pickFolder().catch(() => null);
      if (!folder) return;
      busy = true; render();
      try {
        const r = await window.iris.setTelegramDefaultCwd(folder);
        if (r && r.ok) {
          showToast("Workspace set");
          if (r.status) status = r.status;
        } else {
          showToast(r?.error || "Failed to set workspace", { error: true });
        }
      } catch (e) {
        showToast("Failed: " + (e.message || e), { error: true });
      } finally { busy = false; await refresh(); }
    });

    clearCwdBtn.addEventListener("click", async () => {
      if (busy) return;
      busy = true; render();
      try {
        const r = await window.iris.setTelegramDefaultCwd(null);
        if (r && r.ok) {
          showToast("Workspace reset");
          if (r.status) status = r.status;
        } else {
          showToast(r?.error || "Failed", { error: true });
        }
      } catch (e) {
        showToast("Failed: " + (e.message || e), { error: true });
      } finally { busy = false; await refresh(); }
    });

    async function setMode(mode) {
      if (busy) return;
      busy = true; render();
      try {
        const r = await window.iris.setTelegramChatMode(mode);
        if (r && r.ok) {
          showToast(mode === "iris" ? "Now routing to Iris" : "Now routing to workers");
          if (r.status) status = r.status;
        } else {
          showToast(r?.error || "Failed", { error: true });
        }
      } catch (e) {
        showToast("Failed: " + (e.message || e), { error: true });
      } finally { busy = false; await refresh(); }
    }
    workerModeBtn.addEventListener("click", () => setMode("worker"));
    irisModeBtn.addEventListener("click", () => setMode("iris"));

    testBtn.addEventListener("click", async () => {
      busy = true; testBtn.textContent = "Sending…"; render();
      try {
        const r = await window.iris.sendTelegramTest();
        if (r && r.ok) showToast("Test message sent");
        else showToast(r?.error || "Failed", { error: true });
      } catch (e) {
        showToast("Failed: " + (e.message || e), { error: true });
      } finally {
        busy = false; testBtn.textContent = "Send test message"; render();
      }
    });

    // Live updates from the service while the modal is open.
    const off = window.iris.onTelegramStatus?.((s) => {
      status = s;
      // If we just received a "paired" status update (chat id arrived from
      // the bot), nudge the user — they probably just sent the code.
      render();
    });

    const finish = () => {
      stopPairCountdown();
      if (typeof off === "function") off();
    };

    const { close } = openModal(modal, { onClose: () => { finish(); resolve(null); } });
    header.querySelector(".modal-close").addEventListener("click", () => { finish(); close(); resolve(null); });
    doneBtn.addEventListener("click", () => { finish(); close(); resolve(null); });

    refresh();
  });
}

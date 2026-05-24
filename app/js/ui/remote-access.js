// ═══════════════════════════════════════════════════════════
// remote-access.js — Remote Access (mobile companion) modal
// ═══════════════════════════════════════════════════════════
//
// Lets the user enable an HTTP/WebSocket server inside Iris so a phone app
// (iris-mobile) can connect. Shows the bearer token, port, reachable LAN
// addresses, and live connection count. All controls apply immediately
// (no Save button) — toggling enable/port restarts the server.

import { h, svgIcon, openModal, showToast } from "./util.js";

export function showRemoteAccessModal() {
  return new Promise((resolve) => {
    const modal = h("div", { class: "modal", style: { width: "min(580px, calc(100vw - 32px))" } });

    const header = h("div", { class: "modal-header" });
    header.append(
      h("div", { class: "modal-title" }, "Remote Access (mobile)"),
      h("button", { class: "modal-close", "aria-label": "Close" }, svgIcon("x", 14)),
    );

    const body = h("div", { class: "modal-body" });

    const introField = h("div", { class: "field" });
    introField.append(
      h("div", { class: "hint", style: { lineHeight: "1.55" } },
        "Let an Iris Mobile app connect to this PC. " +
        "All compute stays here — the phone is just a remote view. " +
        "Anyone with the URL and token can use your Iris, so treat the token like a password."),
    );

    // ── Enable toggle ───────────────────────────────────
    const enableField = h("div", { class: "field" });
    enableField.append(h("label", { class: "label" }, "Server"));
    const enableRow = h("label", {
      style: { display: "flex", alignItems: "center", gap: "10px", cursor: "pointer", padding: "6px 0" },
    });
    const enableCheck = h("input", { type: "checkbox" });
    enableRow.append(
      enableCheck,
      h("span", null, "Enable remote access"),
    );
    enableField.append(enableRow);

    const statusLine = h("div", { class: "hint", style: { marginTop: "4px" } }, "—");
    enableField.append(statusLine);

    // ── Token ────────────────────────────────────────────
    const tokenField = h("div", { class: "field" });
    tokenField.append(h("label", { class: "label" }, "Token"));
    const tokenRow = h("div", { class: "field-row" });
    const tokenInput = h("input", {
      class: "input",
      type: "password",
      readonly: "readonly",
      style: { flex: "1", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.85rem" },
      value: "",
    });
    const revealBtn = h("button", { class: "btn btn-ghost", type: "button", title: "Show / hide" }, "👁");
    const copyBtn = h("button", { class: "btn btn-ghost", type: "button", title: "Copy to clipboard" });
    copyBtn.append(svgIcon("copy", 14));
    const regenBtn = h("button", { class: "btn btn-ghost", type: "button", title: "Regenerate" }, "↻");
    tokenRow.append(tokenInput, revealBtn, copyBtn, regenBtn);
    tokenField.append(tokenRow);
    tokenField.append(h("div", { class: "hint" }, "Paste this into the Iris Mobile app once."));

    // ── Port ────────────────────────────────────────────
    const portField = h("div", { class: "field" });
    portField.append(h("label", { class: "label" }, "Port"));
    const portInput = h("input", {
      class: "input",
      type: "number",
      min: "1024",
      max: "65535",
      style: { width: "160px" },
    });
    portField.append(portInput);
    portField.append(h("div", { class: "hint" }, "Default: 8765. Changing this restarts the server. Make sure your firewall allows incoming traffic on this port."));

    // ── Reachable addresses ─────────────────────────────
    const hostsField = h("div", { class: "field" });
    hostsField.append(h("label", { class: "label" }, "Connect from your phone"));
    const hostsList = h("div", {
      style: {
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        padding: "10px 12px",
        background: "var(--bg-elev-1, rgba(255,255,255,0.04))",
        border: "1px solid var(--border, rgba(255,255,255,0.08))",
        borderRadius: "8px",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: "0.85rem",
      },
    });
    hostsField.append(hostsList);
    hostsField.append(h("div", { class: "hint" }, "For access from outside your home WiFi, set up Tailscale and use its hostname."));

    // ── Connections ─────────────────────────────────────
    const connField = h("div", { class: "field" });
    const connRow = h("div", {
      style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" },
    });
    const connText = h("div", { class: "hint" }, "—");
    const refreshBtn = h("button", { class: "btn btn-ghost", type: "button" }, "Refresh");
    connRow.append(connText, refreshBtn);
    connField.append(connRow);

    body.append(introField, enableField, tokenField, portField, hostsField, connField);

    const footer = h("div", { class: "modal-footer" });
    const doneBtn = h("button", { class: "btn btn-primary", type: "button" }, "Done");
    footer.append(doneBtn);

    modal.append(header, body, footer);

    let status = null;
    let busy = false;

    async function refresh() {
      try {
        status = await window.iris.getRemoteStatus();
      } catch (e) {
        showToast("Failed to load remote status: " + (e.message || e), { error: true });
        return;
      }
      render();
    }

    function render() {
      if (!status) return;

      enableCheck.checked = !!status.enabled;
      enableCheck.disabled = busy;

      const dependentDisabled = !status.enabled || busy;
      tokenInput.disabled = dependentDisabled;
      revealBtn.disabled = dependentDisabled;
      copyBtn.disabled = dependentDisabled;
      regenBtn.disabled = dependentDisabled;
      portInput.disabled = busy;
      refreshBtn.disabled = busy;

      tokenInput.value = status.token || "";
      portInput.value = String(status.port || 8765);

      if (status.enabled) {
        if (status.running) {
          statusLine.textContent = `Running on http://${status.host}:${status.port}`;
          statusLine.style.color = "var(--accent, #6bd968)";
        } else {
          statusLine.textContent = "Enabled but not running — check console for errors.";
          statusLine.style.color = "var(--warn, #e0a040)";
        }
      } else {
        statusLine.textContent = "Disabled";
        statusLine.style.color = "";
      }

      hostsList.innerHTML = "";
      if (!status.enabled || !status.running) {
        hostsList.append(h("div", { style: { opacity: "0.55" } }, "(server not running)"));
      } else {
        const hosts = status.reachableHosts || [];
        if (hosts.length === 0) {
          hostsList.append(h("div", { style: { opacity: "0.55" } },
            `http://localhost:${status.port}  (this PC only)`));
        } else {
          for (const hh of hosts) {
            const url = `http://${hh.address}:${status.port}`;
            const line = h("div", {
              style: { display: "flex", alignItems: "center", gap: "8px" },
            });
            const urlSpan = h("span", { style: { flex: "1" } }, url);
            const copyHostBtn = h("button", {
              class: "btn btn-ghost",
              type: "button",
              style: { padding: "2px 8px", fontSize: "0.8rem" },
              title: hh.iface,
            }, "Copy");
            copyHostBtn.addEventListener("click", () => {
              navigator.clipboard.writeText(url).then(
                () => showToast("URL copied"),
                () => showToast("Copy failed", { error: true }),
              );
            });
            line.append(urlSpan, copyHostBtn);
            hostsList.append(line);
          }
        }
      }

      const n = status.connections || 0;
      const clientInfo = Array.isArray(status.clientInfo) ? status.clientInfo : [];
      if (n === 0) {
        connText.textContent = "No connected clients.";
      } else {
        const addrs = clientInfo.map((c) => {
          const ip = (c.remoteAddr || "").replace(/^::ffff:/, "");
          const age = c.connectedAt ? Math.floor((Date.now() - c.connectedAt) / 1000) : 0;
          const ageLabel = age < 60 ? `${age}s` : age < 3600 ? `${Math.floor(age / 60)}m` : `${Math.floor(age / 3600)}h`;
          return `${ip} (${ageLabel})`;
        }).join(", ");
        connText.textContent = `${n} client${n === 1 ? "" : "s"} connected: ${addrs}`;
      }
    }

    enableCheck.addEventListener("change", async () => {
      if (busy) { enableCheck.checked = !enableCheck.checked; return; }
      busy = true;
      try {
        status = await window.iris.setRemoteConfig({ enabled: enableCheck.checked });
        render();
        showToast(status.enabled ? "Remote access enabled" : "Remote access disabled");
      } catch (e) {
        showToast("Failed: " + (e.message || e), { error: true });
        await refresh();
      } finally {
        busy = false;
        render();
      }
    });

    let revealed = false;
    revealBtn.addEventListener("click", () => {
      revealed = !revealed;
      tokenInput.type = revealed ? "text" : "password";
    });

    copyBtn.addEventListener("click", () => {
      const v = tokenInput.value;
      if (!v) return;
      navigator.clipboard.writeText(v).then(
        () => showToast("Token copied"),
        () => showToast("Copy failed", { error: true }),
      );
    });

    regenBtn.addEventListener("click", async () => {
      if (busy) return;
      const ok = confirm(
        "Regenerate the token? Any device currently using the old token will be disconnected.",
      );
      if (!ok) return;
      busy = true;
      try {
        status = await window.iris.regenerateRemoteToken();
        render();
        showToast("Token regenerated");
      } catch (e) {
        showToast("Failed: " + (e.message || e), { error: true });
      } finally {
        busy = false;
        render();
      }
    });

    let portCommitTimer = null;
    portInput.addEventListener("input", () => {
      if (portCommitTimer) clearTimeout(portCommitTimer);
      portCommitTimer = setTimeout(commitPort, 700);
    });
    portInput.addEventListener("blur", () => {
      if (portCommitTimer) { clearTimeout(portCommitTimer); portCommitTimer = null; }
      commitPort();
    });

    async function commitPort() {
      const v = parseInt(portInput.value, 10);
      if (!Number.isFinite(v) || v < 1024 || v > 65535) {
        showToast("Port must be 1024–65535", { error: true });
        portInput.value = String(status?.port || 8765);
        return;
      }
      if (status && v === status.port) return;
      busy = true;
      render();
      try {
        status = await window.iris.setRemoteConfig({ port: v });
        showToast(`Listening on port ${v}`);
      } catch (e) {
        showToast("Failed: " + (e.message || e), { error: true });
      } finally {
        busy = false;
        render();
      }
    }

    refreshBtn.addEventListener("click", () => refresh());

    const { close } = openModal(modal, { onClose: () => resolve(null) });
    header.querySelector(".modal-close").addEventListener("click", () => { close(); resolve(null); });
    doneBtn.addEventListener("click", () => { close(); resolve(null); });

    refresh();
  });
}

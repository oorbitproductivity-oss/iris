// ═══════════════════════════════════════════════════════════
// onboarding.js — first-run wizard
// ═══════════════════════════════════════════════════════════
//
// Shown the first time Iris Code launches (settings.onboarded === false).
// Walks the user through: welcome → auth → default working directory →
// model + effort → hotkey confirmation → done. Each step saves directly
// to Settings so the user can quit mid-onboarding and resume.
//
// Resolves a promise on completion (Get Started) so app.js can flip
// settings.onboarded → true and proceed to the normal UI.
//
// NOTE: deliberately self-contained — no other UI modules import this,
// only app.js calls showOnboarding() once.

import { h, svgIcon, irisImg, openModal, showToast, basename } from "./util.js";
import { showTelegramPanel } from "./telegram-panel.js";

const MODELS = [
  { id: "sonnet", label: "Sonnet", sub: "Balanced — fast and smart" },
  { id: "opus",   label: "Opus",   sub: "Maximum reasoning depth" },
  { id: "haiku",  label: "Haiku",  sub: "Light & quick" },
];

const EFFORTS = [
  { id: "high",   label: "High",   sub: "Deep thinking — matches Claude Code defaults" },
  { id: "medium", label: "Medium", sub: "Faster, lower cost" },
  { id: "low",    label: "Low",    sub: "Snappy replies, shallow reasoning" },
];

const HOTKEY_OPTIONS = [
  { id: "CommandOrControl+Shift+Space", label: "Ctrl + Shift + Space" },
  { id: "CommandOrControl+Shift+I",     label: "Ctrl + Shift + I (conflicts with DevTools)" },
  { id: "CommandOrControl+Shift+J",     label: "Ctrl + Shift + J" },
  { id: "Alt+Space",                    label: "Alt + Space" },
];

/**
 * Show the onboarding wizard. Returns a promise that resolves with the
 * final settings object when the user clicks "Get started".
 */
export function showOnboarding(state) {
  return new Promise((resolve) => {
    const card = h("div", { class: "modal onboarding-card", style: { width: "min(620px, calc(100vw - 32px))" } });

    // Step state
    const draft = {
      mode: state.get().settings?.mode || "subscription",
      apiKeyName: "",
      apiKeyValue: "",
      defaultCwd: state.get().settings?.defaultCwd || null,
      model: state.get().settings?.model || "sonnet",
      irisModel: state.get().settings?.irisModel || "sonnet",
      effort: state.get().settings?.effort || "high",
      spotlightHotkey: state.get().settings?.spotlightHotkey || "CommandOrControl+Shift+Space",
    };

    // ── Layout: progress + body + footer ─────────────────────
    const progress = h("div", { class: "ob-progress" });
    const body = h("div", { class: "ob-body" });
    const footer = h("div", { class: "ob-footer" });

    const backBtn = h("button", { class: "btn btn-ghost" }, "Back");
    const skipBtn = h("button", { class: "btn btn-ghost" }, "Skip");
    const nextBtn = h("button", { class: "btn btn-primary" }, "Next");
    const spacer = h("div", { style: { flex: "1" } });
    footer.append(backBtn, spacer, skipBtn, nextBtn);

    card.append(progress, body, footer);

    let step = 0;
    let close;

    // ── Steps ────────────────────────────────────────────────
    const steps = [
      { id: "welcome",  render: renderWelcome,  nextLabel: "Let's go",    showSkip: false, showBack: false },
      { id: "auth",     render: renderAuth,     nextLabel: "Continue",    showSkip: true,  showBack: true  },
      { id: "cwd",      render: renderCwd,      nextLabel: "Continue",    showSkip: true,  showBack: true  },
      { id: "model",    render: renderModel,    nextLabel: "Continue",    showSkip: true,  showBack: true  },
      { id: "hotkey",   render: renderHotkey,   nextLabel: "Continue",    showSkip: true,  showBack: true  },
      { id: "telegram", render: renderTelegram, nextLabel: "Continue",    showSkip: true,  showBack: true  },
      { id: "done",     render: renderDone,     nextLabel: "Get started", showSkip: false, showBack: true  },
    ];

    function paintProgress() {
      progress.innerHTML = "";
      for (let i = 0; i < steps.length; i++) {
        const dot = h("div", { class: `ob-step-dot${i === step ? " active" : ""}${i < step ? " done" : ""}` });
        progress.append(dot);
      }
    }

    function paintFooter() {
      const s = steps[step];
      backBtn.style.visibility = s.showBack ? "visible" : "hidden";
      skipBtn.style.visibility = s.showSkip ? "visible" : "hidden";
      nextBtn.textContent = s.nextLabel;
    }

    function paint() {
      paintProgress();
      paintFooter();
      body.innerHTML = "";
      steps[step].render(body);
    }

    async function gotoNext() {
      // Per-step persistence
      try {
        if (steps[step].id === "auth") await persistAuth();
        if (steps[step].id === "cwd") await persistCwd();
        if (steps[step].id === "model") await persistModel();
        if (steps[step].id === "hotkey") await persistHotkey();
      } catch (err) {
        console.error("[onboarding] persist failed:", err);
        showToast("Couldn't save that step — try again.", { error: true });
        return;
      }
      if (step >= steps.length - 1) {
        await state.actions.saveSettings({ onboarded: true });
        close();
        resolve(state.get().settings);
        return;
      }
      step++;
      paint();
    }

    function gotoBack() {
      if (step === 0) return;
      step--;
      paint();
    }

    backBtn.addEventListener("click", gotoBack);
    skipBtn.addEventListener("click", () => {
      // Skip just advances without persisting the current step.
      if (step >= steps.length - 1) {
        state.actions.saveSettings({ onboarded: true }).finally(() => {
          close(); resolve(state.get().settings);
        });
        return;
      }
      step++;
      paint();
    });
    nextBtn.addEventListener("click", () => { gotoNext(); });

    // ── Step renderers ───────────────────────────────────────
    function renderWelcome(host) {
      const wrap = h("div", { class: "ob-step ob-welcome" });
      const mark = h("div", { class: "ob-mark" }, irisImg(72));
      const title = h("h1", { class: "ob-title" },
        h("span", { class: "grad" }, "Iris Code"),
      );
      const tag = h("p", { class: "ob-tag" }, "Your orchestrator for parallel Claude Code agents.");
      const lead = h("p", { class: "ob-lead" },
        "Iris is a master agent that watches your sub-workers, suggests the next move, and lets you spin up isolated sessions per project. This wizard takes about 30 seconds — you can change everything later in Settings."
      );
      wrap.append(mark, title, tag, lead);
      host.append(wrap);
    }

    function renderAuth(host) {
      const wrap = h("div", { class: "ob-step" });
      wrap.append(h("h2", { class: "ob-step-title" }, "How should agents talk to Claude?"));
      wrap.append(h("p", { class: "ob-step-sub" },
        "Subscription mode reuses your existing Claude Code login. Pick API key mode if you'd rather pay-as-you-go with a named key."
      ));

      const opts = h("div", { class: "ob-options" });
      const subOpt = optionCard({
        title: "Subscription (recommended)",
        sub: "Uses your existing `claude` CLI login. No extra setup.",
        active: draft.mode === "subscription",
        onClick: () => { draft.mode = "subscription"; paint(); },
      });
      const keyOpt = optionCard({
        title: "API key",
        sub: "Bring your own Anthropic key — billed per token.",
        active: draft.mode === "apikey",
        onClick: () => { draft.mode = "apikey"; paint(); },
      });
      opts.append(subOpt, keyOpt);
      wrap.append(opts);

      if (draft.mode === "apikey") {
        const keyWrap = h("div", { class: "ob-inline-form" });
        keyWrap.append(h("label", { class: "label" }, "Key name"));
        const nameInput = h("input", {
          class: "input", type: "text",
          value: draft.apiKeyName, placeholder: "e.g. Personal",
          spellcheck: "false",
        });
        nameInput.addEventListener("input", () => { draft.apiKeyName = nameInput.value; });
        keyWrap.append(nameInput);

        keyWrap.append(h("label", { class: "label", style: { marginTop: "12px" } }, "API key"));
        const valInput = h("input", {
          class: "input", type: "password",
          value: draft.apiKeyValue, placeholder: "sk-ant-…",
          spellcheck: "false",
        });
        valInput.addEventListener("input", () => { draft.apiKeyValue = valInput.value; });
        keyWrap.append(valInput);

        keyWrap.append(h("div", { class: "hint" },
          "The key is encrypted with the OS keychain before being stored. You can add more keys later in Settings → API keys."
        ));
        wrap.append(keyWrap);
      }
      host.append(wrap);
    }

    function renderCwd(host) {
      const wrap = h("div", { class: "ob-step" });
      wrap.append(h("h2", { class: "ob-step-title" }, "Pick a default working directory"));
      wrap.append(h("p", { class: "ob-step-sub" },
        "New sessions open here unless you choose differently. Usually your projects folder."
      ));

      const row = h("div", { class: "field-row" });
      const valEl = h("div", { class: "ob-cwd-value" }, draft.defaultCwd || "(not set)");
      const browseBtn = h("button", { class: "btn btn-filled", type: "button" }, "Browse…");
      browseBtn.addEventListener("click", async () => {
        const f = await window.iris?.pickFolder?.();
        if (f) {
          draft.defaultCwd = f;
          valEl.textContent = f;
        }
      });
      row.append(valEl, browseBtn);
      wrap.append(row);

      wrap.append(h("div", { class: "hint" },
        "You can skip this — agents will require a folder choice on creation if no default is set."
      ));
      host.append(wrap);
    }

    function renderModel(host) {
      const wrap = h("div", { class: "ob-step" });
      wrap.append(h("h2", { class: "ob-step-title" }, "Choose your default model + effort"));
      wrap.append(h("p", { class: "ob-step-sub" },
        "Every new session inherits these. Tune per-session anytime."
      ));

      wrap.append(h("label", { class: "label" }, "Default model"));
      const modelOpts = h("div", { class: "ob-options ob-options-row" });
      for (const m of MODELS) {
        modelOpts.append(optionCard({
          title: m.label, sub: m.sub,
          active: draft.model === m.id,
          onClick: () => { draft.model = m.id; draft.irisModel = m.id; paint(); },
          compact: true,
        }));
      }
      wrap.append(modelOpts);

      wrap.append(h("label", { class: "label", style: { marginTop: "16px" } }, "Reasoning effort"));
      const effortOpts = h("div", { class: "ob-options ob-options-row" });
      for (const e of EFFORTS) {
        effortOpts.append(optionCard({
          title: e.label, sub: e.sub,
          active: draft.effort === e.id,
          onClick: () => { draft.effort = e.id; paint(); },
          compact: true,
        }));
      }
      wrap.append(effortOpts);
      host.append(wrap);
    }

    function renderHotkey(host) {
      const wrap = h("div", { class: "ob-step" });
      wrap.append(h("h2", { class: "ob-step-title" }, "Pick a global hotkey for Iris"));
      wrap.append(h("p", { class: "ob-step-sub" },
        "Tapping this from anywhere on your system opens the Iris chat overlay. Avoid Ctrl+Shift+I — Chromium reserves it for DevTools."
      ));

      const opts = h("div", { class: "ob-options" });
      for (const o of HOTKEY_OPTIONS) {
        opts.append(optionCard({
          title: o.label,
          sub: o.id === draft.spotlightHotkey ? "Selected" : "",
          active: o.id === draft.spotlightHotkey,
          onClick: () => { draft.spotlightHotkey = o.id; paint(); },
        }));
      }
      wrap.append(opts);
      host.append(wrap);
    }

    function renderTelegram(host) {
      const wrap = h("div", { class: "ob-step" });
      wrap.append(h("h2", { class: "ob-step-title" }, "Set up with Telegram for easy agent access (optional)"));
      wrap.append(h("p", { class: "ob-step-sub" },
        "DM your own Telegram bot to run agent tasks on this PC from anywhere. " +
        "Bring-your-own-bot — no shared servers, nothing leaves your machine except the chat with Telegram itself."
      ));

      const card = h("div", {
        style: {
          padding: "14px 16px",
          border: "1px solid rgba(255,255,255,0.08)",
          background: "rgba(255,255,255,0.03)",
          borderRadius: "10px",
          marginTop: "8px",
        },
      });
      card.append(
        h("ol", { style: { paddingLeft: "20px", margin: "0", lineHeight: "1.6" } },
          h("li", null, "Message ",
            h("a", { href: "https://t.me/BotFather", "data-external": "1" }, "@BotFather"),
            " → ", h("code", null, "/newbot"), " → name it → get a token."),
          h("li", null, "Paste the token in the panel that opens, click ",
            h("strong", null, "Pair my phone"), " → Iris shows a 6-digit code."),
          h("li", null, "Open your bot in Telegram, send the code → bot replies ",
            h("strong", null, "✅ Paired"), ". Done."),
          h("li", null, "Any message becomes a new task. ",
            h("code", null, "/new"), " resets context. ", h("code", null, "/stop"), " cancels."),
        ),
      );
      // External links
      card.querySelectorAll('a[data-external="1"]').forEach((a) => {
        a.addEventListener("click", (e) => {
          e.preventDefault();
          window.iris?.openExternal?.(a.getAttribute("href"));
        });
      });
      wrap.append(card);

      const openBtn = h("button", {
        class: "btn btn-filled",
        type: "button",
        style: { marginTop: "14px" },
      }, "Open Telegram setup…");
      openBtn.addEventListener("click", () => showTelegramPanel());
      wrap.append(openBtn);

      wrap.append(h("div", { class: "hint", style: { marginTop: "10px" } },
        "You can skip this and set it up later in Settings → Telegram Remote Agent."
      ));
      host.append(wrap);
    }

    function renderDone(host) {
      const wrap = h("div", { class: "ob-step ob-done" });
      wrap.append(h("div", { class: "ob-mark" }, irisImg(72)));
      wrap.append(h("h1", { class: "ob-title" }, h("span", { class: "grad" }, "All set.")));
      const sum = h("div", { class: "ob-summary" });
      sum.append(summaryRow("Auth",      draft.mode === "subscription" ? "Subscription" : `API key — ${draft.apiKeyName || "(unnamed)"}`));
      sum.append(summaryRow("Default folder", draft.defaultCwd ? basename(draft.defaultCwd) : "(not set)"));
      sum.append(summaryRow("Model",     `${draft.model} · effort ${draft.effort}`));
      sum.append(summaryRow("Hotkey",    prettyHotkey(draft.spotlightHotkey)));
      wrap.append(sum);
      wrap.append(h("p", { class: "ob-lead" },
        "Open Iris with your hotkey, or hit “New thread” in the sidebar to spin up your first sub-agent."
      ));
      host.append(wrap);
    }

    // ── Persistence ──────────────────────────────────────────
    async function persistAuth() {
      const patch = { mode: draft.mode };
      if (draft.mode === "apikey" && draft.apiKeyName && draft.apiKeyValue) {
        try {
          const added = await window.iris.addKey(draft.apiKeyName, draft.apiKeyValue);
          if (added && added.id) patch.defaultApiKeyId = added.id;
        } catch (err) {
          console.error("[onboarding] addKey failed:", err);
          throw err;
        }
      }
      await state.actions.saveSettings(patch);
    }
    async function persistCwd() {
      if (draft.defaultCwd) await state.actions.saveSettings({ defaultCwd: draft.defaultCwd });
    }
    async function persistModel() {
      await state.actions.saveSettings({
        model: draft.model,
        irisModel: draft.irisModel,
        effort: draft.effort,
      });
    }
    async function persistHotkey() {
      await state.actions.saveSettings({ spotlightHotkey: draft.spotlightHotkey });
    }

    paint();
    const handle = openModal(card, { onClose: () => resolve(state.get().settings) });
    close = handle.close;
  });
}

// ── Local helpers ─────────────────────────────────────────────
function optionCard({ title, sub, active, onClick, compact = false }) {
  const card = h("button", {
    class: `ob-option${active ? " active" : ""}${compact ? " ob-option-compact" : ""}`,
    type: "button",
  });
  const t = h("div", { class: "ob-option-title" }, title);
  card.append(t);
  if (sub) card.append(h("div", { class: "ob-option-sub" }, sub));
  card.addEventListener("click", onClick);
  return card;
}

function summaryRow(label, value) {
  const row = h("div", { class: "ob-summary-row" });
  row.append(h("div", { class: "ob-summary-label" }, label));
  row.append(h("div", { class: "ob-summary-value" }, value || "—"));
  return row;
}

function prettyHotkey(raw) {
  const isMac = (window.iris?.platform || "").startsWith("darwin");
  return raw
    .replace(/CommandOrControl/i, isMac ? "Cmd" : "Ctrl")
    .replace(/CmdOrCtrl/i, isMac ? "Cmd" : "Ctrl")
    .replace(/Command/i, "Cmd")
    .replace(/Control/i, "Ctrl")
    .replace(/Alt/i, isMac ? "Option" : "Alt")
    .replace(/\+/g, " + ");
}

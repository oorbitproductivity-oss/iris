// ═══════════════════════════════════════════════════════════
// voice.js — Web Speech voice input for the Iris overlay
// composer. Inserts a mic button before the send button; click
// toggles dictation, interim results stream into the textarea.
// ═══════════════════════════════════════════════════════════

import { showToast } from "./util.js";

const MIC_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none"
  stroke="currentColor" stroke-width="1.7" stroke-linecap="round"
  stroke-linejoin="round" aria-hidden="true">
  <rect x="9" y="2" width="6" height="12" rx="3"/>
  <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8"/>
</svg>`;

export function initVoice(state) {
  let injected = false;

  function tryInject() {
    if (injected) return true;
    const input = document.getElementById("iro-input");
    const send = document.getElementById("iro-send");
    if (!input || !send) return false;
    injected = true;
    attach(input, send);
    return true;
  }

  // Composer might not be in the DOM yet (overlay hidden) — wait for it.
  if (!tryInject()) {
    const mo = new MutationObserver(() => {
      if (tryInject()) mo.disconnect();
    });
    mo.observe(document.body, { subtree: true, childList: true });
  }
}

function attach(input, send) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "voice-btn";
  btn.title = SpeechRecognition ? "Voice input" : "Voice input not supported";
  btn.setAttribute("aria-label", btn.title);
  btn.innerHTML = MIC_SVG;
  send.parentNode.insertBefore(btn, send);

  if (!SpeechRecognition) {
    btn.disabled = true;
    return;
  }

  let recognition = null;
  let listening = false;
  // The textarea position when recognition began; interim text is rewritten
  // between [startPos, endPos] as new partials arrive.
  let startPos = 0;
  let endPos = 0;

  function setListening(on) {
    listening = on;
    btn.classList.toggle("listening", on);
  }

  function start() {
    try {
      recognition = new SpeechRecognition();
    } catch (e) {
      showToast("Voice input unavailable: " + (e.message || e), { error: true });
      return;
    }
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    startPos = input.selectionStart ?? input.value.length;
    endPos = startPos;

    recognition.addEventListener("result", (e) => {
      let interim = "";
      let final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) final += r[0].transcript;
        else interim += r[0].transcript;
      }
      if (final) {
        const before = input.value.slice(0, startPos);
        const after = input.value.slice(endPos);
        const text = final + (interim ? "" : "");
        input.value = before + text + after;
        endPos = startPos + text.length;
        startPos = endPos;
        input.setSelectionRange(endPos, endPos);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (interim) {
        const before = input.value.slice(0, startPos);
        const after = input.value.slice(endPos);
        input.value = before + interim + after;
        endPos = startPos + interim.length;
        input.setSelectionRange(endPos, endPos);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });

    recognition.addEventListener("error", (e) => {
      setListening(false);
      const msg = (e && e.error) ? String(e.error) : "voice error";
      showToast("Voice input: " + msg, { error: true });
    });

    recognition.addEventListener("end", () => {
      setListening(false);
      recognition = null;
    });

    try {
      recognition.start();
      setListening(true);
      input.focus();
    } catch (e) {
      setListening(false);
      showToast("Voice input failed to start", { error: true });
    }
  }

  function stop() {
    if (recognition) {
      try { recognition.stop(); } catch {}
    }
    setListening(false);
  }

  btn.addEventListener("click", () => {
    if (listening) stop();
    else start();
  });
}

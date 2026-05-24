// ═══════════════════════════════════════════════════════════
// util.js — Internal helpers shared by UI modules
// ═══════════════════════════════════════════════════════════
// (Not part of the spec's required file list, but the spec
// permits "tiny h() helper" — we centralize it here so all
// UI modules use the same primitives.)
// ═══════════════════════════════════════════════════════════

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "html") el.innerHTML = v; // caller is responsible for safety
      else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    if (c instanceof Node) el.append(c);
    else el.append(document.createTextNode(String(c)));
  }
  return el;
}

// ─── SVG icon set (stroke-based, currentColor) ────────────
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  play: '<path d="M6 4l14 8-14 8V4z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.3H9A1.7 1.7 0 0 0 10 3.6V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  chevDown: '<path d="M6 9l6 6 6-6"/>',
  chevRight: '<path d="M9 6l6 6-6 6"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  spark: '<path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>',
  focus: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  iris: '<circle cx="12" cy="12" r="3.5"/><path d="M12 2v3M12 18v3M21 12h-3M5 12H2M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4L5.3 5.3"/>',
  arrowRight: '<path d="M5 12h14M13 5l7 7-7 7"/>',
  zap: '<path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/>',
  maximize: '<path d="M3 9V4a1 1 0 0 1 1-1h5M21 9V4a1 1 0 0 0-1-1h-5M3 15v5a1 1 0 0 0 1 1h5M21 15v5a1 1 0 0 1-1 1h-5"/>',
  minimize: '<path d="M9 3v4a1 1 0 0 1-1 1H4M15 3v4a1 1 0 0 0 1 1h4M9 21v-4a1 1 0 0 0-1-1H4M15 21v-4a1 1 0 0 1 1-1h4"/>',
  expandAll: '<path d="M7 13l5 5 5-5M7 6l5 5 5-5"/>',
  collapseAll: '<path d="M7 5l5-3 5 3M7 19l5 3 5-3M7 11l5 3 5-3"/>',
  chevDoubleDown: '<path d="M7 6l5 5 5-5M7 13l5 5 5-5"/>',
  shield: '<path d="M12 3 L4 6 V11 a9 9 0 0 0 8 10 a9 9 0 0 0 8 -10 V6 Z"/>',
  // Paper-plane glyph — used as the Telegram bridge marker. Drawn in the same
  // outline style as the rest of the icon set so it lives next to "settings"
  // in the sidebar footer without looking out of place.
  paperPlane: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>',
};

export function svgIcon(name, size = 16) {
  if (name === "iris") return irisImg(size);
  const path = ICONS[name] || ICONS.spark;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.innerHTML = path;
  return svg;
}

/** The Iris brand mark — a PNG image (ornate gold-on-black eye + I). */
export function irisImg(size = 24) {
  const img = document.createElement("img");
  img.src = "assets/iris-icon.png";
  img.alt = "Iris";
  img.draggable = false;
  img.className = "iris-img";
  img.style.width = String(size) + "px";
  img.style.height = String(size) + "px";
  img.style.objectFit = "contain";
  img.style.display = "block";
  return img;
}

// ─── Time / path helpers ──────────────────────────────────
export function relativeTime(ts) {
  if (!ts) return "—";
  const now = Date.now();
  const diff = Math.max(0, now - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 5) return "now";
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(ts).toLocaleDateString();
}

export function basename(p) {
  if (!p) return "";
  const norm = String(p).replace(/[\\/]+$/, "");
  const parts = norm.split(/[\\/]/);
  return parts[parts.length - 1] || norm;
}

// ─── Modal lifecycle ──────────────────────────────────────
export function openModal(contentEl, { onClose } = {}) {
  const root = document.getElementById("modal-root");
  const overlay = h("div", { class: "modal-overlay" });
  overlay.append(contentEl);
  root.append(overlay);

  function close() {
    overlay.classList.add("closing");
    overlay.remove();
    document.removeEventListener("keydown", esc, true);
    if (onClose) try { onClose(); } catch {}
  }

  function esc(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", esc, true);

  // Focus first focusable element
  setTimeout(() => {
    const focusable = contentEl.querySelector("input, textarea, select, button");
    if (focusable) focusable.focus();
  }, 50);

  return { close };
}

export function showToast(message, { error = false, duration = 2500 } = {}) {
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();
  const toast = h("div", { class: `toast${error ? " error" : ""}` }, message);
  document.body.append(toast);
  setTimeout(() => toast.remove(), duration);
}

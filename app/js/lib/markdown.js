// markdown.js -- Minimal, safe markdown renderer for Iris Code.
//
// Supported:
//   - Headings (#, ##, ###)
//   - Bold (**), italic (*), inline code (`)
//   - Fenced code blocks ```lang ... ```
//   - Unordered (- ) and ordered (1. ) lists
//   - Links [text](url) -- rendered as anchors with data-url; click is handled by app delegate
//   - Paragraphs separated by blank lines
//   - <iris-web-result url="..." title="...">snippet</iris-web-result> custom tags --
//     rendered as rich link cards with favicon, title, snippet, and host.
//     The orchestrator emits these for web-search citations; the renderer
//     stashes them BEFORE HTML-escaping so their attributes survive intact.
//
// All user content is HTML-escaped before any markdown transforms.
// Output is trusted HTML suitable for insertAdjacentHTML.

const ESC_MAP = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const CODE_OPEN = "";
const CODE_CLOSE = "";
const BLOCK_OPEN = "";
const BLOCK_CLOSE = "";
// Sentinels for <iris-web-result> tags. Stashed before HTML-escape so the
// attribute values survive verbatim, then re-rendered as a card after all
// block-level processing is done.
const CARD_OPEN = "";
const CARD_CLOSE = "";

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/`/g, "&#96;");
}

// Permit only http(s) URLs in web-card hrefs; everything else (javascript:,
// data:, file:, mailto:, malformed, etc.) is dropped to plain text so a
// malicious or buggy citation can never become an active scheme.
function safeHttpUrl(url) {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  // Reject any control characters or whitespace inside the URL -- those are
  // the classic vectors for splitting an href via embedded \n, \r, or NBSP.
  if (/[\x00-\x1f\s]/.test(trimmed)) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return ""; }
}

// Build the card HTML for one citation. All attribute and text content is
// HTML-escaped; the favicon source is constructed from the validated URL.
function renderWebCard({ url, title, snippet }) {
  const safe = safeHttpUrl(url);
  if (!safe) {
    // Fall back to plain escaped text so the snippet is still readable but
    // no link is created.
    const fallback = (title || snippet || url || "").trim();
    return `<span class="web-card-invalid">${escapeHtml(fallback)}</span>`;
  }
  const host = hostnameOf(safe);
  const displayTitle = (title && title.trim()) || host || safe;
  const favicon = `https://www.google.com/s2/favicons?sz=64&domain_url=${encodeURIComponent(safe)}`;
  return [
    `<a class="web-card" href="${escapeAttr(safe)}" target="_blank" rel="noopener noreferrer" data-url="${escapeAttr(safe)}">`,
    `<img class="web-card-favicon" src="${escapeAttr(favicon)}" alt="" loading="lazy" width="20" height="20">`,
    `<div class="web-card-body">`,
    `<div class="web-card-title">${escapeHtml(displayTitle)}</div>`,
    snippet ? `<div class="web-card-snippet">${escapeHtml(snippet)}</div>` : "",
    `<div class="web-card-host">${escapeHtml(host || safe)}</div>`,
    `</div>`,
    `</a>`,
  ].join("");
}

// Inline transforms: applied after HTML-escaping.
function renderInline(text) {
  let out = text;

  // Inline code first (we want its contents preserved verbatim).
  // We replace with placeholders so further regexes don't touch its inside.
  const codeStash = [];
  out = out.replace(/`([^`\n]+?)`/g, (_, code) => {
    codeStash.push(code);
    return CODE_OPEN + (codeStash.length - 1) + CODE_CLOSE;
  });

  // Bold ** ** (do before italic so ** doesn't get eaten as two *)
  out = out.replace(/\*\*([^\*\n][^\*\n]*?)\*\*/g, "<strong>$1</strong>");

  // Italic * *
  out = out.replace(/(^|[^\*])\*([^\*\n][^\*\n]*?)\*(?!\*)/g, "$1<em>$2</em>");

  // Links [text](url) -- only allow http(s), file:, and mailto:
  out = out.replace(/\[([^\]]+?)\]\(([^)\s]+?)\)/g, (m, label, url) => {
    const safeUrl = /^(https?:\/\/|file:\/\/|mailto:)/i.test(url) ? url : null;
    if (!safeUrl) return escapeHtml(m); // leave as escaped text
    return `<a data-url="${escapeAttr(safeUrl)}" href="#">${label}</a>`;
  });

  // Restore inline code
  const codeRe = new RegExp(CODE_OPEN + "(\\d+)" + CODE_CLOSE, "g");
  out = out.replace(codeRe, (_, idx) => {
    return `<code>${codeStash[+idx]}</code>`;
  });

  return out;
}

function renderListItems(lines, ordered) {
  const itemRe = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*]\s+(.*)$/;
  const items = lines.map((l) => l.replace(itemRe, "$1"));
  const tag = ordered ? "ol" : "ul";
  return `<${tag}>${items.map((i) => `<li>${renderInline(i)}</li>`).join("")}</${tag}>`;
}

export function renderMarkdown(input) {
  if (input == null) return "";
  const raw = String(input);

  // FIRST pass: extract <iris-web-result …>…</iris-web-result> tags BEFORE
  // anything else so their attributes don't get HTML-escaped into oblivion.
  // We pull url + title from the open tag (order-independent, double or
  // single quoted) and the snippet from between the tags.
  const cards = [];
  const cardTagRe =
    /<iris-web-result\b([^>]*)>([\s\S]*?)<\/iris-web-result>/gi;
  const withoutCards = raw.replace(cardTagRe, (_full, attrs, snippet) => {
    const urlMatch = /\burl\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    const titleMatch = /\btitle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    const url = urlMatch ? (urlMatch[1] || urlMatch[2] || "") : "";
    const title = titleMatch ? (titleMatch[1] || titleMatch[2] || "") : "";
    cards.push({ url, title, snippet: (snippet || "").trim() });
    return CARD_OPEN + (cards.length - 1) + CARD_CLOSE;
  });

  // Second: extract fenced code blocks so we don't touch their contents.
  const blocks = [];
  const withoutFences = withoutCards.replace(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push({ lang: lang.trim(), code });
    return BLOCK_OPEN + (blocks.length - 1) + BLOCK_CLOSE;
  });

  // HTML-escape everything outside the fenced blocks (the card sentinels are
  // private-use code points and pass through escapeHtml untouched).
  const escaped = escapeHtml(withoutFences);

  // Split into logical lines, then group into block-level units
  const lines = escaped.split("\n");
  const out = [];

  const blockLineRe = new RegExp("^" + BLOCK_OPEN + "(\\d+)" + BLOCK_CLOSE + "\\s*$");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Block placeholder for a fenced code block -- passes through; replaced later.
    if (blockLineRe.test(line)) {
      out.push(line);
      i++;
      continue;
    }

    // Skip blank lines
    if (/^\s*$/.test(line)) { i++; continue; }

    // Heading
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${renderInline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule — three or more `-`, `*`, or `_` on a line by themselves
    // (with optional surrounding whitespace). Used by agents to set off the
    // trailing `**Summary:** …` line at the end of every turn.
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const group = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        group.push(lines[i]);
        i++;
      }
      out.push(renderListItems(group, false));
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const group = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        group.push(lines[i]);
        i++;
      }
      out.push(renderListItems(group, true));
      continue;
    }

    // Paragraph -- gather consecutive non-blank, non-special lines
    const para = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^(#{1,3})\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !blockLineRe.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    if (para.length) {
      out.push(`<p>${renderInline(para.join(" "))}</p>`);
    }
  }

  let html = out.join("\n");

  // Reinsert fenced code blocks
  const blockReplaceRe = new RegExp(BLOCK_OPEN + "(\\d+)" + BLOCK_CLOSE, "g");
  html = html.replace(blockReplaceRe, (_, idx) => {
    const { lang, code } = blocks[+idx];
    const safeCode = escapeHtml(code);
    const cls = lang ? ` class="lang-${escapeAttr(lang)}"` : "";
    return `<pre><code${cls}>${safeCode}</code></pre>`;
  });

  // Reinsert web result cards. Done LAST so the freshly-rendered <a> tag
  // isn't HTML-escaped by the paragraph pipeline above.
  const cardReplaceRe = new RegExp(CARD_OPEN + "(\\d+)" + CARD_CLOSE, "g");
  html = html.replace(cardReplaceRe, (_, idx) => renderWebCard(cards[+idx]));

  return html;
}

// --- Action block extraction ---
// Pulls out ```action ... ``` fenced JSON blocks and returns
// { cleanedText, actions: [{ raw, action }] }
export function extractActions(text) {
  if (text == null) return { cleanedText: "", actions: [] };
  const raw = String(text);
  const actions = [];
  const cleanedText = raw.replace(/```action\s*\n([\s\S]*?)```/g, (m, body) => {
    let parsed = null;
    try { parsed = JSON.parse(body.trim()); } catch (e) {
      return m; // leave as-is if invalid JSON
    }
    if (parsed && typeof parsed === "object" && parsed.type) {
      actions.push({ raw: body.trim(), action: parsed });
      return ""; // strip from rendered text
    }
    return m;
  });
  return { cleanedText: cleanedText.trim(), actions };
}

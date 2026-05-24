// lib/telegram/markdown.js
//
// MarkdownV2 helpers for the Telegram bridge.
//
// Telegram's MarkdownV2 escaping rules are unforgiving — any of `_ * [ ] ( )
// ~ \` > # + - = | { } . !` that appears outside its formatting role must be
// backslash-escaped, otherwise the API rejects the message. We escape ALL of
// them by default and provide a small helper for fenced code blocks where
// only backticks and backslashes need escaping.
//
// Also handles the 4096-character per-message cap by chunking long output on
// line boundaries when possible.

'use strict';

const MAX_MESSAGE = 4096;

// Per https://core.telegram.org/bots/api#markdownv2-style
const MDV2_SPECIALS = /[_*\[\]()~`>#+\-=|{}.!\\]/g;

/** Escape any string for safe inclusion inside a MarkdownV2 message. */
function escapeMarkdownV2(s) {
  if (s == null) return '';
  return String(s).replace(MDV2_SPECIALS, (c) => '\\' + c);
}

/**
 * Escape text destined for inside a fenced code block. Only backtick and
 * backslash need escaping; everything else is rendered verbatim.
 */
function escapeCodeBlock(s) {
  if (s == null) return '';
  return String(s).replace(/\\/g, '\\\\').replace(/`/g, '\\`');
}

/** Wrap text in a MarkdownV2 fenced code block. */
function codeBlock(text, lang) {
  const safe = escapeCodeBlock(text || '');
  const langTag = typeof lang === 'string' && /^[a-z0-9_+-]{0,20}$/i.test(lang) ? lang : '';
  return '```' + langTag + '\n' + safe + '\n```';
}

/** Wrap text as MarkdownV2 inline code (one line). */
function inlineCode(text) {
  return '`' + escapeCodeBlock(text || '') + '`';
}

/**
 * Split a (possibly very long) MarkdownV2 message into ≤4096-char chunks.
 *
 * Strategy: never split inside a code fence. Break on the last blank line, or
 * the last newline, that still fits the budget. As a last resort split at the
 * raw budget — this can leave a dangling backslash, so we trim trailing
 * backslashes to avoid emitting an unfinished escape.
 *
 * Returns string[]. Empty input → [].
 */
function chunkMarkdownV2(text, maxLen = MAX_MESSAGE) {
  if (!text) return [];
  const s = String(text);
  if (s.length <= maxLen) return [s];
  const out = [];
  let rest = s;
  // Track whether we're currently inside an unclosed ``` fence so we can
  // re-open / re-close across chunk boundaries instead of corrupting it.
  let inFence = false;

  while (rest.length > maxLen) {
    // Compute how much we can take, accounting for an open fence: if we're
    // inside one, we'll have to close it with "\n```" (+4 chars), and the
    // next chunk will reopen with "```\n".
    const reservedClose = inFence ? 4 : 0;
    const reservedOpen = inFence ? 4 : 0; // for the *next* chunk's prefix
    const budget = maxLen - reservedClose;

    // Prefer cutting at a blank line, else a newline, within [budget/2, budget].
    let cut = -1;
    const slice = rest.slice(0, budget);
    cut = slice.lastIndexOf('\n\n');
    if (cut < budget / 2) {
      const nl = slice.lastIndexOf('\n');
      if (nl > budget / 2) cut = nl;
    }
    if (cut < budget / 2) cut = budget;
    // Avoid splitting in the middle of a backslash escape.
    while (cut > 1 && rest[cut - 1] === '\\') cut--;

    let chunk = rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\n+/, '');

    // Count fences in this chunk to update inFence for the next iteration.
    const fenceCount = (chunk.match(/```/g) || []).length;
    let willBeInFence = inFence !== (fenceCount % 2 === 1);
    if (inFence) chunk = '```\n' + chunk; // reopen
    if (willBeInFence) chunk = chunk + '\n```'; // close

    out.push(chunk);
    inFence = willBeInFence;
  }

  if (rest.length > 0) {
    if (inFence) rest = '```\n' + rest;
    out.push(rest);
  }
  return out;
}

/** Truncate a string at `max` chars, appending an ellipsis if needed. */
function truncate(s, max) {
  if (!s) return '';
  const str = String(s);
  if (str.length <= max) return str;
  return str.slice(0, Math.max(1, max - 1)) + '…';
}

/**
 * Build a MarkdownV2 announcement for a tool call. Kept compact so we don't
 * spam the chat — the user only needs to know "the agent is doing X right
 * now". Returns null for events we deliberately omit (Read/Glob/Grep are
 * usually noise).
 */
function formatToolAnnouncement(tool, input) {
  if (!tool) return null;
  const name = String(tool);
  // Skip read-only "looking around" tools — they fire constantly.
  if (/^(Read|Glob|Grep|LS|Ls|WebFetch|WebSearch)$/i.test(name)) return null;

  let detail = '';
  if (input && typeof input === 'object') {
    if (name === 'Bash' && typeof input.command === 'string') {
      detail = truncate(input.command.replace(/\s+/g, ' '), 200);
    } else if ((name === 'Edit' || name === 'Write' || name === 'MultiEdit') && input.file_path) {
      detail = String(input.file_path);
    } else if (name === 'NotebookEdit' && input.notebook_path) {
      detail = String(input.notebook_path);
    }
  }
  const head = '🔧 *' + escapeMarkdownV2(name) + '*';
  if (!detail) return head;
  return head + '\n' + inlineCode(truncate(detail, 240));
}

/** Format a tool result preview (success/failure). Returns null if too noisy. */
function formatToolResult(tool, ok) {
  if (!tool) return null;
  const name = String(tool);
  if (/^(Read|Glob|Grep|LS|Ls|WebFetch|WebSearch)$/i.test(name)) return null;
  if (ok) return null; // Successes are implied by the next assistant turn.
  return '⚠️ *' + escapeMarkdownV2(name) + '* failed';
}

/** Format an error message into MarkdownV2 (with leading icon). */
function formatError(message) {
  const m = truncate(String(message || 'Unknown error'), 500);
  return '❌ ' + escapeMarkdownV2(m);
}

/**
 * Format an assistant turn ("result" event) — the user-facing payload.
 * Returns an array of MarkdownV2 chunks ready to send.
 */
function formatResult(text) {
  const body = String(text || '').trim();
  if (!body) return ['_\\(empty response\\)_'];
  return chunkMarkdownV2(escapeMarkdownV2(body));
}

module.exports = {
  MAX_MESSAGE,
  escapeMarkdownV2,
  escapeCodeBlock,
  codeBlock,
  inlineCode,
  chunkMarkdownV2,
  truncate,
  formatToolAnnouncement,
  formatToolResult,
  formatError,
  formatResult,
};

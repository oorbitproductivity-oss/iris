// lib/telegram/api.js
//
// Thin Telegram Bot API client. Uses node's built-in https — no external deps
// (keeps the iris-app dependency footprint small and audit-friendly).
//
// All methods return promises that resolve to the parsed `result` field of a
// successful response, or reject with an Error whose `code`/`description`
// carry whatever Telegram sent back. Network errors reject with the underlying
// Error.

'use strict';

const https = require('https');

const HOST = 'api.telegram.org';

/**
 * Call a Bot API method by POSTing a JSON body. The `token` is supplied per
 * call rather than baked into a client object so the service can swap tokens
 * (pair / unpair / regenerate) without rebuilding state.
 *
 * @param {string} token        — bot token, e.g. "12345:abcdef..."
 * @param {string} method       — Bot API method name, e.g. "getMe"
 * @param {object} [params]     — request body
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] — request timeout (default 30s; long-polling
 *                                    needs >= Telegram's `timeout` + a few s)
 */
function call(token, method, params = {}, opts = {}) {
  if (!token || typeof token !== 'string') {
    return Promise.reject(new Error('telegram: token required'));
  }
  if (!/^\d{5,}:[\w-]{30,}$/.test(token)) {
    return Promise.reject(new Error('telegram: token looks malformed'));
  }
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 30000;
  const body = JSON.stringify(params || {});
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, ok) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve(ok);
    };
    const req = https.request(
      {
        host: HOST,
        port: 443,
        path: `/bot${token}/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          // Hard ceiling — Telegram replies are tiny in practice; this guards
          // against a runaway upstream sending megabytes of garbage.
          if (buf.length > 4 * 1024 * 1024) {
            req.destroy();
            finish(new Error('telegram: response too large'));
          }
        });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(buf); }
          catch (err) { return finish(new Error('telegram: invalid JSON response')); }
          if (parsed && parsed.ok === true) {
            finish(null, parsed.result);
            return;
          }
          const e = new Error(
            parsed && parsed.description
              ? `telegram: ${parsed.description}`
              : `telegram: http ${res.statusCode}`,
          );
          if (parsed && parsed.error_code) e.code = parsed.error_code;
          if (parsed && parsed.parameters) e.parameters = parsed.parameters;
          finish(e);
        });
      },
    );
    req.on('error', (err) => finish(err));
    req.on('timeout', () => {
      // For long-polling this is normal — Telegram holds the connection open
      // up to `timeout` seconds. Surface as a regular timeout so the caller
      // can retry quietly.
      req.destroy();
      const err = new Error('telegram: request timed out');
      err.code = 'ETIMEDOUT';
      finish(err);
    });
    req.write(body);
    req.end();
  });
}

function getMe(token, opts) {
  return call(token, 'getMe', {}, opts);
}

function getUpdates(token, { offset, timeout, allowed_updates } = {}, opts) {
  const params = {};
  if (Number.isFinite(offset)) params.offset = offset;
  if (Number.isFinite(timeout)) params.timeout = timeout;
  if (Array.isArray(allowed_updates)) params.allowed_updates = allowed_updates;
  // Long polling: keep the socket open a few seconds past Telegram's `timeout`.
  const timeoutMs = (Number.isFinite(timeout) ? timeout : 25) * 1000 + 10000;
  return call(token, 'getUpdates', params, { timeoutMs, ...(opts || {}) });
}

function sendMessage(token, { chat_id, text, parse_mode, reply_to_message_id, disable_web_page_preview } = {}, opts) {
  if (chat_id == null) return Promise.reject(new Error('sendMessage: chat_id required'));
  if (typeof text !== 'string' || !text.length) {
    return Promise.reject(new Error('sendMessage: text required'));
  }
  const params = { chat_id, text };
  if (parse_mode) params.parse_mode = parse_mode;
  if (reply_to_message_id) params.reply_to_message_id = reply_to_message_id;
  if (disable_web_page_preview != null) params.disable_web_page_preview = !!disable_web_page_preview;
  return call(token, 'sendMessage', params, opts);
}

function deleteWebhook(token, opts) {
  // Telegram silently refuses getUpdates while a webhook is set. We always
  // delete on startup so the user doesn't have to remember whether they ever
  // set one (e.g. while experimenting with @BotFather).
  return call(token, 'deleteWebhook', { drop_pending_updates: false }, opts);
}

module.exports = { call, getMe, getUpdates, sendMessage, deleteWebhook };

// lib/providers/base.js
//
// Shared base class + small helpers for provider adapters.

class BaseProvider {
  constructor(config) {
    this.name = config.name;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.model = config.model;
    this.fetchImpl = config.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!this.fetchImpl) {
      throw new Error(`${this.name}: no fetch implementation available; pass fetchImpl in opts`);
    }
  }

  /**
   * Smoke-test connectivity / auth. Should make the smallest cheapest call
   * the provider supports (often a models-list or a 1-token generation).
   * Returns { ok: true, info?: string } or { ok: false, error: string }.
   * Implementations should never throw — convert errors to {ok:false}.
   */
  async test() {
    return { ok: false, error: `${this.name}: test() not implemented` };
  }

  /**
   * Streaming chat. Returns an async iterable of normalized events.
   * Implementations override _stream() instead of this — chat() handles
   * shape normalization and error wrapping.
   */
  chat(req) {
    const self = this;
    return (async function* () {
      try {
        yield* self._stream(req);
      } catch (err) {
        yield { type: 'error', error: err && err.message ? err.message : String(err) };
        yield { type: 'stop', reason: 'error' };
      }
    })();
  }

  // eslint-disable-next-line require-yield
  async *_stream(/* req */) {
    throw new Error(`${this.name}: _stream() not implemented`);
  }
}

/**
 * Walks an SSE-style HTTP body, yielding parsed JSON for each `data: ...`
 * frame. Skips `data: [DONE]` markers. Tolerates incomplete frames at the
 * end of a chunk by buffering.
 */
async function* readSSE(response) {
  if (!response.body) {
    throw new Error('SSE: response.body is missing (was the server reachable?)');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          yield JSON.parse(payload);
        } catch {
          // Skip malformed payloads — some providers emit comments.
        }
      }
    }
  }
}

/** Reads a whole response body as text, surfacing useful HTTP errors. */
async function expectOk(response, providerName) {
  if (response.ok) return response;
  let body = '';
  try {
    body = await response.text();
  } catch {}
  const snippet = body ? `: ${body.slice(0, 240)}` : '';
  throw new Error(`${providerName}: HTTP ${response.status} ${response.statusText}${snippet}`);
}

module.exports = { BaseProvider, readSSE, expectOk };

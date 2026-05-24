// tests/_helpers/mock-fetch.js
//
// Tiny fetch mock that returns a ReadableStream body so provider SSE
// readers can be exercised without a network. Usage:
//
//   const fetchImpl = mockFetch([
//     { match: /messages$/, sse: ['event A', 'event B'] },
//   ]);

'use strict';

function asReadable(text) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(text));
      controller.close();
    },
  });
}

function sseFrames(frames) {
  return frames
    .map((f) => (typeof f === 'string' ? `data: ${f}` : `data: ${JSON.stringify(f)}`))
    .join('\n\n') + '\n\ndata: [DONE]\n\n';
}

function ndjsonFrames(frames) {
  return frames.map((f) => JSON.stringify(f)).join('\n') + '\n';
}

function mockFetch(rules) {
  return async function (url, init) {
    for (const r of rules) {
      const u = String(url);
      const m = (r.match instanceof RegExp) ? r.match.test(u) : u.includes(r.match);
      if (!m) continue;
      const status = r.status || 200;
      const body = r.json
        ? JSON.stringify(r.json)
        : r.sse
          ? sseFrames(r.sse)
          : r.ndjson
            ? ndjsonFrames(r.ndjson)
            : r.text || '';
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? 'OK' : String(status),
        headers: new Map([['content-type', r.sse ? 'text/event-stream' : 'application/json']]),
        async text() { return body; },
        async json() { try { return JSON.parse(body); } catch { return null; } },
        body: r.sse || r.ndjson ? asReadable(body) : null,
      };
    }
    throw new Error(`mockFetch: no rule matched ${url}`);
  };
}

module.exports = { mockFetch, sseFrames, ndjsonFrames };

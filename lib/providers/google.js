// lib/providers/google.js
//
// Adapter for Google AI's Gemini API (generativelanguage.googleapis.com).
// Uses the v1beta `streamGenerateContent` endpoint with SSE.

const { BaseProvider, expectOk } = require('./base.js');

class GoogleProvider extends BaseProvider {
  async test() {
    try {
      const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.model)}?key=${encodeURIComponent(this.apiKey || '')}`;
      const res = await this.fetchImpl(url, { method: 'GET' });
      if (res.ok) return { ok: true, info: `${this.name} reachable (${this.model})` };
      const body = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  }

  async *_stream({ messages, tools, system, options }) {
    const model = (options && options.model) || this.model;
    const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.apiKey || '')}`;

    const body = {
      contents: this._toContents(messages || []),
    };
    if (system) {
      body.systemInstruction = { parts: [{ text: system }] };
    }
    if (tools && tools.length) {
      body.tools = [{
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description || '',
          parameters: t.input_schema || t.parameters || { type: 'object', properties: {} },
        })),
      }];
    }
    if (options && options.maxTokens) {
      body.generationConfig = { ...(body.generationConfig || {}), maxOutputTokens: options.maxTokens };
    }

    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    await expectOk(res, this.name);

    // Gemini streams either SSE frames or JSON-array fragments. We handle SSE here.
    if (!res.body) {
      throw new Error('google: streaming response had no body');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let finishReason = null;

    const handleFrame = function* (json) {
      const cand = json.candidates && json.candidates[0];
      if (!cand) return;
      const parts = (cand.content && cand.content.parts) || [];
      for (const p of parts) {
        if (p.text) {
          yield { type: 'text', delta: p.text };
        } else if (p.functionCall) {
          yield {
            type: 'tool_use',
            id: `call_${Math.random().toString(36).slice(2, 10)}`,
            name: p.functionCall.name,
            input: p.functionCall.args || {},
          };
        }
      }
      if (cand.finishReason) finishReason = cand.finishReason;
      if (json.usageMetadata) {
        yield {
          type: 'usage',
          input_tokens: json.usageMetadata.promptTokenCount || 0,
          output_tokens: json.usageMetadata.candidatesTokenCount || 0,
        };
      }
    };

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
          if (!payload) continue;
          try {
            const json = JSON.parse(payload);
            yield* handleFrame(json);
          } catch { /* skip malformed */ }
        }
      }
    }

    const reasonMap = { STOP: 'end_turn', MAX_TOKENS: 'length', SAFETY: 'error' };
    yield { type: 'stop', reason: reasonMap[finishReason] || 'end_turn' };
  }

  _toContents(messages) {
    // Gemini uses role 'user' and 'model'; merge consecutive same-role turns.
    const out = [];
    for (const m of messages) {
      const role = m.role === 'assistant' ? 'model' : 'user';
      const text = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((b) => (typeof b === 'string' ? b : b.text || '')).join('')
          : String(m.content || '');
      out.push({ role, parts: [{ text }] });
    }
    return out;
  }
}

module.exports = { GoogleProvider };

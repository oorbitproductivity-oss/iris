// lib/providers/ollama.js
//
// Adapter for a local Ollama server. Uses /api/chat with stream=true and
// newline-delimited JSON (not SSE). No API key required.

const { BaseProvider, expectOk } = require('./base.js');

class OllamaProvider extends BaseProvider {
  async test() {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/tags`, { method: 'GET' });
      if (res.ok) return { ok: true, info: `${this.name} reachable at ${this.baseUrl}` };
      return { ok: false, error: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  }

  async *_stream({ messages, tools, system, options }) {
    const msgs = (system ? [{ role: 'system', content: system }] : [])
      .concat((messages || []).map((m) => ({
        role: m.role,
        content: typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((b) => (typeof b === 'string' ? b : b.text || '')).join('')
            : String(m.content || ''),
      })));

    const body = {
      model: (options && options.model) || this.model,
      stream: true,
      messages: msgs,
    };
    if (tools && tools.length) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.input_schema || t.parameters || { type: 'object', properties: {} },
        },
      }));
    }

    const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    await expectOk(res, this.name);

    if (!res.body) throw new Error('ollama: response had no body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let json;
        try { json = JSON.parse(line); } catch { continue; }
        if (json.message) {
          if (json.message.content) {
            yield { type: 'text', delta: json.message.content };
          }
          if (Array.isArray(json.message.tool_calls)) {
            for (const tc of json.message.tool_calls) {
              yield {
                type: 'tool_use',
                id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
                name: tc.function && tc.function.name,
                input: (tc.function && tc.function.arguments) || {},
              };
            }
          }
        }
        if (json.done) {
          yield {
            type: 'usage',
            input_tokens: json.prompt_eval_count || 0,
            output_tokens: json.eval_count || 0,
          };
          yield { type: 'stop', reason: 'end_turn' };
        }
      }
    }
  }
}

module.exports = { OllamaProvider };

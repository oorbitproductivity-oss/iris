// lib/providers/openai.js
//
// Adapter for OpenAI's Chat Completions streaming API.
// https://platform.openai.com/docs/api-reference/chat

const { BaseProvider, readSSE, expectOk } = require('./base.js');

class OpenAIProvider extends BaseProvider {
  async test() {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/models`, {
        method: 'GET',
        headers: { authorization: `Bearer ${this.apiKey || ''}` },
      });
      if (res.ok) return { ok: true, info: `${this.name} reachable` };
      const body = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  }

  async *_stream({ messages, tools, system, options }) {
    const msgs = (system ? [{ role: 'system', content: system }] : []).concat(
      this._normalizeMessages(messages || [])
    );
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
    if (options && options.maxTokens) body.max_tokens = options.maxTokens;
    if (options && typeof options.temperature === 'number') body.temperature = options.temperature;

    const res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey || ''}`,
      },
      body: JSON.stringify(body),
    });
    await expectOk(res, this.name);

    // OpenAI Chat Completions streams `delta`s with optional `tool_calls`.
    const toolBuffers = new Map(); // index -> { id, name, args }
    let finishReason = null;
    for await (const frame of readSSE(res)) {
      const choice = frame.choices && frame.choices[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (delta.content) {
        yield { type: 'text', delta: String(delta.content) };
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolBuffers.has(idx)) {
            toolBuffers.set(idx, { id: tc.id || `tool_${idx}`, name: '', args: '' });
          }
          const slot = toolBuffers.get(idx);
          if (tc.id) slot.id = tc.id;
          if (tc.function && tc.function.name) slot.name = tc.function.name;
          if (tc.function && tc.function.arguments) slot.args += tc.function.arguments;
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
      if (frame.usage) {
        yield {
          type: 'usage',
          input_tokens: frame.usage.prompt_tokens || 0,
          output_tokens: frame.usage.completion_tokens || 0,
        };
      }
    }

    for (const slot of toolBuffers.values()) {
      let input = {};
      try { input = slot.args ? JSON.parse(slot.args) : {}; } catch {}
      yield { type: 'tool_use', id: slot.id, name: slot.name, input };
    }

    const reasonMap = { stop: 'end_turn', length: 'length', tool_calls: 'tool_use', function_call: 'tool_use' };
    yield { type: 'stop', reason: reasonMap[finishReason] || 'end_turn' };
  }

  _normalizeMessages(messages) {
    return messages.map((m) => {
      if (typeof m.content === 'string') return { role: m.role, content: m.content };
      if (Array.isArray(m.content)) {
        // Best-effort flatten of Anthropic-style blocks into a string.
        const text = m.content
          .filter((b) => b.type === 'text' || typeof b === 'string')
          .map((b) => (typeof b === 'string' ? b : b.text || ''))
          .join('');
        return { role: m.role, content: text };
      }
      return { role: m.role, content: String(m.content || '') };
    });
  }
}

module.exports = { OpenAIProvider };

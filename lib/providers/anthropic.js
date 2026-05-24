// lib/providers/anthropic.js
//
// Adapter for Anthropic's Messages API. Streams via SSE.
// https://docs.claude.com/en/api/messages

const { BaseProvider, readSSE, expectOk } = require('./base.js');

class AnthropicProvider extends BaseProvider {
  async test() {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      if (res.ok) return { ok: true, info: `${this.name} reachable (${this.model})` };
      const body = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  }

  _headers() {
    return {
      'content-type': 'application/json',
      'x-api-key': this.apiKey || '',
      'anthropic-version': '2023-06-01',
    };
  }

  async *_stream({ messages, tools, system, options }) {
    const body = {
      model: (options && options.model) || this.model,
      max_tokens: (options && options.maxTokens) || 4096,
      stream: true,
      messages: this._normalizeMessages(messages),
    };
    if (system) body.system = system;
    if (tools && tools.length) body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description || '',
      input_schema: t.input_schema || t.parameters || { type: 'object', properties: {} },
    }));

    const res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
    });
    await expectOk(res, this.name);

    // SSE frames are well-structured 'content_block_*' events.
    const toolUses = new Map();
    for await (const evt of readSSE(res)) {
      const type = evt.type;
      if (type === 'content_block_start' && evt.content_block) {
        const cb = evt.content_block;
        if (cb.type === 'tool_use') {
          toolUses.set(evt.index, { id: cb.id, name: cb.name, inputJson: '' });
        }
      } else if (type === 'content_block_delta' && evt.delta) {
        const d = evt.delta;
        if (d.type === 'text_delta' && d.text) {
          yield { type: 'text', delta: d.text };
        } else if (d.type === 'input_json_delta') {
          const slot = toolUses.get(evt.index);
          if (slot) slot.inputJson += d.partial_json || '';
        }
      } else if (type === 'content_block_stop') {
        const slot = toolUses.get(evt.index);
        if (slot) {
          let input = {};
          try { input = slot.inputJson ? JSON.parse(slot.inputJson) : {}; } catch {}
          yield { type: 'tool_use', id: slot.id, name: slot.name, input };
          toolUses.delete(evt.index);
        }
      } else if (type === 'message_delta' && evt.usage) {
        yield { type: 'usage', input_tokens: evt.usage.input_tokens || 0, output_tokens: evt.usage.output_tokens || 0 };
      } else if (type === 'message_stop') {
        yield { type: 'stop', reason: (evt['amazon-bedrock-invocationMetrics'] && 'end_turn') || 'end_turn' };
      } else if (type === 'error') {
        yield { type: 'error', error: (evt.error && evt.error.message) || 'unknown' };
        yield { type: 'stop', reason: 'error' };
      }
    }
  }

  _normalizeMessages(messages) {
    return (messages || []).map((m) => {
      if (typeof m.content === 'string') return { role: m.role, content: m.content };
      if (Array.isArray(m.content)) return { role: m.role, content: m.content };
      return { role: m.role, content: String(m.content || '') };
    });
  }
}

module.exports = { AnthropicProvider };

# Provider: OpenAI-compatible (LM Studio, vLLM, Together, Groq, etc.)

Any service that speaks the OpenAI Chat Completions wire format works
through this adapter — just point it at the right base URL.

## Setup

```bash
iris key add openai-compatible          # paste the token (or anything if local-only)
```

Then configure the base URL in `settings.json` or pass it programmatically:

```js
const { createProvider } = require('./lib/providers');
const p = createProvider({
  name: 'openai-compatible',
  apiKey: process.env.LMSTUDIO_KEY || 'anything',
  baseUrl: 'http://localhost:1234',     // LM Studio default
  model: 'qwen2.5-coder-7b',
});
```

## Tested against

- LM Studio (`http://localhost:1234`)
- vLLM (`http://localhost:8000`)
- Together AI (`https://api.together.xyz`)
- Groq (`https://api.groq.com/openai`)
- Anyscale, DeepInfra, Fireworks, etc.

## Notes

If the upstream emits non-standard fields, the adapter drops them —
only the canonical `choices[].delta.content` and
`choices[].delta.tool_calls` paths are read.

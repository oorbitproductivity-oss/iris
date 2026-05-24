# Provider: OpenRouter

OpenRouter speaks the OpenAI Chat Completions wire format with two
recommended extra headers (`HTTP-Referer`, `X-Title`). Iris Code's
adapter wraps the OpenAI adapter's `fetch` to inject them automatically.

```bash
iris key add openrouter
iris model set openrouter:anthropic/claude-sonnet-4
iris key test openrouter
```

## Notes

- The model id is the full OpenRouter slug, e.g.
  `anthropic/claude-sonnet-4`, `meta-llama/llama-3.1-70b-instruct`,
  `mistralai/mistral-large`.
- Override the referrer and product title via the `Provider` config:
  ```js
  createProvider({ name: 'openrouter', apiKey: '...', referrer: 'https://example.com', title: 'My App' });
  ```

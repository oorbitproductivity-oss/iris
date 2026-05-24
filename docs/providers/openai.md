# Provider: OpenAI

Streams via the Chat Completions API.

```bash
iris key add openai
iris model set openai:gpt-4o
iris key test openai
```

## Notes

- Tool-calls accrete across stream chunks (OpenAI sends `arguments` in
  pieces). The adapter buffers per-index and emits a single
  `{type:'tool_use'}` event when the stream ends. If you build a tool
  on top of this, expect *one* event per call, not partials.
- `--no-color` env or any non-TTY stdout disables ANSI colors in the
  CLI output.

# Provider: Ollama (local)

Run Iris Code against a local LLM with no API key and no internet.

## Setup

1. [Install Ollama](https://ollama.com).
2. Pull a model you want:
   ```bash
   ollama pull llama3.1:8b
   ```
3. Tell Iris Code:
   ```bash
   iris model set ollama:llama3.1:8b
   ```

No `key add` step — Ollama runs on `http://127.0.0.1:11434` and takes
no auth. Override the base URL by passing `--base-url` (CLI) or
`baseUrl` (programmatic) if your Ollama lives elsewhere.

## Notes

- Stream format is NDJSON, not SSE. The adapter parses
  newline-delimited JSON.
- `iris key test ollama` hits `GET /api/tags` to confirm the daemon is
  reachable and lists available models.
- Cost guardrail is a no-op for Ollama (price table is zero) — local
  runs are free.

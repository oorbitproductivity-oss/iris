# Provider: Google (Gemini)

Streams via `generativelanguage.googleapis.com`'s
`streamGenerateContent` endpoint with `alt=sse`.

```bash
iris key add google
iris model set google:gemini-2.5-pro
iris key test google
```

## Notes

- Auth is via `?key=` query parameter, not a Bearer header. The adapter
  handles this; you don't need to do anything different.
- Roles: Gemini uses `user` and `model`, not `user`/`assistant`. The
  adapter translates on the way in.
- Tool calls come through as `functionCall` in the candidate parts; the
  adapter normalizes them to `{type:'tool_use'}` events.

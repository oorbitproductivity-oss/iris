# Browser testing

Iris Code's Phase-6 browser-test loop drives a real browser through the
[Claude in Chrome](https://docs.claude.com) extension. This is the only
browser-automation path supported in v1.

## Setup

1. **Install Claude in Chrome** in your Chrome browser. Iris Code
   does not bundle it; it talks to your existing extension over its
   public MCP/RPC surface.
2. **Configure an Anthropic API key** in Iris Code:
   ```bash
   iris key add anthropic
   ```
   The feature is gated on this — the runner returns an error if no
   Anthropic key is configured.
3. **Approve domains** on first run. The default allowlist is just
   `localhost`, `127.0.0.1`, `0.0.0.0`, `::1`. Add more in Settings →
   Browser, or programmatically via `runner.addAllowedDomain('example.test')`.

## Triggering a run

CLI:

```bash
iris chat
> /test-in-browser  build a todo list at http://localhost:3000 and add two items
```

GUI: click **Test in browser** on the chat pane.

## What a run looks like

The runner takes a task object:

```js
{
  url: 'http://localhost:3000',
  steps: [
    { action: 'navigate', url: 'http://localhost:3000' },
    { action: 'type',     selector: '#todo-input', text: 'milk' },
    { action: 'click',    selector: '#add' },
    { action: 'read',     selector: '#list li' },
    { action: 'screenshot' },
    { action: 'console',  pattern: 'error' },
  ],
  expect: [
    { selector: '#list li', contains: 'milk' },
  ],
}
```

The result is always one of:

```js
{ ok: true,  result: { traces, expectations, ok: true } }
{ ok: false, error: '<message>', recoverable: true|false }
```

`recoverable: true` means the runner already retried with exponential
backoff (default 3 attempts) and still failed — your agent can choose
to surface the error or retry yet again. `recoverable: false` means
something is mis-configured (no Anthropic key, blocked domain) and
retrying won't help.

## The seeded-bug fixture

`tests/sample-app/` is a minimal todo page with a deliberate bug:
clicking **Add** appends the input value to the list but does not clear
the input, so adding a second item concatenates onto the first.

The Phase-6 exit criterion is that Iris Code can:

1. Read `tests/sample-app/`,
2. Identify the bug (the missing `input.value = ''` line),
3. Launch Chrome via the extension,
4. Drive the UI to observe the bug,
5. Propose a fix.

Run the (mocked) browser-runner tests with:

```bash
node tests/browser.test.js
```

End-to-end runs against the real extension are gated behind the
`IRIS_E2E_BROWSER=1` env var so they never burn API credits on every
push.

## Allowlist policy

Iris Code refuses to navigate to a domain outside the allowlist. This
is enforced in `BrowserTestRunner.isHostAllowed` and is not optional —
the only way to extend it is via `addAllowedDomain()` or the Settings
UI. The default localhost-only policy means a misconfigured prompt
cannot accidentally have the agent log into your bank.

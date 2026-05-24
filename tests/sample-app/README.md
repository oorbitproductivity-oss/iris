# tests/sample-app

A tiny single-page web app with a deliberately seeded bug, used by the
Phase-6 browser test fixture. The bug: clicking the "Add" button on the
todo list appends the input value but does **not** clear the input,
breaking the "add two todos in a row" flow.

The Phase-6 exit criterion is that Iris Code can:

1. Read this folder, identify the bug,
2. Launch Chrome via the Claude in Chrome extension,
3. Drive the UI, observe the bug,
4. Propose a fix.

Files:

- `index.html` — the page.
- `app.js`     — the buggy implementation.
- `expected.test.js` — a node-runnable assertion that, after a fix, the
  input is cleared on add.

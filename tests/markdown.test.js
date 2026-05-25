// tests/markdown.test.js — Markdown renderer tests, focused on the new
// <iris-web-result> rich-card extraction path. The renderer ships as an
// ES module under app/js/lib/markdown.js, so we copy it to a temp .mjs
// file and dynamic-import it (the project itself isn't "type": "module").
//
// Run: node tests/markdown.test.js
//
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

async function loadRenderer() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'js', 'lib', 'markdown.js'),
    'utf8'
  );
  const tmp = path.join(
    os.tmpdir(),
    `iris-markdown-${process.pid}-${Date.now()}.mjs`
  );
  fs.writeFileSync(tmp, src, 'utf8');
  try {
    const mod = await import(pathToFileURL(tmp).href);
    return mod;
  } finally {
    // Best-effort cleanup; tmpfile is harmless if left behind.
    try { fs.unlinkSync(tmp); } catch {}
  }
}

async function testCardRoundTrip(renderMarkdown) {
  const input =
    'Here is a fact. <iris-web-result url="https://example.com/path" ' +
    'title="Example Page">hello world snippet</iris-web-result> Done.';
  const html = renderMarkdown(input);
  assert.ok(
    /<a\s+class="web-card"/.test(html),
    'expected an <a class="web-card"> anchor, got:\n' + html
  );
  assert.ok(
    /href="https:\/\/example\.com\/path"/.test(html),
    'href should point at the validated URL'
  );
  assert.ok(
    /<img\s+class="web-card-favicon"\s+src="https:\/\/www\.google\.com\/s2\/favicons[^"]*"/.test(html),
    'favicon img should hit google.com/s2/favicons'
  );
  assert.ok(
    /domain_url=https%3A%2F%2Fexample\.com%2Fpath/.test(html),
    'favicon URL should include the encoded citation URL'
  );
  assert.ok(
    html.includes('Example Page'),
    'card should render the supplied title'
  );
  assert.ok(
    html.includes('hello world snippet'),
    'card should render the snippet body'
  );
  assert.ok(
    html.includes('example.com'),
    'card should render the hostname'
  );
}

async function testJavascriptUrlIsSanitized(renderMarkdown) {
  const input =
    '<iris-web-result url="javascript:alert(1)" title="Evil">x</iris-web-result>';
  const html = renderMarkdown(input);
  assert.ok(
    !/href="javascript:/i.test(html),
    'must NEVER produce a javascript: href, got:\n' + html
  );
  assert.ok(
    !/<a\s+class="web-card"/.test(html),
    'should not render as a card at all, got:\n' + html
  );
}

async function testDataAndFileUrlsRejected(renderMarkdown) {
  // Note: leading/trailing whitespace is trimmed before validation (scraped
  // citations often come with stray whitespace and that's expected), so it
  // is NOT a rejection case. Embedded control characters / newlines ARE
  // rejected — those are classic header-splitting vectors.
  for (const bad of [
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'vbscript:msgbox(1)',
    'https://has\nnewline.com',
    'https://has\rcarriage.com',
    'ftp://wrong-protocol.com',
  ]) {
    const input = `<iris-web-result url="${bad}" title="x">y</iris-web-result>`;
    const html = renderMarkdown(input);
    assert.ok(
      !/<a\s+class="web-card"/.test(html),
      `URL ${JSON.stringify(bad)} must not render as a card, got:\n${html}`
    );
  }
}

async function testMultipleCardsSurvive(renderMarkdown) {
  const input = [
    'Three sources to read:',
    '<iris-web-result url="https://a.example/one" title="One">first</iris-web-result>',
    '<iris-web-result url="https://b.example/two" title="Two">second</iris-web-result>',
    '<iris-web-result url="https://c.example/three" title="Three">third</iris-web-result>',
    'Done.',
  ].join('\n');
  const html = renderMarkdown(input);
  const cardCount = (html.match(/<a\s+class="web-card"/g) || []).length;
  assert.strictEqual(cardCount, 3, `expected 3 cards, got ${cardCount} in:\n${html}`);
  assert.ok(/href="https:\/\/a\.example\/one"/.test(html));
  assert.ok(/href="https:\/\/b\.example\/two"/.test(html));
  assert.ok(/href="https:\/\/c\.example\/three"/.test(html));
}

async function testPlainMarkdownLinksUnaffected(renderMarkdown) {
  // A regular markdown link should NOT become a card — only the custom tag
  // gets the rich treatment. Existing link handling (data-url attr) must
  // continue to work.
  const input = 'See [the docs](https://example.com/docs) for more.';
  const html = renderMarkdown(input);
  assert.ok(
    !/<a[^>]*\bclass="web-card"/.test(html),
    'plain markdown links must not be promoted to cards, got:\n' + html
  );
  assert.ok(
    /data-url="https:\/\/example\.com\/docs"/.test(html),
    'plain markdown link should still render with data-url, got:\n' + html
  );
}

async function testAttributeInjectionEscape(renderMarkdown) {
  // A title containing a closing quote + script tag must not break out of
  // the title attribute or inject HTML into the card body.
  const input =
    '<iris-web-result url="https://ok.example" title=\'evil"><script>alert(1)</script>\'>snippet</iris-web-result>';
  const html = renderMarkdown(input);
  assert.ok(
    !/<script>/i.test(html),
    'must HTML-escape script tags from the title, got:\n' + html
  );
}

async function testCodeBlocksStillWork(renderMarkdown) {
  // Sanity check: fenced code blocks survive alongside web cards in the
  // same message (the two stash passes must not collide).
  const input =
    '```js\nconst x = 1;\n```\n' +
    '<iris-web-result url="https://ok.example" title="OK">hi</iris-web-result>';
  const html = renderMarkdown(input);
  assert.ok(html.includes('<pre><code'), 'fenced block should render');
  assert.ok(/<a\s+class="web-card"/.test(html), 'card should also render');
}

async function run() {
  const { renderMarkdown } = await loadRenderer();
  const tests = [
    ['card round-trip produces anchor + favicon + body', () => testCardRoundTrip(renderMarkdown)],
    ['javascript: URL is sanitized to plain text', () => testJavascriptUrlIsSanitized(renderMarkdown)],
    ['data:, file:, vbscript:, whitespace URLs rejected', () => testDataAndFileUrlsRejected(renderMarkdown)],
    ['multiple cards in one message all survive', () => testMultipleCardsSurvive(renderMarkdown)],
    ['plain markdown links are NOT converted', () => testPlainMarkdownLinksUnaffected(renderMarkdown)],
    ['title attribute HTML is escaped', () => testAttributeInjectionEscape(renderMarkdown)],
    ['fenced code blocks coexist with cards', () => testCodeBlocksStillWork(renderMarkdown)],
  ];
  let passed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}`); console.error('   ', err && err.stack ? err.stack : err); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
}

run();

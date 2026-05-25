// tests/slash-commands.test.js — Custom slash command renderer + import validator.
// Run: node tests/slash-commands.test.js
//
// The slash-commands module is ESM and imported via dynamic import(). We only
// touch the pure-logic helpers (renderTemplate, validateUserCommand,
// parseImportedCommands) — never anything that needs the DOM.

'use strict';

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

const MODULE_URL = pathToFileURL(
  path.join(__dirname, '..', 'app', 'js', 'ui', 'slash-commands.js'),
).href;

async function loadModule() {
  return await import(MODULE_URL);
}

async function testRenderTemplateBasicSelectionSubstitution() {
  const { renderTemplate } = await loadModule();
  const r = renderTemplate('Summarize: {{selection}}', { selection: 'hello world' });
  assert.strictEqual(r.text, 'Summarize: hello world');
  assert.strictEqual(r.cursor, null, 'no {{cursor}} marker → cursor is null');
}

async function testRenderTemplateEmptySelection() {
  const { renderTemplate } = await loadModule();
  const r = renderTemplate('Wrap >>>{{selection}}<<<', {});
  assert.strictEqual(r.text, 'Wrap >>><<<');
}

async function testRenderTemplateCursorMarker() {
  const { renderTemplate } = await loadModule();
  // The default cursor substitution is empty string. Caret offset = index of
  // the {{cursor}} marker in the post-selection text.
  const r = renderTemplate('Hi {{selection}}|{{cursor}} end', { selection: 'X' });
  assert.strictEqual(r.text, 'Hi X| end');
  assert.strictEqual(r.cursor, 'Hi X|'.length, 'cursor lands at the marker position');
}

async function testRenderTemplateBothMarkers() {
  const { renderTemplate } = await loadModule();
  const r = renderTemplate('Q: {{selection}}\nA: {{cursor}}', { selection: 'why' });
  assert.strictEqual(r.text, 'Q: why\nA: ');
  assert.strictEqual(r.cursor, 'Q: why\nA: '.length);
}

async function testRenderTemplateMultipleCursorMarkersUsesFirstForCaret() {
  const { renderTemplate } = await loadModule();
  // Multiple {{cursor}} tokens is a user mistake; we still substitute cleanly
  // and place the caret at the FIRST marker position.
  const r = renderTemplate('a {{cursor}} b {{cursor}}', {});
  assert.strictEqual(r.text, 'a  b ');
  assert.strictEqual(r.cursor, 'a '.length);
}

async function testRenderTemplateNonString() {
  const { renderTemplate } = await loadModule();
  const r = renderTemplate(null);
  assert.strictEqual(r.text, '');
  assert.strictEqual(r.cursor, null);
}

async function testValidateUserCommandHappyPath() {
  const { validateUserCommand } = await loadModule();
  const err = validateUserCommand({
    trigger: 'standup',
    name: 'Daily standup',
    template: 'Give me a 3-bullet standup.',
  });
  assert.strictEqual(err, null);
}

async function testValidateUserCommandMissingTrigger() {
  const { validateUserCommand } = await loadModule();
  const err = validateUserCommand({ trigger: '', name: 'x', template: 'y' });
  assert.match(err, /Missing trigger/);
}

async function testValidateUserCommandBadTriggerSyntax() {
  const { validateUserCommand } = await loadModule();
  const err = validateUserCommand({ trigger: '1bad', name: 'x', template: 'y' });
  assert.match(err, /Invalid trigger/);
  const err2 = validateUserCommand({ trigger: 'has space', name: 'x', template: 'y' });
  assert.match(err2, /Invalid trigger/);
}

async function testValidateUserCommandDuplicateTrigger() {
  const { validateUserCommand } = await loadModule();
  const err = validateUserCommand(
    { trigger: 'foo', name: 'x', template: 'y' },
    { existingTriggers: ['FOO'] },
  );
  assert.match(err, /Duplicate trigger/, 'duplicate detection is case-insensitive');
}

async function testValidateUserCommandMissingTemplate() {
  const { validateUserCommand } = await loadModule();
  const err = validateUserCommand({ trigger: 'foo', name: 'x', template: '' });
  assert.match(err, /Missing template/);
}

async function testParseImportedCommandsAcceptsBareArray() {
  const { parseImportedCommands } = await loadModule();
  const result = parseImportedCommands([
    { trigger: 'standup', name: 'Standup', template: 'go' },
    { trigger: 'fix-pr', name: 'Fix PR', template: 'fix the PR', description: 'desc' },
  ]);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.commands.length, 2);
  assert.strictEqual(result.commands[0].trigger, 'standup');
  assert.strictEqual(result.commands[1].description, 'desc');
  assert.ok(result.commands[0].id, 'auto-generated id');
}

async function testParseImportedCommandsAcceptsWrappedObject() {
  const { parseImportedCommands } = await loadModule();
  const result = parseImportedCommands({
    commands: [{ trigger: 'a', name: 'A', template: 'x' }],
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.commands.length, 1);
}

async function testParseImportedCommandsRejectsNonArray() {
  const { parseImportedCommands } = await loadModule();
  const result = parseImportedCommands({ foo: 'bar' });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.length >= 1);
}

async function testParseImportedCommandsSkipsInvalidEntries() {
  const { parseImportedCommands } = await loadModule();
  const result = parseImportedCommands([
    { trigger: 'good', name: 'Good', template: 'x' },
    { trigger: '', name: 'bad', template: 'y' },           // missing trigger
    { trigger: 'bad space', name: 'b', template: 'z' },    // bad pattern
    { trigger: 'good', name: 'Dup', template: 'q' },       // duplicate
  ]);
  assert.strictEqual(result.ok, false, 'duplicates + bad entries → ok:false');
  assert.strictEqual(result.commands.length, 1, 'only the first valid entry survives');
  assert.strictEqual(result.commands[0].trigger, 'good');
  assert.strictEqual(result.errors.length, 3);
}

async function run() {
  const tests = [
    ['renderTemplate: substitutes {{selection}}', testRenderTemplateBasicSelectionSubstitution],
    ['renderTemplate: empty selection → empty substitution', testRenderTemplateEmptySelection],
    ['renderTemplate: {{cursor}} returns caret offset', testRenderTemplateCursorMarker],
    ['renderTemplate: handles selection + cursor together', testRenderTemplateBothMarkers],
    ['renderTemplate: multiple {{cursor}} markers → first wins for caret', testRenderTemplateMultipleCursorMarkersUsesFirstForCaret],
    ['renderTemplate: non-string input is safe', testRenderTemplateNonString],
    ['validateUserCommand: happy path', testValidateUserCommandHappyPath],
    ['validateUserCommand: missing trigger', testValidateUserCommandMissingTrigger],
    ['validateUserCommand: bad trigger syntax', testValidateUserCommandBadTriggerSyntax],
    ['validateUserCommand: duplicate trigger (case-insensitive)', testValidateUserCommandDuplicateTrigger],
    ['validateUserCommand: missing template', testValidateUserCommandMissingTemplate],
    ['parseImportedCommands: bare array', testParseImportedCommandsAcceptsBareArray],
    ['parseImportedCommands: { commands: [...] } wrapper', testParseImportedCommandsAcceptsWrappedObject],
    ['parseImportedCommands: rejects non-array root', testParseImportedCommandsRejectsNonArray],
    ['parseImportedCommands: skips invalid + dedupes triggers', testParseImportedCommandsSkipsInvalidEntries],
  ];
  let passed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ok ${name}`); passed++; }
    catch (err) {
      console.error(`  FAIL ${name}`);
      console.error('   ', err && err.stack ? err.stack : err);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed}/${tests.length} passed`);
}

run();

// lib/cli/skills-cmd.js — `iris skills list|show|edit|rm|new|reflect`

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ui = require('./ui.js');
const { Skills } = require('../skills');

async function run(args) {
  const sub = args._[1] || 'list';
  const s = new Skills({ dataDir: ui.ensureDataDir() });

  if (sub === 'list') {
    const all = s.list();
    if (!all.length) { ui.info('(no skills yet — they\'re learned during agentic turns or written by hand)'); return; }
    for (const sk of all) ui.out(`  ${ui.gold(sk.name.padEnd(32))} ${ui.dim('[' + (sk.tags || []).join(',') + ']')}  ${sk.description || ''}`);
    return;
  }
  if (sub === 'show') {
    const name = args._[2];
    if (!name) { ui.err('usage: iris skills show <name>'); process.exit(2); }
    const sk = s.load(name);
    if (!sk) { ui.err(`no skill "${name}"`); process.exit(2); }
    ui.out(fs.readFileSync(sk.file, 'utf8'));
    return;
  }
  if (sub === 'edit') {
    const name = args._[2];
    if (!name) { ui.err('usage: iris skills edit <name>'); process.exit(2); }
    const sk = s.load(name);
    if (!sk) { ui.err(`no skill "${name}"`); process.exit(2); }
    const editor = process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
    const child = spawn(editor, [sk.file], { stdio: 'inherit' });
    await new Promise((r) => child.on('close', r));
    return;
  }
  if (sub === 'rm') {
    const name = args._[2];
    if (!name) { ui.err('usage: iris skills rm <name>'); process.exit(2); }
    const ok = s.remove(name);
    if (ok) ui.ok('removed'); else ui.err('not found');
    return;
  }
  if (sub === 'new') {
    const name = args._[2];
    if (!name) { ui.err('usage: iris skills new <name>'); process.exit(2); }
    const desc = await ui.prompt('description: ');
    const tags = (await ui.prompt('tags (comma-separated): ')).split(',').map((t) => t.trim()).filter(Boolean);
    ui.info('opening editor for the body. Save and quit to commit.');
    const editor = process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
    const dir = path.join(ui.ensureDataDir(), 'skills');
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.draft-${Date.now()}.md`);
    fs.writeFileSync(tmp, '# write the procedure body here\n', 'utf8');
    const child = spawn(editor, [tmp], { stdio: 'inherit' });
    await new Promise((r) => child.on('close', r));
    const body = fs.readFileSync(tmp, 'utf8');
    fs.unlinkSync(tmp);
    s.save({ name, description: desc, tags, body });
    ui.ok('saved');
    return;
  }
  if (sub === 'reflect') {
    ui.info('reflect is invoked automatically after agentic turns. Use `iris skills new` to author by hand.');
    return;
  }
  ui.err('usage: iris skills list|show <name>|edit <name>|rm <name>|new <name>');
  process.exit(2);
}

module.exports = { run };

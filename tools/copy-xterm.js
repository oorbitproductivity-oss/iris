// tools/copy-xterm.js
//
// Iris doesn't use a bundler, so the renderer can't `import "xterm"` from
// node_modules. We copy the published ES module + CSS + the fit addon
// into app/js/lib/xterm/ so the renderer can `import "./xterm/xterm.js"`
// directly. Re-runnable; idempotent; non-fatal when node_modules isn't
// populated (so `npm install --omit=optional` / fresh clones don't error
// the install).
//
// Wired up via `postinstall` in package.json.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NM = path.join(ROOT, 'node_modules');
const DEST = path.join(ROOT, 'app', 'js', 'lib', 'xterm');

const COPIES = [
  // [source-in-node_modules, destination-filename]
  ['xterm/lib/xterm.js', 'xterm.js'],
  ['xterm/css/xterm.css', 'xterm.css'],
  ['xterm-addon-fit/lib/xterm-addon-fit.js', 'xterm-addon-fit.js'],
];

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function ensureDir(d) {
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
}

function safeCopy(src, dst) {
  if (!exists(src)) {
    console.warn(`[copy-xterm] skip (missing): ${path.relative(ROOT, src)}`);
    return false;
  }
  try {
    fs.copyFileSync(src, dst);
    console.log(`[copy-xterm] ${path.relative(ROOT, src)} -> ${path.relative(ROOT, dst)}`);
    return true;
  } catch (err) {
    console.warn(`[copy-xterm] failed to copy ${src}: ${err.message || err}`);
    return false;
  }
}

function main() {
  if (!exists(NM)) {
    console.log('[copy-xterm] node_modules/ missing — nothing to copy. (Run `npm install` first.)');
    return;
  }
  ensureDir(DEST);
  let copied = 0;
  for (const [rel, dstName] of COPIES) {
    const src = path.join(NM, rel);
    const dst = path.join(DEST, dstName);
    if (safeCopy(src, dst)) copied++;
  }
  if (copied === 0) {
    console.warn('[copy-xterm] no files copied — the terminal pane will self-disable until xterm is installed.');
  } else {
    console.log(`[copy-xterm] copied ${copied}/${COPIES.length} vendor files into ${path.relative(ROOT, DEST)}`);
  }
}

main();

// lib/cli/ui.js — small shared terminal helpers (color, prompt, paths).

'use strict';

const os = require('os');
const path = require('path');
const readline = require('readline');

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));

const dim   = (s) => c('2', s);
const bold  = (s) => c('1', s);
const gold  = (s) => c('33', s);
const cyan  = (s) => c('36', s);
const red   = (s) => c('31', s);
const green = (s) => c('32', s);
const blue  = (s) => c('34', s);
const grey  = (s) => c('90', s);

function out(s = '') { process.stdout.write(s + '\n'); }
function err(s) { process.stderr.write(`${red('error')} ${s}\n`); }
function info(s) { process.stdout.write(`${dim(s)}\n`); }
function ok(s) { process.stdout.write(`${green('✓')} ${s}\n`); }
function warn(s) { process.stdout.write(`${gold('!')} ${s}\n`); }

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => { rl.close(); resolve(ans); });
  });
}

function dataDir() {
  if (process.env.IRIS_DATA_DIR) return process.env.IRIS_DATA_DIR;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'iris-code');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'iris-code');
  }
  return path.join(os.homedir(), '.config', 'iris-code');
}

function sessionsDir() {
  const p = path.join(dataDir(), 'cli-sessions');
  require('fs').mkdirSync(p, { recursive: true });
  return p;
}

function ensureDataDir() {
  const d = dataDir();
  require('fs').mkdirSync(d, { recursive: true });
  return d;
}

function rule(ch = '─', width = 60) {
  return grey(ch.repeat(width));
}

module.exports = {
  dim, bold, gold, cyan, red, green, blue, grey,
  out, err, info, ok, warn, prompt,
  dataDir, sessionsDir, ensureDataDir, rule,
  COLOR,
};

// lib/cli/chat.js — `iris chat` long-running power-user REPL.
//
// One persistent `claude` subprocess powers the whole session (stream-json
// IPC), so follow-ups are instant and the conversation actually carries
// across turns. Permissions default to bypass; Ctrl+C interrupts the
// current turn without killing the session.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawn } = require('child_process');

const ui = require('./ui.js');
const { ClaudeSession, findLastSessionFor } = require('./session.js');
const { Store } = require('../store.js');
const { Router } = require('../router');
const { Memory } = require('../memory');
const { Journal } = require('../memory/journal.js');
const { Skills } = require('../skills');

async function run(args) {
  const dataDir = ui.ensureDataDir();
  const store = new Store(dataDir);

  // ── session config ─────────────────────────────────────────────────────

  const session = {
    id: crypto.randomUUID(),
    cwd: args.flags.cwd ? path.resolve(args.flags.cwd) : process.cwd(),
    model: args.flags.model || null,
    effort: args.flags.effort || 'high',
    permissionMode: args.flags['no-bypass'] ? 'acceptEdits'
      : args.flags.plan ? 'plan'
      : 'bypassPermissions',
    yolo: !!args.flags.yolo,
    sessionId: args.flags.resume || null,   // resume claude session id if given
    addDirs: args.flags['add-dir']
      ? (Array.isArray(args.flags['add-dir']) ? args.flags['add-dir'] : [args.flags['add-dir']])
      : null,
    hermes: !!args.flags.hermes,
    noMemory: !!args.flags['no-memory'],
    skillsFilter: args.flags.skills || null,
    json: !!args.flags.json,
    routeOverride: args.flags.manual ? 'manual'
      : args.flags.quick ? 'quick-tool'
      : args.flags.agentic ? 'agentic'
      : null,
    transcript: [],
    claudeSessionId: null,
    startedAt: Date.now(),
  };

  // Auto-resume: if we already have a session for this cwd and the user
  // didn't pass --resume or --new, offer to pick up where they left off.
  if (!session.sessionId && !args.flags.new) {
    const last = findLastSessionFor(session.cwd, ui.sessionsDir());
    if (last) session.sessionId = last;
  }

  const memory = new Memory({ dataDir, enabled: !session.noMemory });
  const journal = new Journal({ dataDir, enabled: !session.noMemory });
  const skills = new Skills({ dataDir });
  const router = new Router();

  // ── start the long-lived claude subprocess ─────────────────────────────

  const cs = new ClaudeSession({
    cwd: session.cwd,
    model: session.model || undefined,
    effort: session.effort,
    permissionMode: session.permissionMode,
    sessionId: session.sessionId || undefined,
    addDirs: session.addDirs || undefined,
    yolo: session.yolo,
  });

  try {
    await cs.start();
  } catch (err) {
    ui.err(err.message);
    process.exit(1);
  }

  banner(session);

  // ── one-shot mode (positional prompt) ──────────────────────────────────

  const oneShot = args._.slice(1).join(' ').trim();
  if (oneShot) {
    await turn(session, oneShot, cs, { memory, skills, router, journal });
    persist(session, cs);
    cs.close();
    return;
  }

  // ── REPL ───────────────────────────────────────────────────────────────

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `\n${ui.gold('>')} `,
    historySize: 500,
    terminal: process.stdout.isTTY,
  });

  // Ctrl+C handling: first press interrupts the current turn, second press
  // (when idle) quits. Mirrors how Claude Code itself behaves.
  let interruptedAt = 0;
  process.on('SIGINT', () => {
    if (cs && cs.turn && !cs.turn.finished) {
      cs.interrupt();
      process.stdout.write('\n' + ui.dim('  ⌥ interrupted — back to prompt\n'));
      interruptedAt = Date.now();
      rl.prompt();
    } else if (Date.now() - interruptedAt < 1500) {
      // Double-tap Ctrl+C: exit.
      rl.close();
    } else {
      process.stdout.write('\n' + ui.dim('  press Ctrl+C again to exit, or type /exit\n'));
      interruptedAt = Date.now();
      rl.prompt();
    }
  });

  // Strict turn serialization. readline can deliver buffered lines even
  // after rl.pause(), so we maintain our own queue + promise mutex.
  const lineQueue = [];
  let processing = false;
  let exitRequested = false;

  async function drain() {
    if (processing) return;
    processing = true;
    while (lineQueue.length && !exitRequested) {
      const text = lineQueue.shift();
      if (text.startsWith('/')) {
        const exit = await handleSlash(text, session, cs, store, memory, skills, journal);
        if (exit) { exitRequested = true; break; }
      } else {
        try {
          await turn(session, text, cs, { memory, skills, router, journal });
        } catch (err) {
          ui.err(err && err.message ? err.message : String(err));
        }
        persist(session, cs);
      }
    }
    processing = false;
    if (exitRequested) rl.close();
    else rl.prompt();
  }

  rl.prompt();
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) {
      if (!processing) rl.prompt();
      return;
    }
    lineQueue.push(text);
    drain();
  });

  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    // If there's still work queued (piped stdin sends EOF before drain
    // finishes), let it complete.
    exitRequested = true;
    while (processing || lineQueue.length) {
      await new Promise((r) => setTimeout(r, 50));
    }
    persist(session, cs);
    cs.close();
    ui.out('');
    ui.info(`session ${session.id.slice(0, 8)} saved to ${sessionFile(session.id)}`);
    if (cs.totalUsage.usd) {
      ui.info(`spent $${cs.totalUsage.usd.toFixed(4)} this session (${cs.totalUsage.input_tokens.toLocaleString()} in / ${cs.totalUsage.output_tokens.toLocaleString()} out)`);
    }
    process.exit(0);
  }
  rl.on('close', shutdown);
}

// ── banner ────────────────────────────────────────────────────────────────

function banner(session) {
  // Match Claude Code's banner shape: a single rounded-corner box, left-
  // aligned, two soft hints, then the cwd. Bordered with proper width math
  // that accounts for ANSI escape sequences.
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const term = process.stdout.columns || 80;
  const lines = [];

  // Compose content lines first, measure visible width, draw the box.
  lines.push(`${ui.gold('✻')} ${ui.bold('Welcome to Iris Code!')}`);
  lines.push('');
  const hint = `${ui.dim('/help')} ${ui.dim('for help, ')}${ui.dim('/status')} ${ui.dim('for your current setup')}`;
  lines.push('  ' + hint);
  lines.push('');
  // Truncate cwd if it would overflow.
  const cwdLine = `  ${ui.dim('cwd:')} ${session.cwd}`;
  lines.push(cwdLine);
  if (session.sessionId) {
    lines.push(`  ${ui.dim('resuming:')} ${ui.dim(String(session.sessionId).slice(0, 8))}`);
  }

  // Compute box width as the max visible-line length + 2 padding chars.
  const widest = lines.reduce((m, l) => Math.max(m, stripAnsi(l).length), 0);
  const W = Math.min(term - 2, Math.max(widest + 2, 50));

  const pad = (s) => {
    const v = stripAnsi(s).length;
    const fill = Math.max(0, W - 2 - v);
    return `│ ${s}${' '.repeat(fill)} │`;
  };

  ui.out('');
  ui.out(ui.dim('╭' + '─'.repeat(W) + '╮'));
  for (const l of lines) ui.out(ui.dim('│ ') + l + ui.dim(' '.repeat(Math.max(0, W - 2 - stripAnsi(l).length)) + ' │'));
  ui.out(ui.dim('╰' + '─'.repeat(W) + '╯'));

  // Quiet status line under the box — modes the user might want to know
  // about, but small and forgettable.
  const flags = [];
  if (session.permissionMode === 'bypassPermissions') flags.push(ui.dim('bypass'));
  else if (session.permissionMode === 'plan') flags.push(ui.cyan('plan-mode'));
  else flags.push(ui.dim(session.permissionMode));
  if (session.effort && session.effort !== 'default') flags.push(ui.dim(`effort=${session.effort}`));
  if (session.yolo) flags.push(ui.red('YOLO'));
  if (session.hermes) flags.push(ui.green('hermes'));
  if (session.model) flags.push(ui.dim(session.model));
  if (flags.length) ui.out(ui.dim('  ') + flags.join(ui.dim(' · ')));
}

// ── slash commands ────────────────────────────────────────────────────────

async function handleSlash(text, session, cs, store, memory, skills, journal) {
  // Allow free-form arg text (e.g. /note Sarah we met for coffee, she liked it)
  // by capturing everything after the first whitespace as `rawArgs`.
  const space = text.indexOf(' ');
  const head = space === -1 ? text.slice(1) : text.slice(1, space);
  const rawArgs = space === -1 ? '' : text.slice(space + 1).trim();
  const [cmd, ...rest] = [head, ...rawArgs.split(/\s+/).filter(Boolean)];
  switch (cmd) {
    case 'help':
      ui.out([
        '',
        ui.bold('  conversation'),
        '    /clear                wipe context (starts a fresh claude session)',
        '    /resume <id>          resume a different claude session id',
        '    /new                  abandon resume and start fresh',
        '    /export <file.md>     dump transcript to markdown',
        '    /cost                 token + $ counter for this session',
        '    /elapsed              how long this session has been running',
        '',
        ui.bold('  routing & overrides'),
        '    /manual /quick /agent    one-shot router override for next message',
        '    /hermes                  toggle Hermes memory+skills',
        '    /model <id>              switch model for the next turn',
        '    /effort high|low         change reasoning depth',
        '',
        ui.bold('  permissions'),
        '    /plan                 require a plan before acting',
        '    /bypass               restore bypassPermissions (default)',
        '    /yolo                 --dangerously-skip-permissions (restart required)',
        '',
        ui.bold('  inspection'),
        '    /skills               list learned skills',
        '    /memory               recent Hermes records',
        '    /tools                ask claude to list its toolset',
        '',
        ui.bold('  thoughtful — people, goals, journal'),
        '    /remember <text>           save a free-form note to long-term memory',
        '    /recall <q>                fuzzy-search long-term memory',
        '    /people                    list everyone Iris knows about',
        '    /who <name>                show one person\'s history',
        '    /meet <name> [as <rel>]    introduce a new person (rel = partner, ex-partner, family, friend…)',
        '    /note <name> <text>        append a note to that person',
        '    /forget <name>             remove a person from the journal',
        '    /goals [status]            list goals (default: active)',
        '    /goal new <title>          create a new goal',
        '    /goal status <id> <s>      set status (active|paused|done|dropped)',
        '    /goal note <id> <text>     append a progress note',
        '    /goal done <id>            mark complete',
        '    /goal show <id>            full history of one goal',
        '    /feel <text>               log a feeling / mood entry',
        '    /journal                   recent free-form notes',
        '',
        ui.bold('  exit'),
        '    /gui                  hand off this conversation to the desktop GUI',
        '    /exit                 quit (Ctrl+C twice also works)',
        '',
      ].join('\n'));
      return false;
    case 'gui':
      return await guiHandoff(session, cs);
    case 'hermes':
      session.hermes = !session.hermes;
      ui.info(`hermes: ${session.hermes ? ui.green('on') : ui.red('off')}`);
      return false;
    case 'manual':
    case 'quick':
    case 'agent':
      session.routeOverride = cmd === 'agent' ? 'agentic' : cmd === 'quick' ? 'quick-tool' : 'manual';
      ui.info(`route override: ${session.routeOverride} (next message)`);
      return false;
    case 'plan':
      ui.warn('switching permission mode requires restarting the claude subprocess.');
      ui.info(`run: iris chat --plan --resume ${session.claudeSessionId || ''}`);
      return false;
    case 'bypass':
      ui.warn('already on bypass by default; this slash is a no-op unless you used /plan.');
      return false;
    case 'yolo':
      ui.warn('--dangerously-skip-permissions only takes effect at spawn time.');
      ui.info(`run: iris chat --yolo --resume ${session.claudeSessionId || ''}`);
      return false;
    case 'model':
      if (!rest[0]) { ui.info(session.model || '(claude default)'); return false; }
      ui.warn('model switch requires restarting the claude subprocess.');
      ui.info(`run: iris chat --model ${rest[0]} --resume ${session.claudeSessionId || ''}`);
      return false;
    case 'effort':
      if (!rest[0]) { ui.info(session.effort); return false; }
      ui.warn('effort switch requires restarting the claude subprocess.');
      ui.info(`run: iris chat --effort ${rest[0]} --resume ${session.claudeSessionId || ''}`);
      return false;
    case 'resume':
      ui.warn('resume requires restarting the claude subprocess.');
      ui.info(`run: iris chat --resume ${rest[0] || '<id>'}`);
      return false;
    case 'new':
      ui.warn('to start fresh, exit and run: iris chat --new');
      return false;
    case 'clear':
      session.transcript = [];
      ui.info('local transcript cleared (claude\'s own context is preserved across this subprocess).');
      return false;
    case 'export': {
      const file = rest[0];
      if (!file) { ui.err('/export <file.md>'); return false; }
      fs.writeFileSync(file, transcriptToMarkdown(session), 'utf8');
      ui.ok('wrote ' + file);
      return false;
    }
    case 'cost': {
      const u = cs.totalUsage;
      ui.out(`  in:    ${u.input_tokens.toLocaleString()} tokens`);
      ui.out(`  out:   ${u.output_tokens.toLocaleString()} tokens`);
      ui.out(`  cache: ${u.cache_read.toLocaleString()} read / ${u.cache_creation.toLocaleString()} written`);
      ui.out(`  usd:   $${(u.usd || 0).toFixed(4)}`);
      return false;
    }
    case 'elapsed': {
      const sec = Math.round((Date.now() - session.startedAt) / 1000);
      const m = Math.floor(sec / 60), s = sec % 60;
      ui.info(`${m}m ${s}s`);
      return false;
    }
    case 'skills': {
      const all = skills.list();
      if (!all.length) ui.info('(no skills learned yet)');
      else for (const sk of all) ui.out(`  ${ui.gold(sk.name.padEnd(32))} ${ui.dim(sk.description || '')}`);
      return false;
    }
    case 'memory': {
      const r = memory.recent(10);
      if (!r.length) ui.info('(no memories stored)');
      else for (const m of r) ui.out(`  ${ui.dim(m.kind.padEnd(8))} ${m.summary}`);
      return false;
    }
    case 'tools':
      // Just ask claude.
      await turn(session, 'list every tool you currently have access to. just a comma-separated list, no commentary.', cs, { memory, skills, router: new Router(), journal });
      return false;

    // ── thoughtful commands ──
    case 'remember': {
      if (!rawArgs) { ui.err('usage: /remember <text>'); return false; }
      await memory.remember({ kind: 'pref', summary: rawArgs.slice(0, 200), body: rawArgs, ts: Date.now() });
      ui.ok('remembered');
      return false;
    }
    case 'recall': {
      if (!rawArgs) { ui.err('usage: /recall <query>'); return false; }
      const hits = await memory.recall(rawArgs, { limit: 8 });
      if (!hits.length) { ui.info('(no matches)'); return false; }
      for (const r of hits) ui.out(`  ${ui.dim(new Date(r.ts).toISOString().slice(0, 10))} ${r.summary}`);
      return false;
    }
    case 'people': {
      const all = journal.listPeople();
      if (!all.length) { ui.info('(no people yet — try /meet <name> as <relationship>)'); return false; }
      for (const p of all) {
        const last = p.notes.length ? ui.dim(' — ' + p.notes[p.notes.length - 1].text.slice(0, 80)) : '';
        ui.out(`  ${ui.gold(p.name.padEnd(20))} ${ui.dim('(' + p.relationship + ')')}${last}`);
      }
      return false;
    }
    case 'who': {
      if (!rawArgs) { ui.err('usage: /who <name>'); return false; }
      const p = journal.getPerson(rawArgs);
      if (!p) { ui.info(`no record of "${rawArgs}" — try /meet ${rawArgs} as <relationship>`); return false; }
      ui.out(`  ${ui.bold(p.name)} ${ui.dim('(' + p.relationship + ')')}`);
      if (p.aliases.length) ui.out(`  ${ui.dim('also known as: ' + p.aliases.join(', '))}`);
      if (!p.notes.length) { ui.info('  (no notes yet)'); return false; }
      for (const n of p.notes) ui.out(`    ${ui.dim(new Date(n.ts).toISOString().slice(0, 10))} ${n.text}`);
      return false;
    }
    case 'meet': {
      if (!rawArgs) { ui.err('usage: /meet <name> [as <relationship>]'); return false; }
      const m = /^(.+?)\s+as\s+(.+)$/i.exec(rawArgs);
      const name = m ? m[1].trim() : rawArgs.trim();
      const relationship = m ? m[2].trim().toLowerCase() : 'other';
      const rec = journal.upsertPerson(name, { relationship });
      ui.ok(`saved ${rec.name} (${rec.relationship})`);
      return false;
    }
    case 'note': {
      const m = /^(\S.*?)\s+(.+)$/s.exec(rawArgs || '');
      if (!m) { ui.err('usage: /note <name> <text>'); return false; }
      const name = m[1].trim();
      try {
        journal.addPersonNote(name, m[2]);
        ui.ok(`noted under ${name}`);
      } catch (err) {
        ui.err(err.message + ` — try /meet ${name} first`);
      }
      return false;
    }
    case 'forget': {
      if (!rawArgs) { ui.err('usage: /forget <name>'); return false; }
      const ok = journal.removePerson(rawArgs);
      if (ok) ui.ok(`removed ${rawArgs}`); else ui.info(`no record of "${rawArgs}"`);
      return false;
    }
    case 'goals': {
      const status = rest[0] || 'active';
      const all = status === 'all' ? journal.listGoals() : journal.listGoals({ status });
      if (!all.length) { ui.info(`(no ${status} goals — try /goal new <title>)`); return false; }
      for (const g of all) {
        const last = g.notes.length ? ui.dim(' — ' + g.notes[g.notes.length - 1].text.slice(0, 80)) : '';
        const tag = g.status === 'done' ? ui.green('✓')
          : g.status === 'paused' ? ui.dim('⏸')
          : g.status === 'dropped' ? ui.red('✗') : ui.gold('●');
        ui.out(`  ${tag} ${ui.dim(g.id.slice(0, 8))} ${g.title}${last}`);
      }
      return false;
    }
    case 'goal': {
      const sub = rest[0];
      if (!sub) { ui.err('usage: /goal new|status|note|done|show|drop <args>'); return false; }
      const tail = rawArgs.slice(sub.length).trim();
      try {
        if (sub === 'new') {
          if (!tail) { ui.err('usage: /goal new <title>'); return false; }
          const g = journal.createGoal({ title: tail });
          ui.ok(`goal ${ui.dim(g.id.slice(0, 8))} — ${g.title}`);
        } else if (sub === 'status') {
          const m = /^(\S+)\s+(\S+)$/.exec(tail);
          if (!m) { ui.err('usage: /goal status <id> <active|paused|done|dropped>'); return false; }
          const g = journal.updateGoal(m[1], { status: m[2] });
          ui.ok(`${g.title} → ${g.status}`);
        } else if (sub === 'note') {
          const m = /^(\S+)\s+(.+)$/s.exec(tail);
          if (!m) { ui.err('usage: /goal note <id> <text>'); return false; }
          journal.addGoalNote(m[1], m[2]);
          ui.ok('progress noted');
        } else if (sub === 'done') {
          if (!tail) { ui.err('usage: /goal done <id>'); return false; }
          const g = journal.updateGoal(tail, { status: 'done' });
          ui.ok(`${ui.green('✓')} ${g.title}`);
        } else if (sub === 'drop') {
          if (!tail) { ui.err('usage: /goal drop <id>'); return false; }
          const g = journal.updateGoal(tail, { status: 'dropped' });
          ui.ok(`${ui.red('✗')} ${g.title}`);
        } else if (sub === 'show') {
          if (!tail) { ui.err('usage: /goal show <id>'); return false; }
          const g = journal.getGoal(tail);
          if (!g) { ui.info('no such goal'); return false; }
          ui.out(`  ${ui.bold(g.title)} ${ui.dim('(' + g.status + ')')}`);
          if (g.description) ui.out(`  ${ui.dim(g.description)}`);
          if (!g.notes.length) ui.info('  (no progress notes yet)');
          for (const n of g.notes) ui.out(`    ${ui.dim(new Date(n.ts).toISOString().slice(0, 16).replace('T', ' '))} ${n.text}`);
        } else {
          ui.err(`unknown /goal subcommand: ${sub}`);
        }
      } catch (err) {
        ui.err(err.message);
      }
      return false;
    }
    case 'feel': {
      if (!rawArgs) { ui.err('usage: /feel <text>'); return false; }
      journal.addNote(rawArgs, { tags: ['feel'] });
      ui.ok('logged');
      return false;
    }
    case 'journal': {
      const notes = journal.recentNotes(15);
      if (!notes.length) { ui.info('(no notes yet)'); return false; }
      for (const n of notes) {
        const tags = n.tags.length ? ui.dim(' [' + n.tags.join(',') + ']') : '';
        ui.out(`  ${ui.dim(new Date(n.ts).toISOString().slice(0, 16).replace('T', ' '))}${tags} ${n.text}`);
      }
      return false;
    }

    case 'exit':
    case 'quit':
    case 'q':
      return true;
    default:
      ui.err(`unknown slash: /${cmd} — try /help`);
      return false;
  }
}

// ── a turn ────────────────────────────────────────────────────────────────

async function turn(session, userText, cs, { memory, skills, router, journal }) {
  let route = session.routeOverride;
  if (!route) route = router.fastClassify(userText) || 'quick-tool';
  session.routeOverride = null;
  const hermesOn = session.hermes || route === 'agentic';

  session.transcript.push({ role: 'user', text: userText, ts: Date.now() });

  // Prepend a compact journal preamble on the first turn of a fresh subprocess
  // so the overseer Iris always knows about active goals and key people.
  // Cheap (<500 tokens) and bounded; skipped if the journal is empty.
  if (journal && !session._journalPrimed) {
    const preamble = buildJournalPreamble(journal);
    if (preamble) userText = preamble + '\n\n' + userText;
    session._journalPrimed = true;
  }

  // No pre-amble noise. Thinking indicator runs until the first byte.
  const spin = startSpinner();
  let sawFirstByte = false;
  let assistantText = '';
  let toolCount = 0;
  const turnStart = Date.now();

  for await (const ev of cs.send(userText)) {
    if (!sawFirstByte && (ev.type === 'text' || ev.type === 'tool_use')) {
      stopSpinner(spin);
      sawFirstByte = true;
    }
    if (session.json) { process.stdout.write(JSON.stringify(ev) + '\n'); continue; }

    if (ev.type === 'text') {
      if (ev.partial) {
        process.stdout.write(ev.delta);
        assistantText += ev.delta;
      } else if (assistantText.length === 0) {
        process.stdout.write(ev.delta);
        assistantText += ev.delta;
      }
    } else if (ev.type === 'tool_use') {
      toolCount++;
      process.stdout.write('\n' + renderToolUse(ev));
    } else if (ev.type === 'tool_result') {
      process.stdout.write('\n' + renderToolResult(ev) + '\n');
    } else if (ev.type === 'error') {
      stopSpinner(spin);
      ui.err(ev.error);
    } else if (ev.type === 'stop') {
      stopSpinner(spin);
      // Quiet trailer: only show if there were tools or it took noticeable time.
      const dur = (Date.now() - turnStart) / 1000;
      if (toolCount || dur > 4) {
        const bits = [];
        if (toolCount) bits.push(`${toolCount} tool${toolCount === 1 ? '' : 's'}`);
        if (dur > 1) bits.push(`${dur.toFixed(1)}s`);
        if (cs.totalUsage.usd) bits.push(`$${cs.totalUsage.usd.toFixed(4)}`);
        if (bits.length) process.stdout.write('\n' + ui.dim(bits.join(' · ')) + '\n');
      }
      break;
    }
  }

  session.transcript.push({
    role: 'assistant',
    text: assistantText,
    ts: Date.now(),
    tool_calls: toolCount,
  });
  session.claudeSessionId = cs.sessionId || session.claudeSessionId;

  if (hermesOn && !session.noMemory) {
    await memory.remember({
      kind: 'turn',
      summary: userText.slice(0, 200),
      body: assistantText.slice(0, 4000),
      ts: Date.now(),
    });
    if (route === 'agentic') {
      const proposal = await skills.reflect({ userText, assistantText });
      if (proposal) {
        const ans = await ui.prompt(`  ${ui.dim('hermes proposes')} ${ui.gold(proposal.name)} — accept? [y/N] `);
        if (ans.trim().toLowerCase() === 'y') { skills.save(proposal); ui.ok('saved'); }
      }
    }
  }
}

// ── journal preamble ──────────────────────────────────────────────────────

function buildJournalPreamble(journal) {
  let sum;
  try { sum = journal.buildSummary(); } catch { return null; }
  if (!sum || (!sum.goals.length && !sum.people.length)) return null;
  const lines = ['<iris-journal>'];
  lines.push('This block carries persistent personal context. Treat it as authoritative background — the user did not retype it this turn, but it is part of who they are. Do NOT echo it back unless directly asked.');
  if (sum.goals.length) {
    lines.push('Active goals:');
    for (const g of sum.goals) {
      const last = g.lastNote ? ` — last note: "${g.lastNote}"` : '';
      lines.push(`- [${g.id}] ${g.title}${last}`);
    }
  }
  if (sum.people.length) {
    lines.push('People (most recent):');
    for (const p of sum.people) {
      const last = p.lastNote ? ` — "${p.lastNote}"` : '';
      lines.push(`- ${p.name} (${p.relationship})${last}`);
    }
  }
  lines.push('</iris-journal>');
  return lines.join('\n');
}

// ── rendering helpers ─────────────────────────────────────────────────────

function renderToolUse(ev) {
  // Claude-Code style: ● ToolName(args)
  const args = shortInput(ev.input);
  return `${ui.gold('●')} ${ui.bold(ev.name)}${ui.dim('(')}${ui.dim(args)}${ui.dim(')')}`;
}

function renderToolResult(ev) {
  const text = typeof ev.output === 'string' ? ev.output
    : Array.isArray(ev.output) ? ev.output.map((b) => b.text || JSON.stringify(b)).join('') : '';
  const lines = text.split('\n').slice(0, 1);
  const more = text.split('\n').length > 1 || text.length > 160;
  let body = lines[0].replace(/\s+/g, ' ').slice(0, 160);
  if (more) body += '…';
  return `  ${ui.grey('⎿')} ${ui.dim(body)}`;
}

function shortInput(o) {
  try {
    const s = JSON.stringify(o);
    return s.length > 140 ? s.slice(0, 137) + '…' : s;
  } catch { return '(...)'; }
}

function startSpinner() {
  if (!process.stdout.isTTY) return null;
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  process.stdout.write(ui.dim(frames[0]) + ' ' + ui.dim('thinking…'));
  const id = setInterval(() => {
    i = (i + 1) % frames.length;
    process.stdout.write('\r' + ui.dim(frames[i]) + ' ' + ui.dim('thinking…'));
  }, 80);
  return id;
}

function stopSpinner(id) {
  if (!id) return;
  clearInterval(id);
  if (process.stdout.isTTY) process.stdout.write('\r' + ' '.repeat(20) + '\r');
}

// ── persistence + GUI handoff ─────────────────────────────────────────────

function sessionFile(id) { return path.join(ui.sessionsDir(), `${id}.json`); }
function persist(session, cs) {
  const payload = { ...session, claudeSessionId: cs.sessionId, totalUsage: cs.totalUsage };
  fs.writeFileSync(sessionFile(session.id), JSON.stringify(payload, null, 2), 'utf8');
}

function transcriptToMarkdown(session) {
  const lines = [`# iris session ${session.id}`, '', `cwd: \`${session.cwd}\``, ''];
  for (const t of session.transcript) {
    lines.push(`## ${t.role === 'user' ? 'You' : 'Iris'}`);
    lines.push('');
    lines.push(t.text);
    lines.push('');
  }
  return lines.join('\n');
}

async function guiHandoff(session, cs) {
  persist(session, cs);
  ui.info(`handing off ${session.id.slice(0, 8)} to the GUI…`);
  const appRoot = path.resolve(__dirname, '..', '..');
  const bin = process.platform === 'win32'
    ? path.join(appRoot, 'node_modules', '.bin', 'electron.cmd')
    : path.join(appRoot, 'node_modules', '.bin', 'electron');
  if (fs.existsSync(bin)) {
    const proc = spawn(bin, [appRoot, `--resume=${session.id}`], { detached: true, stdio: 'ignore' });
    proc.unref();
    ui.ok('GUI launched');
  } else {
    ui.warn('no electron binary in node_modules. Run manually:');
    ui.out(`  cd "${appRoot}" && npm start -- --resume=${session.id}`);
  }
  cs.close();
  return true;
}

module.exports = { run };

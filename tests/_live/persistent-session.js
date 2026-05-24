// tests/_live/persistent-session.js
//
// LIVE test: drives ClaudeSession through two turns to prove the
// persistent stream-json IPC keeps context across messages.
// Not part of the default suite — requires `claude` on PATH.
//
// Run: node tests/_live/persistent-session.js

'use strict';

const { ClaudeSession } = require('../../lib/cli/session.js');

async function collect(stream) {
  let text = '';
  let tools = 0;
  for await (const ev of stream) {
    if (ev.type === 'text' && ev.partial) text += ev.delta;
    else if (ev.type === 'tool_use') tools++;
    else if (ev.type === 'error') console.error('  ! error:', ev.error);
    else if (ev.type === 'stop') return { text, tools };
  }
  return { text, tools };
}

async function main() {
  const cs = new ClaudeSession({ cwd: process.cwd(), effort: 'low', permissionMode: 'bypassPermissions' });
  console.log('spawning claude...');
  await cs.start();
  console.log('  pid running, session id (pre-first-turn):', cs.sessionId);

  console.log('\nturn 1: sending "remember the number 4738. just acknowledge."');
  const t1 = Date.now();
  const r1 = await collect(cs.send('remember the number 4738. just acknowledge.'));
  console.log(`  reply (${((Date.now() - t1) / 1000).toFixed(1)}s):`, JSON.stringify(r1.text.slice(0, 200)));
  console.log('  session id:', cs.sessionId);

  console.log('\nturn 2: sending "what number did i ask you to remember?"');
  const t2 = Date.now();
  const r2 = await collect(cs.send('what number did i ask you to remember?'));
  console.log(`  reply (${((Date.now() - t2) / 1000).toFixed(1)}s):`, JSON.stringify(r2.text.slice(0, 200)));

  const recalled = /4738/.test(r2.text);
  console.log('\nrecalled 4738 across turns?', recalled ? 'YES ✓' : 'NO ✗');
  console.log('total usage:', cs.totalUsage);

  cs.close();
  process.exit(recalled ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });

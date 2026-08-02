// End-to-end test for the two doors this server actually has, and for
// export/restore.
//
// There is only one credential left: the shared secret on /mcp. The dashboard is
// open, and this file exists to hold that line in both directions — the agent door
// must stay shut without a key, and the human door must stay open without one.
// Those two assertions come first and are not optional; a build where /mcp
// silently stopped checking, or where the board silently started asking for a
// password again, is broken in a way no other suite would notice.
//
// The rest covers backups: the shared secret must never be in the file, and a
// backup taken by the version that still had dashboard accounts must still load.
//   npm run test:auth
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { readdirSync, rmSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = Number(process.env.AUTH_TEST_PORT ?? 8898);
const DB_PATH = `./data/auth-${process.pid}.db`;
const HOST = `http://localhost:${PORT}`;
const CHANNEL = 'auth-test';
const KEY = 'auth-shared-secret';
const AUTH_HEADER = 'X-Orchestratinator-Key';

let failures = 0;
const assert = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures++;
};
const eq = (actual, expected, msg) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? '✓' : '✗'} ${msg}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
  if (!ok) failures++;
};

const parse = (res) => JSON.parse(res.content[0].text);
const call = (client, name, args = {}) => client.callTool({ name, arguments: args }).then(parse);

async function waitHealthy() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${HOST}/health`)).ok) return true; } catch { /* retry */ }
    await sleep(100);
  }
  return false;
}
async function makeClient(agent, key = KEY) {
  const transport = new StreamableHTTPClientTransport(new URL(`${HOST}/mcp`), {
    requestInit: { headers: { 'X-Channel': CHANNEL, 'X-Agent': agent, ...(key ? { [AUTH_HEADER]: key } : {}) } },
  });
  const client = new Client({ name: `auth-${agent}`, version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
}
const close = async (t) => { try { await t.close(); } catch { /* already gone */ } };
const rmDb = (p) => { for (const ext of ['', '-wal', '-shm']) { try { rmSync(p + ext); } catch { /* ignore */ } } };

const json = async (res) => ({ status: res.status, json: await res.json().catch(() => ({})) });
const get = (path, headers = {}) => fetch(`${HOST}${path}`, { headers });
const postAdmin = async (path, body, headers = {}) =>
  json(await fetch(`${HOST}/api/admin/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }));

const server = spawn('node', ['src/server.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH,
    ORCH_AUTH_TOKEN: KEY,
    ORCH_AUTH_MODE: 'enforce',
  },
  stdio: 'inherit',
});

let alpha;
const snapshots = [];

try {
  if (!(await waitHealthy())) throw new Error('server did not become healthy');
  console.log('server healthy\n');

  console.log('the agent door is shut');
  {
    // enforce mode, so a client with no key must not get a session at all. If this
    // ever passes silently, the port is open to anything that finds it.
    let connected = false;
    try {
      const nokey = await makeClient('intruder', null);
      connected = true;
      await close(nokey.transport);
    } catch { /* expected */ }
    assert(!connected, 'an MCP client with no shared secret cannot connect');

    const wrong = await fetch(`${HOST}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        [AUTH_HEADER]: `${KEY}-nope`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    eq(wrong.status, 401, 'a wrong key → 401');

    alpha = await makeClient('alpha');
    const who = await call(alpha.client, 'whoami');
    eq(who.channel, CHANNEL, 'and the right key connects and works');
  }

  console.log('\nthe human door is open');
  {
    const page = await get('/');
    const html = await page.text();
    eq(page.status, 200, 'the dashboard is served with no credential at all');
    assert(!/type="password"/.test(html), 'and there is no sign-in form in it');

    eq((await get('/api/state')).status, 200, '/api/state is readable');
    eq((await get('/api/activity?limit=5')).status, 200, '/api/activity is readable');
    eq((await get('/health')).status, 200, '/health stays open for the container healthcheck');

    // Every route the sign-in used to need. Their absence is the feature.
    for (const gone of ['/api/session', '/api/login', '/api/logout', '/api/admin/token', '/api/admin/users']) {
      eq((await get(gone)).status, 404, `${gone} is gone`);
    }

    // Operator actions need no credential either — only that the request did not
    // come from another site.
    const nudge = await postAdmin('agent/nudge', { channel: CHANNEL, agent: 'alpha' });
    eq(nudge.status, 200, 'an operator action works with nothing presented');
    const foreign = await postAdmin('agent/nudge', { channel: CHANNEL, agent: 'alpha' }, { origin: 'https://evil.example' });
    eq(foreign.status, 403, 'but not from a foreign Origin');
  }

  console.log('\nseeding a board worth backing up');
  {
    await call(alpha.client, 'send_message', { body: 'something for the backup' });
    await call(alpha.client, 'set_contract', { key: 'iface.v1', value: { args: ['a'] } });
    await call(alpha.client, 'open_task', { title: 'work worth backing up' });
    const board = await (await get('/api/state')).json();
    assert(board.channels.some((c) => c.channel === CHANNEL), 'the channel is on the board');
  }

  console.log('\nexporting a backup');
  {
    const res = await get('/api/admin/backup');
    const doc = await res.json();
    eq(res.status, 200, 'the export is served');
    assert(/attachment; filename="orchestratinator-backup-/.test(res.headers.get('content-disposition') ?? ''), 'as a download with a dated filename');
    eq(doc.format, 'orchestratinator-backup', 'and identifies its own format');
    assert(doc.counts.messages > 0 && doc.counts.tasks > 0 && doc.counts.contracts > 0, 'it carries the board (messages, tasks, contracts)');
    assert(doc.counts.contract_history > 0, 'including contract version history');

    // The one thing that must never be in a file that ends up in a Downloads
    // folder: the key every agent authenticates with.
    const raw = JSON.stringify(doc);
    assert(!raw.includes(KEY), 'the shared MCP secret is nowhere in the file');
    assert(/^sha256:[0-9a-f]{12}$/.test(doc.auth.shared_secret_fingerprint), 'only a fingerprint of it, to check the far end matches');
    assert(doc.auth.env_required.some((v) => /ORCH_AUTH_TOKEN/.test(v)), 'and it lists what the new host still needs configured');

    // There is no account table to carry any more, and no password hash anywhere.
    assert(!('users' in doc.tables), 'no dashboard accounts are exported — there are none');
    assert(!('ui_sessions' in doc.tables), 'and no login cookies either');
    assert(!/scrypt\$/.test(raw), 'no password hash appears anywhere in the file');
  }

  console.log('\nrestoring a backup');
  {
    const doc = await (await get('/api/admin/backup')).json();
    const msgsBefore = doc.counts.messages;

    const wrongWord = await postAdmin('backup/restore', { backup: doc, confirm: 'yes' });
    eq(wrongWord.status, 400, 'a restore without the word RESTORE → 400');
    const notABackup = await postAdmin('backup/restore', { backup: { hello: 'world' }, confirm: 'RESTORE' });
    eq(notABackup.status, 400, 'a file that is not a backup → 400');
    assert(/not an orchestratinator-backup/.test(notABackup.json.error), 'and says so plainly');
    const fromTheFuture = await postAdmin('backup/restore', { backup: { ...doc, format_version: 99 }, confirm: 'RESTORE' });
    eq(fromTheFuture.status, 400, 'a backup from a newer format → 400 rather than a partial load');

    // Move the board away from the backup, so a successful restore has something
    // to actually undo.
    await call(alpha.client, 'send_message', { body: 'written after the backup' });
    await call(alpha.client, 'open_task', { title: 'also after the backup' });
    const drifted = await (await get('/api/admin/backup')).json();
    assert(drifted.counts.messages > msgsBefore, 'the live board has drifted past the backup');

    const done = await postAdmin('backup/restore', { backup: doc, confirm: 'RESTORE' });
    eq(done.status, 200, 'an exact confirmation restores');
    assert(done.json.rows > 0, `and reports the rows it loaded (${done.json.rows})`);
    assert(done.json.snapshot?.saved === true, 'having first written the pre-restore board to disk');
    if (done.json.snapshot?.path) snapshots.push(done.json.snapshot.path);
    assert(done.json.sessions_closed >= 1, 'live agent sessions are closed so they rejoin the restored board');
    assert(!('replaced_users' in done.json), 'and the report says nothing about accounts');

    const after = await (await get('/api/admin/backup')).json();
    eq(after.counts.messages, msgsBefore, 'the board is back to what the backup held');
    const board = await (await get('/api/state')).json();
    assert(board.channels.some((c) => c.channel === CHANNEL), 'with its channel intact');
  }

  console.log('\na backup from the version that had accounts');
  {
    // Anyone upgrading has files on disk with a `users` table of scrypt hashes in
    // them. Those must still restore their board — and must say out loud that the
    // accounts went nowhere, rather than dropping them on the floor in silence.
    const doc = await (await get('/api/admin/backup')).json();
    const legacy = {
      ...doc,
      tables: {
        ...doc.tables,
        users: [{ username: 'costmo', password: 'scrypt$16384$8$1$abc$def', enabled: 1 }],
      },
    };
    const done = await postAdmin('backup/restore', { backup: legacy, confirm: 'RESTORE' });
    eq(done.status, 200, 'it restores rather than being refused');
    if (done.json.snapshot?.path) snapshots.push(done.json.snapshot.path);
    assert((done.json.notes ?? []).some((n) => /ignored 1 dashboard account/.test(n)), 'and says the account in it was ignored');
    // Filtered out before the restore transaction ever sees it, so it earns no row
    // in the per-table report — the note above is what tells you where it went.
    assert(!('users' in done.json.tables), 'the table is never written');
    eq((await get('/api/state')).status, 200, 'the board is still open afterwards');
  }

  console.log('\naudit trail');
  {
    const feed = await (await get('/api/activity?limit=500')).json();
    const rows = feed.rows.filter((r) => r.kind.startsWith('admin.'));
    const kinds = new Set(rows.map((r) => r.kind));
    // The restore wiped admin_events, so what survives is what happened after it —
    // which is the property worth asserting: the log records the restore itself.
    for (const k of ['admin.backup.restore', 'admin.backup.export']) assert(kinds.has(k), `${k} is in the feed`);
    const restore = rows.find((r) => r.kind === 'admin.backup.restore');
    eq(restore?.channel, '(server)', 'server-wide actions are filed under "(server)"');
    eq(restore?.actor, 'operator', 'and are attributed to "operator" — the board knows a human did it, and no more');
    assert(/restored \d+ rows/.test(restore?.detail ?? ''), 'with a detail saying what happened');
    // A channel that only ever appeared in admin_events must not turn into a card.
    const board = await (await get('/api/state')).json();
    assert(!board.channels.some((c) => c.channel === '(server)'), '"(server)" never shows up as a channel on the board');
  }
} catch (err) {
  console.error('auth test error:', err);
  failures++;
} finally {
  if (alpha) await close(alpha.transport);
  server.kill('SIGKILL');
  rmDb(DB_PATH);
  for (const p of snapshots) { try { rmSync(p); } catch { /* ignore */ } }
  // Belt to that braces: a failed run may have left snapshots unreported.
  try {
    for (const f of readdirSync('./data')) {
      if (f.startsWith('pre-restore-')) rmSync(`./data/${f}`);
    }
  } catch { /* no data dir */ }
}

console.log(`\n${failures === 0 ? 'PASS ✅' : 'FAIL ❌'} — ${failures} failure(s)`);
process.exit(failures ? 1 : 0);

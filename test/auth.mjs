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
async function makeClient(agent, key = KEY, channel = CHANNEL) {
  const transport = new StreamableHTTPClientTransport(new URL(`${HOST}/mcp`), {
    requestInit: { headers: { 'X-Channel': channel, 'X-Agent': agent, ...(key ? { [AUTH_HEADER]: key } : {}) } },
  });
  const client = new Client({ name: `auth-${agent}`, version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
}
const close = async (t) => { try { await t.close(); } catch { /* already gone */ } };
const rmDb = (p) => { for (const ext of ['', '-wal', '-shm']) { try { rmSync(p + ext); } catch { /* ignore */ } } };

const json = async (res) => ({ status: res.status, json: await res.json().catch(() => ({})) });
const get = (path, headers = {}) => fetch(`${HOST}${path}`, { headers });
const postApi = async (path, body, headers = {}) =>
  json(await fetch(`${HOST}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }));
const postAdmin = (path, body, headers = {}) => postApi(`/api/admin/${path}`, body, headers);

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
    const ok = await postAdmin('agent/advance', { channel: CHANNEL, agent: 'alpha', up_to_id: 0 });
    eq(ok.status, 200, 'an operator action works with nothing presented');
    const foreign = await postAdmin('agent/advance', { channel: CHANNEL, agent: 'alpha', up_to_id: 0 }, { origin: 'https://evil.example' });
    eq(foreign.status, 403, 'but not from a foreign Origin');
  }

  console.log('\nseeding a board worth backing up');
  let promptId;
  {
    await call(alpha.client, 'send_message', { body: 'something for the backup' });
    await call(alpha.client, 'set_contract', { key: 'iface.v1', value: { args: ['a'] } });
    await call(alpha.client, 'open_task', { title: 'work worth backing up' });
    // The operator's furniture too — a saved prompt and a chosen name — so the
    // round trip below covers the tables added since the format shipped.
    const prompt = await postAdmin('prompt/create', { title: 'Deploy checklist', content: 'run the deploy, read the log' });
    eq(prompt.status, 200, 'a saved prompt is created for the round trip');
    promptId = prompt.json.id;
    const profile = await postApi('/api/floor/profile', { channel: CHANNEL, agent: 'alpha', persona: 'Captain Quirk' });
    eq(profile.status, 200, 'and alpha is given an operator-chosen name');
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
    assert(doc.counts.saved_prompts > 0 && doc.counts.agent_profile > 0, 'and the operator\'s furniture (saved prompts, agent profiles)');

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

  console.log('\nthe newer tables ride the same round trip');
  {
    const doc = await (await get('/api/admin/backup')).json();

    // Drift both: the prompt is deleted and alpha renamed, so a successful
    // restore has to visibly put each of them back.
    const gone = await postAdmin('prompt/delete', { id: promptId });
    eq(gone.status, 200, 'the saved prompt is deleted after the export');
    await postApi('/api/floor/persona', { channel: CHANNEL, agent: 'alpha', persona: 'Renamed' });

    const done = await postAdmin('backup/restore', { backup: doc, confirm: 'RESTORE' });
    eq(done.status, 200, 'the backup restores');
    if (done.json.snapshot?.path) snapshots.push(done.json.snapshot.path);

    const prompts = (await (await get('/api/prompts')).json()).prompts ?? [];
    assert(prompts.some((p) => p.title === 'Deploy checklist'), 'the saved prompt is back');
    const after = await (await get('/api/admin/backup')).json();
    assert((after.tables.agent_profile ?? []).some((r) => r.agent === 'alpha' && r.persona === 'Captain Quirk'),
      'and alpha answers to the name the backup holds');
  }

  console.log('\na file the live schema refuses');
  {
    // Two saved-prompt titles differing only in case collide on the NOCASE
    // unique index. No shipped build exports such a file today — but the format
    // exists to load across versions, so any constraint a future build adds
    // makes this the fate of an older board's honest backup. The refusal has to
    // say where and promise the board did not change, and it must not bounce
    // live sessions over a restore that never happened.
    const doc = await (await get('/api/admin/backup')).json();
    const beta = await makeClient('beta');
    eq((await call(beta.client, 'whoami')).agent, 'beta', 'a live session is watching');

    const clash = {
      ...doc,
      tables: {
        ...doc.tables,
        saved_prompts: [
          { id: 1, title: 'Deploy', content: 'x' },
          { id: 2, title: 'deploy', content: 'y' },
        ],
      },
    };
    const refused = await postAdmin('backup/restore', { backup: clash, confirm: 'RESTORE' });
    eq(refused.status, 400, 'a row the schema refuses → 400, not a bare 500');
    assert(/saved_prompts.*row 2 of 2/.test(refused.json.error), 'naming the table and row that was refused');
    assert(/nothing was restored/.test(refused.json.error), 'and stating that the board did not change');

    const counts = (await (await get('/api/admin/backup')).json()).counts;
    eq(counts.messages, doc.counts.messages, 'the board is untouched');
    eq(counts.saved_prompts, doc.counts.saved_prompts, 'including the table whose wipe was rolled back');
    eq((await call(beta.client, 'whoami')).agent, 'beta', 'and no live session was bounced');
    await close(beta.transport);
  }

  console.log('\na backup from the version that kept names on desks');
  {
    // Before names were global, `personas` carried them per desk. Such a file
    // has no agent_profile table and its persona column no longer exists here,
    // so the generic restore skips it — the operator's chosen names must be
    // adopted anyway, by the rules migratePersonas applies to a live database:
    // cast names are not choices, and a name already on this board wins.
    const doc = await (await get('/api/admin/backup')).json();
    const legacy = { ...doc, tables: { ...doc.tables } };
    delete legacy.tables.agent_profile;
    legacy.tables.personas = [
      { channel: CHANNEL, agent: 'alpha', seat: 0, assigned_at: '2026-01-01 00:00:00', persona: 'Someone Else' },
      { channel: CHANNEL, agent: 'gamma', seat: 1, assigned_at: '2026-01-01 00:00:00', persona: 'Old Salt' },
      { channel: CHANNEL, agent: 'delta', seat: 2, assigned_at: '2026-01-01 00:00:00', persona: 'Ada' },
    ];

    const done = await postAdmin('backup/restore', { backup: legacy, confirm: 'RESTORE' });
    eq(done.status, 200, 'it restores');
    if (done.json.snapshot?.path) snapshots.push(done.json.snapshot.path);
    assert((done.json.notes ?? []).some((n) => /adopted 1 agent name/.test(n)), 'and says it adopted the name the file chose');
    assert((done.json.notes ?? []).some((n) => /kept this board's name for 1 agent/.test(n)), 'and that a standing name won over the file');

    const names = Object.fromEntries(
      ((await (await get('/api/admin/backup')).json()).tables.agent_profile ?? []).map((r) => [r.agent, r.persona])
    );
    eq(names.gamma, 'Old Salt', "gamma's operator-chosen name was carried into the profile");
    eq(names.alpha, 'Captain Quirk', "alpha's standing name was not overwritten");
    assert(!('delta' in names), 'a cast name from arrival order is not mistaken for a choice');
  }

  console.log('\none floor of a backup (costmo, 2026-11-19)');
  {
    // The case it is for: a full import, then the floor goes on working on the
    // other instance while this one goes on with its other floors. Both count
    // message ids on, so the other instance's new rows on the floor carry ids
    // this instance has since given to rows of its own.
    const FAR = 'far-floor';
    const far = await makeClient('fara', KEY, FAR);
    await call(far.client, 'send_message', { body: 'far one' });
    await call(far.client, 'send_message', { body: 'far two' });
    const t1 = await call(far.client, 'open_task', { title: 'far task' });
    const imported = await (await get('/api/admin/backup')).json();
    await close(far.transport);
    // This instance goes on, on another floor (a session of its own: the
    // restores above closed every session open before them).
    const here = await makeClient('alpha');
    await call(here.client, 'send_message', { body: 'here, after the import, one' });
    await call(here.client, 'send_message', { body: 'here, after the import, two' });
    await close(here.transport);
    const hereNow = await (await get('/api/admin/backup')).json();
    const hereIds = hereNow.tables.messages.filter((m) => m.channel === CHANNEL).map((m) => m.id).slice(-2);
    // The other instance went on, on the far floor, from the same ids.
    const doc = structuredClone(imported);
    const later = [0, 1, 2].map((i) => ({ id: hereIds[0] + i, channel: FAR, from_agent: 'farb', to_agent: null, body: JSON.stringify(`later ${i + 1}`), created_at: `2099-01-01 00:00:0${i}`, audience: null }));
    doc.tables.messages.push(...later);
    const task = doc.tables.tasks.find((t) => t.id === (t1.task?.id ?? t1.id));
    if (task) Object.assign(task, { status: 'done', updated_at: '2099-01-01 00:00:09' });
    doc.tables.contracts.push({ channel: FAR, key: 'far.k', value: '"v"', version: 1, updated_by: 'farb', updated_at: '2099-01-01 00:00:05' });
    const fa = doc.tables.agents.find((a) => a.channel === FAR && a.agent === 'fara');
    if (fa) fa.poll_cursor = later[1].id;
    doc.tables.agents.push({ ...fa, agent: 'farb', poll_cursor: 0 });
    doc.created_at = '2099-01-01T00:00:10.000Z';

    const listed = await postAdmin('backup/floors', { backup: doc });
    const farListed = listed.json.floors?.find((f) => f.channel === FAR);
    eq([listed.status, farListed?.messages, farListed?.tasks, farListed?.contracts, farListed?.here], [200, 5, 1, 1, true],
      'the page is told the floors a file holds, each with its counts and whether this instance has it');
    eq(listed.json.floors?.[0]?.channel, FAR, 'newest first');
    eq((await postAdmin('backup/restore-floor', { backup: doc, channel: FAR, confirm: 'RESTORE' })).status, 400, 'confirmed by typing the floor\'s name, not RESTORE');
    const none = await postAdmin('backup/restore-floor', { backup: doc, channel: 'nowhere', confirm: 'nowhere' });
    eq([none.status, none.json.code], [409, 'no_such_floor'], 'a floor the file does not hold is refused');

    const done = await postAdmin('backup/restore-floor', { backup: doc, channel: FAR, confirm: FAR });
    eq(done.status, 200, 'the floor restores');
    if (done.json.snapshot?.path) snapshots.push(done.json.snapshot.path);
    const after = await (await get('/api/admin/backup')).json();
    const farMsgs = after.tables.messages.filter((m) => m.channel === FAR).sort((a, b) => a.id - b.id);
    eq(farMsgs.map((m) => JSON.parse(m.body)), ['far one', 'far two', 'later 1', 'later 2', 'later 3'], 'every message on the floor, in the order it was written');
    const imp = imported.tables.messages.filter((m) => m.channel === FAR).map((m) => m.id);
    eq(farMsgs.slice(0, 2).map((m) => m.id), imp, 'the ones shared with the import keep their numbers');
    const top = Math.max(...hereNow.tables.messages.map((m) => m.id));
    assert(farMsgs.slice(2).every((m) => m.id > top), `and the ones whose numbers this instance had used are numbered above everything here — ${farMsgs.slice(2).map((m) => m.id)} over ${top}`);
    eq(after.tables.messages.filter((m) => hereIds.includes(m.id)).map((m) => [m.channel, JSON.parse(m.body)]),
      [[CHANNEL, 'here, after the import, one'], [CHANNEL, 'here, after the import, two']], 'this instance\'s own rows under those numbers are untouched');
    // later 3's number was free here, but it comes after two that were not:
    // kept, it would read before them.
    eq(done.json.renumbered?.messages?.count, 3, 'and the report says how many were renumbered: the first clash and every message after it');
    eq(after.tables.tasks.find((t) => t.channel === FAR)?.status, 'done', 'the task as the file has it');
    eq(after.tables.contracts.filter((c) => c.channel === FAR).map((c) => c.key), ['far.k'], 'the contract made there');
    eq(after.tables.agents.filter((a) => a.channel === FAR).map((a) => a.agent).sort(), ['fara', 'farb'], 'and the agent that joined there');
    eq(after.tables.agents.find((a) => a.channel === FAR && a.agent === 'fara')?.poll_cursor, farMsgs[3].id,
      'a read position follows its message to its new number: fara had read up to "later 2"');
    eq(after.tables.messages.filter((m) => m.channel === CHANNEL).length, hereNow.tables.messages.filter((m) => m.channel === CHANNEL).length,
      'every other floor is as it was');
    const audit = (await (await get(`/api/activity?channel=${FAR}&limit=20`)).json()).rows ?? [];
    assert(audit.some((r) => r.kind === 'admin.backup.restore_floor' && /renumbered/.test(r.detail ?? '')), 'with an audit row on the floor that says what was renumbered');

    // The other instance goes on again, and its floor is brought over again:
    // the rows this instance already has keep the numbers it gave them.
    const doc2 = structuredClone(doc);
    doc2.tables.messages.push({ id: later[2].id + 1, channel: FAR, from_agent: 'farb', to_agent: null, body: JSON.stringify('later 4'), created_at: '2099-01-01 00:00:20', audience: null });
    doc2.created_at = '2099-01-01T00:00:30.000Z';
    const again = await postAdmin('backup/restore-floor', { backup: doc2, channel: FAR, confirm: FAR });
    eq(again.status, 200, 'a newer file of the same floor restores over the first');
    if (again.json.snapshot?.path) snapshots.push(again.json.snapshot.path);
    const after2 = await (await get('/api/admin/backup')).json();
    const farMsgs2 = after2.tables.messages.filter((m) => m.channel === FAR).sort((a, b) => a.id - b.id);
    eq(farMsgs2.slice(0, 5).map((m) => m.id), farMsgs.map((m) => m.id), 'every message it had keeps the number this instance gave it');
    eq([JSON.parse(farMsgs2[5]?.body ?? 'null'), farMsgs2[5]?.id > farMsgs[4].id], ['later 4', true], 'and the new one comes after them');
    eq(after2.tables.admin_events.filter((r) => r.channel === FAR && r.action === 'backup.restore_floor').length, 2, 'the first restore\'s audit row is kept beside the second\'s');

    // The floor here now has something the file does not: refused, unchanged.
    const far2 = await makeClient('fara', KEY, FAR);
    await call(far2.client, 'send_message', { body: 'said here after the floor came over' });
    await close(far2.transport);
    const before = (await (await get('/api/admin/backup')).json()).tables.messages.filter((m) => m.channel === FAR).length;
    const refused = await postAdmin('backup/restore-floor', { backup: doc2, channel: FAR, confirm: FAR });
    eq([refused.status, refused.json.code], [409, 'floor_newer_here'], 'a floor here that holds something the file does not is refused');
    assert(/nothing was restored.*1 thing on far-floor the file does not: message #\d+/.test(refused.json.error ?? ''), `in words that name what would be lost — ${refused.json.error}`);
    eq((await (await get('/api/admin/backup')).json()).tables.messages.filter((m) => m.channel === FAR).length, before, 'and nothing changed');
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

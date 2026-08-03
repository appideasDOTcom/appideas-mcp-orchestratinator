// End-to-end test for the operator surface: /api/admin/*, the retire/archive
// flags, and the audit trail they leave in the activity feed.
//
// The read-only dashboard is covered by smoke.mjs; this file only exercises the
// mutating half, including the parts that are meant to REFUSE — an admin
// endpoint that quietly accepts a cross-origin POST is the failure mode that
// matters here, so those assertions come first and are not optional.
//   npm run test:admin
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { rmSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = Number(process.env.ADMIN_TEST_PORT ?? 8897);
const DB_PATH = `./data/admin-${process.pid}.db`;
const HOST = `http://localhost:${PORT}`;
const MCP = `${HOST}/mcp`;
const CHANNEL = 'admin-test';
const KEY = 'admin-shared-secret';
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
async function makeClient(agent) {
  const transport = new StreamableHTTPClientTransport(new URL(MCP), {
    requestInit: { headers: { 'X-Channel': CHANNEL, 'X-Agent': agent, [AUTH_HEADER]: KEY } },
  });
  const client = new Client({ name: `admin-${agent}`, version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
}
const close = async (t) => { try { await t.close(); } catch { /* already gone */ } };
const rmDb = (p) => { for (const ext of ['', '-wal', '-shm']) { try { rmSync(p + ext); } catch { /* ignore */ } } };

const state = () => fetch(`${HOST}/api/state`).then((r) => r.json());
const activity = () => fetch(`${HOST}/api/activity?limit=500`).then((r) => r.json());
const chan = async (name = CHANNEL) => (await state()).channels.find((c) => c.channel === name) ?? null;
const agentOf = async (name) => {
  const c = await chan();
  return c?.agents.find((a) => a.agent === name) ?? null;
};

/**
 * POST an admin route.
 *
 * No credential: the dashboard has no sign-in, so adminGuard's only question is
 * whether the request came from somewhere else. A plain fetch with no Origin is
 * exactly what the page itself sends.
 */
const post = (path, body, { headers = {} } = {}) =>
  fetch(`${HOST}/api/admin/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const postJson = async (path, body, opts) => {
  const res = await post(path, body, opts);
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

const server = spawn('node', ['src/server.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH,
    // The key guards /mcp only — every agent below presents it. The dashboard and
    // its operator routes are open, which is what the guard block asserts.
    ORCH_AUTH_TOKEN: KEY,
    ORCH_AUTH_MODE: 'enforce',
    CLAIM_TTL_MINUTES: '15',
  },
  stdio: 'inherit',
});

let alpha;
let beta;

try {
  if (!(await waitHealthy())) throw new Error('server did not become healthy');
  console.log('server healthy\n');

  // --- seed a channel worth operating on ------------------------------------
  alpha = await makeClient('alpha');
  beta = await makeClient('beta');
  await call(alpha.client, 'set_contract', { key: 'iface.v1', value: { args: ['a'] } });
  await call(alpha.client, 'send_message', { body: 'broadcast one' });
  await call(alpha.client, 'send_message', { body: 'broadcast two' });
  await call(alpha.client, 'send_message', { to: 'beta', body: 'a direct one' });
  const t1 = (await call(alpha.client, 'open_task', { title: 'unassigned work' })).id;
  const t2 = (await call(alpha.client, 'open_task', { title: 'beta work', assignee: 'beta' })).id;
  const t3 = (await call(alpha.client, 'open_task', { title: 'claimed work' })).id;
  await call(beta.client, 'claim_task', { id: t3 });

  console.log('guard: what must be refused');
  {
    // The whole guard, now that there is no dashboard credential to check. A page
    // on another origin can fire this request at the port; it must not be honoured,
    // or "open on my machine" quietly becomes "open to every site my browser loads".
    const foreignOrigin = await post(
      'agent/advance',
      { channel: CHANNEL, agent: 'beta', up_to_id: 1 },
      { headers: { origin: 'https://evil.example' } }
    );
    assert(foreignOrigin.status === 403, 'a write from a foreign Origin → 403');

    const crossSite = await post(
      'agent/advance',
      { channel: CHANNEL, agent: 'beta', up_to_id: 1 },
      { headers: { 'sec-fetch-site': 'cross-site' } }
    );
    assert(crossSite.status === 403, 'Sec-Fetch-Site: cross-site → 403');

    const sameOrigin = await post(
      'agent/advance',
      { channel: CHANNEL, agent: 'beta', up_to_id: 0 },
      { headers: { origin: HOST } }
    );
    assert(sameOrigin.status === 200, 'the same Origin is allowed through');

    // No Origin at all is curl, or a same-origin GET. Absence cannot be treated as
    // hostile, and on this build it is the ordinary case rather than a loophole.
    const noOrigin = await post('agent/advance', { channel: CHANNEL, agent: 'beta', up_to_id: 0 });
    assert(noOrigin.status === 200, 'a request with no Origin is allowed through');

    // The agent door is a separate question, and it is still locked.
    const mcp = await fetch(MCP, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert(mcp.status === 401, '/mcp still refuses a client with no shared secret');
  }

  console.log('\nthe dashboard needs no credential');
  {
    const page = await fetch(`${HOST}/`);
    const html = await page.text();
    assert(page.status === 200, 'the board is served to a browser with nothing to present');
    assert(/api\/state/.test(html) || /app\.js/.test(html), 'and it is the dashboard, not a sign-in form');

    for (const gone of ['/api/session', '/api/admin/token', '/api/admin/users']) {
      const res = await fetch(`${HOST}${gone}`);
      assert(res.status === 404, `${gone} no longer exists`);
    }
    const login = await fetch(`${HOST}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'costmo', password: 'whatever' }),
    });
    assert(login.status === 404, '/api/login no longer exists');
  }

  console.log('\nadvance a cursor (mark read)');
  {
    const before = await agentOf('beta');
    assert(before.unread === 3, `beta starts with 3 unread (got ${before.unread})`);
    assert(before.unread_max_id === 3, `and reports the id to advance to (got ${before.unread_max_id})`);

    const { status, json } = await postJson('agent/advance', {
      channel: CHANNEL, agent: 'beta', up_to_id: before.unread_max_id,
    });
    eq([status, json.cleared, json.unread], [200, 3, 0], 'advancing to that id clears all three');
    const after = await agentOf('beta');
    eq(after.unread, 0, 'the board agrees the mailbox is clear');

    // A stale dialog holding an old id must not be able to rewind the cursor and
    // resurrect messages the agent has already dealt with.
    await postJson('agent/advance', { channel: CHANNEL, agent: 'beta', up_to_id: 1 });
    eq((await agentOf('beta')).unread, 0, 'a lower up_to_id cannot rewind the cursor');

    // The agent's own view has to agree: nothing it already had is re-delivered.
    const reread = await call(beta.client, 'poll_messages', { since: 3 });
    eq(reread.count, 0, 'beta re-polling past the cursor sees nothing new');

    const unknown = await postJson('agent/advance', { channel: CHANNEL, agent: 'nobody', up_to_id: 1 });
    eq(unknown.status, 404, 'advancing an agent that does not exist → 404');
    const bad = await postJson('agent/advance', { channel: CHANNEL, agent: 'beta', up_to_id: -2 });
    eq(bad.status, 400, 'a negative up_to_id → 400');
  }

  console.log('\nclose and reassign tasks');
  {
    const closed = await postJson('task/close', { channel: CHANNEL, id: t1, note: 'obsolete' });
    eq([closed.status, closed.json.ok], [200, true], 'an unassigned open task closes');

    // The point of the reserved actor: operator cleanup must never read as an
    // agent finishing work.
    const feed = (await activity()).rows;
    const row = feed.find((r) => r.kind === 'task.done' && r.ref_id === t1);
    eq(row?.actor, 'operator', 'the closed task is attributed to "operator", not an agent');

    // A task another agent holds can be closed too — the MCP tool already allowed
    // this, and pretending otherwise here would just be a lie about ownership.
    const claimed = await postJson('task/close', { channel: CHANNEL, id: t3, note: 'abandoned' });
    eq(claimed.status, 200, "a task claimed by an agent can be closed");
    const feed2 = (await activity()).rows;
    eq(feed2.find((r) => r.kind === 'task.done' && r.ref_id === t3)?.actor, 'beta', 'and keeps its original claimant in the log');

    const again = await postJson('task/close', { channel: CHANNEL, id: t1 });
    eq(again.status, 404, 'closing an already-done task → 404');

    const re = await postJson('task/reassign', { channel: CHANNEL, id: t2, assignee: 'alpha' });
    eq([re.status, re.json.assignee], [200, 'alpha'], 'an open task can be reassigned');
    eq((await agentOf('alpha')).assigned_open, 1, 'and the new assignee now carries it');
    const un = await postJson('task/reassign', { channel: CHANNEL, id: t2, assignee: null });
    eq([un.status, un.json.assignee], [200, null], 'and can be put back in the unassigned pool');
    eq((await chan()).tasks.unassigned_open, 1, 'where the channel counts it as unassigned');

    // The dialog needs to be able to name a task, not just count it.
    const list = (await chan()).task_list;
    assert(list.some((t) => t.id === t2) && !list.some((t) => t.id === t1), 'task_list carries unfinished tasks only');
  }

  console.log('\nretire an agent');
  {
    await call(alpha.client, 'send_message', { to: 'beta', body: 'one more for the pile' });
    const before = await agentOf('beta');
    assert(before.unread > 0, 'beta has a backlog to clear');
    assert(before.sessions > 0, 'and a live session to close');

    const { status, json } = await postJson('agent/retire', { channel: CHANNEL, agent: 'beta' });
    assert(status === 200 && json.cleared === before.unread, `retiring clears the backlog (${json.cleared})`);
    assert(json.sessions_closed >= 1, `and closes the live session(s) (${json.sessions_closed})`);

    const c = await chan();
    assert(!c.agents.some((a) => a.agent === 'beta'), 'beta is off the visible board');
    const hidden = c.retired_agents.find((a) => a.agent === 'beta');
    assert(!!hidden && hidden.retired === true, 'but is reported in retired_agents, not dropped silently');
    eq((await state()).totals.retired_agents, 1, 'and is counted in the totals');

    // Removal is honest towards the agents too, not just the human: a retired
    // agent stops showing up as present on the channel.
    const present = await call(alpha.client, 'whoami');
    assert(!present.present.some((a) => a.agent === 'beta'), 'whoami no longer lists it as present');

    // The chosen semantic: a window that is really still alive comes back by
    // itself. This is the assertion that would catch a "sticky hide" regression.
    const revived = await makeClient('beta');
    await call(revived.client, 'whoami');
    await close(revived.transport);
    const c2 = await chan();
    assert(c2.agents.some((a) => a.agent === 'beta'), 'an agent that calls a tool again un-retires itself');
    eq(c2.retired_agents.length, 0, 'and is no longer listed as retired');
  }

  console.log('\nretire and restore by hand');
  {
    await postJson('agent/retire', { channel: CHANNEL, agent: 'alpha' });
    assert((await chan()).retired_agents.some((a) => a.agent === 'alpha'), 'alpha retired');
    const { status } = await postJson('agent/unretire', { channel: CHANNEL, agent: 'alpha' });
    eq(status, 200, 'unretire accepted');
    assert((await chan()).agents.some((a) => a.agent === 'alpha'), 'alpha is back on the board');
    const unknown = await postJson('agent/unretire', { channel: CHANNEL, agent: 'nobody' });
    eq(unknown.status, 404, 'unretiring an agent that does not exist → 404');

    // Retiring alpha closed its session, so the old client is dead by design —
    // an unknown session id answers 404 and a real client would re-initialise.
    // Do that here, because the tests below need a live session on the channel.
    const dead = await call(alpha.client, 'whoami').then(() => null, (e) => e);
    assert(!!dead, 'the retired agent\'s old session really is gone');
    await close(alpha.transport);
    alpha = await makeClient('alpha');
  }

  console.log('\narchive a channel');
  {
    const { status } = await postJson('channel/archive', { channel: CHANNEL });
    eq(status, 200, 'archive accepted');
    const c = await chan();
    assert(c.archived === true && !!c.archived_at, 'the channel is flagged archived, with a timestamp');
    const s = await state();
    eq([s.totals.channels, s.totals.archived_channels], [0, 1], 'totals exclude it but still count it');
    assert(c.messages > 0, 'and nothing was deleted');

    // Archiving is not a session kill: agents on the channel keep working, which
    // is what makes it safe to use as a "not looking at this now" gesture.
    const stillWorks = await call(alpha.client, 'whoami');
    eq(stillWorks.channel, CHANNEL, 'an agent on an archived channel keeps working');

    await postJson('channel/unarchive', { channel: CHANNEL });
    const back = await chan();
    assert(back.archived === false, 'unarchive puts it back');
    eq((await state()).totals.channels, 1, 'and it counts again');
  }

  console.log('\ndelete a channel');
  {
    const before = await chan();
    assert(before.messages > 0 && before.contracts > 0, 'there is something to destroy');

    const wrong = await postJson('channel/delete', { channel: CHANNEL, confirm: 'admin-tes' });
    eq(wrong.status, 400, 'a confirmation that does not match exactly → 400');
    assert((await chan()) !== null, 'and nothing was deleted');

    const { status, json } = await postJson('channel/delete', { channel: CHANNEL, confirm: CHANNEL });
    eq(status, 200, 'an exact confirmation deletes');
    assert(json.deleted.messages > 0 && json.deleted.contracts > 0, 'and reports what it destroyed');
    assert(json.sessions_closed >= 1, 'live sessions on the channel are closed too');
    eq(await chan(), null, 'the channel is gone from the board');

    // The board forgets the channel; the log does not forget you deleted it.
    const feed = (await activity()).rows;
    const record = feed.find((r) => r.kind === 'admin.channel.delete');
    assert(!!record, 'the deletion is still recorded in the activity feed');
    eq(record?.actor, 'operator', 'attributed to the operator');
    assert(!feed.some((r) => r.kind === 'message' && r.channel === CHANNEL), 'while the channel\'s messages are really gone');
  }

  console.log('\naudit trail');
  {
    const rows = (await activity()).rows.filter((r) => r.kind.startsWith('admin.'));
    const kinds = new Set(rows.map((r) => r.kind));
    for (const k of ['admin.advance', 'admin.retire', 'admin.unretire', 'admin.task.close', 'admin.task.reassign', 'admin.channel.archive', 'admin.channel.unarchive', 'admin.channel.delete']) {
      assert(kinds.has(k), `${k} is in the feed`);
    }
    assert(rows.every((r) => r.actor === 'operator'), 'every operator row is attributed to "operator"');
    assert(rows.every((r) => !!r.detail), 'and says what actually happened');
  }
} catch (err) {
  console.error('admin test error:', err);
  failures++;
} finally {
  if (alpha) await close(alpha.transport);
  if (beta) await close(beta.transport);
  server.kill('SIGKILL');
  rmDb(DB_PATH);
}

console.log(`\n${failures === 0 ? 'PASS ✅' : 'FAIL ❌'} — ${failures} failure(s)`);
process.exit(failures ? 1 : 0);

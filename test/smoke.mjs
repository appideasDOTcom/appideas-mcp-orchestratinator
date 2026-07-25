// End-to-end smoke test: spawns the server, connects two clients (free + pro)
// with header-bound identities, and exercises contracts, messages, tasks, and
// the stale-claim self-heal.
//   npm run smoke
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { rmSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = Number(process.env.SMOKE_PORT ?? 8899);
const DB_PATH = `./data/smoke-${process.pid}.db`;
const BASE = `http://localhost:${PORT}/mcp`;
const CHANNEL = 'smoke-pair';

let failures = 0;
const assert = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures++;
};
const parse = (res) => JSON.parse(res.content[0].text);
const call = (client, name, args = {}) => client.callTool({ name, arguments: args }).then(parse);

function startServer(port, dbPath, extraEnv = {}) {
  return spawn('node', ['src/server.js'], {
    env: { ...process.env, PORT: String(port), DB_PATH: dbPath, ...extraEnv },
    stdio: 'inherit',
  });
}
async function waitHealthy(port) {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://localhost:${port}/health`)).ok) return true; } catch { /* retry */ }
    await sleep(100);
  }
  return false;
}
async function makeClient(agent, base) {
  const transport = new StreamableHTTPClientTransport(new URL(base), {
    requestInit: { headers: { 'X-Channel': CHANNEL, 'X-Agent': agent } },
  });
  const client = new Client({ name: `smoke-${agent}`, version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
}
/**
 * Hand-rolled initialize: no notification stream, no DELETE — i.e. what a client
 * that opens a throwaway session per turn leaves behind on the server.
 */
async function rawInitialize(port, agent) {
  const res = await fetch(`http://localhost:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'X-Channel': CHANNEL,
      'X-Agent': agent,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke-raw', version: '0.0.0' } },
    }),
  });
  await res.text(); // drain so the response stream doesn't stay open
  return res.headers.get('mcp-session-id');
}
const rmDb = (p) => { for (const ext of ['', '-wal', '-shm']) { try { rmSync(p + ext); } catch { /* ignore */ } } };

const server = startServer(PORT, DB_PATH);

try {
  if (!(await waitHealthy(PORT))) throw new Error('server did not become healthy');
  console.log('server healthy\n');

  const { client: free, transport: freeT } = await makeClient('free', BASE);
  const { client: pro, transport: proT } = await makeClient('pro', BASE);

  console.log('identity / presence');
  const who = await call(free, 'whoami');
  assert(who.channel === CHANNEL && who.agent === 'free', 'free identity bound from header');

  console.log('contracts');
  const set1 = await call(free, 'set_contract', { key: 'filters.sync_payload', value: { args: ['post_id', 'payload'], since: '1.0' } });
  assert(set1.version === 1, 'first contract write is version 1');
  const got = await call(pro, 'get_contract', { key: 'filters.sync_payload' });
  assert(got.entry?.value?.since === '1.0', 'pro reads contract written by free');
  const set2 = await call(free, 'set_contract', { key: 'filters.sync_payload', value: { args: ['post_id', 'payload', 'ctx'], since: '1.1' } });
  assert(set2.version === 2, 'rewrite bumps version to 2');

  console.log('messages');
  await call(free, 'send_message', { to: 'pro', body: { kind: 'heads-up', text: 'signature is now 3 args' } });
  await call(free, 'send_message', { body: 'broadcast: contract v2 landed' });
  const poll1 = await call(pro, 'poll_messages', {});
  assert(poll1.count === 2, 'pro receives direct message + broadcast');
  const poll2 = await call(pro, 'poll_messages', { since: poll1.cursor });
  assert(poll2.count === 0, 'cursor prevents re-reading messages');
  const selfPoll = await call(free, 'poll_messages', {});
  assert(selfPoll.count === 0, 'sender does not receive its own messages');

  console.log('tasks');
  const opened = await call(free, 'open_task', { title: 'update consumers to 3-arg filter', assignee: 'pro' });
  const tid = opened.id;
  const openList = await call(pro, 'list_tasks', { status: 'open' });
  assert(openList.tasks.some((t) => t.id === tid), 'pro sees the open task');
  const claimed = await call(pro, 'claim_task', { id: tid });
  assert(claimed.claimed === true, 'pro claims the task');
  const mine = await call(pro, 'list_tasks', { mine: true });
  assert(mine.tasks.some((t) => t.id === tid && t.status === 'claimed'), 'task shows as claimed by pro');
  const done = await call(pro, 'complete_task', { id: tid, note: 'done in PR #42' });
  assert(done.completed === true, 'pro completes the task');

  console.log('dashboard');
  await call(pro, 'set_status', { status: 'waiting', detail: 'e2e public tier, ~8m', ttl_seconds: 600 });
  const state = await (await fetch(`http://localhost:${PORT}/api/state`)).json();
  const chan = state.channels.find((c) => c.channel === CHANNEL);
  assert(!!chan, 'dashboard state lists the channel');
  assert(state.sessions.length === 2, 'both live MCP sessions are reported as connected');
  assert(chan.agents.every((a) => a.presence === 'connected'), 'free + pro show as connected');
  const proAgent = chan.agents.find((a) => a.agent === 'pro');
  assert(proAgent?.state.source === 'reported', 'self-reported status wins for pro');
  assert(proAgent?.state.label === 'waiting', 'reported state is the enum, not a guess');
  assert(proAgent?.state.detail === 'e2e public tier, ~8m', 'the human-readable detail survives to the dashboard');
  // The age display free asked for is only honest if the timestamp is exposed.
  assert(!!proAgent?.reported_at && !!proAgent?.reported_expires_at, 'reported status carries its timestamp and expiry');
  assert(Date.parse(proAgent.reported_expires_at) > Date.parse(proAgent.reported_at), 'expiry is after the report');

  // The tone must come from the declared state, not from keywords in prose —
  // "reviewing the design" is work, and the old regex called it waiting.
  await call(free, 'set_status', { status: 'working', detail: 'reviewing pending blocked design' });
  const toned = await (await fetch(`http://localhost:${PORT}/api/state`)).json();
  const freeToned = toned.channels.find((c) => c.channel === CHANNEL).agents.find((a) => a.agent === 'free');
  assert(freeToned?.state.tone === 'busy', 'tone follows the declared state, not words in the detail');
  assert(chan.tasks.done === 1 && chan.contracts === 1, 'channel task/contract counts');

  // `blocked` must be distinguishable from `waiting` — one needs a human, the
  // other resolves on its own, and a single "waiting" tone hides the difference.
  await call(pro, 'set_status', { status: 'blocked', detail: 'needs a decision on AISS_Otp' });
  const blockedState = await (await fetch(`http://localhost:${PORT}/api/state`)).json();
  const proBlocked = blockedState.channels.find((c) => c.channel === CHANNEL).agents.find((a) => a.agent === 'pro');
  assert(proBlocked.state.tone === 'blocked', 'blocked gets its own tone, distinct from waiting');

  // A free-form status has to be refused: accepting it silently would put the
  // tone back on keyword-guessing, which is the thing the enum replaced.
  const loose = await pro.callTool({ name: 'set_status', arguments: { status: 'waiting on e2e' } })
    .then((r) => ({ rejected: r?.isError === true }), () => ({ rejected: true }));
  assert(loose.rejected, 'a free-form status is refused rather than silently guessed at');

  const feed = await (await fetch(`http://localhost:${PORT}/api/activity?limit=50`)).json();
  const kinds = feed.rows.map((r) => r.kind);
  assert(kinds.includes('message') && kinds.includes('task.opened') && kinds.includes('contract.set'),
    'activity feed spans messages, tasks and contracts');
  assert(kinds.includes('task.done'), 'task completion appears in the feed');
  const times = feed.rows.map((r) => Date.parse(r.ts));
  assert(times.every((t, i) => i === 0 || times[i - 1] >= t), 'feed is ordered newest-first');
  assert(feed.rows.every((r) => r.channel === CHANNEL), 'feed rows carry their channel');
  const scoped = await (await fetch(`http://localhost:${PORT}/api/activity?channel=nope`)).json();
  assert(scoped.count === 0, 'channel filter scopes the feed');

  const page = await fetch(`http://localhost:${PORT}/`);
  const html = await page.text();
  assert(page.ok && html.includes('<title>orchestratinator</title>'), 'dashboard html is served at /');

  console.log('session lifecycle');
  const bogus = await fetch(`http://localhost:${PORT}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': 'no-such-session' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert(bogus.status === 404, 'an unknown session id gets 404 (the spec cue to re-initialize)');

  // Model the client that opens a fresh session per turn and never tears the old
  // one down (no held-open SSE stream, no DELETE). Sessions like these must not
  // pile up: the newer one retires the older one for the same identity.
  const ghost1 = await rawInitialize(PORT, 'ghost');
  const ghost2 = await rawInitialize(PORT, 'ghost');
  assert(!!ghost1 && !!ghost2 && ghost1 !== ghost2, 'two throwaway sessions really are distinct');

  const health = await (await fetch(`http://localhost:${PORT}/health`)).json();
  assert(health.session_stats.superseded >= 1, 'the abandoned session is superseded, not leaked');
  assert(health.sessions === 3, `only the live sessions remain (${health.sessions}: free, pro, ghost)`);

  const retired = await fetch(`http://localhost:${PORT}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': ghost1 },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert(retired.status === 404, 'the superseded session answers 404 so the client re-initializes');

  const after = await (await fetch(`http://localhost:${PORT}/api/state`)).json();
  const agents = after.channels.find((c) => c.channel === CHANNEL).agents;
  const ghostAfter = agents.find((a) => a.agent === 'ghost');
  assert(ghostAfter.presence === 'connected' && ghostAfter.sessions === 1, 'the churning agent reads as connected, once');
  // The safety property: a client holding an open notification stream is really
  // there, so a reconnect must never yank it.
  assert(agents.find((a) => a.agent === 'pro').sessions === 1, 'a streaming session is left alone');

  await freeT.close();
  await proT.close();
} catch (err) {
  console.error('smoke error:', err);
  failures++;
} finally {
  server.kill('SIGKILL');
  rmDb(DB_PATH);
}

// --- self-heal: stale claims and stale statuses ------------------------------
// Run against a second server with both TTLs at 0, so anything written is
// already expired and the fallback paths are the ones under test.
{
  const PORT2 = PORT + 1;
  const DB2 = `./data/smoke-heal-${process.pid}.db`;
  const BASE2 = `http://localhost:${PORT2}/mcp`;
  const server2 = startServer(PORT2, DB2, { CLAIM_TTL_MINUTES: '0', STATUS_TTL_SECONDS: '0' });
  try {
    console.log('\nself-heal (stale claims)');
    if (!(await waitHealthy(PORT2))) throw new Error('heal server did not become healthy');
    const { client: free2, transport: free2T } = await makeClient('free', BASE2);
    const { client: pro2, transport: pro2T } = await makeClient('pro', BASE2);

    const t = await call(free2, 'open_task', { title: 'abandoned task', assignee: 'pro' });
    await call(pro2, 'claim_task', { id: t.id });
    // Inspection query does NOT heal:
    const claimedView = await call(pro2, 'list_tasks', { status: 'claimed' });
    assert(claimedView.tasks.some((x) => x.id === t.id), 'status=claimed inspection does not mutate');
    // Actionable open-poll DOES heal:
    const openView = await call(pro2, 'list_tasks', { status: 'open' });
    assert(openView.tasks.some((x) => x.id === t.id), 'stale claim auto-reopened on open-poll');
    assert((openView.reopened_stale_claims ?? 0) >= 1, 'reopened_stale_claims reported');

    // The property that matters for status: an expired one is treated as absent
    // and the board falls back to inference. A crashed agent must not be able to
    // strand "waiting" on the dashboard forever — that is a confident wrong
    // answer, which is worse than admitting we don't know.
    console.log('\nself-heal (stale status)');
    const written = await call(free2, 'set_status', { status: 'waiting', detail: 'run that never finished' });
    assert(written.set === true, 'the status was accepted and stored');
    const heal = await (await fetch(`http://localhost:${PORT2}/api/state`)).json();
    const freeHealed = heal.channels.find((c) => c.channel === CHANNEL).agents.find((a) => a.agent === 'free');
    assert(freeHealed.reported_status === 'waiting', 'the stored status is still on record');
    assert(freeHealed.reported_expired === true, 'and is reported as expired');
    assert(freeHealed.state.source === 'derived', 'an expired status falls back to a derived state');
    assert(freeHealed.state.label !== 'waiting', 'the stale label is not what the human is shown');

    await free2T.close();
    await pro2T.close();
  } catch (err) {
    console.error('self-heal smoke error:', err);
    failures++;
  } finally {
    server2.kill('SIGKILL');
    rmDb(DB2);
  }
}

console.log(`\n${failures === 0 ? 'PASS ✅' : 'FAIL ❌'} — ${failures} failure(s)`);
process.exit(failures ? 1 : 0);

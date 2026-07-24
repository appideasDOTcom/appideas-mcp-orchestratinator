// End-to-end smoke test: spawns the server, connects two clients (free + pro)
// with header-bound identities, and exercises contracts, messages, and tasks.
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

async function makeClient(agent) {
  const transport = new StreamableHTTPClientTransport(new URL(BASE), {
    requestInit: { headers: { 'X-Channel': CHANNEL, 'X-Agent': agent } },
  });
  const client = new Client({ name: `smoke-${agent}`, version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
}

const server = spawn('node', ['src/server.js'], {
  env: { ...process.env, PORT: String(PORT), DB_PATH },
  stdio: 'inherit',
});

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) { up = true; break; } } catch { /* retry */ }
    await sleep(100);
  }
  if (!up) throw new Error('server did not become healthy');
  console.log('server healthy\n');

  const { client: free, transport: freeT } = await makeClient('free');
  const { client: pro, transport: proT } = await makeClient('pro');

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

  await freeT.close();
  await proT.close();

  console.log(`\n${failures === 0 ? 'PASS ✅' : 'FAIL ❌'} — ${failures} failure(s)`);
} catch (err) {
  console.error('smoke error:', err);
  failures++;
} finally {
  server.kill('SIGKILL');
  for (const ext of ['', '-wal', '-shm']) { try { rmSync(DB_PATH + ext); } catch { /* ignore */ } }
  process.exit(failures ? 1 : 0);
}

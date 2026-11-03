// What the board writes when it could not answer — issue #5 step 3, costmo's
// "Hold + slow request" (task 258). A real server, run with a preload that
// holds its event loop on SIGUSR2 the way a better-sqlite3 lock wait or a heavy
// synchronous route would: the stand-in staged on a private board on
// 2026-11-03, where six 12 s holds gave the host six timeouts and the board
// wrote nothing. Every assertion reads the server's own output.
//
// Most of what is asserted is what is NOT written: a stream open past 2 s, a
// work poll inside its own wait, an ordinary request, a request that queued
// behind a hold. A line on every slow-looking request would bury the one that
// held the loop, which is the only one the line is for.
//   npm run test:boardlog
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.BOARD_LOG_TEST_PORT ?? 8898);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 'board-log-secret';
const DB_PATH = `./data/board-log-${process.pid}.db`;
const PRELOAD = join(tmpdir(), `orch-hold-${process.pid}.mjs`);

let failures = 0;
const assert = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures++;
};
const rmDb = () => { for (const ext of ['', '-wal', '-shm']) { try { rmSync(DB_PATH + ext); } catch { /* none */ } } };

// The hold: SIGUSR2 busy-waits the loop for whatever the hold file says.
writeFileSync(PRELOAD, [
  "import { readFileSync } from 'node:fs';",
  `process.on('SIGUSR2', () => { const ms = Number(readFileSync(${JSON.stringify(`${PRELOAD}.ms`)}, 'utf8')); const end = Date.now() + ms; while (Date.now() < end) { /* held */ } });`,
].join('\n'));
const holdFor = (ms) => { writeFileSync(`${PRELOAD}.ms`, String(ms)); server.kill('SIGUSR2'); };

let out = '';
const since = () => { const at = out.length; return () => out.slice(at); };
const get = (path, headers = {}) => fetch(`${BASE}${path}`, { headers: { 'x-orchestratinator-key': KEY, ...headers } });

rmDb();
const server = spawn('node', ['--import', PRELOAD, 'src/server.js'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DB_PATH, ORCH_AUTH_TOKEN: KEY, ORCH_AUTH_MODE: 'enforce' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => { out += d; });
server.stderr.on('data', (d) => { out += d; });

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(`${BASE}/health`)).ok; } catch { await sleep(100); } }
  if (!up) throw new Error('server never became healthy');
  await sleep(300);

  console.log('board log: the loop held');
  let after = since();
  holdFor(1600);
  await sleep(1600 + 700); // the line is written when the hold ends, at the next tick
  // Read by the next tick, so a 1600 ms hold reads 1350–1600 depending on where
  // in the 250 ms period it began.
  assert(/\[orchestratinator\] event loop held (1[3-9]\d\d|2\d\d\d)ms/.test(after()), 'a hold of the event loop past a second is written, with how long it was held');
  after = since();
  holdFor(500);
  await sleep(500 + 700);
  assert(!/event loop held/.test(after()), 'and a hold under a second is not');

  console.log('\nboard log: a slow request');
  // A work poll asks to be held for its wait; held past that by the loop, it
  // is slow. Path only: the poll's query names the host and must not appear.
  after = since();
  const held = get('/api/host/work?host_id=secret-host-name&wait=1');
  await sleep(200);
  holdFor(3500);
  await held;
  await sleep(300);
  const heldLine = /\[orchestratinator\] slow GET \/api\/host\/work (\d+)ms 200/.exec(after());
  assert(!!heldLine && Number(heldLine[1]) > 3000, 'a request held past its allowance is written as slow, with its method, path, time and status');
  assert(!/secret-host-name|wait=1/.test(after()), 'with the path only — nothing from its query');

  console.log('\nboard log: what is not slow');
  after = since();
  const t0 = Date.now();
  await get('/api/host/work?host_id=h2&wait=3').then((r) => r.json());
  const waited = Date.now() - t0;
  await sleep(200);
  assert(waited > 2900 && !/slow/.test(after()), `a work poll that takes its own wait (${waited}ms) is not slow`);

  after = since();
  const ac = new AbortController();
  const stream = await fetch(`${BASE}/api/floor/stream?channel=c&agent=a`, { signal: ac.signal });
  await sleep(2600);
  ac.abort();
  try { await stream.body?.cancel(); } catch { /* aborted */ }
  await sleep(300);
  assert(stream.status === 200 && !/slow/.test(after()), 'nor is an event stream held open past 2 s');

  after = since();
  for (const p of ['/health', '/api/floor', '/api/state']) await get(p).then((r) => r.text());
  await sleep(300);
  assert(after() === '', 'an ordinary request writes nothing at all');

  // Queued behind a hold, a request is only parsed once the loop lets go — so
  // it is not the one called slow, though its caller waited the whole hold.
  after = since();
  holdFor(2600);
  await sleep(100);
  const q0 = Date.now();
  await get('/health').then((r) => r.text());
  const queued = Date.now() - q0;
  await sleep(300);
  assert(queued > 2000 && /event loop held/.test(after()) && !/slow GET \/health/.test(after()),
    `a request that waited ${queued}ms behind a hold is not called slow; the hold is`);
} catch (err) {
  console.error(err);
  failures++;
} finally {
  if (failures) console.log(`\n--- server output ---\n${out.trim()}\n---------------------`);
  try { server.kill('SIGKILL'); } catch { /* gone */ }
  rmDb();
  for (const f of [PRELOAD, `${PRELOAD}.ms`]) { try { rmSync(f); } catch { /* gone */ } }
}

console.log(failures ? `\nboardlog: ${failures} failed` : '\nboardlog: all passed');
process.exit(failures ? 1 : 0);

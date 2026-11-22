#!/usr/bin/env node
/**
 * A hung poll must not freeze the page (task 264). Serves <repo> — the tree,
 * or a copy holding an older src/ui — on 127.0.0.1:8951 behind hold-proxy.mjs
 * on :8953, opens the real page through the proxy, SIGKILLs the board at
 * t=6 s with the browser's connections held open, starts a fresh one at
 * t=10 s, and samples once a second for 30 s, on the board view and then the
 * floor view. Measured before the fix (2026-11-03): no poll at all after the
 * kill, the dot green and "connected" for as long as the page stayed open.
 *
 *   node --experimental-websocket check-poll-timeout.mjs <repo> <out dir>
 *
 * It asserts, per view:
 *   - within 12 s of the kill the dot is down and says "cannot reach the server";
 *   - within 12 s of the fresh board the header's server time moves again;
 *   - floor view: an /api/floor reaches the fresh board within 12 s, and no
 *     two /api/floor requests after the kill are more than 10 s apart.
 * Ports 8951 and 8953 are its own; nothing touches :8787.
 */
import { spawn, execSync } from 'node:child_process';
import { readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from './drive.mjs';
// The Node floor in words, before better-sqlite3 is opened: a Node-API 9 node
// segfaults on it with none (src/node-floor.js). A copy holding an older src/
// has no such file, and that is not this script's fault to report.
await import('../../../src/node-floor.js').catch((e) => { if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e; });

const HERE = dirname(fileURLToPath(import.meta.url));
const [, , repo, out] = process.argv;
if (!repo || !out) { console.error('usage: check-poll-timeout.mjs <repo> <out dir>'); process.exit(2); }
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
let fails = 0;
const check = (ok, what) => { console.log(`  ${ok ? '✓' : '✗'} ${what}`); if (!ok) fails++; };

let board = null;
const startBoard = async () => {
  board = spawn(process.execPath, [join(repo, 'src/server.js')], { cwd: repo, env: { ...process.env, PORT: '8951', HOST: '127.0.0.1', DB_PATH: join(out, 'board.db'), ORCH_AUTH_TOKEN: 'k' }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { if ((await fetch('http://127.0.0.1:8951/health')).ok) return; } catch { /* not yet */ } await sleep(250); }
  throw new Error('the board on 8951 did not come up');
};
const SAMPLE = `JSON.stringify({ dot: document.getElementById('live-dot')?.className, title: document.getElementById('live-dot')?.title || '', now: ((document.getElementById('server-meta')?.textContent || '').match(/(\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d)Z$/) || [])[1] || '' })`;

async function run(view) {
  const logFile = join(out, `proxy-${view}.log`);
  rmSync(logFile, { force: true });
  for (const ext of ['', '-wal', '-shm']) rmSync(join(out, `board.db${ext}`), { force: true });
  await startBoard();
  const proxy = spawn(process.execPath, [join(HERE, 'hold-proxy.mjs'), '8953', '8951', logFile], { env: { ...process.env, HOLD: '1' }, stdio: 'ignore' });
  await sleep(400);
  const page = await open({ base: 'http://127.0.0.1:8953', view });
  const t0 = Date.now();
  const rows = [];
  let killedAt = 0, freshAt = 0;
  for (let s = 0; s <= 30; s++) {
    if (s === 6) { board.kill('SIGKILL'); killedAt = Date.now(); }
    if (s === 10) { await startBoard(); freshAt = Date.now(); }
    rows.push({ s, ...JSON.parse(await page.evalJs(SAMPLE)) });
    await sleep(Math.max(0, t0 + (s + 1) * 1000 - Date.now()));
  }
  await page.close();
  proxy.kill('SIGKILL');
  board.kill('SIGKILL');
  console.log(`\n${view} view`);
  for (const r of rows) if (r.s % 3 === 0 || (r.s >= 5 && r.s <= 12)) console.log(`    t=${String(r.s).padStart(2)}s ${r.dot.padEnd(9)} ${r.now}  ${r.title.slice(0, 70)}`);
  const before = rows.find((r) => r.s === 5)?.now ?? '';
  check(rows.some((r) => r.s > 6 && r.s <= 18 && /\bdown\b/.test(r.dot) && /cannot reach the server/.test(r.title)), `within 12 s of the board going away the dot says so (${rows.find((r) => r.s > 6 && /\bdown\b/.test(r.dot))?.title.slice(0, 60) ?? 'it never did'})`);
  check(rows.some((r) => r.s > 10 && r.s <= 22 && r.now && r.now > before), `within 12 s of a fresh board the header's server time moves again (was ${before}, last ${rows.at(-1).now})`);
  if (view === 'floor') {
    const lines = readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
    const at = (l) => Date.parse(l.split(' ')[0]);
    const refused = new Set(lines.filter((l) => /upstream error ECONNREFUSED/.test(l)).map((l) => l.split(' ')[1]));
    const polls = lines.filter((l) => / GET \/api\/floor$/.test(l)).map((l) => ({ t: at(l), conn: l.split(' ')[1] }));
    const reached = polls.find((p) => p.t > freshAt && !refused.has(p.conn));
    check(!!reached && reached.t - freshAt <= 12000, `an /api/floor reaches the fresh board within 12 s (${reached ? `${((reached.t - freshAt) / 1000).toFixed(1)} s` : 'none did'})`);
    const after = polls.filter((p) => p.t > killedAt).map((p) => p.t);
    const gaps = after.slice(1).map((t, i) => t - after[i]);
    const worst = Math.max(0, ...gaps);
    check(worst <= 10000, `no two /api/floor polls after the kill are more than 10 s apart (worst ${(worst / 1000).toFixed(1)} s)`);
  }
}

try {
  await run('board');
  await run('floor');
} finally {
  try { board?.kill('SIGKILL'); } catch { /* gone */ }
  try { execSync('pkill -f "hold-proxy.mjs 8953"', { stdio: 'ignore' }); } catch { /* none */ }
  for (const ext of ['', '-wal', '-shm']) if (existsSync(join(out, `board.db${ext}`))) rmSync(join(out, `board.db${ext}`), { force: true });
}
console.log(fails ? `\n${fails} failed · FAIL` : '\nPASS');
process.exit(fails ? 1 : 0);

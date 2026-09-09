#!/usr/bin/env node
/**
 * A host that offers folders, on a throwaway server — the fixture behind the
 * "Take a desk" dialog.
 *
 *   seed-folders.mjs <base-url> [--channel lab] [--key k] [--db data/scratch.db]
 *
 * The folder list lives in the server's memory (`live.folders`), not in a
 * table, so it can only be put there the way a real host puts it: through
 * `/api/host/register`. This registers host `h1` with three folders whose
 * every value is one nothing on the server could default into place — a name
 * that sorts wrong if the order is lost, a time in the past, a count of seven
 * — so a field that reaches the dialog provably crossed the whole chain
 * (docs/internals.md, "the folder list").
 *
 * It re-registers every two seconds, which is also the heartbeat: a seeded
 * host goes stale in 90 s, less than a browser run. One agent is seated on the
 * channel by SQL first, so the dialog's channel list has something in it.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(`${REPO}/package.json`);
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const base = (args[0] ?? '').startsWith('http') ? args[0] : 'http://localhost:8905';
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const CH = flag('channel', 'lab');
const KEY = flag('key', 'k');
const DB = flag('db', `${REPO}/data/scratch.db`);
const HOST = 'h1';

const db = new Database(DB);
db.prepare(`INSERT OR REPLACE INTO agents (channel, agent, last_seen) VALUES (?, ?, datetime('now'))`).run(CH, 'seated');
db.prepare(`INSERT OR REPLACE INTO personas (channel, agent, seat, assigned_at) VALUES (?, ?, 0, datetime('now'))`).run(CH, 'seated');
/* A registration names every desk the host runs, and the server takes one it
   does not name as gone — so a desk seeded by seed-desk.mjs on the same host
   would go offline two seconds after this started. Re-read the rows each time
   and name them. */
const desksOf = () => db.prepare(`SELECT channel, agent, cwd, window_id, sdk_session_id FROM hosted_desks WHERE host_id = ?`).all(HOST)
  .map((d) => ({ channel: d.channel, agent: d.agent, cwd: d.cwd, window: d.window_id, session_id: d.sdk_session_id }));

export const FOLDERS = [
  { path: '/repo/zeta-newest', name: 'zeta-newest', depth: 1, bound: null, has_mcp_json: false, other_board: null, trusted: true, last_active: '2026-09-09T01:02:03.000Z', sessions: 7 },
  { path: '/repo/alpha-older', name: 'alpha-older', depth: 1, bound: { channel: CH, agent: 'alpha', scope: 'local', board: base }, has_mcp_json: false, other_board: null, trusted: false, last_active: '2026-09-08T01:02:03.000Z', sessions: 2 },
  { path: '/repo/mars-elsewhere', name: 'mars-elsewhere', depth: 1, bound: { channel: 'x', agent: 'y', scope: 'project', board: 'http://10.0.0.9:8787' }, has_mcp_json: true, other_board: 'http://10.0.0.9:8787', trusted: false, last_active: null, sessions: 0 },
];

const register = () => fetch(`${base}/api/host/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-orchestratinator-key': KEY },
  body: JSON.stringify({ host_id: HOST, name: 'testbox', tmux: 'orch', desks: desksOf(), roots: ['/repo'], folders: FOLDERS }),
}).then((r) => r.json()).catch((e) => ({ error: e.message }));

console.log(`register: ${JSON.stringify(await register())}`);
const got = await (await fetch(`${base}/api/floor/folders`)).json();
const mine = got.hosts.find((h) => h.host_id === HOST);
console.log(`folders served: ${mine?.folders.map((f) => f.name).join(', ') ?? '(none)'}  live=${mine?.live}  at=${mine?.at}`);
console.log(`\nseeded host ${HOST} on ${base} — re-registering every 2s, ^C to stop`);
const HEARTBEAT = setInterval(register, 2000);
process.on('SIGINT', () => { clearInterval(HEARTBEAT); db.close(); process.exit(0); });

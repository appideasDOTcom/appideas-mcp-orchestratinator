#!/usr/bin/env node
/**
 * A host that answers, on a throwaway server — the fixture behind every part
 * of the page that waits on a host: the folder dialog and the in-page list
 * ("Take a desk"), the History dialog's recent list and search, and a
 * conversation opened to read.
 *
 *   answering-host.mjs <base-url> [--host h1] [--name testbox] [--key k]
 *                      [--db data/scratch.db] [--answers answers.json]
 *                      [--no-dialog]
 *
 * seed-desk.mjs and seed-folders.mjs put state on the board; neither takes
 * work, so a page that asks a host a question waits eight seconds and says
 * the host did not answer. This one long-polls `/api/host/work` for its host
 * and answers each item the way host/index.js does — as events, with the
 * request it answers named — and prints every item it was handed as a JSON
 * line, which is how a check reads what the page actually sent (the start
 * directory of a pick, the `deep` of a search).
 *
 * What it answers, and how to change the answer between steps of a check:
 * `--answers` names a JSON file re-read on every work item.
 *
 *   { "pick":   { "mode": "chosen", "path": "/repo/deep/nest/zeta-newest", "delay": 1500 },
 *     "search": { "delay": 900 },
 *     "read":   { "delay": 700 } }
 *
 *   pick.mode   chosen | cancelled | failed | silent   (default: cancelled)
 *               `why` rides a cancelled, `error` a failed; `silent` says
 *               nothing at all, which is the page's 8-second path
 *   search      matches the query against the titles below, case-blind;
 *               `rows` replaces that; `error` makes the host's search fail
 *   read        any conversation whose id ends `-old` is thirty turns in two
 *               pages; any other is "no conversation … in <folder>"
 *
 * Every value here is one a default could not produce: titles that sort
 * wrong if the order is lost, a turn with markup in it (`<b>all</b>` — it
 * must be drawn as characters), a tool call, a thought, a subagent label, a
 * search that reads 104 files in 2700 ms.
 *
 * It registers every two seconds, naming whatever desks the board already
 * holds for its host — so it runs beside seed-desk.mjs without taking that
 * desk offline — with `dialog: true` unless `--no-dialog`, which is how to
 * see the page's own list for a host with no folder dialog. Start a second
 * one with `--host h2 --no-dialog` for a board with both kinds.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
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
const HOST = flag('host', 'h1');
const NAME = flag('name', HOST === 'h1' ? 'testbox' : HOST);
const KEY = flag('key', 'k');
const DB = flag('db', `${REPO}/data/scratch.db`);
const ANSWERS = flag('answers', null);
const DIALOG = !args.includes('--no-dialog');

const db = new Database(DB);
const desksOf = () => db.prepare(`SELECT channel, agent, cwd, window_id, sdk_session_id FROM hosted_desks WHERE host_id = ?`).all(HOST)
  .map((d) => ({ channel: d.channel, agent: d.agent, cwd: d.cwd, window: d.window_id, session_id: d.sdk_session_id }));

const H = { 'content-type': 'application/json', 'x-orchestratinator-key': KEY };
const post = (path, body) => fetch(base + path, { method: 'POST', headers: H, body: JSON.stringify(body) }).then((r) => r.json()).catch((e) => ({ error: e.message }));
const events = (evs) => post('/api/host/events', { host_id: HOST, events: evs });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const answers = () => { try { return ANSWERS && existsSync(ANSWERS) ? JSON.parse(readFileSync(ANSWERS, 'utf8')) : {}; } catch { return {}; } };

const folder = (name, last, extra = {}) => ({
  path: `/repo/deep/nest/${name}`, name, depth: 3, bound: null, has_mcp_json: false, other_board: null,
  trusted: true, git: true, last_active: last, sessions: last ? 7 : 0, ...extra,
});
// Out of order on purpose: the page must not depend on the order holding.
const FOLDERS = [
  folder('never-opened', null),
  folder('alpha-older', '2026-09-29T10:00:00.000Z'),
  folder('zeta-newest', '2026-09-30T10:00:00.000Z'),
  folder('mars-elsewhere', '2026-09-30T23:00:00.000Z', { bound: { channel: 'x', agent: 'y', scope: 'project', board: 'http://10.0.0.9:8787' }, other_board: 'http://10.0.0.9:8787' }),
];
const register = () => post('/api/host/register', { host_id: HOST, name: NAME, tmux: 'orch', desks: desksOf(), roots: ['/repo'], folders: FOLDERS, dialog: DIALOG });

const listing = (path, at) => {
  const self = FOLDERS.find((f) => f.path === path)
    ?? { path, name: path.split('/').pop() || '/', depth: 1, bound: null, trusted: true, git: false, last_active: null, sessions: 0 };
  return { type: 'browse', requested: path, path, root: '/', parent: path.split('/').slice(0, -1).join('/') || '/', at, self, entries: [{ path: `${path}/src`, name: 'src', depth: 4, bound: null }] };
};

/** Two conversations a desk: the one it is on, and an older one to read. */
const conversations = () => desksOf().flatMap((d) => [
  { id: d.session_id ?? `${d.agent}-now`, channel: d.channel, agent: d.agent, title: `Wire the hook events (${d.agent})`, title_source: 'ai', started_at: '2026-09-30T08:00:00Z', last_at: '2026-10-01T09:14:00Z', modified_at: '2026-10-01T09:14:00Z', size: 812345, spoken: true, live: true, held: 'floor', branch: 'develop', model: 'claude-fable-5-1' },
  { id: `${d.agent}-old`, channel: d.channel, agent: d.agent, title: `Rename the widget (${d.agent})`, title_source: 'custom', started_at: '2026-09-20T10:00:00Z', last_at: '2026-09-20T12:14:00Z', modified_at: '2026-09-20T12:14:00Z', size: 1234, spoken: true, live: false, held: null, branch: 'feature/widgets', model: 'claude-opus-5-5' },
]);

const oldTurns = () => Array.from({ length: 30 }, (_, k) => {
  const i = k + 1;
  const at = new Date(Date.UTC(2026, 8, 20, 10, i)).toISOString();
  if (i === 20) return { role: 'assistant', text: 'OLD-TURN-20: the Widget Rename is done, <b>all</b> 14 call sites.', at };
  if (i % 7 === 0) return { role: 'tool', text: '', tool_name: 'Bash', tool_input: { command: `grep -rn widget src # OLD-TURN-${i}` }, at };
  if (i % 5 === 0) return { role: 'thinking', text: `OLD-TURN-${i} a thought`, at };
  return { role: i % 2 ? 'user' : 'assistant', text: `OLD-TURN-${i} ${i % 2 ? 'the person speaking' : 'the agent replying'}`, at, ...(i === 12 ? { via: 'Find the widget' } : {}) };
});

async function answer(w) {
  const a = answers();
  if (w.kind === 'browse') {
    const path = w.payload?.path ?? '/home/me';
    if (/\/gone[^/]*$/.test(path)) return events([{ type: 'browse', path, requested: path, at: now(), error: `${path} could not be opened: no such folder` }]);
    return events([listing(path, now())]);
  }
  if (w.kind === 'pick') {
    const p = a.pick ?? { mode: 'cancelled' };
    if (p.mode === 'silent') return null;
    const start = w.payload?.start ?? '/home/me';
    await events([{ type: 'pick', state: 'open', at: now(), start }]);
    await sleep(p.delay ?? 0);
    const at = now();
    if (p.mode === 'chosen') return events([listing(p.path, at), { type: 'pick', state: 'chosen', at, start, path: p.path, parent: p.path.split('/').slice(0, -1).join('/') || '/' }]);
    if (p.mode === 'failed') return events([{ type: 'pick', state: 'failed', at, start, error: p.error ?? 'the folder dialog ended with exit code 1: execution error: no screen' }]);
    return events([{ type: 'pick', state: 'cancelled', at, start, why: p.why ?? null }]);
  }
  if (w.kind === 'recent') {
    return events([{ type: 'history', kind: 'recent', request_id: w.payload.request_id, at: now(), rows: a.recent?.rows ?? conversations() }]);
  }
  if (w.kind === 'search') {
    const s = a.search ?? {};
    await sleep(s.delay ?? 0);
    const deep = w.payload.deep === true;
    const q = String(w.payload.query ?? '').toLowerCase();
    const head = { type: 'history', kind: 'search', request_id: w.payload.request_id, query: w.payload.query, deep, at: now() };
    if (s.error) return events([{ ...head, rows: [], error: s.error }]);
    const rows = s.rows ?? conversations().filter((c) => c.title.toLowerCase().includes(q) || /widget/.test(q) && c.id.endsWith('-old')).map((c) => ({
      ...c, hits: deep ? 5 : 1,
      snippets: [
        { role: 'assistant', at: '2026-09-20T10:20:00.000Z', text: '…OLD-TURN-20: the Widget Rename is done, <b>all</b> 14 call sites.' },
        ...(deep ? [{ role: 'tool', at: '2026-09-20T10:07:00.000Z', text: 'Bash grep -rn widget src # OLD-TURN-7' }] : []),
      ],
    }));
    return events([{ ...head, rows, files: 104, ms: 2700 }]);
  }
  if (w.kind === 'read') {
    const { session_id: sid, request_id: rid } = w.payload;
    const head = { type: 'transcript', channel: w.channel, agent: w.agent, session_id: sid, request_id: rid };
    if (!String(sid).endsWith('-old')) {
      const cwd = desksOf().find((d) => d.channel === w.channel && d.agent === w.agent)?.cwd ?? '/repo';
      return events([{ ...head, at: now(), error: `no conversation ${sid} in ${cwd}: no transcript yet`, done: true }]);
    }
    const turns = oldTurns();
    await events([{ ...head, at: now(), turns: turns.slice(0, 15) }]);
    await sleep(a.read?.delay ?? 700);
    return events([{ ...head, at: now(), turns: turns.slice(15), done: true }]);
  }
  return null;
}

console.error(`register: ${JSON.stringify(await register())}`);
const HEARTBEAT = setInterval(register, 2000);
process.on('SIGINT', () => { clearInterval(HEARTBEAT); db.close(); process.exit(0); });
console.error(`host ${HOST} (${NAME}) answering on ${base} — dialog: ${DIALOG}; ^C to stop. Each work item is a line on stdout.`);
for (;;) {
  const got = await fetch(`${base}/api/host/work?host_id=${encodeURIComponent(HOST)}&wait=2`, { headers: H }).then((r) => r.json()).catch(() => ({ work: [] }));
  for (const w of got.work ?? []) {
    console.log(JSON.stringify({ kind: w.kind, channel: w.channel, agent: w.agent, payload: w.payload, waited_ms: w.waited_ms }));
    // Not awaited: a real host answers a pick or a search off its work loop too.
    answer(w).catch((e) => console.error(`answer ${w.kind}: ${e.message}`));
  }
}

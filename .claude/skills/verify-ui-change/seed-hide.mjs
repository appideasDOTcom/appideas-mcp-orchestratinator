#!/usr/bin/env node
/**
 * The fixture for checking issue #20 on the floor: empty desks not drawn, a
 * desk hidden by hand as a pill under its storey, and the pill restoring it.
 *
 * One floor, `alpha`, with a desk per reading — `ann` hosted on a live host
 * (ready), `ed` live by its hooks and holding three unread messages (so its
 * pill has a count to carry), `bob` an agents row alone (not reporting),
 * `cy` hosted on a host two days dead (host offline), `dee` a session that
 * ended (away) — plus `beta` with one live desk and `empty-only`, a floor
 * whose one desk is an agents row alone, so a storey with nothing drawn on
 * it can be seen. Prints what the floor made of it, so the API has answered
 * before a browser is opened. The live host's heartbeat runs for as long as
 * this does.
 *
 *   PORT=8905 DB_PATH=./data/scratch.db ORCH_AUTH_TOKEN=k node src/server.js &
 *   node .claude/skills/verify-ui-change/seed-hide.mjs http://localhost:8905 ./data/scratch.db &
 *   node --experimental-websocket .claude/skills/verify-ui-change/check-hide.mjs http://localhost:8905 [out-dir] ./data/scratch.db
 *
 * Run from the repo root. Kill it when done; the ingest key is `k`.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
// The Node floor in words, before better-sqlite3 is opened: a Node-API 9 node
// segfaults on it with none (src/node-floor.js). A copy holding an older src/
// has no such file, and that is not this script's fault to report.
await import('../../../src/node-floor.js').catch((e) => { if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e; });
const REPO = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const require = createRequire(`${REPO}/package.json`);
const Database = require('better-sqlite3');
const HOST = process.argv[2] ?? 'http://localhost:8905';
const DB = process.argv[3] ?? './data/scratch.db';
const KEY = process.env.ORCH_AUTH_TOKEN ?? 'k';

const db = new Database(DB);
db.prepare(`INSERT OR REPLACE INTO hosts (host_id, name, last_seen) VALUES ('h1', 'testbox', datetime('now'))`).run();
db.prepare(`INSERT OR REPLACE INTO hosts (host_id, name, last_seen) VALUES ('h2', 'oldbox', datetime('now', '-2 days'))`).run();
for (const [ch, ag] of [['alpha', 'ann'], ['alpha', 'ed'], ['alpha', 'bob'], ['alpha', 'cy'], ['alpha', 'dee'], ['beta', 'fay'], ['empty-only', 'gus']]) {
  db.prepare(`INSERT OR REPLACE INTO agents (channel, agent, last_seen) VALUES (?, ?, datetime('now'))`).run(ch, ag);
}
db.prepare(`INSERT OR REPLACE INTO hosted_desks (channel, agent, host_id, cwd, window_id, outside_pid, state, updated_at)
            VALUES ('alpha', 'ann', 'h1', '/repo/ann', 'ann-window', NULL, 'idle', datetime('now'))`).run();
db.prepare(`INSERT OR REPLACE INTO hosted_desks (channel, agent, host_id, cwd, window_id, outside_pid, state, updated_at)
            VALUES ('alpha', 'cy', 'h2', '/repo/cy', NULL, NULL, 'idle', datetime('now'))`).run();
for (let i = 0; i < 3; i++) {
  db.prepare(`INSERT INTO messages (channel, from_agent, to_agent, body) VALUES ('alpha', 'ann', 'ed', ?)`).run(JSON.stringify(`hello ${i}`));
}

const post = (body) => fetch(`${HOST}/api/ingest`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestratinator-key': KEY }, body: JSON.stringify(body),
}).then((r) => r.status);
const ev = (channel, agent, session, event, extra = {}) => ({ channel, agent, session_id: session, hook_event_name: event, cwd: `/repo/${agent}`, ...extra });
console.log('ingest', await Promise.all([
  post(ev('alpha', 'ed', 's-ed', 'SessionStart')),
  post(ev('alpha', 'ed', 's-ed', 'UserPromptSubmit', { message: 'go' })),
  post(ev('alpha', 'ed', 's-ed', 'Stop', { last_assistant_message: 'done' })),
  post(ev('alpha', 'dee', 's-dee', 'SessionStart')),
  post(ev('alpha', 'dee', 's-dee', 'SessionEnd')),
  post(ev('beta', 'fay', 's-fay', 'SessionStart')),
  post(ev('beta', 'fay', 's-fay', 'UserPromptSubmit', { message: 'go' })),
  post(ev('beta', 'fay', 's-fay', 'Stop', { last_assistant_message: 'done' })),
]));

const f = await (await fetch(`${HOST}/api/floor`)).json();
const reading = (d) => d.hosted ? (d.hosted.live ? 'ready' : 'host offline') : d.live ? 'here' : d.reporting ? 'away' : 'not reporting';
for (const c of f.channels) {
  console.log(`${c.channel}${c.archived ? '*' : ''} ${c.live}/${c.desks.length} here —`,
    c.desks.map((d) => `${d.agent}:${reading(d)}${d.hidden ? ':HIDDEN' : ''}${d.board?.unread ? `:${d.board.unread}unread` : ''}`).join(' '));
}
const alpha = f.channels.find((c) => c.channel === 'alpha');
const want = { ann: 'ready', ed: 'here', bob: 'not reporting', cy: 'host offline', dee: 'away' };
for (const [a, r] of Object.entries(want)) {
  const d = alpha?.desks.find((x) => x.agent === a);
  if (!d || reading(d) !== r) console.log(`!! ${a} reads ${d ? reading(d) : 'missing'}, wanted ${r} — fix the fixture before opening a browser`);
}

setInterval(() => db.prepare(`UPDATE hosts SET last_seen = datetime('now') WHERE host_id = 'h1'`).run(), 2000);

#!/usr/bin/env node
/**
 * The fixture for checking archive on both views (issues #21 and #6):
 * three channels on a throwaway server — `alpha` with two agent rows, unread
 * mail and an open task (so a pill has counts to carry), `beta` with one
 * agent, and `solo-only`, a desk made by a hook event alone with no agents
 * row, which is the #6 shape — plus a live host with a heartbeat, so Take a
 * desk draws its Floor dropdown. Prints what both views made of it, so the
 * API has answered before a browser is opened.
 *
 *   PORT=8905 DB_PATH=./data/scratch.db ORCH_AUTH_TOKEN=k node src/server.js &
 *   node .claude/skills/verify-ui-change/seed-archive.mjs http://localhost:8905 ./data/scratch.db &
 *   node --experimental-websocket .claude/skills/verify-ui-change/check-archive.mjs http://localhost:8905
 *
 * Run from the repo root. Keeps running for the heartbeat; kill it when done.
 * The ingest key is `k`, as in the server line above.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const REPO = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const require = createRequire(`${REPO}/package.json`);
const Database = require('better-sqlite3');
const HOST = process.argv[2] ?? 'http://localhost:8905';
const DB = process.argv[3] ?? './data/scratch.db';
const KEY = process.env.ORCH_AUTH_TOKEN ?? 'k';

const db = new Database(DB);
db.prepare(`INSERT OR REPLACE INTO hosts (host_id, name, last_seen) VALUES ('h1', 'testbox', datetime('now'))`).run();
for (const [ch, ag] of [['alpha', 'ann'], ['alpha', 'bob'], ['beta', 'cy']]) {
  db.prepare(`INSERT OR REPLACE INTO agents (channel, agent, last_seen) VALUES (?, ?, datetime('now'))`).run(ch, ag);
}
// Unread mail for ann and an open task on alpha: the pill must carry these.
// `body` is JSON-encoded in this table, as the MCP tool writes it.
for (let i = 0; i < 3; i++) {
  db.prepare(`INSERT INTO messages (channel, from_agent, to_agent, body) VALUES ('alpha', 'bob', 'ann', ?)`).run(JSON.stringify(`hello ${i}`));
}
db.prepare(`INSERT INTO tasks (channel, title, status, created_by) VALUES ('alpha', 'a task', 'open', 'bob')`).run();

// The #6 shape, through the real door: a hook event seats a desk and makes a
// persona, and nothing makes an agents row.
const post = (body) => fetch(`${HOST}/api/ingest`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestratinator-key': KEY }, body: JSON.stringify(body),
});
console.log('ingest', (await post({ channel: 'solo-only', agent: 'solo', session_id: 's-solo', hook_event_name: 'SessionStart', cwd: '/repo/solo' })).status);

const s = await (await fetch(`${HOST}/api/state`)).json();
const f = await (await fetch(`${HOST}/api/floor`)).json();
const names = (j) => j.channels.map((c) => c.channel + (c.archived ? '*' : ''));
console.log('state', names(s), s.totals.channels, '| floor', names(f), f.totals.channels);
if (names(s).join() !== names(f).join()) console.log('!! the two views disagree about which floors exist — fix that before opening a browser');

setInterval(() => db.prepare(`UPDATE hosts SET last_seen = datetime('now') WHERE host_id = 'h1'`).run(), 2000);

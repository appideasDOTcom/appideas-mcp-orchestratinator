#!/usr/bin/env node
/**
 * A hosted desk with a conversation on it, on a throwaway server.
 *
 *   seed-desk.mjs <base-url> [--channel lab] [--agent bo] [--key k]
 *
 * Almost every check of the chat panel or a desk's bubble needs the same
 * fixture: a live host, a desk it runs, and turns of every kind on it. This
 * builds that and prints what the server made of it, so the API has answered
 * before a browser is opened.
 *
 * Two things here are not obvious, and both cost a round when they were
 * discovered (2026-09-03):
 *
 * - **Turns go in through `/api/host/events`, not SQL.** `applyHostEvent`
 *   refuses an event whose desk it does not own, so posting them is also a
 *   test of the path a real host uses. Writing rows straight into `turns`
 *   would seed state no host could have produced.
 * - **The panel scopes turns to the desk's session.** `sessionFilter()` in
 *   `src/ui/floor.js` sends `&session=<hosted.session_id>`, so turns whose
 *   `session_id` is anything else are fetched by nobody. The symptom is
 *   nasty: `/api/floor/turns` with no filter returns every row, so the API
 *   looks right while the page says "No conversation captured yet." Hence
 *   `sdk_session_id` below, set to the same id the events carry.
 *
 * The host row is kept fresh for as long as this runs (see HEARTBEAT): a
 * seeded host goes stale in 90s, which is less than a browser run, and the
 * compose box silently becomes "host is offline" mid-check.
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
const AG = flag('agent', 'bo');
const KEY = flag('key', 'k');
const DB = flag('db', `${REPO}/data/scratch.db`);
const SESSION = `sess-${AG}`;
const HOST = 'h1';

/* The rows no host event can create: the desk itself, and who it belongs to.
   `personas` is (channel, agent, seat, assigned_at) — there is no persona
   column, the name is derived from the agent id. Read the schema rather than
   trusting any list written down, including this one. */
const db = new Database(DB);
db.prepare(`INSERT OR REPLACE INTO agents (channel, agent, last_seen) VALUES (?, ?, datetime('now'))`).run(CH, AG);
db.prepare(`INSERT OR REPLACE INTO personas (channel, agent, seat, assigned_at) VALUES (?, ?, 0, datetime('now'))`).run(CH, AG);
db.prepare(`INSERT OR REPLACE INTO hosts (host_id, name, last_seen) VALUES (?, ?, datetime('now'))`).run(HOST, 'testbox');
db.prepare(
  `INSERT OR REPLACE INTO hosted_desks (channel, agent, host_id, cwd, window_id, outside_pid, sdk_session_id, state, updated_at)
   VALUES (?, ?, ?, ?, ?, NULL, ?, 'working', datetime('now'))`
).run(CH, AG, HOST, `/repo/${AG}`, `${AG}-window`, SESSION);

/* Older than 90s and the desk reports its host offline, which reads exactly
   like the feature under test having broken. */
const HEARTBEAT = setInterval(
  () => db.prepare(`UPDATE hosts SET last_seen = datetime('now') WHERE host_id = ?`).run(HOST),
  2000,
);

/* One of every kind of turn the floor draws, in the order a real session
   produces them: the person, the agent, an Agent call, then that subagent's
   own words and tools carrying `via`, a thought from inside it, and a thought
   from the main thread. Timestamps are fixed so the order is readable. */
const at = (s) => `2026-09-03T18:${s}Z`;
const ev = (e) => ({ channel: CH, agent: AG, session_id: SESSION, ...e });
const events = [
  ev({ type: 'turn', role: 'user', text: 'find out what the docs say', at: at('38:00'), uuid: 'u1' }),
  ev({ type: 'turn', role: 'assistant', text: "I'll check three things first.", at: at('38:06'), uuid: 'a1' }),
  ev({ type: 'turn', role: 'tool', tool_name: 'Agent', tool_input: { description: 'Docs lookup', prompt: 'Find the docs on hooks' }, at: at('38:20'), uuid: 'a2' }),
  ev({ type: 'turn', role: 'assistant', text: "I'll search the official documentation for these details.", at: at('38:26'), uuid: 'sa1', via: 'Docs lookup' }),
  ev({ type: 'turn', role: 'tool', tool_name: 'WebFetch', tool_input: { url: 'https://code.claude.com/docs/en/hook-events.md' }, at: at('38:27'), uuid: 'sa2', via: 'Docs lookup' }),
  ev({ type: 'turn', role: 'thinking', text: 'The hooks page lists the notification kinds; I should read that before the costs page.', at: at('38:38'), uuid: 'st1', via: 'Docs lookup' }),
  ev({ type: 'turn', role: 'assistant', text: 'Let me search for more specific documentation on hook events.', at: at('38:39'), uuid: 'sa3', via: 'Docs lookup' }),
  ev({ type: 'turn', role: 'thinking', text: "I'll leave the console checkboxes as is since the vendor already grants the six scopes we requested.", at: at('39:10'), uuid: 't2' }),
];

const post = await fetch(`${base}/api/host/events`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-orchestratinator-key': KEY },
  body: JSON.stringify({ host_id: HOST, events }),
});
const applied = await post.json().catch(() => ({}));
console.log(`events: ${post.status} ${JSON.stringify(applied)}`);
/* `applied: 0` with a 200 is the failure worth naming: every event was
   refused, and the usual reason is that the desk rows above did not land or
   name a different host. It is not an error anywhere. */
if ((applied.applied ?? 0) !== events.length) {
  console.error(`only ${applied.applied ?? 0} of ${events.length} events applied — check the hosted_desks row and the server log`);
}

const rows = await (await fetch(`${base}/api/floor/turns?channel=${CH}&agent=${AG}&session=${encodeURIComponent(SESSION)}`)).json();
console.log(`turns the panel will fetch (session-scoped): ${rows.count}`);
for (const r of [...rows.rows].reverse()) {
  console.log(`  ${String(r.id).padStart(3)} ${r.role.padEnd(9)} ${String(r.via ?? '').padEnd(12)} ${(r.text ?? '').slice(0, 60)}`);
}

const floor = await (await fetch(`${base}/api/floor`)).json();
const desk = floor.channels.find((c) => c.channel === CH)?.desks.find((d) => d.agent === AG);
console.log(`bubble  : ${JSON.stringify(desk?.last_message?.text ?? null)}`);
/* `hosted.host`, not `host_name` — the payload's projection renames the
   column, which is the trap the skill records as "a column the query selects
   is not a column the page gets". Read a new field out of /api/floor before
   trusting anything, including this line. */
console.log(`working : ${desk?.working}   host: ${desk?.hosted?.host ?? '(none)'}   live: ${desk?.hosted?.live}`);
console.log(`\nseeded ${CH}/${AG} on ${base} — heartbeat running, ^C to stop`);

process.on('SIGINT', () => { clearInterval(HEARTBEAT); db.close(); process.exit(0); });

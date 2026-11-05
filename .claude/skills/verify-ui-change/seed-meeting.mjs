#!/usr/bin/env node
/**
 * A floor to hold a meeting room on (issue #44), with a host that does what
 * a room asks of it, on a throwaway server.
 *
 *   seed-meeting.mjs <base-url> --db <scratch.db> [--key k] > work.jsonl
 *
 * Desks, all on host h1 ("testbox"):
 *   lab/bo, lab/cy, lab/dee   live, idle, a conversation each (sess-<agent>)
 *   lab/ed                    held by an editor (outside_pid): the room's
 *                             messages to it are refused, in the board's words
 *   lab2/zed                  another floor, so Add offers nothing from it
 *
 * And mail on the board: two unread messages for bo, one for cy.
 *
 * The host long-polls its work and answers it the way host/index.js does,
 * as events, printing every item it was handed as one JSON line on stdout
 * — which is how a check reads what the page actually sent, desk by desk:
 *
 *   chat       the words as the desk's user turn, then a reply from the
 *              desk ("<agent> heard: …") 600 ms later. cy says `queued`
 *              first and records 1.5 s later, the way a working window
 *              holds a message. A message starting with "/" is a command:
 *              a `done` delivery with the window's sentence, no user turn.
 *   permission nothing back but the line: the check reads which desk it
 *              was for
 *   sessions   the desk's conversations: its own, and sess-<agent>-old.
 *              Any session named in the file `--gone` lists is left out,
 *              so Resume sees it gone
 *   reopen     the desk's session becomes the one asked for
 *
 * A control file (`--ctl`, JSON, re-read on each poll) lets a check change
 * the board between steps without SQL of its own: { "session": { "bo":
 * "sess-bo-new" } } puts bo on another conversation (a /clear), the way the
 * host would report it. `gone: [ids]` leaves those conversations out of
 * the sessions list (Resume sees them gone), `slow: { bo: 4000 }` holds a
 * desk's recording that long (the room's "in line" note), and
 * `reopenFail: ["bo"]` answers a reopen with the host's error, as a busy
 * window does.
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
const KEY = flag('key', 'k');
const DB = flag('db', `${REPO}/data/scratch.db`);
const CTL = flag('ctl', null);
const HOST = 'h1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = new Database(DB);
const DESKS = [
  { channel: 'lab', agent: 'bo' },
  { channel: 'lab', agent: 'cy' },
  { channel: 'lab', agent: 'dee' },
  { channel: 'lab', agent: 'ed', editor: 4242 },
  { channel: 'lab2', agent: 'zed' },
];
db.prepare(`INSERT OR REPLACE INTO hosts (host_id, name, last_seen) VALUES (?, ?, datetime('now'))`).run(HOST, 'testbox');
DESKS.forEach((d, i) => {
  db.prepare(`INSERT OR REPLACE INTO agents (channel, agent, last_seen) VALUES (?, ?, datetime('now'))`).run(d.channel, d.agent);
  db.prepare(`INSERT OR REPLACE INTO personas (channel, agent, seat, assigned_at) VALUES (?, ?, ?, datetime('now'))`).run(d.channel, d.agent, i);
  db.prepare(
    `INSERT OR REPLACE INTO hosted_desks (channel, agent, host_id, cwd, window_id, outside_pid, sdk_session_id, state, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', datetime('now'))`,
  ).run(d.channel, d.agent, HOST, `/repo/${d.agent}`, d.editor ? null : `${d.agent}-window`, d.editor ?? null, `sess-${d.agent}`);
});
setInterval(() => db.prepare(`UPDATE hosts SET last_seen = datetime('now') WHERE host_id = ?`).run(HOST), 2000);

// Hair on two of them, so a check of the room's hair borders sees two
// colours set and the default (dark brown, DEFAULT_HAIR) on the rest.
db.prepare(`INSERT OR REPLACE INTO agent_profile (agent, hair) VALUES ('bo', '#d9a441'), ('cy', '#b1583a')`).run();

// The agents talking among themselves on the board: two messages waiting for
// bo, one for cy — what a nudge is for. Stored as tools.js stores a body.
const put = db.prepare(`INSERT INTO messages (channel, from_agent, to_agent, body) VALUES ('lab', ?, ?, ?)`);
put.run('cy', 'bo', JSON.stringify('bo, the build went red after your merge'));
put.run('dee', 'bo', JSON.stringify('bo, lint is failing too'));
put.run('bo', 'cy', JSON.stringify('cy, the contract for /api/x changed'));

const sessionOf = (channel, agent) => db.prepare(`SELECT sdk_session_id FROM hosted_desks WHERE channel = ? AND agent = ?`).get(channel, agent)?.sdk_session_id;
let uuid = 0;
const events = (evs) => fetch(`${base}/api/host/events`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestratinator-key': KEY },
  body: JSON.stringify({ host_id: HOST, events: evs }),
}).then((r) => r.json()).catch((e) => ({ error: String(e) }));
const turn = (channel, agent, role, text) => ({
  type: 'turn', channel, agent, session_id: sessionOf(channel, agent), role, text, at: new Date().toISOString(), uuid: `m${++uuid}`,
});

// A conversation each before any room: a room starts from now, so none of
// this is in its transcript — the check asserts exactly that.
for (const d of DESKS) {
  await events([
    turn(d.channel, d.agent, 'user', `an old question for ${d.agent}`),
    turn(d.channel, d.agent, 'assistant', `${d.agent}'s old answer, from before any meeting room`),
  ]);
}

const ctl = () => {
  if (!CTL || !existsSync(CTL)) return {};
  try { return JSON.parse(readFileSync(CTL, 'utf8')); } catch { return {}; }
};
let applied = '';
function applyCtl() {
  const c = ctl();
  const key = JSON.stringify(c.session ?? {});
  if (key === applied) return;
  applied = key;
  for (const [agent, sid] of Object.entries(c.session ?? {})) {
    events([{ type: 'session', channel: 'lab', agent, session_id: sid }]);
  }
}

console.error(`seeded ${DESKS.map((d) => `${d.channel}/${d.agent}`).join(', ')} on ${base}; host ${HOST} taking work`);

async function handle(item) {
  const { channel, agent, kind, payload } = item;
  if (kind === 'chat') {
    const text = payload?.text ?? '';
    if (text.startsWith('/')) {
      await sleep(300);
      // A command is confirmed on its own receipt (host/window.js
      // commandReceipt), which the board turns into a `done` note.
      await events([{ type: 'receipt', channel, agent, command: text.slice(1).split(/\s/)[0], text, said: `${text} — done in ${agent}'s window` }]);
      return;
    }
    if (agent === 'cy') {
      await sleep(200);
      await events([{ type: 'delivery', channel, agent, state: 'queued', text }]);
      await sleep(1500);
    } else {
      await sleep(Number(ctl().slow?.[agent]) || 250);
    }
    await events([turn(channel, agent, 'user', text)]);
    await sleep(600);
    await events([turn(channel, agent, 'assistant', `${agent} heard: ${text}`)]);
  } else if (kind === 'sessions') {
    const gone = new Set(ctl().gone ?? []);
    const rows = [sessionOf(channel, agent), `sess-${agent}`, `sess-${agent}-old`]
      .filter((id, i, all) => id && all.indexOf(id) === i && !gone.has(id))
      .map((id) => ({ id, title: `conversation ${id}`, spoken: true }));
    await sleep(200);
    await events([{ type: 'sessions', channel, agent, at: new Date().toISOString(), rows }]);
  } else if (kind === 'reopen') {
    await sleep(400);
    if ((ctl().reopenFail ?? []).includes(agent)) {
      await events([{ type: 'error', channel, agent, code: 'reopen_failed', message: 'not reopened — the window is still working: ✻ Working… (esc to interrupt)' }]);
      return;
    }
    await events([{ type: 'session', channel, agent, session_id: payload?.session_id ?? `sess-${agent}-fresh` }]);
  }
}

for (;;) {
  applyCtl();
  try {
    const r = await fetch(`${base}/api/host/work?host_id=${HOST}&wait=2`, { headers: { 'x-orchestratinator-key': KEY } });
    const got = await r.json();
    for (const item of got.work ?? []) {
      console.log(JSON.stringify({ at: Date.now(), kind: item.kind, channel: item.channel, agent: item.agent, payload: item.payload }));
      handle(item).catch((e) => console.error(`handling ${item.kind}: ${e}`));
    }
  } catch (e) {
    console.error(`work poll: ${e}`);
    await sleep(500);
  }
}

#!/usr/bin/env node
/**
 * The fixture and the host for checking issue #23 on the floor: bulk
 * selection on a room (nudge, mark read, hide).
 *
 * `alpha` has six drawn desks on host h1 (`testbox`): `ann` and `bo` with
 * windows (bo holding four unread messages), `cy` and `gil` with none, so a
 * nudge opens their windows first, and `di` held by an editor (can't be
 * nudged), plus `ed`, live by its hooks with no host (can't be nudged,
 * three unread). `beta` has one windowed desk, `fay`, so the building has
 * two storeys and check all can be seen to stay in its own room.
 *
 * It is also the host. It long-polls h1's work and answers each chat in the
 * order it was queued, one at a time, the way host/index.js run() does:
 * a desk with a window gets the word as a user turn after `delayMs`, and a
 * desk with none has its window come up after `opensUpMs` (its hosted row
 * gets a window id, which the floor reads as a window), then the turn. A
 * desk named in `never` gets no window: after `neverMs` it gets the error
 * turn waitReady gives up with instead. The answers file is re-read on
 * every item, so a check can change what the host does between steps.
 * Every work item is a JSON line on stdout, with when it was taken and
 * when it was answered, so the order the page queued them in is the effect
 * being checked rather than its appearance.
 *
 *   PORT=8905 DB_PATH=./data/select.db ORCH_AUTH_TOKEN=k node src/server.js &
 *   node .claude/skills/verify-ui-change/seed-select.mjs http://localhost:8905 ./data/select.db /tmp/select-host.json > /tmp/select-work.jsonl &
 *   node --experimental-websocket .claude/skills/verify-ui-change/check-select.mjs http://localhost:8905 /tmp/out ./data/select.db /tmp/select-host.json /tmp/select-work.jsonl
 *
 * Run from the repo root. Kill it when done; the ingest key is `k`.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
// The Node floor in words, before better-sqlite3 is opened: a Node-API 9 node
// segfaults on it with none (src/node-floor.js). A copy holding an older src/
// has no such file, and that is not this script's fault to report.
await import('../../../src/node-floor.js').catch((e) => { if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e; });
const REPO = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const require = createRequire(`${REPO}/package.json`);
const Database = require('better-sqlite3');
const HOST = process.argv[2] ?? 'http://localhost:8905';
const DB = process.argv[3] ?? './data/select.db';
const ANSWERS = process.argv[4] ?? '/tmp/select-host.json';
const KEY = process.env.ORCH_AUTH_TOKEN ?? 'k';
const HK = { 'content-type': 'application/json', 'x-orchestratinator-key': KEY };
const say = (s) => process.stderr.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!existsSync(ANSWERS)) writeFileSync(ANSWERS, JSON.stringify({ delayMs: 1200, opensUpMs: 2500, never: [], neverMs: 12000 }));
const answers = () => { try { return JSON.parse(readFileSync(ANSWERS, 'utf8')); } catch { return {}; } };

const db = new Database(DB);
db.prepare(`INSERT OR REPLACE INTO hosts (host_id, name, last_seen) VALUES ('h1', 'testbox', datetime('now'))`).run();
const DESKS = [['alpha', 'ann', 'ann-window', null], ['alpha', 'bo', 'bo-window', null], ['alpha', 'cy', null, null],
  ['alpha', 'gil', null, null], ['alpha', 'di', null, 4242], ['beta', 'fay', 'fay-window', null]];
for (const [ch, ag] of [...DESKS, ['alpha', 'ed']]) db.prepare(`INSERT OR REPLACE INTO agents (channel, agent, last_seen) VALUES (?, ?, datetime('now'))`).run(ch, ag);
for (const [ch, ag, win, outside] of DESKS) {
  db.prepare(`INSERT OR REPLACE INTO hosted_desks (channel, agent, host_id, cwd, window_id, outside_pid, state, updated_at)
              VALUES (?, ?, 'h1', ?, ?, ?, 'idle', datetime('now'))`).run(ch, ag, `/repo/${ag}`, win, outside);
}
for (const [to, n] of [['bo', 4], ['ed', 3]]) {
  for (let i = 0; i < n; i++) db.prepare(`INSERT INTO messages (channel, from_agent, to_agent, body) VALUES ('alpha', 'ann', ?, ?)`).run(to, JSON.stringify(`for ${to}, ${i}`));
}

const ingest = (body) => fetch(`${HOST}/api/ingest`, { method: 'POST', headers: HK, body: JSON.stringify(body) }).then((r) => r.status);
const ev = (agent, event, extra = {}) => ({ channel: 'alpha', agent, session_id: `s-${agent}`, hook_event_name: event, cwd: `/repo/${agent}`, ...extra });
say(`ingest ${JSON.stringify(await Promise.all([ingest(ev('ed', 'SessionStart')), ingest(ev('ed', 'UserPromptSubmit', { message: 'go' })), ingest(ev('ed', 'Stop', { last_assistant_message: 'done' }))]))}`);
const events = (list) => fetch(`${HOST}/api/host/events`, { method: 'POST', headers: HK, body: JSON.stringify({ host_id: 'h1', events: list }) }).then((r) => r.json());
// A turn on each hosted desk, so each has a newest turn for a nudge to come after.
say(`turns ${JSON.stringify(await events(DESKS.map(([ch, ag]) => ({ type: 'turn', channel: ch, agent: ag, session_id: `s-${ag}`, role: 'assistant', text: `${ag} ready` }))))}`);

const f = await (await fetch(`${HOST}/api/floor`)).json();
for (const c of f.channels) {
  say(`${c.channel} — ${c.desks.map((d) => `${d.agent}:${d.live || d.hosted?.live ? 'drawn' : 'empty'}:${d.nudge?.ok ? (d.nudge.opens ? 'opens' : 'bell') : d.nudge?.code}${d.board?.unread ? `:${d.board.unread}unread(max ${d.board.unread_max_id})` : ''}`).join(' ')}`);
}
const want = { ann: 'bell', bo: 'bell', cy: 'opens', gil: 'opens', di: 'held_by_editor', ed: 'not_hosted' };
const alpha = f.channels.find((c) => c.channel === 'alpha');
for (const [a, w] of Object.entries(want)) {
  const d = alpha?.desks.find((x) => x.agent === a);
  const got = d?.nudge?.ok ? (d.nudge.opens ? 'opens' : 'bell') : d?.nudge?.code;
  if (got !== w || !(d.live || d.hosted?.live)) say(`!! ${a} reads ${got}${d && (d.live || d.hosted?.live) ? '' : ', not drawn'}; wanted ${w} and drawn — fix the fixture before opening a browser`);
}

setInterval(() => db.prepare(`UPDATE hosts SET last_seen = datetime('now') WHERE host_id = 'h1'`).run(), 2000);

for (;;) {
  let work = [];
  try { work = (await fetch(`${HOST}/api/host/work?host_id=h1&wait=20`, { headers: HK }).then((r) => r.json())).work ?? []; } catch { await sleep(500); continue; }
  for (const w of work) {
    const taken = Date.now();
    const a = answers();
    let did = 'ignored';
    if (w.kind === 'chat') {
      const row = db.prepare(`SELECT window_id FROM hosted_desks WHERE channel = ? AND agent = ?`).get(w.channel, w.agent);
      if (!row?.window_id && (a.never ?? []).includes(w.agent)) {
        await sleep(a.neverMs ?? 12000);
        await events([{ type: 'error', channel: w.channel, agent: w.agent, message: 'Claude Code is open in that window but has not finished starting — something on screen is waiting for an answer.' }]);
        did = 'error';
      } else {
        if (!row?.window_id) {
          await sleep(a.opensUpMs ?? 2500);
          db.prepare(`UPDATE hosted_desks SET window_id = ? WHERE channel = ? AND agent = ?`).run(`${w.agent}-window`, w.channel, w.agent);
        }
        await sleep(a.delayMs ?? 1200);
        await events([{ type: 'turn', channel: w.channel, agent: w.agent, session_id: `s-${w.agent}`, role: 'user', text: w.payload?.text ?? '' }]);
        did = row?.window_id ? 'typed' : 'opened, typed';
      }
    }
    process.stdout.write(`${JSON.stringify({ kind: w.kind, channel: w.channel, agent: w.agent, payload: w.payload, taken, answered: Date.now(), did })}\n`);
  }
}

#!/usr/bin/env node
/**
 * A floor for one agent with several sessions (costmo, 2026-11-16), and a
 * host that does what the board asks of one, on a throwaway server.
 *
 *   seed-sessions.mjs <base-url> [--key k] [--ctl ctl.json] > work.jsonl
 *
 * Unlike seed-meeting.mjs this host is a host: it registers through
 * /api/host/register every two seconds, naming every desk it has, with
 * `seats: true` — the board asks only a host that says it can seat a
 * second desk in a folder, and reads which desks it runs off the
 * registration. Nothing is written into the database behind the board.
 *
 * Desks, all on host h1 ("testbox"), each the desk of its own folder:
 *   lab/qa, lab/dev, lab/ops     /repo/qa, /repo/dev, /repo/ops
 *   lab2/zed                     /repo/zed
 *
 * Work, each item printed as one JSON line on stdout — how a check reads
 * what the page asked for:
 *
 *   chat     the words as the desk's user turn, then "<agent> heard: …"
 *   seat     a second desk in a folder: 500 ms later it is one of this
 *            host's desks (scope `seat`), said as `bound`, on the
 *            conversation asked for or a new one (`sess-<agent>-<n>`).
 *            With `seatFail: ["qa-2"]` in the control file the host says
 *            its refusal instead, on the desk it was made beside, in the
 *            words sit() in host/index.js uses. `seatSlow: 3000` holds a
 *            seat that long before it is made.
 *   unbind   the desk is no longer this host's, said as `unbound`
 *   browse   one folder listed, with what it is bound as: the folder's own
 *            desk, never a seat in it
 *   sessions the desk's conversations
 *   reopen   the desk's session becomes the one asked for
 */
import { existsSync, readFileSync } from 'node:fs';
import { boardProtocol } from './board-protocol.mjs';

const args = process.argv.slice(2);
const base = (args[0] ?? '').startsWith('http') ? args[0] : 'http://localhost:8905';
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const KEY = flag('key', 'k');
const CTL = flag('ctl', null);
const HOST = 'h1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HK = { 'content-type': 'application/json', 'x-orchestratinator-key': KEY };

const desks = new Map();
const put = (channel, agent, cwd, more = {}) => desks.set(`${channel}|${agent}`, { channel, agent, cwd, scope: 'local', session_id: `sess-${agent}`, window: `@${agent}`, ...more });
put('lab', 'qa', '/repo/qa');
put('lab', 'dev', '/repo/dev');
put('lab', 'ops', '/repo/ops');
put('lab2', 'zed', '/repo/zed');

/** A folder as the host describes it: bound as its own desk, never as a seat in it. */
const folder = (path) => {
  const own = [...desks.values()].find((d) => d.cwd === path && d.scope !== 'seat') ?? null;
  return {
    path, name: path.split('/').pop(), depth: 1,
    bound: own ? { channel: own.channel, agent: own.agent, scope: 'local', board: base } : null,
    has_mcp_json: false, other_board: null, trusted: true, git: true, last_active: '2026-11-16T10:00:00.000Z', sessions: 2,
  };
};
const FOLDERS = ['/repo/qa', '/repo/dev', '/repo/ops', '/repo/zed', '/repo/empty'];

// The board refuses a host that sends no protocol number (develop's
// protocolRefusal): asked of the board once, as seed-folders does.
const PROTOCOL = await boardProtocol(base);
const register = () => fetch(`${base}/api/host/register`, {
  method: 'POST', headers: HK,
  body: JSON.stringify({
    host_id: HOST, name: 'testbox', protocol: PROTOCOL, tmux: 'orch', seats: true, dialog: false,
    roots: ['/repo'], folders: FOLDERS.map(folder), desks: [...desks.values()],
  }),
}).then((r) => r.json()).catch((e) => ({ error: String(e) }));
const events = (evs) => fetch(`${base}/api/host/events`, { method: 'POST', headers: HK, body: JSON.stringify({ host_id: HOST, events: evs }) })
  .then((r) => r.json()).catch((e) => ({ error: String(e) }));
let uuid = 0;
const turn = (channel, agent, role, text) => ({
  type: 'turn', channel, agent, session_id: desks.get(`${channel}|${agent}`)?.session_id ?? null, role, text, at: new Date().toISOString(), uuid: `s${++uuid}`,
});
const ctl = () => {
  if (!CTL || !existsSync(CTL)) return {};
  try { return JSON.parse(readFileSync(CTL, 'utf8')); } catch { return {}; }
};

await register();
// What `session` and `holder` events say on a real host: each desk on its
// conversation, in a window the floor holds.
for (const d of desks.values()) {
  await events([
    { type: 'session', channel: d.channel, agent: d.agent, session_id: d.session_id, cwd: d.cwd, pid: 1000 },
    { type: 'holder', channel: d.channel, agent: d.agent, holder: 'floor', window: d.window, pid: 1000, window_open: d.window, holders: 1, clients: 0 },
    turn(d.channel, d.agent, 'user', `an old question for ${d.agent}`),
    turn(d.channel, d.agent, 'assistant', `${d.agent}'s old answer, from before any of this`),
  ]);
}
setInterval(register, 2000);
console.error(`seeded ${[...desks.keys()].join(', ')} on ${base}; host ${HOST} taking work`);

let made = 0;
async function handle(item) {
  const { channel, agent, kind, payload } = item;
  const k = `${channel}|${agent}`;
  if (kind === 'chat') {
    await sleep(250);
    await events([turn(channel, agent, 'user', payload?.text ?? '')]);
    await sleep(500);
    await events([turn(channel, agent, 'assistant', `${agent} heard: ${payload?.text ?? ''}`)]);
  } else if (kind === 'seat') {
    // `seatSlow` in the control file holds the seat that long, for a check
    // that reads what the page says while it waits.
    await sleep(Number(ctl().seatSlow) || 500);
    const beside = payload?.beside ?? null;
    if ((ctl().seatFail ?? []).includes(agent) && beside) {
      await events([{ type: 'error', channel: beside.channel, agent: beside.agent, code: 'seat_refused', message: `no new desk on ${channel}: refused: the fixture said to refuse ${agent}` }]);
      return;
    }
    const session = payload?.session_id ?? `sess-${agent}-${++made}`;
    desks.set(k, { channel, agent, cwd: payload.path, scope: 'seat', seat: true, session_id: session, window: `@${channel}-${agent}` });
    await register();
    await events([
      { type: 'bound', channel, agent, cwd: payload.path, scope: 'seat', session_id: null, from: null, beside },
      { type: 'session', channel, agent, session_id: session, cwd: payload.path, pid: 2000 + made },
      { type: 'holder', channel, agent, holder: 'floor', window: `@${channel}-${agent}`, pid: 2000 + made, window_open: `@${channel}-${agent}`, holders: 1, clients: 0 },
    ]);
    await register();
  } else if (kind === 'unbind') {
    await sleep(300);
    const d = desks.get(k);
    desks.delete(k);
    await events([{ type: 'unbound', channel, agent, cwd: d?.cwd ?? null, seat: d?.scope === 'seat' }]);
    await register();
  } else if (kind === 'browse') {
    const path = payload?.path ?? '/repo';
    const at = new Date().toISOString();
    await sleep(150);
    await events([{
      type: 'browse', requested: path, path, root: '/', parent: path === '/' ? null : path.split('/').slice(0, -1).join('/') || '/', at,
      self: folder(path), entries: path === '/repo' ? FOLDERS.map(folder) : [],
    }]);
  } else if (kind === 'sessions') {
    const d = desks.get(k);
    await sleep(200);
    await events([{ type: 'sessions', channel, agent, at: new Date().toISOString(), rows: [d?.session_id, `sess-${agent}-old`].filter(Boolean).map((id) => ({ id, title: `conversation ${id}`, spoken: true })) }]);
  } else if (kind === 'reopen') {
    await sleep(400);
    const d = desks.get(k);
    if (d) d.session_id = payload?.session_id ?? `sess-${agent}-fresh`;
    await events([{ type: 'session', channel, agent, session_id: d?.session_id ?? null }]);
  }
}

for (;;) {
  try {
    const r = await fetch(`${base}/api/host/work?host_id=${HOST}&wait=2`, { headers: HK });
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

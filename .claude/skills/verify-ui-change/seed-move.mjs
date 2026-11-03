#!/usr/bin/env node
/**
 * The fixture for checking issue #18 on the floor: Move to another floor on
 * a desk's nameplate card, and the dialog, the refusals and the landing
 * that follow it. The check is check-card-move.mjs.
 *
 * One floor to begin with, `alpha` — on purpose: with a single floor the
 * "all floors" view is not the building (nothing is collapsed, so a card
 * opens there with no floor chosen), and that is the view Decided 3 names
 * that Take a desk's landing leaves alone. Three desks on it, one per
 * reading of the card's button:
 *   ann  hosted on a live host (testbox) — the button works
 *   ed   live by its hooks, no host at all — disabled, "No host on this board…"
 *   cy   hosted on a host two days dead (oldbox), its hooks heard — NOT drawn:
 *        a hosted desk is exactly as live as its host (buildFloor's `live_`),
 *        so #20's empty rule leaves it off and no card can open on it. The
 *        route's named-host refusal ("The host oldbox is not…") is the floor
 *        suite's to prove; on the page the disabled button is only ever seen
 *        on a desk no host runs.
 *
 * It is also that live host. It long-polls /api/host/work for testbox and
 * answers a move's bind the way host/index.js does — `bound` with `from`,
 * then the new conversation's `session`; or, for a floor named `refuse-…`,
 * a refusal said on the desk it was leaving — and prints every work item as
 * a JSON line, which is how the check reads what the page sent. The host's
 * heartbeat runs for as long as this does.
 *
 *   PORT=8905 DB_PATH=./data/scratch.db ORCH_AUTH_TOKEN=k node src/server.js &
 *   node .claude/skills/verify-ui-change/seed-move.mjs http://localhost:8905 ./data/scratch.db > /tmp/work.jsonl &
 *   node --experimental-websocket .claude/skills/verify-ui-change/check-card-move.mjs http://localhost:8905 [out-dir] /tmp/work.jsonl
 *
 * Run from the repo root. Kill it when done; the key is `k`.
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
const HK = { 'content-type': 'application/json', 'x-orchestratinator-key': KEY };
const say = (s) => process.stderr.write(`${s}\n`);

const db = new Database(DB);
db.prepare(`INSERT OR REPLACE INTO hosts (host_id, name, last_seen) VALUES ('h1', 'testbox', datetime('now'))`).run();
db.prepare(`INSERT OR REPLACE INTO hosts (host_id, name, last_seen) VALUES ('h2', 'oldbox', datetime('now', '-2 days'))`).run();
for (const ag of ['ann', 'cy', 'ed']) db.prepare(`INSERT OR REPLACE INTO agents (channel, agent, last_seen) VALUES ('alpha', ?, datetime('now'))`).run(ag);
db.prepare(`INSERT OR REPLACE INTO hosted_desks (channel, agent, host_id, cwd, window_id, outside_pid, state, updated_at)
            VALUES ('alpha', 'ann', 'h1', '/repo/ann', 'ann-window', NULL, 'idle', datetime('now'))`).run();
db.prepare(`INSERT OR REPLACE INTO hosted_desks (channel, agent, host_id, cwd, window_id, outside_pid, state, updated_at)
            VALUES ('alpha', 'cy', 'h2', '/repo/cy', NULL, NULL, 'idle', datetime('now'))`).run();

const ingest = (body) => fetch(`${HOST}/api/ingest`, { method: 'POST', headers: HK, body: JSON.stringify(body) }).then((r) => r.status);
const ev = (agent, event, extra = {}) => ({ channel: 'alpha', agent, session_id: `s-${agent}`, hook_event_name: event, cwd: `/repo/${agent}`, ...extra });
say(`ingest ${JSON.stringify(await Promise.all(['cy', 'ed'].flatMap((a) => [
  ingest(ev(a, 'SessionStart')), ingest(ev(a, 'UserPromptSubmit', { message: 'go' })), ingest(ev(a, 'Stop', { last_assistant_message: 'done' })),
]))) }`);
const events = (list) => fetch(`${HOST}/api/host/events`, { method: 'POST', headers: HK, body: JSON.stringify({ host_id: 'h1', events: list }) }).then((r) => r.json());
say(`ann's turn ${JSON.stringify(await events([{ type: 'turn', channel: 'alpha', agent: 'ann', session_id: 's-ann', role: 'assistant', text: 'ready when you are' }]))}`);

const f = await (await fetch(`${HOST}/api/floor`)).json();
const reading = (d) => d.hosted ? (d.hosted.live ? 'ready' : 'host offline') : d.live ? 'here' : d.reporting ? 'away' : 'not reporting';
for (const c of f.channels) say(`${c.channel} — ${c.desks.map((d) => `${d.agent}:${reading(d)}:${d.live ? 'live' : 'cold'}`).join(' ')}`);
const want = { ann: ['ready', true], ed: ['here', true], cy: ['host offline', false] };
const alpha = f.channels.find((c) => c.channel === 'alpha');
for (const [a, [r, drawn]] of Object.entries(want)) {
  const d = alpha?.desks.find((x) => x.agent === a);
  if (!d || reading(d) !== r || !!(d.live || d.hosted?.live) !== drawn) say(`!! ${a} reads ${d ? reading(d) : 'missing'}, wanted ${r}${drawn ? ' and drawn' : ' and not drawn'} — fix the fixture before opening a browser`);
}
if (f.channels.length !== 1) say(`!! ${f.channels.length} floors — the all-floors step wants exactly one to begin with`);

setInterval(() => db.prepare(`UPDATE hosts SET last_seen = datetime('now') WHERE host_id = 'h1'`).run(), 2000);

// The host's half of a move, as host/index.js does it: rebound, said with
// where from and no conversation pinned (a window the floor held is closed,
// and the new floor gets a new one — #24 Decided 2), then the new window's
// session a moment later.
let n = 0;
for (;;) {
  let work = [];
  try { work = (await fetch(`${HOST}/api/host/work?host_id=h1&wait=20`, { headers: HK }).then((r) => r.json())).work ?? []; } catch { await new Promise((r) => setTimeout(r, 500)); continue; }
  for (const w of work) {
    process.stdout.write(`${JSON.stringify({ kind: w.kind, channel: w.channel, agent: w.agent, payload: w.payload })}\n`);
    if (w.kind !== 'bind') continue;
    const p = w.payload ?? {};
    await new Promise((r) => setTimeout(r, 400));
    // A floor named `refuse-…` is a move this host refuses, as bind() does
    // when the window turns out to be working: said on the desk it was
    // leaving, which is the one the board has a hosted row for (PR #33).
    if (p.from && /^refuse-/.test(p.channel)) {
      await events([{ type: 'error', channel: p.from.channel, agent: p.from.agent, code: 'bind_refused', message: `not moved to ${p.channel} — the window is still working: ✳ Baking… (esc to interrupt)` }]);
      continue;
    }
    await events([{ type: 'bound', channel: p.channel, agent: p.agent, cwd: p.path, scope: 'local', session_id: null, from: p.from ?? null }]);
    await new Promise((r) => setTimeout(r, 600));
    await events([{ type: 'session', channel: p.channel, agent: p.agent, session_id: `s-${p.agent}-new-${++n}`, cwd: p.path, pid: 4000 + n }]);
  }
}

#!/usr/bin/env node
/**
 * When the board took each turn, against when its transcript wrote it (task
 * 262, issue #5). The board stamps `turns.created_at` on arrival, its own
 * clock; the transcript line carries when Claude Code wrote it. Pairing them
 * shows whether turns were HELD — and a held release that lands on several
 * desks in the same second is the relay itself stalled.
 *
 *   node turn-lag.mjs <repo> <board.json from dating-dump.js> [--held-ms 20000]
 *
 * Pairs by session, role and text, in order within a session, through the
 * host's own readTranscript, so subagent turns and the relay's shapes come
 * out as the board stored them. Tool rows are left out: the relay rewrites
 * their text.
 *
 * Read by role, never all together. Measured 2026-11-03 over 2,691 pairs:
 * user turns p50 0.27 s, p90 1.2 s — the clean clock. Assistant (p50 0.9 s)
 * and thinking (p50 5.4 s) carry their own generation time, so on their
 * own they look like a relay that lags. And it can only see a stall that
 * held EVENTS: issue #5's commonest failure (the work poll alone timing out
 * while the laptop slept) never did, and left no mark here at all.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const [repo, boardPath] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
if (!repo || !boardPath) { console.error('usage: turn-lag.mjs <repo> <board.json> [--held-ms N]'); process.exit(2); }
const { readTranscript } = await import(join(repo, 'host/window.js'));
const board = JSON.parse(readFileSync(boardPath, 'utf8'));
const P = join(homedir(), '.claude/projects');
const where = new Map();
for (const dir of readdirSync(P)) {
  let names = []; try { names = readdirSync(join(P, dir)); } catch { continue; }
  for (const n of names) if (n.endsWith('.jsonl')) where.set(n.slice(0, -6), join(P, dir, n));
}
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
const bySession = new Map();
for (const r of board.turns) {
  if (r.via || !['user', 'assistant', 'thinking'].includes(r.role)) continue;
  if (!bySession.has(r.session_id)) bySession.set(r.session_id, []);
  bySession.get(r.session_id).push(r);
}
const pairs = [];
let missing = 0, unmatched = 0;
for (const [sid, rows] of bySession) {
  const f = where.get(sid);
  if (!f) { missing++; unmatched += rows.length; continue; }
  const tt = ((await readTranscript(f)).turns ?? []).filter((x) => ['user', 'assistant', 'thinking'].includes(x.role) && x.at);
  let k = 0;
  for (const row of rows) {
    const want = norm(row.text).slice(0, 60);
    let j = k;
    while (j < tt.length && !(tt[j].role === row.role && norm(tt[j].text).startsWith(want))) j++;
    if (j >= tt.length) { unmatched++; continue; }
    k = j + 1;
    const arrived = Date.parse(`${row.created_at.replace(' ', 'T')}Z`);
    pairs.push({ desk: `${row.channel}/${row.agent}`, role: row.role, arrived, written: Date.parse(tt[j].at), lag: arrived - Date.parse(tt[j].at) });
  }
}
console.log(`sessions with text turns ${bySession.size} (${missing} not on this disk); pairs ${pairs.length}, unmatched ${unmatched}`);
for (const role of ['user', 'assistant', 'thinking']) {
  const l = pairs.filter((p) => p.role === role).map((p) => p.lag).sort((a, b) => a - b);
  if (!l.length) continue;
  const q = (f) => l[Math.floor(f * (l.length - 1))];
  console.log(`  ${role.padEnd(9)} n=${String(l.length).padStart(5)}  p50 ${q(0.5)} ms  p90 ${q(0.9)} ms  p99 ${q(0.99)} ms`);
}
// Releases: held turns arriving within 2 s of each other. Several desks in one
// release is the relay stalled; one desk alone is usually that desk's own story.
const heldMs = Number(opt('--held-ms', 20000));
const held = pairs.filter((p) => p.lag > heldMs).sort((a, b) => a.arrived - b.arrived);
const groups = [];
for (const x of held) { const g = groups.at(-1); if (g && x.arrived - g.last <= 2000) { g.rows.push(x); g.last = x.arrived; } else groups.push({ first: x.arrived, last: x.arrived, rows: [x] }); }
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
console.log(`releases of turns held over ${heldMs / 1000} s: ${groups.length} (${groups.filter((g) => new Set(g.rows.map((r) => r.desk)).size > 1).length} spanning more than one desk)`);
// Every release spanning desks, then the ten longest holds: one desk's
// releases are many and mostly its own story (a reopened conversation's tail).
const span = (g) => new Set(g.rows.map((r) => r.desk)).size;
const longest = (g) => Math.max(...g.rows.map((r) => r.lag));
const shown = [...groups.filter((g) => span(g) > 1), ...groups.filter((g) => span(g) === 1).sort((a, b) => longest(b) - longest(a)).slice(0, 10)];
for (const g of shown) {
  const desks = new Set(g.rows.map((r) => r.desk));
  console.log(`  ${iso(g.first)}  ${g.rows.length} turn(s), ${desks.size} desk(s), held from ${iso(Math.min(...g.rows.map((r) => r.written)))}  ${[...desks].slice(0, 3).join(', ')}`);
}

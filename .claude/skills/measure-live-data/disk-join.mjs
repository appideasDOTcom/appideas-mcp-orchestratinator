#!/usr/bin/env node
// What is on this host's disk, set against what the board holds. Read-only.
//
//   board-query.sh board-snapshot.js | grep '^@@JSON@@' | sed 's/^@@JSON@@//' > board.json
//   node disk-join.mjs board.json
//
// The transcripts are read with host/window.js's own readTranscript and
// sessionsIn — the same parse the floor draws from — so "a turn" here means
// what it means on the page, not a line of JSONL.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const W = await import(`${REPO}/host/window.js`);
const board = JSON.parse(readFileSync(process.argv[2], 'utf8'));

// One folder once. hosted_desks keeps a row for every desk a folder has ever
// been, so the same cwd is in it several times: reading each would count
// every conversation three times over (306 files for 104, the first time).
const cwds = [...new Set(board.desks.map((d) => d.cwd).filter(Boolean).map((c) => W.canonical(c)))];
const U = new Map();
for (const cwd of cwds) {
  const dir = W.projectDir(cwd);
  let names = [];
  try { names = readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
  for (const n of names) U.set(n.slice(0, -'.jsonl'.length), { cwd, path: join(dir, n), size: statSync(join(dir, n)).size });
}
const boardIds = new Set(board.sessions.map((s) => s.session_id));
const turnIds = new Map(board.turnSessions.map((t) => [t.session_id, t]));
const ids = [...U.keys()];
console.log(`desk folders: ${cwds.length} | conversations on disk: ${ids.length} | MB: ${([...U.values()].reduce((n, f) => n + f.size, 0) / 1e6).toFixed(1)}`);
console.log(`  with any row in turns: ${ids.filter((id) => turnIds.has(id)).length} | with an agent_sessions row: ${ids.filter((id) => boardIds.has(id)).length} | with neither: ${ids.filter((id) => !boardIds.has(id)).length}`);
console.log(`agent_sessions rows: ${board.sessions.length} | of them on this disk: ${board.sessions.filter((s) => U.has(s.session_id)).length}`);

let t0 = Date.now();
const roles = {};
const perSession = new Map();
let turns = 0;
for (const [id, f] of U) {
  const r = await W.readTranscript(f.path);
  perSession.set(id, r.turns.length);
  for (const t of r.turns) { roles[t.role] = (roles[t.role] ?? 0) + 1; turns++; }
}
console.log(`turns as the floor parses them: ${turns} | ${JSON.stringify(roles)} | read and parsed in ${Date.now() - t0} ms (subagent files not counted)`);
const held = [...turnIds.values()].filter((t) => perSession.has(t.session_id));
const b = held.reduce((n, h) => n + h.turns, 0);
const d = held.reduce((n, h) => n + perSession.get(h.session_id), 0);
console.log(`board rows for conversations on this disk: ${b} of ${d} turns (${d ? (100 * b / d).toFixed(1) : 0}%) — an overcount of the board: its rows include subagent turns`);
t0 = Date.now();
let walked = 0;
for (const cwd of cwds) walked += (await W.sessionsIn(cwd, { limit: 30 })).length;
console.log(`the picker's own walk of every folder (sessionsIn, 30 each): ${walked} rows in ${Date.now() - t0} ms`);

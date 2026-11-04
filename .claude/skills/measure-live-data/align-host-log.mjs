#!/usr/bin/env node
/**
 * Put times on an untimed host log by its ORDER (task 262, issue #5). Lines
 * that answer something the operator did are matched to the timed
 * admin_events row for it, and every failure run is bounded by the nearest
 * placed anchor on each side:
 *
 *   node align-host-log.mjs <host.log> <board.json from dating-dump.js> [--min 20] [--out runs.json]
 *
 *   `<ch>/<ag>: answered with N of N step(s)` / `could not answer` / `the form was not submitted`  ↔ permission.answered
 *   `<ch>/<ag>: reopened on a new conversation`  ↔ desk.new
 *   `<ch>/<ag>: bound … in local scope`          ↔ desk.bound
 *   `<ch>/<ag>: reopened on <session id>`        ↔ desk.reopen (by the id)
 *   `<ch>/<ag>: binding <path> — … moving it from` ↔ desk.moved (by the path)
 *
 * The alignment is the LONGEST chain of (line, event) pairs whose times rise
 * with line order, not a greedy walk. Greedy was tried first and drifted by
 * days: one anchor whose event was missing took a later one, and everything
 * after it moved — it put 2,700 lines into 35 minutes. The chain reproduced
 * QA's independent placement of L11053–11132 exactly (2026-11-02
 * 17:46:19Z–18:13:04Z). Bounds are as tight as the operator was busy:
 * minutes when they were working, days over a weekend.
 *
 * Lines written since 0.10.11 carry their own time and need none of this.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const [logPath, boardPath] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
if (!logPath || !boardPath) { console.error('usage: align-host-log.mjs <host.log> <board.json> [--min N] [--out file]'); process.exit(2); }
const lines = readFileSync(logPath, 'utf8').split('\n');
const board = JSON.parse(readFileSync(boardPath, 'utf8'));
const t = (s) => Date.parse(s.replace(' ', 'T') + 'Z');
const iso = (ms) => (ms == null ? '?' : new Date(ms).toISOString().replace('.000Z', 'Z'));

const ev = new Map();
const add = (key, at) => { if (!ev.has(key)) ev.set(key, []); ev.get(key).push(at); };
for (const a of board.admin) {
  const at = t(a.created_at);
  if (a.action === 'permission.answered') add(`A|${a.channel}/${a.target}`, at);
  if (a.action === 'desk.new') add(`N|${a.channel}/${a.target}`, at);
  if (a.action === 'desk.bound') add(`B|${a.channel}/${a.target}`, at);
  if (a.action === 'desk.reopen') add(`R|${a.channel}/${a.target}|${a.detail}`, at);
  if (a.action === 'desk.moved') add(`M|${a.channel}/${a.target}|${a.detail}`, at);
}
const P = '^\\[host\\] (?:\\S+Z )?([\\w.-]+)\\/([\\w.-]+): ';
const RX = [
  ['A', new RegExp(P + '(?:answered with \\d+ of \\d+ step|could not answer the question|the form was not submitted)'), (m) => `A|${m[1]}/${m[2]}`],
  ['N', new RegExp(P + 'reopened on a new conversation'), (m) => `N|${m[1]}/${m[2]}`],
  ['B', new RegExp(P + 'bound .* in local scope'), (m) => `B|${m[1]}/${m[2]}`],
  ['R', new RegExp(P + 'reopened on ([0-9a-f-]{36})'), (m) => `R|${m[1]}/${m[2]}|${m[3]}`],
  ['M', new RegExp(P + 'binding (\\S+) — .*moving it from'), (m) => `M|${m[1]}/${m[2]}|${m[3]}`],
];
const cands = [];
let anchorLines = 0;
for (let i = 0; i < lines.length; i++) {
  for (const [kind, re, keyOf] of RX) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    anchorLines++;
    for (const at of ev.get(keyOf(m)) ?? []) cands.push({ line: i + 1, at, what: `${kind} ${m[1]}/${m[2]}` });
  }
}
// Longest chain, increasing in both line and time: sort by line, then time
// descending, so one line cannot take two events.
cands.sort((a, b) => a.line - b.line || b.at - a.at);
const tails = [], tailIdx = [], prev = new Array(cands.length).fill(-1);
for (let i = 0; i < cands.length; i++) {
  let lo = 0, hi = tails.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < cands[i].at) lo = mid + 1; else hi = mid; }
  tails[lo] = cands[i].at; tailIdx[lo] = i; prev[i] = lo > 0 ? tailIdx[lo - 1] : -1;
}
const chain = [];
for (let i = tailIdx[tails.length - 1] ?? -1; i >= 0; i = prev[i]) chain.unshift(cands[i]);
const placed = [];
const seen = new Set();
for (const c of chain) if (!seen.has(c.line)) { seen.add(c.line); placed.push(c); }
console.log(`anchor lines ${anchorLines}, candidate pairs ${cands.length}, placed ${placed.length}`);

const FAIL = /retrying in (\d+)s$|events not delivered/;
const runs = [];
let cur = null;
for (let i = 0; i < lines.length; i++) {
  const m = FAIL.exec(lines[i]);
  if (m) {
    cur ??= { from: i + 1, to: i + 1, n: 0, steps: {}, kinds: {} };
    cur.to = i + 1; cur.n++;
    const st = m[1] ? `${m[1]}s` : 'ev'; cur.steps[st] = (cur.steps[st] || 0) + 1;
    const k = /timed out|timeout/.test(lines[i]) ? 'T' : /fetch failed|refused|failed \(/.test(lines[i]) ? 'F' : 'O'; cur.kinds[k] = (cur.kinds[k] || 0) + 1;
  } else if (cur && !/^\[host\] (?:\S+Z )?  /.test(lines[i])) { runs.push(cur); cur = null; }
}
if (cur) runs.push(cur);
for (const r of runs) {
  const b = [...placed].reverse().find((a) => a.line < r.from);
  const a = placed.find((x) => x.line > r.to);
  Object.assign(r, { after: b?.at ?? null, afterLine: b?.line ?? null, afterWhat: b?.what ?? null, before: a?.at ?? null, beforeLine: a?.line ?? null, beforeWhat: a?.what ?? null });
}
if (opt('--out')) writeFileSync(opt('--out'), JSON.stringify({ placed, runs }));
const min = Number(opt('--min', 20));
for (const r of runs.filter((x) => x.n >= min)) {
  const hours = r.after != null && r.before != null ? ` (${((r.before - r.after) / 3600000).toFixed(1)} h)` : '';
  console.log(`L${r.from}-${r.to} n=${r.n} ${JSON.stringify(r.steps)} ${JSON.stringify(r.kinds)} | between ${iso(r.after)} (L${r.afterLine} ${r.afterWhat}) and ${iso(r.before)} (L${r.beforeLine} ${r.beforeWhat})${hours}`);
}

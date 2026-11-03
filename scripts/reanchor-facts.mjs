#!/usr/bin/env node
/**
 * Move docs/marketing-facts.md's line references from one commit to another.
 *
 *   node scripts/reanchor-facts.mjs <old-sha> <new-sha> [--write]
 *
 * Every fact in that file cites `path:line` (or `path:a-b`, or
 * `path:a, b, c`) at the commit named in its header. Code moves; the facts
 * do not. For each cited line this takes the text at <old-sha>, finds that
 * exact line in <new-sha>, and reports it as SAME, MOVED (one match — the
 * new number), or UNSURE (none, or several — a person reads it). With
 * --write it rewrites the MOVED references in place and leaves the header
 * for you to re-date; without it, it only reports.
 *
 * Why a script: on 2026-11-02 the file was re-anchored by hand-rolled regex
 * and six references were missed because they were written as lists
 * (`src/floor.js:2244, 2269, 2386, 2412`) or pointed at a `.sh` file. QA
 * found them by reading. This matches every form the file uses; add a form
 * here if a new one appears, not a second regex somewhere else.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const [oldSha, newSha, ...rest] = process.argv.slice(2);
if (!oldSha || !newSha) { console.error('usage: reanchor-facts.mjs <old-sha> <new-sha> [--write]'); process.exit(1); }
const write = rest.includes('--write');
const DOC = 'docs/marketing-facts.md';
const ALIAS = { 'hooks.json': 'plugin/hooks/hooks.json', 'report.mjs': 'plugin/hooks/report.mjs' };

const files = new Map();
const at = (sha, path) => {
  const k = `${sha}:${path}`;
  if (!files.has(k)) {
    try { files.set(k, execFileSync('git', ['show', k], { encoding: 'utf8' }).split('\n')); } catch { files.set(k, null); }
  }
  return files.get(k);
};

let doc = readFileSync(DOC, 'utf8');
// `path:NUMS` where NUMS is "12", "12-15", or "12, 15, 40-42" — one backticked span per reference.
const REF = /`([A-Za-z0-9_./-]+\.[a-z]{1,4}):(\d+(?:-\d+)?(?:,\s*\d+(?:-\d+)?)*)`/g;
let same = 0, moved = 0, unsure = 0;
const edits = [];
for (const m of doc.matchAll(REF)) {
  const [whole, shown, nums] = m;
  const path = ALIAS[shown] ?? shown;
  const o = at(oldSha, path), n = at(newSha, path);
  if (!o || !n) { console.log(`UNSURE ${whole} — file missing at one commit`); unsure++; continue; }
  const parts = nums.split(',').map((x) => x.trim());
  const out = [];
  let changed = false, bad = false;
  for (const part of parts) {
    const [a, b] = part.split('-').map(Number);
    const end = b ?? a;
    const text = o[a - 1];
    if (text === undefined) { bad = true; console.log(`UNSURE ${shown}:${part} — no such line at ${oldSha}`); break; }
    if (n[a - 1] === text && (b === undefined || n[end - 1] === o[end - 1])) { out.push(part); continue; }
    const hits = n.map((l, i) => (l === text && text.trim() ? i + 1 : 0)).filter(Boolean);
    if (hits.length !== 1 || (b !== undefined && n[hits[0] + (end - a) - 1] !== o[end - 1])) {
      bad = true; console.log(`UNSURE ${shown}:${part} — ${hits.length} matches for "${text.trim().slice(0, 60)}"`); break;
    }
    out.push(b === undefined ? String(hits[0]) : `${hits[0]}-${hits[0] + (end - a)}`);
    changed = true;
  }
  if (bad) { unsure++; continue; }
  if (!changed) { same++; continue; }
  const replacement = `\`${shown}:${out.join(', ')}\``;
  console.log(`MOVED  ${whole} -> ${replacement}`);
  edits.push([whole, replacement]);
  moved++;
}
console.log(`\n${same} same, ${moved} moved, ${unsure} unsure`);
if (write && edits.length) {
  for (const [a, b] of edits) doc = doc.split(a).join(b);
  writeFileSync(DOC, doc);
  console.log(`wrote ${edits.length} reference(s) to ${DOC}; re-date the header to ${newSha} yourself`);
} else if (edits.length) console.log('(dry run — add --write to apply)');

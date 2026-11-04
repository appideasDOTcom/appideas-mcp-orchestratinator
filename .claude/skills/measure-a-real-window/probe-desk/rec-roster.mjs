#!/usr/bin/env node
/**
 * Every Claude Code session file naming a conversation or a folder, every
 * 5 ms, written on change: `pid:kind:entrypoint:session:alive|dead`. The
 * roster as holderOf() reads it (host/window.js readSessionFiles: the file
 * AND a live pid), at the resolution a kill-then-reopen race needs — the
 * window leaves it 4–14 ms after `tmux kill-window` on 2.1.300 (task 253).
 *
 *   node rec-roster.mjs <out-file> <session-id-prefix> <folder-substring> [seconds]
 *   16:28:23.907 78445:interactive:cli:de4c5838:alive
 *   16:28:38.325 (none)
 *   16:28:39.035 79889:interactive:cli:de4c5838:alive
 *
 * Reads ~/.claude/sessions only; it never touches a process.
 */
import { readdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const [out, sid, folder, secs = '600'] = process.argv.slice(2);
if (!out || !sid || !folder) { console.error('usage: rec-roster.mjs <out> <session-id-prefix> <folder-substring> [seconds]'); process.exit(2); }
const S = join(homedir(), '.claude', 'sessions');
const alive = (p) => { try { process.kill(p, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
writeFileSync(out, '');
const end = Date.now() + Number(secs) * 1000;
let last = '';
while (Date.now() < end) {
  const rows = [];
  for (const n of readdirSync(S)) {
    if (!/^\d+\.json$/.test(n)) continue;
    let d; try { d = JSON.parse(readFileSync(join(S, n), 'utf8')); } catch { continue; }
    if (d.sessionId?.startsWith(sid) || (d.cwd ?? '').includes(folder)) {
      rows.push(`${d.pid}:${d.kind}:${d.entrypoint ?? '-'}:${String(d.sessionId).slice(0, 8)}:${alive(Number(d.pid)) ? 'alive' : 'dead'}`);
    }
  }
  const now = rows.sort().join(' | ') || '(none)';
  if (now !== last) { appendFileSync(out, `${new Date().toISOString().slice(11, 23)} ${now}\n`); last = now; }
  await new Promise((r) => setTimeout(r, 5));
}

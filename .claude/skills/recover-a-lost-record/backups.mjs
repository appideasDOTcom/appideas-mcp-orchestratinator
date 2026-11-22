#!/usr/bin/env node
/**
 * What each backup file on this machine holds, set side by side: how far
 * each floor's messages go, and which contracts it carries at which version.
 *
 *   node backups.mjs [dir ...] [--floor <channel> ...] [--file <backup.json> ...]
 *
 * With no dir it reads ~/Downloads and the desktop app's own board folder
 * (where the app keeps `pre-restore-…json`, the board as it was just before
 * a restore). Files under 100 KB are listed as a count only: a page check
 * that exports a scratch board leaves a 949-byte file in Downloads each run.
 *
 * Why it exists (2026-11-20): a board was restored from "the newest backup",
 * and the newest whole file was another instance's export. It held this
 * floor only up to the hour the work had moved off that instance, two days
 * earlier, and nobody could see that from the file's name or date. This
 * prints the answer before a restore, and after one says exactly what was
 * lost: the floors whose last message is older than the file.
 *
 * Read-only. It prints no message text and no key.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const take = (flag) => { const out = []; for (let i = argv.indexOf(flag); i >= 0; i = argv.indexOf(flag, i + 1)) out.push(argv[i + 1]); return out.filter(Boolean); };
const floors = take('--floor');
const named = take('--file');
const dirs = argv.filter((a, i) => !a.startsWith('--') && !['--floor', '--file'].includes(argv[i - 1]));
if (!dirs.length && !named.length) dirs.push(join(homedir(), 'Downloads'), join(homedir(), 'Library/Application Support/Orchestratinator/board'));

const files = [...named];
let small = 0;
for (const d of dirs) {
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d)) {
    if (!/orchestratinator-backup-.*\.json$/.test(f)) continue;
    const p = join(d, f);
    if (statSync(p).size < 100_000 && !/^pre-restore-/.test(f)) { small++; continue; }
    files.push(p);
  }
}
files.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
if (!files.length) { console.log(`no backup of any size in ${dirs.join(', ')}`); process.exit(1); }

for (const p of files) {
  let j;
  try { j = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { console.log(`\n${p}\n  unreadable: ${e.message}`); continue; }
  const t = j.tables ?? {};
  const msgs = t.messages ?? [];
  const last = new Map();
  for (const m of msgs) { const was = last.get(m.channel); if (!was || m.id > was.id) last.set(m.channel, { id: m.id, at: m.created_at, n: (was?.n ?? 0) + 1 }); else was.n++; }
  const newest = msgs.reduce((a, m) => (m.id > a.id ? m : a), { id: 0, created_at: '-' });
  console.log(`\n${p}`);
  console.log(`  written ${j.created_at ?? '?'} by ${j.server?.version ?? j.source?.version ?? '?'} · ${(statSync(p).size / 1e6).toFixed(1)} MB · ${msgs.length} messages, newest id ${newest.id} at ${newest.created_at} · ${(t.tasks ?? []).length} tasks · ${(t.contracts ?? []).length} contracts`);
  const rows = [...last.entries()].filter(([ch]) => !floors.length || floors.includes(ch)).sort((a, b) => (a[1].at < b[1].at ? 1 : -1));
  for (const [ch, v] of rows.slice(0, floors.length ? rows.length : 8)) console.log(`    ${v.at}  ${String(v.n).padStart(5)} msgs  last id ${String(v.id).padStart(5)}  ${ch}`);
  if (!floors.length && rows.length > 8) console.log(`    … ${rows.length - 8} more floors (name one with --floor to see it)`);
  const cons = (t.contracts ?? []).filter((c) => !floors.length || floors.includes(c.channel));
  if (floors.length) for (const c of cons) console.log(`    contract ${c.channel}/${c.key} v${c.version} ${c.updated_at} by ${c.updated_by}`);
}
if (small) console.log(`\n(${small} files under 100 KB left out: scratch boards' exports)`);

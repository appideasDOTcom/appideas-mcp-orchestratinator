// Prove a backup file restores cleanly on the current code — see SKILL.md.
//
//   node .claude/skills/verify-a-backup/verify-backup-file.mjs <backup.json> [port]
//
// Stands up a throwaway server from this working tree, restores the file
// through the real API, re-exports, and compares row for row. Fails only on
// loss: a refused restore, a count that doesn't match, or a value that doesn't
// survive the round trip. Everything the restore *says* — notes, ignored
// columns — is printed verbatim for the operator to judge, never guessed at.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const FILE = process.argv[2];
if (!FILE) {
  console.error('usage: node verify-backup-file.mjs <backup.json> [port]');
  process.exit(2);
}
const PORT = Number(process.argv[3] ?? 8899);
const HOST = `http://localhost:${PORT}`;
const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const SCRATCH = mkdtempSync(join(tmpdir(), 'orch-verify-'));

let failures = 0;
const assert = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) failures++; };

const server = spawn('node', ['src/server.js'], {
  cwd: REPO,
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: join(SCRATCH, 'verify.db'),
    ORCH_AUTH_TOKEN: 'verify-secret',
    ORCH_AUTH_MODE: 'warn',
  },
  stdio: 'ignore',
});

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { up = (await fetch(`${HOST}/health`)).ok; } catch { await sleep(100); }
  }
  if (!up) throw new Error(`no throwaway server on :${PORT} — is the port taken?`);

  const doc = JSON.parse(readFileSync(FILE, 'utf8'));

  console.log(`restoring ${FILE}`);
  const res = await fetch(`${HOST}/api/admin/backup/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: 'RESTORE', backup: doc }),
  });
  const out = await res.json();
  assert(res.status === 200, `the restore is accepted (${res.status}${out.error ? `: ${out.error}` : ''})`);
  if (res.status !== 200) throw new Error('nothing to compare');

  const want = Object.values(doc.counts ?? {}).reduce((n, v) => n + v, 0);
  assert(out.rows === want, `every row loads: ${out.rows} of ${want}`);
  for (const [t, n] of Object.entries(doc.counts ?? {})) {
    assert(out.tables?.[t]?.inserted === n, `${t}: ${out.tables?.[t]?.inserted} inserted of ${n} in the file`);
  }

  // The restore's own account of itself, verbatim. Ignored columns are data
  // the file holds and this schema has no home for — that may be fine (an
  // obsolete cursor) or may matter (a column a note should have explained);
  // the operator decides, this script only makes sure it is seen.
  for (const n of out.notes ?? []) console.log(`  note: ${n}`);
  for (const [t, r] of Object.entries(out.tables ?? {})) {
    if (r.ignored_columns?.length) console.log(`  note: ${t} columns set aside: ${r.ignored_columns.join(', ')}`);
  }

  console.log('\nthe board reads back');
  const state = await (await fetch(`${HOST}/api/state`)).json();
  const shelved = new Set((doc.tables.channel_flags ?? []).filter((f) => f.archived_at).map((f) => f.channel));
  const fileChannels = new Set(
    ['messages', 'agents', 'tasks'].flatMap((t) => (doc.tables[t] ?? []).map((r) => r.channel))
  );
  fileChannels.delete('(server)');
  const boardChannels = new Set(state.channels.map((c) => c.channel));
  const missing = [...fileChannels].filter((c) => !boardChannels.has(c) && !shelved.has(c));
  assert(missing.length === 0, `every channel is on the board (missing: ${JSON.stringify(missing)})`);
  const knownAgents = (state.totals?.agents ?? 0) + (state.totals?.retired_agents ?? 0);
  assert(knownAgents === (doc.counts.agents ?? 0), `all ${doc.counts.agents ?? 0} agents are known (board: ${knownAgents})`);
  if ((doc.counts.agents ?? 0) > 0) {
    const floor = await (await fetch(`${HOST}/api/floor`)).json();
    const desks = (floor.channels ?? []).flatMap((c) => c.desks ?? []);
    assert(desks.length > 0 && desks.every((d) => d.persona), `the floor derives a name for every desk (${desks.length} desks)`);
  }

  console.log('\nre-export matches the file');
  const back = await (await fetch(`${HOST}/api/admin/backup`)).json();
  for (const [t, rows] of Object.entries(doc.tables)) {
    if (!(t in (out.tables ?? {})) || out.tables[t].skipped) continue;   // e.g. a legacy users table
    const got = back.tables[t] ?? [];
    const skip = new Set(out.tables[t].ignored_columns ?? []);
    // admin_events legitimately grows: the restore writes its own audit row,
    // after the wipe, so the log survives the thing it records.
    const extras = got.slice(rows.length);
    let same = t === 'admin_events'
      ? got.length >= rows.length && extras.every((r) => r.action?.startsWith('backup.'))
      : got.length === rows.length;
    for (let i = 0; same && i < rows.length; i++) {
      for (const [k, v] of Object.entries(rows[i])) {
        if (skip.has(k)) continue;
        if (got[i][k] !== v) {
          console.log(`    first difference: ${t}[${i}].${k} — file ${JSON.stringify(v)}, board ${JSON.stringify(got[i][k])}`);
          same = false; break;
        }
      }
    }
    assert(same, `${t}: ${rows.length} rows survive value-for-value` +
      (t === 'admin_events' && extras.length ? ` (+${extras.length} audit row(s) recording this restore)` : ''));
  }
} catch (err) {
  console.error('error:', err);
  failures++;
} finally {
  server.kill('SIGKILL');
  // The DB, its WAL, and the pre-restore snapshot the server wrote beside it.
  try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* gone */ }
}
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)`);
process.exit(failures ? 1 : 0);

#!/usr/bin/env node
/**
 * Did a form answered from the floor actually submit? Match the board's
 * record of the answer to the window's own receipt.
 *
 *   match-answer.mjs <channel> <agent> [--since '2026-11-02 18:00'] [--limit 6]
 *
 * Three records exist, and this reads the two that settle it:
 *
 * 1. The server's `admin_events`: one `permission.answered` (or
 *    `permission.clarified`) row per floor answer — channel, agent, the
 *    question and what was chosen, created_at in UTC to the second. Durable;
 *    read inside the container with better-sqlite3 at $DB_PATH, read-only.
 * 2. The desk's transcript on this host: the AskUserQuestion `tool_use`
 *    whose question matches, and — only if the form submitted — a
 *    `tool_result` for its id. A form still standing is a tool_use with no
 *    tool_result after it. The board's `turns` table has the tool_use but
 *    never the result, and the host log's "answered with N of N" line has no
 *    timestamp, so neither can answer this on its own.
 *
 * Measured 2026-11-02 on the six newest rows: each had its tool_result 0.3 to
 * 0.9 s after the admin event. The next "it looked submitted but the form is
 * still there" report is read with this, for that desk and minute, before
 * any theory about the host.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const [channel, agent] = args;
if (!channel || !agent) { console.error("usage: match-answer.mjs <channel> <agent> [--since 'YYYY-MM-DD HH:MM'] [--limit N]"); process.exit(1); }
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const since = opt('--since', '1970-01-01');
const limit = Number(opt('--limit', 6));

const sql = `
const Database = require('better-sqlite3'); const db = new Database(process.env.DB_PATH, { readonly: true });
const desk = db.prepare("SELECT cwd, sdk_session_id FROM hosted_desks WHERE channel = ? AND agent = ?").get(${JSON.stringify(channel)}, ${JSON.stringify(agent)});
const rows = db.prepare("SELECT id, action, detail, created_at FROM admin_events WHERE channel = ? AND target = ? AND action IN ('permission.answered','permission.clarified') AND created_at >= ? ORDER BY id DESC LIMIT ?").all(${JSON.stringify(channel)}, ${JSON.stringify(agent)}, ${JSON.stringify(since)}, ${limit});
console.log(JSON.stringify({ desk, rows }));`;
const out = execFileSync('docker', ['compose', 'exec', '-T', 'orchestratinator', 'node', '-e', sql], { encoding: 'utf8', cwd: resolve(new URL('../../..', import.meta.url).pathname) });
const { desk, rows } = JSON.parse(out.trim().split('\n').pop());
if (!desk) { console.log(`no hosted desk ${channel}/${agent} on the board`); process.exit(1); }
console.log(`desk ${channel}/${agent} cwd ${desk.cwd} session ${desk.sdk_session_id}`);
if (!rows.length) { console.log(`no floor answers for it since ${since}`); process.exit(0); }

const dir = join(homedir(), '.claude', 'projects', resolve(desk.cwd).replace(/[/.]/g, '-'));
if (!existsSync(dir)) { console.log(`no transcripts for ${desk.cwd} on this host (${dir})`); process.exit(1); }
const calls = new Map();
for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
  for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
    if (!line.includes('AskUserQuestion') && !line.includes('toolu_')) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const c = d.message?.content; if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b.type === 'tool_use' && b.name === 'AskUserQuestion') calls.set(b.id, { file: f.slice(0, 8), asked: d.timestamp, q: (b.input?.questions ?? []).map((x) => x.question ?? '').join(' '), result: null });
      if (b.type === 'tool_result' && calls.has(b.tool_use_id)) calls.get(b.tool_use_id).result = d.timestamp;
    }
  }
}
for (const r of rows) {
  const question = String(r.detail ?? '').replace(/^│\s*/, '').split(': ')[0].slice(0, 60);
  const hits = [...calls.values()].filter((c) => c.q.startsWith(question));
  console.log(`\nadmin_events #${r.id} ${r.created_at}Z ${r.action}: ${String(r.detail ?? '').slice(0, 100)}`);
  if (!hits.length) { console.log('  no AskUserQuestion with that question in this desk’s transcripts'); continue; }
  for (const h of hits) {
    console.log(`  ${h.file} asked ${h.asked} → ${h.result ? `tool_result ${h.result} — SUBMITTED` : 'NO tool_result — the form is still standing (or the process died with it open)'}`);
  }
}

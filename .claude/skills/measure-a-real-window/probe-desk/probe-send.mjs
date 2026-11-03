#!/usr/bin/env node
// Measurement helper for a probe desk: snapshot every store, send one chat through the floor's own route, report what changed.
// env: PROBE_DIR (the probe folder), REC (where the recorders write), BOARD (port, default 8787), CHANNEL, AGENT, HOSTLOG/FLOORLOG (names inside REC).
//   probe-send.mjs snap                      -> prints a snapshot id
//   probe-send.mjs send <text> [waitSec]     -> snap, POST /api/floor/chat, wait, report
//   probe-send.mjs report <snapId>           -> report everything since that snapshot
//   probe-send.mjs tail                      -> report since the last snapshot (re-run)
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
const SP = process.env.REC; const P = process.env.PROBE_DIR;
if (!SP || !P) { console.error("set REC (recorder dir) and PROBE_DIR"); process.exit(2); }
const PD = join(homedir(), '.claude', 'projects', resolve(P).replace(/[/.]/g, '-'));
const FILES = () => ({
  hooks: join(P, 'hooks.log'), host: join(SP, process.env.HOSTLOG ?? 'rec/host.log'), floor: join(SP, process.env.FLOORLOG ?? 'rec/floor.log'), pane: join(SP, 'pane.log'),
  ...Object.fromEntries(walk(PD).map((f) => ['T:' + f.slice(PD.length + 1), f])),
});
function walk(d) { if (!existsSync(d)) return []; const out = []; for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) out.push(...walk(p)); else if (/\.(jsonl|json)$/.test(e.name)) out.push(p); } return out; }
const sizeOf = (f) => { try { return statSync(f).size; } catch { return 0; } };
function snap() { const s = {}; for (const [k, f] of Object.entries(FILES())) s[k] = sizeOf(f); const id = `${Date.now()}`; writeFileSync(join(SP, `snap-${id}.json`), JSON.stringify(s)); writeFileSync(join(SP, 'snap-last'), id); return id; }
const since = (f, from) => { try { return readFileSync(f).subarray(from).toString('utf8'); } catch { return ''; } };
const clip = (s, n = 110) => { s = String(s ?? '').replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n) + '…' : s; };
const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b.type === 'text' ? b.text : b.type === 'tool_use' ? `[tool_use ${b.name}]` : b.type === 'tool_result' ? '[tool_result]' : b.type === 'thinking' ? '[thinking]' : `[${b.type}]`).join(' ') : '';
const COMMON = new Set(['session_id', 'transcript_path', 'cwd', 'permission_mode', 'hook_event_name']);
function report(id) {
  const s = JSON.parse(readFileSync(join(SP, `snap-${id}.json`), 'utf8'));
  const files = FILES();
  console.log(`\n##### since snapshot ${id} (${new Date(Number(id)).toISOString()})`);
  console.log('--- host log'); process.stdout.write(since(files.host, s.host ?? 0) || '(nothing)\n');
  console.log('--- floor (my desk, on change)'); process.stdout.write(since(files.floor, s.floor ?? 0) || '(nothing)\n');
  console.log('--- hooks (probe settings)');
  for (const line of since(files.hooks, s.hooks ?? 0).split('\n')) { if (!line.trim()) continue; const sp = line.indexOf(' '); let j; try { j = JSON.parse(line.slice(sp + 1)); } catch { console.log(line.slice(0, 200)); continue; }
    const extra = Object.entries(j).filter(([k]) => !COMMON.has(k)).map(([k, v]) => `${k}=${clip(typeof v === 'string' ? v : JSON.stringify(v), 160)}`).join('  ');
    console.log(`${line.slice(0, sp)} ${j.hook_event_name}  ${extra}`); }
  console.log('--- transcript records');
  for (const [k, f] of Object.entries(files)) { if (!k.startsWith('T:')) continue; const from = s[k] ?? 0; const txt = since(f, from); if (!txt) continue;
    console.log(`  [${k}] ${from === 0 && !(k in s) ? 'NEW FILE' : `+${Buffer.byteLength(txt)} bytes`}`);
    for (const line of txt.split('\n')) { if (!line.trim()) continue; let d; try { d = JSON.parse(line); } catch { console.log('   (partial line)'); continue; }
      const flags = ['isMeta', 'isCompactSummary', 'isSidechain', 'isVisibleInTranscriptOnly'].filter((x) => d[x]).join(',');
      const body = d.type === 'user' || d.type === 'assistant' ? textOf(d.message?.content) : d.type === 'system' ? `${d.subtype ?? ''} ${d.level ?? ''} ${clip(d.content ?? '', 80)} ${d.compactMetadata ? 'compact=' + JSON.stringify(d.compactMetadata) : ''}` : d.type === 'queue-operation' ? `${d.operation} ${clip(d.content ?? '', 60)}` : d.type === 'attachment' ? `${d.attachment?.type} ${clip(textOf(d.attachment?.prompt ?? d.attachment?.content), 60)}` : clip(JSON.stringify(d), 120);
      const model = d.type === 'assistant' ? ` model=${d.message?.model}` : '';
      const len = d.type === 'user' ? ` len=${textOf(d.message?.content).length}` : '';
      console.log(`   ${d.timestamp ?? '-'} ${String(d.type).padEnd(15)} ${flags.padEnd(16)}${model}${len} ${clip(body, 130)}`); } }
  console.log('--- pane frames (time | footer | composer rows)');
  const frames = since(files.pane, s.pane ?? 0).split(/^=== /m).filter(Boolean);
  for (const fr of frames) { const nl = fr.indexOf(' ===\n'); const ts = fr.slice(0, nl); const lines = fr.slice(nl + 5).split('\n').map((l) => l.trimEnd()); const nonEmpty = lines.filter((l) => l.trim()); const foot = nonEmpty[nonEmpty.length - 1] ?? ''; const comp = lines.filter((l) => /^\s*❯/.test(l)).map((l) => clip(l, 70)).join(' // ');
    console.log(`   ${ts} | ${clip(foot, 95)} | ${comp}`); }
}
async function send(text, wait) {
  const id = snap();
  const t0 = Date.now();
  const r = await fetch(`http://localhost:${process.env.BOARD ?? 8787}/api/floor/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: process.env.CHANNEL ?? 'coord-probe', agent: process.env.AGENT ?? 'probe', text }) });
  console.log(`POST /api/floor/chat at ${new Date(t0).toISOString()} -> ${r.status} ${await r.text()}  text=${JSON.stringify(clip(text, 80))} (${text.length} chars, ${text.split('\n').length} lines)`);
  await sleep(wait * 1000);
  report(id);
}
const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'snap') console.log(snap());
else if (cmd === 'send') await send(a, Number(b ?? 25));
else if (cmd === 'report') report(a);
else if (cmd === 'tail') report(readFileSync(join(SP, 'snap-last'), 'utf8').trim());
else console.log('usage');

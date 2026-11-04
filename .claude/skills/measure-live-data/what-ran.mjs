#!/usr/bin/env node
/**
 * What ran on this machine in a window of time, from every Claude Code
 * transcript on it: each Bash command any session ran, with its time and
 * project (task 262, issue #5). This is how the awake bursts were tied to the
 * site-syncinator e2e matrix: a run that started at 17:46:19Z, and a QA
 * session's `scripts/up.js` and `npx playwright` at 17:46–17:47Z.
 *
 *   node what-ran.mjs <from ISO> <to ISO> [--grep <regex>] [--project <substring>] [--results]
 *
 * --grep keeps only commands matching it, for example
 * 'e2e|playwright|scripts/up\.js|npm (run )?test|docker'.
 * --results also prints tool results that match the same pattern (a status
 * line from a test run, `docker ps` output).
 *
 * Read before believing an overlap: a pattern for "Docker-heavy" will also
 * catch this repo's own `docker compose up -d --build` deploys, and a window
 * days wide overlaps everything. Ask what ran in the minute the burst
 * started, not over its bounds. Read-only; it never writes to a transcript.
 */
import { readdirSync, statSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import readline from 'node:readline';

const args = process.argv.slice(2);
const [fromIso, toIso] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--grep', '--project'].includes(args[i - 1])));
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
if (!fromIso || !toIso) { console.error('usage: what-ran.mjs <from ISO> <to ISO> [--grep re] [--project substr] [--results]'); process.exit(2); }
const from = Date.parse(fromIso), to = Date.parse(toIso);
const grep = opt('--grep') ? new RegExp(opt('--grep')) : null;
const project = opt('--project');
const results = args.includes('--results');
const P = join(homedir(), '.claude/projects');
const out = [];
for (const dir of readdirSync(P)) {
  if (project && !dir.includes(project)) continue;
  let names = []; try { names = readdirSync(join(P, dir)); } catch { continue; }
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue;
    const f = join(P, dir, n);
    if (statSync(f).mtimeMs < from) continue;
    for await (const line of readline.createInterface({ input: createReadStream(f) })) {
      if (!line.includes('"tool_use"') && !(results && line.includes('"tool_result"'))) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      const at = Date.parse(d.timestamp ?? '');
      if (!(at >= from && at <= to)) continue;
      const where = dir.replace(/^-Users-[^-]+-/, '').slice(0, 48);
      for (const b of Array.isArray(d.message?.content) ? d.message.content : []) {
        if (b.type === 'tool_use' && b.name === 'Bash') {
          const cmd = String(b.input?.command ?? '').replace(/\s+/g, ' ');
          if (!grep || grep.test(cmd)) out.push(`${new Date(at).toISOString()} ${where}  $ ${cmd.slice(0, 180)}`);
        }
        if (results && b.type === 'tool_result') {
          const c = (Array.isArray(b.content) ? b.content.map((x) => x.text ?? '').join(' ') : String(b.content ?? '')).replace(/\s+/g, ' ');
          if (grep && grep.test(c)) out.push(`${new Date(at).toISOString()} ${where}    → ${c.slice(0, 200)}`);
        }
      }
    }
  }
}
out.sort();
console.log(out.join('\n') || '(nothing in the window)');

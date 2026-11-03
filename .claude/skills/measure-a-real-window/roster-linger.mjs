#!/usr/bin/env node
/**
 * How long a real Claude Code stays in the roster after `tmux kill-window`
 * on its window — the gap a reopen of the same conversation races (issue
 * #24). Written for task 253 (2026-11-03, 2.1.300); re-run it on a new
 * Claude Code before trusting the figures in CLAUDE.md "Moving a desk".
 *
 *   node .claude/skills/measure-a-real-window/roster-linger.mjs <folder> [runs] [transcript-to-resume-a-copy-of]
 *
 * Strip the CLAUDE* environment first (see SKILL.md, "The probe inherits
 * your environment"). Its own tmux socket (-L linger), a session that
 * outlives each window the way `orch` does on the host, windows opened the
 * way host/window.js open() opens them (`exec env … claude [--resume id]`),
 * the trust question answered for the folder. Each run: kill the window and
 * sample every 5 ms until its pid has been gone 3 s — the session file
 * (F), signal 0 on the pid (P), and any OTHER session file naming this
 * conversation or folder. readSessionFiles() needs both F and P, so the
 * window has left the roster at the first sample that is not `FP`.
 *
 * With a transcript, each run resumes a fresh copy of it (its session id
 * rewritten) so the window has a real conversation's weight behind it. The
 * copies are written under ~/.claude/projects/<folder's slug>/ and are a
 * copy of somebody's conversation: delete that directory when done.
 *
 *   {"run":1,"shape":"resumed","pid":72316,"killReturnedMs":12,"changes":"12:FP 18:-P 527:--"}
 *     → kill-window returned at 12 ms, the file went at 18 ms (out of the
 *       roster), the pid at 527 ms.
 *
 * Measured with it: 19 kills, fresh / after a turn / resumed / resumed on a
 * 4.5 MB transcript / with a background shell running — the file went 4–14
 * ms after kill-window returned, the pid 0.5–0.8 s after, and no other
 * process wrote a session file for that conversation or folder.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const ARG = process.argv[2];
if (!ARG) { console.error('usage: roster-linger.mjs <folder> [runs] [transcript]'); process.exit(2); }
mkdirSync(ARG, { recursive: true });
const DIR = realpathSync(ARG);
const RUNS = Number(process.argv[3] ?? 3);
const SRC = process.argv[4] ?? null;
const SOCK = 'linger';
const SESS = join(homedir(), '.claude', 'sessions');
const PROJ = join(homedir(), '.claude', 'projects', DIR.replace(/[/.]/g, '-'));

const tmux = (...a) => execFileSync('tmux', ['-L', SOCK, ...a], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const fileOf = (pid) => join(SESS, `${pid}.json`);
const entryOf = (pid) => { try { return JSON.parse(readFileSync(fileOf(pid), 'utf8')); } catch { return null; } };
const cap = (t) => { try { return tmux('capture-pane', '-p', '-t', t); } catch { return ''; } };

async function openWindow(name, resume) {
  const cmd = ['env', 'CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1', 'claude', ...(resume ? ['--resume', resume] : [])].map((a) => `'${a}'`).join(' ');
  const [target, pidText] = tmux('new-window', '-d', '-P', '-F', '#{session_name}:#{window_id}.#{pane_id}|#{pane_pid}', '-t', 'p:', '-n', name, '-c', DIR, `exec ${cmd}`).split('|');
  const pid = Number(pidText);
  const t0 = Date.now();
  while (!(existsSync(fileOf(pid)) && alive(pid))) {
    // The trust question, once per folder: the cursor starts on "No, exit".
    if (/Yes, I trust this folder/.test(cap(target))) { tmux('send-keys', '-t', target, 'Down'); await sleep(400); tmux('send-keys', '-t', target, 'Enter'); await sleep(800); }
    if (Date.now() - t0 > 60000) throw new Error(`no roster entry for ${pid}; the pane reads:\n${cap(target)}`);
    await sleep(200);
  }
  return { target, pid };
}

async function killAndTime(target, pid) {
  const sid = entryOf(pid)?.sessionId;
  const t0 = process.hrtime.bigint();
  const ms = () => Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  tmux('kill-window', '-t', target);
  const killReturnedMs = ms();
  const changes = []; const others = new Set();
  let last = null, pidGoneAt = null;
  for (;;) {
    for (const n of readdirSync(SESS)) {
      if (!/^\d+\.json$/.test(n) || n === `${pid}.json`) continue;
      let d; try { d = JSON.parse(readFileSync(join(SESS, n), 'utf8')); } catch { continue; }
      if (d.sessionId === sid || d.cwd === DIR) {
        const k = `${n}:${d.kind}:${String(d.sessionId).slice(0, 8)}`;
        if (!others.has(k)) { others.add(k); changes.push(`${ms()}:OTHER ${k}`); }
      }
    }
    const st = `${existsSync(fileOf(pid)) ? 'F' : '-'}${alive(pid) ? 'P' : '-'}`;
    if (st !== last) { changes.push(`${ms()}:${st}`); last = st; }
    if (st[1] === '-' && pidGoneAt === null) pidGoneAt = ms();
    if ((pidGoneAt !== null && ms() - pidGoneAt > 3000) || ms() > 30000) break;
    await sleep(5);
  }
  return { killReturnedMs, changes: changes.join(' ') };
}

tmux('new-session', '-d', '-s', 'p', '-n', 'keep', '-x', '200', '-y', '50', 'sleep 3600');
try {
  for (let i = 1; i <= RUNS; i++) {
    let sid = null;
    if (SRC) {
      mkdirSync(PROJ, { recursive: true });
      sid = randomUUID();
      const old = SRC.split('/').pop().replace('.jsonl', '');
      writeFileSync(join(PROJ, `${sid}.jsonl`), readFileSync(SRC, 'utf8').split(old).join(sid));
    }
    const w = await openWindow(`run-${i}`, sid);
    await sleep(4000);
    console.log(JSON.stringify({ run: i, shape: SRC ? 'resumed' : 'fresh', pid: w.pid, ...(await killAndTime(w.target, w.pid)) }));
    await sleep(1500);
  }
} finally {
  try { tmux('kill-server'); } catch { /* gone */ }
  if (SRC) console.error(`copies of ${SRC} are in ${PROJ} — delete it when done`);
}

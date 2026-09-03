#!/usr/bin/env node
/**
 * A throwaway real Claude Code, on a socket of its own, for settling claims
 * about how Claude Code behaves. See SKILL.md — especially the part about the
 * shape of the task deciding the answer.
 *
 *   probe.mjs up       <dir> [auto|manual|plan|accept]
 *   probe.mjs say      <dir> <text>          paste + Enter, and say what happened
 *   probe.mjs watch    <dir> [seconds]       footer + busy, once a second
 *   probe.mjs pane     <dir> [lines]
 *   probe.mjs timeline <dir> [grep]          every transcript record, in order
 *   probe.mjs down
 *
 * Never touches the operator's `orch` session: -L probe is a different server.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const run = promisify(execFile);
const SOCK = process.env.PROBE_SOCKET ?? 'probe';
const TARGET = 'p:probe';

const tmux = async (args) => {
  try {
    const { stdout } = await run('tmux', ['-L', SOCK, ...args], { encoding: 'utf8', maxBuffer: 1 << 24 });
    return { ok: true, out: stdout };
  } catch (e) { return { ok: false, out: '', error: (e.stderr || e.message || '').trim() }; }
};
const pane = async (lines = 40) => (await tmux(['capture-pane', '-p', '-t', TARGET, '-S', `-${lines}`])).out;
/* The status line, positionally. Not a grep of the capture: -S -N includes the
   whole visible pane, so the conversation is in scope and a window discussing
   "esc to interrupt" would read as busy for ever. */
const footer = async () => ((await tmux(['capture-pane', '-p', '-t', TARGET])).out
  .split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).pop() ?? '').trim();
const busy = async () => /esc to interrupt/i.test(await footer());

/** Claude Code's own directory for a cwd: every / and . becomes a dash. */
const projectDir = (dir) => join(homedir(), '.claude', 'projects', resolve(dir).replace(/[/.]/g, '-'));
function transcript(dir) {
  const d = projectDir(dir);
  if (!existsSync(d)) return null;
  const f = readdirSync(d).filter((x) => x.endsWith('.jsonl'))
    .map((x) => ({ x, m: statSync(join(d, x)).mtimeMs })).sort((a, b) => b.m - a.m)[0];
  return f ? join(d, f.x) : null;
}

const MODES = { auto: 'auto mode on', manual: 'manual mode on', plan: 'plan mode on', accept: 'accept edits on' };

async function up(dir, mode = 'auto') {
  mkdirSync(dir, { recursive: true });
  await tmux(['kill-server']);
  // -x/-y because a detached session defaults to 80 columns, and pane width
  // changes what parses: a footer that fits at 160 wraps at 80.
  const made = await tmux(['new-session', '-d', '-s', 'p', '-n', 'probe', '-c', dir, '-x', '200', '-y', '50', 'exec claude']);
  if (!made.ok) { console.error('could not start:', made.error); process.exit(1); }

  // The two startup dialogs. Neither is auto-answered anywhere in this repo —
  // ANSWERS in host/window.js is deliberately one question long.
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const s = await pane(30);
    // The trust dialog is an arrow list with the cursor on "No, exit" (2.1.258,
    // measured 2026-09-03): a digit does nothing there and Enter alone quits,
    // so "1 then Enter" exited rc=1 every time and the server went with it.
    // Down onto "Yes, I trust this folder", then Enter.
    if (/Is this a project you created or one you trust/i.test(s)) {
      await tmux(['send-keys', '-t', TARGET, 'Down']);
      await sleep(400);
      await tmux(['send-keys', '-t', TARGET, 'Enter']);
      await sleep(1500);
      continue;
    }
    if (/New MCP server found/i.test(s)) {
      await tmux(['send-keys', '-t', TARGET, '1']);
      await sleep(600);
      await tmux(['send-keys', '-t', TARGET, 'Enter']);
      continue;
    }
    if (/shift\+tab to cycle|for shortcuts/i.test(await footer())) break;
  }

  const want = MODES[mode];
  if (!want) { console.error(`unknown mode ${mode} — one of ${Object.keys(MODES).join(', ')}`); process.exit(1); }
  // Loop on the footer rather than counting presses: BTab cycles, and how many
  // presses you need depends on where it started.
  for (let i = 0; i < 6 && !(await footer()).includes(want); i++) {
    await tmux(['send-keys', '-t', TARGET, 'BTab']);
    await sleep(900);
  }
  console.log(`up on tmux -L ${SOCK} (${TARGET}) in ${dir}`);
  console.log(`  footer: ${await footer()}`);
  console.log(`  transcript: ${transcript(dir) ?? '(none yet — send it something)'}`);
}

async function say(dir, text) {
  const before = (() => { const t = transcript(dir); return t ? statSync(t).size : 0; })();
  const wasBusy = await busy();
  await tmux(['set-buffer', '-b', 'probe', '--', text]);
  await tmux(['paste-buffer', '-p', '-d', '-b', 'probe', '-t', TARGET]);
  await sleep(1200);
  const t0 = Date.now();
  await tmux(['send-keys', '-t', TARGET, 'Enter']);
  console.log(`sent (window was ${wasBusy ? 'BUSY' : 'idle'})`);

  // What the transcript says became of it, which is the honest receipt — the
  // pane only shows what a person would see.
  //
  // Resolved inside the loop, not before it: the very first message to a fresh
  // window is what creates the file, so looking it up beforehand finds nothing
  // and reports every opening message as unconfirmed.
  // Wait for a terminal receipt, then report the whole set once.
  //
  // Printing from inside the poll is what this used to do, and it both repeated
  // records and dropped them: a record already present on the first read raced
  // with the `return` on the terminal one, so an enqueue that was plainly in the
  // file went unmentioned. Deciding when to stop and saying what happened are
  // two jobs; only the first one needs a loop.
  const mine = (path) => records(path, before).filter((r) => (r.text ?? '').includes(text.slice(0, 40)));
  // A turn (the window was idle), or an injection (it was working). An enqueue
  // on its own is neither — the message may still be sitting in the queue.
  const terminal = (r) => r.type === 'user' || r.type === 'attachment';

  for (let i = 0; i < 60; i++) {
    await sleep(400);
    const path = transcript(dir);
    if (!path) continue;
    const found = mine(path);
    if (!found.some(terminal) && i < 59) continue;
    const took = ((Date.now() - t0) / 1000).toFixed(2);
    for (const r of found) {
      const what = r.type === 'queue-operation' ? `queue:${r.operation}`
        : r.type === 'attachment' ? 'queued_command' : r.type;
      console.log(`  ${what.padEnd(16)} ${r.ts}`);
    }
    console.log(`  → ${found.some((r) => r.type === 'attachment') ? 'queued and read mid-turn' : 'recorded as a turn'} within ${took}s`);
    return;
  }
  console.log('  nothing in the transcript named it within 24s');
  console.log('  nothing in the transcript named it within 24s');
}

/**
 * Every record, with its text pulled out of whichever field holds it.
 *
 * `from` is a byte offset, so the slice is taken on a Buffer. Doing it on the
 * decoded string — which this did — over-skips by one position per multi-byte
 * character already read, and a transcript is full of them (—, …, ✓). The
 * symptom was subtle and pointed the wrong way: the *first* record after the
 * offset went missing, so a queued message appeared to have no `enqueue`.
 * `readTranscript` in host/window.js gets this right; copy it, do not reinvent.
 */
function records(path, from = 0) {
  const out = [];
  const buf = readFileSync(path);
  for (const line of buf.subarray(from).toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const c = j.message?.content;
    const text = typeof c === 'string' ? c
      : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join(' ')
      : (j.content ?? j.attachment?.prompt ?? '');
    const tools = Array.isArray(c) ? c.filter((x) => x.type === 'tool_use').map((x) => x.name) : [];
    out.push({ type: j.type, operation: j.operation, kind: j.attachment?.type, ts: j.timestamp, text: String(text ?? ''), tools });
  }
  return out;
}

async function main() {
  const [cmd, dir, arg] = process.argv.slice(2);
  if (cmd === 'down') { await tmux(['kill-server']); return console.log(`tmux -L ${SOCK} killed`); }
  if (!dir && cmd !== 'down') { console.error('need a directory'); process.exit(1); }

  if (cmd === 'up') return up(dir, arg ?? 'auto');
  if (cmd === 'say') return say(dir, arg ?? '');
  if (cmd === 'pane') return console.log(await pane(Number(arg) || 40));
  if (cmd === 'watch') {
    for (let i = 0; i < (Number(arg) || 30); i++) {
      console.log(`${new Date().toTimeString().slice(0, 8)} busy=${await busy()}  ${await footer()}`);
      await sleep(1000);
    }
    return undefined;
  }
  if (cmd === 'timeline') {
    const path = transcript(dir);
    if (!path) { console.error('no transcript for', dir); process.exit(1); }
    console.log(path);
    for (const r of records(path)) {
      if (arg && !JSON.stringify(r).includes(arg)) continue;
      const what = [r.type, r.operation ?? r.kind ?? ''].filter(Boolean).join(':');
      const body = r.tools.length ? `tools=${r.tools.join(',')}` : JSON.stringify(r.text.replace(/\s+/g, ' ').slice(0, 70));
      console.log(`${String(r.ts ?? '').padEnd(26)} ${what.padEnd(28)} ${body}`);
    }
    return undefined;
  }
  console.error('usage: probe.mjs up|say|watch|pane|timeline|down — see SKILL.md');
  process.exit(1);
}

main();

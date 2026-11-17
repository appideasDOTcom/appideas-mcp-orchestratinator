#!/usr/bin/env node
/**
 * Does a long message reach a real Claude Code as the operator's own words?
 *
 *   typing.mjs <probe dir> [--size 80x24] [--suggest] [--window <window.js>] [--text-file <f>]
 *
 * Sends one message through the host's own send() (the tree's
 * host/window.js, or the one --window names) into the probe window that
 * probe.mjs `up` made, then reads the user record the window wrote and says
 * WRAPPED (<pasted_content>, the agent is told it may not be the operator's)
 * or unwrapped, and whether it is exactly the message. Exit 0 for unwrapped
 * and exact, 1 otherwise.
 *
 * Built after issue #31 (2026-11-17), whose two typing bugs were each found
 * this way and nowhere else (CLAUDE.md, "Driving a window"):
 *
 *   --suggest   first raise one of Claude Code's prompt suggestions (the dim
 *               line in an empty composer after a turn): it sends short
 *               no-tool turns until the composer row holds text nobody
 *               typed, up to 12. The composer row is read at the BOTTOM of
 *               the pane only. A grep for "❯" anywhere matched an earlier
 *               user line echoed in the transcript and read it as a
 *               suggestion.
 *   --size      resize the probe's window first. The host opens windows at
 *               80x24 when nobody is attached; probe.mjs makes 200x50, where
 *               a five-line message never scrolls the composer.
 *
 * The default message is the one that failed live: words, a blank line and
 * two attachment paths under the header, the last one an image.
 *
 * Use auto mode for the probe (probe.mjs up <dir> auto). In manual mode the
 * agent asks permission for the `ls` it likes to run on a path, the window
 * stands at that question, and send() answers `asking`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const dir = args[0];
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? (args[i + 1] ?? true) : null; };
if (!dir) { console.error('usage: typing.mjs <probe dir> [--size 80x24] [--suggest] [--window <window.js>] [--text-file <f>]'); process.exit(2); }
const SOCK = process.env.PROBE_SOCKET ?? 'probe';
const TARGET = 'p:probe';
const run = promisify(execFile);
const tmux = (a) => run('tmux', ['-L', SOCK, ...a], { encoding: 'utf8' }).then((r) => r.stdout, () => '');

// The host has no -L of its own: ORCH_TMUX names a tmux that talks to the
// probe's socket, and ORCH_TMUX_SESSION its session (send.mjs, beside this).
if (!process.env.ORCH_TMUX) { console.error('set ORCH_TMUX to a wrapper that runs `tmux -L probe "$@"`, and ORCH_TMUX_SESSION=p (see send.mjs)'); process.exit(2); }
const W = await import(opt('window') ? resolve(opt('window')) : `${REPO}/host/window.js`);
const U = await import(`${REPO}/host/uploads.js`);

const text = opt('text-file') ? readFileSync(opt('text-file'), 'utf8').replace(/\n+$/, '')
  : U.withAttachments('Here are the files one more time. Does everything look correct, and are you able to read and understand the files? Answer in one line.', [
    `${homedir()}/.orchestratinator/uploads/159205afe5520f41b66cdd7b/Custom PCBs on a CNC Router _ 10 Steps (with Pictures) - Instructables.pdf`,
    `${homedir()}/.orchestratinator/uploads/74e8831c119c531b140d8b93/Screenshot 2026-11-05 at 10.10.25.png`,
  ]);

if (opt('size')) {
  const [x, y] = String(opt('size')).split('x');
  await tmux(['resize-window', '-t', TARGET, '-x', x, '-y', y]);
  await sleep(800);
}
console.log(`pane ${(await tmux(['display', '-p', '-t', TARGET, '#{window_width}x#{window_height}'])).trim()}`);

/** What the composer row at the bottom of the pane holds, nothing above it. */
const composerRow = async () => {
  const rows = (await tmux(['capture-pane', '-p', '-t', TARGET])).split('\n').filter((l) => l.trim());
  const row = rows.slice(-4).find((l) => /^❯/.test(l));
  return row ? row.replace(/^❯\s*/, '').trim() : null;
};
if (opt('suggest')) {
  let got = '';
  for (let i = 0; i < 12 && !got; i++) {
    await W.send(dir, 'Name one fruit, then suggest a follow-up question I could ask you about it. No tools.');
    for (let t = 0; t < 30 && !got; t++) { await sleep(1000); const r = await composerRow(); if (r && !/esc to interrupt/.test(r)) got = r; }
  }
  console.log(got ? `suggestion in the composer: "${got}"` : 'no suggestion appeared in 12 turns (they come in about half of them); sending anyway');
}

const projects = join(process.env.ORCH_CLAUDE_HOME ?? join(homedir(), '.claude'), 'projects', resolve(dir).replace(/[/.]/g, '-'));
const t0 = Date.now();
const r = await W.send(dir, text);
const ms = Date.now() - t0;
const f = readdirSync(projects).filter((x) => x.endsWith('.jsonl')).map((x) => join(projects, x)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
const last = readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((x) => x.type === 'user' && typeof x.message?.content === 'string').at(-1)?.message.content ?? '';
const wrapped = /<pasted_content/.test(last);
const exact = last === text;
console.log(`send: ${JSON.stringify({ ok: r.ok, code: r.code ?? null, error: r.error ?? null })} in ${ms} ms`);
console.log(`recorded: ${wrapped ? 'WRAPPED in <pasted_content>' : exact ? 'unwrapped, exactly the message' : 'unwrapped, but NOT exactly the message: text left in the composer is typed after (a draft), or a line went missing'}`);
process.exit(!wrapped && exact ? 0 : 1);

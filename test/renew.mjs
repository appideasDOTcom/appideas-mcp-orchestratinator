// A tmux server that can no longer read a desk's folder, and the host moving
// every window to a fresh one — see "a tmux server that can no longer read a
// desk's folder" in host/window.js (2026-11-10).
//
// The real failure cannot be made on demand: it was one long-lived server
// carrying a refusal macOS no longer gave a fresh one, and chmod refuses every
// server alike. So the suite runs real tmux on a socket of its own, through a
// wrapper (ORCH_TMUX) that refuses `run-shell` reads of one flagged folder on
// that server only. The host's fresh-server check uses a private `-L` socket
// and goes to real tmux, which reads it, as a fresh server did on the day.
// The refusal both ways ("nothing can read it") is real: a mode-000 folder.
//
// Its own socket also keeps it off the default one, where the live `orch`
// session is, and where a kill-server would be anything but a test.

import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const FIX = resolve(`./data/renew-fixture-${process.pid}`);
const SOCK = `orch-renew-test-${process.pid}`;
const FLAG = `${FIX}/refuse.txt`;
const CLAUDE_HOME = `${FIX}/claude`;

process.env.ORCH_TMUX = `${FIX}/tmux.sh`;
process.env.ORCH_TMUX_SESSION = 'orch';
process.env.ORCH_HOST_CLAUDE = `${FIX}/stand-in.sh`;
process.env.ORCH_CLAUDE_HOME = CLAUDE_HOME;
process.env.ORCH_RENEW_WAIT_MS = '20000';
process.env.ORCH_LAND_TIMEOUT_MS = '2000';
delete process.env.ORCH_HOST_MODEL;

let failed = 0;
const ok = (cond, name, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${!cond && detail ? ` — ${detail}` : ''}`);
  if (!cond) failed++;
};

async function until(fn, ms = 8000) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
}

const tmuxT = (args) => run('tmux', ['-L', SOCK, ...args]).then((r) => r.stdout.trim(), () => '');
const panesNow = async () => Object.fromEntries((await tmuxT(['list-panes', '-a', '-F', '#{pane_current_path}\t#{pane_pid}']))
  .split('\n').filter(Boolean).map((l) => l.split('\t')));

function setup() {
  rmSync(FIX, { recursive: true, force: true });
  mkdirSync(`${CLAUDE_HOME}/sessions`, { recursive: true });
  writeFileSync(`${FIX}/tmux.sh`,
    `#!/bin/sh\n` +
    // A private socket of the host's own (the fresh-server check): real tmux.
    `for a in "$@"; do [ "$a" = "-L" ] && exec tmux "$@"; done\n` +
    // The suite's server refuses the flagged folder, and only to run-shell:
    // the windows themselves are stand-ins with nothing to refuse.
    `if [ "$1" = "run-shell" ] && [ -s ${JSON.stringify(FLAG)} ]; then case "$*" in *"$(cat ${JSON.stringify(FLAG)})"*) exit 1;; esac; fi\n` +
    `exec tmux -L ${SOCK} "$@"\n`);
  chmodSync(`${FIX}/tmux.sh`, 0o755);
  // Registers the conversation it resumes, as Claude Code does (readiness and
  // the move both read the roster), records its argv, and draws a status
  // line: busy while ./busy exists, a composer otherwise. Whatever is typed
  // goes to ./received.txt.
  writeFileSync(`${FIX}/stand-in.sh`,
    `#!/bin/sh\n` +
    `printf '%s\\n' "$@" >> "$PWD/argv.txt"\n` +
    `if [ "$1" = "--resume" ]; then printf '{"pid":%s,"sessionId":"%s","cwd":"%s","kind":"interactive","startedAt":%s}' "$$" "$2" "$PWD" "$(date +%s)000" > ${JSON.stringify(`${CLAUDE_HOME}/sessions`)}/$$.json; fi\n` +
    `( while :; do printf '\\033[H\\033[2J'; if [ -f "$PWD/busy" ]; then echo '✻ Working… (esc to interrupt)'; else echo '❯ '; fi; sleep 0.3; done ) &\n` +
    `exec cat >> "$PWD/received.txt"\n`);
  chmodSync(`${FIX}/stand-in.sh`, 0o755);
  for (const d of ['a', 'b', 'locked']) mkdirSync(`${FIX}/${d}`, { recursive: true });
}

async function main() {
  setup();
  const W = await import('../host/window.js');
  const A = W.canonical(`${FIX}/a`);
  const B = W.canonical(`${FIX}/b`);
  const told = [];
  W.onServerRenewed((r) => told.push(r));
  // A conversation with a spoken turn on disk, or resumable() rightly opens a
  // new one instead and nothing here would be resumed.
  for (const [dir, id] of [[A, 'sess-a'], [B, 'sess-b']]) {
    const t = W.transcriptPath(dir, id);
    mkdirSync(resolve(t, '..'), { recursive: true });
    const at = new Date().toISOString();
    writeFileSync(t, [
      { type: 'user', sessionId: id, uuid: `${id}-u`, timestamp: at, message: { role: 'user', content: 'hello' } },
      { type: 'assistant', sessionId: id, uuid: `${id}-a`, timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  }

  console.log('\n# a server that reads every folder is left alone');
  let r = await W.open(A, { resume: 'sess-a' });
  await W.waitReady(A, { pid: r.pid, target: r.target, timeoutMs: 8000 });
  r = await W.open(B, { resume: 'sess-b' });
  await W.waitReady(B, { pid: r.pid, target: r.target, timeoutMs: 8000 });
  const first = await panesNow();
  ok(first[A] && first[B], 'two windows are open', JSON.stringify(first));
  ok((await W.checkServer()) === null, 'checkServer finds nothing to do');
  ok(JSON.stringify(await panesNow()) === JSON.stringify(first), 'and the windows are the same processes');

  console.log('\n# one folder refused: every window moves, after the working one finishes its turn');
  writeFileSync(`${B}/busy`, '');
  await until(async () => (await tmuxT(['capture-pane', '-p', '-t', 'orch:'])).length >= 0, 500);
  writeFileSync(FLAG, A);
  const moving = W.checkServer();
  await sleep(2000);
  ok(JSON.stringify(await panesNow()) === JSON.stringify(first), 'nothing is killed while a window is mid-turn');
  rmSync(`${B}/busy`);
  const done = await moving;
  writeFileSync(FLAG, '');
  ok(done?.ok === true && done.refused === A, 'the move names the refused folder', JSON.stringify(done));
  const second = await panesNow();
  ok(second[A] && second[A] !== first[A], 'the refused desk is in a new process', `${first[A]} → ${second[A]}`);
  ok(second[B] && second[B] !== first[B], 'and so is the other desk', `${first[B]} → ${second[B]}`);
  const argv = (d) => readFileSync(`${d}/argv.txt`, 'utf8').trim().split('\n');
  ok(argv(A).slice(-2).join(' ') === '--resume sess-a', 'each resumes its own conversation (a)', argv(A).join(' '));
  ok(argv(B).slice(-2).join(' ') === '--resume sess-b', 'each resumes its own conversation (b)', argv(B).join(' '));
  ok(await until(() => existsSync(`${A}/received.txt`) && /readable again/.test(readFileSync(`${A}/received.txt`, 'utf8'))),
    'the agent that met the refusal is told it can carry on');
  ok(!existsSync(`${B}/received.txt`) || !/moved to a fresh/.test(readFileSync(`${B}/received.txt`, 'utf8')),
    'an agent that finished its turn untouched is not typed to');
  ok(told.length === 1 && told[0].moved.length === 2 && told[0].moved.every((m) => m.ok), 'the desks are told, once each', JSON.stringify(told));

  console.log('\n# an open of a refused folder moves the server first, then opens there');
  await tmuxT(['kill-window', '-t', `orch:${(await tmuxT(['list-panes', '-a', '-F', '#{pane_current_path} #{window_id}'])).split('\n').find((l) => l.startsWith(B))?.split(' ').pop()}`]);
  writeFileSync(FLAG, B);
  const before = await panesNow();
  r = await W.open(B, { resume: 'sess-b' });
  writeFileSync(FLAG, '');
  if (r.ok && r.created) await W.waitReady(B, { pid: r.pid, target: r.target, timeoutMs: 8000 });
  const third = await panesNow();
  ok(r.ok, 'the open succeeds', JSON.stringify(r));
  ok(third[B] && third[A] && third[A] !== before[A], 'in a fresh server, the other desk moved with it', JSON.stringify({ before, third }));
  ok(argv(B).slice(-2).join(' ') === '--resume sess-b', 'on its own conversation', argv(B).join(' '));

  console.log('\n# a server that also runs somebody else\'s session is not killed');
  await tmuxT(['new-session', '-d', '-s', 'mine', 'sleep 300']);
  writeFileSync(FLAG, A);
  const kept = await panesNow();
  const refusedMove = await W.checkServer();
  writeFileSync(FLAG, '');
  ok(refusedMove?.ok === false && /mine/.test(refusedMove.error), 'the move is refused, naming the other session', JSON.stringify(refusedMove));
  ok((await panesNow())[A] === kept[A], 'and the window is the same process');
  await tmuxT(['kill-session', '-t', 'mine']);

  console.log('\n# a folder nothing can read is said, not moved for');
  const L = W.canonical(`${FIX}/locked`);
  chmodSync(L, 0o000);
  const keptL = await panesNow();
  r = await W.open(L, {});
  chmodSync(L, 0o755);
  ok(r.ok === false && r.code === 'unreadable', 'open refuses with code unreadable', JSON.stringify(r));
  ok(JSON.stringify(await panesNow()) === JSON.stringify(keptL), 'and moves nothing');
}

try {
  await main();
} catch (err) {
  failed++;
  console.log(`FAIL threw: ${err.stack}`);
} finally {
  await run('tmux', ['-L', SOCK, 'kill-server']).catch(() => {});
  try { chmodSync(`${FIX}/locked`, 0o755); } catch {}
  rmSync(FIX, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);

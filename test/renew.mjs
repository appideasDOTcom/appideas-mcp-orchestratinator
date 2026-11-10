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
const SRV = `${FIX}/refuse-server.txt`;
const CLAUDE_HOME = `${FIX}/claude`;

process.env.ORCH_TMUX = `${FIX}/tmux.sh`;
process.env.ORCH_TMUX_SESSION = 'orch';
process.env.ORCH_HOST_CLAUDE = `${FIX}/stand-in.sh`;
process.env.ORCH_CLAUDE_HOME = CLAUDE_HOME;
// Long enough for §2's two-second hold, short enough that §3 waits it out.
process.env.ORCH_RENEW_WAIT_MS = '6000';
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
const inMode = async () => (await tmuxT(['list-panes', '-a', '-F', '#{pane_in_mode}'])).split('\n').includes('1');
const paneOf = async (dir) => (await tmuxT(['list-panes', '-a', '-F', '#{pane_current_path}\t#{pane_id}'])).split('\n')
  .map((l) => l.split('\t')).find(([d]) => d === dir)?.[1];
const readOr = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
/** Refuse `dir` on the server running now, or on every server (`sticky`). */
async function refuse(dir, { sticky = false } = {}) {
  writeFileSync(SRV, sticky ? '' : await tmuxT(['display', '-p', '#{pid}']));
  writeFileSync(FLAG, dir);
}
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
    // the windows themselves are stand-ins with nothing to refuse. The
    // refusal is the server's own, as on the day: it holds only while the
    // server whose pid is in ./refuse-server.txt is the one running, so the
    // server a move makes reads the folder. Left empty, every server refuses
    // it — the refusal a move does not clear (QA, PR #54 finding 2).
    `if [ "$1" = "run-shell" ] && [ -s ${JSON.stringify(FLAG)} ]; then case "$*" in *"$(cat ${JSON.stringify(FLAG)})"*) ` +
    `s=$(cat ${JSON.stringify(SRV)} 2>/dev/null); if [ -z "$s" ] || [ "$s" = "$(tmux -L ${SOCK} display -p '#{pid}' 2>/dev/null)" ]; then exit 1; fi;; esac; fi\n` +
    `exec tmux -L ${SOCK} "$@"\n`);
  chmodSync(`${FIX}/tmux.sh`, 0o755);
  // Registers the conversation it resumes, as Claude Code does (readiness and
  // the move both read the roster), records its argv, and draws a status
  // line: busy while ./busy exists, a permission menu while ./asking holds
  // its pid, a composer otherwise. ./busy holding a pid is busy for that
  // process only, so a window resumed after the move comes up idle, as a real
  // one does. Whatever is typed goes to ./received.txt.
  writeFileSync(`${FIX}/stand-in.sh`,
    `#!/bin/sh\n` +
    `printf '%s\\n' "$@" >> "$PWD/argv.txt"\n` +
    `if [ "$1" = "--resume" ]; then printf '{"pid":%s,"sessionId":"%s","cwd":"%s","kind":"interactive","startedAt":%s}' "$$" "$2" "$PWD" "$(date +%s)000" > ${JSON.stringify(`${CLAUDE_HOME}/sessions`)}/$$.json; fi\n` +
    // Drawn over the last frame, each line cleared to its end and the rest of
    // the screen after it, never by clearing first: a capture between a clear
    // and the line after it read a blank screen, which is "not working", and
    // a move waiting on B went ahead on it (QA's finding 3 was the same blank,
    // and the mutant that took the wait's limit away survived on it).
    `( while :; do b=$(cat "$PWD/busy" 2>/dev/null); q=$(cat "$PWD/asking" 2>/dev/null); printf '\\033[H'; ` +
    `if [ -f "$PWD/busy" ] && { [ -z "$b" ] || [ "$b" = "$$" ]; }; then printf '%s\\033[K\\n' '✻ Working… (esc to interrupt)'; ` +
    `elif [ "$q" = "$$" ]; then printf '%s\\033[K\\n' 'Do you want to proceed?' '❯ 1. Yes' '  2. No' '' 'Esc to cancel'; ` +
    `else printf '%s\\033[K\\n' '❯ '; fi; printf '\\033[J'; sleep 0.3; done ) &\n` +
    `exec cat >> "$PWD/received.txt"\n`);
  chmodSync(`${FIX}/stand-in.sh`, 0o755);
  for (const d of ['a', 'b', 'c', 'd', 'locked']) mkdirSync(`${FIX}/${d}`, { recursive: true });
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
  // On the busy line being drawn, not on a capture: the stand-in redraws every
  // 300 ms, and a move that reads B first finds nothing working and kills at
  // once (QA, PR #54 finding 3: the old wait was `.length >= 0`, red 5 of 5).
  ok(await until(async () => (await W.busyAt(B))?.busy === true, 5000), 'the working window shows it is working');
  await refuse(A);
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

  console.log('\n# a turn that outlasts the wait is cut off, an open question is closed, and each agent is told; a window with no conversation starts one');
  // QA, PR #54 Info 5 (the wait's limit, `interrupted` and `asking` had no
  // assertion) and Info 6 (a window with no conversation was closed and only
  // logged). B stays busy past ORCH_RENEW_WAIT_MS; A holds a permission menu.
  const C = W.canonical(`${FIX}/c`);
  r = await W.open(C, {});
  ok(r.ok && r.created, 'a window with no conversation is open', JSON.stringify(r));
  const pre = await panesNow();
  writeFileSync(`${B}/busy`, String(pre[B]));
  writeFileSync(`${A}/asking`, String(pre[A]));
  ok(await until(async () => (await W.busyAt(B))?.busy === true, 5000), 'B is working');
  ok(await until(async () => /Esc to cancel/.test(await tmuxT(['capture-pane', '-p', '-t', await paneOf(A)])), 5000), 'A is asking');
  // Timed on the kill, not on the move's return: a move here takes 25–40 s
  // after it (three reopens and two sends), which says nothing about the wait.
  await refuse(A);
  const t0 = Date.now();
  const moving3 = W.checkServer();
  let killedAt = null;
  await until(async () => ((await panesNow())[B] !== pre[B] ? (killedAt = Date.now() - t0, true) : false), 14_000);
  // Taken away either way: with the limit gone, the wait ends here instead of never.
  rmSync(`${B}/busy`, { force: true });
  rmSync(`${A}/asking`, { force: true });
  const cut = await Promise.race([moving3, sleep(120_000).then(() => 'did not return in 120 s')]);
  writeFileSync(FLAG, '');
  ok(killedAt !== null, 'the move goes ahead though a turn outlasts the wait', `B still ${pre[B]} after 14 s`);
  ok(killedAt === null || killedAt >= 5500, 'once the wait has run out', `${killedAt} ms`);
  ok(cut?.ok === true, 'and the move returns', typeof cut === 'string' ? cut : JSON.stringify(cut));
  const post = await panesNow();
  ok(post[A] !== pre[A] && post[B] !== pre[B], 'both conversations are in new processes', JSON.stringify({ pre, post }));
  ok(await until(() => /cut off by the move/.test(readOr(`${B}/received.txt`))), 'the agent whose turn was cut off is told so', readOr(`${B}/received.txt`));
  ok(await until(() => /ask it again/.test(readOr(`${A}/received.txt`))), 'the agent whose question was closed is told to ask it again', readOr(`${A}/received.txt`));
  ok(post[C] && post[C] !== pre[C], 'the window with no conversation is open again, in a new process', `${pre[C]} → ${post[C]}`);
  ok(!readFileSync(`${C}/argv.txt`, 'utf8').includes('--resume'), 'starting a conversation, not resuming one', readFileSync(`${C}/argv.txt`, 'utf8'));
  ok(readOr(`${C}/received.txt`) === '', 'and nothing is typed into it');
  const mc = cut?.moved?.find((m) => m.cwd === C);
  ok(mc?.ok === true && mc.sessionId === null && /starts one there/.test(W.renewNote(A, mc)), 'its desk is told it starts one', JSON.stringify(mc));
  await tmuxT(['kill-window', '-t', await paneOf(C)]);

  console.log('\n# an open of a refused folder moves the server first, then opens there');
  await tmuxT(['kill-window', '-t', `orch:${(await tmuxT(['list-panes', '-a', '-F', '#{pane_current_path} #{window_id}'])).split('\n').find((l) => l.startsWith(B))?.split(' ').pop()}`]);
  await refuse(B);
  const before = await panesNow();
  r = await W.open(B, { resume: 'sess-b' });
  writeFileSync(FLAG, '');
  if (r.ok && r.created) await W.waitReady(B, { pid: r.pid, target: r.target, timeoutMs: 8000 });
  const third = await panesNow();
  ok(r.ok, 'the open succeeds', JSON.stringify(r));
  ok(third[B] && third[A] && third[A] !== before[A], 'in a fresh server, the other desk moved with it', JSON.stringify({ before, third }));
  ok(argv(B).slice(-2).join(' ') === '--resume sess-b', 'on its own conversation', argv(B).join(' '));

  console.log('\n# a refusal the move does not clear is said on the desk, and not moved for again');
  // QA, PR #54 finding 2. The order matters: the window reopened first makes
  // the new server, so only a later one is checked against it.
  const sess = { [A]: 'sess-a', [B]: 'sess-b' };
  const [early, late] = (await W.panes()).map((p) => W.canonical(p.cwd)).filter((d) => d in sess);
  await refuse(late, { sticky: true });
  const lateMove = await Promise.race([W.checkServer(), sleep(120_000).then(() => 'did not return in 120 s')]);
  ok(lateMove?.ok === true, 'refused again on the new server when reopened second: the move returns', typeof lateMove === 'string' ? lateMove : JSON.stringify(lateMove));
  // A move waiting on itself holds renewServer() for good, so every later
  // check would wait on it too.
  if (typeof lateMove === 'string') throw new Error('the move is waiting on itself; nothing after it can run');
  const ml = lateMove?.moved?.find((m) => m.cwd === late);
  ok(ml?.ok === false && ml.stillRefused === true && /cannot read .* either/.test(W.renewNote(late, ml)), 'its desk is told the fresh server cannot read it either', JSON.stringify(ml));
  r = await W.open(late, { resume: sess[late] });
  ok(r.ok === false && r.code === 'unreadable' && /did not change that/.test(r.error), 'an open of it is refused in those words, not moved for', JSON.stringify(r));
  writeFileSync(FLAG, '');
  r = await W.open(late, { resume: sess[late] });
  if (r.ok && r.created) await W.waitReady(late, { pid: r.pid, target: r.target, timeoutMs: 8000 });
  ok(r.ok && r.created, 'readable again, it opens', JSON.stringify(r));

  await refuse(early, { sticky: true });
  const earlyMove = await W.checkServer();
  const me = earlyMove?.moved?.find((m) => m.cwd === early);
  ok(me?.ok === false && me.stillRefused === true, 'refused when reopened first: the move finds it still refused', JSON.stringify(me));
  const keptE = await panesNow();
  ok((await W.checkServer()) === null, 'and the next check moves nothing');
  ok(JSON.stringify(await panesNow()) === JSON.stringify(keptE), 'the windows are the same processes', JSON.stringify(keptE));
  writeFileSync(FLAG, '');
  ok((await W.checkServer()) === null, 'readable again, nothing to do');

  // An open's own move: the folder it opens has no window, so it is not among
  // the move's checks, and open() reads it on the new server itself.
  await tmuxT(['kill-window', '-t', await paneOf(late)]);
  await refuse(late, { sticky: true });
  r = await W.open(late, { resume: sess[late] });
  ok(r.ok === false && r.code === 'unreadable' && /did not change that/.test(r.error), 'an open whose move did not clear its folder is refused, not opened there', JSON.stringify(r));
  ok(!(await panesNow())[late], 'and no window is made for it');
  writeFileSync(FLAG, '');
  r = await W.open(late, { resume: sess[late] });
  if (r.ok && r.created) await W.waitReady(late, { pid: r.pid, target: r.target, timeoutMs: 8000 });
  ok(r.ok && r.created, 'readable again, it opens', JSON.stringify(r));

  console.log('\n# a server that also runs somebody else\'s session is not killed');
  await tmuxT(['new-session', '-d', '-s', 'mine', 'sleep 300']);
  await refuse(A);
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
  // A real refusal, unlike the wrapper's: with `-t orch:` it parked the
  // session's current window in view-mode (QA, PR #54 finding 1).
  ok(!(await inMode()), 'and leaves no window in view-mode');

  console.log('\n# a folder deleted under its window moves nothing, at any check');
  // QA, PR #54 findings 1 and 4. tmux goes on reporting a deleted folder as
  // the pane's path, so every heartbeat reads it and is refused.
  const D = W.canonical(`${FIX}/d`);
  r = await W.open(D, {});
  // On the stand-in's own file, not the pane: deleted before its `cat` has
  // opened ./received.txt, the stand-in exits and takes the pane with it.
  ok(await until(async () => !!(await panesNow())[D] && existsSync(`${D}/received.txt`), 5000), 'a window is open in it', JSON.stringify(r));
  rmSync(D, { recursive: true, force: true });
  const keptD = await panesNow();
  ok(!!keptD[D], 'tmux still gives the deleted folder as its path', JSON.stringify(keptD));
  ok((await W.checkServer()) === null && (await W.checkServer()) === null, 'checkServer does nothing, twice');
  ok(JSON.stringify(await panesNow()) === JSON.stringify(keptD), 'the windows are the same processes');
  ok(!(await inMode()), 'and no window is left in view-mode');
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

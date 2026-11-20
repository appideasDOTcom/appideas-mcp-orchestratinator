// End-to-end test for hosting: a real host process against a real server,
// driving a real tmux pane — the whole path a message takes from the floor's
// composer into a window, and the whole path a turn takes back out.
//
// Claude Code itself is not launched: ORCH_HOST_CLAUDE points at a stand-in
// that answers `agents --json` with a roster and otherwise sits reading stdin
// like a TUI would. HOME is pointed at the fixture too, so the transcript the
// host tails is one this test writes rather than anything on the real machine.
// Everything else is the real thing — desk discovery from .mcp.json, the long
// poll for work, tmux delivery, the transcript tail, and the SSE feed.
//
// The assertions that matter most are the ones that used to be impossible. A
// previous version of this file asserted the opposite of the first one:
//
//     eq(r.status, 409, 'a message from the floor is refused while the terminal drives');
//     eq((await r.json()).code, 'terminal_driving', 'with the reason');
//
// It passed, and it was encoding the bug. A desk has no driver now: you type
// on the floor or you type in the window, and both land in the same session.
//   npm run test:host
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync, chmodSync, utimesSync } from 'node:fs';
import { resolve } from 'node:path';
import { userInfo } from 'node:os';
import { dialogCommand, hasDialog, startFor, readAnswer, pickIsStale, parentPort, readParentAnswer, askParent, dialogBackend } from '../host/dialog.js';
import { ATTACHED_HEADER, withAttachments, retentionDays, sweepUploads, fetchUpload } from '../host/uploads.js';

const PORT = Number(process.env.HOST_TEST_PORT ?? 8896);
const DB_PATH = `./data/host-${process.pid}.db`;
const HOST = `http://localhost:${PORT}`;
const KEY = 'host-shared-secret';
const CH = 'host-test';
const FIX = resolve(`./data/host-fixture-${process.pid}`);
const HOME = `${FIX}/home`;
const TMUX_SESSION = `orch-host-test-${process.pid}`;
const WATCH_SETTLE_MS = 2000;
const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const REPO = `${FIX}/repo-a`;
const SINK = `${FIX}/received.txt`;

let failures = 0;
const assert = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures++;
};
const eq = (actual, expected, msg) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? '✓' : '✗'} ${msg}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
  if (!ok) failures++;
};
const rmDb = (p) => { for (const ext of ['', '-wal', '-shm']) { try { rmSync(p + ext); } catch { /* ignore */ } } };

const json = (path, body, method = body === undefined ? 'GET' : 'POST') =>
  fetch(`${HOST}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-orchestratinator-key': KEY },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const floor = () => json('/api/floor').then((r) => r.json());
const deskOf = (f, agent) => f.channels.find((c) => c.channel === CH)?.desks.find((d) => d.agent === agent);
const turns = (agent) => json(`/api/floor/turns?channel=${CH}&agent=${agent}`).then((r) => r.json());
const chat = (agent, text) => json('/api/floor/chat', { channel: CH, agent, text });

const received = () => (existsSync(SINK) ? readFileSync(SINK, 'utf8') : '');
const clean = (s) => s.replace(/\x1b\[20[01]~/g, '');

async function until(fn, ms = 8000) {
  const stop = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > stop) return null;
    await sleep(120);
  }
}
async function waitHealthy() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${HOST}/health`)).ok) return true; } catch { /* retry */ }
    await sleep(100);
  }
  return false;
}

/** The transcript Claude Code would write, where the host will look for it. */
const slug = () => REPO.replace(/[^A-Za-z0-9]/g, '-');
const transcript = () => `${HOME}/.claude/projects/${slug()}/${SESSION_ID}.jsonl`;
const appendTurn = (obj) => appendFileSync(transcript(), `${JSON.stringify(obj)}\n`);

function fixture() {
  mkdirSync(`${REPO}/src`, { recursive: true });
  mkdirSync(`${HOME}/.claude/projects/${slug()}`, { recursive: true });
  writeFileSync(SINK, '');
  writeFileSync(transcript(), '');
  // Under a name of its own, as a hand-written .mcp.json may be: a bare /mcp
  // from the floor reconnects the server by the name the window knows it by.
  writeFileSync(`${REPO}/.mcp.json`, JSON.stringify({
    mcpServers: {
      'team-board': {
        type: 'http', url: `${HOST}/mcp`,
        headers: { 'X-Channel': CH, 'X-Agent': 'free', 'X-Orchestratinator-Key': KEY },
      },
    },
  }, null, 2));

  // A repo on a *different* board, to prove this host leaves it alone.
  const other = `${FIX}/repo-elsewhere`;
  mkdirSync(other, { recursive: true });
  writeFileSync(`${other}/.mcp.json`, JSON.stringify({
    mcpServers: {
      orchestratinator: {
        type: 'http', url: 'http://localhost:9/mcp',
        headers: { 'X-Channel': CH, 'X-Agent': 'pro', 'X-Orchestratinator-Key': KEY },
      },
    },
  }, null, 2));

  // Local scope: desks bound with `claude mcp add -s local`, which lives in
  // ~/.claude.json rather than in the repo — HOME is the fixture, so this is
  // the file the host reads. Three cases: a desk bound only there; a directory
  // bound both ways, where local must win because it is what Claude Code
  // connects with (measured 2026-09-09); and a local binding to another board,
  // skipped exactly as a .mcp.json one is.
  const localScope = (agent, url = `${HOST}/mcp`) => ({
    mcpServers: { orchestratinator: { type: 'http', url, headers: { 'X-Channel': CH, 'X-Agent': agent, 'X-Orchestratinator-Key': KEY } } },
  });
  for (const d of ['repo-local', 'repo-both', 'repo-localelse']) mkdirSync(`${FIX}/${d}`, { recursive: true });
  writeFileSync(`${FIX}/repo-both/.mcp.json`, JSON.stringify({
    mcpServers: {
      orchestratinator: {
        type: 'http', url: `${HOST}/mcp`,
        headers: { 'X-Channel': CH, 'X-Agent': 'both-project', 'X-Orchestratinator-Key': KEY },
      },
    },
  }, null, 2));
  writeFileSync(`${HOME}/.claude.json`, JSON.stringify({
    projects: {
      [`${FIX}/repo-local`]: { ...localScope('local-a'), hasTrustDialogAccepted: true },
      [`${FIX}/repo-both`]: localScope('both-local'),
      [`${FIX}/repo-localelse`]: localScope('local-else', 'http://localhost:9/mcp'),
    },
  }, null, 2));

  // Folders that are not desks, for the list the host offers: a git checkout
  // nobody has bound, and a folder Claude Code has opened before — its project
  // directory holds one transcript, dated to a moment that cannot be "now", so
  // the time the board serves back is provably the one read off the file.
  mkdirSync(`${FIX}/plain-git/.git`, { recursive: true });
  writeFileSync(`${FIX}/plain-git/.git/HEAD`, 'ref: refs/heads/main\n');
  mkdirSync(`${FIX}/opened`, { recursive: true });
  const openedProject = `${HOME}/.claude/projects/${`${FIX}/opened`.replace(/[^A-Za-z0-9]/g, '-')}`;
  mkdirSync(openedProject, { recursive: true });
  writeFileSync(`${openedProject}/one.jsonl`, '');
  utimesSync(`${openedProject}/one.jsonl`, new Date('2024-01-02T03:04:05Z'), new Date('2024-01-02T03:04:05Z'));

  // The stand-in: a roster on `agents --json`, a Claude Code otherwise.
  //
  // It asks for bracketed paste so a multi-line message is one turn, it
  // announces itself with its own pid the way a real session does — `$` is
  // the shell pid and `exec` keeps it, so the pid it publishes is the pid tmux
  // reports for the pane — and it writes what it is sent into its transcript.
  //
  // That last part is not decoration. The transcript is how the host knows a
  // message was delivered rather than left sitting in a composer, so a
  // stand-in that never wrote one could only ever prove that bytes reached a
  // pane. Two sends in three were being lost against real Claude Code while
  // this suite was green.
  writeFileSync(`${FIX}/roster.json`, '[]');
  // The body is its own file, .cjs because the fixture sits inside this repo
  // and this package is "type": "module" — as .js it is parsed as ESM, dies on
  // its first require, and the window is gone before anything can look at it.
  // The body is started through an absolute interpreter. A
  // `#!/usr/bin/env node` shebang would depend on the PATH of the pane, and a
  // pane belongs to the tmux server rather than to this process — so the
  // stand-in would die on start, the window would open empty, and the failure
  // would read as "Claude Code has not finished starting". It did.
  writeFileSync(`${FIX}/claude`,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(`${FIX}/claude.cjs`)} "$@"\n`);
  chmodSync(`${FIX}/claude`, 0o755);
  writeFileSync(`${FIX}/claude.cjs`, [
    `const fs = require('fs');`,
    `const ROSTER = ${JSON.stringify(`${FIX}/roster.json`)};`,
    `const SINK = ${JSON.stringify(SINK)};`,
    `const TRANSCRIPT = ${JSON.stringify(transcript())};`,
    `const SESSION_ID = ${JSON.stringify(SESSION_ID)};`,
    `const ARGV = ${JSON.stringify(`${FIX}/argv.log`)};`,
    `if (process.argv[2] === 'agents') { process.stdout.write(fs.readFileSync(ROSTER, 'utf8')); process.exit(0); }`,
    // `claude mcp add -s local …` and `claude mcp remove -s local …`, as the
    // real CLI behaves (measured 2026-09-08/09): a read-modify-write of
    // $HOME/.claude.json under projects[cwd].mcpServers, "already exists" on
    // a duplicate add, "No MCP server named" on a missing remove, and the
    // "File modified:" line on success. HOME is the fixture, so this is the
    // file the host reads back. Handled before the argv log below: an mcp
    // call is not a window, and the --resume assertion diffs that log.
    `if (process.argv[2] === 'mcp') {`,
    `  const CFG = require('path').join(process.env.HOME, '.claude.json');`,
    `  let j = {}; try { j = JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch {}`,
    `  const a = process.argv.slice(3); const sub = a[0];`,
    `  const scopeAt = a.indexOf('-s'); if (scopeAt >= 0 && a[scopeAt + 1] !== 'local') { process.stderr.write('stand-in: only local scope\\n'); process.exit(2); }`,
    `  const rest = a.slice(1).filter((x, i, arr) => x !== '-s' && arr[i - 1] !== '-s');`,
    `  j.projects = j.projects || {}; const dir = process.cwd(); j.projects[dir] = j.projects[dir] || {}; const p = j.projects[dir]; p.mcpServers = p.mcpServers || {};`,
    `  const done = () => { fs.writeFileSync(CFG, JSON.stringify(j, null, 2)); process.stdout.write('File modified: ' + CFG + ' [project: ' + dir + ']\\n'); process.exit(0); };`,
    `  if (sub === 'add') {`,
    `    const t = rest.indexOf('--transport'); const transport = t >= 0 ? rest[t + 1] : 'stdio';`,
    `    const positional = rest.filter((x, i, arr) => !x.startsWith('-') && arr[i - 1] !== '--transport' && arr[i - 1] !== '-H');`,
    `    const [name, url] = positional; const headers = {};`,
    `    rest.forEach((x, i) => { if (x === '-H') { const [k, ...v] = rest[i + 1].split(':'); headers[k.trim()] = v.join(':').trim(); } });`,
    `    if (p.mcpServers[name]) { process.stderr.write('MCP server ' + name + ' already exists in local config\\n'); process.exit(1); }`,
    `    p.mcpServers[name] = { type: transport, url, headers }; done();`,
    `  }`,
    `  if (sub === 'remove') {`,
    `    const name = rest[0];`,
    `    if (!p.mcpServers[name]) { process.stderr.write('No MCP server named "' + name + '" in local scope\\n'); process.exit(1); }`,
    `    delete p.mcpServers[name]; done();`,
    `  }`,
    `  process.stderr.write('stand-in: unknown mcp subcommand\\n'); process.exit(2);`,
    `}`,
    // `claude auth status --json` and `claude auth login`, as 2.1.329 answers
    // them (host/auth.js): signed out while signed-out.flag exists; a login
    // takes signin-delay.flag ms (300 by default) and signs in, or fails with
    // signin-fail.flag's words on stderr. Each call is logged with the USER
    // it was given, because without one Claude Code reads a signed-in Mac as
    // signed out. Not a window, so before the argv log.
    `if (process.argv[2] === 'auth') {`,
    `  const OUT = ${JSON.stringify(`${FIX}/signed-out.flag`)};`,
    `  fs.appendFileSync(${JSON.stringify(`${FIX}/auth.log`)}, process.argv.slice(3).join(' ') + ' USER=' + (process.env.USER || '') + '\\n');`,
    `  if (process.argv[3] === 'status') { const out = fs.existsSync(OUT); process.stdout.write(JSON.stringify({ loggedIn: !out, authMethod: out ? 'none' : 'claude.ai' }) + '\\n'); process.exit(out ? 1 : 0); }`,
    `  if (process.argv[3] !== 'login') process.exit(2);`,
    `  let fail = ''; try { fail = fs.readFileSync(${JSON.stringify(`${FIX}/signin-fail.flag`)}, 'utf8').trim(); } catch {}`,
    `  let delay = 300; try { delay = Number(fs.readFileSync(${JSON.stringify(`${FIX}/signin-delay.flag`)}, 'utf8').trim()) || 300; } catch {}`,
    `  setTimeout(() => { if (fail) { process.stderr.write('Opening browser to sign in\u2026\\n' + fail + '\\n'); process.exit(1); } fs.rmSync(OUT, { force: true }); process.exit(0); }, delay);`,
    `  return;`,
    `}`,
    `fs.appendFileSync(ARGV, process.argv.slice(2).join(' ') + '\\n');`,
    // The one variable a placeholder desk's window is given (paneEnv in
    // host/window.js), one line per window started, as the pane has it.
    `fs.appendFileSync(${JSON.stringify(`${FIX}/pane-env.log`)}, JSON.stringify({ cwd: process.cwd(), key: process.env.ORCH_TEST_PANE_KEY ?? null }) + '\\n');`,
    // Announcing late is how a real session behaves when something on screen
    // is waiting for an answer: the window is up, the pid is not in the roster
    // yet, and send() sits in waitReady. A ready-delay *file* makes that
    // window a known length so a test can look at what the host does
    // *during* it. Absent, it announces immediately, as before.
    //
    // A file, not an env var — this used to read
    // process.env.ORCH_TEST_READY_DELAY_MS. Measured directly: `tmux
    // new-session`/`new-window` on an already-running server gives the new
    // pane only the environment the server had when it first booted, not the
    // requesting client's — so on any machine that already has a tmux server
    // on the default socket for something else (this repo's own live host,
    // say), that env var silently never arrived and the delay was 0 the
    // whole time. The one test using it happened to pass regardless, because
    // its assertions do not strictly require the delay to hold — which is
    // exactly how this went unnoticed until STARTUP_ASK_FLAG hit the same
    // wall and needed the delay to actually be there.
    // A window started with --resume registers under that id, as Claude Code
    // does; without one it registers under the fixture's constant, which is
    // the id a "fresh" conversation flips the desk to.
    `const resumeAt = process.argv.indexOf('--resume');`,
    // A fresh-id *file* (read at start, like the flags below) gives a window
    // started with nothing to resume an id of its own instead of the
    // constant, so a case can tell "a new conversation" from "the one it was
    // on" by the id the desk follows — the move does (#24 Decided 2).
    `const FRESH_ID_FLAG = ${JSON.stringify(`${FIX}/fresh-id.flag`)};`,
    `let freshId = ''; try { freshId = fs.readFileSync(FRESH_ID_FLAG, 'utf8').trim(); } catch {}`,
    `const MY_ID = resumeAt >= 0 && process.argv[resumeAt + 1] ? process.argv[resumeAt + 1] : (freshId || SESSION_ID);`,
    // A window killed under a linger file stays alive — and so in the roster,
    // which drops only dead pids — for that many ms after its hangup. Claude
    // Code does not leave the roster the instant tmux kills its pane: the
    // floor's move asked who held the conversation in that gap and was
    // refused by the closing window itself, 10 of 10 times on the live board
    // (issue #24). This stand-in otherwise exits on the hangup, which is why
    // the suite never met it. Read at the hangup, not at start, so a case can
    // arm it for a window that is already open.
    //
    // The linger ends by a watchdog, not by a timer of its own. A
    // setTimeout(process.exit) here never fired: after the hangup Node
    // reopens the dead pane's tty (uv_tty_init → open()) and on macOS that
    // open never returns, so the loop never ran again — measured with
    // `sample`, 775 of 775 on the main thread (task 263, 2026-11-03). Every
    // run left the two windows the move case closes under this flag alive,
    // parented to the tmux server, 105 of them by one evening. The watchdog
    // is a detached sh that kills this pid when the linger is up, and only
    // if the pid is still this stand-in: pids are reused.
    `const LINGER_FLAG = ${JSON.stringify(`${FIX}/linger.flag`)};`,
    `process.on('SIGHUP', () => {`,
    `  let ms = 0; try { ms = Number(fs.readFileSync(LINGER_FLAG, 'utf8').trim()) || 0; } catch {}`,
    `  if (ms > 0) {`,
    `    process.stdin.on('error', () => {});`,
    `    const me = String(process.pid), script = process.argv[1];`,
    `    require('child_process').spawn('/bin/sh', ['-c', 'sleep "$1"; ps -o command= -p "$2" | grep -qF -- "$3" && kill -9 "$2"', 'linger', String(ms / 1000), me, script], { detached: true, stdio: 'ignore' }).unref();`,
    `    return;`,
    `  }`,
    `  process.removeAllListeners('SIGHUP'); process.kill(process.pid, 'SIGHUP');`,
    `});`,
    `const announce = () => fs.writeFileSync(ROSTER, JSON.stringify([{ pid: process.pid, cwd: process.cwd(), kind: 'interactive', startedAt: Date.now(), sessionId: MY_ID, name: 'stand-in' }]));`,
    `const READY_DELAY_FLAG = ${JSON.stringify(`${FIX}/ready-delay.flag`)};`,
    `let readyDelay = 0;`,
    `try { readyDelay = Number(fs.readFileSync(READY_DELAY_FLAG, 'utf8').trim()) || 0; } catch {}`,
    // A pane in this repo whose process is not yet in the roster — announcing
    // late is exactly that — is what the host reads as "booting", and if the
    // screen looks like a startup dialog it is read and put on the floor (see
    // Desk.watch in host/index.js). Printed once, before the roster delay, so
    // a test can prove that emission fires against a real host process rather
    // than only against a synthetic event handed straight to the server.
    //
    // A flag *file*, not an env var: measured directly (tmux new-session on
    // an already-running server) that tmux does not forward the spawning
    // client's environment into the pane it creates — a window's env comes
    // from whenever the tmux *server* itself first started, not from
    // whichever later process asked for a new window. ROSTER/SINK/TRANSCRIPT
    // already communicate with this stand-in over the filesystem for exactly
    // this reason; this follows the same pattern.
    `const STARTUP_ASK_FLAG = ${JSON.stringify(`${FIX}/startup-ask.flag`)};`,
    `let startupAsk = '';`,
    `try { startupAsk = fs.readFileSync(STARTUP_ASK_FLAG, 'utf8').trim(); } catch {}`,
    `if (startupAsk === 'mcp') {`,
    `  const mcp = ['', ${JSON.stringify('─'.repeat(80))}, '  New MCP server found in this project: orchestratinator', '', '  MCP servers may execute code or access system resources. All tool calls require approval.', '', '    Use this MCP server', '    Use this and all future MCP servers in this project', '  ❯ Continue without using this MCP server', '', '  Enter to confirm · Esc to cancel', ''];`,
    `  for (const l of mcp) process.stdout.write(l + '\\n');`,
    // Forced rather than relying on a caller to also write READY_DELAY_FLAG:
    // this scenario needs a real window to observe, not a fast one, and the
    // ask-flag alone should be enough to say so.
    `  readyDelay = Math.max(readyDelay, 4000);`,
    `}`,
    // The browser extension's question, on a window that HAS registered
    // (costmo's new machine, 2026-11-20): announced at once, the dialog drawn
    // after, raw so Enter reaches it as a key, and gone at that Enter, with a
    // pane cleared, history too (tmux keeps a cleared screen in history, and
    // the dialog's footer left among the pane's last lines had the next
    // message refused as asking). No composer is drawn in its place: a drawn
    // one never changes, and a paste waits a minute on a box that does not.
    `let chromeUp = startupAsk === 'chrome';`,
    `const CHROME = ['', ${JSON.stringify('─'.repeat(80))}, ' Claude in Chrome extension detected', '', ' Claude will use your Chrome browser by default — navigating sites, filling', ' forms, and capturing screenshots in your existing session.', '', ' This session is in Auto mode, which checks routine browser actions — you are', ' only prompted when it is unsure. Turn browser tools off for future sessions', ' with /chrome.', '', ' ❯ No, keep browser tools off', '   Yes, use my browser', '', ' Enter to confirm · Esc to keep browser tools off'];`,
    // A window that has started draws its composer, so the dialog's footer is
    // no longer the pane's last line: the host reads a question as gone by
    // the pane no longer showing it, not by the window registering.
    String.raw`const started = () => { if (startupAsk === 'mcp') process.stdout.write('\n❯ \n'); announce(); };`,
    `if (readyDelay > 0) setTimeout(started, readyDelay); else started();`,
    String.raw`process.stdout.write('\u001b[?2004h');`,
    // A flag file makes the window look mid-turn: Claude Code's status line
    // says "esc to interrupt" exactly while it works, and the host reads that
    // off the pane's bottom line. A reopen must refuse such a window.
    `const BUSY_FLAG = ${JSON.stringify(`${FIX}/busy.flag`)};`,
    String.raw`if (fs.existsSync(BUSY_FLAG)) process.stdout.write('\n  \u2733 Baking\u2026 (esc to interrupt)\n');`,
    // Started while Claude Code is signed out, the window says so where
    // 2.1.329 does, at the right of the status row under the composer, and
    // never redraws it: a sign-in made elsewhere is not taken by this one.
    `const SIGNED_OUT_FLAG = ${JSON.stringify(`${FIX}/signed-out.flag`)};`,
    String.raw`if (fs.existsSync(SIGNED_OUT_FLAG)) process.stdout.write('\n' + '\u2500'.repeat(60) + '\n\u276f \n' + '\u2500'.repeat(60) + '\n  \u23f5\u23f5 auto mode on (shift+tab to cycle)          Not logged in \u00b7 run /login\n');`,
    // And a flag file that leaves the window asking something: a permission
    // menu (`bash`), a one-question form (`form`) or one with previews
    // (`preview`), drawn once at the bottom
    // of the pane and never redrawn — for an answer that waited in the host's
    // line past ANSWER_TTL_MS (QA, PR #49 finding 2 and Info 4).
    `const PROMPT_FLAG = ${JSON.stringify(`${FIX}/prompt.flag`)};`,
    `let promptKind = ''; try { promptKind = fs.readFileSync(PROMPT_FLAG, 'utf8').trim(); } catch {}`,
    `const PROMPTS = ${JSON.stringify({ bash: ["", "────────────────────────────────────────────────────────────────────────────────", " Bash command", "", "   rm -rf build-cache", "   Clear the build cache", "", " Do you want to proceed?", " ❯ 1. Yes", "   2. Yes, and don't ask again for rm commands in this folder", "   3. No, and tell Claude what to do differently (esc)", "", " Esc to cancel · Tab to amend"], form: ["", "────────────────────────────────────────────────────────────────────────────────", " ☐ Scope", "Which scope should step one audit?", "❯ 1. Baseline only", "     Audit just the baseline.", "  2. Everything in the tree", "     Audit everything in the tree.", "  3. Type something.", "────────────────────────────────────────────────────────────────────────────────", "  4. Chat about this", "Enter to select · ↑/↓ to navigate · Esc to cancel"],
      // A question drawn with previews, as 2.1.325 draws one: the choices
      // beside the highlighted one's preview, no "Type something." row, and
      // "n to add notes" on its status line. Never redrawn, so a digit moves
      // nothing here (QA, PR #55 Info 8).
      preview: ["", "────────────────────────────────────────────────────────────────────────────────", " ☐ Where", "", "Where should it go?", "", "❯ 1. Alpha                        ┌────────┐", "  2. Bravo                        │ AAA box│", "  3. Charlie                      └────────┘", "                                  Notes: press n to add notes", "────────────────────────────────────────────────────────────────────────────────", "  Chat about this", "", "Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel"] })};`,
    `for (const l of PROMPTS[promptKind] ?? []) process.stdout.write(l + '\\n');`,
    // A prompt takes a bare key with no Enter, as a person pressing one
    // would, and a tty in canonical mode holds it until a newline that never
    // comes — so the key the host pressed never reached SINK. Raw while
    // asking, as the window suite's prompt panes are (`stty raw`).
    `if (PROMPTS[promptKind] && process.stdin.isTTY) process.stdin.setRawMode(true);`,
    `if (chromeUp) { for (const l of CHROME) process.stdout.write(l + '\\n'); if (process.stdin.isTTY) process.stdin.setRawMode(true); }`,
    String.raw`const START = '\u001b[200~', END = '\u001b[201~';`,
    `let acc = '', composer = '', n = 0;`,
    `process.stdin.on('data', (chunk) => {`,
    `  fs.appendFileSync(SINK, chunk);`,
    String.raw`  if (chromeUp) { if (/[\r\n]/.test(chunk.toString('utf8'))) { chromeUp = false; if (process.stdin.isTTY) process.stdin.setRawMode(false); process.stdout.write('\u001b[2J\u001b[3J\u001b[H'); } return; }`,
    `  acc += chunk.toString('utf8');`,
    `  for (;;) {`,
    `    const at = acc.indexOf(START);`,
    `    if (at >= 0) {`,
    `      const end = acc.indexOf(END, at);`,
    `      if (end < 0) break;`,                                  // the rest of the paste is still on its way
    `      composer += acc.slice(at + START.length, end);`,
    `      acc = acc.slice(0, at) + acc.slice(end + END.length);`,
    `      continue;`,
    `    }`,
    String.raw`    const submit = acc.search(/[\r\n]/);`,
    `    if (submit >= 0) {`,
    `      const text = (composer + acc.slice(0, submit)).trim();`,
    `      composer = ''; acc = acc.slice(submit + 1);`,
    // A slash command, as Claude Code records one (measured 2.1.300,
    // 2026-11-03): /clear starts a NEW session file whose first record is
    // the command, and the roster follows it; /btw writes nothing and draws
    // an overlay with the answer; any other command writes its
    // <command-name> record. A message is a user record, as before.
    `      const cmd = /^\\/(\\w+)(?:\\s+(.*))?$/.exec(text);`,
    `      if (cmd && cmd[1] === 'clear') {`,
    `        const next = 'cleared-' + Date.now();`,
    `        const file = require('path').join(require('path').dirname(TRANSCRIPT), next + '.jsonl');`,
    `        fs.writeFileSync(file, JSON.stringify({ type: 'user', uuid: 'c1', timestamp: new Date().toISOString(), message: { content: '<command-name>/clear</command-name><command-message>clear</command-message><command-args></command-args>' } }) + '\\n');`,
    `        fs.writeFileSync(ROSTER, JSON.stringify([{ pid: process.pid, cwd: process.cwd(), kind: 'interactive', startedAt: Date.now(), sessionId: next, name: 'stand-in' }]));`,
    `        continue;`,
    `      }`,
    `      if (cmd && cmd[1] === 'btw') {`,
    String.raw`        process.stdout.write('\n' + '\u2594'.repeat(60) + '\n    /btw ' + (cmd[2] || '') + '\n      42\n    \u2191/\u2193 to scroll \u00b7 c to copy \u00b7 f to fork \u00b7 Esc to close\n');`,
    `        continue;`,
    `      }`,
    // /mcp as 2.1.328 does it (measured 2026-11-19): bare, the servers
    // panel, which writes nothing; `/mcp reconnect <name>`, the command
    // record and its line as local-command-stdout.
    `      if (cmd && cmd[1] === 'mcp' && !cmd[2]) {`,
    String.raw`        process.stdout.write('\n' + '\u2594'.repeat(60) + '\n  MCP servers\n  1 server\n  \u276f \u2718 team-board\n  \u2191/\u2193 to navigate \u00b7 Enter to view \u00b7 Esc to close\n');`,
    `        continue;`,
    `      }`,
    // The argument without what is left of a paste's closing sequence: the
    // composer above keeps a trailing escape byte with the text it submits.
    `      if (cmd && cmd[1] === 'mcp') {`,
    `        const arg = cmd[2].replace(/[\\u0000-\\u001f]/g, '').trim();`,
    `        const said = /^reconnect\\s+(\\S+)$/.test(arg) ? 'Reconnected to ' + arg.split(/\\s+/)[1] : 'MCP server not found';`,
    `        fs.appendFileSync(TRANSCRIPT, JSON.stringify({ type: 'user', uuid: 'u' + (++n), timestamp: new Date().toISOString(), message: { content: '<command-name>/mcp</command-name><command-message>mcp</command-message><command-args>' + arg + '</command-args>' } }) + '\\n');`,
    `        fs.appendFileSync(TRANSCRIPT, JSON.stringify({ type: 'user', uuid: 'u' + (++n), timestamp: new Date().toISOString(), message: { content: '<local-command-stdout>' + said + '</local-command-stdout>' } }) + '\\n');`,
    `        continue;`,
    `      }`,
    `      if (cmd) { fs.appendFileSync(TRANSCRIPT, JSON.stringify({ type: 'user', uuid: 'u' + (++n), timestamp: new Date().toISOString(), message: { content: '<command-name>/' + cmd[1] + '</command-name><command-message>' + cmd[1] + '</command-message><command-args>' + (cmd[2] || '') + '</command-args>' } }) + '\\n'); continue; }`,
    String.raw`      if (text) fs.appendFileSync(TRANSCRIPT, JSON.stringify({ type: 'user', uuid: 'u' + (++n), timestamp: new Date().toISOString(), message: { content: text } }) + '\n');`,
    `      continue;`,
    `    }`,
    String.raw`    const esc = acc.lastIndexOf('\u001b');`,
    `    const keep = esc >= 0 && acc.length - esc < START.length ? esc : acc.length;`,
    `    composer += acc.slice(0, keep); acc = acc.slice(keep);`,
    `    break;`,
    `  }`,
    `});`,
    `process.stdin.resume();`,
  ].join('\n'));
  chmodSync(`${FIX}/claude`, 0o755);

  // The stand-in for a person at the operating system's folder dialog — a
  // dialog cannot be clicked from a test. The host runs it in place of the
  // real one (ORCH_FOLDER_DIALOG), with the start folder as its argument, and
  // reads the same JSON off its stdout. What it answers is a file, so each
  // case says what "the person" does next: choose a folder, close the dialog,
  // take their time, or have the dialog die. It logs where it was opened, and
  // its pid, so a test can see that a dialog left open really was ended.
  writeFileSync(`${FIX}/dialog`,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(`${FIX}/dialog.cjs`)} "$@"\n`);
  chmodSync(`${FIX}/dialog`, 0o755);
  writeFileSync(`${FIX}/dialog-answer.json`, '{"cancel":true}');
  writeFileSync(`${FIX}/dialog.cjs`, [
    `const fs = require('fs');`,
    `fs.appendFileSync(${JSON.stringify(`${FIX}/dialog.log`)}, JSON.stringify({ start: process.argv[2], pid: process.pid }) + '\\n');`,
    `let a = {}; try { a = JSON.parse(fs.readFileSync(${JSON.stringify(`${FIX}/dialog-answer.json`)}, 'utf8')); } catch {}`,
    `setTimeout(() => {`,
    `  if (a.fail) { process.stderr.write(a.fail + '\\n'); process.exit(a.code || 1); }`,
    `  process.stdout.write(JSON.stringify(a.cancel ? { cancelled: true } : { path: a.path }) + '\\n');`,
    `}, a.delay || 0);`,
  ].join('\n'));
}

function startHost(id = 'host-test-1', extraEnv = {}, { ipc = false } = {}) {
  // `ipc` starts the host the way the desktop app does, with a message port
  // to the process that started it (Node's channel here, Electron's
  // parentPort there — host/dialog.js reads both). What the host says over
  // it is kept in `said`, and `h.send()` answers it.
  const h = spawn('node', ['host/index.js'], {
    env: {
      ...process.env,
      HOME,
      ORCH_URL: HOST, ORCH_AUTH_TOKEN: KEY, ORCH_HOST_ROOTS: FIX,
      ORCH_HOST_ID: id, ORCH_HOST_NAME: 'Test Mac',
      ORCH_HOST_CLAUDE: `${FIX}/claude`, ORCH_TMUX_SESSION: TMUX_SESSION,
      ORCH_HOST_WATCH_MS: '300', ORCH_HOST_CONFIG: '/nonexistent/host.json',
      // A message's attachments are written here (host/uploads.js), not
      // beside a host.json that does not exist.
      ORCH_HOST_UPLOADS: `${FIX}/uploads`,
      // Every bind holds 700 ms after its rescan: more than a watch tick, so
      // a move's desk is always watched before bind() goes on. The move
      // section's "no session row for the conversation it left" reads the
      // race every run (CLAUDE.md, Tests, the seventh sighting).
      ORCH_HOST_BIND_GAP_MS: '700',
      // send() waits for the message to show up in the transcript before it
      // calls it delivered. The stand-in writes one, so this is the real path;
      // the timeout is only shortened so a genuine failure fails fast.
      ORCH_SUBMIT_SETTLE_MS: '150', ORCH_LAND_TIMEOUT_MS: '8000',
      // The folder dialog is the stand-in above, and one left open is closed
      // after four seconds rather than ten minutes — longer than the three
      // the slowest "person" below takes to choose.
      ORCH_FOLDER_DIALOG: `${FIX}/dialog`, ORCH_PICK_TIMEOUT_MS: '4000',
      // A conversation read whole goes up three turns to a page, so a short
      // fixture still crosses a page boundary.
      ORCH_READ_PAGE_TURNS: '3',
      // Every answer and decision counts as old, so each one takes the
      // still-on-screen path (askedStill) the section "an answer that
      // waited in the host's line" measures. Nothing else here answers a
      // prompt, and a startup answer is exempt (answerIsStale).
      ORCH_ANSWER_TTL_MS: '-1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])],
  });
  h.log = '';
  h.said = [];
  if (ipc) h.on('message', (m) => h.said.push(m));
  // Kept outside the process too: the last section deliberately kills the host,
  // and everything it said would go with it just when a failure needs reading.
  h.stdout.on('data', (d) => { h.log += d; hostLog += d; });
  h.stderr.on('data', (d) => { h.log += d; hostLog += d; });
  return h;
}

const killTmux = () => { try { execFileSync('tmux', ['kill-session', '-t', TMUX_SESSION], { stdio: 'ignore' }); } catch { /* none */ } };

/* This run's stand-in claudes, by this run's fixture path, so a run beside
 * it (QA's clone, a mutant copy) is neither counted nor killed by it. Only
 * `node <FIX>/claude.cjs` itself: the linger watchdog's sh names the script
 * too, and is not a stand-in. A run leaves none (task 263) — the pane ones
 * live on the tmux server, not under this process, so nothing else would
 * reach them once their window is gone. */
const STAND_IN = `${FIX}/claude.cjs`;
const standIns = () => {
  let out = '';
  try { out = execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' }); } catch { return []; }
  return out.split('\n').map((l) => l.trim().split(/\s+/)).filter(([, exe, script]) => /(^|\/)node$/.test(exe ?? '') && script === STAND_IN).map(([pid]) => Number(pid));
};
const sweep = () => { for (const p of standIns()) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } } };
const childrenOf = (ppid) => {
  try { return execFileSync('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8' }).split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter(([, pp]) => pp === ppid).map(([p]) => p); } catch { return []; }
};

let server = null;
let host = null;
let hostLog = '';

// An interrupted run cleans up after itself too: Ctrl-C, or a kill of the
// suite, lands here instead of leaving its server, its hosts, its tmux
// session and its stand-ins running (task 263). The finally below does not
// run on a signal.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const p of childrenOf(process.pid)) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    killTmux();
    sweep();
    rmDb(DB_PATH);
    rmSync(FIX, { recursive: true, force: true });
    console.log(`\nhost: interrupted by ${sig}; its server, hosts, tmux session and stand-ins are gone`);
    process.exit(130);
  });
}

try {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); } catch {
    console.log('host: tmux is not installed — skipping (install it with `brew install tmux`)');
    process.exit(0);
  }

  rmDb(DB_PATH);
  fixture();
  // A function, because one row restarts the board on the same database,
  // as a deploy does (the milestone audit's finding 1).
  const startServer = () => spawn('node', ['src/server.js'], {
    // A floor window whose tools dropped is asked about after 1.5 s here (20 s
    // on a real board), and not again within the run: the stand-in never
    // connects, so a retry would type into it again mid-suite.
    env: { ...process.env, PORT: String(PORT), DB_PATH, ORCH_AUTH_TOKEN: KEY, ORCH_AUTH_MODE: 'enforce', ORCH_UPLOAD_DIR: `${FIX}/staged`,
      ORCH_RECONNECT_AFTER_MS: '1500', ORCH_RECONNECT_RETRY_MS: '3600000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server = startServer();
  if (!(await waitHealthy())) throw new Error('server never became healthy');

  console.log('host');

  host = startHost();
  const seen = await until(async () => (deskOf(await floor(), 'free')?.hosted ? await floor() : null));
  assert(!!seen, 'the host finds the repo and registers it as a desk');
  const d0 = deskOf(seen ?? (await floor()), 'free');
  eq(d0?.hosted?.host, 'Test Mac', 'and the floor names the machine it is on');
  assert(!deskOf(await floor(), 'pro'), 'a repo whose .mcp.json names another board is left alone');

  console.log('\n  local scope');
  assert(!!(await until(async () => (deskOf(await floor(), 'local-a')?.hosted ? true : null))),
    'a desk bound in Claude Code\'s local scope (~/.claude.json, no .mcp.json in the repo) is found and hosted');
  assert(/host-test\/local-a .*repo-local .*\(local scope\)/.test(host.log), 'and the host says which scope it read it from');
  assert(!!deskOf(await floor(), 'both-local')?.hosted, 'a directory bound both ways is hosted as its local-scope desk — the one Claude Code connects with');
  assert(!deskOf(await floor(), 'both-project'), 'and not as the .mcp.json one');
  assert(!deskOf(await floor(), 'local-else'), 'a local-scope binding to another board is left alone');
  assert(/skipping host-test\/local-else/.test(host.log), 'and named as skipped, like a .mcp.json one');

  console.log('\n  the folders the host offers');
  const offered = await (await json('/api/floor/folders')).json();
  const mineF = offered.hosts.find((h) => h.host_id === 'host-test-1');
  assert(!!mineF?.live && (mineF?.folders?.length ?? 0) > 0, 'the host reports what sits under its roots, and the board serves it back');
  eq(mineF?.roots, [FIX], 'under the roots it was given');
  const byName = Object.fromEntries((mineF?.folders ?? []).map((f) => [f.name, f]));
  eq(byName['repo-a']?.bound, { channel: CH, agent: 'free', scope: 'project', board: HOST }, 'a desk shows its binding, its scope and its board');
  eq(byName['repo-local']?.bound?.scope, 'local', 'a local-scope desk says so');
  eq(byName['repo-both']?.has_mcp_json, true, 'and a directory that also has a .mcp.json entry says that too — the import case');
  eq(byName['repo-elsewhere']?.other_board, 'http://localhost:9', 'a folder bound to another board says which');
  eq(byName['repo-a']?.other_board ?? null, null, 'and one bound here does not');
  eq(byName['plain-git']?.bound ?? null, null, 'a git checkout that is not a desk is offered, unbound');
  eq(byName['opened']?.last_active, '2024-01-02T03:04:05.000Z', 'a folder Claude Code has opened carries the time of its newest transcript');
  eq(byName['opened']?.sessions, 1, 'and how many sessions it has had');
  eq(byName['repo-local']?.trusted, true, 'whether Claude Code trusts the folder yet comes from the same file');
  assert(!byName['src'], 'a plain subdirectory that is none of these is not offered');
  const order = (mineF?.folders ?? []).map((f) => f.name);
  assert(order.indexOf('repo-a') < order.indexOf('opened') && order.indexOf('opened') < order.indexOf('plain-git'),
    `newest activity first, never-opened last — ${order.join(', ')}`);

  eq(deskOf(await floor(), 'free')?.hosted?.session_id?.startsWith('host:'), true,
    'with no window open yet, the desk has no conversation — it does not invent one');

  console.log('\ntyping from the floor');
  const sent = await chat('free', 'ship it');
  eq(sent.status, 200, 'the floor accepts a message for a desk with a live window');
  // Opening the window is what makes a conversation exist, and the host finds
  // it by asking the roster rather than by being told.
  assert(await until(async () => (deskOf(await floor(), 'free')?.hosted?.session_id === SESSION_ID ? true : null), 20000),
    'and the host then follows the conversation that window is running');
  assert(await until(() => (clean(received()).includes('ship it') ? true : null)),
    'and it arrives in the window — no driver, no handoff, no copy button');

  const multi = await chat('free', 'first line\nsecond line');
  eq(multi.status, 200, 'a multi-line message is accepted');
  assert(await until(() => (clean(received()).includes('second line') ? true : null)), 'and every line arrives');
  assert(/\x1b\[200~/.test(received()), 'delivered as one bracketed paste, so it is one turn and not two');

  /* A slash command is confirmed on its own receipt (issue #9). /btw writes
   * nothing anywhere — its answer is an overlay on the pane — and used to be
   * an error twenty seconds later; the host reads the answer off the window
   * and the desk shows it. */
  console.log('\n  a command confirmed on its own receipt');
  const btwSent = await chat('free', '/btw what is 6*7?');
  eq(btwSent.status, 200, '/btw is accepted');
  const btwRows = await until(async () => {
    const rows = (await turns('free')).rows ?? [];
    return rows.some((r) => r.via === '/btw') ? rows : null;
  }, 15000);
  eq(btwRows?.find((r) => r.via === '/btw')?.text, '42', "the answer is read off the window's overlay and is the agent's, labeled by the command");
  assert((btwRows ?? []).some((r) => r.role === 'context' && r.tool_name === 'host' && r.text === '/btw what is 6*7? — answered in the window'), 'the desk says what was typed and where the answer went, as one line labeled host');
  assert(!(btwRows ?? []).some((r) => r.role === 'error'), 'and no error turn says it did not confirm');

  // A bare /mcp opens a panel in the window that nobody on the floor drives;
  // from the floor it reconnects the desk's tools, by the name its binding
  // gives the board's server (here `team-board`, from the repo's .mcp.json).
  const mcpSent = await chat('free', '/mcp');
  eq(mcpSent.status, 200, 'a bare /mcp is accepted');
  const mcpRows = await until(async () => {
    const rows = (await turns('free')).rows ?? [];
    return rows.some((r) => r.tool_name === 'host' && /^\/mcp — /.test(r.text ?? '')) || rows.some((r) => r.role === 'error') ? rows : null;
  }, 15000);
  assert(clean(received()).includes('/mcp reconnect team-board'), 'the window is sent a reconnect of the desk\'s own server, by the name its binding gives it');
  assert((mcpRows ?? []).some((r) => r.role === 'context' && r.tool_name === 'host' && r.text === '/mcp — Reconnected to team-board'),
    `the desk says what the operator typed and the window's own line — ${JSON.stringify((mcpRows ?? []).filter((r) => r.tool_name === 'host' || r.role === 'error').map((r) => r.text))}`);
  assert(!(mcpRows ?? []).some((r) => r.role === 'error'), 'with no error turn');

  // And by itself: a desk whose agent had a session on this board, and has
  // none now (as after the desktop app restarts its board), is reconnected
  // by its host when the board asks, with the window's line on the desk.
  // The stand-in never connects, so the suite connects as the desk and then
  // drops the session, which is what a board restart does to it.
  const mh = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'X-Channel': CH, 'X-Agent': 'free', 'x-orchestratinator-key': KEY };
  const init = await fetch(`${HOST}/mcp`, { method: 'POST', headers: mh, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'host-test', version: '0' } } }) });
  await init.text();
  const freeSid = init.headers.get('mcp-session-id');
  await fetch(`${HOST}/mcp`, { method: 'DELETE', headers: { ...mh, 'mcp-session-id': freeSid } }).then((x) => x.text());
  const sentBefore = clean(received()).split('/mcp reconnect team-board').length;
  const rcRows = await until(async () => {
    const rows = (await turns('free')).rows ?? [];
    return rows.some((r) => r.tool_name === 'host' && /lost the board/.test(r.text ?? '')) ? rows : null;
  }, 45000);
  assert(clean(received()).split('/mcp reconnect team-board').length > sentBefore, 'with nothing typed by anybody, the window is sent a reconnect of its own server');
  assert((rcRows ?? []).some((r) => r.role === 'context' && r.tool_name === 'host' && r.text === "the desk's tools had lost the board, so the host ran /mcp — Reconnected to team-board"),
    `and the desk says why the host did it, and what the window said — ${JSON.stringify((rcRows ?? []).filter((r) => r.tool_name === 'host').map((r) => r.text).slice(-3))}`);


  /* Issue #31: a file attached on the floor. The board stages it, the host
   * fetches it to its own disk, outside every repo, and types its path into
   * the message. What the window is sent is read off the pane's sink; what
   * is on the disk is read off the disk. */
  console.log('\n  a message with files attached');
  const stage = (bytes, name, type = 'application/octet-stream') =>
    fetch(`${HOST}/api/floor/upload?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`, { method: 'POST', headers: { 'content-type': type }, body: bytes })
      .then((r) => r.json());
  const shotBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7, 6]);
  const shotUp = await stage(shotBytes, 'shot one.png', 'image/png');
  const logUp = await stage(Buffer.from('line 1\nline 2\n'), 'build.log', 'text/plain');
  const withFiles = await json('/api/floor/chat', { channel: CH, agent: 'free', text: 'what broke here?', files: [shotUp.id, logUp.id] });
  eq(withFiles.status, 200, 'a message with two files is accepted');
  const shotPath = `${FIX}/uploads/${shotUp.id}/shot one.png`;
  const logPath = `${FIX}/uploads/${logUp.id}/build.log`;
  const typed = await until(() => (clean(received()).includes(logPath) ? clean(received()) : null), 15000);
  assert((typed ?? '').replace(/\r\n?/g, '\n').includes(`what broke here?\n\n${ATTACHED_HEADER}\n- ${shotPath}\n- ${logPath}`),
    'the window is sent the words, then the list: one path a line, in the order attached');
  eq([existsSync(shotPath) && [...readFileSync(shotPath)], existsSync(logPath) && readFileSync(logPath, 'utf8')], [[...shotBytes], 'line 1\nline 2\n'],
    'and each file is on the host\'s disk under its own name, byte for byte');
  assert(!shotPath.startsWith(REPO) && !existsSync(`${REPO}/shot one.png`), 'outside the desk\'s folder: nothing lands in the repo');
  const before31 = clean(received()).length;
  const alone = await json('/api/floor/chat', { channel: CH, agent: 'free', files: [shotUp.id] });
  eq(alone.status, 200, 'files alone are a message');
  const aloneTyped = await until(() => {
    const now = clean(received()).slice(before31);
    return now.includes(shotPath) ? now : null;
  }, 15000);
  assert(aloneTyped != null && aloneTyped.trim().startsWith(ATTACHED_HEADER), 'and it is the list alone, opening on its header');
  // A file the host cannot write: its folder is taken by a plain file, so
  // the fetch fails before a byte is written. Nothing of the message is typed.
  const blocked = await stage(Buffer.from('x'), 'blocked.txt', 'text/plain');
  writeFileSync(`${FIX}/uploads/${blocked.id}`, 'in the way');
  const before31b = clean(received()).length;
  const failing = await json('/api/floor/chat', { channel: CH, agent: 'free', text: 'about the blocked one', files: [blocked.id] });
  eq(failing.status, 200, 'the board takes a message whose file the host will fail to write');
  const failRows = await until(async () => {
    const rows = (await turns('free')).rows ?? [];
    return rows.some((r) => r.role === 'error' && /blocked\.txt.*; nothing was typed$/.test(r.text ?? '')) ? rows : null;
  }, 15000);
  const failText = failRows?.filter((r) => r.role === 'error').at(-1)?.text ?? '';
  assert(!!failRows, `the desk is told why, then that nothing was typed, in an error turn — ${failText}`);
  // Not "not sent — …": a meeting room puts "not delivered — " before a
  // desk's error, and the two read as one stutter (QA, PR #58 Info 6).
  assert(!/^not (sent|delivered)\b/.test(failText), 'in words that read whole under a meeting room\'s own "not delivered — "');
  await sleep(500);
  assert(!clean(received()).slice(before31b).includes('about the blocked one'), 'and none of its words reach the window');

  console.log('\nreading the conversation back');
  // What Claude Code writes is what the floor shows — including a turn nobody
  // on the floor typed, which is the case that used to need a whole driver.
  appendTurn({ type: 'user', uuid: 'u-1', timestamp: new Date().toISOString(), message: { content: 'typed in the terminal' } });
  appendTurn({ type: 'assistant', uuid: 'a-1', message: { content: [{ type: 'text', text: 'answered in the terminal' }] } });
  const got = await until(async () => {
    const rows = (await turns('free')).rows ?? [];
    return rows.some((r) => r.text === 'answered in the terminal') ? rows : null;
  });
  assert(!!got, 'a turn typed in the window appears on the floor with no hook reporting it');
  assert((got ?? []).some((r) => r.text === 'typed in the terminal'), 'both sides of it');

  appendTurn({ type: 'assistant', uuid: 'a-2', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } });
  const tool = await until(async () => ((await turns('free')).rows ?? []).find((r) => r.role === 'tool'));
  eq(tool?.text, 'Bash: npm test', 'a tool call becomes its one-line row');

  // What the agent thought before the call is a row too, under its own role —
  // the operator read one in the window and found nothing on the floor.
  appendTurn({ type: 'assistant', uuid: 'a-2t', message: { content: [{ type: 'thinking', thinking: 'run the suite before touching anything else', signature: 's' }] } });
  const thought = await until(async () => ((await turns('free')).rows ?? []).find((r) => r.role === 'thinking'));
  eq(thought?.text, 'run the suite before touching anything else', "the agent's thinking reaches the floor as its own kind of row");
  eq(deskOf(await floor(), 'free')?.last_message?.text, 'run the suite before touching anything else', 'and the thought bubble picks it up');

  /* What a compaction leaves behind, what a long paste is wrapped in, and the
   * record an API error is written as — each used to be filed as somebody
   * speaking (issues #10 and #15, measured 2.1.300). */
  appendTurn({ type: 'user', uuid: 'cs-1', isCompactSummary: true, isVisibleInTranscriptOnly: true, timestamp: new Date().toISOString(), message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. Summary: …' } });
  appendTurn({ type: 'system', subtype: 'compact_boundary', uuid: 'cb-1', timestamp: new Date().toISOString(), content: 'Conversation compacted', level: 'info', compactMetadata: { trigger: 'auto', preTokens: 71299, postTokens: 12473, durationMs: 16124 } });
  appendTurn({ type: 'user', uuid: 'pc-1', timestamp: new Date().toISOString(), message: { role: 'user', content: '<pasted_content id="4a60">\nfour lines of mine\nthat the window wrapped\n</pasted_content id="4a60">' } });
  appendTurn({ type: 'assistant', uuid: 'ae-1', isApiErrorMessage: true, timestamp: new Date().toISOString(), message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Autocompact is thrashing: the context refilled to the limit' }] } });
  appendTurn({ type: 'assistant', uuid: 'am-1', timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'claude-test-9', content: [{ type: 'text', text: 'and the model that said this is new' }] } });
  const filed = await until(async () => {
    const rows = (await turns('free')).rows ?? [];
    return rows.some((r) => r.text === 'and the model that said this is new') ? rows : null;
  });
  const summaryRow = (filed ?? []).find((r) => (r.text ?? '').startsWith('This session is being continued'));
  eq([summaryRow?.role, summaryRow?.tool_name], ['context', 'compact-summary'], 'the compaction summary is a system record labeled as one, not "you:"');
  eq((filed ?? []).find((r) => r.tool_name === 'compact')?.text, 'Conversation compacted (auto): 71,299 → 12,473 tokens in 16.1 s', 'the boundary is a line in the compaction\'s own terms');
  eq((filed ?? []).find((r) => r.text === 'four lines of mine\nthat the window wrapped')?.role, 'user', 'a wrapped paste is the operator\'s words with the wrapper gone');
  assert(!(filed ?? []).some((r) => (r.text ?? '').includes('<pasted_content')), 'and the tags are nowhere');
  const apiErr = (filed ?? []).find((r) => r.text === 'Autocompact is thrashing: the context refilled to the limit');
  eq(apiErr?.role, 'error', 'the record an API error is written as is an error turn, not the agent speaking');
  eq(deskOf(await floor(), 'free')?.session?.model, 'claude-test-9', 'and the model that wrote the latest reply is the session\'s model on the floor');

  appendTurn({ type: 'assistant', uuid: 'a-3', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent chatter' }] } });
  await sleep(600);
  assert(!((await turns('free')).rows ?? []).some((r) => r.text === 'subagent chatter'),
    "a subagent's own conversation stays inside the tool call that owns it");

  /* A subagent's own file, though, is read — labeled. Claude Code writes each
   * Agent call's conversation to <session dir>/subagents/agent-<id>.jsonl, and
   * before this the floor showed the Agent line and then nothing until the
   * report, while the editor showed every step in between (2026-09-03). */
  const subDir = `${HOME}/.claude/projects/${slug()}/${SESSION_ID}/subagents`;
  mkdirSync(subDir, { recursive: true });
  writeFileSync(`${subDir}/agent-sub1.meta.json`, JSON.stringify({ agentType: 'claude-code-guide', description: 'Docs lookup', toolUseId: 'toolu_x', spawnDepth: 1 }));
  writeFileSync(`${subDir}/agent-sub1.jsonl`, [
    JSON.stringify({ type: 'user', uuid: 'su-1', isSidechain: true, agentId: 'sub1', timestamp: new Date().toISOString(), message: { content: 'find the docs' } }),
    JSON.stringify({ type: 'assistant', uuid: 'sa-1', isSidechain: true, agentId: 'sub1', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: "I'll search the official docs" }] } }),
    JSON.stringify({ type: 'assistant', uuid: 'sa-2', isSidechain: true, agentId: 'sub1', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', name: 'WebFetch', input: { url: 'https://docs.example.test/hooks' } }] } }),
    '',
  ].join('\n'));
  const viaRows = await until(async () => {
    const rows = (await turns('free')).rows ?? [];
    return rows.some((r) => r.text === "I'll search the official docs") ? rows : null;
  });
  assert(!!viaRows, "a subagent's words appear on the floor, read from its own file");
  eq(viaRows?.find((r) => r.text === "I'll search the official docs")?.via, 'Docs lookup', 'labeled with the description the caller gave it');
  eq(viaRows?.find((r) => r.text === 'WebFetch: https://docs.example.test/hooks')?.via, 'Docs lookup', 'and so is each of its tool calls');
  assert(!(viaRows ?? []).some((r) => r.text === 'find the docs'), 'its brief is not filed as anyone speaking');

  /* Merged by the clock, not by which file was read first — and not by string
   * order either. The session's own transcript is read before the subagents'
   * each tick, so a subagent line stamped earlier than a main-thread line
   * written in the same tick must still land first.
   *
   * The two stamps deliberately differ in *precision*, which is the whole of
   * what separates a clock comparison from `localeCompare`. The first version
   * of this case put them five seconds apart at the same precision, where
   * string order and clock order agree — so it pinned the sort's existence
   * (M7 red) while saying nothing about the guard, and restoring
   * `localeCompare` left it green (QA, PR #3 re-review, 2026-09-03). Here the
   * subagent's second-precision `…:00Z` sorts *after* the main thread's
   * `…:00.500Z` as a string, because `.` is below `Z`, and before it by the
   * clock. Only a real time comparison gets this right.
   */
  const base = new Date();
  base.setMilliseconds(0);
  const subAt = base.toISOString().replace(/\.\d{3}Z$/, 'Z');    // second precision, earlier
  const mainAt = new Date(base.getTime() + 500).toISOString();    // millisecond precision, later
  appendTurn({ type: 'assistant', uuid: 'a-order-main', timestamp: mainAt, message: { content: [{ type: 'text', text: 'ORDER-MAIN said later' }] } });
  appendFileSync(`${subDir}/agent-sub1.jsonl`, `${JSON.stringify({ type: 'assistant', uuid: 'sa-order', isSidechain: true, agentId: 'sub1', timestamp: subAt, message: { content: [{ type: 'text', text: 'ORDER-SUB thought earlier' }] } })}\n`);
  const ordered = await until(async () => {
    const rows = (await turns('free')).rows ?? [];
    return rows.some((r) => r.text === 'ORDER-MAIN said later') && rows.some((r) => r.text === 'ORDER-SUB thought earlier') ? rows : null;
  });
  const idOf = (text) => ordered?.find((r) => r.text === text)?.id ?? -1;
  assert(idOf('ORDER-SUB thought earlier') < idOf('ORDER-MAIN said later'),
    'a subagent line stamped earlier is filed first even though its stamp sorts later as a string — merged by the clock, not by file order or string order');

  console.log('\nswitching apps');

  // Closing the window you were typing in does not end the conversation.
  //
  // The desk forgets its live session the moment a window goes away — and that
  // is exactly when the id is needed. Without remembering it, the next message
  // from the floor opened a brand new conversation: the history on screen
  // vanished and the reply came back in something else.
  const before = existsSync(`${FIX}/argv.log`) ? readFileSync(`${FIX}/argv.log`, 'utf8') : '';
  execFileSync('tmux', ['kill-session', '-t', TMUX_SESSION], { stdio: 'ignore' });
  writeFileSync(`${FIX}/roster.json`, '[]');
  // Let the host actually notice. Without this the message is handled before a
  // watch cycle runs, the desk still holds its live session id, and the test
  // passes whether or not the id is remembered — which is the bug it exists for.
  await sleep(WATCH_SETTLE_MS);

  const again = await chat('free', 'still there?');
  eq(again.status, 200, 'and the floor still takes a message for it');
  const started = await until(() => {
    const log = existsSync(`${FIX}/argv.log`) ? readFileSync(`${FIX}/argv.log`, 'utf8') : '';
    return log.length > before.length ? log.slice(before.length) : null;
  }, 20000);
  assert(started, 'which opens a window again');
  assert((started ?? '').includes(`--resume ${SESSION_ID}`),
    `and resumes the same conversation rather than starting a new one — ${JSON.stringify((started ?? '').trim())}`);

  console.log('\na desk that appears after the host started');
  // Desks used to be discovered once, at boot. Binding a repo to this board
  // afterwards — the most ordinary thing a person does — left the floor saying
  // "No host on this board is running that repo" until the service was
  // restarted, while the hooks were already relaying the conversation. The
  // host now looks again before each heartbeat and whenever the board asks,
  // and the board asks the moment a session starts in a repo no host runs.
  const late = `${FIX}/repo-late`;
  mkdirSync(late, { recursive: true });
  writeFileSync(`${late}/.mcp.json`, JSON.stringify({
    mcpServers: {
      orchestratinator: {
        type: 'http', url: `${HOST}/mcp`,
        headers: { 'X-Channel': CH, 'X-Agent': 'late', 'X-Orchestratinator-Key': KEY },
      },
    },
  }, null, 2));
  eq(deskOf(await floor(), 'late')?.hosted ?? null, null, 'a repo bound to this board after the host started is not hosted yet');
  await json('/api/ingest', { channel: CH, agent: 'late', session_id: 'late-1', hook_event_name: 'SessionStart', cwd: late });
  assert(await until(async () => (deskOf(await floor(), 'late')?.hosted?.live === true ? true : null), 10000),
    'a session starting there is enough: the board asks, the host looks, finds the desk and registers it — nothing restarted');
  assert(/found desk .*\/late/.test(host.log), 'and the host says so in its log');
  rmSync(`${late}/.mcp.json`);
  eq((await json('/api/floor/rescan', {})).status, 200, 'the board can also ask outright');
  assert(await until(async () => (deskOf(await floor(), 'late')?.hosted?.state === 'offline' ? true : null), 10000),
    'and a binding that has been removed takes its desk offline on the next look, rather than reading as hosted for ever');
  assert(/dropped desk .*late/.test(host.log), 'which the host also says');

  // A desk whose .mcp.json key is `${ORCH_TEST_PANE_KEY}`, which neither this
  // host's environment nor the tmux server's sets (QA, PR #52 finding 1;
  // costmo's ruling B). A window the host opens for it is given that one
  // variable, set to the key the host signs in with, so Claude Code in it
  // sends the board's key rather than the placeholder. The window suite has
  // the cases that get nothing; this is the running host's own wiring
  // (useKey at boot). The window's roster entry replaces the fixture's, so
  // the case puts back what was there and closes the window when done.
  const paneDir = `${FIX}/repo-pane`;
  mkdirSync(paneDir, { recursive: true });
  writeFileSync(`${paneDir}/.mcp.json`, JSON.stringify({
    mcpServers: { orchestratinator: { type: 'http', url: `${HOST}/mcp`, headers: { 'X-Channel': CH, 'X-Agent': 'pane', 'X-Orchestratinator-Key': '${ORCH_TEST_PANE_KEY}' } } },
  }, null, 2));
  const rosterWas = readFileSync(`${FIX}/roster.json`, 'utf8');
  eq((await json('/api/floor/rescan', {})).status, 200, 'a desk whose key is a placeholder nothing here sets is found');
  assert(await until(async () => (deskOf(await floor(), 'pane')?.hosted?.live === true ? true : null), 10000), 'and hosted');
  // Opened, not messaged: the stand-in writes whatever it is sent into the
  // fixture's one transcript, which is `free`'s, and later cases count that.
  //
  // The window registers late here, on purpose (QA, PR #57 Info 10). This
  // case kills the pane as soon as it has read what the pane was given, and
  // whether the host had seen the window ready by then was a race. When it
  // had not, the host waited 45 s on a window that was gone, with its line
  // held, and the seven rows of "taking a desk" below failed for it. That
  // was the "Take a desk seven", read as load four times. With the delay
  // the host is always still waiting when the pane goes.
  writeFileSync(`${FIX}/ready-delay.flag`, '8000');
  const paneOpenedAt = host.log.length;
  eq((await json('/api/floor/open', { channel: CH, agent: 'pane' })).status, 200, 'the floor opens it');
  const paneEnvLine = await until(() => {
    const log = existsSync(`${FIX}/pane-env.log`) ? readFileSync(`${FIX}/pane-env.log`, 'utf8') : '';
    return log.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.cwd.endsWith('/repo-pane')) ?? null;
  }, 20000);
  eq(paneEnvLine?.key ?? null, KEY, "the window the host opens for it has the variable, set to the host's key");
  try {
    const panes = execFileSync('tmux', ['list-panes', '-s', '-t', `${TMUX_SESSION}:`, '-F', '#{pane_id} #{pane_current_path}']).toString();
    for (const l of panes.split('\n').filter((x) => x.endsWith('/repo-pane'))) execFileSync('tmux', ['kill-pane', '-t', l.split(' ')[0]]);
  } catch { /* gone */ }
  rmSync(`${FIX}/ready-delay.flag`, { force: true });
  writeFileSync(`${FIX}/roster.json`, rosterWas);
  rmSync(`${paneDir}/.mcp.json`);
  await json('/api/floor/rescan', {});
  assert(await until(() => (/dropped desk .*\/pane .*asked from the floor/.test(host.log.slice(paneOpenedAt)) ? true : null), 10000),
    'a window closed while the host was still waiting for it to start does not hold the host\'s line: what is asked of it next is done at once',
  );

  /* ── taking a desk from the floor ──────────────────────────────────────────
   * The first door that needs no terminal. The route refuses what the board
   * can see is wrong; the host binds with `claude mcp add -s local` (the
   * stand-in above), with its own key, and opens a window. Import takes a
   * .mcp.json desk into local scope and removes the file's entry, keeping
   * other servers. Leave is the reverse. */
  console.log('\ntaking a desk from the floor');
  const take = (body) => json('/api/floor/desk', body);
  const localCfg = () => JSON.parse(readFileSync(`${HOME}/.claude.json`, 'utf8'));
  const argvLog = () => (existsSync(`${FIX}/argv.log`) ? readFileSync(`${FIX}/argv.log`, 'utf8') : '');
  eq((await take({ host_id: 'host-test-1', path: `${FIX}/plain-git`, channel: CH, agent: 'bad name!' })).status, 400, 'an agent name with a space in it is refused');
  eq((await take({ host_id: 'host-test-1', path: '/nope', channel: CH, agent: 'newbie' })).status, 409, 'a folder the host did not offer is refused');
  eq((await take({ host_id: 'host-test-1', path: `${FIX}/repo-elsewhere`, channel: CH, agent: 'newbie' })).status, 409, 'a folder bound to another instance is refused when the take does not name that instance');
  eq((await take({ host_id: 'host-test-1', path: `${FIX}/repo-a`, channel: CH, agent: 'somebody-else' })).status, 400, 'a folder that names its agent cannot be taken under another name');
  const argvBefore = argvLog().length;
  const took = await take({ host_id: 'host-test-1', path: `${FIX}/plain-git`, channel: CH, agent: 'newbie', persona: 'Newbie Nine' });
  eq(took.status, 200, 'an unbound git checkout can be taken as a desk');
  eq((await took.json()).mode, 'take', 'as a fresh binding');
  eq(deskOf(await floor(), 'newbie')?.persona, 'Newbie Nine', 'the seat is drawn at once, wearing the name it was given');
  assert(await until(async () => (deskOf(await floor(), 'newbie')?.hosted?.live === true ? true : null), 20000),
    'and within seconds the host has bound it and registered the desk');
  eq(deskOf(await floor(), 'newbie')?.hosted?.scope, 'local', 'in local scope');
  const entry = localCfg().projects?.[`${FIX}/plain-git`]?.mcpServers?.orchestratinator;
  eq(entry?.headers, { 'X-Channel': CH, 'X-Agent': 'newbie', 'X-Orchestratinator-Key': KEY },
    'written by `claude mcp add -s local`, with the key the host holds — the board never sent one');
  eq(entry?.url, `${HOST}/mcp`, 'pointing at this board');
  assert(/newbie: bound .*plain-git in local scope/.test(host.log), 'and the host log says so');
  assert(await until(() => (argvLog().length > argvBefore ? true : null), 15000), 'and a window opened there');
  assert(!argvLog().slice(argvBefore).includes('--resume'), 'a fresh conversation, with nothing to resume');
  const offeredNow = await (await json('/api/floor/folders')).json();
  eq(offeredNow.hosts.find((h) => h.host_id === 'host-test-1')?.folders.find((f) => f.name === 'plain-git')?.bound?.agent, 'newbie',
    'and the folder list now shows it bound');

  // Import: a .mcp.json desk, with another server beside ours, into local scope.
  writeFileSync(`${REPO}/.mcp.json`, JSON.stringify({
    mcpServers: {
      orchestratinator: { type: 'http', url: `${HOST}/mcp`, headers: { 'X-Channel': CH, 'X-Agent': 'free', 'X-Orchestratinator-Key': KEY } },
      github: { type: 'http', url: 'http://127.0.0.1:9/mcp' },
    },
  }, null, 2));
  const sidBefore = deskOf(await floor(), 'free')?.hosted?.session_id;
  const imported = await take({ host_id: 'host-test-1', path: REPO, channel: CH, agent: 'free', open: false });
  eq(imported.status, 200, 'a desk bound in its .mcp.json can be brought onto the floor');
  eq((await imported.json()).mode, 'import', 'as an import');
  assert(await until(async () => (deskOf(await floor(), 'free')?.hosted?.scope === 'local' ? true : null), 20000), 'after which it is a local-scope desk');
  eq(Object.keys(JSON.parse(readFileSync(`${REPO}/.mcp.json`, 'utf8')).mcpServers), ['github'], 'its .mcp.json lost the orchestratinator entry and kept the other server');
  eq(localCfg().projects?.[REPO]?.mcpServers?.orchestratinator?.headers?.['X-Agent'], 'free', 'and ~/.claude.json gained it');
  eq(deskOf(await floor(), 'free')?.hosted?.session_id, sidBefore, 'the conversation it was following is the one it still follows');
  eq((await take({ host_id: 'host-test-1', path: `${FIX}/opened`, channel: CH, agent: 'newbie' })).status, 409, 'a name already seated at another folder is refused');

  // Leave: the reverse, all the way back to an unbound folder.
  const left = await json('/api/floor/desk/leave', { channel: CH, agent: 'newbie' });
  eq(left.status, 200, 'a desk can be left from the floor');
  assert(await until(async () => (deskOf(await floor(), 'newbie')?.hosted?.state === 'offline' ? true : null), 20000), 'and the desk goes offline once the host has unbound it');
  eq(localCfg().projects?.[`${FIX}/plain-git`]?.mcpServers?.orchestratinator ?? null, null, 'its local-scope entry is gone');
  assert(/dropped desk host-test\/newbie/.test(host.log), 'the host dropped the desk');
  assert(!execFileSync('tmux', ['list-windows', '-t', TMUX_SESSION, '-F', '#{window_name}'], { encoding: 'utf8' }).includes('plain-git'), 'and closed its window');
  assert(!!deskOf(await floor(), 'newbie'), 'the seat stays on the floor — whether the agent is gone is the board\'s question');

  /* ── the session picker and the reopen primitive ────────────────────────────
   * A desk's folder holds many conversations; the picker lists them and a
   * pick closes the floor's window and reopens it with --resume. The host
   * pins the chosen conversation before the new window registers, so a stray
   * session in the same folder cannot steal the desk meanwhile; a picked
   * conversation the board has never seen is joined at its tail, a known one
   * at its end; a fresh one flips the desk to whatever id its window
   * announces; and a window mid-turn is refused, quoting its status line. */
  console.log('\nthe session picker and reopening');
  const SESSION_B = 'bbbbbbbb-2222-3333-4444-555555555555';
  const transcriptB = `${HOME}/.claude/projects/${slug()}/${SESSION_B}.jsonl`;
  writeFileSync(transcriptB, [
    JSON.stringify({ type: 'user', uuid: 'b-u1', timestamp: '2026-09-09T08:00:00Z', message: { content: 'the other conversation begins' } }),
    JSON.stringify({ type: 'assistant', uuid: 'b-a1', timestamp: '2026-09-09T08:00:05Z', message: { content: [{ type: 'text', text: 'B-TAIL-SEEN' }] } }),
    '',
  ].join('\n'));
  const sessionsGet = () => json(`/api/floor/sessions?channel=${CH}&agent=free`).then((r) => r.json());
  // The roster as it truly is. The stand-in overwrites roster.json whenever a
  // window starts and cannot unwrite itself when one is killed, so after the
  // desk taken and left above it names a dead pane under this same session id
  // — which holderOf reads, correctly, as an editor holding it. Rebuild it
  // from the one pane actually running in the repo.
  const paneIn = (dir) => execFileSync('tmux', ['list-panes', '-s', '-t', TMUX_SESSION, '-F', '#{pane_pid} #{pane_current_path}'], { encoding: 'utf8' })
    .trim().split('\n').map((l) => l.split(' ')).find(([, d]) => d === dir)?.[0] ?? null;
  const freePid = Number(paneIn(REPO));
  assert(freePid > 0, 'a window is open in the repo to begin with');
  writeFileSync(`${FIX}/roster.json`, JSON.stringify([{ pid: freePid, cwd: REPO, kind: 'interactive', startedAt: 1, sessionId: SESSION_ID, name: 'stand-in' }]));
  await sleep(WATCH_SETTLE_MS);
  const askList = await json('/api/floor/sessions', { channel: CH, agent: 'free' });
  eq(askList.status, 200, 'the floor can ask a desk\'s host to list its conversations');
  eq((await askList.json()).asked, true, 'and the host is asked');
  const listed = await until(async () => { const g = await sessionsGet(); return g.at ? g : null; }, 15000);
  assert(!!listed, 'the host answers with a list, stamped with its time');
  const rowsById = Object.fromEntries((listed?.rows ?? []).map((r) => [r.id, r]));
  eq(rowsById[SESSION_ID]?.live, true, 'the conversation in the open window is marked live');
  eq(rowsById[SESSION_ID]?.held, 'floor', 'and held by the floor');
  eq(listed?.current, SESSION_ID, 'and the board says it is the desk\'s current one');
  eq([rowsById[SESSION_B]?.title, rowsById[SESSION_B]?.known], ['the other conversation begins', false],
    'the other conversation is titled by its first prompt and the board has never heard it');
  eq((await (await json('/api/floor/sessions', { channel: CH, agent: 'free' })).json()).asked, false,
    'asked again at once, the board serves the list it has rather than walking the folder again');

  // Reopen on B, with the new window slow to register — and a stray session
  // in the same folder during the gap, which newest-wins would have adopted.
  // This session's panes only (-s, not -a: -a is every pane on the tmux
  // server, the live board's included), and none at all in the instant a
  // reopen has killed the session's last window — tmux drops the session
  // with it, and the host makes a new one by the same name a moment later.
  const paneOf = () => {
    try {
      return execFileSync('tmux', ['list-panes', '-s', '-t', TMUX_SESSION, '-F', '#{pane_pid}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').filter(Boolean);
    } catch { return []; }
  };
  const panesBefore = paneOf();
  const argvAtReopen = argvLog().length;
  const turnsBeforeB = ((await turns('free')).rows ?? []).length;
  writeFileSync(`${FIX}/ready-delay.flag`, '3000');
  const reopened = await json('/api/floor/reopen', { channel: CH, agent: 'free', session_id: SESSION_B });
  eq(reopened.status, 200, 'a pick is accepted');
  eq((await reopened.json()).known, false, 'and the board says it has never seen that conversation');
  await sleep(600);   // the old window is closed by now; the new one announces in 3 s
  writeFileSync(`${FIX}/roster.json`, JSON.stringify([{ pid: process.pid, cwd: REPO, kind: 'interactive', startedAt: Date.now() + 5000, sessionId: 'stray-session', name: 'stray' }]));
  const seenIds = new Set();
  for (let i = 0; i < 16; i++) { seenIds.add(deskOf(await floor(), 'free')?.hosted?.session_id ?? null); await sleep(150); }
  assert(!seenIds.has('stray-session'), `a stray session in the folder is not adopted while the reopen is in flight — saw ${[...seenIds].join(', ')}`);
  assert(await until(async () => (deskOf(await floor(), 'free')?.hosted?.session_id === SESSION_B ? true : null), 25000),
    'and the desk lands on the conversation that was picked');
  assert(argvLog().slice(argvAtReopen).includes(`--resume ${SESSION_B}`), 'opened with --resume of that id');
  const panesAfter = paneOf();
  assert(panesAfter.length === panesBefore.length && !panesAfter.some((p) => panesBefore.includes(p)), 'in a new pane, the old one gone');
  assert(await until(async () => (((await turns('free')).rows ?? []).some((r) => (r.text ?? '').includes('B-TAIL-SEEN')) ? true : null), 8000),
    'a conversation the board had never seen is joined at its tail, so its recent past reaches the floor');
  appendFileSync(transcriptB, `${JSON.stringify({ type: 'assistant', uuid: 'b-a2', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: 'B-LIVE-TURN' }] } })}\n`);
  assert(await until(async () => (((await turns('free')).rows ?? []).some((r) => (r.text ?? '').includes('B-LIVE-TURN')) ? true : null), 8000),
    'and what it says next reaches the floor');
  appendTurn({ type: 'assistant', uuid: 'a-old', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: 'A-AFTER-LEAVING' }] } });
  await sleep(WATCH_SETTLE_MS);
  assert(!((await turns('free')).rows ?? []).some((r) => (r.text ?? '').includes('A-AFTER-LEAVING')), 'while the conversation it left is no longer followed');
  eq((await until(async () => { const g = await sessionsGet(); return g.rows?.some((r) => r.id === SESSION_B && r.known) ? g : null; }, 4000)) !== null, true,
    'the list now says the board knows that conversation');

  // Known now: reopening it again joins at the end, replaying nothing.
  rmSync(`${FIX}/ready-delay.flag`, { force: true });
  const bTailCount = () => turns('free').then((t) => (t.rows ?? []).filter((r) => (r.text ?? '').includes('B-TAIL-SEEN')).length);
  const tailBefore = await bTailCount();
  await sleep(6000);   // past the listing throttle, so the reopen's own list is fresh — and past nothing else
  const secondPick = await json('/api/floor/reopen', { channel: CH, agent: 'free', session_id: SESSION_B });
  eq((await secondPick.json()).known, true, 'a second pick of the same conversation is one the board knows');
  assert(await until(async () => { const d = deskOf(await floor(), 'free'); return d?.hosted?.session_id === SESSION_B && d?.hosted?.held === 'floor' && !paneOf().some((p) => panesAfter.includes(p)) ? true : null; }, 25000),
    'and the window is reopened on it');
  await sleep(WATCH_SETTLE_MS);
  eq(await bTailCount(), tailBefore, 'with nothing replayed');

  // Mid-turn: a window whose status line says it is working is not closed.
  // The flag is read when a window starts, so the pick that lands here opens
  // the window that then refuses the next one.
  writeFileSync(`${FIX}/busy.flag`, '1');
  // Waited on against the panes before this pick, not panesAfter: the second
  // pick's window is not in panesAfter either, so with the host's line held
  // (a /mcp reconnect waiting out its 8 s, release gate 2026-11-20) that
  // window read as this pick's, and the refusal below met the next one.
  const panesBeforeBusy = paneOf();
  const busyOpen = await json('/api/floor/reopen', { channel: CH, agent: 'free', session_id: SESSION_B });
  eq(busyOpen.status, 200, 'a pick is queued while the window is idle');
  const idBefore = deskOf(await floor(), 'free')?.hosted?.session_id;
  assert(await until(async () => { const p = paneOf(); return p.length === panesAfter.length && !p.some((x) => panesBeforeBusy.includes(x)) ? true : null; }, 25000),
    'and lands in a new window — one that now says it is working');
  await sleep(WATCH_SETTLE_MS);
  const busyPanes = paneOf();
  const busyPick = await json('/api/floor/reopen', { channel: CH, agent: 'free', session_id: SESSION_ID });
  eq(busyPick.status, 200, 'the board queues the next pick — it cannot see the pane');
  const errTurn = await until(async () => ((await turns('free')).rows ?? []).find((r) => r.role === 'error' && /not reopened/.test(r.text ?? '')) ?? null, 15000);
  assert(!!errTurn, 'the host refuses it as an error turn on the desk');
  assert(/esc to interrupt/.test(errTurn?.text ?? ''), `quoting the pane's status line — ${errTurn?.text}`);
  eq(paneOf(), busyPanes, 'and the working window is left exactly as it was');
  eq(deskOf(await floor(), 'free')?.hosted?.session_id, SESSION_B, `still on its conversation (was ${idBefore})`);

  // A model change asked of that working window: the host refuses it before
  // a key is pressed, and the board stops showing it as asked for. The error
  // names the command, which is the only way the board knows what was
  // refused; without it the select kept the model that was picked until the
  // window's model next changed (costmo, 2026-11-14).
  eq((await chat('free', '/model sonnet')).status, 200, 'a model change is queued for the working window — the board cannot see the pane');
  const busyModel = await until(async () => ((await turns('free')).rows ?? []).find((r) => r.role === 'error' && /change the model when the turn ends/.test(r.text ?? '')) ?? null, 15000);
  assert(!!busyModel, 'the host refuses it in words on the desk');
  eq(deskOf(await floor(), 'free')?.session?.model_requested ?? null, null, 'and the model is no longer asked for: the select shows what the window is on');
  eq(paneOf(), busyPanes, 'with the working window left as it was');
  rmSync(`${FIX}/busy.flag`, { force: true });

  // A fresh conversation: no --resume, and the desk follows whatever id the
  // new window announces. The working window is killed by hand first — the
  // one thing the floor will not do — and the roster it cannot unwrite is
  // cleared, as the section after this one does for the same reason.
  killTmux();
  writeFileSync(`${FIX}/roster.json`, '[]');
  await until(async () => (deskOf(await floor(), 'free')?.hosted?.held === null ? true : null), 8000);
  const argvAtNew = argvLog().length;
  const fresh = await json('/api/floor/reopen', { channel: CH, agent: 'free', session_id: null });
  eq(fresh.status, 200, 'start new is accepted');
  assert(await until(async () => (deskOf(await floor(), 'free')?.hosted?.session_id === SESSION_ID ? true : null), 25000),
    'and the desk follows the conversation the new window announces');
  const newLine = argvLog().slice(argvAtNew).trim().split('\n').pop() ?? '';
  assert(!newLine.includes('--resume'), `opened with nothing to resume — ${JSON.stringify(newLine)}`);

  /* ── the folder picker, and moving a desk to another floor ────────────────
   * The host lists one folder at a time, the way a file picker shows it, and
   * a bound folder taken onto another floor under its own name is moved:
   * rebound, and its window closed and reopened on the same conversation. */
  console.log('\nthe folder picker and moving a desk');
  const CH2 = 'host-test-2';
  const browsed = (path) => json(`/api/floor/browse?host_id=host-test-1${path ? `&path=${encodeURIComponent(path)}` : ''}`).then((r) => r.json());
  eq((await json('/api/floor/browse', { host_id: 'host-test-1', path: FIX })).status, 200, 'the floor can ask the host to list a folder');
  const rootList = await until(async () => { const g = await browsed(FIX); return g.at ? g : null; }, 15000);
  assert(!!rootList, 'and the host answers');
  eq(rootList?.path, FIX, 'with the folder it was asked for');
  const inRoot = Object.fromEntries((rootList?.entries ?? []).map((f) => [f.name, f]));
  eq(inRoot['repo-a']?.bound?.agent, 'free', 'a folder that is a desk says which');
  eq(inRoot['repo-elsewhere']?.other_board, 'http://localhost:9', 'one bound to another board says so');
  eq([inRoot['plain-git']?.bound ?? null, inRoot['plain-git']?.git], [null, true], 'an unbound checkout is plain, and known to be a checkout');
  assert(!inRoot['.claude'] && !inRoot['home'] === false, 'dotfolders are not listed');
  eq((await json('/api/floor/browse', { host_id: 'host-test-1', path: `${FIX}/repo-a` })).status, 200, 'and to open a folder inside it');
  const inner = await until(async () => { const g = await browsed(`${FIX}/repo-a`); return g.at ? g : null; }, 15000);
  eq([inner?.parent, inner?.self?.bound?.channel, (inner?.entries ?? []).map((f) => f.name)], [FIX, CH, ['src']], 'which says where it is, what it is bound as, and what is inside');
  await json('/api/floor/browse', { host_id: 'host-test-1', path: HOME });
  const outside = await until(async () => { const g = await browsed(HOME); return g.at ? g : null; }, 15000);
  assert(!outside?.error && (outside?.entries ?? []).length >= 0 && outside?.parent === FIX, 'a folder outside the roots lists like any other — the roots are where the host looks on its own, not a fence');
  await json('/api/floor/browse', { host_id: 'host-test-1', path: `${FIX}/no-such-folder` });
  const nowhere = await until(async () => { const g = await browsed(`${FIX}/no-such-folder`); return g.at ? g : null; }, 15000);
  assert(/no such folder/.test(nowhere?.error ?? ''), `a folder that does not exist says so — ${nowhere?.error}`);
  // The recent list is the host's last report, and a folder on it can be gone
  // by the time it is clicked. The open is let fail, and this is the sentence
  // the dialog then shows — so it has to say which path, not only that one failed.
  assert((nowhere?.error ?? '').includes(`${FIX}/no-such-folder`), 'and says which path, in the host\'s own words — what a stale recent folder shows');
  await json('/api/floor/browse', { host_id: 'host-test-1' });
  const home = await until(async () => { const g = await browsed(); return g.at && g.path === HOME ? g : null; }, 15000);
  eq(home?.path, HOME, 'and with no path named, the picker starts at the home folder');

  // A folder outside the roots, taken from the picker: bound, and the folder
  // becomes one of the host's roots so its rescan finds the desk.
  const OUT = resolve(`./data/host-outside-${process.pid}`);
  mkdirSync(OUT, { recursive: true });
  await json('/api/floor/browse', { host_id: 'host-test-1', path: resolve('./data') });
  assert(await until(async () => { const g = await browsed(resolve('./data')); return g.at && (g.entries ?? []).some((f) => f.path === OUT) ? true : null; }, 15000), 'the picker shows a folder outside the roots');
  const tookOut = await take({ host_id: 'host-test-1', path: OUT, channel: CH, agent: 'outsider', open: false });
  eq([tookOut.status, (await tookOut.json()).mode], [200, 'take'], 'and it can be taken');
  assert(await until(async () => (deskOf(await floor(), 'outsider')?.hosted?.live ? true : null), 20000), 'the host binds it and the desk registers — the roots were no fence');
  assert(/added .*host-outside-.* to this host's roots for this run/.test(host.log), 'the host added the folder to its roots, and said that ORCH_HOST_ROOTS is where to keep it');
  await json('/api/floor/desk/leave', { channel: CH, agent: 'outsider' });
  await until(async () => (deskOf(await floor(), 'outsider')?.hosted?.state === 'offline' ? true : null), 20000);
  rmSync(OUT, { recursive: true, force: true });

  /* ── releasing a folder from another instance ───────────────────────────────
   * A folder bound to another instance, taken here because the take names
   * the instance it is leaving (costmo, 2026-11-08; host/mcp.js has the
   * ruling). Each folder is shown by a browse first, which is how a caller
   * with no roots reaches one. What is asserted is the disk: which entries
   * went and which stayed, in both scopes, and that a refusal changed
   * nothing. The window in the folder is "the other instance's": a pane
   * this host did not open, found by its directory. */
  console.log('\nreleasing a folder from another instance');
  {
    const CHR = 'host-test-rel';
    const ELSE = 'http://localhost:9';
    const onRel = (f, agent) => f.channels.find((c) => c.channel === CHR)?.desks.find((d) => d.agent === agent);
    const takeOf = (agent) => json(`/api/floor/take?host_id=host-test-1&channel=${CHR}&agent=${agent}`).then((r) => r.json()).then((b) => b.take);
    const settled = (agent) => until(async () => { const t = await takeOf(agent); return t && t.state !== 'asked' ? t : null; }, 30000);
    const show = async (dir) => {
      await json('/api/floor/browse', { host_id: 'host-test-1', path: dir });
      return until(async () => { const g = await browsed(dir); return g.at && g.path === dir ? g : null; }, 15000);
    };
    const elsewhere = (agent, extra = {}) => JSON.stringify({
      mcpServers: { orchestratinator: { type: 'http', url: `${ELSE}/mcp`, headers: { 'X-Channel': CH, 'X-Agent': agent, 'X-Orchestratinator-Key': 'the-other-key' } }, ...extra },
    }, null, 2);
    const panesIn = (dir) => {
      try {
        return execFileSync('tmux', ['list-panes', '-s', '-t', `${TMUX_SESSION}:`, '-F', '#{pane_id} #{pane_current_path}'], { encoding: 'utf8' })
          .trim().split('\n').map((l) => l.split(' ')).filter(([, d]) => d === dir).map(([id]) => id);
      } catch { return []; }
    };

    // In its .mcp.json, beside another server and a third instance's entry.
    const relA = `${FIX}/rel-project`;
    mkdirSync(relA, { recursive: true });
    writeFileSync(`${relA}/.mcp.json`, elsewhere('rel-a', {
      github: { type: 'http', url: 'http://127.0.0.1:9/mcp' },
      third: { type: 'http', url: 'http://localhost:7/mcp', headers: { 'X-Channel': 'z', 'X-Agent': 'rel-a' } },
    }));
    const SESSION_REL = 'cccccccc-9999-3333-4444-555555555555';
    const relProject = `${HOME}/.claude/projects/${relA.replace(/[^A-Za-z0-9]/g, '-')}`;
    mkdirSync(relProject, { recursive: true });
    writeFileSync(`${relProject}/${SESSION_REL}.jsonl`, [
      JSON.stringify({ type: 'user', uuid: 'r-u1', timestamp: '2026-11-08T08:00:00Z', message: { content: 'what it was doing on the other instance' } }),
      JSON.stringify({ type: 'assistant', uuid: 'r-a1', timestamp: '2026-11-08T08:00:05Z', message: { content: [{ type: 'text', text: 'REL-TAIL-SEEN' }] } }),
      '',
    ].join('\n'));
    const shownA = await show(relA);
    eq([shownA?.self?.other_board, shownA?.self?.bound?.agent], [ELSE, 'rel-a'], 'the host shows the folder as bound to the other instance, and as whom');
    eq((await (await json('/api/floor/folders')).json()).hosts.find((h) => h.host_id === 'host-test-1')?.release, true, 'and says it can release one');
    const unasked = await take({ host_id: 'host-test-1', path: relA, channel: CHR, agent: 'rel-a', open: false });
    eq([unasked.status, (await unasked.json()).other_board], [409, ELSE], 'unasked it is refused, with the address to confirm');
    const argvAtRel = argvLog().length;
    const relTook = await take({ host_id: 'host-test-1', path: relA, channel: CHR, agent: 'rel-a', open: false, from_board: ELSE });
    eq([relTook.status, (await relTook.json()).mode], [200, 'release'], 'named, it is taken as a release');
    eq((await settled('rel-a'))?.state, 'seated', 'and the host seats it');
    eq(Object.keys(JSON.parse(readFileSync(`${relA}/.mcp.json`, 'utf8')).mcpServers), ['github', 'third'],
      'its .mcp.json lost the entry for the instance it left, and kept the other server and the third instance\'s entry');
    const relEntry = localCfg().projects?.[relA]?.mcpServers?.orchestratinator;
    eq([relEntry?.url, relEntry?.headers], [`${HOST}/mcp`, { 'X-Channel': CHR, 'X-Agent': 'rel-a', 'X-Orchestratinator-Key': KEY }],
      'and it is bound to this instance in local scope, with this host\'s key, not the one it carried');
    assert(await until(async () => (onRel(await floor(), 'rel-a')?.hosted?.live ? true : null), 20000), 'the desk is on this instance\'s floor, hosted');
    eq(onRel(await floor(), 'rel-a')?.hosted?.session_id, SESSION_REL, 'on the conversation somebody last spoke in there — the host had never watched the folder, and read it off the disk');
    const relLog = host.log.slice(host.log.lastIndexOf('rel-a: binding'));
    assert(/releasing it from http:\/\/localhost:9/.test(relLog), 'the host log says what it released it from');
    assert(/removed orchestratinator from .*rel-project\/\.mcp\.json \(kept github, third\)/.test(relLog) && /left third in .*rel-project\/\.mcp\.json alone — it points at http:\/\/localhost:7/.test(relLog),
      'what it took out of the file, and what it left there and why');
    eq(argvLog().length, argvAtRel, 'asked to open nothing, it opened no window');

    // A binding that changed between the click and the bind: the board's
    // reading is the browse, and the disk no longer says it.
    const relB = `${FIX}/rel-changed`;
    mkdirSync(relB, { recursive: true });
    writeFileSync(`${relB}/.mcp.json`, elsewhere('rel-b'));
    await show(relB);
    const moved = JSON.stringify({ mcpServers: { orchestratinator: { type: 'http', url: 'http://localhost:7/mcp', headers: { 'X-Channel': CH, 'X-Agent': 'rel-b' } } } }, null, 2);
    writeFileSync(`${relB}/.mcp.json`, moved);
    eq((await take({ host_id: 'host-test-1', path: relB, channel: CHR, agent: 'rel-b', open: false, from_board: ELSE })).status, 200, 'the board accepts a release of what it was last shown');
    const changed = await settled('rel-b');
    eq(changed?.state, 'refused', 'and the host, reading the disk, refuses it');
    assert(/^not released: .*rel-changed is bound to http:\/\/localhost:7 now, not to http:\/\/localhost:9 as it was when you asked/.test(changed?.error ?? ''), `saying what the folder is bound to now — ${changed?.error}`);
    eq(readFileSync(`${relB}/.mcp.json`, 'utf8'), moved, 'the file is as it was');
    eq(localCfg().projects?.[relB]?.mcpServers ?? null, null, 'and nothing was bound');

    // In local scope under a name of somebody's own, with a window open in
    // the folder. Working, it is refused; idle, it is closed and a window
    // opens on a new conversation, as a move between floors does.
    const relC = `${FIX}/rel-local`;
    mkdirSync(relC, { recursive: true });
    {
      const cfg = localCfg();
      cfg.projects[relC] = { mcpServers: { oldboard: { type: 'http', url: `${ELSE}/mcp`, headers: { 'X-Channel': CH, 'X-Agent': 'rel-c', 'X-Orchestratinator-Key': 'the-other-key' } } } };
      writeFileSync(`${HOME}/.claude.json`, JSON.stringify(cfg, null, 2));
    }
    execFileSync('tmux', ['new-window', '-d', '-t', `${TMUX_SESSION}:`, '-c', relC, '-n', 'rel-working', 'sh', '-c', "printf '\\n  working (esc to interrupt)\\n'; sleep 300"]);
    assert(await until(() => (panesIn(relC).length === 1 ? true : null), 8000), 'a window is open in the folder, opened by somebody else');
    await sleep(500);
    eq((await show(relC))?.self?.bound?.scope, 'local', 'the folder is shown, bound elsewhere in local scope');
    eq((await take({ host_id: 'host-test-1', path: relC, channel: CHR, agent: 'rel-c', from_board: ELSE })).status, 200, 'the board accepts it: it knows nothing of that window');
    const working = await settled('rel-c');
    assert(working?.state === 'refused' && /^not released from http:\/\/localhost:9 — the window is still working: .*esc to interrupt/.test(working.error ?? ''), `a working window is not closed: refused, quoting its status line — ${working?.error}`);
    eq(Object.keys(localCfg().projects?.[relC]?.mcpServers ?? {}), ['oldboard'], 'and its binding is untouched');
    eq(panesIn(relC).length, 1, 'with the window still there');
    for (const id of panesIn(relC)) execFileSync('tmux', ['kill-pane', '-t', id]);
    execFileSync('tmux', ['new-window', '-d', '-t', `${TMUX_SESSION}:`, '-c', relC, '-n', 'rel-idle', 'sleep', '300']);
    assert(await until(() => (panesIn(relC).length === 1 ? true : null), 8000), 'the same window, now idle');
    const idlePane = panesIn(relC)[0];
    const rosterAtRel = readFileSync(`${FIX}/roster.json`, 'utf8');
    const argvAtRelC = argvLog().length;
    await show(relC);
    eq((await take({ host_id: 'host-test-1', path: relC, channel: CHR, agent: 'rel-c', from_board: ELSE })).status, 200, 'asked again');
    eq((await settled('rel-c'))?.state, 'seated', 'it is seated');
    eq(Object.keys(localCfg().projects?.[relC]?.mcpServers ?? {}), ['orchestratinator'], 'the entry it carried under another name is gone from local scope, and this instance\'s is there');
    eq(localCfg().projects?.[relC]?.mcpServers?.orchestratinator?.url, `${HOST}/mcp`, 'pointing here');
    assert(/removed the local-scope entry "oldboard" in .*rel-local, which pointed at http:\/\/localhost:9/.test(host.log), 'the host says which entry it removed, by its name');
    assert(await until(() => { const now = panesIn(relC); return now.length === 1 && now[0] !== idlePane ? true : null; }, 30000),
      'the window that was open under the other instance is closed, and one of this host\'s is open in its place');
    // The pane is tmux's and comes first; argv.log is the stand-in's, written
    // once it has started, a moment later. Read at the pane alone, the log
    // was sometimes still empty (the main → develop merge's host run,
    // 2026-11-18: `[]`), so the row waits for the line itself.
    const relArgv = await until(() => { const l = argvLog().slice(argvAtRelC).split('\n').slice(0, -1); return l.length ? l : null; }, 8000) ?? [];
    assert(relArgv.length === 1 && !relArgv[0].includes('--resume'), `on a new conversation, like a move that closes a window — ${JSON.stringify(relArgv)}`);
    // The host's open is still waiting for that window to register (see the
    // placeholder-key case above): nothing is taken down before it has.
    assert(await until(() => {
      const id = panesIn(relC)[0];
      if (!id) return null;
      try { return execFileSync('tmux', ['show-options', '-w', '-v', '-t', id, 'remain-on-exit']).toString().trim() === 'off' ? true : null; } catch { return null; }
    }, 20000), 'and the host saw it register');

    // And the other side of a release: this host as the one being left.
    // Another instance's host rebinds the folder, and this one learns of it
    // at its next rescan, a heartbeat (60 s here) later, unless it looks.
    // Measured with two real hosts before it looked (task 292): the
    // instance that was left received the new conversation for 40 s. It
    // looks at two moments, and each is staged as that other host would
    // leave things: the local-scope entry pointing elsewhere.
    const rebindAway = (dir) => {
      const cfg = localCfg();
      cfg.projects[dir].mcpServers.orchestratinator.url = `${ELSE}/mcp`;
      writeFileSync(`${HOME}/.claude.json`, JSON.stringify(cfg, null, 2));
    };
    const relTurns = (agent) => json(`/api/floor/turns?channel=${CHR}&agent=${agent}`).then((r) => r.json()).then((b) => b.rows ?? []);
    // Work arriving for the desk: nothing is opened or typed in a folder
    // that answers to another instance now.
    rebindAway(relA);
    const argvAtGone = argvLog().length;
    await json('/api/floor/chat', { channel: CHR, agent: 'rel-a', text: 'are you still here' });
    const goneTurn = await until(async () => (await relTurns('rel-a')).find((t) => t.role === 'error' && /^not done: /.test(t.text ?? '')) ?? null, 15000);
    assert(/^not done: .*rel-project is bound to http:\/\/localhost:9 now, not host-test-rel\/rel-a on this instance/.test(goneTurn?.text ?? ''), `a message for a desk whose folder has been released elsewhere is refused on the desk, in what the disk says — ${goneTurn?.text}`);
    assert(await until(async () => (onRel(await floor(), 'rel-a')?.hosted?.state === 'offline' ? true : null), 10000), 'and the desk is let go at once, not at the next heartbeat');
    eq(argvLog().length, argvAtGone, 'no window was opened in that folder');
    // A window coming up in the folder: the one the other host opens. It is
    // found by its folder like any other, and must not be followed.
    const SESSION_THEIRS = 'dddddddd-9999-3333-4444-555555555555';
    // The folder is rebound in the same moment the other host's window comes
    // up, and not before the pane is killed and the watch settles. The
    // heartbeat's rescan drops a desk whose folder is bound elsewhere too, and
    // with the rebind first it had those two seconds and more to do it in:
    // the host's heartbeat falls about 60 s after its start, which is about
    // when this case runs, so under load it landed there in QA's merge check
    // of develop (2026-11-18) and in two of my three runs the next day, and
    // the row read red with the desk let go by the other path ("(heartbeat)"
    // in the host's log).
    const relLogFrom = host.log.length;
    for (const id of panesIn(relC)) { try { execFileSync('tmux', ['kill-pane', '-t', id]); } catch { /* gone */ } }
    await sleep(WATCH_SETTLE_MS);
    rebindAway(relC);
    writeFileSync(`${FIX}/roster.json`, JSON.stringify([...JSON.parse(rosterAtRel), { pid: process.pid, cwd: relC, kind: 'interactive', startedAt: Date.now(), sessionId: SESSION_THEIRS, name: 'theirs' }]));
    const relSeen = await until(() => (/rel-c: .*rel-local is bound to http:\/\/localhost:9 now \(a window came up in its folder\) — letting the desk go/.test(host.log) ? true : null), 10000);
    assert(relSeen, 'a window that comes up in a folder released elsewhere is not this desk\'s: the host reads the binding and lets the desk go');
    if (!relSeen) {
      const relLog = host.log.slice(relLogFrom);
      if (/dropped desk host-test-rel\/rel-c .*\(heartbeat\)/.test(relLog)) console.log('    the heartbeat\'s rescan dropped rel-c before the watch looked: a race in this case, not a fault in the watch');
      console.log(`    the host's log from the staging on:\n${relLog.split('\n').map((l) => `      ${l}`).join('\n')}`);
    }
    assert(await until(async () => (onRel(await floor(), 'rel-c')?.hosted?.state === 'offline' ? true : null), 10000), 'the desk goes offline here within the watch, not the heartbeat');
    {
      const { default: Database } = await import('better-sqlite3');
      const db = new Database(DB_PATH, { readonly: true });
      const theirs = db.prepare(`SELECT COUNT(*) AS n FROM agent_sessions WHERE session_id = ?`).get(SESSION_THEIRS).n + db.prepare(`SELECT COUNT(*) AS n FROM turns WHERE session_id = ?`).get(SESSION_THEIRS).n;
      db.close();
      eq(theirs, 0, 'and nothing of the other instance\'s conversation reached this one');
    }

    // Put away: both desks left, the windows closed, the roster as it was.
    for (const agent of ['rel-a', 'rel-c']) {
      await json('/api/floor/desk/leave', { channel: CHR, agent });
      await until(async () => (onRel(await floor(), agent)?.hosted?.state === 'offline' ? true : null), 20000);
    }
    for (const id of panesIn(relC)) { try { execFileSync('tmux', ['kill-pane', '-t', id]); } catch { /* gone */ } }
    writeFileSync(`${FIX}/roster.json`, rosterAtRel);
    for (const d of [relA, relB, relC]) rmSync(d, { recursive: true, force: true });
    rmSync(relProject, { recursive: true, force: true });
    await json('/api/floor/rescan', {});
    await sleep(WATCH_SETTLE_MS);
  }

  // Move: free's folder onto another floor, under its own name. The window
  // is held by the floor and is on SESSION_ID (the fresh conversation from
  // above). A running window keeps the headers it started with, so the move
  // closes it — and opens one on a NEW conversation there (#24 Decided 2,
  // costmo 2026-11-03: "A new session should be started instead"). It used
  // to reopen on the conversation it was on, and asking who held that
  // conversation found the window it had just closed, still in the roster:
  // refused as outside_tmux, the desk on the new floor with no window, every
  // same-conversation move on the live board from 2026-10-19 to 11-02. The
  // linger file is that window, staying in the roster after its pane is
  // killed; this case went red on it at 9d0e652.
  const sidBeforeMove = deskOf(await floor(), 'free')?.hosted?.session_id;
  eq(sidBeforeMove, SESSION_ID, 'the desk to move is on a known conversation, in a floor-held window');
  const SESSION_MOVED = 'eeeeeeee-2222-3333-4444-555555555555';
  writeFileSync(`${FIX}/linger.flag`, '4000');
  writeFileSync(`${FIX}/fresh-id.flag`, SESSION_MOVED);
  const argvAtMove = argvLog().length;
  const panesBeforeMove = paneOf();
  const movedOut = await take({ host_id: 'host-test-1', path: REPO, channel: CH2, agent: 'free' });
  eq([movedOut.status, (await movedOut.json()).mode], [200, 'move'], 'taking it onto another floor under its own name is a move');
  eq((await take({ host_id: 'host-test-1', path: REPO, channel: CH2, agent: 'renamed' })).status, 400, 'and under another name is refused — the folder names its agent');
  const onNewFloor = (f) => f.channels.find((c) => c.channel === CH2)?.desks.find((d) => d.agent === 'free');
  assert(await until(async () => (onNewFloor(await floor())?.hosted?.live ? true : null), 30000), 'the desk appears on the new floor, hosted');
  assert(/free: bound .*repo-a in local scope/.test(host.log) && /moving it from host-test\/free/.test(host.log), 'the host rebound the folder and said where from');
  // A window the floor holds that was not there before the move: for a
  // moment after the rebind the new floor's desk reads the closing window as
  // held, and a first cut of this case passed on that at 9d0e652.
  assert(await until(async () => (onNewFloor(await floor())?.hosted?.held === 'floor' && paneOf().some((p) => !panesBeforeMove.includes(p)) ? true : null), 30000),
    'one move seats it there with a window the floor holds — no second Take a desk, though the closing window was still in the roster (#24 Decided 1)');
  // One line per window started (the stand-in logs nothing else), so none at all reads as [].
  const launches = (from) => argvLog().slice(from).split('\n').slice(0, -1);
  const moveArgv = launches(argvAtMove);
  assert(moveArgv.length > 0 && moveArgv.every((l) => !l.includes('--resume')), `on a new conversation: its window opened with nothing to resume (#24 Decided 2) — ${JSON.stringify(moveArgv)}`);
  assert(await until(async () => (onNewFloor(await floor())?.hosted?.session_id === SESSION_MOVED ? true : null), 30000),
    'and the desk follows the conversation the new window announces');
  // Nothing pins the conversation it left to the new floor, even for the
  // moment before the new window registers: a `bound` naming it is filed as
  // that conversation's session on the new desk, and the row stays — the
  // floor would then hold a conversation that never ran there. (A mutant
  // that put the old id back on `bound` survived every other assertion here,
  // because the new window's session overwrites the desk a moment later.)
  {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(DB_PATH, { readonly: true });
    const onNew = db.prepare(`SELECT session_id FROM agent_sessions WHERE channel = ? AND agent = ?`).all(CH2, 'free').map((r) => r.session_id);
    // This row has gone red by itself six times (CLAUDE.md, Tests), each
    // time green on the next run, and each time nobody read the rows,
    // because by then they were gone with the run's database. So a red
    // reads them itself. A session row is keyed by its id alone, so "on the
    // new floor" means something filed under the old conversation's id
    // named the new floor, after the move. The row's times against the
    // board's clock say when, the turns filed under that id say whether it
    // was a turn (and on which floor) or an event that writes none, and the
    // host's log from the move on says what the host was doing.
    const read = !onNew.includes(SESSION_ID) ? null : {
      row: db.prepare(`SELECT channel, agent, started_at, updated_at, ended_at, transcript FROM agent_sessions WHERE session_id = ?`).get(SESSION_ID),
      clock: db.prepare(`SELECT datetime('now') AS t`).get().t,
      turns: db.prepare(`SELECT id, channel, agent, role, tool_name, created_at, substr(text, 1, 60) AS text FROM turns WHERE session_id = ? ORDER BY id DESC LIMIT 8`).all(SESSION_ID),
    };
    db.close();
    assert(!read, `the new floor holds no session row for the conversation it left — ${JSON.stringify(onNew)}`);
    if (read) {
      const say = (l) => console.log(`      · ${l}`);
      say(`the row, read at ${read.clock} by the board's clock: ${JSON.stringify(read.row)}`);
      say(`the newest turns filed under that id (${read.turns.length}, newest first):`);
      for (const t of read.turns) say(`  ${JSON.stringify(t)}`);
      say('the host log from the move on:');
      for (const l of host.log.slice(host.log.lastIndexOf('moving it from host-test/free')).split('\n').filter(Boolean).slice(0, 40)) say(`  ${l.slice(0, 200)}`);
    }
  }
  const turnsOnNew = await json(`/api/floor/turns?channel=${CH2}&agent=free`).then((r) => r.json());
  eq((turnsOnNew.rows ?? []).filter((r) => r.role === 'error').map((r) => r.text), [], 'its chat on the new floor does not open on a refusal (#24 Decided 2)');
  assert(!/outside tmux/.test(host.log.slice(host.log.lastIndexOf('moving it from host-test/free'))), 'and the host refused nothing on the way');
  await json('/api/floor/sessions', { channel: CH2, agent: 'free' });
  const leftBehind = await until(async () => { const g = await json(`/api/floor/sessions?channel=${CH2}&agent=free`).then((r) => r.json()); return g.at && (g.rows ?? []).some((r) => r.id === SESSION_ID) ? g : null; }, 15000);
  assert(!!leftBehind, 'the conversation it was on stays in its folder — the session picker on the new floor lists it (#24 Decided 2)');
  eq(deskOf(await floor(), 'free') ?? null, null, 'and its seat has left the old floor');
  eq(localCfg().projects?.[REPO]?.mcpServers?.orchestratinator?.headers?.['X-Channel'], CH2, 'the binding on disk names the new floor');
  rmSync(`${FIX}/fresh-id.flag`, { force: true });

  // And back, so the sections below find it where they expect it — a new
  // conversation again, which this stand-in announces as SESSION_ID.
  const argvAtBack = argvLog().length;
  const back = await take({ host_id: 'host-test-1', path: REPO, channel: CH, agent: 'free' });
  eq((await back.json()).mode, 'move', 'moving it back is a move too');
  assert(await until(async () => (deskOf(await floor(), 'free')?.hosted?.held === 'floor' && deskOf(await floor(), 'free')?.hosted?.session_id === SESSION_ID ? true : null), 30000),
    'and it is home, with a window, on the conversation that window announces');
  const backArgv = launches(argvAtBack);
  assert(backArgv.length > 0 && backArgv.every((l) => !l.includes('--resume')), `opened with nothing to resume, like the move out — ${JSON.stringify(backArgv)}`);
  rmSync(`${FIX}/linger.flag`, { force: true });
  await sleep(WATCH_SETTLE_MS);

  // A move whose window is already closed opens on the agent's last
  // conversation, as it always has (#24 Decided 3, costmo 2026-11-03: "Last
  // conversation") — there is no closing window for the open to meet. The
  // window is killed by hand, the one thing the floor will not do, and the
  // roster the stand-in cannot unwrite is cleared, as the picker section does.
  const closeByHand = async (on = (f) => deskOf(f, 'free')) => {
    killTmux();
    writeFileSync(`${FIX}/roster.json`, '[]');
    return until(async () => (on(await floor())?.hosted?.held === null ? true : null), 8000);
  };
  assert(await closeByHand(), 'with its window closed by hand, the desk is held by nobody');
  const argvAtClosed = argvLog().length;
  const logAtMove = hostLog.length;
  eq((await (await take({ host_id: 'host-test-1', path: REPO, channel: CH2, agent: 'free' })).json()).mode, 'move', 'moving a desk whose window is closed is a move');
  assert(await until(async () => { const d = onNewFloor(await floor()); return d?.hosted?.held === 'floor' && d.hosted.session_id === SESSION_ID ? true : null; }, 30000),
    'it opens on the new floor with a window, on its last conversation (#24 Decided 3)');
  const closedArgv = launches(argvAtClosed);
  assert(closedArgv.length === 1 && closedArgv[0].includes(`--resume ${SESSION_ID}`), `resumed by its id, not started fresh — ${JSON.stringify(closedArgv)}`);

  // A real second holder is still refused (#24 Don't break). The move above
  // never asks who holds the conversation a closing window was on; this
  // path does, and an editor holding it is a copy nobody is watching, so
  // the open says so rather than starting a second one. The editor is a
  // process outside tmux claiming the conversation — what holderOf reads.
  // Red twice on 2026-11-18 (the round's first host run, and a mutant run
  // whose mutant was in host/node.sh), green alone after; the rows after it
  // pass, so the floor did see the window go, only not inside 8 s. On a red
  // the host's log since the move and what the floor last showed are
  // printed, so the next sighting is read rather than rerun.
  const logAtClose = hostLog.length;
  const closedAgain = await closeByHand(onNewFloor);
  assert(closedAgain, 'its window closed by hand again');
  if (!closedAgain) {
    console.log(`    the floor still shows: ${JSON.stringify(onNewFloor(await floor())?.hosted ?? null)}`);
    console.log(`    the host's log since the move:\n${hostLog.slice(logAtMove).split('\n').map((l) => `      ${l}`).join('\n')}`);
    console.log(`    (of which after the close: ${hostLog.length - logAtClose} chars)`);
  }
  const editor = spawn('sleep', ['120'], { stdio: 'ignore' });
  writeFileSync(`${FIX}/roster.json`, JSON.stringify([{ pid: editor.pid, cwd: REPO, kind: 'interactive', startedAt: 2, sessionId: SESSION_ID, name: 'an editor' }]));
  assert(await until(async () => (onNewFloor(await floor())?.hosted?.held === 'editor' ? true : null), 8000), 'and the conversation is open in an editor');
  const argvAtEditor = argvLog().length;
  const editorMove = await take({ host_id: 'host-test-1', path: REPO, channel: CH, agent: 'free' });
  eq([editorMove.status, (await editorMove.json()).mode], [200, 'move'], 'a desk an editor holds can be moved — the editor\'s chat follows the binding on its own');
  const refusedHere = await until(async () => ((await turns('free')).rows ?? []).find((r) => r.role === 'error' && r.text?.includes(`outside tmux (pid ${editor.pid})`)) ?? null, 20000);
  assert(!!refusedHere, `but no second copy is opened beside it — refused, naming the editor's pid (#24 Don't break) — ${refusedHere?.text?.slice(0, 120)}`);
  eq(launches(argvAtEditor), [], 'and no window was started');
  editor.kill();
  writeFileSync(`${FIX}/roster.json`, '[]');
  assert(await until(async () => (deskOf(await floor(), 'free')?.hosted?.held === null ? true : null), 8000), 'the editor gone, nothing holds it');

  // A window that is working is not moved (#24 Don't break): the host reads
  // the pane before it touches the binding, and quotes it. The board cannot
  // see the stand-in's status line, so the take is accepted and the host is
  // the one that refuses.
  writeFileSync(`${FIX}/busy.flag`, '1');
  eq((await json('/api/floor/open', { channel: CH, agent: 'free' })).status, 200, 'a window is opened on it again, and this one is working');
  assert(await until(async () => (deskOf(await floor(), 'free')?.hosted?.held === 'floor' ? true : null), 30000), 'held by the floor');
  await sleep(WATCH_SETTLE_MS);
  const busyPanesBefore = paneOf();
  const errorIds = async (ch) => new Set(((await json(`/api/floor/turns?channel=${ch}&agent=free`).then((r) => r.json())).rows ?? []).filter((r) => r.role === 'error').map((r) => r.id));
  const [errorsHereBefore, errorsThereBefore] = [await errorIds(CH), await errorIds(CH2)];
  eq((await take({ host_id: 'host-test-1', path: REPO, channel: CH2, agent: 'free' })).status, 200, 'the board takes the move — it cannot see the pane');
  // Said on the floor the desk is still on, which is the one the board has a
  // hosted row for. It used to be said for the target desk, which has no row
  // until `bound`, so the board dropped it and no floor said anything — this
  // case read the refusal off the host's log and passed (QA, PR #33 finding 1).
  const refusedMove = await until(async () => ((await json(`/api/floor/turns?channel=${CH}&agent=free`).then((r) => r.json())).rows ?? [])
    .find((r) => r.role === 'error' && !errorsHereBefore.has(r.id)) ?? null, 15000);
  assert(/^not moved to host-test-2 — the window is still working: .*esc to interrupt/.test(refusedMove?.text ?? ''),
    `the host refuses it, and the floor the desk is still on says so — naming where it was going, quoting the pane's status line (PR #33 finding 1) — ${refusedMove?.text}`);
  eq([...(await errorIds(CH2))].filter((id) => !errorsThereBefore.has(id)), [], 'and nothing is said for a desk on the floor it did not reach');
  eq(paneOf(), busyPanesBefore, 'and the working window is left exactly as it was');
  eq(localCfg().projects?.[REPO]?.mcpServers?.orchestratinator?.headers?.['X-Channel'], CH, 'and the binding is not touched');
  rmSync(`${FIX}/busy.flag`, { force: true });

  // Home, on its conversation, with a window that is not working, for the
  // sections below.
  assert(await closeByHand(), 'the working window is closed by hand');
  eq((await json('/api/floor/open', { channel: CH, agent: 'free' })).status, 200, 'and a quiet one opened');
  assert(await until(async () => { const d = deskOf(await floor(), 'free'); return d?.hosted?.held === 'floor' && d.hosted.session_id === SESSION_ID ? true : null; }, 30000), 'home, on its conversation');
  await sleep(WATCH_SETTLE_MS);

  /* ── reading a conversation whole (issue #8, Remaining 4) ──────────────────
   * A conversation opened to read is the host reading the transcript from
   * its first record — its subagents' files with it — and nothing else: no
   * window closes, opens or moves, and the desk stays on its own
   * conversation. The fixture has one of every kind of turn, a subagent,
   * and more turns than a page holds. */
  /* ── an answer that waited in the host's line (QA, PR #49) ─────────────
   * The host takes its work one item at a time, so an answer can wait past
   * ANSWER_TTL_MS behind other items — a meeting room's message to several
   * desks on one host makes that likelier. Past it, an answer is pressed
   * only while the window still shows what it was for (askedStill): a form
   * by its header or choices, a permission menu by its choices and its
   * command. This host runs with the TTL at -1, so every answer here is old.
   * The window is the stand-in with prompt.flag: drawn once, never redrawn. */
  console.log('\nan answer that waited in the host\'s line');
  {
    const sinkAt = () => (existsSync(SINK) ? readFileSync(SINK, 'utf8').length : 0);
    const reopenAsking = async (kind) => {
      assert(await closeByHand(), `the window is closed by hand (${kind})`);
      writeFileSync(`${FIX}/prompt.flag`, kind);
      eq((await json('/api/floor/open', { channel: CH, agent: 'free' })).status, 200, `and one is opened that is asking (${kind})`);
      assert(await until(async () => { const d = deskOf(await floor(), 'free'); return d?.hosted?.held === 'floor' && d.hosted.session_id === SESSION_ID ? true : null; }, 30000), 'held by the floor, on its conversation');
      await sleep(WATCH_SETTLE_MS);
    };
    const askBash = async (command) => {
      await json('/api/ingest', { channel: CH, agent: 'free', session_id: SESSION_ID, hook_event_name: 'PermissionRequest', cwd: REPO, tool_name: 'Bash', tool_input: { command } });
      return until(async () => { const p = deskOf(await floor(), 'free')?.permission; return p && (p.summary ?? '').includes(command) && (p.options?.length ?? 0) >= 3 ? p : null; }, 25000);
    };
    await reopenAsking('bash');

    // Press yes / no (milestone audit 2026-11-17, finding 3): the floor's
    // answer for a prompt it could not read. Route, host and window: the
    // desk is waiting (a Notification with nothing parsed), the operator
    // presses, and the window is sent the key the host maps it to. Yes is
    // the menu's first row; no is Escape, which cancels.
    await json('/api/ingest', { channel: CH, agent: 'free', session_id: SESSION_ID, hook_event_name: 'Notification', cwd: REPO, notification_type: 'permission_prompt', notification_message: 'Claude needs your permission' });
    let pressAt = sinkAt();
    eq((await json('/api/floor/press', { channel: CH, agent: 'free', choice: 'yes' })).status, 200, 'Press yes is taken for a desk that is waiting');
    assert(await until(async () => (sinkAt() > pressAt ? true : null), 10000), 'and a key reaches the window');
    eq(readFileSync(SINK, 'utf8').slice(pressAt), '1', 'and the key for yes is the first row, 1');
    await json('/api/ingest', { channel: CH, agent: 'free', session_id: SESSION_ID, hook_event_name: 'Notification', cwd: REPO, notification_type: 'permission_prompt', notification_message: 'Claude needs your permission' });
    pressAt = sinkAt();
    eq((await json('/api/floor/press', { channel: CH, agent: 'free', choice: 'no' })).status, 200, 'Press no is taken');
    assert(await until(async () => (sinkAt() > pressAt ? true : null), 10000), 'and a key reaches the window');
    eq(readFileSync(SINK, 'utf8').slice(pressAt), '\u001b', 'and the key for no is Escape, which cancels; never a row that could approve');
    await json('/api/ingest', { channel: CH, agent: 'free', session_id: SESSION_ID, hook_event_name: 'PreToolUse', cwd: REPO, tool_name: 'Bash', tool_input: { command: 'true' } });

    let p = await askBash('rm -rf build-cache');
    assert(!!p, 'the host reads the menu\'s choices off the window');
    let sink0 = sinkAt();
    let log0 = hostLog.length;
    eq((await json('/api/floor/permission', { channel: CH, agent: 'free', request_id: p?.request_id, decision: 'allow' })).status, 200, 'Approve is queued');
    assert(await until(async () => (hostLog.slice(log0).includes('permission answer, and its prompt is still on screen — answering it') ? true : null), 15000),
      'an old decision whose prompt — its choices and its command — is still on screen is pressed, and the log says why (finding 2)');
    assert(await until(async () => (sinkAt() > sink0 ? true : null), 8000), 'and its key reached the window');
    p = await askBash('npm publish --tag next');
    assert(!!p, 'a second prompt arrives, for another command');
    await sleep(1000);
    sink0 = sinkAt();
    log0 = hostLog.length;
    await json('/api/floor/permission', { channel: CH, agent: 'free', request_id: p?.request_id, decision: 'allow' });
    assert(await until(async () => (hostLog.slice(log0).includes('permission answer — its prompt is no longer on screen') ? true : null), 15000),
      'an old approve for a command the window is not asking about is dropped: the same menu, another command');
    await sleep(800);
    eq(sinkAt(), sink0, 'and not one key was pressed');

    await reopenAsking('form');
    await json('/api/ingest', { channel: CH, agent: 'free', session_id: SESSION_ID, hook_event_name: 'PermissionRequest', cwd: REPO, tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which scope should step one audit?', header: 'Scope', multiSelect: false,
        options: [{ label: 'Baseline only', description: 'Audit just the baseline.' }, { label: 'Everything in the tree', description: 'Audit everything in the tree.' }] }] } });
    const f = await until(async () => { const q = deskOf(await floor(), 'free')?.permission; return q?.questions?.length ? q : null; }, 25000);
    assert(!!f, 'the form is on the desk');
    sink0 = sinkAt();
    log0 = hostLog.length;
    eq((await json('/api/floor/answer', { channel: CH, agent: 'free', request_id: f?.request_id, answers: [{ choose: [1] }] })).status, 200, 'its answer is queued');
    assert(await until(async () => (hostLog.slice(log0).includes('-old answer, and its question is still on screen — answering it') ? true : null), 15000),
      'an old answer whose form is still on screen is pressed — this call site, not only askedStill (Info 4)');
    assert(await until(async () => (sinkAt() > sink0 ? true : null), 8000), 'and its keys reached the window');

    // A preview question the host could not answer is said as a form that
    // was not submitted, not as answers that did not land (QA, PR #55 Info
    // 8). The stand-in never redraws, so the cursor stays on row 1 whatever
    // digit is sent: the host reads that, presses no Enter, and the desk is
    // told the form is still standing. "Did not land" was once said about
    // answers that had landed (issue #7), and here nothing was chosen at all.
    await reopenAsking('preview');
    await json('/api/ingest', { channel: CH, agent: 'free', session_id: SESSION_ID, hook_event_name: 'PermissionRequest', cwd: REPO, tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Where should it go?', header: 'Where', multiSelect: false,
        options: [{ label: 'Alpha', description: 'First.', preview: true }, { label: 'Bravo', description: 'Second.', preview: true }, { label: 'Charlie', description: 'Third.', preview: true }] }] } });
    const pv = await until(async () => { const q = deskOf(await floor(), 'free')?.permission; return q?.questions?.[0]?.tab_title === 'Where' ? q : null; }, 25000);
    assert(!!pv, 'a question with previews is on the desk');
    eq(pv?.questions?.[0]?.options?.length, 3, 'with its three rows and no free-text row, as the window draws it');
    const errsBefore = new Set(((await turns('free')).rows ?? []).filter((r) => r.role === 'error').map((r) => r.id));
    eq((await json('/api/floor/answer', { channel: CH, agent: 'free', request_id: pv?.request_id, answers: [{ choose: [2] }] })).status, 200, 'its answer is queued');
    const unplaced = await until(async () => ((await turns('free')).rows ?? []).find((r) => r.role === 'error' && !errsBefore.has(r.id)) ?? null, 20000);
    assert(/^the form was not submitted — this question takes a number as a move and Enter as the choice, and the cursor was not seen on row 2/.test(unplaced?.text ?? ''),
      `a preview question whose cursor never reached the row is said as a form not submitted — ${unplaced?.text ?? 'no error turn'}`);

    // A board restart (every deploy) while the window is still asking
    // (milestone audit 2026-11-17, finding 1, probe P3). The board keeps open
    // prompts in memory only, and a window standing on a question sends no
    // further hook, so the floor lost the question for good. The host's work
    // poll fails at the restart, it re-registers at once, and that heartbeat
    // says which of its windows are asking (`pending`): the board raises the
    // question again and asks the host to read it off the pane.
    const restarted = server;
    await new Promise((done) => { restarted.once('exit', done); restarted.kill('SIGTERM'); });
    server = startServer();
    assert(await waitHealthy(), 'the board restarts on the same database');
    const back = await until(async () => { const q = deskOf(await floor(), 'free')?.permission; return q?.questions?.[0]?.tab_title === 'Where' ? q : null; }, 30000);
    assert(!!back, 'and the question the window is still asking is back on the floor, read off the pane, with no hook to say it');
    // Closed by the window's own work, as any prompt is: the session the
    // host named is the window's.
    await json('/api/ingest', { channel: CH, agent: 'free', session_id: SESSION_ID, hook_event_name: 'PreToolUse', cwd: REPO, tool_name: 'Bash', tool_input: { command: 'true' } });
    assert(await until(async () => (deskOf(await floor(), 'free')?.permission ? null : true), 8000), 'and closed by the window\'s own next tool call, so nothing is left standing for the sections after');

    rmSync(`${FIX}/prompt.flag`, { force: true });
    assert(await closeByHand(), 'the asking window is closed by hand');
    eq((await json('/api/floor/open', { channel: CH, agent: 'free' })).status, 200, 'and a quiet one opened');
    assert(await until(async () => { const d = deskOf(await floor(), 'free'); return d?.hosted?.held === 'floor' && d.hosted.session_id === SESSION_ID ? true : null; }, 30000), 'home again, on its conversation');
    await sleep(WATCH_SETTLE_MS);
  }

  console.log('\nreading a conversation whole');
  const SESSION_C = 'cccccccc-2222-3333-4444-555555555555';
  const cPath = `${HOME}/.claude/projects/${slug()}/${SESSION_C}.jsonl`;
  const rec = (o) => JSON.stringify(o);
  writeFileSync(cPath, [
    rec({ type: 'user', uuid: 'c1', timestamp: '2026-09-08T09:00:00Z', message: { content: [{ type: 'text', text: '<ide_opened_file>z.js</ide_opened_file>' }, { type: 'text', text: 'C-FIRST-WORDS' }] } }),
    rec({ type: 'assistant', uuid: 'c2', timestamp: '2026-09-08T09:00:02Z', message: { content: [{ type: 'thinking', thinking: 'C-A-THOUGHT' }, { type: 'text', text: 'C-REPLY-ONE' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls C-DIR' } }] } }),
    rec({ type: 'user', uuid: 'c3', timestamp: '2026-09-08T09:00:10Z', message: { content: 'C-SECOND-WORDS' } }),
    rec({ type: 'assistant', uuid: 'c4', timestamp: '2026-09-08T09:00:20Z', message: { content: [{ type: 'text', text: 'C-LAST-WORD' }] } }),
    '',
  ].join('\n'));
  mkdirSync(`${cPath.slice(0, -'.jsonl'.length)}/subagents`, { recursive: true });
  writeFileSync(`${cPath.slice(0, -'.jsonl'.length)}/subagents/agent-s1.jsonl`,
    `${rec({ type: 'assistant', uuid: 'cs1', isSidechain: true, timestamp: '2026-09-08T09:00:05Z', message: { content: [{ type: 'text', text: 'C-SUBAGENT-SEARCHING' }] } })}\n`);
  writeFileSync(`${cPath.slice(0, -'.jsonl'.length)}/subagents/agent-s1.meta.json`, JSON.stringify({ description: 'Find the C thing', agentType: 'Explore' }));
  const readGetC = (id = SESSION_C, extra = '') => json(`/api/floor/read?channel=${CH}&agent=free&session=${id}${extra}`).then((r) => r.json());
  const deskBeforeRead = deskOf(await floor(), 'free')?.hosted;
  const panesBeforeRead = paneOf();
  const argvBeforeRead = argvLog().length;
  const turnsBeforeRead = ((await turns('free')).rows ?? []).length;
  const askedRead = await json('/api/floor/read', { channel: CH, agent: 'free', session_id: SESSION_C });
  eq(askedRead.status, 200, 'the floor can ask a desk\'s host to read one of its conversations whole');
  const whole = await until(async () => { const g = await readGetC(); return g.done ? g : null; }, 15000);
  assert(!!whole && !whole.error, `and the host answers with all of it — ${whole?.error ?? `${whole?.total} turns`}`);
  eq((whole?.rows ?? []).map((r) => `${r.role}|${r.text}|${r.via ?? ''}`), [
    'context|<ide_opened_file>z.js</ide_opened_file>|', 'user|C-FIRST-WORDS|', 'thinking|C-A-THOUGHT|', 'assistant|C-REPLY-ONE|', 'tool|Bash: ls C-DIR|',
    'assistant|C-SUBAGENT-SEARCHING|Find the C thing', 'user|C-SECOND-WORDS|', 'assistant|C-LAST-WORD|',
  ], 'from its first word to its last, in the order things were said: the injected context, a thought, a tool call, and the subagent\'s words under its description, between the turns either side of it');
  eq([whole?.rows?.[1]?.created_at, whole?.rows?.at(-1)?.created_at], ['2026-09-08T09:00:00Z', '2026-09-08T09:00:20Z'], 'each dated when it was said');
  assert(new RegExp(`free: read ${SESSION_C} whole for the floor — 8 turns`).test(host.log), 'the host log says what it read');
  eq((await readGetC(SESSION_C, '&from=3&limit=2')).rows.map((r) => r.text), ['C-REPLY-ONE', 'Bash: ls C-DIR'], 'eight turns at three to a page arrived as one conversation, and can be read back in pages');
  const deskAfterRead = deskOf(await floor(), 'free')?.hosted;
  eq([deskAfterRead?.session_id, deskAfterRead?.held, paneOf(), argvLog().length], [deskBeforeRead?.session_id, deskBeforeRead?.held, panesBeforeRead, argvBeforeRead],
    'and nothing moved: the desk is on the conversation it was on, in the window it was in, and no window was opened or closed — reading is not resuming');
  await sleep(WATCH_SETTLE_MS);
  const afterRead = (await json(`/api/floor/turns?channel=${CH}&agent=free&limit=500`).then((r) => r.json())).rows ?? [];
  eq([afterRead.length, afterRead.some((r) => (r.text ?? '').includes('C-FIRST-WORDS'))], [turnsBeforeRead, false], 'nor did any of it become the desk\'s own turns');
  await json('/api/floor/read', { channel: CH, agent: 'free', session_id: 'no-such-conversation' });
  const missing = await until(async () => { const g = await readGetC('no-such-conversation'); return g.done ? g : null; }, 15000);
  assert(/no conversation no-such-conversation in .*repo-a/.test(missing?.error ?? ''), `a conversation that is not in the desk's folder is said as that, naming the folder — ${missing?.error}`);

  /* ── history across every desk (issue #8, Remaining 2 and 3) ───────────────
   * The recent list and the search are both read off the transcripts in the
   * desks' folders by the real host — the search in a process of its own —
   * and come back as events. The fixture conversation above has a word only
   * the person said, one only the agent said, one only in a tool call, one
   * only in a thought and one only in a subagent's transcript, so each
   * choice of what a search covers has a hit that proves it. */
  {
    console.log('\nhistory across every desk');
    const hGet = (path) => json(`/api/floor/history/${path}`).then((r) => r.json());
    const search = async (query, deep = false) => {
      const asked = await (await json('/api/floor/history/search', { query, deep })).json();
      return until(async () => { const g = await hGet(`search?id=${asked.id}`); return g.done ? g : null; }, 20000);
    };
    const askedRecent = await (await json('/api/floor/history/recent', {})).json();
    eq(askedRecent.asked, ['Test Mac'], 'the floor asks the host for its recent conversations');
    const rec = await until(async () => { const g = await hGet('recent'); return g.hosts.find((h) => h.host_id === 'host-test-1')?.at ? g : null; }, 15000);
    const recC = rec?.rows.find((r) => r.id === SESSION_C);
    eq([recC?.channel, recC?.agent, recC?.title, recC?.started_at, recC?.last_at, recC?.host], [CH, 'free', 'C-FIRST-WORDS', '2026-09-08T09:00:00Z', '2026-09-08T09:00:20Z', 'Test Mac'],
      'and the host answers with every desk\'s conversations, each naming its desk, with the title and times its own transcript gives');
    const order = (rec?.rows ?? []).map((r) => Date.parse(r.last_at ?? r.modified_at));
    assert(order.length >= 3 && order.every((t, i) => i === 0 || order[i - 1] >= t), `most recently spoken in first — ${rec?.rows.map((r) => r.id.slice(0, 8)).join(', ')}`);
    eq(new Set((rec?.rows ?? []).map((r) => `${r.channel}/${r.agent}/${r.id}`)).size, rec?.rows.length, 'each conversation once, under the one desk its folder is');

    let got = await search('c-last-word');
    eq([got?.rows.map((r) => `${r.id}:${r.channel}/${r.agent}:${r.hits}`), got?.rows[0]?.snippets.map((sn) => `${sn.role}|${sn.text}`)], [[`${SESSION_C}:${CH}/free:1`], ['assistant|C-LAST-WORD']],
      'a search finds what the agent said, whatever the case it is typed in, and quotes it');
    const hostLine = got?.hosts.find((h) => h.host_id === 'host-test-1');
    assert(hostLine?.at && hostLine.files >= 3 && Number.isInteger(hostLine.ms) && !hostLine.error, `saying which host answered, over how many transcripts, in how long — ${hostLine?.files} files, ${hostLine?.ms} ms`);
    assert(/search: "c-last-word" — 1 conversation in \d+ files/.test(host.log), 'the host log says what was searched for and what it found');
    got = await search('C-SECOND-WORDS');
    eq(got?.rows.map((r) => `${r.id}:${r.snippets[0]?.role}`), [`${SESSION_C}:user`], 'and what the person said');
    eq([(await search('ls C-DIR'))?.rows.length, (await search('C-A-THOUGHT'))?.rows.length, (await search('C-SUBAGENT-SEARCHING'))?.rows.length], [0, 0, 0],
      'a word that is only in a tool call, only in a thought, or only in a subagent\'s transcript is not found by a plain search — that is the stated half');
    got = await search('ls C-DIR', true);
    eq(got?.rows.map((r) => `${r.id}:${r.snippets[0]?.role}:${r.snippets[0]?.text}`), [`${SESSION_C}:tool:Bash ls C-DIR`], 'with tool calls and thinking included it is: the tool call, by its name and what it was given');
    eq((await search('C-A-THOUGHT', true))?.rows.map((r) => r.snippets[0]?.role), ['thinking'], 'the thought');
    got = await search('c-subagent-searching', true);
    eq(got?.rows.map((r) => `${r.snippets[0]?.role}|${r.snippets[0]?.via}`), ['assistant|Find the C thing'], 'and the subagent\'s words, under its description');
    eq((await search('zz-no-such-words-anywhere'))?.rows, [], 'a search that finds nothing answers with nothing, and is still an answer');
    // The module itself, run the way the host runs it — its own process, asked
    // on stdin — with one folder named twice, as a board's table of every desk
    // a folder has ever been would name it.
    const twice = JSON.parse(execFileSync(process.execPath, ['host/history.js'], {
      input: JSON.stringify({ query: 'c-last-word', deep: false, desks: [{ channel: CH, agent: 'free', cwd: REPO }, { channel: 'another-floor', agent: 'same-folder', cwd: REPO }] }),
      env: { ...process.env, HOME, ORCH_HOST_CLAUDE: `${FIX}/claude`, ORCH_TMUX_SESSION: TMUX_SESSION },
      encoding: 'utf8',
    }));
    eq([twice.rows.map((r) => `${r.channel}/${r.agent}`), twice.files], [[`${CH}/free`], rec?.rows.filter((r) => r.agent === 'free').length],
      'a folder named twice is read once and its conversations listed once, under the first desk to name it — not every file twice and every result twice over');
    // Past its limit a list is cut, and it is cut after it is put in order:
    // the fixture's conversation C is the newest *file* and the one spoken in
    // longest ago, so a list cut in file order would keep exactly the wrong one.
    const ask = (body) => JSON.parse(execFileSync(process.execPath, ['host/history.js'], {
      input: JSON.stringify({ desks: [{ channel: CH, agent: 'free', cwd: REPO }], ...body }),
      env: { ...process.env, HOME, ORCH_HOST_CLAUDE: `${FIX}/claude`, ORCH_TMUX_SESSION: TMUX_SESSION }, encoding: 'utf8',
    }));
    const newestSpoken = rec?.rows.filter((r) => r.agent === 'free')[0]?.id;
    assert(newestSpoken && newestSpoken !== SESSION_C, `the conversation spoken in most recently is not the newest file — ${newestSpoken?.slice(0, 8)}`);
    eq(ask({ op: 'recent', max: 1 }).rows.map((r) => r.id), [newestSpoken], 'a recent list cut to its limit keeps the conversations spoken in most recently, not the files written most recently');
    // "on" is in what the person said in C ("C-SECOND-WORDS") and in a
    // conversation spoken in since ("the other conversation begins").
    const both = ask({ query: 'on' }).rows.map((r) => r.id);
    assert(both.includes(SESSION_C) && both.length >= 2 && both[0] !== SESSION_C, `a search that finds C and a conversation spoken in since lists the later one first — ${both.map((id) => id.slice(0, 8)).join(', ')}`);
    eq(ask({ query: 'on', max: 1 }).rows.map((r) => r.id), [both[0]], 'and cut to its limit it keeps that one, not the newest file');
    const deskAfterSearch = deskOf(await floor(), 'free')?.hosted;
    eq([deskAfterSearch?.session_id, paneOf()], [deskBeforeRead?.session_id, panesBeforeRead], 'none of which moved the desk or its window');
  }

  /* ── the host's own folder dialog (issue #4, items 1 and 2) ────────────────
   * The picker is one function in the host with each operating system's own
   * dialog behind it (host/dialog.js). What is real here: the work item, the
   * child process, the three things the host says while a person chooses, the
   * listing a chosen folder arrives as, and the take that follows. What is
   * stood in for is the person — see the fixture's dialog. That the real
   * macOS dialog takes the front from this host's LaunchAgent is not
   * something a suite can see: it was measured on a real desktop, and the
   * measurement is in host/dialog.js. */
  console.log('\nthe host\'s own folder dialog');
  const dialogLog = () => (existsSync(`${FIX}/dialog.log`) ? readFileSync(`${FIX}/dialog.log`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const person = (a) => writeFileSync(`${FIX}/dialog-answer.json`, JSON.stringify(a));
  const pickGet = () => json('/api/floor/pick?host_id=host-test-1').then((r) => r.json());
  const pickAsk = (start) => json('/api/floor/pick', { host_id: 'host-test-1', ...(start ? { start } : {}) });
  const pickAt = async () => (await pickGet()).at ?? null;
  const settled = (after) => until(async () => { const g = await pickGet(); return g.at && g.at !== after && g.state !== 'open' ? g : null; }, 15000);
  eq((await (await json('/api/floor/folders')).json()).hosts.find((h) => h.host_id === 'host-test-1')?.dialog, true,
    'the host says it can show a folder dialog, so the page offers the button rather than its own list');

  // Chosen: a folder two levels down that nothing has listed — not a
  // checkout, never opened, so absent from the flat list, and never browsed.
  const PICKED = `${FIX}/picked-deep/inner`;
  mkdirSync(PICKED, { recursive: true });
  person({ path: PICKED });
  let pickBefore = await pickAt();
  eq((await pickAsk(`${FIX}/repo-a`)).status, 200, 'the floor can ask the host to open its folder dialog');
  let pickGot = await settled(pickBefore);
  eq([pickGot?.state, pickGot?.path, pickGot?.parent], ['chosen', PICKED, `${FIX}/picked-deep`], 'and the host answers with the folder chosen in it, and the folder that one sits in');
  eq(dialogLog().at(-1)?.start, `${FIX}/repo-a`, 'the dialog opened where it was asked to: the folder the last choice was made in');
  const pickedListing = await browsed(PICKED);
  eq([pickedListing.path, pickedListing.self?.name, pickedListing.self?.bound ?? null, pickedListing.self?.git], [PICKED, 'inner', null, false],
    'the chosen folder arrives with the host\'s own record of it — the same listing the page\'s list produces, which is what says whether it is already a desk');
  assert(/opened the folder dialog at .*repo-a/.test(host.log) && /the folder dialog chose .*picked-deep\/inner/.test(host.log), 'and the host log says what it opened and what was chosen');
  const tookPicked = await take({ host_id: 'host-test-1', path: PICKED, channel: CH, agent: 'picked', open: false });
  eq([tookPicked.status, (await tookPicked.json()).mode], [200, 'take'], 'so it can be taken, though no list ever showed it — the host named it, by listing it');
  eq((await take({ host_id: 'host-test-1', path: `${FIX}/picked-deep/never-named`, channel: CH, agent: 'ghost' })).status, 409, 'while a path the host has not named is still refused, dialog or no dialog');
  assert(await until(async () => (deskOf(await floor(), 'picked')?.hosted?.live ? true : null), 20000), 'the host binds it and the desk registers');
  await json('/api/floor/desk/leave', { channel: CH, agent: 'picked' });
  await until(async () => (deskOf(await floor(), 'picked')?.hosted?.state === 'offline' ? true : null), 20000);

  // While a person is choosing: the host says the dialog is open, a second
  // ask does not stack a second dialog, and the work loop is not held.
  person({ path: PICKED, delay: 3000 });
  pickBefore = await pickAt();
  const callsBefore = dialogLog().length;
  await pickAsk(`${FIX}/repo-a`);
  const opened = await until(async () => { const g = await pickGet(); return g.at && g.at !== pickBefore && g.state === 'open' ? g : null; }, 8000);
  eq([opened?.state, opened?.start], ['open', `${FIX}/repo-a`], 'while the dialog is up the host says so, and where — from here the page waits for the person, not for a clock');
  await pickAsk(`${FIX}/repo-a`);
  await json('/api/floor/browse', { host_id: 'host-test-1', path: FIX });
  const whileOpen = await until(async () => { const g = await browsed(FIX); return g.at && g.at > opened.at ? g : null; }, 2000);
  eq([!!whileOpen, (await pickGet()).state], [true, 'open'],
    'the host goes on doing other work while the dialog is still open — a person choosing does not hold up the loop that delivers messages');
  pickGot = await settled(pickBefore);
  eq(pickGot?.state, 'chosen', 'and the choice arrives when it is made');
  eq(dialogLog().length, callsBefore + 1, 'a second ask while a dialog is open did not put a second one on the screen');

  // Item 2: where it opens. A remembered folder that is gone lands on the
  // nearest folder above it that still exists; with nothing remembered, home.
  person({ cancel: true });
  pickBefore = await pickAt();
  await pickAsk(`${FIX}/repo-a/gone-since/and-deeper`);
  pickGot = await settled(pickBefore);
  eq([pickGot?.state, pickGot?.path ?? null], ['cancelled', null], 'a dialog closed without a choice is said as that, with no folder');
  eq(dialogLog().at(-1)?.start, `${FIX}/repo-a`, 'a remembered folder that no longer exists opens the nearest one above it that does');
  pickBefore = await pickAt();
  await pickAsk();
  await settled(pickBefore);
  eq(dialogLog().at(-1)?.start, HOME, 'and with nothing remembered the dialog opens at home');

  // The dialog failing, and the dialog left open.
  person({ fail: 'stand-in: the display is asleep', code: 3 });
  pickBefore = await pickAt();
  await pickAsk();
  pickGot = await settled(pickBefore);
  eq(pickGot?.state, 'failed', 'a dialog that dies is said as failed');
  assert(/exit code 3/.test(pickGot?.error ?? '') && /the display is asleep/.test(pickGot?.error ?? ''), `quoting how it ended and what it said, not a guess at why — ${pickGot?.error}`);
  person({ path: PICKED, delay: 60000 });
  pickBefore = await pickAt();
  await pickAsk();
  pickGot = await settled(pickBefore);
  eq([pickGot?.state, pickGot?.why], ['cancelled', 'left open for 4s'], 'a dialog nobody touches is closed by the host, and it says that is what happened');
  const leftPid = dialogLog().at(-1)?.pid;
  let leftAlive = true;
  try { process.kill(leftPid, 0); } catch { leftAlive = false; }
  assert(leftPid > 0 && !leftAlive, 'by ending its process — which is how a dialog is closed, since the window goes with it');
  person({ cancel: true });

  // The function itself, away from a host: which command, where it starts,
  // and what its answer means.
  const mac = dialogCommand(`/tmp/it's "here"`, { platform: 'darwin', env: {} });
  eq([mac?.cmd, mac?.args.slice(0, 3)], ['osascript', ['-l', 'JavaScript', '-e']], 'on macOS the dialog is osascript running an open panel itself');
  assert(/NSOpenPanel/.test(mac.args[3]) && /NSApplicationActivationPolicyAccessory/.test(mac.args[3]) && /activateIgnoringOtherApps\(true\)/.test(mac.args[3]),
    'with the two lines measured to bring it to the front: the activation policy, and the activate call');
  eq(mac.args[4], `/tmp/it's "here"`, 'the start folder is handed over as an argument');
  assert(!mac.args[3].includes('here'), 'never written into the script — a path with a quote in it is a path, not source');
  eq([dialogCommand('/x', { platform: 'linux', env: {} }), dialogCommand('/x', { platform: 'win32', env: {} })], [null, null],
    'Linux and Windows have no backend until one has been watched taking focus');
  eq([hasDialog({ platform: 'darwin', env: {} }), hasDialog({ platform: 'linux', env: {} })], [true, false], 'which is what the host tells the board, so such a host gets the page\'s list');
  eq(dialogCommand('/x', { platform: 'linux', env: { ORCH_FOLDER_DIALOG: '/bin/stand-in' } }), { cmd: '/bin/stand-in', args: ['/x'] }, 'the suite\'s stand-in takes the place of any of them');
  eq([startFor(REPO, '/home'), startFor(`${REPO}/gone/deeper`, '/home'), startFor(`${REPO}/.mcp.json`, '/home'), startFor('relative/path', '/home'), startFor(undefined, '/home'), startFor('/no-such-top-level-folder-here', '/home')],
    [REPO, REPO, REPO, '/home', '/home', '/'],
    'a start that exists is used; one that is gone, or is a file, is the nearest folder above it; no start at all is home');
  eq(readAnswer({ code: 0, signal: null, stdout: '{"path":"/a/b"}\n', stderr: '' }), { ok: true, path: '/a/b' }, 'the dialog\'s answer is a path');
  eq(readAnswer({ code: 0, signal: null, stdout: '{"cancelled":true}\n', stderr: '' }), { ok: true, cancelled: true }, 'or that it was closed');
  eq([readAnswer({ code: 0, signal: null, stdout: '{"path":"not/absolute"}', stderr: '' }).ok, readAnswer({ code: 0, signal: null, stdout: 'hello', stderr: '' }).ok, readAnswer({ code: 1, signal: null, stdout: '{"path":"/a/b"}', stderr: '' }).ok], [false, false, false],
    'and anything else — a path that is not one, words that are not an answer, an answer from a process that failed — is a failure');
  eq(readAnswer({ code: null, signal: 'SIGKILL', stdout: '', stderr: 'line one\nexecution error: no screen\n' }).error, 'the folder dialog ended on SIGKILL: execution error: no screen', 'said with how it ended and its last line');
  eq([pickIsStale({ waited_ms: 7000 }, 6000), pickIsStale({ waited_ms: 1000 }, 6000), pickIsStale({}, 6000), pickIsStale({ waited_ms: null }, 6000)], [true, false, false, false],
    'a request the board held for longer than the page waits is stale; a fresh one, and one from a board that does not say, are not');

  /* ── the dialog the parent process shows (desktop #290) ─────────────────────
   * Under the desktop app the host is a child of the app, the person is
   * clicking inside the app, and the app's own dialog is the one in front
   * (measured in the app; the header of host/dialog.js has the table). So
   * with ORCH_FOLDER_DIALOG=parent the host asks the process that started
   * it over the port it was started with, and the answer comes back on it.
   * Here the suite is the app: a Node IPC channel, which host/dialog.js
   * reads the way it reads Electron's parentPort. */
  console.log('\n  the dialog the parent process shows (ORCH_FOLDER_DIALOG=parent)');
  const fakePort = () => {
    const fns = new Set();
    return { posted: [], post(m) { this.posted.push(m); }, on(fn) { fns.add(fn); return () => fns.delete(fn); }, say(m) { for (const fn of [...fns]) fn(m); } };
  };
  eq([dialogBackend({ env: { ORCH_FOLDER_DIALOG: 'parent' } }), dialogBackend({ env: { ORCH_FOLDER_DIALOG: '/bin/x' } }), dialogBackend({ platform: 'darwin', env: {} }), dialogBackend({ platform: 'linux', env: {} })],
    ['parent', 'program', 'darwin', null], 'the backend is named by ORCH_FOLDER_DIALOG and the platform');
  eq(dialogCommand('/x', { env: { ORCH_FOLDER_DIALOG: 'parent' }, port: null }), null, 'told to ask a parent it was not started with, the host has no dialog');
  eq(dialogCommand('/x', { env: { ORCH_FOLDER_DIALOG: 'parent' }, port: fakePort() }), { parent: true }, 'with one, the dialog is the parent\'s');
  eq([hasDialog({ env: { ORCH_FOLDER_DIALOG: 'parent' }, port: null }), hasDialog({ platform: 'linux', env: { ORCH_FOLDER_DIALOG: 'parent' }, port: fakePort() })], [false, true], 'which is what the board is told, platform or no platform');
  eq(parentPort({ parent: undefined, send: null }), null, 'no parentPort and no IPC channel: no parent');
  const ipcPort = parentPort({ parent: undefined, send: (m) => m, proc: { on() {}, off() {} } });
  eq(ipcPort?.kind, 'ipc', 'Node\'s channel (process.send) is a parent');
  const heardEl = [];
  const el = { posted: [], started: 0, handlers: new Set(), postMessage(m) { this.posted.push(m); }, on(ev, fn) { this.handlers.add(fn); }, off(ev, fn) { this.handlers.delete(fn); }, start() { this.started++; } };
  const elPort = parentPort({ parent: el, send: (m) => m });
  eq(elPort?.kind, 'electron', 'and Electron\'s parentPort is, and outranks the channel');
  const off = elPort.on((m) => heardEl.push(m));
  for (const fn of el.handlers) fn({ data: { type: 'x' } });
  eq([heardEl, el.started], [[{ type: 'x' }], 1], 'a message from Electron arrives as an event with .data, and the port is started');
  off();
  eq(el.handlers.size, 0, 'and listening can be stopped');
  eq(readParentAnswer({ type: 'folder-dialog', id: '1', path: '/a/b' }), { ok: true, path: '/a/b' }, 'the parent\'s answer is a path');
  eq(readParentAnswer({ cancelled: true }), { ok: true, cancelled: true }, 'or that the person closed it');
  eq(readParentAnswer({ error: 'no screen' }), { ok: false, error: "the app's folder dialog failed: no screen" }, 'or that it failed, in the app\'s words');
  assert(/not an answer: \{"path":"rel"\}/.test(readParentAnswer({ path: 'rel' }).error), 'and anything else is quoted back, never guessed at');
  {
    const port = fakePort();
    const ask = askParent(port, '/start', { timeoutMs: 60_000 });
    const open = port.posted[0];
    eq([open?.type, open?.state, open?.start, typeof open?.id, open?.message], ['folder-dialog', 'open', '/start', 'string', 'Choose the folder your agent lives in'], 'the ask is one message with an id, the start folder and the message to draw');
    port.say({ type: 'folder-dialog', id: 'someone-else', path: '/wrong' });
    port.say({ type: 'other', id: open.id, path: '/wrong' });
    let settledEarly = false;
    ask.done.then(() => { settledEarly = true; });
    await sleep(20);
    eq(settledEarly, false, 'an answer to another id, or of another type, is not this dialog\'s');
    port.say({ type: 'folder-dialog', id: open.id, path: '/chosen' });
    eq(await ask.done, { ok: true, path: '/chosen' }, 'the answer with its id is');
    const ask2 = askParent(port, '/start', { timeoutMs: 60_000 });
    ask2.close();
    eq([await ask2.done, port.posted.at(-1)?.state, port.posted.at(-1)?.id], [{ ok: true, cancelled: true, why: 'closed by the host' }, 'close', port.posted.at(-2).id], 'closing it tells the parent to take its dialog down');
    const ask3 = askParent(port, '/start', { timeoutMs: 50 });
    eq(await ask3.done, { ok: true, cancelled: true, why: 'left open for 0s' }, 'and one nobody answers is closed by the host, as the command backend\'s is');
    eq(port.posted.at(-1)?.state, 'close', 'with the same word to the parent');
  }

  // The real host, started the way the app starts it, with this suite answering.
  host.kill('SIGTERM');
  await new Promise((r) => host.once('exit', r));
  // ORCH_SEARCH_IN=worker: the app's host runs in Electron's utility process,
  // where the search cannot be a process of its own (execPath is the app, and
  // its RunAsNode fuse is off), so there it is a worker thread. The seam puts
  // this host, the one started the app's way, on that path under plain Node.
  host = startHost('host-test-1', { ORCH_FOLDER_DIALOG: 'parent', ORCH_SEARCH_IN: 'worker' }, { ipc: true });
  assert(await until(async () => (deskOf(await floor(), 'free')?.hosted?.live ? true : null), 15000), 'a host started with a message port is up');
  {
    const hGet = (path) => json(`/api/floor/history/${path}`).then((r) => r.json());
    const search = async (query, deep = false) => {
      const asked = await (await json('/api/floor/history/search', { query, deep })).json();
      return until(async () => { const g = await hGet(`search?id=${asked.id}`); return g.done ? g : null; }, 20000);
    };
    const wGot = await search('c-last-word');
    eq([wGot?.rows.map((r) => `${r.id}:${r.channel}/${r.agent}:${r.hits}`), wGot?.rows[0]?.snippets.map((sn) => `${sn.role}|${sn.text}`), wGot?.hosts.find((h) => h.host_id === 'host-test-1')?.error ?? null],
      [[`${SESSION_C}:${CH}/free:1`], ['assistant|C-LAST-WORD'], null],
      'the app\'s host searches in a worker thread, with the same answer the process gives');
    assert(/search: "c-last-word" — 1 conversation in \d+ files, \d+ ms, in a worker/.test(host.log), 'and its log says the worker answered');
    eq((await search('c-subagent-searching', true))?.rows.map((r) => `${r.snippets[0]?.role}|${r.snippets[0]?.via}`), ['assistant|Find the C thing'], 'a search with tool calls and thinking goes the same way');
    eq((await search('zz-no-such-words-anywhere'))?.rows, [], 'and one that finds nothing still answers');
    // A worker's process.argv[1] is history.js too, so the file's own "run as
    // a script" branch also ran in it, read an empty stdin and wrote a JSON
    // error to the host's stderr beside every answer (measured on Node 24).
    assert(!/Unexpected end of JSON input/.test(host.log), 'and the worker runs only the worker half of history.js: nothing of the script half reaches the host\'s log');
  }
  eq((await (await json('/api/floor/folders')).json()).hosts.find((h) => h.host_id === 'host-test-1')?.dialog, true, 'and says it has a dialog: the parent\'s');
  const PICKED2 = `${FIX}/picked-by-app/inner`;
  mkdirSync(PICKED2, { recursive: true });
  pickBefore = await pickAt();
  eq((await pickAsk(`${FIX}/repo-a`)).status, 200, 'the floor asks for the dialog as before');
  // Each ask is read as the open message *after* the ones already heard,
  // never "the last one": the next open can arrive after the until that
  // looks for it, and the last one is then the previous ask's.
  const opens = () => host.said.filter((m) => m.type === 'folder-dialog' && m.state === 'open');
  const nextOpen = (after) => until(() => (opens().length > after ? opens()[after] : null), 8000);
  const askedApp = await nextOpen(0);
  eq([askedApp?.start, askedApp?.message], [`${FIX}/repo-a`, 'Choose the folder your agent lives in'], 'the host asks the parent, with where to open and what to say');
  eq((await pickGet()).state, 'open', 'and tells the board the dialog is open');
  host.send({ type: 'folder-dialog', id: askedApp.id, path: PICKED2 });
  pickGot = await settled(pickBefore);
  eq([pickGot?.state, pickGot?.path], ['chosen', PICKED2], 'the parent\'s answer is the choice, listed and said as the command backend\'s is');
  assert(/the folder dialog chose .*picked-by-app\/inner/.test(host.log), 'and logged as chosen');
  const tookApp = await take({ host_id: 'host-test-1', path: PICKED2, channel: CH, agent: 'picked-app', open: false });
  eq([tookApp.status, (await tookApp.json()).mode], [200, 'take'], 'so it can be taken: the host named it by listing it');
  await json('/api/floor/desk/leave', { channel: CH, agent: 'picked-app' });
  await until(async () => (deskOf(await floor(), 'picked-app')?.hosted?.state === 'offline' ? true : null), 20000);
  pickBefore = await pickAt();
  await pickAsk(`${FIX}/repo-a`);
  const askedAgain = await nextOpen(1);
  assert(askedAgain && askedAgain.id !== askedApp.id, 'a second ask has an id of its own');
  host.send({ type: 'folder-dialog', id: askedApp.id, path: PICKED2 });
  await sleep(300);
  eq((await pickGet()).state, 'open', 'a late answer to the first dialog is not taken for this one');
  host.send({ type: 'folder-dialog', id: askedAgain.id, cancelled: true });
  pickGot = await settled(pickBefore);
  eq([pickGot?.state, pickGot?.path ?? null], ['cancelled', null], 'the parent saying the person closed it is a cancel');
  pickBefore = await pickAt();
  await pickAsk();
  const askedHome = await nextOpen(2);
  eq(askedHome?.start, HOME, 'with nothing remembered it asks to open at home');
  host.send({ type: 'folder-dialog', id: askedHome.id, error: 'the display is asleep' });
  pickGot = await settled(pickBefore);
  eq([pickGot?.state, pickGot?.error], ['failed', "the app's folder dialog failed: the display is asleep"], 'the parent\'s failure is said in its words');
  pickBefore = await pickAt();
  await pickAsk();
  const askedLeft = await nextOpen(3);
  pickGot = await settled(pickBefore);
  eq([pickGot?.state, pickGot?.why], ['cancelled', 'left open for 4s'], 'a dialog nobody answers is closed by the host after ORCH_PICK_TIMEOUT_MS');
  eq(host.said.some((m) => m.type === 'folder-dialog' && m.state === 'close' && m.id === askedLeft.id), true, 'and the parent is told to take it down');

  /* ── the protocol, and who runs the host (desktop #288, #289) ───────────────
   * A host whose number is not the board's is refused at registration, in
   * words that say what to do, and the words reach the log, the parent and
   * /api/floor. The host keeps trying, so a board rebuilt beside a running
   * host says it for the seconds until the host restarts, and the app shows
   * it until one side is updated. */
  console.log('\n  a host refused for its protocol, and one the app runs');
  host.kill('SIGTERM');
  await new Promise((r) => host.once('exit', r));
  host = startHost('host-test-1', { ORCH_HOST_PROTOCOL: '0', ORCH_HOST_SUPERVISOR: 'app', ORCH_FOLDER_DIALOG: 'parent' }, { ipc: true });
  const toldParent = await until(() => host.said.find((m) => m.type === 'registration' && m.state === 'refused') ?? null, 10000);
  assert(toldParent, 'the host tells its parent the registration was refused');
  assert(/^The host "Test Mac" is behind this board: it sends no protocol version|^The host "Test Mac" is behind this board: it speaks protocol 0/.test(toldParent?.why ?? ''), `in the board's words ("${toldParent?.why}")`);
  assert(/Update the Orchestratinator app, which carries the host\.$/.test(toldParent?.why ?? ''), 'which, for an app-run host, send the person to the app');
  eq([toldParent?.what, toldParent?.host?.protocol, typeof toldParent?.board?.protocol], ['protocol', 0, 'number'], 'with both numbers');
  assert(/registration refused: The host "Test Mac" is behind this board/.test(host.log), 'and the log says the same');
  assert(await until(() => (/registration refused \(protocol 0 here, \d+ at the board\); retrying in/.test(host.log) ? true : null), 8000), 'and keeps trying on the run loop\'s backoff, one short line a try');
  eq((host.log.match(/registration refused: The host/g) ?? []).length, 1, 'the words once, not once a try');
  const refusedRow = (await floor()).hosts.find((h) => h.host_id === 'host-test-1');
  eq([refusedRow?.live, refusedRow?.refused], [false, toldParent?.why], '/api/floor shows the host refused, not live, with the words');
  assert(/protocol 0 · clone .* run by the desktop app, which updates it/.test(host.log), 'the startup line names the protocol and who runs the host');
  host.kill('SIGTERM');
  await new Promise((r) => host.once('exit', r));
  host = startHost('host-test-1');
  assert(await until(async () => (deskOf(await floor(), 'free')?.hosted?.live ? true : null), 15000), 'a host speaking the board\'s protocol is back');
  eq((await floor()).hosts.find((h) => h.host_id === 'host-test-1')?.refused, null, 'and the refusal is gone from its row');
  host.kill('SIGTERM');
  await new Promise((r) => host.once('exit', r));
  host = startHost('host-test-1', { ORCH_FOLDER_DIALOG: 'parent' });
  assert(await until(() => (/ORCH_FOLDER_DIALOG=parent, but nothing started this process with a message port/.test(host.log) ? true : null), 8000),
    'a host told to ask a parent it was not started with says so at startup');
  assert(await until(async () => (deskOf(await floor(), 'free')?.hosted?.live ? true : null), 15000), 'and runs');
  eq((await (await json('/api/floor/folders')).json()).hosts.find((h) => h.host_id === 'host-test-1')?.dialog, false, 'with no dialog, so the page draws its own list for it');

  // The host's half of takeHostWork's guarantee (milestone audit
  // 2026-11-17, finding 4): it says what it finished, and a host told to
  // stop finishes the item in hand and hands back what it never started, so
  // nothing it took is left unfinished and unsaid. Read off the board's own
  // table: what the host reported is the fact, not what the page shows.
  console.log('\n  work in hand when the host stops');
  {
    const { default: Database } = await import('better-sqlite3');
    const rows = (sql, ...a) => { const db = new Database(DB_PATH, { readonly: true }); try { return db.prepare(sql).all(...a); } finally { db.close(); } };
    const mark = rows(`SELECT COALESCE(MAX(id), 0) AS m FROM host_outbox`)[0].m;
    eq((await chat('free', 'reported finished')).status, 200, 'a message is sent');
    assert(await until(() => (clean(received()).includes('reported finished') ? true : null), 20000), 'and typed');
    assert(await until(() => (rows(`SELECT done_at FROM host_outbox WHERE id > ? AND kind = 'chat'`, mark)[0]?.done_at ? true : null), 15000),
      'and the host reports it finished, on its next poll');
    const mark2 = rows(`SELECT COALESCE(MAX(id), 0) AS m FROM host_outbox`)[0].m;
    // Four, so the host is holding a batch it has not started when it is
    // told to stop: it types the first, and takes the other three in one
    // poll once that is done. The stop waits until at least two are taken
    // and unfinished. With fewer, the later ones were never taken at all,
    // and "back in line" said nothing about the release (the first cut of
    // this row: its mutant, the release emptied, stayed green).
    for (const t of ['in line one', 'in line two', 'in line three', 'in line four']) await chat('free', t);
    const held = await until(() => (rows(`SELECT id FROM host_outbox WHERE id > ? AND taken_at IS NOT NULL AND done_at IS NULL`, mark2).length >= 2 ? true : null), 30000);
    assert(held, 'the fixture: the host is holding more than the one it is typing when it is told to stop');
    const exited = new Promise((done) => host.once('exit', done));
    host.kill('SIGTERM');
    await Promise.race([exited, sleep(25000)]);
    const after = rows(`SELECT id, taken_at, done_at FROM host_outbox WHERE id > ?`, mark2);
    eq(after.filter((r) => r.taken_at && !r.done_at).length, 0, `a host stopped with messages in its line leaves none taken and unfinished: each is done or handed back (${after.filter((r) => r.done_at).length} done, ${after.filter((r) => !r.taken_at).length} back in line)`);
    assert(after.filter((r) => !r.taken_at).length >= 1, 'and what it held and never started was handed back, not only never taken');
    // Back in line is for the next run of this host; none comes in this
    // suite, so they are taken out of the line rather than left to be typed
    // by a host a later section starts.
    const db = new Database(DB_PATH);
    try { db.prepare(`DELETE FROM host_outbox WHERE id > ? AND taken_at IS NULL`).run(mark2); } finally { db.close(); }
    host = startHost();
    assert(await until(async () => (deskOf(await floor(), 'free')?.hosted?.live ? true : null), 20000), 'and a new run of the host is up again for what follows');
    await sleep(WATCH_SETTLE_MS);
  }

  // A host killed outright says nothing at the end, so what it finished has
  // to have been said already (QA, the re-measure's L1). It used to ride the
  // next poll, after the whole batch, and every message of a batch the host
  // had typed before it was killed was said lost on its desk: "send it
  // again" about words the window had. The fixture makes the batch: one
  // message is taken alone, and three more are queued while it is typed, so
  // the next poll takes them together.
  console.log('\n  work finished in the middle of a batch, and then the host is killed');
  {
    const { default: Database } = await import('better-sqlite3');
    const rows = (sql, ...a) => { const db = new Database(DB_PATH, { readonly: true }); try { return db.prepare(sql).all(...a); } finally { db.close(); } };
    const mark = rows(`SELECT COALESCE(MAX(id), 0) AS m FROM host_outbox`)[0].m;
    const byText = () => Object.fromEntries(rows(`SELECT payload, taken_at, done_at FROM host_outbox WHERE id > ? AND kind = 'chat'`, mark)
      .map((r) => [JSON.parse(r.payload).text, r]));
    await chat('free', 'batch one');
    assert(await until(() => (byText()['batch one']?.taken_at ? true : null), 15000), 'the fixture: the first message is taken alone');
    for (const t of ['batch two', 'batch three', 'batch four']) await chat('free', t);
    assert(await until(() => (clean(received()).includes('batch two') ? true : null), 30000), 'the fixture: the first of the batch of three is typed');
    const saidAt = await until(() => (byText()['batch two']?.done_at ? { fourTyped: clean(received()).includes('batch four') } : null), 15000);
    assert(saidAt && !saidAt.fourTyped, `a message finished in the middle of a batch is said done before the batch ends${!saidAt ? ' (never said)' : saidAt.fourTyped ? ' (said only once "batch four" was typed)' : ''}`);
    const open = Object.entries(byText()).filter(([, r]) => r.taken_at && !r.done_at).map(([t]) => t);
    host.kill('SIGKILL');
    assert(open.length >= 1, `the fixture: the host is killed with work of the batch still unfinished (${open.join(', ') || 'none'})`);
    const errorsBefore = new Set(((await turns('free')).rows ?? []).filter((r) => r.role === 'error').map((r) => r.id));
    host = startHost();
    const lost = await until(async () => {
      const said = ((await turns('free')).rows ?? []).filter((r) => r.role === 'error' && !errorsBefore.has(r.id)).map((r) => r.text ?? '');
      return said.length >= open.length ? said : null;
    }, 20000);
    assert(lost && open.every((t) => lost.some((s) => s.includes(`"${t}"`))), `the next run says what the killed one left unfinished, with its words (${open.join(', ')}) — ${(lost ?? []).join(' | ')}`);
    assert(lost && !lost.some((s) => s.includes('"batch two"')), 'and not the message it had finished and said');
    assert(await until(async () => (deskOf(await floor(), 'free')?.hosted?.live ? true : null), 20000), 'and the new run is up for what follows');
    await sleep(WATCH_SETTLE_MS);
  }

  console.log('\nwhen the host is gone');
  host.kill('SIGTERM');
  await until(async () => (deskOf(await floor(), 'free')?.hosted?.live === false ? true : null));
  const refused = await chat('free', 'anyone there?');
  eq(refused.status, 409, 'a message with no host to take it is refused rather than swallowed');
  eq((await refused.json()).code, 'host_offline', 'with the reason');
  host = null;

  /* ── the floor keeps hearing while a message is being delivered ─────────────
   * Relaying the conversation and delivering a message used to share one loop,
   * so handling a chat stopped the relay: send() opens a window, waits for
   * Claude Code to come up, then waits for the message to reach the transcript.
   * For that whole stretch the floor was told nothing — not the reply, not even
   * the echo of the message it had just sent, which the composer reads as a
   * send that failed and marks in red. Then the entire stretch arrived at once
   * the moment send() returned. What is happening cannot queue behind what was
   * asked. */
  console.log('\n  hearing the desk while a message is still going in');

  killTmux();
  // The stand-in writes the roster and cannot unwrite it when the pane is
  // killed under it. The host drops a dead pid from the roster now (it read
  // one as an editor holding the conversation once, and refused every reopen
  // after the first), so this is belt and braces: the section starts from a
  // roster that says what is true.
  writeFileSync(`${FIX}/roster.json`, '[]');
  await until(async () => (deskOf(await floor(), 'free')?.hosted?.live === false ? true : null), 4000);
  writeFileSync(`${FIX}/ready-delay.flag`, '6000');
  host = startHost('host-test-1');
  assert(await until(async () => (deskOf(await floor(), 'free')?.hosted?.live ? true : null), 15000),
    'a host is back and the desk is live again');
  // A host just started joins the desk's transcript where it stands, at its
  // first watch tick (follow(id, 'end')), and a turn written before that
  // tick is behind it for good. "Live" is the registration, which comes
  // first, so the marker below was written ahead of the join whenever the
  // tick came late: both rows after it red, the marker never on the floor
  // (seen 2026-11-14, and on 2026-11-18 read in the log: SPOKEN-WHILE-BUSY
  // nowhere in the run). So a turn is written first and waited for, and the
  // relay is known to be reading before anything is timed against it.
  const primer = `RELAY-JOINED-${Date.now()}`;
  appendTurn({
    type: 'assistant', uuid: `primer-${Date.now()}`, timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: primer }] },
  });
  let joined = await until(async () => (((await turns('free')).rows ?? []).some((r) => (r.text ?? '').includes(primer)) ? true : null), 3000);
  for (let i = 0; !joined && i < 5; i++) {
    // Written before the join, so never relayed: another, until one is.
    const again = `${primer}-${i}`;
    appendTurn({ type: 'assistant', uuid: `primer-${i}-${Date.now()}`, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: again }] } });
    joined = await until(async () => (((await turns('free')).rows ?? []).some((r) => (r.text ?? '').includes(again)) ? true : null), 3000);
  }
  assert(joined, 'the fixture: the restarted host is reading the desk\'s transcript before the timed part starts');

  const turnsBefore = ((await turns('free')).rows ?? []).length;
  const marker = `SPOKEN-WHILE-BUSY-${Date.now()}`;
  const queued = await chat('free', 'this one takes a while to go in');
  eq(queued.status, 200, 'the floor accepts the message');

  // The window has to be opened and the stand-in will not announce itself for
  // six seconds, so the host is now stuck inside send(). Anything the desk says
  // in the meantime still has to reach the floor.
  appendTurn({
    type: 'assistant', uuid: `busy-${Date.now()}`, timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: marker }] },
  });

  const heard = await until(async () => {
    const rows = (await turns('free')).rows ?? [];
    return rows.some((r) => (r.text ?? '').includes(marker)) ? rows : null;
  }, 4000);
  assert(!!heard, 'a turn written while the send is still in flight reaches the floor anyway');
  assert(!clean(received()).includes('takes a while to go in'),
    'and it got there before the message it was queued behind — the relay is not waiting on the delivery');
  assert((heard?.length ?? 0) > turnsBefore, 'the floor gained a turn rather than replaying the transcript');
  // And the subagent file already on disk was joined at its end, not replayed.
  // Named directly: QA's M6 (offsets read from 0) turned this suite red only
  // three sections later, through a desk drawn as working because a replayed
  // WebFetch row had become its last turn (PR #3 review, 2026-09-03).
  const everything = (await json(`/api/floor/turns?channel=${CH}&agent=free&limit=500`).then((r) => r.json())).rows ?? [];
  eq(everything.filter((r) => r.text === 'WebFetch: https://docs.example.test/hooks').length, 1,
    'a subagent file already on disk is not replayed when the host restarts');

  assert(await until(() => (clean(received()).includes('takes a while to go in') ? true : null), 20000),
    'and the message itself still lands once the window finishes starting');
  rmSync(`${FIX}/ready-delay.flag`, { force: true });

  /* ── a window asking before it starts ─────────────────────────────────────
   * The host reads a startup dialog off a booting pane — a live interactive
   * tty whose pid the roster does not know yet — and puts it on the floor as
   * a prompt, rather than leaving the desk saying only "starting" while
   * nobody can see what it is asking. Nothing before this proved the
   * emission fires from a real host process against a real pane; test/floor.mjs
   * covers the server's handling of the event, handed to it directly. */
  console.log('\n  a window asking before it starts');
  // A still-running host from the section above holds no window open on
  // 'free' right now, but the pane it already spawned there is on a server
  // whose environment is fixed from further back than either host process —
  // moot, now that the signal is a file rather than an env var, but the kill
  // still matters: two host processes registering the same host_id at once
  // is not a state to add a new scenario on top of.
  host.kill('SIGTERM');
  await until(async () => (deskOf(await floor(), 'free')?.hosted?.live === false ? true : null), 4000);
  host = null;
  killTmux();
  writeFileSync(`${FIX}/roster.json`, '[]');
  writeFileSync(`${FIX}/startup-ask.flag`, 'mcp');
  // Started with a folder-dialog TTL nothing can meet, for the last case in
  // this section: every request for the dialog reaches this host "too late".
  host = startHost('host-test-1', { ORCH_PICK_TTL_MS: '-1' });
  assert(await until(async () => (deskOf(await floor(), 'free')?.hosted?.live ? true : null), 15000),
    'a host is back and the desk is live again');

  const asked = await chat('free', 'open please');
  eq(asked.status, 200, 'the floor accepts a message for a desk with no window yet, which is what opens one');

  const asking = await until(async () => {
    const d = deskOf(await floor(), 'free');
    return d?.permission?.startup ? d : null;
  }, 4000);
  assert(!!asking, 'the desk carries the startup dialog as a prompt while the window is still booting');
  eq(asking.permission.kind, 'mcp', 'read as the new-MCP-server dialog');
  eq(asking.permission.options.map((o) => o.text),
     ['Use this MCP server', 'Use this and all future MCP servers in this project', 'Continue without using this MCP server'],
     'with the dialog’s own rows, not a guess at them');
  assert(!asking.working, 'a desk asking a startup question is not drawn as working');

  assert(await until(async () => (deskOf(await floor(), 'free')?.permission == null ? true : null), 8000),
    'and once the window finishes starting — the forced delay elapsing, same as a real one registering — the prompt comes down on its own');
  rmSync(`${FIX}/startup-ask.flag`, { force: true });

  /* A question Claude Code asks after its window has registered: the browser
   * extension's (costmo's new machine, 2026-11-20). The watch loop read the
   * pane for a startup question only while a window was starting, and the
   * reader did not know this one, so the host refused to type, said "answer
   * it on the floor", and the floor had nothing to answer it with. */
  killTmux();
  writeFileSync(`${FIX}/roster.json`, '[]');
  writeFileSync(`${FIX}/startup-ask.flag`, 'chrome');
  const crErrsBefore = ((await turns('free')).rows ?? []).filter((r) => r.role === 'error').length;
  eq((await chat('free', 'hello past the browser question')).status, 200, 'a message for the desk opens a window that registers and then asks about the browser extension');
  const crRefused = await until(async () => ((await turns('free')).rows ?? []).filter((r) => r.role === 'error').slice(crErrsBefore).find((r) => /the window is asking something, so nothing was typed/.test(r.text ?? '')) ?? null, 30000);
  assert(!!crRefused, `the host types nothing into it and says so — ${crRefused?.text?.slice(0, 80)}`);
  const crAsking = await until(async () => { const d = deskOf(await floor(), 'free'); return d?.permission?.startup ? d : null; }, 8000);
  assert(!!crAsking, 'and the floor is given the question to answer, though the window has registered');
  eq(crAsking?.permission?.kind, 'chrome', 'read as the browser extension’s question');
  eq(crAsking?.permission?.options?.map((o) => o.text), ['No, keep browser tools off', 'Yes, use my browser'], 'with its own two rows');
  const crAnswer = await json('/api/floor/permission', { channel: CH, agent: 'free', request_id: crAsking?.permission?.request_id, decision: '1' });
  eq(crAnswer.status, 200, 'the operator’s choice is taken');
  assert(await until(async () => (deskOf(await floor(), 'free')?.permission == null ? true : null), 10000),
    'the host presses that row, and the question leaves the floor when it leaves the window');
  assert(await until(async () => ((await chat('free', 'after the browser question')).status === 200 ? true : null), 8000), 'and the desk takes a message again');
  assert(await until(() => (clean(received()).includes('after the browser question') ? true : null), 20000), 'which reaches the window');
  rmSync(`${FIX}/startup-ask.flag`, { force: true });

  // A request for the folder dialog that reaches the host after the page has
  // given up must not open one: a dialog appearing in front of somebody who
  // stopped waiting is a surprise, and nothing would read its answer.
  const staleCalls = dialogLog().length;
  const staleAt = await pickAt();
  eq((await pickAsk()).status, 200, 'a request for the folder dialog is queued for a host that will get it too late');
  assert(await until(() => (/not opening the folder dialog — it was asked for/.test(host.log) ? true : null), 8000), 'the host says it is not opening one, and why');
  eq([dialogLog().length, await pickAt()], [staleCalls, staleAt], 'and no dialog opened, and nothing was said to the board as if one had');

  /* ── Claude Code signed out on this machine ─────────────────────────────────
   * costmo, 2026-11-19: a desk on a machine where Claude Code is signed out
   * says so, and its Sign in has the host run Claude Code's own sign-in
   * (host/auth.js). The stand-in answers `auth status` and `auth login` from
   * files, and a window started signed out draws the footer 2.1.329 draws. */
  console.log('\n  Claude Code signed out on this machine');
  host.kill('SIGTERM');
  await until(async () => (deskOf(await floor(), 'free')?.hosted?.live === false ? true : null), 4000);
  host = null;
  killTmux();
  writeFileSync(`${FIX}/roster.json`, '[]');
  writeFileSync(`${FIX}/signed-out.flag`, '');
  rmSync(`${FIX}/auth.log`, { force: true });
  const soAuthLog = () => (existsSync(`${FIX}/auth.log`) ? readFileSync(`${FIX}/auth.log`, 'utf8') : '');
  // Started with USER and LOGNAME empty, as a parent other than launchd may
  // start it: Claude Code finds its sign-in by user, so the host fills them.
  host = startHost('host-test-1', { USER: '', LOGNAME: '' });
  const so = await until(async () => { const d = deskOf(await floor(), 'free'); return d?.hosted?.live && d?.signin ? d : null; }, 15000);
  assert(!!so, 'a host on a machine where Claude Code is signed out says so at registration, and its desk carries Sign in');
  eq([so?.signin?.ok, so?.signin?.host], [true, 'Test Mac'], 'which can be pressed, and names the machine');
  eq(so?.nudge?.code, 'signed_out', 'the bell does not ring a desk that cannot answer');
  eq((await floor()).hosts.find((h) => h.host_id === 'host-test-1')?.signed_out, true, 'and the host is listed signed out');
  assert(new RegExp(`^status --json USER=${userInfo().username}$`, 'm').test(soAuthLog()),
    `Claude Code is asked with USER filled in, which this host was started without — ${JSON.stringify(soAuthLog())}`);
  const soRefused = await chat('free', 'are you there?');
  const soBody = await soRefused.json();
  eq([soRefused.status, soBody.code], [409, 'signed_out'], 'a message is refused before it is queued');
  assert(/signed out on Test Mac.*Sign in/.test(soBody.error ?? ''), `in words that name the machine and the remedy on the desk — ${soBody.error}`);
  assert(!clean(received()).includes('are you there?'), 'and nothing is typed into the window');

  // The desk's window, opened on its conversation while signed out: it draws
  // the footer, and a sign-in made elsewhere leaves it standing.
  const soSoArgv = () => (existsSync(`${FIX}/argv.log`) ? readFileSync(`${FIX}/argv.log`, 'utf8') : '');
  const soSoOpenAt = soSoArgv().length;
  eq((await json('/api/floor/reopen', { channel: CH, agent: 'free', session_id: SESSION_ID })).status, 200, 'the fixture: the desk\'s window is opened on its conversation');
  assert(await until(async () => (deskOf(await floor(), 'free')?.hosted?.held === 'floor' ? true : null), 20000), 'the fixture: the window is up');
  const soDeskTurns = async () => (await turns('free')).rows ?? [];
  const soHostLines = async () => (await soDeskTurns()).filter((r) => r.tool_name === 'host').map((r) => r.text);

  // A sign-in that does not finish: said on the desk, still signed out.
  writeFileSync(`${FIX}/signin-fail.flag`, "Couldn't save your login.");
  const soFailPress = await json('/api/floor/signin', { channel: CH, agent: 'free' });
  eq(soFailPress.status, 200, 'Sign in is taken');
  const soFailRows = await until(async () => { const rows = await soDeskTurns(); return rows.some((r) => r.role === 'error' && /not signed in/.test(r.text ?? '')) ? rows : null; }, 10000);
  assert((soFailRows ?? []).some((r) => r.tool_name === 'host' && /sign-in is open in the browser on Test Mac/.test(r.text ?? '')), 'the desk says the sign-in is open in the browser, and on which machine');
  assert((soFailRows ?? []).some((r) => r.role === 'error' && r.text === "not signed in: it ended with code 1: Couldn't save your login."),
    `one that fails says so in Claude Code's own last words — ${JSON.stringify((soFailRows ?? []).filter((r) => r.role === 'error').map((r) => r.text))}`);
  assert(/^login USER=\S+$/m.test(soAuthLog()), 'it ran Claude Code\'s own sign-in, with USER');
  eq(deskOf(await floor(), 'free')?.signin?.ok, true, 'and the desk still offers Sign in');
  rmSync(`${FIX}/signin-fail.flag`, { force: true });

  // One that does, pressed twice while it is open.
  writeFileSync(`${FIX}/signin-delay.flag`, '1500');
  const soLogins = () => (soAuthLog().match(/^login /gm) ?? []).length;
  const soLoginsBefore = soLogins();
  eq((await json('/api/floor/signin', { channel: CH, agent: 'free' })).status, 200, 'Sign in again');
  await until(() => (soLogins() > soLoginsBefore ? true : null), 5000);
  eq((await json('/api/floor/signin', { channel: CH, agent: 'free' })).status, 200, 'and once more while the first is open');
  // What ends the sign-in is the host's own line: the window reopened (it
  // still draws the footer), then the registration. The reopen waits for the
  // window to come up, up to the host's READY_TIMEOUT_MS (45 s), and a
  // `/mcp reconnect` the board asks for this window (the stand-in never
  // connects) can be ahead of it on the host's line; so the wait is bound by
  // that, and settles on the line, not on a count of seconds.
  await until(async () => ((await soHostLines()).some((t) => /so the host reopened it on the same conversation/.test(t ?? '')) ? true : null), 60000);
  const soSignedIn = await until(async () => { const d = deskOf(await floor(), 'free'); return d?.hosted?.live && !d.signin ? d : null; }, 10000);
  assert(!!soSignedIn, 'once Claude Code is signed in again the desk stops offering Sign in');
  eq(soLogins() - soLoginsBefore, 1, 'a press while a sign-in is open opens no second one');
  const soLines = await soHostLines();
  assert(soLines.some((t) => /already open in the browser on Test Mac/.test(t ?? '')), `and says the first is still open — ${JSON.stringify(soLines.slice(-6))}`);
  assert(soLines.includes('signed in to Claude Code on Test Mac'), 'the desk says it is signed in');
  const soReopened = soSoArgv().slice(soSoOpenAt).split('\n').filter((l) => l.includes(`--resume ${SESSION_ID}`));
  eq(soReopened.length, 2, `the window that still said it was signed out was reopened on its own conversation — ${JSON.stringify(soSoArgv().slice(soSoOpenAt))}`);
  assert(soLines.some((t) => /still said Claude Code was signed out, so the host reopened it on the same conversation/.test(t ?? '')), 'and the desk says why');
  assert(soSignedIn?.nudge?.ok === true, 'the bell rings again');
  eq((await floor()).hosts.find((h) => h.host_id === 'host-test-1')?.signed_out, false, 'the host is listed signed in');
  eq((await chat('free', 'back again')).status, 200, 'a message is taken');
  assert(await until(() => (clean(received()).includes('back again') ? true : null), 15000), 'and reaches the window');
  rmSync(`${FIX}/signin-delay.flag`, { force: true });

  // A window that records "Not logged in" is believed at once, not at the
  // next heartbeat, even while `auth status` says signed in (a credential
  // that is there and no longer taken); a reply from a window ends it.
  appendTurn({ type: 'assistant', uuid: `nli-${Date.now()}`, timestamp: new Date().toISOString(), isApiErrorMessage: true,
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } });
  const soSaidOut = await until(async () => (deskOf(await floor(), 'free')?.signin ? true : null), 8000);
  assert(!!soSaidOut, 'a window that records "Not logged in" puts Sign in on the desk within seconds');
  appendTurn({ type: 'assistant', uuid: `reply-${Date.now()}`, timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: 'Hello again.' }] } });
  assert(await until(async () => (deskOf(await floor(), 'free')?.signin ? null : true), 8000), 'and a reply from a window takes it away');
  rmSync(`${FIX}/signed-out.flag`, { force: true });

  /* ── which board this host serves ───────────────────────────────────────────
   * This used to be `originOf(found[0].url)` — the first desk the filesystem
   * walk happened to return. On a machine whose desks point at two boards that
   * is a coin flip, and the losing side still registers, reports healthy, and
   * serves nothing, with the only evidence a `skipping` line in a log nobody
   * reads. Which board a host serves is the user's to say, so an ambiguous
   * install has to stop and ask rather than pick. */
  console.log('\n  which board this host serves');

  const boards = `${FIX}/boards`;
  const deskAt = (dir, agent, url) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/.mcp.json`, JSON.stringify({
      mcpServers: {
        orchestratinator: {
          type: 'http',
          url: `${url}/mcp`,
          headers: { 'X-Channel': CH, 'X-Agent': agent, 'X-Orchestratinator-Key': `key-${agent}` },
        },
      },
    }, null, 2));
  };
  // Resolves on the marker rather than a fixed wait: the startup line is
  // printed before the first poll, and these hosts point at ports nothing is
  // listening on, so waiting for exit would mean waiting out the retry backoff.
  const runHost = (roots, { until: marker = null, ...extra } = {}) => new Promise((done) => {
    const p = spawn('node', ['host/index.js'], {
      env: {
        ...process.env,
        HOME,
        ORCH_HOST_ROOTS: roots,
        ORCH_TMUX_SESSION: TMUX_SESSION,
        ORCH_HOST_CONFIG: '/nonexistent/host.json',
        ORCH_HOST_CLAUDE: `${FIX}/claude`,
        ORCH_URL: '',
        ...extra,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const finish = (code) => { clearTimeout(timer); try { p.kill('SIGKILL'); } catch { /* gone */ } done({ code, out }); };
    const see = (d) => { out += d; if (marker && marker.test(out)) finish(null); };
    p.stdout.on('data', see);
    p.stderr.on('data', see);
    const timer = setTimeout(() => finish(null), 8000);
    p.on('exit', finish);
  });

  deskAt(`${boards}/one`, 'board-a', 'http://127.0.0.1:9911');
  deskAt(`${boards}/two`, 'board-b', 'http://127.0.0.1:9922');

  const split = await runHost(boards);
  eq(split.code, 1, 'desks pointing at two boards stop the host rather than letting it guess');
  assert(/different boards/.test(split.out), 'and it says that is why');
  assert(/9911/.test(split.out) && /9922/.test(split.out), 'naming both, so the choice can be made');
  assert(/--url/.test(split.out), 'and how to make it');

  const pinned = await runHost(boards, { ORCH_URL: 'http://127.0.0.1:9922', until: /skipping/ });
  assert(/serves http:\/\/127\.0\.0\.1:9922/.test(pinned.out), 'a configured url settles it');
  assert(/skipping .*board-a/.test(pinned.out), 'and desks on the other board are named rather than silently dropped');

  rmSync(`${boards}/two`, { recursive: true, force: true });
  const agreed = await runHost(boards, { until: /tmux/ });
  assert(/→ http:\/\/127\.0\.0\.1:9911/.test(agreed.out), 'desks that agree on one board need no url at all');

  // Local scope can live elsewhere: CLAUDE_CONFIG_DIR moves ~/.claude.json
  // (measured 2026-09-09), and a host that read only the home file would miss
  // every desk bound on such a machine.
  const cfgDir = `${FIX}/cfg`;
  mkdirSync(cfgDir, { recursive: true });
  mkdirSync(`${boards}/three`, { recursive: true });
  writeFileSync(`${cfgDir}/.claude.json`, JSON.stringify({
    projects: {
      [`${boards}/three`]: {
        mcpServers: { orchestratinator: { type: 'http', url: 'http://127.0.0.1:9911/mcp', headers: { 'X-Channel': CH, 'X-Agent': 'cfg-agent', 'X-Orchestratinator-Key': 'key-cfg' } } },
      },
    },
  }));
  // Resolved on the line printed after the desk list — the startup line itself
  // says "tmux", so that marker would cut the output before any desk is named.
  const moved = await runHost(boards, { CLAUDE_CONFIG_DIR: cfgDir, until: /attach to any of them/ });
  assert(/host-test\/cfg-agent .*\(local scope\)/.test(moved.out), 'a desk bound in local scope under CLAUDE_CONFIG_DIR is found there');

  /* ── where the shared secret comes from ─────────────────────────────────────
   * A desk's own binding outranks ORCH_AUTH_TOKEN and host.json (the operator's
   * rule, 2026-09-09): a repo bound by hand says which key this board takes.
   * The environment and the file are for the machine with no hand-bound repo,
   * whose every desk will be taken from the floor — which the host can only do
   * with a key of its own. And the value is never printed. */
  console.log('\n  where the shared secret comes from');
  const keyed = await runHost(boards, { ORCH_AUTH_TOKEN: 'env-key-value', until: /shared secret/ });
  assert(/shared secret: from host-test\/board-a's \.mcp\.json, which overrides ORCH_AUTH_TOKEN/.test(keyed.out),
    "a desk's own .mcp.json wins over ORCH_AUTH_TOKEN, and the host says so");
  assert(!/env-key-value|key-board-a/.test(keyed.out), 'without printing either value');
  const emptyRoot = `${FIX}/empty-root`;
  mkdirSync(emptyRoot, { recursive: true });
  const envOnly = await runHost(emptyRoot, { ORCH_URL: 'http://127.0.0.1:9911', ORCH_AUTH_TOKEN: 'env-key-value', until: /shared secret/ });
  assert(/shared secret: from ORCH_AUTH_TOKEN \(no desk here carries one\)/.test(envOnly.out), 'with no desk to read one from, the environment supplies it');
  const none = await runHost(emptyRoot, { ORCH_URL: 'http://127.0.0.1:9911', until: /shared secret/ });
  assert(/no shared secret/.test(none.out) && /install\.sh --token/.test(none.out),
    'and with nothing at all the host says so, and how to give it one');

  // A key written as a placeholder, which Claude Code expands for the window
  // (2026-11-05, a partner's 33 desks). Read literally, the placeholder beat
  // the environment and the host signed in with the text `${…}`. The value is
  // never logged, so which one won is read off "which overrides": it is said
  // only when the desk's key differs from the environment's.
  const placeholderAt = (dir, key) => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(`${dir}/desk`, { recursive: true });
    writeFileSync(`${dir}/desk/.mcp.json`, JSON.stringify({
      mcpServers: { orchestratinator: { type: 'http', url: 'http://127.0.0.1:9911/mcp', headers: { 'X-Channel': CH, 'X-Agent': 'ph-agent', 'X-Orchestratinator-Key': key } } },
    }, null, 2));
    return dir;
  };
  const line = /shared secret[^\n]*\n/;
  const unset = await runHost(placeholderAt(`${FIX}/ph-unset`, '${ORCH_TEST_UNSET_DESK_KEY}'), { ORCH_AUTH_TOKEN: 'env-key-value', until: line });
  assert(/shared secret: from ORCH_AUTH_TOKEN \(host-test\/ph-agent carries its key as \$\{ORCH_TEST_UNSET_DESK_KEY\}, which this host's environment does not set\)/.test(unset.out),
    "a desk whose key is ${VAR} with VAR unset carries no key, the host's own is used, and the line names the variable");
  const expanded = await runHost(placeholderAt(`${FIX}/ph-set`, '${ORCH_AUTH_TOKEN}'), { ORCH_AUTH_TOKEN: 'env-key-value', until: line });
  assert(/shared secret: from host-test\/ph-agent's \.mcp\.json\n/.test(expanded.out.replace(/\r/g, '')),
    "a desk whose key is ${ORCH_AUTH_TOKEN} is read as that variable's value, not as the text");
  const fallback = await runHost(placeholderAt(`${FIX}/ph-default`, '${ORCH_TEST_UNSET_DESK_KEY:-env-key-value}'), { ORCH_AUTH_TOKEN: 'env-key-value', until: line });
  assert(/shared secret: from host-test\/ph-agent's \.mcp\.json\n/.test(fallback.out.replace(/\r/g, '')),
    'and ${VAR:-default} takes the default, as Claude Code does');
  const empty = await runHost(placeholderAt(`${FIX}/ph-empty`, '${ORCH_TEST_EMPTY_DESK_KEY:-desk-default}'), { ORCH_AUTH_TOKEN: 'env-key-value', ORCH_TEST_EMPTY_DESK_KEY: '', until: line });
  assert(/shared secret: from ORCH_AUTH_TOKEN \(/.test(empty.out),
    'but not when VAR is set and empty: Claude Code 2.1.300 sends "" then, so the desk carries no key (QA, PR #52 Info 2)');
  const embedded = await runHost(placeholderAt(`${FIX}/ph-embedded`, 'pre-${ORCH_TEST_UNSET_DESK_KEY}'), { ORCH_AUTH_TOKEN: 'env-key-value', until: line });
  assert(/shared secret: from ORCH_AUTH_TOKEN \(host-test\/ph-agent carries its key as \$\{ORCH_TEST_UNSET_DESK_KEY\}/.test(embedded.out) && !/pre-/.test(embedded.out),
    'an unset VAR inside a longer key is no key, not the text around it, and the text is not logged');

  // The installed host (QA, PR #52 finding 1). install.sh's LaunchAgent gives
  // the host PATH and HOME only, so ORCH_AUTH_TOKEN is never in its
  // environment: `undefined` leaves it out, as launchd does. A placeholder
  // desk then resolves to nothing, host.json's token (`install.sh --token`)
  // is the key, and the line says which desk could not supply one and why.
  const hostJson = `${FIX}/ph-host.json`;
  writeFileSync(hostJson, JSON.stringify({ token: 'file-key-value' }));
  const installed = await runHost(placeholderAt(`${FIX}/ph-launchd`, '${ORCH_AUTH_TOKEN}'), { ORCH_AUTH_TOKEN: undefined, ORCH_HOST_CONFIG: hostJson, until: line });
  assert(installed.out.includes(`shared secret: from token in ${hostJson} (host-test/ph-agent carries its key as \${ORCH_AUTH_TOKEN}, which this host's environment does not set)`),
    "an installed host with a ${ORCH_AUTH_TOKEN} desk uses host.json's token, and names the desk it could not read");
  assert(!/file-key-value/.test(installed.out), 'without printing it');
  const bare = await runHost(placeholderAt(`${FIX}/ph-launchd`, '${ORCH_AUTH_TOKEN}'), { ORCH_AUTH_TOKEN: undefined, until: /install\.sh --token[^\n]*\n/ });
  assert(/no shared secret: host-test\/ph-agent carries its key as \$\{ORCH_AUTH_TOKEN\}, which this host's environment does not set/.test(bare.out) && /install\.sh --token/.test(bare.out),
    'and with no host.json token it says the same, and how to give it one');

  // install.sh with no --token takes an ORCH_AUTH_TOKEN exported in the
  // installing shell (costmo's ruling on PR #52 finding 1, D): the shell that
  // fills in a repo's `${ORCH_AUTH_TOKEN}` for Claude Code is the one that runs
  // the install, and the LaunchAgent sees none of it. Run against stand-ins
  // with HOME in the fixture. PATH is the stand-ins, /usr/bin and node's own
  // directory, and never /bin, which is where the real launchctl is: a real
  // bootout here would stop the operator's live host. Checked before each run.
  const inst = `${FIX}/install`;
  const instBin = `${inst}/bin`;
  rmSync(inst, { recursive: true, force: true });
  mkdirSync(instBin, { recursive: true });
  mkdirSync(`${inst}/projects`, { recursive: true });
  mkdirSync(`${inst}/Library/LaunchAgents`, { recursive: true });
  writeFileSync(`${instBin}/launchctl`, `#!/bin/sh\necho "$@" >> ${JSON.stringify(`${inst}/launchctl.log`)}\n[ "$1" = print ] && exit 1\nexit 0\n`);
  for (const t of ['claude', 'tmux']) writeFileSync(`${instBin}/${t}`, '#!/bin/sh\nexit 0\n');
  for (const t of ['launchctl', 'claude', 'tmux']) chmodSync(`${instBin}/${t}`, 0o755);
  // ls for node.sh's nvm lookup: launchd's PATH has /bin, this one may not.
  for (const t of ['cat', 'mkdir', 'sleep', 'ls']) { try { execFileSync('ln', ['-sf', `/bin/${t}`, `${instBin}/${t}`]); } catch { /* there */ } }
  const instPath = `${instBin}:/usr/bin:${resolve(process.execPath, '..')}`;
  const install = (args, env = {}) => {
    const which = execFileSync('/bin/sh', ['-c', 'command -v launchctl'], { env: { PATH: instPath } }).toString().trim();
    if (which !== `${instBin}/launchctl`) throw new Error(`install.sh would reach ${which}, not the stand-in`);
    const out = execFileSync('/bin/bash', ['host/install.sh', ...args, `${inst}/projects`], { env: { PATH: instPath, HOME: inst, ...env } }).toString();
    return { out, conf: JSON.parse(readFileSync(`${inst}/.orchestratinator/host.json`, 'utf8')) };
  };
  // First, because a drifted major makes every install below refuse, and a
  // refusal throws out of the suite (the L4b mutant read "red by its exit").
  const dockerMajor = /^FROM node:(\d+)/m.exec(readFileSync('Dockerfile', 'utf8'))?.[1];
  const pickMajor = /^ORCH_NODE_MAJOR=(\d+)/m.exec(readFileSync('host/node.sh', 'utf8'))?.[1];
  eq([pickMajor, dockerMajor], ['24', '24'], "the major the host is given is the board image's (node.sh against the Dockerfile's FROM)");
  const fromShell = install([], { ORCH_AUTH_TOKEN: 'shell-key-value' });
  eq(fromShell.conf.token, 'shell-key-value', 'install.sh with no --token writes an exported ORCH_AUTH_TOKEN to host.json');
  assert(/shared secret from ORCH_AUTH_TOKEN in this shell/.test(fromShell.out) && !/shell-key-value/.test(fromShell.out),
    'and says where it came from, without printing it');
  eq(install(['--token', 'flag-key-value'], { ORCH_AUTH_TOKEN: 'shell-key-value' }).conf.token, 'flag-key-value', '--token still wins over the shell');
  eq(install([]).conf.token, 'flag-key-value', "and with neither, host.json's token is kept");
  // One Node major for what ships and what is tested (milestone audit
  // 2026-11-17, finding 5): the host runs on Node 24, the major the board's
  // image ships and these suites run on, not whatever node is first on PATH
  // (the shell's default here is 20). The pick is host/node.sh's, and the
  // LaunchAgent starts host/run.sh, which picks at every start, so an update
  // that moves the major needs only the restart it already does (QA, the
  // re-measure's L3). Each half has a row of its own (L4: the row before
  // this passed with "first node on PATH", whose PATH held only a 24).
  const plist = readFileSync(`${inst}/Library/LaunchAgents/com.appideas.orchestratinator-host.plist`, 'utf8');
  const progArgs = [.../<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1].matchAll(/<string>([^<]+)<\/string>/g) ?? []].map((m) => m[1]);
  eq(progArgs, ['/bin/sh', resolve('host/run.sh')], 'the LaunchAgent starts run.sh, which picks the Node at each start, not a Node named at install');
  // A Node 20 first on PATH, as on this machine, and a Node 24 under nvm.
  const old = `${inst}/old`;
  mkdirSync(old, { recursive: true });
  writeFileSync(`${old}/node`, '#!/bin/sh\necho 20\n');
  chmodSync(`${old}/node`, 0o755);
  const nvm24 = `${inst}/.nvm/versions/node/v24.99.0/bin`;
  mkdirSync(nvm24, { recursive: true });
  try { execFileSync('ln', ['-sf', process.execPath, `${nvm24}/node`]); } catch { /* there */ }
  const withOld = execFileSync('/bin/bash', ['host/install.sh', `${inst}/projects`], { env: { PATH: `${old}:${instPath}`, HOME: inst } }).toString();
  assert(withOld.includes(`host runs on ${nvm24}/node (${process.version})`), `with a Node 20 first on PATH, install picks the Node 24 after it, not the first node — ${withOld.split('\n').find((l) => l.startsWith('host runs on')) ?? withOld.trim()}`);
  // run.sh, as launchd starts it: a stand-in Node 24 that says what it was
  // asked to run, so the row reads the pick and the exec without a host.
  const runHome = `${inst}/run-home`;
  const runNvm = `${runHome}/.nvm/versions/node/v24.98.0/bin`;
  mkdirSync(runNvm, { recursive: true });
  writeFileSync(`${runNvm}/node`, '#!/bin/sh\nif [ "$1" = -p ]; then echo 24; else echo "RAN $*"; fi\n');
  chmodSync(`${runNvm}/node`, 0o755);
  const ran = execFileSync('/bin/sh', ['host/run.sh'], { env: { PATH: `${old}:/usr/bin:/bin`, HOME: runHome } }).toString().trim();
  eq(ran, `RAN ${resolve('host/index.js')}`, 'run.sh picks the Node 24 at start, past a Node 20 first on PATH, and runs the host on it');
  let noNode = '';
  try { execFileSync('/bin/sh', ['host/run.sh'], { env: { PATH: `${old}:/usr/bin:/bin`, HOME: `${inst}/nowhere` }, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (err) { noNode = `exit ${err.status}: ${String(err.stderr)}`; }
  // Homebrew's node@24 is found wherever HOME points, so on a machine that has one this row has nothing to say.
  if (['/opt/homebrew/opt/node@24/bin/node', '/usr/local/opt/node@24/bin/node'].some((f) => existsSync(f))) console.log('  - (a Homebrew node@24 is installed here: "no Node 24" cannot be staged)');
  else assert(/^exit 1: no Node 24 found/.test(noNode) && /not started/.test(noNode), `and with no Node 24 it starts nothing and says why in the log — ${noNode.trim().split('\n')[0]}`);
  writeFileSync(`${instBin}/node20`, '#!/bin/sh\necho 20\n');
  chmodSync(`${instBin}/node20`, 0o755);
  let refusal = '';
  try { install([], { ORCH_NODE: `${instBin}/node20` }); } catch (err) { refusal = String(err.stderr ?? ''); }
  assert(/^ORCH_NODE is .*node20, which is not Node 24/.test(refusal), `and a Node of another major is refused, in words, before anything is written — ${refusal.trim()}`);

  /* ── what the host log says ─────────────────────────────────────────────────
   * Issue #5. The log is one append-only file under launchd, and on 2026-11-03
   * it held 7,379 failure lines without a time among them, each reading
   * `fetch failed` or "The operation was aborted due to timeout" — countable,
   * but never lined up with the board's own log for the same minutes, and
   * never put against a route. Step 1: every line carries a UTC time. Step 2:
   * a failed request names its method, URL, what failed and how long it
   * waited. Run against a stand-in board in this process, so each way a
   * request fails is one the case chose, and the backoff and the events
   * requeue are asserted beside it: this round adds evidence, not behaviour. */

  /* Issue #31, in-process: how long an attachment is kept. Claude Code's own
   * cleanupPeriodDays, 30 when unset or unreadable, never under a day. */
  console.log('\n  how long an attachment is kept');
  {
    const sdir = `${FIX}/retention`;
    mkdirSync(sdir, { recursive: true });
    const settings = (v) => { writeFileSync(`${sdir}/settings.json`, v === undefined ? '{}' : JSON.stringify({ cleanupPeriodDays: v })); return `${sdir}/settings.json`; };
    eq([retentionDays(settings(undefined)), retentionDays(settings(7)), retentionDays(settings(0)), retentionDays(settings('x')), retentionDays(`${sdir}/none.json`)],
      [30, 7, 1, 30, 30], 'Claude Code\'s cleanupPeriodDays when set, 30 when it is not, and never less than a day');
    const udir = `${FIX}/sweep`;
    const old = 'aaaaaaaaaaaa1111', fresh = 'bbbbbbbbbbbb2222';
    for (const id of [old, fresh]) { mkdirSync(`${udir}/${id}`, { recursive: true }); writeFileSync(`${udir}/${id}/f.txt`, id); }
    mkdirSync(`${udir}/Not-an-upload`, { recursive: true });
    const t = (Date.now() - 8 * 86400_000) / 1000;
    utimesSync(`${udir}/${old}`, t, t);
    utimesSync(`${udir}/Not-an-upload`, t, t);
    eq(sweepUploads({ dir: udir, days: 7 }), 1, 'a sweep removes what is older than the retention');
    eq([existsSync(`${udir}/${old}`), existsSync(`${udir}/${fresh}`), existsSync(`${udir}/Not-an-upload`)], [false, true, true],
      'and leaves what is younger, and anything in the folder that is not an upload of its own');
    eq(withAttachments('', ['/u/a b.png']), `${ATTACHED_HEADER}\n- /u/a b.png`, 'a message of files alone is the list alone');

    // QA, PR #58 Info 3: two of fetchUpload's claims, against a board of a
    // few lines. A body that ends short of its length is never put where the
    // agent is told to look. (Node's fetch throws on it before fetchUpload's
    // own size check runs, measured: that check is a second guard, so this
    // row is about the outcome, whichever guard takes it.) And a file sent
    // again is kept from that send: its folder's time moves, so a sweep at
    // the retention leaves it.
    const fdir = `${FIX}/fetch-unit`;
    let served = 0;
    const tiny = http.createServer((req, res) => { served++; res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '5' }); res.end('hello'); });
    await new Promise((r) => tiny.listen(0, '127.0.0.1', r));
    const short = net.createServer((sock) => sock.once('data', () => sock.end('HTTP/1.1 200 OK\r\ncontent-type: application/octet-stream\r\ncontent-length: 10\r\nconnection: close\r\n\r\nabcd')));
    await new Promise((r) => short.listen(0, '127.0.0.1', r));
    try {
      const sid = 'shortaaaa1111';
      const why = await fetchUpload({ url: `http://127.0.0.1:${short.address().port}`, token: KEY, hostId: 'h', file: { id: sid, name: 'cut.bin' }, dir: fdir }).then(() => null, (e) => e.message);
      assert(/^cut\.bin did not arrive whole/.test(why ?? ''), `a file that arrives short is refused — ${why}`);
      eq([existsSync(`${fdir}/${sid}/cut.bin`), existsSync(`${fdir}/${sid}/cut.bin.part`)], [false, false], 'and nothing of it is left where the agent would be told to look');
      const rid = 'resendbbbb2222';
      const url = `http://127.0.0.1:${tiny.address().port}`;
      const first = await fetchUpload({ url, token: KEY, hostId: 'h', file: { id: rid, name: 'again.txt' }, dir: fdir });
      const old = (Date.now() - 8 * 86400_000) / 1000;
      utimesSync(`${fdir}/${rid}`, old, old);
      const second = await fetchUpload({ url, token: KEY, hostId: 'h', file: { id: rid, name: 'again.txt' }, dir: fdir });
      eq([first === second, served], [true, 1], 'a file sent again is the same file, not fetched twice');
      eq([sweepUploads({ dir: fdir, days: 7 }), existsSync(second)], [0, true], 'and it is kept from that send: a sweep at the retention leaves it');
    } finally {
      tiny.close(); short.close();
    }
  }

  console.log('\n  what the host log says');
  const STAMP = /^\[host\] (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z) /;
  const timedLines = (out, from, to) => {
    const lines = out.split('\n').filter(Boolean);
    const bad = lines.filter((l) => {
      const m = STAMP.exec(l);
      return !m || Date.parse(m[1]) < from - 1000 || Date.parse(m[1]) > to + 1000;
    });
    return lines.length && !bad.length ? true : `${lines.length} lines, untimed or out of range: ${JSON.stringify(bad.slice(0, 2))}`;
  };

  // The lines a host writes before it stops on an error are console.error,
  // not log/warn — the issue's :1626–1707.
  deskAt(`${boards}/two`, 'board-b', 'http://127.0.0.1:9922');
  let from = Date.now();
  const splitAgain = await runHost(boards);
  eq([splitAgain.code, /different boards/.test(splitAgain.out), timedLines(splitAgain.out, from, Date.now())], [1, true, true],
    'every line a host writes as it stops on an error carries the time it was written, in UTC');
  rmSync(`${boards}/two`, { recursive: true, force: true });

  // A stack trace is one call and many lines; each of them is the host's.
  const L = await import('../host/log.js').catch(() => ({}));
  eq(L.stamp?.(['fatal:', 'Error: gone\n    at main (index.js:1:1)'], new Date(0)),
    '[host] 1970-01-01T00:00:00.000Z fatal: Error: gone\n[host] 1970-01-01T00:00:00.000Z     at main (index.js:1:1)',
    'and a message of several lines is tagged and timed on every one of them');

  // Nothing listening: the socket's own refusal, said as one.
  from = Date.now();
  const noBoard = await runHost(emptyRoot, { ORCH_URL: 'http://127.0.0.1:9911', ORCH_AUTH_TOKEN: 'k', until: /retrying in 2s/ });
  eq(timedLines(noBoard.out, from, Date.now()), true, 'so does every line of a running host, its failures among them');
  assert(/POST http:\/\/127\.0\.0\.1:9911\/api\/host\/register refused \(ECONNREFUSED\) after \d+ms; retrying in 1s/.test(noBoard.out),
    'a refused request names its method, its board and path, that it was refused and how long it waited');
  eq([...noBoard.out.matchAll(/retrying in (\d+)s/g)].map((m) => Number(m[1])).slice(0, 2), [1, 2], 'and the backoff after it is what it was');

  // A board that does what each case says, one route at a time: a status
  // code, `hang` (never answers), `drop` (closes the socket), `not-json`.
  // An array is a queue, used up one request at a time; empty, it answers.
  const stand = { seen: [], hand: [] };
  const board = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const route = req.url.split('?')[0].replace('/api/host/', '');
      stand.seen.push({ route, url: req.url, body });
      const how = Array.isArray(stand[route]) ? stand[route].shift() : stand[route];
      if (how === 'hang') return;
      if (how === 'drop') { req.socket.destroy(); return; }
      const send = (status, text) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(text); };
      if (typeof how === 'number') { send(how, '{}'); return; }
      if (how === 'not-json') { send(200, '<html>'); return; }
      const reply = route === 'register' ? { ok: true, desks: [] } : route === 'work' ? { work: stand.hand.splice(0) } : { ok: true };
      // The real work route holds the poll; this one only slows it enough
      // that a host with nothing to do is not a tight loop.
      setTimeout(() => send(200, JSON.stringify(reply)), route === 'work' ? 150 : 0);
    });
  });
  await new Promise((r) => board.listen(0, '127.0.0.1', r));
  const BOARD = `http://127.0.0.1:${board.address().port}`;
  const BOARD_RE = BOARD.replace(/[.:/]/g, (c) => `\\${c}`);
  const against = (behaviour, marker) => {
    Object.assign(stand, { seen: [], hand: [], register: undefined, work: undefined, events: undefined, unregister: undefined }, behaviour);
    return runHost(emptyRoot, { ORCH_URL: BOARD, ORCH_AUTH_TOKEN: 'k', ORCH_REQUEST_TIMEOUT_MS: '300', until: marker });
  };

  const hung = await against({ register: 'hang' }, /retrying in 1s/);
  const hungAt = new RegExp(`POST ${BOARD_RE}\\/api\\/host\\/register timed out after (\\d+)ms \\(limit 300ms\\); retrying in 1s`).exec(hung.out);
  assert(!!hungAt && Number(hungAt[1]) >= 300, 'a request the board never answers names itself, says it timed out, after how long, and against what limit');

  const status = await against({ register: 503 }, /retrying in 1s/);
  assert(new RegExp(`POST ${BOARD_RE}\\/api\\/host\\/register → 503 after \\d+ms; retrying in 1s`).test(status.out),
    'a refusal by status names the board as well as the path, and how long it took');

  const polled = await against({ work: 500 }, /retrying in 2s/);
  // The poll names its run (`boot`, takeHostWork's guarantee; milestone
  // audit 2026-11-17, finding 4), so the line ends on it.
  assert(new RegExp(`GET ${BOARD_RE}\\/api\\/host\\/work\\?host_id=[^ ]+&wait=1&boot=[0-9a-f-]{36} → 500 after \\d+ms; retrying in 1s`).test(polled.out),
    'the work poll is told apart from the register that shares its warning, and names the run of the host it is');
  eq(stand.seen.map((s) => s.route).slice(0, 4), ['register', 'work', 'register', 'work'],
    'and a failed poll still re-registers before the next, as it did');

  const dropped = await against({ register: 'drop' }, /retrying in 1s/);
  const droppedLine = dropped.out.split('\n').find((l) => /retrying in 1s/.test(l)) ?? '';
  assert(new RegExp(`POST ${BOARD_RE}\\/api\\/host\\/register failed \\(UND_ERR_SOCKET: other side closed\\) after \\d+ms`).test(droppedLine) && !/refused/.test(droppedLine),
    'a socket the board closed is named by its own code — not called a refusal');

  const garbled = await against({ register: 'not-json' }, /retrying in 1s/);
  assert(new RegExp(`POST ${BOARD_RE}\\/api\\/host\\/register → 200, body failed \\(SyntaxError: [^)]*\\) after \\d+ms`).test(garbled.out),
    'and a 200 whose body is not JSON says so, rather than a parse error naming nothing');

  // The two that need the host kept running past its first failure: started
  // here rather than through runHost, which ends a host on its marker.
  const running = (behaviour) => {
    Object.assign(stand, { seen: [], hand: [], register: undefined, work: undefined, events: undefined, unregister: undefined }, behaviour);
    const p = spawn('node', ['host/index.js'], {
      env: { ...process.env, HOME, ORCH_HOST_ROOTS: emptyRoot, ORCH_TMUX_SESSION: TMUX_SESSION, ORCH_HOST_CONFIG: '/nonexistent/host.json',
        ORCH_HOST_CLAUDE: `${FIX}/claude`, ORCH_URL: BOARD, ORCH_AUTH_TOKEN: 'k' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const exited = new Promise((r) => p.on('exit', r));
    return {
      out: () => out,
      stop: async (signal = 'SIGKILL') => { p.kill(signal); await Promise.race([exited, sleep(5000)]); try { p.kill('SIGKILL'); } catch { /* gone */ } return out; },
    };
  };

  // The events warn (:621) is the relay's, not the loop's. A `recent` asks
  // for one `history` event with no desk needed, and the first batch is refused.
  const relaying = running({ events: [503] });
  stand.hand.push({ id: 1, kind: 'recent', payload: { request_id: 'log-events-1' } });
  const twice = await until(() => stand.seen.filter((s) => s.route === 'events' && s.body.includes('log-events-1')).length >= 2, 8000);
  const eventsOut = await relaying.stop();
  assert(new RegExp(`events not delivered \\(POST ${BOARD_RE}\\/api\\/host\\/events → 503 after \\d+ms\\); will retry with the next batch`).test(eventsOut),
    'the events warning names the request it is about');
  assert(!!twice, 'and the batch the board refused is posted again with the next one, as it was');

  // stop() unregisters, and a refusal there used to go without a word.
  const quitting = running({ unregister: 503 });
  await until(() => stand.seen.some((s) => s.route === 'work'), 8000);
  const quitOut = await quitting.stop('SIGTERM');
  assert(new RegExp(`unregister not delivered \\(POST ${BOARD_RE}\\/api\\/host\\/unregister → 503 after \\d+ms\\)`).test(quitOut),
    'and an unregister the board refused as the host stops is said too');
  board.closeAllConnections();
  board.close();
} catch (err) {
  console.error(err);
  failures++;
} finally {
  // What the host said, when something went wrong. Debugging a failure in
  // here without it means guessing at a process you cannot see, which is
  // exactly how a delivery bug survived a green suite.
  // What the desk actually recorded. A failure to deliver reaches the floor
  // as an error turn, and reading it beats inferring it from a missing file.
  if (failures && server) {
    try {
      const d = await turns('free');
      console.log('\n--- desk turns ---');
      for (const t of d.rows ?? []) console.log(`${t.id} ${t.role} ${JSON.stringify((t.text ?? '').slice(0, 500))}`);
    } catch { /* the board may already be gone */ }
  }
  // What the window was actually given, and what it was asked to run. A send
  // that "did not land" is either bytes that never arrived or a window that
  // never opened, and these two files say which without guessing.
  if (failures) {
    for (const [label, path] of [['pane received', SINK], ['claude argv', `${FIX}/argv.log`]]) {
      try { if (existsSync(path)) console.log(`\n--- ${label} ---\n${readFileSync(path, 'utf8').trim()}`); } catch { /* gone */ }
    }
  }
  if (failures && hostLog.trim()) console.log(`\n--- host log ---\n${hostLog.trim()}\n----------------`);
  try { host?.kill('SIGKILL'); } catch { /* gone */ }
  try { server?.kill('SIGKILL'); } catch { /* gone */ }
  killTmux();
  // Counted before the sweep, or the sweep would hide a leak: a window the
  // move case closed under the linger flag is gone by now (its watchdog
  // fires 4 s after), and every other one goes on the kill-session above.
  console.log('\n  what the run leaves behind');
  await until(() => (standIns().length === 0 ? true : null), 8000);
  const left = standIns();
  eq(left.length, 0, `a run leaves no stand-in claude running${left.length ? ` (pids ${left.join(', ')})` : ''}`);
  sweep();
  rmDb(DB_PATH);
  rmSync(FIX, { recursive: true, force: true });
}

console.log(failures ? `\nhost: ${failures} failed` : '\nhost: all passed');
process.exit(failures ? 1 : 0);

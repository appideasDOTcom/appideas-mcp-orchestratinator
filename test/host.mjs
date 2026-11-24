// End-to-end test for hosting: a real host process against a real server,
// and a stand-in Claude Code the host runs for each desk, spoken to as JSON
// over stdin and stdout (host/agent.js, host/desk.js; costmo's ruling,
// 2026-11-22, replacing the tmux window layer).
//
// Claude Code itself is not launched: ORCH_HOST_CLAUDE points at a stand-in
// that speaks stream-JSON the way 2.1.330 was measured to (test/agent.mjs has
// the protocol alone), and also writes what real Claude Code writes on disk
// that the host reads: its roster entry under ~/.claude/sessions while it
// runs, and its transcript. HOME is pointed at the fixture, so every file the
// host reads is one this test or its stand-in wrote. Everything else is the
// real thing: desk discovery from .mcp.json and local scope, the long poll
// for work, the process per desk, the transcript tail, and the board's own
// routes, which is where every row below reads its answer.
//   npm run test:host
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync, chmodSync, utimesSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { dialogCommand, hasDialog, startFor, readAnswer, pickIsStale, parentPort, readParentAnswer, askParent, dialogBackend } from '../host/dialog.js';
import { ATTACHED_HEADER, withAttachments, retentionDays, sweepUploads, fetchUpload } from '../host/uploads.js';

// No host a suite starts may see the machine's tmux (2026-11-23): a host lists
// the panes of session `orch` at its start (W.endLegacyWindows), and a mutant
// that dropped its folder check ended the operator's own agents' windows on
// the real server. Every host spawned here inherits this; a row that wants a
// tmux passes its own stand-in.
process.env.ORCH_TMUX = '/nonexistent/orch-suite-has-no-tmux';
// Nor runs the protocol probe on a real Claude Code (task 351): a row that
// wants it names a stand-in (ORCH_CANARY_STANDIN) and turns it on.
process.env.ORCH_CANARY = 'off';

const PORT = Number(process.env.HOST_TEST_PORT ?? 8896);
const DB_PATH = `./data/host-${process.pid}.db`;
const HOST = `http://localhost:${PORT}`;
const KEY = 'host-shared-secret';
const CH = 'host-test';
const FIX = resolve(`./data/host-fixture-${process.pid}`);
const HOME = `${FIX}/home`;
const WATCH_SETTLE_MS = 2000;
const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const REPO = `${FIX}/repo-a`;
// What the stand-in was sent on its stdin, one JSON line a record, logged as
// it handles each one: a message's words, a control request, an answer.
const STDIN_LOG = `${FIX}/stdin.log`;
const SESSIONS_DIR = `${HOME}/.claude/sessions`;

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

/** Every record the stand-ins were sent, in order. */
const stdinRecords = () => (existsSync(STDIN_LOG) ? readFileSync(STDIN_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
/** The words of every message the stand-ins were sent: what used to be "typed into the window". */
const received = () => stdinRecords().filter((r) => r.type === 'user').map((r) => r.text).join('\n');
const clean = (s) => s;
/** The answers the stand-ins were given to what they asked (can_use_tool), and the control requests they were sent. */
const answersSent = () => stdinRecords().filter((r) => r.type === 'control_response');
const controlsSent = () => stdinRecords().filter((r) => r.type === 'control_request');

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

/** The transcript Claude Code writes, where the host will look for it. */
const slugOf = (dir) => dir.replace(/[^A-Za-z0-9]/g, '-');
const slug = () => slugOf(REPO);
const transcriptOf = (dir, id) => `${HOME}/.claude/projects/${slugOf(dir)}/${id}.jsonl`;
const transcript = () => transcriptOf(REPO, SESSION_ID);
const appendTurn = (obj) => appendFileSync(transcript(), `${JSON.stringify(obj)}\n`);

/** The live Claude Codes in a folder, from the roster files the stand-ins write. */
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const procsIn = (dir) => {
  let names = [];
  try { names = readdirSync(SESSIONS_DIR); } catch { return []; }
  return names.map((n) => { try { return JSON.parse(readFileSync(`${SESSIONS_DIR}/${n}`, 'utf8')); } catch { return null; } })
    .filter((s) => s && s.cwd === dir && s.name === 'stand-in' && alive(s.pid));
};
const pidIn = (dir) => procsIn(dir)[0]?.pid ?? null;
/** A roster entry for a process that is not a stand-in: an editor, a terminal, another instance's Claude Code. */
const rosterEntry = (pid, cwd, sessionId, name = 'someone else') =>
  writeFileSync(`${SESSIONS_DIR}/${pid}.json`, JSON.stringify({ pid, cwd, sessionId, kind: 'interactive', startedAt: Date.now(), name }));
const dropRosterEntry = (pid) => rmSync(`${SESSIONS_DIR}/${pid}.json`, { force: true });
const argvLog = () => (existsSync(`${FIX}/argv.log`) ? readFileSync(`${FIX}/argv.log`, 'utf8') : '');
// One line per Claude Code started (the stand-in logs nothing else), so none at all reads as [].
const launches = (from) => argvLog().slice(from).split('\n').slice(0, -1);
// A row that EXPECTS a launch waits for it to be recorded: the host can say a
// desk started before the stand-in has appended its line to argv.log, and a
// read at once saw [] under load (QA, msg 4146: one helper, not a wait per
// row). Rows that prove NO launch read at once, as before.
const launchedSince = async (from, n = 1, ms = 8000) => (await until(() => { const l = launches(from); return l.length >= n ? l : null; }, ms)) ?? launches(from);
/** The next conversation a stand-in starts on a fresh conversation (or a /clear) gets this id, once. */
const nextFreshId = (id) => writeFileSync(`${FIX}/fresh-id.flag`, id);

function fixture() {
  mkdirSync(`${REPO}/src`, { recursive: true });
  mkdirSync(`${HOME}/.claude/projects/${slug()}`, { recursive: true });
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
  mkdirSync(SESSIONS_DIR, { recursive: true });

  // The stand-in: a Claude Code that speaks stream-JSON, and the CLI's
  // subcommands the host also runs (agents, --version, mcp, auth).
  //
  // Its body is a .cjs because the fixture sits inside this repo and this
  // package is "type": "module". It is started through an absolute
  // interpreter, because the host starts it through the person's shell
  // (`<shell> -c 'exec "$0" "$@"' claude …`, host/agent.js), and `exec`
  // keeps the pid: the pid the host holds is this program's own.
  writeFileSync(`${FIX}/claude`,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(`${FIX}/claude.cjs`)} "$@"\n`);
  chmodSync(`${FIX}/claude`, 0o755);
  writeFileSync(`${FIX}/claude.cjs`, STAND_IN_SRC);
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
  // The stand-in for the editor a handback opens (ORCH_EDITOR_OPEN): it
  // writes down the URL it was asked to open, and opens nothing.
  writeFileSync(`${FIX}/editor`, `#!/bin/sh\necho "$@" >> ${JSON.stringify(`${FIX}/editor.log`)}\n`);
  chmodSync(`${FIX}/editor`, 0o755);
}

/*
 * The stand-in Claude Code. Its protocol is test/agent.mjs's (measured on
 * 2.1.330, docs/stream-json-spike.md): no `init` until the first message and
 * one at each turn's start; a message echoed with its uuid and `isReplay` the
 * moment it is taken; a message sent mid-turn taken into that turn and
 * answered in its one result; `can_use_tool` for a permission or a question;
 * `conversation_reset` for /clear; an answer to each control request.
 *
 * What it writes on disk, because the host reads it: its roster entry,
 * ~/.claude/sessions/<pid>.json, from start to exit (the host's fast roster
 * path), and its transcript, user and assistant records where
 * host/claude.js transcriptPath() looks, so the relay has something to relay.
 *
 * What it does on purpose, by a message's words:
 *   PERMIT <tool>  asks permission for <tool> (with a rule it would allow
 *                  again) and says what it was told
 *   ASK            asks a two-question form and says the answers it got
 *   PAIR           asks two permissions at once, its own and a subagent's
 *   BGSUB          a background subagent asks, and the turn ends before it is answered
 *   DIALOG         asks something the floor has no way to answer
 *   SLOW <ms>      a turn that long, which runs a tool first (so the board
 *                  sees it working); a stop ends it
 *   QUIET <ms>     a turn that long with no tool, which the board cannot see
 *   HOLD <ms> …    taken (echoed) only after that long: a message that takes
 *                  time to go in
 *   DIE            taken, and then the process ends with code 3
 *   /compact, /clear  as Claude Code does them
 *   anything else  "ECHO:<words>"
 *
 * And by flag files, read when it starts, because a file reaches it whatever
 * environment the host gives it (the host gives its Claude Codes a person's
 * environment, with nothing of its own ORCH_ settings: host/claude.js
 * windowEnv):
 *   fresh-id.flag    the id of the next new conversation, used once
 *   start-delay.flag ms before it reads anything: a slow start
 *   signed-out.flag  signed out, as 2.1.329 is: every message is answered
 *                    "Not logged in", for as long as this process runs
 *   version.flag     what --version says
 */
const STAND_IN_SRC = String.raw`const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
const FIX = ${JSON.stringify(FIX)};
const argv = process.argv.slice(2);
const flag = (name) => { try { return fs.readFileSync(path.join(FIX, name), 'utf8').trim(); } catch { return null; } };
const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const SESSIONS = path.join(CLAUDE_HOME, 'sessions');

if (argv[0] === 'agents') {
  const rows = [];
  try { for (const n of fs.readdirSync(SESSIONS)) { try { rows.push(JSON.parse(fs.readFileSync(path.join(SESSIONS, n), 'utf8'))); } catch {} } } catch {}
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
// claude stop <job>, as the daemon's CLI does it for a background session:
// the job's process ends and its session file goes. Job "stuck-1" is refused.
if (argv[0] === 'stop') {
  if (argv[1] === 'stuck-1') { process.stderr.write('could not stop stuck-1\n'); process.exit(1); }
  try {
    for (const n of fs.readdirSync(SESSIONS)) {
      let d; try { d = JSON.parse(fs.readFileSync(path.join(SESSIONS, n), 'utf8')); } catch { continue; }
      if (d.jobId !== argv[1]) continue;
      try { process.kill(d.pid, 'SIGTERM'); } catch {}
      fs.rmSync(path.join(SESSIONS, n), { force: true });
    }
  } catch {}
  process.stdout.write('Stopped ' + argv[1] + '\n');
  process.exit(0);
}
// The host reads the version at every heartbeat (host/version.js); a file says which, so a row can move it.
if (argv[0] === '--version') { process.stdout.write((flag('version.flag') || '2.1.330') + ' (Claude Code)\n'); process.exit(0); }
// claude mcp add/remove -s local, as the real CLI behaves (measured
// 2026-09-08/09): a read-modify-write of $HOME/.claude.json under
// projects[cwd].mcpServers, "already exists" on a duplicate add, "No MCP
// server named" on a missing remove, and "File modified:" on success.
if (argv[0] === 'mcp') {
  const CFG = path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json');
  let j = {}; try { j = JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch {}
  const a = argv.slice(1); const sub = a[0];
  const scopeAt = a.indexOf('-s'); if (scopeAt >= 0 && a[scopeAt + 1] !== 'local') { process.stderr.write('stand-in: only local scope\n'); process.exit(2); }
  const rest = a.slice(1).filter((x, i, arr) => x !== '-s' && arr[i - 1] !== '-s');
  j.projects = j.projects || {}; const dir = process.cwd(); j.projects[dir] = j.projects[dir] || {}; const p = j.projects[dir]; p.mcpServers = p.mcpServers || {};
  const done = () => { fs.writeFileSync(CFG, JSON.stringify(j, null, 2)); process.stdout.write('File modified: ' + CFG + ' [project: ' + dir + ']\n'); process.exit(0); };
  if (sub === 'add') {
    const t = rest.indexOf('--transport'); const transport = t >= 0 ? rest[t + 1] : 'stdio';
    const positional = rest.filter((x, i, arr) => !x.startsWith('-') && arr[i - 1] !== '--transport' && arr[i - 1] !== '-H');
    const [name, url] = positional; const headers = {};
    rest.forEach((x, i) => { if (x === '-H') { const [k, ...v] = rest[i + 1].split(':'); headers[k.trim()] = v.join(':').trim(); } });
    if (p.mcpServers[name]) { process.stderr.write('MCP server ' + name + ' already exists in local config\n'); process.exit(1); }
    p.mcpServers[name] = { type: transport, url, headers }; done();
  }
  if (sub === 'remove') {
    const name = rest[0];
    if (!p.mcpServers[name]) { process.stderr.write('No MCP server named "' + name + '" in local scope\n'); process.exit(1); }
    delete p.mcpServers[name]; done();
  }
  process.stderr.write('stand-in: unknown mcp subcommand\n'); process.exit(2);
}
// claude auth status --json and claude auth login, as 2.1.329 answers them
// (host/auth.js): signed out while signed-out.flag exists; a login takes
// signin-delay.flag ms (300 by default) and signs in, or fails with
// signin-fail.flag's words on stderr. Each call is logged with the USER it
// was given, because without one Claude Code reads a signed-in Mac as signed
// out. TEST_ZSHENV_SIGNIN stands for a credential only a shell's startup
// file gives (F1 of the 0.14.5 review): set, it is signed in whatever the
// flag says, the way an exported API key is.
if (argv[0] === 'auth') {
  const OUT = path.join(FIX, 'signed-out.flag');
  fs.appendFileSync(path.join(FIX, 'auth.log'), argv.slice(1).join(' ') + ' USER=' + (process.env.USER || '') + '\n');
  if (argv[1] === 'status') { const out = fs.existsSync(OUT) && !process.env.TEST_ZSHENV_SIGNIN; process.stdout.write(JSON.stringify({ loggedIn: !out, authMethod: out ? 'none' : 'claude.ai' }) + '\n'); process.exit(out ? 1 : 0); }
  if (argv[1] !== 'login') process.exit(2);
  const fail = flag('signin-fail.flag') || '';
  const delay = Number(flag('signin-delay.flag')) || 300;
  setTimeout(() => { if (fail) { process.stderr.write('Opening browser to sign in…\n' + fail + '\n'); process.exit(1); } fs.rmSync(OUT, { force: true }); process.exit(0); }, delay);
  return;
}

// The desk's Claude Code.
fs.appendFileSync(path.join(FIX, 'argv.log'), argv.join(' ') + '\n');
// What it was started with, for the rows about the environment a desk's
// Claude Code gets: the variable a placeholder key names, and any of the
// host's own ORCH_ settings (none should arrive).
fs.appendFileSync(path.join(FIX, 'env.log'), JSON.stringify({ cwd: process.cwd(), key: process.env.ORCH_TEST_PANE_KEY ?? null, orch: Object.keys(process.env).filter((k) => k.startsWith('ORCH_') && k !== 'ORCH_TEST_PANE_KEY') }) + '\n');
const newId = () => { const f = path.join(FIX, 'fresh-id.flag'); let id = null; try { id = fs.readFileSync(f, 'utf8').trim(); fs.rmSync(f, { force: true }); } catch {} return id || randomUUID(); };
const at = argv.indexOf('--resume');
let session = at >= 0 ? argv[at + 1] : newId();
const signedOut = fs.existsSync(path.join(FIX, 'signed-out.flag')) && !process.env.TEST_ZSHENV_SIGNIN;
const startDelay = Number(flag('start-delay.flag')) || 0;
const ROSTER = path.join(SESSIONS, process.pid + '.json');
const announce = () => { fs.mkdirSync(SESSIONS, { recursive: true }); fs.writeFileSync(ROSTER, JSON.stringify({ pid: process.pid, sessionId: session, cwd: process.cwd(), kind: 'interactive', startedAt: Date.now(), name: 'stand-in' })); };
announce();
process.on('exit', () => { try { fs.rmSync(ROSTER, { force: true }); } catch {} });
for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(sig, () => process.exit(0));

const transcriptFile = () => { const dir = path.join(CLAUDE_HOME, 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-')); fs.mkdirSync(dir, { recursive: true }); return path.join(dir, session + '.jsonl'); };
let n = 0;
const record = (o) => fs.appendFileSync(transcriptFile(), JSON.stringify({ uuid: 'st-' + process.pid + '-' + (++n), timestamp: new Date().toISOString(), sessionId: session, ...o }) + '\n');
const said = (text) => record({ type: 'user', message: { role: 'user', content: text } });
const reply = (text, extra = {}) => record({ type: 'assistant', ...extra, message: { role: 'assistant', content: [{ type: 'text', text }] } });

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
// The mode it runs in, as 2.1.331 does: the flag's, else default. With
// no-auto.flag, auto is not available to it, and asked for auto it runs
// default and says so in a status record at once (measured with auto
// disabled); set_permission_mode changes it and says so the same way.
const modeAt = argv.indexOf('--permission-mode');
let mode = modeAt >= 0 ? argv[modeAt + 1] : 'default';
if (mode === 'auto' && fs.existsSync(path.join(FIX, 'no-auto.flag'))) { mode = 'default'; setTimeout(() => out({ type: 'system', subtype: 'status', status: null, permissionMode: 'default', session_id: session }), 50); }
const init = () => out({ type: 'system', subtype: 'init', session_id: session, model: 'claude-haiku-5-5', permissionMode: mode, claude_code_version: '2.1.330' });
const logIn = (o) => fs.appendFileSync(path.join(FIX, 'stdin.log'), JSON.stringify(o) + '\n');
let inTurn = false;
let pending = 0;
let closing = false;
let busy = null;
let queued = [];
let asks = 0;
const waits = new Map();
const done = () => { if (closing && pending === 0) process.exit(0); };
// \`completed\` for each message of the turn comes after its result, and
// \`cancelled\` after a failed one's (2.1.330, measured 2026-11-22: result at
// 1162 ms, completed at 1164; a signed-out turn's result, then cancelled).
const taken = [];
const result = (text, ok = true, subtype = 'success') => { inTurn = false; out({ type: 'result', subtype, is_error: !ok, result: text, session_id: session }); for (const u of taken.splice(0)) out({ type: 'command_lifecycle', command_uuid: u, state: ok ? 'completed' : 'cancelled' }); };
const ask = (request) => new Promise((res) => { const id = 'cu-' + (++asks); waits.set(id, res); out({ type: 'control_request', request_id: id, request }); });
const flushQueued = () => { for (const t of queued) said(t); queued = []; };
const ready = new Promise((r) => setTimeout(r, startDelay));

require('readline').createInterface({ input: process.stdin }).on('line', async (line) => {
  await ready;
  let r; try { r = JSON.parse(line); } catch { return; }
  if (r.type === 'control_response') {
    logIn({ type: 'control_response', request_id: r.response.request_id, response: r.response.response });
    const w = waits.get(r.response.request_id); if (w) { waits.delete(r.response.request_id); w(r.response.response || {}); }
    return;
  }
  if (r.type === 'control_request') {
    const q = r.request || {};
    logIn({ type: 'control_request', ...q });
    const answer = (response) => out({ type: 'control_response', response: { subtype: 'success', request_id: r.request_id, response } });
    if (q.subtype === 'interrupt') {
      answer({ still_queued: [] });
      // While an ask stands, as 2.1.330 does (QA, msg 4100): the ask is
      // withdrawn by control_cancel_request naming it, and the turn ends.
      for (const [id, res] of [...waits]) { waits.delete(id); out({ type: 'control_cancel_request', request_id: id }); res({ cancelled: true }); }
      if (busy) { clearTimeout(busy.timer); const b = busy; busy = null; b.stop(); }
      return;
    }
    if (q.subtype === 'set_model') { answer({ model: 'claude-' + q.model + '-5-5' }); return; }
    if (q.subtype === 'set_permission_mode') { mode = q.mode; answer({ mode }); out({ type: 'system', subtype: 'status', status: null, permissionMode: mode, session_id: session }); return; }
    if (q.subtype === 'side_question') { answer({ response: 'ASIDE:' + q.question, synthetic: false }); return; }
    answer({});
    return;
  }
  if (r.type !== 'user') return;
  const text = typeof r.message.content === 'string' ? r.message.content : JSON.stringify(r.message.content);
  logIn({ type: 'user', text });
  const hold = /^HOLD (\d+)/.exec(text);
  if (hold) await new Promise((res) => setTimeout(res, Number(hold[1])));
  // The receipt, as 2.1.330 gives it (after HOLD's delay, which is how a
  // message "taken late" is staged).
  out({ type: 'command_lifecycle', command_uuid: r.uuid, state: 'queued' });
  taken.push(r.uuid);
  // Taken into a turn already running, as 2.1.330 does: echoed when taken,
  // answered in that turn's one result, and in the conversation by its end.
  if (inTurn) { out({ type: 'user', uuid: r.uuid, isReplay: true, message: { role: 'user', content: text } }); queued.push(text); return; }
  inTurn = true;
  pending++;
  init();
  out({ type: 'user', uuid: r.uuid, isReplay: true, message: { role: 'user', content: text } });
  const finish = (words, ok = true, subtype = 'success') => { flushQueued(); if (words) reply(words); result(words, ok, subtype); };
  const slash = /^\/(\w+)/.exec(text);
  if (!slash) said(text);
  if (signedOut) {
    reply('Not logged in · Please run /login', { isApiErrorMessage: true });
    result('Not logged in · Please run /login', false, 'error_during_execution');
  } else if (text === 'DIE') {
    process.exit(3);
  } else if (text.startsWith('PERMIT ')) {
    const tool = text.slice(7);
    const a = await ask({ subtype: 'can_use_tool', tool_name: tool, display_name: tool, input: { command: 'ls' }, description: 'List files', permission_suggestions: [{ type: 'addRules', rules: [{ toolName: tool, ruleContent: 'ls' }], behavior: 'allow', destination: 'localSettings' }] });
    if (a.cancelled) result('', false, 'error_during_execution');
    else finish(a.behavior === 'allow' ? 'ALLOWED:' + JSON.stringify(a.updatedInput) + (a.updatedPermissions ? ':ALWAYS' : '') : 'DENIED:' + a.message);
  } else if (text === 'PAIR') {
    // Two asks at once, the conversation's own and a subagent's (2.1.330:
    // a subagent's can_use_tool carries agent_id, and its meta file names it).
    const sub = path.join(transcriptFile().replace(/\.jsonl$/, ''), 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'agent-sub1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Build incidents capture' }));
    const [p1, p2] = await Promise.all([
      ask({ subtype: 'can_use_tool', tool_name: 'Bash', display_name: 'Bash', input: { command: 'touch parent' }, description: 'Parent touch', permission_suggestions: [], tool_use_id: 'tu-p' }),
      ask({ subtype: 'can_use_tool', tool_name: 'Bash', display_name: 'Bash', input: { command: 'touch sub' }, description: 'Subagent touch', permission_suggestions: [], tool_use_id: 'tu-s', agent_id: 'sub1' }),
    ]);
    finish('PAIR:' + p1.behavior + ',' + p2.behavior);
  } else if (text === 'BGSUB') {
    // A background subagent asking after its parent's turn has ended
    // (QA, a real 2.1.330 at patch E): its ask is still waited on.
    const sub = path.join(transcriptFile().replace(/\.jsonl$/, ''), 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'agent-sub2.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Background capture' }));
    const waiting = ask({ subtype: 'can_use_tool', tool_name: 'Bash', display_name: 'Bash', input: { command: 'touch bg' }, description: 'Background touch', permission_suggestions: [], tool_use_id: 'tu-bg', agent_id: 'sub2' });
    finish('BG-STARTED');
    const a = await waiting;
    reply('BGSUB:' + a.behavior);
  } else if (text === 'CANCELASK') {
    // Claude Code withdrawing what it asked (control_cancel_request, as
    // 2.1.330 sends it on an interrupt while an ask stands; QA, msg 4100).
    const pend = ask({ subtype: 'can_use_tool', tool_name: 'Bash', display_name: 'Bash', input: { command: 'touch x' }, description: 'Touch a file', permission_suggestions: [] });
    await new Promise((res) => setTimeout(res, 1500));
    for (const [id, res] of [...waits]) { waits.delete(id); out({ type: 'control_cancel_request', request_id: id }); res({ cancelled: true }); }
    await pend;
    result('', false, 'error_during_execution');
  } else if (text === 'ASK') {
    const input = { questions: [{ question: 'Pick a colour', header: 'Colour', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] }, { question: 'Pick a day', header: 'Day', multiSelect: false, options: [{ label: 'Monday' }, { label: 'Friday' }] }] };
    const a = await ask({ subtype: 'can_use_tool', tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion', input });
    finish(a.behavior === 'allow' ? 'ANSWERS:' + JSON.stringify(a.updatedInput.answers) : 'DENIED:' + a.message);
  } else if (text === 'DIALOG') {
    const a = await ask({ subtype: 'request_user_dialog', title: 'Try the new renderer?', options: ['Yes', 'Not now'] });
    finish('DIALOG:' + a.behavior);
  } else if (/^(SLOW|QUIET) \d+$/.test(text)) {
    const [word, ms] = text.split(' ');
    if (word === 'SLOW') record({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-' + n, name: 'Bash', input: { command: 'sleep ' + Math.round(Number(ms) / 1000) } }] } });
    const stopped = await new Promise((res) => { busy = { timer: setTimeout(() => { busy = null; res(false); }, Number(ms)), stop: () => res(true) }; });
    if (stopped) finish('INTERRUPTED', false, 'error_during_execution');
    else finish(word + '-DONE');
  } else if (slash && slash[1] === 'compact') {
    out({ type: 'system', subtype: 'status', status: 'compacting' });
    await new Promise((res) => setTimeout(res, 300));
    record({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', level: 'info', compactMetadata: { trigger: 'manual', preTokens: 5000, postTokens: 900, durationMs: 300 } });
    out({ type: 'system', subtype: 'status', status: null, compact_result: 'success' });
    out({ type: 'system', subtype: 'compact_boundary' });
    result('');
  } else if (slash && slash[1] === 'clear') {
    // As 2.1.330 does it: the reset names a conversation id that is not
    // the session's (and nothing is written under it); the init after it
    // names the session.
    out({ type: 'conversation_reset', new_conversation_id: randomUUID(), trigger: 'clear' });
    session = newId();
    announce();
    init();
    result('');
  } else {
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'ECHO:' + text }] } });
    finish('ECHO:' + text);
  }
  pending--;
  done();
});
// Input closed is a stop (host/agent.js stop()): a turn running finishes and
// the process leaves; one waiting on an answer that can no longer come leaves at once.
process.stdin.on('end', () => { closing = true; if (waits.size) process.exit(0); done(); });
`;

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
      ORCH_HOST_CLAUDE: `${FIX}/claude`,
      ORCH_HOST_WATCH_MS: '300', ORCH_HOST_CONFIG: '/nonexistent/host.json',
      // A message's attachments are written here (host/uploads.js), not
      // beside a host.json that does not exist.
      ORCH_HOST_UPLOADS: `${FIX}/uploads`,
      // Every bind holds 700 ms after its rescan: more than a watch tick, so
      // a move's desk is always watched before bind() goes on. The move
      // section's "no session row for the conversation it left" reads the
      // race every run (CLAUDE.md, Tests, the seventh sighting).
      ORCH_HOST_BIND_GAP_MS: '700',
      // The folder dialog is the stand-in above, and one left open is closed
      // after four seconds rather than ten minutes — longer than the three
      // the slowest "person" below takes to choose.
      ORCH_FOLDER_DIALOG: `${FIX}/dialog`, ORCH_PICK_TIMEOUT_MS: '4000',
      // A conversation read whole goes up three turns to a page, so a short
      // fixture still crosses a page boundary.
      ORCH_READ_PAGE_TURNS: '3',
      // Nothing on the operator's screen: a handback runs this in place of
      // `open -a "Visual Studio Code"` (host/claude.js openInEditor), and
      // "Open in Claude" is asked for a terminal this host has no script
      // for, so it says so rather than open Terminal or iTerm.
      ORCH_EDITOR_OPEN: `${FIX}/editor`, ORCH_TERMINAL: 'none-in-tests',
      // A desk's Claude Code that has not left 2 s after its input closed is
      // ended (host/agent.js), not 5 s: the stand-in leaves at once.
      ORCH_STOP_GRACE_MS: '2000',
      // The desk-pid record (task 340) goes beside host.json, which here does
      // not exist; the fixture HOME's is where the rows read it.
      ORCH_DESK_PIDS_DIR: `${HOME}/.orchestratinator`,
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

/* This run's stand-in claudes, by this run's fixture path, so a run beside
 * it (QA's clone, a mutant copy) is neither counted nor killed by it. A desk's
 * Claude Code is the host's child now, and a host killed outright leaves it
 * to end on its own when its input closes: a run leaves none (task 263). */
const STAND_IN = `${FIX}/claude.cjs`;
const standIns = () => {
  let out = '';
  try { out = execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' }); } catch { return []; }
  return out.split('\n').map((l) => l.trim().split(/\s+/)).filter(([, exe, script, first]) => /(^|\/)node$/.test(exe ?? '') && script === STAND_IN && first === '-p').map(([pid]) => Number(pid));
};
const sweep = () => { for (const p of standIns()) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } } };
const childrenOf = (ppid) => {
  try { return execFileSync('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8' }).split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter(([, pp]) => pp === ppid).map(([p]) => p); } catch { return []; }
};

let server = null;
let host = null;
let hostLog = '';

// An interrupted run cleans up after itself too: Ctrl-C, or a kill of the
// suite, lands here instead of leaving its server, its hosts and its
// stand-ins running (task 263). The finally below does not run on a signal.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const p of childrenOf(process.pid)) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    sweep();
    rmDb(DB_PATH);
    rmSync(FIX, { recursive: true, force: true });
    console.log(`\nhost: interrupted by ${sig}; its server, hosts and stand-ins are gone`);
    process.exit(130);
  });
}

/** Wait for a desk's floor state: who holds it, and on which conversation. */
const heldBy = (agent, held, sid = undefined, ms = 20000, ch = CH) => until(async () => {
  const d = (await floor()).channels.find((c) => c.channel === ch)?.desks.find((x) => x.agent === agent);
  return d?.hosted?.held === held && (sid === undefined || d.hosted.session_id === sid) ? d : null;
}, ms);
/** End a desk's Claude Code from outside the host, as a person quitting it would: SIGTERM, a clean exit. */
// Waits on the things themselves (QA, msg 4130): a Claude Code just (re)started
// may not be in ps yet, so the processes are waited for before the signal,
// and their going before the held-by-nobody wait.
const quitByHand = async (dir = REPO, agent = 'free', ch = CH) => {
  const procs = await until(() => { const p = procsIn(dir); return p.length ? p : null; }, 8000) ?? [];
  for (const s of procs) { try { process.kill(s.pid, 'SIGTERM'); } catch { /* gone */ } }
  await until(() => (procs.every((s) => { try { process.kill(s.pid, 0); return false; } catch { return true; } }) ? true : null), 8000);
  return heldBy(agent, null, undefined, 8000, ch);
};
const turnRows = async (agent = 'free', ch = CH) => (await json(`/api/floor/turns?channel=${ch}&agent=${agent}&limit=500`).then((r) => r.json())).rows ?? [];
const newRows = async (before, agent = 'free', ch = CH) => (await turnRows(agent, ch)).filter((r) => r.id > before);
const lastId = async (agent = 'free', ch = CH) => Math.max(0, ...(await turnRows(agent, ch)).map((r) => r.id));
/** Put free back on its first conversation with its Claude Code running, for the sections that read SESSION_ID's transcript. */
const backHome = async () => {
  const d = deskOf(await floor(), 'free');
  if (!(d?.hosted?.session_id === SESSION_ID && d.hosted.held === 'floor')) {
    await json('/api/floor/reopen', { channel: CH, agent: 'free', session_id: SESSION_ID });
  }
  return heldBy('free', 'floor', SESSION_ID, 20000);
};

try {
  rmDb(DB_PATH);
  fixture();
  // A function, because one row restarts the board on the same database,
  // as a deploy does (the milestone audit's finding 1).
  const startServer = () => spawn('node', ['src/server.js'], {
    // A floor desk whose tools dropped is asked about after 1.5 s here (20 s
    // on a real board), and not again within the run: the stand-in never
    // connects, so a retry would ask for it again mid-suite.
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

  console.log('\na message from the floor');
  nextFreshId(SESSION_ID);
  const argvAtFirst = argvLog().length;
  const sent = await chat('free', 'ship it');
  eq(sent.status, 200, 'the floor accepts a message for a desk with nothing running yet');
  assert(!!(await heldBy('free', 'floor', SESSION_ID)), 'the host starts the desk\'s Claude Code, and the floor holds the desk, on the conversation Claude Code named at the message');
  eq(await launchedSince(argvAtFirst), ['-p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio --replay-user-messages --permission-mode auto'],
    'one Claude Code, started as the programmatic interface: stream-JSON both ways, permissions over stdin, every message echoed, nothing to resume, and in auto mode: nobody chose another (costmo, 2026-11-23)');
  assert(await until(async () => ((await turnRows()).some((r) => r.role === 'assistant' && r.text === 'ECHO:ship it') ? true : null), 10000),
    'the message is delivered and its reply reaches the floor, read from the transcript Claude Code writes');
  assert((await turnRows()).some((r) => r.role === 'user' && r.text === 'ship it'), 'both sides of it');
  eq(JSON.parse(readFileSync(`${FIX}/env.log`, 'utf8').trim().split('\n')[0]).orch, [], 'and the desk\'s Claude Code is given nothing of the host\'s own ORCH_ settings');

  const multi = await chat('free', 'first line\nsecond line');
  eq(multi.status, 200, 'a multi-line message is accepted');
  assert(await until(() => (stdinRecords().some((r) => r.type === 'user' && r.text === 'first line\nsecond line') ? true : null)), 'and arrives whole, as one message: nothing is typed, so nothing can be split or wrapped');

  console.log('\n  a message while the desk is working');
  eq((await chat('free', 'QUIET 4000')).status, 200, 'a turn that takes a while is started');
  await until(() => (stdinRecords().some((r) => r.text === 'QUIET 4000') ? true : null));
  await sleep(300);
  eq((await chat('free', 'and meanwhile this')).status, 200, 'a message sent while it works is taken by the board');
  const queuedNote = await until(async () => deskOf(await floor(), 'free')?.delivery ?? null, 8000);
  eq([queuedNote?.state, queuedNote?.text], ['queued', 'and meanwhile this'], 'and the desk says it is queued: Claude Code took it into the running turn');
  assert(await until(async () => (deskOf(await floor(), 'free')?.delivery ? null : true), 10000), 'the note goes when the message becomes a turn, at the turn\'s end');
  assert((await turnRows()).some((r) => r.role === 'user' && r.text === 'and meanwhile this'), 'and the message is in the conversation');

  console.log('\n  what Claude Code asks: a permission');
  const permOf = async () => deskOf(await floor(), 'free')?.permission ?? null;
  const askPermission = async (tool = 'Bash') => {
    await chat('free', `PERMIT ${tool}`);
    return until(async () => { const p = await permOf(); return p?.options?.length ? p : null; }, 10000);
  };
  const answerFor = (rid) => until(() => answersSent().find((a) => a.request_id === rid) ?? null, 8000);
  const replyAfter = async (mark, re) => until(async () => (await newRows(mark)).find((r) => r.role === 'assistant' && re.test(r.text ?? '')) ?? null, 10000);
  let mark = await lastId();
  let p = await askPermission();
  assert(!!p, 'a permission Claude Code asks for is on the desk, with nothing read off a screen');
  eq(p?.options?.map((o) => o.text), ['Yes', "Yes, and don't ask again for Bash(ls)", 'No'], 'with three rows: yes, yes for good under the rule Claude Code offered, and no');
  eq(p?.summary, 'Bash: ls', 'and what it is for');
  // Held, not refused (F17, costmo 2026-11-23: with prompts several a
  // second, a refused message never reached the desk).
  const heldWhileAsking = await chat('free', 'held behind the permission');
  eq(heldWhileAsking.status, 200, 'a message to a desk that is asking is taken by the board');
  assert(await until(() => (host.log.includes('held behind the permission') || readFileSync(STDIN_LOG, 'utf8').includes('held behind the permission') ? true : null), 10000), 'and written to its Claude Code, held behind the prompt');
  eq((await json('/api/floor/permission', { channel: CH, agent: 'free', request_id: p?.request_id, decision: 'allow' })).status, 200, 'Approve is taken');
  eq((await answerFor(p?.request_id))?.response, { behavior: 'allow', updatedInput: { command: 'ls' } }, 'and reaches Claude Code as an allow, with the input it asked to run with');
  assert(!!(await replyAfter(mark, /^ALLOWED:\{"command":"ls"\}$/)), 'which Claude Code reads as allowed, and says so on the floor');
  assert(!!(await until(async () => (await newRows(mark)).find((r) => r.role === 'user' && r.text === 'held behind the permission') ?? null, 10000)), 'and the message held behind it is in the conversation');
  assert(await until(async () => ((await permOf()) ? null : true), 5000), 'and the desk asks nothing any more');

  mark = await lastId();
  p = await askPermission();
  eq((await json('/api/floor/permission', { channel: CH, agent: 'free', request_id: p?.request_id, decision: '2' })).status, 200, 'the second row is taken by its number');
  eq((await answerFor(p?.request_id))?.response?.updatedPermissions, [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], behavior: 'allow', destination: 'localSettings' }],
    'and allows it for good, with the rule Claude Code suggested');
  assert(!!(await replyAfter(mark, /:ALWAYS$/)), 'which Claude Code reads as that');

  mark = await lastId();
  p = await askPermission('Write');
  eq((await json('/api/floor/permission', { channel: CH, agent: 'free', request_id: p?.request_id, decision: 'deny', reason: 'not that file' })).status, 200, 'Deny with a reason is taken');
  eq((await answerFor(p?.request_id))?.response, { behavior: 'deny', message: 'not that file' }, 'and reaches Claude Code as a refusal carrying the operator\'s words');
  assert(!!(await replyAfter(mark, /^DENIED:not that file$/)), 'which Claude Code reads');

  mark = await lastId();
  p = await askPermission();
  const controlsBeforeCancel = controlsSent().length;
  eq((await json('/api/floor/permission', { channel: CH, agent: 'free', request_id: p?.request_id, decision: 'cancel' })).status, 200, 'Cancel is taken');
  eq((await answerFor(p?.request_id))?.response, { behavior: 'deny', message: 'The operator cancelled this.' }, 'and is a refusal');
  assert(await until(() => (controlsSent().slice(controlsBeforeCancel).some((c) => c.subtype === 'interrupt') ? true : null), 8000), 'followed by a stop of the turn, as Escape was');

  // Two asks at once, the conversation's own and a subagent's (task 352 A):
  // both stand, one shown and one counted, the parent's never replaced, and
  // the subagent's named by the description its caller gave it.
  mark = await lastId();
  await chat('free', 'PAIR');
  const pair1 = await until(async () => { const q = await permOf(); return q?.more === 1 ? q : null; }, 10000);
  eq([pair1?.message, pair1?.more, pair1?.via ?? null], ['Parent touch', 1, null], 'two asks at once: the first is shown, the other counted behind it');
  eq((await json('/api/floor/permission', { channel: CH, agent: 'free', request_id: pair1?.request_id, decision: 'allow' })).status, 200, 'the first is answered');
  const pair2 = await until(async () => { const q = await permOf(); return q && q.request_id !== pair1?.request_id ? q : null; }, 10000);
  eq([pair2?.message, pair2?.more, pair2?.via], ['Subagent touch', 0, 'Build incidents capture'], "and the subagent's comes forward, named as the subagent's");
  eq((await json('/api/floor/permission', { channel: CH, agent: 'free', request_id: pair2?.request_id, decision: 'allow' })).status, 200, 'and is answered in its turn');
  assert(!!(await replyAfter(mark, /^PAIR:allow,allow$/)), 'and Claude Code had both answers');

  // A background subagent's ask, standing after its parent's turn has ended:
  // it stays on the floor, the desk takes no message while it does, and the
  // answer reaches the subagent (QA at patch E: the host dropped it at the
  // turn's result, and the subagent waited for ever on nothing anyone saw).
  mark = await lastId();
  await chat('free', 'BGSUB');
  assert(!!(await replyAfter(mark, /^BG-STARTED$/)), "the fixture: the parent's turn has ended");
  await sleep(1500);
  const bgAsk = await permOf();
  eq([bgAsk?.message, bgAsk?.via], ['Background touch', 'Background capture'], "the subagent's ask is still on the floor after its parent's turn ended, named as the subagent's");
  const subHeld = await chat('free', 'while the subagent asks');
  eq(subHeld.status, 200, 'and a message sent while it stands is taken, for the host to hold');
  eq((await json('/api/floor/permission', { channel: CH, agent: 'free', request_id: bgAsk?.request_id, decision: 'allow' })).status, 200, 'it is answered from the floor');
  assert(!!(await replyAfter(mark, /^BGSUB:allow$/)), 'and the answer reaches the subagent, which goes on');
  assert(await until(async () => ((await permOf()) ? null : true), 5000), 'and the desk asks nothing any more');

  // Claude Code withdrawing an ask (control_cancel_request; QA measured it
  // on 2.1.330 for an interrupt while a permission stood, msg 4100). The
  // floor's own stop sign is refused while a desk asks (Cancel answers the
  // ask first), but any withdrawal must take the prompt off the floor and
  // let the desk take messages again: read as nothing, the dead ask refused
  // every message "waiting on an answer".
  await chat('free', 'CANCELASK');
  assert(!!(await until(async () => (await permOf()) ?? null, 10000)), 'the fixture: Claude Code asks');
  assert(await until(async () => ((await permOf()) ? null : true), 10000), 'and when it withdraws the ask, the prompt leaves the floor');
  mark = await lastId();
  eq((await chat('free', 'after a withdrawn ask')).status, 200, 'and a message to the desk is taken');
  assert(!!(await replyAfter(mark, /^ECHO:after a withdrawn ask$/)), 'and answered, not refused as waiting on an answer');

  // A board restart (every deploy) while Claude Code is still asking
  // (milestone audit 2026-11-17, finding 1). The board keeps open prompts in
  // memory only. The host's work poll fails at the restart, it registers
  // again at once, and every registration says again what each desk's
  // Claude Code is still asking (standingAsks).
  p = await askPermission();
  const rid = p?.request_id;
  const restarted = server;
  await new Promise((done) => { restarted.once('exit', done); restarted.kill('SIGTERM'); });
  server = startServer();
  assert(await waitHealthy(), 'the board restarts on the same database');
  const backAgain = await until(async () => { const q = await permOf(); return q?.request_id === rid ? q : null; }, 30000);
  assert(!!backAgain, 'and the permission Claude Code is still asking for is back on the floor, said again by the host, with no hook to say it');
  mark = await lastId();
  eq((await json('/api/floor/permission', { channel: CH, agent: 'free', request_id: rid, decision: 'allow' })).status, 200, 'and it can be answered from there');
  assert(!!(await replyAfter(mark, /^ALLOWED:/)), 'and the answer reaches Claude Code');

  console.log('\n  what Claude Code asks: a question');
  mark = await lastId();
  await chat('free', 'ASK');
  const form = await until(async () => { const q = await permOf(); return q?.questions?.length ? q : null; }, 10000);
  eq(form?.questions?.map((q) => q.tab_title), ['Colour', 'Day'], 'a question is a form on the desk, built from what Claude Code asked');
  const n = (q, label) => form?.questions?.[q]?.options?.find((o) => o.text === label)?.n;
  eq((await json('/api/floor/answer', { channel: CH, agent: 'free', request_id: form?.request_id, answers: [{ choose: [n(0, 'Blue')] }, { choose: [n(1, 'Friday')] }] })).status, 200, 'the operator\'s answers are taken');
  eq((await answerFor(form?.request_id))?.response, { behavior: 'allow', updatedInput: { ...{ questions: [{ question: 'Pick a colour', header: 'Colour', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] }, { question: 'Pick a day', header: 'Day', multiSelect: false, options: [{ label: 'Monday' }, { label: 'Friday' }] }] }, answers: { 'Pick a colour': 'Blue', 'Pick a day': 'Friday' } } },
    'and reach Claude Code as the tool\'s own answers, question by question');
  assert(!!(await replyAfter(mark, /^ANSWERS:\{"Pick a colour":"Blue","Pick a day":"Friday"\}$/)), 'which it reads');

  // Something Claude Code asks that the floor has no way to answer (a
  // dialog it would have drawn): declined, so the turn is not held, and said.
  mark = await lastId();
  await chat('free', 'DIALOG');
  assert(!!(await replyAfter(mark, /^DIALOG:deny$/)), 'a request the floor cannot answer is declined, never left hanging');
  assert((await newRows(mark)).some((r) => r.tool_name === 'host' && /asked something the floor cannot answer yet \(request_user_dialog\)/.test(r.text ?? '')), 'and the desk says what it was');

  /* Commands: the ones Claude Code takes as a control request go as one,
   * and the desk says what was asked and what came back, as one line
   * labeled host (host/desk.js commandPlan). /compact and /clear are
   * messages, as typed in a window. */
  console.log('\n  commands');
  const hostLine = async (since, re) => until(async () => (await newRows(since)).find((r) => r.tool_name === 'host' && re.test(r.text ?? '')) ?? null, 10000);
  const controlOf = (subtype, from) => until(() => controlsSent().slice(from).find((c) => c.subtype === subtype) ?? null, 8000);
  let cmark = controlsSent().length;
  mark = await lastId();
  eq((await chat('free', '/model sonnet')).status, 200, '/model is taken');
  eq((await controlOf('set_model', cmark))?.model, 'sonnet', 'and goes as Claude Code\'s set_model request');
  assert(!!(await hostLine(mark, /^\/model sonnet — Set model to claude-sonnet-5-5\b/)), 'the desk says what was asked, in the model Claude Code named');
  assert(await until(async () => (deskOf(await floor(), 'free')?.session?.model === 'claude-sonnet-5-5' ? true : null), 5000), 'and the session\'s model is that one');
  eq(JSON.parse(readFileSync(`${HOME}/.claude/settings.json`, 'utf8')).model, 'sonnet', 'and saved as the default for new sessions, in Claude Code\'s own settings (here the fixture\'s)');
  cmark = controlsSent().length;
  mark = await lastId();
  eq((await chat('free', '/effort high')).status, 200, '/effort is taken');
  eq((await controlOf('apply_flag_settings', cmark))?.settings, { effortLevel: 'high' }, 'and goes as a settings change');
  assert(!!(await hostLine(mark, /^\/effort high — Set effort level to high\b/)), 'said on the desk');
  assert(await until(async () => (deskOf(await floor(), 'free')?.session?.effort === 'high' ? true : null), 5000), 'and the session\'s effort is that');
  cmark = controlsSent().length;
  mark = await lastId();
  eq((await chat('free', '/btw what is 6*7?')).status, 200, '/btw is taken');
  eq((await controlOf('side_question', cmark))?.question, 'what is 6*7?', 'and goes as a side question');
  const aside = await until(async () => (await newRows(mark)).find((r) => r.via === '/btw') ?? null, 10000);
  eq([aside?.role, aside?.text], ['assistant', 'ASIDE:what is 6*7?'], 'its answer is the agent\'s, labeled by the command');
  assert(!!(await hostLine(mark, /^\/btw what is 6\*7\? — answered$/)), 'and the desk says it was answered');
  // A bare /mcp reconnects the desk's tools, by the name its binding gives
  // the board's server (here `team-board`, from the repo's .mcp.json).
  cmark = controlsSent().length;
  mark = await lastId();
  eq((await chat('free', '/mcp')).status, 200, 'a bare /mcp is taken');
  eq((await controlOf('mcp_reconnect', cmark))?.serverName, 'team-board', 'and reconnects the desk\'s own server, by the name its binding gives it');
  assert(!!(await hostLine(mark, /^\/mcp — Reconnected to team-board$/)), 'said on the desk');
  mark = await lastId();
  eq((await chat('free', '/compact')).status, 200, '/compact is taken');
  assert(await until(async () => ((await newRows(mark)).some((r) => r.role === 'context' && r.tool_name === 'compact') ? true : null), 10000), 'it compacts, and the boundary Claude Code writes is a line on the desk');
  assert(await until(async () => (deskOf(await floor(), 'free')?.delivery?.said === 'Compacted' ? true : null), 5000), 'and the desk says it compacted');
  const CLEARED = '33333333-cccc-3333-4444-555555555555';
  nextFreshId(CLEARED);
  eq((await chat('free', '/clear')).status, 200, '/clear is taken');
  assert(!!(await heldBy('free', 'floor', CLEARED, 10000)), 'and the desk moves to the new conversation Claude Code names');
  // A compaction from the floor marks the desk working on the board, and
  // the end of the process's turn ends it, with no hook: the stand-in has no
  // plugin, as a machine whose plugin does not report has none.
  assert(await until(async () => (deskOf(await floor(), 'free')?.working ? null : true), 10000), 'the desk is idle again once its turn ends, said by the host from the process (no hook)');
  const backOn = await json('/api/floor/reopen', { channel: CH, agent: 'free', session_id: SESSION_ID });
  eq([backOn.status, backOn.status === 200 ? null : (await backOn.json()).error], [200, null], 'the fixture: back on the first conversation for what follows');
  assert(!!(await heldBy('free', 'floor', SESSION_ID)), 'the fixture: on it');

  // And by itself: a desk whose agent had a session on this board, and has
  // none now (as after the desktop app restarts its board), is reconnected
  // by its host when the board asks. The stand-in never connects, so the
  // suite connects as the desk and then drops the session, which is what a
  // board restart does to it.
  console.log('\n  a reconnect the board asks for');
  const mh = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'X-Channel': CH, 'X-Agent': 'free', 'x-orchestratinator-key': KEY };
  const init = await fetch(`${HOST}/mcp`, { method: 'POST', headers: mh, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'host-test', version: '0' } } }) });
  await init.text();
  cmark = controlsSent().length;
  mark = await lastId();
  await fetch(`${HOST}/mcp`, { method: 'DELETE', headers: { ...mh, 'mcp-session-id': init.headers.get('mcp-session-id') } }).then((x) => x.text());
  eq((await until(() => controlsSent().slice(cmark).find((c) => c.subtype === 'mcp_reconnect') ?? null, 45000))?.serverName, 'team-board',
    'with nothing typed by anybody, the desk\'s Claude Code is asked to reconnect its own server');
  assert(!!(await hostLine(mark, /^the desk's tools had lost the board, so the host reconnected them to team-board$/)), 'and the desk says why the host did it');

  // A stop: SLOW runs a tool first, so the board sees the desk working and
  // lights its stop sign; the stop is Claude Code's own interrupt request.
  console.log('\n  a stop');
  mark = await lastId();
  await chat('free', 'SLOW 20000');
  assert(await until(async () => (deskOf(await floor(), 'free')?.stop?.ok ? true : null), 10000), 'a desk running a tool can be stopped');
  const busyReopen = await json('/api/floor/reopen', { channel: CH, agent: 'free', session_id: SESSION_ID });
  eq([busyReopen.status, (await busyReopen.json()).code], [409, 'working'], 'and the board refuses to reopen it mid-turn');
  cmark = controlsSent().length;
  eq((await json('/api/floor/interrupt', { channel: CH, agent: 'free' })).status, 200, 'the stop is taken');
  assert(!!(await controlOf('interrupt', cmark)), 'and goes as Claude Code\'s interrupt request');
  assert(!!(await replyAfter(mark, /^INTERRUPTED$/)), 'and the turn ends, interrupted, long before its twenty seconds');
  assert(await until(async () => (deskOf(await floor(), 'free')?.working ? null : true), 5000), 'the desk is no longer working');

  // A turn that runs no tool: the board still sees it, because the host says
  // each turn's start and end from the process itself (no hook needed), so
  // the reopen is refused before it reaches the host. The host's own refusal
  // stays for a reopen that crosses the turn's start (test:seats has it).
  mark = await lastId();
  await chat('free', 'QUIET 3000');
  await until(() => (stdinRecords().some((r) => r.text === 'QUIET 3000' && r.type === 'user') ? true : null));
  assert(await until(async () => (deskOf(await floor(), 'free')?.working ? true : null), 5000), 'a turn that runs no tool reads as working on the board, said by the host from the process');
  const quietReopen = await json('/api/floor/reopen', { channel: CH, agent: 'free', session_id: null });
  eq([quietReopen.status, (await quietReopen.json()).code], [409, 'working'], 'so a reopen during it is refused by the board');
  assert(!!(await replyAfter(mark, /^QUIET-DONE$/)), 'the turn it would have cut off finishes');
  eq(deskOf(await floor(), 'free')?.hosted?.session_id, SESSION_ID, 'on the conversation it was on');

  /* Issue #31: a file attached on the floor. The board stages it, the host
   * fetches it to its own disk, outside every repo, and puts its path in the
   * message. What Claude Code is sent is read off the stand-in's stdin log;
   * what is on the disk is read off the disk. */
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
  const typed = await until(() => stdinRecords().find((r) => r.type === 'user' && r.text.includes(logPath))?.text ?? null, 15000);
  eq(typed, `what broke here?\n\n${ATTACHED_HEADER}\n- ${shotPath}\n- ${logPath}`,
    'Claude Code is sent one message: the words, then the list, one path a line, in the order attached');
  eq([existsSync(shotPath) && [...readFileSync(shotPath)], existsSync(logPath) && readFileSync(logPath, 'utf8')], [[...shotBytes], 'line 1\nline 2\n'],
    'and each file is on the host\'s disk under its own name, byte for byte');
  assert(!shotPath.startsWith(REPO) && !existsSync(`${REPO}/shot one.png`), 'outside the desk\'s folder: nothing lands in the repo');
  const before31 = stdinRecords().length;
  const alone = await json('/api/floor/chat', { channel: CH, agent: 'free', files: [shotUp.id] });
  eq(alone.status, 200, 'files alone are a message');
  const aloneSent = await until(() => stdinRecords().slice(before31).find((r) => r.type === 'user' && r.text.includes(shotPath))?.text ?? null, 15000);
  eq(aloneSent, `${ATTACHED_HEADER}\n- ${shotPath}`, 'and it is the list alone, opening on its header');
  // A file the host cannot write: its folder is taken by a plain file, so
  // the fetch fails before a byte is written. Nothing of the message is sent.
  const blocked = await stage(Buffer.from('x'), 'blocked.txt', 'text/plain');
  writeFileSync(`${FIX}/uploads/${blocked.id}`, 'in the way');
  const before31b = stdinRecords().length;
  const failing = await json('/api/floor/chat', { channel: CH, agent: 'free', text: 'about the blocked one', files: [blocked.id] });
  eq(failing.status, 200, 'the board takes a message whose file the host will fail to write');
  const failRows = await until(async () => {
    const rows = (await turns('free')).rows ?? [];
    return rows.some((r) => r.role === 'error' && /blocked\.txt.*; nothing was typed$/.test(r.text ?? '')) ? rows : null;
  }, 15000);
  const failText = failRows?.filter((r) => r.role === 'error').at(-1)?.text ?? '';
  assert(!!failRows, `the desk is told why, then that nothing was sent, in an error turn — ${failText}`);
  // Not "not sent — …": a meeting room puts "not delivered — " before a
  // desk's error, and the two read as one stutter (QA, PR #58 Info 6).
  assert(!/^not (sent|delivered)\b/.test(failText), 'in words that read whole under a meeting room\'s own "not delivered — "');
  await sleep(500);
  assert(!stdinRecords().slice(before31b).some((r) => (r.text ?? '').includes('about the blocked one')), 'and none of its words reach Claude Code');
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
  const tool = await until(async () => ((await turns('free')).rows ?? []).find((r) => r.role === 'tool' && r.text === 'Bash: npm test'));
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
  eq((filed ?? []).find((r) => r.tool_name === 'compact' && (r.text ?? '').includes('(auto)'))?.text, 'Conversation compacted (auto): 71,299 → 12,473 tokens in 16.1 s', 'the boundary is a line in the compaction\'s own terms');
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

  console.log('\nwhen the desk\'s Claude Code ends');
  // Ended from outside, as a person quitting it would. The desk remembers its
  // conversation, and the next message from the floor resumes it rather than
  // starting a new one: the history on screen stays, and the reply lands in it.
  assert(!!(await quitByHand()), 'a desk whose Claude Code was quit is held by nobody');
  let argvAt = argvLog().length;
  eq((await chat('free', 'still there?')).status, 200, 'and the floor still takes a message for it');
  assert(!!(await heldBy('free', 'floor', SESSION_ID)), 'which starts its Claude Code again');
  // The launch is waited for, not read at once: "held by the floor" can be
  // reported before the stand-in has written its line (QA, msg 4113).
  const resumedArgv = await until(() => { const l = launches(argvAt); return l.length ? l : null; }, 8000) ?? [];
  eq(resumedArgv.map((l) => l.split(' ').slice(-2).join(' ')), [`--resume ${SESSION_ID}`], 'resuming the same conversation rather than starting a new one');
  assert(await until(async () => ((await turnRows()).some((r) => r.text === 'ECHO:still there?') ? true : null), 10000), 'and the message is delivered there');

  // Ended on its own, mid-turn: said on the desk, and the next message starts it again.
  mark = await lastId();
  eq((await chat('free', 'DIE')).status, 200, 'a message the desk\'s Claude Code takes and then dies on');
  const exited = await until(async () => (await newRows(mark)).find((r) => r.role === 'error' && /Claude Code ended/.test(r.text ?? '')) ?? null, 10000);
  assert(/^the desk's Claude Code ended \(code 3\).*The next message starts it again\.$/.test(exited?.text ?? ''), `is said on the desk, with how it ended — ${exited?.text}`);
  assert(!!(await heldBy('free', null, undefined, 5000)), 'and the floor no longer holds the desk');
  argvAt = argvLog().length;
  mark = await lastId();
  eq((await chat('free', 'after the end')).status, 200, 'the next message is taken');
  assert(await until(async () => ((await newRows(mark)).some((r) => r.text === 'ECHO:after the end') ? true : null), 10000), 'and starts it again, on the same conversation, and is answered');
  eq((await launchedSince(argvAt)).length, 1, 'one Claude Code started for it');

  // Held by a background session (Claude Code's daemon kept it running after
  // its tab closed): there is nobody to close it, so the host stops it with
  // claude stop and takes the conversation, saying so; never "close it there".
  console.log('\n  a conversation running as a background session');
  const bgSession = (job) => {
    const p = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
    p.unref();
    writeFileSync(`${HOME}/.claude/sessions/${p.pid}.json`, JSON.stringify({ pid: p.pid, sessionId: SESSION_ID, cwd: REPO, kind: 'bg', jobId: job, entrypoint: 'cli', startedAt: Date.now() }));
    return p.pid;
  };
  const bgAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert(!!(await quitByHand()), 'the fixture: the desk\'s own Claude Code quit');
  let bgPid = bgSession('stuck-1');
  mark = await lastId();
  eq((await chat('free', 'over to the floor')).status, 200, 'a message for a desk whose conversation a background session holds is taken');
  const bgRefused = await until(async () => (await newRows(mark)).find((r) => r.role === 'error') ?? null, 15000);
  assert(/^That conversation is running as a background Claude Code session \(stuck-1, pid \d+\), and `claude stop stuck-1` did not stop it: could not stop stuck-1\.$/.test(bgRefused?.text ?? ''),
    `when claude stop fails, the desk says so in its words and nothing is started — ${bgRefused?.text}`);
  try { process.kill(bgPid, 'SIGTERM'); } catch { /* gone */ }
  rmSync(`${HOME}/.claude/sessions/${bgPid}.json`, { force: true });
  bgPid = bgSession('bgjob-1');
  argvAt = argvLog().length;
  mark = await lastId();
  eq((await chat('free', 'over to the floor')).status, 200, 'and when it can be stopped');
  assert(!!(await hostLine(mark, /^its conversation was running as a background Claude Code session \(bgjob-1\), so the host stopped that with claude stop and resumed it here$/)), 'the host stops it and says so on the desk');
  assert(await until(() => (!bgAlive(bgPid) ? true : null), 5000), 'the background session is gone');
  eq((await launchedSince(argvAt)).map((l) => l.split(' ').slice(-2).join(' ')), [`--resume ${SESSION_ID}`], 'and the desk resumes that conversation');
  assert(await until(async () => ((await newRows(mark)).some((r) => r.text === 'ECHO:over to the floor') ? true : null), 10000), 'where the message is answered');

  console.log('\nhanding the conversation to another app');
  // To the editor: the desk's Claude Code ends first, then the editor is
  // asked to open the conversation (the reverse would leave two live copies).
  mark = await lastId();
  eq((await json('/api/floor/handback', { channel: CH, agent: 'free' })).status, 200, 'handing back to the editor is taken');
  const editorUrl = await until(() => (existsSync(`${FIX}/editor.log`) ? readFileSync(`${FIX}/editor.log`, 'utf8').trim() : null), 10000);
  eq(editorUrl, `vscode://anthropic.claude-code/open?session=${SESSION_ID}`, 'the editor is asked to open that conversation, by its id');
  assert(!!(await heldBy('free', null, undefined, 5000)) && !pidIn(REPO), 'after the desk\'s own Claude Code has ended: one app holds a conversation at a time');

  // Open in Claude: the same handoff, to a terminal. This host is asked for
  // a terminal it has no script for, so it says so; the desk's Claude Code
  // was still ended first.
  eq((await json('/api/floor/open', { channel: CH, agent: 'free' })).status, 200, 'the fixture: the desk is opened on the floor again');
  assert(!!(await heldBy('free', 'floor', SESSION_ID)), 'the fixture: held by the floor');
  mark = await lastId();
  eq((await json('/api/floor/claude', { channel: CH, agent: 'free' })).status, 200, 'Open in Claude is taken');
  const noTerminal = await until(async () => (await newRows(mark)).find((r) => r.role === 'error') ?? null, 10000);
  assert(/^ORCH_TERMINAL is set to "none-in-tests", which this host has no script for\./.test(noTerminal?.text ?? '') && noTerminal.text.includes(`--resume ${SESSION_ID}`),
    `a terminal that cannot be opened is said on the desk, with the command to run — ${noTerminal?.text}`);
  assert(!!(await heldBy('free', null, undefined, 5000)) && !pidIn(REPO), 'and the desk\'s Claude Code had been ended for the handoff');

  // Held by another app: a Claude Code the host does not run, on the desk's
  // conversation. The floor says so and takes nothing it cannot deliver.
  const editor = spawn('sleep', ['120'], { stdio: 'ignore' });
  rosterEntry(editor.pid, REPO, SESSION_ID, 'an editor');
  assert(!!(await heldBy('free', 'editor', undefined, 8000)), 'a conversation open in another app is held by the editor on the floor');
  const toEditor = await chat('free', 'hello?');
  eq([toEditor.status, (await toEditor.json()).code], [409, 'held_by_editor'], 'a message is refused, in words, before it is queued');
  eq((await json('/api/floor/open', { channel: CH, agent: 'free' })).status, 409, 'and so is opening it on the floor: that would be two copies of one conversation');
  editor.kill();
  dropRosterEntry(editor.pid);
  assert(!!(await heldBy('free', null, undefined, 8000)), 'the editor gone, nothing holds it');
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

  // A desk whose .mcp.json key is `${ORCH_TEST_PANE_KEY}`, which nothing
  // here sets (QA, PR #52 finding 1; costmo's ruling B). The desk's Claude
  // Code is given that one variable, set to the key the host signs in with,
  // so it sends the board's key rather than the placeholder; and nothing
  // else of the host's ORCH_ settings (0.14.4, host.windows_inherit).
  const paneDir = `${FIX}/repo-pane`;
  mkdirSync(paneDir, { recursive: true });
  writeFileSync(`${paneDir}/.mcp.json`, JSON.stringify({
    mcpServers: { orchestratinator: { type: 'http', url: `${HOST}/mcp`, headers: { 'X-Channel': CH, 'X-Agent': 'pane', 'X-Orchestratinator-Key': '${ORCH_TEST_PANE_KEY}' } } },
  }, null, 2));
  eq((await json('/api/floor/rescan', {})).status, 200, 'a desk whose key is a placeholder nothing here sets is found');
  assert(await until(async () => (deskOf(await floor(), 'pane')?.hosted?.live === true ? true : null), 10000), 'and hosted');
  eq((await json('/api/floor/open', { channel: CH, agent: 'pane' })).status, 200, 'the floor opens it');
  const paneEnvLine = await until(() => {
    const log = existsSync(`${FIX}/env.log`) ? readFileSync(`${FIX}/env.log`, 'utf8') : '';
    return log.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.cwd.endsWith('/repo-pane')) ?? null;
  }, 20000);
  eq(paneEnvLine?.key ?? null, KEY, "the desk's Claude Code has the variable, set to the host's key");
  eq(paneEnvLine?.orch ?? 'unread', [], 'and nothing else of the host\'s ORCH_ settings');
  rmSync(`${paneDir}/.mcp.json`);
  await json('/api/floor/rescan', {});
  assert(await until(() => (/dropped desk .*\/pane /.test(host.log) && !pidIn(paneDir) ? true : null), 10000),
    'a desk whose binding is gone is dropped, and its Claude Code ends with it');

  /* ── taking a desk from the floor ──────────────────────────────────────────
   * The first door that needs no terminal. The route refuses what the board
   * can see is wrong; the host binds with `claude mcp add -s local` (the
   * stand-in above), with its own key, and starts the desk's Claude Code.
   * Import takes a .mcp.json desk into local scope and removes the file's
   * entry, keeping other servers. Leave is the reverse. */
  console.log('\ntaking a desk from the floor');
  const take = (body) => json('/api/floor/desk', body);
  const localCfg = () => JSON.parse(readFileSync(`${HOME}/.claude.json`, 'utf8'));
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
  // The board's own tools ask nothing there (task 352 B): one rule in the
  // folder's local settings, measured on 2.1.330 to let whoami and
  // list_tasks through with no can_use_tool.
  const localSettings = (dir) => { try { return JSON.parse(readFileSync(`${dir}/.claude/settings.local.json`, 'utf8')); } catch { return null; } };
  eq(localSettings(`${FIX}/plain-git`)?.permissions?.allow, ['mcp__orchestratinator'], "and the board's own tools are allowed in that folder, in its local settings");
  assert(!!(await heldBy('newbie', 'floor', undefined, 15000)), 'and its Claude Code is started there, held by the floor');
  const newbieArgv = await until(() => { const l = launches(argvBefore); return l.length ? l : null; }, 8000) ?? [];
  assert(newbieArgv.length === 1 && !newbieArgv[0].includes('--resume'), `a fresh conversation, with nothing to resume — ${JSON.stringify(newbieArgv)}`);
  const offeredNow = await (await json('/api/floor/folders')).json();
  eq(offeredNow.hosts.find((h) => h.host_id === 'host-test-1')?.folders.find((f) => f.name === 'plain-git')?.bound?.agent, 'newbie',
    'and the folder list now shows it bound');

  // Import: a .mcp.json desk, with another server beside ours, into local
  // scope. Its Claude Code is running, and is not touched.
  eq((await json('/api/floor/open', { channel: CH, agent: 'free' })).status, 200, 'the fixture: free\'s Claude Code is running');
  assert(!!(await heldBy('free', 'floor', SESSION_ID)), 'the fixture: held by the floor');
  // Waited for: "held by the floor" can pass before the stand-in's process
  // is visible in ps, and a null here compared against the live pid later
  // read as the conversation moving (QA, msg 4130).
  const freePidBefore = await until(() => pidIn(REPO), 8000);
  assert(!!freePidBefore, 'the fixture: the desk\'s Claude Code is visible before the reopen');
  // The person's own settings in that folder: kept as they are, the rule added beside them.
  mkdirSync(`${REPO}/.claude`, { recursive: true });
  writeFileSync(`${REPO}/.claude/settings.local.json`, JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, model: 'sonnet' }, null, 2));
  writeFileSync(`${REPO}/.mcp.json`, JSON.stringify({
    mcpServers: {
      orchestratinator: { type: 'http', url: `${HOST}/mcp`, headers: { 'X-Channel': CH, 'X-Agent': 'free', 'X-Orchestratinator-Key': KEY } },
      github: { type: 'http', url: 'http://127.0.0.1:9/mcp' },
    },
  }, null, 2));
  const imported = await take({ host_id: 'host-test-1', path: REPO, channel: CH, agent: 'free', open: false });
  eq(imported.status, 200, 'a desk bound in its .mcp.json can be brought onto the floor');
  eq((await imported.json()).mode, 'import', 'as an import');
  assert(await until(async () => (deskOf(await floor(), 'free')?.hosted?.scope === 'local' ? true : null), 20000), 'after which it is a local-scope desk');
  eq(Object.keys(JSON.parse(readFileSync(`${REPO}/.mcp.json`, 'utf8')).mcpServers), ['github'], 'its .mcp.json lost the orchestratinator entry and kept the other server');
  eq(localCfg().projects?.[REPO]?.mcpServers?.orchestratinator?.headers?.['X-Agent'], 'free', 'and ~/.claude.json gained it');
  eq(localSettings(REPO), { permissions: { allow: ['Bash(npm test)', 'mcp__orchestratinator'] }, model: 'sonnet' }, "an import allows the board's tools too, beside the person's own settings, which stay");
  eq([deskOf(await floor(), 'free')?.hosted?.session_id, pidIn(REPO)], [SESSION_ID, freePidBefore], 'the conversation it was on is the one it is still on, in the same Claude Code');
  eq((await take({ host_id: 'host-test-1', path: `${FIX}/opened`, channel: CH, agent: 'newbie' })).status, 409, 'a name already seated at another folder is refused');

  // Leave: the reverse, all the way back to an unbound folder.
  const left = await json('/api/floor/desk/leave', { channel: CH, agent: 'newbie' });
  eq(left.status, 200, 'a desk can be left from the floor');
  assert(await until(async () => (deskOf(await floor(), 'newbie')?.hosted?.state === 'offline' ? true : null), 20000), 'and the desk goes offline once the host has unbound it');
  eq(localCfg().projects?.[`${FIX}/plain-git`]?.mcpServers?.orchestratinator ?? null, null, 'its local-scope entry is gone');
  eq(existsSync(`${FIX}/plain-git/.claude/settings.local.json`), false, "and the rule with it: the file the host made for it, holding nothing else, is gone");
  assert(/dropped desk host-test\/newbie/.test(host.log), 'the host dropped the desk');
  eq(pidIn(`${FIX}/plain-git`), null, 'and ended its Claude Code');
  assert(!!deskOf(await floor(), 'newbie'), 'the seat stays on the floor — whether the agent is gone is the board\'s question');
  {
    // Leave takes away only what the host wrote: a rule the person had
    // already is theirs (host/mcp.js, allowBoardTools).
    const M = await import('../host/mcp.js');
    const own = `${FIX}/own-rule`;
    const rec = `${FIX}/board-tools-unit.json`;
    mkdirSync(`${own}/.claude`, { recursive: true });
    writeFileSync(`${own}/.claude/settings.local.json`, '{\n    "permissions": { "allow": ["mcp__orchestratinator"] }\n}\n');
    eq([M.allowBoardTools(own, rec).added, M.unallowBoardTools(own, rec).removed, localSettings(own)?.permissions?.allow], [false, false, ['mcp__orchestratinator']],
      "a rule the person wrote is neither added again nor taken away by a Leave");
    writeFileSync(`${own}/.claude/settings.local.json`, '{ not json');
    eq([M.allowBoardTools(own, rec).ok, readFileSync(`${own}/.claude/settings.local.json`, 'utf8')], [false, '{ not json'], 'a settings file that is not JSON is left as it is');
  }

  /* ── the session picker and the reopen primitive ────────────────────────────
   * A desk's folder holds many conversations; the picker lists them and a
   * pick ends the desk's Claude Code and starts it again with --resume. A
   * picked conversation the board has never seen is joined at its tail, a
   * known one at its end, and a new one starts with nothing to resume. */
  console.log('\nthe session picker and reopening');
  const SESSION_B = 'bbbbbbbb-2222-3333-4444-555555555555';
  const transcriptB = transcriptOf(REPO, SESSION_B);
  writeFileSync(transcriptB, [
    JSON.stringify({ type: 'user', uuid: 'b-u1', timestamp: '2026-09-09T08:00:00Z', message: { content: 'the other conversation begins' } }),
    JSON.stringify({ type: 'assistant', uuid: 'b-a1', timestamp: '2026-09-09T08:00:05Z', message: { content: [{ type: 'text', text: 'B-TAIL-SEEN' }] } }),
    '',
  ].join('\n'));
  const sessionsGet = () => json(`/api/floor/sessions?channel=${CH}&agent=free`).then((r) => r.json());
  const askList = await json('/api/floor/sessions', { channel: CH, agent: 'free' });
  eq(askList.status, 200, 'the floor can ask a desk\'s host to list its conversations');
  eq((await askList.json()).asked, true, 'and the host is asked');
  const listed = await until(async () => { const g = await sessionsGet(); return g.at ? g : null; }, 15000);
  assert(!!listed, 'the host answers with a list, stamped with its time');
  const rowsById = Object.fromEntries((listed?.rows ?? []).map((r) => [r.id, r]));
  eq(rowsById[SESSION_ID]?.live, true, 'the conversation the desk\'s Claude Code is on is marked live');
  eq(rowsById[SESSION_ID]?.held, 'floor', 'and held by the floor');
  eq(listed?.current, SESSION_ID, 'and the board says it is the desk\'s current one');
  eq([rowsById[SESSION_B]?.title, rowsById[SESSION_B]?.known], ['the other conversation begins', false],
    'the other conversation is titled by its first prompt and the board has never heard it');
  eq((await (await json('/api/floor/sessions', { channel: CH, agent: 'free' })).json()).asked, false,
    'asked again at once, the board serves the list it has rather than walking the folder again');

  const pidBeforeB = pidIn(REPO);
  const argvAtReopen = argvLog().length;
  const reopened = await json('/api/floor/reopen', { channel: CH, agent: 'free', session_id: SESSION_B });
  eq(reopened.status, 200, 'a pick is accepted');
  eq((await reopened.json()).known, false, 'and the board says it has never seen that conversation');
  // A stray Claude Code in the same folder meanwhile, on another
  // conversation: the desk's own process is running, so nothing adopts it.
  rosterEntry(process.pid, REPO, 'stray-session', 'stray');
  const seenIds = new Set();
  for (let i = 0; i < 16; i++) { seenIds.add(deskOf(await floor(), 'free')?.hosted?.session_id ?? null); await sleep(150); }
  assert(!seenIds.has('stray-session'), `a stray session in the folder is not adopted — saw ${[...seenIds].join(', ')}`);
  assert(!!(await heldBy('free', 'floor', SESSION_B, 25000)), 'and the desk lands on the conversation that was picked');
  eq((await launchedSince(argvAtReopen)).map((l) => l.split(' ').slice(-2).join(' ')), [`--resume ${SESSION_B}`], 'its Claude Code started again with --resume of that id');
  assert(pidIn(REPO) && pidIn(REPO) !== pidBeforeB, 'a new process, the old one gone');
  dropRosterEntry(process.pid);
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
  const bTailCount = () => turns('free').then((t) => (t.rows ?? []).filter((r) => (r.text ?? '').includes('B-TAIL-SEEN')).length);
  const tailBefore = await bTailCount();
  await sleep(6000);   // past the listing throttle, so the reopen's own list is fresh — and past nothing else
  const pidAfterB = pidIn(REPO);
  // The conversation was left in auto mode in a terminal (Shift+Tab writes
  // this record at each turn). Started without the flag, Claude Code runs it
  // in default and asks about every tool (costmo, 2026-11-23, 0.15.0).
  appendFileSync(transcriptB, JSON.stringify({ type: 'permission-mode', permissionMode: 'auto', sessionId: SESSION_B }) + '\n');
  const argvAtSecond = argvLog().length;
  const secondPick = await json('/api/floor/reopen', { channel: CH, agent: 'free', session_id: SESSION_B });
  eq((await secondPick.json()).known, true, 'a second pick of the same conversation is one the board knows');
  assert(await until(async () => (pidIn(REPO) && pidIn(REPO) !== pidAfterB && deskOf(await floor(), 'free')?.hosted?.held === 'floor' ? true : null), 25000),
    'and the desk\'s Claude Code is started again on it');
  await sleep(WATCH_SETTLE_MS);
  eq(await bTailCount(), tailBefore, 'with nothing replayed');
  assert(launches(argvAtSecond).some((l) => l.includes(`--resume ${SESSION_B}`) && l.includes('--permission-mode auto')),
    `and in the permission mode the conversation was left in — ${JSON.stringify(launches(argvAtSecond))}`);

  // A new conversation: nothing to resume, and the desk follows the id
  // Claude Code names at the first message.
  const SESSION_NEW = '44444444-dddd-3333-4444-555555555555';
  nextFreshId(SESSION_NEW);
  const argvAtNew = argvLog().length;
  eq((await json('/api/floor/reopen', { channel: CH, agent: 'free', session_id: null })).status, 200, 'start new is accepted');
  assert(await until(() => (launches(argvAtNew).length === 1 ? true : null), 10000), 'and a Claude Code is started');
  assert(!launches(argvAtNew)[0].includes('--resume'), `with nothing to resume — ${JSON.stringify(launches(argvAtNew))}`);
  assert(launches(argvAtNew)[0].includes('--permission-mode auto'), `in auto mode: a new conversation has no mode of its own chosen (costmo, 2026-11-23) — ${JSON.stringify(launches(argvAtNew))}`);
  // Named before anybody types: Claude Code says init only at the first
  // message, and the floor's New session waited for an id for ever (costmo,
  // 2026-11-23). The host reads it from the process's roster file.
  assert(!!(await heldBy('free', 'floor', SESSION_NEW, 10000)), 'and the desk is on the new conversation before any message');
  eq((await chat('free', 'hello, new conversation')).status, 200, 'a message to it is taken');
  assert(!!(await heldBy('free', 'floor', SESSION_NEW)), 'and the desk follows the conversation Claude Code names');

  // A person's own choice is theirs: a defaultMode in the folder's settings
  // is left to Claude Code, which applies it (costmo, 2026-11-23: only the
  // operator's explicit choice produces prompts).
  assert(await until(async () => ((await turnRows()).some((r) => r.role === 'assistant' && r.text === 'ECHO:hello, new conversation') ? true : null), 10000), 'the fixture: its turn is over');
  await until(async () => (deskOf(await floor(), 'free')?.state === 'working' ? null : true), 5000);
  mkdirSync(`${REPO}/.claude`, { recursive: true });
  writeFileSync(`${REPO}/.claude/settings.json`, JSON.stringify({ permissions: { defaultMode: 'default' } }));
  const argvAtChosen = argvLog().length;
  eq((await json('/api/floor/reopen', { channel: CH, agent: 'free', session_id: null })).status, 200, 'with defaultMode default in the folder\'s settings, a new conversation');
  assert(await until(() => (launches(argvAtChosen).length === 1 ? true : null), 10000), 'is started');
  assert(!launches(argvAtChosen)[0].includes('--permission-mode'), `with no mode on the command line: the person's setting is Claude Code's to apply — ${JSON.stringify(launches(argvAtChosen))}`);
  rmSync(`${REPO}/.claude/settings.json`, { force: true });
  await sleep(1500);   // past the start, so the next reopen finds it idle

  // Auto not available to this Claude Code: asked for auto, it runs default
  // without a word but a status record. The host switches it to acceptEdits
  // and says so on the desk, never leaving it asking about every tool.
  writeFileSync(`${FIX}/no-auto.flag`, '1');
  const noAutoMark = await lastId();
  const stdinAtNoAuto = existsSync(STDIN_LOG) ? readFileSync(STDIN_LOG, 'utf8').length : 0;
  eq((await json('/api/floor/reopen', { channel: CH, agent: 'free', session_id: null })).status, 200, 'with auto not available, a new conversation');
  assert(await until(() => (readFileSync(STDIN_LOG, 'utf8').slice(stdinAtNoAuto).includes('"subtype":"set_permission_mode","mode":"acceptEdits"') ? true : null), 10000),
    'is switched to acceptEdits by the host, as soon as Claude Code says it fell back to default');
  assert(!!(await until(async () => (await newRows(noAutoMark)).find((r) => r.role === 'context' && /auto mode is not available.*acceptEdits/.test(r.text ?? '')) ?? null, 10000)),
    'and the desk says so, in a line from the host');
  rmSync(`${FIX}/no-auto.flag`, { force: true });
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
   * nothing. "The other instance's" Claude Code in a folder is a roster
   * entry for a process this host did not start. */
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

    // In its .mcp.json, beside another server and a third instance's entry.
    const relA = `${FIX}/rel-project`;
    mkdirSync(relA, { recursive: true });
    writeFileSync(`${relA}/.mcp.json`, elsewhere('rel-a', {
      github: { type: 'http', url: 'http://127.0.0.1:9/mcp' },
      third: { type: 'http', url: 'http://localhost:7/mcp', headers: { 'X-Channel': 'z', 'X-Agent': 'rel-a' } },
    }));
    const SESSION_REL = 'cccccccc-9999-3333-4444-555555555555';
    const relProject = `${HOME}/.claude/projects/${slugOf(relA)}`;
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
    eq(argvLog().length, argvAtRel, 'asked to open nothing, it started no Claude Code');

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

    // In local scope under a name of somebody's own, with the other
    // instance's Claude Code running in the folder. Seated here on a new
    // conversation, as a move between floors is: that one's conversation is
    // never resumed beside it. Its own host lets it go when it reads the
    // folder's new binding (below, this host as the one being left).
    const relC = `${FIX}/rel-local`;
    mkdirSync(relC, { recursive: true });
    {
      const cfg = localCfg();
      cfg.projects[relC] = { mcpServers: { oldboard: { type: 'http', url: `${ELSE}/mcp`, headers: { 'X-Channel': CH, 'X-Agent': 'rel-c', 'X-Orchestratinator-Key': 'the-other-key' } } } };
      writeFileSync(`${HOME}/.claude.json`, JSON.stringify(cfg, null, 2));
    }
    const SESSION_OTHER = 'ffffffff-9999-3333-4444-555555555555';
    const otherOne = spawn('sleep', ['120'], { stdio: 'ignore' });
    rosterEntry(otherOne.pid, relC, SESSION_OTHER, 'the other instance\'s');
    eq((await show(relC))?.self?.bound?.scope, 'local', 'the folder is shown, bound elsewhere in local scope');
    const argvAtRelC = argvLog().length;
    eq((await take({ host_id: 'host-test-1', path: relC, channel: CHR, agent: 'rel-c', from_board: ELSE })).status, 200, 'a release of a folder with another instance\'s Claude Code in it is accepted');
    eq((await settled('rel-c'))?.state, 'seated', 'it is seated');
    eq(Object.keys(localCfg().projects?.[relC]?.mcpServers ?? {}), ['orchestratinator'], 'the entry it carried under another name is gone from local scope, and this instance\'s is there');
    eq(localCfg().projects?.[relC]?.mcpServers?.orchestratinator?.url, `${HOST}/mcp`, 'pointing here');
    assert(/removed the local-scope entry "oldboard" in .*rel-local, which pointed at http:\/\/localhost:9/.test(host.log), 'the host says which entry it removed, by its name');
    assert(!!(await until(async () => (onRel(await floor(), 'rel-c')?.hosted?.held === 'floor' ? true : null), 20000)), 'its own Claude Code is started there');
    const relArgv = await until(() => { const l = launches(argvAtRelC); return l.length ? l : null; }, 8000) ?? [];
    assert(relArgv.length === 1 && !relArgv[0].includes('--resume'), `on a new conversation, never the other instance's — ${JSON.stringify(relArgv)}`);
    otherOne.kill();
    dropRosterEntry(otherOne.pid);
    await sleep(WATCH_SETTLE_MS);

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
    // Work arriving for the desk: nothing is started or sent in a folder
    // that answers to another instance now.
    rebindAway(relA);
    const argvAtGone = argvLog().length;
    await json('/api/floor/chat', { channel: CHR, agent: 'rel-a', text: 'are you still here' });
    const goneTurn = await until(async () => (await relTurns('rel-a')).find((t) => t.role === 'error' && /^not done: /.test(t.text ?? '')) ?? null, 15000);
    assert(/^not done: .*rel-project is bound to http:\/\/localhost:9 now, not host-test-rel\/rel-a on this instance/.test(goneTurn?.text ?? ''), `a message for a desk whose folder has been released elsewhere is refused on the desk, in what the disk says — ${goneTurn?.text}`);
    assert(await until(async () => (onRel(await floor(), 'rel-a')?.hosted?.state === 'offline' ? true : null), 10000), 'and the desk is let go at once, not at the next heartbeat');
    eq(argvLog().length, argvAtGone, 'no Claude Code was started in that folder');
    // A Claude Code coming up in the folder: the one the other host starts.
    // Found by its folder like any other, and must not be followed. The
    // folder is rebound in the same moment it comes up, and not before: the
    // heartbeat's rescan drops a desk whose folder is bound elsewhere too, and
    // given time it does it first (seen as a race in this case, 2026-11-18/19).
    const SESSION_THEIRS = 'dddddddd-9999-3333-4444-555555555555';
    assert(!!(await quitByHand(relC, 'rel-c', CHR)), 'the fixture: this host\'s Claude Code for the desk has ended');
    const relLogFrom = host.log.length;
    rebindAway(relC);
    rosterEntry(process.pid, relC, SESSION_THEIRS, 'theirs');
    const relSeen = await until(() => (/rel-c: .*rel-local is bound to http:\/\/localhost:9 now \(a window came up in its folder\) — letting the desk go/.test(host.log) ? true : null), 10000);
    assert(relSeen, 'a Claude Code that comes up in a folder released elsewhere is not this desk\'s: the host reads the binding and lets the desk go');
    if (!relSeen) {
      const said = host.log.slice(relLogFrom);
      if (/dropped desk host-test-rel\/rel-c .*\(heartbeat\)/.test(said)) console.log('    the heartbeat\'s rescan dropped rel-c before the watch looked: a race in this case, not a fault in the watch');
      console.log(`    the host's log from the staging on:\n${said.split('\n').map((l) => `      ${l}`).join('\n')}`);
    }
    assert(await until(async () => (onRel(await floor(), 'rel-c')?.hosted?.state === 'offline' ? true : null), 10000), 'the desk goes offline here within the watch, not the heartbeat');
    {
      const { default: Database } = await import('better-sqlite3');
      const db = new Database(DB_PATH, { readonly: true });
      const theirs = db.prepare(`SELECT COUNT(*) AS n FROM agent_sessions WHERE session_id = ?`).get(SESSION_THEIRS).n + db.prepare(`SELECT COUNT(*) AS n FROM turns WHERE session_id = ?`).get(SESSION_THEIRS).n;
      db.close();
      eq(theirs, 0, 'and nothing of the other instance\'s conversation reached this one');
    }

    // Put away: both desks left, the roster as it was.
    dropRosterEntry(process.pid);
    for (const agent of ['rel-a', 'rel-c']) {
      await json('/api/floor/desk/leave', { channel: CHR, agent });
      await until(async () => (onRel(await floor(), agent)?.hosted?.state === 'offline' ? true : null), 20000);
    }
    for (const d of [relA, relB, relC]) rmSync(d, { recursive: true, force: true });
    rmSync(relProject, { recursive: true, force: true });
    await json('/api/floor/rescan', {});
    await sleep(WATCH_SETTLE_MS);
  }

  // Move: free's folder onto another floor, under its own name. Its Claude
  // Code runs on the conversation it is on, and keeps the headers it started
  // with, so the move ends it, and the new floor gets a NEW conversation
  // (#24 Decided 2, costmo 2026-11-03: "A new session should be started
  // instead"). The one it was on stays in its folder.
  const argvBeforeMoveReopen = argvLog().length;
  eq((await json('/api/floor/reopen', { channel: CH, agent: 'free', session_id: SESSION_ID })).status, 200, 'the fixture: free is put back on its first conversation');
  assert(!!(await heldBy('free', 'floor', SESSION_ID)), 'the desk to move is on a known conversation, held by the floor');
  // The reopen's own launch, waited for before the move's count starts:
  // "held by the floor" can already be true from before it, and its line
  // landing after the baseline read as the move resuming (QA, msg 4113).
  await until(() => (launches(argvBeforeMoveReopen).some((l) => l.includes(`--resume ${SESSION_ID}`)) ? true : null), 8000);
  await sleep(WATCH_SETTLE_MS);
  const SESSION_MOVED = 'eeeeeeee-2222-3333-4444-555555555555';
  const pidBeforeMove = pidIn(REPO);
  const argvAtMove = argvLog().length;
  nextFreshId(SESSION_MOVED);
  const movedOut = await take({ host_id: 'host-test-1', path: REPO, channel: CH2, agent: 'free' });
  eq([movedOut.status, (await movedOut.json()).mode], [200, 'move'], 'taking it onto another floor under its own name is a move');
  eq((await take({ host_id: 'host-test-1', path: REPO, channel: CH2, agent: 'renamed' })).status, 400, 'and under another name is refused — the folder names its agent');
  const onNewFloor = (f) => f.channels.find((c) => c.channel === CH2)?.desks.find((d) => d.agent === 'free');
  assert(await until(async () => (onNewFloor(await floor())?.hosted?.live ? true : null), 30000), 'the desk appears on the new floor, hosted');
  assert(/free: bound .*repo-a in local scope/.test(host.log) && /moving it from host-test\/free/.test(host.log), 'the host rebound the folder and said where from');
  assert(await until(async () => (onNewFloor(await floor())?.hosted?.held === 'floor' && pidIn(REPO) && pidIn(REPO) !== pidBeforeMove ? true : null), 30000),
    'one move seats it there with a Claude Code of its own, the old one ended — no second Take a desk (#24 Decided 1)');
  const moveArgv = await launchedSince(argvAtMove);
  assert(moveArgv.length === 1 && !moveArgv[0].includes('--resume'), `on a new conversation: started with nothing to resume (#24 Decided 2) — ${JSON.stringify(moveArgv)}`);
  eq((await json('/api/floor/chat', { channel: CH2, agent: 'free', text: 'hello from the new floor' })).status, 200, 'a message on the new floor is taken');
  assert(!!(await heldBy('free', 'floor', SESSION_MOVED, 15000, CH2)), 'and the desk follows the conversation Claude Code names');
  // Nothing pins the conversation it left to the new floor: a `bound` naming
  // it is filed as that conversation's session on the new desk, and the row
  // stays — the floor would then hold a conversation that never ran there.
  {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(DB_PATH, { readonly: true });
    const onNew = db.prepare(`SELECT session_id FROM agent_sessions WHERE channel = ? AND agent = ?`).all(CH2, 'free').map((r) => r.session_id);
    // A red reads the rows itself: by the time anybody looks they are gone
    // with the run's database (CLAUDE.md, Tests, the six sightings).
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
  await json('/api/floor/sessions', { channel: CH2, agent: 'free' });
  const leftBehind = await until(async () => { const g = await json(`/api/floor/sessions?channel=${CH2}&agent=free`).then((r) => r.json()); return g.at && (g.rows ?? []).some((r) => r.id === SESSION_ID) ? g : null; }, 15000);
  assert(!!leftBehind, 'the conversation it was on stays in its folder — the session picker on the new floor lists it (#24 Decided 2)');
  eq(deskOf(await floor(), 'free') ?? null, null, 'and its seat has left the old floor');
  eq(localCfg().projects?.[REPO]?.mcpServers?.orchestratinator?.headers?.['X-Channel'], CH2, 'the binding on disk names the new floor');

  // And back: a move again, on a new conversation again.
  const argvAtBack = argvLog().length;
  const back = await take({ host_id: 'host-test-1', path: REPO, channel: CH, agent: 'free' });
  eq((await back.json()).mode, 'move', 'moving it back is a move too');
  assert(!!(await heldBy('free', 'floor', undefined, 30000)), 'and it is home, held by the floor');
  const backArgv = await until(() => { const l = launches(argvAtBack); return l.length ? l : null; }, 8000) ?? [];
  assert(backArgv.length === 1 && !backArgv[0].includes('--resume'), `started with nothing to resume, like the move out — ${JSON.stringify(backArgv)}`);
  await sleep(WATCH_SETTLE_MS);

  // A move whose Claude Code is not running opens on the agent's last
  // conversation, as it always has (#24 Decided 3, costmo 2026-11-03: "Last
  // conversation"): there is no running one to end, and nothing to diverge.
  eq((await json('/api/floor/reopen', { channel: CH, agent: 'free', session_id: SESSION_ID })).status, 200, 'the fixture: home on its first conversation');
  assert(!!(await heldBy('free', 'floor', SESSION_ID)), 'the fixture: on it');
  assert(!!(await quitByHand()), 'with its Claude Code quit by hand, the desk is held by nobody');
  const argvAtClosed = argvLog().length;
  eq((await (await take({ host_id: 'host-test-1', path: REPO, channel: CH2, agent: 'free' })).json()).mode, 'move', 'moving a desk whose Claude Code is not running is a move');
  assert(!!(await heldBy('free', 'floor', SESSION_ID, 30000, CH2)), 'it opens on the new floor, on its last conversation (#24 Decided 3)');
  const closedArgv = await until(() => { const l = launches(argvAtClosed); return l.length ? l : null; }, 8000) ?? [];
  assert(closedArgv.length === 1 && closedArgv[0].includes(`--resume ${SESSION_ID}`), `resumed by its id, not started fresh — ${JSON.stringify(closedArgv)}`);

  // A conversation open in another app: a Claude Code the host does not run,
  // on the desk's conversation. A move never resumes that conversation beside
  // it (two processes on one transcript diverge without a word): the new
  // floor gets a new one, and the editor's chat follows the binding on its own.
  assert(!!(await quitByHand(REPO, 'free', CH2)), 'its Claude Code quit by hand again');
  const editor2 = spawn('sleep', ['120'], { stdio: 'ignore' });
  rosterEntry(editor2.pid, REPO, SESSION_ID, 'an editor');
  assert(!!(await heldBy('free', 'editor', undefined, 8000, CH2)), 'and the conversation is open in an editor');
  const argvAtEditor = argvLog().length;
  const editorMove = await take({ host_id: 'host-test-1', path: REPO, channel: CH, agent: 'free' });
  eq([editorMove.status, (await editorMove.json()).mode], [200, 'move'], 'a desk an editor holds can be moved');
  assert(await until(() => (launches(argvAtEditor).length ? true : null), 20000), 'and the desk gets a Claude Code on the floor it moved to');
  assert(launches(argvAtEditor).every((l) => !l.includes(`--resume ${SESSION_ID}`)), `never a second copy of the editor's conversation — ${JSON.stringify(launches(argvAtEditor))}`);
  editor2.kill();
  dropRosterEntry(editor2.pid);

  // A Claude Code in the middle of a turn is not moved (#24 Don't break),
  // even one running no tool: the board reads the turn from the host.
  eq((await json('/api/floor/reopen', { channel: CH, agent: 'free', session_id: SESSION_ID })).status, 200, 'the fixture: home on its first conversation');
  assert(!!(await heldBy('free', 'floor', SESSION_ID)), 'the fixture: on it');
  const quietSeen = () => stdinRecords().filter((r) => r.text === 'QUIET 4000').length;
  const quietDone = async () => (await turnRows()).filter((r) => r.text === 'QUIET-DONE').length;
  const [quiet0, quietDone0] = [quietSeen(), await quietDone()];
  await chat('free', 'QUIET 4000');
  await until(() => (quietSeen() > quiet0 ? true : null));
  await sleep(300);
  const errorIds = async (ch) => new Set(((await json(`/api/floor/turns?channel=${ch}&agent=free`).then((r) => r.json())).rows ?? []).filter((r) => r.role === 'error').map((r) => r.id));
  const [errorsHereBefore, errorsThereBefore] = [await errorIds(CH), await errorIds(CH2)];
  const workingPid = pidIn(REPO);
  assert(await until(async () => (deskOf(await floor(), 'free')?.working ? true : null), 5000), 'the fixture: the board reads the turn');
  eq((await take({ host_id: 'host-test-1', path: REPO, channel: CH2, agent: 'free' })).status, 409, 'the board refuses the move mid-turn');
  eq([...(await errorIds(CH2))].filter((id) => !errorsThereBefore.has(id)), [], 'and nothing is said for a desk on the floor it did not reach');
  eq(pidIn(REPO), workingPid, 'and the working Claude Code is left exactly as it was');
  eq(localCfg().projects?.[REPO]?.mcpServers?.orchestratinator?.headers?.['X-Channel'], CH, 'and the binding is not touched');
  assert(await until(async () => ((await quietDone()) > quietDone0 ? true : null), 10000), 'the fixture: its turn ends');
  await sleep(WATCH_SETTLE_MS);
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
  const pidBeforeRead = pidIn(REPO);
  const argvBeforeRead = argvLog().length;
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
  eq([deskAfterRead?.session_id, deskAfterRead?.held, pidIn(REPO), argvLog().length], [deskBeforeRead?.session_id, deskBeforeRead?.held, pidBeforeRead, argvBeforeRead],
    'and nothing moved: the desk is on the conversation it was on, in the window it was in, and no window was opened or closed — reading is not resuming');
  await sleep(WATCH_SETTLE_MS);
  const afterRead = (await json(`/api/floor/turns?channel=${CH}&agent=free&limit=500`).then((r) => r.json())).rows ?? [];
  // By what was read, not by a count: the desk's own turns from the section
  // before can still be arriving (the relay's lag under load), and a count
  // read them as the read's (QA's runs and this one, 80 → 128 with none of C).
  const fromC = afterRead.filter((r) => r.session_id === SESSION_C || /C-(FIRST-WORDS|REPLY-ONE|SECOND-WORDS|LAST-WORD|SUBAGENT-SEARCHING|A-THOUGHT)/.test(r.text ?? ''));
  eq(fromC.map((r) => r.text), [], 'nor did any of it become the desk\'s own turns');
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
      env: { ...process.env, HOME, ORCH_HOST_CLAUDE: `${FIX}/claude` },
      encoding: 'utf8',
    }));
    eq([twice.rows.map((r) => `${r.channel}/${r.agent}`), twice.files], [[`${CH}/free`], rec?.rows.filter((r) => r.agent === 'free').length],
      'a folder named twice is read once and its conversations listed once, under the first desk to name it — not every file twice and every result twice over');
    // Past its limit a list is cut, and it is cut after it is put in order:
    // the fixture's conversation C is the newest *file* and the one spoken in
    // longest ago, so a list cut in file order would keep exactly the wrong one.
    const ask = (body) => JSON.parse(execFileSync(process.execPath, ['host/history.js'], {
      input: JSON.stringify({ desks: [{ channel: CH, agent: 'free', cwd: REPO }], ...body }),
      env: { ...process.env, HOME, ORCH_HOST_CLAUDE: `${FIX}/claude` }, encoding: 'utf8',
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
    eq([deskAfterSearch?.session_id, pidIn(REPO)], [deskBeforeRead?.session_id, pidBeforeRead], 'none of which moved the desk or its window');
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
  eq(dialogCommand('/x', { platform: 'linux', env: {} }), null, 'Linux has no backend until one has been watched taking focus');
  eq([hasDialog({ platform: 'darwin', env: {} }), hasDialog({ platform: 'win32', env: {} }), hasDialog({ platform: 'linux', env: {} })], [true, true, false], 'which is what the host tells the board, so such a host gets the page\'s list');
  // Windows (issue #28): Windows PowerShell running dialog-win.ps1 with -File,
  // the start folder an argument of its own, as the macOS one is.
  const win = dialogCommand(`C:\\Users\\me\\it's "here"`, { platform: 'win32', env: { SystemRoot: 'C:\\Windows' } });
  eq(win?.cmd.replace(/\\/g, '/'), 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', 'on Windows the dialog is Windows PowerShell, which every Windows has');
  eq(win?.args.slice(0, 6), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File'], 'run with -File (arguments arrive whole) and -STA (the dialog is COM)');
  assert(/dialog-win\.ps1$/.test(win?.args[6] ?? ''), 'the script beside dialog.js');
  eq(win?.args.slice(7, 9), [`C:\\Users\\me\\it's "here"`, 'Choose the folder your agent lives in'], 'the start folder handed over as an argument, then the title');
  eq([dialogBackend({ platform: 'win32', env: {} })], ['win32'], 'and the backend is named for it');
  // readAnswer judges a path by the machine it runs on, as the dialog answers
  // in that machine's paths, so the row uses one absolute here: a drive path
  // on Windows, where it was first run, and a POSIX one on the Mac.
  const winAnswer = process.platform === 'win32' ? 'C:\\Users\\me\\café ünïcode' : '/Users/me/café ünïcode';
  eq(readAnswer({ code: 0, signal: null, stdout: `${JSON.stringify({ path: winAnswer })}\r\n`, stderr: '' }), { ok: true, path: winAnswer },
    'an answer whose line ends in \\r\\n, as Windows writes it, is read whole, its accents included');
  eq(readAnswer({ code: 2, signal: null, stdout: '', stderr: 'Exception calling "Show"\r\n' }).error, 'the folder dialog ended with exit code 2: Exception calling "Show"', 'and a failure is quoted from its last line, without the \\r');
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
  // `HOLD <ms>` is a message the stand-in takes only after that long, so the
  // host is still on one when the next are queued.
  console.log('\n  work in hand when the host stops');
  {
    const { default: Database } = await import('better-sqlite3');
    const rows = (sql, ...a) => { const db = new Database(DB_PATH, { readonly: true }); try { return db.prepare(sql).all(...a); } finally { db.close(); } };
    const mark = rows(`SELECT COALESCE(MAX(id), 0) AS m FROM host_outbox`)[0].m;
    eq((await chat('free', 'reported finished')).status, 200, 'a message is sent');
    assert(await until(() => (received().includes('reported finished') ? true : null), 20000), 'and delivered');
    assert(await until(() => (rows(`SELECT done_at FROM host_outbox WHERE id > ? AND kind = 'chat'`, mark)[0]?.done_at ? true : null), 15000),
      'and the host reports it finished, on its next poll');
    const mark2 = rows(`SELECT COALESCE(MAX(id), 0) AS m FROM host_outbox`)[0].m;
    // The host takes the first alone and the rest in one poll once that is
    // done, and the stop waits until at least two are taken and unfinished.
    // With fewer, the later ones were never taken at all, and "back in line"
    // said nothing about the release (the first cut of this row: its mutant,
    // the release emptied, stayed green).
    for (const t of ['HOLD 1500 in line one', 'HOLD 1500 in line two', 'HOLD 1500 in line three', 'HOLD 1500 in line four']) await chat('free', t);
    const held = await until(() => (rows(`SELECT id FROM host_outbox WHERE id > ? AND taken_at IS NOT NULL AND done_at IS NULL`, mark2).length >= 2 ? true : null), 30000);
    assert(held, 'the fixture: the host is holding more than the one it is delivering when it is told to stop');
    const exited = new Promise((done) => host.once('exit', done));
    host.kill('SIGTERM');
    await Promise.race([exited, sleep(25000)]);
    const after = rows(`SELECT id, taken_at, done_at FROM host_outbox WHERE id > ?`, mark2);
    eq(after.filter((r) => r.taken_at && !r.done_at).length, 0, `a host stopped with messages in its line leaves none taken and unfinished: each is done or handed back (${after.filter((r) => r.done_at).length} done, ${after.filter((r) => !r.taken_at).length} back in line)`);
    assert(after.filter((r) => !r.taken_at).length >= 1, 'and what it held and never started was handed back, not only never taken');
    // The host stopping ends its desks' Claude Codes: they are its children.
    assert(await until(() => (standIns().length === 0 ? true : null), 8000), `and a host that stops leaves none of its desks' Claude Codes running${standIns().length ? ` (pids ${standIns().join(', ')})` : ''}`);
    // Back in line is for the next run of this host; none comes in this
    // suite, so they are taken out of the line rather than left to be sent
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
  // had delivered before it was killed was said lost on its desk: "send it
  // again" about words Claude Code had. The fixture makes the batch: one
  // message is taken alone, and three more are queued while it goes in, so
  // the next poll takes them together.
  console.log('\n  work finished in the middle of a batch, and then the host is killed');
  {
    const { default: Database } = await import('better-sqlite3');
    const rows = (sql, ...a) => { const db = new Database(DB_PATH, { readonly: true }); try { return db.prepare(sql).all(...a); } finally { db.close(); } };
    const mark = rows(`SELECT COALESCE(MAX(id), 0) AS m FROM host_outbox`)[0].m;
    const byText = () => Object.fromEntries(rows(`SELECT payload, taken_at, done_at FROM host_outbox WHERE id > ? AND kind = 'chat'`, mark)
      .map((r) => [JSON.parse(r.payload).text, r]));
    await chat('free', 'HOLD 1500 batch one');
    assert(await until(() => (byText()['HOLD 1500 batch one']?.taken_at ? true : null), 15000), 'the fixture: the first message is taken alone');
    for (const t of ['HOLD 1000 batch two', 'HOLD 1500 batch three', 'HOLD 1500 batch four']) await chat('free', t);
    assert(await until(() => (received().includes('batch two') ? true : null), 30000), 'the fixture: the first of the batch of three is sent');
    const saidAt = await until(() => (byText()['HOLD 1000 batch two']?.done_at ? { fourSent: received().includes('batch four') } : null), 15000);
    assert(saidAt && !saidAt.fourSent, `a message finished in the middle of a batch is said done before the batch ends${!saidAt ? ' (never said)' : saidAt.fourSent ? ' (said only once "batch four" was sent)' : ''}`);
    const open = Object.entries(byText()).filter(([, r]) => r.taken_at && !r.done_at).map(([t]) => t);
    // What the next run reads to end a leftover (task 340): the record of
    // this run's desk processes, kept at each start and exit.
    let rec = [];
    try { rec = JSON.parse(readFileSync(`${HOME}/.orchestratinator/desk-pids-host-test-1.json`, 'utf8')); } catch { /* none */ }
    const runningNow = standIns();
    assert(runningNow.length >= 1 && runningNow.every((pid) => rec.some((r) => r.pid === pid)), `the host keeps a record of its desks' running processes (${runningNow.join(', ')} running; ${rec.map((r) => r.pid).join(', ') || 'none'} recorded)`);
    host.kill('SIGKILL');
    assert(open.length >= 1, `the fixture: the host is killed with work of the batch still unfinished (${open.join(', ') || 'none'})`);
    // Its desks' Claude Codes outlive it until their input closes and the
    // turn in hand ends; the next run must not meet one still on the
    // conversation.
    assert(await until(() => (standIns().length === 0 ? true : null), 10000), 'the fixture: a killed host\'s Claude Codes end on their own, their input closed');
    const errorsBefore = new Set(((await turns('free')).rows ?? []).filter((r) => r.role === 'error').map((r) => r.id));
    host = startHost();
    const lost = await until(async () => {
      const said = ((await turns('free')).rows ?? []).filter((r) => r.role === 'error' && !errorsBefore.has(r.id)).map((r) => r.text ?? '');
      return said.length >= open.length ? said : null;
    }, 20000);
    assert(lost && open.every((t) => lost.some((s) => s.includes(`"${t}"`))), `the next run says what the killed one left unfinished, with its words (${open.join(', ')}) — ${(lost ?? []).join(' | ')}`);
    assert(lost && !lost.some((s) => s.includes('"HOLD 1000 batch two"')), 'and not the message it had finished and said');
    assert(await until(async () => (deskOf(await floor(), 'free')?.hosted?.live ? true : null), 20000), 'and the new run is up for what follows');
    await sleep(WATCH_SETTLE_MS);
  }

  console.log('\nwhen the host is gone');
  // Written just before the stop, inside one watch tick: the stop's last read
  // of the transcripts relays it (pc-developer, msg 4125: a reply finished
  // 234 ms before a stop never reached the floor).
  const lastWords = `LAST-WORDS-BEFORE-THE-STOP-${Date.now()}`;
  appendTurn({ type: 'assistant', uuid: `last-${Date.now()}`, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: lastWords }] } });
  host.kill('SIGTERM');
  assert(await until(async () => (((await turns('free')).rows ?? []).some((r) => r.text === lastWords) ? true : null), 15000), 'what was written just before the host stopped still reaches the floor');
  await until(async () => (deskOf(await floor(), 'free')?.hosted?.live === false ? true : null));
  const refused = await chat('free', 'anyone there?');
  eq(refused.status, 409, 'a message with no host to take it is refused rather than swallowed');
  eq((await refused.json()).code, 'host_offline', 'with the reason');
  host = null;

  /* ── a desk an earlier run left running (task 340) ──────────────────────────
   * A host that dies without its stop leaves each desk's Claude Code to finish
   * the turn it is in, with nobody listening (desktop-dev measured 38 s on a
   * 41 s tool call), and the next run found its conversation held by a process
   * it did not know. The next run of the same host ends it first, by the
   * record above, and only while `ps` still shows that pid as a Claude Code on
   * the stream-JSON path: a pid since given to something else is left alone. */
  console.log('\n  a desk\'s Claude Code an earlier run left running');
  {
    const id = 'host-test-leftover';
    const file = `${HOME}/.orchestratinator/desk-pids-${id}.json`;
    const spin = 'setInterval(() => {}, 1000)';
    const left = spawn(process.execPath, ['-e', spin, '--', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio', '--replay-user-messages'], { stdio: 'ignore' });
    const other = spawn(process.execPath, ['-e', spin, '--', 'not-a-desk'], { stdio: 'ignore' });
    // The VS Code extension's Claude Code, as read off a running one: stream-JSON both ways too, but =stdio and no -p.
    const editor = spawn(process.execPath, ['-e', spin, '--', '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--permission-prompt-tool=stdio', '--replay-user-messages'], { stdio: 'ignore' });
    let leftGone = false;
    left.on('exit', () => { leftGone = true; });
    await sleep(300);
    mkdirSync(`${HOME}/.orchestratinator`, { recursive: true });
    writeFileSync(file, JSON.stringify([{ pid: left.pid, cwd: '/somewhere', session: 'sess-left' }, { pid: other.pid, cwd: '/elsewhere', session: null }, { pid: editor.pid, cwd: '/editor', session: 'sess-editor' }]));
    mkdirSync(`${FIX}/no-desks`, { recursive: true });
    const h = startHost(id, { ORCH_HOST_ROOTS: `${FIX}/no-desks` });
    const said = await until(() => (/ended a desk's Claude Code an earlier run of this host left running \(pid (\d+)/.exec(h.log)?.[1] ?? null), 15000);
    eq(said, String(left.pid), 'the next run of the host ends the desk process its last run left, and says so');
    assert(await until(() => (leftGone ? true : null), 8000), 'and that process is gone');
    let otherAlive = true;
    try { process.kill(other.pid, 0); } catch { otherAlive = false; }
    assert(otherAlive && !h.log.includes(`pid ${other.pid}`), 'a recorded pid that is no Claude Code on the stream-JSON path is left alone');
    let editorAlive = true;
    try { process.kill(editor.pid, 0); } catch { editorAlive = false; }
    assert(editorAlive && !h.log.includes(`pid ${editor.pid}`), 'and so is the VS Code extension\'s Claude Code, which speaks stream-JSON too (=stdio, no -p)');
    let after = null;
    try { after = JSON.parse(readFileSync(file, 'utf8')); } catch { /* unreadable */ }
    assert(Array.isArray(after) && after.length === 0, `and the record is cleared (${JSON.stringify(after)})`);
    h.kill('SIGTERM');
    try { other.kill('SIGKILL'); } catch { /* gone */ }
    try { left.kill('SIGKILL'); } catch { /* gone */ }
    try { editor.kill('SIGKILL'); } catch { /* gone */ }
    await sleep(300);
  }

  /* ── an earlier version's tmux windows (0.14.x → 0.15.0, task 341 C1) ────────
   * Up to 0.14.x each desk's Claude Code ran in a window of the host's tmux
   * session `orch`, and those windows outlive the host. Measured on a real
   * upgrade: the 0.15 host found every desk's conversation held by one, the
   * desk read "held by an editor", and Open on the floor said "Quit it there
   * first" about a window nobody could see. The new host ends the windows in
   * its desks' folders at its start, and says so on the desk. Here tmux is a
   * stand-in that lists panes and records what it is asked to kill. */
  console.log('\n  an earlier version\'s tmux windows');
  {
    const root = `${FIX}/legacy-root`;
    const deskDir = `${root}/old1`;
    const busyDir = `${root}/old2`;
    const otherDir = `${root}/not-a-desk`;
    for (const d of [deskDir, busyDir, otherDir]) mkdirSync(d, { recursive: true });
    const bindAs = (dir, agent) => writeFileSync(`${dir}/.mcp.json`, JSON.stringify({ mcpServers: { orchestratinator: { type: 'http', url: `${HOST}/mcp`, headers: { 'X-Channel': CH, 'X-Agent': agent, 'X-Orchestratinator-Key': KEY } } } }));
    bindAs(deskDir, 'legacy-1');
    bindAs(busyDir, 'legacy-2');
    const spin = 'setInterval(() => {}, 1000)';
    const winA = spawn(process.execPath, ['-e', spin], { cwd: deskDir, stdio: 'ignore' });
    const winC = spawn(process.execPath, ['-e', spin], { cwd: busyDir, stdio: 'ignore' });
    const winB = spawn(process.execPath, ['-e', spin], { cwd: otherDir, stdio: 'ignore' });
    let aGone = false;
    let cGone = false;
    winA.on('exit', () => { aGone = true; });
    winC.on('exit', () => { cGone = true; });
    await sleep(300);
    // Claude Code's roster entries for the two desk windows, as 2.1.330 writes
    // them: the pane in `tmux`, the turn in `status`.
    const sessDir = `${HOME}/.claude/sessions`;
    mkdirSync(sessDir, { recursive: true });
    const rosterAs = (child, dir, sessionId, tmux, status) => writeFileSync(`${sessDir}/${child.pid}.json`, JSON.stringify({ pid: child.pid, sessionId, cwd: dir, kind: 'interactive', entrypoint: 'cli', tmux, status, startedAt: Date.now() }));
    rosterAs(winA, deskDir, 'legacy-sess-1', 'orch:@1.%1', 'idle');
    rosterAs(winC, busyDir, 'legacy-sess-2', 'orch:@3.%3', 'busy');
    const panes = `${FIX}/legacy-panes.txt`;
    const killed = `${FIX}/legacy-killed.txt`;
    writeFileSync(panes, [`@1|legacy-1|${winA.pid}|${deskDir}`, `@3|legacy-2|${winC.pid}|${busyDir}`, `@2|notadesk|${winB.pid}|${otherDir}`].join('\n') + '\n');
    writeFileSync(killed, '');
    writeFileSync(`${FIX}/fake-tmux.cjs`, `
const fs = require('fs');
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'list-panes') { process.stdout.write(fs.readFileSync(${JSON.stringify(panes)}, 'utf8')); process.exit(0); }
if (cmd === 'kill-window') {
  const win = rest[rest.indexOf('-t') + 1];
  fs.appendFileSync(${JSON.stringify(killed)}, win + '\\n');
  const line = fs.readFileSync(${JSON.stringify(panes)}, 'utf8').split('\\n').find((l) => l.startsWith(win + '|'));
  if (line) { try { process.kill(Number(line.split('|')[2]), 'SIGHUP'); } catch {} }
  process.exit(0);
}
process.exit(1);
`);
    writeFileSync(`${FIX}/fake-tmux`, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(`${FIX}/fake-tmux.cjs`)} "$@"\n`);
    chmodSync(`${FIX}/fake-tmux`, 0o755);
    // A heartbeat every 1.5 s, so a registration after the watch has looked is
    // read below, not only the first one (which says nothing of holders yet).
    const h = startHost('host-test-legacy', { ORCH_HOST_ROOTS: root, ORCH_TMUX: `${FIX}/fake-tmux`, ORCH_HOST_HEARTBEAT_MS: '1500' });
    const said = await until(() => (/ended the tmux window an earlier version ran this desk's Claude Code in \(window legacy-1, pid (\d+)\)/.exec(h.log)?.[1] ?? null), 15000);
    eq(said, String(winA.pid), 'the host ends the window an earlier version ran a desk in, at its start, and says so');
    assert(await until(() => (aGone ? true : null), 8000), 'and that window\'s process is gone');
    let bAlive = true;
    try { process.kill(winB.pid, 0); } catch { bAlive = false; }
    eq([readFileSync(killed, 'utf8').trim(), bAlive], ['@1', true], 'a window of that session in a folder that is no desk of this host\'s is left alone, and so, for now, is one mid-turn');
    const onDesk = await until(async () => (((await turns('legacy-1')).rows ?? []).find((r) => r.tool_name === 'host' && /ended the tmux window an earlier version ran/.test(r.text ?? '')) ?? null), 15000);
    assert(!!onDesk, 'and the desk says it on the floor, a line labeled host');
    // The one mid-turn: the floor's own, finishing a turn, never "held by an
    // editor" with "quit it there first".
    // Waited for the watch's report, not only the desk going live: the first
    // registration seats the desk before any watch tick has said who holds it.
    const busyHeld = await until(async () => { const d = deskOf(await floor(), 'legacy-2'); return d?.hosted?.live && d.hosted.held ? d.hosted : null; }, 15000);
    eq([busyHeld?.held, busyHeld?.outside_pid ?? null, cGone], ['floor', null, false], 'a window mid-turn is left to finish it, and the desk reads as the floor\'s, not an editor\'s');
    // And still so after heartbeats that came after the watch's look: the
    // registration carries `outside_pid`, which the board's wake reads as
    // "somebody else holds it" (QA's mutant reporting the window as an
    // outside holder survived the first read alone).
    await sleep(4000);
    const busyLater = deskOf(await floor(), 'legacy-2')?.hosted;
    eq([busyLater?.held, busyLater?.outside_pid ?? null, busyLater?.window_open ?? null, cGone], ['floor', null, true, false], 'heartbeats later, the window mid-turn is still the floor\'s own, open, with no outside holder');
    rosterAs(winC, busyDir, 'legacy-sess-2', 'orch:@3.%3', 'idle');
    assert(await until(() => (cGone ? true : null), 10000), 'and once its turn ends, it is ended too');
    eq(readFileSync(killed, 'utf8').trim().split('\n'), ['@1', '@3'], 'its own window, and nothing else');
    h.kill('SIGTERM');
    for (const c of [winA, winB, winC]) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
    for (const c of [winA, winC]) rmSync(`${sessDir}/${c.pid}.json`, { force: true });
    await sleep(300);
  }

  /* ── a terminal's Claude Code the roster does not list yet (task 348 F6) ─────
   * pc-developer, measured on Windows: Open in Claude on a folder taken under
   * 0.15 stops at Claude Code's trust question in the terminal (the desk's
   * own `-p` never asked it), and until it is answered that Claude Code
   * writes no roster entry. The floor read the desk as held by nobody and
   * started a second process on the conversation. The process table has the
   * terminal's `claude --resume <id>` from its first moment. */
  console.log('\n  a terminal\'s Claude Code the roster does not list yet');
  {
    const root = `${FIX}/handoff-root`;
    mkdirSync(`${root}/h1`, { recursive: true });
    writeFileSync(`${root}/h1/.mcp.json`, JSON.stringify({ mcpServers: { orchestratinator: { type: 'http', url: `${HOST}/mcp`, headers: { 'X-Channel': CH, 'X-Agent': 'handoff-1', 'X-Orchestratinator-Key': KEY } } } }));
    const h = startHost('host-test-handoff', { ORCH_HOST_ROOTS: root });
    assert(await until(async () => (deskOf(await floor(), 'handoff-1')?.hosted?.live ? true : null), 20000), 'the fixture: the desk is live');
    const hm = Math.max(0, ...(((await turns('handoff-1')).rows ?? []).map((r) => r.id)));
    await chat('handoff-1', 'first words');
    assert(await until(async () => ((((await turns('handoff-1')).rows ?? []).some((r) => r.id > hm && r.role === 'assistant')) ? true : null), 20000), 'the fixture: the desk has a conversation');
    const sid = await until(async () => deskOf(await floor(), 'handoff-1')?.hosted?.session_id ?? null, 10000);
    // Open in Claude: the desk's Claude Code ends; the terminal here is none.
    await json('/api/floor/claude', { channel: CH, agent: 'handoff-1' });
    assert(await until(async () => (deskOf(await floor(), 'handoff-1')?.hosted?.held ? null : true), 15000), 'the fixture: the desk\'s own Claude Code has ended');
    mkdirSync(`${FIX}/term`, { recursive: true });
    writeFileSync(`${FIX}/term/claude`, 'setInterval(() => {}, 1000);\n');
    const term = spawn(process.execPath, [`${FIX}/term/claude`, '--resume', sid], { stdio: 'ignore' });
    const held = await until(async () => { const d = deskOf(await floor(), 'handoff-1'); return d?.hosted?.held === 'editor' ? d.hosted : null; }, 15000);
    assert(!!held, 'a Claude Code resuming the conversation that the roster does not list yet holds the desk', JSON.stringify(deskOf(await floor(), 'handoff-1')?.hosted));
    const refused = await chat('handoff-1', 'second words');
    eq(refused.status, 409, 'and a message is refused, not given to a second process on the conversation');
    term.kill('SIGKILL');
    assert(await until(async () => (deskOf(await floor(), 'handoff-1')?.hosted?.held === 'editor' ? null : true), 15000), 'once it has gone, the desk is free again');
    eq(argvLog().split('\n').slice(0, -1).filter((l) => l.includes(`--resume ${sid}`)).length, 0, 'and nothing was ever started beside it');
    // A host stopped while its desk is in a turn (task 348 F4): the stop
    // ends the turn, and that is said on the desk, where it used to show the
    // message with no reply and no word about why.
    const sm = Math.max(0, ...(((await turns('handoff-1')).rows ?? []).map((r) => r.id)));
    await chat('handoff-1', 'SLOW 30000');
    assert(await until(async () => (deskOf(await floor(), 'handoff-1')?.working ? true : null), 15000), 'the fixture: the desk is in a turn');
    const gone = new Promise((res) => h.once('exit', res));
    h.kill('SIGTERM');
    await gone;
    const cut = await until(async () => (((await turns('handoff-1')).rows ?? []).find((r) => r.id > sm && r.tool_name === 'host' && /stopped in the middle of a turn/.test(r.text ?? '')) ?? null), 10000);
    assert(!!cut, 'a turn the host\'s stop cut off is said on the desk');
  }

  /* ── the protocol probe on a Claude Code version not checked (task 351) ──────
   * costmo, 2026-11-23: a new Claude Code is checked with the protocol probe
   * before desks are affected, and any difference is on the floor. The probe
   * here is a stand-in module (ORCH_CANARY_STANDIN) whose answer is a file,
   * counting its runs; the real one is host/canary.js. */
  console.log('\n  the protocol probe on a Claude Code version not checked');
  {
    // The node its own MCP server runs on (host/canary.js probeNode): under
    // the desktop app never process.execPath, Electron's helper with its
    // run-as-node fuse off, which read on costmo's scratch app as a 31-of-32
    // difference ("Connection closed" for the reconnect).
    const { probeNode } = await import('../host/canary.js');
    const app = { versions: { electron: '45.2.3' }, execPath: '/Applications/X.app/Contents/Frameworks/X Helper', home: '/h' };
    eq([
      probeNode({ env: {}, versions: {}, execPath: '/usr/local/bin/node' }),
      probeNode({ env: {}, ...app, exists: (p) => p === '/h/.orchestratinator/bin/node' }),
      probeNode({ env: {}, ...app, exists: () => false }),
      probeNode({ env: { ORCH_CANARY_NODE: '/opt/node' }, ...app, exists: () => true }),
    ], ['/usr/local/bin/node', '/h/.orchestratinator/bin/node', 'node', '/opt/node'],
    "the probe's server runs on this host's node, but under the desktop app on the node the app carries, else a node on PATH, never Electron's helper");
  }
  {
    const root = `${FIX}/canary-root`;
    mkdirSync(`${root}/c1`, { recursive: true });
    writeFileSync(`${root}/c1/.mcp.json`, JSON.stringify({ mcpServers: { orchestratinator: { type: 'http', url: `${HOST}/mcp`, headers: { 'X-Channel': CH, 'X-Agent': 'canary-1', 'X-Orchestratinator-Key': KEY } } } }));
    const mode = `${FIX}/canary-mode.txt`;
    const runs = `${FIX}/canary-runs.txt`;
    writeFileSync(`${FIX}/canary-standin.mjs`, `
import { readFileSync, appendFileSync } from 'node:fs';
export async function probeClaude() {
  appendFileSync(${JSON.stringify(runs)}, 'run\\n');
  const m = readFileSync(${JSON.stringify(mode)}, 'utf8').trim();
  const first = { ok: m !== 'signedout', what: 'the turn ends in one result, with the reply', saw: m === 'signedout' ? 'Not logged in · Please run /login' : '' };
  const rows = [first, { ok: true, what: 'an init names the session', saw: '' }, { ok: m !== 'differ', what: 'command_lifecycle records are sent (the host\\'s receipt)', saw: m === 'differ' ? 'none seen' : '' }];
  return { rows, version: 'x', fails: rows.filter((r) => !r.ok).length, total: rows.length };
}
`);
    // This host's Claude Code answers --version from a flag of its own, so a
    // version changed here is never read by the suite's other host.
    const cver = `${FIX}/canary-version.flag`;
    writeFileSync(`${FIX}/canary-claude`, `#!/bin/sh\nif [ "$1" = "--version" ] && [ -s ${JSON.stringify(cver)} ]; then echo "$(cat ${JSON.stringify(cver)}) (Claude Code)"; exit 0; fi\nexec ${JSON.stringify(`${FIX}/claude`)} "$@"\n`, { mode: 0o755 });
    const canaryEnv = { ORCH_HOST_ROOTS: root, ORCH_HOST_CLAUDE: `${FIX}/canary-claude`, ORCH_CANARY: 'on', ORCH_CANARY_STANDIN: `${FIX}/canary-standin.mjs`, ORCH_CANARY_FILE: `${FIX}/canary-state.json` };
    const runCount = () => (existsSync(runs) ? readFileSync(runs, 'utf8').split('\n').filter(Boolean).length : 0);
    const hostCanary = async () => (await floor()).hosts?.find((h) => h.host_id === 'host-test-canary')?.canary ?? null;
    writeFileSync(mode, 'differ');
    let h = startHost('host-test-canary', canaryEnv);
    const c1 = await until(hostCanary, 20000);
    eq([/^\d+\.\d+\.\d+/.test(c1?.version ?? ''), c1?.ok, c1?.differed?.map((r) => r.what)], [true, false, ["command_lifecycle records are sent (the host's receipt)"]],
      'a version not checked is probed, and the row that differed is on the floor, in the probe\'s words, with the version');
    const said = await until(async () => (((await turns('canary-1')).rows ?? []).find((r) => r.tool_name === 'host' && /answered 1 of the floor's 3 protocol checks differently/.test(r.text ?? '')) ?? null), 10000);
    assert(!!said, 'and said on the desk');
    h.kill('SIGTERM');
    await new Promise((res) => h.once('exit', res));
    // Started again on the same version, with a heartbeat every 1.5 s, so
    // each heartbeat is a chance to probe it again. Then a new version on
    // the same host: once that one's result is on the floor, the heartbeats
    // on the old version have been and gone, and the count says what they did
    // (QA's inversion Q2 at patch C: the old row read the count before the
    // second host had looked at all).
    h = startHost('host-test-canary', { ...canaryEnv, ORCH_HOST_HEARTBEAT_MS: '1500' });
    assert(await until(async () => ((await hostCanary())?.version === c1?.version ? true : null), 20000), 'a host started again still says what the probe found, from its own record');
    await sleep(4000);
    writeFileSync(cver, '2.1.330-canary');
    const c3 = await until(async () => { const c = await hostCanary(); return c?.version === '2.1.330-canary' ? c : null; }, 20000);
    assert(!!c3, 'a new version on a running host is probed at its next heartbeat', JSON.stringify(c3));
    eq(runCount(), 2, 'and each version is probed once: the same version twice is one run, a new one is the second');
    rmSync(cver, { force: true });
    h.kill('SIGTERM');
    await new Promise((res) => h.once('exit', res));
    // A probe that could not run: its first message did not come back.
    rmSync(`${FIX}/canary-state.json`, { force: true });
    writeFileSync(mode, 'signedout');
    h = startHost('host-test-canary', canaryEnv);
    const c2 = await until(async () => { const c = await hostCanary(); return c?.error ? c : null; }, 20000);
    assert(!!c2 && /could not|did not come back/.test(c2.error) && /Not logged in/.test(c2.error), 'a probe that could not run says why, not that Claude Code is different', c2?.error);
    h.kill('SIGTERM');
    await new Promise((res) => h.once('exit', res));
    h = startHost('host-test-canary', canaryEnv);
    assert(await until(async () => ((await hostCanary())?.error ? true : null), 20000), 'the fixture: the host is back with that record');
    eq(runCount(), 3, 'and it is not run again for that version: it does not loop');
    h.kill('SIGTERM');
    await sleep(300);
  }

  /* ── Claude Code missing from where the host looks (task 341 C2h) ───────────
   * Measured with a real host and ORCH_HOST_CLAUDE pointing nowhere: the shell
   * said "no such file or directory" (exit 127), and the desk said "The next
   * message starts it again", which it never would. Said as what it is. */
  console.log('\n  Claude Code missing from where the host looks');
  {
    const root = `${FIX}/missing-root`;
    mkdirSync(`${root}/m1`, { recursive: true });
    writeFileSync(`${root}/m1/.mcp.json`, JSON.stringify({ mcpServers: { orchestratinator: { type: 'http', url: `${HOST}/mcp`, headers: { 'X-Channel': CH, 'X-Agent': 'missing-1', 'X-Orchestratinator-Key': KEY } } } }));
    const h = startHost('host-test-missing', { ORCH_HOST_ROOTS: root, ORCH_HOST_CLAUDE: `${FIX}/no-such-claude` });
    assert(await until(async () => (deskOf(await floor(), 'missing-1')?.hosted?.live ? true : null), 20000), 'the fixture: the desk is live on its host');
    eq((await chat('missing-1', 'anyone there?')).status, 200, 'the fixture: the message is taken by the board');
    const said = await until(async () => (((await turns('missing-1')).rows ?? []).find((r) => r.role === 'error' && /Claude Code/.test(r.text ?? '')) ?? null), 20000);
    assert(!!said && /could not be started on this machine/.test(said.text) && !/next message starts it again/.test(said.text), 'a Claude Code that is not there is said as that, never as "the next message starts it again"', said?.text);
    h.kill('SIGTERM');
    await sleep(300);
  }

  /* ── the floor keeps hearing while a message is being delivered ─────────────
   * Relaying the conversation and delivering a message used to share one
   * loop, so handling a chat stopped the relay. Delivering a message to a
   * desk with nothing running starts its Claude Code and waits for it to take
   * the message; the stand-in here takes six seconds to read anything. For
   * that whole stretch the floor still has to hear the desk. */
  console.log('\n  hearing the desk while a message is still going in');
  writeFileSync(`${FIX}/start-delay.flag`, '6000');
  host = startHost('host-test-1');
  assert(await until(async () => (deskOf(await floor(), 'free')?.hosted?.live ? true : null), 15000),
    'a host is back and the desk is live again');
  // A host just started joins the desk's transcript where it stands, at its
  // first watch tick (follow(id, 'end')), and a turn written before that
  // tick is behind it for good. So a turn is written first and waited for,
  // and the relay is known to be reading before anything is timed against it.
  const primer = `RELAY-JOINED-${Date.now()}`;
  appendTurn({ type: 'assistant', uuid: `primer-${Date.now()}`, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: primer }] } });
  let joined = await until(async () => (((await turns('free')).rows ?? []).some((r) => (r.text ?? '').includes(primer)) ? true : null), 3000);
  for (let i = 0; !joined && i < 5; i++) {
    // Written before the join, so never relayed: another, until one is.
    const again = `${primer}-${i}`;
    appendTurn({ type: 'assistant', uuid: `primer-${i}-${Date.now()}`, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: again }] } });
    joined = await until(async () => (((await turns('free')).rows ?? []).some((r) => (r.text ?? '').includes(again)) ? true : null), 3000);
  }
  assert(joined, 'the fixture: the restarted host is reading the desk\'s transcript before the timed part starts');

  // By id, not by count: the turns route serves a limited window, and once
  // the desk's turns pass it, a count stays the same whatever arrives.
  const turnsBefore = Math.max(0, ...(((await turns('free')).rows ?? []).map((r) => r.id)));
  const marker = `SPOKEN-WHILE-BUSY-${Date.now()}`;
  const queued = await chat('free', 'this one takes a while to go in');
  eq(queued.status, 200, 'the floor accepts the message');
  await until(() => (procsIn(REPO).length ? true : null), 5000);
  appendTurn({ type: 'assistant', uuid: `busy-${Date.now()}`, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: marker }] } });
  const heard = await until(async () => {
    const rows = (await turns('free')).rows ?? [];
    return rows.some((r) => (r.text ?? '').includes(marker)) ? rows : null;
  }, 4000);
  assert(!!heard, 'a turn written while the message is still going in reaches the floor anyway');
  assert(!received().includes('takes a while to go in'), 'and it got there before the message it was queued behind — the relay is not waiting on the delivery');
  assert((heard ?? []).some((r) => r.id > turnsBefore && (r.text ?? '').includes(marker)), 'the floor gained a turn rather than replaying the transcript');
  // And the subagent file already on disk was joined at its end, not replayed.
  // Named directly: QA's M6 (offsets read from 0) turned this suite red only
  // three sections later (PR #3 review, 2026-09-03).
  const everything = (await json(`/api/floor/turns?channel=${CH}&agent=free&limit=500`).then((r) => r.json())).rows ?? [];
  eq(everything.filter((r) => r.text === 'WebFetch: https://docs.example.test/hooks').length, 1,
    'a subagent file already on disk is not replayed when the host restarts');
  assert(await until(() => (received().includes('takes a while to go in') ? true : null), 20000),
    'and the message itself still lands once Claude Code is ready');
  rmSync(`${FIX}/start-delay.flag`, { force: true });

  /* ── a new Claude Code, and a folder dialog asked for too late ─────────────
   * The stand-in answers --version from version.flag, and the host restarted
   * here reads a version it has not seen at its first heartbeat (host/version.js:
   * report only, never a gate). Started with a folder-dialog TTL nothing can
   * meet, so every request for the dialog reaches this host "too late". */
  console.log('\n  a new Claude Code on the machine');
  host.kill('SIGTERM');
  await until(async () => (deskOf(await floor(), 'free')?.hosted?.live === false ? true : null), 8000);
  {
    const V = await import('../host/version.js');
    eq([V.versionOf('2.1.330 (Claude Code)\n'), V.versionOf('claude v2.2.0-beta.1'), V.versionOf('command not found')], ['2.1.330', '2.2.0-beta.1', null],
      'the version is read out of what `claude --version` prints, and nothing out of anything else');
    eq([V.versionChange(null, '2.1.330'), V.versionChange('2.1.330', '2.1.330'), V.versionChange('2.1.330', null), V.versionChange('2.1.330', '2.1.331')],
      [null, null, null, { from: '2.1.330', to: '2.1.331' }], 'a change is two readings that differ: a first reading, the same one, or none is not one');
    const vf = `${FIX}/version-state.json`;
    V.keepVersion('a', '2.1.330', vf); V.keepVersion('b', '2.1.329', vf);
    eq([V.lastVersion('a', vf), V.lastVersion('b', vf), V.lastVersion('c', vf)], ['2.1.330', '2.1.329', null], 'each host keeps its own reading');
  }
  assert(existsSync(`${HOME}/.orchestratinator/claude-version.json`), 'the fixture: the host has been keeping its reading in its own folder');
  writeFileSync(`${FIX}/version.flag`, '2.1.331');
  const versionMark = await lastId();
  host = startHost('host-test-1', { ORCH_PICK_TTL_MS: '-1' });
  assert(await until(async () => (deskOf(await floor(), 'free')?.hosted?.live ? true : null), 15000), 'the fixture: the host is back, and the desk live');
  const versionLine = await until(async () => (await newRows(versionMark)).find((r) => r.tool_name === 'host' && /Claude Code on .* is now 2\.1\.331 \(it was 2\.1\.330\)/.test(r.text ?? '')) ?? null, 8000);
  assert(!!versionLine, `a new Claude Code is said on the desk, with the one before it — ${versionLine?.text}`);
  // Left at 2.1.331 for the rest of the run: taken away, the next host would
  // say a change back on every desk, a line the sections after this one do
  // not expect.

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
   * files, and one started signed out answers every message "Not logged in"
   * for as long as it runs, as 2.1.329 does. */
  console.log('\n  Claude Code signed out on this machine');
  host.kill('SIGTERM');
  await until(async () => (deskOf(await floor(), 'free')?.hosted?.live === false ? true : null), 8000);
  host = null;
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
  assert(!received().includes('are you there?'), 'and nothing is sent to Claude Code');

  // The desk's Claude Code, started on its conversation while signed out.
  const soArgvAt = argvLog().length;
  eq((await json('/api/floor/open', { channel: CH, agent: 'free' })).status, 200, 'the fixture: the desk\'s Claude Code is started on its conversation');
  assert(!!(await heldBy('free', 'floor', SESSION_ID)), 'the fixture: it is running');
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
  // What ends the sign-in is the host's own line: each running Claude Code
  // started again on its conversation, then the registration.
  await until(async () => ((await soHostLines()).some((t) => /started its Claude Code again on the same conversation/.test(t ?? '')) ? true : null), 30000);
  const soSignedIn = await until(async () => { const d = deskOf(await floor(), 'free'); return d?.hosted?.live && !d.signin ? d : null; }, 10000);
  assert(!!soSignedIn, 'once Claude Code is signed in again the desk stops offering Sign in');
  eq(soLogins() - soLoginsBefore, 1, 'a press while a sign-in is open opens no second one');
  const soLines = await soHostLines();
  assert(soLines.some((t) => /already open in the browser on Test Mac/.test(t ?? '')), `and says the first is still open — ${JSON.stringify(soLines.slice(-6))}`);
  assert(soLines.includes('signed in to Claude Code on Test Mac'), 'the desk says it is signed in');
  await until(() => (launches(soArgvAt).filter((l) => l.endsWith(`--resume ${SESSION_ID}`)).length >= 2 ? true : null), 8000);
  eq(launches(soArgvAt).filter((l) => l.endsWith(`--resume ${SESSION_ID}`)).length, 2,
    `the desk's Claude Code, started signed out, was started again on its own conversation, so it reads the new sign-in — ${JSON.stringify(launches(soArgvAt))}`);
  assert(soLines.some((t) => t === 'started its Claude Code again on the same conversation, so it reads the new sign-in'), 'and the desk says why');
  assert(soSignedIn?.nudge?.ok === true, 'the bell rings again');
  eq((await floor()).hosts.find((h) => h.host_id === 'host-test-1')?.signed_out, false, 'the host is listed signed in');
  let soMark = await lastId();
  eq((await chat('free', 'back again')).status, 200, 'a message is taken');
  assert(await until(async () => ((await newRows(soMark)).some((r) => r.text === 'ECHO:back again') ? true : null), 15000), 'and answered: the Claude Code started after the sign-in reads it');
  rmSync(`${FIX}/signin-delay.flag`, { force: true });

  // A Claude Code that records "Not logged in" is believed at once, not at
  // the next heartbeat, even while `auth status` says signed in (a credential
  // that is there and no longer taken); a reply from any desk ends it.
  appendTurn({ type: 'assistant', uuid: `nli-${Date.now()}`, timestamp: new Date().toISOString(), isApiErrorMessage: true,
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } });
  const soSaidOut = await until(async () => (deskOf(await floor(), 'free')?.signin ? true : null), 8000);
  assert(!!soSaidOut, 'a Claude Code that records "Not logged in" puts Sign in on the desk within seconds');
  appendTurn({ type: 'assistant', uuid: `reply-${Date.now()}`, timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: 'Hello again.' }] } });
  assert(await until(async () => (deskOf(await floor(), 'free')?.signin ? null : true), 8000), 'and a reply takes it away');
  rmSync(`${FIX}/signed-out.flag`, { force: true });

  // F5 (0.14.5 review, measured on a rig): a conversation that ended on
  // "Not logged in", resumed on a machine that is signed in, replays its last
  // turns to the floor, and the replayed error muted every desk on the host
  // until a desk replied, which nothing on the floor could make it do. A
  // turn written before the desk joined is history and mutes nothing; one
  // written now still does (the row above it).
  console.log('\n  an old "Not logged in" in a resumed conversation');
  {
    const OLD_ID = '22222222-3333-4444-5555-666666666666';
    const t0 = Date.now() - 120000;
    writeFileSync(transcriptOf(REPO, OLD_ID), [
      { type: 'user', uuid: 'o1', timestamp: new Date(t0).toISOString(), message: { role: 'user', content: 'an old question' } },
      { type: 'assistant', uuid: 'o2', timestamp: new Date(t0 + 1000).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'an old answer' }] } },
      { type: 'assistant', uuid: 'o3', timestamp: new Date(t0 + 2000).toISOString(), isApiErrorMessage: true, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    eq((await json('/api/floor/reopen', { channel: CH, agent: 'free', session_id: OLD_ID })).status, 200, 'the fixture: the desk is reopened on a conversation that ended signed out two minutes ago');
    assert(await until(async () => (((await turns('free')).rows ?? []).some((r) => r.session_id === OLD_ID && r.role === 'error' && /Not logged in/.test(r.text ?? '')) ? true : null), 15000),
      'the fixture: its last turns are replayed to the floor, the old error the last of them');
    await sleep(2500);
    const f5 = await floor();
    eq([f5.hosts.find((h) => h.host_id === 'host-test-1')?.signed_out, !!deskOf(f5, 'free')?.signin, deskOf(f5, 'free')?.nudge?.ok], [false, false, true],
      'history mutes nothing: the host is not listed signed out, the desk offers no Sign in, the bell rings');
    assert(!!(await backHome()), 'the fixture: back on the conversation the sections below expect');
  }

  console.log('\n  the host reads the sign-in a desk\'s Claude Code would have');
  {
    const A = await import('../host/auth.js');
    const W = await import('../host/claude.js');
    const zd = `${FIX}/zdotdir`;
    mkdirSync(zd, { recursive: true });
    writeFileSync(`${zd}/.zshenv`, 'export TEST_ZSHENV_SIGNIN=1\n');
    writeFileSync(`${FIX}/signed-out.flag`, '');
    const base = { ...process.env };
    delete base.TEST_ZSHENV_SIGNIN;
    const withKey = { ...base, ZDOTDIR: zd };          // the key is in .zshenv
    const noKey = { ...base, ZDOTDIR: `${FIX}/zdotdir-none` };   // nowhere
    // What a desk's Claude Code reads: it is started through the person's
    // shell, `<shell> -c 'exec "$0" "$@"' claude …` (host/agent.js).
    const deskReads = (env) => {
      let out = '';
      try { out = execFileSync('/bin/zsh', ['-c', 'exec "$0" "$@"', `${FIX}/claude`, 'auth', 'status', '--json'], { env, encoding: 'utf8' }); }
      catch (e) { out = String(e.stdout ?? ''); }
      return A.readSignedIn(out);
    };
    eq([deskReads(withKey), deskReads(noKey)], [true, false], 'the fixture: a desk\'s Claude Code reads signed in with the key in .zshenv, and signed out with no key anywhere');
    eq(typeof A.signedIn, 'function', 'the fixture: the host has a sign-in reading');
    eq([await A.signedIn({ claude: `${FIX}/claude`, shell: '/bin/zsh', env: withKey }), await A.signedIn({ claude: `${FIX}/claude`, shell: '/bin/zsh', env: noKey })],
      [deskReads(withKey), deskReads(noKey)], 'the host reads what a desk reads: signed in for a key in .zshenv, signed out for none');
    eq(await A.signedIn({ claude: `${FIX}/claude`, shell: null, env: withKey }), false,
      'the control: asked with no shell around it, the same machine reads signed out');
    eq(A.statusCommand?.({ claude: '/x/claude', shell: null }), { cmd: '/x/claude', args: ['auth', 'status', '--json'] }, 'with no shell (Windows), the command runs as it is');
    eq(A.statusCommand?.({ claude: "/it's/claude", shell: '/bin/zsh' }), { cmd: '/bin/zsh', args: ['-c', `exec '/it'\\''s/claude' 'auth' 'status' '--json'`] }, 'with one, it is one line for that shell, quoted');
    eq([A.readSignedIn('Welcome back!\n{\n  "loggedIn": true\n}\n'), A.readSignedIn('welcome {to} my shell\n{\n  "loggedIn": true\n}\n'), A.readSignedIn('{"loggedIn": false}'), A.readSignedIn('no json here'), A.readSignedIn('')], [true, true, false, null, null],
      'a profile that prints a line of its own does not hide the answer');
    // A `claude` that never answers and ignores SIGTERM (QA, 0.14.5 review
    // 3800: the limit did not bound the wait): the reading comes back as
    // "could not say", at the limit, not when the child lets go.
    writeFileSync(`${FIX}/claude-hang`, '#!/bin/sh\ntrap "" TERM\nsleep 30 &\nsleep 30\n');
    chmodSync(`${FIX}/claude-hang`, 0o755);
    const hangAt = Date.now();
    const hung = await A.signedIn({ claude: `${FIX}/claude-hang`, shell: '/bin/zsh', env: noKey, timeoutMs: 300 });
    const hangMs = Date.now() - hangAt;
    eq(hung, null, 'a Claude Code that never answers is "could not say"');
    assert(hangMs < 2000, `within its limit, not when its children let go of the pipe (${hangMs} ms for a 300 ms limit)`);
    // QA's two edges (0.14.5 review 3819): a profile line with a brace of its
    // own, and a profile that leaves a process holding the pipe.
    const zb = `${FIX}/zdotdir-brace`; mkdirSync(zb, { recursive: true });
    writeFileSync(`${zb}/.zshenv`, 'echo "welcome {to} my shell"\nexport TEST_ZSHENV_SIGNIN=1\n');
    const zg = `${FIX}/zdotdir-bg`; mkdirSync(zg, { recursive: true });
    writeFileSync(`${zg}/.zshenv`, 'sleep 12 &\nexport TEST_ZSHENV_SIGNIN=1\n');
    eq(await A.signedIn({ claude: `${FIX}/claude`, shell: '/bin/zsh', env: { ...base, ZDOTDIR: zb } }), true, 'a profile whose own line holds a brace does not hide the answer');
    const bgAt = Date.now();
    const bgRead = await A.signedIn({ claude: `${FIX}/claude`, shell: '/bin/zsh', env: { ...base, ZDOTDIR: zg } });
    const bgMs = Date.now() - bgAt;
    eq(bgRead, true, 'a profile that leaves a process behind still reads');
    assert(bgMs < 2000, `when Claude Code is done, not when that process lets go of the pipe (${bgMs} ms against a 5 s limit)`);
    const real = (p) => ['/bin/zsh', '/bin/bash', '/bin/sh'].includes(p);
    eq([W.shellFor({ told: '/bin/bash', env: { SHELL: '/bin/zsh' }, account: () => '/bin/sh', exists: real }),
      W.shellFor({ told: '', env: { SHELL: '/bin/zsh' }, account: () => '/bin/sh', exists: real }),
      W.shellFor({ told: '', env: {}, account: () => '/bin/bash', exists: real }),
      W.shellFor({ told: 'zsh', env: { SHELL: '/opt/gone/fish' }, account: () => { throw new Error('no passwd'); }, exists: real })],
      ['/bin/bash', '/bin/zsh', '/bin/bash', '/bin/sh'], 'the shell is the one named, else SHELL, else the account\'s, else /bin/sh; a relative or missing one is passed over');

    // And the host itself, started on that machine: signed in, so nothing is
    // refused, where a460afd listed it signed out and refused the desk.
    host.kill('SIGTERM');
    await until(async () => (deskOf(await floor(), 'free')?.hosted?.live === false ? true : null), 8000);
    host = null;
    host = startHost('host-test-1', { ZDOTDIR: zd });
    const zl = await until(async () => { const d = deskOf(await floor(), 'free'); return d?.hosted?.live ? d : null; }, 15000);
    assert(!!zl, 'the fixture: a host started with the key only in .zshenv registers');
    await sleep(1500);
    eq((await floor()).hosts.find((h) => h.host_id === 'host-test-1')?.signed_out, false, 'a host whose desks are signed in through .zshenv is listed signed in');
    const zd2 = deskOf(await floor(), 'free');
    eq([!!zd2?.signin, zd2?.nudge?.code ?? null], [false, null], 'and its desk offers no Sign in and refuses no nudge for it');
    soMark = await lastId();
    eq((await chat('free', 'signed in by the profile')).status, 200, 'a message to the desk is taken');
    assert(await until(async () => ((await newRows(soMark)).some((r) => r.text === 'ECHO:signed in by the profile') ? true : null), 15000),
      'and answered: the desk\'s Claude Code, started through the person\'s shell, has the profile\'s credential');
    host.kill('SIGTERM');
    await until(async () => (deskOf(await floor(), 'free')?.hosted?.live === false ? true : null), 8000);
    host = null;
    rmSync(`${FIX}/signed-out.flag`, { force: true });
    host = startHost('host-test-1');
    await until(async () => (deskOf(await floor(), 'free')?.hosted?.live ? true : null), 15000);
  }
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
  const agreed = await runHost(boards, { until: /→ http:\/\/127\.0\.0\.1:9911/ });
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
  // Resolved on the desk's own line, which is printed after the startup line:
  // not on the name alone, which the key warning before it carries too.
  const moved = await runHost(boards, { CLAUDE_CONFIG_DIR: cfgDir, until: /cfg-agent [^\n]*\(local scope\)/ });
  assert(/host-test\/cfg-agent .*\(local scope\)/.test(moved.out), `a desk bound in local scope under CLAUDE_CONFIG_DIR is found there${/host-test\/cfg-agent .*\(local scope\)/.test(moved.out) ? '' : ` — ${JSON.stringify(moved.out.slice(-600))}`}`);
  // And written there: the host runs `claude mcp add` with CLAUDE_CONFIG_DIR
  // kept, so a desk taken under it lands in the file the host then reads
  // (desktop-dev, 7c9ca84: dropped with every other CLAUDE* variable, the
  // binding went to the default ~/.claude.json and no desk could be taken).
  {
    const { cliEnv } = await import('../host/mcp.js');
    const was = { cfg: process.env.CLAUDE_CONFIG_DIR, cc: process.env.CLAUDECODE };
    process.env.CLAUDE_CONFIG_DIR = cfgDir; process.env.CLAUDECODE = '1';
    const e = cliEnv();
    eq([e.CLAUDE_CONFIG_DIR ?? null, e.CLAUDECODE ?? null], [cfgDir, null], "the CLI the host runs for a binding keeps CLAUDE_CONFIG_DIR, and still none of a Claude Code session's own markers");
    for (const [k, v] of [['CLAUDE_CONFIG_DIR', was.cfg], ['CLAUDECODE', was.cc]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }

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
  // No tmux on this PATH: the installer needs none since the window layer
  // was replaced (2026-11-22).
  writeFileSync(`${instBin}/claude`, '#!/bin/sh\nexit 0\n');
  for (const t of ['launchctl', 'claude']) chmodSync(`${instBin}/${t}`, 0o755);
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

  /* ── Windows: the supervisor Task Scheduler starts ──────────────────────────
   * Task Scheduler restarts nothing that exits and stops a task by killing it
   * (pc-developer, Windows 11, 2026-11-20), so host/supervise.mjs restarts
   * the host and stops it by asking over the IPC channel. Neither is
   * Windows-only code, so both run here. Each host below serves a folder
   * with no desks in it, so it touches nothing the suite's own host has. */
  console.log('\n  the supervisor Windows runs the host under');
  {
    const supHome = `${inst}/sup-home`;
    const empty = `${inst}/sup-empty`;
    mkdirSync(`${supHome}/.orchestratinator`, { recursive: true });
    mkdirSync(empty, { recursive: true });
    const supLog = `${supHome}/.orchestratinator/log/host.log`;
    const stopFile = `${supHome}/.orchestratinator/host.stop`;
    const readLog = () => { try { return readFileSync(supLog, 'utf8'); } catch { return ''; } };
    // The one-supervisor lock (task 348 F3), at a short path: a socket path
    // under the fixture is longer than the system takes.
    const supLock = join(process.env.TMPDIR || tmpdir(), `orch-sup-${process.pid}.sock`);
    const supEnv = (env) => ({ PATH: process.env.PATH, HOME: supHome, TMPDIR: process.env.TMPDIR ?? '/tmp', ORCH_HOST_CONFIG: '/nonexistent/host.json', ORCH_SUPERVISE_RESTART_MS: '300', ORCH_SUPERVISE_LOCK: supLock, ...env });
    const supervise = (env) => spawn(process.execPath, ['host/supervise.mjs'], { env: supEnv(env), stdio: 'ignore' });

    // A host that cannot start (no board named anywhere) exits, and is started again.
    const crashing = supervise({ ORCH_HOST_ROOTS: empty });
    const restarted = await until(() => ((readLog().match(/supervisor: started the host/g) ?? []).length >= 2 ? true : null), 15000);
    assert(restarted, `a host that exits is started again (${(readLog().match(/supervisor: started the host/g) ?? []).length} starts)`);
    assert(/supervisor: the host exited \(code \d+\); starting it again/.test(readLog()), 'and the log says it exited and is being started again');
    writeFileSync(stopFile, 'stop');
    const crashExit = await Promise.race([new Promise((d) => crashing.once('exit', (code) => d(code))), sleep(10000).then(() => 'still running')]);
    eq(crashExit, 0, 'the stop file stops the supervisor, with exit 0');
    eq(existsSync(stopFile), false, 'and it takes the stop file away, so the next start is not stopped by it');
    if (crashExit === 'still running') crashing.kill('SIGKILL');

    // A host that is running is asked, over IPC, and leaves on its own.
    writeFileSync(supLog, '');
    const running = supervise({ ORCH_URL: HOST, ORCH_AUTH_TOKEN: KEY, ORCH_HOST_ROOTS: empty, ORCH_HOST_ID: 'host-test-sup', ORCH_HOST_NAME: 'Supervised' });
    const up = await until(async () => ((await (await json('/api/floor/folders')).json()).hosts.find((h) => h.host_id === 'host-test-sup')?.live ? true : null), 20000);
    assert(up, 'the fixture: the supervised host registers with the board');
    // A second supervisor while one runs (Task Scheduler's Start after an End
    // that killed only conhost, task 348 F3): it starts nothing, and says so.
    const second = supervise({ ORCH_URL: HOST, ORCH_AUTH_TOKEN: KEY, ORCH_HOST_ROOTS: empty, ORCH_HOST_ID: 'host-test-sup', ORCH_HOST_NAME: 'Supervised' });
    const secondExit = await Promise.race([new Promise((d) => second.once('exit', (code) => d(code))), sleep(10000).then(() => 'still running')]);
    eq(secondExit, 0, 'a second supervisor for the same host exits at once, rather than start a second host');
    assert(/another supervisor already runs this host/.test(readLog()), 'and says why in the log');
    eq((readLog().match(/supervisor: started the host/g) ?? []).length, 1, 'and only the first one\'s host was started');
    if (secondExit === 'still running') second.kill('SIGKILL');
    writeFileSync(stopFile, 'stop');
    const t0 = Date.now();
    const runExit = await Promise.race([new Promise((d) => running.once('exit', (code) => d(code))), sleep(30000).then(() => 'still running')]);
    eq(runExit, 0, `asked to stop, the supervisor exits 0 (in ${Date.now() - t0}ms)`);
    const said = readLog();
    assert(/supervisor: asked to stop; telling the host/.test(said) && /supervisor: stopped/.test(said), 'having told the host and said it stopped');
    assert(!/did not leave in time/.test(said), 'and the host left on its own, told over the channel, rather than being ended');
    assert(!/the host exited \(code \d+\); starting it again/.test(said), 'and nothing was started again after the stop');
    if (runExit === 'still running') running.kill('SIGKILL');

    // Its parent gone (Task Scheduler's End kills conhost and nothing under
    // it): the supervisor stops the host properly and leaves.
    writeFileSync(supLog, '');
    const parentEnv = { ...supEnv({ ORCH_URL: HOST, ORCH_AUTH_TOKEN: KEY, ORCH_HOST_ROOTS: empty, ORCH_HOST_ID: 'host-test-sup2', ORCH_HOST_NAME: 'Supervised 2' }) };
    const parent = spawn(process.execPath, ['-e', `const c = require('child_process').spawn(process.execPath, ['host/supervise.mjs'], { stdio: 'ignore', detached: true }); console.log(c.pid); setInterval(() => {}, 1000);`], { env: parentEnv, stdio: ['ignore', 'pipe', 'ignore'] });
    const supPid = await new Promise((d) => parent.stdout.once('data', (b) => d(Number(String(b).trim()))));
    const up2 = await until(async () => ((await (await json('/api/floor/folders')).json()).hosts.find((h) => h.host_id === 'host-test-sup2')?.live ? true : null), 20000);
    assert(up2, 'the fixture: a supervisor started by a process of its own runs its host');
    parent.kill('SIGKILL');
    const supGone = await until(() => { try { process.kill(supPid, 0); return null; } catch { return true; } }, 30000);
    assert(supGone && /the process that started this supervisor is gone/.test(readLog()) && /supervisor: stopped/.test(readLog()), 'when the process that started it is killed, it stops its host properly and leaves');
    if (!supGone) { try { process.kill(supPid, 'SIGKILL'); } catch { /* gone */ } }
  }

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
      env: { ...process.env, HOME, ORCH_HOST_ROOTS: emptyRoot, ORCH_HOST_CONFIG: '/nonexistent/host.json',
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
  // What the host said, and what the desk recorded, when something went
  // wrong. A failure to deliver reaches the floor as an error turn, and
  // reading it beats inferring it from a missing line.
  if (failures && server) {
    try {
      const d = await turns('free');
      console.log('\n--- desk turns ---');
      for (const t of d.rows ?? []) console.log(`${t.id} ${t.role} ${JSON.stringify((t.text ?? '').slice(0, 500))}`);
    } catch { /* the board may already be gone */ }
  }
  // What Claude Code was actually sent, and what it was started with: a
  // message that "did not land" is either a record never written to it or a
  // process never started, and these two files say which without guessing.
  if (failures) {
    for (const [label, path] of [['sent to the stand-ins', STDIN_LOG], ['claude argv', `${FIX}/argv.log`]]) {
      try { if (existsSync(path)) console.log(`\n--- ${label} ---\n${readFileSync(path, 'utf8').trim().split('\n').slice(-80).join('\n')}`); } catch { /* gone */ }
    }
  }
  if (failures && hostLog.trim()) console.log(`\n--- host log ---\n${hostLog.trim()}\n----------------`);
  // The host is stopped, not killed, so it ends its desks' Claude Codes as
  // it does on a stop; a host killed outright leaves them to end when their
  // input closes. Either way none may be left.
  if (host && host.exitCode === null) {
    const gone = new Promise((done) => host.once('exit', done));
    try { host.kill('SIGTERM'); } catch { /* gone */ }
    await Promise.race([gone, sleep(20000)]);
  }
  try { host?.kill('SIGKILL'); } catch { /* gone */ }
  try { server?.kill('SIGKILL'); } catch { /* gone */ }
  // Counted before the sweep, or the sweep would hide a leak.
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

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
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync, chmodSync, utimesSync } from 'node:fs';
import { resolve } from 'node:path';

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
  writeFileSync(`${REPO}/.mcp.json`, JSON.stringify({
    mcpServers: {
      orchestratinator: {
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
    `fs.appendFileSync(ARGV, process.argv.slice(2).join(' ') + '\\n');`,
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
    `const MY_ID = resumeAt >= 0 && process.argv[resumeAt + 1] ? process.argv[resumeAt + 1] : SESSION_ID;`,
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
    `if (readyDelay > 0) setTimeout(announce, readyDelay); else announce();`,
    String.raw`process.stdout.write('\u001b[?2004h');`,
    // A flag file makes the window look mid-turn: Claude Code's status line
    // says "esc to interrupt" exactly while it works, and the host reads that
    // off the pane's bottom line. A reopen must refuse such a window.
    `const BUSY_FLAG = ${JSON.stringify(`${FIX}/busy.flag`)};`,
    String.raw`if (fs.existsSync(BUSY_FLAG)) process.stdout.write('\n  \u2733 Baking\u2026 (esc to interrupt)\n');`,
    String.raw`const START = '\u001b[200~', END = '\u001b[201~';`,
    `let acc = '', composer = '', n = 0;`,
    `process.stdin.on('data', (chunk) => {`,
    `  fs.appendFileSync(SINK, chunk);`,
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
}

function startHost(id = 'host-test-1', extraEnv = {}) {
  const h = spawn('node', ['host/index.js'], {
    env: {
      ...process.env,
      HOME,
      ORCH_URL: HOST, ORCH_AUTH_TOKEN: KEY, ORCH_HOST_ROOTS: FIX,
      ORCH_HOST_ID: id, ORCH_HOST_NAME: 'Test Mac',
      ORCH_HOST_CLAUDE: `${FIX}/claude`, ORCH_TMUX_SESSION: TMUX_SESSION,
      ORCH_HOST_WATCH_MS: '300', ORCH_HOST_CONFIG: '/nonexistent/host.json',
      // send() waits for the message to show up in the transcript before it
      // calls it delivered. The stand-in writes one, so this is the real path;
      // the timeout is only shortened so a genuine failure fails fast.
      ORCH_SUBMIT_SETTLE_MS: '150', ORCH_LAND_TIMEOUT_MS: '8000',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  h.log = '';
  // Kept outside the process too: the last section deliberately kills the host,
  // and everything it said would go with it just when a failure needs reading.
  h.stdout.on('data', (d) => { h.log += d; hostLog += d; });
  h.stderr.on('data', (d) => { h.log += d; hostLog += d; });
  return h;
}

const killTmux = () => { try { execFileSync('tmux', ['kill-session', '-t', TMUX_SESSION], { stdio: 'ignore' }); } catch { /* none */ } };

let server = null;
let host = null;
let hostLog = '';

try {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); } catch {
    console.log('host: tmux is not installed — skipping (install it with `brew install tmux`)');
    process.exit(0);
  }

  rmDb(DB_PATH);
  fixture();
  server = spawn('node', ['src/server.js'], {
    env: { ...process.env, PORT: String(PORT), DB_PATH, ORCH_AUTH_TOKEN: KEY, ORCH_AUTH_MODE: 'enforce' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
  eq((await take({ host_id: 'host-test-1', path: `${FIX}/repo-elsewhere`, channel: CH, agent: 'newbie' })).status, 409, 'a folder bound to another board is refused');
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
  const busyOpen = await json('/api/floor/reopen', { channel: CH, agent: 'free', session_id: SESSION_B });
  eq(busyOpen.status, 200, 'a pick is queued while the window is idle');
  const idBefore = deskOf(await floor(), 'free')?.hosted?.session_id;
  assert(await until(async () => { const p = paneOf(); return p.length === panesAfter.length && !p.some((x) => panesAfter.includes(x)) ? true : null; }, 25000),
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
  eq((await json('/api/floor/browse', { host_id: 'host-test-1' })).status, 200, 'the floor can ask the host to list its root');
  const rootList = await until(async () => { const g = await browsed(); return g.at ? g : null; }, 15000);
  assert(!!rootList, 'and the host answers');
  eq(rootList?.path, FIX, 'with the root it was given');
  const inRoot = Object.fromEntries((rootList?.entries ?? []).map((f) => [f.name, f]));
  eq(inRoot['repo-a']?.bound?.agent, 'free', 'a folder that is a desk says which');
  eq(inRoot['repo-elsewhere']?.other_board, 'http://localhost:9', 'one bound to another board says so');
  eq([inRoot['plain-git']?.bound ?? null, inRoot['plain-git']?.git], [null, true], 'an unbound checkout is plain, and known to be a checkout');
  assert(!inRoot['.claude'] && !inRoot['home'] === false, 'dotfolders are not listed');
  eq((await json('/api/floor/browse', { host_id: 'host-test-1', path: `${FIX}/repo-a` })).status, 200, 'and to open a folder inside it');
  const inner = await until(async () => { const g = await browsed(`${FIX}/repo-a`); return g.at ? g : null; }, 15000);
  eq([inner?.parent, inner?.self?.bound?.channel, (inner?.entries ?? []).map((f) => f.name)], [FIX, CH, ['src']], 'which says where it is, what it is bound as, and what is inside');
  await json('/api/floor/browse', { host_id: 'host-test-1', path: '/etc' });
  const outside = await until(async () => { const g = await browsed('/etc'); return g.at ? g : null; }, 15000);
  assert(/not under this host's roots/.test(outside?.error ?? ''), `a folder outside the roots is refused, not listed — ${outside?.error}`);

  // Move: free's folder onto another floor, under its own name. The window
  // is held by the floor and is on SESSION_ID (the fresh conversation from
  // above), so the move closes it and reopens it there.
  const sidBeforeMove = deskOf(await floor(), 'free')?.hosted?.session_id;
  eq(sidBeforeMove, SESSION_ID, 'the desk to move is on a known conversation, in a floor-held window');
  const argvAtMove = argvLog().length;
  const movedOut = await take({ host_id: 'host-test-1', path: REPO, channel: CH2, agent: 'free' });
  eq([movedOut.status, (await movedOut.json()).mode], [200, 'move'], 'taking it onto another floor under its own name is a move');
  eq((await take({ host_id: 'host-test-1', path: REPO, channel: CH2, agent: 'renamed' })).status, 400, 'and under another name is refused — the folder names its agent');
  const onNewFloor = (f) => f.channels.find((c) => c.channel === CH2)?.desks.find((d) => d.agent === 'free');
  assert(await until(async () => (onNewFloor(await floor())?.hosted?.live ? true : null), 30000), 'the desk appears on the new floor, hosted');
  assert(/free: bound .*repo-a in local scope/.test(host.log) && /moving it from host-test\/free/.test(host.log), 'the host rebound the folder and said where from');
  assert(await until(async () => (onNewFloor(await floor())?.hosted?.session_id === SESSION_ID ? true : null), 30000), 'on the same conversation');
  assert(await until(() => (argvLog().slice(argvAtMove).includes(`--resume ${SESSION_ID}`) ? true : null), 25000),
    'its window reopened with --resume, because a running window keeps the headers it started with');
  eq(deskOf(await floor(), 'free') ?? null, null, 'and its seat has left the old floor');
  eq(localCfg().projects?.[REPO]?.mcpServers?.orchestratinator?.headers?.['X-Channel'], CH2, 'the binding on disk names the new floor');

  // And back, so the sections below find it where they expect it.
  const back = await take({ host_id: 'host-test-1', path: REPO, channel: CH, agent: 'free' });
  eq((await back.json()).mode, 'move', 'moving it back is a move too');
  assert(await until(async () => (deskOf(await floor(), 'free')?.hosted?.session_id === SESSION_ID ? true : null), 30000), 'and it is home, on its conversation');
  await sleep(WATCH_SETTLE_MS);

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
  host = startHost('host-test-1');
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
  rmDb(DB_PATH);
  rmSync(FIX, { recursive: true, force: true });
}

console.log(failures ? `\nhost: ${failures} failed` : '\nhost: all passed');
process.exit(failures ? 1 : 0);

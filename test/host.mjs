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
import { mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';

const PORT = Number(process.env.HOST_TEST_PORT ?? 8896);
const DB_PATH = `./data/host-${process.pid}.db`;
const HOST = `http://localhost:${PORT}`;
const KEY = 'host-shared-secret';
const CH = 'host-test';
const FIX = resolve(`./data/host-fixture-${process.pid}`);
const HOME = `${FIX}/home`;
const TMUX_SESSION = `orch-host-test-${process.pid}`;
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
    `if (process.argv[2] === 'agents') { process.stdout.write(fs.readFileSync(ROSTER, 'utf8')); process.exit(0); }`,
    `fs.writeFileSync(ROSTER, JSON.stringify([{ pid: process.pid, cwd: process.cwd(), kind: 'interactive', startedAt: 1, sessionId: SESSION_ID, name: 'stand-in' }]));`,
    String.raw`process.stdout.write('\u001b[?2004h');`,
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

function startHost(id = 'host-test-1') {
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

  appendTurn({ type: 'assistant', uuid: 'a-3', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent chatter' }] } });
  await sleep(600);
  assert(!((await turns('free')).rows ?? []).some((r) => r.text === 'subagent chatter'),
    "a subagent's own conversation stays inside the tool call that owns it");

  console.log('\nwhen the host is gone');
  host.kill('SIGTERM');
  await until(async () => (deskOf(await floor(), 'free')?.hosted?.live === false ? true : null));
  const refused = await chat('free', 'anyone there?');
  eq(refused.status, 409, 'a message with no host to take it is refused rather than swallowed');
  eq((await refused.json()).code, 'host_offline', 'with the reason');
  host = null;
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
  if (failures && hostLog.trim()) console.log(`\n--- host log ---\n${hostLog.trim()}\n----------------`);
  try { host?.kill('SIGKILL'); } catch { /* gone */ }
  try { server?.kill('SIGKILL'); } catch { /* gone */ }
  killTmux();
  rmDb(DB_PATH);
  rmSync(FIX, { recursive: true, force: true });
}

console.log(failures ? `\nhost: ${failures} failed` : '\nhost: all passed');
process.exit(failures ? 1 : 0);

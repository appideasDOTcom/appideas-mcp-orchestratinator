// End-to-end test for one agent with several sessions: a real host against a
// real server, driving real tmux panes, with several windows in ONE folder.
//
// The host suite cannot hold this. Its stand-in is one window at a time — it
// writes a roster of one entry and one transcript, both named for the
// fixture's single conversation — because for as long as a folder was one
// desk that was the whole of what a host could meet. Here the stand-in is
// what Claude Code is when several run in a folder: each window announces
// itself in a session file of its own (~/.claude/sessions/<pid>.json, the
// host's fast path), writes a transcript of its own, and connects as the desk
// its binding names — the `--mcp-config` file it was started with, or else
// the folder's own entry. It answers every message with "I AM <channel>/
// <agent>", which is what lets an assertion say which desk a window is
// rather than only that bytes reached a pane.
//
// What it cannot say is what Claude Code itself does with `--mcp-config`
// beside a folder's binding. That was measured on a real window and is
// recorded in host/seats.js; this suite is the host's and the board's half.
//
// A tmux socket of its own, never the default: the default socket is the
// live `orch`, and this suite opens the session a seat's window creates.
//   npm run test:seats
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { cwdOf, seatOf, paneIn, sessionsAt, seatWindowName, seatEnv, SEAT_ENV } from '../host/window.js';
import { seatTag, configPath } from '../host/seats.js';

const PORT = Number(process.env.SEATS_TEST_PORT ?? 8902);
const DB_PATH = `./data/seats-${process.pid}.db`;
const HOST = `http://localhost:${PORT}`;
const KEY = 'seats-shared-secret';
const SA = 'seat-a';
const SB = 'seat-b';
const FIX = resolve(`./data/seats-fixture-${process.pid}`);
const HOME = `${FIX}/home`;
const CLAUDE_HOME = `${HOME}/.claude`;
const SEATS = `${FIX}/seats`;
const REPO = `${FIX}/quinn-repo`;
const OTHER = `${FIX}/rae-repo`;
const SOCK = `orch-seats-${process.pid}`;
const TMUXW = `${FIX}/tmuxw`;
const SESSION = 'orch';
const STARTS = `${FIX}/starts.log`;
// Where this suite's host keeps its seats, so the paths asked of
// host/seats.js here are the ones the host uses.
process.env.ORCH_HOST_SEATS = SEATS;

let failures = 0;
const assert = (cond, msg, got) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}${cond || got === undefined ? '' : `  (got ${JSON.stringify(got)})`}`);
  if (!cond) failures++;
};
const eq = (actual, expected, msg) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? '✓' : '✗'} ${msg}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
  if (!ok) failures++;
};
const rmDb = (p) => { for (const ext of ['', '-wal', '-shm']) { try { rmSync(p + ext); } catch { /* ignore */ } } };

const json = (path, body) => fetch(`${HOST}${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { 'content-type': 'application/json', 'x-orchestratinator-key': KEY },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const op = async (path, body) => { const r = await json(path, body); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const floor = () => json('/api/floor').then((r) => r.json());
const deskOf = (f, channel, agent) => f.channels.find((c) => c.channel === channel)?.desks.find((d) => d.agent === agent) ?? null;
const desk = async (channel, agent) => deskOf(await floor(), channel, agent);
const turns = (channel, agent) => json(`/api/floor/turns?channel=${channel}&agent=${agent}&limit=200`).then((r) => r.json()).then((t) => t.rows ?? []);

async function until(fn, ms = 15000) {
  const stop = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > stop) return null;
    await sleep(150);
  }
}
async function waitHealthy() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${HOST}/health`)).ok) return true; } catch { /* retry */ }
    await sleep(100);
  }
  return false;
}

const tmux = (...args) => { try { return execFileSync(TMUXW, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
/** Every pane on this suite's socket: its window's name, its seat tag, its pid, the command tmux keeps for it. */
const panes = () => tmux('list-panes', '-a', '-F', '#{window_name}\t#{@orch_seat}\t#{pane_pid}\t#{pane_start_command}')
  .split('\n').filter(Boolean).map((l) => { const [name, seat, pid, cmd] = l.split('\t'); return { name, seat: seat || null, pid: Number(pid), cmd }; });
/** Every window the stand-in was started as, oldest first. */
const starts = () => (existsSync(STARTS) ? readFileSync(STARTS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function fixture() {
  mkdirSync(REPO, { recursive: true });
  mkdirSync(OTHER, { recursive: true });
  mkdirSync(CLAUDE_HOME, { recursive: true });
  const bind = (dir, channel, agent) => writeFileSync(`${dir}/.mcp.json`, JSON.stringify({
    mcpServers: { orchestratinator: { type: 'http', url: `${HOST}/mcp`, headers: { 'X-Channel': channel, 'X-Agent': agent, 'X-Orchestratinator-Key': KEY } } },
  }, null, 2));
  bind(REPO, SA, 'quinn');
  bind(OTHER, SA, 'rae');
  writeFileSync(TMUXW, `#!/bin/sh\nexec tmux -L ${SOCK} "$@"\n`);
  chmodSync(TMUXW, 0o755);
  writeFileSync(`${FIX}/claude`, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(`${FIX}/claude.cjs`)} "$@"\n`);
  chmodSync(`${FIX}/claude`, 0o755);
  // The stand-in. Everything it needs to find is a constant: a pane's
  // environment is the tmux server's, not this process's.
  writeFileSync(`${FIX}/claude.cjs`, [
    `const fs = require('fs'); const path = require('path');`,
    `const CLAUDE_HOME = ${JSON.stringify(CLAUDE_HOME)};`,
    `const HOME = ${JSON.stringify(HOME)};`,
    `const STARTS = ${JSON.stringify(STARTS)};`,
    `const argv = process.argv.slice(2);`,
    `if (argv[0] === 'agents') { process.stdout.write('[]'); process.exit(0); }`,
    // The host asks Claude Code whether it is signed in at every heartbeat
    // (host/auth.js). Signed in, as 2.1.329 answers it, and not a window.
    `if (argv[0] === 'auth') { process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) + '\\n'); process.exit(0); }`,
    // `claude mcp add|remove -s local`, as the host suite's stand-in does it.
    `if (argv[0] === 'mcp') {`,
    `  const CFG = path.join(HOME, '.claude.json');`,
    `  let j = {}; try { j = JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch {}`,
    `  const a = argv.slice(1); const sub = a[0];`,
    `  const rest = a.slice(1).filter((x, i, arr) => x !== '-s' && arr[i - 1] !== '-s');`,
    `  j.projects = j.projects || {}; const dir = process.cwd(); j.projects[dir] = j.projects[dir] || {}; const p = j.projects[dir]; p.mcpServers = p.mcpServers || {};`,
    `  const done = () => { fs.writeFileSync(CFG, JSON.stringify(j, null, 2)); process.stdout.write('File modified: ' + CFG + '\\n'); process.exit(0); };`,
    `  if (sub === 'add') {`,
    `    const positional = rest.filter((x, i, arr) => !x.startsWith('-') && arr[i - 1] !== '--transport' && arr[i - 1] !== '-H');`,
    `    const [name, url] = positional; const headers = {};`,
    `    rest.forEach((x, i) => { if (x === '-H') { const [k, ...v] = rest[i + 1].split(':'); headers[k.trim()] = v.join(':').trim(); } });`,
    `    if (p.mcpServers[name]) { process.stderr.write('MCP server ' + name + ' already exists in local config\\n'); process.exit(1); }`,
    `    p.mcpServers[name] = { type: 'http', url, headers }; done();`,
    `  }`,
    `  if (sub === 'remove') {`,
    `    const name = rest[0];`,
    `    if (!p.mcpServers[name]) { process.stderr.write('No MCP server named "' + name + '" in local scope\\n'); process.exit(1); }`,
    `    delete p.mcpServers[name]; done();`,
    `  }`,
    `  process.exit(2);`,
    `}`,
    `const flag = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };`,
    `const cwd = process.cwd();`,
    `const cfgFile = flag('--mcp-config');`,
    `const id = flag('--resume') || ('sess-' + process.pid);`,
    // Which desk this window is: its own binding file when it was started
    // with one, as Claude Code does (measured; host/seats.js), else the
    // folder's local-scope entry, else its .mcp.json.
    `const entry = (servers) => { const s = Object.values(servers || {})[0]; return s ? { channel: s.headers['X-Channel'], agent: s.headers['X-Agent'], url: s.url, key: s.headers['X-Orchestratinator-Key'] || null } : null; };`,
    `const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };`,
    `const me = cfgFile ? entry(read(cfgFile)?.mcpServers) : (entry(read(path.join(HOME, '.claude.json'))?.projects?.[cwd]?.mcpServers) || entry(read(path.join(cwd, '.mcp.json'))?.mcpServers));`,
    `const env = {}; for (const k of ['ORCH_DESK_CONFIG', 'ORCH_DESK_ROOT', 'ORCH_CHANNEL', 'ORCH_AGENT']) env[k] = process.env[k] ?? null;`,
    `fs.appendFileSync(STARTS, JSON.stringify({ pid: process.pid, cwd, argv, id, me, env }) + '\\n');`,
    `const dir = path.join(CLAUDE_HOME, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));`,
    `fs.mkdirSync(dir, { recursive: true });`,
    `const transcript = path.join(dir, id + '.jsonl');`,
    `if (!fs.existsSync(transcript)) fs.writeFileSync(transcript, '');`,
    `const sdir = path.join(CLAUDE_HOME, 'sessions'); fs.mkdirSync(sdir, { recursive: true });`,
    `const sfile = path.join(sdir, process.pid + '.json');`,
    `fs.writeFileSync(sfile, JSON.stringify({ pid: process.pid, sessionId: id, cwd, kind: 'interactive', entrypoint: 'cli', startedAt: Date.now() }));`,
    `process.on('SIGHUP', () => { try { fs.unlinkSync(sfile); } catch {} process.removeAllListeners('SIGHUP'); process.kill(process.pid, 'SIGHUP'); });`,
    String.raw`process.stdout.write('\u001b[?2004h');`,
    String.raw`const START = '\u001b[200~', END = '\u001b[201~';`,
    `let acc = '', composer = '', n = 0;`,
    `const rec = (o) => fs.appendFileSync(transcript, JSON.stringify(o) + '\\n');`,
    `process.stdin.on('data', (chunk) => {`,
    `  acc += chunk.toString('utf8');`,
    `  for (;;) {`,
    `    const at = acc.indexOf(START);`,
    `    if (at >= 0) {`,
    `      const end = acc.indexOf(END, at);`,
    `      if (end < 0) break;`,
    `      composer += acc.slice(at + START.length, end);`,
    `      acc = acc.slice(0, at) + acc.slice(end + END.length);`,
    `      continue;`,
    `    }`,
    String.raw`    const submit = acc.search(/[\r\n]/);`,
    `    if (submit >= 0) {`,
    `      const text = (composer + acc.slice(0, submit)).trim();`,
    `      composer = ''; acc = acc.slice(submit + 1);`,
    `      if (text) {`,
    `        rec({ type: 'user', uuid: 'u' + process.pid + '-' + (++n), timestamp: new Date().toISOString(), message: { content: text } });`,
    `        rec({ type: 'assistant', uuid: 'a' + process.pid + '-' + n, timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: 'I AM ' + (me ? me.channel + '/' + me.agent : 'nobody') + ' on ' + id }] } });`,
    // A window mid-turn, as the host reads one: the pane's last line. Its
    // last turn is still the reply above, so the board takes it for idle,
    // which is the case the host's own check is for.
    `        if (/look busy/.test(text)) process.stdout.write('\\nesc to interrupt');`,
    `        if (/look idle/.test(text)) process.stdout.write('\\nidle now\\n');`,
    `      }`,
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
}

let hostLog = '';
function startHost() {
  const h = spawn('node', ['host/index.js'], {
    env: {
      ...process.env,
      HOME, ORCH_CLAUDE_HOME: CLAUDE_HOME,
      ORCH_URL: HOST, ORCH_AUTH_TOKEN: KEY, ORCH_HOST_ROOTS: FIX,
      ORCH_HOST_ID: 'seats-host', ORCH_HOST_NAME: 'Seat Mac',
      ORCH_HOST_CLAUDE: `${FIX}/claude`, ORCH_TMUX: TMUXW, ORCH_TMUX_SESSION: SESSION,
      ORCH_HOST_WATCH_MS: '300', ORCH_HOST_CONFIG: '/nonexistent/host.json', ORCH_HOST_SEATS: SEATS,
      ORCH_SUBMIT_SETTLE_MS: '150', ORCH_LAND_TIMEOUT_MS: '8000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  h.stdout.on('data', (d) => { hostLog += d; });
  h.stderr.on('data', (d) => { hostLog += d; });
  return h;
}
const stopHost = async (h) => {
  if (!h || h.exitCode !== null) return;
  const done = new Promise((ok) => h.once('exit', ok));
  h.kill('SIGTERM');
  await Promise.race([done, sleep(5000)]);
};

const STAND_IN = `${FIX}/claude.cjs`;
const standIns = () => {
  let out = '';
  try { out = execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' }); } catch { return []; }
  return out.split('\n').map((l) => l.trim().split(/\s+/)).filter(([, exe, script]) => /(^|\/)node$/.test(exe ?? '') && script === STAND_IN).map(([pid]) => Number(pid));
};
const killTmux = () => { try { execFileSync(TMUXW, ['kill-server'], { stdio: 'ignore' }); } catch { /* none */ } };
const sweep = () => { for (const p of standIns()) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } } };

let server = null;
let host = null;
const tidy = () => {
  try { server?.kill(); } catch { /* gone */ }
  try { host?.kill('SIGKILL'); } catch { /* gone */ }
  if (existsSync(TMUXW)) killTmux();
  sweep();
  rmDb(DB_PATH);
  rmSync(FIX, { recursive: true, force: true });
};
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { tidy(); console.log(`\nseats: interrupted by ${sig}; its server, host, tmux server and stand-ins are gone`); process.exit(130); });
}

/** Say something to a desk from the floor and wait for the stand-in's answer to it. */
async function ask(channel, agent, text) {
  const r = await op('/api/floor/chat', { channel, agent, text });
  if (r.status !== 200) return { refused: r.body };
  const said = await until(async () => {
    const rows = await turns(channel, agent);
    const at = rows.findIndex((t) => t.role === 'user' && t.text === text);
    return at >= 0 ? rows.slice(at + 1).find((t) => t.role === 'assistant') ?? null : null;
  }, 20000);
  return { answer: said?.text ?? null };
}

try {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); } catch {
    console.log('seats: tmux is not installed — skipping (install it with `brew install tmux`)');
    process.exit(0);
  }

  console.log('seats');
  console.log('\n  which window, said without a window');
  eq([cwdOf('/r/a'), seatOf('/r/a'), cwdOf({ cwd: '/r/a', seat: 'x/y' }), seatOf({ cwd: '/r/a', seat: 'x/y' }), seatOf({ cwd: '/r/a' })], ['/r/a', null, '/r/a', 'x/y', null],
    'a window is asked for by its folder, or by its folder and its seat');
  eq(seatTag('lab/one', 'q|a'), 'lab%2Fone/q%7Ca', 'a seat\'s tag holds neither the separator tmux\'s fields are split on nor a second slash');
  const P = [
    { target: 'o:@1.%1', pid: 11, seat: null, cwd: FIX },
    { target: 'o:@2.%2', pid: 12, seat: 'seat-b/quinn', cwd: FIX },
    { target: 'o:@3.%3', pid: 13, seat: 'seat-a/quinn-2', cwd: FIX },
    { target: 'o:@4.%4', pid: 14, seat: null, cwd: '/somewhere/else' },
  ];
  eq(paneIn(P, FIX)?.pid, 11, 'the folder\'s own window is the one with no tag');
  eq(paneIn(P, { cwd: FIX, seat: 'seat-b/quinn' })?.pid, 12, 'a seat\'s window is the one tagged as it');
  eq(paneIn(P, { cwd: FIX, seat: 'seat-c/quinn' }), null, 'a seat with no window has none: never the folder\'s own, and never another seat\'s');
  eq(paneIn(P.slice(1), FIX), null, 'and a folder with only seats\' windows has no window of its own');
  const S = [
    { pid: 11, cwd: FIX, sessionId: 'own' }, { pid: 12, cwd: FIX, sessionId: 'b' }, { pid: 13, cwd: FIX, sessionId: 'a2' },
    { pid: 99, cwd: FIX, sessionId: 'editor' }, { pid: 14, cwd: '/somewhere/else', sessionId: 'other' },
  ];
  eq(sessionsAt(FIX, S, P).map((s) => s.sessionId), ['own', 'editor'], 'the folder\'s own desk has the sessions in no seat\'s window: its own window\'s and an editor\'s');
  eq(sessionsAt({ cwd: FIX, seat: 'seat-b/quinn' }, S, P).map((s) => s.sessionId), ['b'], 'a seat has the ones running in its window');
  eq(sessionsAt({ cwd: FIX, seat: 'seat-c/quinn' }, S, P).length, 0, 'and one with no window has none, whatever else runs in the folder');
  const wname = seatWindowName('/work/my.repo v2', seatTag('lab.one', 'qa.x'));
  assert(/^[A-Za-z0-9_-]+$/.test(wname), 'a seat\'s window name has no dot in it: it is named in a tmux target, where a dot is where the pane begins', wname);
  eq(seatEnv('/r/a', seatTag('seat-b', 'quinn'), '/s/f.json'), ['-e', `${SEAT_ENV}=/s/f.json`, '-e', 'ORCH_DESK_ROOT=/r/a', '-e', 'ORCH_CHANNEL=seat-b', '-e', 'ORCH_AGENT=quinn'],
    'a seat\'s window is given its binding file, its folder and its two names');

  rmDb(DB_PATH);
  fixture();
  server = spawn('node', ['src/server.js'], {
    env: { ...process.env, PORT: String(PORT), DB_PATH, ORCH_AUTH_TOKEN: KEY, ORCH_AUTH_MODE: 'enforce' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!(await waitHealthy())) throw new Error('server never became healthy');
  host = startHost();
  const up = await until(async () => ((await desk(SA, 'quinn'))?.hosted?.live ? true : null));
  assert(!!up, 'the host finds the folder\'s own desk');
  eq((await floor()).hosts.find((h) => h.name === 'Seat Mac')?.seats, true, 'and says it can seat a second desk in a folder');
  eq(panes().length, 0, 'no window is open yet');

  /* A seat's window is the first window of all: it opens the tmux session.
   * That is the case in which what it was given could leak, because
   * `new-session -e` writes the session's environment, which every later
   * window inherits. */
  console.log('\n  a new desk on another floor, in a folder that is already a desk');
  let r = await op('/api/floor/desk', { host_id: 'seats-host', path: REPO, channel: SB, agent: 'quinn', seat: true });
  eq([r.status, r.body.mode, r.body.agent], [200, 'seat', 'quinn'], 'the board takes New desk here');
  const onB = await until(async () => { const d = await desk(SB, 'quinn'); return d?.hosted?.live && d.hosted.held === 'floor' ? d : null; });
  assert(!!onB, 'the host seats it and opens its window', await desk(SB, 'quinn'));
  eq([onB?.hosted?.seat, onB?.hosted?.scope], [true, 'seat'], 'as a seat');
  const tag = seatTag(SB, 'quinn');
  const file = configPath(tag);
  let ps = panes();
  eq(ps.map((p) => p.seat), [tag], 'its window carries its tag');
  const s1 = starts()[0];
  eq([s1?.cwd, s1?.argv.slice(-2)], [REPO, ['--mcp-config', file]], 'it is started in the folder with a binding file of its own, last on the command line');
  eq(s1?.me && { channel: s1.me.channel, agent: s1.me.agent, url: s1.me.url, key: s1.me.key }, { channel: SB, agent: 'quinn', url: `${HOST}/mcp`, key: KEY }, 'and the file names the new desk on this board, with the host\'s key');
  eq(s1?.env, { ORCH_DESK_CONFIG: file, ORCH_DESK_ROOT: REPO, ORCH_CHANNEL: SB, ORCH_AGENT: 'quinn' }, 'the window is given the file, its folder and its names, for the plugin\'s hook');
  eq((statSync(file).mode & 0o777).toString(8), '600', 'the file holds the key, and only its owner can read it');
  assert(!ps[0].cmd.includes(KEY), 'the key is not in the command tmux keeps and prints for the pane', ps[0].cmd);
  const shown = tmux('show-environment', '-t', `${SESSION}:`);
  assert(!/ORCH_DESK_CONFIG|ORCH_DESK_ROOT|ORCH_CHANNEL|ORCH_AGENT/.test(shown), 'and none of what it was given is left in the session\'s environment, where the next window would inherit it', shown);
  const reg = JSON.parse(readFileSync(`${SEATS}/seats.json`, 'utf8')).seats;
  eq(reg, [{ channel: SB, agent: 'quinn', cwd: REPO, board: HOST }], 'the host keeps the seat on its own record');
  eq(existsSync(`${REPO}/.mcp.json`) && JSON.parse(readFileSync(`${REPO}/.mcp.json`, 'utf8')).mcpServers.orchestratinator.headers['X-Channel'], SA, 'and nothing in the folder is changed: its own binding is as it was');
  eq((await desk(SA, 'quinn'))?.hosted?.live, true, 'the folder\'s own desk is still there');
  eq((await desk(SA, 'quinn'))?.hosted?.held ?? null, null, 'with no window: the seat\'s window is not its window');

  console.log('\n  each desk answers as itself');
  let a = await ask(SB, 'quinn', 'who are you, on the other floor?');
  assert(/^I AM seat-b\/quinn on /.test(a.answer ?? ''), 'a message to the new desk is answered by the window that connected as it', a);
  a = await ask(SA, 'quinn', 'and who are you, at home?');
  assert(/^I AM seat-a\/quinn on /.test(a.answer ?? ''), 'a message to the folder\'s own desk opens its own window, which answers as the folder\'s desk', a);
  ps = panes();
  eq(ps.map((p) => p.seat ?? '').sort(), ['', tag].sort(), 'two windows in one folder now: one tagged, one not');
  const s2 = starts()[1];
  eq([s2?.argv.includes('--mcp-config'), s2?.env], [false, { ORCH_DESK_CONFIG: null, ORCH_DESK_ROOT: null, ORCH_CHANNEL: null, ORCH_AGENT: null }],
    'the folder\'s own window is started plain and inherits nothing of the seat\'s');
  const sidA = (await desk(SA, 'quinn'))?.hosted?.session_id;
  const sidB = (await desk(SB, 'quinn'))?.hosted?.session_id;
  assert(sidA && sidB && sidA !== sidB && sidA === s2.id && sidB === s1.id, 'each desk follows its own window\'s conversation', { sidA, sidB });
  const tA = await turns(SA, 'quinn');
  const tB = await turns(SB, 'quinn');
  assert(!tA.some((t) => /other floor/.test(t.text ?? '')) && !tB.some((t) => /at home/.test(t.text ?? '')), 'and neither desk has a word of the other\'s conversation');
  eq([(await desk(SA, 'quinn'))?.hosted?.held, (await desk(SB, 'quinn'))?.hosted?.held], ['floor', 'floor'], 'each is held by the floor, in its own window');

  console.log('\n  a second session on the same floor');
  r = await op('/api/floor/desk/twin', { channel: SA, agent: 'quinn' });
  eq([r.status, r.body.agent], [200, 'quinn-2'], 'the board names it');
  const two = await until(async () => { const d = await desk(SA, 'quinn-2'); return d?.hosted?.live && d.hosted.held === 'floor' ? d : null; });
  assert(!!two, 'and the host seats it beside the other two', await desk(SA, 'quinn-2'));
  eq(two?.twin, { of: 'quinn', n: 2, meeting: false }, 'as the agent\'s second session there');
  eq(panes().length, 3, 'three windows in the one folder');
  a = await ask(SA, 'quinn-2', 'and you, the second one?');
  assert(/^I AM seat-a\/quinn-2 on /.test(a.answer ?? ''), 'it answers under its own name', a);
  const sid2 = (await desk(SA, 'quinn-2'))?.hosted?.session_id;
  assert(sid2 && ![sidA, sidB].includes(sid2), 'on a conversation of its own');
  eq([(await desk(SA, 'quinn'))?.hosted?.session_id, (await desk(SB, 'quinn'))?.hosted?.session_id], [sidA, sidB], 'and the other two are on theirs, untouched');

  console.log('\n  the plugin\'s hook in a seat\'s window');
  const hook = (env, ev) => new Promise((done) => {
    const c = spawn(process.execPath, ['plugin/hooks/report.mjs'], { env: { PATH: process.env.PATH, HOME, ...env }, stdio: ['pipe', 'ignore', 'ignore'] });
    c.on('exit', done);
    c.stdin.end(JSON.stringify({ cwd: REPO, transcript_path: `${CLAUDE_HOME}/projects/${REPO.replace(/[^A-Za-z0-9]/g, '-')}/${ev.session_id}.jsonl`, ...ev }));
  });
  const asks = { hook_event_name: 'Notification', notification_type: 'permission_prompt', notification_message: 'Claude needs your permission' };
  await hook(s1.env, { session_id: sidB, ...asks });
  let q = await until(async () => { const f = await floor(); return f.queue.length ? f.queue : null; }, 6000);
  eq((q ?? []).map((x) => `${x.channel}/${x.agent}`), [`${SB}/quinn`], 'a prompt raised in the seat\'s window is the seat\'s: the hook reads the window\'s own binding, not the folder\'s');
  await hook(s1.env, { session_id: sidB, hook_event_name: 'Stop', last_assistant_message: 'ok' });
  await until(async () => ((await floor()).queue.length === 0 ? true : null), 6000);
  await hook({}, { session_id: sidA, ...asks });
  q = await until(async () => { const f = await floor(); return f.queue.length ? f.queue : null; }, 6000);
  eq((q ?? []).map((x) => `${x.channel}/${x.agent}`), [`${SA}/quinn`], 'and one raised in the folder\'s own window is the folder\'s desk\'s, as it always was');
  await hook({}, { session_id: sidA, hook_event_name: 'Stop', last_assistant_message: 'ok' });
  await until(async () => ((await floor()).queue.length === 0 ? true : null), 6000);
  await hook({ ORCH_DESK_CONFIG: `${SEATS}/gone.json`, ORCH_CHANNEL: SB, ORCH_AGENT: 'quinn' }, { session_id: sidB, ...asks });
  q = await until(async () => { const f = await floor(); return f.queue.length ? f.queue : null; }, 6000);
  eq((q ?? []).map((x) => `${x.channel}/${x.agent}`), [`${SB}/quinn`], 'with its file gone, the two names the window was given still say which desk it is');
  await hook(s1.env, { session_id: sidB, hook_event_name: 'Stop', last_assistant_message: 'ok' });

  console.log('\n  a host that restarts');
  const before = panes().map((p) => p.pid).sort();
  await stopHost(host);
  hostLog = '';
  host = startHost();
  const back = await until(async () => {
    const f = await floor();
    const ds = [deskOf(f, SA, 'quinn'), deskOf(f, SB, 'quinn'), deskOf(f, SA, 'quinn-2')];
    return ds.every((d) => d?.hosted?.live && d.hosted.held === 'floor') ? ds : null;
  }, 20000);
  assert(!!back, 'finds all three desks again, each holding its window');
  assert(/seat-b\/quinn\s+\S+\s+\(seat scope\)/.test(hostLog) && /seat-a\/quinn-2\s+\S+\s+\(seat scope\)/.test(hostLog), 'the seats come off its own record, and its startup lines say so', hostLog.split('\n').filter((l) => /scope\)/.test(l)));
  eq(panes().map((p) => p.pid).sort(), before, 'no window was closed or opened for it');
  eq((back ?? []).map((d) => d.hosted.session_id), [sidA, sidB, sid2], 'and each desk is on the conversation it was on');
  a = await ask(SB, 'quinn', 'still you, after the restart?');
  assert(/^I AM seat-b\/quinn on /.test(a.answer ?? '') && (a.answer ?? '').endsWith(sidB), 'a message still goes into the seat\'s own window, on its own conversation', a);
  eq(starts().length, 3, 'with no window started for it');

  console.log('\n  what a seat will not do');
  r = await op('/api/floor/handback', { channel: SB, agent: 'quinn' });
  eq([r.status, r.body.code], [409, 'seat_no_editor'], 'its conversation is not handed to an editor');
  r = await op('/api/floor/desk/move', { channel: SB, agent: 'quinn', to: 'elsewhere' });
  eq([r.status, r.body.code], [409, 'seat_no_move'], 'and it is not moved by rebinding a folder that is not its own');
  r = await op('/api/floor/desk/twin', { channel: SA, agent: 'quinn', session_id: sidA });
  const refusedOn = r.body.agent;
  const refusal = await until(async () => (await turns(SA, refusedOn)).find((t) => t.role === 'error') ?? null, 15000);
  assert(/open in the window of another desk in this folder/.test(refusal?.text ?? ''), 'a second session is not opened on a conversation another desk\'s window is running: one window holds a conversation', refusal);
  eq(panes().length, 3, 'so no fourth window was opened');
  eq(starts().length, 3, 'and nothing was started');
  await op('/api/floor/desk/leave', { channel: SA, agent: refusedOn });
  await until(async () => ((await desk(SA, refusedOn)) ? null : true), 10000);

  // A conversation that is gone from the folder: a seat starts a new one.
  // The folder's own desk falls back to the folder's newest conversation
  // (resumable() in host/window.js), and for a seat that is most likely the
  // one another desk's window is running.
  r = await op('/api/floor/desk/twin', { channel: SA, agent: 'quinn', session_id: 'no-such-conversation' });
  const lostOn = r.body.agent;
  const fresh = await until(async () => { const d = await desk(SA, lostOn); return d?.hosted?.live && d.hosted.held === 'floor' ? d : null; }, 20000);
  assert(!!fresh, 'a second session asked for on a conversation that is not in the folder still comes up', await desk(SA, lostOn));
  const sLost = starts().at(-1);
  eq([sLost?.me?.agent, sLost?.argv.includes('--resume')], [lostOn, false], 'on a new conversation: nothing is resumed');
  assert(fresh && ![sidA, sidB, sid2].includes(fresh.hosted.session_id), 'and never on the folder\'s newest, which is another desk\'s', fresh?.hosted?.session_id);
  const said = (await turns(SA, lostOn)).find((t) => t.role === 'context' && /starts a new conversation rather than take the folder's newest/.test(t.text ?? ''));
  assert(!!said, 'which the host says on the desk, in its own words', (await turns(SA, lostOn)).map((t) => `${t.role}: ${t.text}`));
  await op('/api/floor/desk/leave', { channel: SA, agent: lostOn });
  await until(async () => ((await desk(SA, lostOn)) ? null : true), 10000);
  const startedSoFar = starts().length;

  console.log('\n  leaving one of them');
  const pid2 = panes().find((p) => p.seat === seatTag(SA, 'quinn-2'))?.pid;
  r = await op('/api/floor/desk/leave', { channel: SA, agent: 'quinn-2' });
  eq(r.status, 200, 'the board takes the leave');
  const left = await until(async () => ((await desk(SA, 'quinn-2')) ? null : true), 10000);
  assert(!!left, 'the desk is gone from the floor');
  eq(panes().map((p) => p.seat ?? '').sort(), ['', tag].sort(), 'its window is closed, and only its window');
  assert(await until(() => (!alive(pid2) ? true : null), 5000), 'its process is gone');
  eq(JSON.parse(readFileSync(`${SEATS}/seats.json`, 'utf8')).seats.map((s) => `${s.channel}/${s.agent}`), [`${SB}/quinn`], 'its record is gone, and the other seat\'s is not');
  assert(!readdirSync(SEATS).some((f) => f.startsWith('seat-a_quinn-2')), 'and so is its binding file', readdirSync(SEATS));
  a = await ask(SA, 'quinn', 'home desk, still there?');
  assert(/^I AM seat-a\/quinn on /.test(a.answer ?? '') && (a.answer ?? '').endsWith(sidA), 'the folder\'s own desk carries on in its window', a);
  a = await ask(SB, 'quinn', 'other floor, still there?');
  assert(/^I AM seat-b\/quinn on /.test(a.answer ?? '') && (a.answer ?? '').endsWith(sidB), 'and so does the other floor\'s', a);

  // The folder's own desk never falls back onto a conversation one of its
  // seats is running (QA, PR #57 Info 7, Q3: the seat's half had a row and
  // this half had none). The seat spoke last, so its conversation is the
  // folder's newest; resumed here as well, two windows would write one
  // transcript.
  console.log('\n  the folder\'s own desk, asked back onto a conversation that is gone');
  const startsBefore = starts().length;
  r = await op('/api/floor/reopen', { channel: SA, agent: 'quinn', session_id: 'gone-from-the-folder' });
  eq(r.status, 200, 'the board takes the reopen');
  const fellBack = await until(() => (starts().length > startsBefore ? starts().at(-1) : null), 20000);
  eq([fellBack?.me && `${fellBack.me.channel}/${fellBack.me.agent}`, fellBack?.argv[0], fellBack?.argv[1]], [`${SA}/quinn`, '--resume', sidA],
    'its window resumes the newest conversation in the folder that no seat is running: its own, and not the seat\'s, which spoke last');
  const ownBack = await until(async () => { const d = await desk(SA, 'quinn'); return d?.hosted?.live && d.hosted.held === 'floor' && d.hosted.session_id === sidA ? d : null; }, 20000);
  assert(!!ownBack, 'and the desk is on it', (await desk(SA, 'quinn'))?.hosted);
  eq((await desk(SB, 'quinn'))?.hosted?.session_id, sidB, 'the seat is on its own, untouched');

  console.log('\n  a second session brought back on the conversation it had');
  r = await op('/api/floor/desk/twin', { channel: SA, agent: 'quinn', as: 'quinn-2', session_id: sid2, meeting: true });
  eq(r.body.agent, 'quinn-2', 'it is asked for by its old name');
  const again = await until(async () => { const d = await desk(SA, 'quinn-2'); return d?.hosted?.live && d.hosted.held === 'floor' && d.hosted.session_id === sid2 ? d : null; }, 20000);
  assert(!!again, 'and comes back on that conversation', await desk(SA, 'quinn-2'));
  const s4 = starts().at(-1);
  eq([s4?.argv[0], s4?.argv[1], s4?.argv.includes('--mcp-config'), s4?.me?.agent], ['--resume', sid2, true, 'quinn-2'], 'its window is started resuming it, as itself');
  a = await ask(SA, 'quinn-2', 'back again?');
  assert(/^I AM seat-a\/quinn-2 on /.test(a.answer ?? '') && (a.answer ?? '').endsWith(sid2), 'and answers in it', a);

  console.log('\n  the folder\'s own desk leaving, with a seat still in the folder');
  r = await op('/api/floor/desk/leave', { channel: SA, agent: 'quinn-2' });
  await until(async () => ((await desk(SA, 'quinn-2')) ? null : true), 10000);
  // The folder's own binding is its .mcp.json here; leaving takes it out.
  r = await op('/api/floor/desk/leave', { channel: SA, agent: 'quinn' });
  eq(r.status, 200, 'the folder\'s own desk can be left');
  const ownGone = await until(async () => ((await desk(SA, 'quinn'))?.hosted?.live ? null : true), 10000);
  assert(!!ownGone, 'and is no longer hosted');
  eq(panes().map((p) => p.seat), [tag], 'its window closes; the seat\'s stays');
  eq((await desk(SB, 'quinn'))?.hosted?.live, true, 'the seat is still a desk, in a folder that now names no desk of its own');
  a = await ask(SB, 'quinn', 'on your own now?');
  assert(/^I AM seat-b\/quinn on /.test(a.answer ?? ''), 'and still answers as itself', a);
  await hook(s1.env, { session_id: sidB, ...asks });
  q = await until(async () => { const f = await floor(); return f.queue.length ? f.queue : null; }, 6000);
  eq((q ?? []).map((x) => `${x.channel}/${x.agent}`), [`${SB}/quinn`], 'its hook still reports, from the window\'s own file, though the folder binds nothing');

  // A bind onto a name one of the folder's seats carries (QA, PR #57
  // finding 3, and Q2: no row reached this branch of bind() at all). The
  // seat gives the name up to the folder's own binding, which closes its
  // window, so never mid-turn. The board refuses from the desk's last turn
  // (test:floor); here the last turn is a reply and the pane says working.
  console.log('\n  the folder bound to a name one of its seats carries');
  await hook(s1.env, { session_id: sidB, hook_event_name: 'Stop', last_assistant_message: 'ok' });
  await until(async () => ((await floor()).queue.length === 0 ? true : null), 6000);
  a = await ask(SB, 'quinn', 'look busy');
  assert(/^I AM seat-b\/quinn on /.test(a.answer ?? ''), 'the seat is mid-turn, by its pane', a);
  const seatPid = panes().find((p) => p.seat === tag)?.pid;
  const unbound = await until(async () => {
    const f = (await json('/api/floor/folders').then((x) => x.json())).hosts.find((h) => h.host_id === 'seats-host')?.folders.find((x) => x.path === REPO);
    return f && !f.bound ? true : null;
  }, 70000);
  assert(!!unbound, 'the board has the folder as naming no desk of its own');
  r = await op('/api/floor/desk', { host_id: 'seats-host', path: REPO, channel: SB, agent: 'quinn' });
  eq([r.status, r.body.mode], [200, 'take'], 'the board takes the folder for the seat\'s name: by its last turn the seat is idle');
  const no = await until(async () => (await turns(SB, 'quinn')).find((t) => t.role === 'error' && /still working/.test(t.text ?? '')) ?? null, 20000);
  assert(/^not bound to seat-b\/quinn — quinn already has a desk on seat-b in this folder, and its window is still working: esc to interrupt$/.test(no?.text ?? ''), 'the host refuses it, quoting the pane, on the desk that is there', no?.text ?? (await turns(SB, 'quinn')).slice(-3));
  eq([panes().map((p) => p.seat), alive(seatPid)], [[tag], true], 'the seat\'s window is left open');
  eq(JSON.parse(readFileSync(`${SEATS}/seats.json`, 'utf8')).seats.map((x) => `${x.channel}/${x.agent}`), [`${SB}/quinn`], 'and it is still a seat');
  eq((await desk(SB, 'quinn'))?.hosted?.scope, 'seat', 'nothing was bound');
  a = await ask(SB, 'quinn', 'look idle');
  assert(/^I AM seat-b\/quinn on /.test(a.answer ?? ''), 'its turn ends', a);
  r = await op('/api/floor/desk', { host_id: 'seats-host', path: REPO, channel: SB, agent: 'quinn' });
  eq(r.status, 200, 'asked again');
  const own = await until(async () => { const d = await desk(SB, 'quinn'); return d?.hosted?.live && d.hosted.scope === 'local' ? d : null; }, 30000);
  assert(!!own, 'the folder is bound to the name, as the folder\'s own desk', (await desk(SB, 'quinn'))?.hosted);
  eq(own?.hosted?.seat, false, 'which is no seat');
  eq(JSON.parse(readFileSync(`${SEATS}/seats.json`, 'utf8')).seats, [], 'the seat gave the name up: its record is gone');
  assert(await until(() => (!alive(seatPid) ? true : null), 8000), 'and its window was closed');
  eq(panes().filter((p) => p.seat).length, 0, 'no window carries a seat\'s tag now');
  a = await ask(SB, 'quinn', 'who are you now?');
  assert(/^I AM seat-b\/quinn on /.test(a.answer ?? ''), 'a message is answered under the name', a);
  eq(starts().at(-1)?.argv.includes('--mcp-config'), false, 'by the folder\'s own window, started plain: the folder\'s entry is what it connects with');

  console.log('\n  what the run leaves behind');
  await stopHost(host);
  killTmux();
  await until(() => (standIns().length === 0 ? true : null), 8000);
  eq(standIns().length, 0, 'a run leaves no stand-in running');
} catch (err) {
  failures++;
  console.error(`\n  ✗ ${err.stack ?? err}`);
  console.error(hostLog.split('\n').slice(-40).join('\n'));
} finally {
  tidy();
}

console.log(failures ? `\nseats: ${failures} failed` : '\nseats: all passed');
process.exit(failures ? 1 : 0);

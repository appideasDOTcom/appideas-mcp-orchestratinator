// End-to-end test for one agent with several sessions: a real host against a
// real server, with several desks in ONE folder, each with a Claude Code of
// its own that the host runs as a child and talks to as stream-JSON
// (host/agent.js, host/desk.js; costmo's ruling of 2026-11-22 replaced the
// window layer, and with it the tmux windows this suite used to drive).
//
// The host suite cannot hold this. Its stand-in is one desk at a time. Here
// the stand-in is what Claude Code is when several run in a folder: each
// process announces itself in a session file of its own
// (~/.claude/sessions/<pid>.json, the roster's fast path, written while it
// runs, `kind: interactive`, `entrypoint: sdk-cli`, as 2.1.330 was measured
// to write it: docs/stream-json-spike.md), writes a transcript of its own,
// and connects as the desk its binding names: the `--mcp-config` file it was
// started with, or else the folder's own entry. It answers every message
// with "I AM <channel>/<agent> on <conversation>", which is what lets an
// assertion say which desk a process is rather than only that bytes reached
// it. It speaks the protocol the way test/agent.mjs's stand-in does: no
// `init` until the first message, one per turn; a message echoed with its
// uuid and `isReplay` when taken; a message taken mid-turn folded into that
// turn's one `result`; a permission as `control_request can_use_tool`. And
// `--resume` of a conversation with nothing in it ends the process on its
// first line, as Claude Code does ("No conversation found…").
//
// What it cannot say is what Claude Code itself does with `--mcp-config`
// beside a folder's binding. That was measured on a real window and is
// recorded in host/seats.js; this suite is the host's and the board's half.
//   npm run test:seats
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

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
const STARTS = `${FIX}/starts.log`;
// Where this suite's host keeps its seats and reads Claude Code's files, so
// the paths asked of host/seats.js and host/claude.js here are the host's.
process.env.ORCH_HOST_SEATS = SEATS;
process.env.ORCH_CLAUDE_HOME = CLAUDE_HOME;
const { seatTag, configPath } = await import('../host/seats.js');
const { cwdOf, seatOf, resumable, transcriptPath, canonical } = await import('../host/claude.js');
const { agentArgs } = await import('../host/agent.js');

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

/** Every process the stand-in was started as, oldest first. */
const starts = () => (existsSync(STARTS) ? readFileSync(STARTS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const startsOf = (agent) => starts().filter((s) => s.me?.agent === agent);
const flag = (s, f) => { const i = s?.argv?.indexOf(f) ?? -1; return i >= 0 ? s.argv[i + 1] : null; };
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
/** The roster's entries in a folder, as the stand-ins wrote them, live ones only. */
const rosterIn = (dir) => {
  const out = [];
  const sdir = `${CLAUDE_HOME}/sessions`;
  let names = [];
  try { names = execFileSync('ls', [sdir], { encoding: 'utf8' }).split('\n').filter((n) => /^\d+\.json$/.test(n)); } catch { return out; }
  for (const n of names) {
    try { const d = JSON.parse(readFileSync(`${sdir}/${n}`, 'utf8')); if (d.cwd === dir && alive(d.pid)) out.push(d); } catch { /* mid-write or gone */ }
  }
  return out;
};
const seatsOnRecord = () => JSON.parse(readFileSync(`${SEATS}/seats.json`, 'utf8')).seats;

function fixture() {
  mkdirSync(REPO, { recursive: true });
  mkdirSync(OTHER, { recursive: true });
  mkdirSync(`${CLAUDE_HOME}/sessions`, { recursive: true });
  // Claude Code's own config file, which every real machine has. Without it
  // the host's local scope reads as unreadable, and a host concludes nothing
  // from that (Host.boundAt), so this suite never ran the check that read
  // every seat as a released folder (0.14.4, issue: a second meeting room's
  // sessions refused every message and could not be left).
  writeFileSync(`${HOME}/.claude.json`, `${JSON.stringify({ projects: {} }, null, 2)}\n`);
  const bind = (dir, channel, agent) => writeFileSync(`${dir}/.mcp.json`, JSON.stringify({
    mcpServers: { orchestratinator: { type: 'http', url: `${HOST}/mcp`, headers: { 'X-Channel': channel, 'X-Agent': agent, 'X-Orchestratinator-Key': KEY } } },
  }, null, 2));
  bind(REPO, SA, 'quinn');
  bind(OTHER, SA, 'rae');
  // Started the way the host starts Claude Code: through the person's shell,
  // `exec "$0" "$@"`, so the pid the host holds is the stand-in's own.
  writeFileSync(`${FIX}/claude`, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(`${FIX}/claude.cjs`)} "$@"\n`);
  chmodSync(`${FIX}/claude`, 0o755);
  // The stand-in. Everything it needs to find is a constant: the host gives
  // a desk's Claude Code a person's environment and none of its own ORCH_
  // settings (windowEnv), so ORCH_CLAUDE_HOME does not reach it.
  writeFileSync(`${FIX}/claude.cjs`, [
    `const fs = require('fs'); const path = require('path'); const { randomUUID } = require('crypto');`,
    `const CLAUDE_HOME = ${JSON.stringify(CLAUDE_HOME)};`,
    `const HOME = ${JSON.stringify(HOME)};`,
    `const STARTS = ${JSON.stringify(STARTS)};`,
    `const argv = process.argv.slice(2);`,
    `if (argv[0] === 'agents') { process.stdout.write('[]'); process.exit(0); }`,
    `if (argv[0] === '--version') { process.stdout.write('2.1.330 (Claude Code)\\n'); process.exit(0); }`,
    // The host asks Claude Code whether it is signed in at every heartbeat
    // (host/auth.js). Signed in, as 2.1.329 answers it.
    `if (argv[0] === 'auth') { process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) + '\\n'); process.exit(0); }`,
    // \`claude mcp add|remove -s local\`, as the host suite's stand-in does it.
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
    `const resume = flag('--resume');`,
    `const id = resume || randomUUID();`,
    // Which desk this process is: its own binding file when it was started
    // with one, as Claude Code does (measured; host/seats.js), else the
    // folder's local-scope entry, else its .mcp.json.
    `const entry = (servers) => { const s = Object.values(servers || {})[0]; return s ? { channel: s.headers['X-Channel'], agent: s.headers['X-Agent'], url: s.url, key: s.headers['X-Orchestratinator-Key'] || null } : null; };`,
    `const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };`,
    `const me = cfgFile ? entry(read(cfgFile)?.mcpServers) : (entry(read(path.join(HOME, '.claude.json'))?.projects?.[cwd]?.mcpServers) || entry(read(path.join(cwd, '.mcp.json'))?.mcpServers));`,
    `const env = {}; for (const k of ['ORCH_DESK_CONFIG', 'ORCH_DESK_ROOT', 'ORCH_CHANNEL', 'ORCH_AGENT']) env[k] = process.env[k] ?? null;`,
    `const dir = path.join(CLAUDE_HOME, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));`,
    `const transcript = path.join(dir, id + '.jsonl');`,
    // \`--resume\` of a conversation nobody has spoken in ends the process on
    // its first line, as Claude Code does.
    `const spoken = () => { try { return fs.readFileSync(transcript, 'utf8').split('\\n').some((l) => /"type":"(user|assistant)"/.test(l)); } catch { return false; } };`,
    `if (resume && !spoken()) {`,
    `  fs.appendFileSync(STARTS, JSON.stringify({ pid: process.pid, cwd, argv, id, me, env, refused: true }) + '\\n');`,
    `  process.stderr.write('No conversation found with session ID: ' + resume + '\\n'); process.exit(1);`,
    `}`,
    `fs.appendFileSync(STARTS, JSON.stringify({ pid: process.pid, cwd, argv, id, me, env }) + '\\n');`,
    `const sdir = path.join(CLAUDE_HOME, 'sessions'); fs.mkdirSync(sdir, { recursive: true });`,
    `const sfile = path.join(sdir, process.pid + '.json');`,
    `fs.writeFileSync(sfile, JSON.stringify({ pid: process.pid, sessionId: id, cwd, kind: 'interactive', entrypoint: 'sdk-cli', startedAt: Date.now() }));`,
    `const leave = (code) => { try { fs.unlinkSync(sfile); } catch {} process.exit(code); };`,
    `process.on('SIGTERM', () => leave(143)); process.on('SIGHUP', () => leave(129));`,
    `const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');`,
    `const rec = (o) => { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(transcript, JSON.stringify(o) + '\\n'); };`,
    `let n = 0; let inTurn = false; let reqs = 0; const waits = new Map();`,
    `const who = 'I AM ' + (me ? me.channel + '/' + me.agent : 'nobody') + ' on ' + id;`,
    `const said = (text, reply) => {`,
    `  const k = ++n;`,
    `  rec({ type: 'user', uuid: 'u' + process.pid + '-' + k, timestamp: new Date().toISOString(), message: { role: 'user', content: text } });`,
    `  rec({ type: 'assistant', uuid: 'a' + process.pid + '-' + k, timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: reply } ] } });`,
    `  out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });`,
    `};`,
    // completed for each message of the turn comes after its result (2.1.330, measured).
    `const taken = [];`,
    `const result = (text) => { inTurn = false; out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: id }); for (const u of taken.splice(0)) out({ type: 'command_lifecycle', command_uuid: u, state: 'completed' }); };`,
    `const ask = (request) => new Promise((res) => { const rid = 'cu-' + process.pid + '-' + (++reqs); waits.set(rid, res); out({ type: 'control_request', request_id: rid, request }); });`,
    `require('readline').createInterface({ input: process.stdin }).on('line', async (line) => {`,
    `  let r; try { r = JSON.parse(line); } catch { return; }`,
    `  if (r.type === 'control_response') { const w = waits.get(r.response?.request_id); if (w) { waits.delete(r.response.request_id); w(r.response.response); } return; }`,
    `  if (r.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: r.request_id, response: {} } }); return; }`,
    `  if (r.type !== 'user') return;`,
    `  const text = typeof r.message?.content === 'string' ? r.message.content : '';`,
    // Taken into a turn already running: echoed when taken, answered in that
    // turn's one result. "look idle" is what ends a turn "look busy" left open.
    `  out({ type: 'command_lifecycle', command_uuid: r.uuid, state: 'queued' });`,
    `  taken.push(r.uuid);`,
    `  if (inTurn) { out({ type: 'user', uuid: r.uuid, isReplay: true, message: { role: 'user', content: text } }); said(text, who); if (/look idle/.test(text)) result(who); return; }`,
    `  inTurn = true;`,
    `  out({ type: 'system', subtype: 'init', session_id: id, model: 'claude-haiku-5-5', permissionMode: 'default', claude_code_version: '2.1.330' });`,
    `  out({ type: 'user', uuid: r.uuid, isReplay: true, message: { role: 'user', content: text } });`,
    `  if (text.startsWith('PERMIT ')) {`,
    `    const tool = text.slice(7);`,
    `    const a = await ask({ subtype: 'can_use_tool', tool_name: tool, display_name: tool, input: { command: 'ls' }, description: 'List files' });`,
    `    const reply = who + ': ' + (a?.behavior === 'allow' ? 'ALLOWED' : 'DENIED');`,
    `    said(text, reply); result(reply); return;`,
    `  }`,
    // A process mid-turn, as the host reads one: taken, answered in its
    // transcript, and no result yet. Its last turn is a reply, so the board
    // takes it for idle, which is the case the host's own check is for.
    `  said(text, who);`,
    `  if (/look busy/.test(text)) return;`,
    `  result(who);`,
    `});`,
    `process.stdin.on('end', () => leave(0));`,
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
      ORCH_HOST_CLAUDE: `${FIX}/claude`,
      ORCH_HOST_WATCH_MS: '300', ORCH_HOST_CONFIG: '/nonexistent/host.json', ORCH_HOST_SEATS: SEATS,
      ORCH_TAKEN_TIMEOUT_MS: '8000', ORCH_STOP_GRACE_MS: '2000',
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
  await Promise.race([done, sleep(8000)]);
};

const STAND_IN = `${FIX}/claude.cjs`;
const standIns = () => {
  let out = '';
  try { out = execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' }); } catch { return []; }
  return out.split('\n').map((l) => l.trim().split(/\s+/)).filter(([, exe, script]) => /(^|\/)node$/.test(exe ?? '') && script === STAND_IN).map(([pid]) => Number(pid));
};
const sweep = () => { for (const p of standIns()) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } } };

let server = null;
let host = null;
let editor = null;
const tidy = () => {
  try { server?.kill(); } catch { /* gone */ }
  try { host?.kill('SIGKILL'); } catch { /* gone */ }
  try { editor?.kill('SIGKILL'); } catch { /* gone */ }
  sweep();
  rmDb(DB_PATH);
  rmSync(FIX, { recursive: true, force: true });
};
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { tidy(); console.log(`\nseats: interrupted by ${sig}; its server, host and stand-ins are gone`); process.exit(130); });
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
const ON = (channel, agent) => new RegExp(`^I AM ${channel}/${agent} on `);

try {
  console.log('seats');
  console.log('\n  which desk, said without a process');
  eq([cwdOf('/r/a'), seatOf('/r/a'), cwdOf({ cwd: '/r/a', seat: 'x/y' }), seatOf({ cwd: '/r/a', seat: 'x/y' }), seatOf({ cwd: '/r/a' })], ['/r/a', null, '/r/a', 'x/y', null],
    'a desk is asked for by its folder, or by its folder and its seat');
  eq(seatTag('lab/one', 'q|a'), 'lab%2Fone/q%7Ca', 'a seat\'s tag holds neither a separator nor a second slash');
  const args = agentArgs({ resume: 'S1', mcpConfig: '/s/f.json' });
  eq(args.slice(-4), ['--resume', 'S1', '--mcp-config', '/s/f.json'], 'a seat\'s Claude Code is started with its own binding file, after the resume');

  rmDb(DB_PATH);
  fixture();

  // resumable(), against this suite's own folder: a seat asked for a
  // conversation nobody has spoken in starts a new one, never the folder's
  // newest; the folder's own desk falls back to the newest no seat runs.
  {
    const pdir = `${CLAUDE_HOME}/projects/${canonical(REPO).replace(/[^A-Za-z0-9]/g, '-')}`;
    mkdirSync(pdir, { recursive: true });
    const line = (type, at) => JSON.stringify({ type, uuid: `${type}-${at}`, timestamp: at, message: { role: type, content: type === 'user' ? 'hi' : [{ type: 'text', text: 'hello' }] } });
    writeFileSync(`${pdir}/unit-old.jsonl`, `${line('user', '2026-09-01T10:00:00Z')}\n${line('assistant', '2026-09-01T10:00:01Z')}\n`);
    writeFileSync(`${pdir}/unit-new.jsonl`, `${line('user', '2026-09-02T10:00:00Z')}\n${line('assistant', '2026-09-02T10:00:01Z')}\n`);
    const seatPick = await resumable({ cwd: REPO, seat: seatTag(SB, 'quinn') }, 'unit-missing');
    eq(seatPick.id, null, 'resumable: a seat asked for a conversation that is not there gets none');
    assert(/starts a new conversation rather than take the folder's newest/.test(seatPick.note ?? ''), 'and is told it starts a new one rather than take the folder\'s newest', seatPick.note);
    eq((await resumable(REPO, 'unit-missing')).id, 'unit-new', 'the folder\'s own desk falls back to the newest in the folder');
    // A seat's process running unit-new: the folder's own desk skips it.
    const fake = spawn('sleep', ['30'], { stdio: 'ignore' });
    writeFileSync(`${CLAUDE_HOME}/sessions/${fake.pid}.json`, JSON.stringify({ pid: fake.pid, sessionId: 'unit-new', cwd: canonical(REPO), kind: 'interactive', entrypoint: 'sdk-cli', startedAt: Date.now() }));
    eq((await resumable(REPO, 'unit-missing', { seatPids: new Set([fake.pid]) })).id, 'unit-old', 'and never onto one a seat\'s process is running');
    eq((await resumable(REPO, 'unit-missing', { seatPids: new Set() })).id, 'unit-new', 'which only the host\'s own seat pids say: anybody else\'s process is not a seat');
    fake.kill('SIGKILL');
    try { unlinkSync(`${CLAUDE_HOME}/sessions/${fake.pid}.json`); } catch { /* gone */ }
    rmSync(`${pdir}/unit-old.jsonl`); rmSync(`${pdir}/unit-new.jsonl`);
  }

  server = spawn('node', ['src/server.js'], {
    env: { ...process.env, PORT: String(PORT), DB_PATH, ORCH_AUTH_TOKEN: KEY, ORCH_AUTH_MODE: 'enforce' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!(await waitHealthy())) throw new Error('server never became healthy');
  host = startHost();
  const up = await until(async () => ((await desk(SA, 'quinn'))?.hosted?.live ? true : null));
  assert(!!up, 'the host finds the folder\'s own desk');
  eq((await floor()).hosts.find((h) => h.name === 'Seat Mac')?.seats, true, 'and says it can seat a second desk in a folder');
  eq(starts().length, 0, 'no Claude Code is started yet');

  console.log('\n  a new desk on another floor, in a folder that is already a desk');
  let r = await op('/api/floor/desk', { host_id: 'seats-host', path: REPO, channel: SB, agent: 'quinn', seat: true });
  eq([r.status, r.body.mode, r.body.agent], [200, 'seat', 'quinn'], 'the board takes New desk here');
  const onB = await until(async () => { const d = await desk(SB, 'quinn'); return d?.hosted?.live && d.hosted.held === 'floor' ? d : null; });
  assert(!!onB, 'the host seats it and starts its Claude Code', await desk(SB, 'quinn'));
  eq([onB?.hosted?.seat, onB?.hosted?.scope], [true, 'seat'], 'as a seat');
  const tag = seatTag(SB, 'quinn');
  const file = configPath(tag);
  const s1 = await until(() => starts()[0] ?? null, 10000);
  eq([starts().length, s1?.cwd, flag(s1, '--mcp-config'), flag(s1, '--resume')], [1, canonical(REPO), file, null], 'one process, in the folder, with a binding file of its own and nothing resumed');
  assert(s1?.argv.includes('--input-format') && s1.argv.includes('stream-json') && s1.argv.includes('--permission-prompt-tool'), 'spoken to as stream-JSON, permissions over its input', s1?.argv);
  eq(s1?.me && { channel: s1.me.channel, agent: s1.me.agent, url: s1.me.url, key: s1.me.key }, { channel: SB, agent: 'quinn', url: `${HOST}/mcp`, key: KEY }, 'and the file names the new desk on this board, with the host\'s key');
  eq(s1?.env, { ORCH_DESK_CONFIG: file, ORCH_DESK_ROOT: canonical(REPO), ORCH_CHANNEL: SB, ORCH_AGENT: 'quinn' }, 'the process is given the file, its folder and its names, for the plugin\'s hook');
  eq((statSync(file).mode & 0o777).toString(8), '600', 'the file holds the key, and only its owner can read it');
  assert(!s1?.argv.includes(KEY), 'the key is not on the command line', s1?.argv);
  eq(seatsOnRecord(), [{ channel: SB, agent: 'quinn', cwd: canonical(REPO), board: HOST }], 'the host keeps the seat on its own record');
  eq(existsSync(`${REPO}/.mcp.json`) && JSON.parse(readFileSync(`${REPO}/.mcp.json`, 'utf8')).mcpServers.orchestratinator.headers['X-Channel'], SA, 'and nothing in the folder is changed: its own binding is as it was');
  eq((await desk(SA, 'quinn'))?.hosted?.live, true, 'the folder\'s own desk is still there');
  eq((await desk(SA, 'quinn'))?.hosted?.held ?? null, null, 'with no process: the seat\'s is not its');
  // An effort set before the desk's Claude Code has named its model (no
  // message yet, so no init) is set for the conversation and said as not
  // saved: the default is kept per model, and the model is not known.
  {
    const before = existsSync(`${HOME}/.claude/settings.json`) ? readFileSync(`${HOME}/.claude/settings.json`, 'utf8') : null;
    const er = await op('/api/floor/chat', { channel: SB, agent: 'quinn', text: '/effort high' });
    eq(er.status, 200, 'an /effort before the first message is taken');
    const line = await until(async () => (await turns(SB, 'quinn')).find((t) => t.tool_name === 'host' && /^\/effort high — /.test(t.text ?? '')) ?? null, 10000);
    assert(!!line && /for this conversation; not saved as your default/.test(line.text) && !/and saved as your default/.test(line.text), 'and said as set for this conversation, not saved as the default, with no model known to save it under', line?.text);
    eq(existsSync(`${HOME}/.claude/settings.json`) ? readFileSync(`${HOME}/.claude/settings.json`, 'utf8') : null, before, 'and Claude Code\'s settings are untouched');
  }

  console.log('\n  each desk answers as itself');
  let a = await ask(SB, 'quinn', 'who are you, on the other floor?');
  assert(ON(SB, 'quinn').test(a.answer ?? ''), 'a message to the new desk is answered by the process that connected as it', a);
  const sidB = (await until(async () => (await desk(SB, 'quinn'))?.hosted?.session_id ?? null));
  eq(sidB, s1?.id, 'the seat is on the conversation its process named at its first message');
  // The seat's process is in the folder, in the roster, and is not anybody
  // else in it (Host.watch): the folder's own desk does not follow it.
  await sleep(1200);
  // The board names a desk with no conversation by a placeholder of its own
  // (host:<host>:<channel>:<agent>); what matters is that it is not the seat's.
  const homeNow = (await desk(SA, 'quinn'))?.hosted;
  eq([homeNow?.session_id === sidB, homeNow?.held ?? null], [false, null],
    'the folder\'s own desk does not take up the seat\'s conversation, though the seat\'s process runs in its folder');
  a = await ask(SA, 'quinn', 'and who are you, at home?');
  assert(ON(SA, 'quinn').test(a.answer ?? ''), 'a message to the folder\'s own desk starts its own process, which answers as the folder\'s desk', a);
  const s2 = starts()[1];
  eq([starts().length, flag(s2, '--mcp-config'), s2?.env], [2, null, { ORCH_DESK_CONFIG: null, ORCH_DESK_ROOT: null, ORCH_CHANNEL: null, ORCH_AGENT: null }],
    'the folder\'s own process is started plain and inherits nothing of the seat\'s');
  eq(rosterIn(canonical(REPO)).map((x) => x.pid).sort(), [s1.pid, s2.pid].sort(), 'two Claude Codes in one folder now, each in the roster');
  const sidA = (await desk(SA, 'quinn'))?.hosted?.session_id;
  assert(sidA && sidA !== sidB && sidA === s2.id, 'each desk follows its own process\'s conversation', { sidA, sidB });
  const tA = await turns(SA, 'quinn');
  const tB = await turns(SB, 'quinn');
  assert(!tA.some((t) => /other floor/.test(t.text ?? '')) && !tB.some((t) => /at home/.test(t.text ?? '')), 'and neither desk has a word of the other\'s conversation');
  eq([(await desk(SA, 'quinn'))?.hosted?.held, (await desk(SB, 'quinn'))?.hosted?.held], ['floor', 'floor'], 'each is held by the floor, in its own process');

  console.log('\n  a second session on the same floor');
  r = await op('/api/floor/desk/twin', { channel: SA, agent: 'quinn' });
  eq([r.status, r.body.agent], [200, 'quinn-2'], 'the board names it');
  const two = await until(async () => { const d = await desk(SA, 'quinn-2'); return d?.hosted?.live && d.hosted.held === 'floor' ? d : null; });
  assert(!!two, 'and the host seats it beside the other two', await desk(SA, 'quinn-2'));
  eq(two?.twin, { of: 'quinn', n: 2, meeting: false }, 'as the agent\'s second session there');
  eq(await until(() => (starts().length >= 3 ? starts().length : null), 10000), 3, 'three processes in the one folder');
  a = await ask(SA, 'quinn-2', 'and you, the second one?');
  assert(ON(SA, 'quinn-2').test(a.answer ?? ''), 'it answers under its own name', a);
  const sid2 = (await desk(SA, 'quinn-2'))?.hosted?.session_id;
  assert(sid2 && ![sidA, sidB].includes(sid2), 'on a conversation of its own');
  eq([(await desk(SA, 'quinn'))?.hosted?.session_id, (await desk(SB, 'quinn'))?.hosted?.session_id], [sidA, sidB], 'and the other two are on theirs, untouched');

  console.log('\n  the plugin\'s hook in a seat\'s process');
  const hook = (env, ev) => new Promise((done) => {
    const c = spawn(process.execPath, ['plugin/hooks/report.mjs'], { env: { PATH: process.env.PATH, HOME, ...env }, stdio: ['pipe', 'ignore', 'ignore'] });
    c.on('exit', done);
    c.stdin.end(JSON.stringify({ cwd: REPO, transcript_path: transcriptPath(canonical(REPO), ev.session_id), ...ev }));
  });
  let q;
  const asks = { hook_event_name: 'Notification', notification_type: 'permission_prompt', notification_message: 'Claude needs your permission' };
  await hook(s1.env, { session_id: sidB, ...asks });
  q = await until(async () => { const f = await floor(); return f.queue.length ? f.queue : null; }, 6000);
  eq((q ?? []).map((x) => `${x.channel}/${x.agent}`), [`${SB}/quinn`], 'a prompt raised in the seat\'s process is the seat\'s: the hook reads the process\'s own binding, not the folder\'s');
  await hook(s1.env, { session_id: sidB, hook_event_name: 'Stop', last_assistant_message: 'ok' });
  await until(async () => ((await floor()).queue.length === 0 ? true : null), 6000);
  await hook({}, { session_id: sidA, ...asks });
  q = await until(async () => { const f = await floor(); return f.queue.length ? f.queue : null; }, 6000);
  eq((q ?? []).map((x) => `${x.channel}/${x.agent}`), [`${SA}/quinn`], 'and one raised in the folder\'s own process is the folder\'s desk\'s, as it always was');
  await hook({}, { session_id: sidA, hook_event_name: 'Stop', last_assistant_message: 'ok' });
  await until(async () => ((await floor()).queue.length === 0 ? true : null), 6000);
  await hook({ ORCH_DESK_CONFIG: `${SEATS}/gone.json`, ORCH_CHANNEL: SB, ORCH_AGENT: 'quinn' }, { session_id: sidB, ...asks });
  q = await until(async () => { const f = await floor(); return f.queue.length ? f.queue : null; }, 6000);
  eq((q ?? []).map((x) => `${x.channel}/${x.agent}`), [`${SB}/quinn`], 'with its file gone, the two names the process was given still say which desk it is');
  await hook(s1.env, { session_id: sidB, hook_event_name: 'Stop', last_assistant_message: 'ok' });
  await until(async () => ((await floor()).queue.length === 0 ? true : null), 6000);

  console.log('\n  a permission asked in a seat\'s process');
  r = await op('/api/floor/chat', { channel: SB, agent: 'quinn', text: 'PERMIT Bash' });
  eq(r.status, 200, 'the board takes the message');
  q = await until(async () => { const f = await floor(); return f.queue.length ? f.queue : null; }, 10000);
  eq((q ?? []).map((x) => `${x.channel}/${x.agent}`), [`${SB}/quinn`], 'what the seat\'s process asks is the seat\'s, and nobody else\'s in the folder');
  r = await op('/api/floor/permission', { channel: SB, agent: 'quinn', request_id: q?.[0]?.request_id, decision: 'allow' });
  eq(r.status, 200, 'and is answered there');
  const allowed = await until(async () => (await turns(SB, 'quinn')).find((t) => t.role === 'assistant' && /ALLOWED$/.test(t.text ?? '')) ?? null, 10000);
  assert(/^I AM seat-b\/quinn on /.test(allowed?.text ?? ''), 'by the seat\'s own process', allowed?.text);
  await until(async () => ((await floor()).queue.length === 0 ? true : null), 6000);
  // The turn's end, as the plugin reports it. Without it the board reads a
  // permission_prompt notification inside ANSWER_ECHO_MS of an answer as
  // that prompt's echo and drops it, and the hook row further down (which
  // runs a few seconds later once nothing here waits on a timeout) read [].
  await hook(s1.env, { session_id: sidB, hook_event_name: 'Stop', last_assistant_message: allowed?.text ?? 'ok' });

  console.log('\n  a host that restarts');
  const runningBefore = starts().map((s) => s.pid);
  await stopHost(host);
  const ended = await until(() => (runningBefore.every((p) => !alive(p)) ? true : null), 10000);
  assert(!!ended, 'its desks\' Claude Codes end with it: each is its child, and the conversation is on disk');
  eq(rosterIn(canonical(REPO)).length, 0, 'and none is left in the roster');
  hostLog = '';
  host = startHost();
  const back = await until(async () => {
    const f = await floor();
    const ds = [deskOf(f, SA, 'quinn'), deskOf(f, SB, 'quinn'), deskOf(f, SA, 'quinn-2')];
    return ds.every((d) => d?.hosted?.live) ? ds : null;
  }, 20000);
  assert(!!back, 'finds all three desks again');
  assert(/seat-b\/quinn\s+\S+\s+\(seat scope\)/.test(hostLog) && /seat-a\/quinn-2\s+\S+\s+\(seat scope\)/.test(hostLog), 'the seats come off its own record, and its startup lines say so', hostLog.split('\n').filter((l) => /scope\)/.test(l)));
  eq((back ?? []).map((d) => d.hosted.session_id), [sidA, sidB, sid2], 'each desk is on the conversation it was on');
  eq(starts().length, 3, 'with nothing started for it: a desk\'s Claude Code starts at its next message');

  a = await ask(SB, 'quinn', 'still you, after the restart?');
  assert(ON(SB, 'quinn').test(a.answer ?? '') && (a.answer ?? '').endsWith(sidB), 'a message to the seat resumes its own conversation, as itself', a);
  const sBack = starts().at(-1);
  eq([flag(sBack, '--resume'), flag(sBack, '--mcp-config'), sBack?.me?.agent], [sidB, file, 'quinn'], 'its process is started resuming it, with its own binding');
  a = await ask(SA, 'quinn', 'home again, after the restart?');
  assert(ON(SA, 'quinn').test(a.answer ?? '') && (a.answer ?? '').endsWith(sidA), 'and the folder\'s own desk resumes its own', a);
  a = await ask(SA, 'quinn-2', 'and the second one, after the restart?');
  assert(ON(SA, 'quinn-2').test(a.answer ?? '') && (a.answer ?? '').endsWith(sid2), 'and so does the second session', a);
  eq(starts().length, 6, 'one process started for each');

  console.log('\n  what a seat will not do');
  r = await op('/api/floor/handback', { channel: SB, agent: 'quinn' });
  eq([r.status, r.body.code], [409, 'seat_no_editor'], 'its conversation is not handed to an editor');
  r = await op('/api/floor/desk/move', { channel: SB, agent: 'quinn', to: 'elsewhere' });
  eq([r.status, r.body.code], [409, 'seat_no_move'], 'and it is not moved by rebinding a folder that is not its own');
  r = await op('/api/floor/desk/twin', { channel: SA, agent: 'quinn', session_id: sidA });
  const refusedOn = r.body.agent;
  const refusal = await until(async () => (await turns(SA, refusedOn)).find((t) => t.role === 'error') ?? null, 15000);
  assert(new RegExp(`open in another Claude Code \\(pid ${rosterIn(canonical(REPO)).find((x) => x.sessionId === sidA)?.pid}\\)`).test(refusal?.text ?? ''), 'a second session is not opened on a conversation another desk\'s process is running: one process holds a conversation', refusal);
  eq(starts().length, 6, 'so nothing was started');
  await op('/api/floor/desk/leave', { channel: SA, agent: refusedOn });
  await until(async () => ((await desk(SA, refusedOn)) ? null : true), 10000);

  // A conversation that is gone from the folder: a seat starts a new one.
  // The folder's own desk falls back to the folder's newest conversation
  // (resumable() in host/claude.js), and for a seat that is most likely the
  // one another desk's process is running.
  const before2 = starts().length;
  r = await op('/api/floor/desk/twin', { channel: SA, agent: 'quinn', session_id: 'no-such-conversation' });
  const lostOn = r.body.agent;
  const fresh = await until(async () => { const d = await desk(SA, lostOn); return d?.hosted?.live && d.hosted.held === 'floor' ? d : null; }, 20000);
  assert(!!fresh, 'a second session asked for on a conversation that is not in the folder still comes up', await desk(SA, lostOn));
  // The host says the desk is held as soon as it has spawned the process;
  // the stand-in writes its start a moment later.
  const sLost = (await until(() => (starts().length > before2 ? starts().slice(before2) : null), 10000)) ?? [];
  eq(sLost.map((s) => [s.me?.agent, flag(s, '--resume'), !!s.refused]), [[lostOn, null, false]], 'on a new conversation: nothing is resumed');
  a = await ask(SA, lostOn, 'are you new?');
  assert(ON(SA, lostOn).test(a.answer ?? '') && ![sidA, sidB, sid2].some((x) => (a.answer ?? '').endsWith(x)), 'and never on the folder\'s newest, which is another desk\'s', a);
  const said = (await turns(SA, lostOn)).find((t) => t.role === 'context' && /starts a new conversation rather than take the folder's newest/.test(t.text ?? ''));
  assert(!!said, 'which the host says on the desk, in its own words', (await turns(SA, lostOn)).map((t) => `${t.role}: ${t.text}`));
  await op('/api/floor/desk/leave', { channel: SA, agent: lostOn });
  await until(async () => ((await desk(SA, lostOn)) ? null : true), 10000);

  console.log('\n  leaving one of them');
  const pid2 = startsOf('quinn-2').at(-1)?.pid;
  assert(alive(pid2), 'the second session\'s process is running', pid2);
  r = await op('/api/floor/desk/leave', { channel: SA, agent: 'quinn-2' });
  eq(r.status, 200, 'the board takes the leave');
  const left = await until(async () => ((await desk(SA, 'quinn-2')) ? null : true), 10000);
  assert(!!left, 'the desk is gone from the floor');
  assert(await until(() => (!alive(pid2) ? true : null), 8000), 'its process is gone');
  eq(rosterIn(canonical(REPO)).map((x) => x.pid).sort(), [startsOf('quinn').filter((s) => s.me.channel === SA).at(-1)?.pid, sBack.pid].sort(), 'and only its: the other two run on');
  eq(seatsOnRecord().map((s) => `${s.channel}/${s.agent}`), [`${SB}/quinn`], 'its record is gone, and the other seat\'s is not');
  eq(existsSync(configPath(seatTag(SA, 'quinn-2'))), false, 'and so is its binding file');
  eq(existsSync(file), true, 'the other seat\'s file is still there');
  a = await ask(SA, 'quinn', 'home desk, still there?');
  assert(ON(SA, 'quinn').test(a.answer ?? '') && (a.answer ?? '').endsWith(sidA), 'the folder\'s own desk carries on in its process', a);
  a = await ask(SB, 'quinn', 'other floor, still there?');
  assert(ON(SB, 'quinn').test(a.answer ?? '') && (a.answer ?? '').endsWith(sidB), 'and so does the other floor\'s', a);

  // The folder's own desk never falls back onto a conversation one of its
  // seats is running (QA, PR #57 Info 7, Q3). The seat spoke last, so its
  // conversation is the folder's newest; resumed here as well, two processes
  // would write one transcript.
  console.log('\n  the folder\'s own desk, asked back onto a conversation that is gone');
  const startsBefore = starts().length;
  r = await op('/api/floor/reopen', { channel: SA, agent: 'quinn', session_id: 'gone-from-the-folder' });
  eq(r.status, 200, 'the board takes the reopen');
  const fellBack = await until(() => (starts().length > startsBefore ? starts().slice(startsBefore) : null), 20000);
  await sleep(500);
  eq(starts().slice(startsBefore).map((s) => [s.me && `${s.me.channel}/${s.me.agent}`, flag(s, '--resume'), !!s.refused]), [[`${SA}/quinn`, sidA, false]],
    'its process resumes the newest conversation in the folder that no seat is running: its own, and not the seat\'s, which spoke last');
  void fellBack;
  const ownBack = await until(async () => { const d = await desk(SA, 'quinn'); return d?.hosted?.live && d.hosted.held === 'floor' && d.hosted.session_id === sidA ? d : null; }, 20000);
  assert(!!ownBack, 'and the desk is on it', (await desk(SA, 'quinn'))?.hosted);
  eq((await desk(SB, 'quinn'))?.hosted?.session_id, sidB, 'the seat is on its own, untouched');

  console.log('\n  a second session brought back on the conversation it had');
  const q2Before = startsOf('quinn-2').length;
  r = await op('/api/floor/desk/twin', { channel: SA, agent: 'quinn', as: 'quinn-2', session_id: sid2, meeting: true });
  eq(r.body.agent, 'quinn-2', 'it is asked for by its old name');
  const again = await until(async () => { const d = await desk(SA, 'quinn-2'); return d?.hosted?.live && d.hosted.held === 'floor' && d.hosted.session_id === sid2 ? d : null; }, 20000);
  assert(!!again, 'and comes back on that conversation', await desk(SA, 'quinn-2'));
  const s4 = await until(() => (startsOf('quinn-2').length > q2Before ? startsOf('quinn-2').at(-1) : null), 10000);
  eq([flag(s4, '--resume'), flag(s4, '--mcp-config'), s4?.me?.agent], [sid2, configPath(seatTag(SA, 'quinn-2')), 'quinn-2'], 'its process is started resuming it, as itself');
  a = await ask(SA, 'quinn-2', 'back again?');
  assert(ON(SA, 'quinn-2').test(a.answer ?? '') && (a.answer ?? '').endsWith(sid2), 'and answers in it', a);

  console.log('\n  the folder\'s own desk leaving, with a seat still in the folder');
  r = await op('/api/floor/desk/leave', { channel: SA, agent: 'quinn-2' });
  await until(async () => ((await desk(SA, 'quinn-2')) ? null : true), 10000);
  const ownPid = (await desk(SA, 'quinn'))?.hosted?.held === 'floor' ? startsOf('quinn').filter((s) => s.me.channel === SA && !s.refused).at(-1)?.pid : null;
  // The folder's own binding is its .mcp.json here; leaving takes it out.
  r = await op('/api/floor/desk/leave', { channel: SA, agent: 'quinn' });
  eq(r.status, 200, 'the folder\'s own desk can be left');
  const ownGone = await until(async () => ((await desk(SA, 'quinn'))?.hosted?.live ? null : true), 10000);
  assert(!!ownGone, 'and is no longer hosted');
  assert(await until(() => (!alive(ownPid) ? true : null), 8000), 'its process ends; the seat\'s runs on', ownPid);
  assert(alive(sBack.pid), 'the seat\'s process is still running', sBack.pid);
  eq((await desk(SB, 'quinn'))?.hosted?.live, true, 'the seat is still a desk, in a folder that now names no desk of its own');
  a = await ask(SB, 'quinn', 'on your own now?');
  assert(ON(SB, 'quinn').test(a.answer ?? ''), 'and still answers as itself', a);
  await hook(s1.env, { session_id: sidB, ...asks });
  q = await until(async () => { const f = await floor(); return f.queue.length ? f.queue : null; }, 6000);
  eq((q ?? []).map((x) => `${x.channel}/${x.agent}`), [`${SB}/quinn`], 'its hook still reports, from the process\'s own file, though the folder binds nothing');

  // A bind onto a name one of the folder's seats carries (QA, PR #57
  // finding 3, and Q2). The seat gives the name up to the folder's own
  // binding, which ends its process, so never mid-turn. The board reads the
  // turn from the host (each turn's start and end, said from the process),
  // so it refuses before anything reaches the host, even with a reply as
  // the desk's last turn.
  console.log('\n  the folder bound to a name one of its seats carries');
  await hook(s1.env, { session_id: sidB, hook_event_name: 'Stop', last_assistant_message: 'ok' });
  await until(async () => ((await floor()).queue.length === 0 ? true : null), 6000);
  a = await ask(SB, 'quinn', 'look busy');
  assert(ON(SB, 'quinn').test(a.answer ?? ''), 'the seat\'s process answers and stays in its turn', a);
  const seatPid = sBack.pid;
  const unbound = await until(async () => {
    const f = (await json('/api/floor/folders').then((x) => x.json())).hosts.find((h) => h.host_id === 'seats-host')?.folders.find((x) => x.path === canonical(REPO));
    return f && !f.bound ? true : null;
  }, 70000);
  assert(!!unbound, 'the board has the folder as naming no desk of its own');
  r = await op('/api/floor/desk', { host_id: 'seats-host', path: REPO, channel: SB, agent: 'quinn' });
  eq(r.status, 409, 'the board refuses the folder for the seat\'s name: the host said the seat\'s turn is running');
  eq(alive(seatPid), true, 'the seat\'s process is left running');
  eq(seatsOnRecord().map((x) => `${x.channel}/${x.agent}`), [`${SB}/quinn`], 'and it is still a seat');
  eq((await desk(SB, 'quinn'))?.hosted?.scope, 'seat', 'nothing was bound');
  a = await ask(SB, 'quinn', 'look idle');
  assert(ON(SB, 'quinn').test(a.answer ?? ''), 'its turn ends', a);
  r = await op('/api/floor/desk', { host_id: 'seats-host', path: REPO, channel: SB, agent: 'quinn' });
  eq(r.status, 200, 'asked again');
  const own = await until(async () => { const d = await desk(SB, 'quinn'); return d?.hosted?.live && d.hosted.scope === 'local' ? d : null; }, 30000);
  assert(!!own, 'the folder is bound to the name, as the folder\'s own desk', (await desk(SB, 'quinn'))?.hosted);
  eq(own?.hosted?.seat, false, 'which is no seat');
  eq(seatsOnRecord(), [], 'the seat gave the name up: its record is gone');
  eq(existsSync(file), false, 'and its binding file');
  assert(await until(() => (!alive(seatPid) ? true : null), 8000), 'and its process was ended');
  a = await ask(SB, 'quinn', 'who are you now?');
  assert(ON(SB, 'quinn').test(a.answer ?? ''), 'a message is answered under the name', a);
  const sOwn = starts().at(-1);
  eq([flag(sOwn, '--mcp-config'), sOwn?.env?.ORCH_DESK_CONFIG ?? null], [null, null], 'by the folder\'s own process, started plain: the folder\'s entry is what it connects with');

  // Somebody else's Claude Code in the folder (an editor tab, a terminal),
  // on the folder's own conversation. It loads the folder's binding, so it
  // is the folder's own desk's (CLAUDE.md, "One agent, several sessions": a
  // seat's sessions are the ones in its own process, the folder's own desk
  // has the rest, an editor's included). A seat with no process running must
  // not take its conversation up: it would show another desk's words, and
  // its next message would resume a conversation somebody else holds. Last,
  // because the seat is asked to have no process, which only a host restart
  // gives, and a fault here would otherwise cascade through every row after.
  console.log('\n  somebody else\'s Claude Code in the folder');
  const SC = 'seat-c';
  r = await op('/api/floor/desk', { host_id: 'seats-host', path: REPO, channel: SC, agent: 'quinn', seat: true });
  eq([r.status, r.body.mode], [200, 'seat'], 'a new seat in the folder, beside the folder\'s own desk');
  await until(async () => { const d = await desk(SC, 'quinn'); return d?.hosted?.live && d.hosted.held === 'floor' ? d : null; });
  a = await ask(SC, 'quinn', 'who are you, third floor?');
  assert(ON(SC, 'quinn').test(a.answer ?? ''), 'it answers as itself', a);
  const sidC = (await desk(SC, 'quinn'))?.hosted?.session_id;
  const sidOwn = (await desk(SB, 'quinn'))?.hosted?.session_id;
  assert(sidC && sidOwn && sidC !== sidOwn, 'each on its own conversation', { sidC, sidOwn });
  await stopHost(host);
  hostLog = '';
  host = startHost();
  await until(async () => { const f = await floor(); return [deskOf(f, SB, 'quinn'), deskOf(f, SC, 'quinn')].every((d) => d?.hosted?.live && !d.hosted.held) ? true : null; }, 20000);
  const startsNow = starts().length;
  editor = spawn('sleep', ['60'], { stdio: 'ignore' });
  writeFileSync(`${CLAUDE_HOME}/sessions/${editor.pid}.json`, JSON.stringify({ pid: editor.pid, sessionId: sidOwn, cwd: canonical(REPO), kind: 'interactive', entrypoint: 'claude-vscode', startedAt: Date.now() }));
  const seen = await until(async () => ((await desk(SB, 'quinn'))?.hosted?.held === 'editor' ? true : null), 8000);
  assert(!!seen, 'an editor in the folder on the folder\'s conversation is seen by the folder\'s own desk', (await desk(SB, 'quinn'))?.hosted);
  await sleep(1500);
  const foreign = (await turns(SC, 'quinn')).filter((t) => /who are you now\?|on your own now\?|look busy/.test(t.text ?? ''));
  eq(foreign.map((t) => t.text), [], 'and not by the seat, which has no process running: none of that conversation reaches the seat\'s floor');
  editor.kill('SIGKILL');
  try { unlinkSync(`${CLAUDE_HOME}/sessions/${editor.pid}.json`); } catch { /* gone */ }
  editor = null;
  await until(async () => ((await desk(SB, 'quinn'))?.hosted?.held ? null : true), 8000);
  a = await ask(SC, 'quinn', 'still yourself?');
  assert(ON(SC, 'quinn').test(a.answer ?? '') && (a.answer ?? '').endsWith(sidC), 'the seat\'s next message resumes its own conversation, not the editor\'s', a);
  eq(starts().slice(startsNow).map((s) => [s.me?.channel, flag(s, '--resume'), !!s.refused]), [[SC, sidC, false]], 'one process started for it, on its own');

  console.log('\n  what the run leaves behind');
  await stopHost(host);
  await until(() => (standIns().length === 0 ? true : null), 8000);
  eq(standIns().length, 0, 'a run leaves no stand-in running');
} catch (err) {
  failures++;
  console.error(`\n  ✗ ${err.stack ?? err}`);
  console.error(hostLog.split('\n').slice(-40).join('\n'));
} finally {
  if (failures) console.error(`\n--- host log (last 60 lines) ---\n${hostLog.split('\n').slice(-60).join('\n')}`);
  tidy();
}

console.log(failures ? `\nseats: ${failures} failed` : '\nseats: all passed');
process.exit(failures ? 1 : 0);

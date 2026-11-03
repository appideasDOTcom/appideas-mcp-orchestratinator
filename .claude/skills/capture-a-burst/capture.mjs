#!/usr/bin/env node
/**
 * Keep the evidence of a host→board failure burst before it is gone (issue #5
 * step 3, task 257). Runs on its own, as a LaunchAgent (install.sh), and only
 * ever reads what it watches.
 *
 * Why it has to run before anyone looks: every deploy recreates the board's
 * container and `docker logs` starts again at that moment, and Docker
 * Desktop keeps three rotations of each log — about 25–33 minutes of
 * host/monitor.log, 30–40 of vm/init.log, 7½–10 hours of
 * com.docker.backend.log (measured 2026-11-03). A burst found the next morning
 * has nothing left to be lined up against.
 *
 * What it does:
 *   - tails the host log (read-only; it never opens it for writing) and counts
 *     failure lines — the run loop's `…; retrying in Ns`, `events not
 *     delivered (…)`, `unregister not delivered (…)`;
 *   - OPENS a capture at OPEN_COUNT of them within OPEN_WINDOW_MS. 5 in 10
 *     minutes, because a deploy's swap writes one (measured 20:41:25Z) and
 *     even a 15-second outage writes at most four (the 1+2+4+8 s backoff),
 *     while the fault writes one about every 13 s at the 1 s step;
 *   - while open, every SNAPSHOT_MS: the board's log for the window (each
 *     container's under its own id, so a redeploy mid-burst loses nothing)
 *     and Docker Desktop's logs filtered to the window, merged into what is
 *     already saved — a rotation every ~8 minutes cannot take a line that a
 *     snapshot already holds; every PROBE_MS: /health from this machine
 *     (through Docker's forwarder), `_ping` on the Docker socket (into the
 *     VM), and /health from inside the container (no forwarder);
 *   - CLOSES CLOSE_QUIET_MS after the last failure: a last snapshot, the
 *     machine's sleep/wake lines from `pmset -g log` for the window, and a
 *     summary of readings — counts and the slow moments, no conclusions;
 *   - then POSTS that summary, once, as a message to everyone on this repo's
 *     channel (costmo's ruling, task 261), queued on disk and retried until
 *     the board takes it — a board down at the close loses nothing, and the
 *     close never waits on it.
 *
 * Each capture is a directory under CAPTURE_DIR named for its first failure.
 * Its own log goes to stdout (capture.log under launchd); state.json beside
 * the captures says it is alive and what it is watching.
 *
 * Every path, threshold and source is an environment variable, so the staged
 * proof runs this same file against a private board (SKILL.md).
 */
import { openSync, readSync, fstatSync, closeSync, statSync, readdirSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const env = process.env;
const H = homedir();
const num = (k, d) => Number(env[k] ?? d);
const C = {
  hostLog: env.CAPTURE_HOST_LOG ?? join(H, '.orchestratinator/log/host.log'),
  dir: env.CAPTURE_DIR ?? join(H, '.orchestratinator/captures'),
  container: env.CAPTURE_CONTAINER ?? 'appideas-orchestratinator',
  boardFile: env.CAPTURE_BOARD_FILE ?? '',
  healthUrl: env.CAPTURE_HEALTH_URL ?? 'http://localhost:8787/health',
  dockerSock: env.CAPTURE_DOCKER_SOCK ?? join(H, '.docker/run/docker.sock'),
  dockerLogs: env.CAPTURE_DOCKER_LOGS ?? join(H, 'Library/Containers/com.docker.docker/Data/log'),
  // Ruled in by QA (task 257, #2817): read-only, and only while a capture is open.
  inside: env.CAPTURE_INSIDE !== '0',
  openCount: num('CAPTURE_OPEN_COUNT', 5),
  openWindow: num('CAPTURE_OPEN_WINDOW_MS', 10 * 60_000),
  closeQuiet: num('CAPTURE_CLOSE_QUIET_MS', 10 * 60_000),
  before: num('CAPTURE_BEFORE_MS', 10 * 60_000),
  tick: num('CAPTURE_TICK_MS', 1000),
  probeEvery: num('CAPTURE_PROBE_MS', 2000),
  snapshotEvery: num('CAPTURE_SNAPSHOT_MS', 60_000),
  probeTimeout: num('CAPTURE_PROBE_TIMEOUT_MS', 15_000),
  // The alert a closed capture posts (task 261). Where to: this repo's own
  // binding by default — its channel, its board, the board's one key — read
  // when the alert is sent, the way the host reads a desk's binding every
  // heartbeat. The three CAPTURE_POST_* overrides are for the staged rig.
  post: env.CAPTURE_POST !== '0',
  postFrom: env.CAPTURE_POST_FROM ?? join(dirname(fileURLToPath(import.meta.url)), '../../..'),
  postUrl: env.CAPTURE_POST_URL ?? null,
  postKey: env.CAPTURE_POST_KEY ?? null,
  postChannel: env.CAPTURE_POST_CHANNEL ?? null,
  postAs: env.CAPTURE_POST_AS ?? 'capture',
  postRetry: num('CAPTURE_POST_RETRY_MS', 60_000),
};
// The Docker Desktop logs worth having, and how each one dates its lines.
const DOCKER_SOURCES = ['host/com.docker.backend.log', 'host/monitor.log', 'vm/init.log', 'vm/console.log'];

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const say = (...a) => console.log(`[capture] ${iso()}`, ...a);
const FAILURE = /; retrying in \d+s$|\bevents not delivered \(|\bunregister not delivered \(/;
const HOST_TS = /^\[host\] (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z) /;

/** The time a Docker Desktop line carries: a leading [ISO Z] (backend,
 *  monitor, console) or a JSON "time" (vm/init.log). Fractions past the
 *  millisecond are dropped; an offset is honoured. */
export function dockerTime(line) {
  let m = /^\[(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?Z\]/.exec(line);
  if (m) return Date.parse(`${m[1]}${(m[2] ?? '.000').slice(0, 4).padEnd(4, '0')}Z`);
  m = /"time":"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?(Z|[+-]\d\d:\d\d)"/.exec(line);
  if (m) return Date.parse(`${m[1]}${(m[2] ?? '.000').slice(0, 4).padEnd(4, '0')}${m[3]}`);
  return null;
}

/* ───────────── the host log, followed by offset ───────────── */

let offset = 0;
let carry = '';
const ring = []; // { ts, line } — enough of the recent past to start a capture before its trigger
const failures = []; // times of recent failure lines
let open = null; // the capture being written, if one is

function readNew() {
  let fd;
  try { fd = openSync(C.hostLog, 'r'); } catch (err) { return { lines: [], error: err.message }; }
  try {
    const size = fstatSync(fd).size;
    if (size < offset) { say(`${C.hostLog} is shorter than before (${size} < ${offset}); reading it from the start`); offset = 0; carry = ''; }
    if (size === offset) return { lines: [] };
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    offset = size;
    const text = carry + buf.toString('utf8');
    const parts = text.split('\n');
    carry = parts.pop();
    return { lines: parts };
  } finally { closeSync(fd); }
}

/** On start, the last stretch of the file is read for the ring, so a burst
 *  already under way opens a capture at once and keeps its beginning. */
function primeFromTail() {
  let fd;
  try { fd = openSync(C.hostLog, 'r'); } catch { return []; }
  try {
    const size = fstatSync(fd).size;
    const from = Math.max(0, size - 512 * 1024);
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    offset = size;
    const lines = buf.toString('utf8').split('\n');
    if (from > 0) lines.shift(); // a partial first line
    carry = lines.pop() ?? '';
    return lines;
  } finally { closeSync(fd); }
}

/**
 * One host-log line. A line read live without a time (a host from before
 * issue #5) is dated now. A line read from the tail at startup is counted only
 * if it carries its own time and falls inside the window: the live file's
 * tail holds thousands of untimed failures from before 0.10.11, and dated
 * "now" they would open a capture of nothing the moment this started.
 */
function take(line, primed = false) {
  const m = HOST_TS.exec(line);
  if (primed && !m) return;
  const ts = m ? Date.parse(m[1]) : Date.now();
  if (primed && ts < Date.now() - C.before - C.openWindow) return;
  ring.push({ ts, line });
  const keep = Date.now() - C.before - C.openWindow;
  while (ring.length && ring[0].ts < keep) ring.shift();
  if (open) appendFileSync(join(open.dir, 'host.log'), `${line}\n`);
  if (!FAILURE.test(line)) return;
  if (primed && ts < Date.now() - C.openWindow) return;
  failures.push(ts);
  while (failures.length && failures[0] < ts - C.openWindow) failures.shift();
  if (open) { open.lastFailure = ts; open.failures++; return; }
  if (failures.length >= C.openCount) openCapture(failures[0]);
}

/* ───────────── a capture ───────────── */

function openCapture(firstFailure) {
  const start = firstFailure - C.before;
  const dir = join(C.dir, iso(firstFailure).replace(/:/g, '-'));
  mkdirSync(dir, { recursive: true });
  const prior = ring.filter((r) => r.ts >= start).map((r) => r.line);
  writeFileSync(join(dir, 'host.log'), prior.length ? `${prior.join('\n')}\n` : '');
  open = { dir, start, firstFailure, lastFailure: failures[failures.length - 1], failures: failures.length, docker: new Map(), probesPending: {}, probeN: 0, lastSnapshot: 0, lastProbe: 0 };
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ opened_at: iso(), window_start: iso(start), first_failure: iso(firstFailure), trigger: `${failures.length} failure lines within ${C.openWindow / 1000}s`, config: C }, null, 2));
  say(`opened ${dir} — ${failures.length} failure lines since ${iso(firstFailure)}`);
  open.lastSnapshot = 0; // the first snapshot goes on the next tick, beside it
}

async function closeCapture() {
  const c = open;
  await snapshot();
  const end = Date.now();
  const sleeps = await pmsetWindow(c.start, end);
  writeFileSync(join(c.dir, 'pmset.log'), sleeps);
  writeFileSync(join(c.dir, 'summary.txt'), summarise(c, end, sleeps));
  const meta = JSON.parse(readFileSync(join(c.dir, 'meta.json'), 'utf8'));
  writeFileSync(join(c.dir, 'meta.json'), JSON.stringify({ ...meta, closed_at: iso(end), window_end: iso(end), last_failure: iso(c.lastFailure), failure_lines: c.failures }, null, 2));
  say(`closed ${c.dir} — ${c.failures} failure lines, ${iso(c.firstFailure)} → ${iso(c.lastFailure)}`);
  // The alert is queued on disk and sent beside the loop: a board that is
  // down when this closes gets it on a later tick, and nothing here waits.
  if (C.post) writeFileSync(join(c.dir, 'alert.json'), JSON.stringify({ state: 'pending', queued_at: iso(), attempts: 0 }, null, 2));
  open = null;
  failures.length = 0;
}

const run = (cmd, args, timeout = 30_000) => new Promise((done) => {
  execFile(cmd, args, { timeout, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => done({ err, stdout: stdout ?? '', stderr: stderr ?? '' }));
});

async function snapshot() {
  const c = open;
  if (!c) return;
  c.lastSnapshot = Date.now();
  // The board's log. Under Docker, per container: a deploy mid-burst starts
  // a new one, and the old one's log goes with it unless it is already here.
  if (C.container) {
    const id = (await run('docker', ['inspect', '-f', '{{.Id}}', C.container])).stdout.trim().slice(0, 12);
    if (id) {
      // The container's stdout and stderr arrive on two streams; each line
      // carries docker's own time (-t), so they are put back in its order.
      const r = await run('docker', ['logs', '-t', '--since', iso(c.start), C.container]);
      const rows = `${r.stdout}${r.stdout && !r.stdout.endsWith('\n') ? '\n' : ''}${r.stderr}`.split('\n').filter(Boolean).sort();
      if (rows.length) writeFileSync(join(c.dir, `board-${id}.log`), `${rows.join('\n')}\n`);
    }
  } else if (C.boardFile) {
    try { writeFileSync(join(c.dir, 'board.log'), readFileSync(C.boardFile)); } catch (err) { say(`board log: ${err.message}`); }
  }
  // Docker Desktop's, the current file and its dated rotations, cut to the
  // window and merged with what earlier snapshots kept.
  for (const src of DOCKER_SOURCES) {
    const base = join(C.dockerLogs, src);
    let files = [];
    try { files = readdirSync(dirname(base)).filter((f) => f === basename(base) || f.startsWith(`${basename(base)}.20`)).map((f) => join(dirname(base), f)); } catch { continue; }
    const kept = c.docker.get(src) ?? new Map();
    for (const f of files) {
      let st;
      try { st = statSync(f); } catch { continue; }
      if (st.mtimeMs < c.start) continue;
      let last = null;
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        const t = dockerTime(line);
        if (t != null) last = t;
        if (last != null && last >= c.start && line) kept.set(line, t ?? last);
      }
    }
    c.docker.set(src, kept);
    const rows = [...kept].sort((a, b) => a[1] - b[1]).map(([l]) => l);
    writeFileSync(join(c.dir, `docker-${src.replace('/', '-')}`), rows.length ? `${rows.join('\n')}\n` : '');
  }
}

async function pmsetWindow(from, to) {
  const r = await run('pmset', ['-g', 'log'], 60_000);
  const out = [];
  for (const line of r.stdout.split('\n')) {
    // The event is the column after the time; matched there, because the
    // assertion lines name things like Chrome's "Video Wake Lock".
    const m = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) ([+-]\d{4}) (Sleep|Wake|DarkWake)\s/.exec(line);
    if (!m) continue;
    const t = Date.parse(`${m[1].replace(' ', 'T')}${m[2].slice(0, 3)}:${m[2].slice(3)}`);
    if (t >= from && t <= to) out.push(line);
  }
  return out.length ? `${out.join('\n')}\n` : '';
}

/* ───────────── the probes, while a capture is open ───────────── */

function probe(name, fn) {
  const c = open;
  if (c.probesPending[name]) {
    appendFileSync(join(c.dir, 'probes.log'), `${iso()} ${name} skipped — the one from ${iso(c.probesPending[name])} is still waiting\n`);
    return;
  }
  const t0 = Date.now();
  c.probesPending[name] = t0;
  fn().then((what) => what, (err) => `error ${err?.cause?.code ?? err?.name ?? ''} ${err?.message ?? err}`.trim()).then((what) => {
    delete c.probesPending[name];
    if (open === c) appendFileSync(join(c.dir, 'probes.log'), `${iso(t0)} ${name} ${Date.now() - t0}ms ${what}\n`);
  });
}

export const health = async () => { const r = await fetch(C.healthUrl, { signal: AbortSignal.timeout(C.probeTimeout) }); await r.text(); return `${r.status}`; };
export const dockerPing = () => new Promise((done, fail) => {
  const req = request({ socketPath: C.dockerSock, path: '/_ping', method: 'GET', timeout: C.probeTimeout }, (res) => { res.resume(); res.on('end', () => done(`${res.statusCode}`)); });
  req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { name: 'TimeoutError' })));
  req.on('error', fail);
  req.end();
});
const INSIDE = "fetch('http://127.0.0.1:8787/health').then(r=>r.text()).then(()=>process.stdout.write('ok'),e=>{process.stdout.write('error '+e.message);process.exit(1)})";
export const inside = async () => {
  const r = await run('docker', ['exec', C.container, 'node', '-e', INSIDE], C.probeTimeout + 5000);
  return r.err ? `error ${(r.stdout + r.stderr).trim() || r.err.message}` : r.stdout.trim();
};

/* ───────────── the summary: readings, no conclusions ───────────── */

export function summarise(c, end, sleeps) {
  const lines = [];
  const read = (f) => { try { return readFileSync(join(c.dir, f), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  const host = read('host.log');
  const fails = host.filter((l) => FAILURE.test(l));
  lines.push(`window ${iso(c.start)} → ${iso(end)}; ${fails.length} failure lines, first ${iso(c.firstFailure)}, last ${iso(c.lastFailure)}`);
  const by = new Map();
  let overLimit = [];
  for (const l of fails) {
    const m = /\/api\/host\/[a-z]+[^ ]* (refused \(\w+\)|timed out|failed \([^:)]+|→ \d+)/.exec(l);
    // Counted, never quoted: a failure line that is not a board request is
    // the run loop's warn on some other error, and its words can be anything.
    const k = m ? `${m[0].replace(/\?[^ ]*/, '').split(' ')[0]} ${m[1]}` : 'another run-loop failure (not a board request; its words are not copied here)';
    by.set(k, (by.get(k) ?? 0) + 1);
    const w = /after (\d+)ms \(limit (\d+)ms\)/.exec(l);
    if (w && Number(w[1]) > Number(w[2]) + 1000) overLimit.push(`${HOST_TS.exec(l)?.[1] ?? '?'} ${m ? m[0].replace(/\?[^ ]*/, '').split(' ')[0] : '?'} waited ${w[1]}ms, limit ${w[2]}ms`);
  }
  lines.push('host failures by route and outcome:');
  for (const [k, n] of [...by].sort((a, b) => b[1] - a[1])) lines.push(`  ${String(n).padStart(5)}  ${k}`);
  lines.push(`timeouts that waited more than 1 s past their limit: ${overLimit.length}`);
  for (const l of overLimit.slice(0, 10)) lines.push(`  ${l}`);
  const probes = read('probes.log');
  for (const name of ['outside', 'docker-ping', 'inside']) {
    const rows = probes.filter((l) => l.split(' ')[1] === name);
    if (!rows.length) continue;
    const ms = rows.map((l) => Number(/ (\d+)ms /.exec(l)?.[1] ?? NaN)).filter((n) => !Number.isNaN(n));
    const slow = rows.filter((l) => Number(/ (\d+)ms /.exec(l)?.[1] ?? 0) > 1000 || / error /.test(l) || / skipped /.test(l));
    lines.push(`probe ${name}: ${rows.length} runs, max ${Math.max(0, ...ms)}ms, over 1 s or failed or skipped: ${slow.length}`);
    for (const l of slow.slice(0, 15)) lines.push(`  ${l}`);
  }
  for (const f of readdirSync(c.dir).filter((f) => /^board/.test(f))) {
    const rows = read(f);
    const marked = rows.filter((l) => /event loop held|\bslow (GET|POST|PUT|DELETE)\b/.test(l));
    lines.push(`${f}: ${rows.length} lines, ${marked.length} loop-hold or slow-request lines`);
    for (const l of marked.slice(0, 15)) lines.push(`  ${l}`);
  }
  for (const src of DOCKER_SOURCES) {
    const rows = read(`docker-${src.replace('/', '-')}`);
    // :8787, the port — a bare 8787 also turns up inside Docker's hex ids.
    const marked = rows.filter((l) => /:8787\b|gvisor\b.*(stopped|started|accept)|healthcheck failed|exposer\.(Add|Remove)/.test(l));
    lines.push(`docker ${src}: ${rows.length} lines in the window, ${marked.length} about 8787, the forwarder or a failed healthcheck`);
    for (const l of marked.slice(0, 12)) lines.push(`  ${l.slice(0, 240)}`);
    if (src === 'vm/init.log') {
      const ts = rows.map(dockerTime).filter((t) => t != null).sort((a, b) => a - b);
      const gaps = ts.slice(1).map((t, i) => [t - ts[i], ts[i]]).filter(([g]) => g > 9000);
      lines.push(`  gaps over 9 s between vm/init.log lines (normal quiet is up to ~8.9 s): ${gaps.length}`);
      for (const [g, at] of gaps.slice(0, 10)) lines.push(`    ${iso(at)} +${g}ms`);
    }
  }
  lines.push(`pmset sleep/wake lines in the window: ${sleeps.split('\n').filter(Boolean).length}`);
  return `${lines.join('\n')}\n`;
}

/* ───────────── the alert: one message on the channel ───────────── */

/**
 * Where an alert goes and with what key. This repo's own binding unless the
 * rig says otherwise. The key is read here, used in one header, and never
 * written anywhere, this log included.
 */
async function postTarget() {
  if (C.postUrl && C.postKey && C.postChannel) return { origin: C.postUrl.replace(/\/+$/, ''), key: C.postKey, channel: C.postChannel };
  const { discover, originOf } = await import(pathToFileURL(join(C.postFrom, 'host/identity.js')).href);
  const dir = C.postFrom.replace(/\/+$/, '');
  const desk = discover([dir], { maxDepth: 1 }).desks.find((d) => d.cwd === dir);
  if (!desk?.key || !desk.url) throw new Error(`no binding with a key at ${dir}`);
  return { origin: originOf(desk.url), key: desk.key, channel: desk.channel };
}

/** One JSON-RPC call on /mcp; the reply may come as JSON or as one SSE event. */
async function mcp(t, sid, msg) {
  const res = await fetch(`${t.origin}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'x-channel': t.channel, 'x-agent': C.postAs, 'x-orchestratinator-key': t.key,
      ...(sid ? { 'mcp-session-id': sid } : {}),
    },
    body: JSON.stringify(msg),
    signal: AbortSignal.timeout(C.probeTimeout),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${t.origin}/mcp ${msg.method} → ${res.status}`);
  const data = (res.headers.get('content-type') ?? '').includes('text/event-stream')
    ? text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).pop()
    : text;
  return { sid: res.headers.get('mcp-session-id') ?? sid, reply: data ? JSON.parse(data) : null };
}

async function postAlert(dir) {
  const file = join(dir, 'alert.json');
  const alert = JSON.parse(readFileSync(file, 'utf8'));
  alert.attempts = (alert.attempts ?? 0) + 1;
  alert.last_attempt_at = iso();
  try {
    const t = await postTarget();
    const summary = readFileSync(join(dir, 'summary.txt'), 'utf8');
    // Readings only: the summary never quotes a host-log line (summarise).
    const body = `A burst capture closed. Readings only, no host-log lines; an alert from capture.mjs (capture-a-burst skill), not a request for work.\n${dir}\n\n${summary}`;
    let { sid } = await mcp(t, null, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'orchestratinator-capture', version: '1' } } });
    if (!sid) throw new Error('the board gave no MCP session');
    await mcp(t, sid, { jsonrpc: '2.0', method: 'notifications/initialized' });
    const r = await mcp(t, sid, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'send_message', arguments: { body } } });
    const said = JSON.parse(r.reply?.result?.content?.[0]?.text ?? 'null');
    if (r.reply?.result?.isError || !said?.sent) throw new Error(`send_message did not send: ${JSON.stringify(r.reply).slice(0, 200)}`);
    fetch(`${t.origin}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': sid, 'x-channel': t.channel, 'x-agent': C.postAs, 'x-orchestratinator-key': t.key }, signal: AbortSignal.timeout(5000) }).catch(() => {});
    Object.assign(alert, { state: 'posted', posted_at: iso(), message_id: said.id, channel: said.channel, from: said.from, to: said.to, last_error: null });
    say(`posted the alert for ${dir} as message ${said.id} on ${said.channel} (to everyone, from ${said.from})`);
  } catch (err) {
    alert.last_error = `${err?.name ?? 'Error'}: ${err?.cause?.code ?? ''} ${err?.message ?? err}`.replace(/\s+/g, ' ').trim();
    say(`the alert for ${dir} was not posted (${alert.last_error}); trying again in ${C.postRetry / 1000}s`);
  }
  writeFileSync(file, JSON.stringify(alert, null, 2));
}

/** Every closed capture whose alert has not gone yet, oldest first — read off
 *  the disk, so a restart in between loses none of them. */
function pendingAlerts() {
  let names = [];
  try { names = readdirSync(C.dir).filter((n) => /^\d{4}-/.test(n)).sort(); } catch { return []; }
  return names.map((n) => join(C.dir, n)).filter((d) => {
    try { return JSON.parse(readFileSync(join(d, 'alert.json'), 'utf8')).state === 'pending'; } catch { return false; }
  });
}

/* ───────────── the loop ───────────── */

const started = Date.now();
function writeState() {
  try {
    mkdirSync(C.dir, { recursive: true });
    writeFileSync(join(C.dir, 'state.json'), JSON.stringify({ pid: process.pid, started_at: iso(started), updated_at: iso(), host_log: C.hostLog, offset, recent_failures: failures.length, open: open ? { dir: open.dir, failures: open.failures, last_failure: iso(open.lastFailure) } : null }, null, 2));
  } catch (err) { say(`state: ${err.message}`); }
}

async function main() {
  mkdirSync(C.dir, { recursive: true });
  if (!existsSync(C.hostLog)) say(`${C.hostLog} does not exist yet; waiting for it`);
  for (const l of primeFromTail()) take(l, true);
  say(`watching ${C.hostLog} from byte ${offset}; a capture opens at ${C.openCount} failure lines within ${C.openWindow / 1000}s, into ${C.dir}`);
  let lastState = 0;
  let posting = null;
  let postFailed = false;
  let lastPostTry = 0;
  // The tick never waits on Docker. A snapshot and a close shell out to
  // `docker`, and a VM that is stalling is exactly when those hang — a tick
  // that awaited them would stop the probes at the moment they matter. So
  // they run beside it, one at a time, and the probes keep their own clock.
  let behind = null;
  const beside = (what, fn) => {
    if (behind) return;
    behind = fn().catch((err) => say(`${what} failed: ${err.stack ?? err.message}`)).finally(() => { behind = null; });
  };
  setInterval(() => {
    try {
      for (const l of readNew().lines) take(l);
      const now = Date.now();
      if (open && !open.closing) {
        if (now - open.lastProbe >= C.probeEvery) {
          open.lastProbe = now;
          probe('outside', health);
          if (C.dockerSock) probe('docker-ping', dockerPing);
          if (C.inside && C.container && open.probeN++ % 3 === 0) probe('inside', inside);
        }
        if (now - open.lastFailure >= C.closeQuiet) { open.closing = true; behind?.then(() => beside('close', closeCapture)) ?? beside('close', closeCapture); }
        else if (now - open.lastSnapshot >= C.snapshotEvery) beside('snapshot', snapshot);
      }
      // An alert goes beside everything else, one at a time, and a failed
      // one waits postRetry before the next try. The first try is on the
      // tick after its capture closed.
      if (C.post && !posting && now - lastPostTry >= (postFailed ? C.postRetry : 0)) {
        const next = pendingAlerts()[0];
        if (next) {
          lastPostTry = now;
          posting = postAlert(next).then(() => {
            postFailed = (() => { try { return JSON.parse(readFileSync(join(next, 'alert.json'), 'utf8')).state === 'pending'; } catch { return true; } })();
          }).catch((err) => { postFailed = true; say(`alert: ${err.message}`); }).finally(() => { posting = null; });
        }
      }
      if (now - lastState >= 60_000) { lastState = now; writeState(); }
    } catch (err) {
      say(`tick: ${err.stack ?? err.message}`);
    }
  }, C.tick);
  writeState();
  const stop = async () => {
    say('stopping');
    if (open) { try { await closeCapture(); } catch (err) { say(`close on stop: ${err.message}`); } }
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

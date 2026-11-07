// Issue #40: checking GitHub for a newer build, and the update the host
// carries out. Four tiers, each against the real code:
//
//   1. the pure decisions — where a build stands, why an update is refused,
//      what the page draws — over payloads the server itself built;
//   2. a real server against a stand-in GitHub (a local http server counting
//      every request), for the check: once a day, at most one contact a
//      minute however often Check now is pressed, nothing at all while
//      checking is off, the rate limit said in words;
//   3. host/update.js's steps run in this process against real git repos —
//      a bare "GitHub" and a clone — with a stand-in docker and claude, for
//      every refusal and failure, and that a failure puts the clone back;
//   4. the whole path: the page's Update → the board → a real host process →
//      steps back as events → the server "rebuilt" (restarted by this test as
//      the new commit when the stand-in docker is called) → the host exits
//      for launchd → comes back as the new build → the run closes.
//
// Nothing here touches the live board, the real Docker or GitHub.
//   npm run test:update
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { standingOf, refusalOf, branchOf, isNewer } from '../src/updates.js';
import { gitHeadOf } from '../src/build-info.js';

// What every hand-rolled registration below says it speaks: the board refuses
// a host with another number, or none (protocolRefusal in src/floor.js).
const PROTOCOL = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).protocol;
const HOST_PROTOCOL = JSON.parse(readFileSync(new URL('../host/package.json', import.meta.url), 'utf8')).protocol;

const PORT = Number(process.env.UPDATE_TEST_PORT ?? 8906);
const GH_PORT = PORT + 1;
const STUB_PORT = PORT + 2;
const BOARD = `http://localhost:${PORT}`;
const KEY = 'update-shared-secret';
const FIX = join(tmpdir(), `orch-update-${process.pid}`);
const DB = join(FIX, 'board.db');
const ORIGIN_WORK = join(FIX, 'work');
const ORIGIN = join(FIX, 'origin.git');
const CLONE = join(FIX, 'clone');
const CONTAINER = 'c0ffee000000aaaabbbbccccddddeeeeffff0000111122223333444455556666';
const REPO = 'acme/orch';

let failures = 0;
const assert = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) failures++; };
const eq = (a, b, msg) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${ok ? '✓' : '✗'} ${msg}${ok ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`);
  if (!ok) failures++;
};
async function until(fn, ms = 8000, every = 100) {
  const stop = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > stop) return null;
    await sleep(every);
  }
}

/* ───────── fixtures: a "GitHub" repo with three commits, and a clone ───────── */

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

rmSync(FIX, { recursive: true, force: true });
mkdirSync(join(ORIGIN_WORK, 'plugin'), { recursive: true });
mkdirSync(join(ORIGIN_WORK, 'src'), { recursive: true });
git(ORIGIN_WORK, 'init', '-q', '-b', 'main');
const commitAs = (version, files, msg) => {
  writeFileSync(join(ORIGIN_WORK, 'package.json'), JSON.stringify({ version }) + '\n');
  for (const [f, t] of Object.entries(files)) writeFileSync(join(ORIGIN_WORK, f), t);
  git(ORIGIN_WORK, 'add', '-A');
  git(ORIGIN_WORK, 'commit', '-q', '-m', msg);
  return git(ORIGIN_WORK, 'rev-parse', 'HEAD');
};
const C1 = commitAs('1.0.0', { 'plugin/hooks.json': '{"v":1}\n', 'src/a.js': 'one\n' }, 'first');
const C2 = commitAs('1.0.1', { 'plugin/hooks.json': '{"v":2}\n', 'src/a.js': 'two\n' }, 'second: a hook changed');
const C3 = commitAs('1.0.1', { 'src/a.js': 'three\n' }, 'third: same version, plugin untouched');
git(FIX, 'clone', '-q', '--bare', ORIGIN_WORK, ORIGIN);

/** A clone of "GitHub" on main at `at`, as an operator's machine would have. */
function freshClone(at) {
  rmSync(CLONE, { recursive: true, force: true });
  git(FIX, 'clone', '-q', ORIGIN, CLONE);
  git(CLONE, 'reset', '-q', '--hard', at);
}

// Stand-ins for docker and claude. Behaviour by mode file; every call logged.
const STAND = join(FIX, 'bin');
mkdirSync(STAND, { recursive: true });
writeFileSync(join(STAND, 'docker'), `#!/usr/bin/env node
const fs = require('fs'); const F = ${JSON.stringify(FIX)};
const mode = fs.existsSync(F + '/docker.mode') ? fs.readFileSync(F + '/docker.mode', 'utf8').trim() : 'ok';
fs.appendFileSync(F + '/docker.log', JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
const a = process.argv.slice(2);
if (a[0] === 'ps') { if (fs.existsSync(F + '/container')) process.stdout.write(fs.readFileSync(F + '/container', 'utf8')); process.exit(0); }
if (a[0] === 'compose' && a[1] === 'up') {
  fs.writeFileSync(F + '/compose.flag', String(Date.now()));
  if (mode === 'fail') { process.stderr.write('target orchestratinator: failed to solve: boom\\n'); process.exit(1); }
  if (mode === 'running') { process.stdout.write(' Container appideas-orchestratinator Running\\n'); process.exit(0); }
  process.stderr.write(' Container appideas-orchestratinator Recreate\\n Container appideas-orchestratinator Recreated\\n Container appideas-orchestratinator Started\\n');
  process.exit(0);
}
process.exit(0);
`);
writeFileSync(join(STAND, 'claude'), `#!/usr/bin/env node
const fs = require('fs'); const F = ${JSON.stringify(FIX)};
const mode = fs.existsSync(F + '/plugin.mode') ? fs.readFileSync(F + '/plugin.mode', 'utf8').trim() : 'ok';
const a = process.argv.slice(2);
if (a[0] === 'agents') { process.stdout.write('[]'); process.exit(0); }
if (a[0] === 'plugin') {
  fs.appendFileSync(F + '/claude.log', JSON.stringify({ cwd: process.cwd(), args: a }) + '\\n');
  if (mode === 'missing') { process.stderr.write('Plugin "' + a[2] + '" is not installed\\n'); process.exit(1); }
  if (mode === 'fail') { process.stderr.write('boom\\n'); process.exit(2); }
  if (mode === 'slow') { setTimeout(() => { process.stdout.write('✔ updated (slowly)\\n'); process.exit(0); }, 2000); return; }
  process.stdout.write('✔ Plugin "' + a[2] + '" updated from 1.0.0 to 1.0.1. Restart to apply changes.\\n'); process.exit(0);
}
process.exit(0);
`);
chmodSync(join(STAND, 'docker'), 0o755);
chmodSync(join(STAND, 'claude'), 0o755);
const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const setMode = (what, mode) => writeFileSync(join(FIX, `${what}.mode`), mode);

/* ───────── 0. the build's commit, read with nothing but the filesystem ───────── */

console.log('\nthe build knows its commit:');
{
  eq(gitHeadOf(join(ORIGIN_WORK, '.git')), C3, 'a branch HEAD read from its loose ref');
  git(ORIGIN_WORK, 'pack-refs', '--all');
  eq(gitHeadOf(join(ORIGIN_WORK, '.git')), C3, 'and from packed-refs once the loose ref is gone');
  git(ORIGIN_WORK, 'checkout', '-q', '--detach', C2);
  eq(gitHeadOf(join(ORIGIN_WORK, '.git')), C2, 'a detached HEAD');
  git(ORIGIN_WORK, 'checkout', '-q', 'main');
  const wt = join(FIX, 'wt');
  git(ORIGIN_WORK, 'worktree', 'add', '-q', '--detach', wt, C1);
  eq(gitHeadOf(join(wt, '.git')), C1, 'a worktree, whose .git is a file');
  git(ORIGIN_WORK, 'worktree', 'remove', '--force', wt);
  eq(gitHeadOf(join(FIX, 'nowhere')), null, 'and null, not a throw, where there is no .git');
}

/* ───────── 1. the pure decisions ───────── */

console.log('\nwhere a build stands:');
{
  const last = { branch: 'main', head: { sha: C3 }, recent: [C3, C2, C1], compared: {} };
  eq(standingOf(C3, last, 'main').state, 'latest', 'the newest commit is the latest');
  eq(standingOf(C1, last, 'main'), { state: 'behind', behind_by: 2 }, 'a commit in the list is behind by its place in it');
  eq(standingOf(C1, last, 'develop').state, 'unchecked', 'a check of another branch says nothing about this one');
  eq(standingOf(null, last, 'main').state, 'unknown', 'a build that does not know its commit cannot be compared');
  eq(standingOf('f'.repeat(40), last, 'main').state, 'unknown', 'nor one not in the list and not compared');
  eq(standingOf('f'.repeat(40), { ...last, compared: { ['f'.repeat(40)]: { status: 'diverged', behind_by: 4 } } }, 'main'), { state: 'diverged', behind_by: 4 }, 'a compare that says diverged');
  eq(standingOf('f'.repeat(40), { ...last, compared: { ['f'.repeat(40)]: { status: 'ahead' } } }, 'main').state, 'ahead', 'and one that says ahead');
  assert(isNewer({ state: 'behind' }) && isNewer({ state: 'diverged' }) && !isNewer({ state: 'ahead' }) && !isNewer({ state: 'latest' }) && !isNewer({ state: 'unknown' }),
    'an update is offered only when the branch has commits this build lacks');
  eq([branchOf(false), branchOf(true)], ['main', 'develop'], 'the development version follows develop');
}

console.log('\nwhy an update would be refused, before anything is touched:');
{
  const base = {
    check: { branch: 'main', head: { sha: C2 } }, standing: { state: 'behind', behind_by: 1 }, branch: 'main',
    self: { container: 'c0ffee000000' }, host: { name: 'Mac' },
    report: { supervised: true, clone: { path: '/x', branch: 'main', dirty: false } }, run: null,
  };
  eq(refusalOf(base), null, 'nothing to refuse: clean, on the branch, supervised, behind');
  assert(/already under way/.test(refusalOf({ ...base, run: { state: 'running' } })), 'a run under way');
  assert(/Check now/.test(refusalOf({ ...base, check: null })), 'nothing checked yet');
  assert(/newest commit/.test(refusalOf({ ...base, standing: { state: 'latest' } })), 'already the latest');
  assert(/not running in a Docker container/.test(refusalOf({ ...base, self: { container: null } })), 'a board run bare');
  assert(/none is live/.test(refusalOf({ ...base, host: null })), 'no host beside the board');
  assert(/LaunchAgent/.test(refusalOf({ ...base, report: { ...base.report, supervised: false } })), 'a host nothing would restart');
  eq(refusalOf({ ...base, report: { ...base.report, supervised: true, supervisor: 'launchd' } }), null, 'a host that names launchd as what restarts it (0.12.5 and on)');
  const appRun = refusalOf({ ...base, report: { ...base.report, supervised: true, supervisor: 'app' } });
  assert(/run by the Orchestratinator app, which carries its code and updates it\. This board does not update it — update the app instead\./.test(appRun), `a host the desktop app runs is the app's to update (desktop #289) ("${appRun}")`);
  assert(/run by systemd, which this board cannot restart/.test(refusalOf({ ...base, report: { ...base.report, supervised: true, supervisor: 'systemd' } })), 'a host run by something the board has no restart for is named');
  const dirty = refusalOf({ ...base, report: { ...base.report, clone: { path: '/x', branch: 'main', dirty: true, changes: ['a', 'b', 'c', 'd'] } } });
  assert(/local changes \(a, b, c, \+1 more\)/.test(dirty), `a dirty clone, naming what is dirty ("${dirty}")`);
  const off = refusalOf({ ...base, report: { ...base.report, clone: { path: '/x', branch: 'issues/40', dirty: false } } });
  assert(/is on "issues\/40", not main/.test(off), `a clone on another branch ("${off}")`);
  // Finish the update asks for nothing newer, and only of a host whose code
  // can finish (PR #42 N1).
  const fin = { ...base, standing: { state: 'latest' }, finishing: true };
  const old = refusalOf({ ...fin, report: { ...base.report, build: { commit: 'e578070fb5a26172a25207d61d24e93bf2cded0b' } } });
  assert(/runs a build from before Finish the update \(e578070\)/.test(old ?? ''), `finishing, a host whose report names no "finish" is not asked ("${old}")`);
  eq(refusalOf({ ...fin, report: { ...base.report, capabilities: ['finish'] } }), null, 'one that names it is, with nothing newer on the branch');
}

/* ───────── 2. a real server against a stand-in GitHub ───────── */

const gh = {
  requests: [],
  branches: { main: [C2, C1], develop: [C3, C2, C1] },
  limited: false,
  compare: {},   // `${base}...${head}` → { status, behind_by } | 404
  versions: { [C1]: '1.0.0', [C2]: '1.0.1', [C3]: '1.0.1' },
};
const ghServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  gh.requests.push({ path: url.pathname, query: url.search, ua: req.headers['user-agent'] });
  const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  if (url.pathname === `/repos/${REPO}/commits`) {
    if (gh.limited) return send(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1800) });
    const list = gh.branches[url.searchParams.get('sha')];
    if (!list) return send(404, { message: 'Not Found' });
    return send(200, list.map((sha, i) => ({ sha, html_url: `https://github.com/${REPO}/commit/${sha}`, commit: { message: `commit ${i}\n\nbody`, committer: { date: '2026-11-04T12:00:00Z' } } })));
  }
  const cmp = /^\/repos\/[^/]+\/[^/]+\/compare\/(.+)$/.exec(url.pathname);
  if (cmp) {
    const c = gh.compare[cmp[1]];
    return c ? send(200, c) : send(404, { message: 'Not Found' });
  }
  const raw = /^\/[^/]+\/[^/]+\/([0-9a-f]{40})\/package\.json$/.exec(url.pathname);
  if (raw) return gh.versions[raw[1]] ? send(200, { version: gh.versions[raw[1]] }) : send(404, {});
  send(404, {});
});
await new Promise((r) => ghServer.listen(GH_PORT, r));
const apiCalls = () => gh.requests.filter((r) => r.path.startsWith('/repos/')).length;

let server = null;
async function startServer(commit, extra = {}) {
  server = spawn('node', ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), DB_PATH: DB, ORCH_AUTH_TOKEN: KEY,
      ORCH_GITHUB_API: `http://localhost:${GH_PORT}`, ORCH_GITHUB_RAW: `http://localhost:${GH_PORT}`,
      ORCH_UPDATE_REPO: REPO, ORCH_BUILD_COMMIT: commit, ORCH_BOARD_CONTAINER: CONTAINER.slice(0, 12),
      ORCH_UPDATE_MIN_GAP_MS: '3000', ORCH_UPDATE_TICK_MS: '400', FLOOR_HOST_TTL_SECONDS: '30',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.out = '';
  server.stdout.on('data', (d) => { server.out += d; });
  server.stderr.on('data', (d) => { server.out += d; });
  const up = await until(async () => { try { return (await fetch(`${BOARD}/health`)).ok; } catch { return false; } }, 10000);
  if (!up) throw new Error(`server did not start:\n${server.out}`);
}
async function stopServer() {
  if (!server) return;
  const s = server; server = null;
  s.kill('SIGTERM');
  await new Promise((r) => { if (s.exitCode !== null) r(); else s.once('exit', r); });
}
const state = async () => (await fetch(`${BOARD}/api/state`)).json();
const upd = async () => (await state()).update;
const admin = async (path, body = {}) => {
  const res = await fetch(`${BOARD}/api/admin/update/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
// Newest first, and the kind of an admin row is `admin.<action>`.
const activity = async () => (await (await fetch(`${BOARD}/api/activity?limit=200`)).json()).rows;

// The page's decisions, lifted out of src/ui/app.js by their section comments.
const page = await (async () => {
  const src = readFileSync('src/ui/app.js', 'utf8');
  const a = src.indexOf('/* ---------- updates: what the page decides ---------- */');
  const b = src.indexOf('/* ---------- updates: the dialog ---------- */');
  if (a < 0 || b < 0 || b < a) throw new Error('the updates section was not found in src/ui/app.js between its two section comments');
  const tmp = join(FIX, 'page-updates.mjs');
  writeFileSync(tmp, `${src.slice(a, b)}\nexport { UPDATE_STEPS, updateButton, latestText, checkedText, updateStepRows, interruptLines, reloadsFor };\n`);
  return import(`file://${tmp}`);
})();

try {
  rmSync(DB, { force: true });
  await startServer(C1);

  console.log('\nthe settings, and the daily check:');
  {
    const u0 = await upd();
    eq([u0.check, u0.dev, u0.branch], [true, false, 'main'], 'checking is on and follows main by default');
    eq([u0.current.version, u0.current.commit], [JSON.parse(readFileSync('package.json', 'utf8')).version, C1], 'the current version and commit are the running build\'s');
    eq((await (await fetch(`${BOARD}/health`)).json()).commit, C1, '/health names the commit too');
    const first = await until(async () => (await upd()).checked_at, 3000);
    assert(first, 'with checking on, the board checks by itself soon after it starts');
    const u1 = await upd();
    eq(u1.standing, { state: 'behind', behind_by: 1 }, 'and finds this build one commit behind main');
    eq([u1.latest.sha, u1.latest.version, u1.latest.message], [C2, '1.0.1', 'commit 0'], 'the latest: commit, version from package.json, first line of its message');
    assert(u1.available, 'so the header has an Update button');
    eq(apiCalls(), 1, 'one API request for the whole check (the version is raw.githubusercontent, not the API)');
    assert(gh.requests.every((r) => /^appideas-orchestratinator\//.test(r.ua)), 'every request names the board in its user agent, as GitHub requires');
    // Past the 3 s contact gap, so what holds the timer back is the day rule
    // and not the gap (PR #42 finding 2: at 1.5 s the gap held it alone).
    await sleep(3100);
    eq(apiCalls(), 1, 'and the timer, ticking every 400ms here, does not check again the same day');
    const rows = await activity();
    assert(rows.some((r) => r.kind === 'admin.update.check' && r.actor === 'system' && /main is at/.test(r.detail ?? '')), 'the daily check is in the activity log, as the system');
  }

  console.log('\nCheck now, and GitHub\'s hourly limit:');
  {
    const n = apiCalls();
    const r0 = await admin('check');
    eq([r0.body.ok, r0.body.throttled ?? false, apiCalls()], [true, false, n + 1], 'a press past the gap asks, with one request');
    const r1 = await admin('check');
    eq([r1.status, r1.body.throttled], [200, true], 'a press inside a minute of the last contact is answered from what is in hand');
    assert(/next is in \d+s/.test(r1.body.note ?? ''), `and says when it may ask again ("${r1.body.note}")`);
    eq(apiCalls(), n + 1, 'without a request to GitHub');
    await sleep(3100);
    const r2 = await admin('check');
    assert(r2.body.ok && !r2.body.throttled, 'past the gap it asks');
    eq(apiCalls(), n + 2, 'with one request');
    assert((await activity()).some((r) => r.kind === 'admin.update.check' && r.actor === 'operator'), 'and the press is logged as the operator\'s');
    gh.limited = true;
    await sleep(3100);
    const r3 = await admin('check');
    assert(!r3.body.ok && /limit .* used up until \d\d:\d\d UTC/.test(r3.body.error ?? ''), `a spent limit is said in words ("${r3.body.error}")`);
    const u = r3.body.update;
    assert(u.error && u.latest?.sha === C2 && u.available, 'the last good answer is kept beside the failure, and so is the offer');
    eq(page.checkedText(u, Date.now()), 'just now; the last try (just now) failed', 'Settings says the last try failed');
    const n2 = apiCalls();
    await sleep(3100);
    const r4 = await admin('check');
    eq(apiCalls(), n2, 'and until the limit resets, a press does not ask at all');
    assert(/used up until/.test(r4.body.error ?? ''), 'it says so instead');
    gh.limited = false;
  }

  // Restarted on a fresh database for the settings, so the limit above is forgotten.
  await stopServer();
  rmSync(DB, { force: true });
  await startServer(C1, { ORCH_UPDATE_TICK_MS: '300000' });

  console.log('\nturning checking off stops all contact, except Check now:');
  {
    const r0 = await admin('settings', { check: false });
    eq(r0.status, 200, 'the setting is saved on the board');
    const n = apiCalls();
    const r1 = await admin('settings', { dev: true });
    eq(r1.body.update.branch, 'develop', 'the development version follows develop');
    eq(apiCalls(), n, 'with checking off, changing the branch asks GitHub nothing');
    eq(r1.body.update.standing.state, 'unchecked', 'and says develop has not been checked');
    eq(page.latestText(r1.body.update), 'Not checked on develop yet', 'in those words');
    const r2 = await admin('check');
    eq(apiCalls(), n + 1, 'Check now asks even with checking off');
    eq(r2.body.update.standing, { state: 'behind', behind_by: 2 }, 'develop is two commits ahead of this build');
    eq(r2.body.update.available, false, 'but with checking off, no button: the header shows it never while checking is off');
    eq(page.updateButton(r2.body.update), null, 'the page draws none');
    const r3 = await admin('settings', { check: true });
    assert(r3.body.update.available, 'turned back on, the same check offers the update');
    eq(page.updateButton(r3.body.update)?.label, 'Update available', 'and the page draws the button');
    await sleep(3100);
    const n3 = apiCalls();
    const r4 = await admin('settings', { dev: false });
    eq(apiCalls(), n3 + 1, 'with checking on, a change of branch is checked at once');
    eq(r4.body.update.latest?.sha, C2, 'and Latest is main\'s');
    // The tick itself, due and firing, with checking off: develop has never
    // been checked, so the daily check is due the moment the tick runs.
    await admin('settings', { check: false });
    await admin('settings', { dev: true });
    // Past the contact gap first: inside it the gap would hold the tick back,
    // and this would pass for the gap's sake rather than the switch's.
    await sleep(3100);
    await stopServer();
    const n4 = apiCalls();
    await startServer(C1, { ORCH_UPDATE_TICK_MS: '300' });
    await sleep(1500);
    eq(apiCalls(), n4, 'with checking off, a daily check that is due and a tick every 300ms still ask nothing');
    await admin('settings', { check: true });
    eq(await until(() => apiCalls() > n4, 3000) ? apiCalls() : n4, n4 + 1, 'turned on, the same tick checks once');
    await admin('settings', { dev: false });
    await stopServer();
    await startServer(C1, { ORCH_UPDATE_TICK_MS: '300000' });
    const bad = await admin('settings', { check: 'yes' });
    eq(bad.status, 400, 'a setting that is not true or false is refused');
    const s = (await activity()).filter((r) => r.kind === 'admin.update.settings').map((r) => r.detail);
    assert(s.some((d) => /turned off — no contact with GitHub except Check now/.test(d)) && s.some((d) => /following develop/.test(d)),
      'each change is in the activity log');
    // Another browser reads the same values: they are the board's, not this page's.
    const again = await upd();
    eq([again.check, again.dev], [true, false], 'a fresh read of /api/state carries the settings');
  }

  console.log('\na build that is not in the branch\'s last hundred commits:');
  {
    await stopServer();
    rmSync(DB, { force: true });
    const odd = 'a'.repeat(40);
    gh.compare[`${C2}...${odd}`] = { status: 'diverged', behind_by: 1, ahead_by: 3 };
    await startServer(odd, { ORCH_UPDATE_TICK_MS: '300000' });
    const n = apiCalls();
    const r = await admin('check');
    eq(apiCalls(), n + 2, 'is compared, at one more request');
    eq(r.body.update.standing, { state: 'diverged', behind_by: 1 }, 'and reads diverged');
    assert(/not on main/.test(page.latestText(r.body.update)), `Settings says so ("${page.latestText(r.body.update)}")`);
    await sleep(3100);
    await admin('check');
    eq(apiCalls(), n + 3, 'the compare is kept while the branch has not moved');
    await stopServer();
    rmSync(DB, { force: true });
    await startServer('b'.repeat(40), { ORCH_UPDATE_TICK_MS: '300000' });
    const r2 = await admin('check');
    eq(r2.body.update.standing.state, 'unknown', 'a commit GitHub has never seen is unknown');
    assert(/not on GitHub/.test(r2.body.update.standing.why ?? ''), 'and says why');
    eq(r2.body.update.available, false, 'with no button');
  }

  console.log('\na board run bare (npm start, every other suite) never checks by itself:');
  {
    await stopServer();
    rmSync(DB, { force: true });
    const n = apiCalls();
    await startServer(C1, { ORCH_BOARD_CONTAINER: '', ORCH_UPDATE_TICK_MS: '300' });
    await sleep(1500);
    eq(apiCalls(), n, 'no request to GitHub, with checking on and the tick at 300ms');
    const u = await upd();
    eq([u.check, u.current.container, u.standing.state], [true, null, 'unchecked'], 'checking is still on; there is just no container to update');
    const r = await admin('check');
    eq([r.body.ok, apiCalls()], [true, n + 1], 'Check now still asks');
    assert(/not running in a Docker container/.test(r.body.update.refusal ?? ''), 'and an update would be refused, saying why');
  }

  /* ───────── 3. the host's steps, in this process ───────── */

  console.log('\nthe host\'s steps (host/update.js, against real git):');
  {
    process.env.ORCH_HOST_CLONE = CLONE;
    process.env.ORCH_HOST_DOCKER = join(STAND, 'docker');
    process.env.ORCH_HOST_CLAUDE = join(STAND, 'claude');
    process.env.ORCH_UPDATE_FETCH_URL = ORIGIN;
    process.env.ORCH_UPDATE_HEALTH_TIMEOUT_MS = '1500';
    const U = await import('../host/update.js');
    // The board as the host reads it: `before` until the stand-in docker has
    // been asked to build, `commit` after — a real board changes build only
    // when its container is replaced.
    const health = { before: C1, commit: C1 };
    const stub = http.createServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: '1.0.1', commit: existsSync(join(FIX, 'compose.flag')) ? health.commit : health.before }));
    });
    await new Promise((r) => stub.listen(STUB_PORT, r));
    const run = async (commit, branch = 'main', extra = {}) => {
      const said = [];
      let restarted = false;
      const out = await U.runUpdate({ commit, branch, repo: REPO, ...extra }, {
        say: async (step, st, detail) => { said.push([step, st, detail]); },
        boardUrl: `http://localhost:${STUB_PORT}`,
        restart: async () => { restarted = true; },
      });
      return { out, said, restarted, last: said.at(-1) };
    };
    const head = () => git(CLONE, 'rev-parse', 'HEAD');
    const reset = () => { for (const f of ['docker.log', 'claude.log', 'compose.flag', 'docker.mode', 'plugin.mode']) rmSync(join(FIX, f), { force: true }); };

    // The report the host sends on every registration.
    freshClone(C1);
    writeFileSync(join(FIX, 'container'), CONTAINER + '\n');
    process.env.ORCH_HOST_SUPERVISED = '1';
    const me = await U.selfReport();
    eq([me.clone.branch, me.clone.head, me.clone.dirty, me.board_container, me.supervised, me.capabilities], ['main', C1, false, CONTAINER, true, ['finish']],
      'the host reports its clone, the board container its compose project runs, that launchd will restart it, and that it can finish an update');
    const asked = lines(join(FIX, 'docker.log')).find((l) => l.args[0] === 'ps');
    assert(asked?.args.includes(`label=com.docker.compose.project.working_dir=${CLONE}`), 'found by the compose project\'s working directory, which is this clone');

    reset(); freshClone(C1);
    delete process.env.ORCH_HOST_SUPERVISED;
    let r = await run(C2);
    eq(r.last.slice(0, 2), ['preflight', 'refused'], 'a host not under launchd refuses: nothing would start it again');
    eq(me.supervisor, 'launchd', 'the report names launchd as what restarts it');
    eq(me.protocol, HOST_PROTOCOL, 'and the protocol host/package.json carries');

    // Run by the desktop app (desktop #289): said in the report, and an
    // update refused at preflight in the same words the board uses.
    reset(); freshClone(C1);
    process.env.ORCH_HOST_SUPERVISOR = 'app';
    const underApp = await U.selfReport();
    eq([underApp.supervisor, underApp.supervised], ['app', true], 'ORCH_HOST_SUPERVISOR=app: run by the app, which restarts it');
    r = await run(C2);
    eq(r.last.slice(0, 2), ['preflight', 'refused'], 'an app-run host refuses the page\'s update at preflight');
    assert(/run by the Orchestratinator app, which carries its code and updates it/.test(r.last[2]), `in words that say who does update it ("${r.last[2]}")`);
    eq(git(CLONE, 'rev-parse', 'HEAD'), C1, 'and touched nothing');
    process.env.ORCH_HOST_SUPERVISOR = 'Some Thing!';
    eq((await U.selfReport()).supervisor, null, 'a supervisor the board could not say back is nobody');
    process.env.ORCH_HOST_SUPERVISOR = 'systemd';
    eq((await U.selfReport()).supervisor, 'systemd', 'any plain word is reported as given');
    delete process.env.ORCH_HOST_SUPERVISOR;
    process.env.ORCH_HOST_SUPERVISED = '1';
    eq((await U.selfReport()).supervisor, 'launchd', 'and the suites\' stand-in for launchd still reads as launchd');

    reset(); freshClone(C1);
    writeFileSync(join(CLONE, 'scratch.txt'), 'mine');
    r = await run(C2);
    eq(r.last.slice(0, 2), ['preflight', 'refused'], 'a clone with local changes is refused');
    assert(/local changes \(scratch\.txt\)/.test(r.last[2]), `naming them ("${r.last[2]}")`);
    eq(head(), C1, 'and is not touched');
    assert(existsSync(join(CLONE, 'scratch.txt')), 'nothing stashed or cleaned');

    reset(); freshClone(C1);
    git(CLONE, 'checkout', '-q', '-b', 'issues/40');
    r = await run(C2);
    assert(r.last[1] === 'refused' && /is on "issues\/40", not main/.test(r.last[2]), `a clone on another branch is refused ("${r.last[2]}")`);

    reset(); freshClone(C1);
    writeFileSync(join(CLONE, 'local.txt'), 'x');
    git(CLONE, 'add', '-A'); git(CLONE, 'commit', '-q', '-m', 'a local commit');
    const local = head();
    r = await run(C2);
    eq(r.last.slice(0, 2), ['fetch', 'refused'], 'a clone with a commit that is not on the branch is refused after the fetch');
    assert(/cannot be moved forward without losing them/.test(r.last[2]), 'because moving it would lose that commit');
    eq(head(), local, 'and is left where it was');

    reset(); freshClone(C1);
    setMode('docker', 'fail');
    r = await run(C2);
    eq(r.last.slice(0, 2), ['server', 'failed'], 'a build that fails stops at the server step');
    assert(/exited 1: .*failed to solve: boom/.test(r.last[2]) && /board is still the build it was/.test(r.last[2]), `with what docker said ("${r.last[2]}")`);
    eq(head(), C1, 'and the clone is put back on the build that is running');
    assert(/clone is back on/.test(r.last[2]), 'which the step says');
    const compose = lines(join(FIX, 'docker.log')).find((l) => l.args[0] === 'compose');
    eq([compose?.args, compose?.cwd], [['compose', 'up', '-d', '--build'], realpathSync(CLONE)], 'the build was `docker compose up -d --build` in the clone');

    reset(); freshClone(C1);
    setMode('docker', 'running');
    r = await run(C2);
    assert(r.last[1] === 'failed' && /did not replace the container .*Running/.test(r.last[2]), `"Running" is not a rebuild ("${r.last[2]}")`);
    eq(head(), C1, 'and puts the clone back too');

    reset(); freshClone(C1);
    health.commit = C1;
    r = await run(C2);
    assert(r.last[1] === 'failed' && /never answered as .* last answered 1\.0\.1 at/.test(r.last[2]), `a board that does not come back as the commit fails the server step ("${r.last[2]}")`);
    assert(!r.restarted, 'and the host is not restarted');

    reset(); freshClone(C1);
    health.commit = C2;
    r = await run(C2);
    eq(r.said.map(([s, st]) => `${s}:${st}`).filter((x) => !x.endsWith(':running')),
      ['preflight:done', 'fetch:done', 'checkout:done', 'server:done', 'plugin:done'], 'a good update: every step done, in order');
    eq(head(), C2, 'the clone is on the commit');
    eq(git(CLONE, 'symbolic-ref', '--short', 'HEAD'), 'main', 'still on its branch, moved forward, not detached');
    eq(lines(join(FIX, 'claude.log')).map((l) => l.args), [['plugin', 'update', 'orchestratinator-floor@appideas-orchestratinator']], 'plugin/ changed, so the plugin is updated');
    assert(r.restarted, 'and last, the host restarts');
    eq(r.last.slice(0, 2), ['host', 'running'], 'saying so before it goes');

    reset(); freshClone(C2);
    health.before = C2;
    health.commit = C3;
    r = await run(C3);
    eq(r.said.find(([s]) => s === 'plugin')?.slice(0, 2), ['plugin', 'skipped'], 'plugin/ the same in both commits: the plugin step is skipped');
    eq(lines(join(FIX, 'claude.log')).length, 0, 'and claude is not asked');

    reset(); freshClone(C1);
    health.commit = C2;
    setMode('plugin', 'missing');
    r = await run(C2);
    assert(r.said.some(([s, st, d]) => s === 'plugin' && st === 'skipped' && /not installed/.test(d)) && r.restarted, 'a plugin not installed on this machine is skipped, and the update goes on');

    reset(); freshClone(C1);
    setMode('plugin', 'fail');
    r = await run(C2);
    assert(r.last[0] === 'plugin' && r.last[1] === 'failed' && /host was not restarted/.test(r.last[2]) && !r.restarted, 'a plugin update that fails stops there and says the host was not restarted');

    // Finish the update (PR #42 finding 1): the clone and the board are at
    // the commit already, the plugin and the host are not.
    reset(); freshClone(C2);
    health.before = C2;
    health.commit = C2;
    r = await run(C2, 'main', { from: C1, finish: true });
    eq(r.said.map(([s, st]) => `${s}:${st}`).filter((x) => !x.endsWith(':running')),
      ['preflight:done', 'fetch:done', 'checkout:done', 'server:skipped', 'plugin:done'], 'finishing: a board already on the commit is not rebuilt');
    assert(/already answers as 1\.0\.1 at /.test(r.said.find(([s]) => s === 'server')[2]), 'and the step says why');
    eq(lines(join(FIX, 'docker.log')).filter((l) => l.args[0] === 'compose').length, 0, 'docker compose is not run at all');
    eq(lines(join(FIX, 'claude.log')).length, 1, 'plugin/ is compared from where the update started, so the plugin is updated');
    assert(r.restarted, 'and the host restarts');
    reset(); freshClone(C2);
    r = await run(C2);
    eq(r.said.find(([s]) => s === 'plugin')?.slice(0, 2), ['plugin', 'skipped'], 'the same run without its starting point compares the clone with itself and would skip the plugin (why finishing carries `from`)');

    stub.close();
  }

  /* ───────── 4. the whole path ───────── */

  console.log('\nthe whole path: Update on the page → the host → a new build:');
  {
    await stopServer();
    rmSync(DB, { force: true });
    for (const f of ['docker.log', 'claude.log', 'compose.flag', 'docker.mode', 'plugin.mode']) rmSync(join(FIX, f), { force: true });
    freshClone(C1);
    writeFileSync(join(FIX, 'container'), CONTAINER + '\n');
    await startServer(C1, { ORCH_UPDATE_TICK_MS: '300000' });
    await admin('check');

    const roots = join(FIX, 'roots');
    mkdirSync(roots, { recursive: true });
    const hostEnv = {
      ...process.env, ORCH_URL: BOARD, ORCH_AUTH_TOKEN: KEY, ORCH_HOST_ROOTS: roots, ORCH_HOST_ID: 'upd-host', ORCH_HOST_NAME: 'Update Mac',
      ORCH_HOST_CONFIG: '/nonexistent/host.json', ORCH_TMUX_SESSION: `orch-update-test-${process.pid}`,
      ORCH_HOST_CLONE: CLONE, ORCH_HOST_DOCKER: join(STAND, 'docker'), ORCH_HOST_CLAUDE: join(STAND, 'claude'),
      ORCH_UPDATE_FETCH_URL: ORIGIN, ORCH_HOST_SUPERVISED: '1', ORCH_UPDATE_HEALTH_TIMEOUT_MS: '20000', ORCH_HOST_HEARTBEAT_MS: '1000',
    };
    const startHost = () => {
      const h = spawn('node', ['host/index.js'], { env: hostEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      h.out = '';
      h.stdout.on('data', (d) => { h.out += d; });
      h.stderr.on('data', (d) => { h.out += d; });
      return h;
    };
    // Another live host, named to sort first, whose clone runs some other
    // container: it must not be the one the board hands the update to.
    const other = () => fetch(`${BOARD}/api/host/register`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestratinator-key': KEY },
      body: JSON.stringify({ host_id: 'aaa-host', name: 'Another Mac', desks: [], protocol: PROTOCOL, build: { commit: C1 }, board_container: 'deadbeef'.repeat(8), supervised: true,
        clone: { path: '/elsewhere', branch: 'main', head: C1, dirty: false, changes: [] } }),
    });
    await other();
    let host = startHost();
    const ready = await until(async () => (await upd()).host, 10000);
    assert(ready, 'the host beside the board\'s container is the one the board names');
    let u = await upd();
    eq([u.host?.name, u.host?.build?.commit, u.host?.clone?.branch], ['Update Mac', C1, 'main'], 'with its build and its clone — not another live host whose clone runs some other container');
    eq(u.refusal, null, 'nothing to refuse');
    eq(page.updateButton(u)?.label, 'Update available', 'the page offers the update');
    const said = page.interruptLines(u);
    assert(/presence blanks for every desk/.test(said[0]) && /host on Update Mac restarts/.test(said[1]) && /hooks they started with/.test(said[2]),
      'and the confirmation names what will be interrupted');

    // Refused at the board, from the host's own report, before anything runs.
    writeFileSync(join(CLONE, 'scratch.txt'), 'mine');
    const dirtySeen = await until(async () => /local changes/.test((await upd()).refusal ?? ''), 6000);
    assert(dirtySeen, 'a clone that becomes dirty is refused on the page before Update is pressed');
    const refused = await admin('start', { commit: C2 });
    eq(refused.status, 409, 'and by the route');
    assert(/local changes \(scratch\.txt\)/.test(refused.body.error), `in the same words ("${refused.body.error}")`);
    rmSync(join(CLONE, 'scratch.txt'));
    await until(async () => (await upd()).refusal === null, 6000);
    const stale = await admin('start', { commit: C1 });
    assert(stale.status === 409 && /not the newest commit/.test(stale.body.error), 'a commit that is not the one offered is refused');

    // When the stand-in docker is asked to build, "rebuild" the board: stop
    // it and start it again as the commit the clone is now on, on the same
    // database — which is what compose does to the container and the volume.
    const rebuilt = (async () => {
      await until(async () => existsSync(join(FIX, 'compose.flag')), 30000);
      await sleep(300);
      await stopServer();
      await startServer(git(CLONE, 'rev-parse', 'HEAD'), { ORCH_UPDATE_TICK_MS: '300000' });
    })();
    await other();
    const started = await admin('start', { commit: C2 });
    eq(started.status, 200, 'Update now is accepted');
    eq([started.body.run.state, started.body.run.commit, started.body.run.from], ['queued', C2, C1], 'as a run from this build to the commit');
    eq(page.updateButton(started.body.update)?.label, 'Updating…', 'the header button becomes the progress');
    eq((await admin('start', { commit: C2 })).status, 409, 'a second press while it runs is refused');
    const exited = await new Promise((r) => { host.once('exit', (code) => r(code)); setTimeout(() => r('timeout'), 40000); });
    eq(exited, 0, 'the host exits cleanly at the end, for launchd to start it again');
    await rebuilt;
    eq((await (await fetch(`${BOARD}/health`)).json()).commit, C2, 'the board answers as the new commit');
    eq(page.reloadsFor(C1, C2, { commit: C2 }), true, 'which is what makes a page loaded from the old build reload itself');
    eq(page.reloadsFor(C2, C2, { commit: C2 }), false, 'and only that page: one loaded from the new build does not reload again');
    eq(page.reloadsFor(C1, C2, null), false, 'nor a page that saw no update (a deploy by hand)');
    u = await upd();
    const before = u.run;
    eq(before.state, 'running', 'the run is open until the host is back');
    assert(before.steps.some((s) => s.step === 'host' && s.state === 'running'), 'at the restart');
    // A host that comes back on the old build (launchd started what was on
    // disk before the checkout, say) has not finished the update.
    await fetch(`${BOARD}/api/host/register`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestratinator-key': KEY },
      body: JSON.stringify({ host_id: 'upd-host', name: 'Update Mac', desks: [], protocol: PROTOCOL, build: { commit: C1 }, board_container: CONTAINER, supervised: true,
        clone: { path: CLONE, branch: 'main', head: C2, dirty: false, changes: [] } }),
    });
    eq((await upd()).run?.state, 'running', 'a host registering on the old build does not close the run');
    host = startHost(); // what launchd does
    const done = await until(async () => ((await upd()).run?.state === 'done' ? await upd() : null), 10000);
    assert(done, 'the host comes back as the new build, and the run is done');
    eq(done?.run.steps.map((s) => `${s.step}:${s.state}`), ['preflight:done', 'fetch:done', 'checkout:done', 'server:done', 'plugin:done', 'host:done'], 'every step, in order');
    eq(page.updateStepRows(done?.run).map((s) => s.state), ['done', 'done', 'done', 'done', 'done', 'done'], 'as the page lists them');
    eq([done?.standing.state, done?.available, page.latestText(done)], ['latest', false, 'You have the latest'], 'and the board reads "You have the latest" with nothing fetched');
    eq(page.updateButton(done), null, 'the header button is gone');
    eq(git(CLONE, 'rev-parse', 'HEAD'), C2, 'the clone is on the commit');
    eq(done?.host?.build?.commit, C2, 'so is the host');
    eq(lines(join(FIX, 'claude.log')).length, 1, 'and the plugin was updated once');
    const log = (await activity()).filter((r) => r.kind.startsWith('admin.update.')).map((r) => r.kind);
    assert(log.includes('admin.update.start') && log.includes('admin.update.done'), `the start and the end are in the activity log (${[...new Set(log)].join(', ')})`);
    host.kill('SIGTERM');
    await new Promise((r) => host.once('exit', r));

    // A run whose host goes silent ends, in words, rather than spinning forever.
    await stopServer();
    rmSync(DB, { force: true });
    freshClone(C1);
    await startServer(C1, { ORCH_UPDATE_TICK_MS: '300000', ORCH_UPDATE_SILENT_MS: '2500' });
    await admin('check');
    host = startHost();
    await until(async () => (await upd()).host && (await upd()).refusal === null, 10000);
    host.kill('SIGKILL');
    await new Promise((r) => host.once('exit', r));
    const s2 = await admin('start', { commit: C2 });
    eq(s2.status, 200, 'an update queued for a host that has just died is accepted (it was live a moment ago)');
    const gave = await until(async () => ((await upd()).run?.state === 'failed' ? (await upd()).run : null), 8000);
    assert(gave && /No word from the host on Update Mac .* never picked the update up/.test(gave.error), `and ends as failed, saying the host never took it ("${gave?.error}")`);

    // The board's updater host run by the desktop app (desktop #289): the
    // page offers no update, Settings says who installs them, and the
    // dialog would be refused in the same words if it were reached.
    await fetch(`${BOARD}/api/host/register`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestratinator-key': KEY },
      body: JSON.stringify({ host_id: 'upd-host', name: 'Update Mac', desks: [], protocol: PROTOCOL, build: { commit: C1, version: '0.12.5' }, board_container: CONTAINER, supervised: true, supervisor: 'app',
        clone: { path: '/app/host', branch: null, head: C1, dirty: false, changes: [] } }),
    });
    const appBoard = await upd();
    eq([appBoard.host?.supervisor, appBoard.available, appBoard.standing.state], ['app', false, 'behind'], 'a newer build exists, the host is the app\'s, and the page is offered nothing');
    eq(page.updateButton(appBoard), null, 'no button in the header');
    assert(/run by the Orchestratinator app/.test(appBoard.refusal ?? ''), `the refusal names the app ("${appBoard.refusal}")`);
    assert(/The Orchestratinator app installs updates on this machine, not this page\.$/.test(page.latestText(appBoard)), `Settings says a newer build exists and who installs it ("${page.latestText(appBoard)}")`);
    eq((await admin('start', { commit: C2 })).status, 409, 'and the route refuses a press');

  console.log('\nan update that stops after the rebuild, and finishing it (PR #42 finding 1):');
  {
    await stopServer();
    rmSync(DB, { force: true });
    for (const f of ['docker.log', 'claude.log', 'compose.flag', 'docker.mode', 'plugin.mode']) rmSync(join(FIX, f), { force: true });
    freshClone(C1);
    setMode('plugin', 'fail');
    await startServer(C1, { ORCH_UPDATE_TICK_MS: '300000' });
    await admin('check');
    let host = startHost();
    await until(async () => (await upd()).host && (await upd()).refusal === null, 10000);
    const rebuilt = (async () => {
      await until(async () => existsSync(join(FIX, 'compose.flag')), 30000);
      await sleep(300);
      await stopServer();
      await startServer(C2, { ORCH_UPDATE_TICK_MS: '300000' });
    })();
    eq((await admin('start', { commit: C2 })).status, 200, 'an update whose plugin step will fail is accepted');
    await rebuilt;
    // Failed, and the host heard from again: the board was replaced a moment
    // ago, and what the host says of itself arrives with its next heartbeat.
    const failed = await until(async () => { const u = await upd(); return u.run?.state === 'failed' && u.host ? u : null; }, 30000);
    eq(failed?.run.steps.map((s) => `${s.step}:${s.state}`), ['preflight:done', 'fetch:done', 'checkout:done', 'server:done', 'plugin:failed'], 'it stops at the plugin, after the board was rebuilt');
    eq([failed?.current.commit, failed?.host?.build?.commit], [C2, C1], 'the board is on the commit; the host, never restarted, is not');
    eq([failed?.standing.state, failed?.available], ['latest', false], 'nothing is newer any more, so nothing is offered');
    eq(failed?.stopped?.id, failed?.run.id, 'but the board names the run as stopped half-way');
    eq(page.updateButton(failed)?.label, 'Update stopped', 'and the header keeps a button for it, the way back into the dialog');
    const said = page.latestText(failed);
    assert(said !== 'You have the latest' && /stopped at "plugin"/.test(said) && said.includes(C1.slice(0, 7)), `Settings does not say "You have the latest" ("${said}")`);
    eq(failed?.refusal, null, 'and finishing it would not be refused');

    // Finish the update, with the board away at the moment the host reports
    // its last two steps (Info 3: the retry before the host exits). The
    // stand-in plugin update takes 2 s; the board goes down as it starts and
    // is back 2.5 s later.
    setMode('plugin', 'slow');
    const blip = (async () => {
      await until(async () => lines(join(FIX, 'claude.log')).length >= 2, 30000);
      await stopServer();
      await sleep(2500);
      await startServer(C2, { ORCH_UPDATE_TICK_MS: '300000' });
    })();
    const fin = await admin('start', { commit: C2 });
    eq([fin.status, fin.body.run?.finishing, fin.body.run?.from], [200, true, C1], 'Finish the update is a run to the same commit, from where the update started');
    const exited = await new Promise((r) => { host.once('exit', (code) => r(code)); setTimeout(() => r('timeout'), 60000); });
    eq(exited, 0, 'the host exits once the board, back again, has its last steps');
    await blip;
    host = startHost(); // what launchd does
    const done = await until(async () => ((await upd()).run?.state === 'done' ? upd() : null), 15000);
    eq(done?.run.steps.map((s) => `${s.step}:${s.state}`), ['preflight:done', 'fetch:done', 'checkout:done', 'server:skipped', 'plugin:done', 'host:done'],
      'finished: the board is not rebuilt again, the plugin is updated, the host restarts and comes back');
    eq(lines(join(FIX, 'docker.log')).filter((l) => l.args[0] === 'compose').length, 1, 'docker compose ran once, for the first run only');
    eq([done?.host?.build?.commit, done?.stopped, page.updateButton(done), page.latestText(done)], [C2, null, null, 'You have the latest'], 'every part on the commit: no button, and now "You have the latest"');
    host.kill('SIGTERM');
    await new Promise((r) => host.once('exit', r));
  }

  console.log('\nthe board\'s own proof of the server step, and a host that comes back late:');
  {
    await stopServer();
    rmSync(DB, { force: true });
    await startServer(C1, { ORCH_UPDATE_TICK_MS: '300000', ORCH_UPDATE_SILENT_MS: '2500' });
    await admin('check');
    // A host played through the board's own doors, so each event is chosen.
    const reg = (commit) => fetch(`${BOARD}/api/host/register`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestratinator-key': KEY },
      body: JSON.stringify({ host_id: 'played', name: 'Played Mac', desks: [], protocol: PROTOCOL, build: { commit }, board_container: CONTAINER, supervised: true,
        clone: { path: '/played', branch: 'main', head: commit, dirty: false, changes: [] } }),
    });
    const ev = (run_id, step, state, detail = null) => fetch(`${BOARD}/api/host/events`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestratinator-key': KEY },
      body: JSON.stringify({ host_id: 'played', events: [{ type: 'update', run_id, step, state, detail }] }),
    });
    await reg(C1);
    const st = await admin('start', { commit: C2 });
    const id = st.body.run?.id;
    const take = async () => (await (await fetch(`${BOARD}/api/host/work?host_id=played&wait=0`, { headers: { 'x-orchestratinator-key': KEY } })).json()).work;
    eq((await take()).map((w) => w.kind), ['update'], 'the played host takes its update');
    for (const s of ['preflight', 'fetch', 'checkout']) await ev(id, s, 'done');
    await ev(id, 'server', 'running');
    // The board is replaced before the host's "server done" reaches it.
    await stopServer();
    await startServer(C2, { ORCH_UPDATE_TICK_MS: '300000', ORCH_UPDATE_SILENT_MS: '2500' });
    const proof = (await upd()).run?.steps.find((s) => s.step === 'server');
    eq([proof?.state, /the board answers as 2/.test(proof?.detail ?? '') || proof?.detail?.includes(C2.slice(0, 7))], ['done', true], 'a board that starts as the run\'s commit marks the server step done itself, with no word from the host');
    await ev(id, 'plugin', 'done');
    await ev(id, 'host', 'running');
    const gaveUp = await until(async () => ((await upd()).run?.state === 'failed' ? upd() : null), 8000);
    assert(gaveUp && /"host" \(running\)/.test(gaveUp.run.error ?? ''), `a host that never comes back: the run ends naming its last step ("${gaveUp?.run.error}")`);
    eq([gaveUp?.stopped?.id, page.updateButton(gaveUp)?.label], [id, 'Update stopped'], 'and stands stopped, with the header\'s button');
    // This played host sends no capabilities, which is what a host from
    // e578070 sends: it would carry a Finish out the old way (PR #42 N1).
    await reg(C1);
    const oldHost = await upd();
    assert(/runs a build from before Finish the update \(/.test(oldHost.refusal ?? ''), `Finish is refused to a host that does not say it can finish ("${oldHost.refusal}")`);
    const tried = await admin('start', { commit: C2 });
    eq([tried.status, tried.body.error === oldHost.refusal], [409, true], 'by the route too, in the same words, with nothing queued');
    eq((await take()).length, 0, 'the played host is handed no work');
    await reg(C2);
    const late = await upd();
    eq([late.run.state, late.stopped, page.updateButton(late), page.latestText(late)], ['done', null, null, 'You have the latest'], 'the host coming back as the commit, late, finishes it');
  }
  }
} catch (err) {
  failures++;
  console.log(`  ✗ ${err.stack}`);
  if (server) console.log(server.out.slice(-3000));
} finally {
  await stopServer();
  ghServer.close();
  try { execFileSync('tmux', ['kill-session', '-t', `orch-update-test-${process.pid}`], { stdio: 'ignore' }); } catch { /* none */ }
  rmSync(FIX, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);

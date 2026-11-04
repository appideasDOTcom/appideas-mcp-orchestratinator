// Issue #40 on the real page: the header's Update button, the Updates
// section in Settings, the confirmation, a refusal, a failed run, a good one,
// and the page reloading itself onto the new build. Self-contained: it starts
// a stand-in GitHub, a server from <dir> (twice — the second as the new
// commit, on the same database, which is what a rebuild is), and plays the
// host through the board's own doors (/api/host/register, /work, /events).
//
//   node --experimental-websocket check-update.mjs <dir> [boardPort=8925] [ghPort=8926] [cdpPort=9275] [shots dir]
//
// Refuses a port anything answers on. About forty seconds.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const [dirArg, bp = '8925', gp = '8926', cp = '9275', shotsArg] = process.argv.slice(2);
const DIR = resolve(dirArg ?? '.');
const PORT = Number(bp); const GH = Number(gp); const CDP = Number(cp);
process.env.ORCH_CDP_PORT = String(CDP);
const { open } = await import(`${DIR}/.claude/skills/verify-ui-change/drive.mjs`);
const BOARD = `http://localhost:${PORT}`;
const KEY = 'k';
const TMP = mkdtempSync(join(tmpdir(), 'check-update-'));
const SHOTS = shotsArg ? resolve(shotsArg) : TMP;
mkdirSync(SHOTS, { recursive: true });
const C1 = '1'.repeat(40); const C2 = '2'.repeat(40); const C3 = '3'.repeat(40);
const CONTAINER = 'feedfacecafe';
const REPO = 'acme/orch';

const taken = async (url) => { try { await fetch(url, { signal: AbortSignal.timeout(800) }); return true; } catch (e) { return e.cause?.code !== 'ECONNREFUSED'; } };
if (await taken(`${BOARD}/health`)) { console.log(`refusing: PORT ${PORT} is taken`); process.exit(2); }
if (await taken(`http://localhost:${GH}/`)) { console.log(`refusing: GitHub port ${GH} is taken`); process.exit(2); }
if (await taken(`http://localhost:${CDP}/json/version`)) { console.log(`refusing: CDP ${CDP} is taken`); process.exit(2); }

let pass = 0; let fail = 0;
const ok = (c, m, got) => { if (c) pass++; else fail++; console.log(`${c ? '✓' : '✗'} ${m}${c || got === undefined ? '' : `  — got ${JSON.stringify(got)}`}`); };

// GitHub: main is C2 ahead of C1; develop is C3 ahead of both.
const gh = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const j = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (u.pathname === `/repos/${REPO}/commits`) {
    const list = { main: [C2, C1], develop: [C3, C2, C1] }[u.searchParams.get('sha')];
    return list ? j(200, list.map((sha, i) => ({ sha, html_url: `https://github.com/${REPO}/commit/${sha}`, commit: { message: i ? 'older' : `Fix the thing (#${sha[0]}0)`, committer: { date: '2026-11-04T12:00:00Z' } } }))) : j(404, {});
  }
  const raw = /\/([0-9a-f]{40})\/package\.json$/.exec(u.pathname);
  if (raw) return j(200, { version: { [C1]: '0.10.18', [C2]: '0.10.19', [C3]: '0.10.20' }[raw[1]] });
  j(404, {});
});
await new Promise((r) => gh.listen(GH, r));

let server = null;
async function startServer(commit) {
  server = spawn('node', ['src/server.js'], {
    cwd: DIR,
    env: { ...process.env, PORT: String(PORT), DB_PATH: join(TMP, 'b.db'), ORCH_AUTH_TOKEN: KEY,
      ORCH_GITHUB_API: `http://localhost:${GH}`, ORCH_GITHUB_RAW: `http://localhost:${GH}`, ORCH_UPDATE_REPO: REPO,
      ORCH_BUILD_COMMIT: commit, ORCH_BOARD_CONTAINER: CONTAINER, ORCH_UPDATE_MIN_GAP_MS: '0', ORCH_UPDATE_TICK_MS: '500' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BOARD}/health`)).ok) return; } catch { /* */ } await sleep(150); }
  throw new Error('server did not start');
}
async function stopServer() { if (!server) return; const s = server; server = null; s.kill('SIGTERM'); await new Promise((r) => (s.exitCode !== null ? r() : s.once('exit', r))); }

// The host, as far as the board can see one.
const host = { commit: C1, dirty: false };
const hostPost = (path, body) => fetch(`${BOARD}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestratinator-key': KEY }, body: JSON.stringify(body) }).catch(() => null);
const register = () => hostPost('/api/host/register', {
  host_id: 'h1', name: 'testbox', desks: [], folders: [], roots: [],
  build: { version: '0.10.18', commit: host.commit }, board_container: CONTAINER, supervised: true, capabilities: ['finish'],
  clone: { path: '/Users/op/orch', branch: 'main', head: host.commit, dirty: host.dirty, changes: host.dirty ? ['src/ui/app.js'] : [] },
});
const beat = setInterval(register, 1000);
const work = async () => (await (await fetch(`${BOARD}/api/host/work?host_id=h1&wait=0`, { headers: { 'x-orchestratinator-key': KEY } })).json()).work;
const step = (run_id, s, state, detail = null) => hostPost('/api/host/events', { host_id: 'h1', events: [{ type: 'update', run_id, step: s, state, detail }] });

let page;
let pop;
try {
  await startServer(C1);
  await register();
  await sleep(1200); // the first automatic check (min(tick, 30 s) after start)
  page = await open({ base: BOARD, view: 'board', port: CDP });
  const ev = (js) => page.evalJs(js);

  console.log('## the header');
  ok(await page.waitFor(`!document.getElementById('update-btn').hidden`, { timeout: 8000 }).then(() => true, () => false), 'an Update available button, with checking on by default and main ahead');
  ok(await ev(`document.getElementById('update-btn').textContent`) === 'Update available', 'reading "Update available"');

  console.log('## Settings');
  await page.click('#open-settings');
  await page.waitFor(`!!document.querySelector('#set-updates')`);
  const facts = JSON.parse(await ev(`JSON.stringify({
    h: document.querySelector('#settings-dlg h3').textContent,
    check: document.querySelector('[data-upd="check"]').checked,
    dev: document.querySelector('[data-upd="dev"]').checked,
    dd: [...document.querySelectorAll('#set-updates dd')].map((d) => d.textContent.trim()),
  })`));
  ok(facts.h === 'Settings', 'the dialog is called Settings', facts.h);
  ok(facts.check === true && facts.dev === false, 'Check for updates on, development version off', facts);
  ok(facts.dd[0] === 'v' + JSON.parse(await (await fetch(`${BOARD}/health`)).text()).version + ' · 1111111', 'Current: version and commit', facts.dd[0]);
  ok(/^v0\.10\.19 · 2222222 — 1 commit newer than this build$/.test(facts.dd[1]), 'Latest: the newer commit', facts.dd[1]);
  ok(facts.dd[2] === 'just now', 'Last checked', facts.dd[2]);
  await page.shot(join(SHOTS, 'settings.png'), '#settings-dlg');

  await ev(`(() => { const b = document.querySelector('[data-upd="check"]'); b.checked = false; b.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  ok(await page.waitFor(`document.getElementById('update-btn').hidden`, { timeout: 5000 }).then(() => true, () => false), 'unticking Check for updates takes the header button away');
  await sleep(3000); // two polls: the redraw must not tick it back
  ok(await ev(`document.querySelector('[data-upd="check"]').checked`) === false, 'and the box stays unticked across polls (the setting is the board\'s)');
  const st = await (await fetch(`${BOARD}/api/state`)).json();
  ok(st.update.check === false, 'the board has it off', st.update.check);
  await page.click('[data-upd="checknow"]');
  await page.waitFor(`!document.querySelector('[data-upd="checknow"]').disabled`);
  ok(await ev(`document.getElementById('update-btn').hidden`) === true, 'Check now works with checking off, and still no header button');
  await ev(`(() => { const b = document.querySelector('[data-upd="dev"]'); b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  ok(await page.waitFor(`/Not checked on develop yet/.test(document.querySelector('#set-updates').textContent)`, { timeout: 5000 }).then(() => true, () => false), 'the development version, with checking off, is not checked by itself');
  await ev(`(() => { const b = document.querySelector('[data-upd="check"]'); b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await page.click('[data-upd="checknow"]');
  ok(await page.waitFor(`/v0\\.10\\.20 · 3333333/.test(document.querySelector('#set-updates').textContent)`, { timeout: 5000 }).then(() => true, () => false), 'Check now on develop finds develop\'s newest');
  await ev(`(() => { const b = document.querySelector('[data-upd="dev"]'); b.checked = false; b.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  ok(await page.waitFor(`/v0\\.10\\.19 · 2222222/.test(document.querySelector('#set-updates').textContent) && !document.getElementById('update-btn').hidden`, { timeout: 5000 }).then(() => true, () => false), 'back on main, checked at once, and the button is back');
  await page.click('[data-set="close"]');

  console.log('## the confirmation');
  await page.click('#update-btn');
  await page.waitFor(`document.getElementById('update-dlg').open`);
  const conf = JSON.parse(await ev(`JSON.stringify({
    h: document.querySelector('#upd-body h3').textContent,
    lis: [...document.querySelectorAll('#upd-body .upd-int li')].map((l) => l.textContent),
    btn: !!document.querySelector('#upd-body [data-upd="start"]:not([disabled])'),
  })`));
  ok(conf.h === 'Update to v0.10.19 · 2222222', 'it names the build', conf.h);
  ok(conf.lis.length === 3 && /presence blanks/.test(conf.lis[0]) && /host on testbox restarts/.test(conf.lis[1]) && /plugin/.test(conf.lis[2]), 'and what will be interrupted', conf.lis);
  ok(conf.btn, 'with an Update now button');
  await page.shot(join(SHOTS, 'confirm.png'), '#update-dlg');
  host.dirty = true; await register();
  ok(await page.waitFor(`/local changes \\(src\\/ui\\/app\\.js\\)/.test(document.querySelector('#upd-body').textContent) && !document.querySelector('#upd-body [data-upd="start"]')`, { timeout: 6000 }).then(() => true, () => false), 'a clone that turns dirty: the refusal in words, and no Update now');
  host.dirty = false; await register();
  await page.waitFor(`!!document.querySelector('#upd-body [data-upd="start"]')`, { timeout: 6000 });

  console.log('## a failed update');
  await page.click('#upd-body [data-upd="start"]');
  await page.waitFor(`/Updating to/.test(document.querySelector('#upd-body h3').textContent)`);
  ok(await ev(`document.getElementById('update-btn').textContent`) === 'Updating…', 'the header button becomes the progress');
  const [w1] = await work();
  ok(w1?.kind === 'update' && w1.payload.commit === C2 && w1.payload.branch === 'main', 'one update work item for the host, to the offered commit', w1);
  await step(w1.payload.run_id, 'preflight', 'done', 'clean');
  await step(w1.payload.run_id, 'fetch', 'done');
  await step(w1.payload.run_id, 'checkout', 'done');
  await step(w1.payload.run_id, 'server', 'failed', 'docker compose up -d --build exited 1: failed to solve: boom. The board is still the build it was. The clone is back on 1111111.');
  ok(await page.waitFor(`/The update stopped/.test(document.querySelector('#upd-body h3').textContent)`, { timeout: 6000 }).then(() => true, () => false), 'a failed step: "The update stopped"');
  const failed = JSON.parse(await ev(`JSON.stringify({
    err: document.querySelector('#upd-body .set-err')?.textContent,
    steps: [...document.querySelectorAll('#upd-body .upd-step')].map((li) => li.className.replace('upd-step ', '')),
    again: !!document.querySelector('#upd-body [data-upd="start"]'),
    btn: document.getElementById('update-btn').textContent,
  })`));
  ok(/^server: docker compose up -d --build exited 1: failed to solve: boom/.test(failed.err ?? ''), 'naming the step and why', failed.err);
  ok(JSON.stringify(failed.steps) === JSON.stringify(['done', 'done', 'done', 'failed', 'pending', 'pending']), 'the steps as far as they got', failed.steps);
  ok(failed.again && failed.btn === 'Update available', 'and the update is still offered', failed);
  await page.shot(join(SHOTS, 'failed.png'), '#update-dlg');

  console.log('## a good update, and the page reloading itself');
  await page.click('#upd-body [data-upd="start"]');
  await page.waitFor(`/Updating to/.test(document.querySelector('#upd-body h3').textContent)`);
  const [w2] = await work();
  for (const s of ['preflight', 'fetch', 'checkout']) await step(w2.payload.run_id, s, 'done');
  await step(w2.payload.run_id, 'server', 'running', 'docker compose up -d --build');
  await page.waitFor(`document.querySelectorAll('#upd-body .upd-step.running').length === 1`, { timeout: 6000 });
  await page.shot(join(SHOTS, 'running.png'), '#update-dlg');
  await ev(`window.__beforeReload = 1`);
  // A desk's popout (#19) is this page too, on the old build: it must watch
  // the update and reload onto the new one, at its own address.
  const POP = `${BOARD}/?popout=1&channel=lab&agent=bo`;
  pop = await open({ base: POP, ready: `document.readyState === 'complete'`, port: CDP });
  ok(await pop.waitFor(`typeof upd !== 'undefined' && upd.watching?.commit === ${JSON.stringify(C2)}`, { timeout: 8000 }).then(() => true, () => false), 'a popout open during the update watches it too');
  await pop.evalJs(`window.__beforeReload = 1`);
  await stopServer();
  ok(await page.waitFor(`/The board is away/.test(document.querySelector('#upd-body').textContent)`, { timeout: 8000 }).then(() => true, () => false), 'with the board gone, the dialog says so and that the page will reload');
  host.commit = C1;
  await startServer(C2);
  ok(await page.waitFor(`window.__beforeReload === undefined && document.readyState === 'complete'`, { timeout: 12000 }).then(() => true, () => false), 'the page reloads itself once the board answers as the new commit');
  await ev(`window.__afterReload = 1`);
  ok(await pop.waitFor(`window.__beforeReload === undefined && document.readyState === 'complete' && new URLSearchParams(location.search).get('popout') === '1'`, { timeout: 12000 }).then(() => true, () => false), 'the popout reloads itself onto the new build, as the same popout');
  // Closed here because, while its tab is the one in front, the floor's tab
  // is document.hidden and its background poll stands still (app.js tick).
  await pop.close(); pop = null;
  await page.waitFor(`!document.getElementById('update-btn').hidden`, { timeout: 6000 }).catch(() => {});
  ok(await ev(`document.getElementById('update-btn').textContent`) === 'Updating…', 'after the reload the run is still open (the host has not restarted yet)');
  ok(await ev(`document.getElementById('version').textContent`) === 'v' + JSON.parse(await (await fetch(`${BOARD}/health`)).text()).version, 'and the header names the build that answered');
  await sleep(3500);
  ok(await ev(`window.__afterReload`) === 1, 'it reloads once, not again and again (a marker set after the reload is still there 3.5 s on)');

  console.log('## a failure after the rebuild, and Finish the update (PR #42 finding 1)');
  await step(w2.payload.run_id, 'plugin', 'failed', 'claude plugin update exited 2: boom. The board is on 2222222; the host was not restarted and runs the code it started with.');
  ok(await page.waitFor(`document.getElementById('update-btn').textContent === 'Update stopped' && !document.getElementById('update-btn').hidden`, { timeout: 8000 }).then(() => true, () => false), 'the plugin failing past the rebuild leaves an "Update stopped" button in the header');
  await page.click('#open-settings');
  await page.waitFor(`!!document.querySelector('#set-updates')`);
  const latestNow = await ev(`[...document.querySelectorAll('#set-updates dd')][1].textContent.trim()`);
  ok(latestNow !== 'You have the latest' && /stopped at "plugin"/.test(latestNow) && /host runs 1111111/.test(latestNow), 'Settings does not say "You have the latest"', latestNow);
  await page.click('[data-set="close"]');
  await page.click('#update-btn');
  await page.waitFor(`document.getElementById('update-dlg').open`);
  const stoppedDlg = JSON.parse(await ev(`JSON.stringify({
    h: document.querySelector('#upd-body h3').textContent,
    err: document.querySelector('#upd-body .set-err')?.textContent,
    text: document.querySelector('#upd-body').textContent,
    steps: [...document.querySelectorAll('#upd-body .upd-step')].map((li) => li.className.replace('upd-step ', '')),
    finish: !!document.querySelector('#upd-body [data-upd="start"][data-commit="${C2}"]:not([disabled])'),
  })`));
  ok(stoppedDlg.h === 'The update stopped' && /^plugin: claude plugin update exited 2/.test(stoppedDlg.err ?? ''), 'the dialog says which step stopped and why', stoppedDlg.h);
  ok(/The board is on v0\.10\.19 · 2222222\. The host on testbox runs 1111111, the build the update started from\./.test(stoppedDlg.text), 'and what is on which build', stoppedDlg.text.slice(0, 300));
  ok(JSON.stringify(stoppedDlg.steps) === JSON.stringify(['done', 'done', 'done', 'done', 'failed', 'pending']), 'with the steps as far as they got', stoppedDlg.steps);
  ok(stoppedDlg.finish, 'and a Finish the update button');
  await page.shot(join(SHOTS, 'stopped.png'), '#update-dlg');
  await page.click('#upd-body [data-upd="start"]');
  await page.waitFor(`/Updating to/.test(document.querySelector('#upd-body h3').textContent)`, { timeout: 6000 });
  const [w3] = await work();
  ok(w3?.kind === 'update' && w3.payload.commit === C2 && w3.payload.finish === true && w3.payload.from === C1, 'Finish queues the same commit, marked as a finish, from where the update started', w3?.payload);
  for (const s of ['preflight', 'fetch', 'checkout']) await step(w3.payload.run_id, s, 'done');
  await step(w3.payload.run_id, 'server', 'skipped', 'the board already answers as 0.10.19 at 2222222');
  await step(w3.payload.run_id, 'plugin', 'done', 'updated');
  await step(w3.payload.run_id, 'host', 'running', 'restarting the host');
  host.commit = C2; await register();
  ok(await page.waitFor(`document.getElementById('update-btn').hidden`, { timeout: 8000 }).then(() => true, () => false), 'the host back as the new build closes the run and the button goes');
  await page.click('#open-settings');
  await page.waitFor(`!!document.querySelector('#set-updates')`);
  ok(await ev(`[...document.querySelectorAll('#set-updates dd')][1].textContent.trim()`) === 'You have the latest', 'Settings: You have the latest');
  ok((await ev(`[...document.querySelectorAll('#set-updates dd')][0].textContent.trim()`)).endsWith('2222222'), 'Current is the new commit');
  await page.shot(join(SHOTS, 'latest.png'), '#settings-dlg');
  const log = await (await fetch(`${BOARD}/api/activity?limit=100`)).json();
  const kinds = [...new Set(log.rows.map((r) => r.kind).filter((k) => k.startsWith('admin.update.')))];
  ok(['admin.update.settings', 'admin.update.check', 'admin.update.start', 'admin.update.failed', 'admin.update.done'].every((k) => kinds.includes(k)), 'settings, checks, starts, the failure and the finish are all in the activity log', kinds);
} catch (err) {
  fail++;
  console.log(`✗ ${err.stack}`);
} finally {
  clearInterval(beat);
  try { await page?.close(); } catch { /* */ }
  try { await pop?.close(); } catch { /* */ }
  await stopServer();
  gh.close();
  rmSync(join(TMP, 'b.db'), { force: true });
}
console.log(`${fail ? 'FAIL' : 'PASS'} · ${pass} of ${pass + fail} · shots in ${SHOTS}`);
process.exit(fail ? 1 : 0);

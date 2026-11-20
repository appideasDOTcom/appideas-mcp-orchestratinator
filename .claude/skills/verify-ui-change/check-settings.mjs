#!/usr/bin/env node
/**
 * Every setting behind the ⚙ (costmo, 2026-11-19), and the same sections as
 * a page of their own for the desktop app's Settings pane.
 *
 *   run-check-settings.sh <dir>       # the whole fixture; see there
 *
 * Two boards: <base>, a board as Docker runs it (no seed: an empty board is
 * enough to export and restore), and <appBase>, one started with
 * ORCH_BOARD_SUPERVISOR=app, as the app runs its own.
 *
 * What a person does and reads. In a browser: the header has no auto-refresh
 * switch any more, ↻ stays, and ⚙ opens Settings with Auto-refresh first and
 * every section in its paragraphs. Auto-refresh turned off in one tab stops
 * the poll in another tab at once, and on again starts it. `?settings=1` is
 * the sections alone, titled Settings, with nothing of the floor polled, and
 * Export and Restore work there (their handlers used to be on the dialog).
 * In the app (its user-agent token): ⚙ opens a `?settings=1` window, which
 * the app turns into its pane, and opens no dialog; the sections are labels
 * and controls, the restore warning and facts kept, Open new floors left
 * out. On the app's own board: no Updates section and no Update button.
 * The rule for the stored value is in test/floor.mjs ("auto-refresh"); the
 * server's refusals are test/update.mjs's.
 */
import { open, targets } from './drive.mjs';

const base = process.argv[2] ?? 'http://localhost:8955';
const appBase = process.argv[3] ?? 'http://localhost:8995';
const shots = process.argv[4] ?? '/tmp';
const APP_UA = `Object.defineProperty(navigator, 'userAgent', { value: navigator.userAgent + ' Electron/45.2.3 OrchestratinatorDesktop/0.14.0', configurable: true })`;
// Counts each window's polls of /api/state and /api/floor, from before the page's own scripts run.
const COUNT = `(() => { const f = window.fetch; window.__polls = { state: 0, floor: 0 };
  window.fetch = function (u, ...a) { const s = String(u);
    if (/api\\/state/.test(s)) window.__polls.state++;
    if (/api\\/floor(\\?|$)/.test(s)) window.__polls.floor++;
    return f.call(this, u, ...a); }; })()`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
let total = 0;
const ok = (cond, msg, extra = '') => { total++; console.log(`  ${cond ? '✓' : '✗'} ${msg}${cond || !extra ? '' : `  (${extra})`}`); if (!cond) fails++; };
const stopped = (e) => { total++; fails++; console.log(`  ✗ the check stopped on: ${String(e?.message ?? e).split('\n')[0]}`); console.log(`\nFAIL · ${fails} of ${total} red`); process.exit(1); };
process.on('uncaughtException', stopped);
process.on('unhandledRejection', stopped);

const until = (page, expr, what, timeout = 10000) => page.waitFor(expr, { timeout })
  .catch(async () => { throw new Error(`${what} — not in ${timeout / 1000} s; body: ${String(await page.evalJs(`document.body.innerText.slice(0, 300)`)).replace(/\s+/g, ' ')}`); });
const sections = (page) => page.evalJs(`JSON.stringify([...document.querySelectorAll('#set-body > .set-tool, #set-body > #set-updates')]
  .map((s) => s.id || s.querySelector('.set-h')?.textContent.trim() || '(empty)'))`).then(JSON.parse);
const prose = (page) => page.evalJs(`[...document.querySelectorAll('#set-body p:not(.set-warn):not([hidden])')].filter((p) => p.textContent.trim()).length`);
const polls = (page) => page.evalJs(`JSON.stringify(window.__polls)`).then(JSON.parse);
const visible = (page, sel) => page.evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'; })()`);

console.log('\na browser: the header, and ⚙');
const a = await open({ base, view: 'board' });
ok(!(await a.evalJs(`!!document.querySelector('header #autorefresh, header .switch')`)), 'the header has no auto-refresh switch any more');
ok(await visible(a, '#refresh-now') && await visible(a, '#open-settings'), '↻ and ⚙ are still in it');
await a.click('#open-settings');
await until(a, `document.getElementById('settings-dlg').open && !!document.querySelector('#set-auto')`, 'Settings opens with Auto-refresh in it');
let s = await sections(a);
ok(s[0] === 'set-auto', 'Auto-refresh is the first row in Settings', JSON.stringify(s));
ok(s.includes('set-floors') && s.includes('set-updates') && s.includes('Export a backup') && s.includes('Recover from a backup'),
  'and every section the dialog had is still there', JSON.stringify(s));
ok(await prose(a) >= 6, 'the browser keeps its paragraphs', String(await prose(a)));
ok(await a.evalJs(`document.querySelector('#autorefresh').checked`), 'a fresh browser has auto-refresh on, as the switch did');
await a.shot(`${shots}/settings-dialog.png`, '#settings-dlg', { scale: 1 });

console.log('\nauto-refresh, across two tabs');
const b = await open({ base, view: 'board' });
await b.beforeLoad(COUNT);
await b.goto(base);
await until(b, `!!document.querySelector('main .empty, .channel')`, 'the second tab draws');
let p0 = await polls(b);
await sleep(3500);
let p1 = await polls(b);
ok(p1.state > p0.state, 'the second tab polls while it is on', JSON.stringify([p0, p1]));
await a.click('#autorefresh');
ok(await a.evalJs(`localStorage.getItem('orch.autoRefresh')`) === 'off', 'turned off in the first tab, it is kept as off');
await sleep(600);
p0 = await polls(b);
await sleep(6000);
p1 = await polls(b);
ok(p1.state === p0.state, 'and the second tab stops polling at once, with nothing pressed there', JSON.stringify([p0, p1]));
await b.click('#refresh-now');
await sleep(500);
ok((await polls(b)).state > p1.state, '↻ still refreshes it by hand');
await a.click('#autorefresh');
await sleep(600);
p0 = await polls(b);
await sleep(3500);
p1 = await polls(b);
ok(p1.state > p0.state, 'on again in the first tab, the second polls again', JSON.stringify([p0, p1]));
await b.goto(base);
await a.click('#autorefresh');      // off, then a fresh page reads it
await b.goto(base);
await until(b, `!!document.querySelector('main .empty, .channel')`, 'the second tab draws again');
await b.click('#open-settings');
await until(b, `!!document.querySelector('#autorefresh')`, 'its Settings opens');
ok(!(await b.evalJs(`document.querySelector('#autorefresh').checked`)), 'a page loaded while it is off shows it off');
p0 = await polls(b);
await sleep(4000);
ok((await polls(b)).state === p0.state, 'and does not poll', JSON.stringify([p0, await polls(b)]));
await a.click('#autorefresh');
await sleep(300);
ok(await b.evalJs(`document.querySelector('#autorefresh').checked`), 'an open Settings follows a change made in another tab');
await a.evalJs(`document.getElementById('settings-dlg').close(); 1`);

console.log('\nthe settings page, in a browser');
const sp = await open({ base });
await sp.beforeLoad(COUNT);
await sp.goto(`${base}/?settings=1`);
await until(sp, `!!document.querySelector('#set-page #set-auto')`, 'the settings page draws its sections');
ok(await sp.evalJs(`document.title`) === 'Settings', 'it is titled Settings', await sp.evalJs(`document.title`));
ok(!(await visible(sp, 'header')) && !(await visible(sp, '#floor')) && !(await visible(sp, '#channels')), 'no header, floor or board on it');
ok(!(await sp.evalJs(`!!document.querySelector('#set-page [data-set="close"]')`)), 'and no close button: it is a page, not a dialog');
s = await sections(sp);
ok(JSON.stringify(s) === JSON.stringify(['set-auto', 'set-floors', 'set-updates', 'Export a backup', 'Recover from a backup']), 'the same sections as the dialog, in its order', JSON.stringify(s));
await sleep(3000);
const sp1 = await polls(sp);
ok(sp1.floor === 0 && sp1.state >= 1, 'it polls /api/state and nothing of the floor', JSON.stringify(sp1));
ok(await sp.evalJs(`location.search`) === '?settings=1', 'and keeps its own address', await sp.evalJs(`location.search`));
ok(await sp.evalJs(`document.querySelector('#set-page').scrollHeight > 0 && getComputedStyle(document.body).overflowY !== 'hidden'`), 'the page scrolls itself');

await sp.click('[data-set="export"]');
await until(sp, `/^saved /.test(document.querySelector('.set-note-live')?.textContent ?? '')`, 'Export on the settings page saves a file');
ok(true, `Export works on the page: "${await sp.evalJs(`document.querySelector('.set-note-live').textContent`)}"`);
const backup = await (await fetch(`${base}/api/admin/backup`)).text();
await sp.evalJs(`chooseBackupFile(new File([${JSON.stringify(backup)}], 'scratch-backup.json')); 1`);
await until(sp, `!!document.querySelector('#restore-confirm')`, 'a chosen file asks for RESTORE');
await sleep(3000);   // a poll or two: the chosen file and the field must survive them
ok(await sp.evalJs(`document.querySelector('.set-file-head')?.textContent`) === 'scratch-backup.json', 'the chosen file survives the page\'s polls');
await sp.evalJs(`document.querySelector('#restore-confirm').value = 'RESTORE'; 1`);
await sp.click('[data-set="restore"]');
await until(sp, `/Restored \\d+ rows/.test(document.querySelector('.set-done')?.textContent ?? '')`, 'Restore on the settings page restores');
ok(true, `Restore works on the page: "${await sp.evalJs(`document.querySelector('.set-done b').textContent`)}"`);
await sp.shot(`${shots}/settings-page.png`, null, { full: true });

console.log('\nthe desktop app: ⚙ and its pane');
const fw = await open({ base });
await fw.beforeLoad(APP_UA);
await fw.goto(`${base}/?floor=`);
await until(fw, `!!document.querySelector('#floor-rooms .room, #floor-rooms .q-empty')`, 'an app window draws its floor');
ok(await visible(fw, '#open-settings'), 'the ⚙ is in an app window\'s header (costmo: it opens the app\'s pane)');
// Counted, not matched by address: the settings page above is still open at the same address.
const settingsTabs = async () => (await targets()).filter((u) => u.startsWith(base) && /[?&]settings=1/.test(u));
const before = (await settingsTabs()).length;
await fw.press('#open-settings');
let opened = null;
for (let i = 0; i < 50 && !opened; i++) { const now = await settingsTabs(); opened = now.length > before ? now[now.length - 1] : null; if (!opened) await sleep(100); }
ok(!!opened && opened.startsWith(base), 'it asks for the settings page as a new window, which the app turns into its pane', String(opened));
ok(!(await fw.evalJs(`document.getElementById('settings-dlg').open`)), 'and opens no dialog of the board\'s');

const pane = await open({ base });
await pane.beforeLoad(APP_UA);
await pane.goto(`${base}/?settings=1`);
await until(pane, `!!document.querySelector('#set-page #set-auto')`, 'the app\'s pane page draws');
s = await sections(pane);
ok(!s.includes('set-floors'), 'Open new floors is left out: the app\'s own row has it', JSON.stringify(s));
ok(s.includes('set-updates') && s.includes('Export a backup') && s.includes('Recover from a backup'), 'a Docker board seen from the app keeps Updates, Export and Recover', JSON.stringify(s));
ok(await prose(pane) === 0, 'labels and controls only: no paragraphs', String(await prose(pane)));
ok(/Replaces everything on this board/.test(await pane.evalJs(`document.querySelector('.set-warn')?.textContent ?? ''`)), 'but the restore\'s warning stays');
ok(!(await pane.evalJs(`!!document.querySelector('#set-updates .set-check .muted')`)), 'the update rows are their labels', await pane.evalJs(`document.querySelector('#set-updates')?.innerText`));
ok(/Every window/.test(await pane.evalJs(`document.querySelector('#set-auto label')?.textContent ?? ''`)), 'auto-refresh says it reaches every window');
await pane.evalJs(`chooseBackupFile(new File([${JSON.stringify(backup)}], 'scratch-backup.json')); 1`);
await until(pane, `!!document.querySelector('#restore-confirm')`, 'a chosen file in the pane');
ok(/taken[\s\S]*from v/.test(await pane.evalJs(`document.querySelector('.set-file')?.textContent ?? ''`)), 'what the chosen file holds is still said');
await pane.shot(`${shots}/settings-pane-app.png`, null, { full: true });
// A change in the pane reaches an app window, as it would through the shared session.
await fw.beforeLoad(COUNT);
await fw.goto(`${base}/?floor=`);
await until(fw, `!!document.querySelector('#floor-rooms .room, #floor-rooms .q-empty')`, 'the app window again');
await pane.click('#autorefresh');
await sleep(600);
p0 = await polls(fw);
await sleep(4000);
ok((await polls(fw)).state === p0.state, 'auto-refresh turned off in the pane stops an app window\'s poll', JSON.stringify([p0, await polls(fw)]));
await pane.click('#autorefresh');

console.log('\nthe app\'s own board (ORCH_BOARD_SUPERVISOR=app)');
const own = await open({ base: appBase });
await own.beforeLoad(APP_UA);
await own.goto(`${appBase}/?settings=1`);
await until(own, `!!document.querySelector('#set-page #set-auto')`, 'its settings page draws');
await sleep(1500);
s = await sections(own);
ok(!s.includes('set-updates') || await own.evalJs(`document.querySelector('#set-updates').children.length === 0`), 'no Updates section on the app\'s own board', JSON.stringify(s));
ok(s.includes('Export a backup') && s.includes('Recover from a backup'), 'Export and Recover are there', JSON.stringify(s));
const ob = await open({ base: appBase, view: 'board' });
await sleep(1000);
ok(!(await visible(ob, '#update-btn')), 'and no Update button in its header');
await ob.click('#open-settings');
await until(ob, `document.getElementById('settings-dlg').open && !!document.querySelector('#set-auto')`, 'a browser on it opens the ⚙ dialog');
s = await sections(ob);
ok(!s.includes('set-updates') || await ob.evalJs(`document.querySelector('#set-updates').children.length === 0`), 'in a browser too: its ⚙ dialog has no Updates', JSON.stringify(s));

console.log(`\n${fails ? 'FAIL' : 'PASS'} · ${total - fails} of ${total}`);
process.exit(fails ? 1 : 0);

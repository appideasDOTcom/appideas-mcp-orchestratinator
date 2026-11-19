#!/usr/bin/env node
/**
 * Several floors at once, a tab or window each (costmo, 2026-11-19, task
 * 315). On seed-archive.mjs's three floors (alpha, beta, solo-only).
 *
 *   run-check-floor-windows.sh <dir>       # the whole fixture; see there
 *
 * What a person does and reads: the title names the floor a tab stands on
 * (first, so a cut-off tab still shows it), and follows a pick, the board
 * view, and a floor put away under it; the address carries the floor, so a
 * reload lands on this tab's floor and not on the one another tab picked
 * last; a plain click on a chip stays in the tab; the ⧉ opens the floor in
 * a new tab, ⌘-click and middle-click on a chip open it elsewhere, and none
 * of them moves the tab they were pressed in. A bare address still means
 * the stored choice. The rules are in test/floor.mjs ("floor windows");
 * this is the page. Every press here is real input (`press()`), because a
 * browser opens a window only on one.
 */
import { open, attach, targets } from './drive.mjs';

const base = process.argv[2] ?? 'http://localhost:8948';
const shots = process.argv[3] ?? '/tmp';
const T = (head) => `${head} · orchestratinator`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
let total = 0;
const ok = (cond, msg, extra = '') => { total++; console.log(`  ${cond ? '✓' : '✗'} ${msg}${cond || !extra ? '' : `  (${extra})`}`); if (!cond) fails++; };
const stopped = (e) => { total++; fails++; console.log(`  ✗ the check stopped on: ${String(e?.message ?? e).split('\n')[0]}`); console.log(`\nFAIL · ${fails} of ${total} red`); process.exit(1); };
process.on('uncaughtException', stopped);
process.on('unhandledRejection', stopped);

const api = (path, body) => fetch(`${base}/api/admin/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.status);
const read = (page) => page.evalJs(`JSON.stringify({
  title: document.title,
  search: location.search,
  rooms: [...document.querySelectorAll('#floor-rooms svg.room')].map((r) => r.dataset.channel),
  on: [...document.querySelectorAll('#floor-pick a.chip.on')].map((a) => a.dataset.floor),
  stored: (() => { try { return localStorage.getItem('orch.floor'); } catch { return null; } })(),
  board: !document.body.classList.contains('view-floor'),
  opener: window.opener === null ? null : 'has one',
})`).then(JSON.parse);
const until = (page, expr, what) => page.waitFor(expr, { timeout: 10000 })
  .catch(async () => { throw new Error(`${what} — not in 10 s; the page reads ${JSON.stringify(await read(page))}`); });
const floorsOpen = async () => (await targets()).filter((u) => u.startsWith(base) && !/popout=|meeting=/.test(u));
const newTarget = async (before, what) => {
  for (let i = 0; i < 50; i++) {
    const now = await floorsOpen();
    const fresh = now.filter((u) => !before.includes(u) || now.filter((x) => x === u).length > before.filter((x) => x === u).length);
    if (fresh.length) return fresh[0];
    await sleep(100);
  }
  throw new Error(`${what}: no new tab within 5 s; open: ${JSON.stringify(await floorsOpen())}`);
};

console.log('\nthe building, then a floor picked with a plain click');
const page = await open({ base, view: 'floor', floor: '' });
await until(page, `document.querySelectorAll('#floor-rooms svg.room').length === 3`, 'the fixture: three floors in the building');
let f = await read(page);
ok(f.title === T('All floors'), 'the building is titled All floors, first', f.title);
ok(f.search === '?floor=', 'and its address says so: ?floor=', f.search);
const chips = await page.evalJs(`JSON.stringify([...document.querySelectorAll('#floor-pick a.chip')].map((a) => [a.dataset.floor, a.getAttribute('href'), !!a.closest('.fchip')?.querySelector('[data-floor-pop]')]))`).then(JSON.parse);
ok(JSON.stringify(chips) === JSON.stringify([['', '?floor=', false], ['alpha', '?floor=alpha', true], ['beta', '?floor=beta', true], ['solo-only', '?floor=solo-only', true]]),
  'each chip is a link to its floor, and each floor\'s has a ⧉ beside it', JSON.stringify(chips));
const tip = await page.evalJs(`document.querySelector('[data-floor-pop="beta"]')?.title ?? null`);
ok(tip === 'Open beta in a new tab', 'the ⧉ says what it does: In tabs is the default (costmo, 2026-11-19)', tip);
await page.shot(`${shots}/floor-pick.png`, '#floor-pick', { scale: 2 });

let before = await floorsOpen();
await page.evalJs(`window.__orchMark = 'still this page'; 1`);
await page.press('#floor-pick a.chip[data-floor="alpha"]');
await until(page, `document.querySelectorAll('#floor-rooms svg.room').length === 1`, 'a plain click on alpha rides to it');
f = await read(page);
ok(f.rooms.join() === 'alpha' && f.title === T('alpha'), 'a plain click rides to alpha in this tab, and the title follows', JSON.stringify(f));
ok(f.search === '?floor=alpha' && f.stored === 'alpha', 'the address names it, and the stored choice is still written for a fresh open', JSON.stringify([f.search, f.stored]));
await sleep(400);
ok((await floorsOpen()).length === before.length, 'and it opened nothing', JSON.stringify(await floorsOpen()));
// A link followed would land on alpha too, by a reload: the panel, a draft
// and the scroll gone for a click that only means "ride there".
ok(await page.evalJs(`window.__orchMark === 'still this page'`), 'nor followed the link: the page was not reloaded');

console.log('\nanother tab picks another floor; this one reloads');
await page.evalJs(`localStorage.setItem('orch.floor', 'beta'); 1`);
await page.goto(await page.evalJs('location.href'));
await until(page, `document.querySelectorAll('#floor-rooms svg.room').length === 1 && document.title !== 'orchestratinator'`, 'the reload drew a floor');
f = await read(page);
ok(f.rooms.join() === 'alpha' && f.title === T('alpha'), 'a reload lands on this tab\'s floor, not the one picked last in another tab', JSON.stringify(f));

console.log('\nthe ⧉ opens beta in a new tab, and this tab stays on alpha');
await page.press('#floor-pick [data-floor=""]');
await until(page, `document.querySelectorAll('#floor-rooms svg.room').length === 3`, 'back to the building to reach the chips');
before = await floorsOpen();
await page.press('#floor-pick [data-floor-pop="beta"]');
const betaUrl = await newTarget(before, 'the ⧉ on beta');
ok(/\?floor=beta$/.test(betaUrl), 'a new tab, on beta', betaUrl);
const beta = await attach((u) => u === betaUrl);
await until(beta, `document.querySelectorAll('#floor-rooms svg.room').length === 1`, 'the new tab drew a floor');
let b = await read(beta);
ok(b.rooms.join() === 'beta' && b.title === T('beta'), 'it stands on beta, titled beta', JSON.stringify(b));
ok(b.opener === null, 'and it is a peer of the tab it came from, not its child (no opener)', b.opener);
const [pageWin, betaWin] = [await page.windowId(), await beta.windowId()];
ok(pageWin !== null && pageWin === betaWin, 'a tab: in the same browser window as the one it came from', JSON.stringify([pageWin, betaWin]));
f = await read(page);
ok(f.rooms.length === 3 && f.title === T('All floors'), 'the tab it was pressed in did not move', JSON.stringify(f));

console.log('\n⌘-click and middle-click on a chip are the browser\'s');
before = await floorsOpen();
await page.press('#floor-pick a.chip[data-floor="solo-only"]', undefined, { modifiers: 4 });
const soloUrl = await newTarget(before, '⌘-click on solo-only');
ok(/\?floor=solo-only$/.test(soloUrl), '⌘-click opens solo-only in a new tab', soloUrl);
f = await read(page);
ok(f.rooms.length === 3, 'and leaves this tab where it was', JSON.stringify(f.rooms));
before = await floorsOpen();
await page.press('#floor-pick a.chip[data-floor="alpha"]', undefined, { button: 'middle' });
const midUrl = await newTarget(before, 'middle-click on alpha');
ok(/\?floor=alpha$/.test(midUrl), 'middle-click opens alpha in a new tab', midUrl);
f = await read(page);
ok(f.rooms.length === 3, 'and leaves this tab where it was too', JSON.stringify(f.rooms));

console.log('\nthe board view, and a floor put away under a tab');
await beta.press('#view-switch .chip[data-view="board"]');
await until(beta, `!document.body.classList.contains('view-floor')`, 'beta\'s tab went to the board view');
b = await read(beta);
ok(b.title === T('Board') && b.search === '?floor=beta&view=board', 'the board view is titled Board, and its address keeps the floor beside view=board', JSON.stringify([b.title, b.search]));
await beta.goto(await beta.evalJs('location.href'));
await until(beta, `document.readyState === 'complete' && document.title === ${JSON.stringify(T('Board'))}`, 'beta reloaded on the board view');
await beta.press('#view-switch .chip[data-view="floor"]');
await until(beta, `document.querySelectorAll('#floor-rooms svg.room').length === 1`, 'and back on the floor view');
b = await read(beta);
ok(b.rooms.join() === 'beta' && b.title === T('beta') && b.search === '?floor=beta', 'a reload kept the board view, and back on the floor it is still beta', JSON.stringify(b));
const status = await api('channel/archive', { channel: 'beta' });
ok(status === 200, 'the fixture: beta archived by the API', status);
await until(beta, `document.querySelectorAll('#floor-rooms svg.room').length === 2`, 'the tab on beta fell back to the building');
b = await read(beta);
ok(b.title === T('All floors') && b.search === '?floor=', 'a floor put away under a tab drops it to the building, and the title and address say so with nothing clicked', JSON.stringify([b.title, b.search]));
await api('channel/unarchive', { channel: 'beta' });

console.log('\na bare address is the stored choice, as before');
const bare = await open({ base, view: 'floor', floor: 'solo-only' });
await until(bare, `document.querySelectorAll('#floor-rooms svg.room').length === 1`, 'a bare address drew a floor');
const r = await read(bare);
ok(r.rooms.join() === 'solo-only' && r.title === T('solo-only') && r.search === '?floor=solo-only', 'a bare address lands on the stored floor, and then names it', JSON.stringify(r));

console.log('\nOpen new floors: In tabs | In windows, in Settings (costmo, 2026-11-19)');
const settings = async (p) => {
  await p.press('#open-settings');
  await until(p, `document.getElementById('settings-dlg').open && !!document.getElementById('set-updates')`, 'Settings opened');
  return JSON.parse(await p.evalJs(`JSON.stringify({
    value: document.getElementById('floor-open')?.value ?? null,
    options: [...document.querySelectorAll('#floor-open option')].map((o) => o.textContent),
    heading: document.querySelector('#set-floors .set-h')?.textContent ?? null,
  })`));
};
const shut = (p) => p.evalJs(`document.getElementById('settings-dlg').close(), 1`);
let st = await settings(bare);
ok(st.heading === 'Open new floors' && JSON.stringify(st.options) === '["In tabs","In windows"]' && st.value === 'tab',
  'Settings offers Open new floors, In tabs or In windows, and In tabs is chosen when nothing was', JSON.stringify(st));
await bare.evalJs(`(() => { const s = document.getElementById('floor-open'); s.value = 'window'; s.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
ok(await bare.evalJs(`localStorage.getItem('orch.floorOpen')`) === 'window', 'choosing In windows is kept in this browser');
await shut(bare);
await until(bare, `document.querySelector('[data-floor-pop="alpha"]')?.title === 'Open alpha in a new window'`, 'the ⧉ says In windows');
ok(true, 'and the ⧉ says so at once: "Open alpha in a new window"');
before = await floorsOpen();
await bare.press('#floor-pick [data-floor-pop="alpha"]');
const winUrl = await newTarget(before, 'the ⧉ on alpha, In windows');
const win = await attach((u) => u === winUrl);
await until(win, `document.querySelectorAll('#floor-rooms svg.room').length === 1`, 'the new window drew a floor');
const w = await read(win);
const [bareWin, winWin] = [await bare.windowId(), await win.windowId()];
ok(w.rooms.join() === 'alpha' && w.title === T('alpha') && w.opener === null, 'it opens alpha, titled alpha, a peer', JSON.stringify(w));
ok(bareWin !== null && winWin !== null && bareWin !== winWin, 'in a browser window of its own, not a tab of this one', JSON.stringify([bareWin, winWin]));

console.log('\ninside the desktop app, whose Preferences decide');
// The app's own token on the user agent (contract dashboard.floor). The page
// reads navigator.userAgent at each use, so standing it up here is what the
// app's setUserAgent gives every board page before it loads.
await bare.evalJs(`Object.defineProperty(navigator, 'userAgent', { value: navigator.userAgent + ' Electron/45.2.3 OrchestratinatorDesktop/0.14.0', configurable: true }), 1`);
await until(bare, `document.querySelector('[data-floor-pop="alpha"]')?.title === 'Open alpha in a new session'`, 'the ⧉ says a new session in the app');
ok(true, 'the ⧉ says "Open alpha in a new session": the app decides, and the page does not know which');
st = await settings(bare);
ok(st.heading === null && st.value === null, 'Settings leaves Open new floors out: the app\'s Preferences own it', JSON.stringify(st));
await shut(bare);
before = await floorsOpen();
await bare.press('#floor-pick [data-floor-pop="alpha"]');
const appUrl = await newTarget(before, 'the ⧉ on alpha, in the app');
const appTab = await attach((u) => u === appUrl);
ok(await appTab.windowId() === bareWin, 'and the ⧉ opens with no features, whatever this browser stored (a tab here; in the app, its setting)', JSON.stringify([await appTab.windowId(), bareWin]));
await bare.evalJs(`localStorage.removeItem('orch.floorOpen'), 1`);

const errs = [page, beta, bare, win, appTab].flatMap((p) => p.console()).filter((m) => /^error/.test(m) && !/Failed to load resource/.test(m));
ok(errs.length === 0, 'no errors in any tab\'s console', errs.join(' | '));

console.log(fails ? `\nFAIL · ${fails} of ${total} red` : `\nPASS · ${total} of ${total}`);
process.exit(fails ? 1 : 0);

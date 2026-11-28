#!/usr/bin/env node
/**
 * Buildings on the page (the service round, 2026-11-24; docs/service/plan.md).
 *
 *   run-check-buildings.sh <dir>       # the whole fixture; see there
 *
 * What a person does and reads, on a board with three floors (alpha, beta,
 * gamma) seeded as agents make them:
 * - With one building the header has no picker and every floor is on the
 *   floor, as before buildings.
 * - Settings ▸ Buildings: Add building "Lab", and the header grows a chip
 *   each. Headquarters' Delete is dimmed (the default), and so is Lab's once a
 *   floor is in it. A taken name is refused in the section's own words.
 * - A floor's select moves it to Lab. On Headquarters the floor shows alpha and
 *   gamma only, and the totals line counts two floors. A click on the Lab
 *   chip shows beta alone, the address says ?building=, and a reload stays.
 * - The board view shows the same building's cards.
 * - A rename shows on the chip at once.
 *
 * The section as costmo redrew it (2026-11-27): no add field until the
 * circled + is pressed; the name is text until ✎, saved on Return, put back
 * on Escape (and Escape does not close the dialog); a refused name keeps
 * its field; the default is a checkmark that moves, and floors stay where
 * they were; the section folds and stays folded. The app's two settings
 * views (?settings=1&section=general|buildings) each draw their own part.
 * And the boards this operator was invited into: window.orchBoards.set()
 * draws a pill each, a click asks the app to open it, a right-click names
 * it (Return asks the app to keep the label, Escape leaves it).
 */
import { open } from './drive.mjs';

const base = process.argv[2] ?? 'http://localhost:8957';
const shots = process.argv[3] ?? '/tmp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
let total = 0;
const ok = (cond, msg, extra = '') => { total++; console.log(`  ${cond ? '✓' : '✗'} ${msg}${cond || !extra ? '' : `  (${extra})`}`); if (!cond) fails++; };
const stopped = (e) => { total++; fails++; console.log(`  ✗ the check stopped on: ${String(e?.message ?? e).split('\n')[0]}`); console.log(`\nFAIL · ${fails} of ${total} red`); process.exit(1); };
process.on('uncaughtException', stopped);
process.on('unhandledRejection', stopped);
const until = (page, expr, what, timeout = 10000) => page.waitFor(expr, { timeout })
  .catch(async () => { throw new Error(`${what} — not in ${timeout / 1000} s; body: ${String(await page.evalJs(`document.body.innerText.slice(0, 300)`)).replace(/\s+/g, ' ')}`); });

const rooms = (page) => page.evalJs(`JSON.stringify([...document.querySelectorAll('#floor-rooms [data-channel]')].map((n) => n.dataset.channel).filter((v, i, a) => a.indexOf(v) === i).sort())`).then(JSON.parse);
const chips = (page) => page.evalJs(`JSON.stringify([...document.querySelectorAll('#building-pick [data-building]')].map((a) => [a.textContent, a.classList.contains('on')]))`).then(JSON.parse);
const cards = (page) => page.evalJs(`JSON.stringify([...document.querySelectorAll('#channels [data-channel-card], #channels .channel h3, #channels .channel .ch-name')].map((n) => n.textContent.trim()))`).then(JSON.parse);

console.log('\none building: as before');
const p = await open({ base, view: 'floor', floor: '' });
await until(p, `document.querySelectorAll('#floor-rooms [data-channel]').length > 0`, 'the floor draws its rooms');
await until(p, `new Set([...document.querySelectorAll('#floor-rooms [data-channel]')].map((n) => n.dataset.channel)).size === 3`, 'all three floors are drawn');
ok(JSON.stringify(await rooms(p)) === '["alpha","beta","gamma"]', 'every floor is on the floor', JSON.stringify(await rooms(p)));
ok((await chips(p)).length === 0 && await p.evalJs(`getComputedStyle(document.getElementById('building-pick')).display === 'none'`), 'and the header has no building picker');

console.log('\nSettings ▸ Buildings: add one');
await p.click('#open-settings');
await until(p, `!!document.querySelector('#set-buildings [data-set="building-add"]')`, 'Settings has a Buildings section with its ⊕');
ok(!(await p.evalJs(`!!document.querySelector('#building-new')`)), 'no add field shows until ⊕ is pressed');
ok(await p.evalJs(`document.querySelector('[data-set="building-delete"]').disabled`), 'Headquarters\' trash can is dimmed: it is the default');
ok(await p.evalJs(`!!document.querySelector('[data-building-row] .bld-default.on') && !document.querySelector('[data-building-row] input')`), 'its checkmark is on, and its name is text, not a field');
await p.press('#set-buildings [data-set="building-add"]');
await until(p, `document.activeElement?.id === 'building-new'`, '⊕ opens a row already being named');
await p.type('Lab');
await p.key('Enter', { text: '\r' });
await until(p, `document.querySelectorAll('#set-buildings [data-building-row]').length === 2 && !document.querySelector('#building-new')`, 'Return makes it: two rows, and the add row gone');
await until(p, `document.querySelectorAll('#building-pick [data-building]').length === 2`, 'the header grows a chip each');
ok(JSON.stringify(await chips(p)) === '[["Headquarters",true],["Lab",false]]', 'Headquarters is lit, Lab beside it', JSON.stringify(await chips(p)));
ok(await p.evalJs(`document.querySelectorAll('#set-buildings [data-set-floor-building]').length === 3`), 'each floor has a building select');
await p.press('#set-buildings [data-set="building-add"]');
await until(p, `document.activeElement?.id === 'building-new'`, 'the add row again');
await p.type('lab');
await p.press('[data-set="building-save"][data-id="new"]');
await until(p, `!document.querySelector('#set-buildings .set-bld-err').hidden`, 'a taken name is refused in the section');
ok(/already a building called "Lab"/.test(await p.evalJs(`document.querySelector('#set-buildings .set-bld-err').textContent`)), 'in the board\'s words', await p.evalJs(`document.querySelector('#set-buildings .set-bld-err').textContent`));
ok(await p.evalJs(`document.querySelector('#building-new')?.value === 'lab'`), 'and the field stays, holding what was typed, to be fixed');
// A poll asked before the last change lands while the row is open and
// focus is on ✓, not in the field: the section is drawn from that older
// state. What was typed, and the refusal, must survive it (a gate red at
// 7194e2f, 1 of 4 runs; made certain here by drawing the older state).
await p.evalJs(`document.activeElement?.blur?.(); document.querySelector('[data-set="building-save"][data-id="new"]').focus(); ui.state = { ...ui.state, buildings: ui.state.buildings.slice(0, 1) }; renderBuildingsSection(); true`);
ok(await p.evalJs(`document.querySelector('#building-new')?.value === 'lab' && !document.querySelector('#set-buildings .set-bld-err').hidden`), 'and a poll from before drawn under it keeps both the typed name and the refusal', await p.evalJs(`JSON.stringify([document.querySelector('#building-new')?.value, document.querySelector('#set-buildings .set-bld-err')?.hidden])`));
await p.evalJs(`getJson('./api/state').then((st) => { ui.state = st; renderBuildingsSection(); return true; })`);
await p.evalJs(`document.querySelector('#building-new').focus()`);
await p.key('Escape');
await until(p, `!document.querySelector('#building-new')`, 'Escape leaves the add row');
ok(await p.evalJs(`document.getElementById('settings-dlg').open`), 'and does not close Settings');
ok(await p.evalJs(`document.querySelector('#set-buildings .set-bld-err').hidden`), 'the refusal goes with it');

console.log('\nmove a floor, then walk between buildings');
const labId = await p.evalJs(`[...document.querySelectorAll('#building-pick [data-building]')].find((a) => a.textContent === 'Lab').dataset.building`);
await p.evalJs(`(() => { const s = document.querySelector('[data-set-floor-building="beta"]'); s.value = ${JSON.stringify(labId)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await until(p, `[...document.querySelectorAll('#set-buildings [data-building-row]')].some((r) => r.textContent.includes('1 floor') && r.dataset.buildingRow === ${JSON.stringify(labId)})`, 'Lab says it holds one floor');
ok(await p.evalJs(`document.querySelector('[data-set="building-delete"][data-id=${JSON.stringify(labId)}]').disabled`), 'and its Delete is dimmed now');
await p.shot(`${shots}/buildings-settings.png`, '#settings-dlg', { scale: 1 });
await p.key('Escape');
await until(p, `!document.getElementById('settings-dlg').open`, 'Settings closes');
await until(p, `new Set([...document.querySelectorAll('#floor-rooms [data-channel]')].map((n) => n.dataset.channel)).size === 2`, 'Headquarters\' floor redraws without beta');
ok(JSON.stringify(await rooms(p)) === '["alpha","gamma"]', 'Headquarters shows alpha and gamma', JSON.stringify(await rooms(p)));
ok(/^2 floors · /.test(await p.evalJs(`document.getElementById('floor-totals').textContent`)), 'and its totals count two floors', await p.evalJs(`document.getElementById('floor-totals').textContent`));
await p.click(`#building-pick [data-building="${labId}"]`);
await until(p, `new Set([...document.querySelectorAll('#floor-rooms [data-channel]')].map((n) => n.dataset.channel)).size === 1`, 'Lab draws one floor');
ok(JSON.stringify(await rooms(p)) === '["beta"]', 'Lab shows beta alone', JSON.stringify(await rooms(p)));
ok(JSON.stringify(await chips(p)) === '[["Headquarters",false],["Lab",true]]', 'and its chip is lit', JSON.stringify(await chips(p)));
ok(new URLSearchParams(await p.evalJs('location.search')).get('building') === labId, 'the address names the building', await p.evalJs('location.search'));
ok(/^1 floor · /.test(await p.evalJs(`document.getElementById('floor-totals').textContent`)), 'the totals count its one floor', await p.evalJs(`document.getElementById('floor-totals').textContent`));
await p.shot(`${shots}/buildings-lab.png`, null, { scale: 1 });
await p.goto(await p.evalJs('location.href'));
await until(p, `document.querySelectorAll('#building-pick [data-building]').length === 2 && document.querySelectorAll('#floor-rooms [data-channel]').length > 0`, 'the reload draws');
await sleep(500);
ok(JSON.stringify(await rooms(p)) === '["beta"]' && JSON.stringify(await chips(p)) === '[["Headquarters",false],["Lab",true]]', 'a reload stays in Lab', JSON.stringify([await rooms(p), await chips(p)]));

console.log('\nthe board view is the same building');
await p.click('[data-view="board"]');
await until(p, `document.body.classList.contains('view-board') || !document.body.classList.contains('view-floor')`, 'the board view is on');
await sleep(800);
const boardText = await p.evalJs(`document.getElementById('channels').innerText`);
ok(boardText.includes('beta') && !boardText.includes('alpha') && !boardText.includes('gamma'), 'its cards are Lab\'s floor alone', boardText.slice(0, 120).replace(/\s+/g, ' '));
await p.click(`#building-pick [data-building]:not([data-building="${labId}"])`);
await sleep(1200);
const boardMain = await p.evalJs(`document.getElementById('channels').innerText`);
ok(boardMain.includes('alpha') && boardMain.includes('gamma') && !boardMain.includes('beta'), 'and Headquarters\' chip shows its own', boardMain.slice(0, 120).replace(/\s+/g, ' '));

console.log('\na rename: ✎, Escape puts it back, Return keeps it');
await p.click('#open-settings');
await until(p, `!!document.querySelector('[data-set="building-edit"][data-id=${JSON.stringify(labId)}]')`, 'the section is drawn');
await p.press(`[data-set="building-edit"][data-id="${labId}"]`);
await until(p, `document.activeElement?.matches('[data-building-name=${JSON.stringify(labId)}]')`, '✎ makes the name a field, focused');
await p.type('Nope');
await p.key('Escape');
await until(p, `!document.querySelector('[data-building-name=${JSON.stringify(labId)}]')`, 'Escape leaves the field');
ok(await p.evalJs(`document.querySelector('[data-building-label=${JSON.stringify(labId)}]').textContent === 'Lab' && document.getElementById('settings-dlg').open`), 'the name is as it was, and Settings is still open');
await p.press(`[data-set="building-edit"][data-id="${labId}"]`);
await until(p, `document.activeElement?.matches('[data-building-name=${JSON.stringify(labId)}]')`, '✎ again');
await p.type('Workshop');
await p.key('Enter', { text: '\r' });
await until(p, `[...document.querySelectorAll('#building-pick [data-building]')].some((a) => a.textContent === 'Workshop')`, 'the chip reads Workshop');
await until(p, `document.querySelector('[data-building-label=${JSON.stringify(labId)}]')?.textContent === 'Workshop'`, 'and the row, as text again');

console.log('\nthe default is a checkmark that moves, and floors stay where they are');
await p.press(`[data-set="building-default"][data-id="${labId}"]`);
await until(p, `!!document.querySelector('[data-building-row=${JSON.stringify(labId)}] .bld-default.on')`, 'Workshop\'s checkmark is on');
ok(await p.evalJs(`document.querySelectorAll('#set-buildings .bld-default.on').length === 1`), 'and only Workshop\'s');
ok(await p.evalJs(`!document.querySelector('[data-set="building-delete"][data-id=${JSON.stringify(labId)}]') || document.querySelector('[data-set="building-delete"][data-id=${JSON.stringify(labId)}]').disabled`), 'the default\'s trash can is dimmed');
const where = await p.evalJs(`JSON.stringify([...document.querySelectorAll('[data-set-floor-building]')].map((s) => [s.dataset.setFloorBuilding, s.value === ${JSON.stringify(labId)}]))`);
ok(where === '[["alpha",false],["beta",true],["gamma",false]]', 'alpha and gamma stayed in Headquarters', where);
const hqId = await p.evalJs(`[...document.querySelectorAll('[data-set="building-default"]')].map((b) => b.dataset.id)[0]`);
await p.press(`[data-set="building-default"][data-id="${hqId}"]`);
await until(p, `!!document.querySelector('[data-building-row=${JSON.stringify(hqId)}] .bld-default.on')`, 'and back to Headquarters');

console.log('\nthe section folds, and stays folded');
await p.press('#set-buildings button.fold');
await until(p, `document.querySelector('#set-bld-body').hidden`, 'folded');
ok(await p.evalJs(`document.querySelector('#set-buildings button.fold').getAttribute('aria-expanded') === 'false'`), 'the toggle says so');
await p.key('Escape');
await until(p, `!document.getElementById('settings-dlg').open`, 'Settings closes');
await p.click('#open-settings');
await until(p, `!!document.querySelector('#set-buildings')`, 'Settings again');
ok(await p.evalJs(`document.querySelector('#set-bld-body').hidden`), 'still folded');
await p.press('#set-buildings [data-set="building-add"]');
await until(p, `document.activeElement?.id === 'building-new' && !document.querySelector('#set-bld-body').hidden`, '⊕ on a folded section opens it to the new row');
await p.key('Escape');
await sleep(200);
await p.shot(`${shots}/buildings-section.png`, '#set-buildings', { scale: 2 });
await p.key('Escape');

console.log('\nthe app\'s settings views draw their own parts');
const g = await open({ base: `${base}/?settings=1&section=general`, ready: `!!document.querySelector('#set-page #set-auto')` });
ok(await g.evalJs(`!!document.querySelector('#set-page #set-auto') && !document.querySelector('#set-page #set-buildings')`), 'section=general: auto-refresh, and no Buildings');
await g.goto(`${base}/?settings=1&section=buildings`);
await until(g, `!!document.querySelector('#set-page #set-buildings')`, 'section=buildings draws Buildings');
ok(await g.evalJs(`!document.querySelector('#set-page #set-auto') && document.querySelectorAll('#set-page .set-tool').length === 1`), 'and nothing else');
await g.shot(`${shots}/settings-buildings-view.png`, '#set-page', { scale: 2 });
await g.close();

console.log('\nthe boards this operator was invited into');
await p.click('[data-view="floor"]');
ok(await p.evalJs(`document.getElementById('guest-boards').hidden`), 'none said: no row');
await p.evalJs(`window.__opened = []; window.open = (u) => { window.__opened.push(String(u)); return null; }; window.orchBoards.set([
  { id: 'brd_a', name: "Pat's Mac", state: 'available' },
  { id: 'brd_b', name: 'Studio', label: 'Design team', state: 'blocked', why: 'The owner turned sharing off.' },
  { id: 'brd_c', name: 'Garage', state: 'unknown' } ])`);
await until(p, `!document.getElementById('guest-boards').hidden && document.querySelectorAll('#guest-boards .gb').length === 3`, 'a pill each');
const pills = await p.evalJs(`JSON.stringify([...document.querySelectorAll('#guest-boards .gb')].map((g) => [g.className, g.querySelector('.gb-glyph').textContent, g.querySelector('.gb-label').textContent]))`);
ok(pills === JSON.stringify([['gb available', '✓', "Pat's Mac"], ['gb blocked', '!', 'Design team'], ['gb unknown', '–', 'Garage']]), 'each in its state\'s outline and glyph, the label over the name', pills);
const rowTop = await p.evalJs(`document.getElementById('guest-boards').getBoundingClientRect().top >= document.querySelector('header.topbar').getBoundingClientRect().bottom && document.getElementById('guest-boards').getBoundingClientRect().bottom <= document.getElementById('floor').getBoundingClientRect().top`);
ok(rowTop, 'under the header, above the floor');
const borders = await p.evalJs(`JSON.stringify([...document.querySelectorAll('#guest-boards .gb-open')].map((b) => getComputedStyle(b).borderTopColor))`);
ok(new Set(JSON.parse(borders)).size === 3, 'three different outlines', borders);
await p.press('[data-guest-board="brd_a"] .gb-open');
await until(p, `window.__opened.length === 1`, 'a click asks the app');
ok(await p.evalJs(`window.__opened[0]`) === '/?guest_board=brd_a', 'to open that board', await p.evalJs(`window.__opened[0]`));
await p.press('[data-guest-board="brd_c"] .gb-open', '[data-guest-board="brd_c"] .gb-open', { button: 'right' });
await until(p, `document.activeElement?.matches('#guest-boards .gb-input')`, 'a right-click names it, in place');
await p.key('Escape');
await until(p, `!document.querySelector('#guest-boards .gb-input')`, 'Escape leaves it');
ok(await p.evalJs(`window.__opened.length === 1 && document.querySelector('[data-guest-board="brd_c"] .gb-label').textContent === 'Garage'`), 'asking nothing, the name as it was');
await p.press('[data-guest-board="brd_c"] .gb-open', '[data-guest-board="brd_c"] .gb-open', { button: 'right' });
await until(p, `document.activeElement?.matches('#guest-boards .gb-input')`, 'again');
await p.evalJs(`document.activeElement.select()`);
await p.type('Home lab');
await p.key('Enter', { text: '\r' });
await until(p, `window.__opened.length === 2`, 'Return asks the app to keep it');
ok(await p.evalJs(`window.__opened[1]`) === '/?guest_board=brd_c&label=Home+lab', 'with the label', await p.evalJs(`window.__opened[1]`));
ok(await p.evalJs(`document.querySelector('[data-guest-board="brd_c"] .gb-label').textContent === 'Home lab'`), 'and draws it at once');
await p.shot(`${shots}/guest-boards.png`, null, { scale: 1 });
console.log('\nin a window on one of those boards, its button is a label, and the title says whose');
await p.evalJs(`window.__opened = []; window.orchBoards.set([
  { id: 'brd_a', name: "Pat's Mac", state: 'available', here: true },
  { id: 'brd_b', name: 'Studio', state: 'available' } ])`);
await until(p, `!!document.querySelector('#guest-boards .gb.here')`, 'the board here is drawn');
ok(await p.evalJs(`!document.querySelector('#guest-boards .gb.here button') && document.querySelector('#guest-boards .gb.here [aria-current="page"]') !== null`), 'it is no button: a label, current');
await p.press('#guest-boards .gb.here .gb-open');
await sleep(400);
ok(await p.evalJs(`window.__opened.length === 0`), 'a click on it opens nothing', await p.evalJs(`JSON.stringify(window.__opened)`));
await p.press('#guest-boards .gb.here .gb-open', '#guest-boards .gb.here .gb-open', { button: 'right' });
await sleep(400);
ok(await p.evalJs(`!document.querySelector('#guest-boards .gb-input')`), 'nor does a right-click: it is information only');
await p.press('[data-guest-board="brd_b"] .gb-open');
await until(p, `window.__opened.length === 1`, 'the other board still opens');
await until(p, `document.title.endsWith(" · Pat's Mac")`, 'the window\'s title names the board, after the floor');
ok(true, `title: ${await p.evalJs('document.title')}`);
await p.shot(`${shots}/guest-boards-here.png`, '#guest-boards', { scale: 2 });
await p.evalJs(`window.orchBoards.set([])`);
await until(p, `!document.title.includes("Pat's Mac")`, 'and without it, the app\'s name comes back');
ok(await p.evalJs(`document.getElementById('guest-boards').hidden`), 'an empty list takes the row away');

console.log(fails ? `\nFAIL · ${fails} of ${total} red` : `\nPASS · ${total} of ${total}`);
process.exit(fails ? 1 : 0);

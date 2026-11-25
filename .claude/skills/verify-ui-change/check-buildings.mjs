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
 *   each. Main's Delete is dimmed (the default), and so is Lab's once a
 *   floor is in it. A taken name is refused in the section's own words.
 * - A floor's select moves it to Lab. On Main the floor shows alpha and
 *   gamma only, and the totals line counts two floors. A click on the Lab
 *   chip shows beta alone, the address says ?building=, and a reload stays.
 * - The board view shows the same building's cards.
 * - A rename shows on the chip at once.
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
await until(p, `!!document.querySelector('#set-buildings #building-new')`, 'Settings has a Buildings section');
ok(await p.evalJs(`document.querySelector('[data-set="building-delete"]').disabled`), 'Main\'s Delete is dimmed: it is the default');
await p.evalJs(`document.querySelector('#building-new').focus()`);
await p.type('Lab');
await p.click('[data-set="building-create"]');
await until(p, `document.querySelectorAll('#set-buildings [data-building-row]').length === 2`, 'the section lists two buildings');
await until(p, `document.querySelectorAll('#building-pick [data-building]').length === 2`, 'the header grows a chip each');
ok(JSON.stringify(await chips(p)) === '[["Main",true],["Lab",false]]', 'Main is lit, Lab beside it', JSON.stringify(await chips(p)));
ok(await p.evalJs(`document.querySelectorAll('#set-buildings [data-set-floor-building]').length === 3`), 'each floor has a building select');
await p.evalJs(`document.querySelector('#building-new').focus()`);
await p.type('lab');
await p.click('[data-set="building-create"]');
await until(p, `!document.querySelector('#set-buildings .set-bld-err').hidden`, 'a taken name is refused in the section');
ok(/already a building called "Lab"/.test(await p.evalJs(`document.querySelector('#set-buildings .set-bld-err').textContent`)), 'in the board\'s words', await p.evalJs(`document.querySelector('#set-buildings .set-bld-err').textContent`));

console.log('\nmove a floor, then walk between buildings');
const labId = await p.evalJs(`[...document.querySelectorAll('#building-pick [data-building]')].find((a) => a.textContent === 'Lab').dataset.building`);
await p.evalJs(`(() => { const s = document.querySelector('[data-set-floor-building="beta"]'); s.value = ${JSON.stringify(labId)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await until(p, `[...document.querySelectorAll('#set-buildings [data-building-row]')].some((r) => r.textContent.includes('1 floor') && r.dataset.buildingRow === ${JSON.stringify(labId)})`, 'Lab says it holds one floor');
ok(await p.evalJs(`document.querySelector('[data-set="building-delete"][data-id=${JSON.stringify(labId)}]').disabled`), 'and its Delete is dimmed now');
await p.shot(`${shots}/buildings-settings.png`, '#settings-dlg', { scale: 1 });
await p.key('Escape');
await until(p, `!document.getElementById('settings-dlg').open`, 'Settings closes');
await until(p, `new Set([...document.querySelectorAll('#floor-rooms [data-channel]')].map((n) => n.dataset.channel)).size === 2`, 'Main\'s floor redraws without beta');
ok(JSON.stringify(await rooms(p)) === '["alpha","gamma"]', 'Main shows alpha and gamma', JSON.stringify(await rooms(p)));
ok(/^2 floors · /.test(await p.evalJs(`document.getElementById('floor-totals').textContent`)), 'and its totals count two floors', await p.evalJs(`document.getElementById('floor-totals').textContent`));
await p.click(`#building-pick [data-building="${labId}"]`);
await until(p, `new Set([...document.querySelectorAll('#floor-rooms [data-channel]')].map((n) => n.dataset.channel)).size === 1`, 'Lab draws one floor');
ok(JSON.stringify(await rooms(p)) === '["beta"]', 'Lab shows beta alone', JSON.stringify(await rooms(p)));
ok(JSON.stringify(await chips(p)) === '[["Main",false],["Lab",true]]', 'and its chip is lit', JSON.stringify(await chips(p)));
ok(new URLSearchParams(await p.evalJs('location.search')).get('building') === labId, 'the address names the building', await p.evalJs('location.search'));
ok(/^1 floor · /.test(await p.evalJs(`document.getElementById('floor-totals').textContent`)), 'the totals count its one floor', await p.evalJs(`document.getElementById('floor-totals').textContent`));
await p.shot(`${shots}/buildings-lab.png`, null, { scale: 1 });
await p.goto(await p.evalJs('location.href'));
await until(p, `document.querySelectorAll('#building-pick [data-building]').length === 2 && document.querySelectorAll('#floor-rooms [data-channel]').length > 0`, 'the reload draws');
await sleep(500);
ok(JSON.stringify(await rooms(p)) === '["beta"]' && JSON.stringify(await chips(p)) === '[["Main",false],["Lab",true]]', 'a reload stays in Lab', JSON.stringify([await rooms(p), await chips(p)]));

console.log('\nthe board view is the same building');
await p.click('[data-view="board"]');
await until(p, `document.body.classList.contains('view-board') || !document.body.classList.contains('view-floor')`, 'the board view is on');
await sleep(800);
const boardText = await p.evalJs(`document.getElementById('channels').innerText`);
ok(boardText.includes('beta') && !boardText.includes('alpha') && !boardText.includes('gamma'), 'its cards are Lab\'s floor alone', boardText.slice(0, 120).replace(/\s+/g, ' '));
await p.click(`#building-pick [data-building]:not([data-building="${labId}"])`);
await sleep(1200);
const boardMain = await p.evalJs(`document.getElementById('channels').innerText`);
ok(boardMain.includes('alpha') && boardMain.includes('gamma') && !boardMain.includes('beta'), 'and Main\'s chip shows Main\'s', boardMain.slice(0, 120).replace(/\s+/g, ' '));

console.log('\na rename shows on the chip');
await p.click('#open-settings');
await until(p, `!!document.querySelector('[data-building-name=${JSON.stringify(labId)}]')`, 'the section is drawn');
await p.evalJs(`(() => { const i = document.querySelector('[data-building-name=${JSON.stringify(labId)}]'); i.focus(); i.select(); })()`);
await p.type('Workshop');
await p.click(`[data-set="building-rename"][data-id="${labId}"]`);
await until(p, `[...document.querySelectorAll('#building-pick [data-building]')].some((a) => a.textContent === 'Workshop')`, 'the chip reads Workshop');
ok(true, 'renamed');

console.log(fails ? `\nFAIL · ${fails} of ${total} red` : `\nPASS · ${total} of ${total}`);
process.exit(fails ? 1 : 0);

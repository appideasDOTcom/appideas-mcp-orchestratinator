#!/usr/bin/env node
/**
 * Take a desk opened from a floor keeps that floor when a folder is chosen
 * (costmo, 2026-11-16, 0.12.8). On a throwaway server with seed-desk.mjs's
 * desk on `lab` and answering-host.mjs, whose answers file binds one folder
 * on another floor (`elsewhere`, as `cy`).
 *
 *   run-check-take-floor.sh <dir>       # the whole fixture; see there
 *
 * Standing on a floor: the form opens on it, a folder bound elsewhere
 * leaves it there and the dialog becomes a move to it, and a floor picked
 * by hand survives the next folder. From all floors: a bound folder still
 * proposes its own floor. The rule itself is in test/floor.mjs
 * (takeListing); this is the dialog a person reads.
 *
 * A folder is chosen with browseTo(), the function a row's click calls:
 * this host has a folder dialog of its own, so the page draws no rows to
 * click. That is the one step here a person does differently.
 */
import { open } from './drive.mjs';

const base = process.argv[2] ?? 'http://localhost:8947';
const shots = process.argv[3] ?? '/tmp';
const BOUND = '/repo/deep/nest/bound-here';

let fails = 0;
let total = 0;
const ok = (cond, msg, extra = '') => { total++; console.log(`  ${cond ? '✓' : '✗'} ${msg}${cond || !extra ? '' : `  (${extra})`}`); if (!cond) fails++; };
const stopped = (e) => { total++; fails++; console.log(`  ✗ the check stopped on: ${String(e?.message ?? e).split('\n')[0]}`); console.log(`\nFAIL · ${fails} of ${total} red`); process.exit(1); };
process.on('uncaughtException', stopped);
process.on('unhandledRejection', stopped);

const read = (page) => page.evalJs(`JSON.stringify({
  floor: document.querySelector('#desk-channel')?.value ?? null,
  floors: [...document.querySelectorAll('#desk-channel option')].map((o) => o.value),
  agent: document.querySelector('#desk-agent')?.value ?? null,
  locked: document.querySelector('#desk-agent')?.readOnly ?? null,
  button: document.querySelector('#dlg [data-do="desk-take"]')?.textContent ?? null,
  text: document.querySelector('#dlg')?.innerText ?? '',
})`).then(JSON.parse);
const takeFrom = async (floor) => {
  const page = await open({ base, view: 'floor', floor });
  await page.waitFor(`document.querySelectorAll('svg.room .desk').length >= 1`);
  await page.click('#take-desk');
  await page.waitFor(`!!document.querySelector('dialog[open] #desk-channel')`, { timeout: 10000 });
  // And for its host: until the host list has answered the form names no
  // host, and choosing a folder asks nobody. A person waits for the same
  // thing, the Choose folder button. The first cut chose at once and
  // passed or stopped by how long the step before it happened to take.
  await page.waitFor(`(() => { const b = document.querySelector('#dlg [data-do="desk-pick"]'); return !!b && !b.disabled; })()`, { timeout: 10000 });
  return page;
};
const choose = async (page, path, agent) => {
  await page.evalJs(`browseTo(${JSON.stringify(path)}), 1`);
  // What the dialog holds when the folder never arrives is the finding, so it is said.
  await page.waitFor(`document.querySelector('#desk-agent')?.value === ${JSON.stringify(agent)} && /${path.split('/').at(-1)}/.test(document.querySelector('#dlg')?.innerText ?? '')`, { timeout: 10000 })
    .catch(async () => { const f = await read(page); throw new Error(`${path} was not listed in 10 s: agent "${f.agent}", floor "${f.floor}", dialog: ${f.text.replace(/\s+/g, ' ').slice(0, 300)}`); });
};

console.log('\nTake a desk, standing on a floor');
let page = await takeFrom('lab');
let f = await read(page);
ok(f.floor === 'lab' && f.button === 'Take desk', 'the form opens on the floor being looked at', JSON.stringify([f.floor, f.button]));
await choose(page, BOUND, 'cy');
f = await read(page);
ok(f.agent === 'cy' && f.locked === true && /is cy on elsewhere/.test(f.text), 'the fixture: the folder chosen is bound as cy on another floor, and the dialog says so', f.text.match(/[^\n]* is cy on [^\n]*/)?.[0] ?? f.text.slice(0, 200));
ok(f.floor === 'lab', 'the floor is still the one being looked at: choosing a folder did not change it', f.floor);
ok(f.button === 'Move to lab' && /Move cy to lab/.test(f.text), 'so the dialog is a move to this floor, and says so before anything is pressed', f.button);
await page.shot(`${shots}/take-from-floor.png`, '#dlg', { scale: 1 });
// Neither this floor nor the bound folder's: the old rule put the folder's
// floor in the form, and a pick that happened to be that floor passed the
// row below on the old code (seen when this check was first run red).
const other = f.floors.find((v) => v && v !== 'lab' && v !== 'elsewhere');
ok(!!other, 'the fixture: the form offers a floor that is neither this one nor the folder\'s', JSON.stringify(f.floors));
await page.evalJs(`(() => { const s = document.querySelector('#desk-channel'); s.value = ${JSON.stringify(other)}; s.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
await page.waitFor(`document.querySelector('#desk-channel')?.value === ${JSON.stringify(other)}`);
await choose(page, '/repo/deep', '');
f = await read(page);
ok(f.floor === other, 'a floor picked by hand in the dialog is kept when another folder is chosen after it', `${other} → ${f.floor}`);
await choose(page, BOUND, 'cy');
f = await read(page);
ok(f.floor === other, 'a bound one included', `${other} → ${f.floor}`);
await page.close();

console.log('\nTake a desk, from all floors');
page = await takeFrom('');
await choose(page, BOUND, 'cy');
f = await read(page);
ok(f.floor === 'elsewhere' && f.button === 'Bring onto the floor', 'with no floor being looked at, a bound folder still proposes its own, as it always did', JSON.stringify([f.floor, f.button]));
await page.shot(`${shots}/take-from-all.png`, '#dlg', { scale: 1 });
await page.close();

console.log(fails ? `\nFAIL · ${fails} of ${total} red` : `\nPASS · ${total} of ${total}`);
process.exit(fails ? 1 : 0);

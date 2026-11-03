#!/usr/bin/env node
/**
 * Drive both views through the archive round trip against the fixture that
 * seed-archive.mjs builds, and print what each page drew at every step. The
 * assertions are in test/floor.mjs; this is the page, which only a browser
 * can show. Measured on 2026-11-02 for issues #21 and #6, and kept here
 * because the previous page checks for this board were written in a
 * scratchpad and lost.
 *
 *   node --experimental-websocket .claude/skills/verify-ui-change/check-archive.mjs http://localhost:8905 [out-dir]
 *
 * Steps, in order: board — archive beta from the row's dialog, restore it
 * from its pill; floor — the Floor dropdown before and after, "put away" on
 * the hook-only floor (opens the board's channel dialog), the same floor as
 * a pill on the board, restore from the floor's pill, standing on a floor
 * (no control, no list), the floor archived under you (→ all floors), a
 * reload remembering an archived floor (→ all floors). Shots go to out-dir;
 * the floor's pill list is below the fold at 913px, so it is captured with
 * `full: true` — an element shot of it is an empty band (see SKILL.md).
 */
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { open } from './drive.mjs';

const base = process.argv[2] ?? 'http://localhost:8905';
const out = process.argv[3] ?? tmpdir();
const P = fileURLToPath(new URL('./probe-archive.js', import.meta.url));
const say = (label, j) => {
  const r = JSON.parse(j);
  console.log(`\n## ${label}`);
  console.log(`  cards ${JSON.stringify(r.cards)} | – buttons ${r.minusButtons} | archived toggle ${r.archivedToggle}`);
  console.log(`  board pills ${JSON.stringify(r.boardPills.map((p) => `${p.ch}:${p.act}:${p.count}`))} | filter ${JSON.stringify(r.filterOptions)}`);
  console.log(`  rooms ${JSON.stringify(r.rooms)} | chips ${JSON.stringify(r.chips)} | tail ${r.pickTail} | put away ${JSON.stringify(r.putAway)}`);
  console.log(`  floor pills ${JSON.stringify(r.floorPills.map((p) => `${p.ch}:${p.act}:${p.count}`))} | #floor-away ${r.floorAwayDisplay} | empty copy ${JSON.stringify(r.roomsEmpty)}`);
  console.log(`  totals floor ${JSON.stringify(r.totals)} | board ${JSON.stringify(r.boardTotals)} | stored floor ${JSON.stringify(r.storedFloor)}`);
  if (r.dlgOpen) console.log(`  DIALOG ${r.dlgHead} | ${r.dlgButton} | desk options ${JSON.stringify(r.deskOptions)}`);
};
const api = (path, body) => fetch(`${base}/api/admin/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.status);
const closeDlg = (page) => page.evalJs("document.querySelector('dialog[open]')?.close(); 'ok'");

// ---- board ----
let page = await open({ base, view: 'board', floor: '' });
await page.waitFor("document.querySelectorAll('#channels .channel').length === 3");
say('board: start', await page.probe(P));
await page.click('#channels [data-act="channel"][data-channel="beta"]');
await page.waitFor("!!document.querySelector('dialog[open] [data-do=\"archive\"]')");
say('board: channel dialog for beta', await page.probe(P));
await page.click('dialog[open] [data-do="archive"]');
await page.waitFor("!!document.querySelector('#channels .min-bar .min-pill[data-channel=\"beta\"]')", { timeout: 10000 });
say('board: beta archived', await page.probe(P));
await page.shot(`${out}/archive-board-pill.png`, '#channels');
await page.click('#channels .min-pill[data-channel="beta"]');
await page.waitFor("document.querySelectorAll('#channels .channel').length === 3 && !document.querySelector('#channels .min-pill')", { timeout: 10000 });
say('board: beta restored by its pill', await page.probe(P));
await page.close();

// ---- floor ----
page = await open({ base, view: 'floor', floor: '' });
await page.waitFor("document.querySelectorAll('#floor-rooms svg.room').length === 3");
say('floor: start', await page.probe(P));
await page.click('#take-desk');
await page.waitFor("!!document.querySelector('dialog[open] #desk-channel')", { timeout: 10000 });
say('floor: Take a desk dropdown, nothing archived', await page.probe(P));
await closeDlg(page);
await page.click('#floor-rooms .roomPut[data-channel="solo-only"]');
await page.waitFor("!!document.querySelector('dialog[open] [data-do=\"archive\"]')");
say('floor: "put away" opened the channel dialog', await page.probe(P));
await page.click('dialog[open] [data-do="archive"]');
await page.waitFor("!!document.querySelector('#floor-away .min-pill[data-channel=\"solo-only\"]')", { timeout: 10000 });
say('floor: solo-only archived from the floor', await page.probe(P));
await page.shot(`${out}/archive-floor-full.png`, null, { full: true });
await page.click('#take-desk');
await page.waitFor("!!document.querySelector('dialog[open] #desk-channel')", { timeout: 10000 });
say('floor: Take a desk dropdown with solo-only archived', await page.probe(P));
await closeDlg(page);
await page.click('#view-switch [data-view="board"]');
await page.waitFor("!!document.querySelector('#channels .min-bar .min-pill[data-channel=\"solo-only\"]')", { timeout: 10000 });
say('board: solo-only is a pill here too (#6)', await page.probe(P));
await page.click('#view-switch [data-view="floor"]');
await page.waitFor("document.body.classList.contains('view-floor')");
await page.click('#floor-away .min-pill[data-channel="solo-only"]');
await page.waitFor("document.querySelectorAll('#floor-rooms svg.room').length === 3 && !document.querySelector('#floor-away .min-pill')", { timeout: 10000 });
say('floor: solo-only restored by its pill', await page.probe(P));
await page.click('#floor-pick [data-floor="alpha"]');
await page.waitFor("document.querySelectorAll('#floor-rooms svg.room').length === 1");
say('floor: standing on alpha — no control, no list', await page.probe(P));
console.log('\narchive alpha by API:', await api('channel/archive', { channel: 'alpha' }));
await page.waitFor("document.querySelector('#floor-pick [data-floor=\"\"]')?.classList.contains('on') === true", { timeout: 10000 });
say('floor: alpha archived under us → all floors', await page.probe(P));
await page.close();
page = await open({ base, view: 'floor', floor: 'alpha' });
await page.waitFor("document.querySelectorAll('#floor-rooms svg.room').length === 2", { timeout: 10000 });
say('floor: reloaded remembering alpha, which is archived → all floors', await page.probe(P));
console.log('\nunarchive alpha by API:', await api('channel/unarchive', { channel: 'alpha' }));
await page.waitFor("document.querySelectorAll('#floor-rooms svg.room').length === 3", { timeout: 10000 });
say('floor: alpha back', await page.probe(P));
await page.close();
console.log(`\nshots in ${out}`);

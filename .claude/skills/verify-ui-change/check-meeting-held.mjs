#!/usr/bin/env node
/**
 * A meeting kept with no window (0.14.4; costmo, 2026-11-20): the desktop
 * app, quitting, calls `window.orchMeeting.hold()` in each room's window,
 * and the meeting outlives the window. Closing the room's own window still
 * ends it. While no window shows it, its desks stay in it, boxed on the
 * floor, and the panel offers "Open the meeting room". In the app, a floor
 * that loads with such a meeting opens its room; a browser does not.
 *
 *   run-check-meeting-held.sh <dir>       # the whole fixture; see there
 *
 * Driven on a throwaway server with seed-meeting.mjs's floor (`--more`) and
 * host, through real meeting windows. Chrome is started with popups allowed
 * (--disable-popup-blocking), because the app has no popup blocker and the
 * app's floor opens a room with no click (desktop-dev, msg 3710); the
 * browser-floor rows do not depend on it, since the page only opens a room
 * by itself under the app's user agent.
 */
import { open, attach, targets } from './drive.mjs';

const base = process.argv[2] ?? 'http://localhost:8947';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
let total = 0;
const ok = (cond, msg, extra = '') => {
  total++;
  console.log(`  ${cond ? '✓' : '✗'} ${msg}${cond || !extra ? '' : `  (${extra})`}`);
  if (!cond) fails++;
};
const stopped = (e) => { total++; fails++; console.log(`  ✗ the check stopped on: ${String(e?.message ?? e).split('\n')[0]}`); console.log(`\nFAIL · ${fails} of ${total} red`); process.exit(1); };
process.on('uncaughtException', stopped);
process.on('unhandledRejection', stopped);

const isMeeting = (u) => u.includes('meeting=');
const openWindows = async () => (await targets()).filter(isMeeting);
const meetingRow = async (id) => (await (await fetch(`${base}/api/floor/meetings`)).json()).rows.find((r) => r.id === id) ?? null;
const heldNow = async () => ((await (await fetch(`${base}/api/floor`)).json()).meetings_held ?? []);
const until = async (fn, ms = 8000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) { const v = await fn(); if (v) return v; } return null; };
const waited = (page, expr, msg, opts = {}) => page.waitFor(expr, { timeout: 8000, ...opts }).then(() => { ok(true, msg); return true; }, (e) => { ok(false, msg, e.message.split('\n')[0]); return false; });
const boxOn = (id) => `!!document.querySelector('svg.room[data-channel="lab"] .meetBox[data-meeting="${id}"]')`;

const known = new Set();
/** Open a meeting room from the selection toolbar, as the operator does. */
async function meet(page, agents) {
  await page.click('svg.room[data-channel="lab"] [data-act="select-room"]');
  await page.waitFor(`!!document.querySelector('svg.room[data-channel="lab"].selecting')`);
  for (const a of agents) { await page.click(`svg.room.selecting .desk[data-agent="${a}"] .deskHit`); await sleep(120); }
  await page.waitFor(`document.querySelector('svg.room.selecting [data-act="sel-meeting"]')?.getAttribute('aria-disabled') === 'false'`);
  await page.press('svg.room.selecting [data-act="sel-meeting"]');
  const m = await attach((u) => isMeeting(u) && !known.has(u));
  await m.waitFor(`document.querySelectorAll('.m-part').length === ${agents.length} && /[?&]meeting=\\d+$/.test(location.search)`, { timeout: 15000 });
  const id = Number(new URLSearchParams(await m.evalJs('location.search')).get('meeting'));
  const url = await m.evalJs('location.href');
  known.add(url);
  await page.waitFor(`${boxOn(id)} && !document.querySelector('svg.room.selecting')`, { timeout: 8000 });
  return { m, id, url };
}
/** The app quitting with this room open: its word, then the window closes. */
async function holdAndClose(m) {
  const held = await m.evalJs('window.orchMeeting.hold().then(String)');
  await m.evalJs('window.close(), 1').catch(() => {});
  return held;
}

const floor = await open({ base, view: 'floor', floor: 'lab' });
await floor.resize(1280, 1500);
await floor.waitFor(`document.querySelectorAll('svg.room[data-channel="lab"] .desk').length === 9`, { timeout: 10000 });

console.log('\nthe app quits with a room open');
const A = await meet(floor, ['bo', 'cy']);
ok(await A.m.evalJs(`typeof window.orchMeeting?.hold === 'function'`), 'a room\'s window offers the app window.orchMeeting.hold()');
ok(await holdAndClose(A.m) === 'true', 'which says the board kept the meeting');
ok(!!await until(async () => !(await openWindows()).includes(A.url)), 'the room\'s window closed');
await sleep(1200);
const rowA = await meetingRow(A.id);
ok(rowA && rowA.ended_at === null, 'and the meeting did not end', JSON.stringify(rowA?.ended_at));
let held = await heldNow();
ok(held.some((h) => h.id === A.id && JSON.stringify(h.agents) === '["bo","cy"]'), 'the board lists it as held, with its desks', JSON.stringify(held));
await waited(floor, boxOn(A.id), 'the floor still draws its box, with no window showing it');
await sleep(2500);
ok(await floor.evalJs(boxOn(A.id)), 'and goes on drawing it across polls');
ok((await openWindows()).length === 0, 'a browser floor does not open the room by itself', JSON.stringify(await openWindows()));

console.log('\nthe panel of a desk in it');
await floor.click('svg.room[data-channel="lab"] .desk[data-agent="bo"] .deskHit');
await waited(floor, `!!document.querySelector('#floor-panel [data-act="open-held"]')`, 'Bo\'s panel offers "Open the meeting room"');
ok(await floor.evalJs(`!document.querySelector('#floor-panel #p-text') && !document.querySelector('#floor-panel [data-act="bring-back"]')`),
  'in place of a message box, and with no Bring back (there is no window to ask)');
ok(/still on, with no window open for it/.test(await floor.evalJs(`document.querySelector('#floor-panel .p-out-why')?.textContent ?? ''`)), 'and says why');

console.log('\n"In a meeting", pressed, opens the room');
await floor.press(`svg.room .meetBox[data-meeting="${A.id}"] .meetLabel`);
const A2 = await attach((u) => isMeeting(u) && u.includes(`meeting=${A.id}`), { timeout: 8000 });
await waited(A2, `document.querySelectorAll('.m-part').length === 2`, 'the room opens, and both desks join it again');
ok(!!await until(async () => !(await heldNow()).some((h) => h.id === A.id)), 'and the board no longer holds it: the window has it');
await sleep(2500);
ok(await floor.evalJs(boxOn(A.id)), 'the box stood throughout, now the window\'s');
ok(await floor.evalJs(`!!document.querySelector('#floor-panel [data-act="bring-back"]') && !document.querySelector('#floor-panel [data-act="open-held"]')`),
  'and Bo\'s panel offers Bring back again, as for any room with a window');

console.log('\nclosing the room\'s own window ends it (his ruling)');
await A2.evalJs('window.close(), 1').catch(() => {});
ok(!!await until(async () => !!(await meetingRow(A.id))?.ended_at), 'a close with no word from the app ends the meeting');
await waited(floor, `!(${boxOn(A.id)})`, 'and its box goes');
ok(!(await heldNow()).some((h) => h.id === A.id), 'nothing is held');

console.log('\nthe panel\'s button, and End on a held box');
const B = await meet(floor, ['dee', 'fay']);
ok(await holdAndClose(B.m) === 'true', 'a second room held as the app quits');
await waited(floor, boxOn(B.id), 'its box stands');
await floor.click('svg.room[data-channel="lab"] .desk[data-agent="dee"] .deskHit');
await waited(floor, `!!document.querySelector('#floor-panel [data-act="open-held"]')`, 'Dee\'s panel offers the room');
await floor.press('#floor-panel [data-act="open-held"]');
const B2 = await attach((u) => isMeeting(u) && u.includes(`meeting=${B.id}`), { timeout: 8000 });
await waited(B2, `document.querySelectorAll('.m-part').length === 2`, 'pressed, it opens the room with both desks');
ok(await holdAndClose(B2) === 'true', 'held again');
await waited(floor, boxOn(B.id), 'its box stands again');
await sleep(1500);
await floor.press(`svg.room .meetBox[data-meeting="${B.id}"] .meetEnd`);
ok(!!await until(async () => !!(await meetingRow(B.id))?.ended_at), 'End meeting on a held box ends it on the board, with no window to ask');
await waited(floor, `!(${boxOn(B.id)})`, 'and the box goes');
ok((await openWindows()).length === 0, 'and no window was opened for it', JSON.stringify(await openWindows()));

console.log('\nin the desktop app, a floor that loads with a held meeting opens its room, once');
const C = await meet(floor, ['bo', 'cy']);
ok(await holdAndClose(C.m) === 'true', 'a room held as the app quits');
ok(!!await until(async () => !(await openWindows()).length), 'its window closed');
const UA = `Object.defineProperty(navigator, 'userAgent', { value: navigator.userAgent + ' Electron/45.2.3 OrchestratinatorDesktop/0.14.4', configurable: true })`;
const app1 = await open({ base, view: 'floor', floor: 'lab' });
await app1.beforeLoad(UA);
const app2 = await open({ base, view: 'floor', floor: 'lab' });
await app2.beforeLoad(UA);
// Both load together, as the app's floor windows do at a launch.
await Promise.all([app1.goto(`${base}/?floor=lab`), app2.goto(`${base}/?floor=lab`)]);
const C2 = await attach((u) => isMeeting(u) && u.includes(`meeting=${C.id}`), { timeout: 12000 });
await waited(C2, `document.querySelectorAll('.m-part').length === 2`, 'the room comes back with its desks, with no click');
await sleep(4000);
const opened = (await openWindows()).filter((u) => u.includes(`meeting=${C.id}`));
ok(opened.length === 1, 'two app floors loading together open it once', JSON.stringify(opened));
ok(!(await heldNow()).some((h) => h.id === C.id), 'and it is not held any more');
await C2.click('[data-act="m-end"]');
ok(!!await until(async () => !!(await meetingRow(C.id))?.ended_at), 'its own End meeting ends it');

console.log(`\n${fails ? 'FAIL' : 'PASS'} · ${fails ? `${fails} of ${total} red` : `${total} ✓`}`);
process.exit(fails ? 1 : 0);

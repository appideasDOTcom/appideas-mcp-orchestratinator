#!/usr/bin/env node
/**
 * A meeting on the floor (costmo, 2026-11-16): the desks in a meeting room
 * stand in a box of their own, with "In a meeting" on its upper left corner
 * and End meeting, a button, on its upper right. Driven on a throwaway
 * server with seed-meeting.mjs's floor (`--more`: nine desks on lab) and
 * host, through real meeting windows.
 *
 *   run-check-meeting-box.sh <dir>       # the whole fixture; see there
 *
 * Steps: a floor with no meeting, as it was; a meeting of four opened from
 * the selection toolbar (the box from the click, one box throughout, three
 * to a row, its edge and its placards); an envelope leaving a boxed desk
 * from where it is drawn; a second meeting stacked under the first; a desk
 * brought back leaving its box; End meeting pressed in a selecting room;
 * the building, where the box is part of the storey's one row and scrolls
 * with it, the button reading "End" around one desk, a real press on it
 * that does not ride to the floor, and a press on the box's carpet that
 * does; End meeting by keyboard, with every desk back where it stood; a
 * room's window that never hears `end`, closed by the floor; a second
 * floor tab, which has no window to close; a room's window reloaded; and
 * the room's own End meeting. About a minute and a half.
 *
 * Every reading is the page's (probe-meeting-box.js), the windows open
 * (targets), the board's record (/api/floor/meetings) or what the host was
 * handed (work.jsonl). The layout's arithmetic is in test/floor.mjs ("a
 * meeting on the floor"); this is what a browser draws of it.
 */
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { open, attach, targets } from './drive.mjs';

const base = process.argv[2] ?? 'http://localhost:8945';
const shots = process.argv[3] ?? '/tmp';
const WORK = process.argv[4];
const DB = process.argv[5];
const REPO = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const Database = createRequire(`${REPO}/package.json`)('better-sqlite3');
const db = new Database(DB);
const P = fileURLToPath(new URL('./probe-meeting-box.js', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
let total = 0;
const ok = (cond, msg, extra = '') => {
  total++;
  console.log(`  ${cond ? '✓' : '✗'} ${msg}${cond || !extra ? '' : `  (${extra})`}`);
  if (!cond) fails++;
};
// A step that throws ends the check with a ✗ row naming it and the FAIL
// verdict (the same lines as check-select.mjs and check-meeting.mjs).
const stopped = (e) => { total++; fails++; console.log(`  ✗ the check stopped on: ${String(e?.message ?? e).split('\n')[0]}`); console.log(`\nFAIL · ${fails} of ${total} red`); process.exit(1); };
process.on('uncaughtException', stopped);
process.on('unhandledRejection', stopped);

const isMeeting = (u) => u.includes('meeting=');
const read = (page) => page.probe(P).then(JSON.parse);
const roomOf = (r, ch = 'lab') => r.rooms.find((x) => x.ch === ch);
const deskOf = (room, a) => room.desks.find((d) => d.agent === a);
const boxOf = (room, key) => room.boxes.find((b) => b.key === String(key));
const inside = (hit, f, tol = 0.75) => hit.l >= f.l - tol && hit.r <= f.r + tol && hit.t >= f.t - tol && hit.b <= f.b + tol;
const apart = (hit, f, tol = 0.75) => hit.r <= f.l + tol || hit.l >= f.r - tol || hit.b <= f.t + tol || hit.t >= f.b - tol;
const work = () => readFileSync(WORK, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const meetings = async () => (await (await fetch(`${base}/api/floor/meetings`)).json()).rows;
const openWindows = async () => (await targets()).filter(isMeeting);
/** A wait that is the claim: a row either way, never an exception with no verdict. */
const waited = (page, expr, msg, opts = {}) => page.waitFor(expr, { timeout: 8000, ...opts }).then(() => { ok(true, msg); return true; }, (e) => { ok(false, msg, e.message.split('\n')[0]); return false; });
const gone = async (url, ms = 8000) => { for (const until = Date.now() + ms; Date.now() < until; await sleep(100)) if (!(await openWindows()).includes(url)) return true; return false; };

/* Every state the lab room's boxes pass through, as the page draws them:
   a MutationObserver's log, because a box drawn for a moment (two boxes
   for one meeting half-way through its desks, a placard reading
   "Ending…") is gone before a poll reads it. */
const watchBoxes = (page) => page.evalJs(`(() => {
  window.__boxLog = [];
  window.__boxObs?.disconnect();
  const snap = () => {
    const s = JSON.stringify([...document.querySelectorAll('svg.room[data-channel="lab"] .meetBox')].map((g) => {
      const e = g.querySelector('.meetEnd');
      const who = (g.querySelector('.meetLabel title')?.textContent ?? '').split(/ (?:is|are) in a meeting room/)[0];
      return [g.dataset.meeting, [...e.querySelector('.meetTabText').childNodes].map((n) => n.textContent).join(''), e.getAttribute('aria-disabled'), who];
    }));
    if (window.__boxLog.at(-1) !== s) window.__boxLog.push(s);
  };
  window.__boxObs = new MutationObserver(snap);
  window.__boxObs.observe(document.getElementById('floor-rooms'), { childList: true, subtree: true });
  snap();
  return true; })()`);
const boxLog = (page) => page.evalJs('JSON.stringify(window.__boxLog)').then((s) => JSON.parse(s).map((x) => JSON.parse(x)));

const known = new Set();
/** Open a meeting room from the selection toolbar, as the operator does, and return its window and number. */
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
  await page.waitFor(`!!document.querySelector('svg.room[data-channel="lab"] .meetBox[data-meeting="${id}"]') && !document.querySelector('svg.room.selecting')`, { timeout: 8000 });
  return { m, id, url };
}

const floor = await open({ base, view: 'floor', floor: 'lab' });
await floor.resize(1280, 1500);
await floor.waitFor(`document.querySelectorAll('svg.room[data-channel="lab"] .desk').length === 9`, { timeout: 10000 });

console.log('\na floor with no meeting on it');
const r0 = await read(floor);
const home = roomOf(r0);
ok(home.boxes.length === 0 && home.desks.map((d) => d.agent).join() === 'bo,cy,dee,ed,fay,gus,hal,ivy,jo', 'nine desks in the floor\'s order and no box', JSON.stringify(home.desks.map((d) => d.agent)));
ok(JSON.stringify(home.desks.slice(0, 4).map((d) => d.at)) === JSON.stringify([[28, home.desks[0].at[1]], [226, home.desks[0].at[1]], [424, home.desks[0].at[1]], [28, home.desks[3].at[1]]]) && home.desks[3].at[1] > home.desks[0].at[1],
  'three to a row from the left margin, as it always was', JSON.stringify(home.desks.slice(0, 4).map((d) => d.at)));
const homeAt = Object.fromEntries(home.desks.map((d) => [d.agent, d.at]));

console.log('\na meeting of four, opened from the selection toolbar');
await watchBoxes(floor);
const A = await meet(floor, ['bo', 'cy', 'dee', 'fay']);
let log = await boxLog(floor);
ok(log.some((s) => s.length === 1 && s[0][0].startsWith('new:') && s[0][2] === 'true'), 'the box is drawn from the click, before the room\'s window has said anything, with End meeting dimmed: there is no window to tell yet', JSON.stringify(log));
ok(log.every((s) => s.length <= 1), 'and it is one box throughout: never two while the window takes its desks one at a time', JSON.stringify(log));
ok(JSON.stringify(log.at(-1)) === JSON.stringify([[String(A.id), 'End meeting', 'false', 'Bo, Cy, Dee and Fay']]), 'once the window has its number the box is that room\'s, and End meeting can be pressed', JSON.stringify(log.at(-1)));
let r = await read(floor);
let lab = roomOf(r);
let a = boxOf(lab, A.id);
const inA = ['bo', 'cy', 'dee', 'fay'];
const restA = ['ed', 'gus', 'hal', 'ivy', 'jo'];
ok(inA.every((n) => inside(deskOf(lab, n).hit, a.frame)), 'the four desks are inside the box, each whole: bubble, person, counter, nameplate and pills', JSON.stringify(a.frame));
ok(restA.every((n) => apart(deskOf(lab, n).hit, a.frame) && deskOf(lab, n).hit.t >= a.frame.b), 'the five others are outside it, under it');
ok(lab.desks.map((d) => d.agent).join() === 'bo,cy,dee,fay,ed,gus,hal,ivy,jo', 'the meeting\'s desks moved to the top of the floor, the rest following in their own order', lab.desks.map((d) => d.agent).join());
const [bo, cy, dee, fay] = inA.map((n) => deskOf(lab, n).at);
ok(bo[1] === cy[1] && cy[1] === dee[1] && JSON.stringify([bo[0], cy[0], dee[0]]) === '[28,226,424]' && fay[0] === 28 && fay[1] > bo[1],
  'three to a row inside the box: Bo, Cy and Dee on one row, Fay starting the next', JSON.stringify([bo, cy, dee, fay]));
ok(a.frame.t > lab.wall.b && a.label.plate.t >= lab.wall.b && restA.every((n) => deskOf(lab, n).hit.t > a.frame.b), 'the box is at the top of the floor: under the header, above every other desk', JSON.stringify({ wall: lab.wall.b, frame: a.frame.t }));
ok(Math.abs(a.frame.w / lab.scale - (620 - 2 * 19)) < 0.5, 'and the floor\'s full row wide', `${(a.frame.w / lab.scale).toFixed(1)} units`);
ok(a.strokeWidth === '2.5px' && a.vector === 'non-scaling-stroke' && a.stroke === 'rgb(184, 190, 199)', 'its edge is a light grey, 2.5px on screen whatever size the room is drawn at', JSON.stringify([a.stroke, a.strokeWidth, a.vector]));
ok(a.inTrack && a.underDesks, 'drawn under its desks, so nothing of a desk is behind it');
const mid = (p) => (p.t + p.b) / 2;
ok(a.label.text === 'In a meeting' && a.label.plate.l - a.frame.l > 4 && a.label.plate.l - a.frame.l < 30 && Math.abs(mid(a.label.plate) - a.frame.t) < 1.5,
  'the upper left corner carries a placard, "In a meeting", on the box\'s top edge', JSON.stringify(a.label));
ok(a.end.text === 'End meeting' && a.frame.r - a.end.plate.r > 4 && a.frame.r - a.end.plate.r < 30 && Math.abs(mid(a.end.plate) - a.frame.t) < 1.5,
  'the upper right corner carries one that reads End meeting', JSON.stringify(a.end));
ok(a.end.role === 'button' && a.end.tabindex === '0' && a.end.disabled === 'false' && a.end.act === 'meet-end' && a.end.meeting === String(A.id) && a.end.cursor === 'pointer',
  'which is a button: focusable, pressable, naming its room', JSON.stringify(a.end));
ok([a.label, a.end].every((t) => t.words.l >= t.plate.l + 2 && t.words.r <= t.plate.r - 2 && t.words.t >= t.plate.t - 1 && t.words.b <= t.plate.b + 1), 'the words of each fit on its plate, as the browser measures them',
  JSON.stringify([a.label.words, a.label.plate, a.end.words, a.end.plate]));
ok(/^Bo, Cy, Dee and Fay are in a meeting room\./.test(a.label.title) && /^End this meeting: Bo, Cy, Dee and Fay go back to the floor/.test(a.end.title), 'each says on hover who is in the meeting, and the button what it will do', `${a.label.title} | ${a.end.title}`);
ok(lab.meta === home.meta && r.totals === r0.totals, 'the floor\'s counts are as they were', `${home.meta} → ${lab.meta}`);
ok(lab.viewBox[1] > home.viewBox[1], 'and the room is taller by the box\'s edges, not cut off', `${home.viewBox[1]} → ${lab.viewBox[1]}`);

console.log('\nan envelope from a desk in the box');
await floor.evalJs(`(() => {
  window.__env = null;
  window.__envObs = new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) {
      if (window.__env || n.nodeType !== 1 || !n.classList?.contains('envelope')) continue;
      const svg = n.closest('svg.room');
      const nums = (text) => (text ?? '').match(/-?[\\d.]+/g)?.map(Number) ?? [];
      const at = (a) => nums(svg?.querySelector('.desk[data-agent="' + a + '"]')?.getAttribute('transform'));
      const path = nums(n.querySelector('animateMotion')?.getAttribute('path'));
      window.__env = { bo: at('bo'), ed: at('ed'), from: path.slice(0, 2), to: path.slice(-2) };
    }
  });
  window.__envObs.observe(document.getElementById('floor-rooms'), { childList: true, subtree: true });
  return true; })()`);
db.prepare(`INSERT INTO messages (channel, from_agent, to_agent, body) VALUES ('lab', 'bo', 'ed', '"from the meeting"')`).run();
await waited(floor, '!!window.__env', 'a message from Bo to Ed flies an envelope', { timeout: 10000 });
const env = JSON.parse(await floor.evalJs('JSON.stringify(window.__env)'));
await floor.evalJs('window.__envObs.disconnect(); true');
ok(!!env && env.from[0] === env.bo[0] + 84 && env.from[1] === env.bo[1] + 20 && env.to[0] === env.ed[0] + 84 && env.to[1] === env.ed[1] + 20 && env.bo[1] === bo[1],
  'from Bo where Bo is drawn in the box, to Ed where Ed is drawn under it', JSON.stringify(env));

console.log('\na second meeting on the same floor');
const B = await meet(floor, ['gus', 'hal']);
r = await read(floor);
lab = roomOf(r);
a = boxOf(lab, A.id);
let b = boxOf(lab, B.id);
ok(lab.boxes.map((x) => x.key).join() === `${A.id},${B.id}`, 'two boxes, the first meeting\'s first', lab.boxes.map((x) => x.key).join());
ok(b.frame.t > a.frame.b && b.label.plate.t > a.frame.b && Math.abs(b.frame.l - a.frame.l) < 0.5 && Math.abs(b.frame.w - a.frame.w) < 0.5, 'stacked: the second box under the first, the same width, its placards clear of the box above',
  JSON.stringify({ a: [a.frame.t, a.frame.b], b: [b.frame.t, b.frame.b] }));
ok(['gus', 'hal'].every((n) => inside(deskOf(lab, n).hit, b.frame)) && inA.every((n) => inside(deskOf(lab, n).hit, a.frame) && apart(deskOf(lab, n).hit, b.frame)), 'each meeting\'s desks in its own box and not the other\'s');
ok(JSON.stringify(inA.map((n) => deskOf(lab, n).at)) === JSON.stringify([bo, cy, dee, fay]), 'and the first meeting did not move when the second opened');
ok(['ed', 'ivy', 'jo'].every((n) => apart(deskOf(lab, n).hit, a.frame) && deskOf(lab, n).hit.t >= b.frame.b), 'the three desks in no meeting are under both');
ok(b.end.meeting === String(B.id) && b.end.text === 'End meeting' && /^Gus and Hal are in a meeting room\./.test(b.label.title), 'the second box has its own placards, for its own room', JSON.stringify([b.end.meeting, b.label.title]));
await floor.shot(`${shots}/box-two-meetings.png`, 'svg.room[data-channel="lab"]', { scale: 1, beyond: true });
await floor.scheme('light');
await sleep(300);
await floor.shot(`${shots}/box-two-meetings-light.png`, 'svg.room[data-channel="lab"]', { scale: 1, beyond: true });
const lightBox = boxOf(roomOf(await read(floor)), A.id);
ok(lightBox.stroke === 'rgb(184, 190, 199)' && lightBox.label.fill === 'rgb(184, 190, 199)' && lightBox.label.ink === 'rgb(27, 32, 38)', 'in the light theme the edge and the label are the same light grey, with dark words on it', JSON.stringify([lightBox.stroke, lightBox.label.fill, lightBox.label.ink]));
await floor.scheme(null);

console.log('\na desk brought back to the floor leaves its box');
await floor.click('#floor-rooms .desk[data-agent="fay"] .deskHit');
await floor.waitFor(`document.querySelector('#floor-panel')?.dataset.agent === 'fay' && !!document.querySelector('#floor-panel [data-act="bring-back"]')`);
ok(await floor.evalJs(`!document.querySelector('#floor-panel #p-text')`), 'a click on a desk in the box opens its panel as before: no composer while its chat is in the room, and the way back');
await floor.click('#floor-panel [data-act="bring-back"]');
await waited(floor, `document.querySelector('svg.room[data-channel="lab"] .desk[data-agent="fay"]')?.getAttribute('transform') !== 'translate(${fay[0]} ${fay[1]})'`, 'Bring back moves Fay on the floor at once');
await floor.click('#floor-panel [data-act="close-panel"]');
await floor.waitFor(`document.querySelector('#floor-panel')?.classList.contains('hidden')`).catch(() => {});
await A.m.waitFor(`document.querySelectorAll('.m-part').length === 3`, { timeout: 5000 });
r = await read(floor);
lab = roomOf(r);
a = boxOf(lab, A.id);
b = boxOf(lab, B.id);
ok(apart(deskOf(lab, 'fay').hit, a.frame) && apart(deskOf(lab, 'fay').hit, b.frame) && lab.desks.map((d) => d.agent).join() === 'bo,cy,dee,gus,hal,ed,fay,ivy,jo', 'Fay is out of the box and back among the desks in no meeting, in the floor\'s order', lab.desks.map((d) => d.agent).join());
ok(['bo', 'cy', 'dee'].every((n) => inside(deskOf(lab, n).hit, a.frame)) && /^Bo, Cy and Dee are in a meeting room\./.test(a.label.title), 'the box holds the three still in the meeting, and says so');
ok(a.frame.h < boxOf(roomOf(await read(floor)), A.id).frame.h + 1 && a.frame.b < b.frame.t && deskOf(lab, 'fay').at[1] === deskOf(lab, 'ed').at[1], 'one row shorter now, with the second box and the rest moved up under it');

console.log('\nEnd meeting, pressed while the room is selecting');
const chatsBefore = work().filter((x) => x.kind === 'chat').length;
await floor.click('svg.room[data-channel="lab"] [data-act="select-room"]');
await floor.waitFor(`!!document.querySelector('svg.room[data-channel="lab"].selecting')`);
await floor.click('svg.room.selecting .desk[data-agent="ed"] .deskHit');
await sleep(200);
r = await read(floor);
lab = roomOf(r);
ok(lab.selecting && lab.boxes.length === 2 && boxOf(lab, A.id).frame.t > lab.band.b && ['bo', 'cy', 'dee'].every((n) => inside(deskOf(lab, n).hit, boxOf(lab, A.id).frame)),
  'under the selection toolbar the boxes stand lower, clear of it, each still around its desks', JSON.stringify({ band: lab.band?.b, frame: boxOf(lab, A.id)?.frame.t }));
await floor.press(`svg.room .meetBox[data-meeting="${B.id}"] .meetEnd`);
await waited(floor, `!document.querySelector('svg.room .meetBox[data-meeting="${B.id}"]')`, 'a real press on the second box\'s End meeting takes that box away');
ok(await gone(B.url), 'its room\'s window closed', JSON.stringify(await openWindows()));
ok((await openWindows()).includes(A.url), 'and the other meeting\'s window did not');
r = await read(floor);
lab = roomOf(r);
ok(lab.selecting && await floor.evalJs(`document.querySelector('svg.room.selecting .desk[data-agent="ed"] .selBox')?.getAttribute('aria-checked') === 'true' && document.querySelector('svg.room.selecting .desk[data-agent="gus"] .selBox')?.getAttribute('aria-checked') === 'false'`),
  'the room is still selecting with its check as it was: the press ended a meeting and checked nothing');
ok(lab.boxes.map((x) => x.key).join() === String(A.id) && lab.desks.map((d) => d.agent).join() === 'bo,cy,dee,ed,fay,gus,hal,ivy,jo', 'Gus and Hal are back among the floor\'s desks, and the first meeting stands', lab.desks.map((d) => d.agent).join());
let rec = (await meetings()).find((x) => x.id === B.id);
ok(!!rec?.ended_at && rec.participants.map((p) => p.agent).join() === 'gus,hal', 'the board has that room ended, with who was in it, for Resume', JSON.stringify(rec));
await floor.click('svg.room[data-channel="lab"] [data-act="select-room"]');
await floor.waitFor(`!document.querySelector('svg.room.selecting')`);

console.log('\nthe building: the box is part of the storey\'s one row');
const C = await meet(floor, ['gus', 'hal']);
await floor.click('#floor-pick [data-floor=""]');
await floor.waitFor(`document.getElementById('floor-rooms').classList.contains('building') && !!document.querySelector('svg.room[data-channel="lab"].collapsed')`);
await sleep(400);
r = await read(floor);
lab = roomOf(r);
a = boxOf(lab, A.id);
let c = boxOf(lab, C.id);
ok(lab.collapsed && lab.desks.map((d) => d.agent).join() === 'bo,cy,dee,gus,hal,ed,fay,ivy,jo' && lab.desks.every((d, i) => d.at[1] === lab.desks[0].at[1] && d.at[0] === 28 + i * 198),
  'a storey is still one row: the meetings\' desks first, then the rest, a cell apart', JSON.stringify(lab.desks.map((d) => d.at)));
ok(['bo', 'cy', 'dee'].every((n) => inside(deskOf(lab, n).hit, a.frame)) && ['gus', 'hal'].every((n) => inside(deskOf(lab, n).hit, c.frame)) && lab.desks.filter((d) => !['bo', 'cy', 'dee'].includes(d.agent)).every((d) => apart(d.hit, a.frame)),
  'each meeting\'s desks inside its own box, the boxes side by side');
ok(c.frame.l > a.frame.r && Math.abs(c.frame.t - a.frame.t) < 0.5 && a.frame.t > lab.wall.b && a.label.plate.t >= lab.wall.b, 'with air between them, under the header', JSON.stringify({ a: a.frame, c: c.frame }));
ok(a.inTrack && c.inTrack && a.frame.l >= lab.rect.l && a.label.text === 'In a meeting' && a.end.text === 'End meeting', 'the first box starts inside the storey\'s left margin, with both placards');
const edgeHit = await floor.evalJs(`document.elementFromPoint(${a.frame.l + 1.5}, ${(a.frame.t + a.frame.b) / 2})?.getAttribute('class') ?? null`);
ok(edgeHit === 'meetFrame', 'and its left edge is drawn, not cut off by the margin the storey\'s desks are clipped to', String(edgeHit));
const plain = roomOf(r, 'lab2');
ok(lab.viewBox[1] > plain.viewBox[1] && lab.viewBox[1] - plain.viewBox[1] < 60, 'the storey is a little taller for the box, not a row taller', `${plain.viewBox[1]} → ${lab.viewBox[1]}`);
await floor.shot(`${shots}/box-building.png`, '#floor-rooms', { scale: 1, beyond: true });

// One desk left in the second meeting: its box is one desk wide.
await C.m.click('.m-part[data-for-agent="hal"] [data-act="m-remove"]');
await floor.waitFor(`document.querySelector('svg.room[data-channel="lab"] .meetBox[data-meeting="${C.id}"] .meetEnd .meetTabText')?.textContent === 'End'`, { timeout: 5000 }).catch(() => {});
r = await read(floor);
lab = roomOf(r);
c = boxOf(lab, C.id);
ok(c.end.text === 'End' && c.label.text === 'In a meeting' && inside(deskOf(lab, 'gus').hit, c.frame) && apart(deskOf(lab, 'hal').hit, c.frame), 'around one desk the button reads "End", beside the label', JSON.stringify([c.label.text, c.end.text]));
ok(c.end.plate.l - c.label.plate.r >= 4 && c.end.plate.r <= c.frame.r && c.label.plate.l >= c.frame.l && [c.label, c.end].every((t) => t.words.l >= t.plate.l + 2 && t.words.r <= t.plate.r - 2), 'both on the box, clear of each other, their words on their plates',
  JSON.stringify([c.label.plate, c.end.plate, c.frame]));
ok(/^End this meeting: Gus goes back to the floor/.test(c.end.title), 'and its hover says the rest', c.end.title);

// It is the fourth cell, off the right of the storey: one press on the arrow brings it in.
ok(c.end.plate.r > lab.rect.r - 28 * lab.scale, 'that box starts off the right of the storey, where its button cannot be pressed', JSON.stringify({ end: c.end.plate.r, room: lab.rect.r }));
await floor.press('svg.room[data-channel="lab"] .deskArrow.right');
await floor.waitFor(`document.querySelector('svg.room[data-channel="lab"] .deskTrack').getAttribute('transform') === 'translate(-198 0)'`);
await sleep(450);
r = await read(floor);
lab = roomOf(r);
c = boxOf(lab, C.id);
ok(r.building && c.end.plate.r < lab.rect.r - 20 * lab.scale && c.frame.r < lab.rect.r && boxOf(lab, A.id).frame.l < home.rect.l + 28, 'the arrow scrolls the boxes with their desks: the second is in view, the first part-way out', JSON.stringify({ c: c.frame, room: lab.rect }));
await floor.shot(`${shots}/box-building-scrolled.png`, 'svg.room[data-channel="lab"]', { scale: 1, beyond: true });
const lit = await floor.press(`svg.room .meetBox[data-meeting="${C.id}"] .meetEnd`, undefined, {
  held: () => floor.evalJs(`JSON.stringify({ plate: getComputedStyle(document.querySelector('svg.room .meetBox[data-meeting="${C.id}"] .meetEnd .meetTabBox')).stroke,
    carpet: getComputedStyle(document.querySelector('svg.room[data-channel="lab"] .roomFloor')).fill, other: getComputedStyle(document.querySelector('svg.room[data-channel="lab2"] .roomFloor')).fill })`).then(JSON.parse),
});
ok(lit.during.plate !== 'rgb(184, 190, 199)' && lit.during.carpet === lit.during.other, 'under the pointer the button lights and the storey does not: it is not "ride to this floor"', JSON.stringify(lit.during));
await waited(floor, `!document.querySelector('svg.room .meetBox[data-meeting="${C.id}"]')`, 'a real press on it in the building ends that meeting');
r = await read(floor);
ok(r.building && r.floor !== 'lab' && roomOf(r).collapsed, 'without riding to the floor: the page is still the building', JSON.stringify([r.building, r.floor]));
ok(await gone(C.url) && (await openWindows()).includes(A.url), 'its window closed, the first meeting\'s did not');
rec = (await meetings()).find((x) => x.id === C.id);
ok(!!rec?.ended_at, 'and the board has it ended', JSON.stringify(rec));

// The box is scenery in the building, like the desks in it: a press on its carpet rides to the floor.
await floor.press('svg.room[data-channel="lab"] .deskArrow.left');
await sleep(450);
r = await read(floor);
lab = roomOf(r);
a = boxOf(lab, A.id);
const gapX = (deskOf(lab, 'bo').hit.r + deskOf(lab, 'cy').hit.l) / 2;
await floor.press({ x: gapX, y: (a.frame.t + a.frame.b) / 2 });
await waited(floor, `!document.getElementById('floor-rooms').classList.contains('building') && localStorage.getItem('orch.floor') === 'lab'`, 'a press on the box\'s carpet, between two desks, rides to that floor as any press on a storey does');
await floor.waitFor(`!document.querySelector('svg.room[data-channel="lab"].collapsed')`);

console.log('\nEnd meeting from the keyboard, and everything back where it was');
// Ed's card is open while the meeting above it ends: Ed moves up the floor
// with nothing clicked, and the card must go with the desk.
await floor.click('svg.room[data-channel="lab"] .desk[data-agent="ed"] .plate[data-act="details"]');
await floor.waitFor(`!!document.getElementById('desk-pop')`);
const cardAt = () => floor.evalJs(`(() => { const p = document.getElementById('desk-pop')?.getBoundingClientRect(); const d = document.querySelector('svg.room[data-channel="lab"] .desk[data-agent="ed"]')?.getBoundingClientRect();
  return JSON.stringify(p && d ? { dy: Math.round(p.top - d.bottom), dx: Math.round((p.left + p.width / 2) - (d.left + d.width / 2)), top: Math.round(d.top) } : null); })()`).then(JSON.parse);
const card0 = await cardAt();
await watchBoxes(floor);
ok(await floor.evalJs(`(() => { const e = document.querySelector('svg.room .meetBox[data-meeting="${A.id}"] .meetEnd'); e.focus(); return document.activeElement === e; })()`), 'the button takes focus');
await floor.key('Enter');
await waited(floor, `!document.querySelector('svg.room[data-channel="lab"] .meetBox')`, 'Enter on it ends the meeting');
log = await boxLog(floor);
ok(log.some((s) => s.length === 1 && s[0][1] === 'Ending…' && s[0][2] === 'true'), 'between the press and the desks coming back it read "Ending…" and could not be pressed again', JSON.stringify(log));
ok(log.some((s) => s.length === 1 && s[0][3] === 'Cy and Dee') && log.some((s) => s.length === 1 && s[0][3] === 'Dee'), 'the box emptied a desk at a time, as the window let each go, not all at once at the floor\'s next poll', JSON.stringify(log.map((s) => s.map((x) => x[3]))));
ok(await gone(A.url) && (await openWindows()).length === 0, 'the room\'s window closed, and no meeting window is left', JSON.stringify(await openWindows()));
const card1 = await cardAt();
ok(!!card0 && !!card1 && card1.top < card0.top - 20 && Math.abs(card1.dy - card0.dy) <= 2 && Math.abs(card1.dx - card0.dx) <= 2, 'Ed\'s card, open all the while, went up the floor with Ed: it hangs under the desk as it did', JSON.stringify([card0, card1]));
await floor.click('svg.room[data-channel="lab"] .desk[data-agent="ed"] .plate[data-act="details"]');
r = await read(floor);
lab = roomOf(r);
ok(lab.boxes.length === 0 && lab.desks.every((d) => JSON.stringify(d.at) === JSON.stringify(homeAt[d.agent])) && lab.desks.map((d) => d.agent).join() === home.desks.map((d) => d.agent).join(),
  'every desk is back where it stood before any meeting, in the floor\'s order', JSON.stringify(lab.desks.map((d) => [d.agent, d.at])));
ok(JSON.stringify(lab.viewBox) === JSON.stringify(home.viewBox) && lab.meta === home.meta && r.totals === r0.totals, 'and the room is the size it was, with the counts it had', JSON.stringify([home.viewBox, lab.viewBox]));
rec = (await meetings()).find((x) => x.id === A.id);
ok(!!rec?.ended_at && rec.participants.map((p) => p.agent).join() === 'bo,cy,dee', 'the board has the room ended with the three who were in it at the end: it is in Recent meeting rooms for Resume', JSON.stringify(rec));
ok(work().filter((x) => x.kind === 'chat').length === chatsBefore, 'and ending a meeting from the floor, four times over, typed into nobody\'s window');
await floor.click('[data-act="meetings"]');
await floor.waitFor(`!!document.querySelector('.meet-row')`, { timeout: 5000 });
ok(await floor.evalJs(`!![...document.querySelectorAll('.meet-row')].find((x) => x.querySelector('[data-do="meeting-resume"][data-id="${A.id}"]'))`), 'where the floor lists it, with Resume');

console.log('\nResume puts the desks back in a box');
await watchBoxes(floor);
await floor.press(`.meet-row [data-do="meeting-resume"][data-id="${A.id}"]`);
const R1 = await attach((u) => isMeeting(u));
await R1.waitFor(`document.querySelectorAll('.m-part').length === 3`, { timeout: 25000 });
await floor.evalJs(`document.getElementById('dlg')?.close(); true`);
await waited(floor, `!!document.querySelector('svg.room[data-channel="lab"] .meetBox[data-meeting="${A.id}"]')`, 'the resumed room is a box on the floor again, under its own number');
await floor.waitFor(`document.querySelector('svg.room[data-channel="lab"] .desk[data-agent="dee"]')?.getAttribute('transform') === 'translate(${dee[0]} ${bo[1]})'`, { timeout: 8000 }).catch(() => {});
r = await read(floor);
lab = roomOf(r);
a = boxOf(lab, A.id);
ok(!!a && ['bo', 'cy', 'dee'].every((n) => inside(deskOf(lab, n).hit, a.frame)) && a.end.disabled === 'false' && a.end.text === 'End meeting',
  'with the three desks it had in it, and End meeting ready: not still "Ending…" from the press that closed it a few seconds ago', JSON.stringify([a?.end.text, a?.end.disabled, lab.desks.map((d) => d.agent)]));
log = await boxLog(floor);
ok(log.some((s) => s.length === 1 && s[0][3] === 'Bo') && log.every((s) => s.length <= 1), 'it filled a desk at a time, as each joined the room, and was one box throughout', JSON.stringify(log.map((s) => s.map((x) => x[3]))));
const urlR = await R1.evalJs('location.href');

console.log('\na room\'s window that never hears the floor');
// The floor's `end` is dropped on its way out, which is what a window
// loaded before this build is: it knows no such message.
const deaf = (page, on) => page.evalJs(on
  ? `(() => { const real = BroadcastChannel.prototype.postMessage; window.__realPost = real; BroadcastChannel.prototype.postMessage = function (m) { if (m?.t === 'end') { window.__dropped = (window.__dropped ?? 0) + 1; return; } return real.call(this, m); }; return true; })()`
  : `(() => { if (window.__realPost) BroadcastChannel.prototype.postMessage = window.__realPost; return window.__dropped ?? 0; })()`);
await deaf(floor, true);
await watchBoxes(floor);
const t0 = Date.now();
await floor.press(`svg.room .meetBox[data-meeting="${A.id}"] .meetEnd`);
await sleep(500);
r = await read(floor);
a = boxOf(roomOf(r), A.id);
ok(!!a && a.end.text === 'Ending…' && a.end.disabled === 'true' && (await openWindows()).includes(urlR), 'half a second after the press the placard reads "Ending…", and the window, which heard nothing, is still open', JSON.stringify(a?.end));
ok(await gone(urlR, 6000), 'the floor then closes that window itself, by the handle it holds: nothing is left for the operator to do', JSON.stringify(await openWindows()));
await waited(floor, `!document.querySelector('svg.room[data-channel="lab"] .meetBox')`, 'and the box goes when the closed window lets its desks go');
const took = Date.now() - t0;
ok(took < 8000, `inside eight seconds of the press (${took} ms)`);
const dropped = await deaf(floor, false);
ok(dropped === 1, 'the fixture held: exactly one `end` was sent, and dropped', `dropped ${dropped}`);
for (let i = 0; i < 30 && !(await meetings()).find((x) => x.id === A.id)?.ended_at; i++) await sleep(100);
ok(!!(await meetings()).find((x) => x.id === A.id)?.ended_at, 'the closed window ended the board\'s record as a closed window always has');

console.log('\na second floor tab, which holds no window');
const D = await meet(floor, ['bo', 'cy']);
const floor2 = await open({ base, view: 'floor', floor: 'lab' });
await floor2.resize(1280, 1500);
await waited(floor2, `!!document.querySelector('svg.room[data-channel="lab"] .meetBox[data-meeting="${D.id}"]')`, 'a floor opened while a meeting is on draws its box: the room\'s window answers when asked');
let r2 = await read(floor2);
let d2 = boxOf(roomOf(r2), D.id);
ok(['bo', 'cy'].every((n) => inside(deskOf(roomOf(r2), n).hit, d2.frame)) && d2.end.disabled === 'false' && d2.end.text === 'End meeting', 'with its desks in it and End meeting ready', JSON.stringify(d2?.end));
await deaf(floor2, true);
await floor2.press(`svg.room .meetBox[data-meeting="${D.id}"] .meetEnd`);
await sleep(600);
ok(boxOf(roomOf(await read(floor2)), D.id)?.end.text === 'Ending…', 'pressed there with the window deaf to it, it reads "Ending…"');
await sleep(6600);
r2 = await read(floor2);
d2 = boxOf(roomOf(r2), D.id);
ok(!!d2 && d2.end.text === 'End meeting' && d2.end.disabled === 'false' && (await openWindows()).includes(D.url), 'and seven seconds on, with no window of its own to close, it is a button again on a box that still stands: the meeting is still on, and the floor says so');
await deaf(floor2, false);
await floor2.press(`svg.room .meetBox[data-meeting="${D.id}"] .meetEnd`);
await waited(floor2, `!document.querySelector('svg.room[data-channel="lab"] .meetBox')`, 'pressed again, heard this time, it ends the meeting from the tab that did not open it');
await waited(floor, `!document.querySelector('svg.room[data-channel="lab"] .meetBox')`, 'and the box goes from the first tab too');
ok(await gone(D.url), 'the window closed');

console.log('\na room\'s window reloaded, and the room\'s own End meeting');
const E = await meet(floor, ['dee', 'ed']);
await watchBoxes(floor);
await E.m.evalJs('location.reload(); 1');
await sleep(600);
await E.m.waitFor(`document.querySelectorAll('.m-part').length === 2`, { timeout: 15000 });
await sleep(2200);
log = await boxLog(floor);
ok(log.length >= 1 && log.every((s) => s.length === 1 && s[0][0] === String(E.id)), 'through a reload of the room\'s window the box stays where it is: the desks do not jump out and back', JSON.stringify(log));
ok(await floor2.evalJs(`!!document.querySelector('svg.room[data-channel="lab"] .meetBox[data-meeting="${E.id}"]')`), 'on the other tab as well');
await E.m.click('[data-act="m-end"]');
await waited(floor, `!document.querySelector('svg.room[data-channel="lab"] .meetBox')`, 'End meeting in the room\'s own window takes the box off the floor');
r = await read(floor);
lab = roomOf(r);
ok(lab.desks.every((d) => JSON.stringify(d.at) === JSON.stringify(homeAt[d.agent])) && JSON.stringify(lab.viewBox) === JSON.stringify(home.viewBox), 'and the floor is as it was at the start');

const noise = [...await floor.console(), ...await floor2.console()];
ok(noise.length === 0, 'no console warning or error, and no uncaught exception, on either floor tab', JSON.stringify(noise).slice(0, 400));

console.log(fails ? `\nFAIL · ${fails} of ${total} red` : `\nPASS · ${total} of ${total}`);
process.exit(fails ? 1 : 0);

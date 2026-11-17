#!/usr/bin/env node
/**
 * One agent, several sessions, as a person meets it on the page (costmo,
 * 2026-11-16, 0.12.9): the nameplate card's Leave room and its controls
 * going dim in a meeting room; a desk that is already in a meeting room put
 * in a second one, as a second session; Bring back taking the agent out of
 * every room; a room resumed with its second session made again; and Take a
 * desk's New desk here. Driven on a throwaway server with seed-sessions.mjs's
 * floor and host, through real meeting windows.
 *
 *   run-check-sessions.sh <dir>       # the whole fixture; see there
 *
 * Every reading is the page's (the card, the dialog, probe-meeting-box.js),
 * the windows open (targets), or what the host was handed (work.jsonl). The
 * decisions are in test/floor.mjs ("one agent, several sessions") and what a
 * host does with them in test/seats.mjs; this is what a browser draws and
 * sends.
 *
 * One step is the fixture's and not a person's: a second session made for a
 * meeting room is left alone for its first 30 s (its room is recorded a
 * moment after it is made), so the check ages it in the database before it
 * takes it out of its room, and says so in the row.
 */
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { open, attach, targets } from './drive.mjs';

const base = process.argv[2] ?? 'http://localhost:8949';
const shots = process.argv[3] ?? '/tmp';
const WORK = process.argv[4];
const DB = process.argv[5];
const CTL = process.argv[6];
const REPO = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const Database = createRequire(`${REPO}/package.json`)('better-sqlite3');
const P = fileURLToPath(new URL('./probe-meeting-box.js', import.meta.url));
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
const read = (page) => page.probe(P).then(JSON.parse);
const roomOf = (r, ch = 'lab') => r.rooms.find((x) => x.ch === ch);
const deskOf = (room, a) => room?.desks.find((d) => d.agent === a);
const boxOf = (room, key) => room?.boxes.find((b) => b.key === String(key));
const inside = (hit, f, tol = 0.75) => !!hit && !!f && hit.l >= f.l - tol && hit.r <= f.r + tol && hit.t >= f.t - tol && hit.b <= f.b + tol;
const work = () => readFileSync(WORK, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const workSince = (n) => work().slice(n);
const api = async () => (await fetch(`${base}/api/floor`)).json();
const deskNow = async (ch, a) => (await api()).channels.find((c) => c.channel === ch)?.desks.find((d) => d.agent === a) ?? null;
const meetings = async () => (await (await fetch(`${base}/api/floor/meetings`)).json()).rows;
const openWindows = async () => (await targets()).filter(isMeeting);
const waited = (page, expr, msg, opts = {}) => page.waitFor(expr, { timeout: 10000, ...opts }).then(() => { ok(true, msg); return true; }, (e) => { ok(false, msg, e.message.split('\n')[0]); return false; });
const until = async (fn, ms = 10000) => { for (const stop = Date.now() + ms; Date.now() < stop; await sleep(150)) { const v = await fn(); if (v) return v; } return null; };
/** The fixture's own step: a second session is old enough to be closed. */
const age = (agent) => { const db = new Database(DB); try { db.prepare(`UPDATE desk_twins SET created_at = datetime('now', '-60 seconds') WHERE agent = ?`).run(agent); } finally { db.close(); } };

const card = (page) => page.evalJs(`JSON.stringify((() => {
  const pop = document.getElementById('desk-pop');
  if (!pop) return null;
  return {
    name: pop.querySelector('.dp-head strong')?.textContent ?? null,
    buttons: [...pop.querySelectorAll('.dp-foot button')].map((b) => ({ act: b.dataset.act, text: b.textContent, disabled: b.disabled, top: Math.round(b.getBoundingClientRect().top) })),
    why: [...pop.querySelectorAll('.dp-foot p')].map((p) => p.textContent),
  };
})())`).then(JSON.parse);
const openCard = async (page, ch, agent) => {
  await page.evalJs(`document.getElementById('desk-pop')?.remove(); 1`);
  await page.click(`svg.room[data-channel="${ch}"] .desk[data-agent="${agent}"] .plate[data-act="details"]`);
  await page.waitFor(`!!document.querySelector('#desk-pop [data-agent="${agent}"]')`);
  return card(page);
};
const closeCard = (page) => page.evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.body.click(); 1`);
const dialogText = (page) => page.evalJs(`document.querySelector('dialog[open]')?.innerText ?? ''`);
const say = async (page, words) => {
  await page.evalJs(`(() => { const t = document.querySelector('#p-text'); t.value = ${JSON.stringify(words)}; t.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await page.click('#floor-panel [data-act="send"]');
};
const parts = (m) => m.evalJs(`JSON.stringify([...document.querySelectorAll('.m-part')].map((n) => n.dataset.forAgent))`).then(JSON.parse);
const notes = (m) => m.evalJs(`JSON.stringify([...document.querySelectorAll('.m-note')].map((n) => n.textContent))`).then(JSON.parse);

const known = new Set();
/** Open a meeting room from the selection toolbar, as the operator does. `want` is who its window should hold. */
async function meet(page, check, want) {
  await page.click('svg.room[data-channel="lab"] [data-act="select-room"]');
  await page.waitFor(`!!document.querySelector('svg.room[data-channel="lab"].selecting')`);
  for (const a of check) { await page.click(`svg.room.selecting .desk[data-agent="${a}"] .deskHit`); await sleep(120); }
  const chip = await page.evalJs(`JSON.stringify((() => { const c = document.querySelector('svg.room.selecting [data-act="sel-meeting"]'); return { off: c?.getAttribute('aria-disabled'), text: [...c.querySelectorAll('text')].map((t) => t.textContent).join(''), title: c.querySelector('title')?.textContent ?? '' }; })())`).then(JSON.parse);
  if (chip.off !== 'false') return { chip };
  await page.press('svg.room.selecting [data-act="sel-meeting"]');
  const m = await attach((u) => isMeeting(u) && !known.has(u));
  await m.waitFor(`document.querySelectorAll('.m-part').length === ${want.length} && /[?&]meeting=\\d+$/.test(location.search)`, { timeout: 20000 });
  const id = Number(new URLSearchParams(await m.evalJs('location.search')).get('meeting'));
  const url = await m.evalJs('location.href');
  known.add(url);
  return { m, id, url, chip };
}

const floor = await open({ base, view: 'floor', floor: 'lab' });
await floor.resize(1280, 1500);
await floor.waitFor(`document.querySelectorAll('svg.room[data-channel="lab"] .desk').length === 3`, { timeout: 10000 });

console.log('\nthe nameplate card, on a desk in no meeting room');
let c = await openCard(floor, 'lab', 'qa');
ok(JSON.stringify(c.buttons.map((b) => b.text)) === JSON.stringify(['Open conversation', 'Move to another floor', 'Hide desk', 'Leave room']), 'Leave room is on the card, under Hide desk', JSON.stringify(c.buttons.map((b) => b.text)));
ok(c.buttons.every((b, i, all) => i === 0 || b.top > all[i - 1].top), 'each button under the one before it, as the browser lays them out', JSON.stringify(c.buttons.map((b) => b.top)));
ok(c.buttons.every((b) => !b.disabled) && c.why.length === 0, 'and every one of them can be pressed, with nothing to explain', JSON.stringify(c));
await floor.press('#desk-pop [data-act="leave-room"]');
await waited(floor, `/^Leave desk — Qa/.test(document.querySelector('dialog[open] h3')?.textContent ?? '')`, 'Leave room opens the Leave desk dialog, for this desk: it asks first');
let d = await dialogText(floor);
ok(/Take a desk\s+brings it back/.test(d.replace(/\s+/g, ' ')) && /conversations stay where they are/.test(d.replace(/\s+/g, ' ')), 'which says what stays and how the agent comes back', d.replace(/\s+/g, ' ').slice(0, 260));
ok(!(await floor.evalJs(`!!document.getElementById('desk-pop')`)), 'the card is closed under it');
await floor.click('dialog[open] [data-do="cancel"]');
ok(work().every((x) => x.kind !== 'unbind') && !!(await deskNow('lab', 'qa'))?.hosted?.live, 'Cancel leaves the desk where it is: nothing was asked of its host');

console.log('\nin a meeting room, the card\'s controls cannot be pressed');
const A = await meet(floor, ['qa', 'dev'], ['qa', 'dev']);
await floor.waitFor(`!!document.querySelector('svg.room[data-channel="lab"] .meetBox[data-meeting="${A.id}"]') && !document.querySelector('svg.room.selecting')`, { timeout: 8000 });
c = await openCard(floor, 'lab', 'qa');
ok(c.buttons.length === 4 && c.buttons.every((b) => b.disabled), 'all four are dimmed, Open conversation and Leave room included', JSON.stringify(c.buttons.map((b) => [b.text, b.disabled])));
ok(c.why.length === 1 && /^In a meeting room: .*Bring it back from the meeting room, or end the meeting, to use these\.$/.test(c.why[0]), 'with the one reason under them, and what gives them back', JSON.stringify(c.why));
await floor.shot(`${shots}/card-in-meeting.png`, '#desk-pop', { scale: 2 });
const w0 = work().length;
for (const act of ['open', 'move-desk', 'hide-desk', 'leave-room']) await floor.click(`#desk-pop [data-act="${act}"]`);
await sleep(600);
ok(!(await floor.evalJs(`!!document.querySelector('dialog[open]')`)) && (await floor.evalJs(`document.querySelector('#floor-panel')?.classList.contains('hidden') ?? true`)) && workSince(w0).length === 0 && !(await deskNow('lab', 'qa'))?.hidden,
  'a click sent to each does nothing: no dialog, no panel, no flag, nothing asked of the host');
await closeCard(floor);
c = await openCard(floor, 'lab', 'ops');
ok(c.buttons.every((b) => !b.disabled), 'a desk on the same floor that is in no meeting room keeps all four', JSON.stringify(c.buttons.map((b) => [b.text, b.disabled])));
await closeCard(floor);

console.log('\na desk that is in a meeting room, put in a second one');
const w1 = work().length;
const B = await meet(floor, ['qa', 'ops'], ['ops', 'qa-2']);
ok(B.chip.off === 'false' && /Meeting room · 2/.test(B.chip.text), 'the selection\'s Meeting room counts the desk that is already in a room, and can be pressed', JSON.stringify(B.chip.text));
ok(/Qa \(qa\) is in another meeting room: this room gets a new session of it, and the one there carries on\./.test(B.chip.title), 'saying on hover what it will do with it', B.chip.title);
ok(JSON.stringify((await parts(B.m)).sort()) === JSON.stringify(['ops', 'qa-2']), 'the new room holds the other desk and a second session of the agent', JSON.stringify(await parts(B.m)));
ok(JSON.stringify((await parts(A.m)).sort()) === JSON.stringify(['dev', 'qa']), 'and the first room still holds the agent\'s first', JSON.stringify(await parts(A.m)));
const seat = workSince(w1).filter((x) => x.kind === 'seat');
ok(seat.length === 1 && seat[0].channel === 'lab' && seat[0].agent === 'qa-2' && seat[0].payload.path === '/repo/qa' && JSON.stringify(seat[0].payload.beside) === JSON.stringify({ channel: 'lab', agent: 'qa' }) && !seat[0].payload.session_id,
  'the agent\'s host was asked for one new desk in its folder, beside its own, on a new conversation', JSON.stringify(seat));
ok(workSince(w1).every((x) => !['bind', 'unbind', 'reopen'].includes(x.kind)), 'and for nothing else: the session it has was not moved, closed or reopened', JSON.stringify(workSince(w1).map((x) => x.kind)));
ok((await notes(B.m)).some((n) => /is in another meeting room, so this room has a new session of it \(qa-2\)\. The one there carries on\./.test(n)), 'the room says so in its own voice', JSON.stringify(await notes(B.m)));
await waited(floor, `!!document.querySelector('svg.room[data-channel="lab"] .desk[data-agent="qa-2"]') && !!document.querySelector('svg.room[data-channel="lab"] .meetBox[data-meeting="${B.id}"]')`, 'on the floor the agent has a second desk, and the new room a box');
let r = await read(floor);
let lab = roomOf(r);
ok(inside(deskOf(lab, 'qa-2')?.hit, boxOf(lab, B.id)?.frame) && inside(deskOf(lab, 'ops')?.hit, boxOf(lab, B.id)?.frame), 'the second desk stands in the new room\'s box, with the desk it meets', JSON.stringify(boxOf(lab, B.id)?.frame));
ok(inside(deskOf(lab, 'qa')?.hit, boxOf(lab, A.id)?.frame) && inside(deskOf(lab, 'dev')?.hit, boxOf(lab, A.id)?.frame) && lab.boxes.length === 2, 'and the first still stands in the first room\'s: the agent is in two places at once', JSON.stringify(lab.boxes.map((b) => b.key)));
const plates = await floor.evalJs(`JSON.stringify(Object.fromEntries([...document.querySelectorAll('svg.room[data-channel="lab"] .desk')].map((g) => [g.dataset.agent, [g.querySelector('.plateName')?.textContent, g.querySelector('.plateRole')?.textContent]])))`).then(JSON.parse);
ok(plates.qa?.[0] === 'Qa' && plates['qa-2']?.[0] === 'Qa · 2' && /^qa-2 · /.test(plates['qa-2']?.[1] ?? ''), 'the second nameplate is the agent\'s name with its number, over its own id', JSON.stringify([plates.qa, plates['qa-2']]));
const twinApi = await deskNow('lab', 'qa-2');
const baseApi = await deskNow('lab', 'qa');
ok(twinApi?.shirt === baseApi?.shirt && twinApi?.hair === baseApi?.hair && twinApi?.persona === baseApi?.persona && JSON.stringify(twinApi?.twin) === JSON.stringify({ of: 'qa', n: 2, meeting: true }),
  'with the agent\'s own name and colours, and the board saying whose second session it is', JSON.stringify([twinApi?.twin, twinApi?.shirt, baseApi?.shirt]));
await floor.shot(`${shots}/two-rooms.png`, 'svg.room[data-channel="lab"]', { scale: 1 });

console.log('\neach room speaks to its own session');
let w2 = work().length;
await say(B.m, 'for the second room only');
await until(() => workSince(w2).filter((x) => x.kind === 'chat').length >= 2);
ok(JSON.stringify(workSince(w2).filter((x) => x.kind === 'chat').map((x) => x.agent).sort()) === JSON.stringify(['ops', 'qa-2']), 'a message from the second room is typed to its two desks, the second session among them', JSON.stringify(workSince(w2).map((x) => [x.kind, x.agent])));
await B.m.waitFor(`[...document.querySelectorAll('.t-assistant')].some((n) => /qa-2 heard: for the second room only/.test(n.textContent))`, { timeout: 10000 });
ok(!(await A.m.evalJs(`document.querySelector('#floor-panel')?.innerText ?? ''`)).includes('for the second room only'), 'and none of it is in the first room\'s transcript');
w2 = work().length;
await say(A.m, 'for the first room only');
await until(() => workSince(w2).filter((x) => x.kind === 'chat').length >= 2);
ok(JSON.stringify(workSince(w2).filter((x) => x.kind === 'chat').map((x) => x.agent).sort()) === JSON.stringify(['dev', 'qa']), 'a message from the first room is typed to the agent\'s first session', JSON.stringify(workSince(w2).map((x) => [x.kind, x.agent])));
c = await openCard(floor, 'lab', 'qa-2');
ok(c.name === 'Qa · 2' && c.buttons.every((b) => b.disabled), 'the second session\'s card names it by number, and is dimmed like any desk in a meeting room', JSON.stringify(c));
await closeCard(floor);

console.log('\nBring back takes the agent out of every room');
await floor.click('svg.room[data-channel="lab"] .desk[data-agent="qa"] .deskHit');
await floor.waitFor(`document.querySelector('#floor-panel')?.dataset.agent === 'qa' && !!document.querySelector('#floor-panel [data-act="bring-back"]')`);
const back = await floor.evalJs(`document.querySelector('#floor-panel [data-act="bring-back"]').textContent`);
ok(back === 'Bring back from all 2 meeting rooms', 'the desk\'s panel says how many rooms the agent is in', back);
age('qa-2');
ok(true, 'the fixture: the second session is aged past the 30 s it is left alone for after it is made');
const w3 = work().length;
await floor.click('#floor-panel [data-act="bring-back"]');
await waited(A.m, `JSON.stringify([...document.querySelectorAll('.m-part')].map((n) => n.dataset.forAgent)) === '["dev"]'`, 'the first room is left with its other desk');
await waited(B.m, `JSON.stringify([...document.querySelectorAll('.m-part')].map((n) => n.dataset.forAgent)) === '["ops"]'`, 'and so is the second: the second session was brought back with the first');
ok((await openWindows()).length === 2, 'both rooms carry on in their windows', JSON.stringify(await openWindows()));
const closedBy = await until(() => workSince(w3).find((x) => x.kind === 'unbind') ?? null, 12000);
ok(closedBy?.agent === 'qa-2' && closedBy?.channel === 'lab', 'the second session, in no room now, is closed: its host is handed the unbind', JSON.stringify(workSince(w3).map((x) => [x.kind, x.agent])));
await waited(floor, `!document.querySelector('svg.room[data-channel="lab"] .desk[data-agent="qa-2"]')`, 'and its desk leaves the floor', { timeout: 12000 });
r = await read(floor);
lab = roomOf(r);
ok(!inside(deskOf(lab, 'qa')?.hit, boxOf(lab, A.id)?.frame) && lab.desks.filter((x) => x.agent.startsWith('qa')).length === 1, 'the agent is back to one desk, outside every box', JSON.stringify(lab.desks.map((x) => x.agent)));
ok(!!(await deskNow('lab', 'qa'))?.hosted?.live && workSince(w3).every((x) => !(x.kind === 'unbind' && x.agent === 'qa')), 'which is its own, untouched');
ok(await floor.evalJs(`document.querySelector('#floor-panel')?.dataset.agent === 'qa' && !!document.querySelector('#floor-panel #p-text')`), 'with its chat back in the floor\'s panel');
c = await openCard(floor, 'lab', 'qa');
ok(c.buttons.every((b) => !b.disabled) && c.why.length === 0, 'and its card\'s controls back', JSON.stringify(c.buttons.map((b) => [b.text, b.disabled])));
await closeCard(floor);
await floor.evalJs(`document.querySelector('#floor-panel [data-act="close-panel"]')?.click(); 1`);

console.log('\na room of second sessions, ended and resumed');
// dev is still in the first room and ops in the second; qa is on the floor.
const one = await meet(floor, ['dev'], []);
ok(one.chip.off === 'true' && /Meeting room · 1/.test(one.chip.text), 'one desk that is already in a room is still not a meeting on its own', JSON.stringify(one.chip.text));
await floor.click('svg.room[data-channel="lab"] [data-act="select-room"]');
await floor.waitFor(`!document.querySelector('svg.room.selecting')`);
const w4 = work().length;
const C = await meet(floor, ['dev', 'ops'], ['dev-2', 'ops-2']);
ok(!!C.m && JSON.stringify((await parts(C.m)).sort()) === JSON.stringify(['dev-2', 'ops-2']), 'a room of nothing but desks that are in other rooms is a room of their second sessions', JSON.stringify(C.m ? await parts(C.m) : C.chip));
ok(JSON.stringify(workSince(w4).filter((x) => x.kind === 'seat').map((x) => [x.agent, x.payload.beside.agent]).sort()) === JSON.stringify([['dev-2', 'dev'], ['ops-2', 'ops']]), 'each asked of its agent\'s host, beside its agent\'s desk', JSON.stringify(workSince(w4).map((x) => [x.kind, x.agent])));
await until(async () => (await deskNow('lab', 'dev-2'))?.hosted?.live && (await deskNow('lab', 'ops-2'))?.hosted?.live, 12000);
const sidTwin = (await deskNow('lab', 'dev-2'))?.hosted?.session_id;
await say(C.m, 'said before the room ended');
await C.m.waitFor(`[...document.querySelectorAll('.t-assistant')].some((n) => /dev-2 heard: said before the room ended/.test(n.textContent))`, { timeout: 10000 });
await floor.waitFor(`!!document.querySelector('svg.room[data-channel="lab"] .meetBox[data-meeting="${C.id}"] .meetEnd[aria-disabled="false"]')`, { timeout: 8000 });
age('dev-2'); age('ops-2');
ok(true, 'the fixture: both are aged past the 30 s a second session is left alone for after it is made');
const w5 = work().length;
await floor.press(`svg.room .meetBox[data-meeting="${C.id}"] .meetEnd`);
const ended = await until(async () => !(await openWindows()).includes(C.url), 8000);
ok(!!ended, 'End meeting on the floor ends the room');
const closed = await until(() => { const u = workSince(w5).filter((x) => x.kind === 'unbind').map((x) => x.agent).sort(); return u.length >= 2 ? u : null; }, 12000);
ok(JSON.stringify(closed) === JSON.stringify(['dev-2', 'ops-2']), 'and both second sessions are closed with it', JSON.stringify(workSince(w5).map((x) => [x.kind, x.agent])));
await waited(floor, `!document.querySelector('svg.room[data-channel="lab"] .desk[data-agent="dev-2"]') && !document.querySelector('svg.room[data-channel="lab"] .desk[data-agent="ops-2"]')`, 'their desks leave the floor', { timeout: 12000 });
ok(JSON.stringify((await parts(A.m)).concat(await parts(B.m)).sort()) === JSON.stringify(['dev', 'ops']), 'the rooms their first sessions are in carry on', JSON.stringify([await parts(A.m), await parts(B.m)]));
const rec = (await meetings()).find((x) => x.id === C.id);
ok(!!rec?.ended_at && JSON.stringify(rec.participants.map((p) => [p.agent, p.base ?? null]).sort()) === JSON.stringify([['dev-2', 'dev'], ['ops-2', 'ops']]) && rec.participants.find((p) => p.agent === 'dev-2')?.session_id === sidTwin,
  'the board keeps the room with whose second session each was and the conversation it was on', JSON.stringify(rec?.participants));
ok(JSON.stringify(rec?.participants.map((p) => p.persona).sort()) === JSON.stringify(['Dev', 'Ops']), 'named as its agent in the Recent list, though its desk is gone', JSON.stringify(rec?.participants.map((p) => p.persona)));
await floor.click('[data-act="meetings"]');
await floor.waitFor(`!!document.querySelector('.meet-row [data-do="meeting-resume"][data-id="${C.id}"]')`, { timeout: 5000 });
const w6 = work().length;
await floor.press(`.meet-row [data-do="meeting-resume"][data-id="${C.id}"]`);
const R1 = await attach((u) => isMeeting(u) && u.includes(`meeting=${C.id}`));
await floor.evalJs(`document.getElementById('dlg')?.close(); true`);
await waited(R1, `JSON.stringify([...document.querySelectorAll('.m-part')].map((n) => n.dataset.forAgent).sort()) === '["dev-2","ops-2"]'`, 'Resume brings both second sessions back into the room, under the names they had', { timeout: 25000 });
const again = workSince(w6).filter((x) => x.kind === 'seat');
ok(again.length === 2 && again.find((x) => x.agent === 'dev-2')?.payload.session_id === sidTwin && JSON.stringify(again.find((x) => x.agent === 'dev-2')?.payload.beside) === JSON.stringify({ channel: 'lab', agent: 'dev' }),
  'each made again beside its agent\'s desk, on the conversation it was on', JSON.stringify(again.map((x) => [x.agent, x.payload.session_id, x.payload.beside])));
await until(async () => (await deskNow('lab', 'dev-2'))?.hosted?.session_id === sidTwin, 12000);
ok((await deskNow('lab', 'dev-2'))?.hosted?.session_id === sidTwin, 'and the desk is on it');
await waited(R1, `[...document.querySelectorAll('.t-assistant')].some((n) => /dev-2 heard: said before the room ended/.test(n.textContent))`, 'with what it said before the room ended in the transcript', { timeout: 12000 });
ok((await notes(R1)).some((n) => /is back, as dev-2, on its conversation\./.test(n)), 'and the room saying it is back', JSON.stringify(await notes(R1)));
await waited(floor, `!!document.querySelector('svg.room[data-channel="lab"] .desk[data-agent="dev-2"]') && !!document.querySelector('svg.room[data-channel="lab"] .meetBox[data-meeting="${C.id}"]')`, 'on the floor its desk is back, in the room\'s box');

console.log('\na second session its host refuses');
// qa is on the floor; dev and ops are each in two rooms. First qa goes into
// a room (with a third session of dev), then a second room asks for a
// second session of qa, which the fixture's host refuses, and a third of ops.
const D = await meet(floor, ['qa', 'dev'], ['qa', 'dev-3']);
ok(!!D.m && JSON.stringify((await parts(D.m)).sort()) === JSON.stringify(['dev-3', 'qa']), 'the fixture: the agent is in a room again, with a third session of another', JSON.stringify(D.m ? await parts(D.m) : D.chip));
await floor.waitFor(`!document.querySelector('svg.room.selecting')`, { timeout: 8000 });
writeFileSync(CTL, JSON.stringify({ seatFail: ['qa-2'] }));
const E = await meet(floor, ['qa', 'ops'], ['x']).catch((e) => ({ err: e.message }));
ok(!!E.m, 'a room asked for with two desks that are both in rooms already', JSON.stringify(E.err ?? E.chip));
await waited(E.m, `[...document.querySelectorAll('.m-note')].some((n) => /second session did not start: no new desk on lab: refused: the fixture said to refuse qa-2/.test(n.textContent))`, 'a second session the host refuses is said in the room, in the host\'s words', { timeout: 20000 });
await until(async () => JSON.stringify(await parts(E.m)) === JSON.stringify(['ops-3']), 10000);
ok(JSON.stringify(await parts(E.m)) === JSON.stringify(['ops-3']), 'and is not in it: the room carries on with the one that did arrive', JSON.stringify(await parts(E.m)));
ok(!(await floor.evalJs(`!!document.querySelector('svg.room[data-channel="lab"] .desk[data-agent="qa-2"]')`)), 'nor is there a desk for it on the floor');
ok(JSON.stringify((await parts(D.m)).sort()) === JSON.stringify(['dev-3', 'qa']), 'and the room the agent is in is as it was', JSON.stringify(await parts(D.m)));
writeFileSync(CTL, '{}');

// Every room ended, so the floor is as it was: three desks, no box.
for (const m of [E.m, D.m, R1, B.m, A.m].filter(Boolean)) {
  for (const t of ['dev-2', 'dev-3', 'ops-2', 'ops-3', 'qa-2']) age(t);
  await m.click('[data-act="m-end"]').catch(() => {});
  await sleep(500);
}
await until(async () => (await openWindows()).length === 0, 10000);
await waited(floor, `document.querySelectorAll('svg.room[data-channel="lab"] .desk').length === 3 && !document.querySelector('svg.room[data-channel="lab"] .meetBox')`, 'the fixture: every room ended, every second session closed, three desks and no box', { timeout: 25000 });

console.log('\nTake a desk: New desk here');
const lab2 = await open({ base, view: 'floor', floor: 'lab2' });
await lab2.resize(1280, 1100);
await lab2.waitFor(`document.querySelectorAll('svg.room[data-channel="lab2"] .desk').length === 1`);
await lab2.click('#take-desk');
await lab2.waitFor(`!!document.querySelector('dialog[open] #desk-channel')`, { timeout: 10000 });
await lab2.waitFor(`document.querySelectorAll('#dlg .dir-row').length > 0`, { timeout: 10000 });
await lab2.evalJs(`browseTo('/repo/qa'), 1`);
await lab2.waitFor(`document.querySelector('#desk-agent')?.value === 'qa' && /is qa on lab/.test(document.querySelector('#dlg')?.innerText ?? '')`, { timeout: 10000 });
const form = () => lab2.evalJs(`JSON.stringify({
  floor: document.querySelector('#desk-channel')?.value ?? null,
  buttons: [...document.querySelectorAll('#dlg .dlg-foot button')].map((b) => ({ text: b.textContent, act: b.dataset.do, disabled: b.disabled })),
  note: document.querySelector('#dlg .dlg-note')?.textContent ?? '',
})`).then(JSON.parse);
let f = await form();
ok(JSON.stringify(f.buttons.map((b) => b.text)) === JSON.stringify(['Cancel', 'New desk here', 'Move to lab2']), 'a folder that is a desk on another floor offers New desk here, between Cancel and Move', JSON.stringify(f.buttons));
ok(f.buttons.every((b) => !b.disabled), 'all three can be pressed');
ok(/New desk here starts a new session of qa on lab2, in the same folder\. The session it has on lab is left running, and so is every other one\./.test(f.note), 'and the note says what it does to the session the agent has: nothing', f.note);
await lab2.shot(`${shots}/take-new-desk.png`, '#dlg', { scale: 1 });
// A host that refuses: said in the dialog, in the host's words, and the page stays.
writeFileSync(CTL, JSON.stringify({ seatFail: ['qa'] }));
const w7a = work().length;
await lab2.press('#dlg [data-do="desk-seat"]');
await waited(lab2, `/no new desk on lab2: refused: the fixture said to refuse qa/.test(document.querySelector('dialog[open]')?.innerText ?? '')`, 'a new desk its host refuses is said in the dialog, in the host\'s words', { timeout: 15000 });
ok(workSince(w7a).filter((x) => x.kind === 'seat').length === 1 && !(await deskNow('lab2', 'qa'))?.hosted && !!(await lab2.evalJs(`!!document.querySelector('dialog[open] #desk-channel')`)),
  'and the dialog stays, on a floor the agent did not reach', JSON.stringify(workSince(w7a).map((x) => x.kind)));
// A host that takes its time: the dialog waits for the desk, and says so.
writeFileSync(CTL, JSON.stringify({ seatSlow: 3000 }));
await lab2.waitFor(`(() => { const b = document.querySelector('#dlg [data-do="desk-seat"]'); return !!b && !b.disabled; })()`, { timeout: 8000 });
const w7 = work().length;
await lab2.press('#dlg [data-do="desk-seat"]');
const sat = await until(() => workSince(w7).find((x) => x.kind === 'seat') ?? null, 8000);
await sleep(700);
const waiting = await lab2.evalJs(`JSON.stringify({ open: !!document.querySelector('dialog[open] #desk-channel'), note: document.querySelector('#dlg .dlg-note')?.textContent ?? '' })`).then(JSON.parse);
ok(waiting.open && /^Asked testbox for a new desk for qa on lab2 — waiting for it to sit down/.test(waiting.note) && !(await deskNow('lab2', 'qa'))?.hosted,
  'the board taking it is not the desk being there: the dialog stays open and says it is waiting for the host', JSON.stringify(waiting));
writeFileSync(CTL, '{}');
ok(sat?.channel === 'lab2' && sat?.agent === 'qa' && sat.payload.path === '/repo/qa' && JSON.stringify(sat.payload.beside) === JSON.stringify({ channel: 'lab', agent: 'qa' }),
  'pressed, the host is asked for a desk on this floor in that folder, under the agent\'s own name', JSON.stringify(sat));
ok(workSince(w7).every((x) => x.kind !== 'bind'), 'and is not asked to move anything', JSON.stringify(workSince(w7).map((x) => x.kind)));
await waited(lab2, `!document.querySelector('dialog[open]') && !!document.querySelector('svg.room[data-channel="lab2"] .desk[data-agent="qa"]')`, 'the dialog closes when the desk is there, and the agent has a desk on this floor', { timeout: 15000 });
ok(await lab2.evalJs(`document.querySelector('#floor-panel')?.dataset.agent === 'qa'`), 'with its panel open, on the floor it was taken to');
const here = await deskNow('lab2', 'qa');
const there = await deskNow('lab', 'qa');
ok(!!here?.hosted?.live && here.hosted.seat === true && here.twin === null && !!there?.hosted?.live && there.hosted.seat === false && here.hosted.session_id !== there.hosted.session_id,
  'the board has the agent on both floors, each on a conversation of its own, and its first desk is where it was', JSON.stringify([here?.hosted, there?.hosted]));
ok(await lab2.evalJs(`(() => { const b = document.querySelector('#floor-panel [data-act="handback"]'); return !!b && b.classList.contains('hidden'); })()`), 'a desk that shares its folder is not offered Open in VS Code: an editor there is the folder\'s own desk');
c = await openCard(lab2, 'lab2', 'qa');
const mv = c.buttons.find((b) => b.act === 'move-desk');
ok(mv?.disabled === true && c.why.some((w) => /^This is one of several desks of this agent in one folder/.test(w)), 'its card\'s Move is dimmed, and says why and what to use instead', JSON.stringify(c));
ok(c.buttons.find((b) => b.act === 'leave-room')?.disabled === false, 'Leave room is not');
const w8 = work().length;
await lab2.press('#desk-pop [data-act="leave-room"]');
await lab2.waitFor(`!!document.querySelector('dialog[open] [data-do="desk-leave"]')`);
d = (await dialogText(lab2)).replace(/\s+/g, ' ');
ok(/It is one of several desks this agent has in one folder: the others keep running/.test(d), 'the Leave desk dialog says what leaving this one does, and does not, to the others', d.slice(0, 300));
await lab2.press('dialog[open] [data-do="desk-leave"]');
const leftBy = await until(() => workSince(w8).find((x) => x.kind === 'unbind') ?? null, 8000);
ok(leftBy?.channel === 'lab2' && leftBy?.agent === 'qa', 'pressed, the host is asked to close that desk', JSON.stringify(workSince(w8).map((x) => [x.kind, x.channel, x.agent])));
await waited(lab2, `!document.querySelector('svg.room[data-channel="lab2"] .desk[data-agent="qa"]')`, 'and the desk and its agent are gone from this floor', { timeout: 12000 });
ok(!!(await deskNow('lab', 'qa'))?.hosted?.live && (await deskNow('lab2', 'qa')) === null, 'the agent\'s desk on its own floor is untouched, and the board has no row left for the one that was left');

console.log('\nNew desk here, on the floor the agent is already on');
await lab2.click('#take-desk');
await lab2.waitFor(`!!document.querySelector('dialog[open] #desk-channel')`, { timeout: 10000 });
await lab2.waitFor(`document.querySelectorAll('#dlg .dir-row').length > 0`, { timeout: 10000 });
await lab2.evalJs(`browseTo('/repo/zed'), 1`);
await lab2.waitFor(`document.querySelector('#desk-agent')?.value === 'zed'`, { timeout: 10000 });
f = await form();
ok(JSON.stringify(f.buttons.map((b) => b.text)) === JSON.stringify(['Cancel', 'New desk here', 'Bring onto the floor']) && /under its name with a number \(zed-2\)/.test(f.note), 'the dialog offers it there too, and says the name the new desk will take', JSON.stringify([f.buttons.map((b) => b.text), f.note]));
await lab2.evalJs(`browseTo('/repo/empty'), 1`);
await lab2.waitFor(`/empty/.test(document.querySelector('#dlg .dlg-self')?.textContent ?? '') && document.querySelector('#desk-agent')?.value === ''`, { timeout: 10000 });
f = await form();
ok(JSON.stringify(f.buttons.map((b) => b.text)) === JSON.stringify(['Cancel', 'Take desk']), 'a folder that is not a desk yet is not offered a second one', JSON.stringify(f.buttons.map((b) => b.text)));
await lab2.click('#dlg [data-do="cancel"]');

console.log(fails ? `\nFAIL · ${fails} of ${total} red` : `\nPASS · ${total} of ${total}`);
process.exit(fails ? 1 : 0);

#!/usr/bin/env node
/**
 * A meeting room (issue #44), driven end to end on a throwaway server with
 * seed-meeting.mjs's floor and host: create from the selection toolbar, one
 * transcript labelled by desk, who hears a message, a refusal said per desk,
 * a participant's prompt answered in the room, Add and Remove, "Bring back"
 * from the floor, a reload, End, the Recent list, Resume with a reopen and a
 * skip, and closing the window.
 *
 *   run-check-meeting.sh <dir>       # the whole fixture; see there
 *
 * Every assertion reads the page or what the host was handed (work.jsonl,
 * one JSON line per item), never the room's own idea of what it sent.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { open, attach, targets } from './drive.mjs';

const base = process.argv[2] ?? 'http://localhost:8941';
const shots = process.argv[3] ?? '/tmp';
const WORK = process.argv[4];
const CTL = process.argv[5];
const KEY = 'k';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
let total = 0;
const ok = (cond, msg, extra = '') => {
  total++;
  console.log(`  ${cond ? '✓' : '✗'} ${msg}${cond || !extra ? '' : `  (${extra})`}`);
  if (!cond) fails++;
};
const work = () => readFileSync(WORK, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const workSince = (n) => work().slice(n);
const isMeeting = (u) => u.includes('meeting=');
const text = (page, sel) => page.evalJs(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? null`);
const parts = (page) => page.evalJs(`JSON.stringify([...document.querySelectorAll('.m-part')].map((n) => n.dataset.forAgent))`).then(JSON.parse);
const say = async (page, words) => {
  await page.evalJs(`(() => { const t = document.querySelector('#p-text'); t.value = ${JSON.stringify(words)}; t.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await page.click('#floor-panel [data-act="send"]');
};
const msgNode = (page, words) => page.evalJs(`(() => {
  const n = [...document.querySelectorAll('#p-turns .m-msg')].find((x) => x.querySelector('.t-body')?.textContent === ${JSON.stringify(words)});
  return n ? JSON.stringify({ who: n.querySelector('.t-who').textContent, delivs: [...n.querySelectorAll('.m-deliv')].map((d) => d.textContent), pending: n.classList.contains('t-pending') }) : 'null';
})()`).then(JSON.parse);
const floorPanel = (page) => page.evalJs(`JSON.stringify({
  agent: document.querySelector('#floor-panel')?.dataset.agent ?? null,
  composer: !!document.querySelector('#floor-panel #p-text'),
  back: document.querySelector('#floor-panel [data-act="bring-back"]')?.textContent ?? null,
  why: document.querySelector('#floor-panel .p-out-why')?.textContent ?? null,
})`).then(JSON.parse);
const openOnFloor = async (page, agent) => {
  await page.click(`#floor-rooms .desk[data-agent="${agent}"] .deskHit`);
  await page.waitFor(`document.querySelector('#floor-panel')?.dataset.agent === ${JSON.stringify(agent)}`);
};

const floor = await open({ base, view: 'floor', floor: 'lab' });
await floor.resize(1500, 1000);
const totalsBefore = await text(floor, '#floor-totals');

console.log('\ncreate, from the selection toolbar');
await floor.click('svg.room[data-channel="lab"] [data-act="select-room"]');
await floor.waitFor(`!!document.querySelector('svg.room.selecting')`);
const chip = () => floor.evalJs(`JSON.stringify((() => { const g = document.querySelector('svg.room.selecting [data-act="sel-meeting"]'); return g && { text: g.querySelector('text').textContent, disabled: g.getAttribute('aria-disabled') }; })())`).then(JSON.parse);
let c = await chip();
ok(c && c.disabled === 'true' && c.text === 'Meeting room', 'beside Nudge / Mark read / Hide: Meeting room, off with nothing checked', JSON.stringify(c));
await floor.click('svg.room.selecting .desk[data-agent="bo"] .deskHit');
await sleep(200);
ok((await chip()).disabled === 'true', 'and off with one desk checked: a meeting of one is a popout');
for (const a of ['cy', 'dee']) { await floor.click(`svg.room.selecting .desk[data-agent="${a}"] .deskHit`); await sleep(200); }
c = await chip();
ok(c.disabled === 'false' && c.text === 'Meeting room · 3', 'three checked: "Meeting room · 3"', JSON.stringify(c));
let w0 = work().length;
await floor.press('svg.room.selecting [data-act="sel-meeting"]');
let m = await attach(isMeeting);
await m.resize(760, 980);
await m.waitFor(`document.querySelectorAll('.m-part').length === 3`, { timeout: 12000 });
ok(JSON.stringify(await parts(m)) === '["bo","cy","dee"]', 'one window, with the three checked desks in it');
ok(/[?&]meeting=\d+$/.test(await m.evalJs('location.search')), 'and an address naming the room the board recorded', await m.evalJs('location.search'));
const roomId = Number(new URLSearchParams(await m.evalJs('location.search')).get('meeting'));
ok(await m.evalJs(`getComputedStyle(document.querySelector('.topbar')).display === 'none' && getComputedStyle(document.querySelector('#floor-rooms')).display === 'none'`),
  'no top bar and no rooms in it');
ok(!/old answer|old question/.test(await text(m, '#p-turns')), 'the transcript starts now: nothing a desk said before it joined');
ok(workSince(w0).length === 0, 'opening the room typed into nobody');

// Opening the room is an action sent, so the selection closes itself
// (costmo, 2026-11-14) and nothing is left on the room: every desk was reached.
await floor.waitFor(`!document.querySelector('svg.room.selecting')`, { timeout: 3000 })
  .then(() => ok(true, 'the floor\'s room stopped selecting by itself when the window opened'), (e) => ok(false, 'the floor\'s room stopped selecting by itself when the window opened', e.message));
ok(await floor.evalJs(`!document.querySelector('svg.room .missBar') && document.querySelector('svg.room[data-channel="lab"] [data-act="select-room"]')?.textContent.startsWith('select desks')`),
  'with select desks back on its header and no line left on it');

console.log('\nthe floor while the desks are in it');
await openOnFloor(floor, 'bo');
let fp = await floorPanel(floor);
ok(!fp.composer && fp.back === 'Bring back from the meeting room' && /meeting room/.test(fp.why ?? ''), 'the floor panel for a participant: no composer, and the way back', JSON.stringify(fp));
ok(await floor.evalJs(`!!document.querySelector('#floor-rooms .desk[data-agent="bo"]')`), 'the desk stays drawn on the floor');
ok((await text(floor, '#floor-totals')) === totalsBefore, 'and the floor\'s counts are as they were', `${totalsBefore} → ${await text(floor, '#floor-totals')}`);

console.log('\none message, everyone, delivered desk by desk');
w0 = work().length;
await say(m, 'hello room');
const delivText = `[...document.querySelectorAll('#p-turns .m-msg .m-deliv')].map((n) => n.textContent).join('|')`;
ok(await m.waitFor(`/Cy queued — the desk is working/.test(${delivText})`, { timeout: 3000, every: 50 }).then(() => true, () => false),
  "while Cy's window holds it, Cy's line says so: queued — the desk is working");
await m.waitFor(`[...document.querySelectorAll('#p-turns .t-assistant')].length >= 3`, { timeout: 10000 }).catch(() => {});
let msg = await msgNode(m, 'hello room');
ok(msg && /you → everyone \(Bo, Cy, Dee\)/i.test(msg.who), 'the message says who it went to', JSON.stringify(msg));
ok(msg && msg.delivs.join('|') === 'Bo delivered|Cy delivered|Dee delivered' && !msg.pending, 'each desk delivered, on its own line', JSON.stringify(msg?.delivs));
ok(await m.evalJs(`[...document.querySelectorAll('#p-turns .m-msg')].length === 1`), 'drawn once, though three desks recorded it');
const heard = await m.evalJs(`JSON.stringify([...document.querySelectorAll('#p-turns .t-assistant')].map((n) => [n.querySelector('.t-who').childNodes[0].textContent, n.querySelector('.t-body').textContent]))`).then(JSON.parse);
ok(['Bo', 'Cy', 'Dee'].every((p) => heard.some(([who, body]) => who === p && body === `${p.toLowerCase()} heard: hello room`)), 'every reply comes back, labelled with its desk', JSON.stringify(heard));
// A participant's box, clicked outside its buttons, hides or shows that
// desk's part of the transcript (costmo, 2026-11-14).
const rows = () => m.evalJs(`JSON.stringify([...document.querySelectorAll('#p-turns > [data-key]')].map((n) => ({ key: n.dataset.key, by: n.dataset.saidBy ?? null, to: [...n.querySelectorAll('.m-deliv b')].map((b) => b.textContent), body: n.querySelector('.t-body')?.textContent ?? n.textContent })))`).then(JSON.parse);
const keys = (list) => JSON.stringify(list.map((r) => r.key));
const boxOf = (a) => m.evalJs(`(() => { const n = document.querySelector('.m-part[data-for-agent="${a}"]'); return JSON.stringify({ off: n.classList.contains('m-off'), shown: n.dataset.shown, word: n.querySelector('.m-off-word')?.textContent ?? null, title: n.title, focused: document.activeElement === n }); })()`).then(JSON.parse);
const boxClick = (a) => m.click(`.m-part[data-for-agent="${a}"] .m-row-name b`);
console.log('\nevery conversation hidden, and shown again');
const first = await rows();
for (const a of ['bo', 'cy', 'dee']) await boxClick(a);
ok((await rows()).length === 0 && /Every conversation here is hidden\. Click a name above/.test(await text(m, '#p-turns')), 'with every box clicked off the transcript says so, and how to get it back', await text(m, '#p-turns'));
for (const a of ['bo', 'cy', 'dee']) await boxClick(a);
ok(keys(await rows()) === keys(first) && first.length >= 4, 'and with each clicked on again it is the transcript it was, row for row', `${keys(first)} → ${keys(await rows())}`);
const sent = workSince(w0).filter((x) => x.kind === 'chat');
ok(sent.length === 3 && new Set(sent.map((x) => x.agent)).size === 3 && sent.every((x) => x.payload.text === 'hello room'), 'one chat per desk reached the host, the words as typed', JSON.stringify(sent.map((x) => x.agent)));
ok(await m.evalJs(`document.querySelector('#p-text').value === ''`), 'the box is empty after the send');
await m.shot(`${shots}/meeting-sent.png`, null, { scale: 1 });

console.log('\na nudge needed, and given');
const pills = (agent) => m.evalJs(`JSON.stringify([...document.querySelectorAll('.m-part[data-for-agent="${agent}"] .m-pill')].map((n) => n.textContent.trim()))`).then(JSON.parse);
ok(JSON.stringify(await pills('bo')) === '["✉ 2"]' && JSON.stringify(await pills('cy')) === '["✉ 1"]' && JSON.stringify(await pills('dee')) === '[]',
  'each participant carries its unread count, as its desk does', JSON.stringify([await pills('bo'), await pills('cy'), await pills('dee')]));
const tops = await m.evalJs(`JSON.stringify(['bo', 'cy', 'dee'].map((a) => [
  getComputedStyle(document.querySelector('.m-part[data-for-agent="' + a + '"]')).borderTopColor,
  getComputedStyle(document.querySelector('.m-to [data-agent="' + a + '"]')).borderTopColor]))`).then(JSON.parse);
ok(JSON.stringify(tops) === JSON.stringify([['rgb(217, 164, 65)', 'rgb(217, 164, 65)'], ['rgb(177, 88, 58)', 'rgb(177, 88, 58)'], ['rgb(90, 65, 48)', 'rgb(90, 65, 48)']]),
  "each participant's box and To chip carry its hair across the top; one with none set carries the default", JSON.stringify(tops));
const nudgeLabel = () => m.evalJs(`document.querySelector('[data-act="m-nudge-all"]').textContent`);
ok(await nudgeLabel() === 'Nudge everyone · 3 unread', 'the Nudge button says a nudge is needed', await nudgeLabel());
w0 = work().length;
await m.click('.m-part[data-for-agent="cy"] [data-act="m-nudge"]');
await sleep(1500);
ok(JSON.stringify(workSince(w0).filter((x) => x.kind === 'chat').map((x) => [x.agent, x.payload.text])) === '[["cy","nudge"]]', "Cy's bell nudges Cy alone");
await m.waitFor(`(() => { const n = [...document.querySelectorAll('#p-turns .m-msg')].find((x) => x.querySelector('.t-body')?.textContent === 'nudge'); return n && /delivered/.test(n.textContent); })()`, { timeout: 8000 }).catch(() => {});
msg = await msgNode(m, 'nudge');
ok(msg && /you → Cy$/.test(msg.who.trim()) && msg.delivs.join('|') === 'Cy delivered', 'and the room shows it, delivered', JSON.stringify(msg));
await m.click('.m-part[data-for-agent="bo"] [data-act="m-pill"]');
await m.waitFor(`document.querySelector('#dlg')?.open && !!document.querySelector('#dlg [data-do="advance"]')`, { timeout: 6000 }).catch(() => {});
ok(await m.evalJs(`!!document.querySelector('#dlg [data-do="nudge"]') && !!document.querySelector('#dlg [data-do="advance"]')`),
  "Bo's ✉ opens the floor's own backlog dialog, here: Nudge agent, Mark all read");
await m.click('#dlg [data-do="advance"]');
await m.waitFor(`!document.querySelector('.m-part[data-for-agent="bo"] .m-pill')`, { timeout: 8000 }).catch(() => {});
ok(JSON.stringify(await pills('bo')) === '[]', "Mark all read clears Bo's count in the room");
ok(await nudgeLabel() === 'Nudge everyone · 1 unread', 'and the Nudge button follows', await nudgeLabel());
w0 = work().length;
await m.click('[data-act="m-nudge-all"]');
await sleep(2000);
ok(JSON.stringify(workSince(w0).filter((x) => x.kind === 'chat').map((x) => x.agent).sort()) === '["bo","cy","dee"]', 'Nudge everyone types the word into every desk in the room');
const nudges = await m.evalJs(`[...document.querySelectorAll('#p-turns .m-msg')].filter((x) => x.querySelector('.t-body')?.textContent === 'nudge').length`);
ok(nudges === 2, 'as one message in the transcript, not one per desk', String(nudges));

console.log('\na click on a name in the To row');
// costmo, 2026-11-14: with everyone lit a name is a solo; the only lit name
// gives everyone back; between the two a name is a toggle.
const lit = () => m.evalJs(`JSON.stringify([...document.querySelectorAll('.m-to .m-to-one.on')].map((b) => b.dataset.agent))`);
const allOn = () => m.evalJs(`document.querySelector('.m-to [data-act="m-to-all"]').classList.contains('on')`);
const tip = (a) => m.evalJs(`document.querySelector('.m-to .m-to-one[data-agent="${a}"]').title`);
const chipClick = (a) => m.click(`.m-to [data-act="m-to"][data-agent="${a}"]`);
ok(await lit() === '["bo","cy","dee"]' && await allOn(), 'the room starts with every name lit', await lit());
ok(await tip('cy') === 'Only Cy hears your messages', 'and a name says on hover that a click makes it the only one', await tip('cy'));
await chipClick('cy');
ok(await lit() === '["cy"]' && !(await allOn()), 'with everyone lit, a click on Cy leaves Cy alone lit — not everyone but Cy', await lit());
ok(/Only Cy hears what you send, until you choose again/.test(await text(m, '.p-hint')), 'and the hint under the box says so', await text(m, '.p-hint'));
ok(await tip('cy') === 'Everyone hears your messages' && await tip('dee') === 'Dee hears your messages too', 'the lit name now offers everyone, the others offer to join', `${await tip('cy')} | ${await tip('dee')}`);
await chipClick('cy');
ok(await lit() === '["bo","cy","dee"]' && await allOn(), 'a click on the only lit name gives everyone back', await lit());
await chipClick('cy');
await chipClick('dee');
ok(await lit() === '["cy","dee"]', 'with one lit, a click on another adds it', await lit());
ok(await tip('dee') === 'Leave Dee out of your messages', 'and with some lit a lit name offers to step out', await tip('dee'));
await chipClick('dee');
ok(await lit() === '["cy"]', 'with some lit and not all, a click on a lit name takes it out', await lit());
await chipClick('dee');
await chipClick('bo');
ok(await lit() === '["bo","cy","dee"]' && await allOn(), 'and adding the last one is everyone again', await lit());

console.log('\nnarrowed to one desk, and it stays narrowed after a send');
await chipClick('bo');
ok(await lit() === '["bo"]', 'one click on Bo, with everyone lit, narrows to Bo', await lit());
ok(/Only Bo hears what you send, until you choose again/.test(await text(m, '.p-hint')), 'the hint says who hears it, and that it stays', await text(m, '.p-hint'));
w0 = work().length;
await say(m, 'just for bo');
await m.waitFor(`[...document.querySelectorAll('#p-turns .t-body')].some((n) => n.textContent === 'bo heard: just for bo')`, { timeout: 8000 }).catch(() => {});
msg = await msgNode(m, 'just for bo');
ok(msg && /you → Bo$/i.test(msg.who.trim()) && msg.delivs.join('|') === 'Bo delivered', 'the transcript shows it went to Bo only', JSON.stringify(msg));
await sleep(1500);
ok(JSON.stringify(workSince(w0).filter((x) => x.kind === 'chat').map((x) => x.agent)) === '["bo"]', 'and only Bo\'s host was handed it');
// costmo, 2026-11-14: a send keeps the choice. It used to go back to everyone.
ok(await lit() === '["bo"]' && !(await allOn()), 'after the send, Bo is still the only name lit — the choice is not put back to everyone', await lit());
ok(/Only Bo hears what you send/.test(await text(m, '.p-hint')), 'and the hint still says so, with the box empty', await text(m, '.p-hint'));
w0 = work().length;
await say(m, 'bo again');
await m.waitFor(`[...document.querySelectorAll('#p-turns .t-body')].some((n) => n.textContent === 'bo heard: bo again')`, { timeout: 8000 }).catch(() => {});
msg = await msgNode(m, 'bo again');
ok(msg && /you → Bo$/i.test(msg.who.trim()) && msg.delivs.join('|') === 'Bo delivered', 'so the next message goes to Bo only, with nothing clicked', JSON.stringify(msg));
await sleep(1500);
ok(JSON.stringify(workSince(w0).filter((x) => x.kind === 'chat').map((x) => x.agent)) === '["bo"]', 'and only Bo\'s host was handed that one too');
w0 = work().length;
await say(m, '@cy only cy, by name');
await m.waitFor(`[...document.querySelectorAll('#p-turns .t-body')].some((n) => n.textContent === 'cy heard: only cy, by name')`, { timeout: 8000 }).catch(() => {});
await sleep(1500);
ok(JSON.stringify(workSince(w0).filter((x) => x.kind === 'chat').map((x) => x.agent)) === '["cy"]', 'a name at the start of the box still outranks the chips for its one message');
ok(await lit() === '["bo"]', 'and leaves the chips as they were: Bo', await lit());
await m.click('.m-to [data-act="m-to-all"]');
ok(await lit() === '["bo","cy","dee"]' && await allOn(), 'the everyone chip puts it back to everyone', await lit());

console.log('\nin line, and narrowed by name');
writeFileSync(CTL, JSON.stringify({ slow: { bo: 4000 } }));
await say(m, 'line up');
ok(await m.waitFor(`/Dee in line — \\d+ desks? ahead on testbox/.test(${delivText})`, { timeout: 3000, every: 50 }).then(() => true, () => false),
  'a desk behind another on its host says so: in line — N ahead, and no silence clock runs on it');
await m.waitFor(`(() => { const n = [...document.querySelectorAll('#p-turns .m-msg')].find((x) => x.querySelector('.t-body')?.textContent === 'line up'); return n && n.querySelectorAll('.m-deliv.ok').length === 3; })()`, { timeout: 12000 }).catch(() => {});
ok((await msgNode(m, 'line up'))?.delivs.every((d) => /delivered$/.test(d)), 'and each is delivered when its turn comes');
writeFileSync(CTL, '{}');
await m.evalJs(`(() => { const t = document.querySelector('#p-text'); t.value = '@bo hi'; t.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
ok(await text(m, '.p-hint') === 'Only Bo hears this one; the @names are not sent.', 'names at the start of the box narrow it, and the hint says so', await text(m, '.p-hint'));
w0 = work().length;
await say(m, '@cy, @Dee  just you two');
await m.waitFor(`(() => { const n = [...document.querySelectorAll('#p-turns .m-msg')].find((x) => x.querySelector('.t-body')?.textContent === 'just you two'); return n && n.querySelectorAll('.m-deliv.ok').length === 2; })()`, { timeout: 8000 }).catch(() => {});
msg = await msgNode(m, 'just you two');
ok(msg && /you → Cy, Dee$/.test(msg.who.trim()), '"@cy, @Dee …" goes to Cy and Dee (an id or a name, any case)', JSON.stringify(msg));
ok(JSON.stringify(workSince(w0).filter((x) => x.kind === 'chat').map((x) => [x.agent, x.payload.text]).sort()) === '[["cy","just you two"],["dee","just you two"]]',
  'and they receive the words without the names');
w0 = work().length;
await say(m, '@zed hello');
await sleep(800);
ok(await m.evalJs(`document.querySelector('#p-text').value`) === '@zed hello' && !workSince(w0).length, 'a name that is nobody in the room sends nothing, and the words stay in the box');
await m.evalJs(`(() => { const t = document.querySelector('#p-text'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);

console.log('\na desk that cannot take it is said, never skipped');
const addable = await m.evalJs(`JSON.stringify([...document.querySelectorAll('.m-add option')].map((o) => o.value).filter(Boolean))`).then(JSON.parse);
ok(JSON.stringify(addable) === '["ed"]', 'Add offers the free desks of this floor only (not zed, on lab2)', JSON.stringify(addable));
await m.evalJs(`(() => { const s = document.querySelector('.m-add'); s.value = 'ed'; s.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
await m.waitFor(`document.querySelectorAll('.m-part').length === 4`, { timeout: 5000 }).catch(() => {});
ok(JSON.stringify(await parts(m)) === '["bo","cy","dee","ed"]', 'Ed added from the window');
w0 = work().length;
await say(m, 'everyone, ed included');
await sleep(3500);
msg = await msgNode(m, 'everyone, ed included');
const edLine = msg?.delivs.find((d) => d.startsWith('Ed')) ?? '';
ok(/^Ed not sent — This conversation is open in your editor/.test(edLine), 'Ed: not sent, in the board\'s own words', edLine);
ok(msg?.delivs.filter((d) => /delivered$/.test(d)).length === 3, 'and the other three were sent anyway', JSON.stringify(msg?.delivs));
ok(!workSince(w0).some((x) => x.agent === 'ed'), 'nothing was queued for Ed');

console.log('\na participant\'s own prompt, answered in the room');
await fetch(`${base}/api/ingest`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestratinator-key': KEY },
  body: JSON.stringify({ channel: 'lab', agent: 'cy', session_id: 'sess-cy', hook_event_name: 'PermissionRequest', cwd: '/repo/cy', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }),
});
await m.waitFor(`!!document.querySelector('.m-alert[data-for-agent="cy"] .p-alert')`, { timeout: 8000 }).catch(() => {});
const alertWho = await m.evalJs(`document.querySelector('.m-alert[data-for-agent="cy"] .m-alert-who')?.textContent ?? null`);
ok(alertWho === 'Cy', 'Cy\'s prompt stands against the box, labelled with its desk', alertWho);
ok(await m.evalJs(`document.querySelector('.m-part[data-for-agent="cy"]').classList.contains('s-needs-you')`), 'and Cy reads "needs you" in the row of participants');
await m.waitFor(`!!document.querySelector('.m-alert[data-for-agent="cy"] [data-act="decide"][data-choice="allow"]')`, { timeout: 14000 }).catch(() => {});
w0 = work().length;
await m.click('.m-alert[data-for-agent="cy"] [data-act="decide"][data-choice="allow"]');
await sleep(1500);
const perm = workSince(w0).find((x) => x.kind === 'permission');
ok(perm?.agent === 'cy' && perm?.payload?.decision === 'allow', 'Approve answers Cy\'s window, through the panel\'s own route', JSON.stringify(perm));
await m.shot(`${shots}/meeting-prompt.png`, null, { scale: 1 });

console.log('\nStop, on a participant that is working');
const hostEv = (events) => fetch(`${base}/api/host/events`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestratinator-key': KEY },
  body: JSON.stringify({ host_id: 'h1', events }),
}).then((r) => r.json());
await hostEv([{ type: 'turn', channel: 'lab', agent: 'bo', session_id: 'sess-bo', role: 'tool', tool_name: 'Bash', tool_input: { command: 'npm test' }, at: new Date().toISOString(), uuid: 'stop-1' }]);
await m.waitFor(`document.querySelector('.m-part[data-for-agent="bo"] [data-act="stop"]')?.disabled === false`, { timeout: 8000 }).catch(() => {});
ok(await m.evalJs(`document.querySelector('.m-part[data-for-agent="bo"]').classList.contains('s-working')`), 'Bo reads "working" in the row');
ok(await m.evalJs(`document.querySelector('.m-part[data-for-agent="cy"] [data-act="stop"]').disabled`), 'an idle desk\'s stop sign is dimmed, with the board\'s reason');
await m.click('.m-part[data-for-agent="bo"] [data-act="stop"]');
await m.waitFor(`document.querySelector('#dlg')?.open && !!document.querySelector('#dlg [data-do="stop-desk"]')`, { timeout: 4000 }).catch(() => {});
ok(await m.evalJs(`document.querySelector('#dlg [data-do="stop-desk"]')?.dataset.agent === 'bo'`), 'Bo\'s stop sign asks first, in the board\'s own dialog, in this window');
w0 = work().length;
await m.click('#dlg [data-do="stop-desk"]');
await sleep(1500);
ok(workSince(w0).some((x) => x.kind === 'interrupt' && x.agent === 'bo'), 'and stops Bo, nobody else');
await hostEv([{ type: 'turn', channel: 'lab', agent: 'bo', session_id: 'sess-bo', role: 'assistant', text: 'stopped.', at: new Date().toISOString(), uuid: 'stop-2' }]);

console.log('\na click on a participant\'s box hides its part of the transcript');
// The step before posted Bo's "stopped."; read the transcript only once it
// is drawn, or it turns up later as a row this step did not expect.
await m.waitFor(`[...document.querySelectorAll('#p-turns .t-body')].some((n) => n.textContent === 'stopped.')`, { timeout: 8000 }).catch(() => {});
const all0 = await rows();
// The button's box is a fixed height, so a label wrapped onto a second
// line shows only as its contents being taller than the box.
const nudgeH = () => m.evalJs(`document.querySelector('[data-act="m-nudge-all"]').scrollHeight`);
const nudgeH0 = await nudgeH();
const cyOnly = all0.find((r) => r.body === 'only cy, by name');
const both = all0.find((r) => r.body === 'just you two');
ok(!!cyOnly && !!both && all0.some((r) => r.by === 'cy') && all0.some((r) => r.by === 'dee') && all0.some((r) => r.by === 'bo'),
  'the fixture: Bo, Cy and Dee have each said something, and there is a message to Cy alone and one to Cy and Dee', keys(all0));
ok(/^Click to hide Cy’s part of the conversation below/.test((await boxOf('cy')).title), 'a box says on hover what a click on it does', (await boxOf('cy')).title);
await m.press('.m-part[data-for-agent="cy"] .m-row-name b');
let box = await boxOf('cy');
ok(box.off && box.shown === 'no' && box.word === 'hidden' && /is hidden\. Click to show it again/.test(box.title), 'a real click on Cy\'s name marks its box hidden, in a word and on hover', JSON.stringify(box));
await m.shot(`${shots}/meeting-hidden.png`, null, { scale: 1 });
let now = await rows();
ok(!now.some((r) => r.by === 'cy'), 'nothing Cy said is in the transcript', keys(now));
ok(!now.some((r) => r.key === cyOnly.key), 'nor is the message that went to Cy alone');
ok(now.some((r) => r.key === both.key) && (await msgNode(m, 'hello room'))?.delivs.join('|') === 'Bo delivered|Cy delivered|Dee delivered',
  'a message that also went to a desk still shown stays, drawn whole, with Cy\'s delivery line under it', JSON.stringify(await msgNode(m, 'hello room')));
// Every message to Cy alone goes with it: the one sent by name, and the
// nudge its bell rang earlier (the first cut of this step forgot the bell).
const cyAlone = (r) => r.to.length > 0 && r.to.every((who) => who === 'Cy');
ok(all0.filter(cyAlone).length >= 2 && all0.filter(cyAlone).some((r) => r.key === cyOnly.key), 'the fixture holds more than one message to Cy alone', JSON.stringify(all0.filter(cyAlone).map((r) => r.body)));
const want0 = all0.filter((r) => r.by !== 'cy' && !cyAlone(r));
ok(keys(now) === keys(want0), 'every message to Cy alone is gone, and everything else is where it was, in the same order',
  `missing ${JSON.stringify(want0.filter((r) => !now.some((x) => x.key === r.key)))} · extra ${JSON.stringify(now.filter((r) => !want0.some((x) => x.key === r.key)))} · ${keys(now)}`);
ok(/Replies from Cy are hidden above\.$/.test(await text(m, '.p-hint')), 'the hint under the box says Cy will hear the next message with its replies hidden', await text(m, '.p-hint'));
ok(await nudgeH() === nudgeH0, 'and the longer hint does not squeeze the Nudge button onto a second line', `${nudgeH0}px → ${await nudgeH()}px`);
await hostEv([{ type: 'turn', channel: 'lab', agent: 'cy', session_id: 'sess-cy', role: 'assistant', text: 'cy, said while hidden', at: new Date().toISOString(), uuid: 'hid-1' }]);
await hostEv([{ type: 'turn', channel: 'lab', agent: 'bo', session_id: 'sess-bo', role: 'assistant', text: 'bo, said meanwhile', at: new Date().toISOString(), uuid: 'hid-2' }]);
await m.waitFor(`[...document.querySelectorAll('#p-turns .t-body')].some((n) => n.textContent === 'bo, said meanwhile')`, { timeout: 8000 }).catch(() => {});
now = await rows();
ok(now.some((r) => r.body === 'bo, said meanwhile') && !now.some((r) => r.body === 'cy, said while hidden'), 'what Cy says while hidden does not appear; what Bo says does');
const stopOff = await m.evalJs(`document.querySelector('.m-part[data-for-agent="cy"] [data-act="stop"]').disabled`);
await m.press('.m-part[data-for-agent="cy"] [data-act="stop"]');
await m.click('.m-part[data-for-agent="cy"] [data-act="stop"]');
await sleep(300);
ok(stopOff && (await boxOf('cy')).off, 'a click on a button in the box, even a dimmed one, is not a click on the box: Cy stays hidden', JSON.stringify(await boxOf('cy')));
await m.press('.m-part[data-for-agent="dee"] .m-state');
now = await rows();
box = await boxOf('dee');
ok(box.off && box.focused && !now.some((r) => r.by === 'dee' || r.by === 'cy') && now.some((r) => r.by === 'bo'), 'a click on Dee\'s box hides Dee too, leaving Bo\'s', JSON.stringify(box));
ok(!now.some((r) => r.key === both.key) && now.some((r) => r.body === 'hello room'), 'the message to Cy and Dee goes once both are hidden; the one Bo also heard stays');
await m.key('Enter');
await sleep(200);
now = await rows();
box = await boxOf('dee');
ok(!box.off && box.shown === 'yes' && box.word === null && box.focused, 'Enter on the focused box shows Dee again, and the box keeps the focus', JSON.stringify(box));
ok(now.some((r) => r.by === 'dee') && now.some((r) => r.key === both.key) && !now.some((r) => r.by === 'cy'), 'Dee\'s part and the message to Cy and Dee are back; Cy is still hidden');
// A poll that changes a desk's state redraws the whole row of boxes. Focus
// must come through it, or Enter works once.
await fetch(`${base}/api/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestratinator-key': KEY },
  body: JSON.stringify({ channel: 'lab', agent: 'bo', session_id: 'sess-bo', hook_event_name: 'UserPromptSubmit', cwd: '/repo/bo', message: 'carry on' }) });
const redrawn = await m.waitFor(`document.querySelector('.m-part[data-for-agent="bo"]').classList.contains('s-working')`, { timeout: 8000 }).then(() => true, () => false);
ok(redrawn && (await boxOf('dee')).focused, 'the row of boxes redrawn under it (Bo starts working) leaves the focus on Dee\'s box', JSON.stringify({ redrawn, box: await boxOf('dee') }));
await fetch(`${base}/api/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestratinator-key': KEY },
  body: JSON.stringify({ channel: 'lab', agent: 'bo', session_id: 'sess-bo', hook_event_name: 'Stop', cwd: '/repo/bo' }) });
await m.waitFor(`!document.querySelector('.m-part[data-for-agent="bo"]').classList.contains('s-working')`, { timeout: 8000 }).catch(() => {});
await m.press('.m-part[data-for-agent="cy"] .m-row-name b');
now = await rows();
const was = all0.map((r) => r.key);
const back = now.map((r) => r.key).filter((k) => was.includes(k));
ok(!(await boxOf('cy')).off && JSON.stringify(back) === JSON.stringify(was), 'Cy clicked on again: every row that was there is back, in the order it was said', `${JSON.stringify(was)} → ${keys(now)}`);
const iBo = now.findIndex((r) => r.body === 'bo, said meanwhile');
const iCy = now.findIndex((r) => r.body === 'cy, said while hidden');
ok(iCy >= 0 && iBo === iCy + 1 && iCy >= all0.length, 'and what Cy said while hidden is there now, in line: after everything before it and ahead of what Bo said next', `cy ${iCy}, bo ${iBo} of ${now.length}`);
ok(!/hidden above/.test(await text(m, '.p-hint')), 'with nobody hidden the hint says nothing about it', await text(m, '.p-hint'));
await m.shot(`${shots}/meeting-shown.png`, null, { scale: 1 });

console.log('\na slash command, and its receipt');
await chipClick('bo');
ok(await lit() === '["bo"]', 'one click on Bo narrows the command to Bo', await lit());
await say(m, '/compact');
ok(await lit() === '["bo"]', 'and Bo is still the only name lit after it', await lit());
await m.waitFor(`(() => { const n = [...document.querySelectorAll('#p-turns .m-msg')].find((x) => x.querySelector('.t-body')?.textContent === '/compact'); return n && /done in/.test(n.textContent); })()`, { timeout: 8000 }).catch(() => {});
msg = await msgNode(m, '/compact');
ok(msg?.delivs.join('|') === "Bo /compact — done in bo's window" && !msg.pending, 'the command\'s receipt stands under it, in the window\'s words', JSON.stringify(msg));

console.log('\na question form, answered in the room');
const { spawn } = await import('node:child_process');
const formSeed = spawn('node', [new URL('./seed-form.mjs', import.meta.url).pathname, base, '--channel', 'lab', '--host', 'h-form'], { stdio: 'ignore' });
const formSeed2 = spawn('node', [new URL('./seed-form.mjs', import.meta.url).pathname, base, '--channel', 'lab', '--host', 'h-form2', '--agent', 'typist2'], { stdio: 'ignore' });
for (const a of ['typist', 'typist2']) {
  await m.waitFor(`[...document.querySelectorAll('.m-add option')].some((o) => o.value === '${a}')`, { timeout: 12000 }).catch(() => {});
  await m.evalJs(`(() => { const s = document.querySelector('.m-add'); s.value = '${a}'; s.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
  await m.waitFor(`!!document.querySelector('.m-alert[data-for-agent="${a}"] .p-ask')`, { timeout: 10000 }).catch(() => {});
}
ok(await m.evalJs(`!!document.querySelector('.m-alert[data-for-agent="typist"] .p-ask .p-q')`), 'Typist\'s form is drawn in the room, in its own box');
for (const a of ['typist', 'typist2']) {
  await m.evalJs(`(() => {
    const f = document.querySelector('.m-alert[data-for-agent="${a}"] .p-ask');
    for (const q of f.querySelectorAll('.p-q')) { const i = q.querySelector('input:not([data-other="1"])'); i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); }
    return 1; })()`);
}
await m.click('.m-alert[data-for-agent="typist"] [data-act="ask-submit"]');
await m.click('.m-alert[data-for-agent="typist2"] [data-act="ask-submit"]');
await m.waitFor(`['typist', 'typist2'].every((a) => /sending your answers/.test(document.querySelector('.m-alert[data-for-agent="' + a + '"]')?.textContent ?? ''))`, { timeout: 5000 }).catch(() => {});
ok(await m.evalJs(`['typist', 'typist2'].every((a) => /sending your answers/.test(document.querySelector('.m-alert[data-for-agent="' + a + '"]')?.textContent ?? ''))`),
  'two forms answered back to back each keep their own spinner');
const answered = await fetch(`${base}/api/host/work?host_id=h-form&wait=0`, { headers: { 'x-orchestratinator-key': KEY } }).then((r) => r.json());
const ans = (answered.work ?? []).find((x) => x.kind === 'answer');
ok(ans?.agent === 'typist' && ans?.channel === 'lab', 'Submit sends Typist\'s answers to Typist\'s window', JSON.stringify((answered.work ?? []).map((x) => [x.kind, x.agent])));
await m.shot(`${shots}/meeting-form.png`, null, { scale: 1 });
await m.click('.m-part[data-for-agent="typist"] [data-act="m-remove"]');
await m.click('.m-part[data-for-agent="typist2"] [data-act="m-remove"]');
formSeed.kill();
formSeed2.kill();

console.log('\nRemove, and Bring back from the floor');
await boxClick('dee');
const deeHid = (await boxOf('dee')).off && !/dee heard: hello room/.test(await text(m, '#p-turns'));
await m.click('.m-part[data-for-agent="dee"] [data-act="m-remove"]');
await sleep(600);
ok(deeHid, 'Dee\'s part is hidden before it is removed (the fixture for the line after next)');
ok(JSON.stringify(await parts(m)) === '["bo","cy","ed"]', 'Remove takes Dee out of the room');
ok(/Dee went back to the floor/.test(await text(m, '#p-turns')), 'and the transcript says so');
ok(/dee heard: hello room/.test(await text(m, '#p-turns')), 'what Dee said while here stays in it, and is shown again: a desk that left has no box to click');
await openOnFloor(floor, 'dee');
await floor.waitFor(`!!document.querySelector('#floor-panel #p-text')`, { timeout: 5000 }).catch(() => {});
fp = await floorPanel(floor);
ok(fp.composer && !fp.back, 'Dee\'s own chat works on the floor again', JSON.stringify(fp));
await floor.press('#floor-panel [data-act="detach"]');
const deePop = await attach((u) => u.includes('popout=1') && u.includes('agent=dee'));
const offered = (a) => m.evalJs(`[...document.querySelectorAll('.m-add option')].some((o) => o.value === '${a}')`);
await m.waitFor(`![...document.querySelectorAll('.m-add option')].some((o) => o.value === 'dee')`, { timeout: 5000 }).catch(() => {});
ok(!(await offered('dee')), 'a desk out in its own popout is not offered by Add: one place at a time (Decided 3)');
await deePop.close();
await m.waitFor(`[...document.querySelectorAll('.m-add option')].some((o) => o.value === 'dee')`, { timeout: 8000 }).catch(() => {});
ok(await offered('dee'), 'and is offered again once its popout is closed');
await openOnFloor(floor, 'cy');
await floor.waitFor(`!!document.querySelector('#floor-panel [data-act="bring-back"]')`, { timeout: 5000 });
await floor.click('#floor-panel [data-act="bring-back"]');
await m.waitFor(`!document.querySelector('.m-part[data-for-agent="cy"]')`, { timeout: 5000 }).catch(() => {});
ok(JSON.stringify(await parts(m)) === '["bo","ed"]', '"Bring back from the meeting room" on the floor takes Cy out of the room');
await floor.waitFor(`!!document.querySelector('#floor-panel #p-text')`, { timeout: 5000 }).catch(() => {});
ok((await floorPanel(floor)).composer, 'and the floor panel is Cy\'s chat again');

console.log('\na reload is the same room');
const litBeforeReload = await lit();
await boxClick('ed');
const edHid = (await boxOf('ed')).off;
await m.evalJs('location.reload(); 1');
await sleep(1500);
m = await attach(isMeeting);
await m.waitFor(`document.querySelectorAll('.m-part').length === 2`, { timeout: 12000 }).catch(() => {});
ok(JSON.stringify(await parts(m)) === '["bo","ed"]' && Number(new URLSearchParams(await m.evalJs('location.search')).get('meeting')) === roomId,
  'reloaded, the window opens the same room with the same desks', JSON.stringify(await parts(m)));
ok(litBeforeReload === '["bo"]' && await lit() === '["bo","ed"]' && await allOn(), 'the choice of Bo alone, kept through every send since, does not outlive the reload: everyone is lit', `${litBeforeReload} → ${await lit()}`);
ok(edHid && await m.evalJs(`document.querySelectorAll('.m-part.m-off').length === 0`), 'Ed\'s part, hidden before the reload, is shown after it: what is hidden is the page\'s, not the room\'s record');
await openOnFloor(floor, 'bo');
await floor.waitFor(`!!document.querySelector('#floor-panel [data-act="bring-back"]')`, { timeout: 5000 }).catch(() => {});
ok(!(await floorPanel(floor)).composer, 'and Bo is still out of the floor\'s panel');

console.log('\na choice that comes to name the whole room is everyone');
// QA, PR #55 finding 2: narrowed to Bo with the others then removed, the
// room lit "everyone" and said everyone hears, the stored choice was still
// Bo, and a desk added next was left out of the next message.
await chipClick('bo');
ok(await lit() === '["bo"]' && !(await allOn()), 'narrowed to Bo, with Ed still in the room', await lit());
await m.click('.m-part[data-for-agent="ed"] [data-act="m-remove"]');
await m.waitFor(`document.querySelectorAll('.m-part').length === 1`, { timeout: 5000 }).catch(() => {});
ok(await lit() === '["bo"]' && await allOn() && /Everyone in the room hears this/.test(await text(m, '.p-hint')),
  'Ed removed, Bo is the whole room, and the room says everyone hears', `${await lit()} | ${await text(m, '.p-hint')}`);
await m.waitFor(`[...document.querySelectorAll('.m-add option')].some((o) => o.value === 'ed')`, { timeout: 8000 }).catch(() => {});
await m.evalJs(`(() => { const s = document.querySelector('.m-add'); s.value = 'ed'; s.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
await m.waitFor(`document.querySelectorAll('.m-part').length === 2`, { timeout: 5000 }).catch(() => {});
ok(await lit() === '["bo","ed"]' && await allOn(), 'and means it: Ed, added next, is lit with Bo — the choice was everyone, not a list of one', await lit());
await say(m, 'after the leave');
await m.waitFor(`[...document.querySelectorAll('#p-turns .m-msg')].some((x) => x.querySelector('.t-body')?.textContent === 'after the leave')`, { timeout: 8000 }).catch(() => {});
msg = await msgNode(m, 'after the leave');
ok(msg && /you → everyone \(Bo, Ed\)/i.test(msg.who), 'so the next message goes to both, as the room said it would', JSON.stringify(msg?.who));

console.log('\na second room cannot take a desk this one holds');
const other = await open({ base: `${base}/?meeting=new&channel=lab&agents=bo,dee` });
await other.waitFor(`/is in a window already/.test(document.querySelector('#p-turns')?.innerText ?? '')`, { timeout: 15000 }).catch(() => {});
ok(JSON.stringify(await parts(other)) === '["dee"]' && /Bo is in a window already/.test(await text(other, '#p-turns')),
  'opened on Bo and Dee, it takes Dee and says why it has no Bo: the lock is held here', JSON.stringify(await parts(other)));
ok(JSON.stringify(await parts(m)) === '["bo","ed"]', 'and this room still has Bo');
await other.click('[data-act="m-end"]');
await sleep(800);
await other.close().catch(() => {});

console.log('\nEnd meeting');
const totalsMid = await text(floor, '#floor-totals');
await m.click('[data-act="m-end"]');
await sleep(1500);
const still = (await targets()).filter(isMeeting);
ok(still.length === 0, 'End meeting closes the window', still.join(', '));
await floor.waitFor(`!!document.querySelector('#floor-panel #p-text')`, { timeout: 6000 }).catch(() => {});
ok((await floorPanel(floor)).composer, 'and Bo is back on the floor, its chat working there');
ok(!(await floor.evalJs(`document.querySelector('#floor').innerText`)).includes('Meeting room ·'), 'an ended room is not drawn on the floor');
ok((await text(floor, '#floor-totals')) === totalsMid, 'and adds nothing to any count', `${totalsMid} → ${await text(floor, '#floor-totals')}`);

console.log('\nRecent meeting rooms, and Resume');
writeFileSync(CTL, JSON.stringify({ session: { bo: 'sess-bo-new' } }));
await floor.waitFor(`(() => { return true; })()`);
await sleep(3500);
await floor.click('[data-act="meetings"]');
await floor.waitFor(`!!document.querySelector('.meet-row')`, { timeout: 5000 });
// Both rooms ended within a second, and the list's order is updated_at at
// second resolution, then id: this room is found by its id, not its place.
const rowOf = (id) => `[...document.querySelectorAll('.meet-row')].find((r) => r.querySelector('[data-id="${id}"]'))`;
const allRows = await floor.evalJs(`document.querySelectorAll('.meet-row').length`);
const row = [await floor.evalJs(`${rowOf(roomId)}?.innerText ?? ''`)];
ok(allRows === 2 && /Bo, Ed/.test(row[0]) && /lab/.test(row[0]) && /ended/.test(row[0]),
  'this room is listed with its participants, its floor and when it ended, beside the second room', JSON.stringify(row));
ok(/Bo · sess-bo/.test(row[0]), 'with the conversation each was on as it ended', row[0]);
await floor.shot(`${shots}/meeting-recent.png`, null, { scale: 1 });
w0 = work().length;
await floor.press(`.meet-row [data-do="meeting-resume"][data-id="${roomId}"]`);
m = await attach(isMeeting);
await m.resize(760, 980);
await m.waitFor(`/Resumed\\./.test(document.querySelector('#p-turns')?.innerText ?? '')`, { timeout: 20000 }).catch(() => {});
const after = await text(m, '#p-turns');
ok(/Ed was not reopened: Ed's conversation is open in your editor/.test(after), 'Ed is not reopened, and the room says why', after);
const reopen = workSince(w0).find((x) => x.kind === 'reopen');
ok(reopen?.agent === 'bo' && reopen?.payload?.session_id === 'sess-bo', 'Bo, moved to another conversation since, is reopened on the one it had', JSON.stringify(reopen));
await m.waitFor(`/Bo is back on its conversation/.test(document.querySelector('#p-turns')?.innerText ?? '')`, { timeout: 12000 }).catch(() => {});
ok(/Bo is back on its conversation/.test(await text(m, '#p-turns')), 'and the room says when it is back on it');
ok(JSON.stringify(await parts(m)) === '["bo"]', 'the resumed room holds the desk that could be reopened');
ok(/hello room/.test(await text(m, '#p-turns')), 'and what was said in the room before is there again');
await m.shot(`${shots}/meeting-resumed.png`, null, { scale: 1 });

console.log('\nclosing the window ends it');
await m.close();
await sleep(1500);
await openOnFloor(floor, 'bo');
await floor.waitFor(`!!document.querySelector('#floor-panel #p-text')`, { timeout: 6000 }).catch(() => {});
ok((await floorPanel(floor)).composer, 'Bo is back on the floor when the window is closed');
const roomA = async () => (await (await fetch(`${base}/api/floor/meetings`)).json()).rows.filter((r) => r.id === roomId);
let rec = await roomA();
ok(rec.length === 1 && !!rec[0].ended_at, 'the board has the room as ended, one entry still after a resume', JSON.stringify(rec.map((r) => [r.id, r.ended_at])));
ok(JSON.stringify(rec[0].participants.map((p) => [p.agent, !!p.absent])) === '[["bo",false],["ed",true]]',
  'Ed, not reopened because an editor held it, is kept in the room for the next Resume, marked absent', JSON.stringify(rec[0].participants));

// Resume, again, against each way a desk can fail to come back. The fixture
// moves Bo to a new conversation before each, so each Resume has to reopen it.
const resumeAgain = async (ctlNow, before = async () => {}) => {
  writeFileSync(CTL, JSON.stringify(ctlNow));
  await before();
  await sleep(3500);
  await floor.click('[data-act="meetings"]');
  await floor.waitFor(`!!document.querySelector('.meet-row')`, { timeout: 5000 });
  const rowNow = await floor.evalJs(`${rowOf(roomId)}?.innerText ?? ''`);
  w0 = work().length;
  await floor.press(`.meet-row [data-do="meeting-resume"][data-id="${roomId}"]`);
  const r = await attach(isMeeting);
  await r.waitFor(`/Resumed\\./.test(document.querySelector('#p-turns')?.innerText ?? '')`, { timeout: 25000 }).catch(() => {});
  return { r, rowNow };
};
console.log('\nResume: a busy window');
let rs = await resumeAgain({ session: { bo: 'sess-bo-x2' } },
  () => hostEv([{ type: 'turn', channel: 'lab', agent: 'bo', session_id: 'sess-bo', role: 'tool', tool_name: 'Bash', tool_input: { command: 'make' }, at: new Date().toISOString(), uuid: 'busy-1' }]));
ok(/Ed · sess-ed · not back last time/.test(rs.rowNow), 'the Recent list says which desk did not come back last time', rs.rowNow);
let notes = await text(rs.r, '#p-turns');
ok(/Bo was not reopened: bo is working[^.]*\..*It stays in this room for the next Resume\./s.test(notes), 'Bo, mid-turn, is not reopened, in the reopen route\'s words, and kept for next time', notes);
ok(!workSince(w0).some((x) => x.kind === 'reopen'), 'and nothing was sent to its window');
await rs.r.close();
await sleep(1500);
console.log('\nResume: the host refuses the reopen');
rs = await resumeAgain({ session: { bo: 'sess-bo-x3' }, reopenFail: ['bo'] },
  () => hostEv([{ type: 'turn', channel: 'lab', agent: 'bo', session_id: 'sess-bo', role: 'assistant', text: 'done with make', at: new Date().toISOString(), uuid: 'busy-2' }]));
await rs.r.waitFor(`/Bo was not reopened: not reopened — the window is still working/.test(document.querySelector('#p-turns')?.innerText ?? '')`, { timeout: 12000 }).catch(() => {});
notes = await text(rs.r, '#p-turns');
ok(/Bo was not reopened: not reopened — the window is still working/.test(notes), 'the host\'s refusal, read off its error turn, is said in its words', notes);
ok(JSON.stringify(await parts(rs.r)) === '[]', 'and the desk is not left in the room on the wrong conversation');
await rs.r.close();
await sleep(1500);
rec = await roomA();
ok(JSON.stringify(rec[0].participants.map((p) => [p.agent, !!p.absent, p.session_id])) === '[["bo",true,"sess-bo"],["ed",true,"sess-ed"]]',
  'both are kept, each with the conversation it had in the room — not the one its desk is on now', JSON.stringify(rec[0].participants));
console.log('\nResume: a conversation gone from disk');
rs = await resumeAgain({ session: { bo: 'sess-bo-x4' }, gone: ['sess-bo'] });
notes = await text(rs.r, '#p-turns');
ok(/Bo was not reopened: its conversation is gone from its folder\.(?! It stays)/.test(notes), 'Bo, whose conversation is gone, is said so — and not kept, since that will not pass', notes);
ok(!workSince(w0).some((x) => x.kind === 'reopen'), 'its window was not touched: the host\'s list was asked first');
await rs.r.close();
await sleep(1500);
rec = await roomA();
ok(JSON.stringify(rec[0].participants.map((p) => p.agent)) === '["ed"]', 'the record keeps Ed only', JSON.stringify(rec[0].participants));

// The verdict mutate-in-a-copy's runners read: `PASS · N of N` / `FAIL · M of N red`.
console.log(fails ? `\nFAIL · ${fails} of ${total} red` : `\nPASS · ${total} of ${total}`);
process.exit(fails ? 1 : 0);

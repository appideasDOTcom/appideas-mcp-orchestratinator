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
const ok = (cond, msg, extra = '') => {
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

console.log('\nthe floor while the desks are in it');
await floor.click('svg.room[data-channel="lab"] [data-act="select-room"]');
await sleep(300);
await openOnFloor(floor, 'bo');
let fp = await floorPanel(floor);
ok(!fp.composer && fp.back === 'Bring back from the meeting room' && /meeting room/.test(fp.why ?? ''), 'the floor panel for a participant: no composer, and the way back', JSON.stringify(fp));
ok(await floor.evalJs(`!!document.querySelector('#floor-rooms .desk[data-agent="bo"]')`), 'the desk stays drawn on the floor');
ok((await text(floor, '#floor-totals')) === totalsBefore, 'and the floor\'s counts are as they were', `${totalsBefore} → ${await text(floor, '#floor-totals')}`);

console.log('\none message, everyone, delivered desk by desk');
w0 = work().length;
await say(m, 'hello room');
await m.waitFor(`[...document.querySelectorAll('#p-turns .t-assistant')].length >= 3`, { timeout: 10000 }).catch(() => {});
let msg = await msgNode(m, 'hello room');
ok(msg && /you → everyone \(Bo, Cy, Dee\)/i.test(msg.who), 'the message says who it went to', JSON.stringify(msg));
ok(msg && msg.delivs.join('|') === 'Bo delivered|Cy delivered|Dee delivered' && !msg.pending, 'each desk delivered, on its own line', JSON.stringify(msg?.delivs));
ok(await m.evalJs(`[...document.querySelectorAll('#p-turns .m-msg')].length === 1`), 'drawn once, though three desks recorded it');
const heard = await m.evalJs(`JSON.stringify([...document.querySelectorAll('#p-turns .t-assistant')].map((n) => [n.querySelector('.t-who').childNodes[0].textContent, n.querySelector('.t-body').textContent]))`).then(JSON.parse);
ok(['Bo', 'Cy', 'Dee'].every((p) => heard.some(([who, body]) => who === p && body === `${p.toLowerCase()} heard: hello room`)), 'every reply comes back, labelled with its desk', JSON.stringify(heard));
const sent = workSince(w0).filter((x) => x.kind === 'chat');
ok(sent.length === 3 && new Set(sent.map((x) => x.agent)).size === 3 && sent.every((x) => x.payload.text === 'hello room'), 'one chat per desk reached the host, the words as typed', JSON.stringify(sent.map((x) => x.agent)));
ok(await m.evalJs(`document.querySelector('#p-text').value === ''`), 'the box is empty after the send');
await m.shot(`${shots}/meeting-sent.png`, null, { scale: 1 });

console.log('\na nudge needed, and given');
const pills = (agent) => m.evalJs(`JSON.stringify([...document.querySelectorAll('.m-part[data-for-agent="${agent}"] .m-pill')].map((n) => n.textContent.trim()))`).then(JSON.parse);
ok(JSON.stringify(await pills('bo')) === '["✉ 2"]' && JSON.stringify(await pills('cy')) === '["✉ 1"]' && JSON.stringify(await pills('dee')) === '[]',
  'each participant carries its unread count, as its desk does', JSON.stringify([await pills('bo'), await pills('cy'), await pills('dee')]));
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

console.log('\nnarrowed to one desk, for one message');
await m.click('.m-to [data-act="m-to"][data-agent="cy"]');
await m.click('.m-to [data-act="m-to"][data-agent="dee"]');
ok(/Only Bo hears this one/.test(await text(m, '.p-hint')), 'the hint says who hears it', await text(m, '.p-hint'));
w0 = work().length;
await say(m, 'just for bo');
await m.waitFor(`[...document.querySelectorAll('#p-turns .t-body')].some((n) => n.textContent === 'bo heard: just for bo')`, { timeout: 8000 }).catch(() => {});
msg = await msgNode(m, 'just for bo');
ok(msg && /you → Bo$/i.test(msg.who.trim()) && msg.delivs.join('|') === 'Bo delivered', 'the transcript shows it went to Bo only', JSON.stringify(msg));
await sleep(1500);
ok(JSON.stringify(workSince(w0).filter((x) => x.kind === 'chat').map((x) => x.agent)) === '["bo"]', 'and only Bo\'s host was handed it');
ok(await m.evalJs(`document.querySelector('.m-to [data-act="m-to-all"]').classList.contains('on')`), 'the next message goes to everyone again');

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

console.log('\na slash command, and its receipt');
await m.click('.m-to [data-act="m-to"][data-agent="cy"]');
await m.click('.m-to [data-act="m-to"][data-agent="dee"]');
await m.click('.m-to [data-act="m-to"][data-agent="ed"]');
await say(m, '/compact');
await m.waitFor(`(() => { const n = [...document.querySelectorAll('#p-turns .m-msg')].find((x) => x.querySelector('.t-body')?.textContent === '/compact'); return n && /done in/.test(n.textContent); })()`, { timeout: 8000 }).catch(() => {});
msg = await msgNode(m, '/compact');
ok(msg?.delivs.join('|') === "Bo /compact — done in bo's window" && !msg.pending, 'the command\'s receipt stands under it, in the window\'s words', JSON.stringify(msg));

console.log('\na question form, answered in the room');
const { spawn } = await import('node:child_process');
const formSeed = spawn('node', [new URL('./seed-form.mjs', import.meta.url).pathname, base, '--channel', 'lab', '--host', 'h-form'], { stdio: 'ignore' });
await m.waitFor(`[...document.querySelectorAll('.m-add option')].some((o) => o.value === 'typist')`, { timeout: 12000 }).catch(() => {});
await m.evalJs(`(() => { const s = document.querySelector('.m-add'); s.value = 'typist'; s.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
await m.waitFor(`!!document.querySelector('.m-alert[data-for-agent="typist"] .p-ask')`, { timeout: 10000 }).catch(() => {});
ok(await m.evalJs(`!!document.querySelector('.m-alert[data-for-agent="typist"] .p-ask .p-q')`), 'Typist\'s form is drawn in the room, in its own box');
await m.evalJs(`(() => {
  const f = document.querySelector('.m-alert[data-for-agent="typist"] .p-ask');
  for (const q of f.querySelectorAll('.p-q')) { const i = q.querySelector('input:not([data-other="1"])'); i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); }
  return 1; })()`);
await m.click('.m-alert[data-for-agent="typist"] [data-act="ask-submit"]');
await m.waitFor(`/sending your answers/.test(document.querySelector('.m-alert[data-for-agent="typist"]')?.textContent ?? '')`, { timeout: 5000 }).catch(() => {});
const answered = await fetch(`${base}/api/host/work?host_id=h-form&wait=0`, { headers: { 'x-orchestratinator-key': KEY } }).then((r) => r.json());
const ans = (answered.work ?? []).find((x) => x.kind === 'answer');
ok(ans?.agent === 'typist' && ans?.channel === 'lab', 'Submit sends Typist\'s answers to Typist\'s window', JSON.stringify((answered.work ?? []).map((x) => [x.kind, x.agent])));
await m.shot(`${shots}/meeting-form.png`, null, { scale: 1 });
await m.click('.m-part[data-for-agent="typist"] [data-act="m-remove"]');
formSeed.kill();

console.log('\nRemove, and Bring back from the floor');
await m.click('.m-part[data-for-agent="dee"] [data-act="m-remove"]');
await sleep(600);
ok(JSON.stringify(await parts(m)) === '["bo","cy","ed"]', 'Remove takes Dee out of the room');
ok(/Dee went back to the floor/.test(await text(m, '#p-turns')), 'and the transcript says so');
ok(/dee heard: hello room/.test(await text(m, '#p-turns')), 'what Dee said while here stays in it');
await openOnFloor(floor, 'dee');
await floor.waitFor(`!!document.querySelector('#floor-panel #p-text')`, { timeout: 5000 }).catch(() => {});
fp = await floorPanel(floor);
ok(fp.composer && !fp.back, 'Dee\'s own chat works on the floor again', JSON.stringify(fp));
await openOnFloor(floor, 'cy');
await floor.waitFor(`!!document.querySelector('#floor-panel [data-act="bring-back"]')`, { timeout: 5000 });
await floor.click('#floor-panel [data-act="bring-back"]');
await m.waitFor(`!document.querySelector('.m-part[data-for-agent="cy"]')`, { timeout: 5000 }).catch(() => {});
ok(JSON.stringify(await parts(m)) === '["bo","ed"]', '"Bring back from the meeting room" on the floor takes Cy out of the room');
await floor.waitFor(`!!document.querySelector('#floor-panel #p-text')`, { timeout: 5000 }).catch(() => {});
ok((await floorPanel(floor)).composer, 'and the floor panel is Cy\'s chat again');

console.log('\na reload is the same room');
await m.evalJs('location.reload(); 1');
await sleep(1500);
m = await attach(isMeeting);
await m.waitFor(`document.querySelectorAll('.m-part').length === 2`, { timeout: 12000 }).catch(() => {});
ok(JSON.stringify(await parts(m)) === '["bo","ed"]' && Number(new URLSearchParams(await m.evalJs('location.search')).get('meeting')) === roomId,
  'reloaded, the window opens the same room with the same desks', JSON.stringify(await parts(m)));
await openOnFloor(floor, 'bo');
await floor.waitFor(`!!document.querySelector('#floor-panel [data-act="bring-back"]')`, { timeout: 5000 }).catch(() => {});
ok(!(await floorPanel(floor)).composer, 'and Bo is still out of the floor\'s panel');

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
const row = await floor.evalJs(`JSON.stringify([...document.querySelectorAll('.meet-row')].map((r) => r.innerText))`).then(JSON.parse);
ok(row.length === 1 && /Bo, Ed/.test(row[0]) && /lab/.test(row[0]) && /ended/.test(row[0]), 'one entry: its participants, its floor, when it ended', JSON.stringify(row));
ok(/Bo · sess-bo/.test(row[0]), 'with the conversation each was on as it ended', row[0]);
await floor.shot(`${shots}/meeting-recent.png`, null, { scale: 1 });
w0 = work().length;
await floor.press('.meet-row [data-do="meeting-resume"]');
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
const rooms = await (await fetch(`${base}/api/floor/meetings`)).json();
ok(rooms.rows.length === 1 && !!rooms.rows[0].ended_at, 'the board has the room as ended, still one entry after a resume', JSON.stringify(rooms.rows.map((r) => [r.id, r.ended_at])));

console.log(fails ? `\nFAIL · ${fails} red` : '\nPASS');
process.exit(fails ? 1 : 0);

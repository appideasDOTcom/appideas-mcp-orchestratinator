#!/usr/bin/env node
/**
 * What a desk's Claude Code asks, on its panel (since the window layer was
 * replaced, 2026-11-22: the host says each permission and question as an
 * `ask` event, host/desk.js). On a throwaway server with seed-meeting.mjs's
 * floor and host; the asks are put on desk bo the way the host puts them.
 *
 *   run-check-ask.sh <dir>     # the whole fixture; see there
 *
 * 1. A permission: its summary, Approve / Deny / Cancel, and the row Claude
 *    Code offered to allow it for good; Send dimmed with the board's reason;
 *    Approve reaches the host as that row's number on that request, and the
 *    "for good" row as its own.
 * 2. A question: the form built from its questions; Submit with a chosen row
 *    and typed words reaches the host as `answers`, the typed words an
 *    answer of their own (nothing withdrawn).
 * 3. Several at once (task 352 A): one shown with "N more waiting", the next
 *    forward when it is answered, a subagent's named, Send dimmed throughout.
 */
import { readFileSync } from 'node:fs';
import { open } from './drive.mjs';

const base = process.argv[2] ?? 'http://localhost:8965';
const shots = process.argv[3] ?? '/tmp';
const WORK = process.argv[4];
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

const work = () => readFileSync(WORK, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const say = (ev) => fetch(`${base}/api/host/events`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestratinator-key': 'k' },
  body: JSON.stringify({ host_id: 'h1', events: [{ channel: 'lab', agent: 'bo', session_id: 'sess-bo', ...ev }] }),
}).then((r) => r.json());
const box = (page) => page.evalJs(`JSON.stringify((() => {
  const a = document.querySelector('#floor-panel .p-alert');
  const send = document.querySelector('#floor-panel [data-act="send"]');
  return a ? {
    head: a.textContent.replace(/\\s+/g, ' ').trim().slice(0, 200),
    buttons: [...a.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean),
    questions: [...a.querySelectorAll('.p-ask [data-q], .p-ask .p-q')].length,
    send: send ? { disabled: send.disabled, placeholder: document.querySelector('#p-text')?.placeholder ?? '' } : null,
  } : null;
})())`).then(JSON.parse);

const floor = await open({ base, view: 'floor', floor: 'lab' });
await floor.resize(1280, 1000);
await floor.waitFor(`!!document.querySelector('svg.room[data-channel="lab"] .desk[data-agent="bo"]')`, { timeout: 10000 });
await floor.click('svg.room[data-channel="lab"] .desk[data-agent="bo"] .deskHit');
await floor.waitFor(`document.getElementById('floor-panel')?.dataset.agent === 'bo'`, { timeout: 8000 });

console.log('\na permission');
const ROWS = [{ n: 1, text: 'Yes' }, { n: 2, text: "Yes, and don't ask again for Bash(npm test)" }, { n: 3, text: 'No' }];
const r1 = await say({ type: 'ask', request_id: 'cu-1', kind: 'permission', tool: 'Bash', tool_input: { command: 'npm test' }, summary: 'Bash: npm test', options: ROWS });
ok(r1.applied === 1, 'the fixture: the host\'s event is taken', JSON.stringify(r1));
await floor.waitFor(`/npm test/.test(document.querySelector('#floor-panel .p-alert')?.textContent ?? '')`, { timeout: 8000 }).catch(() => {});
let b = await box(floor);
ok(/Bash: npm test/.test(b?.head ?? ''), 'the box says what the tool wants', b?.head);
ok(['Approve', 'Deny', 'Cancel'].every((t) => b?.buttons.includes(t)), 'Approve, Deny and Cancel', JSON.stringify(b?.buttons));
ok(b?.buttons.some((t) => /don't ask again for Bash\(npm test\)/.test(t)), 'and the rule Claude Code offered, as a row of its own', JSON.stringify(b?.buttons));
// Held by the host behind the prompt, not refused (F17, costmo 2026-11-23).
ok(b?.send?.disabled === false && /reaches it once you answer/.test(b?.send?.placeholder ?? ''), 'Send stays open while it stands, and the box says a message waits for the answer', JSON.stringify(b?.send));
await floor.shot(`${shots}/ask-permission.png`, '#floor-panel', { scale: 1 });
let w0 = work().length;
await floor.click('#floor-panel .p-alert [data-choice="allow"]');
await sleep(1500);
let got = work().slice(w0).filter((x) => x.kind === 'permission').map((x) => [x.payload.request_id, x.payload.decision]);
ok(JSON.stringify(got) === JSON.stringify([['cu-1', '1']]), 'Approve reaches the host as row 1 of that request', JSON.stringify(got));
await say({ type: 'ask', request_id: 'cu-2', kind: 'permission', tool: 'Bash', tool_input: { command: 'npm test' }, summary: 'Bash: npm test', options: ROWS });
await floor.waitFor(`!!document.querySelector('#floor-panel .p-alert [data-request="cu-2"]')`, { timeout: 8000 }).catch(() => {});
w0 = work().length;
await floor.click('#floor-panel .p-alert .p-choice[data-choice="2"]');
await sleep(1500);
got = work().slice(w0).filter((x) => x.kind === 'permission').map((x) => [x.payload.request_id, x.payload.decision]);
ok(JSON.stringify(got) === JSON.stringify([['cu-2', '2']]), 'the "for good" row reaches the host as its own row', JSON.stringify(got));

console.log('\na question');
const QS = [{ question: 'Pick a colour', header: 'Colour', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] }, { question: 'Pick a day', header: 'Day', multiSelect: false, options: [{ label: 'Monday' }, { label: 'Friday' }] }];
await say({ type: 'ask', request_id: 'cu-3', kind: 'question', tool: 'AskUserQuestion', tool_input: { questions: QS }, summary: 'a question for you', options: [] });
await floor.waitFor(`/2 questions for you/.test(document.querySelector('#floor-panel .p-alert')?.textContent ?? '')`, { timeout: 8000 }).catch(() => {});
b = await box(floor);
ok(/2 questions for you/.test(b?.head ?? ''), 'the box is a form of its two questions', b?.head);
await floor.shot(`${shots}/ask-question.png`, '#floor-panel', { scale: 1 });
// Through the page's own answering: Blue on the first, typed words on the second.
const answered = await floor.evalJs(`(async () => {
  const r = await fetch('./api/floor/answer', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'lab', agent: 'bo', request_id: 'cu-3', answers: [{ choose: [2] }, { choose: [3], text: 'Saturday, actually' }] }) });
  return r.status;
})()`);
ok(answered === 200, 'the form\'s answer is taken', String(answered));
await sleep(1500);
got = work().filter((x) => x.kind === 'answer' && x.payload.request_id === 'cu-3').map((x) => x.payload.answers);
ok(JSON.stringify(got) === JSON.stringify([{ 'Pick a colour': 'Blue', 'Pick a day': 'Saturday, actually' }]), 'and reaches the host as answers, typed words an answer of their own', JSON.stringify(got));
ok(!work().some((x) => x.kind === 'chat' && /Pick a day/.test(x.payload?.text ?? '')), 'with nothing sent after it as a message: no form was withdrawn for the typed words');

console.log('\nseveral at once (task 352 A)');
// The conversation's own and a subagent's, asked together: one shown, the
// other counted and named when it comes forward; Send open throughout.
await say({ type: 'ask', request_id: 'cu-4', kind: 'permission', tool: 'Bash', tool_input: { command: 'touch a' }, summary: 'Bash: touch a', options: ROWS });
await say({ type: 'ask', request_id: 'cu-5', kind: 'permission', tool: 'Bash', tool_input: { command: 'touch b' }, summary: 'Bash: touch b', options: ROWS, via: 'Build incidents capture' });
await floor.waitFor(`/1 more waiting/.test(document.querySelector('#floor-panel .p-alert')?.textContent ?? '')`, { timeout: 8000 }).catch(() => {});
b = await box(floor);
ok(/touch a/.test(b?.head ?? '') && /1 more waiting after this one/.test(b?.head ?? ''), 'the first is shown, saying one more waits behind it', b?.head);
ok(b?.send?.disabled === false, 'Send stays open: a message is held behind them', JSON.stringify(b?.send));
await floor.shot(`${shots}/ask-several.png`, '#floor-panel', { scale: 1 });
await floor.click('#floor-panel .p-alert [data-choice="allow"][data-request="cu-4"]');
await floor.waitFor(`!!document.querySelector('#floor-panel .p-alert [data-request="cu-5"]')`, { timeout: 8000 }).catch(() => {});
b = await box(floor);
ok(/touch b/.test(b?.head ?? '') && /asked by the subagent \u201cBuild incidents capture\u201d/.test(b?.head ?? '') && !/more waiting/.test(b?.head ?? ''), 'answered, the next comes forward at once, named as the subagent\'s', b?.head);
ok(b?.send?.disabled === false && /reaches it once you answer/.test(b?.send?.placeholder ?? ''), 'and Send stays open, saying it waits: something is still asked', JSON.stringify(b?.send));
await floor.shot(`${shots}/ask-subagent.png`, '#floor-panel', { scale: 1 });

console.log('\nan ask Claude Code went on without (newop walk, 2026-11-23)');
// costmo's first desk: a WebSearch permission, then Claude Code ran the tool
// and replied with nobody answering; the board's row had no permission and
// "0 need you", and the panel still drew the box with Approve / Deny.
// What the host says then is `gone` for the ask (its 'cancelled').
// The section above leaves the subagent's ask standing: said gone first.
await say({ type: 'ask', request_id: 'cu-5', gone: true });
await floor.waitFor(`!document.querySelector('#floor-panel .p-alert [data-request="cu-5"]')`, { timeout: 8000 }).catch(() => {});
await say({ type: 'ask', request_id: 'cu-6', kind: 'permission', tool: 'WebSearch', tool_input: { query: 'Tokyo weather today' }, summary: 'WebSearch: Tokyo weather today', options: ROWS });
await floor.waitFor(`!!document.querySelector('#floor-panel .p-alert [data-request="cu-6"]')`, { timeout: 8000 }).catch(() => {});
b = await box(floor);
ok(/WebSearch: Tokyo weather today/.test(b?.head ?? ''), 'the fixture: the ask is on the panel', b?.head);
await say({ type: 'ask', request_id: 'cu-6', gone: true });
await floor.waitFor(`!document.querySelector('#floor-panel .p-alert [data-request="cu-6"]') && !/Tokyo weather/.test(document.querySelector('#floor-panel .p-alert-slot')?.textContent ?? '')`, { timeout: 8000 }).catch(() => {});
b = await box(floor);
ok(!/Tokyo weather/.test(b?.head ?? '') && !(b?.buttons ?? []).includes('Approve'), 'when the host says it is gone, the box goes, with nothing to press', JSON.stringify(b));
const after = await fetch(`${base}/api/floor`).then((r) => r.json());
const bo = after.channels.find((c) => c.channel === 'lab')?.desks.find((d) => d.agent === 'bo');
ok(!bo?.permission && !bo?.session?.awaiting_kind, 'and the board agrees: no permission, nothing awaiting', JSON.stringify([bo?.permission?.request_id, bo?.session?.awaiting_kind]));
await floor.shot(`${shots}/ask-gone.png`, '#floor-panel', { scale: 1 });

console.log('\none ask, approved, and nothing behind it (F14, the newop walk)');
// costmo's first desk: one WebSearch permission, Approve pressed, the answer
// reached Claude Code and the search ran, the board cleared its prompt, and
// the panel kept the box until a reload; a second Approve then read "That
// prompt is no longer open".
await say({ type: 'ask', request_id: 'cu-7', kind: 'permission', tool: 'WebSearch', tool_input: { query: 'Tokyo weather today' }, summary: 'WebSearch: Tokyo weather today November 23 2026', options: ROWS });
await floor.waitFor(`!!document.querySelector('#floor-panel .p-alert [data-request="cu-7"]')`, { timeout: 8000 }).catch(() => {});
ok(!!(await floor.evalJs(`!!document.querySelector('#floor-panel .p-alert [data-request="cu-7"]')`)), 'the fixture: the one ask is on the panel');
await floor.click('#floor-panel .p-alert [data-choice="allow"][data-request="cu-7"]');
await floor.waitFor(`!document.querySelector('#floor-panel .p-alert [data-request="cu-7"]') && !/Tokyo weather/.test(document.querySelector('#floor-panel .p-alert-slot')?.textContent ?? '')`, { timeout: 8000 }).catch(() => {});
b = await box(floor);
ok(!/Tokyo weather/.test(b?.head ?? '') && !(b?.buttons ?? []).includes('Approve'), 'approved, the box goes, with nothing left to press', JSON.stringify(b));
await sleep(3000);
b = await box(floor);
ok(!/Tokyo weather/.test(b?.head ?? ''), 'and does not come back at the next polls', JSON.stringify(b));
await floor.shot(`${shots}/ask-approved.png`, '#floor-panel', { scale: 1 });

console.log('\nan ask standing with no needs-you mark, approved (F14, costmo\'s screenshot)');
// What costmo's box was: a host ask drawn with an empty kind ("<b></b> —
// WebSearch…"), the desk's needs-you mark not set, "0 need you" in the
// header. Approved, the board cleared it, and the box stayed until a reload.
// The ask is put on a conversation other than the one the desk shows, so its
// mark is not the one the panel reads.
// A panel opened fresh, as costmo's was: the slot has drawn nothing yet.
await floor.evalJs(`location.reload()`);
await floor.waitFor(`!!document.querySelector('svg.room[data-channel="lab"] .desk[data-agent="bo"]')`, { timeout: 15000 });
await floor.click('svg.room[data-channel="lab"] .desk[data-agent="bo"] .deskHit');
await floor.waitFor(`document.getElementById('floor-panel')?.dataset.agent === 'bo'`, { timeout: 8000 });
await say({ type: 'ask', request_id: 'cu-8', kind: 'permission', tool: 'WebSearch', tool_input: { query: 'Tokyo weather today' }, summary: 'WebSearch: Tokyo weather today November 23 2026', options: ROWS, session_id: 'sess-bo-other' });
await floor.waitFor(`!!document.querySelector('#floor-panel .p-alert [data-request="cu-8"]')`, { timeout: 8000 }).catch(() => {});
b = await box(floor);
ok(/^— WebSearch/.test(b?.head ?? '') , 'the fixture: the box is drawn with no kind, as on costmo\'s screen', b?.head);
await floor.click('#floor-panel .p-alert [data-choice="allow"][data-request="cu-8"]');
await floor.waitFor(`!document.querySelector('#floor-panel .p-alert [data-request="cu-8"]')`, { timeout: 8000 }).catch(() => {});
await sleep(2500);
b = await box(floor);
ok(!/Tokyo weather/.test(b?.head ?? '') && !(b?.buttons ?? []).includes('Approve'), 'approved, the box goes, with no reload', JSON.stringify(b));
await floor.shot(`${shots}/ask-nomark-approved.png`, '#floor-panel', { scale: 1 });

console.log(`\n${fails ? 'FAIL' : 'PASS'} · ${fails ? `${fails} of ${total} red` : `${total} of ${total}`}`);
process.exit(fails ? 1 : 0);

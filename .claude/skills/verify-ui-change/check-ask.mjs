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
    send: send ? { disabled: send.disabled } : null,
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
ok(b?.send?.disabled === true, 'Send is dimmed while it stands', JSON.stringify(b?.send));
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
// other counted and named when it comes forward; Send dimmed throughout.
await say({ type: 'ask', request_id: 'cu-4', kind: 'permission', tool: 'Bash', tool_input: { command: 'touch a' }, summary: 'Bash: touch a', options: ROWS });
await say({ type: 'ask', request_id: 'cu-5', kind: 'permission', tool: 'Bash', tool_input: { command: 'touch b' }, summary: 'Bash: touch b', options: ROWS, via: 'Build incidents capture' });
await floor.waitFor(`/1 more waiting/.test(document.querySelector('#floor-panel .p-alert')?.textContent ?? '')`, { timeout: 8000 }).catch(() => {});
b = await box(floor);
ok(/touch a/.test(b?.head ?? '') && /1 more waiting after this one/.test(b?.head ?? ''), 'the first is shown, saying one more waits behind it', b?.head);
ok(b?.send?.disabled === true, 'Send is dimmed', JSON.stringify(b?.send));
await floor.shot(`${shots}/ask-several.png`, '#floor-panel', { scale: 1 });
await floor.click('#floor-panel .p-alert [data-choice="allow"][data-request="cu-4"]');
await floor.waitFor(`!!document.querySelector('#floor-panel .p-alert [data-request="cu-5"]')`, { timeout: 8000 }).catch(() => {});
b = await box(floor);
ok(/touch b/.test(b?.head ?? '') && /asked by the subagent \u201cBuild incidents capture\u201d/.test(b?.head ?? '') && !/more waiting/.test(b?.head ?? ''), 'answered, the next comes forward at once, named as the subagent\'s', b?.head);
ok(b?.send?.disabled === true, 'and Send stays dimmed: something is still asked', JSON.stringify(b?.send));
await floor.shot(`${shots}/ask-subagent.png`, '#floor-panel', { scale: 1 });

console.log(`\n${fails ? 'FAIL' : 'PASS'} · ${fails ? `${fails} of ${total} red` : `${total} of ${total}`}`);
process.exit(fails ? 1 : 0);

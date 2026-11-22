#!/usr/bin/env node
/**
 * A dialog read by its shape, and a screen the floor does not know (0.14.6,
 * docs/robustness-review.md items 1 and 3), as a desk's panel draws them.
 * On a throwaway server with seed-meeting.mjs's floor and host; the prompts
 * are put on desk bo the way the host puts them, as `startup` events.
 *
 *   run-check-screen-prompt.sh <dir>     # the whole fixture; see there
 *
 * 1. A dialog: "The window asks — <its title>", its sentence, a button per
 *    row and Escape; Send dimmed with the board's reason; a row pressed
 *    reaches the host as that row's number on that request.
 * 2. A screen nobody knows: its lines in a box, Open the window and Press
 *    Escape; Escape reaches the host as `cancel`.
 *
 * Every reading is the page's, and what the host was handed (work.jsonl).
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
  body: JSON.stringify({ host_id: 'h1', events: [{ channel: 'lab', agent: 'bo', ...ev }] }),
}).then((r) => r.json());
const box = (page) => page.evalJs(`JSON.stringify((() => {
  const a = document.querySelector('#floor-panel .p-alert');
  const send = document.querySelector('#floor-panel [data-act="send"]');
  return a ? {
    head: a.querySelector('b')?.parentElement?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
    detail: a.querySelector('.p-startup-detail')?.textContent.trim() ?? null,
    rows: [...a.querySelectorAll('.p-choice')].map((b) => b.textContent.trim()),
    buttons: [...a.querySelectorAll('button')].map((b) => b.textContent.trim()),
    lines: a.querySelector('.p-screen-lines')?.textContent ?? null,
    send: send ? { disabled: send.disabled } : null,
  } : null;
})())`).then(JSON.parse);

const floor = await open({ base, view: 'floor', floor: 'lab' });
await floor.resize(1280, 1000);
await floor.waitFor(`!!document.querySelector('svg.room[data-channel="lab"] .desk[data-agent="bo"]')`, { timeout: 10000 });
await floor.click('svg.room[data-channel="lab"] .desk[data-agent="bo"] .deskHit');
await floor.waitFor(`document.getElementById('floor-panel')?.dataset.agent === 'bo'`, { timeout: 8000 });

console.log('\na dialog read by its shape');
const DETAIL = 'Auto mode works better when it knows your environment. Takes about a minute.';
const r1 = await say({ type: 'startup', request_id: 'startup:@1:dialog', kind: 'dialog', asks: 'Teach auto mode about your environment?', detail: DETAIL,
  options: [{ n: 1, text: 'Yes' }, { n: 2, text: 'Not now' }, { n: 3, text: "Don't show again" }], window: 'bo-window' });
ok(r1.applied === 1, 'the fixture: the host\'s event is taken', JSON.stringify(r1));
await floor.waitFor(`!!document.querySelector('#floor-panel .p-alert .p-choice')`, { timeout: 8000 }).catch(() => {});
let b = await box(floor);
ok(/^The window asks — Teach auto mode about your environment\?/.test(b?.head ?? ''), 'the box says the window asks, in the dialog\'s own title, not "before it can start"', b?.head);
ok(b?.detail === DETAIL, 'with what the dialog says above its rows', b?.detail);
ok(JSON.stringify(b?.rows) === JSON.stringify(['Yes', 'Not now', "Don't show again"]), 'a button for each of its rows', JSON.stringify(b?.rows));
ok(b?.buttons.includes('Escape'), 'and Escape beside them', JSON.stringify(b?.buttons));
ok(b?.send?.disabled === true, 'and Send is dimmed while it stands', JSON.stringify(b?.send));
await floor.shot(`${shots}/dialog-box.png`, '#floor-panel', { scale: 1 });
const w0 = work().length;
await floor.click('#floor-panel .p-alert .p-choice[data-choice="2"]');
await sleep(1500);
const got1 = work().slice(w0).filter((x) => x.kind === 'permission').map((x) => [x.payload.request_id, x.payload.decision]);
ok(JSON.stringify(got1) === JSON.stringify([['startup:@1:dialog', '2']]), 'Not now reaches the host as row 2 of that dialog', JSON.stringify(got1));
await say({ type: 'startup', request_id: 'startup:@1:dialog', gone: true });

console.log('\na screen the floor does not know');
const LINES = ['  Plugins', '  2 installed', '  ❯ ✔ floor', '    ✔ easel', '  ↑/↓ to navigate · Space to toggle · Esc to close'];
await say({ type: 'startup', request_id: 'startup:@1:screen', kind: 'screen', asks: 'the window is showing something the floor does not know', screen: LINES, options: [], window: 'bo-window' });
await floor.waitFor(`!!document.querySelector('#floor-panel .p-screen-lines')`, { timeout: 8000 }).catch(() => {});
b = await box(floor);
ok(/^The window is showing something the floor does not know/.test(b?.head ?? ''), 'the box says the window shows something the floor does not know', b?.head);
ok(b?.lines === LINES.join('\n'), 'with the pane\'s lines as it drew them', JSON.stringify(b?.lines));
ok(JSON.stringify(b?.buttons) === JSON.stringify(['Open the window', 'Press Escape']), 'and two things to do about it: open the window, or press Escape', JSON.stringify(b?.buttons));
ok(b?.send?.disabled === true, 'Send is dimmed', JSON.stringify(b?.send));
const attention = await floor.evalJs(`JSON.stringify(window.orchAttention?.get?.() ?? null)`).then(JSON.parse);
ok(attention?.asking === true, 'and the window counts it as asking, so the tab pulses for it', JSON.stringify(attention));
await floor.shot(`${shots}/screen-box.png`, '#floor-panel', { scale: 1 });
const w1 = work().length;
await floor.click('#floor-panel .p-alert [data-choice="cancel"]');
await sleep(1500);
const got2 = work().slice(w1).filter((x) => x.kind === 'permission').map((x) => [x.payload.request_id, x.payload.decision]);
ok(JSON.stringify(got2) === JSON.stringify([['startup:@1:screen', 'cancel']]), 'Press Escape reaches the host as cancel on that request', JSON.stringify(got2));

console.log(`\n${fails ? 'FAIL' : 'PASS'} · ${fails ? `${fails} of ${total} red` : `${total} of ${total}`}`);
process.exit(fails ? 1 : 0);

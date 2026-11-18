#!/usr/bin/env node
/**
 * One agent in two meeting rooms, on real Claude Code windows, driven from a
 * real (headless) browser the way the operator does it: the whole of "one
 * agent, several sessions" in one run, with nothing standing in for
 * anything. The board and the host are the tree's, on a throwaway port and
 * a tmux socket of their own (SKILL.md, "Two windows in one folder", has
 * the setup: three folders bound as ms-a/qa, ms-a/dev and ms-a/ops, each
 * with a window the floor holds).
 *
 *   ORCH_CDP_PORT=9293 node --experimental-websocket two-rooms.mjs http://localhost:8931 <shots dir> [key]
 *
 * Not a check to run on every change: it starts a real fourth window and
 * asks four real windows one question each (four short replies of tokens).
 * It is the last tier, for a change to how a second session is made,
 * bound or closed.
 */
import { open, attach } from '../verify-ui-change/drive.mjs';
const base = process.argv[2]; const shots = process.argv[3];
const KEY = process.argv[4] ?? 'probe-ms';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; let total = 0;
const ok = (c, msg, extra = '') => { total++; console.log(`  ${c ? '✓' : '✗'} ${msg}${c || !extra ? '' : `  (${extra})`}`); if (!c) fails++; };
const api = async () => (await fetch(`${base}/api/floor`, { headers: { 'x-orchestratinator-key': KEY } })).json();
const desk = async (a) => (await api()).channels.find((c) => c.channel === 'ms-a')?.desks.find((d) => d.agent === a) ?? null;
const until = async (fn, ms) => { for (const stop = Date.now() + ms; Date.now() < stop; await sleep(500)) { const v = await fn(); if (v) return v; } return null; };
const isMeeting = (u) => u.includes('meeting=');
const known = new Set();
const parts = (m) => m.evalJs(`JSON.stringify([...document.querySelectorAll('.m-part')].map((n) => n.dataset.forAgent))`).then(JSON.parse);
async function meet(page, check, n) {
  await page.click('svg.room[data-channel="ms-a"] [data-act="select-room"]');
  await page.waitFor(`!!document.querySelector('svg.room[data-channel="ms-a"].selecting')`);
  for (const a of check) { await page.click(`svg.room.selecting .desk[data-agent="${a}"] .deskHit`); await sleep(150); }
  await page.waitFor(`document.querySelector('svg.room.selecting [data-act="sel-meeting"]')?.getAttribute('aria-disabled') === 'false'`, { timeout: 8000 });
  await page.press('svg.room.selecting [data-act="sel-meeting"]');
  const m = await attach((u) => isMeeting(u) && !known.has(u));
  await m.waitFor(`document.querySelectorAll('.m-part').length === ${n} && /[?&]meeting=\\d+$/.test(location.search)`, { timeout: 30000 });
  known.add(await m.evalJs('location.href'));
  return m;
}
const say = async (page, words) => {
  await page.evalJs(`(() => { const t = document.querySelector('#p-text'); t.value = ${JSON.stringify(words)}; t.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await page.click('#floor-panel [data-act="send"]');
};
const heard = (m, re, ms = 120000) => m.waitFor(`[...document.querySelectorAll('.t-assistant')].some((n) => ${re}.test(n.textContent))`, { timeout: ms }).then(() => true, () => false);
const ASK = 'Measurement fixture for the orchestratinator. Call the orchestratinator MCP tool whoami once and reply with exactly: I AM <channel>/<agent> — nothing else.';

const floor = await open({ base, view: 'floor', floor: 'ms-a' });
await floor.resize(1280, 1400);
await floor.waitFor(`document.querySelectorAll('svg.room[data-channel="ms-a"] .desk').length === 3`, { timeout: 15000 });
console.log('\none agent in two meeting rooms, on real windows');
const A = await meet(floor, ['qa', 'dev'], 2);
ok(JSON.stringify((await parts(A)).sort()) === '["dev","qa"]', 'the first room holds the QA agent and the developer', JSON.stringify(await parts(A)));
const B = await meet(floor, ['qa', 'ops'], 2);
ok(JSON.stringify((await parts(B)).sort()) === '["ops","qa-2"]', 'the second room holds the service agent and a second session of the QA agent', JSON.stringify(await parts(B)));
const seated = await until(async () => { const d = await desk('qa-2'); return d?.hosted?.live && d.hosted.held === 'floor' ? d : null; }, 60000);
ok(!!seated && seated.hosted.seat === true && seated.twin?.of === 'qa', 'its host started a real second window in the QA agent\'s folder, and the floor holds it', JSON.stringify(seated?.hosted));
const first = await desk('qa');
ok(first?.hosted?.held === 'floor' && first.hosted.session_id !== seated?.hosted?.session_id, 'beside the first, which is still running its own conversation', JSON.stringify([first?.hosted?.session_id, seated?.hosted?.session_id]));
await floor.waitFor(`document.querySelectorAll('svg.room[data-channel="ms-a"] .meetBox').length === 2 && !!document.querySelector('svg.room[data-channel="ms-a"] .desk[data-agent="qa-2"]')`, { timeout: 15000 });
await floor.shot(`${shots}/real-two-rooms.png`, 'svg.room[data-channel="ms-a"]', { scale: 1 });
await say(B, ASK);
ok(await heard(B, '/I AM ms-a\\/qa-2/'), 'asked in the second room, the second session answers as itself: I AM ms-a/qa-2');
ok(await heard(B, '/I AM ms-a\\/ops/'), 'and so does the service agent: I AM ms-a/ops');
await say(A, ASK);
ok(await heard(A, '/I AM ms-a\\/qa(?!-)/'), 'asked in the first room, the first session answers as the QA agent: I AM ms-a/qa');
ok(await heard(A, '/I AM ms-a\\/dev/'), 'and the developer: I AM ms-a/dev');
ok(!(await B.evalJs(`document.querySelector('#floor-panel').innerText`)).includes('I AM ms-a/dev') && !(await A.evalJs(`document.querySelector('#floor-panel').innerText`)).includes('I AM ms-a/qa-2'), 'neither room has a word of the other\'s conversation');
await B.shot(`${shots}/real-room-b.png`, null, { scale: 1 });
await floor.click('svg.room[data-channel="ms-a"] .desk[data-agent="qa"] .deskHit');
await floor.waitFor(`document.querySelector('#floor-panel')?.dataset.agent === 'qa' && !!document.querySelector('#floor-panel [data-act="bring-back"]')`, { timeout: 8000 });
const label = await floor.evalJs(`document.querySelector('#floor-panel [data-act="bring-back"]').textContent`);
ok(label === 'Bring back from all 2 meeting rooms', 'on the floor, the agent\'s panel offers to bring it back from both rooms', label);
await floor.click('#floor-panel [data-act="bring-back"]');
const goneDesk = await until(async () => ((await desk('qa-2')) ? null : true), 90000);
ok(!!goneDesk, 'brought back, the second session is closed by the board and its desk leaves the floor');
ok(JSON.stringify(await parts(A)) === '["dev"]' && JSON.stringify(await parts(B)) === '["ops"]', 'both rooms carry on with their other desk', JSON.stringify([await parts(A), await parts(B)]));
ok((await desk('qa'))?.hosted?.held === 'floor' && (await desk('qa')).hosted.session_id === first.hosted.session_id, 'and the QA agent is back to one desk, on the conversation it had');
for (const m of [B, A]) { await m.click('[data-act="m-end"]').catch(() => {}); await sleep(600); }
console.log(fails ? `\nFAIL · ${fails} of ${total} red` : `\nPASS · ${total} of ${total}`);
process.exit(fails ? 1 : 0);

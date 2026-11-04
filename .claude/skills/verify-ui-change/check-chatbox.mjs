#!/usr/bin/env node
/**
 * Drive the floor's chat box through issue #13 (0.10.17): it grows with its
 * text, keeps a height the operator drags it to per channel + agent +
 * session, and the panel stays usable at its tallest. The rules themselves
 * are tested in test/floor.mjs ("the chat box's height") by lifting the
 * page's section; this is the page, which only a browser shows — line
 * heights, the native drag handle, and what still fits on the panel.
 *
 *   PORT=8915 CDP=9265 .claude/skills/verify-ui-change/run-check-chatbox.sh "$PWD"
 *
 * The runner starts a server from the directory it is given on a scratch DB,
 * seeds two desks on it (bo and cy, seed-desk.mjs), runs this and kills all
 * of it, so the same command reads a copy holding a mutant or an old SHA.
 * By hand:
 *
 *   PORT=8915 DB_PATH=<db> ORCH_AUTH_TOKEN=k node src/server.js &
 *   node .claude/skills/verify-ui-change/seed-desk.mjs http://localhost:8915 --db <db> &
 *   node .claude/skills/verify-ui-change/seed-desk.mjs http://localhost:8915 --db <db> --agent cy &
 *   node --experimental-websocket .claude/skills/verify-ui-change/check-chatbox.mjs http://localhost:8915 <db>
 *
 * Writes to the DB it is given (a saved prompt, the desk's session id), so
 * point it at a scratch DB only. About 60 s.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { open } from './drive.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const Database = createRequire(`${REPO}/package.json`)('better-sqlite3');
const [BASE = 'http://localhost:8915', DB] = process.argv.slice(2);
if (!DB) { console.error('usage: check-chatbox.mjs <base-url> <scratch-db>'); process.exit(2); }
const CH = 'lab', A = 'bo', B = 'cy', KEY = 'k', HOST = 'h1';
const HK = { 'content-type': 'application/json', 'x-orchestratinator-key': KEY };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The box's geometry, measured on this font (see styles.css): a 15px line
// and 10px of padding and border. Three rows are today's 55px box; the cap
// is 14 lines.
const LINE = 15, EXTRA = 10, BASE_H = 3 * LINE + EXTRA, CAP_H = 14 * LINE + EXTRA;
const linesH = (n) => Math.max(BASE_H, Math.min(n, 14) * LINE + EXTRA);

let pass = 0, fail = 0;
const ok = (cond, label, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
};
const step = (s) => console.log(`\n${s}`);

const db = new Database(DB);
// Each desk back on the session seed-desk.mjs gave it, so a second run on the
// same DB starts where the first did (steps 12 and 13 move bo's).
for (const ag of [A, B]) db.prepare(`UPDATE hosted_desks SET sdk_session_id = ? WHERE channel = ? AND agent = ?`).run(`sess-${ag}`, CH, ag);
db.prepare(`DELETE FROM saved_prompts WHERE title = 'box-check'`).run();
db.prepare(`INSERT INTO saved_prompts (title, content) VALUES ('box-check', ?)`).run(
  Array.from({ length: 6 }, (_, i) => `prompt line ${i + 1}`).join('\n'));
const hostEvents = (events) => fetch(`${BASE}/api/host/events`, { method: 'POST', headers: HK, body: JSON.stringify({ host_id: HOST, events }) }).then((r) => r.json());
const setSession = (agent, id) => hostEvents([{ type: 'session', channel: CH, agent, session_id: id, cwd: `/repo/${agent}` }]);
const floorDesk = async (agent) => (await (await fetch(`${BASE}/api/floor`)).json()).channels.find((c) => c.channel === CH)?.desks.find((d) => d.agent === agent);

const page = await open({ base: BASE, view: 'floor', floor: CH });
await page.resize(1500, 1000);
await page.evalJs(`Object.keys(localStorage).filter((k) => k.startsWith('orch.boxh') || k.startsWith('orch.draft')).forEach((k) => localStorage.removeItem(k)); 'ok'`);

const state = async () => JSON.parse(await page.evalJs(`(() => {
  const t = document.getElementById('p-text'), w = document.getElementById('floor-panel');
  return JSON.stringify({ agent: w?.dataset.agent, h: t?.offsetHeight, sh: t?.scrollHeight, ch: t?.clientHeight, value: t?.value,
    mark: t?.__mark ?? null, maxH: t?.style.maxHeight,
    keys: Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith('orch.boxh')).map((k) => [k, localStorage.getItem(k)])),
    drafts: Object.keys(localStorage).filter((k) => k.startsWith('orch.draft')) });
})()`));
const heightIs = async (h, label, { timeout = 3000 } = {}) => {
  try { await page.waitFor(`document.getElementById('p-text')?.offsetHeight === ${h}`, { timeout }); } catch { /* read below */ }
  const s = await state();
  ok(s.h === h, label, `height ${s.h}, expected ${h}`);
  return s;
};
/**
 * Read at once, with no wait. Where the box's text is set without an
 * \`input\` event, the page fits it in the same task (stashDraft), and the
 * panel's 2 s render would fit it again inside any wait — so a check that
 * waits cannot tell the two apart. Measured: with stashDraft's fit removed,
 * these steps passed on the render and only typing went red.
 */
const NOW = { timeout: 0 };
const openDesk = async (agent) => {
  await page.click(`.desk[data-agent="${agent}"] .deskHit`);
  await page.waitFor(`document.getElementById('floor-panel')?.dataset.agent === ${JSON.stringify(agent)} && document.getElementById('p-text') && !document.getElementById('floor-panel').classList.contains('hidden')`);
  await sleep(250);
};
const focus = () => page.evalJs(`document.getElementById('p-text').focus(); 'ok'`);
/** Type n lines with Shift+Enter between them, at the end of what is there. */
const typeLines = async (n, word = 'line') => {
  await focus();
  for (let i = 1; i <= n; i++) {
    if (i > 1) await page.key('Enter', { shift: true, text: '\r' });
    await page.type(`${word} ${i}`);
  }
};
/** Empty the box the way a person does: select all, delete. */
const empty = async () => {
  await focus();
  await page.evalJs(`(() => { const t = document.getElementById('p-text'); t.setRangeText('', 0, t.value.length, 'end'); t.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
};
/**
 * Let the page draw before a click that opens something. Observed in this
 * check's first runs (2026-11-04): two \`scroll\` events on #p-turns within
 * 10 ms of the click on the saved-prompt button, and the menu the click had
 * opened was gone — the page closes it on any scroll, because it is placed
 * against a rectangle. The same click on a fresh Chrome saw no scroll and
 * the menu stayed. What moved the transcript was not established; the box
 * had just been emptied, so its layout change is let land first.
 */
const frames = () => page.evalJs(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r('ok'))))`);
/** Drag the box's own resize handle by dy, through the browser's input. */
const drag = async (dy, held = undefined) => {
  const r = JSON.parse(await page.evalJs(`JSON.stringify(document.getElementById('p-text').getBoundingClientRect())`));
  const p = await page.press({ x: r.right - 4, y: r.bottom - 4 }, { x: r.right - 4, y: r.bottom - 4 + dy }, { held });
  if (held) { await sleep(150); return { ...(await state()), during: p.during }; }
  await sleep(150);
  return state();
};
const keyFor = (session, agent = A) => `orch.boxh:${CH}|${agent}|${session}`;

step('1. grows with its text, a line at a time, and scrolls inside past the cap');
await openDesk(A);
let s = await state();
ok(s.h === BASE_H, `a fresh box is today's size (${BASE_H}px)`, `height ${s.h}`);
await focus();
const seen = [];
for (let n = 1; n <= 20; n++) {
  if (n > 1) await page.key('Enter', { shift: true, text: '\r' });
  await page.type(`line ${n}`);
  seen.push((await state()).h);
}
ok(seen.every((h, i) => h === linesH(i + 1)), 'each line drawn at 15px more from the fourth to the fourteenth, flat before and after',
  seen.map((h, i) => `${i + 1}:${h}`).join(' '));
s = await state();
ok(s.sh > s.ch, 'at twenty lines it scrolls inside', `scrollHeight ${s.sh} > clientHeight ${s.ch}`);
ok(Object.keys(s.keys).length === 0, 'and its own growing is not recorded as a height', JSON.stringify(s.keys));
ok(s.value.split('\n').length === 20, 'Shift+Enter added a line each time, nothing was sent', `${s.value.split('\n').length} lines`);

step('2. shrinks as text goes');
await empty();
await heightIs(BASE_H, 'emptied, it is back to the starting size');
await typeLines(5);
await heightIs(linesH(5), 'five lines');
await page.evalJs(`(() => { const t = document.getElementById('p-text'); t.setRangeText('', t.value.lastIndexOf('\\n'), t.value.length, 'end'); t.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
await heightIs(linesH(4), 'a line deleted, a line shorter');

step('3. Enter sends, and the box is back to the starting size after the send');
await empty();
await typeLines(6, 'sent');
await heightIs(linesH(6), 'six lines before the send');
await page.key('Enter');
await page.waitFor(`document.getElementById('p-text').value === ''`, { timeout: 5000 }).catch(() => {});
s = await heightIs(BASE_H, 'after Enter the box is empty and at the starting size', NOW);
ok(await page.evalJs(`!!document.querySelector('#p-turns .t-pending')`), 'and the message is on its way (a pending bubble)');

step('4. a lost message put back into the box draws it at its height');
await hostEvents([{ type: 'turn', channel: CH, agent: A, session_id: `sess-${A}`, role: 'error', text: 'the window lost it', at: new Date().toISOString(), uuid: `err-${Date.now()}` }]);
await page.waitFor(`document.getElementById('p-text').value.includes('sent 6')`, { timeout: 8000 }).catch(() => {});
s = await heightIs(linesH(6), 'the six lines are back, and so is their height', NOW);
ok(s.value.includes('sent 1'), 'with the words', JSON.stringify(s.value.slice(0, 30)));

step('5. a saved prompt inserted draws the box at its height');
await empty();
await heightIs(BASE_H, 'empty first');
await frames();
await page.click('#floor-panel [data-act="prompts"]');
await page.waitFor(`!!document.querySelector('#prompt-menu .pm-item[data-pick]:not([data-pick="manage"])')`);
await page.click('#prompt-menu .pm-item[data-pick]:not([data-pick="manage"])');
s = await heightIs(linesH(6), 'a six-line prompt draws six lines', NOW);
ok(s.value.startsWith('prompt line 1'), 'and it is the prompt', JSON.stringify(s.value.slice(0, 20)));

step('6. a slash command completed by Tab leaves the box at its height');
await empty();
await focus();
await page.type('/mo');
await page.key('Tab');
s = await heightIs(BASE_H, 'one line, the starting size');
ok(s.value === '/model ', 'and the command was completed', JSON.stringify(s.value));

step('7. a draft loaded when a desk opens is drawn at its height');
await empty();
await page.evalJs(`localStorage.setItem('orch.draft:${CH}|${B}', ${JSON.stringify(Array.from({ length: 8 }, (_, i) => `draft ${i + 1}`).join('\n'))}); 'ok'`);
await openDesk(B);
s = await heightIs(linesH(8), 'the other desk opens on its eight-line draft at eight lines', NOW);

step('8. a drag sets a height: a floor the text still grows past');
await openDesk(A);
await empty();
await heightIs(BASE_H, 'starting size');
s = await drag(100);
const SET = s.h;
ok(SET > BASE_H + 90 && SET < BASE_H + 110, 'dragged about 100px taller', `height ${SET}`);
ok(s.keys[keyFor(`sess-${A}`)] === String(SET), 'kept for this channel, agent and session', JSON.stringify(s.keys));
await typeLines(3);
await heightIs(SET, 'three lines in it: still the dragged height, not shorter');
await empty();
await typeLines(14);
await heightIs(CAP_H, 'fourteen lines: grown past it to the cap');
await typeLines(6, 'more');
await heightIs(CAP_H, 'twenty: at the cap, the larger of it and the dragged height');
await empty();
await heightIs(SET, 'emptied: back to the dragged height, not to the start');
s = await state();
ok(s.keys[keyFor(`sess-${A}`)] === String(SET), 'and growing and emptying did not move the stored height', JSON.stringify(s.keys));

step('9. kept across a desk switch, a closed panel, a reload');
await page.evalJs(`document.getElementById('p-text').__mark = 'before'; 'ok'`);
await openDesk(B);
await openDesk(A);
await heightIs(SET, 'a desk switch and back');
await page.key('Escape');
await page.waitFor(`document.getElementById('floor-panel').classList.contains('hidden')`).catch(() => {});
await openDesk(A);
await heightIs(SET, 'the panel closed and opened again');
await page.goto(BASE);
await page.waitFor(`!!document.querySelector('#floor-rooms .room')`, { timeout: 15000 });
await openDesk(A);
await heightIs(SET, 'a reload');
{
  // Another tab, which is also what a browser restart comes back to: the
  // same origin's localStorage, read by a page that never saw the drag.
  const other = await open({ base: BASE, view: 'floor', floor: CH });
  await other.resize(1500, 1000);
  await other.click(`.desk[data-agent="${A}"] .deskHit`);
  await other.waitFor(`document.getElementById('floor-panel')?.dataset.agent === ${JSON.stringify(A)} && document.getElementById('p-text')?.offsetHeight === ${SET}`).catch(() => {});
  const h = await other.evalJs(`document.getElementById('p-text')?.offsetHeight`);
  ok(h === SET, 'another tab', `height ${h}`);
  await other.close();
}
await openDesk(B);
await empty();
await heightIs(BASE_H, 'and the other desk has its own: the starting size');

step('10. a drag taller than the cap is the ceiling as well as the floor');
await openDesk(A);
s = await drag(300 - SET);
const TALL = s.h;
ok(TALL > CAP_H, `dragged past the cap (${CAP_H}px)`, `height ${TALL}`);
await typeLines(25);
s = await heightIs(TALL, 'twenty-five lines: drawn at the dragged height, which is more than the cap');
ok(s.sh > s.ch, 'and scrolling inside it', `scrollHeight ${s.sh} > clientHeight ${s.ch}`);
await empty();

step('11. dragged back to the starting size or smaller, it clears and auto-grows again');
s = await drag(-600);
ok(s.h === BASE_H, 'the handle stops at the starting size', `height ${s.h}`);
ok(!(keyFor(`sess-${A}`) in s.keys), 'and the stored height is gone', JSON.stringify(s.keys));
await typeLines(8);
await heightIs(linesH(8), 'eight lines: it grows with the text again');
await empty();
await heightIs(BASE_H, 'and shrinks to the start');

step('12. a new session on the open desk switches the box without a desk switch');
s = await drag(60);
const OLD = s.h;
await page.evalJs(`document.getElementById('p-text').__mark = 'same-box'; 'ok'`);
await setSession(A, `sess-${A}-2`);
s = await heightIs(BASE_H, 'the new session starts at the default', { timeout: 8000 });
ok(s.mark === 'same-box' && s.agent === A, 'in the same box, on the same desk', `mark ${s.mark}`);
await setSession(A, `sess-${A}`);
s = await heightIs(OLD, 'going back to the older session gets its height back', { timeout: 8000 });
ok(s.mark === 'same-box', 'still the same box');

step('13. a height set on the placeholder session carries to the real id');
db.prepare(`UPDATE hosted_desks SET sdk_session_id = NULL WHERE channel = ? AND agent = ?`).run(CH, A);
const PH = `host:${HOST}:${CH}:${A}`;
ok((await floorDesk(A))?.hosted?.session_id === PH, `the desk is on its placeholder (${PH})`, (await floorDesk(A))?.hosted?.session_id);
s = await heightIs(BASE_H, 'which has no height of its own', { timeout: 8000 });
s = await drag(45);
const PH_H = s.h;
ok(s.keys[keyFor(PH)] === String(PH_H), 'a drag is filed under the placeholder', JSON.stringify(s.keys));
await setSession(A, `sess-${A}-3`);
await page.waitFor(`localStorage.getItem(${JSON.stringify(keyFor(`sess-${A}-3`))}) !== null`, { timeout: 8000 }).catch(() => {});
s = await state();
ok(s.keys[keyFor(`sess-${A}-3`)] === String(PH_H), 'the real id has it once announced', JSON.stringify(s.keys));
ok(!(keyFor(PH) in s.keys), 'and the placeholder keeps nothing for the next window', JSON.stringify(s.keys));
ok(s.h === PH_H, 'the box did not move', `height ${s.h}`);

step('14. the panel stays usable at its tallest, with a question in the alert slot');
// Back on the session with a conversation, and a long one: a transcript
// shorter than the panel never gives way, so the room would not be tested.
await setSession(A, `sess-${A}`);
// The panel reloads a desk's turns when its session changes, and turns that
// land in the same moment race that reload — measured on the base page as
// well as this one (the base drew 30 of 38). Not this issue's, and not
// what this step measures: the old turns are let in first.
await page.waitFor(`document.querySelectorAll('#p-turns .t').length >= 8`, { timeout: 8000 }).catch(() => {});
await hostEvents(Array.from({ length: 30 }, (_, i) => ({ type: 'turn', channel: CH, agent: A, session_id: `sess-${A}`, role: 'assistant',
  text: `filler reply ${i + 1}: enough words to take a line or two of the transcript, so it is taller than any panel`,
  at: new Date(Date.now() + i).toISOString(), uuid: `fill-${i}-${Date.now()}` })));
const tall = `document.getElementById('p-turns').scrollHeight > document.getElementById('p-turns').clientHeight + 200`;
await page.waitFor(tall, { timeout: 8000 }).catch(() => {});
{
  const t = JSON.parse(await page.evalJs(`(() => { const t = document.getElementById('p-turns'); return JSON.stringify({ sh: t.scrollHeight, ch: t.clientHeight, n: t.querySelectorAll('.t').length }); })()`));
  ok(t.sh > t.ch + 200, 'the transcript is taller than the panel has room for', `scrollHeight ${t.sh}, clientHeight ${t.ch}, ${t.n} turns drawn`);
}
await fetch(`${BASE}/api/ingest`, { method: 'POST', headers: HK, body: JSON.stringify({
  channel: CH, agent: A, session_id: `sess-${A}`, cwd: `/repo/${A}`, hook_event_name: 'PermissionRequest',
  tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run the tests' } }) });
await page.waitFor(`!!document.querySelector('#floor-panel .p-alert-slot > *')`, { timeout: 8000 }).catch(() => {});
ok(await page.evalJs(`!!document.querySelector('#floor-panel .p-alert-slot > *')`), 'a permission prompt is in the alert slot');
const fits = async () => JSON.parse(await page.evalJs(`(() => {
  const w = document.getElementById('floor-panel').getBoundingClientRect();
  const r = (sel) => { const e = document.querySelector('#floor-panel ' + sel); if (!e) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom) }; };
  return JSON.stringify({ panel: { top: Math.round(w.top), bottom: Math.round(w.bottom) }, alert: r('.p-alert-slot'), send: r('[data-act="send"]'), foot: r('.p-foot'),
    turns: document.getElementById('p-turns').offsetHeight, box: document.getElementById('p-text').offsetHeight });
})()`));
for (const [w, h] of [[1500, 1000], [1280, 720], [800, 700]]) {
  await page.resize(w, h);
  await sleep(300);
  await empty();
  await typeLines(16);
  let f = await fits();
  const inside = (x) => x && x.top >= f.panel.top && x.bottom <= f.panel.bottom + 1;
  ok(inside(f.alert) && inside(f.send) && inside(f.foot) && f.turns >= 50, `${w}x${h}, sixteen lines: alert, send and links on the panel`, JSON.stringify(f));
  // Read with the handle still held, too: the drag's own limit is its
  // max-height, and the page refits on release, so after it is too late to
  // see a drag that ran the send row off the panel.
  const dragged = await drag(800, fits);
  const mid = dragged.during;
  ok(inside(mid.alert) && inside(mid.send) && inside(mid.foot),
    `${w}x${h}, mid-drag with the handle held past the panel: alert, send and links on it`, JSON.stringify(mid));
  f = await fits();
  ok(inside(f.alert) && inside(f.send) && inside(f.foot) && f.turns >= 50,
    `${w}x${h}, dragged as far as it goes: still on the panel, with transcript showing`, JSON.stringify(f));
  await drag(-900);
}
await page.resize(1500, 1000);
await empty();

step('15. drafts stay per desk, under their old key');
s = await state();
await typeLines(2, 'kept');
s = await state();
ok(s.drafts.includes(`orch.draft:${CH}|${A}`) && s.drafts.every((k) => k.split('|').length === 2), 'orch.draft:<channel>|<agent>, no session in it', JSON.stringify(s.drafts));
await empty();

await page.close();
db.close();
// The verdict carries no ✗: run-page-mutant.sh counts that character as a red.
console.log(fail ? `\nFAIL · ${fail} of ${pass + fail} red` : `\nPASS · ${pass} of ${pass}`);
process.exit(fail ? 1 : 0);

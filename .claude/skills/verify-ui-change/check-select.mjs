#!/usr/bin/env node
/**
 * Drive the floor through issue #23 (bulk selection on a room) against the
 * fixture and host seed-select.mjs runs, and print what the page drew at
 * each step, with an assertion beside each reading. The rules themselves
 * are tested in test/floor.mjs ("bulk selection on a room") by lifting the
 * page's section. This is the page, which only a browser shows.
 *
 *   node --experimental-websocket .claude/skills/verify-ui-change/check-select.mjs http://localhost:8905 <out-dir> <db> <answers.json> <work.jsonl>
 *
 * Steps: the building, with a select control on each storey; selecting a
 * storey there, and a click on its desk or carpet checking or doing
 * nothing rather than riding to the floor; the floor on its own with the
 * check carried across the rebuild; Space on a focused checkbox, with
 * focus kept; check all / uncheck all; the three controls' words before
 * anything runs. Then a bulk nudge with the panel open on the desk last in
 * line, behind a window that never comes up. Its bubble is read past the
 * 30 s grace, and the host's work log for the order. Then mark read, with
 * a message landing after the draw, and the admin rows. Then hide, with
 * the pills, the counts and a pill restoring a desk unchecked. Last, the
 * bell and the card behaving as they did before, once selecting is over.
 * About 90 s, most of it the nudge.
 */
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { open } from './drive.mjs';
// The Node floor in words, before better-sqlite3 is opened: a Node-API 9 node
// segfaults on it with none (src/node-floor.js). A copy holding an older src/
// has no such file, and that is not this script's fault to report.
await import('../../../src/node-floor.js').catch((e) => { if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e; });

const base = process.argv[2] ?? 'http://localhost:8905';
const out = process.argv[3] ?? tmpdir();
const DB = process.argv[4] ?? './data/select.db';
const ANSWERS = process.argv[5] ?? '/tmp/select-host.json';
const WORK = process.argv[6] ?? '/tmp/select-work.jsonl';
const REPO = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const Database = createRequire(`${REPO}/package.json`)('better-sqlite3');
const db = new Database(DB);
const P = fileURLToPath(new URL('./probe-select.js', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) fails++; };
const eq = (got, want, msg) => ok(JSON.stringify(got) === JSON.stringify(want), `${msg}${JSON.stringify(got) === JSON.stringify(want) ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
const read = async (page) => JSON.parse(await page.probe(P));
const roomOf = (r, ch) => r.rooms.find((x) => x.ch === ch);
const show = (label, r) => {
  console.log(`\n## ${label}`);
  console.log(`  building ${r.building} | floor "${r.floor}" | card ${r.card} | focused ${r.focused}${r.errors?.length ? ` | PAGE ERRORS ${JSON.stringify(r.errors)}` : ''}`);
  for (const room of r.rooms) {
    console.log(`  ${room.ch}${room.collapsed ? ' (collapsed)' : ''}${room.selecting ? ' SELECTING' : ''} h=${room.h} "${room.meta}" control "${room.control}" bells ${room.bellsShown} desks ${JSON.stringify(room.desks)}${room.pills.length ? ` pills ${JSON.stringify(room.pills)}` : ''}`);
    if (room.bar) console.log(`    bar: ${room.bar.allText}(${room.bar.all}) "${room.bar.count}" ${JSON.stringify(room.bar.chips)}\n    sum: "${room.bar.sum}"`);
  }
  if (r.panel) console.log(`  panel ${r.panel.agent} pending ${JSON.stringify(r.panel.pending)} composer "${r.panel.composer}"`);
};
const work = () => readFileSync(WORK, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const adminRows = (since) => db.prepare(`SELECT action, actor, target, detail FROM admin_events WHERE id > ? ORDER BY id`).all(since);
const adminTop = () => db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM admin_events`).get().id;
const floorDesk = async (agent, ch = 'alpha') => (await fetch(`${base}/api/floor`).then((r) => r.json())).channels.find((c) => c.channel === ch)?.desks.find((d) => d.agent === agent);
writeFileSync(ANSWERS, JSON.stringify({ delayMs: 1200, opensUpMs: 2500, never: [], neverMs: 12000 }));

const page = await open({ base, view: 'floor', floor: '' });
await page.waitFor("document.querySelectorAll('#floor-rooms svg.room').length === 2");
// A handler that throws inside an async click reads exactly like one that
// did nothing; the probe carries these out.
await page.evalJs(`window.__errs = []; addEventListener('error', (e) => __errs.push(String(e.error?.stack ?? e.message))); addEventListener('unhandledrejection', (e) => __errs.push(String(e.reason?.stack ?? e.reason))); true`);

let r = await read(page);
show('building: two storeys', r);
ok(r.building, 'all floors with two floors is the building');
eq(r.rooms.map((x) => x.control), ['select desks', 'select desks'], 'every storey has the control (Decided 1)');
eq(r.rooms.map((x) => x.selecting), [false, false], 'and nothing is selecting yet');
await page.shot(`${out}/select-building-start.png`, null, { full: true });

await page.click('svg.room[data-channel="alpha"] .roomSel');
await page.waitFor("!!document.querySelector('svg.room[data-channel=\"alpha\"].selecting')");
r = await read(page);
show('building: alpha selecting', r);
ok(r.building && r.floor === '', 'pressing it in the building does not ride to the floor');
eq(roomOf(r, 'alpha').desks, ['ed[ ]', 'ann[ ]', 'bo[ ]', 'cy[ ]', 'di[ ]', 'gil[ ]'], 'every drawn desk on alpha has a checkbox, unchecked');
eq(roomOf(r, 'beta').desks, ['fay'], 'and the other storey has none: selection is per room');
eq(roomOf(r, 'alpha').control, 'done selecting', 'the control is now the way out');
eq(roomOf(r, 'alpha').bar?.count, '0 of 6', 'the toolbar counts against the six drawn');
await page.shot(`${out}/select-building-selecting.png`, null, { full: true });

await page.click('svg.room[data-channel="alpha"] .desk[data-agent="ann"] .deskHit');
await page.click('svg.room[data-channel="alpha"] .roomFloor');
await sleep(300);
r = await read(page);
show('building: a click on ann, then one on the carpet', r);
ok(r.building && r.floor === '', 'neither click rode to the floor');
eq(roomOf(r, 'alpha').desks[1], 'ann[x]', 'the click on the desk checked it');
eq(roomOf(r, 'alpha').bar?.count, '1 of 6', 'and the count follows');

await page.click('#floor-pick [data-floor="alpha"]');
await page.waitFor("!document.querySelector('#floor-rooms svg.room.collapsed') && document.querySelectorAll('#floor-rooms svg.room').length === 1");
r = await read(page);
show('alpha on its own', r);
ok(roomOf(r, 'alpha').selecting && roomOf(r, 'alpha').desks[1] === 'ann[x]', 'the room is still selecting with ann checked: the selection outlived a rebuild and a change of view');
const bvb = roomOf(r, 'alpha').boxVsBell;
ok(!!bvb && bvb.box[1] + bvb.box[3] <= bvb.bell[1] + 4 && Math.abs((bvb.box[0] + bvb.box[2] / 2) - (bvb.bell[0] + bvb.bell[2] / 2)) < 12, `the checkbox sits over the space above the bell (box ${JSON.stringify(bvb?.box)}, bell ${JSON.stringify(bvb?.bell)})`);
await page.shot(`${out}/select-alpha-one.png`, '#floor-rooms');

// Keyboard: Space on a focused checkbox checks it, and focus survives the rebuild it causes.
await page.evalJs(`document.querySelector('.desk[data-agent="bo"] .selBox').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })); true`);
await sleep(200);
r = await read(page);
eq(roomOf(r, 'alpha').desks[2], 'bo[x]', 'Space on bo\'s focused checkbox checks it');
eq(r.focused, 'alpha|sel|bo', 'and the checkbox still has focus after the room was rebuilt');
await page.evalJs(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })); true`);
await sleep(200);
r = await read(page);
eq(roomOf(r, 'alpha').desks[2], 'bo[ ]', 'a second Space unchecks it');

// Done, then open gil's panel the ordinary way, then select again: the desk
// last in the line is the one whose pending bubble is read below.
await page.click('svg.room[data-channel="alpha"] .roomSel');
await page.waitFor("!document.querySelector('svg.room.selecting')");
r = await read(page);
eq(roomOf(r, 'alpha').desks, ['ed', 'ann', 'bo', 'cy', 'di', 'gil'], 'done selecting: no checkboxes, the checks forgotten');
await page.click('.desk[data-agent="gil"] .deskHit');
await page.waitFor("document.getElementById('floor-panel')?.dataset.agent === 'gil'");
await page.click('svg.room[data-channel="alpha"] .roomSel');
await page.waitFor("!!document.querySelector('svg.room.selecting')");
r = await read(page);
eq(roomOf(r, 'alpha').desks[1], 'ann[ ]', 'selecting again starts with nothing checked');
ok(r.panel?.agent === 'gil', 'the panel opened before selecting stays open');

await page.click('svg.room[data-channel="alpha"] .selAll');
await sleep(150);
r = await read(page);
show('check all', r);
eq(roomOf(r, 'alpha').bar?.count, '6 of 6', 'check all checks every drawn desk');
eq(roomOf(r, 'alpha').bar?.allText, 'uncheck all', 'and turns into uncheck all');
eq(roomOf(r, 'beta'), undefined, 'beta is not on this view');
await page.click('svg.room[data-channel="alpha"] .selAll');
await sleep(150);
r = await read(page);
eq(roomOf(r, 'alpha').bar?.count, '0 of 6', 'uncheck all unchecks them');
eq(roomOf(r, 'alpha').bar?.chips, ['sel-nudge:Nudge 0:off', 'sel-read:Mark read:off', 'sel-hide:Hide 0:off', 'sel-meeting:Meeting room:off'], 'with nothing checked every action is off — Meeting room (#44) too');
await page.click('svg.room[data-channel="alpha"] .selAll');
await sleep(150);
r = await read(page);
show('check all again: the controls before anything runs', r);
eq(roomOf(r, 'alpha').bar?.chips, ['sel-nudge:Nudge 4 · 2 open a window:on', 'sel-read:Mark read · 7:on', 'sel-hide:Hide 6:on', 'sel-meeting:Meeting room · 6:on'],
  'Nudge says how many and that two open a window first; Mark read says its count before it runs');
eq(roomOf(r, 'alpha').desks, ['ed[x]<can\'t nudge>', 'ann[x]', 'bo[x]', 'cy[x]<no window>', 'di[x]<can\'t nudge>', 'gil[x]<no window>'], 'and each checked desk a nudge cannot reach, or would open, says so before the click');
console.log(`    nudge title: ${roomOf(r, 'alpha').bar.titles['sel-nudge'].replace(/\n/g, ' / ')}`);
await page.shot(`${out}/select-alpha-all.png`, '#floor-rooms');

// The nudge, behind a window that never comes up: cy is in front of gil,
// and gives up at 34 s, past the 30 s grace gil's bubble would otherwise run.
writeFileSync(ANSWERS, JSON.stringify({ delayMs: 1500, opensUpMs: 2500, never: ['cy'], neverMs: 34000 }));
const workBefore = work().length;
const t0 = Date.now();
await page.click('svg.room[data-channel="alpha"] [data-act="sel-nudge"]');
const seen = [];
let pastGrace = null;
for (;;) {
  await sleep(1000);
  r = await read(page);
  const a = roomOf(r, 'alpha');
  const line = `${a.desks.join(' ')} | gil bubble ${JSON.stringify(r.panel?.pending ?? [])} | nudge chip ${a.bar?.chips[0]}`;
  if (seen.at(-1)?.line !== line) { seen.push({ s: ((Date.now() - t0) / 1000).toFixed(1), line }); console.log(`  +${seen.at(-1).s}s ${line}`); }
  const s = (Date.now() - t0) / 1000;
  if (s > 31 && s < 33 && !pastGrace) pastGrace = r.panel?.pending ?? [];
  if (!a.desks.some((d) => /<in line>|<opening>/.test(d)) || s > 75) break;
}
r = await read(page);
show('after the nudge', r);
const a = roomOf(r, 'alpha');
ok(!!pastGrace && pastGrace.length === 1 && /in line — 1 desk ahead on testbox/.test(pastGrace[0]) && !/not recorded/.test(pastGrace[0]),
  `past 30 s, gil's bubble still says where it is in the line, not "not recorded" (${JSON.stringify(pastGrace)})`);
eq(a.desks, ['ed[x]<not nudged!>', 'ann[x]<nudged>', 'bo[x]<nudged>', 'cy[x]<not nudged!>', 'di[x]<not nudged!>', 'gil[x]<nudged>'], 'each desk says what happened to it');
eq(a.tagTitles.cy, 'Claude Code is open in that window but has not finished starting — something on screen is waiting for an answer.', 'cy\'s says why, in the host\'s words');
ok(/^No host on this board/.test(a.tagTitles.ed ?? '') && /open in your editor/.test(a.tagTitles.di ?? ''), 'ed and di say why, in the server\'s words');
eq(a.bar?.sum, 'nudge: 3 nudged · 3 not nudged — cy, ed, di', 'the toolbar counts every desk and names the ones not nudged');
const sent = work().slice(workBefore).filter((w) => w.kind === 'chat');
eq(sent.map((w) => `${w.agent}:${w.payload?.text}:${w.did}`), ['ann:nudge:typed', 'bo:nudge:typed', 'cy:nudge:error', 'gil:nudge:opened, typed'],
  'the host was sent the windowed desks first, then the windowless, and nothing for the two it cannot reach');
ok(r.panel?.pending.length === 0, 'gil\'s pending bubble is retired by its turn');
ok(r.rooms.length === 1 && r.panel?.agent === 'gil', 'the mode stayed on, the panel stayed on gil');
await page.shot(`${out}/select-alpha-nudged.png`, '#floor-rooms');

// Mark read, with a message to bo landing after the page drew it.
let top = adminTop();
db.prepare(`INSERT INTO messages (channel, from_agent, to_agent, body) VALUES ('alpha', 'ann', 'bo', '"late"')`).run();
const label = await page.evalJs(`(() => { const c = document.querySelector('svg.room[data-channel="alpha"] [data-act="sel-read"]'); const t = c.querySelector('.selChipText').textContent; c.dispatchEvent(new MouseEvent('click', { bubbles: true })); return t; })()`);
await page.waitFor("[...document.querySelectorAll('svg.room[data-channel=\"alpha\"] .selTag')].some((t) => /^read /.test(t.textContent))");
await sleep(2500);
r = await read(page);
show('after mark read', r);
const lateCaught = label === 'Mark read · 7';
console.log(`    the control read "${label}" when it was clicked${lateCaught ? ' — the drawn payload, before the late message' : ' — a poll had landed first; the late message was drawn'}`);
eq(roomOf(r, 'alpha').desks.filter((d) => /<read/.test(d)), ['ed[x]<read 3>', 'bo[x]<read 4>'], 'each desk with a backlog says how many it marked');
eq(adminRows(top).map((x) => `${x.action}:${x.actor}:${x.target}`), ['advance:operator:ed', 'advance:operator:bo'], 'one advance row per desk, by operator');
eq((await floorDesk('bo'))?.board?.unread ?? 0, lateCaught ? 1 : 0, 'the message that arrived after the draw is still unread on bo');
eq((await floorDesk('ed'))?.board?.unread ?? 0, 0, 'and ed\'s backlog is read');

// Hide two, then restore one from its pill.
await page.click('svg.room[data-channel="alpha"] .selAll');   // uncheck all
await sleep(150);
await page.click('.desk[data-agent="ann"] .selBox');
await page.click('.desk[data-agent="bo"] .selBox');
await sleep(150);
top = adminTop();
const metaBefore = roomOf(await read(page), 'alpha').meta;
await page.click('svg.room[data-channel="alpha"] [data-act="sel-hide"]');
await page.waitFor("document.querySelectorAll('svg.room[data-channel=\"alpha\"] .deskPill').length === 2");
r = await read(page);
show('after hide', r);
eq(roomOf(r, 'alpha').pills, ['ann', 'bo'], 'each hidden desk is a pill under the storey');
eq(roomOf(r, 'alpha').meta, metaBefore, 'and the storey still counts them');
eq(roomOf(r, 'alpha').bar?.count, '0 of 4', 'their checks went with them');
eq(adminRows(top).map((x) => `${x.action}:${x.actor}:${x.target}`), ['desk.hide:operator:ann', 'desk.hide:operator:bo'], 'one desk.hide row per desk, by operator');
await page.click('svg.room[data-channel="alpha"] .deskPill[data-agent="ann"]');
await page.waitFor("!!document.querySelector('svg.room[data-channel=\"alpha\"] .desk[data-agent=\"ann\"]')");
r = await read(page);
eq(roomOf(r, 'alpha').desks.find((d) => d.startsWith('ann')), 'ann[ ]', 'a pill still restores in a selecting room, and the desk comes back unchecked');
await page.shot(`${out}/select-alpha-hidden.png`, '#floor-rooms');

// Done: the one-desk controls are as they were.
await page.click('svg.room[data-channel="alpha"] .roomSel');
await page.waitFor("!document.querySelector('svg.room.selecting')");
const before = work().length;
await page.click('.desk[data-agent="ann"] .bell');
await sleep(4000);
eq(work().slice(before).map((w) => `${w.kind}:${w.agent}:${w.payload?.text}`), ['chat:ann:nudge'], 'outside selection the bell nudges its one desk');
await page.click('.desk[data-agent="ann"] .plateHit');
await sleep(200);
r = await read(page);
ok(r.card, 'and the nameplate opens its card again');
await page.click('#desk-pop [data-act="hide-desk"]');
await page.waitFor("!!document.querySelector('svg.room[data-channel=\"alpha\"] .deskPill[data-agent=\"ann\"]')");
ok(true, 'the card\'s Hide desk still hides its one desk');
await page.click('svg.room[data-channel="alpha"] .deskPill[data-agent="ann"]');
await page.waitFor("!!document.querySelector('svg.room[data-channel=\"alpha\"] .desk[data-agent=\"ann\"]')");
// A pill newer than the board half's copy (issue #23 Decided 5). The dialog
// reads /api/state (findAgent), polled apart from the floor's /api/floor, and
// a pill that arrived between the two used to open nothing (the same at
// 39d5e4b). The board half's own poll is switched off first, so the pill is
// certainly newer than its copy when it is clicked, rather than by luck.
await page.evalJs(`(() => { const c = document.getElementById('autorefresh'); c.checked = false; c.dispatchEvent(new Event('change')); return true; })()`);
const lateId = db.prepare(`INSERT INTO messages (channel, from_agent, to_agent, body) VALUES ('alpha', 'ann', 'ed', '"one more"')`).run().lastInsertRowid;
await page.waitFor("!!document.querySelector('.desk[data-agent=\"ed\"] .pill[data-act=\"unread\"]')");
const stateAtClick = Number(await page.evalJs("findAgent('alpha', 'ed')?.unread ?? 0"));
eq(stateAtClick, 0, 'the board half\'s copy has not seen the message when the pill is clicked (its poll is off)');
await page.click('.desk[data-agent="ed"] .pill[data-act="unread"]');
await page.waitFor("!!document.querySelector('#dlg [data-do=\"advance\"]')");
eq(Number(await page.evalJs(`document.querySelector('#dlg [data-do="advance"]').dataset.upTo`)), Number(lateId),
  'and the unread pill opens the backlog dialog anyway, read again first, its Mark all read up to the newest (Decided 5)');
await page.click('#dlg [data-do="cancel"]');
// And an older backlog: the board's copy now has that one message, and a
// second arrives that only the floor has drawn. Opened on the copy as it
// was, the list would lack it and Mark all read would stop short of it.
const newerId = db.prepare(`INSERT INTO messages (channel, from_agent, to_agent, body) VALUES ('alpha', 'ann', 'ed', '"and another"')`).run().lastInsertRowid;
await page.waitFor("/✉ 2/.test(document.querySelector('.desk[data-agent=\"ed\"] .pill[data-act=\"unread\"]')?.textContent ?? '')");
eq(Number(await page.evalJs("findAgent('alpha', 'ed')?.unread ?? 0")), 1, 'the board half\'s copy holds the older backlog of one when the pill reads two');
await page.click('.desk[data-agent="ed"] .pill[data-act="unread"]');
await page.waitFor("!!document.querySelector('#dlg [data-do=\"advance\"]')");
eq(Number(await page.evalJs(`document.querySelector('#dlg [data-do="advance"]').dataset.upTo`)), Number(newerId),
  'the dialog is read again first and marks up to the message only the floor had drawn');
await page.click('#dlg [data-do="cancel"]');
await page.evalJs(`(() => { const c = document.getElementById('autorefresh'); c.checked = true; c.dispatchEvent(new Event('change')); return true; })()`);

// Leaving and coming back while a nudge is still in line. The first cut's
// rooms signature read "selecting, nothing checked" and "not selecting" as
// the same once a result was kept, so neither toggle drew (found here).
writeFileSync(ANSWERS, JSON.stringify({ delayMs: 1200, opensUpMs: 2500, never: ['cy'], neverMs: 9000 }));
await page.click('svg.room[data-channel="alpha"] .roomSel');
await page.waitFor("!!document.querySelector('svg.room.selecting')");
await page.click('.desk[data-agent="cy"] .selBox');
await sleep(150);
await page.click('svg.room[data-channel="alpha"] [data-act="sel-nudge"]');
await page.waitFor("[...document.querySelectorAll('.desk[data-agent=\"cy\"] .selTag')].some((t) => t.firstChild?.textContent === 'opening')");
await page.click('svg.room[data-channel="alpha"] .roomSel');
await sleep(400);
r = await read(page);
ok(!roomOf(r, 'alpha').selecting && roomOf(r, 'alpha').control === 'select desks', 'done selecting with a nudge still in line leaves the mode');
await page.click('svg.room[data-channel="alpha"] .roomSel');
await sleep(400);
r = await read(page);
ok(roomOf(r, 'alpha').selecting, 'and selecting again comes back');
eq(roomOf(r, 'alpha').desks.find((d) => d.startsWith('cy')), 'cy[ ]<opening>', 'with the nudge still in line on cy, unchecked but still reporting');
await page.waitFor("[...document.querySelectorAll('.desk[data-agent=\"cy\"] .selTag')].some((t) => t.firstChild?.textContent === 'not nudged')", { timeout: 20000 });
ok(true, 'and cy\'s nudge ends as not nudged when its window gives up');
if (r.errors?.length) ok(false, `no page errors (${JSON.stringify(r.errors)})`);

console.log(`\n${fails ? `${fails} ✗ · FAIL` : 'PASS'}`);
await page.close();
process.exit(fails ? 1 : 0);

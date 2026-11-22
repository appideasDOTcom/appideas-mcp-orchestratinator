#!/usr/bin/env node
/**
 * Three things that ran out of their room (costmo, 2026-11-22, three
 * screenshots from the 0.14.5 app), on a throwaway server with
 * seed-meeting.mjs's floor and host, `--long`: a desk with the live
 * board's longest id, `orchestratinator-desktop-dev`.
 *
 *   run-check-plate-fit.sh <dir>       # the whole fixture; see there
 *
 * 1. A nameplate's line is one line no wider than PLATE_MAX_W (180 room
 *    units), cut with "…", and a cut plate carries both lines whole as its
 *    hover. The long desk's role line ran past its desk and out of a
 *    meeting's box; it is read on the floor and inside a meeting's box.
 * 2. A meeting room's Nudge button is one line however many names the
 *    chips choose: the names cut with "…", the count kept after them, the
 *    whole label first on the hover when the names are cut.
 * 3. A floor window under 900px draws its rooms at the rooms' width, not
 *    as a 300px thumbnail: one floor, and the building.
 *
 * Every reading is the page's own layout (getBoundingClientRect, getBBox,
 * scroll sizes), with a shot of each at the end. About forty seconds.
 */
import { open, attach } from './drive.mjs';

const base = process.argv[2] ?? 'http://localhost:8963';
const shots = process.argv[3] ?? '/tmp';
const LONG = 'orchestratinator-desktop-dev';
const PLATE_MAX_W = 180;
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

const floorPayload = async () => (await (await fetch(`${base}/api/floor`)).json()).channels.find((c) => c.channel === 'lab');
const persona = (await floorPayload()).desks.find((d) => d.agent === LONG)?.persona;
ok(!!persona && persona.length > 20, 'the fixture: the long desk is on lab, with a long name', String(persona));

/* One desk's nameplate as drawn: each line's text and its width in room
   units (getBBox is in the room's own units), the plate's hover, and each
   line's rect on screen. */
const plateOf = (page, agent, scope = 'svg.room[data-channel="lab"]') => page.evalJs(`JSON.stringify((() => {
  const g = document.querySelector('${scope} .desk[data-agent="${agent}"]');
  if (!g) return null;
  const line = (cls) => { const t = g.querySelector('.' + cls); const r = t.getBoundingClientRect(); return { text: t.textContent, w: t.getBBox().width, l: r.left, r: r.right }; };
  return { name: line('plateName'), role: line('plateRole'), title: g.querySelector('.plate > title')?.textContent ?? null };
})())`).then(JSON.parse);

console.log('\na nameplate on the floor');
const floor = await open({ base, view: 'floor', floor: 'lab' });
await floor.resize(1280, 1300);
await floor.waitFor(`!!document.querySelector('svg.room[data-channel="lab"] .desk[data-agent="${LONG}"] .plateRole')`, { timeout: 10000 });
let p = await plateOf(floor, LONG);
ok(/… · ready$/.test(p.role.text) && LONG.startsWith(p.role.text.replace(/… · ready$/, '')), 'the long desk\'s role line cuts its id with an ellipsis and keeps "· ready" whole after it', p.role.text);
ok(p.role.w <= PLATE_MAX_W + 0.5, `and is no wider than ${PLATE_MAX_W} room units, as the browser measures it`, p.role.w.toFixed(1));
ok(p.role.w > PLATE_MAX_W - 12, 'and not much narrower either: the longest start that fits', p.role.w.toFixed(1));
ok(p.name.text === persona && p.name.w <= PLATE_MAX_W + 0.5, 'its name fits, and is drawn whole', `${p.name.text} ${p.name.w.toFixed(1)}`);
ok(p.title === `${persona}\n${LONG} · ready`, 'the cut plate carries both lines whole as its hover', JSON.stringify(p.title));
const bo = await plateOf(floor, 'bo');
ok(bo.role.text === 'bo · ready' && bo.name.text === 'Bo' && bo.title === null, 'a plate that fits is drawn as it was, with no hover of its own', JSON.stringify(bo));
const hit = await floor.evalJs(`JSON.stringify((() => { const pad = document.querySelector('svg.room[data-channel="lab"] .desk[data-agent="${LONG}"] .plateHit'); pad.scrollIntoView({ block: 'center' }); const t = pad.getBoundingClientRect(); const x = (t.left + t.right) / 2, y = (t.top + t.bottom) / 2; const e = document.elementFromPoint(x, y); return { cls: e?.getAttribute('class'), act: e?.closest('[data-act]')?.dataset.act ?? null }; })())`).then(JSON.parse);
ok(hit.cls === 'plateHit' && hit.act === 'details', 'and its pad still takes the click, under the hover', JSON.stringify(hit));
await floor.shot(`${shots}/plate-floor.png`, `svg.room[data-channel="lab"]`, { scale: 1 });

console.log('\na nameplate inside a meeting\'s box');
await floor.click('svg.room[data-channel="lab"] [data-act="select-room"]');
await floor.waitFor(`!!document.querySelector('svg.room[data-channel="lab"].selecting')`);
for (const a of ['bo', 'cy', LONG]) { await floor.click(`svg.room.selecting .desk[data-agent="${a}"] .deskHit`); await sleep(120); }
await floor.waitFor(`document.querySelector('svg.room.selecting [data-act="sel-meeting"]')?.getAttribute('aria-disabled') === 'false'`);
await floor.press('svg.room.selecting [data-act="sel-meeting"]');
const m = await attach((u) => u.includes('meeting='));
await m.waitFor(`document.querySelectorAll('.m-part').length === 3 && /[?&]meeting=\\d+$/.test(location.search)`, { timeout: 15000 });
await floor.waitFor(`!!document.querySelector('svg.room[data-channel="lab"] .meetBox') && !document.querySelector('svg.room.selecting')`, { timeout: 8000 });
const boxed = await floor.evalJs(`JSON.stringify((() => {
  const f = document.querySelector('svg.room[data-channel="lab"] .meetBox .meetFrame') ?? document.querySelector('svg.room[data-channel="lab"] .meetBox rect');
  const r = f.getBoundingClientRect();
  const t = document.querySelector('svg.room[data-channel="lab"] .desk[data-agent="${LONG}"] .plateRole').getBoundingClientRect();
  const n = document.querySelector('svg.room[data-channel="lab"] .desk[data-agent="${LONG}"] .plateName').getBoundingClientRect();
  return { frame: [r.left, r.right], role: [t.left, t.right], name: [n.left, n.right] };
})())`).then(JSON.parse);
ok(boxed.role[0] >= boxed.frame[0] && boxed.role[1] <= boxed.frame[1], 'the long desk\'s role line stands inside the meeting\'s box', JSON.stringify(boxed));
ok(boxed.name[0] >= boxed.frame[0] && boxed.name[1] <= boxed.frame[1], 'and so does its name', JSON.stringify(boxed));
await floor.shot(`${shots}/plate-meeting.png`, `svg.room[data-channel="lab"]`, { scale: 1 });

console.log('\na meeting room\'s Nudge, narrowed to two long names');
await m.resize(760, 900);
// Everyone lit: a click on one chip leaves only that desk; a click on another adds it.
await m.click(`.m-to [data-agent="bo"]`);
await sleep(150);
await m.click(`.m-to [data-agent="${LONG}"]`);
// Bo has two unread messages and the long desk one (seed-meeting.mjs).
const want = `Nudge Bo, ${persona} (3)`;
await m.waitFor(`document.querySelector('[data-act="m-nudge-all"]').textContent === ${JSON.stringify(want)}`, { timeout: 6000 }).catch(() => {});
const nb = async () => m.evalJs(`JSON.stringify((() => {
  const b = document.querySelector('[data-act="m-nudge-all"]');
  const who = b.querySelector('.m-nudge-who'), n = b.querySelector('.m-nudge-n');
  const br = b.getBoundingClientRect(), nr = n?.getBoundingClientRect(), wr = who?.getBoundingClientRect();
  const send = document.querySelector('.p-actions [data-act="send"]').getBoundingClientRect();
  const row = document.querySelector('.p-actions').getBoundingClientRect();
  return { text: b.textContent, title: b.title, h: b.clientHeight, sh: b.scrollHeight, bw: br.width,
    whoCut: !!who && who.scrollWidth > who.clientWidth + 1, whoLines: who ? Math.round(wr.height / parseFloat(getComputedStyle(who).lineHeight || '15')) : 0,
    n: n?.textContent ?? null, nIn: !!nr && nr.left >= br.left - 0.5 && nr.right <= br.right + 0.5 && nr.width > 8,
    sendIn: send.right <= row.right + 0.5 && send.top >= row.top - 0.5 };
})())`).then(JSON.parse);
let n = await nb();
ok(n.text === want, 'the label is the names and the count, whole, in the page\'s words', n.text);
ok(n.sh <= n.h + 1, 'and it is drawn on one line: nothing taller than the button\'s box', JSON.stringify([n.h, n.sh]));
ok(n.whoCut, 'the names are cut with an ellipsis to fit the button\'s width', JSON.stringify(n));
ok(n.n === ' (3)' && n.nIn, 'and the count is kept whole, inside the button, after them', JSON.stringify(n));
ok(n.title.split('\n')[0] === want && /Types “nudge” into/.test(n.title), 'the whole label leads the hover, above what a click does', n.title);
ok(n.sendIn, 'Send is still on the row', JSON.stringify(n));
ok(n.bw <= 240.5, 'the button is no wider than its max-width', n.bw.toFixed(1));
await m.shot(`${shots}/nudge-narrowed.png`, '.p-actions', { scale: 1 });
// Back to everyone: the short label, not cut, and its hover as it was.
await m.click('.m-to [data-act="m-to-all"], .m-to .m-to-all').catch(() => {});
await m.waitFor(`/^Nudge all/.test(document.querySelector('[data-act="m-nudge-all"]').textContent)`, { timeout: 6000 }).catch(() => {});
n = await nb();
ok(/^Nudge all \(\d+\)$/.test(n.text) && !n.whoCut && !n.title.startsWith('Nudge'), 'with everyone chosen, "Nudge all (N)" is drawn uncut and its hover is as it was', JSON.stringify(n));

console.log('\na floor window under 900px wide');
const roomW = () => floor.evalJs(`JSON.stringify((() => {
  const rooms = document.getElementById('floor-rooms').getBoundingClientRect();
  const fb = document.querySelector('.floor-body'), cs = getComputedStyle(fb);
  const body = { width: fb.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) };
  const svgs = [...document.querySelectorAll('#floor-rooms svg.room')].map((s) => Math.round(s.getBoundingClientRect().width));
  return { win: innerWidth, rooms: Math.round(rooms.width), body: Math.round(body.width), svgs };
})())`).then(JSON.parse);
await floor.resize(1280, 1300);
await sleep(300);
const wide = await roomW();
ok(wide.svgs[0] >= 700, 'at 1280px the room is drawn at its full width', JSON.stringify(wide));
await floor.resize(860, 1300);
await floor.waitFor('innerWidth <= 900', { timeout: 4000 }).catch(() => {});
await sleep(400);
const narrow = await roomW();
ok(narrow.rooms >= narrow.body - 2, 'at 860px the rooms take the floor\'s whole width', JSON.stringify(narrow));
ok(narrow.svgs[0] >= Math.min(775, narrow.rooms) - 2 && narrow.svgs[0] > 600, 'and the room is drawn at that width, not as a 300px thumbnail', JSON.stringify(narrow));
await floor.shot(`${shots}/floor-860.png`, null, { scale: 1 });
// The panel opened on its own row, under the rooms: the rooms keep their width.
await floor.click(`svg.room[data-channel="lab"] .desk[data-agent="dee"] .deskHit`);
await floor.waitFor(`document.getElementById('floor-panel')?.dataset.agent === 'dee'`, { timeout: 8000 }).catch(() => {});
const withPanel = await roomW();
const panelBelow = await floor.evalJs(`(() => { const p = document.getElementById('floor-panel').getBoundingClientRect(), r = document.getElementById('floor-rooms').getBoundingClientRect(); return p.top >= r.bottom - 1; })()`);
ok(panelBelow && withPanel.svgs[0] === narrow.svgs[0], 'a desk\'s panel opens under them, and the room does not shrink for it', JSON.stringify({ panelBelow, withPanel }));
await floor.shot(`${shots}/floor-860-panel.png`, null, { scale: 1, full: true });
// The building: every storey the building's width, which is the rooms' width under its cap.
await floor.evalJs(`(() => { localStorage.setItem('orch.floor', ''); history.replaceState(null, '', '?floor='); location.reload(); return true; })()`);
await sleep(500);
await floor.waitFor(`document.querySelector('#floor-rooms')?.classList.contains('building') && document.querySelectorAll('#floor-rooms svg.room').length >= 2`, { timeout: 10000 });
await sleep(300);
const bld = await roomW();
ok(bld.rooms >= bld.body - 2 && bld.svgs.every((w) => w > 600), 'in the building at 860px, the building takes the width and every storey is drawn across it', JSON.stringify(bld));
await floor.shot(`${shots}/building-860.png`, null, { scale: 1 });

console.log(`\n${fails ? 'FAIL' : 'PASS'} · ${fails ? `${fails} of ${total} red` : `${total} of ${total}`}`);
process.exit(fails ? 1 : 0);

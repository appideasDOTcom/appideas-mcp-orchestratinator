#!/usr/bin/env node
/**
 * A wide popout's foot (issue #43): beside the chat, the desk's four controls
 * stand under the desk and the seat links under them, and the composer is the
 * box and the Send row alone. Narrow, and on the floor's own panel, nothing
 * moved.
 *
 *   PORT=8933 DB_PATH=/tmp/pf.db ORCH_AUTH_TOKEN=k node src/server.js &
 *   node .claude/skills/verify-ui-change/seed-desk.mjs http://localhost:8933 --db /tmp/pf.db --agent bo > /dev/null &
 *   node .claude/skills/verify-ui-change/seed-desk.mjs http://localhost:8933 --db /tmp/pf.db --agent cy > /dev/null &
 *   ORCH_CDP_PORT=9273 node --experimental-websocket .claude/skills/verify-ui-change/check-pop-foot.mjs http://localhost:8933 /tmp/shots
 *
 * Or run-check-pop-foot.sh <dir>, which does all of that and cleans up.
 * The popup is opened with press(), because the browser blocks window.open
 * without a user gesture.
 */
import { open, attach } from './drive.mjs';

const base = process.argv[2] ?? 'http://localhost:8933';
const shots = process.argv[3] ?? '/tmp';
const KEY = process.argv[4] ?? 'k';
const CH = 'lab';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
const ok = (cond, msg, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}${cond || !extra ? '' : `  (${extra})`}`);
  if (!cond) fails++;
};
const host = (events) => fetch(`${base}/api/host/events`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestratinator-key': KEY },
  body: JSON.stringify({ host_id: 'h1', events }),
}).then((r) => r.json());
const box = (page, sel) => page.evalJs(`JSON.stringify(document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect() ?? null)`).then(JSON.parse);
const wide = (page) => page.evalJs(`document.querySelector('#floor-panel').classList.contains('pop-wide')`);
const stop = async (pop, why) => {
  // What follows measures a foot that is not where it should be.
  ok(false, why);
  try { await pop.close(); } catch { /* gone */ }
  console.log(`\n${fails} ✗ · FAIL`);
  process.exit(1);
};
const footHome = (page) => page.evalJs(`document.querySelector('#floor-panel .p-foot')?.parentElement?.className ?? null`);

let floor = await open({ base, view: 'floor', floor: CH });
await floor.resize(1500, 1000);
await floor.click(`#floor-rooms .desk[data-agent="bo"] .deskHit`);
await floor.waitFor(`document.querySelector('#floor-panel')?.dataset.agent === 'bo'`);
await floor.press('#floor-panel [data-act="detach"]');
let pop = await attach((u) => u.includes('popout=1') && u.includes('agent=bo'));
await pop.waitFor(`document.querySelector('#floor-panel')?.dataset.agent === 'bo' && document.querySelector('.p-deskslot svg.popdesk')`);

console.log('\nnarrow first: the foot is the composer’s, as before');
await pop.resize(440, 980);
await pop.waitFor(`!document.querySelector('#floor-panel').classList.contains('pop-wide')`, { timeout: 3000 });
await sleep(200);
const narrowCompose = await box(pop, '#floor-panel .p-compose');
ok(await footHome(pop) === 'p-compose', 'the foot is in the composer', await footHome(pop));
ok(await pop.evalJs(`document.querySelector('.p-compose').lastElementChild.classList.contains('p-foot')`), 'and is its last part');

console.log('\nwide: the foot under the desk');
await pop.resize(1100, 900);
await pop.waitFor(`document.querySelector('#floor-panel').classList.contains('pop-wide')`, { timeout: 3000 })
  .then(() => ok(true, 'the popout is wide'), () => ok(false, 'the popout is wide'));
await sleep(200);
ok(await footHome(pop) === 'p-deskslot', 'the foot is in the desk’s column', await footHome(pop));
ok(!(await pop.evalJs(`!!document.querySelector('.p-compose .p-foot')`)), 'and nothing of it is left in the composer');
const slot = await box(pop, '.p-deskslot');
const svg = await box(pop, '.p-deskslot svg.popdesk');
const ctl = await box(pop, '.p-deskslot .p-desk');
const links = await box(pop, '.p-deskslot .p-links');
const turns = await box(pop, '#p-turns');
// The foot not in the column at all (HEAD before #43): nothing to measure.
if (!ctl || !links) await stop(pop, 'the controls and links are in the desk’s column to measure');
ok(svg.bottom <= ctl.top, `the four controls are beneath the desk (desk bottom ${Math.round(svg.bottom)}, controls top ${Math.round(ctl.top)})`);
ok(links.height > 0 && ctl.bottom <= links.top, `the OPEN IN links beneath the controls (controls bottom ${Math.round(ctl.bottom)}, links top ${Math.round(links.top)})`);
ok(ctl.top - svg.bottom < 40, `directly beneath, not at the column's foot (${Math.round(ctl.top - svg.bottom)}px gap)`);
const controls = JSON.parse(await pop.evalJs(`JSON.stringify([...document.querySelectorAll('.p-deskslot .p-desk > select, .p-deskslot .p-desk > button')]
  .map((n) => ({ act: n.dataset.act, r: n.getBoundingClientRect(), shown: n.offsetParent !== null })))`));
ok(controls.length === 4 && controls.every((c) => c.shown), `all four controls drawn: ${controls.map((c) => c.act).join(', ')}`);
ok(controls.every((c) => c.r.left >= slot.left - 0.5 && c.r.right <= slot.right + 0.5),
  'every control inside the column', controls.map((c) => `${c.act} ${Math.round(c.r.left)}–${Math.round(c.r.right)}`).join(' ') + ` column ${Math.round(slot.left)}–${Math.round(slot.right)}`);
ok(controls[0].r.top === controls[1].r.top && controls[2].r.top === controls[3].r.top && controls[0].r.bottom <= controls[2].r.top,
  'still two rows of two: model and effort, then Sessions and Leave desk');
ok(slot.right <= turns.left + 1, 'the column stays left of the chat');
const hitW = (page, sel) => page.evalJs(`Math.round(document.querySelector('${sel} .deskHit').getBoundingClientRect().width)`);
const onFloorW = await hitW(floor, '#floor-rooms .desk[data-agent="bo"]');
ok(Math.abs(onFloorW - await hitW(pop, '.p-deskslot .desk')) <= 1, `the desk is still the floor’s size (${onFloorW}px)`);

console.log('\nwide: the composer collapses to the box and the Send row');
const compose = await box(pop, '#floor-panel .p-compose');
const actions = await box(pop, '#floor-panel .p-actions');
const panel = await box(pop, '#floor-panel');
ok(compose.bottom - actions.bottom <= 12, `nothing under the Send row but the composer’s padding (${Math.round(compose.bottom - actions.bottom)}px)`);
ok(compose.height < narrowCompose.height - 40, `the composer is shorter than with the foot in it (${Math.round(compose.height)}px vs ${Math.round(narrowCompose.height)}px)`);
ok(Math.abs(compose.bottom - (panel.bottom - 1)) <= 2, 'and stands at the panel’s bottom');
await pop.shot(`${shots}/pop-foot-wide.png`, null, { scale: 1 });

console.log('\nthe desk redrawn keeps the foot');
await pop.evalJs(`document.querySelector('.p-deskslot svg.popdesk').dataset.old = '1'; 1`);
await host([{ type: 'turn', channel: CH, agent: 'bo', session_id: 'sess-bo', role: 'assistant', text: `a reply that changes the bubble ${Date.now()}`, at: new Date().toISOString(), uuid: `a-${Date.now()}` }]);
await pop.waitFor(`!document.querySelector('.p-deskslot svg.popdesk')?.dataset.old`, { timeout: 6000 })
  .then(() => ok(true, 'the desk was drawn again'), () => ok(false, 'the desk was drawn again'));
if (!(await footHome(pop) === 'p-deskslot' && await pop.evalJs(`document.querySelectorAll('.p-deskslot svg.popdesk').length === 1 && document.querySelectorAll('.p-foot').length === 1`))) {
  await stop(pop, 'one desk, one foot, the foot still under it');
}
ok(true, 'one desk, one foot, the foot still under it');
ok(await pop.evalJs(`document.querySelector('.p-deskslot').firstElementChild.matches('svg.popdesk')`), 'the desk first in the column');

console.log('\nwide: the controls still work where they stand');
await pop.click('.p-deskslot [data-act="sessions"]');
await pop.waitFor(`document.querySelector('dialog')?.open`, { timeout: 4000 })
  .then(() => ok(true, 'Sessions opens its dialog'), () => ok(false, 'Sessions opens its dialog'));
await pop.key('Escape');
await pop.waitFor(`!document.querySelector('dialog')?.open`, { timeout: 3000 }).catch(() => {});
await pop.click('.p-deskslot [data-act="leave-desk"]');
await pop.waitFor(`document.querySelector('dialog')?.open`, { timeout: 4000 })
  .then(() => ok(true, 'Leave desk asks first'), () => ok(false, 'Leave desk asks first'));
await pop.key('Escape');
await pop.waitFor(`!document.querySelector('dialog')?.open`, { timeout: 3000 }).catch(() => {});

console.log('\nwide and short: the desk gives way, the foot still fits');
for (const [w, h] of [[1100, 640], [1100, 520]]) {
  await pop.resize(w, h);
  await sleep(300);
  if (!(await wide(pop))) { ok(false, `${w}x${h} is wide`); continue; }
  const s = await box(pop, '.p-deskslot');
  const d = await box(pop, '.p-deskslot svg.popdesk');
  const f = await box(pop, '.p-deskslot .p-foot');
  const p = await box(pop, '#floor-panel');
  const inside = JSON.parse(await pop.evalJs(`JSON.stringify([...document.querySelectorAll('.p-deskslot .p-foot select, .p-deskslot .p-foot button')]
    .filter((n) => n.offsetParent).every((n) => { const r = n.getBoundingClientRect(), c = document.querySelector('.p-deskslot').getBoundingClientRect(); return r.left >= c.left - 0.5 && r.right <= c.right + 0.5; }))`));
  ok(d.bottom <= f.top && f.bottom <= p.bottom && inside,
    `${w}x${h}: desk ${Math.round(d.width)}px wide, foot ${Math.round(f.top)}–${Math.round(f.bottom)} in a panel ending at ${Math.round(p.bottom)}, controls inside the ${Math.round(s.width)}px column`);
  if (h === 520) await pop.shot(`${shots}/pop-foot-short.png`, null, { scale: 1 });
}

console.log('\nnarrow again: home');
await pop.resize(440, 980);
await pop.waitFor(`!document.querySelector('#floor-panel').classList.contains('pop-wide')`, { timeout: 3000 });
await sleep(200);
ok(await footHome(pop) === 'p-compose' && await pop.evalJs(`document.querySelector('.p-compose').lastElementChild.classList.contains('p-foot')`),
  'the foot is back at the composer’s end', await footHome(pop));
const nLinks = await box(pop, '.p-compose .p-links');
const nCtl = await box(pop, '.p-compose .p-desk');
ok(nLinks.right <= nCtl.left && Math.abs(nLinks.top - nCtl.top) <= 2, 'links left, controls right, side by side, as before');
ok(Math.abs((await box(pop, '#floor-panel .p-compose')).height - narrowCompose.height) <= 1, 'the composer is the height it was');
await pop.shot(`${shots}/pop-foot-narrow.png`, null, { scale: 1 });

console.log('\nnarrow and short: the box grows, the transcript gives way first, then the desk');
{
  // Under ~800px tall the desk and a 140px transcript used to take all the
  // height: the box sat at 55px, neither growing nor taking a drag.
  const state = () => pop.evalJs(`(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(), t = document.querySelector('#p-text');
    return JSON.stringify({ ta: t.offsetHeight, max: parseFloat(t.style.maxHeight), turns: Math.round(r('#p-turns').height), desk: Math.round(r('.p-deskslot svg').height),
      fits: r('.p-compose').bottom <= r('#floor-panel').bottom + 0.5 }); })()`).then(JSON.parse);
  const fill = async (n) => {
    await pop.evalJs(`(() => { const t = document.querySelector('#p-text'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); t.focus(); return 1; })()`);
    for (let i = 0; i < n; i++) { await pop.type(`line ${i + 1}`); if (i < n - 1) await pop.key('Enter', { shift: true, text: '\r' }); }
    await sleep(200);
    return state();
  };
  const draft = await pop.evalJs(`document.querySelector('#p-text').value`);
  await pop.resize(440, 980); await sleep(300);
  const fullDesk = (await state()).desk;
  for (const [w, h] of [[500, 760], [440, 640]]) {
    await pop.resize(w, h); await sleep(400);
    const empty = await fill(0);
    const six = await fill(6);
    const many = await fill(26);
    const back = await fill(0);
    ok(empty.ta === back.ta && six.ta > empty.ta + 40, `${w}x${h}: six lines grow the box (${empty.ta} → ${six.ta}px)`);
    ok(many.ta > six.ta && many.turns <= 61 && many.desk < six.desk && many.desk >= Math.floor(fullDesk / 2) - 1 && many.fits,
      `${w}x${h}: 26 lines take the transcript to its least and then the desk, not past half, send row on the panel`,
      JSON.stringify({ six, many, fullDesk }));
    ok(back.desk === empty.desk, `${w}x${h}: emptied, the box and the desk are as they were (${back.ta}px, desk ${back.desk}px)`);
  }
  await pop.resize(500, 760); await sleep(400);
  await fill(0);
  const b = await box(pop, '#p-text');
  await pop.press({ x: b.right - 3, y: b.bottom - 3 }, { x: b.right - 3, y: b.bottom + 900 }, { steps: 10 });
  await sleep(300);
  const dragged = await state();
  ok(dragged.ta > b.height + 150 && dragged.ta >= dragged.max - 1 && dragged.fits && dragged.desk >= Math.floor(fullDesk / 2) - 1,
    `500x760: a drag takes the box to its room (${Math.round(b.height)} → ${dragged.ta}px), desk ${dragged.desk}px, send row on the panel`, JSON.stringify(dragged));
  await pop.evalJs(`location.reload(); 1`).catch(() => {});
  await sleep(1500);
  pop = await attach((u) => u.includes('popout=1') && u.includes('agent=bo'));
  await pop.waitFor(`document.querySelector('.p-deskslot svg.popdesk') && document.querySelector('#p-turns .t')`);
  await sleep(500);
  const reloaded = await state();
  ok(Math.abs(reloaded.ta - dragged.ta) <= 2 && reloaded.fits, `and the dragged height is theirs after a reload (${reloaded.ta}px)`, JSON.stringify(reloaded));
  // The desk and the box size each other: settled means neither moves
  // while nothing changes. A loop between fitBox and popLayout would.
  const moves = await pop.evalJs(`new Promise((res) => { let n = 0; const o = new MutationObserver((m) => { n += m.length; });
    o.observe(document.querySelector('.p-deskslot'), { attributes: true, subtree: true, attributeFilter: ['style'] });
    o.observe(document.querySelector('#p-text'), { attributes: true, attributeFilter: ['style'] });
    setTimeout(() => { o.disconnect(); res(n); }, 2000); })`);
  ok(moves === 0, `and settled: no desk or box redraw in 2 s of nothing changing (${moves})`);
  await pop.evalJs(`(() => { const t = document.querySelector('#p-text'); t.value = ${JSON.stringify(draft)}; t.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
}

console.log('\nthe floor’s own panel is untouched');
await floor.click(`#floor-rooms .desk[data-agent="cy"] .deskHit`);
await floor.waitFor(`document.querySelector('#floor-panel')?.dataset.agent === 'cy' && document.querySelector('#floor-panel .p-foot')`);
ok(await footHome(floor) === 'p-compose' && !(await wide(floor)), 'its foot is in the composer', await footHome(floor));

try { await pop.close(); } catch { /* gone */ }
console.log(fails ? `\n${fails} ✗ · FAIL` : '\nPASS');
process.exit(fails ? 1 : 0);

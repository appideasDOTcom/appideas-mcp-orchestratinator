#!/usr/bin/env node
/**
 * A desk's chat in a window of its own (issue #19), driven end to end on a
 * throwaway server: detach, the floor while a desk is out, the controls in the
 * popout, every way back, a floor reload and close, the desk moving, hidden
 * and left under it, and seven windows open at once staying live.
 *
 *   PORT=8931 DB_PATH=/tmp/pop.db ORCH_AUTH_TOKEN=k node src/server.js &
 *   for a in bo cy d1 d2 d3 d4 d5; do
 *     node .claude/skills/verify-ui-change/seed-desk.mjs http://localhost:8931 --db /tmp/pop.db --agent $a > /dev/null &
 *   done
 *   node .claude/skills/verify-ui-change/seed-form.mjs http://localhost:8931 --host h-form > /dev/null &
 *   ORCH_CDP_PORT=9271 ORCH_CHROME_ARGS=--enable-features=IntensiveWakeUpThrottling:grace_period_seconds/10 \
 *     node --experimental-websocket .claude/skills/verify-ui-change/check-popout.mjs http://localhost:8931 /tmp/shots
 *
 * ORCH_CHROME_ARGS shortens Chrome's throttling grace from five minutes to
 * ten seconds, for the minimized-popout step. It reaches only a Chrome the
 * check launches, so kill one already on the port first. The step measures
 * the throttling itself and says so if it did not happen.
 *
 * Its own CDP port, because QA's checks keep a Chrome on 9222. A popup is
 * opened with press() — real input — because the browser blocks window.open
 * without a user gesture, and a dispatched click is not one.
 */
import { open, attach, targets } from './drive.mjs';

const base = process.argv[2] ?? 'http://localhost:8931';
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
const isPop = (agent, channel = null) => (u) => u.includes('popout=1') && u.includes(`agent=${agent}`) && (!channel || u.includes(`channel=${channel}`));
const pops = async () => (await targets()).filter((u) => u.includes('popout=1'));
const panelOf = (page) => page.evalJs(`JSON.stringify({
  agent: document.querySelector('#floor-panel')?.dataset.agent ?? null,
  channel: document.querySelector('#floor-panel')?.dataset.channel ?? null,
  composer: !!document.querySelector('#p-text'),
  draft: document.querySelector('#p-text')?.value ?? null,
  out: !!document.querySelector('#floor-panel [data-act="bring-back"]'),
  ended: document.querySelector('#floor-panel')?.dataset.ended ?? null,
  why: document.querySelector('#floor-panel .p-out-why')?.textContent ?? null,
})`).then(JSON.parse);
const openOnFloor = async (page, agent) => {
  await page.click(`#floor-rooms .desk[data-agent="${agent}"] .deskHit`);
  await page.waitFor(`document.querySelector('#floor-panel')?.dataset.agent === ${JSON.stringify(agent)}`);
};
const type = (page, text) => page.evalJs(`(() => { const t = document.querySelector('#p-text'); t.value = ${JSON.stringify(text)};
  t.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
const closePop = async (pop) => { try { await pop.close(); } catch { /* already gone */ } };

let floor = await open({ base, view: 'floor', floor: CH });
await floor.resize(1500, 1000);

console.log('\ndetach');
await openOnFloor(floor, 'bo');
await type(floor, 'typed on the floor first');
ok(await floor.evalJs(`!!document.querySelector('#floor-panel [data-act="detach"]')`), 'the panel header has a detach button');
await floor.press('#floor-panel [data-act="detach"]');
let pop = await attach(isPop('bo'));
await pop.resize(440, 980);
await pop.waitFor(`document.querySelector('#floor-panel')?.dataset.agent === 'bo' && document.querySelector('#p-turns .t')`);
let p = await panelOf(pop);
ok(p.composer && p.draft === 'typed on the floor first', 'the popout opens on the desk, with the draft typed on the floor', JSON.stringify(p));
ok(await pop.evalJs(`!!document.querySelector('.p-deskslot svg.popdesk .desk .bell') && !!document.querySelector('.p-deskslot .plate')`),
  'it draws the desk as the floor does: bell, nameplate');
ok(await pop.evalJs(`!!document.querySelector('[data-act="reattach"]') && !document.querySelector('[data-act="close-panel"]')`), 'Re-attach in place of ✕');
ok(await pop.evalJs(`getComputedStyle(document.querySelector('.topbar')).display === 'none' && getComputedStyle(document.querySelector('#floor-rooms')).display === 'none'`),
  'no top bar and no rooms in the popout');
await floor.waitFor(`!!document.querySelector('#floor-panel [data-act="bring-back"]')`);
p = await panelOf(floor);
ok(p.out && !p.composer, 'the floor panel is the header and "Bring chat back here", with no composer', JSON.stringify(p));
ok(await floor.evalJs(`!!document.querySelector('#floor-rooms .desk[data-agent="bo"]')`), 'the desk stays drawn in its room');
// The desk at the size the floor draws it (costmo, after the first cut drew
// it smaller): the hit pad is the cell's full width, in both windows. At the
// popout's own width first: headless opens a popup at 800 px whatever was
// asked, which is wide enough for the desk's own column.
await pop.resize(440, 980);
await pop.waitFor(`!document.querySelector('#floor-panel').classList.contains('pop-wide')`, { timeout: 3000 });
const hitW = (page, sel) => page.evalJs(`Math.round(document.querySelector('${sel} .deskHit').getBoundingClientRect().width)`);
const onFloorW = await hitW(floor, '#floor-rooms .desk[data-agent="bo"]');
ok(Math.abs(onFloorW - await hitW(pop, '.p-deskslot .desk')) <= 1, `the desk is drawn at the floor's size (${onFloorW}px)`);
const box = (page, sel) => page.evalJs(`JSON.stringify(document.querySelector('${sel}').getBoundingClientRect())`).then(JSON.parse);
let slot = await box(pop, '.p-deskslot');
let turnsBox = await box(pop, '#p-turns');
ok(slot.bottom <= turnsBox.top + 1 && !(await pop.evalJs(`document.querySelector('#floor-panel').classList.contains('pop-wide')`)),
  'narrow: the desk above the chat');
const panelBox = await box(pop, '#floor-panel');
ok(panelBox.left >= 8 && panelBox.top >= 8, `inset from the window's edge (${Math.round(panelBox.left)}px, ${Math.round(panelBox.top)}px)`);
await pop.shot(`${shots}/popout.png`, null, { scale: 1 });
await pop.resize(1100, 900);
await pop.waitFor(`document.querySelector('#floor-panel').classList.contains('pop-wide')`, { timeout: 3000 })
  .then(() => ok(true, 'dragged wide: the desk takes a column of its own'), () => ok(false, 'dragged wide: the desk takes a column of its own'));
slot = await box(pop, '.p-deskslot');
turnsBox = await box(pop, '#p-turns');
ok(slot.right <= turnsBox.left + 1 && slot.top <= turnsBox.top + 1, 'to the left of the chat');
await pop.shot(`${shots}/popout-wide.png`, null, { scale: 1 });
await pop.resize(440, 980);
await pop.waitFor(`!document.querySelector('#floor-panel').classList.contains('pop-wide')`, { timeout: 3000 })
  .then(() => ok(true, 'and narrow again, back over the chat'), () => ok(false, 'and narrow again, back over the chat'));

// The chat box (#13) in a popout: 18 lines, then its corner dragged far past
// the window, at three sizes. The send row stays in the window. Before the
// popout's panel gave boxRoom its height, the box reached 1,123px and the
// row was drawn off the bottom of every size.
{
  const draft = await pop.evalJs(`document.querySelector('#p-text').value`);
  const fits = [];
  for (const [w, h] of [[440, 980], [1100, 760], [440, 700]]) {
    await pop.resize(w, h);
    await sleep(300);
    await pop.evalJs(`document.querySelector('#p-text').focus(); 1`);
    for (let i = 0; i < 18; i++) { await pop.type(`line ${i + 1}`); await pop.key('Enter', { shift: true, text: '\r' }); }
    const b = await box(pop, '#p-text');
    await pop.press({ x: b.right - 3, y: b.bottom - 3 }, { x: b.right - 3, y: b.bottom + 900 });
    await sleep(300);
    const foot = await box(pop, '#floor-panel .p-foot');
    const panel = await box(pop, '#floor-panel');
    fits.push(`${w}x${h}:${Math.round(foot.bottom)}/${Math.round(panel.bottom)}`);
    await pop.evalJs(`(() => { const t = document.querySelector('#p-text'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
    const c = await box(pop, '#p-text');
    await pop.press({ x: c.right - 3, y: c.bottom - 3 }, { x: c.right - 3, y: c.top + 10 });
  }
  ok(fits.every((f) => { const [a, b] = f.split(':')[1].split('/').map(Number); return a <= b; }),
    `a long message and a tall drag keep the send row in the window: ${fits.join(' ')} (foot/panel bottom)`);
  await pop.resize(440, 980);
  await pop.evalJs(`(() => { const t = document.querySelector('#p-text'); t.value = ${JSON.stringify('')} + ${JSON.stringify(draft)}; t.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
}
await floor.shot(`${shots}/floor-out.png`, '#floor-panel', { scale: 1 });

console.log('\nno second window');
// A mark on the popout's own page: a detach that re-opened the window by its
// name would reload it, and the mark would be gone. The name alone already
// prevents a second window, so the count by itself cannot tell "brought to
// the front" from "reloaded".
await pop.evalJs(`window.__orchMark = 'still this page'; 1`);
await floor.press('#floor-panel [data-act="detach"]');
await sleep(600);
ok((await pops()).length === 1, 'detaching a desk already out opens nothing new', JSON.stringify(await pops()));
ok(await pop.evalJs(`window.__orchMark === 'still this page'`), 'and does not reload the one that is out — it is brought to the front');

console.log('\nthe stream reaches the popout');
await host([{ type: 'delivery', channel: CH, agent: 'bo', state: 'queued', text: 'a message held for bo' }]);
await pop.waitFor(`[...document.querySelectorAll('#p-turns .t-pending')].some((n) => n.textContent.includes('a message held for bo'))`, { timeout: 4000 })
  .then(() => ok(true, 'a delivery note arrives in the popout'), (e) => ok(false, 'a delivery note arrives in the popout', e.message));
await host([{ type: 'turn', channel: CH, agent: 'bo', session_id: 'sess-bo', role: 'user', text: 'a message held for bo', at: new Date().toISOString(), uuid: `u-${Date.now()}` }]);
const t0 = Date.now();
await host([{ type: 'turn', channel: CH, agent: 'bo', session_id: 'sess-bo', role: 'assistant', text: 'streamed reply for the popout', at: new Date().toISOString(), uuid: `a-${Date.now()}` }]);
await pop.waitFor(`[...document.querySelectorAll('#p-turns .t')].some((n) => n.textContent.includes('streamed reply for the popout'))`, { timeout: 4000, every: 25 });
ok(Date.now() - t0 < 1500, `a new turn is in the popout in ${Date.now() - t0}ms (the poll alone is 2 s)`);

console.log('\nthe controls, in the popout');
await pop.click('.p-deskslot .plate[data-act="details"]');
await pop.waitFor(`!!document.querySelector('#desk-pop')`).then(() => ok(true, 'the nameplate opens its card in the popout'), () => ok(false, 'the nameplate opens its card in the popout'));
await pop.click('#desk-pop [data-act="rename"]');
await pop.waitFor(`document.querySelector('#dlg')?.open`).then(() => ok(true, 'Edit avatar opens its dialog in the popout'), () => ok(false, 'Edit avatar opens its dialog in the popout'));
ok(!(await floor.evalJs(`!!document.querySelector('#dlg')?.open`)), 'and not on the floor');
await pop.key('Escape');
await pop.waitFor(`!document.querySelector('#dlg')?.open`);
await pop.click('#floor-panel [data-act="sessions"]');
await pop.waitFor(`document.querySelector('#dlg')?.open`).then(() => ok(true, 'Sessions opens in the popout'), () => ok(false, 'Sessions opens in the popout'));
await pop.key('Escape');
await pop.waitFor(`!document.querySelector('#dlg')?.open`);
// The bell: what the bell posts is the chat route, so a nudge is a user turn
// the host would type. Its pending bubble is the popout's.
await pop.click('.p-deskslot .bell');
await pop.waitFor(`[...document.querySelectorAll('#p-turns .t-pending')].some((n) => n.textContent.includes('nudge'))`, { timeout: 4000 })
  .then(() => ok(true, 'the bell nudges, and its pending bubble is in the popout'), (e) => ok(false, 'the bell nudges, and its pending bubble is in the popout', e.message));
ok(await floor.evalJs(`!!document.querySelector('#floor-rooms .desk[data-agent="bo"] .bell.ringing')`), 'the desk on the floor rings with it');
// Send from the popout's composer.
await type(pop, 'sent from the popout');
await pop.click('#floor-panel [data-act="send"]');
await pop.waitFor(`[...document.querySelectorAll('#p-turns .t-pending')].some((n) => n.textContent.includes('sent from the popout')) && document.querySelector('#p-text').value === ''`, { timeout: 4000 })
  .then(() => ok(true, 'Send works from the popout'), (e) => ok(false, 'Send works from the popout', e.message));

console.log('\na nudge struck on the floor, for a desk that is out');
await sleep(1500);            // the popout's own peal ends first
await floor.click('#floor-rooms .desk[data-agent="bo"] .bell');
await pop.waitFor(`[...document.querySelectorAll('#p-turns .t-pending')].filter((n) => n.textContent.includes('nudge')).length >= 2`, { timeout: 4000 })
  .then(() => ok(true, 'its pending bubble is drawn in the popout'), (e) => ok(false, 'its pending bubble is drawn in the popout', e.message));

console.log('\na bulk nudge from a selecting room, for a desk that is out (#23)');
{
  // No host answers this board's work, so every nudge stays in line. bo is
  // made windowless for this step, which puts it after every windowed desk
  // in the line (nudgePlan), so its bubble has something to wait on and
  // say: the desks ahead of it, which only the floor's record knows.
  await host([{ type: 'holder', channel: CH, agent: 'bo', holder: null }]);
  await floor.waitFor(`fetch('./api/floor').then((r) => r.json()).then((f) => f.channels.find((c) => c.channel === 'lab').desks.find((d) => d.agent === 'bo').nudge?.opens === true)`, { timeout: 6000 });
  const n = JSON.parse(await floor.evalJs(`JSON.stringify(document.querySelectorAll('#floor-rooms svg.room[data-channel="lab"] .desk').length)`));
  const want = `in line — ${n - 1} desks ahead`;
  await floor.click('svg.room[data-channel="lab"] [data-act="select-room"]');
  await floor.waitFor(`!!document.querySelector('svg.room.selecting [data-act="sel-all"]')`);
  await floor.click('svg.room.selecting [data-act="sel-all"]');
  // The plan is made from the page's own payload, which can be a poll behind
  // the fetch above: wait for the room to say bo has no window. A first cut
  // pressed Nudge on the fetch alone and the plan put bo first in line.
  await floor.waitFor(`(document.querySelector('svg.room.selecting .desk[data-agent="bo"]')?.textContent ?? '').includes('no window')`, { timeout: 6000 });
  await floor.waitFor(`!!document.querySelector('svg.room.selecting [data-act="sel-nudge"]:not([aria-disabled="true"])')`);
  await floor.click('svg.room.selecting [data-act="sel-nudge"]');
  await pop.waitFor(`[...document.querySelectorAll('#p-turns .t-pending')].some((n) => n.textContent.includes(${JSON.stringify(want)}))`, { timeout: 8000 })
    .then(() => ok(true, `the popout draws its bubble with the room's line: "${want}"`),
      async (e) => ok(false, `the popout draws its bubble with the room's line: "${want}"`, (await pop.evalJs(`[...document.querySelectorAll('#p-turns .t-pending')].map((n) => n.textContent).join(' | ')`)) || e.message));
  await floor.click('svg.room.selecting [data-act="select-room"]');
  await host([{ type: 'holder', channel: CH, agent: 'bo', holder: 'floor', window: 'bo-window' }]);
}

console.log('\nHistory, for a desk that is out');
await floor.evalJs(`window.floorRead('lab', 'bo', 'sess-old', 'an old talk'); 1`);
await pop.waitFor(`document.querySelector('#floor-panel')?.dataset.reading === 'sess-old'`, { timeout: 4000 })
  .then(() => ok(true, 'a History row opens the reading view in the popout'), (e) => ok(false, 'a History row opens the reading view in the popout', e.message));
ok(!(await floor.evalJs(`!!document.querySelector('#floor-panel')?.dataset.reading`)), 'and not on the floor');
await pop.click('[data-act="read-back"]');
await pop.waitFor(`!!document.querySelector('#p-text')`);

console.log('\nRe-attach, in the popout');
await type(pop, 'typed in the popout');
await pop.click('[data-act="reattach"]');
await floor.waitFor(`!!document.querySelector('#p-text') && document.querySelector('#floor-panel').dataset.agent === 'bo'`, { timeout: 4000 });
p = await panelOf(floor);
ok(p.composer && p.draft === 'typed in the popout', 'the floor has the chat back, with the popout\'s draft', JSON.stringify(p));
await sleep(500);
ok((await pops()).length === 0, 'and the popout is closed', JSON.stringify(await pops()));

console.log('\nBring chat back here, on the floor');
await floor.press('#floor-panel [data-act="detach"]');
pop = await attach(isPop('bo'));
await pop.waitFor(`!!document.querySelector('#p-text')`);
await type(pop, 'second draft, in the popout');
await floor.waitFor(`!!document.querySelector('#floor-panel [data-act="bring-back"]')`);
await floor.click('#floor-panel [data-act="bring-back"]');
await floor.waitFor(`!!document.querySelector('#p-text')`, { timeout: 4000 });
p = await panelOf(floor);
ok(p.draft === 'second draft, in the popout', 'the chat is back with the popout\'s draft', JSON.stringify(p));
await sleep(800);
ok((await pops()).length === 0, 'and the popout closed itself', JSON.stringify(await pops()));

console.log('\nclosing the popout window');
await floor.press('#floor-panel [data-act="detach"]');
pop = await attach(isPop('bo'));
await pop.waitFor(`!!document.querySelector('#p-text')`);
await floor.waitFor(`!!document.querySelector('#floor-panel [data-act="bring-back"]')`);
// The floor's panel shut first. With it still open on the desk, the panel's
// own redraw would take the chat back, and the window closing would not be
// what was tested.
await floor.click('#floor-panel [data-act="close-panel"]');
await floor.waitFor(`document.querySelector('#floor-panel').classList.contains('hidden')`);
await closePop(pop);
await floor.waitFor(`document.querySelector('#floor-panel')?.dataset.agent === 'bo' && !!document.querySelector('#p-text')`, { timeout: 5000 })
  .then(() => ok(true, 'closing the window puts the chat back in the floor panel'), (e) => ok(false, 'closing the window puts the chat back in the floor panel', e.message));

// With the floor's panel on another desk, closing the window changes
// nothing there (costmo, task 273): the panel stays on cy, with what was
// being typed to cy and the focus in its box. bo is simply no longer out.
await floor.press('#floor-panel [data-act="detach"]');
pop = await attach(isPop('bo'));
await pop.waitFor(`!!document.querySelector('#p-text')`);
await openOnFloor(floor, 'cy');
await floor.waitFor(`!!document.querySelector('#p-text')`);
await type(floor, 'half a message to cy');
await floor.evalJs(`document.querySelector('#p-text').focus(); 1`);
await closePop(pop);
await sleep(3500);
p = await panelOf(floor);
ok(p.agent === 'cy' && p.draft === 'half a message to cy' && await floor.evalJs(`document.activeElement?.id === 'p-text'`),
  'closing it with the floor on another desk leaves that desk\'s panel, its text and its focus alone', JSON.stringify({ ...p, focus: await floor.evalJs(`document.activeElement?.id || document.activeElement?.tagName`) }));
await type(floor, '');
await openOnFloor(floor, 'bo');
await floor.waitFor(`!!document.querySelector('#p-text')`, { timeout: 3000 })
  .then(() => ok(true, 'and bo, no longer out, opens its chat on the floor when clicked'), (e) => ok(false, 'and bo, no longer out, opens its chat on the floor when clicked', e.message));

console.log('\na floor reloaded, then closed');
await floor.press('#floor-panel [data-act="detach"]');
pop = await attach(isPop('bo'));
await pop.resize(440, 980);
await pop.waitFor(`!!document.querySelector('#p-text')`);
await floor.goto(base);
await floor.waitFor(`!!document.querySelector('#floor-rooms .desk[data-agent="bo"]')`, { timeout: 8000 });
await openOnFloor(floor, 'bo');
await floor.waitFor(`!!document.querySelector('#floor-panel [data-act="bring-back"]')`, { timeout: 3000 })
  .then(() => ok(true, 'a reloaded floor knows the desk is out'), (e) => ok(false, 'a reloaded floor knows the desk is out', e.message));
ok((await pops()).length === 1, 'and the popout survived the reload');
await floor.close();
await sleep(500);
await host([{ type: 'turn', channel: CH, agent: 'bo', session_id: 'sess-bo', role: 'assistant', text: 'said with the floor closed', at: new Date().toISOString(), uuid: `c-${Date.now()}` }]);
await pop.waitFor(`[...document.querySelectorAll('#p-turns .t')].some((n) => n.textContent.includes('said with the floor closed'))`, { timeout: 4000 })
  .then(() => ok(true, 'with the floor tab closed, the popout is still live'), (e) => ok(false, 'with the floor tab closed, the popout is still live', e.message));

console.log('\nthe session switch, in the popout');
// A hosted session announcing a new id puts the panel onto that session's
// turns from zero (pollOnce's filter check), here as on the floor.
await host([{ type: 'session', channel: CH, agent: 'bo', session_id: 'sess-bo-2', cwd: '/repo/bo' },
  { type: 'turn', channel: CH, agent: 'bo', session_id: 'sess-bo-2', role: 'assistant', text: 'first words of the new session', at: new Date().toISOString(), uuid: `n-${Date.now()}` }]);
await pop.waitFor(`[...document.querySelectorAll('#p-turns .t')].some((n) => n.textContent.includes('first words of the new session'))
  && ![...document.querySelectorAll('#p-turns .t')].some((n) => n.textContent.includes('said with the floor closed'))`, { timeout: 6000 })
  .then(() => ok(true, 'the popout moves to the new session\'s turns, and the old ones go'), (e) => ok(false, 'the popout moves to the new session\'s turns, and the old ones go', e.message));

floor = await open({ base, view: 'floor', floor: CH });
await floor.resize(1500, 1000);

console.log('\na minimized popout stays out (QA, PR #41 finding 1)');
{
  // Chrome gives a window hidden past its grace one timer wake-up a minute.
  // Presence used to be a 2 s beat heard within 7 s, so the floor drew bo's
  // composer beside the popout's. It is the popout's lock now, and the hub
  // drops a window when its lock comes free, not when it goes quiet.
  await openOnFloor(floor, 'bo');
  await floor.waitFor(`!!document.querySelector('#floor-panel [data-act="bring-back"]')`, { timeout: 5000 });
  await pop.evalJs(`window.__ticks = []; setInterval(() => window.__ticks.push(Date.now()), 1000); 1`);
  await pop.windowState('minimized');
  await pop.waitFor(`document.visibilityState === 'hidden'`, { timeout: 5000 });
  const samples = [];
  // 150 s: QA measured the beats holding at 2 s for about 65 s after the
  // minimize before the minute-long gaps began, and a first cut sampling
  // 100 s saw a longest gap of 14 s, which proves nothing.
  for (let i = 0; i < 30; i++) {
    await sleep(5000);
    samples.push(await floor.evalJs(`document.querySelector('#floor-panel')?.dataset.agent === 'bo' && !!document.querySelector('#floor-panel [data-act="bring-back"]') && !document.querySelector('#p-text')`));
  }
  const gap = await pop.evalJs(`(() => { const t = window.__ticks; let g = 0; for (let i = 1; i < t.length; i++) g = Math.max(g, t[i] - t[i - 1]); return g; })()`);
  ok(gap >= 20_000, `the hidden popout's timers were throttled (longest gap ${gap} ms) — or this step proves nothing`);
  ok(samples.every(Boolean), `the floor kept bo out, with no composer of its own, in ${samples.filter(Boolean).length} of ${samples.length} samples over 150 s`);
  // The stream: a turn while it is still hidden reaches it at once. Its own
  // poll is throttled to once a minute, so only the hub can have brought it.
  const t0 = Date.now();
  await host([{ type: 'turn', channel: CH, agent: 'bo', session_id: 'sess-bo-2', role: 'assistant', text: 'said to a minimized popout', at: new Date().toISOString(), uuid: `h-${Date.now()}` }]);
  await pop.waitFor(`[...document.querySelectorAll('#p-turns .t')].some((n) => n.textContent.includes('said to a minimized popout'))`, { timeout: 5000, every: 100 })
    .then(() => ok(true, `and its stream still delivers while it is hidden (${Date.now() - t0} ms)`), (e) => ok(false, 'and its stream still delivers while it is hidden', e.message));
  await pop.windowState('normal');
  await pop.waitFor(`document.visibilityState === 'visible'`, { timeout: 5000 });
}

console.log('\nits desk changes under it');
const hidden = await floor.evalJs(`fetch('./api/admin/desk/hide', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'lab', agent: 'bo' }) }).then((r) => r.status)`);
await floor.waitFor(`!document.querySelector('#floor-rooms .desk[data-agent="bo"]')`, { timeout: 5000 });
await sleep(2500);
p = await panelOf(pop);
ok(hidden === 200 && p.composer && await pop.evalJs(`!!document.querySelector('.p-deskslot .desk')`), 'hidden: the popout stays, desk and chat', JSON.stringify(p));
await floor.evalJs(`fetch('./api/admin/desk/show', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'lab', agent: 'bo' }) }).then((r) => r.status)`);
await type(pop, 'draft that moves with the desk');
await host([{ type: 'bound', channel: 'lab2', agent: 'bo', cwd: '/repo/bo', from: { channel: CH, agent: 'bo' } }]);
await pop.waitFor(`document.querySelector('#floor-panel')?.dataset.channel === 'lab2' && !!document.querySelector('#p-text')`, { timeout: 6000 })
  .then(() => ok(true, 'moved: the popout follows the desk to its new floor'), (e) => ok(false, 'moved: the popout follows the desk to its new floor', e.message));
p = await panelOf(pop);
ok(p.draft === 'draft that moves with the desk', 'with its draft', JSON.stringify(p));
ok((await pops()).some(isPop('bo', 'lab2')), 'and its address names the new floor', JSON.stringify(await pops()));
await floor.goto(`${base}`);
await floor.evalJs(`localStorage.setItem('orch.floor', 'lab2'); 1`);
await floor.goto(`${base}`);
await floor.waitFor(`!!document.querySelector('#floor-rooms .desk[data-agent="bo"]')`, { timeout: 8000 });
await openOnFloor(floor, 'bo');
await floor.waitFor(`!!document.querySelector('#floor-panel [data-act="bring-back"]')`, { timeout: 3000 })
  .then(() => ok(true, 'the floor knows it is out on the new floor'), (e) => ok(false, 'the floor knows it is out on the new floor', e.message));
await host([{ type: 'unbound', channel: 'lab2', agent: 'bo', cwd: '/repo/bo' }]);
await sleep(2500);
p = await panelOf(pop);
ok(!p.ended && p.composer, 'left: not said in the first moments (a move reads as left on its way)', JSON.stringify(p));
await pop.waitFor(`document.querySelector('#floor-panel')?.dataset.ended === 'left'`, { timeout: 8000 })
  .then(() => ok(true, 'left: the popout says so'), (e) => ok(false, 'left: the popout says so', e.message));
p = await panelOf(pop);
ok(p.agent === 'bo' && /left this desk/.test(p.why ?? '') && await pop.evalJs(`!!document.querySelector('[data-act="close-window"]')`),
  'under its own header, with a way to close — never blank, never another desk', JSON.stringify(p));
await pop.shot(`${shots}/popout-left.png`, null, { scale: 1 });
await pop.click('[data-act="close-window"]');
await sleep(600);
ok((await pops()).length === 0, 'Close this window closes it');

console.log('\na question form, in the popout (#7)');
await floor.evalJs(`localStorage.setItem('orch.floor', 'page-check'); 1`);
await floor.goto(base);
await floor.waitFor(`!!document.querySelector('#floor-rooms .desk[data-agent="typist"]')`, { timeout: 8000 });
await openOnFloor(floor, 'typist');
await floor.waitFor(`!!document.querySelector('#floor-panel .p-ask')`, { timeout: 5000 });
await floor.press('#floor-panel [data-act="detach"]');
const asker = await attach(isPop('typist'));
await asker.waitFor(`!!document.querySelector('#floor-panel .p-ask')`, { timeout: 8000 })
  .then(() => ok(true, 'the form is drawn in the popout'), (e) => ok(false, 'the form is drawn in the popout', e.message));
ok(await asker.evalJs(`document.querySelectorAll('#floor-panel .p-ask .p-tab').length === 3`), 'all three of its tabs');
await asker.click('#floor-panel [data-act="ask-submit"]');
ok(await asker.evalJs(`getComputedStyle(document.querySelector('.p-ask-warn')).display !== 'none'`), 'Submit with nothing answered shows the warning, there, and sends nothing');
for (const q of [0, 1, 2]) {
  await asker.evalJs(`(() => { const i = document.querySelector('.p-q[data-q="${q}"] input:not([data-other])'); i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
}
await asker.click('#floor-panel [data-act="ask-submit"]');
await asker.waitFor(`/sending your answers/.test(document.querySelector('#floor-panel .p-alert-slot')?.textContent ?? '')`, { timeout: 5000 })
  .then(() => ok(true, 'answered and submitted from the popout: the board took it'), (e) => ok(false, 'answered and submitted from the popout: the board took it', e.message));
ok(await floor.evalJs(`!!document.querySelector('#floor-panel [data-act="bring-back"]') && !document.querySelector('#floor-panel .p-ask')`),
  'and the floor\'s panel held no copy of the form while it was out');
await asker.click('[data-act="reattach"]');
await sleep(500);

console.log('\nseven windows: the floor and six popouts, all live');
await floor.evalJs(`localStorage.setItem('orch.floor', 'lab'); 1`);
await floor.goto(base);
await floor.waitFor(`!!document.querySelector('#floor-rooms .desk[data-agent="cy"]')`, { timeout: 8000 });
const six = ['cy', 'd1', 'd2', 'd3', 'd4', 'd5'];
const many = [];
for (const a of six) {
  await openOnFloor(floor, a);
  await floor.press('#floor-panel [data-act="detach"]');
  const w = await attach(isPop(a));
  await w.waitFor(`!!document.querySelector('#p-text')`, { timeout: 10000 });
  many.push([a, w]);
}
// The floor's own panel open on a desk that is in, so it wants a stream too.
await host([{ type: 'bound', channel: CH, agent: 'bo', cwd: '/repo/bo', from: { channel: 'lab2', agent: 'bo' } }]);
await floor.waitFor(`!!document.querySelector('#floor-rooms .desk[data-agent="bo"]')`, { timeout: 8000 });
await openOnFloor(floor, 'bo');
await floor.waitFor(`!!document.querySelector('#p-text')`);
await sleep(1500);
const timeFetch = (page) => page.evalJs(`(async () => { const t = performance.now(); const r = await fetch('./api/floor', { signal: AbortSignal.timeout(6000) }).catch(() => null); return r?.ok ? Math.round(performance.now() - t) : -1; })()`);
const times = [await timeFetch(floor), ...(await Promise.all(many.map(([, w]) => timeFetch(w))))];
ok(times.every((ms) => ms >= 0 && ms < 1000), `a fetch from every window answers: ${times.join(', ')} ms`);
const stamp = Date.now();
await host([...six, 'bo'].map((a) => ({ type: 'delivery', channel: CH, agent: a, state: 'queued', text: `held ${stamp} for ${a}` })));
const live = await Promise.all([...many, ['bo', floor]].map(([a, w]) =>
  w.waitFor(`[...document.querySelectorAll('#p-turns .t-pending')].some((n) => n.textContent.includes('held ${stamp} for ${a}'))`, { timeout: 4000 }).then(() => true, () => false)));
ok(live.every(Boolean), `every window's stream delivers: ${live.map((x, i) => `${[...six, 'bo'][i]}=${x ? 'yes' : 'NO'}`).join(' ')}`);
for (const [, w] of many) await closePop(w);

console.log('\nthe console');
{
  const said = [...floor.console(), ...many.flatMap(([, w]) => w.console())];
  ok(said.length === 0, `no warnings, errors or exceptions in the floor or the popouts${said.length ? `: ${said.slice(0, 3).join(' | ')}` : ''}`);
}

console.log(`\n${fails ? `${fails} ✗ · FAIL` : 'PASS'}`);
await floor.close();
process.exit(fails ? 1 : 0);

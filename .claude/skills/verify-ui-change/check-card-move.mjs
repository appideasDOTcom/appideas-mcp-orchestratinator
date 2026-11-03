#!/usr/bin/env node
/**
 * Drive issue #18 on the floor against the fixture seed-move.mjs builds:
 * Move to another floor on a desk's nameplate card, from both views, and
 * print what the page drew at every step. The route's assertions are in
 * test/floor.mjs ("move to another floor, from the nameplate card"); this is
 * the page, which only a browser can show. Measured 2026-11-03.
 *
 *   node --experimental-websocket .claude/skills/verify-ui-change/check-card-move.mjs http://localhost:8905 [out-dir] [work.jsonl]
 *
 * Steps, in order:
 *   1. All floors, one floor on the board (so not the building): the card on
 *      `ed` (no host) — the button disabled with Take a desk's no_host words
 *      under it, and a click on it opening nothing; and `cy`, whose host is
 *      gone, not drawn at all, so no card is ever open on it.
 *   2. The card on `ann`: the button live; the dialog — its floors, the
 *      sentence, the agent fixed.
 *   3. ann mid-turn: Move is refused in the dialog with Take a desk's words.
 *   4. A new floor by name, from all floors: the page lands on that floor
 *      with ann's panel open, and ann drawn there and nowhere else
 *      (Decided 3: from the all-floors view).
 *   5. From one floor, back to alpha (a floor on the board): lands on alpha
 *      (Decided 3: from one floor).
 * Every bind the page caused is read back out of the seed's work log: the
 * desk's own folder, the target floor, where from.
 */
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { open } from './drive.mjs';

const base = process.argv[2] ?? 'http://localhost:8905';
const out = process.argv[3] ?? tmpdir();
const WORK = process.argv[4] ?? null;
const KEY = process.env.ORCH_AUTH_TOKEN ?? 'k';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label) => { console.log(`  ${ok ? '✓' : '✗'} ${label}`); if (!ok) failures++; };
const events = (list) => fetch(`${base}/api/host/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestratinator-key': KEY }, body: JSON.stringify({ host_id: 'h1', events: list }) }).then((r) => r.json());
const binds = () => (WORK && existsSync(WORK) ? readFileSync(WORK, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((w) => w.kind === 'bind') : []);

// What the page shows: which floor it stands on, which desks each storey
// draws, the card's foot, the dialog, the panel.
const PROBE = `JSON.stringify({
  // Where the page stands: what setFloor wrote. Not the lit chip — with one
  // floor on the board the picker draws no chips at all, and a move that
  // empties the floor it left can leave exactly one.
  floor: localStorage.getItem('orch.floor') || null,
  chips: [...document.querySelectorAll('#floor-pick [data-floor]')].map((b) => b.dataset.floor),
  rooms: [...document.querySelectorAll('#floor-rooms svg.room')].map((r) => ({ ch: r.dataset.channel, collapsed: r.classList.contains('collapsed'), desks: [...r.querySelectorAll('.desk')].map((d) => d.dataset.agent) })),
  card: (() => { const p = document.getElementById('desk-pop'); if (!p) return null;
    return { head: p.querySelector('.dp-head strong')?.textContent, buttons: [...p.querySelectorAll('.dp-foot button')].map((b) => b.textContent + (b.disabled ? ' [disabled]' : '')), why: p.querySelector('.dp-move-why')?.textContent ?? null }; })(),
  dialog: (() => { const d = document.getElementById('dlg'); if (!d?.open) return null; const b = document.getElementById('dlg-body');
    return { title: b.querySelector('h3')?.textContent, sub: b.querySelector('.dlg-sub')?.textContent, floors: [...b.querySelectorAll('#move-to option')].map((o) => o.value + (o.selected ? '*' : '')), agent: b.querySelector('.desk-name output')?.textContent, note: b.querySelector('.dlg-note')?.textContent, go: (() => { const g = b.querySelector('[data-do="desk-move"]'); return g ? g.textContent + (g.disabled ? ' [disabled]' : '') : null; })(), err: (() => { const e = b.querySelector('.dlg-err'); return e && !e.hidden ? e.textContent : null; })() }; })(),
  panel: document.getElementById('floor-panel')?.dataset?.agent ?? null,
  panelChannel: document.getElementById('floor-panel')?.dataset?.channel ?? null,
})`;
const look = async (page, label) => { const r = JSON.parse(await page.evalJs(PROBE)); console.log(`\n## ${label}\n  ${JSON.stringify(r)}`); return r; };
const cardOn = async (page, agent) => {
  await page.click(`#floor-rooms .desk[data-agent="${agent}"] .plateHit`);
  await page.waitFor(`!!document.querySelector('#desk-pop [data-act="move-desk"]') && document.querySelector('#desk-pop .dp-head .mono')?.textContent?.endsWith('/${agent}')`);
};

const page = await open({ base, view: 'floor', floor: '' });
await page.resize(1400, 900);
await page.waitFor(`document.querySelectorAll('#floor-rooms svg.room').length === 1`);

// 1 — the button that cannot be pressed
let r = await look(page, 'all floors, one floor on the board');
check(r.rooms.length === 1 && !r.rooms[0].collapsed && r.floor === null, 'one storey, not collapsed, no floor chosen — the all-floors view a card can open in');
await cardOn(page, 'ed');
r = await look(page, 'the card on ed — live by its hooks, no host');
check(r.card?.buttons.includes('Move to another floor [disabled]'), 'Move to another floor is on the card, disabled');
check(r.card?.why === 'No host on this board is running this folder, so there is nobody to bind it.', 'with Take a desk\'s no_host words under it');
await page.shot(`${out}/move-card-disabled.png`, '#desk-pop', { scale: 2 });
await page.click('#desk-pop [data-act="move-desk"]');
await sleep(400);
r = await look(page, 'after clicking the disabled button');
check(!r.dialog, 'a click on it opens nothing');
await page.evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); document.getElementById('desk-pop')?.remove(); 'ok'`);
check(!r.rooms[0].desks.includes('cy'), 'cy, hosted on a host gone two days, is not drawn — a hosted desk is as live as its host — so no card opens on it');

// 2 — the button that can, and its dialog
await cardOn(page, 'ann');
r = await look(page, 'the card on ann — hosted on testbox');
check(r.card?.buttons.join(' | ') === 'Open conversation | Move to another floor | Hide desk', `beside Open conversation and Hide desk (Edit avatar is in the card's head) — ${r.card?.buttons.join(' | ')}`);
check(!r.card?.why, 'enabled, no reason drawn');
await page.shot(`${out}/move-card.png`, '#desk-pop', { scale: 2 });
await page.click('#desk-pop [data-act="move-desk"]');
await page.waitFor(`document.getElementById('dlg')?.open && !!document.getElementById('move-to')`);
r = await look(page, 'the dialog');
check(!r.card, 'the card closed on the click');
check(JSON.stringify(r.dialog?.floors) === JSON.stringify(['__new__*']), 'with alpha the only floor, the one choice is a new floor — the one it is on is not offered');
check(r.dialog?.agent === 'ann', 'the agent is fixed, read from the desk');
check(/a new conversation opens there/.test(r.dialog?.note ?? '') && /it opens on its last conversation/.test(r.dialog?.note ?? ''), 'the sentence says what happens to the conversation, both ways');
check(r.dialog?.go === 'Move to … [disabled]', 'and Move waits for a floor name');
await page.evalJs(`(() => { const i = document.getElementById('move-new-channel'); i.value = 'beta-new'; i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
r = await look(page, 'a new floor typed');
check(r.dialog?.go === 'Move to beta-new' && r.dialog?.title === 'Move Ann to beta-new', 'the button and the title name it as it is typed');
await page.shot(`${out}/move-dialog.png`, '#dlg', { scale: 2 });

// 3 — refused in Take a desk's words
await events([{ type: 'turn', channel: 'alpha', agent: 'ann', session_id: 's-ann', role: 'tool', text: 'Bash: make' }]);
await page.click('#dlg-body [data-do="desk-move"]');
await page.waitFor(`(() => { const e = document.querySelector('#dlg-body .dlg-err'); return e && !e.hidden && !!e.textContent; })()`);
r = await look(page, 'Move while ann is mid-turn');
check(r.dialog?.err === 'ann is working — its host says so, or its last turn is a tool call. This closes its window mid-turn. Wait for it to finish, or stop it first.', 'refused in the dialog with Take a desk\'s words, the form kept');
check(binds().length === 0, 'and nothing went to the host');
await page.shot(`${out}/move-refused.png`, '#dlg', { scale: 2 });
await events([{ type: 'turn', channel: 'alpha', agent: 'ann', session_id: 's-ann', role: 'assistant', text: 'done' }]);

// 4 — from all floors, to a new floor by name
await page.click('#dlg-body [data-do="desk-move"]');
await page.waitFor(`localStorage.getItem('orch.floor') === 'beta-new' && document.getElementById('floor-panel')?.dataset?.agent === 'ann'`, { timeout: 15000 });
await page.waitFor(`!!document.querySelector('#floor-rooms svg.room[data-channel="beta-new"] .desk[data-agent="ann"]')`, { timeout: 15000 });
r = await look(page, 'moved from all floors to a new floor');
check(r.floor === 'beta-new', 'the page stands on the floor the agent went to (Decided 3, from all floors)');
check(r.panel === 'ann', 'with ann\'s panel open');
check(JSON.stringify(r.rooms.map((x) => x.ch)) === '["beta-new"]' && r.rooms[0].desks.includes('ann'), 'ann drawn there');
let b = binds().at(-1);
check(b?.payload?.path === '/repo/ann' && b?.channel === 'beta-new' && b?.payload?.from?.channel === 'alpha' && !('resume' in (b?.payload ?? {})), `the host was handed the desk's own folder, the new floor, where from, and no resume — ${JSON.stringify(b?.payload)}`);
await page.shot(`${out}/move-landed-new-floor.png`, null, { full: true });
const fl = await fetch(`${base}/api/floor`).then((x) => x.json());
check(!fl.channels.find((c) => c.channel === 'alpha')?.desks.some((d) => d.agent === 'ann'), 'and not on alpha any more');

// 5 — from one floor, to a floor on the board
await cardOn(page, 'ann');
await page.click('#desk-pop [data-act="move-desk"]');
await page.waitFor(`document.getElementById('dlg')?.open && !!document.getElementById('move-to')`);
r = await look(page, 'the dialog on beta-new');
check(JSON.stringify(r.dialog?.floors) === JSON.stringify(['alpha*', '__new__']), 'a floor on the board is offered first, the new floor after — beta-new, where it is, is not');
await page.click('#dlg-body [data-do="desk-move"]');
await page.waitFor(`localStorage.getItem('orch.floor') === 'alpha' && document.getElementById('floor-panel')?.dataset?.agent === 'ann' && !!document.querySelector('#floor-rooms svg.room[data-channel="alpha"] .desk[data-agent="ann"]')`, { timeout: 15000 });
r = await look(page, 'moved from one floor back to alpha');
check(r.floor === 'alpha' && r.panel === 'ann', 'the page went with it (Decided 3, from one floor)');
b = binds().at(-1);
check(b?.channel === 'alpha' && b?.payload?.from?.channel === 'beta-new', 'the host was handed the move back');
await page.shot(`${out}/move-landed-alpha.png`, null, { full: true });

await page.close();
console.log(`\n${failures ? `FAIL — ${failures}` : 'PASS'} · shots in ${out}`);
process.exit(failures ? 1 : 0);

#!/usr/bin/env node
/**
 * What each window reports to the desktop app (costmo, 2026-11-19: tabs
 * pulse blue for nudges, amber for a prompt; the tray bell and the Dock
 * from the whole board; "nudge all" per window). The app's main process
 * reads `window.orchAttention` with executeJavaScript, so this drives
 * exactly that: get(), next(v), nudgeAll(), in a floor tab, another
 * floor's tab, a popout, a meeting room and a board-view tab.
 *
 *   run-check-attention.sh <dir>       # the whole fixture; see there
 *
 * On seed-select.mjs's floor and host: alpha has bo (four unread, a
 * window), ed (three unread, no host: the board refuses to nudge it), and
 * ann, cy, gil, di with nothing waiting; beta has fay. The rules are in
 * test/floor.mjs ("window attention"); this is the page.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { open } from './drive.mjs';

await import('../../../src/node-floor.js').catch((e) => { if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e; });
const REPO = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const Database = createRequire(`${REPO}/package.json`)('better-sqlite3');

const base = process.argv[2] ?? 'http://localhost:8949';
const DB = process.argv[4];
const WORK = process.argv[6];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
let total = 0;
const ok = (cond, msg, extra = '') => { total++; console.log(`  ${cond ? '✓' : '✗'} ${msg}${cond || !extra ? '' : `  (${extra})`}`); if (!cond) fails++; };
const stopped = (e) => { total++; fails++; console.log(`  ✗ the check stopped on: ${String(e?.message ?? e).split('\n')[0]}`); console.log(`\nFAIL · ${fails} of ${total} red`); process.exit(1); };
process.on('uncaughtException', stopped);
process.on('unhandledRejection', stopped);

const get = (p) => p.evalJs(`JSON.stringify(window.orchAttention?.get() ?? null)`).then(JSON.parse);
const strip = (r) => r && ({ nudges: r.nudges, asking: r.asking, board: r.board });
const until = (p, expr, what) => p.waitFor(expr, { timeout: 12000 })
  .catch(async () => { throw new Error(`${what} — not in 12 s; the window reports ${JSON.stringify(await get(p))}`); });
const work = () => readFileSync(WORK, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const nudgesTo = (agent) => work().filter((w) => w.kind === 'chat' && w.agent === agent && w.payload?.text === 'nudge').length;
const db = new Database(DB);
const KEY = { 'content-type': 'application/json', 'x-orchestratinator-key': 'k' };

console.log('\na floor tab and another floor\'s tab');
const alpha = await open({ base, view: 'floor', floor: 'alpha' });
await until(alpha, `window.orchAttention?.get().nudges === 1`, 'alpha reports bo');
let a = await get(alpha);
ok(JSON.stringify(strip(a)) === JSON.stringify({ nudges: 1, asking: false, board: { nudges: 1, asking: false } }),
  'alpha: one nudge waiting (bo; ed has mail but the board would refuse it), nothing asking; the board the same', JSON.stringify(a));
ok(typeof a.version === 'number', 'and the report carries a version', JSON.stringify(a));
const beta = await open({ base, view: 'floor', floor: 'beta' });
await until(beta, `window.orchAttention?.get().board.nudges === 1`, 'beta read the board');
let b = await get(beta);
ok(b.nudges === 0 && b.asking === false && b.board.nudges === 1, 'beta\'s tab: nothing on its own floor, bo in the board\'s count', JSON.stringify(b));

console.log('\nnext(v) answers on the next change, and only then');
await alpha.evalJs(`window.__next = null; window.orchAttention.next(${a.version}).then((r) => { window.__next = r; }); 1`);
await sleep(2500);
ok(await alpha.evalJs(`window.__next === null`), 'with nothing changed it has not answered after a poll');
db.prepare(`INSERT INTO messages (channel, from_agent, to_agent, body) VALUES ('beta', 'ann', 'fay', '"for fay"')`).run();
await until(alpha, `window.__next !== null`, 'next() answered the change');
const n = JSON.parse(await alpha.evalJs(`JSON.stringify(window.__next)`));
ok(n.version > a.version && n.nudges === 1 && n.board.nudges === 2, 'mail for fay on beta: alpha\'s next() answers with the board\'s count moved and its own unchanged', JSON.stringify(n));
const now = JSON.parse(await alpha.evalJs(`window.orchAttention.next(${a.version}).then((r) => JSON.stringify(r))`));
ok(now.version === n.version, 'and a next() behind the current version answers at once', JSON.stringify(now));

console.log('\na prompt on a desk is asking');
const ing = await fetch(`${base}/api/ingest`, { method: 'POST', headers: KEY, body: JSON.stringify({
  channel: 'alpha', agent: 'ann', session_id: 's-ann', cwd: '/repo/ann', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }) });
ok(ing.ok, 'the fixture: a permission prompt on ann', ing.status);
await until(alpha, `window.orchAttention.get().asking === true`, 'alpha reports ann asking');
a = await get(alpha);
await until(beta, `window.orchAttention.get().board.asking === true`, 'beta read the board');
b = await get(beta);
ok(a.asking === true && a.board.asking === true, 'alpha is asking, and so is the board', JSON.stringify(a));
ok(b.asking === false && b.board.asking === true, 'beta is not: the prompt is on another floor, which only the board\'s report carries', JSON.stringify(b));

console.log('\nnudge all, from a window');
const r1 = JSON.parse(await beta.evalJs(`window.orchAttention.nudgeAll().then((r) => JSON.stringify(r))`));
ok(JSON.stringify(r1) === JSON.stringify({ sent: [{ channel: 'beta', agent: 'fay' }], refused: [] }), 'beta\'s nudge all types into fay, its one desk with mail', JSON.stringify(r1));
await alpha.evalJs(`(() => {
  window.__rang = false;
  const look = () => { if (document.querySelector('.desk[data-channel="alpha"][data-agent="bo"] .bell.ringing')) window.__rang = true; };
  new MutationObserver(look).observe(document.getElementById('floor-rooms'), { subtree: true, attributes: true, childList: true });
  return 1;
})()`);
const same = await alpha.evalJs(`(() => { const x = window.orchAttention.nudgeAll(); const y = window.orchAttention.nudgeAll(); window.__all = null; x.then((r) => { window.__all = r; }); return x === y; })()`);
ok(same === true, 'a second press while the first is typing is the same nudge, not a second one');
await until(alpha, `window.__all !== null`, 'alpha\'s nudge all answered');
const r2 = JSON.parse(await alpha.evalJs(`JSON.stringify(window.__all)`));
ok(JSON.stringify(r2.sent) === JSON.stringify([{ channel: 'alpha', agent: 'bo' }]), 'alpha\'s types into bo', JSON.stringify(r2));
ok(await alpha.evalJs(`window.__rang === true`), 'and bo\'s bell rang on the floor, as the bell\'s own nudge does');
ok(r2.refused.length === 1 && r2.refused[0].agent === 'ed' && r2.refused[0].reason.length > 0, 'and says ed was not, in the board\'s words', JSON.stringify(r2.refused));
for (let i = 0; i < 40 && (nudgesTo('bo') < 1 || nudgesTo('fay') < 1); i++) await sleep(250);
ok(nudgesTo('bo') === 1 && nudgesTo('fay') === 1, 'the host was handed "nudge" once for bo and once for fay', JSON.stringify(work().map((w) => `${w.agent}:${w.payload?.text}`)));
ok(nudgesTo('ann') + nudgesTo('cy') + nudgesTo('gil') === 0, 'and nothing for desks with nothing waiting');

console.log('\na popout and a meeting room report their own desks, and the floor tab still counts them (costmo, 2026-11-19)');
const pop = await open({ base: `${base}/?popout=1&channel=alpha&agent=bo`, ready: `document.readyState === 'complete'` });
await until(pop, `window.orchAttention?.get().nudges === 1`, 'the popout reports bo');
const p = await get(pop);
ok(p.nudges === 1 && p.asking === false && p.board.nudges === 2, 'bo\'s popout: its one desk, and the board', JSON.stringify(p));
// The row below must read a floor tab that knows bo is out, not one that has
// not heard the popout's `here` yet (which would count bo either way). bo's
// panel on the floor offers "Bring chat back here" only once it has heard.
await alpha.evalJs(`window.floorOpenDesk('alpha', 'bo')`);
await until(alpha, `!!document.querySelector('[data-act="bring-back"][data-agent="bo"]')`, 'the floor tab knows bo is out in its popout');
a = await get(alpha);
ok(a.nudges === 1 && a.board.nudges === 2, 'the floor tab still counts bo, out in its popout, so the tab pulses for it; the board counts it once', JSON.stringify(a));
db.prepare(`INSERT INTO messages (channel, from_agent, to_agent, body) VALUES ('alpha', 'cy', 'gil', '"for gil"')`).run();
const room = await open({ base: `${base}/?meeting=new&channel=alpha&agents=ann,gil`, ready: `document.readyState === 'complete'` });
await until(room, `window.orchAttention?.get().asking === true && window.orchAttention.get().nudges === 1`, 'the room reports ann asking and gil waiting');
const m = await get(room);
ok(m.asking === true && m.nudges === 1, 'a meeting room with ann and gil: ann asking, gil\'s mail waiting', JSON.stringify(m));
await alpha.evalJs(`window.floorOpenDesk('alpha', 'ann')`);
await until(alpha, `/meeting room/.test(document.querySelector('[data-act="bring-back"][data-agent="ann"]')?.textContent ?? '')`, 'the floor tab knows ann is in the room');
a = await get(alpha);
ok(a.asking === true, 'and the floor tab is still asking for ann, who is in the room: the tab pulses amber for a prompt in a room', JSON.stringify(a));
// The To chips narrowed to ann: the app's nudge all is still every
// participant with something waiting, whatever the chips choose.
await room.press('#floor-panel [data-act="m-to"][data-agent="ann"]');
await until(room, `document.querySelector('#floor-panel [data-act="m-to"][data-agent="gil"]')?.getAttribute('aria-pressed') === 'false'`, 'the chips narrowed to ann');
const rm = JSON.parse(await room.evalJs(`window.orchAttention.nudgeAll().then((r) => JSON.stringify(r))`));
ok(JSON.stringify(rm.sent) === JSON.stringify([{ channel: 'alpha', agent: 'gil' }]), 'the room\'s nudge all types into gil, though the chips chose only ann', JSON.stringify(rm));
ok(rm.refused.length === 0, 'and nothing into ann, who has nothing waiting', JSON.stringify(rm.refused));
await until(room, `[...document.querySelectorAll('#floor-panel *')].some((e) => e.children.length === 0 && /^nudge$/.test(e.textContent.trim()))`, 'the room shows the nudge');
ok(true, 'the room\'s transcript records the nudge, as its own Nudge button does');
for (let i = 0; i < 40 && nudgesTo('gil') < 1; i++) await sleep(250);
ok(nudgesTo('gil') === 1, 'and the host was handed it for gil', JSON.stringify(work().map((w) => `${w.agent}:${w.payload?.text}`)));

console.log('\na tab on the board view');
const appBoard = await open({ base, view: 'floor', floor: 'alpha' });
await appBoard.beforeLoad(`Object.defineProperty(navigator, 'userAgent', { value: navigator.userAgent + ' Electron/45.2.3 OrchestratinatorDesktop/9.8.7', configurable: true })`);
await appBoard.goto(`${base}/?floor=beta&view=board`);
await until(appBoard, `!document.body.classList.contains('view-floor') && window.orchAttention.get().nudges === 1`, 'the app\'s board-view tab reports beta');
const ab = await get(appBoard);
const onFloorTab = (await get(alpha)).board;
ok(ab.nudges === 1 && JSON.stringify(ab.board) === JSON.stringify(onFloorTab), 'in the app, a board-view tab still reports its floor (fay), and the board as a floor tab reads it', JSON.stringify([ab, onFloorTab]));
const plain = await open({ base, view: 'floor', floor: 'alpha' });
await plain.goto(`${base}/?floor=beta&view=board`);
await sleep(3000);
const pb = await get(plain);
ok(pb.nudges === 0 && pb.board.nudges === 0, 'in a browser it polls nothing of the floor, as before, and so reports nothing', JSON.stringify(pb));

// The header's number (costmo, 2026-11-20): the app's own inside the app,
// this instance's in a browser. The app's page here says it is 9.8.7.
const boardVersion = JSON.parse(await (await fetch(`${base}/health`)).text()).version;
const headerOf = (page) => page.evalJs(`document.getElementById('version').textContent`);
ok(await headerOf(appBoard) === 'v9.8.7', 'in the app the header shows the app\'s version, not this instance\'s', `${await headerOf(appBoard)} (instance ${boardVersion})`);
ok(await headerOf(plain) === `v${boardVersion}`, 'in a browser it shows this instance\'s', await headerOf(plain));

const errs = [alpha, beta, pop, room, appBoard, plain].flatMap((x) => x.console()).filter((s) => /^error/.test(s) && !/Failed to load resource/.test(s));
ok(errs.length === 0, 'no errors in any window\'s console', errs.join(' | '));

console.log(fails ? `\nFAIL · ${fails} of ${total} red` : `\nPASS · ${total} of ${total}`);
process.exit(fails ? 1 : 0);

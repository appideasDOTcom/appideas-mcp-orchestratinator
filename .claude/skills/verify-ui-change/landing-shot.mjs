/*
 * The five landing-page captures, off the real page against landing-seed.mjs.
 *
 *   node --experimental-websocket .claude/skills/verify-ui-change/landing-shot.mjs [out-dir]
 *
 * Spec (appideas-designer, CAPTURE-SPEC.md, task #204): 1600x1000 CSS px at
 * device pixel ratio 2, PNG, dark theme, auto-refresh on, no browser chrome;
 * captures 1–4 read as one moment. Full-page where a view is taller than the
 * viewport (the building, the board), stated in the task rather than cropped.
 *
 * How the moment is frozen: the page polls /api/state, /api/floor and
 * /api/activity every 2–2.5 s and redraws the header's clock and `up` counter
 * from them. After the room has settled, `fetch` is wrapped so the FIRST
 * response to each of those paths is cached and every later call is answered
 * from the cache — the page keeps polling, auto-refresh stays on, and every
 * poll says the same thing. POSTs and the panel's own reads (/api/floor/turns)
 * pass through untouched, so clicking desks and striking a bell still work.
 * Captures 1–4 are taken in that one page session; 5 (the board) is a second
 * load, so its clock differs by the seconds between them.
 */
import { open } from './drive.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BASE = process.env.ORCH_SHOT_BASE ?? 'http://localhost:8906';
const OUT = process.argv[2] ?? join(REPO, 'docs', 'review', 'landing');
mkdirSync(OUT, { recursive: true });
const TT = 'trailtracker-mobile';

const FREEZE = `(() => {
  if (window.__frozen) return 'already';
  const real = window.fetch.bind(window);
  const cache = new Map();
  const key = (u) => String(u).replace(/[?#].*$/, '');
  const frozen = (u) => /\\/api\\/(state|floor|activity)$/.test(key(u));
  window.fetch = async (u, init) => {
    if (!frozen(u) || (init && init.method && init.method !== 'GET')) return real(u, init);
    const k = key(u);
    if (!cache.has(k)) {
      const r = await real(u, init);
      cache.set(k, { status: r.status, text: await r.text(), type: r.headers.get('content-type') ?? 'application/json' });
    }
    const c = cache.get(k);
    return new Response(c.text, { status: c.status, headers: { 'content-type': c.type } });
  };
  window.__frozen = true;
  return 'frozen';
})()`;

const page = await open({ base: BASE, view: 'floor', floor: TT });
await page.resize(1600, 1000, { dpr: 2 });

await page.waitFor(`document.querySelectorAll('#floor-rooms .room').length === 1`);
await page.waitFor(`document.querySelectorAll('#floor-rooms .desk').length === 6`);
await page.waitFor(`document.querySelector('.desk[data-agent="app-developer"] .needs')`);
await page.waitFor(`document.querySelector('.desk[data-agent="api-developer"].working .thought')`);

// The App Developer's panel, with its prompt drawn as the menu.
await page.click(`.desk[data-agent="app-developer"] .deskHit`);
await page.waitFor(`document.querySelector('#floor-panel')?.dataset.agent === 'app-developer'`);
await page.waitFor(`document.querySelector('#floor-panel [data-act="decide"][data-choice="allow"]')`);
await page.waitFor(`document.querySelector('#floor-panel [data-act="handback"]')`);

// Let the signs roll and the monitors type a line, then freeze the moment.
await page.evalJs(`new Promise(r => setTimeout(r, 2500))`);
console.log('freeze:', await page.evalJs(FREEZE));
await page.evalJs(`new Promise(r => setTimeout(r, 2600))`);   // one poll of each, cached

// A line typed in the reply box.
await page.evalJs(`(() => {
  const t = document.getElementById('p-text');
  t.value = "Approve it, and capture the iPad set in landscape as well.";
  t.dispatchEvent(new Event('input', { bubbles: true }));
  return t.value;
})()`);

// Strike the QA Engineer's bell and shoot inside its peal (1.33 s).
await page.click(`.desk[data-agent="qa-engineer"] .bell`);
await page.waitFor(`document.querySelector('.desk[data-agent="qa-engineer"] .bell.ringing')`, { timeout: 4000 });
await page.evalJs(`new Promise(r => setTimeout(r, 350))`);
await page.shot(join(OUT, '01-room-prompt.png'), null, { scale: 1 });
console.log('01 room+prompt');

// 3: one desk, cropped at the floor's own drawing, four times the CSS size.
await page.waitFor(`!document.querySelector('.desk[data-agent="qa-engineer"] .bell.ringing')`, { timeout: 4000 });
await page.shot(join(OUT, '03-desk.png'), `.desk[data-agent="app-developer"]`, { pad: 6, scale: 4 });
console.log('03 desk');

// 4: the API Developer's panel — four turns, the three doors, no prompt.
await page.evalJs(`(() => { const t = document.getElementById('p-text'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
await page.click(`.desk[data-agent="api-developer"] .deskHit`);
await page.waitFor(`document.querySelector('#floor-panel')?.dataset.agent === 'api-developer'`);
await page.waitFor(`document.querySelectorAll('#p-turns .turn, #p-turns [class*="t-"]').length > 0`);
await page.waitFor(`!document.querySelector('#floor-panel [data-act="decide"]')`);
await page.waitFor(`document.querySelector('#floor-panel [data-act="claude"]') && document.querySelector('#floor-panel [data-act="attach"]')`);
await page.evalJs(`new Promise(r => setTimeout(r, 600))`);
await page.shot(join(OUT, '04-panel-conversation.png'), null, { scale: 1 });
console.log('04 panel');

// 2: the building — all three floors, no panel, full page since it is taller than 1000.
await page.click(`#floor-panel [data-act="close-panel"]`);
await page.waitFor(`!document.querySelector('#floor-panel')?.dataset.agent || document.querySelector('#floor-panel').hidden || getComputedStyle(document.querySelector('#floor-panel')).display === 'none'`);
await page.click(`#floor-pick [data-floor=""]`);
await page.waitFor(`document.querySelectorAll('#floor-rooms .room').length === 3`);
await page.evalJs(`new Promise(r => setTimeout(r, 1200))`);
const size = await page.evalJs(`JSON.stringify({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })`);
console.log('building document size (CSS px):', size);
await page.shot(join(OUT, '02-building.png'), null, { full: true });
console.log('02 building');
await page.close();

// 5: the board, a second load.
const board = await open({ base: BASE, view: 'board' });
await board.resize(1600, 1000, { dpr: 2 });
await board.waitFor(`document.querySelectorAll('.channel').length === 3`);
await board.waitFor(`document.querySelectorAll('#activity tr, .activity tr, [data-kind]').length > 3`, { timeout: 8000 }).catch(() => {});
await board.evalJs(`new Promise(r => setTimeout(r, 2500))`);
console.log('freeze:', await board.evalJs(FREEZE));
await board.evalJs(`new Promise(r => setTimeout(r, 2800))`);
const bsize = await board.evalJs(`JSON.stringify({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })`);
console.log('board document size (CSS px):', bsize);
await board.shot(join(OUT, '05-board-activity.png'), null, { full: true });
console.log('05 board');
await board.close();
console.log('wrote', OUT);

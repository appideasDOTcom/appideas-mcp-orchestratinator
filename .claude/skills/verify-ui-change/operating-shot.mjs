/*
 * The five images docs/operating.md uses, off the real page against the
 * README fixture (landing-seed.mjs), each cropped to one element at device
 * pixel ratio 2:
 *
 *   board-offline.png   the board's ledgerino-desktop card: nobody there
 *   board-card.png      the board's bookinator-wp card: a live team
 *   board-activity.png  the board's activity log
 *   floor-desk.png      the App Developer's desk, needing a human
 *   floor-panel.png     the App Developer's panel, its permission prompt up
 *
 *   node --experimental-websocket .claude/skills/verify-ui-change/operating-shot.mjs [out-dir]
 *
 * Normally run by shoot-readme.sh, after landing-shot and readme-shot, on
 * the same seed. The board is frozen the way landing-shot freezes it (the
 * first answer to each poll is replayed), so the ages in a card do not tick
 * between the poll and the capture.
 */
import { open } from './drive.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BASE = process.env.ORCH_SHOT_BASE ?? 'http://localhost:8906';
const OUT = process.argv[2] ?? join(REPO, 'docs', 'images');
mkdirSync(OUT, { recursive: true });
const TT = 'trailtracker-mobile';
const pause = (page, ms) => page.evalJs(`new Promise(r => setTimeout(r, ${ms}))`);

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

/**
 * Tag the board card for a channel so shot() can name it (cards carry no
 * channel attribute), and let it take its own height: the grid stretches a
 * card to the tallest in its row, and TrailTracker's six agents left both of
 * these two-thirds empty. Nothing inside the card changes.
 */
const tagCard = (page, channel, id) => page.evalJs(`(() => {
  const c = [...document.querySelectorAll('.channel')].find((n) => n.querySelector('.channel-name')?.textContent === ${JSON.stringify(channel)});
  if (!c) throw new Error('no board card for ${channel}');
  c.id = ${JSON.stringify(id)};
  c.style.alignSelf = 'start';
  return 1;
})()`);

/* ---------- the board ---------- */

const board = await open({ base: BASE, view: 'board' });
await board.resize(1600, 1000, { dpr: 2 });
await board.waitFor(`document.querySelectorAll('.channel').length === 3`);
await pause(board, 2500);
await board.evalJs(FREEZE);
await pause(board, 2800);
await tagCard(board, 'ledgerino-desktop', 'shot-offline');
await tagCard(board, 'bookinator-wp', 'shot-live');
await board.shot(join(OUT, 'board-offline.png'), '#shot-offline', { pad: 0, scale: 1 });
await board.shot(join(OUT, 'board-card.png'), '#shot-live', { pad: 0, scale: 1 });
// The log starts near the bottom of a 1000-px window and runs past it, and a
// plain element crop paints only inside the window: the first cut had four
// rows of twelve over dark ground. `beyond` crops in page coordinates and
// paints past the window. (Lifting #log-scroll's cap, resizing the window
// and scrolling the table into view were each tried first and did not fix
// it; twelve rows were in the DOM all along.)
await board.shot(join(OUT, 'board-activity.png'), '.panel-log table', { pad: 0, scale: 1, beyond: true });
console.log('board: offline, card, activity');
await board.close();

/* ---------- the floor ---------- */

const floor = await open({ base: BASE, view: 'floor', floor: TT });
await floor.resize(1600, 1000, { dpr: 2 });
await floor.waitFor(`document.querySelector('.desk[data-agent="app-developer"] .needs')`);
await floor.click(`.desk[data-agent="app-developer"] .deskHit`);
await floor.waitFor(`document.querySelector('#floor-panel')?.dataset.agent === 'app-developer'`);
await floor.waitFor(`!!document.querySelector('#floor-panel [data-act="decide"][data-choice="allow"]')`);
await pause(floor, 2500);
await floor.evalJs(FREEZE);
await pause(floor, 2600);
await floor.shot(join(OUT, 'floor-desk.png'), `.desk[data-agent="app-developer"]`, { pad: 6, scale: 1 });
await floor.shot(join(OUT, 'floor-panel.png'), '#floor-panel', { pad: 0, scale: 1 });
console.log('floor: desk, panel');
await floor.close();
console.log('wrote', OUT);

/*
 * The README's two newest images, off the real page against the README
 * fixture: a meeting room (docs/images/meeting-room.png) and chats popped
 * out beside the floor (docs/images/popouts.png). The other three README
 * images are landing-shot.mjs's 02, 01 and 05 under the README's names.
 *
 *   PORT=8906 DB_PATH=./data/landing.db ORCH_AUTH_TOKEN=k node src/server.js &
 *   node .claude/skills/verify-ui-change/landing-seed.mjs &
 *   node .claude/skills/verify-ui-change/landing-host.mjs &     # the desks answer the room
 *   node --experimental-websocket .claude/skills/verify-ui-change/readme-shot.mjs [out-dir]
 *
 * Run it on a fresh seed: the room's transcript starts when the room opens,
 * but a second run would find the first run's room in Recent and its
 * messages in the desks' turns.
 *
 * Both windows are opened with press() — real input — because the browser
 * blocks window.open without a user gesture (drive.mjs, attach()).
 *
 * popouts.png is a composite, and that is the honest way to show it: a
 * popout is a window of its own, so no single page capture holds the floor
 * and two popouts. Each window is captured on its own, at DPR 2, and the
 * three are laid side by side on a plain backdrop by compose(), drawn in the
 * same headless browser — no image library. Nothing in any window is
 * retouched.
 */
import { open, attach } from './drive.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BASE = process.env.ORCH_SHOT_BASE ?? 'http://localhost:8906';
const OUT = process.argv[2] ?? join(REPO, 'docs', 'images');
mkdirSync(OUT, { recursive: true });
const TMP = mkdtempSync(join(tmpdir(), 'readme-shot-'));   // the composite's parts, kept out of the repo
const TT = 'trailtracker-mobile';
const pause = (page, ms) => page.evalJs(`new Promise(r => setTimeout(r, ${ms}))`);

const floor = await open({ base: BASE, view: 'floor', floor: TT });
await floor.resize(1600, 1000, { dpr: 2 });
await floor.waitFor(`document.querySelectorAll('#floor-rooms .desk').length === 6`);
await floor.waitFor(`document.querySelector('.desk[data-agent="api-developer"].working .thought')`);

/* ---------- meeting-room.png ---------- */

// The App Developer is asking a permission question, and a desk that is
// asking takes no message (askingWhy), so the room is the three who can talk.
const ROOM = ['project-manager', 'api-developer', 'qa-engineer'];
await floor.click(`svg.room[data-channel="${TT}"] [data-act="select-room"]`);
await floor.waitFor(`!!document.querySelector('svg.room.selecting')`);
for (const a of ROOM) { await floor.click(`svg.room.selecting .desk[data-agent="${a}"] .deskHit`); await pause(floor, 200); }
await floor.waitFor(`document.querySelector('svg.room.selecting [data-act="sel-meeting"]')?.getAttribute('aria-disabled') === 'false'`);
await floor.press('svg.room.selecting [data-act="sel-meeting"]');
const room = await attach((u) => /[?&]meeting=/.test(u));
// Short enough that the transcript is not mostly empty below four replies.
await room.resize(1100, 800, { dpr: 2 });
await room.waitFor(`document.querySelectorAll('.m-part').length === 3`, { timeout: 12000 });

const say = async (words) => {
  await room.evalJs(`(() => { const t = document.getElementById('p-text'); t.focus(); t.value = ${JSON.stringify(words)};
    t.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await room.key('Enter');
};
const replies = () => `document.querySelectorAll('#p-turns .t-assistant').length`;

await say('RC 2.0 goes to App Review on Thursday. Anything blocking on your side?');
await room.waitFor(`${replies()} >= 3`, { timeout: 15000 });
await say('@qa-engineer start the regression on the 2.0 RC as soon as it is tagged.');
await room.waitFor(`${replies()} >= 4`, { timeout: 15000 });
await room.waitFor(`![...document.querySelectorAll('#p-turns .m-deliv')].some(n => /sending|queued/i.test(n.textContent))`, { timeout: 8000 });
await pause(room, 1200);
await room.shot(join(OUT, 'meeting-room.png'), null, { scale: 1 });
console.log('meeting-room', await room.evalJs(`JSON.stringify([...document.querySelectorAll('#p-turns .m-msg .m-deliv')].map(n => n.textContent))`));
// The landing page's sixth capture is the same moment in a narrow window:
// the page shows it in a 514 CSS px slot, and the README's 1100-wide room
// shrunk to that puts its text near 6 px (appideas-designer, msg 3022). So
// about 560 wide: the narrowest from 560 at which "Nudge everyone · 1 unread"
// stays on one line. Below that it wraps and spills under the room's edge,
// which is a page fault, not something to photograph. Then the shortest
// height at which the transcript needs no scrolling.
const oneLine = `(() => { const n = document.querySelector('[data-act="m-nudge-all"]'), s = document.querySelector('#p-send, [data-act="send"]') ?? n;
  return n.getBoundingClientRect().height <= s.getBoundingClientRect().height + 1 && n.scrollHeight <= n.clientHeight + 1; })()`;
let roomW = 560;
for (; roomW <= 760; roomW += 10) {
  await room.resize(roomW, 1000, { dpr: 2 });
  await pause(room, 200);
  if (await room.evalJs(oneLine)) break;
}
let roomH = 600;
for (; roomH <= 2400; roomH += 10) {
  await room.resize(roomW, roomH, { dpr: 2 });
  await pause(room, 150);
  if (await room.evalJs(`(() => { const t = document.querySelector('#p-turns'); return t.scrollHeight <= t.clientHeight + 1; })()`)) break;
}
await pause(room, 600);
await room.shot(join(OUT, '06-meeting-room.png'), null, { scale: 1 });
console.log(`06-meeting-room at ${roomW}x${roomH}`);

// End the room so its desks come back to the floor for the next shot.
await room.click('[data-act="meeting-end"]').catch(() => {});
await room.close().catch(() => {});
await pause(floor, 2500);
await floor.click(`svg.room[data-channel="${TT}"] [data-act="select-room"]`).catch(() => {});
await floor.waitFor(`!document.querySelector('svg.room.selecting')`);
await pause(floor, 800);

/* ---------- popouts.png ---------- */

// The floor narrower than a capture's 1600, so it and two popouts make one
// picture a README can show; the floor keeps its own panel open on the App
// Developer's permission prompt, so all three places a chat can be are in it.
// 520, wider than the page's own 440 (POP_W in src/ui/floor.js), so the chat
// reads at the size a README shows it; a popout is a window the operator
// sizes. (Its header's "Re-attach" wraps at either width: that is the button.)
const FLOOR_W = 1320, POP_W = 520, H = 1000;
await floor.resize(FLOOR_W, H, { dpr: 2 });
const popOut = async (agent) => {
  await floor.click(`.desk[data-agent="${agent}"] .deskHit`);
  await floor.waitFor(`document.querySelector('#floor-panel')?.dataset.agent === ${JSON.stringify(agent)}`);
  await floor.waitFor(`!!document.querySelector('#floor-panel [data-act="detach"]')`);
  await floor.press('#floor-panel [data-act="detach"]');
  const p = await attach((u) => u.includes('popout=1') && u.includes(`agent=${agent}`));
  await p.resize(POP_W, H, { dpr: 2 });
  await p.waitFor(`document.querySelectorAll('#p-turns .turn, #p-turns [class*="t-"]').length > 0`, { timeout: 12000 });
  return p;
};
const pops = [await popOut('api-developer'), await popOut('project-manager')];
await floor.click(`.desk[data-agent="app-developer"] .deskHit`);
await floor.waitFor(`document.querySelector('#floor-panel')?.dataset.agent === 'app-developer'`);
await floor.waitFor(`!!document.querySelector('#floor-panel [data-act="decide"][data-choice="allow"]')`);
await pause(floor, 1500);
for (const p of pops) await pause(p, 300);

const parts = [
  { file: join(TMP, 'floor.png'), page: floor, w: FLOOR_W },
  ...pops.map((page, i) => ({ file: join(TMP, `pop-${i}.png`), page, w: POP_W })),
];
for (const p of parts) await p.page.shot(p.file, null, { scale: 1 });
await compose(parts, join(OUT, 'popouts.png'));
console.log('popouts');
for (const p of pops) await p.close().catch(() => {});

/** The windows side by side on a plain backdrop, at the captures' own pixels. */
async function compose(list, out) {
  const GAP = 24, EDGE = 24;
  const width = list.reduce((s, p) => s + p.w, 0) + GAP * (list.length - 1) + EDGE * 2;
  const height = H + EDGE * 2;
  const look = 'border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.55)';
  const imgs = list.map((p) => `<img src="data:image/png;base64,${readFileSync(p.file).toString('base64')}" style="${look};width:${p.w}px;height:${H}px">`).join('');
  const html = join(TMP, 'compose.html');
  writeFileSync(html, `<!doctype html><html><body style="margin:0;background:#0b0d10">
    <div style="display:flex;gap:${GAP}px;padding:${EDGE}px">${imgs}</div></body></html>`);
  const c = await open({ base: `file://${html}` });
  await c.resize(width, height, { dpr: 2 });
  await c.waitFor(`[...document.images].every(i => i.complete && i.naturalWidth > 0)`);
  await c.shot(out, null, { scale: 1 });
  await c.close();
}

console.log('wrote', OUT);
process.exit(0);

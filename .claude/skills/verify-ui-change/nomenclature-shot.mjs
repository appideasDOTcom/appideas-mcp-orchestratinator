// The labelled nomenclature shot, off the real page.
import { open } from './drive.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/* Everything is derived from this file's own location so the script survives
   being moved, and so it never again lives only in a session scratchpad —
   which is exactly where the previous version of this pipeline was when it
   was lost, costing a rebuild from scratch. */
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BASE = process.env.ORCH_SHOT_BASE ?? 'http://localhost:8907';

const OUT = process.argv[2] ?? join(REPO, 'docs', 'floor-nomenclature.png');
const HERE = dirname(fileURLToPath(import.meta.url));

const page = await open({ base: BASE, view: 'floor', floor: 'trailtracker-mobile' });

/* State the width this picture needs rather than inheriting whatever the
   browser happened to be launched with. At 1500 the legend runs off the page
   and the overlay reports `legendFits: false` — which is the check below. */
await page.resize(1900, 1150);

await page.waitFor(`document.querySelectorAll('#floor-rooms .room').length === 1`);
await page.waitFor(`document.querySelectorAll('#floor-rooms .desk').length === 4`);
// The bubble and the sign are drawn from the payload, so they exist as soon as
// the room does; the thought trail only exists on a desk the server calls
// working. Waiting on the trail waits on the fixture, not on a timer.
await page.waitFor(`document.querySelector('.desk[data-agent="app-developer"].working .thought')`);
await page.waitFor(`document.querySelector('.desk[data-agent="designer"] .needs')`);

// Let the sign's first roll finish and the monitor type a line or two.
await page.evalJs(`new Promise(r => setTimeout(r, 1800))`);

/* Freeze the page before measuring. Rooms are rebuilt wholesale on any poll that
   changes anything, and a rebuild between measuring a rect and drawing on it is
   an overlay pointing at where a desk used to be. */
await page.evalJs(`(() => { window.fetch = () => new Promise(() => {}); return 'frozen'; })()`);

const report = await page.probe(`${HERE}/nomenclature-overlay.js`);
console.log(report);
if (JSON.parse(report).legendFits !== true) {
  throw new Error('the legend does not fit the page — widen the viewport above; refusing to write a cropped reference image');
}

await page.shot(OUT, '#nomen-frame', { pad: 0, scale: 2 });
await page.close();
console.log('wrote', OUT);

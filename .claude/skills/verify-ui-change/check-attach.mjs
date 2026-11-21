#!/usr/bin/env node
/**
 * Attach files to a message on a seeded desk (seed-desk.mjs) and read what
 * the page drew at each step — issue #31, 0.12.10.
 *
 *   node --experimental-websocket .claude/skills/verify-ui-change/check-attach.mjs http://localhost:8905 [out-dir] [channel] [agent] [key] [seed-host-id] [db]
 *
 * The three ways in, each through the page's own handler: a paste of a
 * screenshot into the box, a drop onto the panel, and the picker's input
 * (the native dialog itself is the browser's and is not driven). Then: a
 * thumbnail drawn from the file, the preview on a real hover, a remove by a
 * real press, a paste of words with a picture beside them taking nothing,
 * Send carrying the ids (read off the host's work queue, the host's door),
 * the pending bubble with the files, the recorded turn drawn as words and
 * files with no path list, an error turn handing the files back above the
 * box, the send row still on the panel with chips standing, and the
 * paperclip dimmed with why on a host from before attachments.
 *
 * Every row carries a verdict (✓ / ✗, then PASS or FAIL) so a page mutant
 * can be read off it.
 */
import { open } from './drive.mjs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const base = process.argv[2] ?? 'http://localhost:8905';
const out = process.argv[3] ?? tmpdir();
const CH = process.argv[4] ?? 'lab';
const AG = process.argv[5] ?? 'bo';
const KEY = process.argv[6] ?? 'k';
const HOSTID = process.argv[7] ?? 'h1';
const DB = process.argv[8] ?? null;
const SID = `sess-${AG}`;
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

let bad = 0;
const ok = (cond, label, seen) => { console.log(`  ${cond ? '✓' : '✗'} ${label}${!cond && seen !== undefined ? `  (saw ${JSON.stringify(seen)})` : ''}`); if (!cond) bad++; };
const stopped = (e) => { bad++; console.log(`  ✗ the check stopped on: ${String(e?.message ?? e).split('\n')[0]}`); console.log(`FAIL · ${bad} of the attachment checks`); process.exit(1); };
process.on('uncaughtException', stopped);
process.on('unhandledRejection', stopped);

const hostEvents = (events) => fetch(`${base}/api/host/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestratinator-key': KEY }, body: JSON.stringify({ host_id: HOSTID, events }) }).then((r) => r.json());
const work = () => fetch(`${base}/api/host/work?host_id=${HOSTID}`, { headers: { 'x-orchestratinator-key': KEY } }).then((r) => r.json()).then((b) => b.work ?? []);

// The fixture, read before anything is believed (the skill's "fallback that
// happens to match the fixture"): the desk names its host, and that host
// says it fetches attachments.
const fl = await (await fetch(`${base}/api/floor`)).json();
const desk = fl.channels.find((c) => c.channel === CH)?.desks.find((d) => d.agent === AG);
console.log(`== fixture: hosted.host_id ${desk?.hosted?.host_id} · hosts[].uploads ${fl.hosts?.find((h) => h.host_id === desk?.hosted?.host_id)?.uploads}`);
ok(desk?.hosted?.host_id === HOSTID && fl.hosts?.find((h) => h.host_id === HOSTID)?.uploads === true, 'the fixture: a desk whose host fetches attachments');
await work(); // whatever the seed queued is not this check's

const page = await open({ base, view: 'floor' });
await page.resize(1500, 1000);
await page.evalJs(`window.floorOpenDesk(${JSON.stringify(CH)}, ${JSON.stringify(AG)})`);
await page.waitFor(`document.querySelector('#floor-panel')?.dataset.agent === ${JSON.stringify(AG)}`);
await page.waitFor(`!document.querySelector('#floor-panel [data-act="attach-file"]')?.disabled`, { timeout: 8000 }).catch(() => {});
const clip = await page.evalJs(`(() => { const b = document.querySelector('#floor-panel [data-act="attach-file"]'); return b ? { disabled: b.disabled, title: b.title } : null; })()`);
ok(clip && !clip.disabled && /Attach files/.test(clip.title), 'the paperclip stands beside the box, live, and says what it takes', clip);

// Files made in the page: a real PNG from a canvas, a text file, a PDF's bytes.
await page.evalJs(`(async () => {
  const c = document.createElement('canvas'); c.width = 240; c.height = 140;
  const g = c.getContext('2d'); g.fillStyle = '#c33'; g.fillRect(0, 0, 240, 140); g.fillStyle = '#fff'; g.fillRect(20, 20, 80, 40);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  window.__f = {
    png: new File([blob], 'screenshot 1.png', { type: 'image/png' }),
    txt: new File(['line one\\nline two\\n'], 'build.log', { type: 'text/plain' }),
    pdf: new File(['%PDF-1.4\\n%fake\\n'], 'spec.pdf', { type: 'application/pdf' }),
    pic: new File([blob], 'image.png', { type: 'image/png' }),
  };
  window.__dt = (...fs) => { const d = new DataTransfer(); for (const f of fs) d.items.add(f); return d; };
  return 'ok';
})()`);
const chips = () => page.evalJs(`[...document.querySelectorAll('#floor-panel .p-attach .att-chip')].map((c) => ({ name: c.querySelector('.att-name')?.textContent, state: c.className.replace('att-chip', '').trim(), kind: c.dataset.kind, thumb: c.querySelector('img.att-thumb')?.naturalWidth ?? null, label: c.querySelector('.att-generic')?.textContent ?? null }))`);

// 1. A paste of a screenshot.
await page.evalJs(`(() => { const ta = document.querySelector('#p-text'); ta.focus(); const d = window.__dt(window.__f.png); ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true })); return 1; })()`);
await page.waitFor(`document.querySelector('#floor-panel .att-chip.ready')`, { timeout: 8000 }).catch(() => {});
await page.waitFor(`document.querySelector('#floor-panel .att-chip img.att-thumb')?.naturalWidth > 0`, { timeout: 4000 }).catch(() => {});
let c = await chips();
console.log('== after the paste:', JSON.stringify(c));
ok(c.length === 1 && c[0].name === 'screenshot 1.png' && c[0].state === 'ready' && c[0].thumb === 240, 'a pasted screenshot is a chip above the box, its own thumbnail drawn, uploaded and ready', c);
const placed = await page.evalJs(`(() => { const a = document.querySelector('#floor-panel .p-attach').getBoundingClientRect(); const t = document.querySelector('#p-text').getBoundingClientRect(); return { chipsBottom: a.bottom, boxTop: t.top }; })()`);
ok(placed.chipsBottom <= placed.boxTop + 0.5, 'the chips stand above the box', placed);

// 2. A drop onto the panel's transcript, not the box itself.
await page.evalJs(`(() => { const el = document.querySelector('#p-turns'); const d = window.__dt(window.__f.txt); el.dispatchEvent(new DragEvent('dragover', { dataTransfer: d, bubbles: true, cancelable: true })); el.dispatchEvent(new DragEvent('drop', { dataTransfer: d, bubbles: true, cancelable: true })); return 1; })()`);
// 3. The picker's input.
await page.evalJs(`(() => { const i = document.querySelector('#floor-panel .p-file'); i.files = window.__dt(window.__f.pdf).files; i.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
await page.waitFor(`document.querySelectorAll('#floor-panel .att-chip.ready').length === 3`, { timeout: 8000 }).catch(() => {});
c = await chips();
console.log('== after a drop and the picker:', JSON.stringify(c));
ok(c.length === 3 && c.every((x) => x.state === 'ready'), 'a file dropped on the panel and one from the picker join it, each uploaded', c);
ok(c[1]?.label === 'LOG' && c[2]?.label === 'PDF' && c[1].thumb === null, 'a file the browser cannot draw is its extension, not a broken image', c);

// 4. The preview on a real hover.
const pv = await page.hover('#floor-panel .att-chip[data-kind="image"]', { held: () => page.evalJs(`(() => {
  const p = document.getElementById('att-preview'); if (!p) return null;
  const r = p.getBoundingClientRect(); const img = p.querySelector('img');
  return { on: p.classList.contains('on'), w: r.width, h: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right, vw: innerWidth, vh: innerHeight, nat: img.naturalWidth, cap: p.querySelector('.att-pcap').textContent };
})()`) });
console.log('== hovering the thumbnail:', JSON.stringify(pv));
ok(pv?.on && pv.nat === 240 && pv.w > 100 && pv.h > 60, 'hovering the thumbnail shows it larger, the same picture', pv);
ok(pv && pv.top >= 0 && pv.left >= 0 && pv.right <= pv.vw && pv.bottom <= pv.vh, 'wholly on the screen', pv);
await page.shot(`${out}/attach-hover.png`, null, { full: true });
await page.hover('#p-text');
ok(!(await page.evalJs(`document.getElementById('att-preview')?.classList.contains('on') ?? false`)), 'and gone when the pointer leaves');

// 5. Remove one by a real press on its ✕; the board is told.
const discards = `performance.getEntriesByType('resource').filter((e) => e.name.endsWith('/api/floor/upload/discard')).length`;
const d0 = await page.evalJs(discards);
await page.press('#floor-panel .att-chip:nth-child(2) .att-x');
await page.waitFor(`document.querySelectorAll('#floor-panel .att-chip').length === 2`, { timeout: 4000 }).catch(() => {});
await page.waitFor(`${discards} > ${d0}`, { timeout: 4000 }).catch(() => {});
c = await chips();
ok(c.map((x) => x.name).join() === 'screenshot 1.png,spec.pdf', 'its ✕ takes one out of the box', c);
ok(await page.evalJs(`${discards} > ${d0}`), 'and discards it from the board at once');

// 6. Words with a picture beside them: the words are what was meant.
await page.evalJs(`(() => { const ta = document.querySelector('#p-text'); const d = window.__dt(window.__f.pic); d.setData('text/plain', 'Q3 total\\t4,210'); ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true })); return 1; })()`);
await new Promise((r) => setTimeout(r, 400));
ok((await chips()).length === 2, 'a paste of words with a picture beside them attaches nothing');

// 7. Send: words and files. Read what the host is handed, at the host's door.
await page.evalJs(`(() => { const ta = document.querySelector('#p-text'); ta.value = 'look at these'; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return 1; })()`);
await page.waitFor(`document.querySelectorAll('#p-turns .t-pending').length === 1`, { timeout: 8000 }).catch(() => {});
const w = await work();
const pay = w.find((x) => x.kind === 'chat')?.payload;
console.log('== the host is handed:', JSON.stringify(pay));
ok(pay?.text === 'look at these' && pay.files?.map((f) => f.name).join() === 'screenshot 1.png,spec.pdf', 'Send hands the host the words and both files, in order', pay);
const pend = await page.evalJs(`(() => { const p = document.querySelector('#p-turns .t-pending'); return p ? { body: p.querySelector('.t-body')?.textContent, files: [...p.querySelectorAll('.t-file')].map((f) => f.textContent.trim()) } : null; })()`);
ok(pend?.body === 'look at these' && pend.files.length === 2 && pend.files[0].endsWith('screenshot 1.png'), 'the pending bubble shows the words and the files', pend);
ok((await chips()).length === 0 && (await page.evalJs(`document.querySelector('#floor-panel .p-attach').classList.contains('hidden')`)), 'and the box is empty of them');

// 8. The window records it: the host's list under the words.
const paths = pay.files.map((f) => `/Users/someone/.orchestratinator/uploads/${f.id}/${f.name}`);
await hostEvents([{ type: 'turn', channel: CH, agent: AG, session_id: SID, role: 'user', at: new Date().toISOString(), uuid: 'att-u1',
  text: `look at these\n\nAttached by the operator:\n${paths.map((p) => `- ${p}`).join('\n')}` }]);
await page.waitFor(`document.querySelectorAll('#p-turns .t-pending').length === 0`, { timeout: 8000 }).catch(() => {});
const rec = await page.evalJs(`(() => { const t = [...document.querySelectorAll('#p-turns .t-user')].pop(); return t ? { pending: t.classList.contains('t-pending'), body: t.querySelector('.t-body')?.textContent, files: [...t.querySelectorAll('.t-file')].map((f) => ({ name: f.textContent.trim(), title: f.title })), text: t.textContent } : null; })()`);
console.log('== the recorded turn:', JSON.stringify(rec));
ok(rec && !rec.pending && rec.body === 'look at these', 'the recorded message retires the pending one and reads as the words', rec);
ok(rec?.files.length === 2 && rec.files[1].title === paths[1] && !/Attached by the operator/.test(rec.text), 'with the files drawn as files, the path on hover, and no list of paths in the words', rec);
await page.shot(`${out}/attach-recorded.png`, '#floor-panel');

// 9. Files alone, and the window losing them: an error turn hands them back.
await page.evalJs(`(() => { const i = document.querySelector('#floor-panel .p-file'); i.files = window.__dt(window.__f.png).files; i.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
await page.waitFor(`document.querySelector('#floor-panel .att-chip.ready')`, { timeout: 8000 }).catch(() => {});
await page.press('#floor-panel [data-act="send"]');
await page.waitFor(`document.querySelectorAll('#p-turns .t-pending').length === 1`, { timeout: 8000 }).catch(() => {});
const alone = (await work()).find((x) => x.kind === 'chat')?.payload;
ok(alone?.text === '' && alone.files?.length === 1, 'files alone are sent, from the Send button', alone);
await hostEvents([{ type: 'turn', channel: CH, agent: AG, session_id: SID, role: 'error', at: new Date().toISOString(), uuid: 'att-e1', text: 'not sent — the board would not give screenshot 1.png: no such upload' }]);
await page.waitFor(`document.querySelectorAll('#floor-panel .att-chip').length === 1`, { timeout: 8000 }).catch(() => {});
await page.waitFor(`document.querySelector('#floor-panel .att-chip img.att-thumb')?.naturalWidth > 0`, { timeout: 4000 }).catch(() => {});
c = await chips();
ok(c.length === 1 && c[0].state === 'ready' && c[0].thumb === 240, 'an error turn hands the files back above the box, thumbnail and all', c);

// 10. The send row stays on the panel with chips standing (the box's room),
// and the chips cost the panel one row however many there are: the window's
// foot stays where it was without them.
const foot = () => page.evalJs(`(() => { const p = document.querySelector('#floor-panel').getBoundingClientRect(); const s = document.querySelector('#floor-panel [data-act="send"]').getBoundingClientRect(); const a = document.querySelector('#floor-panel .p-attach').getBoundingClientRect(); return { panelBottom: Math.round(p.bottom), sendBottom: Math.round(s.bottom), chipsH: Math.round(a.height), vh: innerHeight }; })()`);
await page.evalJs(`(() => { for (const b of document.querySelectorAll('#floor-panel .att-x')) b.click(); return 1; })()`);
await page.resize(900, 640);
await new Promise((r) => setTimeout(r, 400));
const bare = await foot();
await page.resize(1500, 1000);
for (const f of ['png', 'txt', 'pdf', 'txt', 'pdf', 'txt', 'pdf', 'txt']) {
  await page.evalJs(`(() => { const i = document.querySelector('#floor-panel .p-file'); i.files = window.__dt(window.__f.${f}).files; i.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
}
await page.waitFor(`document.querySelectorAll('#floor-panel .att-chip').length === 8`, { timeout: 10000 }).catch(() => {});
await page.resize(900, 640);
await new Promise((r) => setTimeout(r, 400));
const room = await foot();
console.log('== a 640px window, no chips then eight:', JSON.stringify({ bare, room }));
ok((await chips()).length === 8 && room.sendBottom <= room.panelBottom + 0.5 && room.chipsH <= 48, 'eight chips in a short window stand in one row, scrolled sideways, and Send stays on the panel', room);
ok(room.panelBottom <= Math.max(bare.panelBottom, room.vh), 'and the panel reaches no further down the window than it did without them', { bare, room });
await page.shot(`${out}/attach-many.png`, '#floor-panel');
await page.resize(1500, 1000);

// 10b. Files already on the desk's machine (issue #28's companion): the
// button stands only for a host that says it has a file dialog of its own; a
// press asks that host; what its dialog chose becomes chips with no bytes
// here; Send hands the host the paths. The dialog itself is the host's and
// is not driven: its answer is posted as the host would post it.
if (DB) {
  const require = createRequire(`${REPO}/package.json`);
  const Database = require('better-sqlite3');
  const setFd = (v) => { const db = new Database(DB); db.prepare('UPDATE hosts SET file_dialog = ? WHERE host_id = ?').run(v, HOSTID); db.close(); };
  const hb = () => page.evalJs(`(() => { const b = document.querySelector('#floor-panel [data-act="attach-host"]'); return b ? { hidden: b.classList.contains('hidden'), disabled: b.disabled, title: b.title } : null; })()`);
  // One at a time: each ✕ redraws the strip, so a button found before the
  // first click is no longer in the page by the second.
  await page.evalJs(`(() => { let b, n = 0; while ((b = document.querySelector('#floor-panel .att-x')) && n++ < 50) b.click(); return n; })()`);
  ok((await chips()).length === 0, 'the fixture: the box holds no files before this part', await chips());
  ok((await hb())?.hidden === true, 'on a host with no file dialog of its own, no button for files on its machine is drawn', await hb());
  setFd(1);
  await page.waitFor(`!document.querySelector('#floor-panel [data-act="attach-host"]').classList.contains('hidden')`, { timeout: 8000 }).catch(() => {});
  const shown = await hb();
  ok(shown && !shown.hidden && !shown.disabled && /^Choose files on /.test(shown.title), 'once the host says it has one, the button stands beside the paperclip, live, naming the machine', shown);
  await work();
  await page.press('#floor-panel [data-act="attach-host"]');
  let asked = [];
  for (let i = 0; i < 20 && !asked.length; i++) { asked = (await work()).filter((x) => x.kind === 'pickfiles'); if (!asked.length) await new Promise((r) => setTimeout(r, 250)); }
  ok(asked.length === 1 && asked[0].channel === CH && asked[0].agent === AG, 'a press asks the desk\'s host to open its file dialog', asked.map((x) => `${x.kind} ${x.channel}/${x.agent}`));
  const waiting = await hb();
  ok(waiting?.disabled && /is open on/.test(waiting.title), 'and the button waits while that dialog is open, saying so', waiting);
  const picked = ['C:\\Users\\pat\\lab\\notes.md', 'C:\\Users\\pat\\lab\\run 2.log'];
  await hostEvents([{ type: 'pickfiles', channel: CH, agent: AG, state: 'open', at: new Date().toISOString() }]);
  await hostEvents([{ type: 'pickfiles', channel: CH, agent: AG, state: 'chosen', paths: picked, at: new Date().toISOString() }]);
  await page.waitFor(`document.querySelectorAll('#floor-panel .att-chip.on-host').length === 2`, { timeout: 8000 }).catch(() => {});
  const hc = await page.evalJs(`[...document.querySelectorAll('#floor-panel .att-chip.on-host')].map((c) => ({ name: c.querySelector('.att-name')?.textContent, under: c.querySelector('.att-size')?.textContent, title: c.title, thumb: !!c.querySelector('img') }))`);
  console.log('== chips for files on the host:', JSON.stringify(hc));
  ok(hc.length === 2 && hc[0].name === 'notes.md' && /^on /.test(hc[0].under) && hc[1].title.startsWith(picked[1]) && !hc[0].thumb && !hc[1].thumb,
    'what it chose stands above the box: each file by name, "on" its machine, the path on hover, and no thumbnail', hc);
  await page.waitFor(`!document.querySelector('#floor-panel [data-act="attach-host"]').disabled`, { timeout: 4000 }).catch(() => {});
  ok((await hb())?.disabled === false, 'and the button is live again for another pick', await hb());
  await page.evalJs(`(() => { const ta = document.querySelector('#p-text'); ta.value = 'read these'; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return 1; })()`);
  await page.waitFor(`document.querySelectorAll('#p-turns .t-pending').length === 1`, { timeout: 8000 }).catch(() => {});
  const hp = (await work()).find((x) => x.kind === 'chat')?.payload;
  console.log('== the host is handed:', JSON.stringify(hp));
  ok(hp?.text === 'read these' && JSON.stringify(hp.host_files) === JSON.stringify(picked) && !hp.files, 'Send hands the host the words and the paths, in order, with nothing uploaded', hp);
  ok((await chips()).length === 0, 'and the box is empty of them', await chips());
  await hostEvents([{ type: 'turn', channel: CH, agent: AG, session_id: SID, role: 'user', at: new Date().toISOString(), uuid: 'att-h1',
    text: `read these\n\nAttached by the operator:\n${picked.map((p) => `- ${p}`).join('\n')}` }]);
  await page.waitFor(`document.querySelectorAll('#p-turns .t-pending').length === 0`, { timeout: 8000 }).catch(() => {});
  const hrec = await page.evalJs(`(() => { const t = [...document.querySelectorAll('#p-turns .t-user')].pop(); return t ? { pending: t.classList.contains('t-pending'), body: t.querySelector('.t-body')?.textContent, files: [...t.querySelectorAll('.t-file')].map((f) => ({ name: f.textContent.trim(), title: f.title })) } : null; })()`);
  ok(hrec && !hrec.pending && hrec.body === 'read these' && hrec.files.length === 2 && hrec.files[0].title === picked[0] && hrec.files[1].name.endsWith('run 2.log'),
    'the recorded message retires the pending one, its Windows paths drawn as files', hrec);
  setFd(0);
  await page.waitFor(`document.querySelector('#floor-panel [data-act="attach-host"]').classList.contains('hidden')`, { timeout: 8000 }).catch(() => {});
  ok((await hb())?.hidden === true, 'and a host that stops saying it has one loses the button', await hb());
}

// 11. A host from before attachments: dimmed, with why.
if (DB) {
  const require = createRequire(`${REPO}/package.json`);
  const Database = require('better-sqlite3');
  const db = new Database(DB);
  db.prepare('UPDATE hosts SET uploads = 0 WHERE host_id = ?').run(HOSTID);
  db.close();
  await page.waitFor(`document.querySelector('#floor-panel [data-act="attach-file"]').disabled`, { timeout: 8000 }).catch(() => {});
  const dim = await page.evalJs(`(() => { const b = document.querySelector('#floor-panel [data-act="attach-file"]'); return { disabled: b.disabled, title: b.title }; })()`);
  ok(dim.disabled && /runs a build from before attachments/.test(dim.title), 'on a host from before attachments the paperclip is dimmed and says why', dim);
}

await page.close();
console.log(bad ? `FAIL · ${bad} of the attachment checks` : 'PASS · every attachment check');
process.exit(bad ? 1 : 0);

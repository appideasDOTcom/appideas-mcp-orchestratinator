#!/usr/bin/env node
/**
 * Files attached in a meeting room (issue #31; costmo, 2026-11-17: "meeting
 * rooms too"). seed-meeting.mjs's floor and host; the host types a message's
 * files under its words the way host/uploads.js does.
 *
 *   PORT=8925 CDP=9265 run-check-attach-meeting.sh <dir>
 *
 * A room of Bo and Cy opened by its address; a screenshot pasted into the
 * room's box; Send; then what each desk was handed (the seed host's work
 * lines), the room's message drawn with the file, and each desk's delivery
 * read as recorded off its own turn, which carries the list. Then files
 * alone, whose match is the file's id and name, not an empty string.
 */
import { open } from './drive.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:8905';
const WORK = process.argv[3];
const SHOTS = process.argv[4] ?? '/tmp';
const CTL = process.argv[5] ?? null;
const hostEvents = (events) => fetch(`${base}/api/host/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestratinator-key': 'k' }, body: JSON.stringify({ host_id: 'h1', events }) }).then((r) => r.json());
let fails = 0;
const ok = (cond, label, seen) => { console.log(`  ${cond ? '✓' : '✗'} ${label}${!cond && seen !== undefined ? `  (saw ${typeof seen === 'string' ? seen : JSON.stringify(seen)})` : ''}`); if (!cond) fails++; };
const stopped = (e) => { fails++; console.log(`  ✗ the check stopped on: ${String(e?.message ?? e).split('\n')[0]}`); console.log(`FAIL · ${fails} of the room's attachment checks`); process.exit(1); };
process.on('uncaughtException', stopped);
process.on('unhandledRejection', stopped);
const work = () => readFileSync(WORK, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const m = await open({ base: `${base}/?meeting=new&channel=lab&agents=bo,cy` });
await m.resize(760, 980);
await m.waitFor(`document.querySelectorAll('.m-part').length === 2`, { timeout: 15000 });
await m.waitFor(`!document.querySelector('#floor-panel [data-act="attach-file"]')?.disabled`, { timeout: 8000 }).catch(() => {});
ok(await m.evalJs(`!!document.querySelector('#floor-panel [data-act="attach-file"]') && !document.querySelector('#floor-panel [data-act="attach-file"]').disabled`), 'the room\'s box has the paperclip, live');

await m.evalJs(`(async () => {
  const c = document.createElement('canvas'); c.width = 120; c.height = 80; c.getContext('2d').fillRect(0, 0, 120, 80);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  window.__png = new File([blob], 'room shot.png', { type: 'image/png' });
  const ta = document.querySelector('#p-text'); ta.focus();
  const d = new DataTransfer(); d.items.add(window.__png);
  ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true }));
  return 1;
})()`);
await m.waitFor(`document.querySelector('#floor-panel .att-chip.ready')`, { timeout: 8000 }).catch(() => {});
ok(await m.evalJs(`document.querySelectorAll('#floor-panel .att-chip.ready').length === 1 && document.querySelector('#floor-panel .att-chip img').naturalWidth === 120`), 'a pasted screenshot stands above the room\'s box, thumbnail drawn');

const w0 = work().length;
await m.evalJs(`(() => { const t = document.querySelector('#p-text'); t.value = 'see the shot'; t.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
await m.press('#floor-panel [data-act="send"]');
await m.waitFor(`[...document.querySelectorAll('#p-turns .m-msg')].some((n) => n.querySelector('.t-body')?.textContent === 'see the shot' && !n.classList.contains('t-pending'))`, { timeout: 12000 }).catch(() => {});
const handed = work().slice(w0).filter((x) => x.kind === 'chat');
console.log('== handed:', JSON.stringify(handed.map((x) => [x.agent, x.payload?.text, x.payload?.files?.map((f) => f.name)])));
ok(handed.length === 2 && handed.every((x) => x.payload?.text === 'see the shot' && x.payload.files?.length === 1 && x.payload.files[0].name === 'room shot.png')
  && handed[0].payload.files[0].id === handed[1].payload.files[0].id, 'each desk the message went to is handed the words and the same file', handed.map((x) => x.agent));
const msg = await m.evalJs(`(() => { const n = [...document.querySelectorAll('#p-turns .m-msg')].find((x) => x.querySelector('.t-body')?.textContent === 'see the shot'); return n ? { pending: n.classList.contains('t-pending'), files: [...n.querySelectorAll('.t-file')].map((f) => f.textContent.trim()), delivs: [...n.querySelectorAll('.m-deliv')].map((d) => d.textContent) } : null; })()`);
console.log('== the room message:', JSON.stringify(msg));
ok(msg && msg.files.length === 1 && msg.files[0].endsWith('room shot.png'), 'the room\'s message shows the file under its words', msg);
ok(msg && !msg.pending && msg.delivs.length === 2 && msg.delivs.every((d) => !/sending|not recorded/.test(d)), 'and each desk reads as having recorded it, off its own turn that carries the list', msg);
ok(await m.evalJs(`!document.querySelector('#floor-panel .att-chip') && !/Attached from the floor/.test(document.querySelector('#p-turns').innerText)`), 'the box is empty of it, and no list of paths is drawn as anybody\'s words');

// Files alone, while Bo's window takes something else first: its recording
// of the room's message is held 4 s (the seed's `slow`), and in that time a
// line typed into Bo's own window lands as a user turn. A message with no
// words is matched by its file's id and name, so neither that line nor the
// first message (the same screenshot, another upload) is taken for it.
// Matched by its empty words, or by the name alone, it was, and Bo read
// "delivered" for a message its window had not recorded: the first a page
// mutant that survived before this row, the second a fault the row found.
if (CTL) writeFileSync(CTL, JSON.stringify({ slow: { bo: 4000 } }));
const w1 = work().length;
await m.evalJs(`(() => { const i = document.querySelector('#floor-panel .p-file'); const d = new DataTransfer(); d.items.add(window.__png); i.files = d.files; i.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
await m.waitFor(`document.querySelector('#floor-panel .att-chip.ready')`, { timeout: 8000 }).catch(() => {});
await m.press('#floor-panel [data-act="send"]');
const loneBo = () => m.evalJs(`(() => { const n = [...document.querySelectorAll('#p-turns .m-msg')].filter((x) => !x.querySelector('.t-body') && x.querySelector('.t-file')).pop(); const d = n && [...n.querySelectorAll('.m-deliv')].find((x) => /^Bo /.test(x.textContent)); return d ? d.textContent : null; })()`);
if (CTL) {
  await m.waitFor(`[...document.querySelectorAll('#p-turns .m-msg')].some((n) => !n.querySelector('.t-body') && n.querySelector('.t-file'))`, { timeout: 8000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 600));
  await hostEvents([{ type: 'turn', channel: 'lab', agent: 'bo', session_id: 'sess-bo', role: 'user', text: 'typed in Bo\'s own window', at: new Date().toISOString(), uuid: `own-${Date.now()}` }]);
  await m.waitFor(`/typed in Bo/.test(document.querySelector('#p-turns').innerText)`, { timeout: 6000 }).catch(() => {});
  const mid = await loneBo();
  ok(mid != null && !/delivered/.test(mid), 'a line typed into Bo\'s own window meanwhile is not taken for the room\'s files', mid);
}
await m.waitFor(`[...document.querySelectorAll('#p-turns .m-msg')].filter((n) => !n.querySelector('.t-body') && n.querySelector('.t-file')).some((n) => !n.classList.contains('t-pending')) && [...document.querySelectorAll('#p-turns .m-msg .m-deliv')].filter((d) => /^Bo/.test(d.textContent)).pop()?.textContent.includes('delivered')`, { timeout: 12000 }).catch(() => {});
const alone = work().slice(w1).filter((x) => x.kind === 'chat');
ok(alone.length === 2 && alone.every((x) => x.payload?.text === '' && x.payload.files?.length === 1), 'files alone go to both desks', alone.map((x) => x.payload));
const lone = await m.evalJs(`(() => { const n = [...document.querySelectorAll('#p-turns .m-msg')].filter((x) => !x.querySelector('.t-body') && x.querySelector('.t-file')).pop(); return n ? { pending: n.classList.contains('t-pending'), delivs: [...n.querySelectorAll('.m-deliv')].map((d) => d.textContent) } : null; })()`);
ok(lone && !lone.pending && lone.delivs.length === 2, 'and read as recorded by the file\'s id and name, the only thing such a message has', lone);
ok(/delivered/.test((await loneBo()) ?? ''), 'and Bo reads delivered once its window records the message itself', await loneBo());
await m.shot(`${SHOTS}/attach-meeting.png`, null, { full: true });

await m.click('[data-act="m-end"]').catch(() => {});
console.log(fails ? `FAIL · ${fails} of the room's attachment checks` : 'PASS · every room attachment check');
process.exit(fails ? 1 : 0);

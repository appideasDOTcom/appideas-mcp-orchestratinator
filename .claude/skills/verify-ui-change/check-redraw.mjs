#!/usr/bin/env node
/**
 * What a host's answer does to whoever is using the dialog — issue #37.
 *
 *   node --experimental-websocket check-redraw.mjs <base-url> --answers <file> [--expect before|after]
 *
 * History, Sessions and Take a desk draw again when their host answers, and
 * the answer lands on the host's clock. Drawn whole, that took the focus
 * out of the box being typed in, Take a desk's name with it, and a button
 * held down across it fired no click. Against seed-desk.mjs's desk (`lab` /
 * `bo` on h1) and answering-host.mjs answering for h1 with `--answers
 * <file>`, which this check rewrites before each row to time the answer.
 * Run it with run-check-redraw.sh, which starts all three with the board's
 * 5 s History and Sessions throttles off, so every open asks its host.
 *
 * Every key and press is real input (drive.mjs `key`, `press`). Each row
 * also proves the fixture: the host's answer must have landed while the
 * keys were going in or the button was down, timed by wrapping the three
 * render functions, or the row is red for the fixture, said as such.
 *
 *   typing     the box clicked 250 ms after the dialog opens, then one
 *              letter every 110 ms across the answer: the letters in the
 *              box, focus on it, no key elsewhere
 *   held       a row held down until the answer has drawn, then released:
 *              a click on that row. Clicks are recorded, and in these rows
 *              swallowed in the capture phase, so a row pressed opens
 *              nothing. The release follows the row (`press`'s `follow`):
 *              Take a desk's <dialog> is centred and grows 48 px when its
 *              listing lands, so everything in it moves up 24 px, and a
 *              release at the old spot is on the next row — a loss the
 *              patch cannot prevent and #37 is not about. The row says how
 *              far it moved
 *   own redraw a dialog's Close / Cancel held while its own render runs, as
 *              the issue measured it (10 of 10 lost at the base)
 *   moved on   a row held while the list is redrawn with another
 *              conversation in its place: no click on either. A kept
 *              element must be the same control, not the same spot
 *   Take a desk's name: kept through the first listing; a bound folder's
 *              agent wins over what was typed; a folder chosen afterwards
 *              empties it; a name typed while that folder is on its way is
 *              kept
 *
 * `--expect before` is what the base did (e88a951): History's own partial
 * redraw kept its box and its Close button, nothing else survived, and the
 * name typed while a folder was on its way was emptied.
 */
import { writeFileSync } from 'node:fs';
import { open } from './drive.mjs';

const args = process.argv.slice(2);
const base = args.find((a) => a.startsWith('http')) ?? 'http://localhost:8905';
const expect = args.includes('--expect') ? args[args.indexOf('--expect') + 1] : null;
const ANSWERS = args.includes('--answers') ? args[args.indexOf('--answers') + 1] : null;
if (!ANSWERS) { console.error('--answers <file> is required: the file answering-host.mjs re-reads'); process.exit(2); }
const answer = (a) => writeFileSync(ANSWERS, JSON.stringify(a));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

const page = await open({ base, view: 'board' });
await page.resize(1280, 900);
await page.evalJs(`(() => {
  /* When each dialog's answer landed: the first draw after the form says
     its host has answered. Classic-script functions are the global's
     properties, so the page's own calls go through these wrappers. */
  const LANDED = {
    history: () => ui.histForm && !ui.histForm.waiting && ui.histForm.rows !== null,
    sessions: () => ui.sessForm && !ui.sessForm.waiting && ui.sessForm.rows !== null,
    desk: () => !!ui.deskForm?.listing && !ui.deskForm.waiting,
  };
  window.__landed = {};
  window.__draws = [];
  for (const [kind, fn] of [['history', 'renderHistoryDialog'], ['sessions', 'renderSessionDialog'], ['desk', 'renderDeskDialog']]) {
    const real = window[fn];
    window[fn] = function (...a) {
      const out = real.apply(this, a);
      const t = performance.now();
      window.__draws.push({ kind, t });
      if (window.__landed[kind] === null && LANDED[kind]()) window.__landed[kind] = t;
      return out;
    };
  }
  window.__clicks = [];
  window.__swallow = false;
  window.addEventListener('click', (e) => {
    const c = e.target.closest?.('[data-do], [data-go]');
    window.__clicks.push(c ? ((c.dataset.do ?? 'go') + ' ' + (c.dataset.id ?? c.dataset.go ?? '')).trim()
      : '(none: ' + (e.target.id || e.target.className || e.target.tagName) + ')');
    if (window.__swallow && e.target.closest?.('#dlg')) { e.stopImmediatePropagation(); e.preventDefault(); }
  }, true);
  window.__keys = { field: null, box: 0, other: 0 };
  window.addEventListener('keydown', (e) => {
    if (e.key.length !== 1 || !window.__keys.field) return;
    if (e.target === document.querySelector(window.__keys.field)) window.__keys.box++;
    else window.__keys.other++;
  }, true);
  return 'ok';
})()`);

const now = () => page.evalJs('performance.now()');
async function opened(opener, kind) {
  await page.evalJs(`(async () => {
    for (const x of document.querySelectorAll('dialog[open]')) x.close();
    await new Promise((r) => setTimeout(r, 50));
    window.__landed[${J(kind)}] = null;
    window.__clicks = [];
    return 'ok';
  })()`);
  await page.evalJs(opener);
  await page.waitFor(`document.querySelector('#dlg').open`);
}
const landed = (kind, timeout = 8000) => page.waitFor(`window.__landed[${J(kind)}] !== null`, { every: 50, timeout }).then(() => true, () => false);
const landedAt = (kind) => page.evalJs(`window.__landed[${J(kind)}]`);
async function typeSlowly(text) {
  for (const ch of text) { await page.key(ch, { text: ch }); await sleep(110); }
}
const read = (field) => page.evalJs(`JSON.stringify((() => {
  const f = document.querySelector(${J(field)});
  return { value: f?.value ?? null, readOnly: !!f?.readOnly, active: document.activeElement?.id || document.activeElement?.tagName, keys: window.__keys };
})())`).then(JSON.parse);

const rows = [];
let failed = 0;
function row(name, seen, want, fixture = null, note = '') {
  let verdict = '';
  if (expect || fixture) {
    const w = want?.[expect];
    const ok = !fixture && (w === undefined || seen === w);
    if (!ok) failed++;
    verdict = fixture ? `✗ the fixture: ${fixture}` : ok ? '✓' : `✗ wanted ${w}`;
  }
  rows.push(`${name.padEnd(52)} ${String(seen).padEnd(22)} ${verdict}${note ? `  (${note})` : ''}`);
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyzabcdefghij';   // 36: about four seconds
const TYPING = [
  { name: 'history, recent list answering', kind: 'history', open: `historyDialog()`, field: '#hist-query',
    answers: { recent: { delay: 1200 } }, before: 'kept' },
  { name: 'take a desk, opened on a folder', kind: 'desk', open: `deskDialog({ hostId: 'h1', path: '/repo/deep/nest/alpha-older' })`, field: '#desk-agent',
    answers: { browse: { delay: 1200 } }, before: 'lost' },
  { name: 'sessions, its host answering', kind: 'sessions', open: `sessionDialog('lab', 'bo', 'Bo')`, field: '#sess-filter',
    answers: { sessions: { answer: true, delay: 1200 } }, before: 'lost' },
];
for (const d of TYPING) {
  process.stderr.write(`typing: ${d.name}… `);
  answer(d.answers);
  await opened(d.open, d.kind);
  await sleep(250);
  await page.press(d.field);
  await page.evalJs(`window.__keys = { field: ${J(d.field)}, box: 0, other: 0 }, 'ok'`);
  const t0 = await now();
  await typeSlowly(LETTERS);
  const t1 = await now();
  await landed(d.kind, 1000);
  const at = await landedAt(d.kind);
  const got = await read(d.field);
  const kept = got.value === LETTERS && got.active === d.field.slice(1) && got.keys.other === 0;
  const seen = kept ? 'kept' : 'lost';
  const fixture = at === null ? 'the host never answered' : at < t0 || at > t1 ? `the answer landed ${Math.round(at - t0)} ms from the first key, outside the typing` : null;
  row(`typing · ${d.name}`, seen, { after: 'kept', before: d.before }, fixture,
    `${got.keys.box} keys into the box, ${got.keys.other} elsewhere; ${got.value?.length ?? '-'} letters in it; focus ${got.active}; answer at ${at === null ? '-' : Math.round(at - t0)} ms`);
}

/* Take a desk opened on no folder: its host list arrives and replaces the
   folder block above the box (the page's list until it knows the host has a
   dialog of its own, then the button). The board answers that list itself
   at once, faster than a person reaches the box, so the arrival is replayed:
   the dialog drawn as it is before the list, the box clicked and typed in,
   then the list put back and drawn. The first cut of the patch moved the
   Agent label up past the old block, and the move dropped its focus. */
{
  process.stderr.write('take a desk: host list arriving… ');
  answer({});
  await opened(`deskDialog()`, 'desk');
  await page.waitFor(`ui.deskForm.hosts !== null`, { every: 50, timeout: 4000 });
  await page.evalJs(`(() => { window.__hosts = ui.deskForm.hosts; ui.deskForm.hosts = null; renderDeskDialog(); return 'ok'; })()`);
  const blockBefore = await page.evalJs(`!!document.querySelector('#dlg .dlg-crumbs')`);
  await page.press('#desk-agent');
  await page.evalJs(`window.__keys = { field: '#desk-agent', box: 0, other: 0 }, 'ok'`);
  await typeSlowly('abc');
  await page.evalJs(`(() => { ui.deskForm.hosts = window.__hosts; renderDeskDialog(); return 'ok'; })()`);
  const blockAfter = await page.evalJs(`!!document.querySelector('#dlg .desk-pick') && !document.querySelector('#dlg .dlg-crumbs')`);
  await typeSlowly('def');
  const got = await read('#desk-agent');
  const kept = got.value === 'abcdef' && got.active === 'desk-agent' && got.keys.other === 0;
  row('take a desk · its host list arriving above the box', kept ? 'kept' : 'lost', { after: 'kept', before: 'lost' },
    !blockBefore || !blockAfter ? `the folder block did not change from the list to the button (${blockBefore}, ${blockAfter})` : null,
    `${got.keys.box} keys into the box, ${got.keys.other} elsewhere; "${got.value}"; focus ${got.active}`);
}

/* Take a desk's name. */
{
  process.stderr.write('take a desk: bound folder… ');
  answer({ browse: { delay: 1200, bound: { '/repo/deep/nest/bound-here': { channel: 'lab', agent: 'cy', scope: 'local' } } } });
  await opened(`deskDialog({ hostId: 'h1', path: '/repo/deep/nest/bound-here' })`, 'desk');
  await sleep(250);
  await page.press('#desk-agent');
  await page.evalJs(`window.__keys = { field: '#desk-agent', box: 0, other: 0 }, 'ok'`);
  const t0 = await now();
  await typeSlowly('zzzzzzzzzzzzzzzzzzzzzz');
  const at = await landedAt('desk');
  const got = await read('#desk-agent');
  row('take a desk · a bound folder\'s agent wins', `${got.value}${got.readOnly ? ' (read-only)' : ''}`, { after: 'cy (read-only)', before: 'cy (read-only)' },
    at === null || at < t0 ? 'the bound listing did not land while typing' : null);
}
{
  process.stderr.write('take a desk: another folder… ');
  answer({ browse: { delay: 0 } });
  await opened(`deskDialog({ hostId: 'h1', path: '/repo/deep/nest/alpha-older' })`, 'desk');
  await landed('desk');
  await page.press('#desk-agent');
  await typeSlowly('abc');
  const typed = (await read('#desk-agent')).value;
  await page.evalJs(`window.__landed.desk = null, 'ok'`);
  await page.press('#dlg .recent-row[data-go="/repo/deep/nest/zeta-newest"]');
  await landed('desk');
  const path = await page.evalJs(`ui.deskForm.path`);
  const got = await read('#desk-agent');
  row('take a desk · a folder chosen afterwards empties it', got.value === '' ? 'emptied' : `"${got.value}"`, { after: 'emptied', before: 'emptied' },
    typed !== 'abc' ? `"abc" never got into the box (${typed})` : path !== '/repo/deep/nest/zeta-newest' ? `the dialog stands in ${path}` : null);

  process.stderr.write('take a desk: typed while on its way… ');
  answer({ browse: { delay: 1500 } });
  await page.evalJs(`window.__landed.desk = null, 'ok'`);
  await page.press('#dlg .recent-row[data-go="/repo/deep/nest/alpha-older"]');
  await page.press('#desk-agent');
  await typeSlowly('qa');
  const t1 = await now();
  await landed('desk', 4000);
  const at = await landedAt('desk');
  const after = await read('#desk-agent');
  row('take a desk · typed while that folder is on its way', after.value === 'qa' ? 'kept' : `"${after.value}"`, { after: 'kept', before: '""' },
    at === null ? 'the listing never landed' : at < t1 ? `the listing landed ${Math.round(t1 - at)} ms before the typing ended` : null);
}

/* A row held down while the host answers. */
const HELD = [
  { name: 'history, a row', kind: 'history', open: `historyDialog()`, answers: { recent: { delay: 1200 } },
    target: '#dlg [data-do="history-read"][data-id="bo-old"]', click: 'history-read bo-old' },
  { name: 'sessions, a row', kind: 'sessions', open: `sessionDialog('lab', 'bo', 'Bo')`, answers: { sessions: { answer: true, delay: 1200 } },
    target: '#dlg [data-do="session-resume"][data-id="bo-old"]', click: 'session-resume bo-old' },
  { name: 'take a desk, a recent folder', kind: 'desk', open: `deskDialog({ hostId: 'h1', path: '/repo/deep/nest/alpha-older' })`, answers: { browse: { delay: 1200 } },
    target: '#dlg .recent-row[data-go="/repo/deep/nest/zeta-newest"]', click: 'go /repo/deep/nest/zeta-newest' },
];
for (const d of HELD) {
  process.stderr.write(`held: ${d.name}… `);
  answer(d.answers);
  await opened(d.open, d.kind);
  const there = await page.waitFor(`!!document.querySelector(${J(d.target)})`, { every: 50, timeout: 3000 }).then(() => true, () => false);
  if (!there) { row(`held · ${d.name}`, 'no row to press', { after: 'clicked', before: 'lost' }, `${d.target} was never drawn`); continue; }
  const before = await page.evalJs(`window.__landed[${J(d.kind)}]`);
  await page.evalJs(`window.__swallow = true, 'ok'`);
  const { during, moved } = await page.press(d.target, d.target, { held: () => landed(d.kind), follow: true });
  await page.evalJs(`window.__swallow = false, 'ok'`);
  const clicks = JSON.parse(await page.evalJs(`JSON.stringify(window.__clicks)`));
  const seen = clicks.includes(d.click) ? 'clicked' : 'lost';
  row(`held · ${d.name}`, seen, { after: 'clicked', before: 'lost' },
    before !== null ? 'the answer had landed before the press' : !during ? 'the answer did not land while the button was down' : null,
    `${moved.y ? `moved ${Math.round(moved.y)} px under the press; ` : ''}clicks ${J(clicks)}`);
}

/* The dialog's own redraw while its Close / Cancel is held, the issue's
   measurement: five presses each. */
const OWN = [
  { name: 'history', kind: 'history', open: `historyDialog()`, redraw: 'renderHistoryDialog()', answers: { recent: { delay: 0 } }, before: 5 },
  { name: 'sessions', kind: 'sessions', open: `sessionDialog('lab', 'bo', 'Bo')`, redraw: 'renderSessionDialog()', answers: { sessions: { answer: true, delay: 0 } }, before: 0 },
  { name: 'take a desk', kind: 'desk', open: `deskDialog({ hostId: 'h1', path: '/repo/deep/nest/alpha-older' })`, redraw: 'renderDeskDialog()', answers: { browse: { delay: 0 } }, before: 0 },
];
for (const d of OWN) {
  process.stderr.write(`own redraw: ${d.name}… `);
  answer(d.answers);
  await opened(d.open, d.kind);
  await landed(d.kind);
  await sleep(300);
  let n = 0;
  await page.evalJs(`window.__swallow = true, 'ok'`);
  for (let i = 0; i < 5; i++) {
    await page.evalJs(`window.__clicks = [], 'ok'`);
    await page.press('#dlg [data-do="cancel"]', '#dlg [data-do="cancel"]', { held: async () => { await sleep(50); await page.evalJs(`${d.redraw}, 'ok'`); await sleep(100); } });
    if ((JSON.parse(await page.evalJs(`JSON.stringify(window.__clicks)`))).includes('cancel')) n++;
  }
  await page.evalJs(`window.__swallow = false, 'ok'`);
  row(`own redraw · ${d.name}'s close, held`, `${n} of 5 clicked`, { after: '5 of 5 clicked', before: `${d.before} of 5 clicked` });
}

/* Another conversation in the held row's place. */
{
  process.stderr.write('moved on… ');
  answer({ sessions: { answer: true, delay: 0 } });
  await opened(`sessionDialog('lab', 'bo', 'Bo')`, 'sessions');
  await landed('sessions');
  await sleep(300);
  await page.evalJs(`window.__swallow = true, 'ok'`);
  await page.press('#dlg [data-do="session-resume"][data-id="bo-old"]', undefined, { held: () => page.evalJs(`(() => {
    ui.sessForm.rows = ui.sessForm.rows.map((r) => r.id === 'bo-old' ? { ...r, id: 'bo-other', title: 'Another conversation' } : r);
    renderSessionDialog();
    return 'ok';
  })()`) });
  await page.evalJs(`window.__swallow = false, 'ok'`);
  const clicks = JSON.parse(await page.evalJs(`JSON.stringify(window.__clicks)`));
  const hit = clicks.find((c) => /bo-old|bo-other/.test(c));
  row('moved on · a held row replaced by another', hit ? `clicked ${hit}` : 'no click on either', { after: 'no click on either', before: 'no click on either' });
}

process.stderr.write('\n');
await page.evalJs(`for (const x of document.querySelectorAll('dialog[open]')) x.close(); 'ok'`);
await page.close();
console.log(rows.join('\n'));
if (expect) {
  console.log(failed ? `FAIL · ${failed} of ${rows.length}` : `PASS · ${rows.length} of ${rows.length}`);
  process.exit(failed ? 1 : 0);
}

#!/usr/bin/env node
/**
 * What each gesture outside a dialog's contents does to it — issue #11.
 *
 *   node --experimental-websocket check-backdrop.mjs <base-url> [--expect before|after]
 *
 * Against seed-desk.mjs's desk (`lab` / `bo` on host h1) with answering-host.mjs
 * answering for h1, so the Sessions and History dialogs have a host to ask.
 *
 * Every gesture is real input through `press()` — a synthetic click names its
 * own target, and the target is the whole question: a click goes to the
 * nearest common ancestor of where the button went down and where it came up,
 * so a drag out of a field onto the backdrop lands on the `<dialog>`. Four
 * gestures per dialog, each from a freshly opened dialog with a marker typed
 * into its field:
 *
 *   backdrop  press and release on the dimmed page, outside the dialog's box
 *   drag      press in the field, release on the backdrop
 *   padding   press and release inside the dialog's box, in its own padding
 *   escape    the Escape key (twice on a search field, whose first Escape
 *             the browser spends clearing it)
 *
 * and reads whether the dialog is still open, the marker still in the field,
 * and how many `close` events the gesture fired. The count is what tells
 * "never closed" from "closed and drawn back": a dialog waiting on its host
 * was redrawn open by the host's answer within the 120 ms the row waits
 * (PR #36, QA finding 2 — with `search` taken out of TYPED_INPUT, History's
 * backdrop row still read `open kept`). So `open` passes only with no close.
 *
 * Then a second table, close-then-wait (PR #36, QA finding 1): each dialog
 * that asks a host is opened, closed 150 ms later with Escape or its own
 * Close button, and watched for ten seconds. History is answered at once by
 * answering-host, Sessions not at all (its loop gives up at 8 s and says
 * so), Take a desk is opened on a folder so its host is asked a `browse` —
 * three ways a host's answer can arrive after the close. Control: the task
 * list, which asks no host. Then the same, made deterministic: each of the
 * three closed and redrawn in one task, which is a host's answer landing
 * between close() and its late `close` event. Then Sessions closed and the
 * retire dialog opened while Sessions' loop still runs, which must not draw
 * over it. And one row closes History and opens it again in the same task,
 * which the late `close` must not empty.
 *
 * `--expect` turns both into a pass/fail: `after` is issue #11's Decided — a
 * dialog carrying a plain-text field closes on Escape only, one without
 * closes on all four — and every closed dialog stays closed; `before` is the
 * behaviour the issue reports, and the three host dialogs coming back, which
 * is what the base did (05004f9 and 66dcf64 alike).
 */
import { open } from './drive.mjs';

const args = process.argv.slice(2);
const base = args.find((a) => a.startsWith('http')) ?? 'http://localhost:8905';
const expect = args.includes('--expect') ? args[args.indexOf('--expect') + 1] : null;
const MARK = 'typed-for-issue-11';

const page = await open({ base, view: 'board' });
await page.resize(1280, 900);
/* Every close either dialog fires, counted by the dialog's selector. Set once:
   the listeners outlive every dialog drawn into these two elements. */
await page.evalJs(`(() => {
  window.__closes = { '#dlg': 0, '#settings-dlg': 0 };
  /* And a log of every open, close() and close event with its time, printed
     under a red row: a row's verdict says what it saw, this says how. */
  window.__dlgLog = [];
  const t = () => Math.round(performance.now());
  const say = (what, el, extra) => window.__dlgLog.push(\`\${t()} \${what} #\${el.id}\${extra ? ' ' + extra : ''}\`);
  const show = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function () { say('showModal', this); return show.call(this); };
  const shut = HTMLDialogElement.prototype.close;
  HTMLDialogElement.prototype.close = function (...a) {
    say('close()', this, (new Error().stack.split('\\n')[2] ?? '').trim().replace(/^at /, '').slice(0, 60));
    return shut.apply(this, a);
  };
  for (const k of Object.keys(window.__closes)) {
    const d = document.querySelector(k);
    d.addEventListener('close', () => { window.__closes[k]++; say('close event', d); });
    d.addEventListener('cancel', () => say('cancel event', d));
  }
  return 'ok';
})()`);
const logSince = async (mark) => (await page.evalJs(`JSON.stringify(window.__dlgLog.slice(${mark}))`));
const logMark = () => page.evalJs(`window.__dlgLog.length`);
const closes = (dlg) => page.evalJs(`window.__closes[${JSON.stringify(dlg)}]`);
const resetCloses = (dlg) => page.evalJs(`window.__closes[${JSON.stringify(dlg)}] = 0`);

/* A backup the settings dialog will accept, so its type-RESTORE field is drawn. */
const BACKUP = JSON.stringify({ format: 'orchestratinator-backup', version: 1, created_at: new Date().toISOString(),
  server: { version: 'x' }, counts: { messages: 0 }, tables: {} });

/* Each dialog: how to open it, the field to type into (null: none), and the
   dialog element. The openers are the page's own globals — every one of these
   closes through the same handler on its <dialog>, whichever button opened it. */
const DIALOGS = [
  { name: 'rename', open: `renameDialog('lab', 'bo')`, field: '#persona-name' },
  { name: 'saved prompts (new)', open: `loadPrompts({ edit: 'new' })`, field: '#prompt-title' },
  { name: 'saved prompts (body)', open: `loadPrompts({ edit: 'new' })`, field: '#prompt-content' },
  { name: 'channel (delete confirm)', open: `channelDialog('lab')`, field: '#confirm-name' },
  { name: 'take a desk', open: `deskDialog()`, field: '#desk-agent' },
  { name: 'move (new floor)', open: `moveDeskDialog('lab', 'bo', { host: 'h1', folder: '/repo/bo' })`, field: '#move-new-channel' },
  { name: 'sessions', open: `sessionDialog('lab', 'bo', 'Bo')`, field: '#sess-filter' },
  { name: 'history', open: `historyDialog()`, field: '#hist-query' },
  { name: 'settings (file chosen)', dlg: '#settings-dlg', field: '#restore-confirm',
    open: `(async () => { openSettings(); await chooseBackupFile(new File([${JSON.stringify(BACKUP)}], 'b.json', { type: 'application/json' })); })()` },
  { name: 'tasks (no field)', open: `taskDialog('lab', null)`, field: null, from: '#dlg .dlg-sub' },
  { name: 'retire (no field)', open: `retireDialog('lab', 'bo')`, field: null, from: '#dlg .dlg-sub' },
  { name: 'saved prompts (list)', open: `promptManager()`, field: null, from: '#dlg .dlg-sub' },
  { name: 'settings (no file)', dlg: '#settings-dlg', open: `openSettings()`, field: null, from: '#settings-dlg .set-h' },
];

const isOpen = (dlg) => page.evalJs(`document.querySelector(${JSON.stringify(dlg)}).open`);

async function fresh(d) {
  const dlg = d.dlg ?? '#dlg';
  /* A dialog's `close` event is a queued task, not part of close(), and the
     page's handler for it empties #dlg-body. Opened in the same breath, the
     next dialog was drawn and then wiped by the last one's late close — an
     open dialog with nothing in it, intermittently, depending on whether a
     CDP round trip happened to let the task run first. So: close, let the
     event loop turn, then open. */
  await page.evalJs(`(async () => {
    for (const x of document.querySelectorAll('dialog[open]')) x.close();
    await new Promise((r) => setTimeout(r, 50));
    return 'ok';
  })()`);
  await page.evalJs(d.open);
  await page.waitFor(`document.querySelector(${JSON.stringify(dlg)}).open`);
  if (d.field) {
    /* A dialog that asks its host something redraws whole when the answer
       lands — Sessions does, on its host's list, and the redraw takes focus
       out of the filter (the value survives, in the form's state). So the
       marker is typed and focused again until the same field element has
       held it across two polls half a second apart: nothing redrew it in
       between. Otherwise a lost marker or a lost focus is the fixture's.
       The first cut retyped only a missing value, and a back-to-back run
       whose host answered late waited on a focus nobody restored. */
    await page.waitFor(`(() => {
      const f = document.querySelector(${JSON.stringify(d.field)});
      if (!f) return false;
      const same = window.__issue11Field === f;
      window.__issue11Field = f;
      if (f.value !== ${JSON.stringify(MARK)}) {
        f.value = ${JSON.stringify(MARK)};
        f.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (document.activeElement !== f) f.focus();
      return same && f.value === ${JSON.stringify(MARK)} && document.activeElement === f;
    })()`, { every: 500, timeout: 15000 }).catch(async (e) => {
      const seen = await page.evalJs(`(() => {
        const f = document.querySelector(${JSON.stringify(d.field)});
        return JSON.stringify({ field: !!f, same: window.__issue11Field === f, value: f?.value,
          active: document.activeElement?.id || document.activeElement?.tagName, open: document.querySelector(${JSON.stringify(dlg)}).open,
          html: document.querySelector(${JSON.stringify(dlg)}).textContent.replace(/\s+/g, " ").slice(0, 300) });
      })()`);
      throw new Error(`${d.name}: the marker never settled in its field — ${seen}`, { cause: e });
    });
  }
  return dlg;
}

/* Inside the dialog's border box but outside everything it holds: its own
   padding, bottom-left. That point's target is the <dialog> itself. */
const paddingPoint = (dlg) => page.evalJs(`(() => {
  const r = document.querySelector(${JSON.stringify(dlg)}).getBoundingClientRect();
  return { x: r.x + 8, y: r.y + r.height - 6 };
})()`);
const BACKDROP = { x: 10, y: 10 };

/* What a gesture did, once it has done it. A drag is ten input events, so its
   click — and the close() it causes — lands 300 ms and more after the gesture
   starts, and the `close` event comes later than the close() itself. Read at a
   fixed 120 ms, a row saw the dialog shut and no close counted, and called a
   working dialog broken (the first cut, 2 reds in 2 control runs). So a row
   waits for its dialog to be shut with its close event counted, and otherwise
   gives the gesture 600 ms to do anything at all: a row that should stay open
   is read after that, and a close in that time is counted against it. */
const landed = (dlg, ms = 600) => page.waitFor(
  `!document.querySelector(${JSON.stringify(dlg)}).open && window.__closes[${JSON.stringify(dlg)}] >= 1`,
  { timeout: ms, every: 50 }).catch(() => false);

/* A button pressed by its centre must be where it was measured. Take a desk
   redraws taller when its host list arrives, and a Cancel measured before
   that redraw was pressed in empty space. Wait until it has held still. */
const stillButton = (sel) => page.waitFor(`(() => {
  const b = document.querySelector(${JSON.stringify(sel)});
  if (!b) return false;
  const r = JSON.stringify(b.getBoundingClientRect());
  const same = window.__btnRect === r;
  window.__btnRect = r;
  return same;
})()`, { every: 60, timeout: 2000 });

const rows = [];
let failed = 0;
for (const d of DIALOGS) {
  process.stderr.write(`${d.name}… `);
  for (const gesture of ['backdrop', 'drag', 'padding', 'escape']) {
    const mark = await logMark();
    const dlg = await fresh(d);
    await resetCloses(dlg);
    await page.evalJs(`window.__dlgLog.push(Math.round(performance.now()) + ' gesture ${gesture}'), 'ok'`);
    if (gesture === 'backdrop') await page.press(BACKDROP);
    else if (gesture === 'drag') await page.press(d.field ?? d.from, BACKDROP);
    else if (gesture === 'padding') { const p = await paddingPoint(dlg); await page.press(p); }
    else await page.key('Escape');
    await landed(dlg);
    let stillOpen = await isOpen(dlg);
    let label = gesture;
    /* A non-empty `type="search"` field takes the first Escape itself — the
       browser clears it — and the second reaches the dialog. That is the
       browser's, not the page's (History's query has no Escape handler), so
       the row says two were pressed rather than calling Escape broken. */
    if (gesture === 'escape' && stillOpen && d.field &&
        await page.evalJs(`document.querySelector(${JSON.stringify(d.field)})?.type === 'search'`)) {
      await page.key('Escape');
      await landed(dlg);
      stillOpen = await isOpen(dlg);
      label = 'escape×2';
    }
    const kept = d.field
      ? await page.evalJs(`document.querySelector(${JSON.stringify(d.field)})?.value === ${JSON.stringify(MARK)}`)
      : null;
    const shut = await closes(dlg);
    let verdict = '';
    if (expect) {
      const want = expect === 'after'
        ? (d.field ? gesture !== 'escape' : false)
        : false;                 // before: every gesture closed every dialog
      // Open means never closed: open with a close behind it is a dialog that
      // was drawn back, and reads as the failure it is.
      const ok = want ? stillOpen && kept && shut === 0 : !stillOpen && shut >= 1;
      if (!ok) failed++;
      verdict = ok ? '✓' : `✗ wanted ${want ? 'open, never closed' : 'closed'}  log ${await logSince(mark)}`;
    }
    rows.push(`${d.name.padEnd(26)} ${label.padEnd(9)} ${(stillOpen ? 'open' : 'closed').padEnd(7)}` +
      ` ${d.field && stillOpen ? (kept ? 'kept' : 'lost') : '—   '}  ${String(shut).padStart(2)} close  ${verdict}`);
  }
}
/* Close-then-wait. Closed by a person 150 ms after opening, before any host
   has answered, then sampled every 250 ms for WATCH_MS — long enough for
   Sessions' loop to give up (8 s) and draw its "did not answer". */
const WATCH_MS = 10_000;
const WAITERS = [
  { name: 'tasks (control, no host)', open: `taskDialog('lab', null)`, host: false },
  { name: 'history', open: `historyDialog()`, host: true },
  { name: 'sessions', open: `sessionDialog('lab', 'bo', 'Bo')`, host: true },
  { name: 'take a desk (a folder)', open: `deskDialog({ hostId: 'h1', path: '/repo/deep/nest' })`, host: true },
];
const later = [];
for (const w of WAITERS) {
  for (const how of ['escape', 'button']) {
    process.stderr.write(`${w.name} ${how}… `);
    const mark = await logMark();
    await fresh({ open: w.open, field: null });
    await resetCloses('#dlg');
    await new Promise((r) => setTimeout(r, 150));
    if (how === 'escape') await page.key('Escape');
    else { await stillButton('#dlg [data-do="cancel"]'); await page.press('#dlg [data-do="cancel"]'); }
    /* The clock starts when the close has landed. A close that never did is
       the fixture's miss, said as one — not "drawn back". */
    const shutFirst = await landed('#dlg', 2000);
    const t0 = Date.now();
    let back = null;
    if (shutFirst) {
      while (Date.now() - t0 < WATCH_MS) {
        await new Promise((r) => setTimeout(r, 250));
        if (await isOpen('#dlg')) { back = Date.now() - t0; break; }
      }
    }
    const shut = await closes('#dlg');
    let verdict = '';
    if (expect) {
      const wantBack = expect === 'before' && w.host;
      const ok = shutFirst && (wantBack ? back !== null : back === null && shut === 1);
      if (!ok) failed++;
      verdict = ok ? '✓' : `✗ ${shutFirst ? `wanted ${wantBack ? 'drawn back' : 'closed for good, one close'}` : 'the close never landed'}  log ${await logSince(mark)}`;
    }
    const seen = !shutFirst ? 'never closed' : back === null ? `closed ${WATCH_MS / 1000} s` : `back at ${back} ms`;
    later.push(`${w.name.padEnd(26)} ${how.padEnd(9)} ${seen.padEnd(16)} ${String(shut).padStart(2)} close  ${verdict}`);
  }
}
/* A loop that outlives its dialog must not draw over the next one. Sessions
   polls its host for 8 s; closed after a moment, and the retire dialog —
   which sets no context of its own — opened once the close has landed. The
   Sessions loop, still running, used to find its context in place and draw
   Sessions over Retire when it gave up.
   It runs before the redraw-in-the-gap rows on purpose: the board answers
   a second Sessions ask within 5 s from the list it holds (SESSIONS_MIN_MS),
   and a Sessions answered that way has no loop left to outlive it. The
   first cut ran after them and passed at the base, so the row now also
   requires Sessions to be waiting on its host when it is closed. */
{
  process.stderr.write('sessions then retire… ');
  const mark = await logMark();
  await fresh({ open: `sessionDialog('lab', 'bo', 'Bo')`, field: null });
  await resetCloses('#dlg');
  await new Promise((r) => setTimeout(r, 150));
  const asking = await page.evalJs(`ui.sessForm?.waiting === true`);
  await page.key('Escape');
  await landed('#dlg', 2000);
  await new Promise((r) => setTimeout(r, 300));
  await page.evalJs(`retireDialog('lab', 'bo'), 'ok'`);
  await page.waitFor(`document.querySelector('#dlg').open`);
  await new Promise((r) => setTimeout(r, 9500));
  const over = JSON.parse(await page.evalJs(`JSON.stringify({ open: document.querySelector('#dlg').open,
    sessions: !!document.querySelector('#dlg #sess-filter'), retire: !!document.querySelector('#dlg [data-do="retire"]') })`));
  let verdict = '';
  if (expect) {
    const ok = asking && (expect === 'after' ? over.open && over.retire && !over.sessions : over.sessions);
    if (!ok) failed++;
    verdict = ok ? '✓' : !asking ? '✗ the fixture: Sessions was not waiting on its host'
      : `✗ wanted ${expect === 'after' ? 'Retire, untouched' : 'Sessions drawn over it'}  log ${await logSince(mark)}`;
  }
  later.push(`${'sessions closed, then retire opened'.padEnd(42)} ${over.sessions ? 'Sessions drawn over it' : over.retire ? 'retire' : 'neither'}${asking ? '' : ' (not asking)'}  ${verdict}`);
}

/* The gap, made deterministic. A dialog's close() and its `close` event are
   apart — measured about 100 ms apart here — and a host's answer that lands
   between them used to draw the dialog back (History, 1 run in 3 on the
   first cut of the fix). Here the answer is the dialog's own redraw, called
   in the same task as the close, so it lands in the gap every time. */
for (const [name, opener, redraw] of [
  ['history', `historyDialog()`, `renderHistoryDialog()`],
  ['sessions', `sessionDialog('lab', 'bo', 'Bo')`, `renderSessionDialog()`],
  ['take a desk (a folder)', `deskDialog({ hostId: 'h1', path: '/repo/deep/nest' })`, `renderDeskDialog()`],
]) {
  process.stderr.write(`${name} gap… `);
  const mark = await logMark();
  await fresh({ open: opener, field: null });
  await page.evalJs(`(() => { closeDialog(); ${redraw}; return 'ok'; })()`);
  await new Promise((r) => setTimeout(r, 1000));
  const shown = await isOpen('#dlg');
  let verdict = '';
  if (expect) {
    const ok = expect === 'after' ? !shown : shown;
    if (!ok) failed++;
    verdict = ok ? '✓' : `✗ wanted ${expect === 'after' ? 'closed' : 'drawn back'}  log ${await logSince(mark)}`;
  }
  later.push(`${`${name}, redrawn before its close event`.padEnd(42)} ${shown ? 'drawn back' : 'closed'}  ${verdict}`);
}

/* Closed and opened again in one task. The `close` event lands after the new
   dialog is drawn, and must leave it be: its body and its context are the
   new dialog's (PR #36 task 64 — "anything done in the close handler must not
   clobber a dialog opened in the same breath"). Before the fix the handler
   emptied the body whatever was open. */
process.stderr.write('same breath… ');
await fresh({ open: `historyDialog()`, field: null });
await page.evalJs(`(() => { closeDialog(); historyDialog(); return 'ok'; })()`);
await new Promise((r) => setTimeout(r, 1000));
const breath = JSON.parse(await page.evalJs(`JSON.stringify({ open: document.querySelector('#dlg').open,
  drawn: !!document.querySelector('#dlg #hist-query'), ctx: ui.dlgCtx?.kind ?? null })`));
{
  let verdict = '';
  if (expect) {
    const ok = expect === 'after'
      ? breath.open && breath.drawn && breath.ctx === 'history'
      : breath.open && !breath.drawn;
    if (!ok) failed++;
    verdict = ok ? '✓' : `✗ wanted ${expect === 'after' ? 'History drawn, its context kept' : 'an emptied dialog'}`;
  }
  later.push(`${'history, closed and reopened in one task'.padEnd(36)} ${breath.open ? 'open' : 'closed'} · ` +
    `${breath.drawn ? 'drawn' : 'EMPTY'} · context ${breath.ctx ?? 'none'}  ${verdict}`);
}
process.stderr.write('\n');     // the progress line ends before the tables start
await page.evalJs(`for (const x of document.querySelectorAll('dialog[open]')) x.close(); 'ok'`);
await page.close();
console.log(rows.join('\n'));
console.log('\nclose, then wait');
console.log(later.join('\n'));
const total = rows.length + later.length;
if (expect) {
  console.log(failed ? `FAIL · ${failed} of ${total}` : `PASS · ${total} of ${total}`);
  process.exit(failed ? 1 : 0);
}

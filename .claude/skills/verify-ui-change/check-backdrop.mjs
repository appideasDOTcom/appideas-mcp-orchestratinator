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
 * and reads whether the dialog is still open and the marker still in the
 * field. `--expect` turns the table into a pass/fail: `after` is issue #11's
 * Decided — a dialog carrying a plain-text field closes on Escape only, one
 * without closes on all four; `before` is the behaviour the issue reports.
 */
import { open } from './drive.mjs';

const args = process.argv.slice(2);
const base = args.find((a) => a.startsWith('http')) ?? 'http://localhost:8905';
const expect = args.includes('--expect') ? args[args.indexOf('--expect') + 1] : null;
const MARK = 'typed-for-issue-11';

const page = await open({ base, view: 'board' });
await page.resize(1280, 900);

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

const rows = [];
let failed = 0;
for (const d of DIALOGS) {
  process.stderr.write(`${d.name}… `);
  for (const gesture of ['backdrop', 'drag', 'padding', 'escape']) {
    const dlg = await fresh(d);
    if (gesture === 'backdrop') await page.press(BACKDROP);
    else if (gesture === 'drag') await page.press(d.field ?? d.from, BACKDROP);
    else if (gesture === 'padding') { const p = await paddingPoint(dlg); await page.press(p); }
    else await page.key('Escape');
    await new Promise((r) => setTimeout(r, 120));
    let stillOpen = await isOpen(dlg);
    let label = gesture;
    /* A non-empty `type="search"` field takes the first Escape itself — the
       browser clears it — and the second reaches the dialog. That is the
       browser's, not the page's (History's query has no Escape handler), so
       the row says two were pressed rather than calling Escape broken. */
    if (gesture === 'escape' && stillOpen && d.field &&
        await page.evalJs(`document.querySelector(${JSON.stringify(d.field)})?.type === 'search'`)) {
      await page.key('Escape');
      await new Promise((r) => setTimeout(r, 120));
      stillOpen = await isOpen(dlg);
      label = 'escape×2';
    }
    const kept = d.field
      ? await page.evalJs(`document.querySelector(${JSON.stringify(d.field)})?.value === ${JSON.stringify(MARK)}`)
      : null;
    let verdict = '';
    if (expect) {
      const want = expect === 'after'
        ? (d.field ? gesture !== 'escape' : false)
        : false;                 // before: every gesture closed every dialog
      const ok = stillOpen === want && (!want || kept);
      if (!ok) failed++;
      verdict = ok ? '✓' : `✗ wanted ${want ? 'open' : 'closed'}`;
    }
    rows.push(`${d.name.padEnd(26)} ${label.padEnd(9)} ${(stillOpen ? 'open' : 'closed').padEnd(7)}` +
      ` ${d.field && stillOpen ? (kept ? 'kept' : 'lost') : '—   '}  ${verdict}`);
  }
}
process.stderr.write('\n');     // the progress line ends before the table starts
await page.evalJs(`for (const x of document.querySelectorAll('dialog[open]')) x.close(); 'ok'`);
await page.close();
console.log(rows.join('\n'));
if (expect) {
  console.log(failed ? `FAIL · ${failed} of ${rows.length}` : `PASS · ${rows.length} of ${rows.length}`);
  process.exit(failed ? 1 : 0);
}

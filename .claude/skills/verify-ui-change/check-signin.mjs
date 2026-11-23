#!/usr/bin/env node
/**
 * Claude Code signed out on a desk's host (costmo, 2026-11-19: "Host signs
 * in"). The desk's panel says so with a Sign in that has the host run Claude
 * Code's own sign-in; Send is dimmed with the reason; the tab pulses as for a
 * question (window.orchAttention's `asking`); a host from before Sign in gets
 * the button dimmed with why. And a host refused for its protocol (task
 * 337): every place the desk names its host says "refused", in the board's
 * words where there is room for them. The board's rules are in test:floor ("Claude
 * Code signed out on a host"), the host's in test:host; this is the page.
 *
 *   run-check-signin.sh <dir>       # the whole fixture; see there
 *
 * On seed-select.mjs's floor and host (h1, `testbox`): bo has a window and
 * four unread. The check sets the host's two columns itself, as a host's
 * registration would, and reads what the seed's host was handed.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { open } from './drive.mjs';

await import('../../../src/node-floor.js').catch((e) => { if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e; });
const REPO = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const Database = createRequire(`${REPO}/package.json`)('better-sqlite3');

const base = process.argv[2] ?? 'http://localhost:8953';
const DB = process.argv[4];
const WORK = process.argv[6];
let fails = 0;
let total = 0;
const ok = (cond, msg, extra = '') => { total++; console.log(`  ${cond ? '✓' : '✗'} ${msg}${cond || !extra ? '' : `  (${extra})`}`); if (!cond) fails++; };
const stopped = (e) => { total++; fails++; console.log(`  ✗ the check stopped on: ${String(e?.message ?? e).split('\n')[0]}`); console.log(`\nFAIL · ${fails} of ${total} red`); process.exit(1); };
process.on('uncaughtException', stopped);
process.on('unhandledRejection', stopped);
const db = new Database(DB);
const setHost = (signins, signedOut) => db.prepare(`UPDATE hosts SET signins = ?, signed_out = ? WHERE host_id = 'h1'`).run(signins, signedOut);
const work = () => readFileSync(WORK, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const until = (p, expr, what) => p.waitFor(expr, { timeout: 12000 })
  .catch(async () => { throw new Error(`${what} — not in 12 s; the panel reads ${JSON.stringify(await p.evalJs(`document.querySelector('#floor-panel .p-alert-slot')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null`))}`); });
const box = (p) => p.evalJs(`JSON.stringify((() => {
  const b = document.querySelector('#floor-panel .p-signin');
  const btn = b?.querySelector('[data-act="signin"]');
  return { box: !!b, text: b?.textContent.replace(/\\s+/g, ' ').trim() ?? '', button: btn ? { label: btn.textContent.trim(), disabled: btn.disabled } : null,
    send: document.querySelector('#floor-panel [data-act="send"]')?.disabled ?? null, placeholder: document.getElementById('p-text')?.placeholder ?? '' };
})())`).then(JSON.parse);
const asking = (p) => p.evalJs(`window.orchAttention?.get().asking ?? null`);

console.log('\nsigned out: the desk says so, and offers Sign in');
setHost(1, 1);
const alpha = await open({ base, view: 'floor', floor: 'alpha' });
await alpha.waitFor(`!!window.orchAttention && !!document.querySelector('.desk[data-agent="bo"]')`, { timeout: 12000 });
await alpha.evalJs(`window.floorOpenDesk('alpha', 'bo')`);
await until(alpha, `!!document.querySelector('#floor-panel .p-signin')`, 'bo\'s panel shows the sign-in box');
let s = await box(alpha);
ok(/Claude Code is signed out on testbox/.test(s.text), 'the box names the machine', s.text);
ok(s.button && s.button.label === 'Sign in' && !s.button.disabled, 'with Sign in, which can be pressed', JSON.stringify(s.button));
ok(!/\/login|claude auth/.test(s.text), 'and no command for the operator to type', s.text);
ok(s.send === true && /signed out on testbox/.test(s.placeholder), 'Send is dimmed, and the box says why', JSON.stringify([s.send, s.placeholder]));
ok(await asking(alpha) === true, 'the tab reports asking, so it pulses as for a question');

console.log('\npressing Sign in');
const before = work().filter((w) => w.kind === 'signin').length;
await alpha.press('#floor-panel [data-act="signin"]');
await until(alpha, `/finish signing in/.test(document.querySelector('#floor-panel .p-signin')?.textContent ?? '')`, 'the box shows the wait');
s = await box(alpha);
ok(/finish signing in, in the browser that opened on testbox/.test(s.text), 'the box says where to finish it', s.text);
ok(s.button === null, 'and the button is gone while it waits', JSON.stringify(s.button));
for (let i = 0; i < 40 && work().filter((w) => w.kind === 'signin').length === before; i++) await new Promise((r) => setTimeout(r, 250));
const handed = work().filter((w) => w.kind === 'signin').slice(before);
ok(handed.length === 1 && handed[0].agent === 'bo' && handed[0].channel === 'alpha', 'the host is handed one sign-in, for bo', JSON.stringify(handed));

console.log('\nsigned in again');
setHost(1, 0);
await until(alpha, `!document.querySelector('#floor-panel .p-signin')`, 'the box goes');
s = await box(alpha);
ok(!s.box && s.send === false, 'the box is gone and Send is back', JSON.stringify(s));
ok(await asking(alpha) === false, 'and the tab no longer reports asking');

console.log('\nsigned out, with the turn that found it out standing as an error');
// What a real signed-out desk shows (costmo on the app at b1a774a): the turn
// it was sent fails "authentication_failed: Not logged in · Please run
// /login", which stands on the session as awaiting 'error', and the box drew
// that error and no Sign in, in the one state Sign in is for (/login cannot
// run on a desk the host runs).
const setAwaiting = (kind, message) => db.prepare(`UPDATE agent_sessions SET awaiting_kind = ?, awaiting_message = ?, awaiting_since = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END WHERE channel = 'alpha' AND agent = 'bo'`).run(kind, message, kind);
const marked = setAwaiting('error', 'authentication_failed: Not logged in · Please run /login').changes;
ok(marked > 0, 'the fixture: bo\'s session carries the authentication error', String(marked));
setHost(1, 1);
await until(alpha, `!!document.querySelector('#floor-panel .p-signin [data-act="signin"]')`, 'the sign-in box, over the error');
s = await box(alpha);
ok(s.button && s.button.label === 'Sign in' && !s.button.disabled, 'Sign in is offered while the authentication error stands, and can be pressed', JSON.stringify(s.button));
ok(!/\/login/.test(s.text), 'and the box hands the operator no command', s.text);
setAwaiting(null, null);
setHost(1, 0);
await until(alpha, `!document.querySelector('#floor-panel .p-signin')`, 'the box goes again');

console.log('\na host from before Sign in');
setHost(0, 1);
await until(alpha, `!!document.querySelector('#floor-panel .p-signin [data-act="signin"]')`, 'the box is back');
s = await box(alpha);
ok(s.button?.disabled === true && s.button.label === 'Sign in', 'its Sign in is dimmed', JSON.stringify(s.button));
ok(/runs a build from before Sign in/.test(s.text), 'with why under it', s.text);
setHost(0, 0);

console.log('\na host refused for its protocol (F4, task 337)');
// What a registration refused for its protocol leaves on the host's row
// (hosts.refused, src/db.js), set here as check-signin sets its own two
// columns: the seed's host only touches last_seen, so nothing clears it. The
// words are protocolRefusal's for a 0.12.12 host. Measured on the rig at
// 8d769cb (task 336): the nameplate said "host refused" and the panel said
// "offline… Start it on that machine", which is the wrong remedy for a host
// that is running.
const REFUSED = 'The host "testbox" is behind this board: it sends no protocol version (build 0.12.12, from before there was one) and the board speaks protocol 1 (build 0.14.5). The two must match. Restart the host so it runs the clone\'s current code.';
db.prepare(`UPDATE hosts SET refused = ? WHERE host_id = 'h1'`).run(REFUSED);
await alpha.waitFor(`document.querySelector('#floor-rooms .desk[data-agent="bo"] .plateRole')?.textContent === 'bo · host refused'`, { timeout: 12000 }).catch(() => {});
const r = JSON.parse(await alpha.evalJs(`JSON.stringify({
  plate: document.querySelector('#floor-rooms .desk[data-agent="bo"] .plateRole')?.textContent ?? '',
  meta: document.querySelector('#floor-panel .p-meta')?.textContent ?? '',
  placeholder: document.getElementById('p-text')?.placeholder ?? '',
  hint: document.querySelector('#floor-panel .p-hint')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
  send: document.querySelector('#floor-panel [data-act="send"]')?.disabled ?? null })`));
ok(r.plate === 'bo · host refused', 'the nameplate says the host was refused', r.plate);
ok(/host testbox refused/.test(r.meta) && !/offline/.test(r.meta), 'and so does the panel\'s header, not "offline"', r.meta);
ok(/host was refused by this board/.test(r.placeholder), 'the box says why nothing can be sent', r.placeholder);
ok(r.hint === REFUSED, 'the hint is the board\'s own words, with the remedy that works', r.hint);
ok(!/Start it on that machine/.test(r.hint) && r.send === true, 'never "start it" for a host that is running, and Send is dimmed', JSON.stringify([r.hint.slice(0, 60), r.send]));
await alpha.click('#floor-rooms .desk[data-agent="bo"] .plate[data-act="details"]');
await alpha.waitFor(`!!document.getElementById('desk-pop')?.textContent`, { timeout: 8000 }).catch(() => {});
const card = await alpha.evalJs(`[...document.querySelectorAll('#desk-pop .dp-row')].map((n) => n.textContent.replace(/\\s+/g, ' ').trim()).find((t) => /^window/.test(t)) ?? ''`);
ok(/host testbox refused/.test(card) && !/offline/.test(card), 'the nameplate card\'s window row says it too', card);
db.prepare(`UPDATE hosts SET refused = NULL WHERE host_id = 'h1'`).run();
await alpha.waitFor(`!/refused/.test(document.querySelector('#floor-panel .p-meta')?.textContent ?? '')`, { timeout: 12000 })
  .then(() => ok(true, 'the refusal cleared, the panel reads as before'), () => ok(false, 'the refusal cleared, the panel reads as before'));

const errs = alpha.console().filter((x) => /^error/.test(x) && !/Failed to load resource/.test(x));
ok(errs.length === 0, 'no errors in the console', errs.join(' | '));
console.log(fails ? `\nFAIL · ${fails} of ${total} red` : `\nPASS · ${total} of ${total}`);
process.exit(fails ? 1 : 0);

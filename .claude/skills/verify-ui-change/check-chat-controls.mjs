#!/usr/bin/env node
/**
 * Drive the chat controls on a seeded desk (seed-desk.mjs) and print what the
 * page drew at each step — issues #9/#10/#15, 0.10.9. Measured 2026-11-03.
 *
 *   node --experimental-websocket .claude/skills/verify-ui-change/check-chat-controls.mjs http://localhost:8905 [out-dir] [channel] [agent] [key] [seed-host-id]
 *
 * Steps: the panel as opened (selects, meta line, rows); the slash menu on
 * "/co" and Tab completing it; a /btw from the box → one pending bubble →
 * the host's receipt + its `host` line posted as the seed host → no bubble,
 * one line "host · /btw … — answered in the window"; the model select →
 * "sonnet asked" beside it and the select holding the ask; PreModelSwitch /
 * PostModelSwitch through /api/ingest → asked-for cleared, header on the id;
 * a same-second /clear (SessionEnd + SessionStart source clear) → the new
 * session with the model and effort carried; the foot as two rows of two.
 * And since 2026-11-14: both selects untouched across three polls and a
 * turn (a MutationObserver's count, 0), their titles, and both dimmed with
 * the reason while the window asks something.
 * Hooks are posted to /api/ingest with the seed's key, host events to
 * /api/host/events as the seed host (h1 unless told otherwise) — the same
 * doors a real plugin and host use, so nothing here is a state no host
 * could have produced.
 */
import { open } from './drive.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const base = process.argv[2] ?? 'http://localhost:8905';
const out = process.argv[3] ?? tmpdir();
const CH = process.argv[4] ?? 'lab';
const AG = process.argv[5] ?? 'bo';
const KEY = process.argv[6] ?? 'k';
const HOSTID = process.argv[7] ?? 'h1';
const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = resolve(HERE, 'probe-chat-panel.js');
const SID = 'sess-' + AG;

const ingest = (body) => fetch(`${base}/api/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestratinator-key': KEY }, body: JSON.stringify({ channel: CH, agent: AG, session_id: SID, cwd: `/repo/${AG}`, ...body }) }).then((r) => r.json());
const hostEvents = (events) => fetch(`${base}/api/host/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestratinator-key': KEY }, body: JSON.stringify({ host_id: HOSTID, events }) }).then((r) => r.json());
const box = (text, enter = true) => `(() => { const ta = document.querySelector('#p-text'); ta.value = ${JSON.stringify(text)}; ta.dispatchEvent(new Event('input', { bubbles: true })); ${enter ? "ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));" : ''} return ta.value; })()`;

// The select facts carry a verdict (✓ / ✗, then PASS or FAIL), so a page
// mutant can be read off this check; the rest prints what the page drew.
let bad = 0;
const ok = (cond, label) => { console.log(`  ${cond ? '✓' : '✗'} ${label}`); if (!cond) bad++; };

const page = await open({ base, view: 'floor' });
await page.resize(1500, 1000);
await page.evalJs(`window.floorOpenDesk(${JSON.stringify(CH)}, ${JSON.stringify(AG)})`);
await page.waitFor(`document.querySelector('#floor-panel')?.dataset.agent === ${JSON.stringify(AG)}`);
await page.waitFor(`document.querySelector('#floor-panel [data-act="set-model"]')?.options.length > 0`, { timeout: 8000 });
const read = async () => JSON.parse(await page.probe(PROBE));
console.log('== as opened:', JSON.stringify((({ meta, model, effort, asked }) => ({ meta, model, effort, asked }))(await read())));

// The selects are left alone while nothing about them changes (2026-11-14).
// The panel is drawn again on every poll and every stream event, and both
// selects used to be emptied and refilled each time: a menu open over one
// was replaced under the pointer. Counted with a MutationObserver from here
// to the end of the run, and read first across three polls and a turn.
// (endsWith, not a regex: `\/` in a template string is `/`, and `//api…` is a comment.)
const polls = `performance.getEntriesByType('resource').filter((e) => e.name.endsWith('/api/floor')).length`;
await page.evalJs(`(() => { window.__sel = { rewrites: 0, polls: ${polls} };
  for (const s of document.querySelectorAll('#floor-panel [data-act="set-model"], #floor-panel [data-act="set-effort"]'))
    new MutationObserver((recs) => { window.__sel.rewrites += recs.length; }).observe(s, { childList: true });
  return 'ok'; })()`);
await hostEvents([{ type: 'turn', channel: CH, agent: AG, session_id: SID, role: 'assistant', text: 'a turn, so the stream draws the panel too', at: new Date().toISOString() }]);
await page.waitFor(`${polls} >= window.__sel.polls + 3`, { timeout: 20000 });
const early = await page.evalJs('window.__sel.rewrites');
console.log('== selects across three polls and a turn: rewrites', early);
ok(early === 0, 'neither select is rewritten while nothing about it changes — an open menu is left standing');
const titles = await page.evalJs(`[...document.querySelectorAll('#floor-panel .p-sel')].map((s) => s.title)`);
console.log('== titles:', JSON.stringify(titles));
ok(titles.length === 2 && titles.every((t) => /default for new sessions/.test(t) && !/session only/.test(t)), 'each says a choice is saved as the default for new sessions');

// A window that is asking takes no choice: Send sends nothing then, and a
// select that took a pick would drop it without a word. Dimmed, with why.
await ingest({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } });
await page.waitFor(`document.querySelector('#floor-panel [data-act="set-model"]').disabled`, { timeout: 8000 });
const asking = await page.evalJs(`[...document.querySelectorAll('#floor-panel .p-sel')].map((s) => ({ disabled: s.disabled, title: s.title }))`);
console.log('== while the window asks:', JSON.stringify(asking), 'send disabled:', await page.evalJs(`document.querySelector('#floor-panel [data-act="send"]').disabled`));
ok(asking.every((x) => x.disabled && /is asking something/.test(x.title)), 'while the window asks, both are dimmed and say why — a pick then would be dropped');
// A Stop closes the prompt: one of the four hooks that mean work happened (CLEARS_AWAITING).
await ingest({ hook_event_name: 'Stop' });
await page.waitFor(`!document.querySelector('#floor-panel [data-act="set-model"]').disabled`, { timeout: 8000 });
ok(true, 'and both take a choice again once the prompt is gone');

await page.evalJs(box('/co', false));
let r = await read(); console.log('== slash menu on /co:', JSON.stringify({ hidden: r.slashHidden, rows: r.slashRows }));
await page.evalJs(`(() => { const ta = document.querySelector('#p-text'); ta.focus(); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); return ta.value; })()`);
r = await read(); console.log('== after Tab:', JSON.stringify({ textarea: r.textarea }));
await page.evalJs(box(''));

await page.evalJs(box('/btw what is 6*7? reply with just the number'));
await page.waitFor(`document.querySelectorAll('#p-turns .t-pending').length === 1`);
console.log('== /btw pending:', await page.evalJs(`document.querySelector('#p-turns .t-pending .t-when').textContent`));
await hostEvents([
  { type: 'turn', channel: CH, agent: AG, session_id: SID, role: 'context', text: '/btw what is 6*7? reply with just the number — answered in the window', tool_name: 'host', at: new Date().toISOString() },
  { type: 'turn', channel: CH, agent: AG, session_id: SID, role: 'assistant', text: '42', via: '/btw', at: new Date().toISOString() },
  { type: 'receipt', channel: CH, agent: AG, session_id: SID, command: 'btw', said: 'answered in the window', text: '/btw what is 6*7? reply with just the number' },
]);
await page.waitFor(`document.querySelectorAll('#p-turns .t-pending').length === 0`, { timeout: 8000 });
r = await read(); console.log('== after the receipt: pending 0; last rows:', JSON.stringify(r.rows.slice(-2).map((x) => x.text)));
await page.shot(`${out}/chat-btw.png`, '#floor-panel');

await page.evalJs(`(() => { const s = document.querySelector('#floor-panel [data-act="set-model"]'); s.value = 'sonnet'; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
await page.waitFor(`!document.querySelector('#floor-panel .p-asked').classList.contains('hidden')`, { timeout: 8000 });
r = await read(); console.log('== model select → sonnet:', JSON.stringify({ model: r.model.value, asked: r.asked.text }));
await ingest({ hook_event_name: 'PreModelSwitch', from_model: 'claude-haiku-5-5', to_model: 'claude-sonnet-5-5', requested_model: 'sonnet', source: 'picker' });
await ingest({ hook_event_name: 'PostModelSwitch', from_model: 'claude-haiku-5-5', to_model: 'claude-sonnet-5-5', requested_model: 'sonnet', source: 'picker' });
await page.waitFor(`document.querySelector('#floor-panel .p-asked').classList.contains('hidden')`, { timeout: 10000 });
r = await read(); console.log('== confirmed by the hooks:', JSON.stringify({ model: r.model.value, meta: r.meta }));

await ingest({ hook_event_name: 'Stop', effort_level: 'medium' });
await ingest({ hook_event_name: 'PreCompact', trigger: 'manual' });
await ingest({ hook_event_name: 'SessionEnd', reason: 'clear' });
await fetch(`${base}/api/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestratinator-key': KEY }, body: JSON.stringify({ channel: CH, agent: AG, session_id: SID + '-2', cwd: `/repo/${AG}`, hook_event_name: 'SessionStart', source: 'clear' }) });
await page.waitFor(`document.querySelector('#floor-panel .p-meta').textContent.includes('medium effort')`, { timeout: 10000 });
r = await read(); console.log('== after a same-second /clear:', JSON.stringify({ model: r.model.value, effort: r.effort.value, meta: r.meta, bubble: r.bubble }));
const whole = await page.evalJs('window.__sel.rewrites');
console.log('== selects over the whole run: rewrites', whole);
ok(whole === 2, 'over the whole run each is rewritten once — its placeholder row leaving when the window first named a model, and an effort — and a model changed twice and a session once without another');
await page.shot(`${out}/chat-foot.png`, '#floor-panel .p-foot', { pad: 10 });
await page.close();
console.log(`shots: ${out}/chat-btw.png ${out}/chat-foot.png`);
console.log(bad ? `FAIL · ${bad} of the select checks` : 'PASS · the selects');
process.exitCode = bad ? 1 : 0;

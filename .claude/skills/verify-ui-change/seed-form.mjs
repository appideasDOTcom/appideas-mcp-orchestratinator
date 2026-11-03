#!/usr/bin/env node
/**
 * A hosted desk holding an AskUserQuestion form, on a throwaway server — the
 * fixture for any check of the question panel (tabs, the free-text row, the
 * lines under the form, Submit).
 *
 *   seed-form.mjs <base-url> [--channel page-check] [--agent typist] [--key k]
 *
 * Two things that cost a round when this was first done (2026-11-02):
 *
 * - **The form is not drawn until a host answers the prompt.** The hook's
 *   PermissionRequest (through /api/ingest, with `tool_input.questions`)
 *   gives the board the call, and the board keeps it as `asked`; but the
 *   panel draws `permission.questions`, which `settleForm` fills only when
 *   the host's `prompt` event arrives. So this takes the host's work and
 *   answers it as a host that could read no form off the pane — then the
 *   form is drawn from the call, every tab and row from the questions below.
 * - **The host goes stale in 90 s.** Re-registered every 20 s for as long as
 *   this runs, as seed-desk.mjs does.
 *
 * The questions: two single-selects (each gets a "Type something." row) and
 * one multi-select, so a check can tick the free-text row on a single-choice
 * question and on a multi and see the difference.
 */
const args = process.argv.slice(2);
const BASE = args[0];
if (!BASE) { console.error('usage: seed-form.mjs <base-url> [--channel c] [--agent a] [--key k]'); process.exit(1); }
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const CH = opt('--channel', 'page-check'), AG = opt('--agent', 'typist'), KEY = opt('--key', 'k');
const HK = { 'content-type': 'application/json', 'x-orchestratinator-key': KEY };
const HOST = 'h1';

const register = () => fetch(`${BASE}/api/host/register`, { method: 'POST', headers: HK, body: JSON.stringify({ host_id: HOST, name: 'testbox', tmux: 'deskside', desks: [{ channel: CH, agent: AG, cwd: `/repo/${AG}`, window: '@9' }] }) });
const ingest = (body) => fetch(`${BASE}/api/ingest`, { method: 'POST', headers: HK, body: JSON.stringify({ channel: CH, agent: AG, session_id: `s-${AG}`, cwd: `/repo/${AG}`, ...body }) });
const deskOf = async () => (await fetch(`${BASE}/api/floor`).then((r) => r.json())).channels.find((c) => c.channel === CH)?.desks.find((d) => d.agent === AG);

console.log('register', (await register()).status);
console.log('session ', (await ingest({ hook_event_name: 'SessionStart' })).status);
const questions = [
  { header: 'Colour', question: 'Which colour should the probe use for its accent?', multiSelect: false, options: [{ label: 'Blue', description: 'cool' }, { label: 'Orange', description: 'warm' }] },
  { header: 'Fruit', question: 'Which fruit goes in the bowl?', multiSelect: false, options: [{ label: 'Apple', description: 'crisp' }, { label: 'Mango', description: 'soft' }] },
  { header: 'Days', question: 'Which weekdays work?', multiSelect: true, options: [{ label: 'Monday', description: 'early' }, { label: 'Friday', description: 'late' }] },
];
console.log('prompt  ', (await ingest({ hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: { questions } })).status);
const work = await fetch(`${BASE}/api/host/work?host_id=${HOST}&wait=0`, { headers: HK }).then((r) => r.json());
console.log('work    ', (work.work ?? []).map((w) => w.kind).join(' ') || '(none)');
const rid = (await deskOf())?.permission?.request_id;
const ev = await fetch(`${BASE}/api/host/events`, { method: 'POST', headers: HK, body: JSON.stringify({ host_id: HOST, events: [{ type: 'prompt', channel: CH, agent: AG, request_id: rid, options: [], questions: null, tabs: null, form_error: 'the window is asking, and no question form’s header is on its 80x24 pane' }] }) }).then((r) => r.json());
console.log('prompt event', JSON.stringify(ev));
const desk = await deskOf();
console.log('form    ', desk?.permission?.questions?.map((q) => `${q.tab_title}[${q.kind},${q.options.length}]`).join(' ') ?? 'NONE', '| hosted', !!desk?.hosted, '| from', desk?.permission?.form_from);
console.log(`open the floor, click .desk[data-agent="${AG}"] .deskHit, wait on #floor-panel .p-ask`);
setInterval(register, 20000);

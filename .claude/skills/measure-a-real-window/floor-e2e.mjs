#!/usr/bin/env node
/**
 * The floor, end to end, on a real Claude Code: a board, the tree's host, and
 * a desk on a scratch folder, driven through the board's own routes (what
 * the page's buttons send). Where protocol-probe.mjs asks "does Claude Code
 * still speak the protocol", this asks "does the floor still work on it".
 *
 *   . scripts/node-floor.sh && node .claude/skills/measure-a-real-window/floor-e2e.mjs <board> <host id> <folder> [<floor>]
 *
 * The board and host are a scratch pair (a scratch Docker board and a host
 * started by hand with its own ORCH_HOST_ID and ORCH_HOST_ROOTS), never the
 * operator's. Costs a dozen short model turns on the signed-in account.
 *
 * Left out on purpose: /model and /effort (from the floor they save the
 * machine's default for new sessions, by costmo's ruling, so here they would
 * change the operator's settings; test:claude holds the save), and the two
 * handoffs, which open VS Code or a terminal on the operator's screen.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const [BOARD = 'http://127.0.0.1:8981', HOST = 'dev-browser-test', FOLDER, CH = 'e2e'] = process.argv.slice(2);
if (!FOLDER) { console.error('usage: floor-e2e.mjs <board> <host id> <folder> [<floor>]'); process.exit(2); }
const AGENT = FOLDER.split('/').filter(Boolean).at(-1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
let total = 0;
const row = (ok, what, saw = '') => { total++; if (!ok) fails++; console.log(`  ${ok ? '✓' : '✗'} ${what}${saw ? `  — ${String(saw).replace(/\s+/g, ' ').slice(0, 200)}` : ''}`); };
const json = (path, body) => fetch(`${BOARD}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const until = async (fn, ms = 60_000, every = 500) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(every); } };
const desk = async () => ((await (await json('/api/floor')).json()).channels.find((c) => c.channel === CH)?.desks ?? []).find((d) => d.agent === AGENT) ?? null;
const rows = async () => ((await (await json(`/api/floor/turns?channel=${CH}&agent=${AGENT}&limit=500`)).json()).rows ?? []);
const lastId = async () => Math.max(0, ...(await rows()).map((r) => r.id));
const since = async (mark) => (await rows()).filter((r) => r.id > mark);
const chat = async (text) => { const r = await json('/api/floor/chat', { channel: CH, agent: AGENT, text }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const reply = (mark, re, ms = 120_000) => until(async () => (await since(mark)).find((r) => r.role === 'assistant' && re.test(r.text ?? '')) ?? null, ms);
const hostLine = (mark, re, ms = 60_000) => until(async () => (await since(mark)).find((r) => r.tool_name === 'host' && re.test(r.text ?? '')) ?? null, ms);
const asking = (ms = 120_000) => until(async () => { const d = await desk(); return d?.permission?.request_id ? d.permission : null; }, ms);
const idle = (ms = 60_000) => until(async () => { const d = await desk(); return d && !d.working ? true : null; }, ms);

console.log(`floor e2e: ${BOARD}, host ${HOST}, ${FOLDER} as ${CH}/${AGENT}`);

console.log('\ntaking the desk');
const took = await json('/api/floor/desk', { host_id: HOST, path: FOLDER, channel: CH, agent: AGENT });
row(took.status === 200, 'Take a desk on the scratch folder is taken', `${took.status} ${JSON.stringify(await took.json().catch(() => ({})))}`);
row(!!(await until(async () => (await desk())?.hosted?.live ? true : null, 60_000)), 'and the desk is seated, live on its host');

console.log('\na message');
let mark = await lastId();
let c = await chat('Reply with exactly: E2E-ONE');
row(c.status === 200, 'a message is taken', JSON.stringify(c));
row(!!(await reply(mark, /E2E-ONE/)), 'the desk\'s Claude Code starts and its reply reaches the floor');
row(!!(await until(async () => ((await desk())?.hosted?.held === 'floor' ? true : null), 20_000)), 'held by the floor', JSON.stringify((await desk())?.hosted));
row(!!(await idle()), 'and the desk reads idle once the turn ends');

console.log('\na permission');
mark = await lastId();
await chat('Use the Bash tool to run exactly this command: touch e2e-made.txt && echo E2E-BASH . Then reply with its output.');
let p = await asking();
row(!!p, 'it stands on the desk', p?.summary);
row((p?.options ?? []).some((o) => /don't ask again/.test(o.text)), 'with the "don\'t ask again" row Claude Code offered', JSON.stringify(p?.options?.map((o) => o.text)));
c = await chat('are you there?');
row(c.status === 409 && c.body.code === 'asking', 'a message while it asks is refused, in words', JSON.stringify(c.body).slice(0, 160));
row((await json('/api/floor/permission', { channel: CH, agent: AGENT, request_id: p?.request_id, decision: 'allow' })).status === 200, 'Approve is taken');
row(!!(await reply(mark, /E2E-BASH/)) && existsSync(join(FOLDER, 'e2e-made.txt')), 'the command ran');
row(!(await desk())?.permission, 'and the box is gone');
await idle();
mark = await lastId();
await chat('Use the Bash tool to run exactly: touch e2e-denied.txt');
p = await asking();
row((await json('/api/floor/permission', { channel: CH, agent: AGENT, request_id: p?.request_id, decision: 'deny', reason: 'not that file' })).status === 200, 'Deny is taken');
await idle(120_000);
row(!existsSync(join(FOLDER, 'e2e-denied.txt')), 'and the command did not run');

console.log('\na question');
mark = await lastId();
await chat('Use the AskUserQuestion tool to ask me exactly two questions in one call: "Pick a colour" with options Red and Blue, and "Pick a day" with options Monday and Friday. Then reply with exactly the two answers you received.');
p = await asking();
row(p?.questions?.length === 2, 'the desk shows a form of its two questions', JSON.stringify(p?.questions?.map((q) => q.question)));
// The form's own "type something" row (formFromInput marks it `other`).
const typed = (p?.questions?.[1]?.options ?? []).find((o) => o.other)?.n ?? 3;
const ans = await json('/api/floor/answer', { channel: CH, agent: AGENT, request_id: p?.request_id, answers: [{ choose: [2] }, { choose: [typed], text: 'Saturday, actually' }] });
row(ans.status === 200, 'Submit is taken', `${ans.status} ${JSON.stringify(await ans.json().catch(() => ({})))}`);
const got = await reply(mark, /Blue/);
row(!!got && /Saturday/.test(got.text), 'and Claude Code got both answers, typed words included', got?.text);
await idle();

console.log('\ncommands');
mark = await lastId();
await chat('/btw Reply with exactly: E2E-BTW');
row(!!(await until(async () => (await since(mark)).find((r) => r.via === '/btw' && /E2E-BTW/.test(r.text ?? '')) ?? null, 90_000)), '/btw is answered on the desk, apart from the conversation');
mark = await lastId();
await chat('/mcp');
const mcpLine = await hostLine(mark, /^\/mcp — /);
row(!!mcpLine && /Reconnected/.test(mcpLine.text), '/mcp reconnects the desk\'s board server, said on the desk', mcpLine?.text);
mark = await lastId();
await chat('/compact');
row(!!(await until(async () => (await since(mark)).find((r) => r.role === 'context' && r.tool_name === 'compact') ?? null, 240_000)), '/compact compacts, and its boundary is a line on the desk');
row(!!(await idle(60_000)), 'and the desk is idle after it, with no hook needed');
const before = (await desk())?.hosted?.session_id;
mark = await lastId();
await chat('/clear');
const after = await until(async () => { const s = (await desk())?.hosted?.session_id; return s && s !== before ? s : null; }, 60_000);
row(!!after, '/clear puts the desk on a new conversation', `${before} → ${after}`);
await idle();
mark = await lastId();
await chat('Reply with exactly: E2E-AFTER-CLEAR');
row(!!(await reply(mark, /E2E-AFTER-CLEAR/)), 'and the next message is answered there, relayed from that conversation\'s transcript');

console.log('\na working desk');
mark = await lastId();
await chat('Write a 1200-word story about a lighthouse keeper. Use no tools. End it with the word E2E-STORY.');
row(!!(await until(async () => ((await desk())?.working ? true : null), 30_000)), 'the desk reads working while it writes');
c = await chat('Also, after the story, add the word E2E-MID.');
row(c.status === 200, 'a message to it while it works is taken');
row(!!(await until(async () => ((await desk())?.delivery?.state === 'queued' ? true : null), 20_000)), 'and said as queued into the turn', JSON.stringify((await desk())?.delivery));
row(!!(await reply(mark, /E2E-MID/, 240_000)), 'and answered');
await idle(120_000);
mark = await lastId();
await chat('Write a 1500-word story about a ship in a bottle. Use no tools.');
await until(async () => ((await desk())?.working ? true : null), 30_000);
await sleep(2000);
const tStop = Date.now();
row((await json('/api/floor/interrupt', { channel: CH, agent: AGENT })).status === 200, 'the stop sign is taken');
row(!!(await idle(15_000)), `and the turn stops (${Date.now() - tStop} ms)`);

console.log(`\n${fails ? 'FAIL' : 'PASS'} · ${total - fails} of ${total}`);
process.exit(fails ? 1 : 0);

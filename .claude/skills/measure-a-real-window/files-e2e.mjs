#!/usr/bin/env node
/**
 * board.files on a real Claude Code (M3, costmo's decision 21): two desks on
 * a scratch board, one asked in plain words to send the other a file with the
 * send_file tool, and the other asked to read what arrived. Proves a real
 * agent finds and uses the tool, the host reads and stages the file, and the
 * receiving agent gets a path it can open.
 *
 *   . scripts/node-floor.sh && node .claude/skills/measure-a-real-window/files-e2e.mjs <board> <host id> <folders dir>
 *
 * The board and host are a scratch pair, as for floor-e2e.mjs (bare board,
 * the tree's host started by hand with its own id, roots and config). Keep
 * the host's config in a folder apart from the board's database: each puts
 * an `uploads` folder beside its own (the board's staged copies, the host's
 * received ones), and the same folder for both makes the host's write fail
 * EEXIST on the board's file (the first run). Costs a handful of model turns
 * on the signed-in account.
 */
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const [BOARD, HOST, DIR] = process.argv.slice(2);
if (!DIR) { console.error('usage: files-e2e.mjs <board> <host id> <folders dir>'); process.exit(2); }
const CH = 'files-e2e';
const root = realpathSync(DIR);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; let total = 0;
const row = (ok, what, saw = '') => { total++; if (!ok) fails++; console.log(`  ${ok ? '✓' : '✗'} ${what}${saw ? `  — ${String(saw).replace(/\s+/g, ' ').slice(0, 240)}` : ''}`); };
const json = (path, body) => fetch(`${BOARD}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const until = async (fn, ms = 120_000, every = 700) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(every); } };
const desk = async (a) => ((await (await json('/api/floor')).json()).channels.find((c) => c.channel === CH)?.desks ?? []).find((d) => d.agent === a) ?? null;
const rows = async (a) => ((await (await json(`/api/floor/turns?channel=${CH}&agent=${a}&limit=500`)).json()).rows ?? []);

const MARK = `FILE-E2E-${Date.now()}`;
for (const a of ['sender', 'receiver']) mkdirSync(join(root, a), { recursive: true });
writeFileSync(join(root, 'sender', 'notes.txt'), `${MARK}\nsecond line\n`);
await json('/api/floor/browse', { host_id: HOST, path: root });
await sleep(2500);
for (const a of ['sender', 'receiver']) {
  const r = await json('/api/floor/desk', { host_id: HOST, path: join(root, a), channel: CH, agent: a });
  row(r.status === 200, `${a}: Take a desk`, `${r.status} ${JSON.stringify(await r.json().catch(() => ({})))}`);
}
row(!!(await until(async () => (await desk('sender'))?.hosted?.live && (await desk('receiver'))?.hosted?.live ? true : null, 60_000)), 'both desks are seated, live on the host');

// The receiver must be running before a message can be delivered to it; a first word wakes it.
await json('/api/floor/chat', { channel: CH, agent: 'receiver', text: 'Reply with exactly: READY' });
row(!!(await until(async () => (await rows('receiver')).some((r) => r.role === 'assistant' && /READY/.test(r.text ?? '')))), 'the receiver is up');

await json('/api/floor/chat', { channel: CH, agent: 'sender', text: 'Use the send_file tool from the orchestratinator board to send the file notes.txt (in your folder) to the agent named receiver, with the note "please read this". Then reply with exactly SENT-OK if the tool said it was sent, or the tool\'s error if not.' });
const said = await until(async () => (await rows('sender')).find((r) => r.role === 'assistant' && /SENT-OK|error|refus|could not/i.test(r.text ?? '')), 180_000);
row(/SENT-OK/.test(said?.text ?? ''), 'the sender\'s Claude Code calls send_file and is told it was sent', said?.text);
const toolUse = (await rows('sender')).find((r) => r.role === 'tool' && /send_file/.test(`${r.tool_name ?? ''} ${r.text ?? ''}`));
row(!!toolUse, 'its transcript shows the send_file call', toolUse?.text ?? toolUse?.tool_name);

const got = await until(async () => (await rows('receiver')).find((r) => r.role === 'user' && /notes\.txt/.test(r.text ?? '')), 120_000);
row(!!got, 'the receiver is sent a message naming the file');
row(got?.from === 'sender', 'from the sender, as the page draws it', JSON.stringify({ from: got?.from }));
row(/Attached by sender:\n- \/.*notes\.txt/.test(got?.text ?? '') && /please read this/.test(got?.text ?? ''), 'with the note, and the file listed as attached by the sender at a path on this computer', got?.text);

await json('/api/floor/chat', { channel: CH, agent: 'receiver', text: 'Read the file that was just attached to the previous message and reply with exactly its first line.' });
const read = await until(async () => (await rows('receiver')).find((r) => r.role === 'assistant' && r.text?.includes(MARK)), 180_000);
// Only with the file delivered: the receiver can also find the sender's copy
// in the folder beside its own, which proves nothing (the first run did).
row(!!got && !!read, 'the receiver\'s Claude Code opens the delivered path and reads the file\'s first line', read?.text);

console.log(fails ? `\nFAIL · ${fails} of ${total} red` : `\nPASS · ${total} of ${total}`);
process.exit(fails ? 1 : 0);

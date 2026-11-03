#!/usr/bin/env node
/**
 * The second half of a withdrawn form: the one message that carries every
 * answer, sent through the host's own `send()`, and the receipt read back.
 *
 *   clarify.mjs <dir> '<answers json>'
 *
 * Run it straight after `form.mjs` has played a typed answer on a
 * single-choice question (its last keys `N Enter`, tool result "The user
 * doesn't want to proceed…"). It finds that call in the transcript, builds
 * the message the board would queue (`clarifyMessage` in src/floor.js, from
 * the call's own input and the same answers), pastes it with `send()`, and
 * prints the user record and the agent's reply — the only honest receipt.
 *
 * Measured 2026-11-02 on 2.1.300 (issue #7, round 2): tool_result at
 * :22.866Z, send() ok in 3.2 s, user record at :29.867Z reading exactly
 * "Colour: Orange. Fruit: I like Dragon Fruit. Weekday: Friday." That string
 * is the ruling; if this prints something else, the ruling is not what runs.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const [dir, answersJson] = process.argv.slice(2);
if (!dir || !answersJson) { console.error('usage: clarify.mjs <dir> \'<answers json>\''); process.exit(1); }
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SOCK = process.env.PROBE_SOCKET ?? 'probe';
if (!process.env.ORCH_TMUX) {
  const wrapper = join(resolve(dir), '.tmux-probe.sh');
  if (!existsSync(wrapper)) { writeFileSync(wrapper, `#!/bin/bash\nexec tmux -L ${SOCK} "$@"\n`); chmodSync(wrapper, 0o755); }
  process.env.ORCH_TMUX = wrapper;
}
process.env.ORCH_TMUX_SESSION = 'p';
const W = await import(`${REPO}/host/window.js`);
const { clarifyMessage, formFromInput } = await import(`${REPO}/src/floor.js`);

const t = (...a) => execFileSync('tmux', ['-L', SOCK, ...a], { encoding: 'utf8' });
const cap = () => t('capture-pane', '-p', '-t', 'p:probe');
const records = () => {
  const d = join(homedir(), '.claude', 'projects', resolve(dir).replace(/[/.]/g, '-'));
  const f = readdirSync(d).filter((x) => x.endsWith('.jsonl')).map((x) => ({ x, m: statSync(join(d, x)).mtimeMs })).sort((a, b) => b.m - a.m)[0];
  return readFileSync(join(d, f.x), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};
const blocks = () => records().flatMap((r) => (Array.isArray(r.message?.content) ? r.message.content.map((b) => ({ ...b, ts: r.timestamp })) : []));
const typed = () => records().filter((r) => r.type === 'user' && typeof r.message?.content === 'string');

const call = blocks().filter((b) => b.type === 'tool_use' && b.name === 'AskUserQuestion').pop();
if (!call) { console.log('no AskUserQuestion in the transcript — run form.mjs first'); process.exit(1); }
const result = blocks().find((b) => b.type === 'tool_result' && b.tool_use_id === call.id);
console.log(`tool_use       → ${call.ts} headers ${call.input.questions.map((q) => q.header).join('/')}`);
console.log(`tool_result    → ${result ? `${result.ts} ${JSON.stringify(result.content).slice(0, 120)}` : 'NONE — the form is still open; nothing to clarify'}`);
if (!result) process.exit(1);
const form = formFromInput(call.input.questions);
const msg = clarifyMessage(form.questions, JSON.parse(answersJson));
console.log(`clarifyMessage → ${JSON.stringify(msg)}`);
const n0 = typed().length;
const t0 = Date.now();
const r = await W.send(resolve(dir), msg);
console.log(`send()         → ${JSON.stringify({ ok: r.ok, code: r.code, error: r.error })} in ${Date.now() - t0} ms`);
for (let i = 0; i < 120 && /esc to interrupt/i.test(W.footOf(cap())); i++) await sleep(500);
await sleep(2500);
for (const u of typed().slice(n0)) console.log(`user record    → ${u.timestamp} ${JSON.stringify(u.message.content)}`);
const last = records().filter((x) => x.type === 'assistant').pop();
const text = (last?.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
console.log(`agent reply    → ${last?.timestamp} ${JSON.stringify(text).slice(0, 300)}`);

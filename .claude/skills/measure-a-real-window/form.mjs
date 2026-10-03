#!/usr/bin/env node
/**
 * A real AskUserQuestion on the probe window, read every way the floor reads
 * one — and, if asked, answered through the host's own code.
 *
 *   form.mjs <dir> '<what to ask for>' ['<answers json>']
 *
 *   form.mjs "$SP/probe" 'two single-select questions: header "One", question
 *     "Which one?", options Alpha, Bravo; header "Two", question "And which?",
 *     options Red, Green' '[{"choose":[1]},{"choose":[2]}]'
 *
 * The probe must be up (`probe.mjs up`). Without answers the form is cancelled
 * with Escape; with them, `answerSteps` → `answerQuestion` are played and the
 * tool result is read back out of the transcript, which is the only honest
 * receipt. It prints, in order: the pane's size, what `readQuestions` made of
 * the pane, the form built from the call's own input (`formFromInput`), which
 * of the two `settleForm` would draw, the keys, what the host returned, and
 * what the window recorded.
 *
 * Three things this is built around, each learned on 2.1.284 (2026-10-01):
 *
 * - **The instruction is typed, not pasted.** A window given only a pasted
 *   block declines to act on it ("Your message contained only pasted text…")
 *   and asks for the instruction in the person's own words. `send-keys -l`
 *   is typing.
 * - **The open call is the last AskUserQuestion with no result.** A call that
 *   fails validation — two questions with the same text — is in the transcript
 *   with an error result milliseconds later, and the model's retry is the form
 *   on screen. Taking the first call measured the wrong one once.
 * - **Pane size is the variable.** A form taller than the pane loses its top
 *   rows; resize first (`tmux -L probe resize-window -t p:probe -x 80 -y 24`)
 *   to see what a window nobody is attached to shows.
 *
 * Late keys: point ORCH_TMUX at a wrapper that delays one `send-keys` to see
 * what a stalled window looks like from the host — the reading calls here go
 * straight to the socket, so only the host's own keys are delayed.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const [dir, spec, answersJson] = process.argv.slice(2);
if (!dir || !spec) { console.error('usage: form.mjs <dir> \'<what to ask for>\' [\'<answers json>\']'); process.exit(1); }
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SOCK = process.env.PROBE_SOCKET ?? 'probe';

// host/window.js runs `tmux` on the default socket. A wrapper is how it is
// pointed at the probe's, and both variables are read when it is imported.
if (!process.env.ORCH_TMUX) {
  const wrapper = join(resolve(dir), '.tmux-probe.sh');
  if (!existsSync(wrapper)) { writeFileSync(wrapper, `#!/bin/bash\nexec tmux -L ${SOCK} "$@"\n`); chmodSync(wrapper, 0o755); }
  process.env.ORCH_TMUX = wrapper;
}
process.env.ORCH_TMUX_SESSION = 'p';
const W = await import(`${REPO}/host/window.js`);
const { answerSteps, formFromInput, settleForm, unansweredOf } = await import(`${REPO}/src/floor.js`);

const t = (...a) => execFileSync('tmux', ['-L', SOCK, ...a], { encoding: 'utf8' });
const cap = (n) => t('capture-pane', '-p', '-t', 'p:probe', ...(n ? ['-S', `-${n}`] : []));
const parts = () => {
  const d = join(homedir(), '.claude', 'projects', resolve(dir).replace(/[/.]/g, '-'));
  const f = readdirSync(d).filter((x) => x.endsWith('.jsonl')).map((x) => ({ x, m: statSync(join(d, x)).mtimeMs })).sort((a, b) => b.m - a.m)[0];
  return readFileSync(join(d, f.x), 'utf8').split('\n').filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .flatMap((r) => (Array.isArray(r.message?.content) ? r.message.content : []));
};
const shape = (qs) => qs.map((q) => `${q.tab_title}[${q.kind},${q.options.length}${q.strip ? '' : ',no strip'}]`).join(' ');

for (let i = 0; i < 100 && /esc to interrupt/i.test(W.footOf(cap())); i++) await sleep(300);
t('send-keys', '-t', 'p:probe', '-l', `Call AskUserQuestion exactly once, now, with ${spec}. A display fixture for measuring how the form is drawn and answered. Nothing else; after it returns reply with the single word done.`);
await sleep(1200);
t('send-keys', '-t', 'p:probe', 'Enter');
let asking = null;
for (let i = 0; i < 600 && !asking; i++) { await sleep(100); asking = W.askingOf(cap(12)); }
if (!asking) { console.log('the window never asked. Its pane:'); console.log(cap()); process.exit(1); }
await sleep(1500);   // let it stop drawing

console.log(`pane ${t('display-message', '-p', '-t', 'p:probe', '#{pane_width}x#{pane_height} alternate_on=#{alternate_on}').trim()}; top line ${JSON.stringify(cap().split('\n')[0])}`);
const read = await W.readQuestions(resolve(dir));
console.log(`readQuestions  → ${read.ok ? shape(read.questions) : JSON.stringify(read)}`);
const closed = new Set(parts().filter((p) => p.type === 'tool_result').map((p) => p.tool_use_id));
const call = parts().filter((p) => p.type === 'tool_use' && p.name === 'AskUserQuestion' && !closed.has(p.id)).pop();
if (!call) { console.log('no open AskUserQuestion in the transcript'); process.exit(1); }
const built = formFromInput(call.input.questions);
console.log(`formFromInput  → ${built ? shape(built.questions) : 'null'}`);
if (read.ok && built) {
  const rows = (qs) => JSON.stringify(qs.map((q) => [q.tab_title, q.strip, q.kind, q.options.map((o) => [o.n, o.text, !!o.other, o.checked])]));
  console.log(`  rows, numbers, free-text rows, kinds and strip: ${rows(read.questions) === rows(built.questions) ? 'IDENTICAL' : `DIFFER\n  pane  ${rows(read.questions)}\n  built ${rows(built.questions)}`}`);
}
const settled = settleForm(built, read.ok ? read.questions : null, read.tabs);
console.log(`settleForm     → from=${settled.from}: ${settled.said}`);

if (!answersJson || !settled.questions) {
  t('send-keys', '-t', 'p:probe', 'Escape');
  console.log('cancelled with Escape');
  process.exit(0);
}
const answers = JSON.parse(answersJson);
console.log(`unansweredOf   → ${JSON.stringify(unansweredOf(settled.questions, answers))}`);
const steps = answerSteps(settled.questions, answers);
console.log(`answerSteps    → ${steps.map((s) => (s.text !== undefined ? `text(${s.text.length})` : s.key)).join(' ') || '(no keys)'}`);
if (!steps.length) { t('send-keys', '-t', 'p:probe', 'Escape'); console.log('nothing to play; cancelled with Escape'); process.exit(0); }
const t0 = Date.now();
const r = await W.answerQuestion(resolve(dir), steps);
console.log(`answerQuestion → ok=${r.ok} code=${r.code ?? '-'} done=[${(r.done ?? []).join(' ')}] in ${Date.now() - t0} ms${r.error ? `\n  ${r.error}` : ''}`);
await sleep(3500);
const result = parts().find((c) => c.type === 'tool_result' && c.tool_use_id === call.id);
console.log(`tool result    → ${result ? JSON.stringify(typeof result.content === 'string' ? result.content : result.content?.map((c) => c.text).join(' ')).slice(0, 400) : 'NONE — the window recorded no answer'}`);
console.log(`askingOf now   → ${JSON.stringify(W.askingOf(cap(12)))}`);
if (!r.ok && W.askingOf(cap(12))) { t('send-keys', '-t', 'p:probe', 'Escape'); console.log('left standing; cancelled with Escape'); }

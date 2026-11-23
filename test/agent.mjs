#!/usr/bin/env node
/**
 * host/agent.js: one desk's Claude Code through stream-JSON (costmo's
 * ruling, 2026-11-22, replacing the window layer).
 *
 * Against a stand-in that speaks the protocol the way 2.1.330 was measured
 * to (docs/stream-json-spike.md): an `init` at start, a message echoed with
 * its uuid and `isReplay` when taken, a `result` at a turn's end, a
 * `can_use_tool` request for a permission or a question, a
 * `conversation_reset` for /clear, and an answer to each control request.
 * What the stand-in does on purpose, by the words of a message:
 *   PERMIT <tool>   asks permission for <tool> and says what it was told
 *   ASK             asks a two-question form and says the answers it got
 *   SLOW <ms>       a turn that takes that long
 *   /clear          a new conversation
 *   DIE             the process ends with code 3, mid-turn
 *   IGNORE          is never taken (no echo), for the not-taken path
 *   anything else   "ECHO:<words>"
 */
import { writeFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Agent, readRecord, agentArgs, userLine } from '../host/agent.js';

let failures = 0;
const assert = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) failures++; };
const eq = (actual, expected, msg) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? '✓' : '✗'} ${msg}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
  if (!ok) failures++;
};
const next = (agent, event, ms = 5000) => new Promise((res) => {
  const t = setTimeout(() => res(null), ms);
  agent.once(event, (v) => { clearTimeout(t); res(v); });
});

const FIX = resolve(`./data/agent-fixture-${process.pid}`);
mkdirSync(FIX, { recursive: true });
const STAND = `${FIX}/claude.mjs`;
writeFileSync(STAND, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
const argv = process.argv.slice(2);
const at = argv.indexOf('--resume');
let session = at >= 0 ? argv[at + 1] : randomUUID();
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
// No init at start: 2.1.330 writes one at each turn's start, the first
// with the first message (measured through host/agent.js on the real one).
const init = () => out({ type: 'system', subtype: 'init', session_id: session, model: 'claude-haiku-5-5', permissionMode: 'default', claude_code_version: '2.1.330' });
let busy = null;
let n = 0;
const waits = new Map();
const result = (text, ok = true, subtype = 'success') => { busy = null; inTurn = false; out({ type: 'result', subtype, is_error: !ok, result: text, session_id: session }); };
const ask = (request) => new Promise((res) => { const id = 'cu-' + (++n); waits.set(id, res); out({ type: 'control_request', request_id: id, request }); });
let pending = 0;
let inTurn = false;
let closing = false;
const done = () => { if (closing && pending === 0) process.exit(0); };
createInterface({ input: process.stdin }).on('line', async (line) => {
  const r = JSON.parse(line);
  if (r.type === 'control_response') { const w = waits.get(r.response.request_id); if (w) { waits.delete(r.response.request_id); w(r.response.response); } return; }
  if (r.type === 'control_request') {
    const q = r.request;
    const reply = (response) => out({ type: 'control_response', response: { subtype: 'success', request_id: r.request_id, response } });
    if (q.subtype === 'interrupt') { reply({ still_queued: [] }); if (busy) { clearTimeout(busy); out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }); result('', false, 'error_during_execution'); pending--; done(); } return; }
    if (q.subtype === 'set_model') { reply({ model: 'claude-' + q.model + '-5-5' }); return; }
    if (q.subtype === 'side_question') { reply({ response: 'ASIDE:' + q.question, synthetic: false }); return; }
    if (q.subtype === 'refuse_me') { out({ type: 'control_response', response: { subtype: 'error', request_id: r.request_id, error: 'not supported' } }); return; }
    if (q.subtype === 'never_answer') return;
    reply({});
    return;
  }
  if (r.type !== 'user') return;
  const text = r.message.content;
  if (text === 'IGNORE') return;
  // Taken into a turn already running, as 2.1.330 does: echoed when taken,
  // answered in that turn's one result (measured: DONE-SLEEP and MIDTURN in one).
  if (inTurn) { out({ type: 'user', uuid: r.uuid, isReplay: true, message: { role: 'user', content: text } }); return; }
  inTurn = true;
  pending++;
  init();
  out({ type: 'user', uuid: r.uuid, isReplay: true, message: { role: 'user', content: text } });
  if (text === 'DIE') process.exit(3);
  if (text.startsWith('PERMIT ')) {
    const tool = text.slice(7);
    const a = await ask({ subtype: 'can_use_tool', tool_name: tool, display_name: tool, input: { command: 'ls' }, description: 'List files', permission_suggestions: [{ type: 'addRules', rules: [{ toolName: tool, ruleContent: 'ls' }], behavior: 'allow', destination: 'localSettings' }] });
    result(a.behavior === 'allow' ? 'ALLOWED:' + JSON.stringify(a.updatedInput) + (a.updatedPermissions ? ':ALWAYS' : '') : 'DENIED:' + a.message);
  } else if (text === 'ASK') {
    const input = { questions: [{ question: 'Pick a colour', header: 'Colour', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] }, { question: 'Pick a day', header: 'Day', multiSelect: false, options: [{ label: 'Monday' }, { label: 'Friday' }] }] };
    const a = await ask({ subtype: 'can_use_tool', tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion', input });
    result(a.behavior === 'allow' ? 'ANSWERS:' + JSON.stringify(a.updatedInput.answers) : 'DENIED:' + a.message);
  } else if (text.startsWith('SLOW ')) {
    await new Promise((res) => { busy = setTimeout(() => { res(); }, Number(text.slice(5))); });
    if (busy) result('SLOW-DONE');
    else { pending--; done(); return; }
  } else if (text === '/clear') {
    session = randomUUID();
    out({ type: 'conversation_reset', new_conversation_id: session, trigger: 'clear' });
    init();
    result('');
  } else {
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'ECHO:' + text }] } });
    result('ECHO:' + text);
  }
  pending--;
  done();
});
process.stdin.on('end', () => { closing = true; done(); });
`);
chmodSync(STAND, 0o755);

console.log('agent');
try {
  console.log('\n  what a record means (readRecord), as 2.1.330 writes them');
  eq(readRecord({ type: 'system', subtype: 'init', session_id: 'S', model: 'm', permissionMode: 'default', claude_code_version: '2.1.330' }),
    { kind: 'init', session_id: 'S', model: 'm', mode: 'default', version: '2.1.330' }, 'an init names the session, the model, the mode and the version');
  eq(readRecord({ type: 'user', uuid: 'u1', isReplay: true }), { kind: 'taken', uuid: 'u1' }, 'a replayed user record is the receipt for the message of that uuid');
  eq(readRecord({ type: 'user', uuid: 'u2', message: { content: [{ type: 'tool_result' }] } }), null, 'a tool result is not a receipt');
  eq(readRecord({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '', session_id: 'S' }),
    { kind: 'result', ok: false, subtype: 'error_during_execution', text: '', session_id: 'S' }, 'a result says whether the turn ended well');
  eq(readRecord({ type: 'conversation_reset', new_conversation_id: 'S2' }), { kind: 'reset', session_id: 'S2' }, '/clear names the new conversation');
  eq(readRecord({ type: 'system', subtype: 'status', status: 'compacting' }), { kind: 'status', status: 'compacting', compact: null }, 'compacting begins');
  eq(readRecord({ type: 'control_request', request_id: 'r', request: { subtype: 'can_use_tool', tool_name: 'Bash', display_name: 'Bash', input: { command: 'ls' }, description: 'd', permission_suggestions: [1] } }),
    { kind: 'permission', request_id: 'r', tool: 'Bash', title: 'Bash', input: { command: 'ls' }, description: 'd', suggestions: [1] }, 'a permission is the tool, its input, what it is for, and the rules that would allow it again');
  eq(readRecord({ type: 'control_request', request_id: 'q', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'x' }] } } }).kind, 'question', 'AskUserQuestion is a question, not a permission');
  eq(readRecord({ type: 'control_request', request_id: 'd', request: { subtype: 'request_user_dialog', title: 'T' } }).kind, 'ask', 'anything else Claude Code asks is kept, never dropped');
  eq(readRecord({ type: 'rate_limit_event' }), null, 'a record the host has no use for is nothing');
  assert(agentArgs({ resume: 'S1', mcpConfig: '/x.json' }).join(' ') === '-p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio --replay-user-messages --resume S1 --mcp-config /x.json',
    'the command line: stream-JSON both ways, permissions over stdin, every message echoed, then the resume and the binding');
  eq(JSON.parse(userLine('hi', 'u')), { type: 'user', uuid: 'u', message: { role: 'user', content: 'hi' } }, 'a message carries the uuid its receipt will name');

  console.log('\n  a process');
  const a = new Agent({ cwd: FIX, claude: STAND, env: process.env });
  a.start();
  eq([a.alive, a.sessionId], [true, null], 'a new process is running, on no conversation yet: Claude Code names it at the first message');
  const started = next(a, 'init');
  const r1Done = next(a, 'result');
  const s1 = await a.send('hello');
  const init = await started;
  assert(!!init?.session_id && a.sessionId === init.session_id, `and with that message it says which conversation it is on (${init?.session_id})`);
  eq([s1.ok, typeof s1.uuid], [true, 'string'], 'a message is delivered when Claude Code takes it: its own echo');
  const r1 = await r1Done;
  eq([r1?.ok, r1?.text, a.working], [true, 'ECHO:hello', false], 'and the turn ends in a result, the process idle again');

  const slowDone = next(a, 'result', 8000);
  const slow = await a.send('SLOW 600');
  assert(slow.ok && a.working, 'a message that starts a turn leaves the process working');
  const mid = a.send('during');
  assert((await mid).ok, 'a message sent while it worked is taken into that turn');
  eq([(await slowDone)?.text, a.working], ['SLOW-DONE', false], 'and the turn ends once, in one result');

  console.log('\n  permissions and questions');
  const permAsked = next(a, 'permission');
  const permDone = next(a, 'result');
  await a.send('PERMIT Bash');
  const perm = await permAsked;
  eq([perm?.tool, perm?.input, perm?.description, perm?.suggestions?.length], ['Bash', { command: 'ls' }, 'List files', 1], 'a permission arrives as data: the tool, its input, what for, and the rule that would allow it again');
  eq(a.allow(perm.request_id).ok, true, 'and is allowed with one call');
  eq((await permDone)?.text, 'ALLOWED:{"command":"ls"}', 'which Claude Code reads as allowed, with the input it asked for');
  eq(a.allow(perm.request_id).code, 'stale_request', 'a second answer to it is refused: it is no longer open');
  const alwaysAsked = next(a, 'permission');
  const alwaysDone = next(a, 'result');
  await a.send('PERMIT Bash');
  const always = await alwaysAsked;
  a.allow(always.request_id, null, always.suggestions);
  eq((await alwaysDone)?.text, 'ALLOWED:{"command":"ls"}:ALWAYS', 'and allowed for good with its own suggested rule');
  const denyAsked = next(a, 'permission');
  const denyDone = next(a, 'result');
  await a.send('PERMIT Write');
  a.deny((await denyAsked).request_id, 'not that file');
  eq((await denyDone)?.text, 'DENIED:not that file', 'a refusal carries the operator\'s reason');
  const qAsked = next(a, 'question');
  const qDone = next(a, 'result');
  await a.send('ASK');
  const q = await qAsked;
  eq(q?.questions.map((x) => x.header), ['Colour', 'Day'], 'a question arrives with every question it asks');
  a.allow(q.request_id, { ...q.input, answers: { 'Pick a colour': 'Blue', 'Pick a day': 'Friday' } });
  eq((await qDone)?.text, 'ANSWERS:{"Pick a colour":"Blue","Pick a day":"Friday"}', 'and is answered by its answers');

  console.log('\n  control requests');
  eq(await a.control('set_model', { model: 'sonnet' }), { ok: true, response: { model: 'claude-sonnet-5-5' } }, 'a model change is a request with an answer that names the model');
  eq((await a.control('side_question', { question: 'two plus two' })).response?.response, 'ASIDE:two plus two', 'a side question (/btw) is answered outside the conversation');
  eq(await a.control('refuse_me'), { ok: false, error: 'not supported' }, 'a refused request says so');
  eq((await a.control('never_answer', {}, { timeoutMs: 300 })).code, 'no_answer', 'and one never answered is said as that, not waited on for ever');
  const intDone = next(a, 'result', 8000);
  await a.send('SLOW 5000');
  eq((await a.control('interrupt')).ok, true, 'a stop is a request');
  eq((await intDone)?.subtype, 'error_during_execution', 'and the turn ends interrupted');
  const resetSeen = next(a, 'reset');
  const before = a.sessionId;
  await a.send('/clear');
  const reset = await resetSeen;
  assert(!!reset?.session_id && reset.session_id !== before && a.sessionId === reset.session_id, '/clear moves the process onto the new conversation');
  await next(a, 'result');

  console.log('\n  when it is not there');
  const notTaken = await a.send('IGNORE', { timeoutMs: 300 });
  eq(notTaken.code, 'not_taken', 'a message never taken is said as not taken, not as sent');
  const exit = next(a, 'exit');
  const dying = await a.send('DIE');
  eq(dying.ok, true, 'a message the process takes and then dies on was still taken');
  const ex = await exit;
  eq([ex?.code, a.alive], [3, false], 'its end is said, with its code');
  eq((await a.send('after')).code, 'no_process', 'and nothing is sent to a process that is gone');
  eq((await a.control('set_model', { model: 'x' })).code, 'no_process', 'nor asked of it');

  console.log('\n  resuming, and stopping');
  const b = new Agent({ cwd: FIX, claude: STAND, resume: init.session_id });
  b.start();
  eq(b.sessionId, init.session_id, 'a resumed process is on the conversation it was asked for from the start');
  const bInit = next(b, 'init');
  const bDone = next(b, 'result');
  await b.send('again');
  eq((await bInit)?.session_id, init.session_id, 'and Claude Code says the same at its first turn');
  await bDone;
  const stopped = await b.stop({ graceMs: 2000 });
  eq([stopped?.code, b.alive], [0, false], 'a stop closes its input and it leaves of itself');
} catch (err) {
  console.log(`  ✗ the suite stopped: ${err.stack}`);
  failures++;
} finally {
  rmSync(FIX, { recursive: true, force: true });
}
console.log(failures ? `\nagent: ${failures} failed` : '\nagent: all passed');
process.exit(failures ? 1 : 0);

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
import { Agent, readRecord, agentArgs, userLine, spawnPlan, winQuote } from '../host/agent.js';

let failures = 0;
const assert = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) failures++; };
const eq = (actual, expected, msg) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? '✓' : '✗'} ${msg}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
  if (!ok) failures++;
};
const next = (agent, event, ms = 5000, pred = () => true) => new Promise((res) => {
  const t = setTimeout(() => { agent.off(event, on); res(null); }, ms);
  function on(v) { if (!pred(v)) return; clearTimeout(t); agent.off(event, on); res(v); }
  agent.on(event, on);
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
// \`completed\` for each message of the turn comes after its result, and
// \`cancelled\` after a failed one's (2.1.330, measured 2026-11-22: result at
// 1162 ms, completed at 1164; a signed-out turn's result, then cancelled).
const taken = [];
const result = (text, ok = true, subtype = 'success') => { busy = null; inTurn = false; out({ type: 'result', subtype, is_error: !ok, result: text, session_id: session }); for (const u of taken.splice(0)) out({ type: 'command_lifecycle', command_uuid: u, state: ok ? 'completed' : 'cancelled' }); };
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
    // An interrupt while an ask stands, as 2.1.330 answers it (QA, msg 4100):
    // control_cancel_request naming the ask, then the turn ends.
    if (q.subtype === 'interrupt' && waits.size) { reply({ still_queued: [] }); for (const id of [...waits.keys()]) { waits.delete(id); out({ type: 'control_cancel_request', request_id: id }); } result('', false, 'error_during_execution'); pending--; done(); return; }
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
  // The receipt, as 2.1.330 gives it: command_lifecycle queued the moment a
  // message arrives, whatever the turn is doing.
  out({ type: 'command_lifecycle', command_uuid: r.uuid, state: 'queued' });
  taken.push(r.uuid);
  // A reply written with no tool (a long text): 2.1.330 echoes the message
  // only when the reply is done, with its result. Only the lifecycle record
  // says it was taken before then.
  if (text.startsWith('LONGTEXT ')) {
    inTurn = true;
    pending++;
    init();
    out({ type: 'command_lifecycle', command_uuid: r.uuid, state: 'started' });
    await new Promise((res) => setTimeout(res, Number(text.slice(9))));
    out({ type: 'user', uuid: r.uuid, isReplay: true, message: { role: 'user', content: text } });
    result('LONGTEXT-DONE');
    pending--;
    done();
    return;
  }
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
    // As 2.1.330 does it: the reset names a conversation id that is not the
    // session's; the init after it names the session.
    out({ type: 'conversation_reset', new_conversation_id: randomUUID(), trigger: 'clear' });
    session = randomUUID();
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
  eq(readRecord({ type: 'command_lifecycle', command_uuid: 'u1', state: 'queued' }), { kind: 'taken', uuid: 'u1', state: 'queued' }, 'the receipt is command_lifecycle, the moment Claude Code has the message');
  eq(readRecord({ type: 'user', uuid: 'u1', isReplay: true }), { kind: 'taken', uuid: 'u1', state: 'echo' }, 'and a replayed user record is one too, for a Claude Code that sends no lifecycle');
  eq(readRecord({ type: 'user', uuid: 'u2', message: { content: [{ type: 'tool_result' }] } }), null, 'a tool result is not a receipt');
  eq(readRecord({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '', session_id: 'S' }),
    { kind: 'result', ok: false, subtype: 'error_during_execution', text: '', session_id: 'S' }, 'a result says whether the turn ended well');
  eq(readRecord({ type: 'conversation_reset', new_conversation_id: 'S2' }), { kind: 'reset', conversation: 'S2' }, '/clear\'s reset carries no session id: its id is not the session\'s');
  eq(readRecord({ type: 'system', subtype: 'status', status: 'compacting' }), { kind: 'status', status: 'compacting', compact: null }, 'compacting begins');
  eq(readRecord({ type: 'control_request', request_id: 'r', request: { subtype: 'can_use_tool', tool_name: 'Bash', display_name: 'Bash', input: { command: 'ls' }, description: 'd', permission_suggestions: [1] } }),
    { kind: 'permission', request_id: 'r', tool: 'Bash', title: 'Bash', input: { command: 'ls' }, description: 'd', suggestions: [1] }, 'a permission is the tool, its input, what it is for, and the rules that would allow it again');
  eq(readRecord({ type: 'control_request', request_id: 'q', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'x' }] } } }).kind, 'question', 'AskUserQuestion is a question, not a permission');
  eq(readRecord({ type: 'control_request', request_id: 'd', request: { subtype: 'request_user_dialog', title: 'T' } }).kind, 'ask', 'anything else Claude Code asks is kept, never dropped');
  eq(readRecord({ type: 'rate_limit_event' }), null, 'a record the host has no use for is nothing');
  assert(agentArgs({ resume: 'S1', mcpConfig: '/x.json' }).join(' ') === '-p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio --replay-user-messages --resume S1 --mcp-config /x.json',
    'the command line: stream-JSON both ways, permissions over stdin, every message echoed, then the resume and the binding');
  eq(JSON.parse(userLine('hi', 'u')), { type: 'user', uuid: 'u', message: { role: 'user', content: 'hi' } }, 'a message carries the uuid its receipt will name');
  // How Claude Code is started (task 348 F7, pc-developer: with only an npm
  // claude.cmd on PATH the desk never started; Node will not spawn a .cmd
  // without a shell).
  eq(spawnPlan('claude', ['-p', '--resume', 'abc'], '/bin/zsh', 'darwin'), ['/bin/zsh', ['-c', 'exec "$0" "$@"', 'claude', '-p', '--resume', 'abc'], {}], 'through the person\'s shell on a Mac, exec\'d so the pid is Claude Code\'s');
  eq(spawnPlan('C:\\Users\\a\\.local\\bin\\claude.exe', ['-p'], null, 'win32'), ['C:\\Users\\a\\.local\\bin\\claude.exe', ['-p'], {}], 'claude.exe on Windows, started as it is');
  const cmdPlan = spawnPlan('C:\\Program Files\\nodejs\\claude.cmd', ['-p', '--mcp-config', 'C:\\Users\\Jo Ann\\x.json'], null, 'win32');
  eq([cmdPlan[0], cmdPlan[1].slice(0, 3), cmdPlan[2]], ['cmd.exe', ['/d', '/s', '/c'], { windowsVerbatimArguments: true }], 'an npm claude.cmd through cmd.exe, which can start it');
  eq(cmdPlan[1][3], '""C:\\Program Files\\nodejs\\claude.cmd" -p --mcp-config "C:\\Users\\Jo Ann\\x.json""', 'with each argument that needs it quoted, a space in a path included');
  eq([winQuote('-p'), winQuote('a b'), winQuote('say "hi"'), winQuote('C:\\dir\\')], ['-p', '"a b"', '"say \\"hi\\""', 'C:\\dir\\'], 'quoted by the rules node and claude.exe parse a command line by');

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
  // Claude Code says the message \`completed\` just after the result (2.1.330,
  // measured). That is the end of a message, not the start of a turn.
  await new Promise((res) => setTimeout(res, 150));
  eq(a.working, false, 'and stays idle once the lifecycle says the message completed, which comes after the result');

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
  // While a permission stands, a message is not taken by Claude Code until
  // it is answered (the protocol probe, 2.1.330): refused before it is
  // written, so it is never said "not taken" and then delivered anyway.
  const heldAsked = next(a, 'permission');
  const heldDone = next(a, 'result');
  await a.send('PERMIT Bash');
  const held = await heldAsked;
  const refused = await a.send('a message while it asks');
  eq([refused.ok, refused.code], [false, 'asking'], 'a message while a permission stands is refused, not written');
  assert(/waiting on an answer to what it asked \(permission for Bash\)/.test(refused.error ?? ''), 'saying what it waits on', refused.error);
  a.allow(held.request_id);
  await heldDone;
  eq((await a.send('after the answer')).ok, true, 'and once it is answered, a message is taken again');
  await next(a, 'result');
  // Stopped while it asks: Claude Code withdraws the ask (control_cancel_request),
  // and the process takes messages again (QA, measured on 2.1.330, msg 4100).
  const cancelAsked = next(a, 'permission');
  const cancelSeen = next(a, 'cancelled');
  await a.send('PERMIT Bash');
  const toCancel = await cancelAsked;
  eq((await a.control('interrupt')).ok, true, 'the fixture: a stop while it asks');
  eq((await cancelSeen)?.request_id, toCancel?.request_id, 'a withdrawn ask is read as withdrawn, by its id');
  eq(a.asks.size, 0, 'and is no longer held as asking');
  const afterCancel = await a.send('after the withdrawn ask');
  eq(afterCancel.ok, true, 'so the next message is taken, not refused as waiting on an answer');
  await next(a, 'result');
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
  await new Promise((res) => setTimeout(res, 150));
  eq(a.working, false, 'and the process stays idle once the lifecycle says the message was cancelled, which comes after a failed turn\'s result');
  const resetSeen = next(a, 'reset');
  const before = a.sessionId;
  // Read in the reset's own emit, before the init's line can land.
  let atReset;
  a.once('reset', () => { atReset = a.sessionId; });
  const initAfter = next(a, 'init', 5000, (m) => m.session_id !== before);
  await a.send('/clear');
  const reset = await resetSeen;
  const init2 = await initAfter;
  assert(!!init2?.session_id && init2.session_id !== before && a.sessionId === init2.session_id, '/clear moves the process onto the new session the init after it names');
  assert(reset?.conversation && reset.conversation !== init2?.session_id, 'never onto the id the reset names, which is not on disk');
  eq(atReset, null, 'and between the reset and that init it is on no conversation, never on the reset\'s id');
  await next(a, 'result');

  console.log('\n  a reply longer than the receipt timeout');
  const longDone = next(a, 'result', 6000);
  const longTaken = await a.send('LONGTEXT 1500', { timeoutMs: 500 });
  eq(longTaken.ok, true, 'a message whose reply takes longer than the wait is taken by its lifecycle receipt, not said "not taken" (its echo comes with the result)');
  eq((await longDone)?.text, 'LONGTEXT-DONE', 'and its reply arrives');

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

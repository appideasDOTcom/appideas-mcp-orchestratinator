/**
 * The protocol probe: does this Claude Code still speak what the host reads?
 * (task 351, costmo 2026-11-23: "Orchestratinator breaks every time anything
 * comes in even with the slightest difference from before.")
 *
 * A real Claude Code started through this host's own process code
 * (host/agent.js, the person's shell, the window environment) in a scratch
 * folder, on haiku, checking each thing the host relies on as measured on
 * 2.1.330 (docs/stream-json-spike.md). Every row carries what it saw, so a
 * difference reads as the difference. About a dozen short haiku turns on the
 * account `claude` is signed in with.
 *
 * Run two ways: by the host, once for each Claude Code version it has not
 * checked (Host.canaryCheck in host/index.js), with the rows that differed
 * put on the floor; and by hand, through
 * .claude/skills/measure-a-real-window/protocol-probe.mjs, which prints them.
 *
 * Never: /model or /effort typed (the terminal's commands save the machine's
 * default; the controls sent here are session-only). ~/.claude/settings.json
 * is read before and after: a change is a red row, and the file is put back.
 * The folder is the caller's and is kept between runs, so Claude Code's own
 * list of projects gains one entry, the same one each time, not one a run.
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Agent, userLine } from './agent.js';
import { windowEnv, shellFor } from './claude.js';

/**
 * Run the probe. Returns { rows: [{ ok, what, saw }], version, fails, total }.
 * \`say\` receives each section title and row line as it goes.
 */
/**
 * The node that runs the probe's own MCP server. Not \`process.execPath\`
 * under the desktop app: there it is Electron's helper binary, whose
 * run-as-node fuse is off, so the server never started and Claude Code
 * answered "Connection closed" for its reconnect (costmo's scratch app at
 * b1a774a: the floor's banner read 31 of 32, a difference in this host, not
 * in Claude Code). The Node the app carries, through the link it keeps
 * beside the host (the plugin's hook uses the same link), else a \`node\` on
 * PATH. \`ORCH_CANARY_NODE\` outranks both.
 */
export function probeNode({ env = process.env, versions = process.versions, execPath = process.execPath, home = homedir(), exists = existsSync } = {}) {
  if (env.ORCH_CANARY_NODE) return env.ORCH_CANARY_NODE;
  if (!versions.electron) return execPath;
  const carried = join(home, '.orchestratinator', 'bin', 'node');
  return exists(carried) ? carried : 'node';
}

export async function probeClaude({ claude = 'claude', model = 'haiku', dir, say = () => {} } = {}) {
  const rows = [];
  let fails = 0;
  let total = 0;
  let version = null;
  const row = (ok, what, saw = '') => {
    total++;
    if (!ok) fails++;
    const s = saw ? String(saw).replace(/\s+/g, ' ').slice(0, 220) : '';
    rows.push({ ok: !!ok, what, saw: s });
    say(`  ${ok ? '✓' : '✗'} ${what}${s ? `  — ${s}` : ''}`);
  };
  const SETTINGS = join(homedir(), '.claude', 'settings.json');
  const settingsBefore = existsSync(SETTINGS) ? readFileSync(SETTINGS) : null;
  const hash = (b) => (b ? createHash('sha256').update(b).digest('hex').slice(0, 12) : 'none');
  const DIR = dir;
  mkdirSync(DIR, { recursive: true });
  // A server of its own, so mcp_reconnect has one to reconnect: the smallest
  // stdio MCP server that answers.
  const SERVER = join(DIR, 'mcp-server.cjs');
  writeFileSync(SERVER, `
const rl = require('readline').createInterface({ input: process.stdin });
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
rl.on('line', (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.id === undefined) return;
  if (m.method === 'initialize') say({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '0' } } });
  else if (m.method === 'tools/list') say({ jsonrpc: '2.0', id: m.id, result: { tools: [] } });
  else say({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method' } });
});
`);
  const MCP = join(DIR, 'mcp.json');
  // The node that runs this file runs the server: under the desktop app
  // that is not a \`node\` on PATH, so it is named.
  writeFileSync(MCP, JSON.stringify({ mcpServers: { probe: { command: probeNode(), args: [SERVER] } } }));
  const CWD = join(DIR, 'work');
  rmSync(CWD, { recursive: true, force: true });
  mkdirSync(CWD, { recursive: true });
  const CLAUDE = claude;
  const MODEL = model;
  let a = null;
  try {
  const records = [];
  const start = (resume = null) => {
    // In default mode whatever the person's settings say: its rows measure a
    // permission being asked, and under a `defaultMode` of auto nothing asks,
    // so every launch would read as Claude Code having changed (measured on
    // 2.1.331: settings auto and no flag, init auto; with this flag, default).
    const a = new Agent({ cwd: CWD, env: windowEnv(), resume, mcpConfig: MCP, model: MODEL, permissionMode: 'default', claude: CLAUDE, shell: process.platform === 'win32' ? null : shellFor() });
    a.on('record', (r) => records.push({ at: Date.now(), r }));
    a.start();
    return a;
  };
  const next = (a, kind, ms = 90_000, pred = () => true) => new Promise((res) => {
    const t = setTimeout(() => { a.off(kind, on); res(null); }, ms);
    function on(m) { if (!pred(m)) return; clearTimeout(t); a.off(kind, on); res(m); }
    a.on(kind, on);
  });
  const turn = async (a, text, ms = 120_000) => {
    const ended = next(a, 'result', ms);
    const taken = await a.send(text);
    return { taken, result: await ended };
  };

  say(`protocol probe: ${CLAUDE}, model ${MODEL}, in ${CWD}`);
  a = start();

  say('\nstarting');
  await sleep(3000);
  row(!records.some(({ r }) => r.type === 'system' && r.subtype === 'init'), 'nothing is said before the first message (no init at start)', records.map(({ r }) => `${r.type}/${r.subtype ?? ''}`).join(' '));
  row(!a.exited, 'and the process is still running, waiting on its input', a.exited ? JSON.stringify(a.exited) : '');

  say('\na message');
  const initP = next(a, 'init');
  let t = await turn(a, 'Reply with exactly: PROBE-ONE');
  const init = await initP;
  row(t.taken.ok, 'it is taken: the message comes back with our uuid and isReplay', t.taken.error);
  row(!!init?.session_id, 'an init names the session', JSON.stringify(init));
  say(`    Claude Code ${init?.version ?? '(no claude_code_version in init)'} · model ${init?.model} · mode ${init?.mode}`);
  row(t.result?.ok && /PROBE-ONE/.test(t.result.text), 'the turn ends in one result, with the reply', JSON.stringify(t.result));
  const SID = init?.session_id;

  say('\na long reply');
  // The receipt is command_lifecycle `queued`, the moment Claude Code has the
  // message; the echo comes when the message is written into the conversation,
  // which for a reply with no tool is when the reply ends (2.1.330).
  const longEnd = next(a, 'result', 180_000);
  const tLong = Date.now();
  const longTaken = await a.send('Write a 500-word story about a harbour. Use no tools.', { timeoutMs: 120_000 });
  const takenMs = Date.now() - tLong;
  const longRes = await longEnd;
  const endMs = Date.now() - tLong;
  row(records.some(({ r }) => r.type === 'command_lifecycle' && r.state === 'queued'), 'command_lifecycle records are sent (the host\'s receipt)');
  row(longTaken.ok && takenMs < 5000 && takenMs < endMs - 2000, `a message is receipted at once, long before its reply ends (receipt ${takenMs} ms, result ${endMs} ms)`);
  void longRes;

  say('\na permission, and a message sent mid-turn');
  let perm = next(a, 'permission');
  let ended = next(a, 'result', 120_000);
  // A command that changes something: Claude Code runs a read-only one (echo,
  // sleep) without asking, so only this kind is a permission on any machine.
  let taken = await a.send('Use the Bash tool to run exactly this command: touch probe-made.txt && sleep 5 && echo PROBE-BASH . Then reply with its output.');
  let p = await perm;
  row(taken.ok && !!p, 'a tool needing permission is asked as can_use_tool', p ? `${p.tool}: ${JSON.stringify(p.input).slice(0, 80)}` : 'no request');
  row(Array.isArray(p?.suggestions) && p.suggestions.length > 0, 'with permission_suggestions (the "don\'t ask again" row)', JSON.stringify(p?.suggestions ?? null));
  const resultsBefore = records.filter(({ r }) => r.type === 'result').length;
  // What the host's hold rests on (Agent.send, F17): written raw while the
  // permission stands, a message is not taken until the permission is answered.
  const heldUuid = randomUUID();
  const tHeld = Date.now();
  a.write(userLine('Ignore this line; it only tests delivery.', heldUuid));
  const takenHeld = () => records.some(({ r }) => r.type === 'user' && r.isReplay && r.uuid === heldUuid);
  await sleep(6000);
  row(!takenHeld(), 'a message written while a permission stands is not taken while it stands (the host holds it, and starts its receipt clock at the answer)');
  a.allow(p?.request_id);
  for (let i = 0; i < 60 && !takenHeld(); i++) await sleep(250);
  row(takenHeld(), `and is taken once the permission is answered (${Date.now() - tHeld} ms after it was written)`);
  await sleep(1500);
  // Sent while the allowed command runs (its sleep 5), so the turn is running.
  const mid = await a.send('Also end your reply with the word PROBE-MID.');
  row(mid.ok, 'a message sent while the turn runs is taken at once', mid.error);
  let res = await ended;
  row(res?.ok && /PROBE-BASH/.test(res.text), 'the allowed command ran', res?.text);
  await sleep(4000);
  const extra = records.filter(({ r }) => r.type === 'result').length - resultsBefore;
  row(/PROBE-MID/.test(res?.text ?? '') || extra >= 2, `the mid-turn message is answered (in that turn's result, or one more turn: ${extra} result(s))`, res?.text);

  say('\na permission denied');
  perm = next(a, 'permission');
  ended = next(a, 'result', 120_000);
  await a.send('Use the Bash tool to run exactly: touch probe-denied.txt');
  p = await perm;
  a.deny(p?.request_id, 'The operator declined this.');
  res = await ended;
  row(!!p && !!res && !existsSync(join(CWD, 'probe-denied.txt')), 'a deny ends the turn without running it', res?.text);

  say('\na question');
  const q = next(a, 'question');
  ended = next(a, 'result', 120_000);
  await a.send('Use the AskUserQuestion tool to ask me exactly two questions in one call: "Pick a colour" with options Red and Blue, and "Pick a day" with options Monday and Friday. Then reply with exactly the two answers you received, nothing else.');
  const qq = await q;
  row((qq?.questions?.length ?? 0) === 2, 'AskUserQuestion arrives as can_use_tool with its questions in the input', JSON.stringify(qq?.questions?.map((x) => x.question)));
  const answers = Object.fromEntries((qq?.questions ?? []).map((x, i) => [x.question, i === 0 ? 'Blue' : 'Saturday, actually']));
  a.allow(qq?.request_id, { ...(qq?.input ?? {}), answers });
  res = await ended;
  row(/Blue/.test(res?.text ?? '') && /Saturday/.test(res?.text ?? ''), 'answered by allowing it with answers, typed words taken as an answer', res?.text);

  say('\ncontrols');
  let c = await a.control('set_model', { model: 'sonnet' });
  row(c.ok, 'set_model is answered', JSON.stringify(c));
  c = await a.control('set_model', { model: MODEL });
  c = await a.control('apply_flag_settings', { settings: { effortLevel: 'low' } });
  row(c.ok, 'apply_flag_settings (effort) is answered', JSON.stringify(c));
  c = await a.control('side_question', { question: 'Reply with exactly: PROBE-BTW' }, { timeoutMs: 90_000 });
  row(c.ok && /PROBE-BTW/.test(JSON.stringify(c.response ?? '')), 'side_question (/btw) answers in its response', JSON.stringify(c).slice(0, 200));
  c = await a.control('mcp_reconnect', { serverName: 'probe' }, { timeoutMs: 60_000 });
  row(c.ok, 'mcp_reconnect of the folder\'s server is answered', JSON.stringify(c));
  c = await a.control('mcp_reconnect', { serverName: 'no-such-server' }, { timeoutMs: 30_000 });
  row(!c.ok, 'and one naming no server is refused in words', JSON.stringify(c));

  say('\na stop');
  // Stopped while it writes a long reply: a tool it might run in the
  // background would end the turn on its own and prove nothing.
  ended = next(a, 'result', 180_000);
  await a.send('Write a 1500-word story about a lighthouse keeper. Use no tools.');
  await sleep(3000);
  const tStop = Date.now();
  c = await a.control('interrupt');
  res = await ended;
  const stopMs = Date.now() - tStop;
  row(c.ok && !!res && stopMs < 10_000 && (res.text ?? '').split(/\s+/).length < 1200, `interrupt ends the turn mid-reply (${res ? `${stopMs} ms, ${(res.text ?? '').split(/\s+/).length} words, ${res.subtype}` : 'no result'})`, (res?.text ?? '').slice(0, 80));

  say('\ncommands typed as messages');
  t = await turn(a, '/cost');
  row(t.taken.ok && !!t.result, '/cost is taken and ends in a result', t.result?.text);
  const compactBegan = next(a, 'status', 180_000, (m) => m.status === 'compacting');
  const compacted = next(a, 'compacted', 180_000);
  t = await turn(a, '/compact', 180_000);
  row(!!(await compactBegan), '/compact says it is compacting (status)');
  row(!!(await compacted) && !!t.result, 'and writes a compact_boundary, then a result', t.result?.text);
  const reset = next(a, 'reset');
  const initClear = next(a, 'init', 120_000, (m) => m.session_id && m.session_id !== SID);
  t = await turn(a, '/clear');
  const r = await reset;
  const ic = await initClear;
  row(!!r, '/clear says it reset the conversation (conversation_reset)', JSON.stringify(r));
  row(!!ic?.session_id, 'and the init after it names the new session', JSON.stringify(ic));
  say(`    the reset named ${r?.conversation}, the init ${ic?.session_id}${r?.conversation === ic?.session_id ? ' (the same)' : ' (different: the host follows the init)'}`);
  const SID2 = ic?.session_id ?? SID;
  // A conversation is on disk only once something is said in it.
  t = await turn(a, 'Reply with exactly: PROBE-AFTER-CLEAR');
  row(/PROBE-AFTER-CLEAR/.test(t.result?.text ?? ''), 'and the next message is answered there', t.result?.text);

  say('\nending and resuming');
  const tEnd = Date.now();
  const exit = await a.stop();
  row(exit && Date.now() - tEnd < 5000, `closing its input ends it (${Date.now() - tEnd} ms, code ${exit?.code})`, JSON.stringify(exit));
  a = start(SID2);
  const init2P = next(a, 'init');
  t = await turn(a, 'Reply with exactly: PROBE-RESUMED');
  const init2 = await init2P;
  row(init2?.session_id === SID2 && /PROBE-RESUMED/.test(t.result?.text ?? ''), '--resume continues the same conversation', `${init2?.session_id} vs ${SID2}${a.exited ? ` · exited ${JSON.stringify(a.exited)}` : ''}`);
  await a.stop();

  say('\nthe machine');
  const settingsAfter = existsSync(SETTINGS) ? readFileSync(SETTINGS) : null;
  const same = hash(settingsBefore) === hash(settingsAfter);
  row(same, `~/.claude/settings.json is untouched (${hash(settingsBefore)} → ${hash(settingsAfter)})`);
  if (!same && settingsBefore) { writeFileSync(SETTINGS, settingsBefore); say('    put back as it was'); }

    version = init?.version ?? null;
  } finally {
    try { await a?.stop(); } catch { /* gone */ }
  }
  return { rows, version, fails, total };
}

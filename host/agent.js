/**
 * One desk's Claude Code, driven through its programmatic interface.
 *
 * costmo's ruling, 2026-11-22: the window layer (a tmux pane per desk, its
 * screen read and typed into) is replaced by this, one system, no switch.
 * The layer it replaces broke every couple of days, each time a Claude Code
 * update moved a screen (docs/robustness-review.md). Here nothing is read
 * off a screen: Claude Code runs as
 *
 *   claude -p --input-format stream-json --output-format stream-json
 *          --verbose --permission-prompt-tool stdio --replay-user-messages
 *
 * and every exchange is a JSON line. Measured on 2.1.330 before any of this
 * was written (docs/stream-json-spike.md, both spikes):
 *
 *   a message       a `user` record in; echoed back with the uuid we gave it
 *                   and `isReplay: true` the moment Claude Code takes it,
 *                   idle or mid-turn (that echo is the delivery receipt);
 *                   the turn ends in a `result` record
 *   a permission    a `control_request` `can_use_tool` out (tool, input,
 *                   description, `permission_suggestions`); answered with a
 *                   `control_response` (`behavior: allow` with the input,
 *                   or `deny` with a message). The plugin's own permission
 *                   hook does not raise it a second time
 *   a question      the same request for AskUserQuestion, its questions in
 *                   the input; answered by allowing it with `answers` added
 *   commands        /compact, /clear, /cost typed as messages work
 *                   (`status: compacting` and `compact_boundary`;
 *                   `conversation_reset` with the new id); /model is the
 *                   `set_model` control, effort `apply_flag_settings`,
 *                   /btw `side_question`, the MCP reconnect `mcp_reconnect`,
 *                   stop `interrupt`
 *   a resume        `--resume <id>`, the same session, which a terminal can
 *                   also resume once this process has ended
 *
 * This module knows the protocol and the process. It knows nothing of
 * desks, the board or the floor; host/index.js does.
 */
import { spawn, execFile, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

export const CLAUDE = process.env.ORCH_HOST_CLAUDE ?? 'claude';
/** How long a control request is given before it is said to have no answer. */
export const CONTROL_TIMEOUT_MS = Number(process.env.ORCH_CONTROL_TIMEOUT_MS ?? 20_000);
/** How long a message is given to be taken (its echo) before send() says so. */
export const TAKEN_TIMEOUT_MS = Number(process.env.ORCH_TAKEN_TIMEOUT_MS ?? 30_000);
/** How long a stopping process is given to leave before it is killed. */
export const STOP_GRACE_MS = Number(process.env.ORCH_STOP_GRACE_MS ?? 5_000);

/** The command line, one place. `resume`, `mcpConfig` and `permissionMode` are optional. */
export function agentArgs({ resume = null, mcpConfig = null, model = null, permissionMode = null } = {}) {
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-prompt-tool', 'stdio',
    '--replay-user-messages',
    ...(resume ? ['--resume', resume] : []),
    ...(mcpConfig ? ['--mcp-config', mcpConfig] : []),
    ...(model ? ['--model', model] : []),
    // The mode the conversation was in (Desk.modeFor). Left out, Claude Code
    // starts in `default` whatever the conversation was in: on 0.15.0 every
    // desk taken over from an `auto` window asked about every tool (costmo,
    // 2026-11-23; measured on 2.1.331: init says `default` without the flag,
    // `auto` with it).
    ...(permissionMode ? ['--permission-mode', permissionMode] : []),
  ];
}

/** A user message as the input stream takes it. */
export function userLine(text, uuid) {
  return `${JSON.stringify({ type: 'user', uuid, message: { role: 'user', content: text } })}\n`;
}

/** A control request, and the answer to one Claude Code sent us. */
export function controlLine(requestId, request) {
  return `${JSON.stringify({ type: 'control_request', request_id: requestId, request })}\n`;
}
export function answerLine(requestId, response) {
  return `${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })}\n`;
}

/**
 * What one output record means to the host, or null for one it has no use
 * for (rate limits, stream deltas, hook progress). Pure, so the suite can
 * hold every reading without a process.
 */
export function readRecord(r) {
  if (!r || typeof r !== 'object') return null;
  if (r.type === 'system' && r.subtype === 'init') {
    return { kind: 'init', session_id: r.session_id ?? null, model: r.model ?? null, mode: r.permissionMode ?? null, version: r.claude_code_version ?? null };
  }
  // The receipt. Claude Code says `command_lifecycle` `queued` with our
  // message's uuid the moment it has the message, then `started` and
  // `completed` (2.1.330, measured 2026-11-22). The echo (`isReplay`) comes
  // only when the message is written into the conversation, which for a
  // message that starts a long reply is when the reply ends: a first message
  // on an idle desk was echoed 14 s later, with the result. Waiting on the
  // echo alone said "not taken" after 30 s about every message whose reply
  // took longer. The echo stays a receipt too, for a Claude Code that does
  // not send lifecycle records.
  if (r.type === 'command_lifecycle') return { kind: 'taken', uuid: r.command_uuid ?? null, state: r.state ?? null };
  if (r.type === 'user' && r.isReplay) return { kind: 'taken', uuid: r.uuid ?? null, state: 'echo' };
  if (r.type === 'result') {
    return { kind: 'result', ok: !r.is_error, subtype: r.subtype ?? null, text: typeof r.result === 'string' ? r.result : '', session_id: r.session_id ?? null };
  }
  // /clear. Its `new_conversation_id` is NOT the new session's id: the init
  // that follows names that, and only that id is on disk (the protocol
  // probe, 2026-11-22, 2.1.330: reset 0e0457e3…, init and transcript
  // 5c414aac…; the spike's run had the same split, misread when this was
  // written). So a reset carries no session, and the next init moves us.
  if (r.type === 'conversation_reset') return { kind: 'reset', conversation: r.new_conversation_id ?? null };
  if (r.type === 'system' && r.subtype === 'status') {
    return { kind: 'status', status: r.status ?? null, compact: r.compact_result ?? null };
  }
  if (r.type === 'system' && r.subtype === 'compact_boundary') return { kind: 'compacted' };
  if (r.type === 'control_request') {
    const q = r.request ?? {};
    if (q.subtype === 'can_use_tool' && q.tool_name === 'AskUserQuestion') {
      return { kind: 'question', request_id: r.request_id, input: q.input ?? {}, questions: q.input?.questions ?? [], agent: q.agent_id ?? null };
    }
    if (q.subtype === 'can_use_tool') {
      return {
        kind: 'permission', request_id: r.request_id, tool: q.tool_name ?? 'tool', title: q.display_name ?? q.tool_name ?? 'tool',
        input: q.input ?? {}, description: q.description ?? null, suggestions: q.permission_suggestions ?? [],
        // A subagent's ask names it (`agent_id`, the id its transcript and
        // meta file carry; absent for the conversation's own: 2.1.330,
        // measured 2026-11-23 for task 352).
        agent: q.agent_id ?? null,
      };
    }
    // Anything else Claude Code asks of the host: a dialog it would have
    // drawn (`request_user_dialog`), or a request this host does not know.
    // Never left hanging: the host puts it on the desk or refuses it.
    return { kind: 'ask', request_id: r.request_id, subtype: q.subtype ?? null, request: q };
  }
  // Claude Code withdrawing what it asked: an interrupt while a permission
  // or question stands is answered with \`control_cancel_request\` naming the
  // ask, then the turn's result (QA, measured on 2.1.330, msg 4100). Read
  // as nothing, the dead ask stayed in \`asks\` and every later message was
  // refused "waiting on an answer" while the floor showed a prompt Claude
  // Code had withdrawn.
  if (r.type === 'control_cancel_request') return { kind: 'cancelled', request_id: r.request_id ?? r.request?.request_id ?? null };
  if (r.type === 'control_response') {
    const p = r.response ?? {};
    return { kind: 'answered', request_id: p.request_id ?? null, ok: p.subtype === 'success', response: p.response ?? null, error: p.error ?? null };
  }
  return null;
}

/**
 * One running Claude Code. Events:
 *   init      { session_id, model, mode, version }   a session began (start, resume, /clear)
 *   taken     { uuid }                                a message was taken
 *   result    { ok, subtype, text, session_id }       a turn ended
 *   reset     { session_id }                          /clear made a new conversation
 *   status    { status, compact }                     compacting began or ended
 *   permission, question, ask                         Claude Code asks the host something
 *   exit      { code, signal, stderr }                the process is gone
 */
/** One argument quoted for a Windows command line (the MSVCRT rules node and
 *  claude.exe parse by), and left bare when it needs nothing. */
export function winQuote(arg) {
  const a = String(arg);
  if (a && /^[\w.\-/\\:=@+,]+$/.test(a)) return a;
  return `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * How Claude Code is started: [command, argv, options]. Through the person's
 * shell where there is one (POSIX: its startup files are part of what Claude
 * Code has). On Windows an npm install is \`claude.cmd\`, which Node will not
 * spawn without a shell (CVE-2024-27980), so it runs through \`cmd.exe /d /s
 * /c\` with each argument quoted (pc-developer, task 348 F7, measured: with
 * only claude.cmd on PATH the desk never started).
 */
export function spawnPlan(claude, args, shell, platform = process.platform) {
  if (shell) return [shell, ['-c', 'exec "$0" "$@"', claude, ...args], {}];
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(claude)) {
    return ['cmd.exe', ['/d', '/s', '/c', `"${[claude, ...args].map(winQuote).join(' ')}"`], { windowsVerbatimArguments: true }];
  }
  return [claude, args, {}];
}

export class Agent extends EventEmitter {
  constructor({ cwd, env = process.env, resume = null, mcpConfig = null, model = null, permissionMode = null, claude = CLAUDE, shell = null } = {}) {
    super();
    this.cwd = cwd;
    this.env = env;
    this.args = agentArgs({ resume, mcpConfig, model, permissionMode });
    this.claude = claude;
    // Started through the person's shell where there is one, as the windows
    // were (`default-shell -c`): its startup files are part of what Claude
    // Code has, and a credential exported in ~/.zshenv is otherwise missing
    // (F1 of the 0.14.5 review). `exec`, so the pid is Claude Code's own.
    this.shell = shell;
    this.child = null;
    this.sessionId = resume;
    this.working = false;       // a turn is running: from a taken message to its result
    this.exited = null;         // { code, signal, stderr } once gone
    this.controls = new Map();  // request_id -> { resolve, timer }
    this.takenWaits = new Map(); // uuid -> { resolve, timer }
    this.asks = new Map();      // request_id -> what Claude Code is waiting on us for
    this.stderr = '';
  }

  get pid() { return this.child?.pid ?? null; }
  get alive() { return !!this.child && !this.exited; }

  start() {
    if (this.child) return this;
    const [cmd, argv, opts] = spawnPlan(this.claude, this.args, this.shell);
    this.child = spawn(cmd, argv, { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...opts });
    this.child.on('error', (err) => this.gone({ code: null, signal: null, error: err.message }));
    this.child.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    this.child.stdin.on('error', () => { /* a write to a process that has left: exit says it */ });
    createInterface({ input: this.child.stdout }).on('line', (line) => this.line(line));
    this.child.on('exit', (code, signal) => this.gone({ code, signal }));
    return this;
  }

  line(line) {
    let r;
    // A line that is not JSON is skipped, and said (QA, task 344 R5): were it
    // a request, the turn would wait on an answer nobody knew was asked. The
    // first few a process, so a stream gone wrong cannot flood the log.
    try { r = JSON.parse(line); } catch { if ((this.garbled = (this.garbled ?? 0) + 1) <= 5 && line.trim()) this.emit('garbled', line.slice(0, 200)); return; }
    const m = readRecord(r);
    this.emit('record', r);
    if (!m) return;
    switch (m.kind) {
      case 'init': this.sessionId = m.session_id ?? this.sessionId; break;
      case 'taken': {
        // A message taken means a turn: it starts one on an idle process,
        // and a running one is working already. Only `queued`, `started`
        // and the echo say that. `completed` and `cancelled` are the end of
        // one message and come after the turn's result (2.1.330, measured
        // 2026-11-22: completed 2 ms after a result; cancelled after a
        // signed-out turn's), so read as a turn starting they left the
        // process working with nothing running. The result says when a
        // turn ends.
        if (m.state !== 'queued' && m.state !== 'started' && m.state !== 'echo') break;
        this.working = true;
        const w = this.takenWaits.get(m.uuid);
        if (w) { clearTimeout(w.timer); this.takenWaits.delete(m.uuid); w.resolve({ ok: true, uuid: m.uuid }); }
        break;
      }
      // A turn that has ended asks nothing of its own: an ask of the
      // conversation's left over is dead, and is said gone by whoever listens
      // for 'cancelled'. A subagent's is not: a background subagent goes on
      // after its parent's turn has ended, and its ask is still waited on
      // (QA, a real 2.1.330 at patch E: cleared here, the subagent waited on
      // a permission nobody could see, its work never done, and the desk
      // took messages as if nothing stood). Withdrawn, it comes as its own
      // control_cancel_request.
      case 'result': {
        this.working = false;
        if (m.session_id) this.sessionId = m.session_id;
        for (const [id, ask] of [...this.asks]) {
          if (ask.agent) continue;
          this.asks.delete(id);
          this.emit('cancelled', { kind: 'cancelled', request_id: id });
        }
        this.armHeld();
        break;
      }
      case 'cancelled': this.asks.delete(m.request_id); this.armHeld(); break;
      case 'reset': this.sessionId = null; break;
      case 'permission': case 'question': case 'ask': this.asks.set(m.request_id, m); break;
      case 'answered': {
        const w = this.controls.get(m.request_id);
        if (w) { clearTimeout(w.timer); this.controls.delete(m.request_id); w.resolve(m.ok ? { ok: true, response: m.response } : { ok: false, error: m.error ?? 'refused' }); }
        return;
      }
      default: break;
    }
    this.emit(m.kind, m);
  }

  write(s) {
    if (!this.alive) return false;
    try { this.child.stdin.write(s); return true; } catch { return false; }
  }

  /** Send a message. Resolves once Claude Code has taken it, or says why not. */
  send(text, { timeoutMs = TAKEN_TIMEOUT_MS } = {}) {
    const uuid = randomUUID();
    if (!this.alive) return Promise.resolve({ ok: false, code: 'no_process', error: 'the desk\'s Claude Code is not running' });
    // While it waits on an answer, Claude Code does not take a message: it
    // is taken only once the ask is answered (the protocol probe,
    // 2026-11-22, 2.1.330). So it is written now and held: answered at once
    // as `held`, with `taken` settling when Claude Code takes it, and the
    // 30 s receipt clock starting only once nothing is asked (armHeld). It
    // used to be refused, and with prompts arriving several a second a
    // message sent from the floor met one nearly every time and never
    // reached the desk (costmo, 2026-11-23, F17).
    if (this.asks.size) {
      const w = { resolve: null, timer: null, held: true, timeoutMs, uuid };
      const taken = new Promise((res) => { w.resolve = res; });
      this.takenWaits.set(uuid, w);
      if (!this.write(userLine(text, uuid))) { this.takenWaits.delete(uuid); return Promise.resolve({ ok: false, code: 'no_process', error: 'the desk\'s Claude Code is not running' }); }
      return Promise.resolve({ ok: true, held: true, uuid, taken });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.takenWaits.delete(uuid); resolve({ ok: false, code: 'not_taken', uuid, error: `Claude Code did not take the message within ${Math.round(timeoutMs / 1000)}s` }); }, timeoutMs);
      this.takenWaits.set(uuid, { resolve, timer });
      if (!this.write(userLine(text, uuid))) { clearTimeout(timer); this.takenWaits.delete(uuid); resolve({ ok: false, code: 'no_process', error: 'the desk\'s Claude Code is not running' }); }
    });
  }

  /** Start the receipt clock of every held message, once nothing is asked. */
  armHeld() {
    if (this.asks.size) return;
    for (const [uuid, w] of this.takenWaits) {
      if (!w.held || w.timer) continue;
      w.timer = setTimeout(() => { this.takenWaits.delete(uuid); w.resolve({ ok: false, code: 'not_taken', uuid, error: `Claude Code did not take the message within ${Math.round(w.timeoutMs / 1000)}s of the answer` }); }, w.timeoutMs);
    }
  }

  /** A control request; resolves with its answer. */
  control(subtype, fields = {}, { timeoutMs = CONTROL_TIMEOUT_MS } = {}) {
    if (!this.alive) return Promise.resolve({ ok: false, code: 'no_process', error: 'the desk\'s Claude Code is not running' });
    const requestId = `h-${randomUUID()}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.controls.delete(requestId); resolve({ ok: false, code: 'no_answer', error: `Claude Code did not answer ${subtype} within ${Math.round(timeoutMs / 1000)}s` }); }, timeoutMs);
      this.controls.set(requestId, { resolve, timer });
      if (!this.write(controlLine(requestId, { subtype, ...fields }))) { clearTimeout(timer); this.controls.delete(requestId); resolve({ ok: false, code: 'no_process', error: 'the desk\'s Claude Code is not running' }); }
    });
  }

  /** Answer something Claude Code asked: allow (with the input it is to run with) or deny. */
  answer(requestId, response) {
    if (!this.asks.has(requestId)) return { ok: false, code: 'stale_request', error: 'that question is no longer open' };
    if (!this.write(answerLine(requestId, response))) return { ok: false, code: 'no_process', error: 'the desk\'s Claude Code is not running' };
    this.asks.delete(requestId);
    this.armHeld();
    return { ok: true };
  }
  allow(requestId, updatedInput, updatedPermissions = null) {
    const ask = this.asks.get(requestId);
    return this.answer(requestId, { behavior: 'allow', updatedInput: updatedInput ?? ask?.input ?? {}, ...(updatedPermissions ? { updatedPermissions } : {}) });
  }
  deny(requestId, message = 'The operator declined this.') {
    return this.answer(requestId, { behavior: 'deny', message });
  }

  /** End the process: input closed, then a kill if it lingers. Resolves once it is gone. */
  stop({ graceMs = STOP_GRACE_MS } = {}) {
    if (!this.child || this.exited) return Promise.resolve(this.exited ?? { code: null });
    return new Promise((resolve) => {
      this.once('exit', resolve);
      try { this.child.stdin.end(); } catch { /* gone */ }
      setTimeout(() => { if (!this.exited) this.kill('SIGTERM'); }, graceMs);
      setTimeout(() => { if (!this.exited) this.kill('SIGKILL'); }, graceMs * 2);
    });
  }

  /**
   * End the process and what it runs. On POSIX a signal (SIGTERM ends Claude
   * Code and the tool it is running: desktop-dev, measured on 2.1.330). On
   * Windows a signal is TerminateProcess of the one pid, which left a Bash
   * tool's tree running with its parent gone (pc-developer, task 348 F5), and
   * the pid may be cmd.exe's (spawnPlan): so the whole tree, by taskkill.
   * \`sync\` for process.on('exit'), where nothing asynchronous runs.
   */
  kill(signal = 'SIGTERM', { sync = false } = {}) {
    const pid = this.child?.pid;
    if (!pid) return;
    if (process.platform === 'win32') {
      const args = ['/PID', String(pid), '/T', '/F'];
      try { if (sync) execFileSync('taskkill', args, { windowsHide: true, stdio: 'ignore' }); else execFile('taskkill', args, { windowsHide: true }, () => {}); } catch { /* gone */ }
      return;
    }
    try { this.child.kill(signal); } catch { /* gone */ }
  }

  gone(info) {
    if (this.exited) return;
    // midTurn: it left with a turn running and no result for it.
    this.exited = { ...info, stderr: this.stderr.trim().slice(-600), midTurn: this.working };
    this.working = false;
    for (const [, w] of this.takenWaits) { clearTimeout(w.timer); w.resolve({ ok: false, code: 'exited', error: 'the desk\'s Claude Code ended before it took the message' }); }
    this.takenWaits.clear();
    for (const [, w] of this.controls) { clearTimeout(w.timer); w.resolve({ ok: false, code: 'exited', error: 'the desk\'s Claude Code ended before it answered' }); }
    this.controls.clear();
    this.asks.clear();
    this.emit('exit', this.exited);
  }
}

/**
 * A desk: one folder (or a seat in one), its conversation, and the Claude Code
 * the host runs for it (host/agent.js). Replaces the window layer (costmo,
 * 2026-11-22): nothing here reads a screen or types into one.
 *
 * What it keeps from before, unchanged in kind: the conversation is read from
 * Claude Code's own transcript and relayed turn by turn (follow, watch), so
 * the floor shows what was said whoever said it, and a conversation picked up
 * in a terminal or an editor keeps reaching the floor.
 *
 * What a desk's Claude Code asks (a permission, a question, anything else) is
 * said to the board as an `ask` event with everything Claude Code sent, and
 * the operator's answer comes back as data. A message is delivered when
 * Claude Code takes it (its echo), never when a screen seems to have changed.
 */
import { log, warn } from './log.js';
import * as W from './claude.js';
import * as M from './mcp.js';
import { Agent } from './agent.js';

const TAIL_BYTES = Number(process.env.ORCH_TAIL_BYTES ?? 64 * 1024);

/** Commands the floor sends that Claude Code takes as a control request, not as words. */
export function commandPlan(text, server) {
  const cmd = W.commandOf(text);
  if (!cmd) return { kind: 'message', text };
  const args = (cmd.args ?? '').trim();
  switch (cmd.name) {
    case 'model': return args ? { kind: 'control', name: 'model', subtype: 'set_model', fields: { model: args } } : { kind: 'refuse', code: 'picker', error: 'name the model (/model sonnet), or use the model control on the desk' };
    case 'effort': return args ? { kind: 'control', name: 'effort', subtype: 'apply_flag_settings', fields: { settings: { effortLevel: args } } } : { kind: 'refuse', code: 'picker', error: 'name the level (/effort high), or use the effort control on the desk' };
    case 'btw': return args ? { kind: 'control', name: 'btw', subtype: 'side_question', fields: { question: args } } : { kind: 'refuse', code: 'empty', error: '/btw needs a question' };
    case 'mcp': return !args || args === 'reconnect' ? { kind: 'control', name: 'mcp', subtype: 'mcp_reconnect', fields: { serverName: server } }
      : /^reconnect\s+(\S+)$/.test(args) ? { kind: 'control', name: 'mcp', subtype: 'mcp_reconnect', fields: { serverName: args.split(/\s+/)[1] } }
        : { kind: 'message', text, command: 'mcp' };
    default: return { kind: 'message', text, command: cmd.name };
  }
}

/** What a control request's answer is said as on the desk. */
export function controlSaid(name, args, r) {
  if (!r.ok) return null;
  if (name === 'model') return `Set model to ${r.response?.model ?? args}`;
  if (name === 'effort') return `Set effort level to ${args}`;
  if (name === 'mcp') return `Reconnected to ${args || 'the board'}`;
  if (name === 'btw') return 'answered';
  return 'done';
}

/** A permission's rows, as the floor draws them: allow, allow for good (when Claude Code offered a rule), deny. */
export function permissionRows(ask) {
  const rule = (ask.suggestions ?? []).flatMap((s) => s.rules ?? []).map((r) => r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName).filter(Boolean);
  return [
    { n: 1, text: 'Yes', act: 'allow' },
    ...(ask.suggestions?.length ? [{ n: 2, text: `Yes, and don't ask again${rule.length ? ` for ${rule.join(', ')}` : ''}`, act: 'always' }] : []),
    { n: ask.suggestions?.length ? 3 : 2, text: 'No', act: 'deny' },
  ];
}

/** One line saying what a tool wants, for the desk's prompt. */
export function askSummary(ask) {
  const input = ask.input ?? {};
  const what = input.command ?? input.file_path ?? input.path ?? input.url ?? input.pattern ?? ask.description ?? '';
  return `${ask.title ?? ask.tool}${what ? `: ${String(what).split('\n')[0].slice(0, 300)}` : ''}`;
}

export class Desk {
  constructor(host, { channel, agent, cwd, scope = 'project', seat = null, server = null }) {
    this.host = host;
    this.channel = channel;
    this.agent = agent;
    this.server = server || M.SERVER_NAME;
    this.seat = seat || null;
    this.scope = scope;
    this.cwd = W.canonical(cwd);
    this.proc = null;             // the Agent running for this desk, if one is
    this.sessionId = null;        // the conversation our process is on, while it runs
    this.lastSessionId = null;    // the conversation this desk is, which outlives any process
    this.holder = null;           // 'floor' | 'editor' | null, as last reported
    this.holders = 0;
    this.outsidePid = null;
    this.offset = 0;
    this.subOffsets = new Map();
    this.since = Date.now();
    this.intent = null;
    this.model = null;
    this.asks = new Map();        // request_id -> the ask, as said to the board
    this.starting = null;         // the promise of a process being started
  }

  get label() { return `${this.channel}/${this.agent}`; }
  get where() { return this.seat ? { cwd: this.cwd, seat: this.seat } : this.cwd; }
  get running() { return !!this.proc?.alive; }

  /** Start following a conversation: 'start' from its first word, 'end' from now, 'tail' its recent past. */
  async follow(id, mode = 'end') {
    if (mode === true) mode = 'start';
    else if (mode === false) mode = 'end';
    this.lastSessionId = id;
    this.subOffsets = new Map();
    this.model = null;
    this.joinedAt = mode === 'start' ? 0 : Date.now();
    if (!id) { this.offset = 0; return; }
    const path = W.transcriptPath(this.cwd, id);
    const size = await W.transcriptSize(path);
    this.offset = mode === 'start' ? 0 : mode === 'tail' ? Math.max(0, size - TAIL_BYTES) : size;
    if (mode !== 'start') {
      for (const sub of await W.subagentTranscripts(path)) this.subOffsets.set(sub.path, await W.transcriptSize(sub.path));
    }
  }

  /** Say on the floor what the host did on the person's behalf: a line labeled host. */
  told(text, sessionId) {
    log(`${this.label}: ${text}`);
    this.host.emit({
      type: 'turn', channel: this.channel, agent: this.agent, session_id: sessionId ?? this.sessionId ?? this.lastSessionId,
      role: 'context', text, at: new Date().toISOString(), uuid: null, tool_name: 'host', tool_input: null, via: null,
    }, true);
  }

  /**
   * The desk's Claude Code, started if it is not running. `resume` is the
   * conversation to continue (the desk's own by default), `fresh` a new one.
   * One process a desk, and only while no other process holds the
   * conversation (an editor, a terminal): two on one transcript diverge
   * without a word (CLAUDE.md, the one rule).
   */
  async ensure({ resume, fresh = false } = {}) {
    if (this.running) return { ok: true, created: false };
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const id = fresh ? null : (resume ?? await this.resumeId());
      if (id) {
        const held = (await W.roster()).sessions?.find((s) => s.sessionId === id && s.pid !== this.proc?.pid);
        // A background session has no screen and nobody at it: this is the
        // handoff, so the host moves it here (W.releaseBackground).
        // An earlier host's window (0.14.x): idle, it is ended and the
        // conversation resumed here; mid-turn, the turn is left to finish.
        if (held && W.isLegacyWindow(held)) {
          if (held.status === 'busy') return { ok: false, code: 'legacy_busy', error: 'its Claude Code is finishing a turn in the tmux window an earlier version of the host ran it in; the floor takes the conversation over as soon as that turn ends' };
          await W.endLegacyWindow({ pid: held.pid, window: /:(@\d+)/.exec(held.tmux)?.[1] ?? null });
          this.told(`the host ended the tmux window an earlier version ran this desk's Claude Code in (pid ${held.pid}), so its conversation continues here`, id);
        } else if (held?.kind === 'background') {
          const rel = await W.releaseBackground(held);
          if (!rel.ok) return rel;
          this.told(`its conversation was running as a background Claude Code session (${rel.job}), so the host stopped that with claude stop and resumed it here`, id);
        } else if (held) return { ok: false, code: 'held_elsewhere', pid: held.pid, error: `that conversation is open in another Claude Code (pid ${held.pid}): close it there, then send this again` };
        // Not in the roster yet, and running all the same (W.resumingProcesses).
        if (!held) {
          const pid = (await W.resumingProcesses()).get(id);
          if (pid && pid !== this.proc?.pid) return { ok: false, code: 'held_elsewhere', pid, error: `that conversation is open in another Claude Code (pid ${pid}, \`claude --resume\`) that has not finished starting, such as a terminal still asking whether to trust this folder: answer or close it there, then send this again` };
        }
      }
      const env = this.host.agentEnv(this);
      const proc = new Agent({ cwd: this.cwd, env, resume: id, claude: W.CLAUDE, mcpConfig: this.host.seatConfig(this), shell: process.platform === 'win32' ? null : W.shellFor() });
      this.attach(proc);
      proc.start();
      this.proc = proc;
      this.sessionId = id;
      this.host.notePids?.();
      if (id && id !== this.lastSessionId) await this.follow(id, 'tail');
      log(proc.pid ? `${this.label}: Claude Code started (pid ${proc.pid}) ${id ? `on ${id}` : 'on a new conversation'}` : `${this.label}: Claude Code could not be started (${W.CLAUDE})`);
      this.report();
      return { ok: true, created: true };
    })();
    try { return await this.starting; } finally { this.starting = null; }
  }

  /** The conversation to resume: the desk's own when its transcript is on disk, else the folder's newest, else none. */
  async resumeId() {
    if (this.sessionId) return this.sessionId;
    const pinned = this.lastSessionId;
    const pick = await W.resumable(this.where, pinned, { seatPids: this.host.seatPids?.() ?? new Set() });
    if (pick.note) this.told(pick.note, pick.id ?? pinned);
    if (pick.id && pick.id !== pinned) await this.follow(pick.id);
    return pick.id;
  }

  attach(proc) {
    proc.on('init', (m) => {
      if (m.model) this.modelId = m.model;
      if (!m.session_id) return;
      this.sessionId = m.session_id;
      if (m.session_id !== this.lastSessionId) this.follow(m.session_id, 'start').then(() => this.report());
      else this.report();
    });
    // /clear: the conversation it names is not the session's id; the init
    // right after it is, and that moves the desk (agent.js, readRecord).
    proc.on('reset', () => { this.sessionId = null; });
    proc.on('status', (m) => {
      if (m.status === 'compacting') this.host.emit({ type: 'receipt', channel: this.channel, agent: this.agent, command: 'compact', said: 'compacting', text: '/compact', session_id: this.sessionId, compacting: true }, true);
      else if (m.compact) this.host.emit({ type: 'receipt', channel: this.channel, agent: this.agent, command: 'compact', said: m.compact === 'success' ? 'Compacted' : `compaction ${m.compact}`, text: '/compact', session_id: this.sessionId, compacting: false, compacted: m.compact === 'success' }, true);
    });
    // Each turn's start and end, as the process says them: the board's
    // working and idle, with no hook needed (src/floor.js, case 'state').
    proc.on('init', () => this.host.emit({ type: 'state', channel: this.channel, agent: this.agent, state: 'working' }, true));
    proc.on('result', (m) => {
      this.host.emit({ type: 'state', channel: this.channel, agent: this.agent, state: 'idle' }, true);
      // A signed-out machine answers every turn with this (2.1.329's words).
      if (!m.ok && /not logged in/i.test(m.text)) this.host.noteTurn({ role: 'error', text: m.text });
    });
    proc.on('permission', (ask) => this.raise({ ...ask, kind: 'permission', rows: permissionRows(ask), summary: askSummary(ask) }));
    proc.on('garbled', (l) => warn(`${this.label}: skipped a line from Claude Code that is not JSON: ${l}`));
    // Withdrawn by Claude Code (an interrupt while it asked), or left over at
    // a turn's end: off the desk and off the floor (agent.js, 'cancelled').
    proc.on('cancelled', (m) => {
      if (!this.asks.delete(m.request_id)) return;
      this.host.emit({ type: 'ask', channel: this.channel, agent: this.agent, request_id: m.request_id, gone: true }, true);
    });
    proc.on('question', (ask) => this.raise({ ...ask, kind: 'question', summary: 'a question for you', tool: 'AskUserQuestion' }));
    proc.on('ask', (ask) => {
      // Something the floor has no way to answer yet (a dialog Claude Code
      // would have drawn). Refused, so the turn is not held for ever, and
      // said on the desk with what it was, so it is not silent either.
      proc.answer(ask.request_id, { behavior: 'deny', message: 'The floor cannot answer this kind of request.' });
      this.told(`Claude Code asked something the floor cannot answer yet (${ask.subtype ?? 'unknown'}); it was declined. ${JSON.stringify(ask.request).slice(0, 300)}`);
    });
    proc.on('exit', (e) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.host.notePids?.();
      this.sessionId = null;
      for (const id of this.asks.keys()) this.host.emit({ type: 'ask', channel: this.channel, agent: this.agent, request_id: id, gone: true }, true);
      this.asks.clear();
      if (!this.stopping && e.code !== 0) {
        // 127 is the shell's "command not found" (and a spawn error is the
        // same with no shell): Claude Code is not where the host was told it
        // is, so the next message will meet the same thing. Said as that, not
        // as a promise (task 341 C2h, measured with ORCH_HOST_CLAUDE missing).
        const missing = e.code === 127 || !!e.error;
        const why = e.stderr ? `: ${e.stderr.split('\n').slice(-3).join(' ')}` : e.error ? `: ${e.error}` : '';
        const message = missing
          ? `the desk's Claude Code could not be started on this machine${why}. Claude Code (\`${W.CLAUDE}\`) is not installed, or not where the host looks for it; reinstall it, or run the host's installer again so it finds it`
          : `the desk's Claude Code ended (${e.signal ?? `code ${e.code}`})${why}. The next message starts it again.`;
        this.host.emit({ type: 'error', channel: this.channel, agent: this.agent, code: missing ? 'agent_missing' : 'agent_exited', message }, true);
      }
      this.stopping = false;
      this.report();
    });
  }

  /** Something Claude Code asks: said to the board, kept until answered. */
  raise(ask) {
    this.asks.set(ask.request_id, ask);
    this.host.emit({
      type: 'ask', channel: this.channel, agent: this.agent, session_id: this.sessionId ?? this.lastSessionId,
      request_id: ask.request_id, kind: ask.kind, tool: ask.tool, tool_input: ask.input ?? null,
      summary: ask.summary, description: ask.description ?? null,
      options: (ask.rows ?? []).map(({ n, text }) => ({ n, text })),
    }, true);
    log(`${this.label}: Claude Code asks (${ask.kind}): ${ask.summary}`);
  }

  /** What is still asked, for the heartbeat, so a board that restarted raises it again. */
  standingAsks() {
    return [...this.asks.values()].map((ask) => ({
      type: 'ask', channel: this.channel, agent: this.agent, session_id: this.sessionId ?? this.lastSessionId,
      request_id: ask.request_id, kind: ask.kind, tool: ask.tool, tool_input: ask.input ?? null,
      summary: ask.summary, description: ask.description ?? null, options: (ask.rows ?? []).map(({ n, text }) => ({ n, text })),
    }));
  }

  /**
   * The operator's answer to a permission: a row's number, or allow, deny,
   * cancel. Cancel is a refusal that also stops the turn, as Escape in the
   * window was.
   */
  async answerPermission(requestId, decision, reason = null) {
    const ask = this.asks.get(requestId);
    if (!ask || !this.proc) return { ok: false, code: 'stale_request', error: 'that question is no longer open' };
    const row = /^\d+$/.test(String(decision)) ? ask.rows?.find((r) => r.n === Number(decision)) : null;
    const act = row?.act ?? decision;
    let r;
    if (act === 'allow') r = this.proc.allow(requestId);
    else if (act === 'always') r = this.proc.allow(requestId, null, ask.suggestions ?? null);
    else if (act === 'deny') r = this.proc.deny(requestId, reason?.trim() ? reason.trim() : 'The operator said no.');
    else if (act === 'cancel') { r = this.proc.deny(requestId, 'The operator cancelled this.'); if (r.ok) await this.proc.control('interrupt'); }
    else return { ok: false, code: 'bad_decision', error: `"${decision}" is not an answer to that` };
    if (r.ok) this.asks.delete(requestId);
    return r;
  }

  /** The operator's answers to a question: { "<question>": "<answer>" }. */
  answerQuestion(requestId, answers) {
    const ask = this.asks.get(requestId);
    if (!ask || !this.proc) return { ok: false, code: 'stale_request', error: 'that question is no longer open' };
    const r = answers ? this.proc.allow(requestId, { ...ask.input, answers }) : this.proc.deny(requestId, 'The operator cancelled the question.');
    if (r.ok) this.asks.delete(requestId);
    return r;
  }

  async interrupt() {
    if (!this.running) return { ok: false, code: 'no_process', error: 'the desk\'s Claude Code is not running' };
    return this.proc.control('interrupt');
  }

  /** Bring the desk's tools back after the board went away (reconnectDue). */
  async reconnect() {
    if (!this.running) return;
    const r = await this.proc.control('mcp_reconnect', { serverName: this.server });
    if (r.ok) this.told(`the desk's tools had lost the board, so the host reconnected them to ${this.server}`);
    else warn(`${this.label}: reconnecting its tools: ${r.error}`);
  }

  /** Deliver the operator's words, starting the desk's Claude Code if it is not running. */
  async say(text) {
    const plan = commandPlan(text, this.server);
    const cmdName = plan.name ?? plan.command ?? null;
    if (plan.kind === 'refuse') {
      this.host.emit({ type: 'error', channel: this.channel, agent: this.agent, message: plan.error, code: plan.code, command: cmdName }, true);
      return plan;
    }
    const up = await this.ensure();
    if (!up.ok) {
      this.host.emit({ type: 'error', channel: this.channel, agent: this.agent, message: up.error, code: up.code ?? null, command: cmdName }, true);
      return up;
    }
    if (plan.kind === 'control') {
      const args = plan.fields.model ?? plan.fields.settings?.effortLevel ?? plan.fields.serverName ?? plan.fields.question ?? '';
      const r = await this.proc.control(plan.subtype, plan.fields);
      if (!r.ok) {
        this.host.emit({ type: 'error', channel: this.channel, agent: this.agent, message: `${text.trim()} was not done: ${r.error}`, code: r.code ?? 'refused', command: cmdName }, true);
        return r;
      }
      if (plan.name === 'btw') {
        this.host.emit({ type: 'turn', channel: this.channel, agent: this.agent, session_id: this.sessionId, role: 'assistant', text: String(r.response?.response ?? ''), at: new Date().toISOString(), uuid: null, tool_name: null, tool_input: null, via: '/btw' }, true);
      }
      let said = controlSaid(plan.name, args, r);
      // Saved as the default for new sessions too, as the terminal's own
      // /model and /effort do (W.saveDefaults has the ruling).
      if (plan.name === 'model' || plan.name === 'effort') {
        if (plan.name === 'model' && r.response?.model) this.modelId = r.response.model;
        const saved = W.saveDefaults(plan.name === 'model' ? { model: args } : { effort: args, modelId: this.modelId });
        said = saved.ok && saved.wrote ? `${said} and saved as your default for new sessions` : `${said} for this conversation; not saved as your default (${saved.error ?? 'its model is not known yet: send it a message first'})`;
      }
      this.told(`${text.trim()} — ${said}`);
      this.host.emit({
        type: 'receipt', channel: this.channel, agent: this.agent, command: plan.name, said, text, session_id: this.sessionId,
        model: plan.name === 'model' ? (r.response?.model ?? args) : null, effort: plan.name === 'effort' ? args : null, compacting: false,
      }, true);
      return { ok: true };
    }
    const wasWorking = this.proc.working;
    const r = await this.proc.send(plan.text);
    if (!r.ok) {
      this.host.emit({ type: 'error', channel: this.channel, agent: this.agent, message: `not delivered: ${r.error}`, code: r.code ?? 'not_delivered', command: cmdName }, true);
      return r;
    }
    if (wasWorking) this.host.emit({ type: 'delivery', channel: this.channel, agent: this.agent, state: 'queued', text, held: false }, true);
    return { ok: true, queued: wasWorking };
  }

  /** End the desk's Claude Code, for a handoff, a move, a leave or the host stopping. */
  async stop() {
    if (!this.proc) return;
    const proc = this.proc;
    this.stopping = true;
    await proc.stop();
    // A turn the stop cut off is said (task 348 F4, pc-developer and QA,
    // measured): the stop suppresses agent_exited, so the floor showed the
    // operator's message with no reply and no word about why.
    if (proc.exited?.midTurn) this.told('its Claude Code was stopped in the middle of a turn (the host stopping, or the desk handed over), so that turn ended unfinished; what it had already written or run stays, and the next message continues the conversation');
  }

  /** Tell the board who holds the desk now, when that changed. */
  report() {
    const holder = this.running || this.legacyPid ? 'floor' : this.outsidePid ? 'editor' : null;
    const window = this.running ? `proc:${this.proc.pid}` : this.legacyPid ? `legacy:${this.legacyPid}` : null;
    const key = `${holder}|${window}|${this.holders}|${this.sessionId}`;
    if (key === this.reported) return;
    this.reported = key;
    this.holder = holder;
    if (this.sessionId && this.sessionId !== this.saidSession) {
      this.saidSession = this.sessionId;
      this.host.emit({ type: 'session', channel: this.channel, agent: this.agent, session_id: this.sessionId, cwd: this.cwd, pid: this.proc?.pid ?? null }, true);
    }
    this.host.emit({
      type: 'holder', channel: this.channel, agent: this.agent, holder, window, pid: this.proc?.pid ?? this.outsidePid ?? null,
      window_open: window, holders: this.holders, clients: 0,
    }, true);
  }

  /**
   * A watch tick: who else holds the conversation (an editor or a terminal,
   * from Claude Code's roster), and every new turn of the transcript.
   */
  async watch(live = []) {
    const mine = this.proc?.pid ?? null;
    const others = live.filter((s) => s.pid !== mine);
    // A Claude Code coming up in the folder while this desk runs none may be
    // the one another instance's host opened after releasing the folder
    // there (bind in host/index.js). Followed, its conversation reached this
    // board for up to a heartbeat (task 292, measured with two real hosts),
    // so the binding is read first, once for each new set of processes, and
    // a desk whose folder answers elsewhere now is let go (letGoIfReleased).
    // The window layer did this in its watch; the rewrite to processes had
    // left it out, and test:host's release rows read the old conversation
    // reaching the board again.
    const othersKey = others.map((s) => s.pid).sort().join(',');
    if (!this.running && others.length && othersKey !== this.othersSeen) {
      this.othersSeen = othersKey;
      if (await this.host.letGoIfReleased?.(this, 'a window came up in its folder')) return;
    }
    if (!others.length) this.othersSeen = '';
    // A conversation taken up somewhere else while this desk has none running
    // is followed there: what is said in a terminal or an editor still
    // reaches the floor.
    if (!this.running && others.length) {
      const pinnedOther = others.find((s) => s.sessionId === this.lastSessionId);
      const newest = pinnedOther ?? others.reduce((a, b) => ((b.startedAt ?? 0) > (a.startedAt ?? 0) ? b : a));
      if (newest.sessionId && newest.sessionId !== this.lastSessionId) await this.follow(newest.sessionId, (newest.startedAt ?? 0) >= this.since);
    }
    const outside = others.find((s) => s.sessionId === this.lastSessionId) ?? null;
    // An earlier host's tmux window on the conversation (0.14.x, left by an
    // upgrade) is the floor's own, finishing a turn: said as the floor's, not
    // as an editor the operator is told to quit (W.endLegacyWindows).
    this.legacyPid = outside && W.isLegacyWindow(outside) ? outside.pid : null;
    // A Claude Code on this conversation that the roster does not list yet
    // (a terminal waiting on the trust question: W.resumingProcesses) holds
    // it as surely as one that it does.
    const unlisted = !this.running && !outside && this.lastSessionId ? this.resuming?.get(this.lastSessionId) ?? null : null;
    this.outsidePid = this.legacyPid ? null : outside?.pid ?? unlisted ?? null;
    this.holders = live.filter((s) => s.sessionId === (this.sessionId ?? this.lastSessionId)).length;
    this.report();
    if (!this.lastSessionId) return;
    const path = W.transcriptPath(this.cwd, this.lastSessionId);
    const r = await W.readTranscript(path, { after: this.offset });
    if (!r.ok) return;
    this.offset = r.offset;
    const turns = [...r.turns];
    for (const sub of await W.subagentTranscripts(path)) {
      const s = await W.readTranscript(sub.path, { after: this.subOffsets.get(sub.path) ?? 0, via: sub.label });
      if (!s.ok) continue;
      this.subOffsets.set(sub.path, s.offset);
      turns.push(...s.turns);
    }
    if (turns.every((t) => Number.isFinite(Date.parse(t.at)))) turns.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    for (const turn of turns) {
      if (turn.model && !turn.via && turn.model !== this.model) {
        this.model = turn.model;
        this.host.emit({ type: 'model', channel: this.channel, agent: this.agent, session_id: this.lastSessionId, model: turn.model }, true);
      }
      if (turn.role === 'model') continue;
      if (!(this.joinedAt && Date.parse(turn.at) < this.joinedAt)) this.host.noteTurn?.(turn);
      this.host.emit({
        type: 'turn', channel: this.channel, agent: this.agent, session_id: this.lastSessionId,
        role: turn.role, text: turn.text, at: turn.at, uuid: turn.uuid,
        tool_name: turn.tool_name ?? null, tool_input: turn.tool_input ?? null, via: turn.via ?? null,
      });
    }
  }
}

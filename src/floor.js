import express from 'express';
import { CAST } from './db.js';
import { agentBoard, agentLoadIndex, channelCounts, mcpSessionCounts, ZERO_COUNTS } from './agent-state.js';
import { PALETTE, DEFAULT_HAIR, DEFAULT_SKIN, shirtForSeat } from './palette.js';

/**
 * The floor: what each agent's own Claude Code session is doing — and, for
 * desks a host has claimed, the session itself.
 *
 * The board (see web.js) answers "what have these agents agreed between
 * themselves". It deliberately cannot answer "who is stuck right now", because
 * an MCP server never sees inside an agent's turn — that limit is real and is
 * documented at length in the README. This module closes the gap from two
 * directions:
 *
 *   1. Reporting. A workstation plugin (plugin/) posts hook events here as each
 *      Claude Code session runs, so a window you are not looking at still has
 *      a desk that says what it is doing and whether it needs a human.
 *
 *   2. Hosting. A workstation service (host/) runs each desk's Claude Code in a
 *      tmux pane and connects it to the floor. Those desks are a real chat:
 *      what you type is a user turn in that window, the reply comes back, and a
 *      permission prompt becomes Approve / Deny here. The human is still the one
 *      deciding — from one screen instead of one per agent. Nothing is owned:
 *      you can be attached to the same pane, typing into it, at the same time.
 *
 * Two things follow from the first and shape everything below:
 *
 *   - Reported data arrives by push, not poll. A window that goes quiet stops
 *     posting, which is information, but a window that is *switched off* also
 *     stops posting and looks identical. So nothing here infers "waiting" from
 *     silence. Waiting is only ever what Claude Code explicitly said it was
 *     waiting for, and it is cleared by the next thing that happens.
 *
 *   - It is conversation content. Full prompts and full replies, on a server
 *     whose dashboard has no sign-in. That is a deliberate choice for one
 *     trusted network (see the README's note on the port), but it is a bigger
 *     claim than the board ever made, and it is why `turns` is excluded from
 *     backups and why the ingest and host doors need the same secret as /mcp.
 *
 * And one thing follows from the second: the host is on a workstation, the
 * server is wherever it is, and only the workstation can reach out. So the host
 * talks to this server the same way the plugin does — outbound only — and the
 * server never holds an open port toward anybody's machine. Work for a host
 * waits in a table until the host asks for it.
 */

/** Per-turn cap. Full text was the point, but one pasted logfile shouldn't
 *  become a row every viewer downloads every two seconds for the rest of time. */
const TEXT_MAX = 20_000;

/** How many turns the chat panel asks for at once. */
const TURNS_DEFAULT = 80;
const TURNS_MAX = 500;

/**
 * How long a silent session keeps its seat before the desk shows as away.
 *
 * The floor has no connection to observe — its only signal is hook events — so
 * "live" is a claim about recency, exactly like the board's presence dot: green
 * means "we heard from this window recently", nothing more. A crashed window
 * never sends SessionEnd, and without this its desk would sit there green for
 * days, which is the floor equivalent of the stale `waiting` chip the status
 * TTL exists to prevent. Generous by default because the counter-error is real
 * too: a window that is open while its human reads or thinks for a while emits
 * nothing, and flapping to "away" over lunch would teach people the floor
 * cannot be trusted in the other direction.
 */
const SESSION_STALE_MINUTES = Math.max(1, Number(process.env.FLOOR_SESSION_TTL_MINUTES ?? 60));

/**
 * A host that hasn't been heard from for this long is offline. Hosts long-poll
 * for work in ~25-second requests and re-register once a minute, so the default
 * means two missed check-ins. The chat composer switches to copy-only the
 * moment a host is offline, because "Send" to a host that isn't there is the
 * one lie the floor is not allowed to tell.
 */
const HOST_STALE_SECONDS = Math.max(30, Number(process.env.FLOOR_HOST_TTL_SECONDS ?? 90));

/**
 * How an avatar is drawn. The whole difference is hair, because a head, a pair
 * of shoulders and a chair back is all the character these figures have — there
 * is nowhere else to put a distinction without inventing detail the flat style
 * does not carry.
 *
 * `neutral` is first because it is the default and it draws no hair at all,
 * which is exactly what every desk looked like before this existed.
 */
export const GENDERS = ['neutral', 'male', 'female'];

/** Longest a host's work request is held open before answering "nothing yet". */
const WORK_WAIT_MAX_MS = 25_000;

/** Longest message accepted from the composer. */
const CHAT_MAX = 20_000;

/**
 * The notification types that mean a human is the blocker.
 *
 * Everything else Claude Code notifies about — auth success, an elicitation
 * dialog closing — is news, not a queue item, and putting it in the operator's
 * list would train them to ignore the list.
 */
const AWAITING_NOTIFICATIONS = new Set(['permission_prompt', 'idle_prompt']);

/**
 * Events that prove a human is no longer the blocker, because work happened.
 *
 * PreToolUse is in here and PostToolUse is not, which halves how often the hook
 * fires on the busiest path in a session. It is safe in that order because
 * PreToolUse runs *before* the permission decision: the clear lands first, then
 * PermissionRequest and the permission_prompt Notification each set it again. Two
 * independent signals re-raise a live prompt, so the one that arrives early
 * cannot hide it.
 */
const CLEARS_AWAITING = new Set(['SessionStart', 'UserPromptSubmit', 'Stop', 'PreToolUse']);

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const clip = (v, max = TEXT_MAX) => {
  if (v === null || v === undefined) return null;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s === null || s === undefined) return null;
  return s.length > max ? `${s.slice(0, max)}\n… [truncated at ${max} characters]` : s;
};
/* SQLite's datetime to ISO. Idempotent: the floor's view of a host carries an
   already-converted timestamp, and running this over it a second time used to
   append a second Z. Date.parse said NaN to that, NaN failed every comparison
   it was put in, and a host ten minutes dead reported as live. */
const iso = (s) => (s ? `${String(s).replace(' ', 'T').replace(/Z*$/, '')}Z` : null);
/* Fails closed. An unparseable timestamp used to make this NaN, and every
   `secondsSince(...) < TTL` test it fed then answered false — so the one thing
   a bad clock value must never do, which is make something look alive, is
   exactly what it did. No timestamp and no sense are both "infinitely long
   ago". */
const secondsSince = (isoStr, nowMs) => {
  const at = isoStr ? Date.parse(isoStr) : NaN;
  return Number.isFinite(at) ? (nowMs - at) / 1000 : Infinity;
};
/* How many recent tool calls a desk carries for its monitor. A shade more than
   the four lines the screen shows, so a browser that missed a poll still has
   the run to type rather than a gap. */
const SCREEN_COMMANDS = 6;

const deskKey = (channel, agent) => `${channel}|${agent}`;

/**
 * Can anything be typed into this desk's window right now, and if not, why not?
 *
 * Pure, and takes the already-fetched row so a caller with a whole list does not
 * make one query per desk. Exported because two surfaces need the same verdict:
 * the chat endpoint enforces it, and the board greys out its Nudge button with
 * it. A button that decided for itself would eventually disagree with the server
 * that actually refuses the work — enabled and 409ing, or greyed out over a
 * window that was perfectly reachable.
 *
 * The one rule underneath all three refusals is the one this whole repo is built
 * on: a conversation is one process, and only the app holding it can type.
 */
export function deliverable(h, nowMs = Date.now()) {
  if (!h) return { error: 'No host on this board is running that repo, so there is nowhere to send this.', code: 'not_hosted' };
  if (h.state === 'offline' || secondsSince(iso(h.host_seen), nowMs) >= HOST_STALE_SECONDS) {
    return { error: `The host for this desk (${h.host_name ?? h.host_id}) is offline.`, code: 'host_offline' };
  }
  // A conversation is one process, and right now an editor has it. Nothing can
  // be typed into it from here — so say that before a message is taken, rather
  // than accepting one and failing to deliver it.
  if (h.outside_pid) {
    return {
      error: 'This conversation is open in your editor. Close it there, or use “Open in VS Code” to move it back, then type here.',
      code: 'held_by_editor',
    };
  }
  return { hosted: h };
}

/**
 * Whether this desk can be *nudged*, which is a stricter question than whether
 * it can be sent a message.
 *
 * Chat may open a window: you are starting a conversation, and the host will
 * make somewhere for it to happen. A nudge cannot, because a nudge is not
 * content — it means "there is something waiting on your channel, go and
 * look", and that is meaningless said to a desk with nobody at it. Sent to a
 * desk with no window, it would silently spin up a whole session to deliver
 * one word.
 *
 * So `window_id` is the extra condition: something has to already be running
 * for a nudge to reach. This is the gate both nudge surfaces use — the board's
 * button and the floor's bell — while the compose box keeps deliverable().
 */
export function nudgeable(h, nowMs = Date.now()) {
  const can = deliverable(h, nowMs);
  if (can.error) return can;
  if (!h.window_id) {
    return {
      error: 'No window is open for this desk, so there is no one to nudge. Send a message instead — that opens one.',
      code: 'no_window',
    };
  }
  return can;
}

/**
 * The session id a hosted desk's turns are filed under before its SDK session
 * has announced its own. Deterministic, so the message that starts a session
 * and the session it starts can be joined up afterwards — see rekeySession.
 */
const placeholderSession = (hostId, channel, agent) => `host:${hostId}:${channel}:${agent}`;

/**
 * One line describing a tool call, for the collapsed row in the chat panel.
 *
 * The whole reason tool calls are stored as their own rows is so the panel can
 * show them as one line and expand on click. That only pays off if the one line
 * is the useful part — "Bash" tells you nothing, `Bash: npm test` tells you what
 * the agent is actually doing, which is the question the person watching has.
 */
function toolSummary(toolName, toolInput) {
  const i = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const first =
    str(i.command) ??
    str(i.file_path) ??
    str(i.path) ??
    str(i.pattern) ??
    str(i.description) ??
    str(i.prompt) ??
    str(i.url) ??
    null;
  if (!first) return toolName;
  const oneLine = first.replace(/\s+/g, ' ').trim();
  return `${toolName}: ${oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine}`;
}

/**
 * Apply one hook event from the workstation plugin.
 *
 * Every event upserts the session first, because any event at all is proof the
 * window exists — and because most hook payloads carry only the common fields,
 * the upsert COALESCEs rather than overwrites, so a Stop can't blank the model a
 * SessionStart knew.
 */
export function ingestHookEvent(store, body, live = null) {
  const channel = str(body.channel);
  const agent = str(body.agent);
  const sessionId = str(body.session_id);
  if (!channel || !agent || !sessionId) {
    return { ok: false, error: 'channel, agent and session_id are required' };
  }
  const event = str(body.hook_event_name) ?? 'unknown';
  const pid = Number.isInteger(Number(body.pid)) && Number(body.pid) > 0 ? Number(body.pid) : null;

  store.upsertSession({
    session_id: sessionId,
    channel,
    agent,
    cwd: str(body.cwd),
    transcript: str(body.transcript_path),
    model: str(body.model),
    permission_mode: str(body.permission_mode),
    git_branch: str(body.git_branch),
    runner: 'hook',
    pid,
  });
  const persona = store.ensurePersona(channel, agent);

  /**
   * Whether a host is tailing this repo's transcript right now.
   *
   * When one is, it is the authority on conversation *content* — it reads what
   * Claude Code wrote, which is complete and has the tool calls in it — and
   * these hooks would file every turn a second time. When there is no host
   * (its machine is off, the service isn't running), the hooks are the only
   * source there is, and the floor is better off with a partial conversation
   * than an empty desk. Either way the hooks remain the authority on *state*:
   * a prompt is open, a turn started, a turn ended.
   */
  const hosted = store.hostedDesk(channel, agent);
  const mirrored = !!hosted && secondsSince(iso(hosted.host_seen), Date.now()) < HOST_STALE_SECONDS;

  const key = deskKey(channel, agent);
  const state = (s) => {
    if (!hosted) return;
    store.setHostedState(channel, agent, s);
    live?.publish(key, { type: 'state', state: s });
  };

  const turn = (role, text, toolName = null) => {
    const clipped = clip(text);
    if (!clipped && !toolName) return 0;
    const id = store.insertTurn({
      channel, agent, session_id: sessionId, role, text: clipped, tool_name: toolName,
    });
    live?.publish(deskKey(channel, agent), {
      type: 'turn',
      turn: { id, session_id: sessionId, role, text: clipped, tool_name: toolName, created_at: new Date().toISOString() },
    });
    return id;
  };

  // Ordered so the clear happens before anything that might set it again.
  if (CLEARS_AWAITING.has(event)) {
    store.clearAwaiting(sessionId);
    // A prompt that was open is closed by work happening, whether it was
    // answered from the floor or by the person sitting at the window.
    if (live?.pending.has(key)) {
      live.pending.delete(key);
      live.publish(key, { type: 'permission', request: null });
    }
  }

  let recorded = null;
  switch (event) {
    case 'SessionEnd':
      store.endSession(sessionId);
      live?.pending.delete(key);
      state('idle');
      break;

    case 'UserPromptSubmit':
      // The human just typed. By definition they are not the blocker any more,
      // which is why this event clears the queue entry above rather than waiting
      // for the turn to finish.
      if (body.message && !mirrored) recorded = turn('user', body.message);
      state('working');
      break;

    case 'Stop':
      if (body.last_assistant_message && !mirrored) recorded = turn('assistant', body.last_assistant_message);
      state('idle');
      break;

    case 'PreToolUse':
      // Recorded as the tool *starts*, so the floor shows what is happening now
      // rather than what finished a moment ago. PostToolUse would be the honest
      // record of completion, but by then the interesting second has passed.
      if (str(body.tool_name) && !mirrored) {
        recorded = turn('tool', toolSummary(body.tool_name, body.tool_input), body.tool_name);
      }
      state('working');
      break;

    /**
     * A permission prompt, straight from the session that opened it.
     *
     * This is why the floor never has to read a prompt off a screen to know one
     * is open: Claude Code says so. Answering it is a keystroke sent into the
     * window (see host/index.js), which is exactly what the person sitting at
     * it would do — and either of them can be the one who does it.
     */
    case 'PermissionRequest': {
      const summary = str(body.tool_name)
        ? toolSummary(body.tool_name, body.tool_input)
        : 'a tool needs a permission decision';
      store.setAwaiting(sessionId, 'permission_request', summary);
      // The id is only ever used to notice that an answer arrived for a prompt
      // that has since closed — the window itself is answered with a keystroke.
      live?.pending.set(key, {
        request_id: `${sessionId}:${body.tool_name ?? 'tool'}:${Date.parse(new Date().toISOString())}`,
        tool: str(body.tool_name) ?? 'tool',
        summary: clip(summary, 500),
        message: clip(body.notification_message ?? body.message, 500),
        at: new Date().toISOString(),
      });
      state('awaiting');
      live?.publish(key, { type: 'permission', request: live.pending.get(key) });
      break;
    }

    case 'Notification':
      if (AWAITING_NOTIFICATIONS.has(str(body.notification_type))) {
        store.setAwaiting(sessionId, body.notification_type, clip(body.notification_message, 500));
      }
      break;

    case 'StopFailure':
      // An API error is not a human-blocking prompt, but it is the other way a
      // window silently stops making progress, and it reads the same from across
      // the room. It goes in the queue so nobody waits on a dead turn.
      recorded = turn('error', str(body.error_message) ?? str(body.error_type) ?? 'the turn ended with an API error');
      store.setAwaiting(sessionId, 'error', clip(body.error_message ?? body.error_type, 500));
      break;

    default:
      break;
  }

  return { ok: true, event, channel, agent, persona: persona.persona, turn_id: recorded };
}

/**
 * State that is live rather than stored: the text of a reply while it streams,
 * the permission prompts hosts are waiting on, the browsers watching a desk,
 * and the hosts waiting for work. All of it is rebuilt from the hosts within a
 * minute of a restart — they re-register and re-announce anything pending — so
 * a table would be a table of things that are about to be wrong.
 */
export function createLive() {
  const partial = new Map();   // deskKey -> text of the reply so far
  const pending = new Map();   // deskKey -> { request_id, tool, summary, message, at }
  const watchers = new Map();  // deskKey -> Set<fn>
  const waiters = new Map();   // host_id -> wake fn for a held work request
  return {
    partial,
    pending,
    subscribe(key, fn) {
      if (!watchers.has(key)) watchers.set(key, new Set());
      watchers.get(key).add(fn);
      return () => watchers.get(key)?.delete(fn);
    },
    publish(key, event) {
      for (const fn of watchers.get(key) ?? []) {
        try { fn(event); } catch { /* a dead browser must not break the rest */ }
      }
    },
    wait(hostId, ms) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => { waiters.delete(hostId); resolve(); }, ms);
        waiters.set(hostId, () => { clearTimeout(timer); waiters.delete(hostId); resolve(); });
      });
    },
    wake(hostId) {
      waiters.get(hostId)?.();
    },
  };
}

/**
 * Apply one event from a host about one of its desks.
 *
 * A hosted session is written into the same tables as a reported one, so the
 * rest of the floor — the queue, the staleness rule, the chat panel — cannot
 * tell the difference and does not need to. The extra state a host has that a
 * hook doesn't (the reply as it streams, a prompt it is holding open) lives in
 * `live`.
 */
function applyHostEvent(store, live, hostId, ev) {
  const channel = str(ev.channel);
  const agent = str(ev.agent);
  if (!channel || !agent) return false;
  const key = deskKey(channel, agent);
  const desk = store.hostedDesk(channel, agent);
  if (!desk || desk.host_id !== hostId) return false;

  const placeholder = placeholderSession(hostId, channel, agent);
  const sessionId = str(ev.session_id) ?? desk.sdk_session_id ?? placeholder;
  const now = new Date().toISOString();
  const turn = (role, text, toolName = null) => {
    const clipped = clip(text);
    if (!clipped && !toolName) return 0;
    const id = store.insertTurn({ channel, agent, session_id: sessionId, role, text: clipped, tool_name: toolName });
    live.publish(key, { type: 'turn', turn: { id, session_id: sessionId, role, text: clipped, tool_name: toolName, created_at: now } });
    return id;
  };
  const state = (s) => {
    store.setHostedState(channel, agent, s);
    live.publish(key, { type: 'state', state: s });
  };

  switch (str(ev.type)) {
    /**
     * Which conversation is live in that repo now — or none, when the window
     * has been closed. Not a handoff and nothing to arbitrate: the host simply
     * reports what `claude agents --json` says is there, and if the person
     * cleared the conversation or started a different one, that is the
     * conversation now.
     */
    case 'holder': {
      // Who is holding this desk's conversation, as of the host's last look.
      // Reported on its own so the floor knows within a poll rather than
      // within a heartbeat.
      store.setHostedHolder(channel, agent, {
        windowId: ev.holder === 'floor' ? (str(ev.window) ?? null) : null,
        outsidePid: ev.holder === 'editor' ? (Number(ev.pid) || null) : null,
      });
      break;
    }
    case 'session': {
      const live_id = str(ev.session_id);
      if (!live_id) {
        // No window open here. The desk stays, with the last conversation it
        // had, so opening one again continues rather than starts over.
        state('idle');
        break;
      }
      store.upsertSession({
        session_id: live_id, channel, agent, cwd: str(ev.cwd) ?? desk.cwd, runner: 'host', pid: Number(ev.pid) || null,
      });
      // A message sent to a repo with no window was filed under the
      // placeholder while one was opening. This is when the real id is known.
      if (live_id !== placeholder) store.rekeySession(channel, agent, placeholder, live_id);
      if (desk.sdk_session_id !== live_id) {
        store.setHostedSession(channel, agent, live_id);
        live.publish(key, { type: 'session', session_id: live_id });
      }
      store.ensurePersona(channel, agent);
      break;
    }

    /**
     * A turn, read from Claude Code's own transcript by the host.
     *
     * This is the floor's only source of conversation content, and it does not
     * care who typed it. A message you type in your own terminal arrives here
     * exactly like one sent from the floor's composer, because both of them
     * end up in the same transcript. That is the whole reason the floor no
     * longer needs to know which door a desk is being used through.
     */
    case 'turn': {
      const role = str(ev.role);
      if (role === 'tool') turn('tool', toolSummary(str(ev.tool_name) ?? 'tool', ev.tool_input), str(ev.tool_name));
      else if (role === 'user' || role === 'assistant') turn(role, ev.text);
      else return false;
      store.upsertSession({ session_id: sessionId, channel, agent, cwd: desk.cwd });
      break;
    }

    case 'error':
      turn('error', str(ev.message) ?? 'the host reported an error');
      store.setAwaiting(sessionId, 'error', clip(ev.message, 500));
      state('idle');
      break;

    default:
      return false;
  }
  return true;
}

/**
 * The floor's view: one entry per channel, one desk per agent.
 *
 * Sessions arrive newest-first, so the first one seen for a (channel, agent) is
 * the current one and the rest are that desk's history. A desk exists as soon as
 * a persona does, which means an agent that has posted a single hook event has a
 * seat — the alternative, waiting for it to also appear on the board, would show
 * an empty room to somebody whose windows are plainly open.
 */
export function buildFloor(store, live = null, sessions = null) {
  const nowMs = Date.now();
  const key = deskKey;

  const current = new Map();     // channel+agent -> newest session row

  const sessionCount = new Map();
  for (const s of store.floorSessions()) {
    const k = key(s.channel, s.agent);

    sessionCount.set(k, (sessionCount.get(k) ?? 0) + 1);
    if (!current.has(k)) current.set(k, s);
  }

  const lastTurn = new Map(store.lastTurns().map((t) => [key(t.channel, t.agent), t]));
  const turnCount = new Map(store.turnCounts().map((r) => [key(r.channel, r.agent), r.n]));

  // Hosted desks, with whether their host is actually there to hear us.
  const hosted = new Map();
  for (const h of store.listHostedDesks()) {
    const seen = iso(h.host_seen);
    hosted.set(key(h.channel, h.agent), {
      host_id: h.host_id,
      host_name: h.host_name ?? h.host_id,
      host_seen: seen,
      live: h.state !== 'offline' && secondsSince(seen, nowMs) < HOST_STALE_SECONDS,
      state: h.state,
      cwd: h.cwd,
      sdk_session_id: h.sdk_session_id,
      // Which window the floor drives, and the editor process holding this
      // conversation instead — the two facts that decide whether it can be
      // typed into from here.
      window_id: h.window_id ?? null,
      outside_pid: h.outside_pid ?? null,
    });
  }

  // Every agent the board knows gets a desk, not only the ones whose windows
  // run the plugin. A floor is a channel, and a channel with four agents on the
  // board and one desk in the room is a room that lies about who works there.
  // The desks without a session are drawn as not reporting, which also happens
  // to be the clearest possible reminder of who still needs the plugin.
  // Retired agents and archived channels stay off, matching the board's default.
  const archived = new Set(store.listChannelFlags().filter((f) => f.archived_at).map((f) => f.channel));
  // The board's row for each agent, kept rather than discarded: the desk's sign
  // shows what the board shows, and that comes off these same columns. A desk
  // can exist without one — a window can post hook events before its agent has
  // ever called an MCP tool — and then there is simply no sign to paint.
  const agentRows = new Map();
  for (const a of store.listAllAgents()) {
    if (a.retired_at || archived.has(a.channel)) continue;
    agentRows.set(key(a.channel, a.agent), a);
    store.ensurePersona(a.channel, a.agent);
  }
  const load = agentLoadIndex(store);
  // Keyed with deskKey so it lines up with `k` below, not with agent-state's
  // own NUL key.
  const mcp = mcpSessionCounts(sessions, key);

  // The board's channel-header numbers, so a storey can print the same line.
  // Shaped by agent-state.js rather than here — see channelCounts.
  const counts = channelCounts(store);

  const byChannel = new Map();
  const profiles = store.listProfiles();
  for (const p of store.listPersonas()) {
    if (archived.has(p.channel)) continue;
    if (!byChannel.has(p.channel)) byChannel.set(p.channel, []);
    byChannel.get(p.channel).push(p);
  }

  const queue = [];
  const channels = [...byChannel.keys()].sort().map((channel) => {
    const desks = byChannel
      .get(channel)
      .slice()
      .sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0) || a.agent.localeCompare(b.agent))
      .map((p) => {
        const k = key(channel, p.agent);
        const h = hosted.get(k) ?? null;
        const s = current.get(k) ?? null;
        const t = lastTurn.get(k) ?? null;
        // Said and did, kept apart, and looked up per desk — see the note on
        // deskLastMessage in db.js for why these are not one query each.
        const m = store.deskLastMessage(channel, p.agent);
        // Has the agent said anything since it was last spoken to? The bubble
        // shows the newest thing an agent said, and between a request landing
        // and the agent's first words there can be minutes — during which the
        // bubble still shows the answer to the *previous* question, so a desk
        // that has just been given new work is indistinguishable from one still
        // grinding on the old. A fact, reported here; the floor picks the words.
        const u = store.deskLastUserTurn(channel, p.agent);
        const heard = !!u && (!m || u.id > m.id);
        const awaitingSince = iso(s?.awaiting_since);
        // Live means "heard from recently", never "still open" — see
        // SESSION_STALE_MINUTES for why both halves of that matter. The one
        // exemption is a desk waiting on a human: no hooks fire while Claude
        // Code sits at a prompt, so that silence is expected, and aging the
        // longest-waiting person out of the queue that exists to surface them
        // would be exactly backwards. The queue shows the wait's age for the
        // same reason the board shows a status's age — `waiting · 2h` reads as
        // suspect on its own, so a prompt in a window somebody force-quit still
        // gets looked at rather than trusted forever.
        // A hosted desk is live exactly as long as its host is: the host says
        // so once a minute, and it is the one watching that repo's window.
        const heardMinutesAgo = s ? (nowMs - Date.parse(iso(s.updated_at))) / 60000 : Infinity;
        const hookLive = !!s && !s.ended_at && (s.awaiting_kind != null || heardMinutesAgo < SESSION_STALE_MINUTES);
        const live_ = h ? h.live : hookLive;
        const pendingReq = live ? live.pending.get(k) ?? null : null;

        if (live_ && s?.awaiting_kind) {
          queue.push({
            channel,
            agent: p.agent,
            persona: p.persona,
            kind: s.awaiting_kind,
            message: s.awaiting_message,
            since: awaitingSince,
            waiting_seconds: awaitingSince ? Math.max(0, Math.round((nowMs - Date.parse(awaitingSince)) / 1000)) : null,
            cwd: s.cwd,
            // The name of the window to go to. A full path is correct and
            // unreadable; the last segment is what the tab actually says.
            window: s.cwd ? s.cwd.split('/').filter(Boolean).pop() : null,
            session_id: s.session_id,
            // A hosted prompt can be answered right here — but only if the
            // floor can reach the window that is asking. Answering means
            // pressing a key in it, and a conversation open in an editor has
            // no window we can press a key in. Offering the buttons anyway
            // gave a prompt that swallowed a dozen clicks and never closed.
            hosted: !!h && !h.outside_pid,
            held: h?.outside_pid ? 'editor' : null,
            request_id: pendingReq?.request_id ?? null,
          });
        }

        return {
          agent: p.agent,
          persona: p.persona,
          // How to draw this one. Defaulted here rather than in the drawing code
          // so a desk always states it, and an unset agent cannot be told apart
          // from one deliberately set to neutral — they are the same thing.
          gender: profiles[p.agent]?.gender ?? 'neutral',
          // Resolved here, so a desk always states the colour it is drawn in and
          // the drawing code never has to know what a default is. Shirt is the
          // exception that needs no fallback in practice — it is written down
          // the first time a desk is seen — but one is kept for a profile row
          // that predates that.
          shirt: profiles[p.agent]?.shirt ?? shirtForSeat(p.seat ?? 0),
          hair: profiles[p.agent]?.hair ?? DEFAULT_HAIR,
          skin: profiles[p.agent]?.skin ?? DEFAULT_SKIN,
          seat: p.seat ?? 0,
          live: live_,
          // False until this desk's window has posted a single hook event — the
          // one distinction between "away" and "never installed the plugin".
          reporting: !!s,
          hosted: h
            ? {
                host: h.host_name,
                live: h.live,
                state: h.state,
                window: h.cwd ? h.cwd.split('/').filter(Boolean).pop() : null,
                // The conversation the panel is scoped to — whichever one is
                // live in that repo. Before a window has opened, the
                // placeholder the first message is filed under, so the panel is
                // scoped from the first keystroke rather than the first reply.
                session_id: h.sdk_session_id ?? placeholderSession(h.host_id, channel, p.agent),
                // Who is holding this conversation right now.
                //
                // A conversation is one process. When it is open in an editor,
                // the floor cannot type into it — not a failure, just where it
                // is. The floor says so and offers the move, instead of taking
                // a message it cannot deliver.
                held: h.outside_pid ? 'editor' : (h.window_id ? 'floor' : null),
                held_pid: h.outside_pid ?? null,
              }
            : null,
          // Whether the bell on this desk rings, decided here rather than on
          // the floor. A client-side re-derivation of this drifted within a
          // day: it read `held` and so treated "no window at all" as no
          // different from "our own window", and offered to nudge an agent
          // whose session had ended the day before.
          nudge: (() => {
            const v = nudgeable(h, nowMs);
            return v.error ? { ok: false, code: v.code, reason: v.error } : { ok: true, host: v.hosted.host_name ?? v.hosted.host_id };
          })(),
          permission: pendingReq,
          session: s
            ? {
                session_id: s.session_id,
                cwd: s.cwd,
                window: s.cwd ? s.cwd.split('/').filter(Boolean).pop() : null,
                model: s.model,
                permission_mode: s.permission_mode,
                git_branch: s.git_branch,
                started_at: iso(s.started_at),
                updated_at: iso(s.updated_at),
                ended_at: iso(s.ended_at),
                awaiting_kind: s.awaiting_kind,
                awaiting_message: s.awaiting_message,
                awaiting_since: awaitingSince,
              }
            : null,
          last_turn: t
            ? { role: t.role, text: t.text, tool_name: t.tool_name, at: iso(t.created_at), id: t.id }
            : null,
          // What this agent last said, which is what its thought bubble shows.
          // Separate from last_turn, which stays because it is what tells the
          // floor whether the desk is mid-tool-call and therefore working.
          last_message: m ? { text: m.text, at: iso(m.created_at), id: m.id } : null,
          // Spoken to, and not yet answered.
          heard: heard ? { at: iso(u.created_at), id: u.id } : null,
          // The last few tool calls, oldest first — the desk's monitor types
          // them out. Ids travel with them so the browser can tell a command it
          // has already typed from one that has just arrived.
          commands: store.deskCommands(channel, p.agent, SCREEN_COMMANDS),
          // What the board says about this agent — status, mailbox, task load.
          // Derived by the board's own code (agent-state.js) rather than
          // re-inferred here, so the sign on a desk and the row on the board
          // cannot drift into disagreeing about the same agent.
          board: agentRows.has(k) ? agentBoard(agentRows.get(k), load, nowMs, mcp.get(k) ?? 0) : null,
          turns: turnCount.get(k) ?? 0,
          sessions: sessionCount.get(k) ?? 0,
        };
      });

    return {
      channel,
      desks,
      live: desks.filter((d) => d.live).length,
      awaiting: desks.filter((d) => d.live && d.session?.awaiting_kind).length,
      // What the board prints in this channel's header. Same numbers, same
      // source, so the two surfaces cannot report different amounts of work.
      stats: counts.get(channel) ?? ZERO_COUNTS,
    };
  });

  // Longest-waiting first: the queue's only job is to answer "who has been stuck
  // on me the longest", and any other order makes the person reading it do that
  // sort in their head.
  queue.sort((a, b) => (b.waiting_seconds ?? 0) - (a.waiting_seconds ?? 0));

  const hosts = store.listHosts().map((h) => ({
    host_id: h.host_id,
    name: h.name,
    last_seen: iso(h.last_seen),
    live: secondsSince(iso(h.last_seen), nowMs) < HOST_STALE_SECONDS,
  }));

  return {
    now: new Date(nowMs).toISOString(),
    channels,
    queue,
    hosts,
    cast: CAST,
    totals: {
      channels: channels.length,
      desks: channels.reduce((n, c) => n + c.desks.length, 0),
      live: channels.reduce((n, c) => n + c.live, 0),
      awaiting: queue.length,
      hosted: channels.reduce((n, c) => n + c.desks.filter((d) => d.hosted?.live).length, 0),
    },
  };
}

export function createFloorRouter({ store, auth, sessions = null }) {
  const router = express.Router();
  const live = createLive();

  /* ───────────────────── the plugin's door ───────────────────── */

  /**
   * Where each workstation's hook plugin posts. Guarded by the same shared
   * secret as /mcp — see ingestGuard for why it is the same one.
   *
   * Always answers 200 for a well-formed event, even one it decided to ignore.
   * The caller is a hook running inside somebody's turn; a 4xx it can't act on
   * would only ever become noise in a terminal at the exact moment that person
   * is trying to concentrate on something else.
   */
  router.post('/api/ingest', auth.ingestGuard, (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ ok: false, error: 'expected a JSON object' });
    }
    try {
      const result = ingestHookEvent(store, body, live);
      return res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      console.warn(`[orchestratinator] ingest failed: ${err.message}`);
      return res.status(500).json({ ok: false, error: 'ingest failed' });
    }
  });

  /* ───────────────────── the host's doors ───────────────────── */

  /**
   * A host announces itself and the desks it can run. Called at startup and
   * then once a minute as a heartbeat, carrying any permission prompt it is
   * still holding open — which is how `live.pending` survives a server restart
   * without ever being written down.
   *
   * The reply tells the host which SDK session each desk last had, so a host
   * that restarted can resume the conversation rather than start a new one.
   */
  router.post('/api/host/register', auth.ingestGuard, (req, res) => {
    const hostId = str(req.body?.host_id);
    if (!hostId) return res.status(400).json({ error: 'host_id is required' });
    const name = str(req.body?.name) ?? hostId;
    store.registerHost(hostId, name, str(req.body?.tmux));

    const desks = Array.isArray(req.body?.desks) ? req.body.desks : [];
    const accepted = [];
    for (const d of desks) {
      const channel = str(d?.channel);
      const agent = str(d?.agent);
      const cwd = str(d?.cwd);
      if (!channel || !agent || !cwd) continue;
      store.hostDesk(channel, agent, hostId, cwd, {
        windowId: str(d?.window),
        outsidePid: Number(d?.outside_pid) || null,
      });
      store.ensurePersona(channel, agent);
      const row = store.hostedDesk(channel, agent);
      accepted.push({
        channel, agent, cwd,
        sdk_session_id: row?.sdk_session_id ?? null,
      });
    }

    for (const p of Array.isArray(req.body?.pending) ? req.body.pending : []) {
      applyHostEvent(store, live, hostId, { ...p, type: 'permission_request' });
    }

    res.json({ ok: true, host_id: hostId, desks: accepted, work_wait_max_ms: WORK_WAIT_MAX_MS });
  });

  /** A host going away cleanly. Its desks stay, marked offline, so the session
   *  ids they carry survive for the next time it comes back. */
  router.post('/api/host/unregister', auth.ingestGuard, (req, res) => {
    const hostId = str(req.body?.host_id);
    if (!hostId) return res.status(400).json({ error: 'host_id is required' });
    store.setHostState(hostId, 'offline');
    for (const d of store.listHostedDesks().filter((x) => x.host_id === hostId)) {
      const k = deskKey(d.channel, d.agent);
      live.pending.delete(k);
      live.partial.delete(k);
      live.publish(k, { type: 'state', state: 'offline' });
    }
    res.json({ ok: true });
  });

  /**
   * Work for a host: chat messages to deliver, permission decisions to apply,
   * interrupts. Held open for up to `wait` seconds so the host learns about a
   * message within milliseconds of it being typed without polling in a tight
   * loop, and without this server ever connecting *to* a workstation.
   */
  router.get('/api/host/work', auth.ingestGuard, async (req, res) => {
    const hostId = str(req.query.host_id);
    if (!hostId) return res.status(400).json({ error: 'host_id is required' });
    store.touchHost(hostId);
    const waitMs = Math.min(WORK_WAIT_MAX_MS, Math.max(0, Number(req.query.wait) || 0) * 1000);

    let items = store.takeHostWork(hostId);
    if (!items.length && waitMs > 0) {
      let gone = false;
      req.on('close', () => { gone = true; live.wake(hostId); });
      await live.wait(hostId, waitMs);
      if (gone) return;
      items = store.takeHostWork(hostId);
      store.touchHost(hostId);
    }
    res.json({ work: items });
  });

  /** What a host's desks are doing. A batch, because a streaming reply would
   *  otherwise be one HTTP request per token. */
  router.post('/api/host/events', auth.ingestGuard, (req, res) => {
    const hostId = str(req.body?.host_id);
    if (!hostId) return res.status(400).json({ error: 'host_id is required' });
    store.touchHost(hostId);
    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    let applied = 0;
    for (const ev of events) {
      try {
        if (ev && typeof ev === 'object' && applyHostEvent(store, live, hostId, ev)) applied++;
      } catch (err) {
        console.warn(`[orchestratinator] host event failed: ${err.message}`);
      }
    }
    res.json({ ok: true, applied });
  });

  /* ───────────────────── the browser's doors ───────────────────── */

  router.get('/api/floor', (_req, res) => {
    res.json(buildFloor(store, live, sessions));
  });

  /**
   * One desk's conversation. `since` is a turn id, so the panel can poll for
   * just what's new rather than refetching a whole conversation every couple of
   * seconds while somebody reads it.
   */
  router.get('/api/floor/turns', (req, res) => {
    const channel = str(req.query.channel);
    const agent = str(req.query.agent);
    if (!channel || !agent) return res.status(400).json({ error: 'channel and agent are required' });
    const since = Math.max(0, Number(req.query.since) || 0);
    const limit = Math.min(TURNS_MAX, Math.max(1, Number(req.query.limit) || TURNS_DEFAULT));
    const session = str(req.query.session);
    // A conversation can span session ids — a fork carries its parent's
    // history — so the filter is the chain, not the one id.
    const sessions = session ? store.sessionChain(session) : null;
    const rows = store.recentTurns(channel, agent, { since, limit, sessions }).map((r) => ({
      ...r,
      created_at: iso(r.created_at),
    }));
    res.json({ channel, agent, since, session, sessions, count: rows.length, rows, partial: live.partial.get(deskKey(channel, agent)) ?? '' });
  });

  /**
   * A desk, live. Server-sent events: each new turn, the reply as it streams,
   * state changes, and permission prompts as they open and close. Read-only,
   * like every other GET here, and it degrades to the two-second poll if a
   * proxy in the way doesn't like long responses.
   */
  router.get('/api/floor/stream', (req, res) => {
    const channel = str(req.query.channel);
    const agent = str(req.query.agent);
    if (!channel || !agent) return res.status(400).json({ error: 'channel and agent are required' });
    const key = deskKey(channel, agent);

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const send = (ev) => { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* closed */ } };

    // What's true right now, so a panel that just opened doesn't wait for the
    // next event to learn there is a reply mid-stream or a prompt open.
    if (live.partial.get(key)) send({ type: 'partial', text: live.partial.get(key) });
    if (live.pending.get(key)) send({ type: 'permission', request: live.pending.get(key) });

    const unsubscribe = live.subscribe(key, send);
    const heartbeat = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* closed */ } }, 15_000);
    req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
  });

  /**
   * Rename whoever sits at a desk. An operator action, so it takes the same CSRF
   * guard as the rest of them and is written where every viewer will see it —
   * a cast that only one browser agrees with is worse than no cast at all.
   */
  router.post('/api/floor/persona', auth.adminGuard, (req, res) => {
    const channel = str(req.body?.channel);
    const agent = str(req.body?.agent);
    const persona = str(req.body?.persona);
    if (!channel || !agent || !persona) {
      return res.status(400).json({ error: 'channel, agent and persona are required' });
    }
    if (persona.length > 40) return res.status(400).json({ error: 'persona must be 40 characters or fewer' });
    const changes = store.setProfile(channel, agent, { persona });
    store.logAdmin(channel, 'persona.set', { target: agent, detail: persona });
    res.json({ ok: true, changes, channel, agent, persona });
  });

  /**
   * Everything an operator chooses about an agent, in one edit.
   *
   * Both fields are optional and only what is sent is written, so the dialog can
   * save a name and an avatar together without either having to know the other's
   * current value. Applies to every channel at once, like the name it extends.
   */
  router.post('/api/floor/profile', auth.adminGuard, (req, res) => {
    const channel = str(req.body?.channel);
    const agent = str(req.body?.agent);
    if (!channel || !agent) return res.status(400).json({ error: 'channel and agent are required' });

    const patch = {};
    if (req.body?.persona !== undefined) {
      const persona = str(req.body.persona);
      if (!persona) return res.status(400).json({ error: 'persona cannot be empty — omit it to leave the name alone' });
      if (persona.length > 40) return res.status(400).json({ error: 'persona must be 40 characters or fewer' });
      patch.persona = persona;
    }
    if (req.body?.gender !== undefined) {
      const gender = str(req.body.gender);
      // Refused rather than silently coerced: a value this does not know would
      // otherwise be stored and then draw as neutral forever, looking saved.
      if (!GENDERS.includes(gender)) {
        return res.status(400).json({ error: `gender must be one of ${GENDERS.join(', ')}` });
      }
      patch.gender = gender;
    }
    // Colours are checked against the same lists the picker is drawn from, so
    // the only values that reach the database are ones an operator could have
    // clicked. An arbitrary hex would render — which is exactly why it has to
    // be refused here rather than trusted: nothing downstream would notice.
    for (const field of ['shirt', 'hair', 'skin']) {
      if (req.body?.[field] === undefined) continue;
      const value = str(req.body[field]);
      if (!PALETTE[field].includes(value)) {
        return res.status(400).json({ error: `${field} must be one of the ${PALETTE[field].length} colours offered for it` });
      }
      patch[field] = value;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to change' });

    const changes = store.setProfile(channel, agent, patch);
    for (const [k, v] of Object.entries(patch)) {
      store.logAdmin(channel, k === 'persona' ? 'persona.set' : 'avatar.set', { target: agent, detail: `${k}: ${v}` });
    }
    res.json({ ok: true, changes, channel, agent, ...patch });
  });

  /** A hosted desk that can take a message right now, or the reason it can't. */
  const hostedOrWhyNot = (channel, agent) => deliverable(store.hostedDesk(channel, agent));

  /**
   * Say something to a hosted desk. The message is a user turn in that session:
   * recorded here, handed to the host, and answered in the same conversation.
   * Refused, with the reason, when nothing is there to receive it — the floor
   * would rather say "the host is offline" than swallow a message.
   */
  router.post('/api/floor/chat', auth.adminGuard, (req, res) => {
    const channel = str(req.body?.channel);
    const agent = str(req.body?.agent);
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!channel || !agent || !text) return res.status(400).json({ error: 'channel, agent and text are required' });
    if (text.length > CHAT_MAX) return res.status(400).json({ error: `text must be ${CHAT_MAX} characters or fewer` });
    const check = hostedOrWhyNot(channel, agent);
    if (check.error) return res.status(409).json(check);

    const h = check.hosted;
    // The message is not written down here.
    //
    // It used to be, the moment it was accepted, and it was then written a
    // second time when the mirror read it back out of the window's own
    // transcript — so every message you sent appeared on the floor twice. The
    // deeper problem was that the first copy was a claim rather than a fact:
    // it appeared identically whether the window took the message or dropped
    // it. The conversation is what the window recorded, and nothing else, so
    // this enqueues the work and lets the mirror say what actually happened.
    // The page shows your message as sending until it comes back.
    // The host does the delivery: it types this into the desk's window, the
    // same window the person's own terminal is attached to. Nothing has to be
    // handed over first, so there is nothing to say here about whose turn it is.
    store.enqueueHostWork(h.host_id, channel, agent, 'chat', { text });
    live.wake(h.host_id);
    res.json({ ok: true, host: h.host_name ?? h.host_id });
  });

  /**
   * Move this desk's conversation into the editor.
   *
   * One process holds a conversation. If the floor has it open in a window of
   * its own, that window is closed first — two processes on one transcript is
   * the bug that made a message get answered by a copy nobody was watching.
   */
  router.post('/api/floor/handback', auth.adminGuard, (req, res) => {
    const channel = str(req.body?.channel);
    const agent = str(req.body?.agent);
    if (!channel || !agent) return res.status(400).json({ error: 'channel and agent are required' });
    const h = store.hostedDesk(channel, agent);
    if (!h) return res.status(409).json({ error: 'No host on this board is running that repo.', code: 'not_hosted' });
    store.enqueueHostWork(h.host_id, channel, agent, 'handback', {});
    live.wake(h.host_id);
    res.json({ ok: true });
  });


  /**
   * Move this desk's conversation onto the floor: open a window for it here.
   *
   * The other half of handback, and it was missing. The host has always known
   * how to do this — `case 'open'` opens the window and waits for it to come
   * up — but nothing ever asked, so the only way back from an editor was to
   * close the tab and then say something, because delivering a message opens a
   * window as a side effect. That left a desk sitting with no window and no way
   * to be given one, which reads as the floor having lost it.
   *
   * Refused while an editor still holds it. A conversation is one process, and
   * opening a window for one the editor has open is how you get two live copies
   * of the same transcript — the thing handback closes its own window to avoid.
   */
  router.post('/api/floor/open', auth.adminGuard, (req, res) => {
    const channel = str(req.body?.channel);
    const agent = str(req.body?.agent);
    if (!channel || !agent) return res.status(400).json({ error: 'channel and agent are required' });
    const h = store.hostedDesk(channel, agent);
    if (!h) return res.status(409).json({ error: 'No host on this board is running that repo.', code: 'not_hosted' });
    if (h.outside_pid) {
      return res.status(409).json({
        error: 'This conversation is open in your editor. Close it there first — one app holds a conversation at a time.',
        code: 'held_by_editor',
      });
    }
    if (h.window_id) return res.json({ ok: true, already: true });
    store.enqueueHostWork(h.host_id, channel, agent, 'open', {});
    live.wake(h.host_id);
    res.json({ ok: true });
  });

  /**
   * Answer a permission prompt a hosted desk is holding open. This is the
   * human-in-the-middle, done from the floor: the same decision the window
   * would have asked for, recorded as an operator action so the log can say
   * who allowed what.
   */
  router.post('/api/floor/permission', auth.adminGuard, (req, res) => {
    const channel = str(req.body?.channel);
    const agent = str(req.body?.agent);
    const requestId = str(req.body?.request_id);
    const decision = str(req.body?.decision);
    if (!channel || !agent || !requestId || !['allow', 'deny'].includes(decision)) {
      return res.status(400).json({ error: 'channel, agent, request_id and a decision of allow or deny are required' });
    }
    const check = hostedOrWhyNot(channel, agent);
    if (check.error) return res.status(409).json(check);
    const key = deskKey(channel, agent);
    const pendingReq = live.pending.get(key);
    if (!pendingReq || pendingReq.request_id !== requestId) {
      return res.status(409).json({ error: 'That prompt is no longer open.', code: 'stale_request' });
    }

    // One decision per prompt, taken here rather than queued once per click.
    //
    // Every click used to enqueue its own work item. When the window that
    // asked could not be reached, nothing visibly happened, so the button got
    // pressed again — and once a window did exist, twenty-nine queued
    // approvals arrived in it as twenty-nine keystrokes, which submitted
    // themselves as a message. Clearing the prompt first makes the second
    // click a no-op instead of a stored one.
    live.pending.delete(key);
    live.publish(key, { type: 'permission', request_id: requestId, decision, resolved: true });
    store.enqueueHostWork(check.hosted.host_id, channel, agent, 'permission', {
      request_id: requestId, decision, message: str(req.body?.message), queued_at: Date.now(),
    });
    live.wake(check.hosted.host_id);
    store.logAdmin(channel, `permission.${decision}`, { target: agent, detail: pendingReq.summary });
    res.json({ ok: true, request_id: requestId, decision });
  });

  /** Stop the current turn on a hosted desk. */
  router.post('/api/floor/interrupt', auth.adminGuard, (req, res) => {
    const channel = str(req.body?.channel);
    const agent = str(req.body?.agent);
    if (!channel || !agent) return res.status(400).json({ error: 'channel and agent are required' });
    const check = hostedOrWhyNot(channel, agent);
    if (check.error) return res.status(409).json(check);
    store.enqueueHostWork(check.hosted.host_id, channel, agent, 'interrupt', {});
    live.wake(check.hosted.host_id);
    store.logAdmin(channel, 'interrupt', { target: agent });
    res.json({ ok: true });
  });

  return router;
}

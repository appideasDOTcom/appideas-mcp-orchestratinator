import express from 'express';
import { CAST } from './db.js';

/**
 * The floor: what each agent's own Claude Code session is doing.
 *
 * The board (see web.js) answers "what have these agents agreed between
 * themselves". It deliberately cannot answer "who is stuck right now", because
 * an MCP server never sees inside an agent's turn — that limit is real and is
 * documented at length in the README. This module closes the gap from the other
 * end: Claude Code *can* see inside its own turn and will tell anyone who asks,
 * via hooks, so each workstation runs a small plugin that posts here.
 *
 * Two things follow from that, and they shape everything below:
 *
 *   - The data arrives by push, not poll. A window that goes quiet stops
 *     posting, which is information, but a window that is *switched off* also
 *     stops posting and looks identical. So nothing here infers "waiting" from
 *     silence. Waiting is only ever what Claude Code explicitly said it was
 *     waiting for — a permission prompt or an idle prompt — and it is cleared by
 *     the next thing that happens.
 *
 *   - It is conversation content. Full prompts and full replies, on a server
 *     whose dashboard has no sign-in. That is a deliberate choice for one
 *     trusted network (see the README's note on the port), but it is a bigger
 *     claim than the board ever made, and it is why `turns` is excluded from
 *     backups and why the ingest door needs the same secret as /mcp.
 */

/** Per-turn cap. Full text was the point, but one pasted logfile shouldn't
 *  become a row every viewer downloads every two seconds for the rest of time. */
const TEXT_MAX = 20_000;

/** How many turns the chat panel asks for at once. */
const TURNS_DEFAULT = 80;
const TURNS_MAX = 500;

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
const iso = (s) => (s ? `${String(s).replace(' ', 'T')}Z` : null);

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
 * Apply one hook event.
 *
 * Every event upserts the session first, because any event at all is proof the
 * window exists — and because most hook payloads carry only the common fields,
 * the upsert COALESCEs rather than overwrites, so a Stop can't blank the model a
 * SessionStart knew.
 */
export function ingestHookEvent(store, body) {
  const channel = str(body.channel);
  const agent = str(body.agent);
  const sessionId = str(body.session_id);
  if (!channel || !agent || !sessionId) {
    return { ok: false, error: 'channel, agent and session_id are required' };
  }
  const event = str(body.hook_event_name) ?? 'unknown';

  store.upsertSession({
    session_id: sessionId,
    channel,
    agent,
    cwd: str(body.cwd),
    transcript: str(body.transcript_path),
    model: str(body.model),
    permission_mode: str(body.permission_mode),
    git_branch: str(body.git_branch),
  });
  const persona = store.ensurePersona(channel, agent);

  const turn = (role, text, toolName = null) => {
    const clipped = clip(text);
    if (!clipped && !toolName) return 0;
    return store.insertTurn({
      channel, agent, session_id: sessionId, role, text: clipped, tool_name: toolName,
    });
  };

  // Ordered so the clear happens before anything that might set it again.
  if (CLEARS_AWAITING.has(event)) store.clearAwaiting(sessionId);

  let recorded = null;
  switch (event) {
    case 'SessionEnd':
      store.endSession(sessionId);
      break;

    case 'UserPromptSubmit':
      // The human just typed. By definition they are not the blocker any more,
      // which is why this event clears the queue entry above rather than waiting
      // for the turn to finish.
      if (body.message) recorded = turn('user', body.message);
      break;

    case 'Stop':
      if (body.last_assistant_message) recorded = turn('assistant', body.last_assistant_message);
      break;

    case 'PreToolUse':
      // Recorded as the tool *starts*, so the floor shows what is happening now
      // rather than what finished a moment ago. PostToolUse would be the honest
      // record of completion, but by then the interesting second has passed.
      if (str(body.tool_name)) {
        recorded = turn('tool', toolSummary(body.tool_name, body.tool_input), body.tool_name);
      }
      break;

    case 'PermissionRequest':
      store.setAwaiting(
        sessionId,
        'permission_request',
        str(body.tool_name) ? `${body.tool_name} needs a permission decision` : 'a tool needs a permission decision'
      );
      break;

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
 * The floor's view: one entry per channel, one desk per agent.
 *
 * Sessions arrive newest-first, so the first one seen for a (channel, agent) is
 * the current one and the rest are that desk's history. A desk exists as soon as
 * a persona does, which means an agent that has posted a single hook event has a
 * seat — the alternative, waiting for it to also appear on the board, would show
 * an empty room to somebody whose windows are plainly open.
 */
export function buildFloor(store) {
  const nowMs = Date.now();
  const NUL = String.fromCharCode(0);
  const key = (channel, agent) => [channel, agent].join(NUL);

  const current = new Map();     // channel+agent -> newest session row
  const sessionCount = new Map();
  for (const s of store.floorSessions()) {
    const k = key(s.channel, s.agent);
    sessionCount.set(k, (sessionCount.get(k) ?? 0) + 1);
    if (!current.has(k)) current.set(k, s);
  }

  const lastTurn = new Map(store.lastTurns().map((t) => [key(t.channel, t.agent), t]));
  const turnCount = new Map(store.turnCounts().map((r) => [key(r.channel, r.agent), r.n]));

  const byChannel = new Map();
  for (const p of store.listPersonas()) {
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
        const s = current.get(k) ?? null;
        const t = lastTurn.get(k) ?? null;
        const awaitingSince = iso(s?.awaiting_since);
        const live = !!s && !s.ended_at;

        if (live && s.awaiting_kind) {
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
          });
        }

        return {
          agent: p.agent,
          persona: p.persona,
          seat: p.seat ?? 0,
          live,
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
          turns: turnCount.get(k) ?? 0,
          sessions: sessionCount.get(k) ?? 0,
        };
      });

    return {
      channel,
      desks,
      live: desks.filter((d) => d.live).length,
      awaiting: desks.filter((d) => d.live && d.session?.awaiting_kind).length,
    };
  });

  // Longest-waiting first: the queue's only job is to answer "who has been stuck
  // on me the longest", and any other order makes the person reading it do that
  // sort in their head.
  queue.sort((a, b) => (b.waiting_seconds ?? 0) - (a.waiting_seconds ?? 0));

  return {
    now: new Date(nowMs).toISOString(),
    channels,
    queue,
    cast: CAST,
    totals: {
      channels: channels.length,
      desks: channels.reduce((n, c) => n + c.desks.length, 0),
      live: channels.reduce((n, c) => n + c.live, 0),
      awaiting: queue.length,
    },
  };
}

export function createFloorRouter({ store, auth }) {
  const router = express.Router();

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
      const result = ingestHookEvent(store, body);
      return res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      console.warn(`[orchestratinator] ingest failed: ${err.message}`);
      return res.status(500).json({ ok: false, error: 'ingest failed' });
    }
  });

  router.get('/api/floor', (_req, res) => {
    res.json(buildFloor(store));
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
    const rows = store.recentTurns(channel, agent, { since, limit }).map((r) => ({
      ...r,
      created_at: iso(r.created_at),
    }));
    res.json({ channel, agent, since, count: rows.length, rows });
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
    const changes = store.setPersona(channel, agent, persona);
    store.logAdmin(channel, 'persona.set', { target: agent, detail: persona });
    res.json({ ok: true, changes, channel, agent, persona });
  });

  return router;
}

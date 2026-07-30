import express from 'express';
import { fileURLToPath } from 'node:url';
import {
  SERVER_CHANNEL, hashPassword, normalizeUsername, passwordProblem, usernameProblem,
} from './auth.js';
import {
  applyBackup, backupFilename, buildBackup, snapshotBeforeRestore, validateBackup,
} from './backup.js';

/**
 * The dashboard: a small web UI (served at `/`), the JSON endpoints it polls,
 * and the operator actions it can take. Everything is derived from the same
 * SQLite database the MCP tools write to.
 *
 * The read half was originally the whole file, on the principle that the board
 * should only ever reflect coordination and never influence it. `/api/admin/*`
 * breaks that on purpose, because the alternative was worse: closing a stuck
 * task or clearing a dead agent's backlog meant hand-editing SQLite, and the
 * MCP surface already let any agent do both to anyone (complete_task has no
 * ownership check; poll_messages takes an `agent` override). These endpoints
 * grant no new authority — they make an existing one deliberate, attributed to
 * `operator`, and logged where the board can show it.
 *
 * `sessions` is the live MCP session registry owned by server.js, which prunes
 * superseded and idle entries so a row in it means "a window we've heard from
 * lately" rather than "a window that once said hello".
 */

const UI_DIR = fileURLToPath(new URL('./ui', import.meta.url));

// An agent with no live session but a recent tool call is probably still there
// (its window is open, it just isn't polling). Past this it's shown as offline.
const RECENT_MINUTES = 5;
// Fallback expiry for statuses written before `status_expires_at` existed.
// Current writes carry their own expiry — see set_status's ttl_seconds.
const LEGACY_STATUS_TTL_MINUTES = 30;

// The agent told us its state, so map it straight to a chip tone rather than
// guessing from the words. `blocked` is deliberately distinct from `waiting`:
// waiting resolves on its own, blocked needs a human.
const STATE_TONE = { working: 'busy', waiting: 'waiting', blocked: 'blocked', idle: 'idle' };

// How many unfinished tasks per channel /api/state carries in full. The counts
// are always exact; this bounds only the list the task dialog offers, because
// this payload is refetched every couple of seconds.
const TASK_LIST_MAX = 25;

// What a plain nudge says: the dashboard's stand-in for typing "check your
// messages" into that agent's own window. It asks for ordinary behaviour — read,
// act, answer — and deliberately says nothing about being brief or selective,
// because a nudge that discourages a reply is a different button (below).
// Works with an empty backlog too: the reason to nudge an agent is often that it
// has gone quiet with nothing unread at all.
const NUDGE = (unread) =>
  'Operator: ' +
  (unread
    ? `you have ${unread} unread message${unread === 1 ? '' : 's'} waiting on this channel. `
    : 'checking in on this channel. ') +
  'Please poll your messages, look at the task board, handle anything that is yours, and respond normally — ' +
  'treat this exactly as if I had typed it into your own window. Call set_status so the board shows where you landed.';

// What a "catch up quietly" nudge actually says. Phrased so an agent that reads
// it does the right thing without a human in the loop: skim, act only on what
// matters, and leave a status behind so the board reflects the outcome.
const CATCH_UP = (unread, upTo) =>
  `Operator: you have ${unread} unread message${unread === 1 ? '' : 's'} on this channel, up to id ${upTo}. ` +
  'Please skim them, act only on anything urgent or addressed directly to you, and reply only if a reply is genuinely needed. ' +
  'Then call set_status so the board shows where you landed.';

const NUDGE_STYLES = new Set(['normal', 'quiet']);

/** SQLite `datetime('now')` is UTC without a zone marker — make it a real ISO string. */
const iso = (s) => (s ? `${String(s).replace(' ', 'T')}Z` : null);
const ageMinutes = (isoStr, nowMs) => (isoStr ? (nowMs - Date.parse(isoStr)) / 60000 : Infinity);

/** Group rows into a Map keyed by one column. */
function index(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

/**
 * Best-effort answer to "what is this agent doing right now?".
 *
 * A live self-reported status (via the `set_status` tool) always wins — only
 * the agent knows whether a quiet stretch is work, a wait, or a crash. Once it
 * expires we treat it as absent and infer from what the agent holds on the task
 * board and what's waiting in its mailbox.
 *
 * Note what is deliberately NOT inferred: nothing here reads a long gap since
 * `last_action` as "waiting". That gap looks identical whether the agent is
 * blocked, crashed, or finished and quiet, so it can only produce a confident
 * wrong answer.
 */
function deriveState({ reported, reportedDetail, expired, claimed, assignedOpen, unread }) {
  if (reported && !expired) {
    return {
      label: reported,
      detail: reportedDetail ?? null,
      tone: STATE_TONE[reported] ?? 'busy',
      source: 'reported',
    };
  }
  // No age here on purpose: `reported_at` is the fact and the client derives the
  // age from it. Baking a minute-counter into this payload would change it every
  // minute and defeat the dashboard's re-render memo.
  const derived = (label, tone) => ({ label, detail: null, tone, source: 'derived' });
  if (claimed.length) {
    const t = claimed[0];
    return derived(
      claimed.length > 1 ? `working — ${claimed.length} claimed tasks` : `working — #${t.id} ${t.title}`,
      'busy'
    );
  }
  if (unread > 0) {
    return derived(`waiting — ${unread} unread message${unread === 1 ? '' : 's'}`, 'waiting');
  }
  if (assignedOpen > 0) {
    return derived(`waiting — ${assignedOpen} task${assignedOpen === 1 ? '' : 's'} assigned`, 'waiting');
  }
  return derived('idle', 'idle');
}

function buildState(store, sessions, sessionStats, meta) {
  const nowMs = Date.now();

  const liveByKey = new Map();   // `${channel}\u0000${agent}` -> session count
  const liveSessions = [];
  for (const s of Object.values(sessions)) {
    liveSessions.push({
      id: s.id.slice(0, 8),
      channel: s.channel,
      agent: s.agent,
      connected_at: s.connected_at,
      last_seen: s.last_seen,
    });
    if (s.channel && s.agent) {
      const k = `${s.channel}\u0000${s.agent}`;
      liveByKey.set(k, (liveByKey.get(k) ?? 0) + 1);
    }
  }

  const agentRows = store.listAllAgents();
  const load = store.agentTaskLoad();
  const claimed = store.claimedTasks();
  const unread = store.unreadCounts();
  const stats = store.channelStats();
  const archivedAt = new Map(
    store.listChannelFlags().filter((f) => f.archived_at).map((f) => [f.channel, f.archived_at])
  );
  const tasksByChannel = index(store.boardTasks(), (t) => t.channel);
  // The same NUL-joined compound key the maps below use — neither a channel nor
  // an agent name can contain one, so a pair can never collide.
  const NUL = String.fromCharCode(0);
  const agentKey = (channel, agent) => [channel, agent].join(NUL);
  const unreadMaxByAgent = new Map(unread.map((r) => [agentKey(r.channel, r.agent), r.unread_max_id]));

  const claimedByAgent = index(claimed.filter((t) => t.claimed_by), (t) => `${t.channel}\u0000${t.claimed_by}`);
  const unreadByAgent = new Map(unread.map((r) => [`${r.channel}\u0000${r.agent}`, r.unread]));
  const assignedByAgent = new Map();
  const unassignedByChannel = new Map();
  for (const r of load) {
    if (r.bucket === 'unassigned') unassignedByChannel.set(r.channel, r.n);
    else if (r.agent) {
      const k = `${r.channel}\u0000${r.agent}`;
      assignedByAgent.set(k, { ...(assignedByAgent.get(k) ?? {}), [r.bucket]: r.n });
    }
  }

  const taskCounts = new Map();
  for (const r of stats.tasks) {
    const c = taskCounts.get(r.channel) ?? { open: 0, claimed: 0, done: 0 };
    c[r.status] = r.n;
    taskCounts.set(r.channel, c);
  }
  const messageCounts = new Map(stats.messages.map((r) => [r.channel, r.n]));
  const contractCounts = new Map(stats.contracts.map((r) => [r.channel, r.n]));

  // Channels known to the database, plus any a live session claims but that has
  // yet to write anything.
  const channelNames = new Set(store.listAllChannels());
  for (const s of liveSessions) if (s.channel) channelNames.add(s.channel);

  const agentsByChannel = index(agentRows, (r) => r.channel);
  // A session whose agent has never called a tool still deserves a row.
  for (const s of liveSessions) {
    if (!s.channel || !s.agent) continue;
    const list = agentsByChannel.get(s.channel) ?? [];
    if (!list.some((a) => a.agent === s.agent)) {
      list.push({ channel: s.channel, agent: s.agent, last_seen: null, status: null, status_detail: null, status_at: null, status_expires_at: null, last_action: null, last_action_at: null, poll_cursor: 0 });
      agentsByChannel.set(s.channel, list);
    }
  }

  const channels = [...channelNames].sort().map((channel) => {
    const allAgents = (agentsByChannel.get(channel) ?? [])
      .slice()
      .sort((a, b) => a.agent.localeCompare(b.agent))
      .map((a) => {
        const k = `${channel}\u0000${a.agent}`;
        const liveCount = liveByKey.get(k) ?? 0;
        const lastSeen = iso(a.last_seen);
        const seenAgeMin = ageMinutes(lastSeen, nowMs);
        const presence = liveCount > 0 ? 'connected' : seenAgeMin <= RECENT_MINUTES ? 'recent' : 'offline';
        const mine = claimedByAgent.get(k) ?? [];
        const reportedAt = iso(a.status_at);
        const reportedAgeMin = ageMinutes(reportedAt, nowMs);
        // Prefer the expiry the agent chose; rows predating that column fall
        // back to the old server-wide window so they still age off.
        const expiresAt = iso(a.status_expires_at);
        const expired = expiresAt
          ? Date.parse(expiresAt) <= nowMs
          : reportedAgeMin > LEGACY_STATUS_TTL_MINUTES;
        const state = deriveState({
          reported: a.status,
          reportedDetail: a.status_detail,
          expired,
          claimed: mine,
          assignedOpen: assignedByAgent.get(k)?.assigned ?? 0,
          unread: unreadByAgent.get(k) ?? 0,
        });
        return {
          agent: a.agent,
          presence,
          sessions: liveCount,
          state,
          last_seen: lastSeen,
          last_action: a.last_action,
          last_action_at: iso(a.last_action_at),
          reported_status: a.status,
          reported_detail: a.status_detail ?? null,
          reported_at: reportedAt,
          reported_expires_at: expiresAt,
          reported_expired: !!a.status && expired,
          unread: unreadByAgent.get(k) ?? 0,
          // The id "mark read" has to advance to. The browser echoes this back so
          // a message that arrives between render and click isn't swallowed.
          unread_max_id: unreadMaxByAgent.get(agentKey(channel, a.agent)) ?? null,
          retired: !!a.retired_at,
          retired_at: iso(a.retired_at),
          claimed_tasks: mine.map((t) => ({ id: t.id, title: t.title })),
          assigned_open: assignedByAgent.get(k)?.assigned ?? 0,
        };
      });

    // Retired agents ship in their own list rather than being dropped: the board
    // shows a "retired (N)" affordance, because silently omitting a row is the
    // one way this feature could mislead rather than declutter.
    const agents = allAgents.filter((a) => !a.retired);
    const retiredAgents = allAgents.filter((a) => a.retired);

    const tasks = taskCounts.get(channel) ?? { open: 0, claimed: 0, done: 0 };
    const unfinished = tasksByChannel.get(channel) ?? [];
    return {
      channel,
      archived: archivedAt.has(channel),
      archived_at: iso(archivedAt.get(channel)),
      connected: agents.filter((a) => a.presence === 'connected').length,
      agents,
      retired_agents: retiredAgents,
      tasks: { ...tasks, unassigned_open: unassignedByChannel.get(channel) ?? 0 },
      // The counts above are exact; this list is capped (see TASK_LIST_MAX) and
      // exists so the task dialog can name a task rather than just count it.
      task_list: unfinished.slice(0, TASK_LIST_MAX).map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        assignee: t.assignee,
        claimed_by: t.claimed_by,
        updated_at: iso(t.updated_at),
      })),
      task_list_total: unfinished.length,
      messages: messageCounts.get(channel) ?? 0,
      contracts: contractCounts.get(channel) ?? 0,
    };
  });

  const visible = channels.filter((c) => !c.archived);

  return {
    server: {
      name: meta.name,
      version: meta.version,
      port: meta.port,
      db_path: meta.dbPath,
      claim_ttl_minutes: meta.claimTtlMinutes,
      session_ttl_minutes: meta.sessionTtlMinutes,
      // Lifetime connection churn. Clients that open a session per turn instead
      // of reusing one show up here as a large `superseded`.
      session_stats: { ...(sessionStats ?? {}) },
      started_at: meta.startedAt,
      uptime_seconds: Math.round((nowMs - Date.parse(meta.startedAt)) / 1000),
      now: new Date(nowMs).toISOString(),
    },
    sessions: liveSessions.sort((a, b) => (a.channel ?? '').localeCompare(b.channel ?? '')),
    channels,
    // Totals describe the board as displayed, so archived channels and retired
    // agents are excluded — a header that counts things you can't see is worse
    // than no header. Both are reported separately so nothing is hidden silently.
    totals: {
      channels: visible.length,
      agents: visible.reduce((n, c) => n + c.agents.length, 0),
      // Agents, not sessions: one window can churn through many sessions, and
      // "2 agents · 21 connected" is a nonsense sentence.
      connected: visible.reduce((n, c) => n + c.connected, 0),
      live_sessions: liveSessions.length,
      open_tasks: visible.reduce((n, c) => n + c.tasks.open, 0),
      claimed_tasks: visible.reduce((n, c) => n + c.tasks.claimed, 0),
      archived_channels: channels.length - visible.length,
      retired_agents: channels.reduce((n, c) => n + c.retired_agents.length, 0),
    },
  };
}

/**
 * The operator surface. Every route here is a write, so every route is guarded
 * (see auth.adminGuard — enforced regardless of how open the read side is) and
 * every route leaves an `admin_events` row behind, which the activity feed
 * shows. Identity is always the literal `operator`, never a borrowed agent name,
 * so a human's cleanup can never be mistaken for an agent finishing work.
 *
 * Channel and agent names travel in the JSON body rather than the path: they're
 * free-form strings, and a path segment would need encoding conventions that
 * only exist to be got wrong.
 */
function createAdminRouter({ store, auth, closeSessionsFor, meta }) {
  const router = express.Router();

  // Ahead of the guard below — this is the endpoint that hands out the token the
  // guard wants, so it has its own (stricter) check.
  router.get('/token', auth.adminTokenGuard, (_req, res) => {
    res.json({ token: auth.adminToken });
  });

  router.use(auth.adminGuard);

  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const bad = (res, error) => res.status(400).json({ error });
  const missing = (res, error) => res.status(404).json({ error });

  /** Pull and validate the (channel, agent) pair every agent route needs. */
  const pair = (req) => ({ channel: str(req.body?.channel), agent: str(req.body?.agent) });
  /** Does this agent have a row at all? unreadCounts has one per agent row. */
  const agentRow = (channel, agent) =>
    store.unreadCounts().find((r) => r.channel === channel && r.agent === agent) ?? null;

  // Mark a backlog read on the agent's behalf. The store clamps with
  // MAX(poll_cursor, …) so this can only ever move forward — a stale dialog
  // can't rewind a cursor and resurrect messages the agent already dealt with.
  router.post('/agent/advance', (req, res) => {
    const { channel, agent } = pair(req);
    const upTo = Number(req.body?.up_to_id);
    if (!channel || !agent) return bad(res, 'channel and agent are required');
    if (!Number.isInteger(upTo) || upTo < 0) return bad(res, 'up_to_id must be a non-negative integer');
    const row = agentRow(channel, agent);
    if (!row) return missing(res, `no agent "${agent}" on channel "${channel}"`);
    const before = row.unread;
    store.advancePollCursor(channel, agent, upTo);
    const after = agentRow(channel, agent)?.unread ?? 0;
    store.logAdmin(channel, 'advance', {
      target: agent,
      detail: `marked ${before - after} message(s) read up to id ${upTo}`,
    });
    res.json({ ok: true, channel, agent, cursor: upTo, cleared: before - after, unread: after });
  });

  /**
   * Poke an agent from the dashboard instead of from its own window.
   *
   * Three flavours, all the same delivery: `normal` (the default) asks for
   * ordinary behaviour, `quiet` asks it to drain a backlog without chatter, and
   * any `text` is sent verbatim so the dashboard can carry your own words.
   *
   * This is a queued message, not a wake-up: MCP is pull-only, so it lands on the
   * agent's next poll. An agent running a poll loop picks it up within one loop
   * interval; a window that never polls again never sees it. `agent` needs no
   * backlog — the whole point of the plain nudge is that it works on an idle one.
   */
  router.post('/agent/nudge', (req, res) => {
    const { channel, agent } = pair(req);
    if (!channel || !agent) return bad(res, 'channel and agent are required');
    const style = str(req.body?.style) ?? 'normal';
    if (!NUDGE_STYLES.has(style)) return bad(res, `style must be one of: ${[...NUDGE_STYLES].join(', ')}`);
    const row = agentRow(channel, agent);
    if (!row) return missing(res, `no agent "${agent}" on channel "${channel}"`);
    const custom = str(req.body?.text);
    const text = custom ?? (style === 'quiet' ? CATCH_UP(row.unread, row.unread_max_id ?? 0) : NUDGE(row.unread));
    const id = store.insertMessage(channel, 'operator', agent, JSON.stringify({ kind: 'operator-nudge', text }));
    store.logAdmin(channel, 'nudge', { target: agent, detail: text });
    res.json({
      ok: true,
      channel,
      agent,
      style: custom ? 'custom' : style,
      message_id: id,
      text,
      queued_behind_unread: row.unread,
    });
  });

  /**
   * Take an agent off the board: clear its backlog, close its live sessions, flag
   * the row retired.
   *
   * Closing the sessions is what makes this meaningful rather than cosmetic. An
   * unknown session id answers 404, which the MCP spec tells clients to
   * re-initialise on — so a window that's still alive comes straight back and
   * un-retires itself (see touchAgent), while a dead one stays gone. "Prove
   * you're alive or stay off the board."
   */
  router.post('/agent/retire', (req, res) => {
    const { channel, agent } = pair(req);
    if (!channel || !agent) return bad(res, 'channel and agent are required');
    const row = agentRow(channel, agent);
    if (!row) return missing(res, `no agent "${agent}" on channel "${channel}"`);
    if (row.unread_max_id) store.advancePollCursor(channel, agent, row.unread_max_id);
    const closed = closeSessionsFor({ channel, agent });
    store.retireAgent(channel, agent);
    store.logAdmin(channel, 'retire', {
      target: agent,
      detail: `cleared ${row.unread} unread, closed ${closed} live session(s)`,
    });
    res.json({ ok: true, channel, agent, cleared: row.unread, sessions_closed: closed });
  });

  router.post('/agent/unretire', (req, res) => {
    const { channel, agent } = pair(req);
    if (!channel || !agent) return bad(res, 'channel and agent are required');
    if (!store.unretireAgent(channel, agent)) return missing(res, `no agent "${agent}" on channel "${channel}"`);
    store.logAdmin(channel, 'unretire', { target: agent, detail: 'restored to the board' });
    res.json({ ok: true, channel, agent });
  });

  router.post('/task/close', (req, res) => {
    const channel = str(req.body?.channel);
    const id = Number(req.body?.id);
    if (!channel || !Number.isInteger(id)) return bad(res, 'channel and an integer id are required');
    const note = str(req.body?.note) ?? 'closed from the dashboard by the operator';
    if (!store.completeTask(channel, id, note, 'operator')) {
      return missing(res, `task #${id} not found on "${channel}", or already done`);
    }
    store.logAdmin(channel, 'task.close', { target: `#${id}`, detail: note });
    res.json({ ok: true, channel, id, note });
  });

  router.post('/task/reassign', (req, res) => {
    const channel = str(req.body?.channel);
    const id = Number(req.body?.id);
    if (!channel || !Number.isInteger(id)) return bad(res, 'channel and an integer id are required');
    // An explicit null is meaningful: it puts the task back in the unassigned
    // pool for whoever picks it up first.
    const assignee = str(req.body?.assignee);
    if (!store.reassignTask(channel, id, assignee)) {
      return missing(res, `task #${id} not found on "${channel}", or already done`);
    }
    store.logAdmin(channel, 'task.reassign', { target: `#${id}`, detail: assignee ? `assigned to ${assignee}` : 'unassigned' });
    res.json({ ok: true, channel, id, assignee });
  });

  // Archive is non-destructive and reversible, so it deliberately does NOT close
  // sessions: agents on the channel keep working, their writes keep landing, and
  // unarchiving shows the lot. Hiding is a statement about your attention, not
  // about their work.
  for (const [path, archived, action] of [['archive', true, 'channel.archive'], ['unarchive', false, 'channel.unarchive']]) {
    router.post(`/channel/${path}`, (req, res) => {
      const channel = str(req.body?.channel);
      if (!channel) return bad(res, 'channel is required');
      store.setChannelArchived(channel, archived, 'operator');
      store.logAdmin(channel, action, { target: channel, detail: archived ? 'hidden from the board' : 'restored to the board' });
      res.json({ ok: true, channel, archived });
    });
  }

  /**
   * Permanent, unrecoverable deletion of everything on a channel. Guarded by
   * having to name the channel exactly: this is the one action on the board with
   * no undo, and the only backup is whatever the Docker volume happens to hold.
   */
  router.post('/channel/delete', (req, res) => {
    const channel = str(req.body?.channel);
    const confirm = str(req.body?.confirm);
    if (!channel) return bad(res, 'channel is required');
    if (confirm !== channel) return bad(res, 'confirm must exactly match the channel name');
    const closed = closeSessionsFor({ channel });
    const deleted = store.purgeChannel(channel, 'operator');
    res.json({ ok: true, channel, deleted, sessions_closed: closed });
  });

  /* ---------- dashboard users ---------- */

  /**
   * Who may open the dashboard. Every account is an admin — the model is "people
   * I know by name", so there are no roles to get wrong, and the only rules are
   * the two that stop the board being locked away from the person at the keyboard.
   *
   * `you` is the account this request is authenticated as, and is null for a
   * caller using the shared secret instead of a login. That's what the self-rules
   * key off, so a shared-secret caller is unrestricted: it has no account to
   * strand itself out of, and it is the way back in when someone does.
   */
  const you = (req) => auth.actor(req);
  const logUser = (req, action, target, detail) =>
    store.logAdmin(SERVER_CHANNEL, action, { actor: you(req) ?? 'operator', target, detail });

  router.get('/users', (req, res) => {
    res.json({
      // Timestamps through `iso` like everywhere else: SQLite's datetime('now') has
      // no zone marker, and a browser parsing it raw reads UTC as local time.
      users: store.listUsers().map((u) => ({
        ...u,
        created_at: iso(u.created_at),
        updated_at: iso(u.updated_at),
        last_login: iso(u.last_login),
      })),
      you: you(req),
      login_required: auth.loginRequired(),
      session_days: auth.sessionDays,
    });
  });

  router.post('/users/create', (req, res) => {
    const username = normalizeUsername(req.body?.username);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const problem = usernameProblem(username) ?? passwordProblem(password);
    if (problem) return bad(res, problem);
    if (req.body?.verify != null && req.body.verify !== password) return bad(res, 'the two passwords do not match');
    if (store.getUser(username)) return res.status(409).json({ error: `"${username}" already has an account` });
    store.createUser(username, hashPassword(password), true);
    auth.usersChanged();
    logUser(req, 'user.create', username, `created the account "${username}"`);
    res.json({ ok: true, username, user: store.getUser(username) });
  });

  /**
   * Rename, change a password, or both.
   *
   * An empty password means "leave it alone", which is what makes it possible to
   * fix a typo'd username without knowing the password behind it. A password that
   * *is* supplied signs that person out of every other browser: the credential
   * their cookies were issued against no longer exists. Every browser except this
   * one — being logged out by your own password change reads as a bug, and the
   * request itself is proof this browser is entitled to stay.
   */
  router.post('/users/update', (req, res) => {
    const username = normalizeUsername(req.body?.username);
    if (!store.getUser(username)) return missing(res, `no account "${username}"`);
    const rename = req.body?.new_username == null || req.body.new_username === ''
      ? null
      : normalizeUsername(req.body.new_username);
    const password = typeof req.body?.password === 'string' && req.body.password ? req.body.password : null;
    if (!rename && !password) return bad(res, 'nothing to change — supply a new username, a new password, or both');

    if (rename && rename !== username) {
      const problem = usernameProblem(rename);
      if (problem) return bad(res, problem);
      if (store.getUser(rename)) return res.status(409).json({ error: `"${rename}" already has an account` });
    }
    if (password) {
      const problem = passwordProblem(password);
      if (problem) return bad(res, problem);
      if (req.body?.verify != null && req.body.verify !== password) return bad(res, 'the two passwords do not match');
    }

    const changed = [];
    let name = username;
    if (rename && rename !== username) {
      store.renameUser(username, rename);
      // Sessions follow the account. Dropping them instead would sign someone out
      // for a change that has nothing to do with their credentials.
      store.renameUiSessions(username, rename);
      name = rename;
      changed.push(`renamed "${username}" to "${rename}"`);
    }
    if (password) {
      store.setUserPassword(name, hashPassword(password));
      const keep = auth.sessionIdOf(req);
      const out = you(req) === name && keep
        ? store.deleteUiSessionsExcept(name, keep)
        : store.deleteUiSessionsFor(name);
      changed.push(`changed the password${out ? `, signing out ${out} other browser session${out === 1 ? '' : 's'}` : ''}`);
    }
    auth.usersChanged();
    logUser(req, 'user.update', name, changed.join(' and '));
    res.json({ ok: true, username: name, user: store.getUser(name), changed });
  });

  // Disabling is the reversible half of removing someone: their sessions stop
  // working on the next request (see getUiSession's join) and start working again
  // if you re-enable them, without anybody having to re-issue a password.
  router.post('/users/enabled', (req, res) => {
    const username = normalizeUsername(req.body?.username);
    const enabled = !!req.body?.enabled;
    const user = store.getUser(username);
    if (!user) return missing(res, `no account "${username}"`);
    if (!enabled && you(req) === username) {
      return bad(res, 'you cannot disable the account you are signed in as');
    }
    if (user.enabled === enabled) return res.json({ ok: true, username, user, unchanged: true });
    store.setUserEnabled(username, enabled);
    auth.usersChanged();
    logUser(req, enabled ? 'user.enable' : 'user.disable', username, `${enabled ? 'enabled' : 'disabled'} the account "${username}"`);
    res.json({ ok: true, username, user: store.getUser(username) });
  });

  router.post('/users/delete', (req, res) => {
    const username = normalizeUsername(req.body?.username);
    if (!store.getUser(username)) return missing(res, `no account "${username}"`);
    if (you(req) === username) return bad(res, 'you cannot delete the account you are signed in as');
    store.deleteUiSessionsFor(username);
    store.deleteUser(username);
    auth.usersChanged();
    logUser(req, 'user.delete', username, `deleted the account "${username}"`);
    // Said out loud rather than left to be discovered: with no accounts left the
    // dashboard stops asking anyone to sign in.
    const left = store.countEnabledUsers();
    res.json({
      ok: true,
      username,
      enabled_users_left: left,
      ...(left === 0 ? { warning: 'no enabled accounts remain — the dashboard no longer requires a sign-in' } : {}),
    });
  });

  /* ---------- backup and restore ---------- */

  /**
   * The whole board as one downloadable file. See src/backup.js for what is in it
   * and, more importantly, what isn't: the shared MCP secret never travels, and
   * live login cookies never travel.
   */
  router.get('/backup', (req, res) => {
    const doc = buildBackup({ store, meta: { ...meta, authMode: auth.mode } });
    const name = backupFilename();
    logUser(req, 'backup.export', name, `exported ${doc.counts ? Object.values(doc.counts).reduce((n, v) => n + v, 0) : 0} rows`);
    res.set('Content-Disposition', `attachment; filename="${name}"`);
    res.set('Cache-Control', 'no-store');
    res.json(doc);
  });

  /**
   * Load a backup over the top of this board.
   *
   * Everything currently here goes. A merge was the other option and it's the
   * wrong one: ids are per-board, so blending two histories produces a task #14
   * that means two different things depending on which half you read. Guarded the
   * same way channel deletion is — by making you type the word — and softened the
   * only way a destructive action can honestly be softened, by writing the current
   * board to the data directory first.
   */
  router.post('/backup/restore', (req, res) => {
    if (str(req.body?.confirm) !== 'RESTORE') {
      return bad(res, 'confirm must be the word RESTORE — a restore replaces everything currently on this board');
    }
    const doc = req.body?.backup;
    const problem = validateBackup(doc);
    if (problem) return bad(res, problem);

    const snapshot = snapshotBeforeRestore({ store, meta: { ...meta, authMode: auth.mode } });
    // Every live MCP session refers to channels and agents that are about to be
    // replaced. An unknown session id answers 404, which the spec tells clients to
    // re-initialise on, so a window that's still alive rejoins the restored board.
    const closed = closeSessionsFor({ all: true });
    const applied = applyBackup({ store, doc });
    auth.usersChanged();

    // Replacing the users table dropped every login, this one included. If the
    // restored table still lists the person doing the restore as an enabled
    // account, sign them straight back in: being bounced to a login form by your
    // own restore means never seeing the report of what it did, and they hold the
    // operator token either way. Anyone else re-authenticates.
    const actor = you(req);
    if (applied.replaced_users && actor && store.getUser(actor)?.enabled) {
      auth.issueSession(req, res, actor);
      applied.notes.push(`kept you signed in as "${actor}" — that account is in the backup too`);
    }

    // Logged after the restore, never before: the restore wipes admin_events, so a
    // row written first would be destroyed by the thing it was recording.
    logUser(req, 'backup.restore', doc.created_at ?? 'backup',
      `restored ${applied.rows} rows from a backup taken ${doc.created_at ?? 'at an unrecorded time'}` +
      (snapshot.saved ? `; previous board saved to ${snapshot.path}` : '; the pre-restore snapshot could not be written'));

    res.json({
      ok: true,
      restored_from: doc.created_at ?? null,
      source_version: doc.server?.version ?? null,
      rows: applied.rows,
      tables: applied.report,
      notes: applied.notes,
      replaced_users: applied.replaced_users,
      sessions_closed: closed,
      snapshot,
      shared_secret: doc.auth?.shared_secret_fingerprint ?? null,
    });
  });

  return router;
}

export function createWebRouter({ store, sessions, sessionStats, meta, auth, closeSessionsFor }) {
  const router = express.Router();

  router.use('/api/admin', createAdminRouter({ store, auth, closeSessionsFor, meta }));

  router.get('/api/state', (_req, res) => {
    res.json(buildState(store, sessions, sessionStats, meta));
  });

  router.get('/api/activity', (req, res) => {
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const channel = req.query.channel ? String(req.query.channel) : null;
    const rows = store.activity({ channel, limit, offset }).map((r) => ({
      ...r,
      ts: iso(r.ts),
    }));
    res.json({ count: rows.length, limit, offset, channel, rows });
  });

  router.use(express.static(UI_DIR, { index: 'index.html', maxAge: 0 }));

  return router;
}

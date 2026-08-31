import express from 'express';
import { fileURLToPath } from 'node:url';
import { SERVER_CHANNEL } from './auth.js';
import {
  applyBackup, backupFilename, buildBackup, snapshotBeforeRestore, validateBackup,
} from './backup.js';
import { createFloorRouter, deliverable, nudgeable } from './floor.js';
// The same derivation the store uses, so a row for an agent with no persona row
// yet shows the name it is about to be given rather than a raw id for one poll.
import { humanName } from './db.js';
import { PALETTE, SHIRTS, DEFAULT_HAIR, DEFAULT_SKIN } from './palette.js';
import {
  agentBoard, agentKey, agentLoadIndex, channelCounts, index, iso, ZERO_COUNTS,
} from './agent-state.js';

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

// How many unfinished tasks per channel /api/state carries in full. The counts
// are always exact; this bounds only the list the task dialog offers, because
// this payload is refetched every couple of seconds.
const TASK_LIST_MAX = 25;

// Same idea for a backlog. The count on the pill is always exact; this bounds
// only the rows the dialog offers to act on.
const BACKLOG_LIST_MAX = 25;

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
  // The backlog dialog lists the messages, not just their number. Board-only:
  // the floor's pills open this same dialog, and it reads them from here.
  const backlogByAgent = index(store.unreadMessages(), (m) => agentKey(m.channel, m.agent));
  // Fetched once and indexed rather than queried per agent: /api/state is polled
  // every couple of seconds and every desk would otherwise cost a lookup.
  const hostedByAgent = new Map(store.listHostedDesks().map((h) => [agentKey(h.channel, h.agent), h]));
  // The per-agent workload the floor draws from too — see agent-state.js.
  const idx = agentLoadIndex(store);
  const { unassignedByChannel } = idx;
  // The five numbers a channel header prints, shaped once — the floor prints the
  // same line under each storey and imports the same helper.
  const counts = channelCounts(store);
  const archivedAt = new Map(
    store.listChannelFlags().filter((f) => f.archived_at).map((f) => [f.channel, f.archived_at])
  );
  const tasksByChannel = index(store.boardTasks(), (t) => t.channel);


  // Channels known to the database, plus any a live session claims but that has
  // yet to write anything.
  const channelNames = new Set(store.listAllChannels());

  // Who each agent is called. One name per agent id, for every channel at once —
  // read straight from the names table rather than from the per-desk seating
  // rows, because a name outlives its seats: an agent renamed while working on
  // one channel must answer to that name on a channel it has never sat down in.
  const profiles = store.listProfiles();
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
    // Chosen names first, then the derived default for every agent that has not
    // been renamed. The map has to be *complete*, not merely correct: it is what
    // resolves a name anywhere the id appears — a task's requester, a reassign
    // dropdown, a dialog heading — and a half-filled one silently falls back to
    // raw ids in exactly those places while the agent rows show proper names.
    const personas = {};
    for (const a of agentsByChannel.get(channel) ?? []) {
      personas[a.agent] = profiles[a.agent]?.persona ?? humanName(a.agent);
    }
    const allAgents = (agentsByChannel.get(channel) ?? [])
      .slice()
      .sort((a, b) => a.agent.localeCompare(b.agent))
      .map((a) => {
        const k = agentKey(channel, a.agent);
        // Presence included: the floor draws it too, and a desk that disagreed
        // with its own row about whether the agent is connected would be worse
        // than not showing it at all.
        return {
          agent: a.agent,
          // The display name. `agent` stays alongside it everywhere it is shown:
          // the name is for reading, the id is what routes. Read from the same
          // map the dialogs use, so a row and a heading cannot disagree.
          persona: personas[a.agent],
          // The board draws no avatars, but it is where the dialog that edits
          // one is opened from, so every current value has to reach it.
          gender: profiles[a.agent]?.gender ?? 'neutral',
          shirt: profiles[a.agent]?.shirt ?? SHIRTS[0],
          hair: profiles[a.agent]?.hair ?? DEFAULT_HAIR,
          skin: profiles[a.agent]?.skin ?? DEFAULT_SKIN,
          ...agentBoard(a, idx, nowMs, liveByKey.get(k) ?? 0),
          // Whether the operator can nudge this agent — the same verdict the
          // floor's bell shows, so the two nudge surfaces agree. Stricter than
          // the chat endpoint on purpose: see nudgeable().
          nudge: (() => {
            const v = nudgeable(hostedByAgent.get(k), nowMs);
            return v.error
              ? { ok: false, code: v.code, reason: v.error }
              : { ok: true, host: v.hosted.host_name ?? v.hosted.host_id };
          })(),
          unread_list: (backlogByAgent.get(k) ?? []).slice(0, BACKLOG_LIST_MAX).map((m) => ({
            id: m.id,
            from: m.from,
            to: m.to,
            body: m.body,
            created_at: iso(m.created_at),
          })),
          retired: !!a.retired_at,
          retired_at: iso(a.retired_at),
        };
      });

    // Retired agents ship in their own list rather than being dropped: the board
    // shows a "retired (N)" affordance, because silently omitting a row is the
    // one way this feature could mislead rather than declutter.
    const agents = allAgents.filter((a) => !a.retired);
    const retiredAgents = allAgents.filter((a) => a.retired);

    const n = counts.get(channel) ?? ZERO_COUNTS;
    const tasks = { open: n.open, claimed: n.claimed, done: n.done };
    const unfinished = tasksByChannel.get(channel) ?? [];
    return {
      channel,
      // Every name on this channel, so a dialog can render "requested by
      // <name>" for an agent that has no row of its own.
      personas,
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
        // Who asked for the work. The dialog leads with this rather than with
        // the assignee, which the row's own dropdown already shows.
        created_by: t.created_by,
        updated_at: iso(t.updated_at),
      })),
      task_list_total: unfinished.length,
      messages: n.messages,
      contracts: n.contracts,
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
    // The colours a picker may offer, sent rather than hard-coded in the page:
    // the endpoint validates against this same list, so a swatch that appears
    // is a swatch that will save. Static and small — a few hundred bytes on a
    // payload that already carries every agent on the board.
    palette: PALETTE,
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
 * The operator surface. Every route here is a write, so every route goes through
 * auth.adminGuard — which on this build checks only that the request did not come
 * from another origin, since the dashboard has no credential of its own. Every
 * route also leaves an `admin_events` row behind, which the activity feed shows.
 * Identity is always the literal `operator`, never a borrowed agent name, so a
 * human's cleanup can never be mistaken for an agent finishing work.
 *
 * Channel and agent names travel in the JSON body rather than the path: they're
 * free-form strings, and a path segment would need encoding conventions that
 * only exist to be got wrong.
 */
function createAdminRouter({ store, auth, closeSessionsFor, meta }) {
  const router = express.Router();

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

  /**
   * Point a message at a different agent, or at everyone.
   *
   * A message is a record of something said, so this rewrites history in a way
   * reassigning a task does not — a task changing hands is the normal course of
   * events, a message changing addressee is not. It is here because the backlog
   * dialog needs it and the operator is the human in the middle either way; the
   * admin log keeps who did it, which is the part that makes it recoverable.
   */
  router.post('/message/reassign', (req, res) => {
    const channel = str(req.body?.channel);
    const id = Number(req.body?.id);
    const to = str(req.body?.to) || null;
    if (!channel || !Number.isInteger(id)) return bad(res, 'channel and a numeric id are required');
    const row = store.messageById(channel, id);
    if (!row) return missing(res, `no message #${id} on channel "${channel}"`);
    if (to && !agentRow(channel, to)) return missing(res, `no agent "${to}" on channel "${channel}"`);
    const changes = store.reassignMessage(channel, id, to);
    store.logAdmin(channel, 'message.reassign', {
      target: to ?? '(everyone)',
      detail: `#${id} was addressed to ${row.to ?? '(everyone)'}`,
    });
    res.json({ ok: true, channel, id, to, changes });
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

  /* ---------- server-wide actions ---------- */

  /**
   * Record something that isn't about one channel.
   *
   * Always attributed to the literal `operator`, because that is now the honest
   * answer: the dashboard has no sign-in, so the board knows a human did this and
   * nothing more. Filed under SERVER_CHANNEL, which the board never draws as a
   * card.
   */
  const logServer = (action, target, detail) =>
    store.logAdmin(SERVER_CHANNEL, action, { actor: 'operator', target, detail });

  /* ---------- backup and restore ---------- */

  /**
   * The whole board as one downloadable file. See src/backup.js for what is in it
   * and, more importantly, what isn't: the shared MCP secret never travels.
   */
  router.get('/backup', (_req, res) => {
    const doc = buildBackup({ store, meta: { ...meta, authMode: auth.mode } });
    const name = backupFilename();
    logServer('backup.export', name, `exported ${doc.counts ? Object.values(doc.counts).reduce((n, v) => n + v, 0) : 0} rows`);
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

    // Logged after the restore, never before: the restore wipes admin_events, so a
    // row written first would be destroyed by the thing it was recording.
    logServer('backup.restore', doc.created_at ?? 'backup',
      `restored ${applied.rows} rows from a backup taken ${doc.created_at ?? 'at an unrecorded time'}` +
      (snapshot.saved ? `; previous board saved to ${snapshot.path}` : '; the pre-restore snapshot could not be written'));

    res.json({
      ok: true,
      restored_from: doc.created_at ?? null,
      source_version: doc.server?.version ?? null,
      rows: applied.rows,
      tables: applied.report,
      notes: applied.notes,
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
  // The floor's own endpoints — ingest, state, per-desk turns, casting. Mounted
  // ahead of the static handler so /api/floor never falls through to index.html.
  router.use(createFloorRouter({ store, auth, sessions }));

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

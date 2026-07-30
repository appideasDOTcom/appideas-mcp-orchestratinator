import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Open (and migrate) the SQLite database.
 *
 * Everything is scoped by `channel` — a channel is one coordination space,
 * typically one free/pro plugin pair. A single container/DB serves any number
 * of channels, so adding a new plugin-pair never requires a schema or infra
 * change: the two new agents just use a new channel name.
 */
export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      channel     TEXT NOT NULL,
      from_agent  TEXT NOT NULL,
      to_agent    TEXT,                    -- NULL = broadcast to the whole channel
      body        TEXT NOT NULL,           -- JSON-encoded
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel, id);

    CREATE TABLE IF NOT EXISTS contracts (
      channel     TEXT NOT NULL,
      key         TEXT NOT NULL,
      value       TEXT NOT NULL,           -- JSON-encoded
      version     INTEGER NOT NULL DEFAULT 1,
      updated_by  TEXT,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (channel, key)
    );

    CREATE TABLE IF NOT EXISTS contract_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      channel     TEXT NOT NULL,
      key         TEXT NOT NULL,
      value       TEXT NOT NULL,
      version     INTEGER NOT NULL,
      updated_by  TEXT,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      channel     TEXT NOT NULL,
      title       TEXT NOT NULL,
      body        TEXT,
      status      TEXT NOT NULL DEFAULT 'open',  -- open | claimed | done
      created_by  TEXT,
      assignee    TEXT,
      claimed_by  TEXT,
      note        TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_channel ON tasks(channel, status);

    CREATE TABLE IF NOT EXISTS agents (
      channel     TEXT NOT NULL,
      agent       TEXT NOT NULL,
      last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (channel, agent)
    );

    -- Operator-set flags on a channel. A channel is otherwise a derived key (see
    -- listAllChannels), so archiving needs somewhere of its own to live.
    CREATE TABLE IF NOT EXISTS channel_flags (
      channel     TEXT PRIMARY KEY,
      archived_at TEXT,
      archived_by TEXT
    );

    -- Operator actions taken from the dashboard. These exist so the board can
    -- explain itself: an unread count dropping from 139 to 0 with nothing in the
    -- log is indistinguishable from a bug. Unioned into the activity feed.
    CREATE TABLE IF NOT EXISTS admin_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      channel     TEXT NOT NULL,
      action      TEXT NOT NULL,           -- advance | nudge | retire | unretire | task.close | ...
      actor       TEXT NOT NULL DEFAULT 'operator',
      target      TEXT,                    -- agent or task the action applied to
      detail      TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_admin_events_channel ON admin_events(channel, id);
  `);

  // Presence detail added after v0.1 — the dashboard reads these to show an
  // approximate last-known state per agent. Added by migration so an existing
  // volume keeps its data.
  addColumn(db, 'agents', 'status', 'TEXT');                        // self-reported state: working|waiting|blocked|idle
  addColumn(db, 'agents', 'status_at', 'TEXT');
  addColumn(db, 'agents', 'last_action', 'TEXT');                   // last tool called
  addColumn(db, 'agents', 'last_action_at', 'TEXT');
  addColumn(db, 'agents', 'poll_cursor', 'INTEGER NOT NULL DEFAULT 0'); // highest message id read

  // A status carries its own expiry so a crashed agent can't leave "waiting" on
  // the board forever — past it the dashboard falls back to inference. Rows
  // written before this column existed have NULL and are aged off the old
  // server-wide default instead (see STATUS_TTL_MINUTES in web.js).
  addColumn(db, 'agents', 'status_detail', 'TEXT');                 // the human-readable line
  addColumn(db, 'agents', 'status_expires_at', 'TEXT');

  // Retired = the operator has taken this agent off the board. Deliberately a
  // flag and not a DELETE: the row is recreated by `touchAgent` the moment the
  // agent connects again, so a delete would be undone by the next reconnect and
  // look like the button didn't work. Any real activity clears it (see
  // touchAgent) — hiding an agent that is actually working is the one failure
  // worse than a cluttered board.
  addColumn(db, 'agents', 'retired_at', 'TEXT');

  return db;
}

function addColumn(db, table, column, decl) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

const n = (v) => (typeof v === 'bigint' ? Number(v) : v);

/**
 * How long a self-reported status stays believable when the caller doesn't say.
 * Deliberately short: an expired status is treated as absent and the dashboard
 * falls back to inference, so the failure mode of a crashed agent is "we stop
 * claiming to know" rather than a stale label the human keeps trusting.
 * Settable to 0 so a test can prove the fallback actually fires.
 */
export const STATUS_TTL_SECONDS = Math.max(0, Number(process.env.STATUS_TTL_SECONDS ?? 900));

/**
 * Wrap a database handle in a small set of channel-scoped data operations.
 * Because there is exactly one Node process, better-sqlite3's synchronous
 * calls serialize all writes for us — no cross-process locking to manage.
 */
export function makeStore(db) {
  // A claim older than this reverts to `open` so an abandoned task (agent
  // claimed it, then its turn died before complete_task) can't sit invisibly
  // in `claimed`. Should comfortably exceed your longest expected task.
  const CLAIM_TTL = `-${Math.max(0, Number(process.env.CLAIM_TTL_MINUTES ?? 15))} minutes`;

  const q = {
    insertMessage: db.prepare(
      `INSERT INTO messages (channel, from_agent, to_agent, body)
       VALUES (@channel, @from, @to, @body)`
    ),
    pollMessages: db.prepare(
      `SELECT id, from_agent AS "from", to_agent AS "to", body, created_at
       FROM messages
       WHERE channel = @channel AND id > @since
         AND ( to_agent = @me OR (to_agent IS NULL AND from_agent != @me) )
       ORDER BY id ASC
       LIMIT @limit`
    ),
    getContract: db.prepare(
      `SELECT key, value, version, updated_by, updated_at
       FROM contracts WHERE channel = @channel AND key = @key`
    ),
    listContracts: db.prepare(
      `SELECT key, value, version, updated_by, updated_at
       FROM contracts WHERE channel = @channel ORDER BY key`
    ),
    getContractVersion: db.prepare(
      `SELECT version FROM contracts WHERE channel = @channel AND key = @key`
    ),
    upsertContract: db.prepare(
      `INSERT INTO contracts (channel, key, value, version, updated_by, updated_at)
       VALUES (@channel, @key, @value, @version, @by, datetime('now'))
       ON CONFLICT(channel, key)
       DO UPDATE SET value = @value, version = @version, updated_by = @by, updated_at = datetime('now')`
    ),
    insertContractHistory: db.prepare(
      `INSERT INTO contract_history (channel, key, value, version, updated_by)
       VALUES (@channel, @key, @value, @version, @by)`
    ),
    openTask: db.prepare(
      `INSERT INTO tasks (channel, title, body, assignee, created_by)
       VALUES (@channel, @title, @body, @assignee, @by)`
    ),
    listTasksAll: db.prepare(
      `SELECT * FROM tasks WHERE channel = @channel ORDER BY id DESC`
    ),
    claimTask: db.prepare(
      `UPDATE tasks SET status = 'claimed', claimed_by = @by, updated_at = datetime('now')
       WHERE channel = @channel AND id = @id AND status = 'open'`
    ),
    reapStaleClaims: db.prepare(
      `UPDATE tasks
       SET status = 'open', claimed_by = NULL, note = 'claim expired — auto-reopened', updated_at = datetime('now')
       WHERE channel = @channel AND status = 'claimed' AND updated_at <= datetime('now', @ttl)`
    ),
    completeTask: db.prepare(
      `UPDATE tasks
       SET status = 'done', note = @note, claimed_by = COALESCE(claimed_by, @by), updated_at = datetime('now')
       WHERE channel = @channel AND id = @id AND status != 'done'`
    ),
    touchAgent: db.prepare(
      `INSERT INTO agents (channel, agent, last_seen, last_action, last_action_at)
       VALUES (@channel, @agent, datetime('now'), @action, datetime('now'))
       ON CONFLICT(channel, agent) DO UPDATE SET
         last_seen      = datetime('now'),
         last_action    = COALESCE(@action, last_action),
         last_action_at = CASE WHEN @action IS NULL THEN last_action_at ELSE datetime('now') END,
         -- A retired agent that calls a tool is back, whatever the board said.
         retired_at     = NULL`
    ),
    setAgentStatus: db.prepare(
      `INSERT INTO agents (channel, agent, last_seen, status, status_detail, status_at, status_expires_at)
       VALUES (@channel, @agent, datetime('now'), @status, @detail, datetime('now'), datetime('now', @ttl))
       ON CONFLICT(channel, agent) DO UPDATE SET
         last_seen         = datetime('now'),
         status            = @status,
         status_detail     = @detail,
         status_at         = datetime('now'),
         status_expires_at = datetime('now', @ttl),
         retired_at        = NULL`
    ),
    advancePollCursor: db.prepare(
      `UPDATE agents SET poll_cursor = MAX(poll_cursor, @cursor)
       WHERE channel = @channel AND agent = @agent`
    ),
    listAgents: db.prepare(
      `SELECT agent, last_seen, status, status_detail, status_at, status_expires_at,
              last_action, last_action_at
       FROM agents WHERE channel = @channel AND retired_at IS NULL ORDER BY agent`
    ),

    // --- operator actions (see src/web.js) ----------------------------------
    retireAgent: db.prepare(
      `UPDATE agents SET retired_at = datetime('now')
       WHERE channel = @channel AND agent = @agent AND retired_at IS NULL`
    ),
    unretireAgent: db.prepare(
      `UPDATE agents SET retired_at = NULL WHERE channel = @channel AND agent = @agent`
    ),
    reassignTask: db.prepare(
      `UPDATE tasks SET assignee = @assignee, updated_at = datetime('now')
       WHERE channel = @channel AND id = @id AND status != 'done'`
    ),
    setChannelArchived: db.prepare(
      `INSERT INTO channel_flags (channel, archived_at, archived_by)
       VALUES (@channel, @at, @by)
       ON CONFLICT(channel) DO UPDATE SET archived_at = @at, archived_by = @by`
    ),
    insertAdminEvent: db.prepare(
      `INSERT INTO admin_events (channel, action, actor, target, detail)
       VALUES (@channel, @action, @actor, @target, @detail)`
    ),
    listChannelFlags: db.prepare(`SELECT channel, archived_at, archived_by FROM channel_flags`),

    // --- dashboard reads (see src/web.js) -----------------------------------
    listAllAgents: db.prepare(
      `SELECT channel, agent, last_seen, status, status_detail, status_at, status_expires_at,
              last_action, last_action_at, poll_cursor, retired_at
       FROM agents ORDER BY channel, agent`
    ),
    // Every unfinished task, so the board can offer one by id instead of just
    // counting it. Bounded because /api/state is polled every couple of seconds.
    boardTasks: db.prepare(
      `SELECT id, channel, title, status, assignee, claimed_by, created_by, updated_at
       FROM tasks WHERE status != 'done' ORDER BY channel, id DESC LIMIT 2000`
    ),
    listAllChannels: db.prepare(
      `SELECT channel FROM (
         SELECT channel FROM agents    UNION SELECT channel FROM messages
         UNION SELECT channel FROM tasks UNION SELECT channel FROM contracts
       ) WHERE channel IS NOT NULL ORDER BY channel`
    ),
    countTasksByStatus: db.prepare(
      `SELECT channel, status, COUNT(*) AS n FROM tasks GROUP BY channel, status`
    ),
    countMessages: db.prepare(
      `SELECT channel, COUNT(*) AS n FROM messages GROUP BY channel`
    ),
    countContracts: db.prepare(
      `SELECT channel, COUNT(*) AS n FROM contracts GROUP BY channel`
    ),
    // Open work each agent is on the hook for: claimed by them, or assigned and
    // still open. Unassigned open tasks are counted per-channel instead.
    agentTaskLoad: db.prepare(
      `SELECT channel, claimed_by AS agent, 'claimed' AS bucket, COUNT(*) AS n
         FROM tasks WHERE status = 'claimed' AND claimed_by IS NOT NULL
        GROUP BY channel, claimed_by
       UNION ALL
       SELECT channel, assignee, 'assigned', COUNT(*)
         FROM tasks WHERE status = 'open' AND assignee IS NOT NULL
        GROUP BY channel, assignee
       UNION ALL
       SELECT channel, NULL, 'unassigned', COUNT(*)
         FROM tasks WHERE status = 'open' AND assignee IS NULL
        GROUP BY channel`
    ),
    claimedTasks: db.prepare(
      `SELECT id, channel, title, claimed_by, updated_at FROM tasks
       WHERE status = 'claimed' ORDER BY updated_at DESC`
    ),
    // Messages an agent would receive on its next poll_messages call.
    // `unread_max_id` is the id the operator's "mark read" must advance to — the
    // highest message this agent can currently see, NOT the channel's max. The
    // browser sends the value it rendered back, so a message that arrives between
    // render and click stays unread instead of being silently swallowed.
    unreadCounts: db.prepare(
      `SELECT a.channel, a.agent, COUNT(m.id) AS unread, MAX(m.id) AS unread_max_id
         FROM agents a
         LEFT JOIN messages m
           ON m.channel = a.channel AND m.id > a.poll_cursor
          AND (m.to_agent = a.agent OR (m.to_agent IS NULL AND m.from_agent != a.agent))
        GROUP BY a.channel, a.agent`
    ),
    activity: db.prepare(
      // One row per interesting database write, newest first. `detail` is capped
      // so a huge contract value can't blow up the response.
      // `seq` breaks ties: datetime('now') has one-second resolution, so a task
      // opened and completed in the same second would otherwise sort randomly.
      `WITH feed AS (
         SELECT 'message' AS kind, id AS ref_id, channel, created_at AS ts, 0 AS seq,
                from_agent AS actor, to_agent AS target, NULL AS title,
                substr(body, 1, 2000) AS detail, NULL AS status, NULL AS version
           FROM messages
         UNION ALL
         SELECT 'task.opened', id, channel, created_at, 0,
                created_by, assignee, title, substr(body, 1, 2000), 'open', NULL
           FROM tasks
         UNION ALL
         -- The task's latest transition. A still-open task only earns a row here
         -- if it was touched after creation (i.e. a stale claim auto-reopened).
         SELECT 'task.' || status, id, channel, updated_at, 1,
                COALESCE(claimed_by, created_by), assignee, title, substr(note, 1, 2000), status, NULL
           FROM tasks WHERE status != 'open' OR updated_at > created_at
         UNION ALL
         SELECT 'contract.set', id, channel, updated_at, 0,
                updated_by, NULL, key, substr(value, 1, 2000), NULL, version
           FROM contract_history
         UNION ALL
         -- seq 2 so an operator action sorts after the task/message rows it
         -- caused when both land in the same one-second tick.
         SELECT 'admin.' || action, id, channel, created_at, 2,
                actor, target, action, substr(detail, 1, 2000), NULL, NULL
           FROM admin_events
       )
       SELECT * FROM feed
        WHERE (@channel IS NULL OR channel = @channel)
        ORDER BY ts DESC, seq DESC, ref_id DESC
        LIMIT @limit OFFSET @offset`
    ),
  };

  /**
   * Delete every trace of a channel. A channel isn't a row anywhere — it's a key
   * shared across five tables (see listAllChannels) — so this has to sweep all of
   * them, in one transaction, or a half-deleted channel keeps reappearing from
   * whichever table still holds it.
   *
   * `admin_events` is deliberately NOT swept. It records what the operator did
   * rather than what the channel contained, and an audit trail you can erase by
   * deleting the thing it describes is not an audit trail. Keeping it costs
   * nothing on the board either: listAllChannels doesn't read this table, so the
   * channel still disappears — the log just goes on remembering you deleted it.
   */
  const purgeChannel = db.transaction((channel, by) => {
    const counts = {};
    for (const table of ['messages', 'tasks', 'contracts', 'contract_history', 'agents', 'channel_flags']) {
      counts[table] = db.prepare(`DELETE FROM ${table} WHERE channel = ?`).run(channel).changes;
    }
    q.insertAdminEvent.run({
      channel,
      action: 'channel.delete',
      actor: by,
      target: channel,
      detail: JSON.stringify(counts),
    });
    return counts;
  });

  const setContract = db.transaction((channel, key, value, by) => {
    const row = q.getContractVersion.get({ channel, key });
    const version = (row?.version ?? 0) + 1;
    q.upsertContract.run({ channel, key, value, version, by });
    q.insertContractHistory.run({ channel, key, value, version, by });
    return { version };
  });

  return {
    insertMessage: (channel, from, to, body) =>
      n(q.insertMessage.run({ channel, from, to, body }).lastInsertRowid),
    pollMessages: (channel, me, since, limit) =>
      q.pollMessages.all({ channel, me, since, limit }),

    getContract: (channel, key) => q.getContract.get({ channel, key }) ?? null,
    listContracts: (channel) => q.listContracts.all({ channel }),
    setContract,

    openTask: (channel, title, body, assignee, by) =>
      n(q.openTask.run({ channel, title, body, assignee, by }).lastInsertRowid),
    listTasks: (channel, status, mine) => {
      let rows = q.listTasksAll.all({ channel });
      if (status) rows = rows.filter((r) => r.status === status);
      if (mine) rows = rows.filter((r) => r.assignee === mine || r.claimed_by === mine);
      return rows;
    },
    claimTask: (channel, id, by) => q.claimTask.run({ channel, id, by }).changes,
    completeTask: (channel, id, note, by) => q.completeTask.run({ channel, id, note, by }).changes,
    reapStaleClaims: (channel) => q.reapStaleClaims.run({ channel, ttl: CLAIM_TTL }).changes,

    touchAgent: (channel, agent, action = null) => q.touchAgent.run({ channel, agent, action }),
    setAgentStatus: (channel, agent, status, detail = null, ttlSeconds = STATUS_TTL_SECONDS) =>
      q.setAgentStatus.run({ channel, agent, status, detail, ttl: `+${Math.max(0, Math.floor(ttlSeconds))} seconds` }),
    advancePollCursor: (channel, agent, cursor) =>
      q.advancePollCursor.run({ channel, agent, cursor }).changes,
    listAgents: (channel) => q.listAgents.all({ channel }),

    // --- operator actions -----------------------------------------------------
    retireAgent: (channel, agent) => q.retireAgent.run({ channel, agent }).changes,
    unretireAgent: (channel, agent) => q.unretireAgent.run({ channel, agent }).changes,
    reassignTask: (channel, id, assignee) => q.reassignTask.run({ channel, id, assignee }).changes,
    setChannelArchived: (channel, archived, by) =>
      q.setChannelArchived.run({ channel, at: archived ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null, by }).changes,
    purgeChannel,
    logAdmin: (channel, action, { actor = 'operator', target = null, detail = null } = {}) =>
      n(q.insertAdminEvent.run({ channel, action, actor, target, detail }).lastInsertRowid),

    // --- dashboard reads ------------------------------------------------------
    listAllAgents: () => q.listAllAgents.all(),
    listChannelFlags: () => q.listChannelFlags.all(),
    boardTasks: () => q.boardTasks.all(),
    listAllChannels: () => q.listAllChannels.all().map((r) => r.channel),
    channelStats: () => ({
      tasks: q.countTasksByStatus.all(),
      messages: q.countMessages.all(),
      contracts: q.countContracts.all(),
    }),
    agentTaskLoad: () => q.agentTaskLoad.all(),
    claimedTasks: () => q.claimedTasks.all(),
    unreadCounts: () => q.unreadCounts.all(),
    activity: ({ channel = null, limit = 200, offset = 0 } = {}) =>
      q.activity.all({ channel, limit, offset }),
  };
}

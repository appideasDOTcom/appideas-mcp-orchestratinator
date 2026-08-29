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
      action      TEXT NOT NULL,           -- advance | retire | unretire | task.close | ...
      actor       TEXT NOT NULL DEFAULT 'operator',
      target      TEXT,                    -- agent or task the action applied to
      detail      TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_admin_events_channel ON admin_events(channel, id);

    -- ─── The floor ────────────────────────────────────────────────────────────
    -- Everything above is what agents say to *each other*. Everything below is
    -- what each agent's own Claude Code session is doing — the half a human
    -- could previously only see by looking at the window. It is written by the
    -- hook plugin on each workstation (see plugin/), never by an MCP tool.
    --
    -- This exists because the people operating this system were reading N chat
    -- windows and a dashboard at once to answer one question: who is stuck, and
    -- on what. The board could never answer it, by design — it cannot see inside
    -- an agent's turn. Claude Code can, and will tell us, so we ask it.

    -- A Claude Code session, mapped onto a (channel, agent) by the hook. The
    -- hook resolves that identity by reading the repo's own .mcp.json — the same
    -- file that already declares X-Channel/X-Agent — so a workstation needs no
    -- configuration beyond installing the plugin.
    CREATE TABLE IF NOT EXISTS agent_sessions (
      session_id       TEXT PRIMARY KEY,
      channel          TEXT NOT NULL,
      agent            TEXT NOT NULL,
      cwd              TEXT,
      transcript       TEXT,                -- path to the JSONL, for backfill
      model            TEXT,
      permission_mode  TEXT,
      git_branch       TEXT,
      -- The operator queue is derived from these three. awaiting_kind is the
      -- Notification hook's notification_type — permission_prompt, idle_prompt.
      -- Set when Claude Code says it needs a human; cleared by the next turn.
      awaiting_kind    TEXT,
      awaiting_message TEXT,
      awaiting_since   TEXT,
      ended_at         TEXT,
      started_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_agent ON agent_sessions(channel, agent, updated_at);

    -- One row per turn boundary. Tool calls are their own rows rather than being
    -- folded into the assistant text, because the floor collapses them to a
    -- single line and expands on click — which it can only do if they were never
    -- flattened together in the first place.
    CREATE TABLE IF NOT EXISTS turns (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      channel     TEXT NOT NULL,
      agent       TEXT NOT NULL,
      session_id  TEXT NOT NULL,
      role        TEXT NOT NULL,            -- user | assistant | tool | error
      text        TEXT,
      tool_name   TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_turns_agent ON turns(channel, agent, id);

    -- Who each agent is on the floor. Assigned on first sight and editable by
    -- the operator, stored here rather than in a browser because a floor where
    -- two people disagree about which desk is which stops being a shared
    -- reference — the one job it has.
    CREATE TABLE IF NOT EXISTS personas (
      channel     TEXT NOT NULL,
      agent       TEXT NOT NULL,
      persona     TEXT NOT NULL,
      seat        INTEGER,
      assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (channel, agent)
    );

    -- ─── Hosting ──────────────────────────────────────────────────────────────
    -- A host is a workstation service (host/) that runs each desk's Claude Code
    -- in a tmux pane and connects it to the floor, so a desk becomes a chat.
    -- Hosts only ever reach *out* to this server: they register, then hold a
    -- request open asking for work. Nothing here connects to a workstation.
    CREATE TABLE IF NOT EXISTS hosts (
      host_id       TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Which desks a host runs, and the SDK session each one last had — kept
    -- across host restarts so the conversation resumes rather than restarts.
    CREATE TABLE IF NOT EXISTS hosted_desks (
      channel        TEXT NOT NULL,
      agent          TEXT NOT NULL,
      host_id        TEXT NOT NULL,
      cwd            TEXT NOT NULL,
      sdk_session_id TEXT,
      state          TEXT NOT NULL DEFAULT 'idle',   -- idle | working | awaiting | offline
      updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (channel, agent)
    );

    -- Work waiting for a host: a message to deliver, a permission decision to
    -- apply, an interrupt. A table rather than memory so a message typed while
    -- the server restarts is still there when the host next asks.
    CREATE TABLE IF NOT EXISTS host_outbox (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id     TEXT NOT NULL,
      channel     TEXT NOT NULL,
      agent       TEXT NOT NULL,
      kind        TEXT NOT NULL,              -- chat | permission | interrupt
      payload     TEXT NOT NULL,              -- JSON
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      taken_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_host_outbox_pending ON host_outbox(host_id, taken_at, id);
  `);

  // An earlier cut of the floor queued "nudges" for a desk's own hook to hand
  // to the agent at its next turn boundary. It worked, and it was the wrong
  // shape: a message that lands "eventually" is not a chat. Hosting replaced it.
  dropTables(db, ['nudges'], 'the floor now hosts sessions instead of queueing nudges');

  // v0.9 carried dashboard logins: a `users` table of scrypt hashes and a
  // `ui_sessions` table of live cookies. Both are gone — the dashboard is open
  // to whoever can reach the port, which on a single-user machine behind a
  // firewall is the whole of the intended model. Dropped rather than left
  // orphaned, because a table of password hashes for a feature that no longer
  // exists is a liability with no reader: any backup, snapshot, or `.dump` of
  // this file would go on carrying credentials nothing can check.
  dropTables(db, ['ui_sessions', 'users'], 'dashboard sign-in was removed');

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

  // Where a session was first heard about: 'hook' for one a window reported
  // itself, 'host' for one the host saw in `claude agents --json`. The same
  // session is usually both, and which arrived first is of no consequence —
  // it is kept because it says whether a desk has the plugin installed at all.
  // `pid` and `parent_session` are informational; nothing depends on them now
  // that a window is found by asking rather than by watching a process.
  addColumn(db, 'agent_sessions', 'runner', 'TEXT');
  addColumn(db, 'agent_sessions', 'pid', 'INTEGER');
  addColumn(db, 'agent_sessions', 'parent_session', 'TEXT');
  // A desk used to have a *driver* — 'floor' or 'terminal' — because a window
  // somebody had open was believed to own its session outright, so the host had
  // to stand aside and the floor became a copy-and-paste box. That was never
  // true: a live Claude Code window can be typed into (see host/window.js), and
  // with it there is nothing to arbitrate. One conversation per repo, two doors
  // onto it, no ownership. These three columns described the arbitration.
  dropColumns(db, 'hosted_desks', ['driver', 'terminal_session_id', 'resume_fork'],
    'a desk has no driver any more — both doors reach the same window');

  // How a person sits down at a desk.
  //
  // The floor can type into a desk's window; so can whoever is attached to it.
  // But nothing on the floor ever said *where* that window is, so the second
  // door existed and was invisible — you could watch a conversation you had no
  // way to join. These carry the address: which tmux session the host runs, and
  // which window in it belongs to this desk.
  addColumn(db, 'hosts', 'tmux_session', 'TEXT');
  addColumn(db, 'hosted_desks', 'window_id', 'TEXT');
  // And when a repo's Claude Code is running somewhere the floor cannot reach —
  // an editor's own panel, with no stdin to type into — this is the pid of it,
  // so the floor can say so and say what to do instead of failing on send.
  addColumn(db, 'hosted_desks', 'outside_pid', 'INTEGER');

  return db;
}

function addColumn(db, table, column, decl) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

/**
 * Remove tables a past version created, and say so once.
 *
 * Announced rather than silent: this deletes rows from an existing volume, and a
 * migration that destroys data without a word in the log is one you find out
 * about from its absence.
 */
function dropTables(db, tables, why) {
  const present = tables.filter(
    (t) => !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t)
  );
  if (!present.length) return;
  for (const t of present) db.exec(`DROP TABLE IF EXISTS ${t}`);
  console.log(`[orchestratinator] migration: dropped ${present.join(', ')} — ${why}`);
}

/**
 * Remove columns a past version added, and say so once.
 *
 * The same bargain as dropTables: this discards data in an existing volume, so
 * it is announced. A SQLite too old for DROP COLUMN leaves them in place, which
 * is harmless — nothing reads them any more — and says so rather than failing
 * a startup over a column nobody wants.
 */
function dropColumns(db, table, columns, why) {
  const present = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const doomed = columns.filter((c) => present.includes(c));
  if (!doomed.length) return;
  const dropped = [];
  for (const c of doomed) {
    try {
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${c}`);
      dropped.push(c);
    } catch (err) {
      console.warn(`[orchestratinator] migration: left ${table}.${c} in place (${err.message}); nothing reads it`);
    }
  }
  if (dropped.length) console.log(`[orchestratinator] migration: dropped ${table}.${dropped.join(', ')} — ${why}`);
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
 * How many turns are kept per desk. The floor shows a live tail, not an archive
 * — the archive is the transcript on the workstation that produced it, which is
 * complete and which this server has no business duplicating in full.
 */
export const TURN_RETENTION = Math.max(20, Number(process.env.TURN_RETENTION ?? 400));

/**
 * The default cast. Deliberately original names rather than characters from a
 * television show: the metaphor is doing the work here, not the trademark, and
 * a shipped product carrying someone else's cast list is a problem the operator
 * shouldn't inherit from us. Rename any of them from the floor — the assignment
 * lives in `personas` and is what every viewer sees.
 *
 * Assigned in order, so a channel's first agent is always Ada and the desks stay
 * where people learned them. Beyond the list an agent simply keeps its own name,
 * which is unglamorous but never collides.
 */
export const CAST = [
  'Ada', 'Bo', 'Cleo', 'Dex', 'Edie', 'Finn', 'Greta', 'Hugo',
  'Ines', 'Jonas', 'Kira', 'Lou', 'Mira', 'Nico', 'Opal', 'Piper',
];

/**
 * Every table a backup carries, and the only tables a restore will write.
 *
 * All board data and nothing else. Nothing here is a credential, which is what
 * makes a backup file safe to email to yourself — see describeAuth in backup.js
 * for the one secret that stays behind, and applyBackup for what happens to the
 * `users` table an older backup may still carry.
 *
 * `turns` and `agent_sessions` are deliberately absent. They hold what people
 * actually typed to their agents and what those agents typed back, which is a
 * very different thing to hand someone than a task list — and the sentence
 * above, about a backup being safe to email to yourself, would stop being true
 * the moment they were included. They are also reconstructible: the transcripts
 * they were built from still sit on each workstation under ~/.claude/projects.
 * `personas` is included because who sits at which desk is an operator decision
 * that would otherwise be silently lost on a restore. The hosting tables are
 * runtime state — hosts re-register within a minute of any restart — and a
 * restored copy of them would only describe machines that may not exist.
 */
export const BACKUP_TABLES = [
  'messages',
  'contracts',
  'contract_history',
  'tasks',
  'agents',
  'channel_flags',
  'admin_events',
  'personas',
];

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

    // ─── The floor ──────────────────────────────────────────────────────────
    upsertSession: db.prepare(
      // Any activity clears `ended_at`: a resumed session is a live session, and
      // leaving the tombstone set would grey out a desk somebody is sitting at.
      // COALESCE on the detail columns because most hook events carry only the
      // common fields, and a Stop must not blank the model a SessionStart knew.
      `INSERT INTO agent_sessions
         (session_id, channel, agent, cwd, transcript, model, permission_mode, git_branch,
          runner, pid, parent_session, updated_at)
       VALUES (@session_id, @channel, @agent, @cwd, @transcript, @model, @permission_mode,
               @git_branch, @runner, @pid, @parent_session, datetime('now'))
       ON CONFLICT(session_id) DO UPDATE SET
         channel         = excluded.channel,
         agent           = excluded.agent,
         cwd             = COALESCE(excluded.cwd, cwd),
         transcript      = COALESCE(excluded.transcript, transcript),
         model           = COALESCE(excluded.model, model),
         permission_mode = COALESCE(excluded.permission_mode, permission_mode),
         git_branch      = COALESCE(excluded.git_branch, git_branch),
         runner          = COALESCE(excluded.runner, runner),
         pid             = COALESCE(excluded.pid, pid),
         parent_session  = COALESCE(excluded.parent_session, parent_session),
         ended_at        = NULL,
         updated_at      = datetime('now')`
    ),
    setAwaiting: db.prepare(
      // Re-notifying for the same reason must not restart the clock. The queue is
      // ranked by how long a human has been the blocker, and a permission prompt
      // that re-fires every few seconds would otherwise always look brand new —
      // which is exactly backwards from what the operator needs to see.
      `UPDATE agent_sessions
          SET awaiting_kind    = @kind,
              awaiting_message = @message,
              awaiting_since   = CASE WHEN awaiting_kind = @kind AND awaiting_since IS NOT NULL
                                      THEN awaiting_since ELSE datetime('now') END,
              updated_at       = datetime('now')
        WHERE session_id = @session_id`
    ),
    clearAwaiting: db.prepare(
      `UPDATE agent_sessions
          SET awaiting_kind = NULL, awaiting_message = NULL, awaiting_since = NULL,
              updated_at = datetime('now')
        WHERE session_id = @session_id`
    ),
    endSession: db.prepare(
      `UPDATE agent_sessions
          SET ended_at = datetime('now'), awaiting_kind = NULL, awaiting_message = NULL,
              awaiting_since = NULL, updated_at = datetime('now')
        WHERE session_id = @session_id`
    ),
    insertTurn: db.prepare(
      `INSERT INTO turns (channel, agent, session_id, role, text, tool_name)
       VALUES (@channel, @agent, @session_id, @role, @text, @tool_name)`
    ),
    // Keyed by channel+agent rather than session: a resumed session gets a new
    // session_id but it is the same desk, and a chat panel that emptied itself
    // every time somebody ran /resume would be worse than no chat panel.
    recentTurns: db.prepare(
      // Optionally one conversation only. A desk can have more than one session
      // on it, and the panel should show the one you are in. `sessions` is a
      // JSON array rather than one id because a conversation can span ids: a
      // fork carries its parent's history, and the two read as one.
      `SELECT id, session_id, role, text, tool_name, created_at
         FROM turns
        WHERE channel = @channel AND agent = @agent AND id > @since
          AND (@sessions IS NULL OR session_id IN (SELECT value FROM json_each(@sessions)))
        ORDER BY id DESC
        LIMIT @limit`
    ),
    floorSessions: db.prepare(
      `SELECT session_id, channel, agent, cwd, transcript, model, permission_mode, git_branch,
              runner, pid, parent_session,
              awaiting_kind, awaiting_message, awaiting_since, ended_at, started_at, updated_at
         FROM agent_sessions
        ORDER BY updated_at DESC`
    ),
    getSession: db.prepare(
      `SELECT session_id, channel, agent, cwd, runner, pid, parent_session,
              awaiting_kind, ended_at, updated_at
         FROM agent_sessions WHERE session_id = ?`
    ),
    // Windows open on a desk, newest first — the candidates to drive it.
    liveHookSessions: db.prepare(
      `SELECT session_id, cwd, pid, awaiting_kind, ended_at, updated_at
         FROM agent_sessions
        WHERE channel = ? AND agent = ? AND runner = 'hook' AND ended_at IS NULL
        ORDER BY updated_at DESC`
    ),
    turnsInSessions: db.prepare(
      `SELECT COUNT(*) AS n, MAX(created_at) AS last_at FROM turns
        WHERE channel = ? AND agent = ? AND session_id IN (SELECT value FROM json_each(?))`
    ),
    // The newest turn carrying text, per desk — what the avatar's bubble says.
    lastTurns: db.prepare(
      `SELECT t.channel, t.agent, t.role, t.text, t.tool_name, t.created_at, t.id
         FROM turns t
         JOIN (SELECT channel, agent, MAX(id) AS id
                 FROM turns WHERE text IS NOT NULL AND text != ''
                GROUP BY channel, agent) last
           ON last.channel = t.channel AND last.agent = t.agent AND last.id = t.id`
    ),
    turnCounts: db.prepare(`SELECT channel, agent, COUNT(*) AS n FROM turns GROUP BY channel, agent`),
    listPersonas: db.prepare(`SELECT channel, agent, persona, seat FROM personas`),
    personasInChannel: db.prepare(`SELECT persona, seat FROM personas WHERE channel = ?`),
    getPersona: db.prepare(`SELECT persona, seat FROM personas WHERE channel = ? AND agent = ?`),
    upsertPersona: db.prepare(
      `INSERT INTO personas (channel, agent, persona, seat)
       VALUES (@channel, @agent, @persona, @seat)
       ON CONFLICT(channel, agent) DO UPDATE SET
         persona     = excluded.persona,
         seat        = COALESCE(excluded.seat, seat),
         assigned_at = datetime('now')`
    ),
    // Turns would otherwise grow without bound: this is full conversation text
    // arriving at every turn boundary from every window on the network. Trimmed
    // to the newest N per desk, which is more than the live tail can show.
    pruneTurns: db.prepare(
      `DELETE FROM turns
        WHERE id IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY channel, agent ORDER BY id DESC) AS rn
              FROM turns
          ) WHERE rn > @keep
        )`
    ),

    // ─── Hosting ────────────────────────────────────────────────────────────
    upsertHost: db.prepare(
      `INSERT INTO hosts (host_id, name, tmux_session, last_seen)
       VALUES (@host_id, @name, @tmux_session, datetime('now'))
       ON CONFLICT(host_id) DO UPDATE SET
         name = excluded.name, tmux_session = excluded.tmux_session, last_seen = datetime('now')`
    ),
    touchHost: db.prepare(`UPDATE hosts SET last_seen = datetime('now') WHERE host_id = ?`),
    listHosts: db.prepare(`SELECT host_id, name, tmux_session, registered_at, last_seen FROM hosts ORDER BY name`),
    upsertHostedDesk: db.prepare(
      // Re-registering brings a desk back from offline; the session id it had
      // is deliberately left alone so the host can resume it.
      `INSERT INTO hosted_desks (channel, agent, host_id, cwd, window_id, outside_pid, state, updated_at)
       VALUES (@channel, @agent, @host_id, @cwd, @window_id, @outside_pid, 'idle', datetime('now'))
       ON CONFLICT(channel, agent) DO UPDATE SET
         host_id = excluded.host_id, cwd = excluded.cwd,
         window_id = excluded.window_id, outside_pid = excluded.outside_pid,
         state = 'idle', updated_at = datetime('now')`
    ),
    setHostedSession: db.prepare(
      // Whichever conversation is live in that repo right now. It changes when
      // the person there starts a new one, and that is not an event to
      // negotiate — it is simply the conversation now.
      `UPDATE hosted_desks SET sdk_session_id = @sdk_session_id, updated_at = datetime('now')
        WHERE channel = @channel AND agent = @agent`
    ),
    setHostedState: db.prepare(
      `UPDATE hosted_desks SET state = @state, updated_at = datetime('now')
        WHERE channel = @channel AND agent = @agent`
    ),
    setHostState: db.prepare(
      `UPDATE hosted_desks SET state = @state, updated_at = datetime('now') WHERE host_id = @host_id`
    ),
    listHostedDesks: db.prepare(
      `SELECT d.channel, d.agent, d.host_id, d.cwd, d.sdk_session_id, d.state, d.updated_at,
              d.window_id, d.outside_pid,
              h.name AS host_name, h.last_seen AS host_seen, h.tmux_session AS host_tmux
         FROM hosted_desks d
         LEFT JOIN hosts h ON h.host_id = d.host_id`
    ),
    hostedDesk: db.prepare(
      `SELECT d.channel, d.agent, d.host_id, d.cwd, d.sdk_session_id, d.state, d.updated_at,
              d.window_id, d.outside_pid,
              h.name AS host_name, h.last_seen AS host_seen, h.tmux_session AS host_tmux
         FROM hosted_desks d
         LEFT JOIN hosts h ON h.host_id = d.host_id
        WHERE d.channel = ? AND d.agent = ?`
    ),
    enqueueHostWork: db.prepare(
      `INSERT INTO host_outbox (host_id, channel, agent, kind, payload)
       VALUES (@host_id, @channel, @agent, @kind, @payload)`
    ),
    pendingHostWork: db.prepare(
      `SELECT id, channel, agent, kind, payload, created_at FROM host_outbox
        WHERE host_id = ? AND taken_at IS NULL ORDER BY id`
    ),
    markWorkTaken: db.prepare(`UPDATE host_outbox SET taken_at = datetime('now') WHERE id = ?`),
    pruneHostWork: db.prepare(
      `DELETE FROM host_outbox WHERE taken_at IS NOT NULL AND taken_at < datetime('now', '-1 day')`
    ),
    rekeyTurns: db.prepare(
      `UPDATE turns SET session_id = @to WHERE channel = @channel AND agent = @agent AND session_id = @from`
    ),
    deleteSession: db.prepare(`DELETE FROM agent_sessions WHERE session_id = ?`),
  };

  /**
   * Delete every trace of a channel. A channel isn't a row anywhere — it's a key
   * shared across many tables (see listAllChannels) — so this has to sweep all of
   * them, in one transaction, or a half-deleted channel keeps reappearing from
   * whichever table still holds it. The floor tables are swept too: deleting a
   * channel and leaving its conversations behind would be the worst of both, a
   * board that forgets and a transcript store that doesn't.
   *
   * `admin_events` is deliberately NOT swept. It records what the operator did
   * rather than what the channel contained, and an audit trail you can erase by
   * deleting the thing it describes is not an audit trail. Keeping it costs
   * nothing on the board either: listAllChannels doesn't read this table, so the
   * channel still disappears — the log just goes on remembering you deleted it.
   */
  const purgeChannel = db.transaction((channel, by) => {
    const counts = {};
    for (const table of ['messages', 'tasks', 'contracts', 'contract_history', 'agents',
      'channel_flags', 'agent_sessions', 'turns', 'personas', 'hosted_desks', 'host_outbox']) {
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

  /**
   * Prepared statements are cheap but not free, and a restore touches every table
   * generically. Build the per-table SQL once, on first use.
   */
  const tableCache = new Map();
  function tableInfo(table) {
    if (!BACKUP_TABLES.includes(table)) throw new Error(`refusing to touch unknown table "${table}"`);
    let info = tableCache.get(table);
    if (!info) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      info = {
        columns,
        selectAll: db.prepare(`SELECT * FROM ${table}`),
        deleteAll: db.prepare(`DELETE FROM ${table}`),
        count: db.prepare(`SELECT COUNT(*) AS n FROM ${table}`),
      };
      tableCache.set(table, info);
    }
    return info;
  }

  /**
   * Coerce one value into something SQLite will accept.
   *
   * A backup file is JSON that a human can open and edit, so it can come back
   * holding a `true` where the column holds a 1, or an object where the column
   * holds an encoded string. Failing the whole restore on that would be a poor
   * trade — every one of these has an unambiguous storage form.
   */
  function bindable(v) {
    if (v === undefined || v === null) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v;
    return JSON.stringify(v);
  }

  /**
   * Replace the contents of the backed-up tables wholesale.
   *
   * "Replace" and not "merge", because the job this exists for is moving a board
   * to a new host: a merge would leave the destination holding a blend of two
   * histories with ids that mean different things in each. Unknown columns in the
   * file are reported and skipped rather than failing the restore, so a backup
   * taken before a migration still loads.
   *
   * One transaction over every table: a half-restored board is worse than a
   * refused one, and better-sqlite3 rolls the lot back if any insert throws.
   */
  const restoreBackup = db.transaction((tables) => {
    const report = {};
    for (const [table, rows] of Object.entries(tables)) {
      if (!BACKUP_TABLES.includes(table)) { report[table] = { skipped: 'unknown table' }; continue; }
      if (!Array.isArray(rows)) { report[table] = { skipped: 'not an array of rows' }; continue; }
      const { columns, deleteAll } = tableInfo(table);
      const removed = deleteAll.run().changes;
      // Column set is taken from the file's own rows, intersected with the live
      // schema — so a file written by an older or newer build still loads.
      const present = [...new Set(rows.flatMap((r) => Object.keys(r ?? {})))];
      const use = present.filter((c) => columns.includes(c));
      const ignored = present.filter((c) => !columns.includes(c));
      let inserted = 0;
      if (use.length && rows.length) {
        const stmt = db.prepare(
          `INSERT INTO ${table} (${use.join(', ')}) VALUES (${use.map((c) => `@${c}`).join(', ')})`
        );
        for (const row of rows) {
          stmt.run(Object.fromEntries(use.map((c) => [c, bindable(row?.[c])])));
          inserted++;
        }
      }
      report[table] = { removed, inserted, ...(ignored.length ? { ignored_columns: ignored } : {}) };
    }
    return report;
  });

  const setContract = db.transaction((channel, key, value, by) => {
    const row = q.getContractVersion.get({ channel, key });
    const version = (row?.version ?? 0) + 1;
    q.upsertContract.run({ channel, key, value, version, by });
    q.insertContractHistory.run({ channel, key, value, version, by });
    return { version };
  });

  /**
   * Give an agent a face the first time the floor sees it, then leave it alone.
   *
   * Stability is the whole point: people learn the room by where somebody sits,
   * so a cast that reshuffles on reconnect would cost more comprehension than
   * the metaphor buys. The first free name in CAST wins, which makes the
   * assignment deterministic per channel rather than dependent on who connected
   * first on any given morning. An operator rename goes through setPersona and
   * is never undone by this.
   */
  /**
   * Hand a host everything waiting for it, and mark it taken, in one
   * transaction — so a host that asks twice (a retried request, say) cannot be
   * handed the same message twice and deliver it twice.
   */
  const takeHostWork = db.transaction((hostId) => {
    const rows = q.pendingHostWork.all(hostId);
    for (const r of rows) q.markWorkTaken.run(r.id);
    return rows.map((r) => {
      let payload = {};
      try { payload = JSON.parse(r.payload); } catch { /* a bad row is an empty job */ }
      return { id: r.id, channel: r.channel, agent: r.agent, kind: r.kind, payload, created_at: r.created_at };
    });
  });

  function ensurePersona(channel, agent) {
    const existing = q.getPersona.get(channel, agent);
    if (existing) return existing;
    const taken = new Set(q.personasInChannel.all(channel).map((r) => r.persona));
    // Past the end of the cast an agent simply keeps its own name — unglamorous,
    // but it cannot collide and it cannot be wrong.
    const persona = CAST.find((c) => !taken.has(c)) ?? agent;
    const seat = taken.size;
    q.upsertPersona.run({ channel, agent, persona, seat });
    return { persona, seat };
  }

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

    // --- backup / restore -----------------------------------------------------
    dumpTable: (table) => tableInfo(table).selectAll.all(),
    countTable: (table) => tableInfo(table).count.get().n,
    restoreBackup,

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

    // ─── The floor ──────────────────────────────────────────────────────────
    upsertSession: (s) =>
      q.upsertSession.run({
        session_id: s.session_id,
        channel: s.channel,
        agent: s.agent,
        cwd: s.cwd ?? null,
        transcript: s.transcript ?? null,
        model: s.model ?? null,
        permission_mode: s.permission_mode ?? null,
        git_branch: s.git_branch ?? null,
        runner: s.runner ?? null,
        pid: s.pid ?? null,
        parent_session: s.parent_session ?? null,
      }).changes,
    getSession: (sessionId) => q.getSession.get(sessionId) ?? null,
    liveHookSessions: (channel, agent) => q.liveHookSessions.all(channel, agent),
    /** A conversation's session ids, newest first: the session and the ones it was forked from. */
    sessionChain: (sessionId) => {
      const chain = [];
      let id = sessionId;
      while (id && chain.length < 8 && !chain.includes(id)) {
        chain.push(id);
        id = q.getSession.get(id)?.parent_session ?? null;
      }
      return chain;
    },
    turnsInSessions: (channel, agent, sessions) =>
      q.turnsInSessions.get(channel, agent, JSON.stringify(sessions ?? [])),
    setAwaiting: (sessionId, kind, message = null) =>
      q.setAwaiting.run({ session_id: sessionId, kind, message }).changes,
    clearAwaiting: (sessionId) => q.clearAwaiting.run({ session_id: sessionId }).changes,
    endSession: (sessionId) => q.endSession.run({ session_id: sessionId }).changes,
    insertTurn: (t) =>
      n(q.insertTurn.run({
        channel: t.channel,
        agent: t.agent,
        session_id: t.session_id,
        role: t.role,
        text: t.text ?? null,
        tool_name: t.tool_name ?? null,
      }).lastInsertRowid),
    // Oldest-first, because that is the order a conversation is read in.
    recentTurns: (channel, agent, { since = 0, limit = 80, sessions = null } = {}) =>
      q.recentTurns.all({ channel, agent, since, limit, sessions: sessions?.length ? JSON.stringify(sessions) : null }).reverse(),
    floorSessions: () => q.floorSessions.all(),
    lastTurns: () => q.lastTurns.all(),
    turnCounts: () => q.turnCounts.all(),
    listPersonas: () => q.listPersonas.all(),
    setPersona: (channel, agent, persona, seat = null) =>
      q.upsertPersona.run({ channel, agent, persona, seat }).changes,
    ensurePersona,
    pruneTurns: (keep = TURN_RETENTION) => q.pruneTurns.run({ keep }).changes,

    // ─── Hosting ────────────────────────────────────────────────────────────
    registerHost: (hostId, name, tmuxSession = null) =>
      q.upsertHost.run({ host_id: hostId, name, tmux_session: tmuxSession }).changes,
    touchHost: (hostId) => q.touchHost.run(hostId).changes,
    listHosts: () => q.listHosts.all(),
    hostDesk: (channel, agent, hostId, cwd, { windowId = null, outsidePid = null } = {}) =>
      q.upsertHostedDesk.run({
        channel, agent, host_id: hostId, cwd, window_id: windowId, outside_pid: outsidePid,
      }).changes,
    setHostedSession: (channel, agent, sdkSessionId) =>
      q.setHostedSession.run({ channel, agent, sdk_session_id: sdkSessionId }).changes,
    setHostedState: (channel, agent, state) => q.setHostedState.run({ channel, agent, state }).changes,
    setHostState: (hostId, state) => q.setHostState.run({ host_id: hostId, state }).changes,
    listHostedDesks: () => q.listHostedDesks.all(),
    hostedDesk: (channel, agent) => q.hostedDesk.get(channel, agent) ?? null,
    enqueueHostWork: (hostId, channel, agent, kind, payload) =>
      n(q.enqueueHostWork.run({ host_id: hostId, channel, agent, kind, payload: JSON.stringify(payload ?? {}) }).lastInsertRowid),
    takeHostWork,
    pruneHostWork: () => q.pruneHostWork.run().changes,
    /**
     * A hosted session only learns its own id on its first turn, so the message
     * that started it was filed under a placeholder. Move those turns to the
     * real id and drop the placeholder, so the conversation is one conversation.
     */
    rekeySession: db.transaction((channel, agent, from, to) => {
      const moved = q.rekeyTurns.run({ channel, agent, from, to }).changes;
      q.deleteSession.run(from);
      return moved;
    }),
  };
}

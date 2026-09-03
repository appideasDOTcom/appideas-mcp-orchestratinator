import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { shirtForSeat } from './palette.js';

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
      role        TEXT NOT NULL,            -- user | assistant | tool | error | context | thinking
      text        TEXT,
      tool_name   TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_turns_agent ON turns(channel, agent, id);

    -- Who each agent is on the floor. Assigned on first sight and editable by
    -- the operator, stored here rather than in a browser because a floor where
    -- two people disagree about which desk is which stops being a shared
    -- reference — the one job it has.
    -- What an agent is called and how it is drawn, for every channel at once.
    --
    -- Keyed by the agent id and nothing else, because that is what an operator
    -- means by "the name": X-Agent identifies the worker, so an agent called
    -- coordinator, renamed on one channel, is renamed on all of them. The derived default
    -- already behaved this way — it comes from the id, so it is the same
    -- everywhere — and a per-channel override made the two disagree the moment
    -- anybody used it.
    --
    -- A row exists only for an agent somebody has actually customised, and every
    -- column in it is nullable for the same reason: NULL means "the default",
    -- so changing a default reaches every agent that was happy with it rather
    -- than only the ones seen since. The name derives from the agent id; the
    -- gender is neutral, which is the avatar drawn with no hair at all.
    CREATE TABLE IF NOT EXISTS agent_profile (
      agent      TEXT PRIMARY KEY,
      persona    TEXT,
      gender     TEXT,
      shirt      TEXT,
      hair       TEXT,
      skin       TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Where an agent sits, which is per channel because a room is per channel.
    -- The table keeps its name for the sake of every database already carrying
    -- it; what it no longer keeps is the agent's name. Older copies still have a
    -- persona column here, and migratePersonas removes it after lifting the
    -- operator-chosen names into agent_names above.
    CREATE TABLE IF NOT EXISTS personas (
      channel     TEXT NOT NULL,
      agent       TEXT NOT NULL,
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
      kind        TEXT NOT NULL,              -- chat | permission | interrupt | handback | open
      payload     TEXT NOT NULL,              -- JSON
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      taken_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_host_outbox_pending ON host_outbox(host_id, taken_at, id);

    -- ─── Operator furniture ───────────────────────────────────────────────────
    -- The handful of messages an operator sends over and over, kept so they can
    -- be picked instead of retyped. Board-wide rather than per-channel: there
    -- are about ten of them and they are the operator's, not a channel's, so
    -- scoping them per channel would mean saving the same text four times.
    --
    -- The unique index is the duplicate-title rule. Enforced here rather than
    -- only in the form because the form is one of two ways in — the other is a
    -- restored backup — and a rule that lives in one caller is not a rule.
    -- NOCASE so "Deploy" and "deploy" collide, which is what a person means by
    -- "no duplicate titles".
    CREATE TABLE IF NOT EXISTS saved_prompts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      title      TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_prompts_title ON saved_prompts(title COLLATE NOCASE);
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

  // Who said a turn, when it was not the desk's own thread: the description of
  // the subagent (Agent tool) whose transcript it was read from, NULL for the
  // conversation itself. A column rather than a prefix baked into the text, so
  // the chat panel can label it and the bubble can still quote it plainly.
  addColumn(db, 'turns', 'via', 'TEXT');

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
  // A tmux window in this desk's repo, whether or not a session has registered
  // in it yet — deliberately not `window_id`, which means "a window the floor
  // can type into". They differ throughout Claude Code's startup.
  addColumn(db, 'hosted_desks', 'window_open', 'TEXT');
  // How many live processes claim this desk's conversation. Normally 1.
  addColumn(db, 'hosted_desks', 'holders', 'INTEGER');
  // Terminals attached to the host's tmux session. A property of the session
  // rather than of this desk, carried per desk because that is the row the
  // floor already reads. It is the receipt an attach spins against.
  addColumn(db, 'hosted_desks', 'clients', 'INTEGER');

  migratePersonas(db);
  migrateAgentNames(db);
  addColumn(db, 'agent_profile', 'shirt', 'TEXT');
  addColumn(db, 'agent_profile', 'hair', 'TEXT');
  addColumn(db, 'agent_profile', 'skin', 'TEXT');
  migrateShirts(db);

  return db;
}

/**
 * Retire the arrival-order cast in databases that still carry it.
 *
 * Only rows whose name is still exactly a cast name are rewritten — anything an
 * operator typed is theirs and is left alone. The test is imperfect by
 * construction: an operator who deliberately named someone "Ada" loses it here,
 * once. That is accepted rather than solved, because the alternative is a
 * `named_by` column existing forever to record a distinction that stops
 * mattering the moment this has run.
 *
 * Seats are untouched, so no desk moves.
 */
function migratePersonas(db) {
  const cols = db.prepare(`PRAGMA table_info(personas)`).all().map((c) => c.name);
  if (!cols.includes('persona')) return;   // already migrated

  const rows = db.prepare(`SELECT channel, agent, persona, assigned_at FROM personas`).all();
  const cast = new Set(CAST);

  // A name worth keeping is one an operator actually chose: not a cast name,
  // and not the default this agent would derive anyway. Where the same agent
  // was named differently on two channels the most recent wins, because a
  // global name can only be one thing and the last thing said is the best
  // available guess at what the operator currently wants.
  const chosen = new Map();
  for (const r of rows) {
    if (!r.persona || cast.has(r.persona) || r.persona === humanName(r.agent)) continue;
    const prev = chosen.get(r.agent);
    if (!prev || String(r.assigned_at ?? '') >= String(prev.assigned_at ?? '')) chosen.set(r.agent, r);
  }

  const insert = db.prepare(
    `INSERT INTO agent_names (agent, persona, named_at) VALUES (?, ?, COALESCE(?, datetime('now')))
     ON CONFLICT(agent) DO NOTHING`
  );
  db.transaction(() => {
    for (const [agent, r] of chosen) insert.run(agent, r.persona, r.assigned_at);
  })();

  const conflicts = [...chosen.keys()].filter(
    (a) => new Set(rows.filter((r) => r.agent === a && r.persona && !cast.has(r.persona)).map((r) => r.persona)).size > 1
  );
  console.log(
    `[db] names are now global: kept ${chosen.size} operator-chosen name${chosen.size === 1 ? '' : 's'}` +
    `, everything else derives from its agent id` +
    (conflicts.length ? ` · ${conflicts.join(', ')} had different names on different channels — kept the most recent` : '')
  );

  // The column is gone rather than left to rot: two places holding a name is
  // how they come to disagree, and a reader finding `personas.persona` would
  // reasonably believe it.
  dropColumns(db, 'personas', ['persona'], 'a name belongs to the agent now, not to one of its desks');
}

/**
 * Give every agent that already has a seat the shirt that seat implied.
 *
 * Before this the colour was a CSS rule keyed on seat, so it existed only while
 * the page was open. Writing it down changes nothing on screen — the values are
 * the same five, in the same order — and it is what makes the colour editable
 * without the edit being undone by the next re-render.
 */
function migrateShirts(db) {
  const seated = db.prepare(
    `SELECT p.agent, MIN(p.seat) AS seat FROM personas p
      WHERE NOT EXISTS (SELECT 1 FROM agent_profile a WHERE a.agent = p.agent AND a.shirt IS NOT NULL)
      GROUP BY p.agent`
  ).all();
  if (!seated.length) return;
  const set = db.prepare(
    `INSERT INTO agent_profile (agent, shirt) VALUES (?, ?)
     ON CONFLICT(agent) DO UPDATE SET shirt = COALESCE(shirt, excluded.shirt)`
  );
  db.transaction(() => {
    for (const r of seated) set.run(r.agent, shirtForSeat(r.seat));
  })();
  console.log(`[db] recorded a shirt colour for ${seated.length} agent${seated.length === 1 ? '' : 's'} from the seat each already had`);
}

/**
 * `agent_names` held one thing about an agent; `agent_profile` holds several.
 *
 * Renamed rather than extended because a table called "names" that also carries
 * how somebody is drawn misleads the next reader, and more avatar settings are
 * coming. Short-lived table, so this only ever matches a database written in the
 * window between the two.
 */
function migrateAgentNames(db) {
  const has = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='agent_names'`).get();
  if (!has) return;
  const moved = db.prepare(
    `INSERT INTO agent_profile (agent, persona, updated_at)
     SELECT agent, persona, named_at FROM agent_names
     WHERE TRUE ON CONFLICT(agent) DO UPDATE SET persona = COALESCE(agent_profile.persona, excluded.persona)`
  ).run().changes;
  db.exec(`DROP TABLE agent_names`);
  console.log(`[db] agent_names -> agent_profile (${moved} name${moved === 1 ? '' : 's'} carried over)`);
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
 * The cast this system used to hand out: Ada, Bo, Cleo… assigned in arrival
 * order. It is kept for one reason only — `migratePersonas` needs to recognise
 * an auto-assigned name in an existing database — and nothing assigns from it
 * any more.
 *
 * It was replaced because a name given by arrival order is arbitrary, and an
 * arbitrary name used as an identifier is worse than no name: two channels each
 * called their first agent Ada, so "Ada" meant nothing on its own and the
 * operator had to translate it back to an X-Agent every time. A name derived
 * from the agent's own id cannot drift from what it names.
 */
export const CAST = [
  'Ada', 'Bo', 'Cleo', 'Dex', 'Edie', 'Finn', 'Greta', 'Hugo',
  'Ines', 'Jonas', 'Kira', 'Lou', 'Mira', 'Nico', 'Opal', 'Piper',
];

/**
 * The name an agent is given when nobody has chosen one: its own id, made
 * readable. Words split on anything that is not a letter or a digit, and each
 * gets its first character upper-cased — `appideas-qa` becomes `Appideas Qa`.
 *
 * The rest of each word is left exactly as written, so an id that already
 * carries capitals keeps them (`QA` stays `QA` rather than becoming `Qa`).
 * An id with nothing alphanumeric in it is returned unchanged, because a blank
 * nameplate would be worse than an ugly one.
 */
export function humanName(agent) {
  const raw = String(agent ?? '');
  const words = raw.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (!words.length) return raw;
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

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
 * `personas` and `agent_profile` are included because where an agent sits and
 * how it is named and drawn are both operator decisions that would otherwise be
 * silently lost on a restore. The hosting tables are
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
  'agent_profile',
  'saved_prompts',
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

    // Saved prompts. Ordered here rather than in the picker: two surfaces list
    // them (the compose menu and the manager) and an order decided twice is an
    // order that eventually disagrees with itself. NOCASE so the list reads
    // alphabetically to a person rather than to ASCII, which would file every
    // lower-case title after every upper-case one.
    listSavedPrompts: db.prepare(
      `SELECT id, title, content, created_at, updated_at
         FROM saved_prompts ORDER BY title COLLATE NOCASE`
    ),
    getSavedPrompt: db.prepare(`SELECT id, title, content FROM saved_prompts WHERE id = ?`),
    savedPromptByTitle: db.prepare(`SELECT id FROM saved_prompts WHERE title = ? COLLATE NOCASE`),
    insertSavedPrompt: db.prepare(
      `INSERT INTO saved_prompts (title, content) VALUES (?, ?)`
    ),
    updateSavedPrompt: db.prepare(
      `UPDATE saved_prompts SET title = ?, content = ?, updated_at = datetime('now') WHERE id = ?`
    ),
    deleteSavedPrompt: db.prepare(`DELETE FROM saved_prompts WHERE id = ?`),

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
    // The unread messages themselves, not just the count. Bounded like
    // boardTasks: the join is naturally small because it only matches messages
    // past an agent's cursor, but a channel nobody has polled for a week would
    // otherwise put its whole history in a dashboard poll.
    unreadMessages: db.prepare(
      `SELECT a.channel, a.agent, m.id, m.from_agent AS "from", m.to_agent AS "to",
              m.body, m.created_at
         FROM agents a
         JOIN messages m
           ON m.channel = a.channel AND m.id > a.poll_cursor
          AND (m.to_agent = a.agent OR (m.to_agent IS NULL AND m.from_agent != a.agent))
        WHERE a.retired_at IS NULL
        ORDER BY a.channel, a.agent, m.id DESC
        LIMIT 2000`
    ),
    reassignMessage: db.prepare(
      `UPDATE messages SET to_agent = @to WHERE channel = @channel AND id = @id`
    ),
    messageById: db.prepare(
      `SELECT id, channel, from_agent AS "from", to_agent AS "to", body, created_at
         FROM messages WHERE channel = @channel AND id = @id`
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
              -- One prompt announces itself twice under two different names —
              -- PermissionRequest, then a permission_prompt notification about
              -- six seconds later — and counting those as two waits restarted
              -- the clock, so every prompt's age read six seconds short. Same
              -- wait, so same start.
              awaiting_since   = CASE WHEN awaiting_since IS NOT NULL AND (
                                        awaiting_kind = @kind
                                        OR (awaiting_kind IN ('permission_request', 'permission_prompt')
                                            AND @kind IN ('permission_request', 'permission_prompt'))
                                      )
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
    // Raise and clear addressed by *desk* rather than by session, for callers
    // that are not the hook — the operator answering a prompt, and the host
    // reporting that an answer never landed.
    //
    // Both target the newest session for the desk, which is exactly the row the
    // floor payload reads. A host event carries no session id of its own and
    // falls back to `hosted_desks.sdk_session_id`, which is set by a different
    // message than the one that created the session row; when those two have not
    // met yet it lands on a placeholder, and an error filed there is an error
    // nobody sees.
    setDeskAwaiting: db.prepare(
      `UPDATE agent_sessions
          SET awaiting_kind    = @kind,
              awaiting_message = @message,
              -- One prompt announces itself twice under two different names —
              -- PermissionRequest, then a permission_prompt notification about
              -- six seconds later — and counting those as two waits restarted
              -- the clock, so every prompt's age read six seconds short. Same
              -- wait, so same start.
              awaiting_since   = CASE WHEN awaiting_since IS NOT NULL AND (
                                        awaiting_kind = @kind
                                        OR (awaiting_kind IN ('permission_request', 'permission_prompt')
                                            AND @kind IN ('permission_request', 'permission_prompt'))
                                      )
                                      THEN awaiting_since ELSE datetime('now') END,
              updated_at       = datetime('now')
        WHERE session_id = (SELECT session_id FROM agent_sessions
                             WHERE channel = @channel AND agent = @agent
                             ORDER BY updated_at DESC LIMIT 1)`
    ),
    clearDeskAwaiting: db.prepare(
      `UPDATE agent_sessions
          SET awaiting_kind = NULL, awaiting_message = NULL, awaiting_since = NULL,
              updated_at = datetime('now')
        WHERE session_id = (SELECT session_id FROM agent_sessions
                             WHERE channel = @channel AND agent = @agent
                             ORDER BY updated_at DESC LIMIT 1)`
    ),
    endSession: db.prepare(
      `UPDATE agent_sessions
          SET ended_at = datetime('now'), awaiting_kind = NULL, awaiting_message = NULL,
              awaiting_since = NULL, updated_at = datetime('now')
        WHERE session_id = @session_id`
    ),
    insertTurn: db.prepare(
      `INSERT INTO turns (channel, agent, session_id, role, text, tool_name, via)
       VALUES (@channel, @agent, @session_id, @role, @text, @tool_name, @via)`
    ),
    // Keyed by channel+agent rather than session: a resumed session gets a new
    // session_id but it is the same desk, and a chat panel that emptied itself
    // every time somebody ran /resume would be worse than no chat panel.
    recentTurns: db.prepare(
      // Optionally one conversation only. A desk can have more than one session
      // on it, and the panel should show the one you are in. `sessions` is a
      // JSON array rather than one id because a conversation can span ids: a
      // fork carries its parent's history, and the two read as one.
      `SELECT id, session_id, role, text, tool_name, via, created_at
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
      `SELECT t.channel, t.agent, t.role, t.text, t.tool_name, t.via, t.created_at, t.id
         FROM turns t
         JOIN (SELECT channel, agent, MAX(id) AS id
                 FROM turns WHERE text IS NOT NULL AND text != ''
                GROUP BY channel, agent) last
           ON last.channel = t.channel AND last.agent = t.agent AND last.id = t.id`
    ),
    turnCounts: db.prepare(`SELECT channel, agent, COUNT(*) AS n FROM turns GROUP BY channel, agent`),
    /* The last thing an agent SAID or THOUGHT, and the last few things it DID —
       the floor's thought bubble draws the first, its monitor types the second.
       Thinking counts (2026-09-03, at the operator's ask): a thought bubble is
       where a thought belongs, and between replies it is the one line that says
       what the desk is doing. A desk that
       reads "Bash: grep -rn ..." tells an operator what a tool call looked like,
       which is the one thing the chat panel behind it already shows in full;
       what it cannot get anywhere else at a glance is what the agent is telling
       them.

       Per desk, not per table, and that is the point. Both started as one query
       over every turn: a MAX(id) GROUP BY for the message, a ROW_NUMBER() window
       for the commands. Correct, and measured at 80k turns they cost 18ms and
       52ms *per call* — on a payload every open browser polls every two seconds,
       against a table that only grows. Driven off idx_turns_agent one desk at a
       time the same work is 0.15ms and 0.23ms for twenty desks. A seek per desk
       beats a scan per poll. */
    deskLastMessage: db.prepare(
      `SELECT id, text, created_at
         FROM turns
        WHERE channel = ? AND agent = ? AND role IN ('assistant', 'thinking')
          AND text IS NOT NULL AND text != ''
        ORDER BY id DESC LIMIT 1`
    ),
    deskCommands: db.prepare(
      `SELECT id, text
         FROM turns
        WHERE channel = ? AND agent = ? AND role = 'tool'
          AND text IS NOT NULL AND text != ''
        ORDER BY id DESC LIMIT ?`
    ),
    /* The newest thing the operator said, whoever they said it through — the
       floor's compose box, the bell, or the keyboard at the window itself.
       Compared against deskLastMessage to answer one question: has the agent
       said anything since it was spoken to? Same seek off idx_turns_agent as
       its two neighbours, for the reason written above them.

       `[Request interrupted by user]` is filed as a user turn, but Claude Code
       writes it, not the operator — so counting it would put "Thinking…" in the
       bubble at the exact moment the operator stopped the agent thinking, which
       is the stale-bubble problem this query exists to fix, inverted. The
       bracket has to close for the line to be only the marker: interrupting by
       typing leaves the marker with the real message after it, and that one IS
       the operator speaking. */
    /* The text comes back as well as the id. Both callers want a different half
       of the same row: the queue asks "has this desk been spoken to since it
       last spoke", which is an id comparison, and the delivery note asks "is
       the message I am about to say is queued already in the conversation",
       which can only be answered by the words. */
    deskLastUserTurn: db.prepare(
      `SELECT id, text, created_at
         FROM turns
        WHERE channel = ? AND agent = ? AND role = 'user'
          AND NOT (text LIKE '[Request interrupted%' AND text LIKE '%]')
        ORDER BY id DESC LIMIT 1`
    ),
    /* The newest turn of any kind, for the one caller that needs a single
       desk's rather than every desk's — see lastTurns above for the bulk form.
       Same shape, same "a turn with no text is not a turn" rule. */
    deskLastTurn: db.prepare(
      `SELECT id, role, tool_name, via, created_at
         FROM turns
        WHERE channel = ? AND agent = ? AND text IS NOT NULL AND text != ''
        ORDER BY id DESC LIMIT 1`
    ),
    listPersonas: db.prepare(
      `SELECT p.channel, p.agent, n.persona AS persona, p.seat
         FROM personas p LEFT JOIN agent_profile n ON n.agent = p.agent`
    ),
    seatsInChannel: db.prepare(`SELECT agent, seat FROM personas WHERE channel = ?`),
    getPersona: db.prepare(
      `SELECT n.persona AS persona, p.seat
         FROM personas p LEFT JOIN agent_profile n ON n.agent = p.agent
        WHERE p.channel = ? AND p.agent = ?`
    ),
    upsertSeat: db.prepare(
      `INSERT INTO personas (channel, agent, seat)
       VALUES (@channel, @agent, @seat)
       ON CONFLICT(channel, agent) DO UPDATE SET
         seat        = COALESCE(excluded.seat, seat),
         assigned_at = datetime('now')`
    ),
    getName: db.prepare(`SELECT persona FROM agent_profile WHERE agent = ?`),
    // The name-shaped twin of setShirtIfUnset: fills a blank, never overwrites.
    setNameIfUnset: db.prepare(
      `INSERT INTO agent_profile (agent, persona) VALUES (@agent, @persona)
       ON CONFLICT(agent) DO UPDATE SET
         persona = COALESCE(persona, excluded.persona), updated_at = datetime('now')`
    ),
    listProfiles: db.prepare(`SELECT agent, persona, gender, shirt, hair, skin FROM agent_profile`),
    getShirt: db.prepare(`SELECT shirt FROM agent_profile WHERE agent = ?`),
    setShirtIfUnset: db.prepare(
      `INSERT INTO agent_profile (agent, shirt) VALUES (@agent, @shirt)
       ON CONFLICT(agent) DO UPDATE SET shirt = COALESCE(shirt, excluded.shirt)`
    ),
    // One row per agent, every channel at once. COALESCE so setting one field
    // never silently clears another: the caller passes NULL for "leave it".
    upsertProfile: db.prepare(
      `INSERT INTO agent_profile (agent, persona, gender, shirt, hair, skin)
       VALUES (@agent, @persona, @gender, @shirt, @hair, @skin)
       ON CONFLICT(agent) DO UPDATE SET
         persona    = COALESCE(@persona, persona),
         gender     = COALESCE(@gender, gender),
         shirt      = COALESCE(@shirt, shirt),
         hair       = COALESCE(@hair, hair),
         skin       = COALESCE(@skin, skin),
         updated_at = datetime('now')`
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
      `INSERT INTO hosted_desks (channel, agent, host_id, cwd, window_id, outside_pid, window_open, holders, state, updated_at)
       VALUES (@channel, @agent, @host_id, @cwd, @window_id, @outside_pid, @window_open, @holders, 'idle', datetime('now'))
       ON CONFLICT(channel, agent) DO UPDATE SET
         host_id = excluded.host_id, cwd = excluded.cwd,
         window_id = excluded.window_id, outside_pid = excluded.outside_pid,
         window_open = excluded.window_open, holders = excluded.holders,
         state = 'idle', updated_at = datetime('now')`
    ),
    setHostedHolder: db.prepare(
      // Only who is holding the desk. Deliberately not the upsert: that resets
      // state to 'idle', and the holder changes while a turn is running.
      `UPDATE hosted_desks SET window_id = @window_id, outside_pid = @outside_pid,
              window_open = @window_open, holders = @holders, clients = @clients,
              updated_at = datetime('now')
        WHERE channel = @channel AND agent = @agent`
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
              d.window_id, d.outside_pid, d.window_open, d.holders, d.clients,
              h.name AS host_name, h.last_seen AS host_seen, h.tmux_session AS host_tmux
         FROM hosted_desks d
         LEFT JOIN hosts h ON h.host_id = d.host_id`
    ),
    hostedDesk: db.prepare(
      `SELECT d.channel, d.agent, d.host_id, d.cwd, d.sdk_session_id, d.state, d.updated_at,
              d.window_id, d.outside_pid, d.window_open, d.holders, d.clients,
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
          try {
            stmt.run(Object.fromEntries(use.map((c) => [c, bindable(row?.[c])])));
          } catch (err) {
            // A row this schema refuses — a duplicate key, a constraint added
            // since the file was written. The transaction rolls the whole
            // restore back; what the caller needs from here is *which table and
            // row*, because "UNIQUE constraint failed" alone sends someone
            // grepping a file that may hold a hundred thousand rows.
            err.message = `"${table}" row ${inserted + 1} of ${rows.length} was refused: ${err.message}`;
            throw err;
          }
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
    // A seat row can exist with no name — that is the normal case now, and it
    // means "call it whatever the id derives to".
    if (existing) return { persona: existing.persona ?? humanName(agent), seat: existing.seat };
    // Seat is still arrival order — it decides where the desk is drawn, and
    // desks staying where people learned them is worth keeping. The *name* is
    // not: it comes from the agent's own id, so it means the same thing on
    // every channel and needs no translation back to an X-Agent.
    //
    // Deliberately no uniqueness check. Two agents may end up sharing a name,
    // here or after an operator renames one, and that is allowed: the id below
    // the name is what identifies them, and a guard would only be able to
    // refuse an operator something they asked for on purpose.
    const seat = q.seatsInChannel.all(channel).length;
    q.upsertSeat.run({ channel, agent, seat });
    // The shirt is written down now and never derived again. Every other
    // default resolves at read time so it can be improved later, but this one
    // depends on arrival order: leave it underived and an agent's shirt would
    // change whenever a desk ahead of it was removed. It is a fact about when
    // this agent arrived, so it is recorded once, here.
    q.setShirtIfUnset.run({ agent, shirt: shirtForSeat(seat) });
    return { persona: q.getName.get(agent)?.persona ?? humanName(agent), seat };
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
    /**
     * Take on names a legacy backup kept per desk — see applyBackup, which is
     * the only caller and holds the reasoning. A name already on this board
     * wins over the file's, the same rule migratePersonas applied to a live
     * database: the file is the past, and the board may have been renamed
     * since. Returns what happened rather than a row count, because "kept"
     * only matters when the two disagreed.
     */
    adoptNames: db.transaction((rows) => {
      let adopted = 0, kept = 0;
      for (const r of rows) {
        const standing = q.getName.get(r.agent)?.persona ?? null;
        if (standing) {
          if (standing !== r.persona) kept++;
          continue;
        }
        q.setNameIfUnset.run({ agent: r.agent, persona: r.persona });
        adopted++;
      }
      return { adopted, kept };
    }),

    // --- dashboard reads ------------------------------------------------------
    listAllAgents: () => q.listAllAgents.all(),
    listChannelFlags: () => q.listChannelFlags.all(),

    // --- saved prompts --------------------------------------------------------
    // The duplicate-title check is a read the caller makes before writing, and
    // the unique index behind it is what makes that safe: this is one process,
    // so nothing can slip between the two, and if anything ever does the write
    // fails rather than quietly making a second "Deploy".
    listSavedPrompts: () => q.listSavedPrompts.all(),
    getSavedPrompt: (id) => q.getSavedPrompt.get(id) ?? null,
    /** The prompt holding this title, if any — `exceptId` skips the row being edited. */
    savedPromptByTitle: (title, exceptId = null) => {
      const row = q.savedPromptByTitle.get(title);
      return row && row.id !== exceptId ? row : null;
    },
    createSavedPrompt: (title, content) => n(q.insertSavedPrompt.run(title, content).lastInsertRowid),
    updateSavedPrompt: (id, title, content) => q.updateSavedPrompt.run(title, content, id).changes,
    deleteSavedPrompt: (id) => q.deleteSavedPrompt.run(id).changes,
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
    unreadMessages: () => q.unreadMessages.all(),
    messageById: (channel, id) => q.messageById.get({ channel, id }),
    reassignMessage: (channel, id, to) => q.reassignMessage.run({ channel, id, to: to || null }).changes,
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
    clearDeskAwaiting: (channel, agent) => q.clearDeskAwaiting.run({ channel, agent }).changes,
    setDeskAwaiting: (channel, agent, kind, message = null) =>
      q.setDeskAwaiting.run({ channel, agent, kind, message }).changes,
    endSession: (sessionId) => q.endSession.run({ session_id: sessionId }).changes,
    insertTurn: (t) =>
      n(q.insertTurn.run({
        channel: t.channel,
        agent: t.agent,
        session_id: t.session_id,
        role: t.role,
        text: t.text ?? null,
        tool_name: t.tool_name ?? null,
        // The statement names every parameter, so a caller that omits one
        // fails the whole insert — which is what happened the day this column
        // was added to the statement and not here.
        via: t.via ?? null,
      }).lastInsertRowid),
    // Oldest-first, because that is the order a conversation is read in.
    recentTurns: (channel, agent, { since = 0, limit = 80, sessions = null } = {}) =>
      q.recentTurns.all({ channel, agent, since, limit, sessions: sessions?.length ? JSON.stringify(sessions) : null }).reverse(),
    floorSessions: () => q.floorSessions.all(),
    lastTurns: () => q.lastTurns.all(),
    turnCounts: () => q.turnCounts.all(),
    deskLastMessage: (channel, agent) => q.deskLastMessage.get(channel, agent) ?? null,
    // Reversed here rather than in SQL: the screen types them in the order they
    // happened, and LIMIT has to keep the newest end.
    deskCommands: (channel, agent, n) => q.deskCommands.all(channel, agent, n).reverse(),
    deskLastUserTurn: (channel, agent) => q.deskLastUserTurn.get(channel, agent) ?? null,
    deskLastTurn: (channel, agent) => q.deskLastTurn.get(channel, agent) ?? null,
    // Names filled in here rather than in SQL: the derivation is JavaScript, and
    // duplicating it as SQL string surgery is exactly how two answers to "what
    // is this agent called" start to disagree.
    listPersonas: () => q.listPersonas.all().map((r) => ({ ...r, persona: r.persona ?? humanName(r.agent) })),
    /**
     * Everything an operator has chosen, as { agent: { persona, gender } }.
     *
     * Separate from `listPersonas` because that one is per *desk* and only
     * knows agents that have taken a seat. A profile outlives its seats: an
     * agent renamed on one channel must answer to that name on a channel where
     * it has never posted a hook event, which is most of them.
     */
    listProfiles: () => Object.fromEntries(
      q.listProfiles.all().map((r) => [r.agent, {
        persona: r.persona, gender: r.gender, shirt: r.shirt, hair: r.hair, skin: r.skin,
      }])
    ),
    /**
     * Set what an operator has chosen about an agent — for every channel at once,
     * because these belong to the agent and not to one of its desks.
     *
     * Fields left `undefined` are untouched, so the name and the avatar can be
     * edited independently without either erasing the other. `channel` is
     * accepted and ignored: every caller has one to hand, and the admin log
     * records which board the operator was looking at when they did it.
     */
    setProfile: (_channel, agent, { persona = null, gender = null, shirt = null, hair = null, skin = null } = {}) =>
      q.upsertProfile.run({ agent, persona, gender, shirt, hair, skin }).changes,
    ensurePersona,
    pruneTurns: (keep = TURN_RETENTION) => q.pruneTurns.run({ keep }).changes,

    // ─── Hosting ────────────────────────────────────────────────────────────
    registerHost: (hostId, name, tmuxSession = null) =>
      q.upsertHost.run({ host_id: hostId, name, tmux_session: tmuxSession }).changes,
    touchHost: (hostId) => q.touchHost.run(hostId).changes,
    listHosts: () => q.listHosts.all(),
    setHostedHolder: (channel, agent, { windowId = null, outsidePid = null, windowOpen = null, holders = 0, clients = 0 } = {}) =>
      q.setHostedHolder.run({ channel, agent, window_id: windowId, outside_pid: outsidePid, window_open: windowOpen, holders, clients }).changes,
    hostDesk: (channel, agent, hostId, cwd, { windowId = null, outsidePid = null, windowOpen = null, holders = 0 } = {}) =>
      q.upsertHostedDesk.run({
        channel, agent, host_id: hostId, cwd, window_id: windowId, outside_pid: outsidePid,
        window_open: windowOpen, holders,
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

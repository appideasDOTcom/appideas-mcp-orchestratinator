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
  `);
  return db;
}

const n = (v) => (typeof v === 'bigint' ? Number(v) : v);

/**
 * Wrap a database handle in a small set of channel-scoped data operations.
 * Because there is exactly one Node process, better-sqlite3's synchronous
 * calls serialize all writes for us — no cross-process locking to manage.
 */
export function makeStore(db) {
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
    completeTask: db.prepare(
      `UPDATE tasks
       SET status = 'done', note = @note, claimed_by = COALESCE(claimed_by, @by), updated_at = datetime('now')
       WHERE channel = @channel AND id = @id AND status != 'done'`
    ),
    touchAgent: db.prepare(
      `INSERT INTO agents (channel, agent, last_seen)
       VALUES (@channel, @agent, datetime('now'))
       ON CONFLICT(channel, agent) DO UPDATE SET last_seen = datetime('now')`
    ),
    listAgents: db.prepare(
      `SELECT agent, last_seen FROM agents WHERE channel = @channel ORDER BY agent`
    ),
  };

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

    touchAgent: (channel, agent) => q.touchAgent.run({ channel, agent }),
    listAgents: (channel) => q.listAgents.all({ channel }),
  };
}

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BACKUP_TABLES } from './db.js';

/**
 * Export and restore the whole board as one JSON file.
 *
 * Why JSON and not a copy of the SQLite file. The job this exists for is moving a
 * board off a laptop and onto something that stays up, which means the file gets
 * carried between two builds of this server that may not have identical schemas.
 * A `.db` copy is faithful but opaque and version-locked; a JSON dump can be
 * opened, diffed, grepped, and loaded by a build with a column the file has never
 * heard of (see restoreBackup — unknown columns are reported and skipped rather
 * than fatal). It is also restorable through the API, so moving a board never
 * needs anyone to go poking at a Docker volume by hand.
 *
 * What it deliberately does NOT contain: the shared MCP secret, and live login
 * cookies. See `describeAuth` and BACKUP_TABLES.
 */

export const FORMAT = 'orchestratinator-backup';
export const FORMAT_VERSION = 1;

/**
 * What the destination host needs configured for a restored board to work, and
 * how to tell whether it already is.
 *
 * The shared secret is not in the file. It's the credential every agent's
 * .mcp.json holds, so a backup carrying it would turn "I downloaded a copy of my
 * task board" into "I downloaded the key to it" — and these files get emailed to
 * yourself, dropped in Downloads, and synced to cloud drives. The fingerprint is
 * a truncated SHA-256 of it, which is enough to answer the only question that
 * actually comes up on the far end ("is this the same key my agents already
 * have?") and reverses to nothing.
 */
function describeAuth(env, meta) {
  const token = (env.ORCH_AUTH_TOKEN ?? '').trim();
  return {
    shared_secret_set: !!token,
    shared_secret_fingerprint: token
      ? `sha256:${createHash('sha256').update(token).digest('hex').slice(0, 12)}`
      : null,
    mode: meta.authMode ?? null,
    // Named, not valued. A restore on a new host is expected to bring its own
    // .env; this is the checklist for writing one.
    env_required: [
      'ORCH_AUTH_TOKEN (not in this file — copy it from the old host\'s .env, or reissue it and update every .mcp.json)',
      'ORCH_AUTH_MODE',
      'DB_PATH',
      'PORT',
    ],
  };
}

/** The whole board, as the object that gets serialised to a download. */
export function buildBackup({ store, meta, env = process.env }) {
  const tables = {};
  const counts = {};
  for (const table of BACKUP_TABLES) {
    tables[table] = store.dumpTable(table);
    counts[table] = tables[table].length;
  }
  return {
    format: FORMAT,
    format_version: FORMAT_VERSION,
    created_at: new Date().toISOString(),
    server: { name: meta.name, version: meta.version },
    source: { db_path: meta.dbPath, port: meta.port, started_at: meta.startedAt },
    auth: describeAuth(env, meta),
    // Redundant with `tables`, and worth it: this is what the restore dialog shows
    // you before you overwrite anything, and reading it needs no schema knowledge.
    counts,
    tables,
  };
}

/** A filename that sorts chronologically and survives a Downloads folder. */
export function backupFilename(now = new Date()) {
  return `orchestratinator-backup-${now.toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
}

/**
 * Reject a file we can't honestly claim to understand.
 *
 * A restore is destructive, so the failure to avoid is loading half of something
 * unrecognised and leaving the board in a state that came from neither the file
 * nor the database. Cheap structural checks, all of them before any write.
 */
export function validateBackup(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 'that is not a backup file (expected a JSON object)';
  if (doc.format !== FORMAT) {
    return `that file is not an ${FORMAT} (its "format" says ${JSON.stringify(doc.format ?? null)})`;
  }
  const v = Number(doc.format_version);
  if (!Number.isInteger(v) || v < 1) return 'that backup has no usable format_version';
  if (v > FORMAT_VERSION) {
    return `that backup is format_version ${v}; this server understands up to ${FORMAT_VERSION}. Upgrade the server first.`;
  }
  if (!doc.tables || typeof doc.tables !== 'object' || Array.isArray(doc.tables)) {
    return 'that backup has no "tables" object';
  }
  const known = Object.keys(doc.tables).filter((t) => BACKUP_TABLES.includes(t));
  if (!known.length) return 'that backup contains none of the tables this server keeps';
  for (const t of known) {
    if (!Array.isArray(doc.tables[t])) return `"tables.${t}" is not an array of rows`;
  }
  return null;
}

/**
 * Write the current board next to the database before overwriting it.
 *
 * A one-click destructive action whose only undo is "hope you took a backup
 * first" is the kind of thing that eats an afternoon, and the snapshot costs a
 * few hundred kilobytes on the volume. Best-effort on purpose: a read-only
 * filesystem or a full disk is a reason to warn, not a reason to refuse a restore
 * someone is deliberately performing.
 */
export function snapshotBeforeRestore({ store, meta, env = process.env }) {
  try {
    const dir = dirname(meta.dbPath);
    const path = join(dir, `pre-restore-${backupFilename()}`);
    writeFileSync(path, JSON.stringify(buildBackup({ store, meta, env })));
    return { saved: true, path };
  } catch (e) {
    return { saved: false, error: String(e.message ?? e) };
  }
}

/**
 * Load a validated backup over the top of the current board.
 *
 * Two safety rules that aren't obvious from the shape of the data:
 *
 *  - A backup whose `users` table has nobody enabled in it does not get to
 *    replace the current users. Restoring it literally would leave a server with
 *    no account that can sign in, which reads as "the restore broke the login"
 *    rather than as the faithful reproduction it technically is. Keeping the
 *    current users is the only outcome that stays operable.
 *  - When users *are* replaced, every live login is dropped. The credentials that
 *    would keep those cookies valid have just been swapped out from underneath
 *    them, so continuing to honour them would mean trusting a session against a
 *    user table it was never checked against.
 */
export function applyBackup({ store, doc }) {
  const tables = {};
  for (const t of BACKUP_TABLES) if (Array.isArray(doc.tables[t])) tables[t] = doc.tables[t];

  const incomingUsers = tables.users ?? null;
  const usable = (incomingUsers ?? []).filter(
    (u) => u && typeof u.username === 'string' && typeof u.password === 'string' && (u.enabled ?? 1)
  );
  const notes = [];
  const replacedUsers = !!incomingUsers && usable.length > 0;
  if (incomingUsers && !replacedUsers) {
    delete tables.users;
    notes.push(
      incomingUsers.length
        ? 'kept the current dashboard users: every account in the backup was disabled or malformed'
        : 'kept the current dashboard users: the backup carried none'
    );
  }

  const missing = BACKUP_TABLES.filter((t) => !(t in tables));
  if (missing.length) notes.push(`left untouched (absent from the backup): ${missing.join(', ')}`);

  const report = store.restoreBackup(tables);
  if (replacedUsers) {
    const dropped = store.deleteAllUiSessions();
    notes.push(
      `replaced ${usable.length} dashboard user${usable.length === 1 ? '' : 's'} and signed out ` +
      `${dropped} browser session${dropped === 1 ? '' : 's'} — everyone signs in against the restored accounts`
    );
  }

  return {
    report,
    notes,
    replaced_users: replacedUsers,
    rows: Object.values(report).reduce((n, r) => n + (r.inserted ?? 0), 0),
  };
}

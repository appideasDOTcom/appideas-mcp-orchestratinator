import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BACKUP_TABLES, CAST, humanName } from './db.js';

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
 * What it deliberately does NOT contain: the shared MCP secret. See
 * `describeAuth`. Everything else in the file is board data — there are no
 * dashboard accounts to carry, because there is no dashboard sign-in.
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
 * Names a legacy backup kept on desks, worth carrying into the profile.
 *
 * Before names were global, `personas` had a `persona` column per (channel,
 * agent). A file from then restores through the generic path with that column
 * skipped — the live table no longer has it — which would silently drop every
 * name an operator chose. Migrations never run against a file, only against a
 * live database, so applyBackup has to do here what migratePersonas did there,
 * and by the same rules: a cast name and a derived default are not choices, and
 * where two desks named one agent differently the most recent choice stands.
 */
function legacyNamesIn(personas) {
  if (!Array.isArray(personas)) return [];
  const cast = new Set(CAST);
  const chosen = new Map();
  for (const r of personas) {
    if (typeof r?.persona !== 'string' || !r.persona) continue;
    if (cast.has(r.persona) || r.persona === humanName(r.agent)) continue;
    const prev = chosen.get(r.agent);
    if (!prev || String(r.assigned_at ?? '') >= String(prev.assigned_at ?? '')) chosen.set(r.agent, r);
  }
  return [...chosen.values()].map((r) => ({ agent: r.agent, persona: r.persona }));
}

/**
 * Load a validated backup over the top of the current board.
 *
 * Only the tables in BACKUP_TABLES are written; anything else in the file is
 * ignored rather than fatal, which is what lets a file written by a different
 * build still load. The case worth naming is a backup taken before dashboard
 * sign-in was removed: those carry a `users` table of scrypt hashes for a
 * feature that no longer exists, and silently dropping them on the floor would
 * leave someone wondering where their accounts went. Say it instead.
 */
export function applyBackup({ store, doc }) {
  const tables = {};
  for (const t of BACKUP_TABLES) if (Array.isArray(doc.tables[t])) tables[t] = doc.tables[t];

  const notes = [];
  const staleUsers = Array.isArray(doc.tables.users) ? doc.tables.users.length : 0;
  if (staleUsers) {
    notes.push(
      `ignored ${staleUsers} dashboard account${staleUsers === 1 ? '' : 's'} in the backup — ` +
      'this server has no sign-in, so the board is open to anyone who can reach it'
    );
  }

  const missing = BACKUP_TABLES.filter((t) => !(t in tables));
  if (missing.length) notes.push(`left untouched (absent from the backup): ${missing.join(', ')}`);

  const report = store.restoreBackup(tables);

  // After the restore, not inside it: the file's own tables land whole either
  // way, and a fault here must read as a note on a finished restore, never as
  // a reason to roll one back.
  const legacy = legacyNamesIn(doc.tables.personas);
  if (legacy.length) {
    try {
      const { adopted, kept } = store.adoptNames(legacy);
      if (adopted) {
        notes.push(
          `adopted ${adopted} agent name${adopted === 1 ? '' : 's'} from the backup's personas table — ` +
          'this file is from before names were global'
        );
      }
      if (kept) {
        notes.push(
          `kept this board's name for ${kept} agent${kept === 1 ? '' : 's'} the backup names differently — ` +
          'a name already here wins over a per-desk one from the file'
        );
      }
    } catch (e) {
      notes.push(`could not carry the backup's per-desk agent names over: ${String(e.message ?? e)}`);
    }
  }

  return {
    report,
    notes,
    rows: Object.values(report).reduce((n, r) => n + (r.inserted ?? 0), 0),
  };
}

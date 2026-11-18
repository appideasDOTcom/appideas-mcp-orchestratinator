/**
 * Files attached to a message on the floor, held here only until a host takes
 * them (issue #31).
 *
 * The board is not where an attachment lives. A window reads from its own
 * machine's disk, and the board may be a container on another computer, so
 * "upload" is three hops: the page sends the bytes here the moment a file is
 * attached (so the chip can say it is ready before Send), the message names
 * the staged ids, and the desk's host fetches each one, writes it under its
 * own `~/.orchestratinator/uploads` (outside every repo, so nothing lands in
 * a working tree) and names that path in what it types. The host owns the
 * file's lifetime from then on (host/uploads.js).
 *
 * So what is kept here is short-lived on purpose: `ttlMs` (an hour) after the
 * file was attached or last sent. Not deleted when a host fetches it, because
 * a meeting room sends one attachment to several desks, which may be on
 * several hosts, and because a message whose delivery fails hands its files
 * back to the box to be sent again. An attachment removed from the box is
 * discarded at once.
 *
 * A host may fetch only what a message to one of its desks named (`grant`).
 * Every host holds the same key, so this is not a lock against a hostile
 * host; it keeps a bug in one host from reading what was sent to another.
 *
 * Never served back to a browser. The page draws its thumbnails from the File
 * it already holds, so bytes from the operator's clipboard never become a
 * page on this origin.
 */
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve as absolute } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

/** costmo, 2026-11-17: 100 MB a file, twenty files a message. */
export const UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
export const UPLOAD_MAX_FILES = 20;
/** How long a staged file waits for a host, from attach or last send. */
export const UPLOAD_TTL_MS = 60 * 60 * 1000;

const ID_RE = /^[a-z0-9]{8,40}$/;

/**
 * A name safe to write on any of the hosts' disks and to type into a window:
 * no directory parts, no control characters (a newline would split the line
 * the host types the path on), nothing that starts with a dot, and short
 * enough for every filesystem. What is left is the operator's own name for
 * the file, which is what the agent should see.
 */
export function safeName(name) {
  let s = String(name ?? '').normalize('NFC');
  s = s.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[.\s]+/, '');
  if (s.length > 120) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 12 ? s.slice(dot) : '';
    s = s.slice(0, 120 - ext.length) + ext;
  }
  return s || 'file';
}

/** A media type as the page reported it, or the neutral one. Only ever shown. */
const safeType = (t) => (typeof t === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(t) ? t.toLowerCase() : 'application/octet-stream');

export function createUploads({ dir: given, ttlMs = UPLOAD_TTL_MS, maxBytes = UPLOAD_MAX_BYTES, maxFiles = UPLOAD_MAX_FILES } = {}) {
  // Absolute, because the host's route serves it with sendFile, which takes
  // no other kind; DB_PATH, and so this, is relative on a bare board.
  // Made on the first upload, not here: every suite starts a bare board
  // beside its database, and a folder for each would be left in data/.
  const dir = absolute(given);
  const metaPath = (id) => join(dir, `${id}.json`);
  const dataPath = (id) => join(dir, id);
  const read = (id) => {
    if (!ID_RE.test(String(id ?? ''))) return null;
    try { return JSON.parse(readFileSync(metaPath(id), 'utf8')); } catch { return null; }
  };
  const write = (m) => writeFileSync(metaPath(m.id), JSON.stringify(m));
  const drop = (id) => {
    for (const p of [dataPath(id), metaPath(id), `${dataPath(id)}.part`]) rmSync(p, { force: true });
  };

  /**
   * Take the request's body as one file. Streamed to disk and counted on the
   * way, so a 100 MB attachment is never held in the board's memory (the
   * board shares Docker's VM with everything else; issue #5), and one over
   * the cap is cut off at the cap rather than read to the end.
   */
  async function stage(req, { name, type }) {
    mkdirSync(dir, { recursive: true });
    const id = randomBytes(12).toString('hex');
    const part = `${dataPath(id)}.part`;
    let size = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) return cb(Object.assign(new Error('too large'), { code: 'too_large' }));
        cb(null, chunk);
      },
    });
    try {
      await pipeline(req, counter, createWriteStream(part));
    } catch (err) {
      rmSync(part, { force: true });
      if (err.code === 'too_large') return { error: `larger than ${Math.round(maxBytes / 1048576)} MB`, code: 'too_large', status: 413 };
      return { error: `the upload did not finish (${err.message})`, code: 'aborted', status: 400 };
    }
    renameSync(part, dataPath(id));
    const now = Date.now();
    const m = { id, name: safeName(name), type: safeType(type), size, at: now, used: now, hosts: [] };
    write(m);
    return { file: view(m) };
  }

  const view = (m) => ({ id: m.id, name: m.name, type: m.type, size: m.size });

  /**
   * The files a message names, in its order, or why it cannot carry them.
   * Every id must still be here: a file that expired between attach and Send
   * is said by name, not dropped from the message without a word.
   */
  function resolve(ids) {
    if (ids == null) return { files: [] };
    if (!Array.isArray(ids)) return { error: 'files must be a list of upload ids', code: 'bad_files' };
    const uniq = [...new Set(ids.map(String))];
    if (uniq.length > maxFiles) return { error: `at most ${maxFiles} files a message`, code: 'too_many_files' };
    const files = [];
    for (const id of uniq) {
      const m = read(id);
      if (!m || !existsSync(dataPath(id))) {
        return { error: 'An attachment is no longer on the board (attachments wait an hour). Remove it and attach the file again.', code: 'upload_gone', id };
      }
      files.push(m);
    }
    return { files: files.map(view) };
  }

  /** Let this host fetch these files, and keep them another `ttlMs`. */
  function grant(ids, hostId) {
    const now = Date.now();
    for (const id of ids) {
      const m = read(id);
      if (!m) continue;
      if (!m.hosts.includes(hostId)) m.hosts.push(hostId);
      m.used = now;
      write(m);
    }
  }

  /** The file a host asked for: its path and size, if that host was granted it. */
  function forHost(id, hostId) {
    const m = read(id);
    if (!m || !existsSync(dataPath(id))) return { error: 'no such upload (it may have expired)', status: 404 };
    if (!m.hosts.includes(hostId)) return { error: 'that upload was not sent to a desk on this host', status: 403 };
    return { path: dataPath(id), size: statSync(dataPath(id)).size, meta: view(m) };
  }

  function discard(ids) {
    let n = 0;
    for (const id of Array.isArray(ids) ? ids : []) {
      if (read(id)) { drop(id); n++; }
    }
    return n;
  }

  /** Remove everything past its hour, and any half-written part older than that. */
  function sweep(nowMs = Date.now()) {
    let n = 0;
    let names = [];
    try { names = readdirSync(dir); } catch { return 0; }
    for (const f of names) {
      if (f.endsWith('.json')) {
        const id = f.slice(0, -5);
        const m = read(id);
        if (!m || nowMs - (m.used ?? m.at ?? 0) > ttlMs) { drop(id); n++; }
      } else if (f.endsWith('.part')) {
        try { if (nowMs - statSync(join(dir, f)).mtimeMs > ttlMs) { rmSync(join(dir, f), { force: true }); n++; } } catch { /* gone */ }
      } else if (ID_RE.test(f) && !existsSync(metaPath(f))) {
        rmSync(join(dir, f), { force: true });
        n++;
      }
    }
    return n;
  }

  return { dir, maxBytes, maxFiles, ttlMs, stage, resolve, grant, forHost, discard, sweep };
}

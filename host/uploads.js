/**
 * A message's attachments, on this machine (issue #31).
 *
 * The board stages a file for an hour and no longer (src/uploads.js). A
 * window reads from this machine's disk, so the host fetches each file a
 * message names, writes it here and types its path into the message. Three
 * decisions behind that, each costmo's or measured:
 *
 *   - **Outside every repo.** `~/.orchestratinator/uploads/<id>/<name>`,
 *     beside host.json. Inside the desk's folder an attachment would be a
 *     change in somebody's working tree. Outside it, the measured question
 *     was whether a window may read it: on Claude Code 2.1.326, a window in
 *     manual mode read a file here and a PNG beside it with the Read tool and
 *     raised no permission prompt (probe, 2026-11-17). Where a machine's
 *     settings do ask, the prompt is an ordinary one, drawn on the floor and
 *     answered there like any other.
 *   - **The path is named, not pasted as an image.** A message is typed into
 *     the window, and an image path inside a typed or pasted message stays
 *     text (the same probe). The agent reads the file when it wants it, which
 *     is also what lets a 100 MB log be attached without filling the context.
 *   - **It lives as long as Claude Code keeps the transcript that names it**
 *     (costmo, 2026-11-17). `cleanupPeriodDays` in Claude Code's own
 *     settings, 30 days when unset, is how long Claude Code keeps a
 *     conversation and its pasted text; past it the conversation is gone
 *     from disk anyway. Read at each sweep, so a change to the setting
 *     applies without a restart. Never less than a day: Claude Code reads 0
 *     as "keep nothing", and a file deleted before its message is read would
 *     be a message about nothing. A file sent again is kept from that send.
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_RETENTION_DAYS = 30;
/** How long one file may take to arrive from the board. 100 MB on a LAN is seconds. */
const FETCH_TIMEOUT_MS = Number(process.env.ORCH_UPLOAD_FETCH_MS ?? 120_000);

/**
 * The line that opens the list, and that the page reads a message's
 * attachments by (`splitAttached` in src/ui/floor.js; test/floor.mjs holds
 * the two to one spelling). Words an operator would not type as the last
 * paragraph of a message, and that tell the agent what the paths are.
 */
export const ATTACHED_HEADER = 'Attached from the floor:';

/** Where attachments are kept: beside host.json, or where a suite says. */
export function uploadsDir() {
  return process.env.ORCH_HOST_UPLOADS
    ?? join(dirname(process.env.ORCH_HOST_CONFIG ?? join(homedir(), '.orchestratinator', 'host.json')), 'uploads');
}

/** Claude Code's settings file: the one whose cleanupPeriodDays the files follow. */
function claudeSettings() {
  const home = process.env.ORCH_CLAUDE_HOME ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  return join(home, 'settings.json');
}

/** Days an attachment is kept: Claude Code's cleanupPeriodDays, 30 when unset, at least 1. */
export function retentionDays(settingsPath = claudeSettings()) {
  let v;
  try { v = JSON.parse(readFileSync(settingsPath, 'utf8'))?.cleanupPeriodDays; } catch { v = undefined; }
  const n = Number(v);
  if (v === undefined || v === null || !Number.isFinite(n)) return DEFAULT_RETENTION_DAYS;
  return Math.max(1, n);
}

/**
 * The message as typed: the operator's words, then the list. One path a
 * line, so a name with spaces in it is still one path, and nothing on a line
 * but the path after its dash.
 */
export function withAttachments(text, paths) {
  if (!paths?.length) return text ?? '';
  const list = [ATTACHED_HEADER, ...paths.map((p) => `- ${p}`)].join('\n');
  const words = String(text ?? '').trim();
  return words ? `${words}\n\n${list}` : list;
}

const ID_RE = /^[a-z0-9]{8,40}$/;

/**
 * Fetch one staged file into `<dir>/<id>/<name>` and return its path. A file
 * already here under that id (a meeting room sent it to two desks on this
 * host, or the message is being sent again) is not fetched twice; its
 * lifetime starts again from now.
 *
 * Written to a `.part` and renamed, so a fetch cut off halfway never leaves
 * a file the agent could be told about.
 */
export async function fetchUpload({ url, token, hostId, file, dir = uploadsDir() }) {
  const id = String(file?.id ?? '');
  if (!ID_RE.test(id)) throw new Error('an attachment with no id');
  const name = String(file?.name ?? '').replace(/[\\/]/g, ' ').replace(/^\.+/, '').trim() || 'file';
  const home = join(dir, id);
  const path = join(home, name);
  if (existsSync(path)) {
    const now = new Date();
    try { utimesSync(home, now, now); } catch { /* still there; kept by its old time */ }
    return path;
  }
  mkdirSync(home, { recursive: true });
  const part = `${path}.part`;
  let res;
  try {
    res = await fetch(`${url}/api/host/upload?host_id=${encodeURIComponent(hostId)}&id=${encodeURIComponent(id)}`, {
      headers: { 'x-orchestratinator-key': token ?? '' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`could not reach the board for ${name} (${err.cause?.code ?? err.name ?? err.message})`);
  }
  if (!res.ok) {
    const why = await res.json().then((b) => b?.error).catch(() => null);
    throw new Error(`the board would not give ${name}: ${why ?? res.status}`);
  }
  try {
    await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
  } catch (err) {
    rmSync(part, { force: true });
    throw new Error(`${name} did not arrive whole (${err.message})`);
  }
  const want = Number(res.headers.get('content-length'));
  const got = statSync(part).size;
  if (Number.isFinite(want) && got !== want) {
    rmSync(part, { force: true });
    throw new Error(`${name} arrived short (${got} of ${want} bytes)`);
  }
  renameSync(part, path);
  return path;
}

/**
 * Remove every attachment older than the retention, by its folder's time
 * (set when it was written, and again whenever it is sent again). Returns how
 * many went. Cheap enough for every heartbeat: one readdir and a stat each.
 */
export function sweepUploads({ dir = uploadsDir(), days = retentionDays(), nowMs = Date.now() } = {}) {
  let names;
  try { names = readdirSync(dir); } catch { return 0; }
  let n = 0;
  for (const f of names) {
    if (!ID_RE.test(f)) continue;
    const p = join(dir, f);
    try {
      if (nowMs - statSync(p).mtimeMs > days * DAY_MS) { rmSync(p, { recursive: true, force: true }); n++; }
    } catch { /* gone already */ }
  }
  return n;
}

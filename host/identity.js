import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { projectDir } from './window.js';

/**
 * Find the repos on this machine that belong to an orchestratinator, and which
 * desk each one is.
 *
 * A directory is a desk when a Claude Code MCP entry for it carries `X-Channel`
 * and `X-Agent` — the two headers a repo already sends to reach the board.
 * There are two places such an entry can live, and both are read, in Claude
 * Code's own order of precedence:
 *
 *   - local scope: `~/.claude.json` → `projects["<dir>"].mcpServers`, which is
 *     what `claude mcp add -s local` writes. It is what the floor binds a desk
 *     with — it raises no approval dialog and keeps the key out of the repo
 *     tree (docs/desk-from-the-floor.md, measured 2026-09-08/09);
 *   - project scope: `<dir>/.mcp.json`, the hand-written bootstrap.
 *
 * When both name a desk for one directory the local one wins, because that is
 * the entry Claude Code connects with — measured: `whoami` in such a window
 * answers the local identity, whatever the file says. The plugin hook applies
 * the same rule in its `findIdentity`; the two cannot share code (the plugin
 * runs from a cached copy), so a change here is a change there.
 *
 * Nothing is configured twice, and a directory that never opted into the board
 * cannot be hosted by accident.
 */

// `data` is here because this project's own tests write throwaway repos into
// it, each with a real `.mcp.json`. Now that the walk no longer stops at the
// first desk it finds, a host running during a test run would otherwise
// register those fixtures as desks on somebody's actual board.
const SKIP = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', '.cache', 'Library', 'data']);

/** Case-insensitive, because a header name in hand-written JSON is whatever the
 *  person typing it felt like that day, and both spellings work over HTTP. */
export function header(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want && typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** The orchestratinator entry in a set of MCP servers, as a desk, or null. The
 *  signature is the pair of headers, never the entry's name. */
function deskIn(servers, dir, extra) {
  for (const s of Object.values(servers && typeof servers === 'object' ? servers : {})) {
    const channel = header(s?.headers, 'X-Channel');
    const agent = header(s?.headers, 'X-Agent');
    if (channel && agent && typeof s?.url === 'string') {
      return { channel, agent, cwd: dir, url: s.url, key: header(s.headers, 'X-Orchestratinator-Key'), ...extra };
    }
  }
  return null;
}

/** Where Claude Code keeps the file local scope lives in. `CLAUDE_CONFIG_DIR`
 *  moves the whole thing — measured 2026-09-09: with it set, `claude mcp add`
 *  writes `<dir>/.claude.json` and leaves the real `~/.claude.json` untouched,
 *  so a host reading only the home file would see no desk on such a machine. */
export function claudeConfigPath() {
  return join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json');
}

/** The resolved spelling of a path, or the path itself when it has none.
 *  Claude Code keys `projects` by the resolved path (measured: a cwd of
 *  `/tmp/x` is filed under `/private/tmp/x`), and a root can be given either
 *  way, so every lookup tries both. */
function real(dir) {
  try { return realpathSync(dir); } catch { return dir; }
}

/**
 * Every local-scope desk on this machine, keyed by directory, plus which
 * directories Claude Code has been told to trust (the folder-trust question a
 * fresh window asks — surfaced on the floor, never pressed here).
 *
 * Read once per walk rather than once per directory: the file is ~150 KB on a
 * working machine and Claude Code rewrites it constantly. A read that lands
 * mid-rewrite — or a file that is absent, or hand-edited into nonsense —
 * yields an empty map with `ok: false`, and the walk carries on with
 * `.mcp.json` alone: the desks it found before local scope existed, never
 * half of something.
 */
export function readLocalScope(file = claudeConfigPath()) {
  const desks = new Map();
  const trusted = new Map();
  let projects;
  try {
    projects = JSON.parse(readFileSync(file, 'utf8'))?.projects;
  } catch {
    return { ok: false, desks, trusted };
  }
  if (!projects || typeof projects !== 'object') return { ok: true, desks, trusted };
  for (const [dir, p] of Object.entries(projects)) {
    if (!p || typeof p !== 'object') continue;
    const trust = p.hasTrustDialogAccepted === true;
    trusted.set(dir, trust);
    const desk = deskIn(p.mcpServers, dir, { scope: 'local', trusted: trust });
    if (desk) desks.set(dir, desk);
  }
  return { ok: true, desks, trusted };
}

/**
 * The desk a directory is bound as, or null: its local-scope entry first, then
 * its `.mcp.json`. `local` is a `readLocalScope()` result — pass one in to read
 * the file once for a whole walk.
 */
export function readDesk(dir, local = readLocalScope()) {
  const mine = local.desks.get(dir) ?? local.desks.get(real(dir));
  if (mine) return { ...mine, cwd: dir };
  const file = join(dir, '.mcp.json');
  if (!existsSync(file)) return null;
  try {
    const desk = deskIn(JSON.parse(readFileSync(file, 'utf8'))?.mcpServers, dir, { scope: 'project' });
    if (!desk) return null;
    desk.trusted = local.trusted.get(dir) ?? local.trusted.get(real(dir)) ?? false;
    return desk;
  } catch {
    // A malformed .mcp.json is already breaking this repo's MCP connection and
    // its owner will hear about it from somewhere that can actually help.
    return null;
  }
}

/** Whether a directory's `.mcp.json` carries an orchestratinator entry for
 *  any board at all — the file the README's step 3 has people write. */
function hasMcpEntry(dir) {
  const file = join(dir, '.mcp.json');
  if (!existsSync(file)) return false;
  try { return !!deskIn(JSON.parse(readFileSync(file, 'utf8'))?.mcpServers, dir, {}); } catch { return false; }
}

/** What Claude Code's own project directory says about a folder: how many
 *  sessions have been run there and when the newest transcript was last
 *  written to. Absent for a folder Claude Code has never opened. */
function activityOf(dir) {
  let sessions = 0;
  let last = 0;
  const pdir = projectDir(dir);
  let entries;
  try { entries = readdirSync(pdir, { withFileTypes: true }); } catch { return { opened: false, sessions, last_active: null }; }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    sessions++;
    try { last = Math.max(last, statSync(join(pdir, e.name)).mtimeMs); } catch { /* being written */ }
  }
  return { opened: true, sessions, last_active: last ? new Date(last).toISOString() : null };
}

/**
 * One folder as the floor draws it: what it is bound as and from which file,
 * whether a `.mcp.json` entry exists to import, whether Claude Code trusts it
 * yet (a fresh window asks otherwise, on the desk), whether it is a git
 * checkout, and when it was last worked in. One shape for the candidate walk
 * and for the picker, so the two can never describe a folder differently.
 */
function folderRecord(dir, depth, desk, local) {
  const act = activityOf(dir);
  return {
    path: dir,
    name: basename(dir),
    depth,
    bound: desk ? { channel: desk.channel, agent: desk.agent, scope: desk.scope, board: originOf(desk.url) } : null,
    has_mcp_json: hasMcpEntry(dir),
    trusted: desk?.trusted ?? local.trusted.get(dir) ?? local.trusted.get(real(dir)) ?? false,
    git: existsSync(join(dir, '.git')),
    opened: act.opened,
    last_active: act.last_active,
    sessions: act.sessions,
  };
}

/** The most folders a host will ever offer. The list is for a person picking
 *  one from a dialog, and past a few hundred it is a search, not a list. */
export const FOLDER_CAP = 300;

const isUnder = (path, root) => path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);

/**
 * Walk each root for desks, and for the folders that could become one.
 *
 * Shallow on purpose: repos live a few levels under a projects directory, and
 * a host that crawls a home directory looking for them is a host people turn
 * off. Every directory reached is checked for a binding; it is *offered* as a
 * folder only when something says a person might mean it — it sits directly
 * under a root, it is a git checkout, Claude Code has opened it before, or it
 * is bound already. Everything else is walked through in silence.
 *
 * Each folder says what the floor's "take a desk" dialog needs to draw its
 * row and its confirmation: what it is bound as and from which file, whether a
 * `.mcp.json` entry exists to import, whether Claude Code trusts it yet (a
 * fresh window asks otherwise, on the desk), and when it was last worked in —
 * which is what sorts the list, newest first, so "recently opened" is the top
 * of it rather than a feature of its own.
 */
export function discover(roots, { maxDepth = 4, local = readLocalScope() } = {}) {
  const desks = new Map();
  const folders = [];
  const offered = new Set();
  const offer = (dir, depth, desk) => {
    if (offered.has(dir)) return;
    const rec = folderRecord(dir, depth, desk, local);
    if (!(depth === 1 || rec.git || rec.opened || desk)) return;
    offered.add(dir);
    folders.push(rec);
  };
  const walk = (dir, depth) => {
    const desk = readDesk(dir, local);
    if (desk) desks.set(`${desk.channel}|${desk.agent}`, desk);
    offer(dir, depth, desk);
    // Keep going even after finding one. Desks nest: a workspace directory can
    // be a desk in its own right and still contain the plugin repos that are
    // desks too. Stopping here — which this used to do, on the reasoning that a
    // desk's subdirectories are its own files — made every one of those nested
    // desks invisible, so a host would report a single desk and look broken.
    if (depth >= maxDepth) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name) || (e.name.startsWith('.') && e.name !== '.')) continue;
      const path = join(dir, e.name);
      try { if (statSync(path).isDirectory()) walk(path, depth + 1); } catch { /* skip */ }
    }
  };
  const under = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    under.push(real(root));
    walk(root, 0);
  }
  // A local-scope desk the walk could not reach — deeper than maxDepth, or
  // inside a directory the walk skips — is still a desk Claude Code can see.
  // The walk is shallow so that a host does not crawl a home directory, but a
  // binding written by hand or from the floor is an explicit act, and it is
  // taken up wherever it sits, as long as that is under a root: the roots are
  // the fence on what this host will ever run.
  for (const [dir, desk] of local.desks) {
    const k = `${desk.channel}|${desk.agent}`;
    if (desks.has(k) || !existsSync(dir)) continue;
    const here = real(dir);
    const root = under.find((r) => isUnder(here, r));
    if (!root) continue;
    desks.set(k, desk);
    offer(dir, here.slice(root.length).split('/').filter(Boolean).length, desk);
  }
  // Newest first, never-opened last, then by name — the order a person
  // looking for "the one I was just in" wants, and a stable one otherwise.
  folders.sort((a, b) => {
    if (a.last_active !== b.last_active) return a.last_active ? (b.last_active ? b.last_active.localeCompare(a.last_active) : -1) : 1;
    return a.name.localeCompare(b.name);
  });
  return { desks: [...desks.values()], folders: folders.slice(0, FOLDER_CAP) };
}

/** The desks alone. */
export function discoverDesks(roots, opts) {
  return discover(roots, opts).desks;
}

/**
 * One folder and the folders inside it — the picker's view.
 *
 * A person taking a desk thinks "my agent lives in this directory": they open
 * folders until they are standing in it. So this lists one level at a time,
 * from a root down, the way a file picker does, and the walk above is not
 * used for it: a flat list of every folder that might be a desk, shown by
 * its last path segment, was 95 names from nowhere on the first machine it
 * ran on (2026-09-10). Dotfolders and node_modules are not shown; everything
 * else is, because a folder called `build` or `data` can be somebody's
 * project. The roots are the fence, here as everywhere: a folder outside
 * them is refused, not listed.
 */
export function listFolder(dir, roots, { local = readLocalScope() } = {}) {
  const here = real(dir);
  const under = roots.filter((r) => existsSync(r)).map(real);
  const root = under.find((r) => isUnder(here, r));
  if (!root) return { ok: false, error: `${dir} is not under this host's roots (${roots.join(', ')})` };
  const depthOf = (p) => p.slice(root.length).split('/').filter(Boolean).length;
  const record = (p) => folderRecord(p, depthOf(p), readDesk(p, local), local);
  let entries;
  try { entries = readdirSync(here, { withFileTypes: true }); } catch (err) { return { ok: false, error: `${dir} could not be read: ${err.message}` }; }
  const children = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
    children.push(record(join(here, e.name)));
  }
  children.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return { ok: true, path: here, root, parent: here === root ? null : dirname(here), self: record(here), entries: children };
}

/** The origin a desk's board lives on, for matching desks to this host's server. */
export function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

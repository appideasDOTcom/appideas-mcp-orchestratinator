import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
function header(headers, name) {
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

/**
 * Walk each root for desks. Shallow on purpose: repos live a few levels under
 * a projects directory, and a host that crawls a home directory looking for
 * them is a host people turn off.
 */
export function discoverDesks(roots, { maxDepth = 4, local = readLocalScope() } = {}) {
  const found = new Map();
  const walk = (dir, depth) => {
    const desk = readDesk(dir, local);
    if (desk) found.set(`${desk.channel}|${desk.agent}`, desk);
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
    if (found.has(k) || !existsSync(dir)) continue;
    const here = real(dir);
    if (under.some((r) => here === r || here.startsWith(r.endsWith('/') ? r : `${r}/`))) found.set(k, desk);
  }
  return [...found.values()];
}

/** The origin a desk's board lives on, for matching desks to this host's server. */
export function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

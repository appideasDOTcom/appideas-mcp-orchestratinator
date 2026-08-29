import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Find the repos on this machine that belong to an orchestratinator, and which
 * desk each one is.
 *
 * The same rule the workstation plugin uses: a directory is a desk if its
 * `.mcp.json` declares `X-Channel` and `X-Agent` — the two headers a repo
 * already carries to reach the board. Nothing is configured twice, and a
 * directory that never opted into the board cannot be hosted by accident.
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

/** The desk a `.mcp.json` declares, or null if it declares none. */
export function readDesk(dir) {
  const file = join(dir, '.mcp.json');
  if (!existsSync(file)) return null;
  try {
    const servers = JSON.parse(readFileSync(file, 'utf8'))?.mcpServers ?? {};
    for (const s of Object.values(servers)) {
      const channel = header(s?.headers, 'X-Channel');
      const agent = header(s?.headers, 'X-Agent');
      if (channel && agent && typeof s?.url === 'string') {
        return { channel, agent, cwd: dir, url: s.url, key: header(s.headers, 'X-Orchestratinator-Key') };
      }
    }
  } catch {
    // A malformed .mcp.json is already breaking this repo's MCP connection and
    // its owner will hear about it from somewhere that can actually help.
  }
  return null;
}

/**
 * Walk each root for desks. Shallow on purpose: repos live a few levels under
 * a projects directory, and a host that crawls a home directory looking for
 * them is a host people turn off.
 */
export function discoverDesks(roots, { maxDepth = 4 } = {}) {
  const found = new Map();
  const walk = (dir, depth) => {
    const desk = readDesk(dir);
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
  for (const root of roots) {
    if (existsSync(root)) walk(root, 0);
  }
  return [...found.values()];
}

/** The origin a desk's board lives on, for matching desks to this host's server. */
export function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

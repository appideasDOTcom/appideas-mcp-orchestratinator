/**
 * The host's hands on Claude Code's own configuration: how a desk is bound
 * from the floor, and unbound again.
 *
 * A desk taken from the floor is bound in Claude Code's *local scope* —
 * `claude mcp add -s local`, which lands in ~/.claude.json keyed by directory
 * — never by writing a `.mcp.json` into the repo. Measured 2026-09-08/09
 * (docs/desk-from-the-floor.md): local scope raises no "New MCP server found"
 * dialog, a window resumed after a rebind carries on the same conversation,
 * and a VS Code chat in the folder follows the binding by itself. It also
 * keeps the key out of the repo tree, which a `.mcp.json` does not.
 *
 * Three rules, each the answer to a failure that was seen or measured:
 *
 *   - **Write only through the CLI.** ~/.claude.json is Claude Code's file,
 *     150 KB and rewritten constantly; a hand edit races it. `claude mcp add`
 *     and `claude mcp remove` are documented, non-interactive and sub-second.
 *   - **Never from inside a pane.** A tmux pane's environment is the tmux
 *     server's, not this process's (test/host.mjs, the flag-file note), so a
 *     CLI run there would write under the wrong HOME — under test, the
 *     operator's real file. Everything here is execFile from the host itself,
 *     with an explicit cwd, because local scope is keyed by cwd.
 *   - **The key is this host's own.** cfg.token, read from a desk's binding or
 *     given to the host at install; the board never sends one, so a page that
 *     can reach the port cannot hand a key to anyone.
 *
 * The one file in the repo this touches is `.mcp.json`, and only to *remove*
 * the orchestratinator entry for this board when a desk is imported or left —
 * a project entry left beside a local one keeps raising the approval dialog
 * on every fresh window (measured), so removing it is what makes the floor's
 * binding dialog-free. Other servers in the file are kept, and an entry that
 * points at another board is never touched.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { header, originOf } from './identity.js';
import { canonical } from './window.js';

const run = promisify(execFile);
const CLAUDE = process.env.ORCH_HOST_CLAUDE ?? 'claude';
/** A ceiling, not an estimate: `mcp add` and `mcp remove` measured at well
 *  under a second (2026-09-09). Sixty seconds is for a machine that is busy
 *  or a Claude Code that is updating itself on the way up. */
const MCP_CLI_TIMEOUT_MS = Number(process.env.ORCH_MCP_CLI_TIMEOUT_MS ?? 60_000);
/** The server name the binding is written under. The floor's hook and the
 *  host find a desk by its headers, not this name, so it is a label. */
export const SERVER_NAME = 'orchestratinator';

/** The host's environment without any `CLAUDE*` variable: a host started from
 *  inside a Claude Code session (a test, an agent) would otherwise hand the
 *  CLI a nested-session environment. */
export function cliEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE')));
}

const lastLine = (s) => String(s ?? '').trim().split('\n').filter((l) => l.trim()).pop() ?? '';

async function cli(args, dir) {
  try {
    const { stdout } = await run(CLAUDE, args, {
      cwd: dir, env: cliEnv(), timeout: MCP_CLI_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out: lastLine(stdout) };
  } catch (e) {
    return {
      ok: false,
      code: typeof e.code === 'number' ? e.code : null,
      error: e.killed ? `timed out after ${MCP_CLI_TIMEOUT_MS / 1000}s` : (lastLine(e.stderr) || lastLine(e.stdout) || e.message),
    };
  }
}

/** Bind `dir` as (channel, agent) on `url`'s board, in local scope. */
export async function mcpAdd(dir, { url, channel, agent, key }) {
  const args = ['mcp', 'add', '-s', 'local', '--transport', 'http', SERVER_NAME, url, '-H', `X-Channel: ${channel}`, '-H', `X-Agent: ${agent}`];
  if (key) args.push('-H', `X-Orchestratinator-Key: ${key}`);
  const r = await cli(args, dir);
  return r.ok ? { ok: true } : { ok: false, error: `claude mcp add exited ${r.code ?? '?'} — ${r.error}` };
}

/** Remove `dir`'s local-scope binding. An absent one is not a failure: the
 *  CLI says `No MCP server named "…" in local scope` and exits 1 (measured),
 *  and the caller wanted it gone either way. */
export async function mcpRemove(dir) {
  const r = await cli(['mcp', 'remove', '-s', 'local', SERVER_NAME], dir);
  if (r.ok) return { ok: true, removed: true };
  if (/No MCP server named/i.test(r.error)) return { ok: true, removed: false };
  return { ok: false, error: `claude mcp remove exited ${r.code ?? '?'} — ${r.error}` };
}

/**
 * Take the orchestratinator entry for `origin`'s board out of `dir/.mcp.json`,
 * keeping every other server and the file's own indentation. Entries that
 * point at another board are left alone and named in `foreign`; a file that
 * cannot be read as JSON is left alone and refused, because a rewrite would
 * replace whatever the person meant with nothing.
 */
export function dropProjectEntry(dir, { origin, channel = null, agent = null } = {}) {
  const file = join(dir, '.mcp.json');
  if (!existsSync(file)) return { ok: true, removed: [], kept: [], foreign: [] };
  let raw;
  let json;
  try {
    raw = readFileSync(file, 'utf8');
    json = JSON.parse(raw);
  } catch (e) {
    return { ok: false, code: 'unreadable', error: `${file} could not be read as JSON — ${e.message}` };
  }
  const servers = json?.mcpServers;
  if (!servers || typeof servers !== 'object') return { ok: true, removed: [], kept: [], foreign: [] };
  const removed = [];
  const kept = [];
  const foreign = [];
  for (const [name, s] of Object.entries(servers)) {
    const ch = header(s?.headers, 'X-Channel');
    const ag = header(s?.headers, 'X-Agent');
    if (!(ch && ag && typeof s?.url === 'string')) { kept.push(name); continue; }
    const board = originOf(s.url);
    const ours = board === origin && (!channel || ch === channel) && (!agent || ag === agent);
    if (ours) removed.push(name);
    else { kept.push(name); foreign.push({ name, board, channel: ch, agent: ag }); }
  }
  if (removed.length) {
    for (const name of removed) delete servers[name];
    const indent = /^([ \t]+)"/m.exec(raw)?.[1] ?? '  ';
    writeFileSync(file, JSON.stringify(json, null, indent) + (raw.endsWith('\n') ? '\n' : ''));
  }
  return { ok: true, removed, kept, foreign };
}

/** The fence: is `dir` one of the roots, or under one? Both sides resolved,
 *  because a root can be given through a symlink and a path can arrive
 *  spelled either way. */
export function insideRoots(dir, roots) {
  const here = canonical(dir);
  return roots.map((r) => canonical(r)).some((r) => here === r || here.startsWith(r.endsWith('/') ? r : `${r}/`));
}

/**
 * Extra desks in a folder that is already somebody's desk: one agent with
 * several sessions at once, each on a floor of its own or in a meeting room
 * of its own (costmo, 2026-11-16).
 *
 * A folder's binding names one desk: Claude Code's local scope holds one
 * `orchestratinator` entry per directory (docs/desk-from-the-floor.md: "one
 * binding per directory per scope also means one agent per checkout"), and
 * every window started in the folder connects as that desk. So a second
 * session in the same folder cannot be a second binding. It is a window
 * started with a binding of its own:
 *
 *   claude --mcp-config <file>     the same server name, other headers
 *
 * Measured 2026-11-16 on 2.1.325, on a throwaway board and a tmux socket of
 * its own: a folder bound in local scope as ms-a/qa, one window started
 * plain and one with `--mcp-config` naming ms-b/qa under the same server
 * name. The board counted one MCP session on each floor and two in all, so
 * the file's entry replaces the folder's in that window and is not added
 * beside it. No approval dialog was drawn. Both windows wrote a roster file
 * with the same cwd, which is why a seat's window is told from the folder's
 * own by a tag on its tmux window and never by directory (window.js,
 * "which window").
 *
 * What a seat is, then: a record here that (channel, agent) is a desk at a
 * folder, and a file holding the binding its windows start with. Both are
 * the host's own, beside host.json, because nothing of Claude Code's has
 * anywhere to keep them. The file carries the board's key, as
 * `~/.claude.json` does for a desk bound in local scope and as host.json
 * does for the host; it is written mode 600 and rewritten whenever the key
 * or the board's address changes. The plugin hook reads the same file
 * (`ORCH_DESK_CONFIG` in the window's environment, set with tmux `-e`), so a
 * hook in a seat's window reports as the seat and not as the folder's desk.
 *
 * What a seat is not: a desk an editor can hold. A VS Code chat in the
 * folder loads the folder's binding and nothing can hand it another, so a
 * seat is the floor's window only and "Open in VS Code" is refused for one,
 * in words.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Where the seats are kept: beside host.json, or where a suite says. */
export function seatsDir() {
  return process.env.ORCH_HOST_SEATS
    ?? join(dirname(process.env.ORCH_HOST_CONFIG ?? join(homedir(), '.orchestratinator', 'host.json')), 'seats');
}

const registry = () => join(seatsDir(), 'seats.json');

/**
 * The tag a seat's tmux window carries (`@orch_seat`), and what a desk is
 * asked for by. Channel and agent, each percent-encoded, so the tag holds
 * neither the `|` that separates tmux's format fields nor anything a floor
 * named before names were checked could have put in it.
 */
export function seatTag(channel, agent) {
  return `${encodeURIComponent(channel)}/${encodeURIComponent(agent)}`;
}

/** The file a seat's windows are started with. A readable name for whoever
 *  lists the directory, and a hash of the tag so two tags never share one. */
export function configPath(tag) {
  const name = String(tag).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  const sum = createHash('sha1').update(String(tag)).digest('hex').slice(0, 8);
  return join(seatsDir(), `${name}.${sum}.mcp.json`);
}

/** Every seat on record. A file that is absent or cannot be read is no seats:
 *  the desks bound in Claude Code's own files are found without it. */
export function listSeats() {
  let rows;
  try { rows = JSON.parse(readFileSync(registry(), 'utf8'))?.seats; } catch { return []; }
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((s) => s && typeof s.channel === 'string' && typeof s.agent === 'string' && typeof s.cwd === 'string' && typeof s.board === 'string')
    .map((s) => ({ channel: s.channel, agent: s.agent, cwd: s.cwd, board: s.board, seat: seatTag(s.channel, s.agent) }));
}

function save(rows) {
  const dir = seatsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Written beside and renamed over, so a reader never meets half a file.
  const tmp = `${registry()}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ seats: rows.map(({ channel, agent, cwd, board }) => ({ channel, agent, cwd, board })) }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, registry());
}

/** Put a seat on record: (channel, agent) is a desk at `cwd`, on `board`
 *  (an origin). One seat per name on a board; naming it again moves it. */
export function addSeat({ channel, agent, cwd, board }) {
  const rows = listSeats().filter((s) => !(s.channel === channel && s.agent === agent && s.board === board));
  rows.push({ channel, agent, cwd, board });
  save(rows);
  return { channel, agent, cwd, board, seat: seatTag(channel, agent) };
}

/** Take a seat off the record, and its file with it. True if there was one. */
export function removeSeat(channel, agent, board) {
  const all = listSeats();
  const rows = all.filter((s) => !(s.channel === channel && s.agent === agent && (!board || s.board === board)));
  if (rows.length === all.length) return false;
  save(rows);
  try { rmSync(configPath(seatTag(channel, agent)), { force: true }); } catch { /* gone already */ }
  return true;
}

/**
 * Write the binding a seat's windows start with: the board's address and the
 * three headers, under the server name the folder's own binding uses, so it
 * takes that entry's place in the window (see the header). Written only
 * when it differs, because the host does this at every look at its desks.
 */
export function writeConfig(seat, { url, key, name = 'orchestratinator' }) {
  const file = configPath(seat.seat ?? seatTag(seat.channel, seat.agent));
  const headers = { 'X-Channel': seat.channel, 'X-Agent': seat.agent };
  if (key) headers['X-Orchestratinator-Key'] = key;
  const body = `${JSON.stringify({ mcpServers: { [name]: { type: 'http', url, headers } } }, null, 2)}\n`;
  let have = null;
  try { have = readFileSync(file, 'utf8'); } catch { /* not written yet */ }
  if (have !== body) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, body, { mode: 0o600 });
    // An existing file keeps its mode through writeFileSync; say it again.
    try { chmodSync(file, 0o600); } catch { /* not ours to change */ }
  }
  return file;
}

/** Whether a seat's file is there to start a window with. */
export function hasConfig(tag) {
  return existsSync(configPath(tag));
}

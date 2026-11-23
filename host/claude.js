/**
 * What the host reads of Claude Code on this machine, and the two apps it
 * hands a conversation to. Since 2026-11-22 (costmo's ruling) a desk's Claude
 * Code is a process the host runs and speaks to as data (host/agent.js,
 * host/desk.js); nothing here reads a screen or types into one. What is left
 * from the window layer is what never depended on a screen:
 *
 *   - the roster: `~/.claude/sessions/<pid>.json`, every live session's pid,
 *     cwd and id (`claude agents --json` as the fallback), which is how the
 *     host knows a conversation is open in another app;
 *   - the transcripts: `~/.claude/projects/<slug>/<session>.jsonl` and each
 *     subagent's file beside it, which the relay tails (readTranscript) and
 *     the picker and History read (sessionsIn, resumable);
 *   - the environment a desk's Claude Code is started in (windowEnv), and
 *     the shell it is started through (shellFor);
 *   - the handoffs: VS Code (openInEditor) and a terminal (openInTerminal).
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { readDesk } from './identity.js';
import { configPath } from './seats.js';
import { log, warn } from './log.js';

const run = promisify(execFile);

/**
 * The board's key as this host holds it, for a window that cannot fill its
 * own. Set by index.js whenever the host settles on a key (useKey).
 *
 * A repo whose `.mcp.json` key is `${ORCH_AUTH_TOKEN}` works in the operator's
 * terminal because their shell exports it. A window the host opens has the
 * tmux server's environment instead, and when the host started that server
 * it is the LaunchAgent's `PATH` + `HOME`: measured by QA on PR #52, 0 of 2
 * panes carried the variable, even from a client that exported it. So Claude
 * Code sent the literal placeholder, the hook sent no key, and an enforcing
 * board refused both, for every placeholder desk opened from the floor.
 * costmo's ruling (PR #52, 2026-11-06): the pane is given that one variable,
 * set to the host's key, and nothing is written to disk. Only for a desk whose
 * key names a variable (`keyVar`, identity.js) — a literal key needs
 * nothing. Since 0.14.4 that is every such desk, not only one whose variable
 * the host could not fill: a window gets nothing of the host's own settings
 * (windowEnv, below), so "the host filled it, so the tmux server has it" no
 * longer holds. The value is what the host made of the placeholder, which is
 * what the window would make of it in the host's environment, else the key
 * the host settled on.
 */
let boardKey = null;
export function useKey(key) { boardKey = key || null; }

/** tmux `-e` arguments for a window opened in this desk's folder, or none.
 *  `-e` rather than the `env` the command line already runs through: an
 *  argument to `env` is part of the pane's start command, which tmux keeps
 *  and prints (`#{pane_start_command}`, choose-tree), so the key would be on
 *  every listing of the session. `-e` is the window's environment and
 *  nothing else (tmux 3.0 and later). */
export function paneEnv(desk, key = boardKey) {
  const value = desk?.key || key;
  return desk?.keyVar && value ? ['-e', `${desk.keyVar}=${value}`] : [];
}

/**
 * tmux escapes whatever it thinks the terminal cannot print, so a directory
 * with a character outside ASCII comes back as octal escapes unless the locale
 * says UTF-8 — and under launchd there is no locale at all. Take the person's
 * if they have one; otherwise say UTF-8, because a repo's name is not ours to
 * mangle.
 */
/** The markers a Claude Code session sets for its children; see windowEnv. */
export const PARENT_SESSION = new Set([
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_CHILD_NOTES_DIR',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SSE_PORT',
]);
/**
 * The environment tmux is run with, which is what a tmux server this host
 * starts keeps, and so what every window opened on it gets: a person's
 * environment, and nothing of the host's own settings (0.14.4; decided
 * 2026-11-20, costmo having handed the call over, recorded in CLAUDE.md, "The
 * clear of 2026-11-20", and contract `orchestratinator.consumed`,
 * `host.windows_inherit`).
 *
 * - **No `ORCH_` variable.** Those are how a host is configured, and the
 *   desktop app configures its host by environment. Handed down, every
 *   window carried the app's board address, its key, its host id and
 *   `ORCH_HOST_SUPERVISOR=app`, so a board, a host or a suite started by
 *   hand in an agent's window silently became the app's (measured that day:
 *   a host suite run from such a window read one red, the host meant to
 *   have no key having the app's). The one thing of them a window needs,
 *   the key its binding names as a variable, it is given by `-e` (paneEnv),
 *   and a seat's window its four by `-e` too (seatEnv). The suites reach
 *   their stand-ins by flag files, for the same reason, so nothing rides on
 *   this.
 * - **`TMPDIR` filled when missing**, on macOS the person's own (`getconf
 *   DARWIN_USER_TEMP_DIR`). A window the app's host opened had none, so
 *   everything in it wrote to `/tmp`. Elsewhere it is left alone.
 * - **`USER` and `LOGNAME` filled when missing**, as claudeEnv does for the
 *   host's own Claude Code calls: with HOME and PATH alone Claude Code says a
 *   signed-in Mac is signed out, and a window is a Claude Code.
 * - **None of the markers a Claude Code session sets for its own children**
 *   (`PARENT_SESSION`). A host started from inside a Claude Code window, by
 *   hand or by an app launched from one, hands them on, and a Claude Code
 *   that inherits them believes it is that session's child. Measured by
 *   pc-developer on Windows, 2026-11-20, Claude Code 2.1.330: a window under
 *   a multiplexer started from an agent's window showed "⚠ Transcript saving
 *   is off — inherited CLAUDE_CODE_CHILD_SESSION marker" and wrote no
 *   transcript, which is a desk the floor can never hear. Only the markers
 *   go: `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_USE_BEDROCK`, `ANTHROPIC_API_KEY`
 *   and the rest are how a person configures Claude Code, and a window needs
 *   them. `CLAUDE_EFFORT` is the parent's effort level, and would set the
 *   window's.
 * - **A locale**, below.
 *
 * tmux finds its socket by `TMUX_TMPDIR`, never `TMPDIR`, so filling it moves
 * no server. A server already running keeps what it was started with:
 * cleanServerEnv() takes the same variables out of it at the host's start.
 *
 * tmux escapes whatever it thinks the terminal cannot print, so a directory
 * with a character outside ASCII comes back as octal escapes unless the locale
 * says UTF-8 — and under launchd there is no locale at all. Take the person's
 * if they have one; otherwise say UTF-8, because a repo's name is not ours to
 * mangle.
 */
export function windowEnv(env = process.env, { platform = process.platform, tempDir = darwinTempDir, user = accountName } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith('ORCH_') && !PARENT_SESSION.has(k)) out[k] = v;
  out.LC_ALL = env.LC_ALL || env.LC_CTYPE || env.LANG || 'en_US.UTF-8';
  if (!env.TMPDIR && platform === 'darwin') {
    const t = tempDir();
    if (t) out.TMPDIR = t;
  }
  if (!env.USER || !env.LOGNAME) {
    const u = env.USER || env.LOGNAME || user();
    if (u) { out.USER = env.USER || u; out.LOGNAME = env.LOGNAME || u; }
  }
  return out;
}

/** The person's own temporary directory on macOS, as their shell has it in
 *  `TMPDIR`, or null. */
function darwinTempDir() {
  try { return execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8', timeout: 2000 }).trim() || null; } catch { return null; }
}
function accountName() {
  try { return userInfo().username || null; } catch { return null; }
}

/**
 * Windows, where the multiplexer is not tmux itself but a tool that answers
 * tmux's commands (psmux 3.4.0 measured by pc-developer, 2026-11-20, against
 * Claude Code 2.1.330: drawing, typing, keys, bracketed paste, `=name`, `-e`,
 * `-c`, attach and detach all as on the Mac). Two things differ, and both are
 * about how a program is found and started, not about what tmux is asked:
 *
 * - **A binary is found by its path.** winget puts psmux's `tmux.exe` in
 *   `%LOCALAPPDATA%\Microsoft\WinGet\Links` and adds that to the user's
 *   PATH, which only processes started after the install see. So the name
 *   is resolved once with `where.exe`, then that folder, and `ORCH_TMUX` /
 *   `ORCH_HOST_CLAUDE` still win.
 * - **A window's program is started as an argument list, never a shell
 *   line** (`launchArgs`). Windows has no `exec`, so a shell line leaves the
 *   shell as the pane's process and Claude Code as its child: the pane's pid
 *   is then `bash.exe` or `powershell.exe`, never the pid `claude agents`
 *   reports, and the host finds a desk's window by exactly that join
 *   (holderOf). Given after `--`, the pane's pid is claude.exe's, and its
 *   folder is spelled as the roster spells it (both measured).
 *
 * `ORCH_HOST_PLATFORM` stands in for the platform, for the suites alone.
 */
export const WINDOWS = (process.env.ORCH_HOST_PLATFORM ?? process.platform) === 'win32';
function findExe(name, { extra = [] } = {}) {
  try {
    // stderr ignored: where.exe says "INFO: Could not find files …" there on
    // a miss, and that line read as the host's own in its log.
    const hits = execFileSync('where.exe', [name], { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/).map((l) => l.trim());
    // The .exe first (Anthropic's native install); an npm install is only a
    // .cmd, which spawnPlan in host/agent.js runs through cmd.exe (task 348 F7).
    const hit = hits.find((l) => /\.exe$/i.test(l)) ?? hits.find((l) => /\.cmd$/i.test(l));
    if (hit) return hit;
  } catch { /* not on PATH */ }
  return extra.find((p) => existsSync(p)) ?? name;
}
export const CLAUDE = process.env.ORCH_HOST_CLAUDE ?? (WINDOWS && process.platform === 'win32' ? findExe('claude', { extra: [join(homedir(), '.local', 'bin', 'claude.exe')] }) : 'claude');

/** Long enough for a cold `claude agents --json`, short enough not to stall a poll. */
const LIST_TIMEOUT_MS = Number(process.env.ORCH_ROSTER_TIMEOUT_MS ?? 15_000);
/**
 * Where Claude Code keeps its own files. Overridable so the tests can prove
 * what happens to a message that never lands without writing into the real one.
 */
const CLAUDE_HOME = process.env.ORCH_CLAUDE_HOME ?? join(homedir(), '.claude');

/**
 * The shell a window's command runs in, for the host's sign-in reading
 * (statusCommand in host/auth.js): a window is `exec env … claude …` run by
 * tmux through its `default-shell -c` (launchArgs), so that shell's startup
 * files are part of what a window has. The floor's server says which shell
 * it uses; with no server running, tmux would start one with SHELL, then the
 * account's shell, then /bin/sh (tmux(1), default-shell), and so does this.
 * Null on Windows, where a window is the program with no shell around it.
 */
export function shellFor({ told = '', env = process.env, account = () => userInfo().shell, exists = existsSync } = {}) {
  let own = '';
  try { own = account() || ''; } catch { /* no passwd entry */ }
  for (const s of [told, env.SHELL, own]) if (s && s.startsWith('/') && exists(s)) return s;
  return '/bin/sh';
}
/**
 * The real path of a directory, with symlinks resolved.
 *
 * Everything here matches a repo to a session by comparing directories, and
 * two spellings of the same directory are the normal case, not an edge one: on
 * macOS `/tmp` is a symlink to `/private/tmp`, so a desk found at
 * `/tmp/x` and the Claude Code session that reports itself in
 * `/private/tmp/x` are the same window and must compare equal. They didn't,
 * once, and the symptom was a desk that opened a window fine and then never
 * showed a word of the conversation — the transcript path is derived from this
 * too, so a mismatch quietly pointed at a file that does not exist.
 */
export function canonical(p) {
  if (typeof p !== 'string' || !p) return p;
  try { return realpathSync.native(p); } catch { return p; }
}

/* ───────────────────────── which window ───────────────────────── */

/**
 * Where a window is: a folder, or a folder and a seat.
 *
 * For as long as a folder was one desk, the directory was a window's whole
 * identity (paneIn, below), and every function here takes it as its first
 * argument. One agent with several sessions at once (host/seats.js) puts
 * several windows in one folder, each a different desk, and the directory
 * no longer says which. So the first argument is either the folder, as it
 * always was, for the folder's own desk, or `{ cwd, seat }` for a seat,
 * where `seat` is the tag its tmux window carries (`@orch_seat`).
 *
 * The folder's own window is the one with no tag, and that is the rule that
 * keeps every desk that existed before seats exactly as it was: nothing
 * tags a window but open() for a seat, so a host with no seats finds every
 * window as it always did.
 */
export const cwdOf = (where) => (typeof where === 'string' ? where : where?.cwd ?? null);
export const seatOf = (where) => (typeof where === 'string' ? null : where?.seat || null);
/**
 * Every live Claude Code session on this machine, keyed by the directory it
 * was started in. This is the whole of discovery: no `.mcp.json` crawl, no
 * hook reporting a pid, no TTL guessing which windows are still open. A
 * session that has exited is simply not in the list.
 */
export async function roster() {
  const fast = readSessionFiles();
  if (fast) return fast;
  return rosterViaCli();
}

/** Signal 0 is the portable "are you there". EPERM means yes, just not ours. */
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
}
/**
 * The roster, read from the files Claude Code writes about itself.
 *
 * Every running session drops `~/.claude/sessions/<pid>.json` describing itself
 * — pid, session id, cwd, kind — and removes it on the way out. This is the
 * same information `claude agents --json` prints, from the same place, and it
 * is the difference between a host that answers in a millisecond and one that
 * does not work at all: that command takes **thirteen seconds** on this machine,
 * because it boots the whole CLI to do it. A watch loop that runs every second
 * cannot call it, and the readiness check got three tries inside a 45-second
 * budget before giving up on a window that was already running.
 *
 * A file can outlive its process if a session was killed, so the pid is checked
 * rather than trusted. Returns null — not an empty roster — when the directory
 * isn't there at all, so the caller can fall back rather than conclude that
 * nothing is running.
 */
function readSessionFiles() {
  const dir = join(CLAUDE_HOME, 'sessions');
  let names;
  try { names = readdirSync(dir); } catch { return null; }
  const sessions = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    let d;
    try { d = JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch { continue; }
    if (typeof d?.cwd !== 'string' || typeof d?.sessionId !== 'string') continue;
    const pid = Number(d.pid) || null;
    if (!alive(pid)) continue;
    sessions.push({
      pid,
      cwd: canonical(d.cwd),
      sessionId: d.sessionId,
      // The file says `bg` where `claude agents --json` says `background` for
      // the same process (2.1.258) — one word here, the CLI's, so a reader of
      // either sees the same roster. The first cut compared against the CLI's
      // word and let the daemon's session through as an editor tab.
      kind: d.kind === 'bg' ? 'background' : typeof d.kind === 'string' ? d.kind : 'interactive',
      // How this session was started — 'claude-vscode' for the VS Code
      // extension, and so on. It is the difference between a window that can be
      // typed into and one that has to be reached another way, which is not a
      // detail: it decides whether a message can be delivered at all.
      entrypoint: typeof d.entrypoint === 'string' ? d.entrypoint : null,
      name: typeof d.name === 'string' ? d.name : null,
      // Claude Code's handle for a background session — what `claude stop`
      // and `claude attach` take. `name` is a label and may be words.
      job: typeof d.jobId === 'string' ? d.jobId : null,
      startedAt: Number(d.startedAt) || null,
      // The tmux pane an interactive Claude Code runs in (`orch:@12.%12`) and
      // whether it is in a turn (`busy` / `idle`), as 2.1.330 writes them:
      // how an earlier host's window is known, and when it may be ended
      // (endLegacyWindows).
      tmux: typeof d.tmux === 'string' ? d.tmux : null,
      status: typeof d.status === 'string' ? d.status : null,
    });
  }
  return { ok: true, sessions };
}

/** The documented way to ask, kept as a fallback. Correct, and very slow. */
async function rosterViaCli() {
  let out;
  try {
    ({ stdout: out } = await run(CLAUDE, ['agents', '--json'], { timeout: LIST_TIMEOUT_MS, encoding: 'utf8' }));
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: false, error: 'the claude CLI is not on PATH', sessions: [] };
    return { ok: false, error: (err?.stderr || err?.message || String(err)).trim(), sessions: [] };
  }
  let rows;
  try {
    rows = JSON.parse(out);
  } catch {
    return { ok: false, error: 'claude agents --json did not return JSON', sessions: [] };
  }
  if (!Array.isArray(rows)) return { ok: false, error: 'unexpected roster shape', sessions: [] };
  return {
    ok: true,
    sessions: rows
      .filter((r) => r && typeof r.cwd === 'string' && typeof r.sessionId === 'string')
      // A process that is gone holds nothing, whatever the list says. The
      // CLI should never print one, and the session-file reader above checks
      // the same way; a stand-in that cannot unwrite its own entry can, and
      // read as an editor it refused every reopen after the first.
      .filter((r) => alive(Number(r.pid)))
      .map((r) => ({
        pid: Number(r.pid) || null,
        cwd: canonical(r.cwd),
        sessionId: r.sessionId,
        kind: typeof r.kind === 'string' ? r.kind : 'interactive',
        name: typeof r.name === 'string' ? r.name : null,
        startedAt: Number(r.startedAt) || null,
      })),
  };
}

/**
 * The desk processes a host has running, kept on disk so the next run of the
 * same host can end any that a crash left behind (task 340, desktop-dev,
 * measured on 2.1.330). A host stopped properly ends its desks (stop() in
 * host/agent.js). A host that dies outright (a kill, a crash that takes the
 * process, the app's utility process going with the app) closes their input
 * and nothing else, and a Claude Code whose input closes finishes the turn it
 * is in first: a desk in a 41 s tool call ran on 38 s with nobody listening.
 * A host started meanwhile then found its conversation held by a process it
 * did not know and refused it ("held elsewhere"), so the operator was handed
 * a remedy for the host's own leftover. Now the new run ends it first.
 *
 * One file per host id, beside host.json: two hosts on one machine (the
 * app's and one started by hand) never end each other's desks.
 */
export function deskPidsFile(hostId) {
  const safe = String(hostId ?? 'host').replace(/[^A-Za-z0-9._-]/g, '_');
  // Beside host.json, as the seats and the uploads are: ~/.orchestratinator
  // for a launchd host, the app's profile for the app's.
  const dir = process.env.ORCH_DESK_PIDS_DIR ?? dirname(process.env.ORCH_HOST_CONFIG ?? join(homedir(), '.orchestratinator', 'host.json'));
  return join(dir, `desk-pids-${safe}.json`);
}

/** Write the running desks' pids (best effort: a host that cannot write it runs as before). */
export function noteDeskPids(file, rows) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(rows)}\n`);
    renameSync(tmp, file);
    return true;
  } catch { return false; }
}

const commandLineOf = (pid) => new Promise((resolve) => {
  execFile('ps', ['-o', 'command=', '-p', String(pid)], { timeout: 5000 }, (err, out) => resolve(err ? null : String(out).trim()));
});

/**
 * End the desk processes an earlier run of this host left running. A pid is
 * ended only while `ps` still shows it as a Claude Code on the stream-JSON
 * path, so a pid the system has since given to something else is left alone.
 * SIGTERM ends Claude Code at once, tool and all (0.5 s, measured); SIGKILL
 * after `graceMs` for one that has not gone. Not on Windows, where there is
 * no `ps` to tell a reused pid apart: there the leftover finishes its turn
 * and leaves, as before (unmeasured there). Returns what it ended.
 */
export async function endLeftoverDesks(file, { graceMs = 5000 } = {}) {
  let rows = [];
  try { rows = JSON.parse(readFileSync(file, 'utf8')); } catch { return []; }
  if (!Array.isArray(rows)) rows = [];
  const ended = [];
  if (process.platform !== 'win32') {
    for (const r of rows) {
      const pid = Number(r?.pid);
      if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || !alive(pid)) continue;
      const cmd = await commandLineOf(pid);
      // A desk's own command line (agentArgs): \`-p\` and the space form of
      // --permission-prompt-tool. The VS Code extension's Claude Code also
      // speaks stream-JSON both ways, but with \`--permission-prompt-tool=stdio\`
      // and no \`-p\` (read off a running one, 2.1.329), so it never matches.
      const argv = cmd ? cmd.split(/\s+/) : [];
      if (!argv.includes('-p') || !cmd.includes('--input-format stream-json') || !cmd.includes('--permission-prompt-tool stdio')) continue;
      try { process.kill(pid, 'SIGTERM'); } catch { continue; }
      const end = Date.now() + graceMs;
      while (alive(pid) && Date.now() < end) await sleep(100);
      if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      ended.push({ pid, cwd: r.cwd ?? null, session: r.session ?? null });
    }
  }
  noteDeskPids(file, []);
  return ended;
}

/**
 * The windows an earlier build of the host ran desks in, ended so their
 * conversations can come to the floor (0.15.0's upgrade, measured
 * 2026-11-22 in task 341 C1). Up to 0.14.x each desk's Claude Code ran in a
 * window of the host's tmux session `orch` (psmux on Windows), and those
 * windows outlive the host that made them. After the upgrade the new host
 * found each desk's conversation held by that window's process, so every
 * desk read "held by an editor", and Open on the floor said "Quit it there
 * first" about a window in a detached session nobody could see or knew of.
 *
 * So the new host ends them at its start, as it ends a background session
 * on a click (releaseBackground): the host made them, nobody is at them, and
 * the conversation is on disk and resumes on the floor. Only a window of
 * that session whose folder is one of this host's desks' (a seat's included:
 * it shares its desk's folder) is touched; a pane in any other folder, and
 * every other session and socket, is left alone. A machine with no tmux, or
 * no such session, is a no-op. `ORCH_TMUX` and `ORCH_TMUX_SESSION`, which
 * 0.14.x read, still name the binary and the session.
 */
const LEGACY_SEP = '|';   // 0.14.x's own: a tab comes back as `_` with no locale (launchd)
function legacyTmux() {
  if (process.env.ORCH_TMUX) return process.env.ORCH_TMUX;
  if (!WINDOWS) return 'tmux';
  const links = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Links');
  return process.platform === 'win32' ? findExe('tmux', { extra: [join(links, 'tmux.exe')] }) : 'tmux';
}
const tmuxRun = (bin, args) => new Promise((resolve) => {
  execFile(bin, args, { timeout: 5000, windowsHide: true, env: { ...process.env, LC_ALL: process.env.LC_ALL ?? 'en_US.UTF-8' } },
    (err, out) => resolve(err ? null : String(out)));
});

const legacySessionName = () => (process.env.ORCH_TMUX_SESSION ?? 'orch').replace(/[^A-Za-z0-9._-]/g, '-') || 'orch';
/** A roster entry that is an earlier host's window: its pane is in the host's session. */
export const isLegacyWindow = (s) => typeof s?.tmux === 'string' && s.tmux.startsWith(`${legacySessionName()}:`);

/** End one such window: its tmux window if there is one, its process either way. */
export async function endLegacyWindow({ pid, window = null }, { graceMs = 5000 } = {}) {
  const bin = legacyTmux();
  const win = window ?? null;
  if (win) await tmuxRun(bin, ['kill-window', '-t', win]);
  if (Number.isInteger(pid) && pid > 1) {
    const end = Date.now() + graceMs;
    while (alive(pid) && Date.now() < end) await sleep(100);
    if (alive(pid)) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
    const hard = Date.now() + graceMs;
    while (alive(pid) && Date.now() < hard) await sleep(100);
    if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }
  return { ok: !alive(pid) };
}
const windowOf = (tmux) => /:(@\d+)/.exec(tmux ?? '')?.[1] ?? null;

/**
 * Every earlier-host window in one of these folders: from the roster (its
 * `tmux` field names the session) and from tmux itself (a pane of the
 * session, for a build whose roster writes no `tmux`). An idle one is ended;
 * a busy one (the roster's `status`) is left to finish its turn and returned
 * as waiting, to be looked at again, because ending it would cut off work in
 * flight. An agent of the operator's own may be mid-turn in one at the
 * moment the new host starts (the desktop app's update, run while its agents
 * work, is exactly that).
 */
export async function endLegacyWindows(deskDirs, opts = {}) {
  const session = legacySessionName();
  const mine = new Set(deskDirs.map((d) => canonical(d)));
  const roster = readSessionFiles()?.sessions ?? [];
  const out = await tmuxRun(legacyTmux(), ['list-panes', '-s', '-t', `=${session}`, '-F', ['#{window_id}', '#{window_name}', '#{pane_pid}', '#{pane_current_path}'].join(LEGACY_SEP)]);
  const panes = new Map();
  for (const line of (out ?? '').split(/\r?\n/).filter(Boolean)) {
    const [win, name, pidText, ...rest] = line.split(LEGACY_SEP);
    if (Number(pidText)) panes.set(Number(pidText), { window: win, name, cwd: canonical(rest.join(LEGACY_SEP)) });
  }
  const found = new Map();
  for (const r of roster) {
    if (r.kind !== 'interactive' || !mine.has(r.cwd)) continue;
    if (!isLegacyWindow(r) && !panes.has(r.pid)) continue;
    found.set(r.pid, { pid: r.pid, cwd: r.cwd, session: r.sessionId, status: r.status, window: windowOf(r.tmux) ?? panes.get(r.pid)?.window ?? null, name: panes.get(r.pid)?.name ?? r.name ?? null });
  }
  for (const [pid, p] of panes) {
    // A pane whose process has gone (0.14.x set remain-on-exit) holds nothing.
    if (!found.has(pid) && mine.has(p.cwd) && alive(pid)) found.set(pid, { pid, cwd: p.cwd, session: null, status: null, window: p.window, name: p.name });
  }
  const ended = [];
  const waiting = [];
  for (const w of found.values()) {
    if (w.status === 'busy') { waiting.push(w); continue; }
    await endLegacyWindow(w, opts);
    ended.push(w);
  }
  return { ended, waiting };
}

/**
 * Claude Codes resuming a conversation that Claude Code's roster does not
 * list yet: session id → pid, from the process table. (task 348 F6,
 * pc-developer, measured on Windows; the premise read on macOS by QA.) A
 * terminal opened by "Open in Claude" on a folder taken under 0.15 stops at
 * Claude Code's trust question, because the desk's own Claude Code (`-p`)
 * never asked it, and until it is answered that Claude Code writes no roster
 * entry. The floor then read the desk as held by nobody, took the next
 * message and started a second process on the conversation. The process
 * table has the terminal's `claude --resume <id>` from its first moment.
 * A desk's own command line (`-p`, `--print`) is never one of these.
 */
/**
 * One process's command line, read as a Claude Code resuming a conversation:
 * its session id, or null. Pure, for the suites. Claude Code is \`claude\`,
 * \`claude.exe\`, or an npm install's \`node …/claude-code/cli.js\` (what a
 * \`claude.cmd\` runs on Windows: pc-developer, task 348); never one started
 * with \`-p\` or \`--print\`, which is a desk's own.
 */
export function resumingIdOf(cmd) {
  if (typeof cmd !== 'string') return null;
  const argv = cmd.trim().split(/\s+/).map((a) => a.replace(/^"|"$/g, ''));
  const isClaude = argv.some((a) => /(^|[\\/])claude(\.exe)?$/i.test(a) || /claude-code[\\/]cli\.m?js$/i.test(a));
  if (!isClaude || argv.includes('-p') || argv.includes('--print')) return null;
  for (let i = 0; i < argv.length; i++) {
    const m = /^--resume=(.+)$/.exec(argv[i]);
    const id = m ? m[1] : argv[i] === '--resume' ? argv[i + 1] : null;
    if (id && /^[0-9a-f-]{8,}$/i.test(id)) return id;
  }
  return null;
}

export async function resumingProcesses() {
  const out = new Map();
  const take = (pid, cmd) => {
    if (!pid) return;
    const id = resumingIdOf(cmd);
    if (id) out.set(id, pid);
  };
  if (process.platform === 'win32') {
    const ps = await new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='claude.exe' OR Name='node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"], { timeout: 8000, windowsHide: true }, (err, o) => resolve(err ? null : String(o)));
    });
    let rows = [];
    try { rows = JSON.parse(ps || '[]'); } catch { rows = []; }
    for (const r of Array.isArray(rows) ? rows : [rows]) take(Number(r?.ProcessId), r?.CommandLine);
    return out;
  }
  const ps = await new Promise((resolve) => {
    execFile('ps', ['-Ao', 'pid=,command='], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (err, o) => resolve(err ? '' : String(o)));
  });
  for (const line of ps.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) take(Number(m[1]), m[2]);
  }
  return out;
}

/** When a process started, in ms, from how long `ps` says it has run; null when it cannot say. */
export async function startedAt(pid) {
  if (!pid) return null;
  const r = await new Promise((resolve) => {
    execFile('ps', ['-o', 'etime=', '-p', String(pid)], { timeout: 5000 }, (err, out) => resolve(err ? null : String(out).trim()));
  });
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(r ?? '');
  if (!m) return null;
  const secs = (Number(m[1] ?? 0) * 86400) + (Number(m[2] ?? 0) * 3600) + (Number(m[3]) * 60) + Number(m[4]);
  return Date.now() - (secs * 1000);
}

/**
 * The conversation a window with no record is on: the one in its folder
 * somebody last spoke in, when that was after the window started. Anything
 * older is not this window's, and a folder just taken starts a new
 * conversation rather than whichever old one is in it (resumable). Null
 * when nothing was said in it: a new conversation loses nothing.
 */
export async function spokenSince(where, sinceMs) {
  if (seatOf(where) || !sinceMs) return null;
  const newest = await newestConversation(canonical(cwdOf(where)));
  if (!newest) return null;
  const at = Date.parse(newest.at);
  // A second of grace: a turn's stamp is the window's clock at the write,
  // and the start is `ps`, which counts whole seconds.
  return Number.isFinite(at) && at >= sinceMs - 1000 ? newest.id : null;
}

/** The variable a seat's window carries: the path of its binding file. */
export const SEAT_ENV = 'ORCH_DESK_CONFIG';

/**
 * A slash command as the composer takes one: a single line, `/name` and
 * whatever follows. Anything with a newline in it is a message, whatever its
 * first character — the window's own rule, and the reason a pasted block that
 * happens to start with "/" is never mistaken for a command.
 */
export function commandOf(text) {
  const t = String(text ?? '').trim();
  if (!t || t.includes('\n')) return null;
  const m = /^\/([A-Za-z][\w:-]*)(?:\s+(.*))?$/.exec(t);
  return m ? { name: m[1].toLowerCase(), args: (m[2] ?? '').trim() } : null;
}

const SGR = /\x1b\[[0-9;]*m/g;
/**
 * Hand a message to Claude Code in the editor, through the URL the extension
 * publishes for exactly this.
 *
 * `vscode://anthropic.claude-code/open?session=…&prompt=…` opens a conversation
 * in VS Code with the text already in the input box. It is a supported entry
 * point declared by the extension, not a way around one — the same link a page
 * or a menu item would use.
 *
 * Two things it will not do, both load-bearing:
 *   - it does not press Enter, so the person sends their own message;
 *   - it refuses a session that is already open ("Session is already open") and
 *     drops the prompt, so the caller must know that case and say so rather
 *     than hand over a message that goes nowhere.
 */
export async function openInEditor({ sessionId = null, text = null } = {}) {
  // Both parts are optional: with a prompt this hands over a message, without
  // one it just brings the conversation up in the editor.
  if (!sessionId && !(typeof text === "string" && text.trim())) {
    return { ok: false, error: 'nothing to open' };
  }
  const q = new URLSearchParams();
  if (sessionId) q.set('session', sessionId);
  if (typeof text === 'string' && text.trim()) q.set('prompt', text);
  const url = `vscode://anthropic.claude-code/open?${q}`;
  // ORCH_EDITOR_OPEN names a program run with the URL in place of `open -a`:
  // test:host's seam, so a handback in the suite puts nothing on the
  // operator's screen. Nothing installed sets it.
  const opener = process.env.ORCH_EDITOR_OPEN;
  try {
    await run(opener || 'open', opener ? [url] : ['-a', 'Visual Studio Code', url], { timeout: 10_000 });
    return { ok: true, url };
  } catch (err) {
    return { ok: false, error: (err?.stderr || err?.message || String(err)).trim() };
  }
}

/**
 * A string as AppleScript source. Backslash first, or the escape of the quote
 * gets escaped in turn and the script ends mid-literal.
 */
const osaString = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * The terminals this knows how to open, and how to tell each one to run a
 * command in a new window.
 *
 * Two of them, and the choice is not cosmetic. This button exists for the
 * moment somebody has stopped trusting what the floor is showing them; opening
 * Terminal.app in front of a person who lives in iTerm adds one more unfamiliar
 * thing to a screen that has already confused them once.
 */
const TERMINALS = {
  iterm: {
    app: 'iTerm',
    path: '/Applications/iTerm.app',
    script: (cmd) => [
      'tell application "iTerm"',
      '  activate',
      '  set w to (create window with default profile)',
      `  tell current session of w to write text ${osaString(cmd)}`,
      'end tell',
    ].join('\n'),
  },
  terminal: {
    app: 'Terminal',
    path: '/System/Applications/Utilities/Terminal.app',
    script: (cmd) => [
      'tell application "Terminal"',
      `  do script ${osaString(cmd)}`,
      '  activate',
      'end tell',
    ].join('\n'),
  },
};

/** Which one to open: what ORCH_TERMINAL names, else whichever is installed. */
function pickTerminal() {
  const want = (process.env.ORCH_TERMINAL ?? '').trim().toLowerCase();
  // Set but unrecognised is an error, not a reason to quietly open the other
  // one. Someone who wrote a terminal's name in a config file will not be
  // looking for the reason a different terminal opened.
  if (want) return TERMINALS[want] ?? null;
  for (const t of [TERMINALS.iterm, TERMINALS.terminal]) if (existsSync(t.path)) return t;
  return TERMINALS.terminal;
}

/**
 * Windows Terminal opened by the host lands behind the window in front
 * (pc-developer, 2026-11-20: "YES, BUT BEHIND"), because a hidden process may
 * not take the front. host/front-win.ps1 finds the new window by its title
 * and brings it forward with the unlock measured for the folder dialog.
 * Started and not awaited: it waits up to FRONT_WAIT_MS for the window to
 * appear, and the host's line is the one that delivers messages. What it
 * reports goes to the host log. Measured (pc-developer, 2026-11-20, 9e160cc):
 * in front and focused 1.0 to 1.3 s after opening, 4 of 4, from both
 * buttons; the table is in front-win.ps1's header.
 */
const FRONT_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'front-win.ps1');
const FRONT_WAIT_MS = 5000;
function bringToFront(title) {
  const ps = join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  execFile(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', FRONT_SCRIPT, title, String(FRONT_WAIT_MS)],
    { timeout: FRONT_WAIT_MS + 10_000, encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => {
      let said = null;
      try { said = JSON.parse(String(stdout).trim()); } catch { /* reported below as it came */ }
      if (said?.front) log(`brought the Windows Terminal window "${title}" to the front`);
      else warn(`the Windows Terminal window "${title}" opened but was not brought to the front: ${said?.why ?? (String(stderr).trim() || err?.message || 'no answer')}`);
    });
}

/**
 * "Open in Claude": the conversation handed to a terminal of the operator's
 * own, running `claude --resume <id>` in the desk's folder (costmo's ruling,
 * 2026-11-22: the desk's Claude Code is the host's child, with no screen to
 * attach to, so a terminal is a handoff, as VS Code always was). The caller
 * ends the desk's own process first: two processes on one conversation
 * diverge without a word.
 */
export async function openInTerminal({ cwd, sessionId }) {
  const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  const resume = sessionId ? ` --resume ${sessionId}` : '';
  if (WINDOWS) {
    const title = `orchestratinator · ${Date.now().toString(36).slice(-4)}`;
    const cmd = `claude${resume}`;
    try {
      await new Promise((resolve, reject) => {
        const child = spawn('wt.exe', ['-w', 'new', 'new-tab', '-d', cwd, '--title', title, '--suppressApplicationTitle', 'claude', ...(sessionId ? ['--resume', sessionId] : [])], { detached: true, stdio: 'ignore' });
        child.once('error', reject);
        child.once('spawn', () => { child.unref(); resolve(); });
      });
      bringToFront(title);
      return { ok: true, app: 'Windows Terminal', cmd };
    } catch (err) {
      return { ok: false, cmd, error: `could not open Windows Terminal: ${err?.code === 'ENOENT' ? 'wt.exe is not installed' : err?.message ?? err}. Run \`${cmd}\` in ${cwd} yourself.` };
    }
  }
  const cmd = `cd ${q(cwd)} && claude${resume}`;
  const term = pickTerminal();
  if (!term) return { ok: false, cmd, error: `ORCH_TERMINAL is set to "${process.env.ORCH_TERMINAL}", which this host has no script for. Set it to "iterm" or "terminal", or run \`${cmd}\` yourself.` };
  try {
    await run('osascript', ['-e', term.script(cmd)], { timeout: 15_000 });
    return { ok: true, app: term.app, cmd };
  } catch (err) {
    const why = (err?.stderr || err?.message || String(err)).trim();
    return { ok: false, cmd, error: `could not open ${term.app}: ${why}. Run \`${cmd}\` on this machine yourself.` };
  }
}

/**
 * Claude Code's own transcript for a session. This is the mirror: both sides
 * of the conversation, written by Claude Code itself, whoever typed it and
 * from wherever. The floor tails it instead of being told about turns, which
 * is why a turn you type in your own terminal shows up on the floor without
 * anything reporting it.
 */
export function transcriptPath(cwd, sessionId) {
  return join(projectDir(cwd), `${sessionId}.jsonl`);
}

/** Claude Code's own directory for a working directory: one transcript per
 *  session, plus a subdirectory per session for its subagents. Exists only
 *  once Claude Code has opened the folder, which is what the folder list
 *  reads it for. */
export function projectDir(cwd) {
  return join(CLAUDE_HOME, 'projects', projectSlug(cwd));
}

/**
 * Claude Code's own directory name for a working directory: every character
 * that is not a letter or digit becomes a dash. Exported because it is the one
 * place the rule lives — the folder list and the session picker find a
 * directory's transcripts by it, and two spellings of one rule is how a desk
 * ends up reading a file that does not exist.
 */
export function projectSlug(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * Which conversation `--resume` can actually open here.
 *
 * The board pins a desk to the session id the roster last showed for it, and
 * the roster is written when a process starts. A process that starts as one
 * session and picks another up from inside — /resume in a VS Code tab — keeps
 * its first id in the roster and writes every word into the other file. Close
 * it, and the desk is pinned to an id that never became a transcript, and
 * `claude --resume <that>` can only say "No conversation found with session
 * ID" and exit. Seen on 2.1.258 (2026-09-09): service-developer pinned to
 * 47717b6c…, eight session rows from one afternoon of opening and closing
 * tabs, three with a file on disk, one with any turns in it.
 *
 * So the pin is checked against the disk, and when nobody has spoken in it
 * the desk's conversation is the one in this folder with the latest turn.
 * "Spoken" is as readTranscript files it — a `user` or `assistant` turn — and
 * not a record type: a tab in which somebody typed /resume and nothing else
 * holds three user records, all of them the command and its output, which the
 * reader files as context. The first cut counted those and opened that tab
 * (62c585ba) instead of the conversation. By the time of the last turn, not
 * the file's mtime, because reopening a conversation appends metadata without
 * saying anything (a `bridge-session` record moved 8cac3404's mtime to today
 * while its last word was yesterday's). With nothing spoken anywhere the
 * window starts fresh, as it does for a desk with no pin at all — and a desk
 * with no pin is left alone: a folder just taken from the floor starts a new
 * conversation, not whichever old one happens to be in it.
 *
 * Nothing here decides silently. The note says what was asked for and what
 * was opened, and the caller puts it where the operator will read it.
 */
export async function resumable(where, sessionId, { seatPids = new Set() } = {}) {
  if (!sessionId) return { id: null, note: null };
  const here = canonical(cwdOf(where));
  const own = transcriptPath(here, sessionId);
  const exists = existsSync(own);
  if (exists && await lastTurnAt(own)) return { id: sessionId, note: null };
  const asked = `${sessionId} ${exists ? 'has no turns in it' : 'never wrote a transcript'}, so there is nothing to resume there`;
  // A seat never falls back to "the newest in this folder". The folder is
  // several desks' (see "which window"), and its newest conversation is most
  // likely the one another desk's window is running: resumed here as well,
  // two processes would append to one transcript. It starts a new one.
  if (seatOf(where)) return { id: null, note: `${asked}; this desk shares its folder with another desk, so it starts a new conversation rather than take the folder's newest.` };
  // And the folder's own desk never falls back onto a conversation one of
  // its seats is running, for the same reason.
  // The seats' own Claude Codes, which the host names (host/desk.js): a
  // conversation one of them is running is not this desk's to take.
  const r = await roster();
  const theirs = new Set((r.ok ? r.sessions : []).filter((x) => x.cwd === here && seatPids.has(x.pid)).map((x) => x.sessionId));
  const newest = await newestConversation(here, theirs);
  // Said as a fact about the folder, not as something done: the caller may
  // still be refused — by a background session holding the conversation, for
  // one — and "opened X instead" above a refusal to open X is a false record.
  if (!newest) return { id: null, note: `${asked}; nothing else in this folder has any either, so a new conversation starts.` };
  return {
    id: newest.id,
    note: `${asked}; the conversation here is ${newest.id} — the newest in this folder, last turn ${newest.at}.`,
  };
}

/** The transcript in this folder whose last turn is latest, or null. */
async function newestConversation(cwd, skip = new Set()) {
  let names;
  try { names = readdirSync(projectDir(cwd)).filter((f) => f.endsWith('.jsonl') && !skip.has(f.slice(0, -'.jsonl'.length))); } catch { return null; }
  let best = null;
  for (const name of names) {
    const at = await lastTurnAt(join(projectDir(cwd), name));
    if (at && (!best || at > best.at)) best = { id: name.slice(0, -'.jsonl'.length), at };
  }
  return best;
}

/**
 * When somebody last said something in a transcript, or null if nobody has.
 * Through readTranscript, so "said" means exactly what the floor draws as a
 * person or the agent speaking — the one reader, not a second opinion on
 * record types. Read whole rather than tailed: it runs once per open, on a
 * folder's few files, and the whole point is not to miss the last word.
 */
async function lastTurnAt(path) {
  const r = await readTranscript(path);
  if (!r.ok) return null;
  let last = null;
  for (const t of r.turns) {
    if ((t.role === 'user' || t.role === 'assistant') && Number.isFinite(Date.parse(t.at))) last = t.at;
  }
  return last;
}

/**
 * The conversations in a folder, newest first — the floor's session picker.
 *
 * Thirty, by the file's mtime, and each read twice: the first 64 KB for the
 * first thing a person said (its timestamp is when the conversation began)
 * and the last 256 KB for the newest title record and the last spoken turn.
 * A title is Claude Code's own: `custom-title` (the person named it, /rename)
 * over `ai-title` (Claude Code named it) over the first prompt clipped — and
 * `title_source` says which, so the page can mark a named one. The first
 * prompt is read by readTranscript's block rule (contextTagOf), so a message
 * that opens with an `<ide_opened_file>` block is titled by the words after
 * it, not the tag.
 *
 * Deliberate omission, and the cost not paid: a `custom-title` written early
 * in a long session and never repeated sits past the head and before the tail
 * and is missed — the conversation shows its AI title or first prompt
 * instead. Claude Code rewrites the title record often (781 copies of one in
 * a real transcript, 2026-09-10), so the tail nearly always has it; a full
 * scan of thirty multi-megabyte files on every open of the picker is what
 * this buys. A file with no spoken turn in either read is listed with no
 * title: a tab opened and closed, and the page says so rather than hiding it,
 * because the current window's own conversation looks exactly like that for
 * its first minute.
 *
 * `live`/`held` come from the roster and the panes, the same join holderOf
 * makes: a row an editor holds cannot be reopened here, and the page needs
 * to know which row that is.
 *
 * `branch` and `model` are read from the same two bounded reads, off the
 * transcript's own records rather than from the board's `agent_sessions` —
 * which has a model for one session in four (66 of 274 on the first board
 * measured, 2026-10-01) and nothing at all for a conversation the hook never
 * reported.
 */
const SESSIONS_HEAD_BYTES = 64 * 1024;
const SESSIONS_TAIL_BYTES = 256 * 1024;
export async function sessionsIn(cwd, { limit = 30, ours = new Set() } = {}) {
  const here = canonical(cwd);
  const dir = projectDir(here);
  let names;
  try { names = readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
  const { stat } = await import('node:fs/promises');
  const files = [];
  for (const name of names) {
    try {
      const st = await stat(join(dir, name));
      if (st.isFile()) files.push({ name, size: st.size, mtime: st.mtime });
    } catch { /* gone between readdir and stat */ }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  // `ours`: the pids of the Claude Codes the host runs for its desks. A live
  // conversation one of them runs is the floor's; any other is an editor's
  // or a terminal's.
  const r = await roster();
  const rows = [];
  for (const f of files.slice(0, Math.max(1, limit))) {
    const id = f.name.slice(0, -'.jsonl'.length);
    const meta = await transcriptMeta(join(dir, f.name), f.size);
    const claiming = r.ok ? r.sessions.filter((x) => x.sessionId === id) : [];
    const title = meta.custom ?? meta.ai ?? (meta.prompt ? clipTitle(meta.prompt) : null);
    rows.push({
      id,
      title,
      title_source: meta.custom ? 'custom' : meta.ai ? 'ai' : meta.prompt ? 'prompt' : null,
      first_prompt: meta.prompt ? meta.prompt.slice(0, 200) : null,
      started_at: meta.startedAt,
      branch: meta.branch,
      model: meta.model,
      last_at: meta.lastAt ?? f.mtime.toISOString(),
      modified_at: f.mtime.toISOString(),
      size: f.size,
      spoken: Boolean(meta.prompt || meta.lastAt),
      live: claiming.length > 0,
      held: claiming.length ? (claiming.some((x) => ours.has(x.pid)) ? 'floor' : 'editor') : null,
      kind: claiming[0]?.kind ?? null,
      pid: claiming[0]?.pid ?? null,
    });
  }
  return rows;
}

/**
 * The conversation in a folder somebody last spoke in, as the session picker
 * would list it, or null. For a desk released from another instance (bind in
 * host/index.js): this host has never watched the folder, so it has no pin
 * to keep, and the agent should arrive on the conversation it was having
 * rather than on a blank one. The picker's bounded reads, not resumable()'s
 * whole-file ones: a release can be one of thirty in a row.
 */
export async function lastSpokenIn(cwd) {
  const rows = (await sessionsIn(cwd)).filter((r) => r.spoken);
  rows.sort((a, b) => String(b.last_at).localeCompare(String(a.last_at)));
  return rows[0]?.id ?? null;
}

/**
 * The permission modes a desk carries over from its conversation. Claude Code
 * writes a `permission-mode` record into the transcript at each turn of an
 * interactive session (Shift+Tab's choice), and a `-p` process started
 * without `--permission-mode` runs in `default` however the conversation was
 * left: every tool asks (costmo, 2026-11-23, the day 0.15.0 took his `auto`
 * desks over). `bypassPermissions` is not carried: on this path it has not
 * been measured, and a flag Claude Code refuses would stop the desk starting.
 * `default` needs no flag.
 */
export const CARRIED_MODES = new Set(['auto', 'acceptEdits', 'plan', 'dontAsk']);
const MODE_TAIL_BYTES = 4 * 1024 * 1024;

/**
 * The mode a transcript was last in, from its last `permission-mode` record,
 * or null. Read from the tail first (one is written each turn), then whole.
 * Only that record: a `-p` process's own user records say `default` while the
 * record beside them still carries the conversation's choice (read on
 * desktop-dev's conversation, 2026-11-23).
 */
export async function conversationMode(path) {
  const { open } = await import('node:fs/promises');
  let fh;
  try { fh = await open(path, 'r'); } catch { return null; }
  try {
    const { size } = await fh.stat();
    for (const from of size > MODE_TAIL_BYTES ? [size - MODE_TAIL_BYTES, 0] : [0]) {
      const buf = Buffer.alloc(size - from);
      await fh.read(buf, 0, buf.length, from);
      const lines = buf.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"permission-mode"')) continue;
        let r;
        try { r = JSON.parse(lines[i]); } catch { continue; }
        if (r?.type === 'permission-mode' && typeof r.permissionMode === 'string') return r.permissionMode;
      }
    }
    return null;
  } finally { await fh.close(); }
}

/**
 * The conversation a running Claude Code is on, from its own roster file, or
 * null. A `-p` process names its conversation in `init`, which it writes only
 * when its first message arrives, so a desk opened on a new conversation had
 * no id until somebody typed, and the floor's New session spun for ever
 * (costmo, 2026-11-23). Its roster file carries the id from its first
 * milliseconds (measured on 2.1.331, nothing sent).
 */
export function sessionOfPid(pid) {
  if (!pid) return null;
  try {
    const d = JSON.parse(readFileSync(join(CLAUDE_HOME, 'sessions', `${pid}.json`), 'utf8'));
    return typeof d?.sessionId === 'string' ? d.sessionId : null;
  } catch { return null; }
}

/** A title from a first prompt: its first line, whitespace folded, 80 characters. */
function clipTitle(s) {
  const line = String(s).trim().split('\n')[0].replace(/\s+/g, ' ');
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}

/**
 * What the head and the tail of one transcript say about it. Both reads are
 * bounded; on a small file they overlap and the whole file is read once.
 */
async function transcriptMeta(path, size) {
  const out = { custom: null, ai: null, prompt: null, startedAt: null, lastAt: null, branch: null, model: null };
  const { open } = await import('node:fs/promises');
  let fh;
  try { fh = await open(path, 'r'); } catch { return out; }
  try {
    const headLen = Math.min(size, SESSIONS_HEAD_BYTES);
    const head = Buffer.alloc(headLen);
    await fh.read(head, 0, headLen, 0);
    const whole = size <= SESSIONS_HEAD_BYTES;
    const headLines = head.toString('utf8').split('\n');
    if (!whole) headLines.pop();   // a line cut by the byte limit is not a record
    let tailLines = [];
    if (!whole) {
      const tailLen = Math.min(size, SESSIONS_TAIL_BYTES);
      const tail = Buffer.alloc(tailLen);
      await fh.read(tail, 0, tailLen, size - tailLen);
      tailLines = tail.toString('utf8').split('\n');
      if (tailLen < size) tailLines.shift();   // the partial first line an arbitrary offset lands in
    }
    const parse = (line) => { try { return line.trim() ? JSON.parse(line) : null; } catch { return null; } };
    const titleOf = (d) => {
      if (d?.type === 'custom-title' && typeof d.customTitle === 'string' && d.customTitle.trim()) out.custom = d.customTitle.trim();
      else if (d?.type === 'ai-title' && typeof d.aiTitle === 'string' && d.aiTitle.trim()) out.ai = d.aiTitle.trim();
    };
    for (const line of headLines) {
      const d = parse(line);
      if (!d) continue;
      titleOf(d);
      if (!out.prompt && d.type === 'user' && !d.isMeta && !d.isSidechain) {
        const text = personText(d.message?.content);
        if (text) {
          out.prompt = text;
          out.startedAt = Number.isFinite(Date.parse(d.timestamp)) ? d.timestamp : null;
        }
      }
    }
    // Titles: the newest record wins, and the tail is newer than the head.
    // The last spoken turn: scanned from the end, like lastTurnAt.
    const later = whole ? headLines : tailLines;
    for (const line of later) titleOf(parse(line));
    for (let i = later.length - 1; i >= 0 && !out.lastAt; i--) {
      if (!later[i].includes('"timestamp"')) continue;
      const d = parse(later[i]);
      if (d && (d.type === 'user' || d.type === 'assistant') && !d.isSidechain && Number.isFinite(Date.parse(d.timestamp))) out.lastAt = d.timestamp;
    }
    // The branch and the model, as the conversation last had them: Claude
    // Code writes `gitBranch` on its records and `message.model` on every
    // assistant turn, and both can change mid-conversation (a checkout, a
    // /model), so the newest record that says is the one to believe — the
    // tail first, then the head for a file whose tail is all tool output.
    // `<synthetic>` is the model Claude Code names on a message it wrote
    // itself (an API error, an interrupt), which is nobody's model.
    const said = (d) => {
      if (!d || d.isSidechain) return;
      if (!out.branch && typeof d.gitBranch === 'string' && d.gitBranch.trim()) out.branch = d.gitBranch.trim();
      const m = d.type === 'assistant' ? d.message?.model : null;
      if (!out.model && typeof m === 'string' && m.trim() && m !== '<synthetic>') out.model = m.trim();
    };
    const scan = (lines) => {
      for (let i = lines.length - 1; i >= 0 && !(out.branch && out.model); i--) {
        if (lines[i].includes('"gitBranch"') || lines[i].includes('"model"')) said(parse(lines[i]));
      }
    };
    scan(later);
    if (!whole) scan(headLines);
  } finally {
    await fh.close();
  }
  return out;
}

/** The person's own words in a user record — every block that is not injected context. */
function personText(content) {
  const blocks = typeof content === 'string' ? [content]
    : Array.isArray(content) ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text) : [];
  return blocks.filter((b) => !contextTagOf(b)).join('').trim() || null;
}

/**
 * How much of a transcript exists right now.
 *
 * Used as the starting offset when a desk begins following a conversation, so
 * that attaching to one already hours long doesn't replay it onto the floor —
 * while a conversation that is genuinely new starts at 0 and has its opening
 * exchange reported like any other. Guessing this from "is this the first
 * read" instead silently loses the first turns of every new session.
 */
export async function transcriptSize(path) {
  try {
    const { stat } = await import('node:fs/promises');
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** The text of one content block list, ignoring tool calls and thinking. */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
}

/**
 * The tag name if this whole string is machine-injected context —
 * <ide_opened_file>…</ide_opened_file> and kin — else null. Opening and
 * closing names may differ, because a slash command is recorded as one string
 * of several wrappers (<command-name>…</command-args>); the label is the
 * first tag either way. Matched against whole blocks only, never inside one,
 * so nobody's prose is parsed — the worst case, a person whose entire message
 * is one tagged block, renders labeled as context: visible, never lost.
 */
/**
 * The words inside the window's own paste wrapper, with the wrapper gone.
 *
 * Since 2.1.29x a long paste is recorded as
 * `<pasted_content id="4a60">…</pasted_content id="4a60">` — the operator's
 * message, with tags on it that contextTagOf does not match (the tag carries
 * an attribute, and the closing one does too) — so the floor drew the tags
 * as the operator's words. Every pair is unwrapped, by its id, wherever it
 * stands in the block; the wrapper is the window's, the words are the
 * person's. What is sent from the floor avoids the wrapper altogether now
 * (wouldWrap / typeInto); this is for what was pasted by hand.
 */
export function unwrapPaste(s) {
  return String(s ?? '').replace(/<pasted_content id="([^"]*)">\n?([\s\S]*?)\n?<\/pasted_content id="\1">/g, '$2');
}

function contextTagOf(s) {
  const m = /^\s*<([A-Za-z][\w-]*)>[\s\S]*<\/[A-Za-z][\w-]*>\s*$/.exec(s);
  return m ? m[1] : null;
}

/**
 * The only tool_input keys the floor's collapsed line ever reads. A Write of a
 * whole file would otherwise put that file on the network on its way to
 * becoming a one-line summary.
 */
const TOOL_INPUT_KEYS = ['command', 'file_path', 'path', 'pattern', 'description', 'prompt', 'url'];

function reduceToolInput(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const k of TOOL_INPUT_KEYS) {
    if (typeof input[k] === 'string' && input[k].trim()) out[k] = input[k].slice(0, 300);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Read a transcript into turns the floor can render. `after` is a byte offset,
 * so tailing is a read from where the last one stopped rather than a re-parse
 * of a conversation that may be very long.
 */
export async function readTranscript(path, { after = 0, via = null } = {}) {
  if (!existsSync(path)) return { ok: false, error: 'no transcript yet', turns: [], offset: after };
  const { readFile, stat } = await import('node:fs/promises');
  const { size } = await stat(path);
  if (size <= after) return { ok: true, turns: [], offset: size };
  const buf = await readFile(path);
  // Start at the previous offset, but never mid-line: a JSONL file being
  // appended to can be read between the write and its newline.
  const slice = buf.subarray(after).toString('utf8');
  // Splitting on the newline always leaves a final element that is not a
  // finished line — the empty string after a trailing newline, or the half of
  // a line that has been written so far. Either way it is not ours to consume.
  const complete = slice.split('\n').slice(0, -1);
  const consumed = complete.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);

  // This is the floor's only source of conversation turns. The hooks report
  // state — a prompt is open, a turn started, a turn ended — but not content:
  // two sources would file every turn twice, and the transcript is the one
  // Claude Code writes itself, whoever typed and from wherever.
  const turns = [];
  /* The text blocks of a message, whichever shape it was written in: a plain
   * string, or a content-block list with the text blocks picked out. */
  const blocksOf = (content) => (typeof content === 'string' ? [content]
    : Array.isArray(content)
      ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text)
      : []);
  /* A message is not all the person. Claude Code glues injected context onto
   * what somebody typed — IDE state, slash-command records, its own notices —
   * each as its own block (or a whole message of them). Joining every block
   * into one string put that context on the floor as the operator's words,
   * tag and all. The block boundary is the discriminator: a block that is
   * wholly one tagged wrapper becomes a `context` turn labeled by its tag, and
   * only the remaining blocks are the person. One rule for every door a
   * message comes in by — see the two callers. */
  const personTurns = (blocks, at, uuid) => {
    let human = [];
    const flush = () => {
      const text = human.join('');
      if (text.trim()) turns.push({ role: 'user', text, at, uuid });
      human = [];
    };
    for (const raw of blocks) {
      // The wrapper the window puts round a long paste is not the person's
      // words, and the words inside it are — see unwrapPaste.
      const s = unwrapPaste(raw);
      const tag = contextTagOf(s);
      // A command's stdout carries the SGR codes the window printed it with
      // ("\u001b[2mCompacted…"); a context line is read, not rendered.
      if (tag) {
        flush();
        const text = s.replace(SGR, '').trim();
        // A command's output that is only the plugin's hook command echoed
        // back ("Compacted PreCompact [p=$(cat); … report.mjs …] completed
        // successfully", after /compact; pc-developer, task 348 I1): the
        // floor's own plumbing, which nobody reading the desk asked to see.
        if (tag === 'local-command-stdout' && /\[p=\$\(cat\);[\s\S]*report\.mjs/.test(text)) continue;
        turns.push({ role: 'context', text, tool_name: tag, at, uuid });
      } else if (/^\s*\[Request interrupted by user[^\]]*\]\s*$/.test(s)) {
        // Claude Code's own record of a stop (QA, L2: "[Request interrupted
        // by user for tool use]" read as the operator's words). A quiet line.
        flush();
        turns.push({ role: 'context', text: s.trim(), tool_name: 'interrupted', at, uuid });
      } else human.push(s);
    }
    flush();
  };
  for (const line of complete) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }

    /* A message read while the agent was working.
     *
     * This is a user turn by every measure that matters — a person typed it,
     * the agent answered it — and it is the only record of one. Claude Code
     * writes a queued message down in one of two shapes, and which one you get
     * depends on when it was picked up:
     *
     *   drained at the end of a turn → a `user` record, at consumption
     *   injected mid-turn           → this `attachment`, and nothing else
     *
     * Measured, both ways, on 2.1.220. The second shape is now the common one,
     * because the floor stopped holding messages for a working desk — and
     * skipping it meant the operator's own message never appeared in the
     * conversation at all. Seen end to end on the real board: the agent
     * answered "MIDTURN-PROOF-SEEN" six seconds after it was sent, and the
     * floor showed the reply to a question nobody could see being asked.
     *
     * `prompt` was a plain string on 2.1.220 and is a content-block list
     * ([{type:'text',text:'…'}]) by 2.1.251 — read from a live transcript
     * 2026-09-01, after String() turned every mid-turn message on the floor
     * into "[object Object]". textOf handles both, same as a user record.
     *
     * Not deduplicated against the `user` shape, deliberately. The two are
     * exclusive — the same message is never written both ways — and matching
     * on text across reads to guard against it would swallow the case where
     * somebody really does send the same words twice, which on this board is
     * an ordinary thing to do: "nudge" is a word people send repeatedly. If
     * that exclusivity ever stops holding, a message appears twice, which is
     * visible and fixable; the other mistake is silent.
     */
    if (d.type === 'attachment' && d.attachment?.type === 'queued_command' && !d.isSidechain) {
      // Not always a person. Claude Code delivers its own notices through
      // this same queue — a background command finishing, a subagent's result
      // — as one <task-notification> block, and this used to file each as the
      // operator's words: "YOU", over fourteen kilobytes of another agent's
      // report, drawn as plain text because that is what the operator's own
      // typing is drawn as (seen on the qa desk, 2026-09-02). The same block
      // rule a user record gets, so the panel can tell the system from the
      // person here too.
      personTurns(blocksOf(d.attachment.prompt), d.timestamp ?? null, d.uuid ?? null);
      continue;
    }

    // The boundary Claude Code writes when it compacts: a system record, with
    // how much and how long in compactMetadata. Filed as a context line in
    // the compaction's own terms, so the floor can say what happened where
    // it happened; the state while it ran is the hooks' (PreCompact /
    // PostCompact), not this record's — it is written only at the end.
    if (d.type === 'system' && d.subtype === 'compact_boundary' && !via) {
      const m = d.compactMetadata ?? {};
      const n = (x) => (Number.isFinite(Number(x)) ? Number(x).toLocaleString('en-US') : null);
      const secs = Number.isFinite(Number(m.durationMs)) ? `${(Number(m.durationMs) / 1000).toFixed(1)} s` : null;
      const text = `Conversation compacted${m.trigger ? ` (${m.trigger})` : ''}` +
        (n(m.preTokens) && n(m.postTokens) ? `: ${n(m.preTokens)} → ${n(m.postTokens)} tokens` : '') + (secs ? ` in ${secs}` : '');
      turns.push({ role: 'context', text, tool_name: 'compact', at: d.timestamp ?? null, uuid: d.uuid ?? null });
      continue;
    }
    if (d.type !== 'user' && d.type !== 'assistant') continue;
    // Sidechain is a subagent's own conversation. In the session's transcript
    // it is skipped: it belongs inside the tool call that owns it, not beside
    // the turns of the session that spawned it. But it is no longer written
    // there at all — each subagent has a file of its own under
    // <session dir>/subagents/ (see subagentTranscripts), every record flagged
    // isSidechain — and those files are read through here with `via` set,
    // which turns the flag from a filter into a label. Without that the floor
    // showed "Agent: <description>" and then nothing until the report came
    // back, while the editor showed every "Let me search for…" in between
    // (2.1.258, 2026-09-03).
    if (d.isMeta || (d.isSidechain && !via)) continue;
    const at = d.timestamp ?? null;
    const uuid = d.uuid ?? null;

    if (d.type === 'user') {
      // A subagent's user records are its brief — already on the floor as the
      // Agent tool line that spawned it — and its tool results. Neither is a
      // person speaking, so neither is a turn.
      if (via) continue;
      // The summary a compaction leaves behind — "This session is being
      // continued from a previous conversation…", 5–19k characters — is a
      // user record by shape and nobody's words by any other measure. It
      // used to be drawn as "you:" (issue #15). A system record, labeled, for
      // the page to draw collapsed.
      if (d.isCompactSummary) {
        const text = textOf(d.message?.content);
        if (text.trim()) turns.push({ role: 'context', text, tool_name: 'compact-summary', at, uuid });
        continue;
      }
      // A user record is not all the operator — see personTurns.
      personTurns(blocksOf(d.message?.content), at, uuid);
      continue;
    }
    const content = d.message?.content;
    // Not the agent either: the record Claude Code writes when a turn ends in
    // an API error is an assistant record flagged isApiErrorMessage with
    // model "<synthetic>" — measured on an auto-compact that thrashed, whose
    // text ("Autocompact is thrashing: …") the floor had drawn as the agent's
    // own words beside an error saying nothing. Its own role, so the desk
    // reads it as what it is.
    if (d.isApiErrorMessage) {
      const text = signedOutText(textOf(content), d.error);
      if (text.trim()) turns.push({ role: 'error', text, at, uuid, ...(via ? { via } : {}) });
      continue;
    }
    // Nor is any other record Claude Code writes itself under the model
    // "<synthetic>": "No response requested." when a conversation whose
    // turn was cut off is resumed (task 348 F4, measured on 2.1.330), which
    // the floor drew as the agent's own answer. Surfaced as a quiet line,
    // never as the agent's words.
    if (d.message?.model === '<synthetic>') {
      const text = textOf(content);
      if (text.trim()) turns.push({ role: 'context', text, tool_name: 'synthetic', at, uuid, ...(via ? { via } : {}) });
      continue;
    }
    // What the agent thought before it spoke — Claude Code's thinking blocks,
    // which the window draws in dim text ahead of each step. On 2.1.258 they
    // are a sentence or two of narration ("I'll leave the console checkboxes
    // as is since FreshBooks already…"; across one working desk the 90th
    // percentile was under 300 characters), and the operator read exactly
    // that in the window and found nothing on the floor (2026-09-03). Their
    // own role, so no surface files them as the agent's words. Empty blocks
    // are common and are nothing.
    for (const block of Array.isArray(content) ? content : []) {
      if (block?.type !== 'thinking' || typeof block.thinking !== 'string' || !block.thinking.trim()) continue;
      turns.push({ role: 'thinking', text: block.thinking, at, uuid, ...(via ? { via } : {}) });
    }
    const text = textOf(content);
    // Every assistant record names the model that wrote it. Carried on the
    // turn so the desk can follow a mid-session /model — the session's model
    // column is otherwise written once, at SessionStart (issue #10).
    const model = typeof d.message?.model === 'string' && d.message.model && d.message.model !== '<synthetic>' ? d.message.model : null;
    if (text.trim()) turns.push({ role: 'assistant', text, at, uuid, ...(model ? { model } : {}), ...(via ? { via } : {}) });
    else if (model && !via) turns.push({ role: 'model', text: '', model, at, uuid });
    for (const block of Array.isArray(content) ? content : []) {
      if (block?.type !== 'tool_use') continue;
      turns.push({ role: 'tool', text: '', tool_name: block.name ?? 'tool', tool_input: reduceToolInput(block.input), at, uuid, ...(via ? { via } : {}) });
    }
  }
  return { ok: true, turns, offset: after + consumed };
}

/**
 * The subagents of a conversation, each with the transcript it writes.
 *
 * The Agent tool does not write into the transcript of the session that
 * spawned it. Each call gets a file of its own — `<session dir>/subagents/
 * agent-<id>.jsonl`, beside an `agent-<id>.meta.json` naming its type and the
 * description the caller gave it — and the session's transcript holds only
 * the tool_use that started it and the report that came back. Read on a live
 * session, 2.1.258. `label` is that description, which is the same words the
 * editor puts over the block: "Usage-limit warning behaviour".
 *
 * A readdir per desk per tick. Cheap, and it has to be a scan: a subagent can
 * start at any moment, and nothing else announces its file.
 */
/* How long a subagent transcript with no meta file beside it is left unread
   before it is read under its id. See subagentTranscripts. */
const SUBAGENT_META_GRACE_MS = Number(process.env.ORCH_SUBAGENT_META_GRACE_MS ?? 120_000);
/** When each meta-less subagent transcript was first seen, by path. */
const subagentFirstSeen = new Map();

/**
 * A turn that found the desk signed out, in the floor's words: what Claude
 * Code observed ("Not logged in"), and the remedy the floor runs itself, the
 * desk's Sign in. Claude Code's own line ends "Please run /login", a command
 * nobody can type into a desk the host runs (costmo, 2026-11-23, on the app
 * at b1a774a: the proof a user can sign in cannot be a command a user will
 * not run). Measured on 2.1.330 signed out: an assistant record flagged
 * isApiErrorMessage, `error: "authentication_failed"`, text "Not logged in ·
 * Please run /login". The board says it the same way (src/floor.js).
 */
export const SIGNED_OUT_WORDS = 'Not logged in: Claude Code is signed out on this machine. Press Sign in on this desk to sign in again.';
export function signedOutText(text, code = null) {
  return code === 'authentication_failed' || /^\s*Not logged in\b/i.test(String(text ?? '')) ? SIGNED_OUT_WORDS : text;
}

/**
 * Whose ask this is, when a subagent asked: the description its caller gave
 * it, from `agent-<id>.meta.json` beside its transcript (task 352: the floor
 * showed a background subagent's prompt as its parent's). Null when the meta
 * is not there to read; the caller says "a subagent" then.
 */
export function subagentLabel(cwd, sessionId, agentId) {
  if (!cwd || !sessionId || !agentId) return null;
  try {
    const meta = JSON.parse(readFileSync(join(projectDir(cwd), sessionId, 'subagents', `agent-${agentId}.meta.json`), 'utf8'));
    const label = [meta?.description, meta?.agentType].find((v) => typeof v === 'string' && v.trim());
    return label ? String(label).trim().slice(0, 120) : null;
  } catch { return null; }
}

export async function subagentTranscripts(mainPath, { metaGraceMs = SUBAGENT_META_GRACE_MS } = {}) {
  const dir = `${String(mainPath).replace(/\.jsonl$/, '')}/subagents`;
  if (!existsSync(dir)) return [];
  const { readdir, readFile } = await import('node:fs/promises');
  const names = (await readdir(dir).catch(() => [])).filter((n) => /^agent-[^/]+\.jsonl$/.test(n)).sort();
  const out = [];
  for (const name of names) {
    const id = name.slice('agent-'.length, -'.jsonl'.length);
    const path = join(dir, name);
    let meta = null;
    try { meta = JSON.parse(await readFile(join(dir, `agent-${id}.meta.json`), 'utf8')); } catch { /* no meta yet */ }
    // The meta file usually lands in the same second as the transcript, but
    // not always: over 50 real pairs on one machine, two came meta-first and
    // one transcript came 52 seconds before its meta (QA, PR #3 review,
    // 2026-09-03). Reading it in the meantime filed its first turns under the
    // id and the rest under the description, and nothing relabels. So a
    // transcript with no meta is left alone until the meta arrives — its
    // turns are read then, from the first word — and only after a long grace
    // is it read under its id, in case the meta never comes.
    if (!meta) {
      const seen = subagentFirstSeen.get(path) ?? Date.now();
      subagentFirstSeen.set(path, seen);
      if (Date.now() - seen < metaGraceMs) continue;
    } else {
      subagentFirstSeen.delete(path);
    }
    const label = [meta?.description, meta?.agentType].find((v) => typeof v === 'string' && v.trim()) ?? id;
    out.push({
      id, path, label: String(label).trim().slice(0, 120),
      agentType: meta?.agentType ?? null, toolUseId: meta?.toolUseId ?? null,
    });
  }
  return out;
}

/**
 * A model or effort change from the floor, saved as the person's default for
 * new sessions (costmo, 2026-11-22, by AskUserQuestion: "Also save as
 * default", keeping his 2026-11-14 ruling). On the programmatic path Claude
 * Code makes such a change for the one conversation ("Set model to Haiku 5.5
 * for this session only", measured on 2.1.330, settings untouched), so the
 * host writes what the terminal's /model and /effort write, in Claude Code's
 * own shape: `model` as the name given ("opus"), and effort per model under
 * `modelSettings.<model id>.effortLevel`. Only those keys; the rest of the
 * file is left as it is. Written whole to a file beside it and renamed over
 * it, so a reader never meets half a file.
 */
export function saveDefaults({ model = null, effort = null, modelId = null } = {}, file = join(CLAUDE_HOME, 'settings.json')) {
  let d = {};
  try { d = JSON.parse(readFileSync(file, 'utf8')) ?? {}; } catch (err) { if (err.code !== 'ENOENT') return { ok: false, error: `could not read ${file}: ${err.message}` }; }
  // Nothing to write (an effort whose model is not known yet): said, not
  // reported as saved.
  if (!model && !(effort && modelId)) return { ok: true, wrote: false };
  if (model) d.model = model;
  if (effort && modelId) {
    d.modelSettings = d.modelSettings && typeof d.modelSettings === 'object' ? d.modelSettings : {};
    d.modelSettings[modelId] = { ...(d.modelSettings[modelId] ?? {}), effortLevel: effort };
  }
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.orch-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(d, null, 2)}\n`);
    renameSync(tmp, file);
    return { ok: true, wrote: true };
  } catch (err) {
    return { ok: false, error: `could not write ${file}: ${err.message}` };
  }
}

const STOP_TIMEOUT_MS = Number(process.env.ORCH_STOP_TIMEOUT_MS ?? 30_000);
const RELEASE_TIMEOUT_MS = Number(process.env.ORCH_RELEASE_TIMEOUT_MS ?? 10_000);

function heldInBackground(held, why) {
  const job = held.job ?? held.name ?? String(held.pid);
  return {
    ok: false,
    code: 'held_by_background',
    error: `That conversation is running as a background Claude Code session (${job}, pid ${held.pid})${why ? `, and ${why}` : ''}.`,
  };
}

/**
 * Move a conversation out of a background session so the desk can take it.
 *
 * Claude Code's daemon keeps a conversation running after its tab has gone
 * (kind `bg` in its session file, a job id), and answers a `--resume` of it
 * with "running as a background session (<id>) ... claude stop <id> first to
 * resume it here". So this runs `claude stop`, and it is the one thing the
 * host does on the person's behalf. The click on the floor is the handoff,
 * the tab is already closed, so there is nothing of theirs to close, and
 * `claude stop` keeps the conversation in Claude Code's own words (measured
 * 2026-09-09 on 2.1.258). The alternative was a desk that said "run
 * `claude stop 323362b2`" to the people this floor exists to keep out of a
 * terminal, which stranded a working channel for an afternoon. Gone means
 * gone from the roster, not "the command returned".
 *
 * Carried over from the window layer when it was replaced (2026-11-22): the
 * first cut of the process layer refused such a conversation with "close it
 * there", which is the stranding again.
 */
export async function releaseBackground(held) {
  const job = held.job ?? held.name ?? String(held.pid);
  let stopped;
  try {
    stopped = await run(CLAUDE, ['stop', job], { timeout: STOP_TIMEOUT_MS });
  } catch (err) {
    const why = (err?.stderr || err?.stdout || err?.message || String(err)).trim();
    return heldInBackground(held, `\`claude stop ${job}\` did not stop it: ${why}`);
  }
  const until = Date.now() + RELEASE_TIMEOUT_MS;
  for (;;) {
    const r = await roster();
    if (r.ok && !r.sessions.some((x) => x.pid === held.pid)) return { ok: true, job };
    if (Date.now() >= until) {
      return heldInBackground(held, `\`claude stop ${job}\` said "${(stopped?.stdout ?? '').trim()}" but the session was still running ${RELEASE_TIMEOUT_MS / 1000}s later`);
    }
    await new Promise((res) => setTimeout(res, 250));
  }
}

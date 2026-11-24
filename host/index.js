#!/usr/bin/env node
/**
 * The orchestratinator host: this workstation's link between the floor and the
 * Claude Code conversations here.
 *
 * Each desk's Claude Code is a process this host runs and speaks to as data,
 * through Claude Code's stream-JSON interface (host/agent.js, host/desk.js).
 * A conversation is one process, so one app holds it at a time: the floor,
 * or the operator's editor or terminal after a handoff (CLAUDE.md, "The one
 * rule everything else follows from"). Until 0.15.0 desks ran in tmux
 * windows that the host typed into and read back; that layer is gone, and
 * an upgrade ends the windows it left (W.endLegacyWindows).
 *
 * What this process actually does:
 *
 *   - enumerates the repos here that belong to the board (each one's
 *     `.mcp.json` says which desk it is),
 *   - reads Claude Code's roster for which conversations are live, and whose,
 *   - tails each live session's own transcript and sends the turns up, so a
 *     turn you type in your own terminal appears on the floor with nothing
 *     reporting it,
 *   - and does what the floor asks: deliver a message, answer a permission
 *     prompt or a question, stop a turn, start a desk's Claude Code.
 *
 * It only ever reaches out. The server never connects to this machine and
 * nothing here listens on a port. If the server is down it retries with
 * backoff; if this host is down the floor says so.
 *
 *   ORCH_HOST_ROOTS   colon-separated directories to look for repos under
 *   ORCH_URL          the board, e.g. http://localhost:8787 (from .mcp.json if unset)
 *   ORCH_AUTH_TOKEN   the shared secret                     (from .mcp.json if unset)
 *   ORCH_HOST_NAME    how this machine shows on the floor   (hostname if unset)
 *   ORCH_TMUX_SESSION the tmux session 0.14.x ran desks in, whose windows
 *                     an upgrade ends (orch)
 *   ORCH_HOST_SUPERVISOR who restarts this process: `app` for the desktop
 *                     app (launchd is read from XPC_SERVICE_NAME) — host/update.js
 *   ORCH_FOLDER_DIALOG  a program to run as the folder dialog, or `parent` to
 *                     ask the process that started this one — host/dialog.js
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { discover, listFolder, localEntries, originOf, readDesk, readLocalScope } from './identity.js';
import * as W from './claude.js';
import { Desk } from './desk.js';
import * as M from './mcp.js';
import * as S from './seats.js';
import * as D from './dialog.js';
import * as H from './history.js';
import * as U from './update.js';
import * as UP from './uploads.js';
import * as A from './auth.js';
import * as V from './version.js';
import * as C from './canary.js';
import { log, warn, error, failureOf, requestFailed } from './log.js';

// The installer's line for giving the host its key, in this platform's own
// words (pc-developer, task 348 I4: a Windows host told its person to run
// ./host/install.sh).
const INSTALL_TOKEN_LINE = process.platform === 'win32'
  ? 'powershell -ExecutionPolicy Bypass -File host\\install.ps1 -Token <the ORCH_AUTH_TOKEN from the server\'s .env> <your projects folder>'
  : './host/install.sh --token <the ORCH_AUTH_TOKEN from the server\'s .env> <your projects dir>';
// How long after Open in Claude or Open in VS Code the host also reads the
// process table for the conversation's new holder (task 348 F6).
const HANDOFF_WATCH_MS = 30 * 60_000;
const CONFIG_FILE = process.env.ORCH_HOST_CONFIG ?? join(homedir(), '.orchestratinator', 'host.json');
// What the protocol probe said about each Claude Code version this host has
// seen (task 351), beside host.json; and the folder it runs in, kept, so
// Claude Code's own list of projects gains one entry, not one a run.
const CANARY_FILE = process.env.ORCH_CANARY_FILE ?? join(dirname(CONFIG_FILE), 'claude-canary.json');
const CANARY_DIR = join(dirname(CONFIG_FILE), 'canary');
/** Which folders' board-tool allow rule this machine's host wrote (task 352
 *  B, host/mcp.js), beside the desk-pid record, so Leave removes only that. */
const BOARD_TOOLS_RECORD = join(dirname(W.deskPidsFile('host')), 'board-tools-allowed.json');
/** How long a queued permission answer stays worth delivering. */
const ANSWER_TTL_MS = Number(process.env.ORCH_ANSWER_TTL_MS ?? 30_000);
const HEARTBEAT_MS = Number(process.env.ORCH_HOST_HEARTBEAT_MS ?? 60_000);
/** How often a startup question still on screen is said to the board again. */
const STARTUP_RESAY_MS = Number(process.env.ORCH_STARTUP_RESAY_MS ?? 60_000);
/** How often a registered floor window's screen is read for a dialog or a screen the floor does not know (Desk.tick). */
const SCREEN_LOOK_MS = Math.max(500, Number(process.env.ORCH_SCREEN_LOOK_MS ?? 3000));
/** How long a screen the floor does not know must stand unchanged before the desk says so. */
const UNKNOWN_SETTLE_MS = Math.max(0, Number(process.env.ORCH_UNKNOWN_SETTLE_MS ?? 2500));
/** How long a host told to stop waits for the item in hand to finish (stop()). */
const STOP_DRAIN_MS = Number(process.env.ORCH_STOP_DRAIN_MS ?? 15_000);
const WORK_WAIT_S = Math.max(1, Number(process.env.ORCH_HOST_POLL_WAIT ?? 25));
/** How often the roster and the transcripts are re-read. */
const WATCH_MS = Math.max(250, Number(process.env.ORCH_HOST_WATCH_MS ?? 700));
/* test:host's seam for the move race (bind): ms to hold after a bind's rescan. */
const BIND_GAP_MS = Math.max(0, Number(process.env.ORCH_HOST_BIND_GAP_MS ?? 0) || 0);
// How much of a conversation the board has never seen goes up when it is
// reopened from the picker — see Desk.follow's 'tail'.
const TAIL_BYTES = Number(process.env.ORCH_TAIL_BYTES ?? 64 * 1024);
// The picker's list: newest first, by file. See sessionsIn in window.js.
const SESSIONS_LIMIT = Number(process.env.ORCH_SESSIONS_LIMIT ?? 30);
// Settable only so the host suite can watch a request time out without
// waiting five seconds for each one; nothing installed sets it.
const REQUEST_TIMEOUT_MS = Number(process.env.ORCH_REQUEST_TIMEOUT_MS ?? 5_000);
// A conversation read whole goes up in pages: so many turns, or so many
// characters, whichever comes first — one long reply must not make a page
// the board's body limit refuses.
const READ_PAGE_TURNS = Number(process.env.ORCH_READ_PAGE_TURNS ?? 200);
const READ_PAGE_CHARS = Number(process.env.ORCH_READ_PAGE_CHARS ?? 256 * 1024);
// A search of every transcript runs as host/history.js in a process of its
// own, and is ended if it has not answered in this long.
const HISTORY_SCRIPT = fileURLToPath(new URL('./history.js', import.meta.url));
const SEARCH_TIMEOUT_MS = Number(process.env.ORCH_SEARCH_TIMEOUT_MS ?? 60_000);
// Under the desktop app the search cannot be a process: the host runs in
// Electron's utility process, whose execPath is the app's binary, and the
// app's RunAsNode fuse is off. So there it is a worker thread (history.js
// says why that keeps what the process was for). Everywhere else it is the
// process, as it always was. ORCH_SEARCH_IN=worker is the suites' seam for
// the app's path under plain Node; nothing installed sets it.
const SEARCH_IN_WORKER = !!process.versions.electron || process.env.ORCH_SEARCH_IN === 'worker';
/** How long a request for the folder dialog stays worth acting on — shorter
 *  than the 8 s the page waits, on purpose, so a dialog that does open is one
 *  the page is still there to hear about. See D.pickIsStale. */
const PICK_TTL_MS = Number(process.env.ORCH_PICK_TTL_MS ?? 6_000);

/**
 * Which key answers a permission prompt in Claude Code's own dialog. The floor
 * knows a prompt is open because the plugin's PermissionRequest hook says so —
 * structured, not scraped — and this is how the answer is typed back in.
 *
 * Deny is Escape, not a number. Claude Code's prompts do not have a fixed shape:
 * some offer three options ("Yes" / "Yes, and don't ask again" / "No"), some
 * only two ("Yes, allow reading from etc/" / "No"), and the folder-trust dialog
 * has its own. A deny that pressed "3" would do nothing at all on a two-option
 * prompt — leaving it open while the floor reported it answered — and on some
 * other shape could land on an option that is not a refusal. Escape is offered
 * by every one of them ("Esc to cancel") and was verified against a live prompt
 * to produce `The tool use was rejected`.
 *
 * Allow is "1" because the first option is the affirmative in every dialog, and
 * a number is immune to the selection having been moved by whoever is sitting
 * at the window.
 */
// The three that are always offered. Fallbacks only: when the board has read the
// window's own list it sends the option's number instead, because "No" is not
// always 3 and Escape is a different thing from choosing it — the prompt's own
// footer says so ("3. No" beside "Esc to cancel").
const ANSWER_KEY = { allow: '1', deny: 'Escape', cancel: 'Escape' };

/* The same two keys, for a prompt nothing could read. Deliberately only two:
   "interrupt" is not here because it already has its own path, which stops the
   turn rather than guessing at an answer. */
const PRESS_KEY = { yes: '1', no: 'Escape' };

/* ───────────────────────── configuration ───────────────────────── */

function loadConfig() {
  let file = {};
  if (existsSync(CONFIG_FILE)) {
    try { file = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { warn(`could not read ${CONFIG_FILE}: ${e.message}`); }
  }
  // Split on the platform's own list separator: ':' cuts a Windows root at
  // its drive letter (`C:\Users\…`, pc-developer, 2026-11-20), and ';' is
  // what PATH and every other list there uses.
  const roots = (process.env.ORCH_HOST_ROOTS ? process.env.ORCH_HOST_ROOTS.split(delimiter) : file.roots ?? [process.cwd()])
    .map((r) => r.replace(/^~(?=$|[\\/])/, homedir()))
    .filter(Boolean);
  return {
    roots,
    // Where the roots came from, because a folder taken from the picker
    // outside them is added to them — in memory always, and in the file when
    // the file is what they were read from. See Host.addRoot.
    rootsFrom: process.env.ORCH_HOST_ROOTS ? 'ORCH_HOST_ROOTS' : 'file',
    url: process.env.ORCH_URL ?? file.url ?? null,
    token: process.env.ORCH_AUTH_TOKEN ?? file.token ?? null,
    // Where the token came from, for the log and for rescan(): a desk's own
    // key outranks both of these, and only these — see main().
    tokenSource: process.env.ORCH_AUTH_TOKEN ? 'ORCH_AUTH_TOKEN' : file.token ? `token in ${CONFIG_FILE}` : null,
    name: process.env.ORCH_HOST_NAME ?? file.name ?? hostname(),
    hostId: process.env.ORCH_HOST_ID ?? file.host_id ?? hostname(),
  };
}

/* ───────────────────────── one desk ───────────────────────── */

// A desk, and the Claude Code the host runs for it, is host/desk.js since the
// window layer was replaced (costmo, 2026-11-22).

/* ───────────────────────── the host ───────────────────────── */

class Host {
  constructor(cfg) {
    this.cfg = cfg;
    this.desks = new Map();
    // Which run of this host it is, so the board can tell work an earlier run
    // took and never finished from work this one is doing (takeHostWork in
    // src/db.js; milestone audit 2026-11-17, finding 4). With what is
    // finished and not yet said (`acks`, sent on the next work poll), what
    // was taken and not started (`inHand`), and the item being carried out.
    this.boot = randomUUID();
    this.acks = [];
    this.inHand = [];
    this.current = null;
    // A move's reopen intent, keyed like `desks`, for the rescan to set on the desk it creates (bind).
    this.intents = new Map();
    // Claude Code's sign-in on this machine (host/auth.js): `status` is what
    // `claude auth status` last said (null: never asked, or it could not
    // say), `said` that a window has recorded "Not logged in" since the last
    // sign-in or reply, and `signing` the sign-in running now, if any. Work
    // for the host's own line that a sign-in left behind goes in `later`.
    this.auth = { status: null, said: false, signing: null };
    this.later = [];
    // What discover() last found under the roots that could become a desk;
    // posted with every registration. See rescan().
    this.folders = [];
    this.outbox = [];
    this.flushTimer = null;
    this.stopping = false;
    // The folder dialog on this machine's screen, while one is open. See pick().
    this.picking = null;
    // The update being carried out, if one is. See update().
    this.updating = null;
    // The search of this machine's transcripts that is running, if one is. See search().
    this.searching = null;
  }

  /**
   * One request to the board. A failure is thrown as one sentence naming the
   * request, the board, what failed and how long it waited (requestFailed in
   * host/log.js) — and every caller logs err.message as it always has, so
   * the run loop's one warn and the events warn say it without being told.
   * Until issue #5 only a non-2xx reply named even its path; a refusal and a
   * timeout reached the log as `fetch failed` and "The operation was aborted
   * due to timeout", for the register, the work poll and the events alike.
   */
  async request(path, { method = 'GET', body, timeout = REQUEST_TIMEOUT_MS } = {}) {
    const url = `${this.cfg.url}${path}`;
    const started = Date.now();
    const failed = (what) => new Error(requestFailed({ method, url, what, waitedMs: Date.now() - started, limitMs: timeout }));
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json', 'x-orchestratinator-key': this.cfg.token ?? '' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      throw failed(failureOf(err));
    }
    if (!res.ok) {
      // A refusal's words ride on the error, for the one caller that acts
      // on them (register(), a protocol mismatch). Read best-effort: a
      // board that answered with no JSON is still a plain status.
      const err = failed(`→ ${res.status}`);
      err.status = res.status;
      try { err.body = await res.json(); } catch { err.body = null; }
      throw err;
    }
    // The signal covers the body too, so a board that sends its headers and
    // then stalls times out here, after the status said 200.
    try { return await res.json(); } catch (err) { throw failed(`→ ${res.status}, body ${failureOf(err)}`); }
  }

  /**
   * The environment a desk's Claude Code runs in: a person's own, nothing of
   * this host's settings (W.windowEnv, 0.14.4's ruling), with the board's key
   * where the binding names a variable for it, and for a seat the four that
   * tell the plugin's hook which desk it is (host/seats.js).
   */
  agentEnv(desk) {
    const env = W.windowEnv();
    if (desk.seat) {
      const [channel, agent] = String(desk.seat).split('/').map((part) => { try { return decodeURIComponent(part); } catch { return part; } });
      Object.assign(env, { ORCH_DESK_CONFIG: S.configPath(desk.seat), ORCH_DESK_ROOT: desk.cwd, ORCH_CHANNEL: channel, ORCH_AGENT: agent });
      return env;
    }
    const kv = W.paneEnv(readDesk(desk.cwd));
    if (kv.length) { const at = kv[1].indexOf('='); env[kv[1].slice(0, at)] = kv[1].slice(at + 1); }
    return env;
  }

  /** The pids of the Claude Codes this host runs for its desks, and for its seats alone. */
  ourPids() { return new Set([...this.desks.values()].filter((d) => d.running).map((d) => d.proc.pid)); }
  /** Kept on disk at each start and exit of a desk's process, so the next
   *  run can end what a crash left (W.endLeftoverDesks, task 340). */
  notePids() {
    const rows = [...this.desks.values()].filter((d) => d.running).map((d) => ({ pid: d.proc.pid, cwd: d.cwd, session: d.sessionId ?? d.lastSessionId ?? null }));
    W.noteDeskPids(W.deskPidsFile(this.cfg.hostId), rows);
  }

  /**
   * Check a Claude Code version this host has not checked with the protocol
   * probe (host/canary.js, task 351; costmo, 2026-11-23: "Orchestratinator
   * breaks every time anything comes in even with the slightest difference
   * from before"). Once per version per machine, kept in CANARY_FILE; run
   * in the background, one at a time; desks are not held by it. A probe
   * whose first message does not come back (not signed in, no network) is
   * kept as "could not be checked" with why, and not run again for that
   * version: it does not loop. A machine signed out is not probed at all
   * until it is signed in. \`ORCH_CANARY=off\` (the suites) runs nothing;
   * \`ORCH_CANARY_STANDIN\` names a module whose probeClaude stands in.
   */
  canaryCheck(version) {
    if (!version || process.env.ORCH_CANARY === 'off' || this.canaryRunning) return;
    const read = () => { try { return JSON.parse(readFileSync(CANARY_FILE, 'utf8')) ?? {}; } catch { return {}; } };
    const known = read()[version];
    if (known) { this.canary = known; return; }
    if (this.signedOut()) return;
    this.canaryRunning = true;
    log(`checking Claude Code ${version} with the protocol probe (about a minute, a dozen short haiku turns)`);
    const at = () => new Date().toISOString();
    const probe = process.env.ORCH_CANARY_STANDIN
      ? import(pathToFileURL(process.env.ORCH_CANARY_STANDIN).href).then((m) => m.probeClaude)
      : Promise.resolve(C.probeClaude);
    probe
      .then((fn) => fn({ claude: W.CLAUDE, model: 'haiku', dir: CANARY_DIR }))
      .then((r) => {
        const first = r.rows.find((x) => /the turn ends in one result/.test(x.what));
        if (!r.total || (first && !first.ok)) return { version, at: at(), error: `its first message did not come back (${first?.saw || 'no answer'}), so nothing could be compared` };
        return { version, at: at(), ok: r.fails === 0, total: r.total, differed: r.rows.filter((x) => !x.ok).map(({ what, saw }) => ({ what, saw })) };
      }, (err) => ({ version, at: at(), error: err.message }))
      .then((res) => {
        const all = read();
        all[version] = res;
        try {
          mkdirSync(dirname(CANARY_FILE), { recursive: true });
          writeFileSync(`${CANARY_FILE}.${process.pid}`, `${JSON.stringify(all, null, 2)}\n`);
          renameSync(`${CANARY_FILE}.${process.pid}`, CANARY_FILE);
        } catch (err) { warn(`the protocol probe's result for ${version} could not be kept (${err.message}); it will run again`); }
        this.canary = res;
        this.emit({ type: 'canary', canary: res }, true);
        const words = res.error
          ? `Claude Code ${version} could not be checked with the floor's protocol probe: ${res.error}`
          : res.ok
            ? `Claude Code ${version} checked with the floor's protocol probe: it speaks what the floor reads (${res.total} of ${res.total})`
            : `Claude Code ${version} answered ${res.differed.length} of the floor's ${res.total} protocol checks differently from what it was built on; the floor names them at the top`;
        log(words);
        // After the first registration: before it, a desk new to this board
        // has no row there and what is said about it is dropped.
        const tell = () => { for (const d of this.desks.values()) d.told(words); };
        if (this.registered) tell(); else (this.afterRegister ??= []).push(tell);
      })
      .finally(() => { this.canaryRunning = false; });
  }

  /** End the windows an earlier host ran this host's desks in (W.endLegacyWindows); say each on its desk. */
  async sweepLegacy({ deferTold = false } = {}) {
    const desks = [...this.desks.values()];
    const { ended, waiting } = await W.endLegacyWindows(desks.map((d) => d.cwd));
    for (const l of ended) {
      const desk = desks.find((d) => W.canonical(d.cwd) === l.cwd && !d.seat) ?? desks.find((d) => W.canonical(d.cwd) === l.cwd);
      const words = `the host ended the tmux window an earlier version ran this desk's Claude Code in (${l.name ? `window ${l.name}, ` : ''}pid ${l.pid ?? 'unknown'}), so its conversation continues here; the next message resumes it`;
      // Said after the first registration when asked: before it, a desk new
      // to this board has no row there and the board drops what is said.
      const say = () => (desk ? desk.told(words, l.session ?? undefined) : log(words));
      if (deferTold) (this.afterRegister ??= []).push(say); else say();
    }
    if (waiting.length && !this.legacyWaiting) for (const w of waiting) log(`left the tmux window an earlier version ran ${w.cwd} in (pid ${w.pid}) to finish its turn; the floor takes it over when it ends`);
    this.legacyWaiting = waiting.length > 0;
  }
  seatPids() { return new Set([...this.desks.values()].filter((d) => d.running && d.seat).map((d) => d.proc.pid)); }

  /** A seat's own binding file, which its Claude Code is started with; none for a folder's own desk. */
  seatConfig(desk) { return desk.seat ? S.configPath(desk.seat) : null; }

  emit(ev, now = false) {
    this.outbox.push(ev);
    if (now) return this.flush();
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 150);
    return undefined;
  }

  /**
   * One batch on the wire at a time, in the order the events were said. An
   * urgent event used to start a POST of its own beside one still in flight,
   * and the board took whichever landed first: a turn's `working` could land
   * after its `idle`, and the desk read working until the next turn (the
   * host suite under load, 2026-11-22). A flush asked for meanwhile waits
   * for the one sending, then sends what has gathered.
   */
  flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.flushing = (this.flushing ?? Promise.resolve()).then(() => this.sendOutbox());
    return this.flushing;
  }

  async sendOutbox() {
    if (!this.outbox.length) return;
    const events = this.outbox.splice(0);
    try {
      await this.request('/api/host/events', { method: 'POST', body: { host_id: this.cfg.hostId, events } });
    } catch (err) {
      warn(`events not delivered (${err.message}); will retry with the next batch`);
      this.outbox.unshift(...events);
      if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 1000);
    }
  }

  async register() {
    // Which Claude Code runs here, and a change said on every desk this host
    // runs (host/version.js: report only, never a gate). Read before the
    // desks, so the line reaches the board in this heartbeat's events.
    const cv = await V.claudeVersion();
    if (cv) {
      const change = V.versionChange(V.lastVersion(this.cfg.hostId), cv);
      if (change) {
        log(`Claude Code is now ${change.to} on this machine (it was ${change.from})`);
        for (const d of this.desks.values()) d.told(V.versionWords(this.cfg.name, change));
      }
      V.keepVersion(this.cfg.hostId, cv);
      this.claudeVersion = cv;
      this.canaryCheck(cv);
    }
    // Where each desk stands, reported every time rather than once. `window`
    // is the desk's own Claude Code while the host runs one (`proc:<pid>`),
    // the mark the board has always read as "the floor holds it"; and
    // `outside_pid` a Claude Code somebody else runs on its conversation (a
    // terminal or an editor). What a desk's Claude Code is asking is said
    // again as `ask` events, so a board that restarted raises it again.
    const desks = [];
    for (const d of this.desks.values()) {
      for (const ev of d.standingAsks()) this.emit(ev);
      desks.push({
        channel: d.channel, agent: d.agent, cwd: d.cwd, scope: d.scope,
        session_id: d.sessionId ?? d.lastSessionId,
        // The same mark as the desk's holder report: a registration that
        // said null for an earlier version's window mid-turn put the desk
        // back to unheld at every heartbeat (patch E's row, which reads past
        // the first registration).
        window: d.windowMark,
        outside_pid: d.running ? null : d.outsidePid,
        window_open: d.windowMark,
        holders: d.holders ?? 0,
      });
    }
    // The folders too, with paths and roots spelled the one way the board
    // will compare them, and a mark on any bound to some other board — the
    // origin is this host's to know, not the walk's.
    const origin = originOf(this.cfg.url);
    const roots = this.cfg.roots.map((r) => W.canonical(r));
    const folders = (this.folders ?? []).map((f) => ({
      ...f,
      path: W.canonical(f.path),
      other_board: f.bound && f.bound.board !== origin ? f.bound.board : null,
    }));
    // And whether this machine can show its own folder dialog, so the page
    // knows which picker to draw before anybody clicks: the native one, or its
    // own list for a host with no backend. See host/dialog.js.
    // And that it can release a folder from another instance (`release`,
    // see bind): a host from before that would read the work as a plain take
    // and leave the old binding standing beside the new one, so the board
    // asks only a host that says it can.
    // And itself: the build it runs, the clone it runs from, and the board
    // container that clone's compose project runs here, if any. That is how
    // the board knows which host can update it, and what an update would be
    // refused for before anyone presses it (issue #40, host/update.js).
    const me = await U.selfReport().catch((err) => ({ clone: { path: U.CLONE, error: err.message }, protocol: U.BUILD.protocol, supervisor: U.supervisor() }));
    let reply;
    try {
      reply = await this.request('/api/host/register', {
        // `seats`: this host can put a second desk in a folder (sit()). A board
        // asks only a host that says so; an older one would ignore the work.
        // `uploads`: it fetches a message's attachments (host/uploads.js); a
        // board refuses files to a host that does not say so.
        method: 'POST', body: { host_id: this.cfg.hostId, name: this.cfg.name, desks, tmux: null, roots, folders, dialog: D.hasDialog(), release: true, seats: true, uploads: true, reconnect: true, signin: true, signed_out: this.signedOut(), boot: this.boot, claude_version: this.claudeVersion ?? null, canary: this.canary ?? null, ...me },
      });
    } catch (err) {
      // The board refusing this host for its protocol (protocolRefusal in
      // src/floor.js): its words go to the log and to whoever started this
      // process, once per wording, and the host keeps trying on the run
      // loop's backoff — a board rebuilt beside a running host is this for
      // the seconds until the host restarts, and the desktop app shows the
      // words until one side is updated.
      if (err.body?.code === 'protocol_mismatch') {
        const why = err.body.error;
        if (why !== this.refusedWhy) {
          error(`registration refused: ${why}`);
          this.refusedWhy = why;
          D.tellParent({ type: 'registration', state: 'refused', what: 'protocol', why, board: err.body.board ?? null, host: err.body.host ?? null });
        }
        throw new Error(`registration refused (protocol ${err.body.host?.protocol ?? 'none'} here, ${err.body.board?.protocol ?? '?'} at the board)`);
      }
      throw err;
    }
    if (this.refusedWhy) {
      log('registration accepted again');
      this.refusedWhy = null;
      D.tellParent({ type: 'registration', state: 'accepted' });
    }
    // Take back the conversation ids the board is holding. A restarted host
    // has none of its own, and without them the next message from the floor
    // starts a new conversation instead of continuing the one on screen.
    for (const d of Array.isArray(reply?.desks) ? reply.desks : []) {
      const desk = this.desks.get(`${d.channel}|${d.agent}`);
      if (desk && !desk.lastSessionId && d.sdk_session_id) await desk.follow(d.sdk_session_id);
    }
    return reply;
  }

  /**
   * Look at the roots again, and take up whatever has appeared, moved or gone
   * since the last look.
   *
   * discoverDesks() used to run once, in main(), and the list it returned was
   * this host's for life. That made the most ordinary thing a person does —
   * point a repo's .mcp.json at this board, or at a new channel, and open
   * Claude Code in it — the one thing the floor could not follow: the hooks
   * reported the desk within a second (they read .mcp.json per event) while
   * the host went on serving the list it had at boot, and the compose box said
   * "No host on this board is running that repo" until somebody restarted a
   * launchd job. Closing the editor, reopening it and reloading the page all
   * correctly changed nothing. Restarting a service is not an acceptable price
   * for editing a file, so the host looks again: before every heartbeat on its
   * own, and on request (a `rescan` work item), which the board sends the
   * moment a session starts in a repo no host runs. The walk is shallow — see
   * discoverDesks — and measured at ~200ms over a real projects directory.
   *
   * A desk that has moved (same name, different repo) is a different desk and
   * gets a fresh Desk: it reads its own transcript from its own offset rather
   * than carrying the old repo's. A desk that is gone is dropped here, and the
   * next register() — which names every desk this host has, every time — is
   * how the board learns to mark it offline.
   */
  async rescan(reason = 'heartbeat') {
    const origin = originOf(this.cfg.url);
    const seenNow = discover(this.cfg.roots);
    // What is under the roots that could become a desk, for the floor's
    // "take a desk" dialog. Carried on the next register(): a bind, a move
    // and a leave each end in a rescan, so the list is fresh within a second
    // of any change made from here, and the board's "look again" is a rescan.
    this.folders = seenNow.folders;
    const found = seenNow.desks.filter((d) => originOf(d.url) === origin);
    const seen = new Set();
    let changed = false;
    for (const d of found) {
      const k = `${d.channel}|${d.agent}`;
      seen.add(k);
      // A seat's binding file, written at every look: it carries the board's
      // address and key as this host holds them now, and a window for the
      // seat is started with it (host/seats.js).
      if (d.seat) {
        try { S.writeConfig(d, { url: `${this.cfg.url}/mcp`, key: this.cfg.token }); } catch (err) { warn(`${d.channel}/${d.agent}: could not write its binding file — ${err.message}`); }
      }
      // A desk's own key outranks the environment and host.json — the rule
      // main() applies at boot, kept here for a desk bound after it. A host
      // installed before any repo was bound has no key at all, and the first
      // desk to appear is where one comes from. Never a second desk's over a
      // first's: one board takes one key, and flipping between two would make
      // every other request fail in turn.
      if (d.key && d.key !== this.cfg.token && this.cfg.tokenSource !== 'a desk') {
        log(`shared secret: now from ${d.channel}/${d.agent}'s ${d.scope === 'local' ? 'local-scope entry' : '.mcp.json'}${this.cfg.tokenSource ? `, which overrides ${this.cfg.tokenSource}` : ''}  (${reason})`);
        this.cfg.token = d.key;
        this.cfg.tokenSource = 'a desk';
        W.useKey(d.key);
      }
      const have = this.desks.get(k);
      if (have && have.cwd === W.canonical(d.cwd) && (have.seat ?? null) === (d.seat ?? null)) {
        // Same repo, same conversation — only where the binding is written
        // may have changed, which a floor import does (.mcp.json → local
        // scope). Not a new desk; say where it is bound now and carry on.
        if (d.server && have.server !== d.server) have.server = d.server;
        if (have.scope !== d.scope) {
          have.scope = d.scope;
          log(`desk ${d.channel}/${d.agent} is now bound in ${d.scope} scope  (${reason})`);
          changed = true;
        }
        continue;
      }
      // A desk replaced (moved to another folder) ends its Claude Code: the
      // process belongs to the folder it was started in.
      if (have?.running) have.stop().catch(() => {});
      const made = new Desk(this, d);
      // A move's intent, from bind(): on the desk from its first tick.
      if (this.intents.has(k)) made.intent = this.intents.get(k);
      this.desks.set(k, made);
      log(`${have ? 'moved' : 'found'} desk ${d.channel}/${d.agent}  ${d.cwd}  (${d.seat ? 'a seat beside the folder\'s own desk' : `${d.scope} scope`}, ${reason})`);
      changed = true;
    }
    for (const [k, desk] of this.desks) {
      if (seen.has(k)) continue;
      this.desks.delete(k);
      // Its Claude Code ends with it: a desk let go (left, moved, released
      // to another instance) must not go on talking to this board.
      if (desk.running) desk.stop().catch(() => {});
      log(`dropped desk ${desk.label} — ${desk.seat ? `its seat at ${desk.cwd} is gone` : `${desk.cwd} no longer binds it to ${origin}`}  (${reason})`);
      changed = true;
    }
    return changed;
  }

  /** Re-read the roster and each desk's transcript. This is the whole of how
   *  the floor learns what is happening — no hook has to report a turn. */
  async watch() {
    const r = await W.roster();
    if (!r.ok) return;
    // Every live session per directory, not the newest one.
    //
    // A repo routinely has several conversations open at once — two editor
    // tabs, an old one reopened to look something up. Reducing them to
    // "newest" made a desk change conversation whenever a tab closed: the
    // history on the floor vanished and the next message landed in whichever
    // one happened to win. A desk is one conversation; it picks its own.
    const byCwd = new Map();
    for (const s of r.sessions) {
      if (s.kind !== 'interactive') continue;
      if (!byCwd.has(s.cwd)) byCwd.set(s.cwd, []);
      byCwd.get(s.cwd).push(s);
    }
    // A folder can hold several desks (host/seats.js), each with a Claude
    // Code of its own. A desk's sessions are its own process's and anybody
    // else's in the folder (a terminal, an editor), never another desk's.
    const ours = new Map([...this.desks.values()].filter((d) => d.running).map((d) => [d.proc.pid, d]));
    // A terminal's or an editor's Claude Code that the roster does not list
    // yet (W.resumingProcesses), looked for only while a handoff is recent
    // (HANDOFF_WATCH_MS): that is when one is waiting on the trust question.
    // Every 2 s, every 5 s on Windows, where asking the system is slow. A
    // desk being started looks for itself as well (Desk.ensure).
    const handing = [...this.desks.values()].some((d) => d.handedOffAt && Date.now() - d.handedOffAt < HANDOFF_WATCH_MS);
    if (!handing) this.resuming = new Map();
    else if (!this.resumingAt || Date.now() - this.resumingAt > (process.platform === 'win32' ? 5000 : 2000)) {
      this.resumingAt = Date.now();
      try { this.resuming = await W.resumingProcesses(); } catch { this.resuming = new Map(); }
    }
    for (const desk of this.desks.values()) desk.resuming = this.resuming ?? new Map();
    for (const desk of this.desks.values()) {
      // A seat's are its own process's only; the folder's own desk has the
      // rest, an editor's or a terminal's included (host/seats.js).
      const live = (byCwd.get(desk.cwd) ?? []).filter((s) => (desk.seat ? ours.get(s.pid) === desk : !ours.has(s.pid) || ours.get(s.pid) === desk));
      try { await desk.watch(live); } catch (err) { warn(`${desk.label}: ${err.message}`); }
    }
  }

  /**
   * Where a desk's folder is bound right now, read off the disk: null when
   * that is still this desk on this instance, otherwise what it says instead.
   *
   * A host learns that a binding has gone at its next rescan, up to a
   * heartbeat later, and until then acts on the desk as its own. That was
   * harmless while the only thing that removed a binding was this host's
   * own leave. A release is another instance's host rebinding the folder
   * (see bind), and this host is the one being left: it would open a window
   * in a folder that now answers to the other instance, type the old
   * floor's messages into it, and relay its conversation back. So the two
   * moments that matter look first: work for the desk (handle), and a
   * window coming up in its folder (Desk.watch).
   *
   * A local-scope file that cannot be read says nothing either way, and
   * nothing is concluded from it: Claude Code rewrites it constantly, and a
   * read that lands mid-write must not cost a desk.
   */
  boundAt(desk) {
    // A seat is bound by this host's own record, never by the folder's
    // entry: the folder names its own desk, which is the point of a seat
    // (host/seats.js). Read against the folder, as it was from the merge of
    // seats (main, 0.12.9) into a develop that had this check (0.12.7)
    // until 0.14.4, every seat read as released: its window coming up and
    // every piece of work for it, Leave included, let it go, and the rescan
    // found it again from its record at once. The host log said so every
    // watch tick; the floor showed "not done: … is <folder's desk> on this
    // instance now" on every message, and a seat that could not be left.
    if (desk.seat) {
      const origin = originOf(this.cfg.url);
      const still = S.listSeats().some((s) => s.channel === desk.channel && s.agent === desk.agent && s.board === origin);
      return still ? null : { says: 'no longer a seat here' };
    }
    const local = readLocalScope();
    if (!local.ok) return null;
    const now = readDesk(desk.cwd, local);
    if (now && originOf(now.url) === originOf(this.cfg.url) && now.channel === desk.channel && now.agent === desk.agent) return null;
    return { says: !now ? 'bound to nothing' : originOf(now.url) === originOf(this.cfg.url) ? `${now.channel}/${now.agent} on this instance` : `bound to ${originOf(now.url)}` };
  }

  /** Drop a desk whose folder no longer binds it here, now rather than at the
   *  next heartbeat, and say so. True when it was let go. */
  async letGoIfReleased(desk, when) {
    const gone = this.boundAt(desk);
    if (!gone) return false;
    log(`${desk.label}: ${desk.cwd} is ${gone.says} now (${when}) — letting the desk go`);
    if (await this.rescan(`its folder is ${gone.says} — ${desk.label}`)) await this.register();
    return true;
  }

  /**
   * Take a desk from the floor: bind a folder under this host's roots to a
   * (channel, agent) in Claude Code's local scope — importing, and removing,
   * the folder's own .mcp.json entry for this board if it has one — and open
   * a window there. See host/mcp.js for what "bind" means and why.
   *
   * Every step is a line in the log. A window opening in a folder the
   * operator did not name in a terminal is exactly the kind of surprise this
   * host is built not to spring, and the log is where they will read what
   * happened. Refusals go to the desk as an error turn too, quoting the CLI's
   * own last line rather than a guessed cause.
   *
   * Handled before the desk lookup, because until this runs there is no desk.
   */
  async bind(item) {
    const { channel, agent } = item;
    const p = item.payload ?? {};
    const path = typeof p.path === 'string' ? p.path : '';
    // Where a refusal is said. A move that has not rebound anything yet is
    // said on the desk it is moving FROM — where the agent still is, and the
    // only one of the two the board has a hosted row for. Said on the target,
    // as it was, the board dropped it (no row there until `bound`), so a move
    // the host refused reached no floor at all (QA, PR #33 finding 1). Once
    // the folder is bound to the new names the target is where it belongs.
    //
    // `taking` names the desk that was being taken, wherever the refusal is
    // said. The board keeps what became of each take it accepted under that
    // name (`live.takes` in src/floor.js), which is the only place a refusal
    // for a desk with no row on this instance can be read: a plain take, and
    // every release, since the desk being released sits on another instance.
    let rebound = false;
    const fail = (message, code = 'bind_failed') => {
      const at = p.from && !rebound ? p.from : { channel, agent };
      const said = at === p.from && !message.startsWith('not moved') ? `not moved to ${channel}: ${message}` : message;
      warn(`${channel}/${agent}: ${said}`);
      return this.emit({ type: 'error', channel: at.channel, agent: at.agent, code, message: said, taking: { channel, agent } }, true);
    };
    // Any folder the picker showed can be a desk. The roots used to fence
    // this; the board runs on localhost and that is the security model, so
    // the only refusals left are a path that is not a folder here.
    if (!path) return fail('refused: no folder was named', 'bind_refused');
    if (!existsSync(path)) return fail(`refused: ${path} does not exist`, 'bind_refused');
    if (!this.cfg.token) {
      return fail(`this host has no shared secret to bind with — run  ${INSTALL_TOKEN_LINE}  on it, or bind one repo by hand`, 'no_key');
    }
    const dir = W.canonical(path);
    const origin = originOf(this.cfg.url);
    // A move closes the folder's window and reopens it under the new names,
    // because a running window keeps the headers it started with (measured
    // 2026-09-09). Mid-turn it is refused before anything is touched, quoting
    // the pane rather than guessing why it is busy.
    //
    // A release is the same close-and-reopen for a folder bound to another
    // instance (host/mcp.js has the ruling, and why it is this narrow). The
    // request names the instance being left, and the disk is read again now:
    // the operator confirmed leaving that one, so a binding that has changed
    // since the click is refused rather than followed. This instance knows
    // nothing about that desk's turns, so the pane is the only busy check
    // there is, where a move between floors has the board's as well.
    const leaving = typeof p.release?.board === 'string' && p.release.board ? p.release.board : null;
    if (leaving) {
      const now = readDesk(dir);
      const nowAt = now ? originOf(now.url) : null;
      if (nowAt !== leaving) {
        const is = !now ? 'bound to nothing' : nowAt === origin ? `bound to this instance already, as ${now.channel}/${now.agent}` : `bound to ${nowAt}`;
        return fail(`not released: ${dir} is ${is} now, not to ${leaving} as it was when you asked. Look at the folder again.`, 'bind_refused');
      }
      if (now.agent !== agent) return fail(`not released: ${dir} names its agent ${now.agent}, and ${agent} was asked for`, 'bind_refused');
    }
    const folderDesk = [...this.desks.values()].find((d) => d.cwd === dir && !d.seat);
    if ((p.from || leaving) && folderDesk?.proc?.working) {
      return fail(leaving ? `not released from ${leaving} — its Claude Code is in the middle of a turn` : `not moved to ${channel} — its Claude Code is in the middle of a turn`, 'bind_refused');
    }
    log(`${channel}/${agent}: binding ${dir}${leaving ? ` — releasing it from ${leaving}` : ''}${!leaving && p.import ? ' — importing its .mcp.json entry' : ''}${p.from ? ` — moving it from ${p.from.channel}/${p.from.agent}` : ''}`);
    // A desk already at this folder — the import case — keeps its conversation:
    // the Desk object survives the rescan (same cwd), and its pinned id is
    // handed to the new binding's registration below.
    // The folder's own desk, never one of its seats (host/seats.js): a seat
    // has a window and a binding of its own and is not what is being rebound.
    const before = [...this.desks.values()].find((d) => d.cwd === dir && !d.seat);
    let oldLast = before?.lastSessionId ?? null;
    // A seat that already carries the names this folder is being bound to
    // gives them up: the folder's own entry is what a window here connects
    // with, and two desks cannot answer to one name.
    const twin = this.desks.get(`${channel}|${agent}`);
    if (twin?.seat) {
      // Never mid-turn, as for the folder's own window above and for a
      // seat that is left: this closes the seat's window. The board refuses
      // it too, from the desk's last turn; this is the pane's word, for a
      // window that started working since (QA, PR #57 finding 3: the check
      // above reads the folder's own window, and this one had none).
      if (twin.proc?.working) {
        return fail(`${p.from ? `not moved to ${channel}` : `not bound to ${channel}/${agent}`} — ${agent} already has a desk on ${channel} in this folder, and its Claude Code is in the middle of a turn`, 'bind_refused');
      }
      await twin.stop();
      S.removeSeat(channel, agent, origin);
      log(`${channel}/${agent}: its seat at ${twin.cwd} is replaced by the folder's own binding`);
    }
    if (leaving) {
      // The file first: it is the one step that can refuse without having
      // changed anything (a .mcp.json that is not JSON). Then local scope, by
      // the name each entry was written under. A step that fails after one
      // that took says both, because the folder is then half released and
      // the words on the floor are the only record of which half.
      const dropped = M.dropProjectEntry(dir, { origin, also: [leaving] });
      if (!dropped.ok) return fail(`not released: left ${dir}/.mcp.json alone: ${dropped.error}`);
      if (dropped.removed.length) {
        log(`${channel}/${agent}: removed ${dropped.removed.join(', ')} from ${dir}/.mcp.json${dropped.kept.length ? ` (kept ${dropped.kept.join(', ')})` : ''}`);
      }
      for (const x of dropped.foreign) log(`${channel}/${agent}: left ${x.name} in ${dir}/.mcp.json alone — it points at ${x.board}`);
      const held = localEntries(dir);
      const names = held.ok ? held.entries.filter((x) => x.board === leaving).map((x) => x.name) : [M.SERVER_NAME];
      for (const name of names) {
        const rm = await M.mcpRemove(dir, name);
        if (!rm.ok) {
          return fail(`${dropped.removed.length ? `took the entry for ${leaving} out of ${dir}/.mcp.json, but ` : 'not released: '}could not remove the local-scope entry "${name}" in ${dir}: ${rm.error}`);
        }
        if (rm.removed) log(`${channel}/${agent}: removed the local-scope entry "${name}" in ${dir}, which pointed at ${leaving}`);
      }
    } else if (p.import || before) {
      const rm = await M.mcpRemove(dir);
      if (!rm.ok) return fail(`could not clear the old local-scope entry in ${dir}: ${rm.error}`);
      if (rm.removed) log(`${channel}/${agent}: removed the previous local-scope entry in ${dir}`);
      const dropped = M.dropProjectEntry(dir, { origin });
      if (!dropped.ok) return fail(`left ${dir}/.mcp.json alone: ${dropped.error}`);
      if (dropped.removed.length) {
        log(`${channel}/${agent}: removed ${dropped.removed.join(', ')} from ${dir}/.mcp.json${dropped.kept.length ? ` (kept ${dropped.kept.join(', ')})` : ''}`);
      }
      for (const x of dropped.foreign) log(`${channel}/${agent}: left ${x.name} in ${dir}/.mcp.json alone — it points at ${x.board}`);
    }
    const added = await M.mcpAdd(dir, { url: `${this.cfg.url}/mcp`, channel, agent, key: this.cfg.token });
    if (!added.ok) {
      // Past a release's removals there is no binding to put back with: the
      // old one was another instance's, key and all. Said as it stands.
      return fail(leaving ? `released ${dir} from ${leaving}, but could not bind it here: ${added.error}. The folder is bound to nothing now.` : `could not bind ${dir}: ${added.error}`);
    }
    rebound = true;
    log(`${channel}/${agent}: bound ${dir} in local scope`);
    // The board's own tools ask nothing in a folder the floor took (task 352
    // B, host/mcp.js): a take, an import, a move and a release all bind here.
    const allowed = M.allowBoardTools(dir, BOARD_TOOLS_RECORD);
    if (allowed.added) log(`${channel}/${agent}: allowed the board's tools (${M.boardToolRule()}) in ${allowed.file}`);
    else if (!allowed.ok) warn(`${channel}/${agent}: the board's tools will ask for permission there: ${allowed.error}`);
    this.addRoot(dir);
    // Whether the move closes the floor's window for a new conversation is
    // asked before the rescan, and the intent is handed to the rescan to set
    // as it creates the desk (`intents`). Set after it, as it was, it came
    // one await too late: watchLoop() is a loop of its own, and a tick in
    // that await found the new desk with no intent and the old window still
    // running, adopted that conversation by newest-wins, and filed its
    // session row on the new floor. That was test:host's move-section red,
    // seven sightings, all under load, and read on the seventh (CLAUDE.md,
    // Tests).
    //
    // A release (a folder bound to another instance, seated here) goes by
    // the same rules, for the same reasons. Its window, when there is one,
    // was opened under the other instance's address and keeps it until it is
    // closed, whichever host opened it: both hosts on a machine see every
    // pane on the tmux server and find one by its folder. With no window to
    // close there is no pin either, since this host never watched the
    // folder, so the conversation it arrives on is read off the disk: the
    // one somebody last spoke in, from its tail, because this instance has
    // none of its turns.
    // A Claude Code running in the folder when it moves (the folder's own
    // desk's, or one the instance being left runs) is ended, and the new
    // floor gets a new conversation (#24 Decided 2). Ours is stopped here;
    // the other instance's host lets its own go when it reads the folder's
    // new binding (letGoIfReleased).
    const inFolder = (await W.roster()).sessions?.some((x) => W.canonical(x.cwd) === dir && x.kind === 'interactive') ?? false;
    const pane = (p.from || leaving) && (folderDesk?.running || inFolder) ? true : null;
    if (pane && folderDesk?.running) await folderDesk.stop();
    const fresh = !!pane && p.open !== false;
    if (leaving && !fresh && !oldLast) oldLast = await W.lastSpokenIn(dir).catch(() => null);
    const key = `${channel}|${agent}`;
    if (fresh) {
      const since = Date.now();
      this.intents.set(key, { sessionId: null, pid: null, since, until: since + 45_000 + WATCH_MS });
    }
    try {
      await this.rescan(`bound from the floor — ${channel}/${agent}`);
    } finally {
      this.intents.delete(key);
    }
    // A seam for test:host: the moment after the rescan held open, so a
    // watch tick lands in it every run rather than under load only. Unset
    // (the default) it is no pause at all.
    if (BIND_GAP_MS) await sleep(BIND_GAP_MS);
    const desk = this.desks.get(key);
    if (!desk) {
      return fail(`bound ${dir}, but the rescan did not find the desk — is ${this.cfg.url} the board its entry names?`);
    }
    // A moved desk whose window the floor holds: that window is still on the
    // old channel, so it is closed — and the new floor gets a NEW
    // conversation (#24 Decided 2, costmo 2026-11-03: "A new session should
    // be started instead"). The one it was on stays in its folder, where the
    // session picker and History reach it.
    //
    // It used to reopen on the same conversation, and that was refused every
    // time on the live board (10 of 10, 2026-10-19 → 11-02): open() asks who
    // holds the conversation it is resuming, and the answer was the window
    // just killed — still in the roster, alive and in no pane, so an editor
    // (outside_tmux). A fresh window leaves the roster 4–14 ms after
    // kill-window, which is a race the live windows lost; the floor's own
    // window would have to be told from a real second holder by timing, and
    // a real second holder must still be refused. A new conversation has
    // no holder to ask about. Measured in task 253.
    //
    // So nothing here pins the old id on the new floor, and the reopen's
    // intent is set before anything else can tick, by the rescan as it
    // creates the desk (above): between the rescan and the reopen the old
    // window is still running in this folder, and newest-wins in watch()
    // would adopt it. An editor's chat is left alone;
    // it follows the new binding on its next tool call. A desk with no floor
    // window takes the open path below, as it always has, onto its last
    // conversation (#24 Decided 3, costmo 2026-11-03: "Last conversation") —
    // there is no closing window there for the reopen to meet.
    if (!fresh && oldLast) {
      await desk.follow(oldLast, leaving ? 'tail' : 'end');
    }
    await this.register();
    await this.emit({ type: 'bound', channel, agent, cwd: dir, scope: 'local', session_id: fresh ? null : oldLast, from: p.from ?? null, released_from: leaving }, true);
    if (p.open === false) {
      // Asked to open nothing, a released folder's window is still closed:
      // left running it goes on talking to the instance it was released
      // from. Said on the desk if it cannot be, since that is then the state.
      return undefined;
    }
    if (fresh) {
      await this.reopen(desk, { sessionId: null });
      return undefined;
    }
    const r = await desk.ensure({ resume: desk.sessionId ?? desk.lastSessionId });
    if (!r.ok) this.emit({ type: 'error', channel, agent, message: r.error, code: r.code ?? null }, true);
    return undefined;
  }

  /**
   * A new desk beside the folder's own: the same agent, in the same folder,
   * with a session of its own — on another floor, or in a second meeting
   * room on the same one (costmo, 2026-11-16; host/seats.js has what was
   * measured). Nothing of the folder's own desk is touched: its binding
   * stays, its window keeps running, and so does every other seat's.
   *
   * It always opens on a new conversation, or on the one the board names
   * (a meeting room resumed: the seat was closed when its room ended and
   * this is it coming back). Never on "the folder's last conversation",
   * which is the open path's rule for a folder that is one desk: here that
   * conversation is most likely the one another desk's window is running.
   *
   * A refusal before the seat exists is said on the desk it was made
   * beside, for the reason a refused move is said where the agent still is
   * (bind): the new desk has no row on the board until `bound`, and an
   * error for a desk the board has no row for is dropped.
   */
  async sit(item) {
    const { channel, agent } = item;
    const p = item.payload ?? {};
    const path = typeof p.path === 'string' ? p.path : '';
    const beside = p.beside && typeof p.beside === 'object' && p.beside.channel && p.beside.agent ? p.beside : null;
    let seated = false;
    const fail = (message, code = 'seat_failed') => {
      const at = beside && !seated ? beside : { channel, agent };
      const said = at === beside ? `no new desk on ${channel}: ${message}` : message;
      warn(`${channel}/${agent}: ${said}`);
      return this.emit({ type: 'error', channel: at.channel, agent: at.agent, code, message: said }, true);
    };
    if (!path) return fail('refused: no folder was named', 'seat_refused');
    if (!existsSync(path)) return fail(`refused: ${path} does not exist`, 'seat_refused');
    if (!this.cfg.token) return fail('this host has no shared secret to bind a desk with', 'no_key');
    const dir = W.canonical(path);
    const origin = originOf(this.cfg.url);
    const key = `${channel}|${agent}`;
    const have = this.desks.get(key);
    if (have && !(have.seat && have.cwd === dir)) {
      return fail(`refused: ${channel}/${agent} is already a desk here, at ${have.cwd}`, 'seat_refused');
    }
    const sessionId = typeof p.session_id === 'string' && p.session_id ? p.session_id : null;
    log(`${channel}/${agent}: a new desk at ${dir}, beside ${beside ? `${beside.channel}/${beside.agent}` : 'the folder\'s own'}${sessionId ? ` — on ${sessionId}` : ''}`);
    let seat;
    try {
      seat = S.addSeat({ channel, agent, cwd: dir, board: origin });
      S.writeConfig(seat, { url: `${this.cfg.url}/mcp`, key: this.cfg.token });
    } catch (err) {
      return fail(`could not record the new desk: ${err.message}`);
    }
    // The intent before the rescan makes the desk, as in bind(): a watch tick
    // between the two must not find the desk with nothing to wait for.
    const since = Date.now();
    this.intents.set(key, { sessionId, pid: null, since, until: since + 45_000 + WATCH_MS });
    try {
      await this.rescan(`a new desk from the floor — ${channel}/${agent}`);
    } finally {
      this.intents.delete(key);
    }
    const desk = this.desks.get(key);
    if (!desk?.seat) {
      S.removeSeat(channel, agent, origin);
      return fail(`recorded the new desk at ${dir}, but the rescan did not find it`);
    }
    seated = true;
    await this.register();
    await this.emit({ type: 'bound', channel, agent, cwd: dir, scope: 'seat', session_id: null, from: null, beside }, true);
    if (p.open === false) return undefined;
    await this.reopen(desk, { sessionId, known: p.known === true });
    return undefined;
  }

  /**
   * Leave a desk: close the floor's window there, take the binding out of
   * wherever it was read from — the local-scope entry, and the .mcp.json entry
   * for this board — and let the rescan drop the desk, which the next
   * registration reports as offline. The seat stays on the floor; whether the
   * agent is gone is the board's question, not this one's.
   */
  async unbind(desk) {
    const { channel, agent } = desk;
    const fail = (message) => {
      warn(`${desk.label}: ${message}`);
      return this.emit({ type: 'error', channel, agent, code: 'unbind_failed', message }, true);
    };
    if (desk.running) {
      await desk.stop();
      log(`${desk.label}: ended its Claude Code`);
    }
    // A seat's binding is the host's own record and nothing of the folder's
    // (host/seats.js): the folder's own desk, and its other seats, stay.
    if (desk.seat) {
      S.removeSeat(channel, agent, originOf(this.cfg.url));
      log(`${desk.label}: removed its seat at ${desk.cwd}`);
      await this.rescan(`left from the floor — ${desk.label}`);
      await this.register();
      return this.emit({ type: 'unbound', channel, agent, cwd: desk.cwd, seat: true }, true);
    }
    const rm = await M.mcpRemove(desk.cwd);
    if (!rm.ok) return fail(`could not remove the local-scope entry in ${desk.cwd}: ${rm.error}`);
    if (rm.removed) log(`${desk.label}: removed the local-scope entry in ${desk.cwd}`);
    const unallowed = M.unallowBoardTools(desk.cwd, BOARD_TOOLS_RECORD);
    if (unallowed.removed) log(`${desk.label}: took the board's tools rule out of ${unallowed.file}`);
    else if (!unallowed.ok) warn(`${desk.label}: ${unallowed.error}`);
    const dropped = M.dropProjectEntry(desk.cwd, { origin: originOf(this.cfg.url), channel, agent });
    if (!dropped.ok) return fail(`left ${desk.cwd}/.mcp.json alone: ${dropped.error}`);
    if (dropped.removed.length) log(`${desk.label}: removed ${dropped.removed.join(', ')} from ${desk.cwd}/.mcp.json`);
    await this.rescan(`left from the floor — ${desk.label}`);
    await this.register();
    return this.emit({ type: 'unbound', channel, agent, cwd: desk.cwd }, true);
  }

  /**
   * Put this desk's window on another of its folder's conversations — or on
   * a new one. The session picker's primitive, and a move's (always on a new
   * one — see bind): close, then open with `--resume` or without.
   *
   * Reopening the conversation its own window holds races that window out of
   * the roster (issue #24): open() can find it still there, alive and in no
   * pane, and refuse it as an editor. Nothing does that — the picker disables
   * the current row and a move asks for a new conversation — so it is not
   * guarded against here; a real second holder must still be refused.
   *
   * Close first, because open() returns early on an existing pane and
   * ignores `resume`; a window that is mid-turn is not closed, and the refusal
   * quotes the pane's bottom line rather than guessing why it is busy. Then
   * the intent — see Desk.watch — and the offset: 'end' when the board holds
   * this conversation's turns already, 'tail' when it has never seen them,
   * so the panel opens on the conversation's recent past. `null` starts a
   * fresh one, which has no id until its window registers; the intent's pid
   * is how that one is recognised.
   */
  async reopen(desk, { sessionId = null, known = false } = {}) {
    const { channel, agent } = desk;
    const fail = (message, code = 'reopen_failed') => {
      warn(`${desk.label}: ${message}`);
      desk.intent = null;
      return this.emit({ type: 'error', channel, agent, code, message }, true);
    };
    if (desk.proc?.working) return fail('not reopened — its Claude Code is in the middle of a turn');
    if (desk.running) {
      await desk.stop();
      log(`${desk.label}: ended its Claude Code to reopen on ${sessionId ?? 'a new conversation'}`);
    }
    // The conversation asked for, checked against the disk first, as a
    // resume always was (resumable): one never written (a pin with no
    // transcript, a conversation deleted) falls back to the folder's newest
    // that no seat runs, and a seat starts a new one. Said on the desk.
    // Handed straight to --resume, a missing id is a Claude Code that exits
    // on its first line (the seats suite, 2026-11-22).
    if (sessionId) {
      const pick = await W.resumable(desk.where, sessionId, { seatPids: this.seatPids() });
      if (pick.note) desk.told(pick.note, pick.id ?? sessionId);
      sessionId = pick.id;
    }
    const before = { last: desk.lastSessionId, offset: desk.offset };
    if (sessionId) await desk.follow(sessionId, known ? 'end' : 'tail');
    else { desk.lastSessionId = null; desk.offset = 0; }
    const r = await desk.ensure(sessionId ? { resume: sessionId } : { fresh: true });
    if (!r.ok) {
      // Refused (another app holds that conversation): the desk is not on
      // it, so it does not relay it either.
      desk.lastSessionId = before.last;
      desk.offset = before.offset;
      return fail(r.error);
    }
    log(`${desk.label}: reopened on ${sessionId ?? 'a new conversation'}`);
    return undefined;
  }

  /** The desks this host runs, as the history module wants them. */
  deskFolders() {
    // One desk a folder: the conversations are the folder's, and with seats
    // (host/seats.js) several desks share one. Listed under each, the same
    // conversation was in History once per desk. The folder's own desk
    // speaks for it; a folder with only seats is under its first.
    const byCwd = new Map();
    for (const d of this.desks.values()) {
      const have = byCwd.get(d.cwd);
      if (!have || (have.seat && !d.seat)) byCwd.set(d.cwd, d);
    }
    return [...byCwd.values()].map((d) => ({ channel: d.channel, agent: d.agent, cwd: d.cwd }));
  }

  /**
   * The conversations most recently spoken in, across every desk here — the
   * History dialog's list. The picker's own bounded read of each folder,
   * merged; answered as a `history` event naming the request it answers.
   * Not awaited by the work loop, like everything else here that reads disk
   * on somebody's click.
   */
  async recent(item) {
    const requestId = item.payload?.request_id ?? null;
    const at = () => new Date().toISOString();
    try {
      const rows = await H.recentAcross(this.deskFolders());
      return this.emit({ type: 'history', kind: 'recent', request_id: requestId, at: at(), rows }, true);
    } catch (err) {
      warn(`recent conversations: ${err.message}`);
      return this.emit({ type: 'history', kind: 'recent', request_id: requestId, at: at(), rows: [], error: err.message }, true);
    }
  }

  /**
   * Search what was said in every conversation on this machine. See
   * host/history.js for why it is the transcripts and why it is a process of
   * its own.
   *
   * One search at a time: a new one ends the one before it, because the
   * person who asked has asked for something else, and two walks of the same
   * disk answer nobody sooner. The answer is a `history` event — the rows,
   * how many files were read and how long it took — or what the process said
   * when it failed, quoted.
   */
  search(item) {
    const requestId = item.payload?.request_id ?? null;
    const query = typeof item.payload?.query === 'string' ? item.payload.query : '';
    const deep = item.payload?.deep === true;
    const say = (more) => this.emit({ type: 'history', kind: 'search', request_id: requestId, query, deep, at: new Date().toISOString(), ...more }, true);
    if (this.searching) {
      log(`search: a newer search replaces "${this.searching.query}"`);
      this.searching.superseded = true;
      try { this.searching.child.kill('SIGTERM'); } catch { /* already gone */ }
    }
    if (SEARCH_IN_WORKER) return this.searchInWorker(query, deep, say);
    let child;
    try {
      child = spawn(process.execPath, [HISTORY_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      warn(`search: could not start — ${err.message}`);
      return say({ rows: [], error: `could not start the search: ${err.message}` });
    }
    const mine = { child, query, superseded: false };
    this.searching = mine;
    let out = '';
    let errOut = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errOut += d; });
    const timer = setTimeout(() => { mine.timedOut = true; child.kill('SIGTERM'); }, SEARCH_TIMEOUT_MS);
    child.on('error', (err) => { errOut += err.message; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (this.searching === mine) this.searching = null;
      // Replaced by a newer search: nobody is waiting for this one.
      if (mine.superseded) return;
      let got = null;
      try { got = JSON.parse(out); } catch { /* reported below as it came */ }
      if (code === 0 && got && Array.isArray(got.rows)) {
        log(`search: "${query}"${deep ? ' (with tool calls and thinking)' : ''} — ${got.rows.length} conversation${got.rows.length === 1 ? '' : 's'} in ${got.files} files, ${got.ms} ms`);
        say({ rows: got.rows, files: got.files, ms: got.ms });
        return;
      }
      const tail = errOut.trim().split('\n').pop() || out.trim().split('\n').pop() || '';
      const how = mine.timedOut ? `was ended after ${Math.round(SEARCH_TIMEOUT_MS / 1000)}s` : signal ? `ended on ${signal}` : `ended with exit code ${code}`;
      warn(`search: "${query}" ${how}${tail ? `: ${tail}` : ''}`);
      say({ rows: [], error: `the search ${how}${tail ? `: ${tail}` : ''}` });
    });
    child.stdin.end(JSON.stringify({ desks: this.deskFolders(), query, deep }));
    return undefined;
  }

  /**
   * search(), run as a worker thread: the desktop app's path (SEARCH_IN_WORKER).
   * The same answer, the same log lines and the same words on a failure, so
   * the floor cannot tell the two apart. `child.kill` is what a newer search
   * calls on the one it replaces, so the worker is given one.
   */
  searchInWorker(query, deep, say) {
    let worker;
    try {
      worker = new Worker(new URL('./history.js', import.meta.url), { workerData: { historyAsk: { desks: this.deskFolders(), query, deep } } });
    } catch (err) {
      warn(`search: could not start — ${err.message}`);
      return say({ rows: [], error: `could not start the search: ${err.message}` });
    }
    const mine = { child: { kill: () => { mine.ended = true; worker.terminate(); } }, query, superseded: false };
    this.searching = mine;
    let got = null;
    let failed = '';
    const timer = setTimeout(() => { mine.timedOut = true; mine.child.kill(); }, SEARCH_TIMEOUT_MS);
    worker.on('message', (m) => { if (m?.out) got = m.out; else failed = m?.error ?? ''; });
    worker.on('error', (err) => { failed = err?.message ?? String(err); });
    worker.on('exit', (code) => {
      clearTimeout(timer);
      if (this.searching === mine) this.searching = null;
      if (mine.superseded) return;
      if (!mine.timedOut && got && Array.isArray(got.rows)) {
        log(`search: "${query}"${deep ? ' (with tool calls and thinking)' : ''} — ${got.rows.length} conversation${got.rows.length === 1 ? '' : 's'} in ${got.files} files, ${got.ms} ms, in a worker`);
        say({ rows: got.rows, files: got.files, ms: got.ms });
        return;
      }
      const tail = failed.trim().split('\n').pop() || '';
      const how = mine.timedOut ? `was ended after ${Math.round(SEARCH_TIMEOUT_MS / 1000)}s` : mine.ended ? 'was ended' : `ended with exit code ${code}`;
      warn(`search: "${query}" ${how}${tail ? `: ${tail}` : ''}`);
      say({ rows: [], error: `the search ${how}${tail ? `: ${tail}` : ''}` });
    });
    return undefined;
  }

  /**
   * Read one of a desk's conversations whole, for somebody to read — the
   * transcript from its first record, its subagents' transcripts with it,
   * in the order things were said.
   *
   * Nothing is opened, closed or moved, and the desk's own place in its
   * conversation is not touched: this is a file read, and the offsets the
   * relay keeps are the relay's. It goes up as `transcript` events in pages,
   * each naming the request it answers, the last one saying `done` — the
   * board keeps it in memory only for whoever asked.
   *
   * The id is checked again here, though the board checked it: it becomes a
   * file name on this machine. A conversation that is not in this desk's
   * folder is said as that, with the folder named.
   */
  async readWhole(desk, payload) {
    const { channel, agent } = desk;
    const sessionId = typeof payload?.session_id === 'string' ? payload.session_id : '';
    const requestId = payload?.request_id ?? null;
    const say = (more) => this.emit({ type: 'transcript', channel, agent, session_id: sessionId, request_id: requestId, at: new Date().toISOString(), ...more }, true);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) return say({ error: 'that is not a session id', done: true });
    const path = W.transcriptPath(desk.cwd, sessionId);
    const main = await W.readTranscript(path);
    if (!main.ok) return say({ error: `no conversation ${sessionId} in ${desk.cwd}: ${main.error}`, done: true });
    const turns = [...main.turns];
    // A subagent with no meta file yet is read under its id here rather than
    // waited for (metaGraceMs: 0): the relay waits because a stored turn is
    // never relabeled, and nothing read this way is stored.
    for (const sub of await W.subagentTranscripts(path, { metaGraceMs: 0 })) {
      const r = await W.readTranscript(sub.path, { via: sub.label });
      if (r.ok) turns.push(...r.turns);
    }
    if (turns.every((t) => Number.isFinite(Date.parse(t.at)))) turns.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    log(`${desk.label}: read ${sessionId} whole for the floor — ${turns.length} turn${turns.length === 1 ? '' : 's'}`);
    let page = [];
    let chars = 0;
    for (const t of turns) {
      page.push({ role: t.role, text: t.text, at: t.at, tool_name: t.tool_name ?? null, tool_input: t.tool_input ?? null, via: t.via ?? null });
      chars += String(t.text ?? '').length;
      if (page.length >= READ_PAGE_TURNS || chars >= READ_PAGE_CHARS) {
        await say({ turns: page });
        page = [];
        chars = 0;
      }
    }
    return say({ turns: page, done: true });
  }

  /**
   * A folder taken from the picker outside this host's roots becomes one of
   * them. The roots are where the host looks for desks on its own, and a
   * desk it has just bound is somewhere it must look — otherwise the rescan
   * that follows the bind finds nothing and the desk never registers. Kept
   * in memory, and written back to host.json when that is where the roots
   * came from; roots given by ORCH_HOST_ROOTS are the environment's to
   * change, so those live only for this run and the log says so.
   */
  addRoot(dir) {
    if (M.insideRoots(dir, this.cfg.roots)) return false;
    this.cfg.roots.push(dir);
    if (this.cfg.rootsFrom !== 'file') {
      log(`added ${dir} to this host's roots for this run — ORCH_HOST_ROOTS sets them, so add it there to keep it`);
      return true;
    }
    let file = {};
    try { file = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch { /* absent or unreadable: written fresh below */ }
    file.roots = [...new Set([...(Array.isArray(file.roots) ? file.roots : []), dir])];
    try {
      mkdirSync(dirname(CONFIG_FILE), { recursive: true });
      writeFileSync(CONFIG_FILE, `${JSON.stringify(file, null, 2)}\n`);
      log(`added ${dir} to this host's roots (${CONFIG_FILE})`);
    } catch (err) {
      warn(`added ${dir} to this host's roots for this run, but could not write ${CONFIG_FILE}: ${err.message}`);
    }
    return true;
  }

  /**
   * One folder as the board keeps it for the form: the listing, with each
   * folder marked as bound to this board or another so the dialog can say
   * which without a second question. The one shape for a folder opened in
   * the page's list and one chosen in the native dialog, so the form cannot
   * be filled two ways.
   */
  listingEvent(asked) {
    const at = new Date().toISOString();
    const r = listFolder(asked);
    if (!r.ok) return { type: 'browse', path: asked, requested: asked, at, error: r.error };
    const origin = originOf(this.cfg.url);
    const mark = (f) => ({ ...f, other_board: f.bound && f.bound.board !== origin ? f.bound.board : null });
    return {
      type: 'browse', requested: asked, path: r.path, root: r.root, parent: r.parent, at,
      self: mark(r.self), entries: r.entries.map(mark),
    };
  }

  /**
   * List one folder for the picker. Answered as an event, like the session
   * list: the work loop is one-way and the board keeps the last folder each
   * host showed.
   */
  async browse(item) {
    // No path means the host's home folder: where the page's own list starts.
    const asked = typeof item.payload?.path === 'string' && item.payload.path ? item.payload.path : homedir();
    const ev = this.listingEvent(asked);
    if (ev.error) warn(`browse ${asked}: ${ev.error}`);
    return this.emit(ev, true);
  }

  /**
   * Open the operating system's folder dialog on this machine, and say what
   * the person chose in it. See host/dialog.js for what was measured.
   *
   * Three things are said, each as a `pick` event, because the page has
   * nothing else to settle on: `open` the moment the dialog is up (from then
   * on the page waits for the person, not for a clock), then `chosen`,
   * `cancelled` or `failed`. A chosen folder is listed first, as the same
   * `browse` event the page's own list produces — that record is what says a
   * folder is already a desk, on which floor and under which agent, and it
   * is what the board checks a take against: the board never sends a path
   * this host has not named, and naming it is this.
   *
   * It opens where the page asks — the folder the last choice was made in —
   * or at the nearest folder above that which still exists (D.startFor).
   *
   * Not awaited. The work loop that calls this also delivers messages to
   * desks, and a person in a folder dialog takes as long as they take.
   *
   * One dialog at a time: a second request while one is open says `open`
   * again rather than stacking another on the screen.
   */
  pick(item) {
    const say = (state, more = {}) => this.emit({ type: 'pick', state, at: new Date().toISOString(), ...more }, true);
    if (D.pickIsStale(item, PICK_TTL_MS)) {
      warn(`not opening the folder dialog — it was asked for ${Math.round(Number(item.waited_ms) / 1000)}s ago and nobody is waiting for it now`);
      return undefined;
    }
    if (this.picking) return say('open', { start: this.picking.start });
    const start = D.startFor(item.payload?.start);
    const opened = D.openFolderDialog(start);
    if (!opened.ok) {
      warn(`folder dialog: ${opened.error}`);
      return say('failed', { start, error: opened.error });
    }
    this.picking = { start, close: opened.close };
    log(`opened the folder dialog at ${start}`);
    opened.done.then((r) => {
      this.picking = null;
      if (!r.ok) {
        warn(`folder dialog: ${r.error}`);
        return say('failed', { start, error: r.error });
      }
      if (r.cancelled) {
        log(`the folder dialog was closed without a choice${r.why ? ` — ${r.why}` : ''}`);
        return say('cancelled', { start, why: r.why ?? null });
      }
      const listing = this.listingEvent(r.path);
      if (listing.error) {
        warn(`folder dialog: chose ${r.path}, which could not be listed: ${listing.error}`);
        return say('failed', { start, error: listing.error });
      }
      log(`the folder dialog chose ${listing.path}`);
      this.emit(listing);
      return say('chosen', { start, path: listing.path, parent: listing.parent });
    }).catch((err) => warn(`folder dialog: ${err.message}`));
    return say('open', { start });
  }

  /**
   * Whether Claude Code is signed out on this machine, as the board is told
   * it: `claude auth status` says so, or a window has recorded "Not logged
   * in" since the last sign-in or reply. The window's word counts on its own
   * because it is what the window believes: a credential that is present but
   * no longer accepted may still read as signed in to `auth status`.
   */
  signedOut() {
    return this.auth.status === false || this.auth.said;
  }

  /**
   * Ask Claude Code whether it is signed in, and tell the board at once when
   * the answer changes (a registration carries `signed_out`). An answer that
   * could not be had leaves the last one standing.
   */
  async checkAuth(why, { register = true, was = this.signedOut() } = {}) {
    const st = await A.signedIn({ shell: process.platform === 'win32' ? null : W.shellFor() });
    if (st !== null) this.auth.status = st;
    const now = this.signedOut();
    if (now !== was) {
      log(`Claude Code is ${now ? 'signed out' : 'signed in'} on this machine (${why})`);
      if (register) await this.register().catch((err) => warn(`registering after the sign-in changed: ${err.message}`));
    }
    return now;
  }

  /**
   * Every turn the relay posts passes here, for the one thing about the
   * machine a turn can say: a window recorded "Not logged in" (its API error
   * when a message reaches it signed out), or a reply came back, which a
   * signed-out window cannot give.
   */
  noteTurn(turn) {
    if (turn.role === 'error' && A.isNotLoggedIn(turn.text)) {
      if (this.auth.said) return;
      // What the board was last told, read before the window's word changes it.
      const was = this.signedOut();
      this.auth.said = true;
      this.checkAuth('a window recorded "Not logged in"', { was }).catch((err) => warn(`sign-in check: ${err.message}`));
    } else if (turn.role === 'assistant' && this.auth.said) {
      const was = this.signedOut();
      this.auth.said = false;
      this.checkAuth('a window replied', { was }).catch((err) => warn(`sign-in check: ${err.message}`));
    }
  }

  /**
   * The desk's Sign in (POST /api/floor/signin): Claude Code's own sign-in,
   * run here as the person, which opens the browser on this machine (costmo,
   * 2026-11-19: the host signs in on the click, in the app and on the Docker
   * board alike). Said on the desk as it opens and as it ends. One at a time:
   * a second press while one is open says so and opens nothing.
   *
   * A window that still says it is signed out once Claude Code is signed in
   * again is reopened on its conversation. Whether a running window takes a
   * sign-in made by another process was not measured (it needs a real
   * account), so the host reads each window instead of assuming: a window
   * that took it is left alone, and one that did not is idle (a signed-out
   * window cannot be working) and is resumed where it was. The board hears
   * "signed in" only after that, so no message is typed into a window while
   * it is being reopened: until then the board still refuses them.
   */
  async signIn(desk) {
    if (this.auth.signing) {
      desk.told(`Claude Code's sign-in is already open in the browser on ${this.cfg.name}: finish it there.`);
      return;
    }
    desk.told(`Claude Code's sign-in is open in the browser on ${this.cfg.name}: finish it there, and this desk can answer again.`);
    log(`${desk.label}: opened Claude Code's sign-in`);
    this.auth.signing = A.signIn();
    let r;
    try { r = await this.auth.signing; } finally { this.auth.signing = null; }
    if (!r.ok) {
      warn(`${desk.label}: Claude Code's sign-in: ${r.error}`);
      await this.emit({ type: 'error', channel: desk.channel, agent: desk.agent, code: 'signin_failed', message: `not signed in: ${r.error}` }, true);
      await this.checkAuth('after a sign-in that did not finish');
      return;
    }
    this.auth.said = false;
    const st = await A.signedIn({ shell: process.platform === 'win32' ? null : W.shellFor() });
    if (st !== null) this.auth.status = st;
    if (this.signedOut()) {
      await this.emit({ type: 'error', channel: desk.channel, agent: desk.agent, code: 'signin_failed', message: 'the sign-in ended, and Claude Code still says it is signed out here. Press Sign in to try again.' }, true);
      return;
    }
    log(`${desk.label}: Claude Code is signed in again`);
    desk.told(`signed in to Claude Code on ${this.cfg.name}`);
    this.later.push(async () => {
      await this.reopenSignedOut();
      await this.register().catch((err) => warn(`registering after the sign-in: ${err.message}`));
    });
  }

  /**
   * After a sign-in, each desk whose Claude Code is running is started again
   * on its conversation: a process started signed out is not known to take
   * a sign-in made by another (not measured: it needs a real account), and a
   * new process reads the credentials as it starts. Never mid-turn: a
   * signed-out process cannot be working.
   */
  async reopenSignedOut() {
    for (const desk of this.desks.values()) {
      if (!desk.running || desk.proc.working) continue;
      const id = desk.sessionId ?? desk.lastSessionId ?? null;
      await this.reopen(desk, { sessionId: id, known: true });
      desk.told('started its Claude Code again on the same conversation, so it reads the new sign-in', id);
    }
  }

  async handle(item) {
    if (item.kind === 'bind') {
      await this.bind(item);
      return;
    }
    if (item.kind === 'seat') {
      await this.sit(item);
      return;
    }
    if (item.kind === 'browse') {
      await this.browse(item);
      return;
    }
    if (item.kind === 'pick') {
      await this.pick(item);
      return;
    }
    // History is about this machine, not one desk, and reads disk: neither
    // is awaited, so a message to a desk is never behind somebody's search.
    if (item.kind === 'recent') {
      this.recent(item).catch((err) => warn(`recent conversations: ${err.message}`));
      return;
    }
    if (item.kind === 'search') {
      this.search(item);
      return;
    }
    // Bringing this machine to a new build: minutes of git and docker, so
    // started and not awaited — the relay and every desk's messages go on
    // until the board itself goes away for the rebuild.
    if (item.kind === 'update') {
      this.update(item);
      return;
    }
    if (item.kind === 'rescan') {
      // Asked for rather than scheduled: the board saw a session start on a
      // desk no host runs, or somebody pressed the button, and this host may
      // be the one whose roots that repo is under. Before the desk lookup,
      // because not having the desk is the whole point. Register straight
      // after a change so the floor hears the answer in this tick rather than
      // at the next heartbeat.
      const why = item.payload?.why ?? 'asked';
      if (await this.rescan(`${why} — ${item.channel}/${item.agent}`)) await this.register();
      return;
    }
    const desk = this.desks.get(`${item.channel}|${item.agent}`);
    if (!desk) return warn(`work for a desk this host doesn't have: ${item.channel}/${item.agent}`);
    // Not into a folder that has been released to another instance since
    // this host last looked (boundAt): said on the desk, in what the disk
    // says, and the desk let go. The page hands a refused message back to
    // its box on an error turn, so the words are not lost.
    {
      const gone = this.boundAt(desk);
      if (gone) {
        await this.emit({ type: 'error', channel: desk.channel, agent: desk.agent, code: 'released', message: `not done: ${desk.cwd} is ${gone.says} now, not ${desk.label} on this instance. The desk is let go here.` }, true);
        await this.letGoIfReleased(desk, `${item.kind} work arrived for it`);
        return undefined;
      }
    }
    switch (item.kind) {
      case 'chat': {
        let text = typeof item.payload?.text === 'string' ? item.payload.text : '';
        // A wake from the floor (wakeDue in src/floor.js): said on the desk
        // with what it is for, so the operator can see why it started.
        const woken = item.payload?.woken;
        if (woken && typeof woken === 'object') {
          const parts = [];
          if (Number(woken.unread)) parts.push(`${Number(woken.unread)} unread message${Number(woken.unread) === 1 ? '' : 's'}`);
          if (Number(woken.tasks)) parts.push(`${Number(woken.tasks)} task${Number(woken.tasks) === 1 ? '' : 's'}`);
          desk.told(`woken by the floor: ${parts.join(', ') || 'work waiting'}, and no Claude Code running here`);
        }
        // Attachments (issue #31): each fetched from the board onto this
        // machine, outside the repo, and named in the message by its path
        // (host/uploads.js). Awaited, on this line, because the message must
        // be typed in its place among the others; a file is a local copy
        // from the board, seconds at most. One that does not arrive stops
        // the message: words about a file the agent cannot open are worse
        // than the error turn, which hands the words and the files back to
        // the box.
        const files = Array.isArray(item.payload?.files) ? item.payload.files : [];
        if (files.length) {
          const paths = [];
          try {
            for (const f of files) paths.push(await UP.fetchUpload({ url: this.cfg.url, token: this.cfg.token, hostId: this.cfg.hostId, file: f }));
          } catch (err) {
            warn(`${desk.label}: an attachment did not arrive — ${err.message}; the message was not sent`);
            // The why, then what became of the message. Not "not sent — …":
            // a meeting room puts "not delivered — " before a desk's error, and
            // the two read as "not delivered — not sent — …" (QA, PR #58 Info 6).
            this.emit({ type: 'error', channel: desk.channel, agent: desk.agent, code: 'upload_failed', message: `${err.message}; nothing was typed` }, true);
            break;
          }
          text = UP.withAttachments(text, paths);
          log(`${desk.label}: ${paths.length} attachment${paths.length === 1 ? '' : 's'} in ${UP.uploadsDir()}`);
        }
        // A meeting room's notice is the board's, typed nobody asked for at
        // this moment: `notice` on the work, or (from a board before it) the
        // text being one <meeting-room> block, as the relay files it.
        const notice = item.payload?.notice === true || /^<meeting-room>[\s\S]*<\/meeting-room>$/.test(text.trim());
        if (text.trim()) await desk.say(text, { unasked: notice && !files.length });
        break;
      }
      case 'permission': {
        // The operator's answer to something the desk's Claude Code asked,
        // as data: a row's number, or allow, deny, cancel (desk.js).
        const r = await desk.answerPermission(item.payload?.request_id, item.payload?.decision, item.payload?.reason ?? null);
        if (!r.ok) {
          warn(`${desk.label}: could not answer — ${r.error}`);
          this.emit({ type: 'error', channel: desk.channel, agent: desk.agent, code: r.code === 'stale_request' ? 'stale_request' : null, message: `your answer did not reach Claude Code — ${r.error}` }, true);
        }
        break;
      }
      case 'prompt':
        // The board asking what a prompt offers: the host said it whole when
        // Claude Code asked, and says it again.
        for (const ev of desk.standingAsks()) this.emit(ev, true);
        break;
      case 'answer': {
        const r = desk.answerQuestion(item.payload?.request_id, item.payload?.answers ?? null);
        if (!r.ok) this.emit({ type: 'error', channel: desk.channel, agent: desk.agent, code: 'answer_failed', message: `your answers did not reach Claude Code — ${r.error}` }, true);
        break;
      }
      case 'press':
        // From a board that still offers a blind key at a prompt it could
        // not read. Nothing is unreadable now: every question arrives as data.
        this.emit({ type: 'error', channel: desk.channel, agent: desk.agent, code: 'press_failed', message: 'nothing was pressed: what Claude Code asks now reaches the floor as data, to be answered there' }, true);
        break;
      case 'interrupt':
        await desk.interrupt();
        break;
      case 'signin':
        // Waits on a person in a browser for minutes, so it is started and
        // not awaited: every desk's messages go on meanwhile.
        this.signIn(desk).catch((err) => warn(`${desk.label}: sign-in: ${err.message}`));
        break;
      case 'reconnect':
        await desk.reconnect();
        break;
      case 'handback': {
        // Give the conversation to the editor: end ours first, then open it
        // there. The order matters: the reverse leaves two live copies.
        // Not a seat's: an editor in this folder loads the folder's binding,
        // so the conversation would carry on as the folder's own desk.
        if (desk.seat) {
          this.emit({ type: 'error', channel: desk.channel, agent: desk.agent, code: 'seat_no_editor', message: 'this desk shares its folder with another desk, and an editor opened there is that desk, not this one, so this conversation stays on the floor.' }, true);
          break;
        }
        const id = desk.sessionId ?? desk.lastSessionId;
        await desk.stop();
        desk.handedOffAt = Date.now();
        const opened = await W.openInEditor({ sessionId: id });
        if (!opened.ok) this.emit({ type: 'error', channel: desk.channel, agent: desk.agent, message: opened.error }, true);
        break;
      }
      case 'open': {
        const r = await desk.ensure();
        if (!r.ok) this.emit({ type: 'error', channel: desk.channel, agent: desk.agent, message: r.error, code: r.code ?? null }, true);
        break;
      }
      case 'unbind':
        await this.unbind(desk);
        break;
      case 'sessions': {
        const rows = await W.sessionsIn(desk.cwd, { limit: SESSIONS_LIMIT, ours: this.ourPids() });
        this.emit({ type: 'sessions', channel: desk.channel, agent: desk.agent, at: new Date().toISOString(), rows }, true);
        break;
      }
      case 'read':
        this.readWhole(desk, item.payload).catch((err) => warn(`${desk.label}: could not read ${item.payload?.session_id} — ${err.message}`));
        break;
      case 'reopen':
        await this.reopen(desk, {
          sessionId: typeof item.payload?.session_id === 'string' && item.payload.session_id ? item.payload.session_id : null,
          known: item.payload?.known === true,
        });
        break;
      case 'attach':
      case 'claude': {
        // "Open in Claude": the conversation handed to a terminal of the
        // operator's own. The desk's Claude Code ends first, then the
        // terminal resumes the conversation; the floor follows what is said
        // there, and Open on the floor brings it back once that one exits.
        if (desk.seat) {
          this.emit({ type: 'error', channel: desk.channel, agent: desk.agent, code: 'seat_no_editor', message: 'this desk shares its folder with another desk, and a terminal opened there is that desk, not this one, so this conversation stays on the floor.' }, true);
          break;
        }
        const id = desk.sessionId ?? await desk.resumeId();
        await desk.stop();
        desk.handedOffAt = Date.now();
        const t = await W.openInTerminal({ cwd: desk.cwd, sessionId: id });
        if (!t.ok) { this.emit({ type: 'error', channel: desk.channel, agent: desk.agent, message: t.error }, true); break; }
        desk.told(`handed to ${t.app} (\`${t.cmd}\`). What is said there reaches the floor; Open on the floor brings it back once you exit there.`, id);
        break;
      }
      default:
        warn(`unknown work kind ${item.kind}`);
    }
  }

  /**
   * Carry out an update the board asked for (issue #40; host/update.js has
   * the steps). Each step goes to the board as an `update` event the moment it
   * starts and ends; the events survive the board's own restart in the
   * outbox, which retries. Last, this process exits and launchd starts the
   * new code — after every event has been delivered, because the board
   * closes the run only on hearing the restart and then this host again.
   */
  update(item) {
    const p = item.payload ?? {};
    const say = (step, state, detail) => {
      (state === 'failed' || state === 'refused' ? warn : log)(`update ${String(p.commit).slice(0, 7)}: ${step} ${state}${detail ? ` — ${detail}` : ''}`);
      return this.emit({ type: 'update', run_id: p.run_id, step, state, detail, at: new Date().toISOString() }, true);
    };
    if (this.updating) {
      say('preflight', 'refused', 'this host is already carrying out an update');
      return;
    }
    const restart = async () => {
      const until = Date.now() + 60_000;
      while (this.outbox.length && Date.now() < until) { await this.flush(); if (this.outbox.length) await sleep(1000); }
      log('update: exiting so launchd starts the new build');
      await this.stop();
      process.exit(0);
    };
    this.updating = U.runUpdate({ commit: p.commit, branch: p.branch, repo: p.repo, from: p.from, finish: p.finish === true }, { say, boardUrl: this.cfg.url, restart })
      .catch((err) => say('preflight', 'failed', `the update stopped on an error in the host: ${err.message}`))
      .finally(() => { this.updating = null; });
  }

  /**
   * Read the roster and the transcripts, forever, on its own clock.
   *
   * This is deliberately not part of run(). The two used to share one loop, and
   * handling a chat blocked it: send() opens a window, waits up to
   * READY_TIMEOUT_MS for Claude Code to come up, then up to LAND_TIMEOUT_MS for
   * the message to appear in the transcript. For that minute-plus the floor was
   * told nothing at all — no reply, not even the echo of the message it had
   * just sent, which the composer reads as a send that failed. Then the whole
   * minute arrived in a single batch the moment send() returned. Relaying what
   * is happening cannot be behind doing what was asked.
   */
  async watchLoop() {
    while (!this.stopping) {
      try { await this.watch(); } catch (err) { warn(`watch: ${err.message}`); }
      // An earlier host's window that was mid-turn at the start: looked at
      // each tick until its turn ends, then ended (sweepLegacy).
      if (this.legacyWaiting) { try { await this.sweepLegacy(); } catch (err) { warn(`legacy windows: ${err.message}`); } }
      if (this.stopping) break;
      await sleep(WATCH_MS);
    }
  }

  async run() {
    let backoff = 1000;
    let lastRegister = 0;
    let watching = null;
    while (!this.stopping) {
      try {
        if (Date.now() - lastRegister > HEARTBEAT_MS) {
          // Look before saying: the heartbeat names every desk this host has,
          // so a desk bound since the last one is on the board a minute later
          // at the latest, with nothing restarted. See rescan().
          await this.rescan('heartbeat');
          // And whether Claude Code is still signed in here, so the board can
          // say a desk cannot answer before anybody types to it (host/auth.js).
          await this.checkAuth('heartbeat', { register: false });
          await this.register();
          lastRegister = Date.now();
          this.registered = true;
          for (const say of (this.afterRegister ?? []).splice(0)) say();
          // Attachments past Claude Code's own cleanupPeriodDays (host/uploads.js).
          try {
            const gone = UP.sweepUploads();
            if (gone) log(`removed ${gone} attachment${gone === 1 ? '' : 's'} older than ${UP.retentionDays()} days`);
          } catch (err) { warn(`attachment sweep: ${err.message}`); }
        }
        // The relay starts only after the first registration has landed, and
        // that order is not tidiness. A desk's first watch tick reports which
        // session is live there and who holds it, and the server files both
        // against a row that register() creates — an event for a desk the
        // server has never heard of is dropped without a word. Started beside
        // register(), the first tick won that race on a desk new to this host
        // (measured 2026-09-02: a session adopted and reported within
        // milliseconds of boot, invisible on the board for a full heartbeat),
        // and neither event is ever re-sent, because from the host's side
        // nothing changed. Still a separate loop once it runs — see watchLoop.
        watching ??= this.watchLoop();
        // The long poll is the pacing for *work*. The transcripts are read by
        // watchLoop() beside this, not between these lines.
        // What was finished since the last poll rides on this one; kept
        // until a poll carrying it has been answered.
        const saying = this.acks.slice();
        const reply = await this.request(
          `/api/host/work?host_id=${encodeURIComponent(this.cfg.hostId)}&wait=${Math.ceil(WATCH_MS / 1000)}&boot=${this.boot}${saying.length ? `&done=${saying.join(',')}` : ''}`,
          { timeout: WATCH_MS + 10_000 },
        );
        this.acks = this.acks.filter((id) => !saying.includes(id));
        // One at a time, and none started once a stop has begun: those go
        // back in line for the next run (stop()).
        // What a sign-in left for this line: a window to reopen once Claude
        // Code is signed in again (signIn). On the line, because it closes a
        // window, and nothing else may be typing into it meanwhile.
        while (this.later.length && !this.stopping) {
          const job = this.later.shift();
          await job().catch((err) => warn(`a job left for the host's line: ${err.message}`));
        }
        this.inHand = (reply.work ?? []).slice();
        while (this.inHand.length && !this.stopping) {
          const item = this.inHand.shift();
          // Which desk the host is acting on, so the watch does not put the
          // host's own passing screens on the floor as unknown (Desk.tick).
          this.acting = { channel: item.channel, agent: item.agent };
          this.current = this.handle(item).catch((err) => warn(`${item.kind} for ${item.channel}/${item.agent}: ${err.message}`));
          await this.current;
          this.current = null;
          this.acting = null;
          this.acks.push(item.id);
          // Said now when more of the batch is still to go, not on the next
          // poll: that poll comes only after the whole batch, and a host
          // killed before it had every item it finished said lost on its
          // desk, a typed message among them as "send it again" (QA, the
          // milestone audit's re-measure, L1). The last item of a batch
          // rides the poll that follows at once. A failure leaves it for
          // that poll, as before.
          if (this.inHand.length) await this.sayDone();
        }
        backoff = 1000;
      } catch (err) {
        if (this.stopping) break;
        warn(`${err.message}; retrying in ${backoff / 1000}s`);
        lastRegister = 0;
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
    if (watching) await watching;
  }

  /** What this run finished and has not said yet, told to the board now (the release route with nothing to release). */
  async sayDone() {
    const saying = this.acks.slice();
    if (!saying.length) return;
    try {
      await this.request('/api/host/work/release', { method: 'POST', body: { host_id: this.cfg.hostId, boot: this.boot, done: saying, release: [] }, timeout: 5000 });
      this.acks = this.acks.filter((id) => !saying.includes(id));
    } catch (err) { warn(`finished work not said yet (${err.message}); it goes with the next work poll`); }
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    log('shutting down');
    // A folder dialog is this process's question, and with nobody left to
    // hear the answer it comes off the screen.
    this.picking?.close();
    try { this.searching?.child.kill('SIGTERM'); } catch { /* already gone */ }
    // The item in hand is finished, up to STOP_DRAIN_MS: a message half
    // typed is the worst way to stop. What was taken and never started goes
    // back in line for the next run, and what was finished is said, so the
    // board loses nothing it handed over (takeHostWork's guarantee). A host
    // killed outright says neither; its next run's registration sorts that.
    if (this.current) {
      const left = await Promise.race([this.current.then(() => false), sleep(STOP_DRAIN_MS).then(() => true)]);
      if (left) warn(`stopping with an item still in hand after ${STOP_DRAIN_MS / 1000}s; the next run will say it on its desk`);
    }
    const release = this.inHand.map((i) => i.id);
    if (release.length || this.acks.length) {
      try {
        await this.request('/api/host/work/release', { method: 'POST', body: { host_id: this.cfg.hostId, boot: this.boot, done: this.acks, release }, timeout: 2000 });
        if (release.length) log(`handed ${release.length} item${release.length === 1 ? '' : 's'} not yet started back to the board`);
      } catch (err) { warn(`release not delivered (${err.message}); the next run will sort what this one took`); }
    }
    // Each desk's Claude Code is this process's child now (host/desk.js):
    // its input is closed, so a turn running finishes and the process
    // leaves, and one that has not left by the grace is ended. The
    // conversation is on disk; the next run of the host resumes it at the
    // desk's next message.
    await Promise.all([...this.desks.values()].map((d) => d.stop().catch(() => {})));
    // One last read of every desk's transcript, so what was written between
    // the relay's last tick and the stop reaches the floor (pc-developer,
    // measured on Windows: a reply finished 234 ms before a stop was never
    // relayed, and the next run joins the transcript at its end).
    try { await this.watch(); } catch (err) { warn(`last read of the transcripts: ${err.message}`); }
    await this.flush();
    // Best effort — the board reads a host whose heartbeat has stopped as
    // gone anyway (HOST_STALE_SECONDS) — but said, like every other request
    // that fails.
    try { await this.request('/api/host/unregister', { method: 'POST', body: { host_id: this.cfg.hostId }, timeout: 2000 }); } catch (err) { warn(`unregister not delivered (${err.message})`); }
  }
}

/* ───────────────────────── main ───────────────────────── */

async function main() {
  const cfg = loadConfig();

  const { desks: found, folders } = discover(cfg.roots);
  if (!found.length) {
    warn(`no desks found under ${cfg.roots.join(', ')} — a desk is a directory whose .mcp.json carries X-Channel and X-Agent`);
  }

  // Which board this host serves. A configured url wins; otherwise the desks
  // decide, and only when they agree. Taking the first desk in walk order is
  // what this used to do, and it is how a host ends up bound to a board none of
  // the desks you care about live on: it registers, reports itself healthy, and
  // silently serves nothing, with the only evidence a `skipping` line that
  // scrolls past. Ambiguity is the user's to resolve, so say so and stop.
  const origins = [...new Set(found.map((d) => originOf(d.url)).filter(Boolean))];
  if (!cfg.url && origins.length === 1) cfg.url = origins[0];
  if (!cfg.url && origins.length > 1) {
    error(`the desks under ${cfg.roots.join(', ')} point at ${origins.length} different boards, and nothing here says which one this host serves:`);
    for (const o of origins) {
      const names = found.filter((d) => originOf(d.url) === o).map((d) => `${d.channel}/${d.agent}`);
      const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? `, +${names.length - 3} more` : '');
      error(`  ${o}  — ${names.length} desk${names.length === 1 ? '' : 's'}: ${shown}`);
    }
    error('pick one:  ./host/install.sh --url <board> <your projects dir>');
    error(`or set ORCH_URL, or add "url" to ${CONFIG_FILE}`);
    process.exit(1);
  }
  if (!cfg.url) {
    error('no server: set ORCH_URL, or put a repo with an orchestratinator .mcp.json under ORCH_HOST_ROOTS');
    process.exit(1);
  }
  cfg.url = cfg.url.replace(/\/+$/, '');
  const origin = originOf(cfg.url);
  const mine = found.filter((d) => originOf(d.url) === origin);
  for (const d of found.filter((d) => originOf(d.url) !== origin)) {
    log(`skipping ${d.channel}/${d.agent} — its board is ${originOf(d.url)}, this host serves ${origin}`);
  }
  // The shared secret, and where it came from. A desk's own binding wins over
  // ORCH_AUTH_TOKEN and over host.json (operator's rule, 2026-09-09): a repo
  // bound by hand is the most direct statement of which key this board takes,
  // and a machine whose environment carries a stale one should follow its
  // desks rather than the other way round. The environment and the file exist
  // for the machine with no hand-bound desk at all — every desk on it taken
  // from the floor, which the host can only do with a key of its own. From a
  // desk on the board we actually serve: a key from another board
  // authenticates against nothing here. The value itself is never logged.
  const keyed = mine.find((d) => d.key);
  const bindingOf = (d) => `${d.channel}/${d.agent}'s ${d.scope === 'local' ? 'local-scope entry' : '.mcp.json'}`;
  if (keyed) {
    const overrides = cfg.token && cfg.token !== keyed.key ? `, which overrides ${cfg.tokenSource}` : '';
    log(`shared secret: from ${bindingOf(keyed)}${overrides}`);
    cfg.token = keyed.key;
    cfg.tokenSource = 'a desk';
    const others = mine.filter((d) => d.key && d.key !== keyed.key);
    if (others.length) warn(`${others.length} desk${others.length === 1 ? '' : 's'} carr${others.length === 1 ? 'ies' : 'y'} a different key from ${keyed.channel}/${keyed.agent}'s — ${others.map((d) => `${d.channel}/${d.agent}`).join(', ')}. One board takes one key; using ${keyed.channel}/${keyed.agent}'s, and the others will be refused by the board.`);
  } else {
    // A desk whose key is a placeholder this host cannot fill (`keyUnset`,
    // host/identity.js) is named, because under launchd that is every such
    // desk: the LaunchAgent's environment is PATH and HOME, so a repo that
    // keeps `${ORCH_AUTH_TOKEN}` in its .mcp.json works in its own windows
    // and gives the host nothing (QA, PR #52 finding 1). Without the name the
    // log said only that there was no key, and the README had said such a
    // machine needed no --token.
    const ph = mine.filter((d) => d.keyUnset);
    const vars = [...new Set(ph.flatMap((d) => d.keyUnset))].map((v) => `\${${v}}`).join(', ');
    const placeholders = ph.length
      ? `${ph[0].channel}/${ph[0].agent}${ph.length > 1 ? ` and ${ph.length - 1} other desk${ph.length === 2 ? '' : 's'}` : ''} carr${ph.length === 1 ? 'ies' : 'y'} its key as ${vars}, which this host's environment does not set`
      : null;
    if (cfg.token) {
      log(`shared secret: from ${cfg.tokenSource} (${placeholders ?? 'no desk here carries one'})`);
    } else {
      warn(`no shared secret: ${placeholders ?? 'no desk here carries a key'}, ORCH_AUTH_TOKEN is unset and ${CONFIG_FILE} has no "token". A board that enforces one will refuse this host, and the floor cannot bind a desk from here. Give it one with:  ${INSTALL_TOKEN_LINE}`);
    }
  }
  W.useKey(cfg.token);
  if (found.length && !mine.length) {
    warn(`every desk found points at another board — this host serves ${origin} and has nothing to do`);
  }

  await U.readBuild();
  const by = U.supervisor();
  log(`build ${U.BUILD.version} at ${U.BUILD.commit?.slice(0, 7) ?? 'an unknown commit'} · protocol ${U.BUILD.protocol ?? 'none'} · clone ${U.CLONE}${by === 'launchd' ? '' : by === 'app' ? ' · run by the desktop app, which updates it' : by ? ` · run by ${by}, which the board cannot update` : ' · not under launchd, so the board cannot update this host'}`);
  // The folder dialog's backend, when it is the parent process: said at
  // startup, because a host told to ask a parent it does not have would
  // otherwise only be found out at the first click (host/dialog.js).
  if (D.dialogBackend() === 'parent' && !D.parentPort()) warn('ORCH_FOLDER_DIALOG=parent, but nothing started this process with a message port — this host has no folder dialog');

  // Desks an earlier run of this host left running when it died without its
  // stop (a kill, a crash): ended before anything here resumes their
  // conversations beside them (task 340; W.endLeftoverDesks).
  const leftovers = await W.endLeftoverDesks(W.deskPidsFile(cfg.hostId));
  for (const l of leftovers) log(`ended a desk's Claude Code an earlier run of this host left running (pid ${l.pid}${l.cwd ? `, ${l.cwd}` : ''}${l.session ? `, conversation ${l.session}` : ''})`);

  const host = new Host(cfg);
  host.folders = folders;
  for (const d of mine) host.desks.set(`${d.channel}|${d.agent}`, new Desk(host, d));
  // The tmux windows an earlier build (0.14.x) ran these desks in, ended so
  // their conversations come to the floor instead of reading "held by an
  // editor" behind a window nobody can see (W.endLegacyWindows, task 341).
  // A window mid-turn is left to finish and looked at again by the watch.
  await host.sweepLegacy({ deferTold: true });

  log(`${cfg.name} (${cfg.hostId}) → ${cfg.url} · ${mine.length} desk${mine.length === 1 ? '' : 's'}`);
  for (const d of mine) log(`  ${d.channel}/${d.agent}  ${d.cwd}  (${d.scope} scope)`);

  let stopped = null;
  const stop = () => (stopped ??= host.stop().finally(() => process.exit(0)));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  // A host that exits on anything but its stop (an uncaught error, a fatal
  // one in main) takes its desks with it rather than leaving each to finish
  // its turn with nobody listening (task 340). A kill outright runs nothing
  // here: the next run's endLeftoverDesks is for that.
  process.on('exit', () => {
    for (const d of host.desks.values()) { try { d.proc?.kill('SIGTERM', { sync: true }); } catch { /* gone */ } }
  });
  // And when the process that started it says so, which is the only stop
  // Windows has: Task Scheduler's own is a kill with no signal (measured), so
  // host/supervise.mjs asks over the IPC channel and waits. Any parent may
  // send it; none sent it before, so nothing else changes.
  D.parentPort()?.on((m) => { if (m && typeof m === 'object' && m.type === 'stop') stop(); });

  await host.run();
}

main().catch((err) => {
  error('fatal:', err?.stack ?? err);
  process.exit(1);
});

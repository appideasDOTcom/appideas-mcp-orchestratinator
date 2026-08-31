/**
 * A repo's Claude Code window.
 *
 * There is one conversation per repo and no such thing as owning it. Claude
 * Code runs in a tmux pane; the floor types into that pane; you type into it
 * too, by attaching to the same pane in your own terminal. Neither of you is
 * "the driver", because a pane is not a thing that can be held. Switching
 * between the floor and the terminal costs nothing, because nothing moves.
 *
 * This replaces the old driver/release/fork/TTL/pid-watch machinery, which
 * existed solely to work around "a terminal owns its session outright and
 * cannot be typed into from anywhere else". That was never true:
 *
 *   - `~/.claude/sessions/<pid>.json` is every live session announcing its own
 *     pid, cwd and session id. (`claude agents --json` prints the same thing
 *     and is the fallback, but it boots the whole CLI to do it — thirteen
 *     seconds here — which no watch loop can afford.)
 *   - `tmux send-keys` / `paste-buffer` deliver a real user turn into a live
 *     interactive session.
 *   - `~/.claude/projects/<slug>/<session>.jsonl` is both sides of the
 *     conversation, so the floor mirrors by tailing a file.
 *
 * All three are documented, stable surfaces. Nothing here reverse-engineers a
 * protocol, so a Claude Code update cannot silently break it.
 *
 * Everything lives in one tmux session (ORCH_TMUX_SESSION, default `orch`)
 * with one window per repo, named after the repo's directory. That means
 * `tmux attach -t orch` is a perfectly good front end to the whole board: the
 * windows are the desks, in the same order the floor shows them.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * tmux escapes whatever it thinks the terminal cannot print, so a directory
 * with a character outside ASCII comes back as octal escapes unless the locale
 * says UTF-8 — and under launchd there is no locale at all. Take the person's
 * if they have one; otherwise say UTF-8, because a repo's name is not ours to
 * mangle.
 */
const TMUX_ENV = {
  ...process.env,
  LC_ALL: process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || 'en_US.UTF-8',
};

const TMUX = process.env.ORCH_TMUX ?? 'tmux';
/**
 * The field separator for `-F` formats.
 *
 * This was a tab, and it cost an evening. tmux puts its format output through
 * the same escaping a terminal gets, and with no locale in the environment —
 * which is exactly the case under launchd, where this host actually runs — a
 * tab comes back as `_`. Every field ran together, so panes() parsed nothing,
 * every send opened a *second* window for a repo that already had one, and
 * then failed against a target like `orch:@3.%3_8235`. Run by hand from a
 * shell, where a locale is set, the identical code was fine.
 *
 * TMUX_ENV below stops that happening again, but the separator is a printable
 * character regardless: parsing does not get to depend on an environment
 * variable. Every field before the last is tmux's own ids or a session name
 * sanitised on the way in, so none of them can contain it — see panes().
 */
const SEP = '|';
const SESSION = (process.env.ORCH_TMUX_SESSION ?? 'orch').replace(/[^A-Za-z0-9._-]/g, '-') || 'orch';
const CLAUDE = process.env.ORCH_HOST_CLAUDE ?? 'claude';
/** Long enough for a cold `claude agents --json`, short enough not to stall a poll. */
const LIST_TIMEOUT_MS = Number(process.env.ORCH_ROSTER_TIMEOUT_MS ?? 15_000);
/** How long a freshly opened window gets to become a running session. */
const READY_TIMEOUT_MS = Number(process.env.ORCH_READY_TIMEOUT_MS ?? 45_000);
/** Pause before each attempt to submit a pasted message — see send(). */
const SUBMIT_SETTLE_MS = Number(process.env.ORCH_SUBMIT_SETTLE_MS ?? 400);
/** How long a message waits for a running turn to end before it is typed in. */
const IDLE_TIMEOUT_MS = Number(process.env.ORCH_IDLE_TIMEOUT_MS ?? 300_000);
/** How long a pasted message has to become a turn before it counts as lost. */
const LAND_TIMEOUT_MS = Number(process.env.ORCH_LAND_TIMEOUT_MS ?? 20_000);
/** How many times Enter is pressed before giving up on a paste — see send(). */
const SUBMIT_ATTEMPTS = Math.max(1, Number(process.env.ORCH_SUBMIT_ATTEMPTS ?? 3));
/** How long one paste has to show up in the composer before it is re-sent. */
const PASTE_CONFIRM_MS = Number(process.env.ORCH_PASTE_CONFIRM_MS ?? 3_000);
/** The whole budget for getting the text into the composer — see pasteInto(). */
const PASTE_TIMEOUT_MS = Number(process.env.ORCH_PASTE_TIMEOUT_MS ?? 60_000);
/**
 * Where Claude Code keeps its own files. Overridable so the tests can prove
 * what happens to a message that never lands without writing into the real one.
 */
const CLAUDE_HOME = process.env.ORCH_CLAUDE_HOME ?? join(homedir(), '.claude');

/**
 * tmux exits non-zero for ordinary answers ("no such session"), so callers
 * that are asking a question rather than giving an order use `ok: false`
 * instead of catching. Only a missing tmux binary is worth reporting up.
 */
async function tmux(args, { timeout = 5000 } = {}) {
  try {
    const { stdout } = await run(TMUX, args, { timeout, encoding: 'utf8', env: TMUX_ENV });
    return { ok: true, out: stdout.trim() };
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: false, missing: true, error: 'tmux is not installed' };
    return { ok: false, error: (err?.stderr || err?.message || String(err)).trim() };
  }
}

/** Whether tmux is usable at all. The floor degrades honestly if it isn't. */
export async function tmuxAvailable() {
  const r = await tmux(['-V']);
  return r.ok;
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

/* ───────────────────────── the roster ───────────────────────── */

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
      kind: typeof d.kind === 'string' ? d.kind : 'interactive',
      // How this session was started — 'claude-vscode' for the VS Code
      // extension, and so on. It is the difference between a window that can be
      // typed into and one that has to be reached another way, which is not a
      // detail: it decides whether a message can be delivered at all.
      entrypoint: typeof d.entrypoint === 'string' ? d.entrypoint : null,
      name: typeof d.name === 'string' ? d.name : null,
      startedAt: Number(d.startedAt) || null,
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

/** The live session for a repo, if one is open. Newest wins if a repo has two. */
export async function sessionFor(cwd) {
  const r = await roster();
  if (!r.ok) return { ...r, session: null };
  const here = canonical(cwd);
  const mine = r.sessions
    .filter((s) => s.cwd === here && s.kind === 'interactive')
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return { ok: true, session: mine[0] ?? null };
}

/**
 * The questions the host is allowed to answer for you, and the answer.
 *
 * Deliberately one entry long, and it will stay short. Most of what Claude Code
 * asks on the way up is a decision that is genuinely the operator's — whether a
 * folder is trusted, whether an MCP server may run. Answering those on someone's
 * behalf is the thing that must not be automated, so they are not here and the
 * window keeps waiting for a person.
 *
 * The resume-mode question is different, and the difference is not that it
 * matters less. Its answer is *forced* by what a handoff is. This whole system
 * rests on a conversation being one process that moves between windows intact;
 * "resume from summary" hands the new window a lossy copy, which is not moving a
 * conversation but forking one. There is exactly one option consistent with the
 * button the operator pressed, and the prompt's warning is about a cost they
 * already accepted by pressing it.
 *
 * Matched on the option's *words*, never its number. The numbers mean opposite
 * things from one dialog to the next — on the trust question "2" is "No, exit" —
 * so a host that learned to press a number would eventually press it at the
 * wrong screen.
 */
const ANSWERS = [
  {
    name: 'resume mode',
    // The sentence that identifies the screen, not one of the options: a menu
    // has to be recognised before anything is pressed at it.
    asks: /Resuming the full session will consume/i,
    pick: /^\s*[\u276f>]?\s*\d+\.\s*Resume full session as-is/i,
  },
];

/** One option's words, without the cursor that may or may not be sitting on it.
 *  Comparing raw lines instead is how the read-back below silently never
 *  matched: the line it had planned for had no cursor, and the line it read
 *  back had one. */
const optionText = (line) => String(line ?? '').replace(/^\s*[\u276f>]?\s*/, '').trim();

/** The numbered options on screen, and which one the cursor is on. */
export function menuOf(screen) {
  const rows = [];
  let at = -1;
  for (const line of screen.split('\n')) {
    if (!/^\s*[\u276f>]?\s*\d+\.\s/.test(line)) continue;
    if (/^\s*[\u276f>]/.test(line)) at = rows.length;
    rows.push(line);
  }
  return { rows, at };
}

/**
 * Answer a question the host recognises, if one is on screen.
 *
 * Nothing is confirmed blind. The cursor is walked to the wanted option, the
 * screen is read back, and Enter is pressed only once the highlighted line is
 * the line that was asked for. If it is not — the menu redrew, the wording
 * moved, anything — this gives up and returns null, and the caller goes on
 * waiting and eventually quotes the screen. A question we half-recognise is a
 * question for a person.
 */
export function plannedAnswer(screen, done = new Set()) {
  const known = ANSWERS.find((a) => a.asks.test(screen) && !done.has(a.name));
  if (!known) return null;
  const { rows, at } = menuOf(screen);
  const want = rows.findIndex((r) => known.pick.test(r));
  if (at < 0 || want < 0) return null;
  return { name: known.name, from: at, to: want, chose: optionText(rows[want]) };
}

async function answerKnown(target, done = new Set()) {
  const plan = plannedAnswer(await screenOf(target), done);
  if (!plan) return null;

  const key = plan.to > plan.from ? 'Down' : 'Up';
  for (let n = 0; n < Math.abs(plan.to - plan.from); n++) {
    const moved = await tmux(['send-keys', '-t', target, key]);
    if (!moved.ok) return null;
    await sleep(60);
  }

  // Read it back before committing. This is the whole safety of the thing: the
  // cursor has to be sitting on the line that was asked for, on the screen as
  // it is now, before anything is confirmed.
  const now = menuOf(await screenOf(target));
  if (now.at < 0 || optionText(now.rows[now.at]) !== plan.chose) return null;
  const sent = await tmux(['send-keys', '-t', target, 'Enter']);
  if (!sent.ok) return null;
  return { name: plan.name, chose: plan.chose };
}

/**
 * Wait until this repo has a live Claude Code session, not merely a pane.
 *
 * The roster is the honest readiness signal: a session appears in it only once
 * it is actually running, which is after any dialog on the way up has been
 * answered — and while waiting, this answers the ones the host is allowed to
 * answer (see ANSWERS; it is one question long, and the reasoning for keeping
 * it that way is written there). Timing out is not an error to hide — it means
 * the window is sitting on a question the host would not answer for you, and
 * the floor quotes it rather than naming a cause.
 *
 * `pid` matters more than it looks. A repo can have two Claude Code sessions in
 * it — the one this host just opened in a pane, and one the person already had
 * open in their editor — and asking merely "is a session running in this
 * directory" is then answered instantly by the wrong one. The paste goes into
 * the window that is still booting and is lost. The pane's own process is the
 * only unambiguous way to ask about the window we actually opened.
 */
export async function waitReady(cwd, { timeoutMs = READY_TIMEOUT_MS, pid = null, target = null } = {}) {
  const stop = Date.now() + timeoutMs;
  let seen = [];
  const answered = [];
  const done = new Set();
  for (;;) {
    // Did it exit? A window that is gone is never going to become ready, and
    // waiting the full timeout to say nothing useful about it helps nobody.
    if (target) {
      const dead = await tmux(['display-message', '-p', '-t', target, '#{pane_dead}']);
      if (dead.ok && dead.out.trim() === '1') {
        const last = await tmux(['capture-pane', '-p', '-t', target, '-S', '-40']);
        await tmux(['kill-window', '-t', target]);
        const said = (last.out ?? '').split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-6).join(' / ');
        return {
          ok: false,
          code: 'window_exited',
          error: `Claude Code exited as soon as the window opened${said ? `: ${said}` : ' without saying anything'}`,
        };
      }
    }
    // The screen before the roster, and that order is the whole point. The
    // roster does NOT wait for the startup question: a window sitting on the
    // resume-mode menu is registered, interactive, and completely unable to
    // take a message. Checking the roster first returned ok in a few
    // milliseconds and left the question standing — which is the bug this was
    // written to fix, reproduced by the fix itself.
    //
    // Each question is answered at most once. Still on screen next time round
    // means it was not really answered, and pressing Enter at it again is
    // guessing.
    if (target) {
      const did = await answerKnown(target, done);
      if (did) {
        done.add(did.name);
        answered.push(did);
        await sleep(250);
        continue;                       // let it redraw before judging it ready
      }
    }

    const all = await roster();
    seen = all.sessions;
    const session = pid
      ? all.sessions.find((s) => s.pid === pid) ?? null
      : (await sessionFor(cwd)).session;
    if (session) {
      // Up and running: let the window close normally from here on.
      if (target) await tmux(['set-option', '-w', '-t', target, 'remain-on-exit', 'off']);
      return { ok: true, session, answered };
    }
    if (Date.now() >= stop) {
      // Show the screen rather than name a cause. This used to assert a trust
      // dialog, which is only one of the things that stops a window here: an
      // MCP server waiting to be approved does it too, and so does anything
      // else Claude Code puts up before it registers. Naming the wrong one is
      // worse than naming none — it sends the reader off to answer a prompt
      // that isn't there while the real one sits on screen, unread. The window
      // is still alive at this point (a dead one returned above), so whatever
      // is blocking it can simply be quoted.
      const shot = target ? await tmux(['capture-pane', '-p', '-t', target, '-S', '-40']) : null;
      const onScreen = (shot?.out ?? '')
        .split('\n')
        .map((l) => l.replace(/\s+$/, ''))
        .filter(Boolean)
        .slice(-8)
        .join(' / ');
      const roll = seen.length
        ? seen.map((x) => `${x.pid}@${x.cwd}`).join(', ')
        : 'nothing at all';
      return {
        ok: false,
        code: 'not_ready',
        error: `Claude Code is open in that window but has not finished starting — something on screen is waiting for an answer. Attach with \`tmux attach -t ${SESSION}\` and reply to it, and this will go through.${onScreen ? ` The window is showing: ${onScreen}` : ''} (waited for ${pid ? `pid ${pid}` : cwd} for ${Math.round(timeoutMs / 1000)}s; the roster had ${roll})`,
      };
    }
    await sleep(400);
  }
}

/* ───────────────────────── the window ───────────────────────── */

/**
 * A tmux window name has to survive `tmux select-window -t orch:name`, so it
 * carries only characters that mean nothing to tmux's target syntax. It is not
 * an identifier — two repos can produce the same one — so nothing matches on it
 * alone; see paneFor.
 */
export function windowName(cwd) {
  return basename(cwd).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40) || 'desk';
}

/** Every live pane in our tmux session. */
export async function panes() {
  // The directory goes last and takes everything after the third separator: it
  // is the one field whose contents are not ours, and a directory is allowed
  // to contain a '|'. The three before it are tmux's own ids and a flag.
  const fields = ['#{session_name}:#{window_id}.#{pane_id}', '#{pane_dead}', '#{pane_pid}', '#{pane_current_path}'];
  const r = await tmux(['list-panes', '-t', SESSION, '-a', '-F', fields.join(SEP)]);
  if (!r.ok || !r.out) return [];
  return r.out.split('\n')
    .map((line) => {
      const parts = line.split(SEP);
      if (parts.length < fields.length) return null;
      const [target, dead, pid] = parts;
      // The window id is inside the target (session:@window.%pane). It is what
      // a person needs to be given to sit down at this desk, and pulling it
      // out of a string we already have beats another tmux call.
      const window = target.match(/@\d+/)?.[0] ?? null;
      return { target, window, dead: dead === '1', pid: Number(pid) || null, cwd: parts.slice(3).join(SEP) };
    })
    .filter((p) => p && p.target && p.cwd && !p.dead);
}

/** The window names already in use, so a new window can avoid colliding. */
async function windowNames() {
  const r = await tmux(['list-windows', '-a', '-F', '#{window_name}']);
  return r.ok && r.out ? r.out.split('\n') : [];
}

/**
 * The pane running this repo's Claude Code, or null.
 *
 * The directory is the identity, and the only one. A window is *named* after
 * the repo's last path segment because that is what reads well in `tmux
 * attach`, but a name is not an identifier: two repos can end in the same
 * segment — two checkouts of one project, or any two `api` folders — and
 * delivering one agent's message into another agent's window is far worse than
 * any failure that comes of being strict here.
 *
 * There was briefly a "fall back to the name if exactly one pane has it" clause
 * for the case of a pane whose directory drifts. It reintroduced the collision
 * through the back door: opening the second desk found the first desk's window
 * by name and handed it over. If a pane's directory ever does drift, this opens
 * a second window — visible, and recoverable — rather than quietly typing into
 * the wrong one.
 */
export async function paneFor(cwd) {
  const here = canonical(cwd);
  const all = await panes();
  return all.find((p) => canonical(p.cwd) === here) ?? null;
}

/**
 * A live Claude Code for this repo that is not in any tmux pane.
 *
 * The floor types by pasting into a pane, so a session running anywhere else —
 * an editor's built-in terminal, a plain shell — cannot be typed into at all.
 * Opening a second one "for the floor" is far worse than refusing: both resume
 * the same conversation and append to the same transcript, so every message the
 * floor sends is read and answered by the copy, in a window nobody is watching,
 * while the person waits in the one they are actually sitting at. That is not a
 * hypothetical — it is what this did.
 */
export async function outsideTmux(cwd) {
  const here = canonical(cwd);
  const [r, all] = await Promise.all([roster(), panes()]);
  if (!r.ok) return null;
  const inPanes = new Set(all.map((p) => p.pid).filter(Boolean));
  return r.sessions.find((s) => s.cwd === here && s.kind === 'interactive' && !inPanes.has(s.pid)) ?? null;
}

/**
 * Who is holding a particular conversation right now.
 *
 * The question is about the conversation, not the directory. A repo can have
 * several open at once — two editor tabs and a window the floor started — and
 * "is anything running here" answers none of the things that matter: whether
 * the floor can type, and where the person is sitting. Asking it that way had
 * the floor believing it held a desk because *some* pane existed, while the
 * conversation on screen was in an editor tab it could never reach.
 */
export async function holderOf(cwd, sessionId) {
  if (!sessionId) return { where: null, pid: null, window: null };
  const [r, all] = await Promise.all([roster(), panes()]);
  if (!r.ok) return { where: null, pid: null, window: null };
  const live = r.sessions.find((x) => x.sessionId === sessionId);
  if (!live) return { where: null, pid: null, window: null };
  const pane = all.find((p) => p.pid === live.pid);
  if (pane) return { where: 'floor', pid: live.pid, window: pane.window };
  return { where: 'editor', pid: live.pid, window: null };
}

/**
 * Whether the window is in the middle of a turn.
 *
 * Claude Code offers `esc to interrupt` exactly while it is working, so that
 * is the signal. It is a string on a screen, which nobody promised to keep —
 * but it is only ever used to decide to *wait longer*, and nothing is believed
 * because of it. If the wording ever changes this reads as idle and the send
 * behaves as it would have anyway, verification and all.
 */
async function busy(target) {
  const r = await tmux(['capture-pane', '-p', '-t', target, '-S', '-6']);
  return r.ok && /esc to interrupt/i.test(r.out);
}

/** Wait for a turn to finish. Resolves false if it simply never does. */
async function waitIdle(target, ms = IDLE_TIMEOUT_MS) {
  const stop = Date.now() + ms;
  for (;;) {
    if (!(await busy(target))) return true;
    if (Date.now() >= stop) return false;
    await sleep(500);
  }
}

/** What the window looks like right now, for deciding whether it is doing
 *  anything. Short, because this is asked repeatedly. */
async function screenOf(target, lines = 12) {
  const r = await tmux(['capture-pane', '-p', '-t', target, '-S', `-${lines}`]);
  return r.ok ? r.out : '';
}

/**
 * Wait until the window stops redrawing.
 *
 * Claude Code takes a bracketed paste asynchronously, and an Enter that
 * arrives while it is still reading one is treated as part of the paste: it
 * becomes a newline in the composer instead of submitting. A fixed delay is a
 * guess at that, and a wrong one on a slow machine; the screen going still is
 * the actual condition, so that is what this waits for. It is not believed —
 * the message still has to be found in the transcript afterwards.
 */
async function settled(target, { quiet = 2, tries = 20 } = {}) {
  let last = null;
  let same = 0;
  for (let i = 0; i < tries && same < quiet; i++) {
    await sleep(SUBMIT_SETTLE_MS);
    const now = await screenOf(target);
    if (now === last) same++;
    else { same = 0; last = now; }
  }
  // Whether it actually went still, rather than ran out of tries. A window
  // that never stops redrawing is not the same as one that has quietened down
  // and the caller is entitled to know which it got — this used to return
  // nothing, so a window still painting a long transcript was indistinguishable
  // from an idle one and got typed into anyway.
  return same >= quiet;
}

/**
 * The text sitting in the composer, or null if no composer is on screen.
 *
 * The composer is the box at the bottom: a rule, a prompt line, its wrapped
 * continuation lines, another rule. Reading just that is the point — the rest
 * of the screen changes on its own (the hint line under the box rotates
 * through "? for shortcuts", "paste again to expand", "Ctrl+Y to paste deleted
 * text"), so a whole-screen comparison answers "did anything happen" rather
 * than "did my paste arrive".
 *
 * Returns null rather than an empty string when there is no box to read, which
 * is a different answer: the caller falls back to the whole screen instead of
 * concluding the composer is empty.
 *
 * The closing rule is required, and that is not tidiness. `❯` is also Claude
 * Code's selection cursor in a menu — the folder-trust question, the MCP
 * approval, and the resume-mode prompt a large `--resume` opens with all draw
 * one. Matching the marker alone, this read the highlighted option as composer
 * text, so pasteInto compared a menu against itself, saw nothing change, and
 * re-pasted into it until its budget ran out. A menu has no rule under it; the
 * composer is a box, which is what the paragraph above already said it was.
 *
 * Finding no box degrades to the old answer rather than a wrong one: the caller
 * falls back to the whole screen, which still changes when a real composer
 * takes a paste.
 */
export function composerOf(screen) {
  const lines = screen.split('\n');
  const rule = /^[\s│|]*[─━—-]{20,}/;
  let at = -1;
  for (let n = lines.length - 1; n >= 0; n--) {
    if (/^\s*[❯>]/.test(lines[n])) { at = n; break; }
  }
  if (at < 0) return null;
  const body = [lines[at].replace(/^\s*[❯>]/, '')];
  let closed = false;
  for (let n = at + 1; n < lines.length; n++) {
    if (rule.test(lines[n])) { closed = true; break; }
    body.push(lines[n]);
  }
  if (!closed) return null;
  return body.join('\n').replace(/\s+$/, '');
}

/** What to compare before and after a paste: the composer when there is one,
 *  the whole screen when there is not. */
async function inputState(target) {
  const screen = await screenOf(target);
  return composerOf(screen) ?? screen;
}

/**
 * Put the text in the composer, and prove it is there.
 *
 * A bracketed paste is not reliably delivered, and the failure is silent: tmux
 * reports success because it wrote the bytes, while Claude Code drops them.
 * The window this was found in had just been opened with `--resume` on a large
 * transcript, and the drop lines up exactly with the moment the session
 * registers itself — which is the moment waitReady() returns, so the floor was
 * pasting into the one instant the window would not take it. Measured on a
 * resume: a paste at 0.5s arrived, the paste at 1.1s — session registration —
 * vanished, and pastes from 1.6s on arrived. On the cold window this was
 * reported from, that gap was thirty seconds wide.
 *
 * So the paste is checked rather than assumed, the same way the submit already
 * is. What it can be checked against is limited: a long message is collapsed to
 * `[Pasted text #1 +39 lines]`, so its own text is not on screen to look for.
 * The composer *changing* is what is available, and it is enough — the composer
 * only changes here because something was typed into it.
 *
 * Before re-pasting, the composer is cleared. A paste that was merely slow
 * rather than dropped would otherwise be joined by the retry and submitted as
 * the message twice over.
 */
async function pasteInto(target, text) {
  const buffer = `orch-${process.pid}-${Math.abs(hash(target))}`;
  const stop = Date.now() + PASTE_TIMEOUT_MS;
  const done = new Set();
  let attempts = 0;
  for (;;) {
    // A question cannot be answered by pasting at it, and this is where that
    // was learnt: a window on the resume-mode menu took fourteen pastes over
    // sixty seconds and none of them were an answer. send() only calls
    // waitReady() for a pane it opened itself, and "Open on the floor" made a
    // pane it did not open the ordinary case — so the check belongs here too,
    // at the point where the message is actually going in.
    const did = await answerKnown(target, done);
    if (did) { done.add(did.name); await sleep(250); }

    // Never paste into a window that is still painting: that is when it drops
    // them. Not settling is not fatal — the paste is verified either way — but
    // it is worth waiting for while there is budget left.
    await settled(target);
    const before = await inputState(target);

    const set = await tmux(['set-buffer', '-b', buffer, '--', text]);
    if (!set.ok) return { ok: false, error: set.error };
    // -p is the bracketed paste; -d deletes the buffer so it doesn't pile up.
    const paste = await tmux(['paste-buffer', '-p', '-d', '-b', buffer, '-t', target]);
    if (!paste.ok) {
      await tmux(['delete-buffer', '-b', buffer]);
      return { ok: false, error: paste.error };
    }
    attempts++;

    const confirmBy = Date.now() + PASTE_CONFIRM_MS;
    while (Date.now() < confirmBy) {
      await sleep(250);
      if ((await inputState(target)) !== before) return { ok: true, attempts };
    }

    if (Date.now() >= stop) {
      // Say what is on the screen, not just how hard we tried. This error was
      // read once with no idea what it meant, because a count of attempts
      // describes our own behaviour and nothing about the window's — and the
      // window was sitting on a question the whole time, in plain sight of
      // anyone who thought to look. Retrying cannot answer a question, so the
      // pane is the only part of this worth reading. waitReady() has quoted its
      // screen on timeout for exactly this reason; this one never learned.
      const shot = await tmux(['capture-pane', '-p', '-t', target, '-S', '-40']);
      const onScreen = (shot.out ?? '')
        .split('\n')
        .map((l) => l.replace(/\s+$/, ''))
        .filter(Boolean)
        .slice(-8)
        .join(' / ');
      return {
        ok: false,
        code: 'paste_lost',
        error: `the window would not take the message — it was pasted in ${attempts} time${attempts === 1 ? '' : 's'} over ${Math.round(PASTE_TIMEOUT_MS / 1000)}s and never appeared in the composer. Nothing was sent.${onScreen ? ` The window is showing: ${onScreen}` : ''}`,
      };
    }
    // Clear anything that arrives late, so the next paste is not appended to a
    // copy of the same message. One Ctrl-U per line, and a collapsed paste is
    // one line however long the message was.
    for (let i = 0; i < 8; i++) await tmux(['send-keys', '-t', target, 'C-u']);
  }
}

/** Whitespace is not meaningful here: a composer rewraps, and a transcript
 *  records what was submitted rather than how it was typed. */
const squash = (t) => t.replace(/\s+/g, ' ').trim();

/** Whether this exact message is in the conversation yet. */
async function landed(path, after, text) {
  const want = squash(text);
  const t = await readTranscript(path, { after });
  return t.turns.some((x) => x.role === 'user' && squash(x.text).includes(want));
}
/**
 * Open this repo's Claude Code in a pane, or hand back the one already there.
 *
 * `resume` continues a specific conversation; without it Claude Code does what
 * it does in any terminal — which, for a repo that has a recent session, is
 * the same conversation the floor was just showing.
 */
export async function open(cwd, { resume = null } = {}) {
  if (!existsSync(cwd)) return { ok: false, error: `no such directory: ${cwd}` };

  const here = canonical(cwd);
  const already = await paneFor(here);
  if (already) return { ok: true, target: already.target, created: false };

  const stray = (await holderOf(here, resume)).where === 'editor' ? await outsideTmux(here) : null;
  if (stray) {
    return {
      ok: false,
      code: 'outside_tmux',
      error: `Claude Code is already running for this repo outside tmux (pid ${stray.pid}), and the floor can only type into a tmux window. Opening a second one would answer you in a copy you are not looking at. Quit that one, or sit in it here: tmux attach -t ${SESSION}`,
    };
  }

  // Keep the plain repo name when it is free, so `tmux attach` reads as a list
  // of desks. When another repo has already taken it, disambiguate rather than
  // create a second window with the same name — see paneFor.
  const taken = (await windowNames()).includes(windowName(here));
  const name = taken ? `${windowName(here)}-${(Math.abs(hash(here)) % 65536).toString(16).padStart(4, '0')}` : windowName(here);
  // `claude` is exec'd rather than run from a shell so the pane dies with the
  // session instead of dropping to a prompt that looks like a live window.
  const cmd = [CLAUDE, ...(resume ? ['--resume', resume] : [])]
    .map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`)
    .join(' ');

  // Take the target tmux hands back rather than looking the new pane up again.
  //
  // A pane does not report its directory the instant it is created, so asking
  // paneFor() straight afterwards could find nothing and fail with "the window
  // was created but no pane appeared" — a window would open, sit there, and the
  // message that opened it would be lost. `-P -F` prints the new pane's target
  // as part of creating it, which is exact and cannot race.
  const FORMAT = ['#{session_name}:#{window_id}.#{pane_id}', '#{pane_pid}'].join(SEP);
  const has = await tmux(['has-session', '-t', SESSION]);
  const made = has.ok
    ? await tmux(['new-window', '-d', '-P', '-F', FORMAT, '-t', SESSION, '-n', name, '-c', here, `exec ${cmd}`])
    : await tmux(['new-session', '-d', '-P', '-F', FORMAT, '-s', SESSION, '-n', name, '-c', here, `exec ${cmd}`]);
  if (!made.ok) return { ok: false, error: made.error, missing: made.missing };
  const [target, pid] = made.out.split('\n')[0].split(SEP);
  if (!target?.trim()) return { ok: false, error: 'tmux created the window but did not say where' };

  // Keep the pane if what we started exits, so its last words survive to be
  // read. Without this a window that dies on its first line — `claude` not on
  // PATH, a wrapper with a syntax error — leaves nothing behind but an empty
  // tmux session, and the only thing anyone can say is that it "has not
  // finished starting", for the full timeout. waitReady turns this off once
  // the session is really up, so a window that closes normally still closes.
  await tmux(['set-option', '-w', '-t', target.trim(), 'remain-on-exit', 'on']);
  return { ok: true, target: target.trim(), pid: Number(pid) || null, created: true };
}

/**
 * Type into this repo's window.
 *
 * The text goes through a tmux buffer and a bracketed paste rather than
 * `send-keys -l`, because a message with a newline in it would otherwise
 * submit halfway through — every newline is an Enter to the thing reading the
 * pane. Bracketed paste arrives as one block, which is what a person pasting
 * into Claude Code gets, and then Enter sends it.
 */
export async function send(cwd, text, { open: autoOpen = false, resume = null } = {}) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'nothing to send' };
  const here = canonical(cwd);

  // Which window, if any, is running this conversation — and whether it is one
  // we can type into. A folder can hold several conversations at once, so
  // "some pane exists here" is not the same question and answering it that way
  // typed into whichever window happened to be open.
  const held = await holderOf(here, resume);
  if (held.where === 'editor') {
    return {
      ok: false,
      code: 'held_by_editor',
      error: `That conversation is open in your editor (pid ${held.pid}). One app holds a conversation at a time — close it there, or move it back, and this will go through.`,
    };
  }
  let pane = held.where === 'floor' ? (await panes()).find((p) => p.pid === held.pid) ?? null : null;
  // With no conversation named, the folder is all there is to go on — which
  // is right for a caller that just wants "this repo's window".
  if (!pane && !resume) pane = await paneFor(here);
  if (!pane && autoOpen) {
    const opened = await open(here, { resume });
    if (!opened.ok) return opened;
    // A pane is not a session. Claude Code takes a moment to start, and on a
    // repo it has not seen before it stops to ask whether the folder is
    // trusted and whether to use its MCP servers. Pasting during any of that
    // types the message into a dialog, where it is both lost and confusing.
    const up = await waitReady(here, { pid: opened.pid, target: opened.target });
    if (!up.ok) return up;
    pane = { target: opened.target, pid: opened.pid };
  }
  if (!pane) return { ok: false, error: 'no Claude Code window is open for this repo', code: 'no_window' };

  // Which conversation this is going into — needed to confirm below that the
  // message actually became a turn rather than sitting in the composer. It is
  // the pane's session, not just any session in this directory: the person may
  // have their own window open on the same repo, and that is not the one being
  // typed into.
  const known = await roster();
  const live = (pane.pid ? known.sessions.find((s) => s.pid === pane.pid) : null)
    ?? (await sessionFor(here)).session
    ?? null;
  const path = live?.sessionId ? transcriptPath(here, live.sessionId) : null;

  // Wait for the window to finish what it is doing before typing into it.
  //
  // A message pasted into a running turn is not queued, it is dropped: the
  // composer is empty afterwards and the text is simply gone. That is the
  // ordinary case from the floor rather than an edge one — a person types
  // while the agent is working — and it was losing two messages in three.
  // Waiting is what someone at the keyboard would do.
  if (!(await waitIdle(pane.target))) {
    return { ok: false, code: 'busy', error: 'the window has been working for too long to take a message — nothing was typed in' };
  }

  // Where the transcript stood before anything was typed. Taken here rather
  // than after the paste because getting the text in can itself take a while
  // on a window that is still starting, and a turn written during that would
  // then be behind the offset and invisible to landed() — the message would be
  // in the conversation and still reported lost.
  const before = path ? await transcriptSize(path) : null;

  // Get the text into the composer, and confirm it is there before pressing
  // anything. This is a paste that can be silently dropped, not a write that
  // either works or errors — see pasteInto().
  const typed = await pasteInto(pane.target, text);
  if (!typed.ok) return { ...typed, target: pane.target };

  // Submit, and prove it went by finding the message itself in the transcript.
  //
  // This used to watch the transcript merely *grow*, which anything at all
  // satisfies — a tool result, a subagent, a second process writing the same
  // file — so a message that never left the composer was reported as
  // delivered. Nothing downstream looked at the flag either, so a lost message
  // reached the floor as a sent one and no human could have known.
  //
  // Claude Code consumes a bracketed paste asynchronously, and an Enter that
  // arrives while it is still doing so is dropped — the message then sits in
  // the composer, typed but never sent, which looks exactly like the floor
  // having silently failed. Worse, the *next* message pastes onto the end of
  // it and the two are submitted as one.
  //
  // A fixed delay is a magic number that a slower machine breaks, so this
  // confirms instead: the transcript growing is proof the turn was accepted,
  // and until it does, Enter is pressed again. Enter on an empty composer does
  // nothing, so a retry after a submission that did land is harmless.
  //
  // A stand-in that just reads stdin cannot reproduce any of this — it accepts
  // the Enter a TUI drops — so the tests cannot prove it. It was found by
  // watching a real window, and it is verified there.
  await settled(pane.target);

  let sent = false;
  let last = await screenOf(pane.target);
  const stop = Date.now() + LAND_TIMEOUT_MS;
  for (let press = 0; press < SUBMIT_ATTEMPTS && !sent && Date.now() < stop; press++) {
    const enter = await tmux(['send-keys', '-t', pane.target, 'Enter']);
    if (!enter.ok) return { ok: false, error: enter.error };
    // Nothing to check against: the pane is running something with no Claude
    // Code session to find. A real desk always has one, because waitReady does
    // not return without it, so this is the stand-in the tests drive.
    if (!path) return { ok: true, target: pane.target, confirmed: false, unverified: true };

    // Press Enter again only if the window has gone completely still without
    // the message appearing. Retrying blind is worse than not retrying: an
    // Enter that Claude Code reads as part of the paste becomes a newline in
    // the composer, so a message once arrived carrying the eight carriage
    // returns of the eight retries that "delivered" it.
    let frozen = 0;
    while (!sent && Date.now() < stop && frozen < 4) {
      await sleep(250);
      sent = await landed(path, before, text);
      if (sent) break;
      const now = await screenOf(pane.target);
      if (now === last) frozen++;
      else { frozen = 0; last = now; }
    }
  }

  if (!sent) {
    return {
      ok: false,
      code: 'not_delivered',
      target: pane.target,
      // This now says something it can back up. The text was seen in the
      // composer before Enter was pressed, so "took it but did not submit it"
      // is an observation rather than the only remaining guess, and the message
      // really is still sitting there for you to send by hand.
      error: `the window took the message but never submitted it — it is still in the composer, not in the conversation. Attach with \`tmux attach -t ${SESSION}\` and press Enter to send it.`,
    };
  }
  return { ok: true, target: pane.target, confirmed: true };
}

/**
 * Press keys in this repo's window — tmux key names, not literal text.
 *
 * This is for answering, not for saying: the digit that picks an option in a
 * permission dialog, the Escape that stops a turn. Anything a person would
 * type as a message goes through send(), which pastes it as one block.
 */
/**
 * The pane with wrapped lines rejoined.
 *
 * Option text is routinely longer than the window is wide — "Yes, and don't ask
 * again for similar commands in <a long absolute path>" wraps mid-path — and a
 * plain capture hands back the two halves as two lines, split at whatever
 * character the column happened to fall on. `-J` is tmux's own answer to that
 * and gives the line back whole.
 *
 * Kept separate from screenOf rather than replacing it: composerOf reads the box
 * rules, and joining changes what a line is.
 */
async function joinedScreenOf(target) {
  const r = await tmux(['capture-pane', '-p', '-J', '-t', target, '-S', '-12']);
  return r.ok ? r.out : '';
}

/** The numbered choices on a screen, in order, with their text. */
export function promptOptions(screen) {
  const out = [];
  for (const line of String(screen ?? '').split('\n')) {
    const m = /^\s*[\u276f>]?\s*(\d+)\.\s+(.*\S)\s*$/.exec(line);
    if (m) out.push({ n: Number(m[1]), text: m[2].trim() });
  }
  return out;
}

/**
 * What the window is asking, and what it will accept as an answer.
 *
 * No hook carries this. PermissionRequest says which tool wants permission and
 * the Notification six seconds later says even less; the choices themselves —
 * "don't ask again for similar commands in this directory", and whatever else a
 * particular prompt offers — exist only on the screen. So they are read from it,
 * once, when the board asks.
 *
 * Guarded the same way answerPrompt is, and for the same reason: a conversation
 * that quotes a menu is not a window offering one, and the composer is what
 * tells them apart.
 */
export async function readPrompt(cwd) {
  const pane = await paneFor(cwd);
  if (!pane) return { ok: false, code: 'no_window', error: 'no Claude Code window is open for this repo' };
  if (!askingOf(await screenOf(pane.target))) {
    return { ok: false, code: 'no_prompt', error: 'the window is not holding a question — nothing is being asked' };
  }
  const options = promptOptions(await joinedScreenOf(pane.target));
  if (!options.length) {
    return { ok: false, code: 'no_prompt', error: 'the window is waiting on something, but it is not a list of choices' };
  }
  return { ok: true, options };
}

/**
 * Whether the window is holding a question, read from the line at the bottom.
 *
 * `composerOf` was doing this job and cannot: an AskUserQuestion draws its
 * cursor as `\u276f 1. Alpha` with a rule below it, which is a composer by every
 * test that function applies. A driver built on it sat through a question
 * untouched and then fired its whole key sequence into a permission prompt.
 *
 * Claude Code puts a status line at the very bottom of the pane and changes it
 * to say what the window will accept. Idle it offers to interrupt; holding a
 * question it offers to select, to cancel, to amend. That line is *positional* —
 * the last one on the screen — which is what makes it safe: the conversation
 * above it quotes prompts constantly, and no amount of quoting moves the bottom
 * line.
 *
 * Returns the line itself, so a caller can say what it saw.
 */
export function askingOf(screen) {
  const lines = String(screen ?? '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  const foot = lines[lines.length - 1] ?? '';
  // The composer's own status line. Checked first: it contains "esc", and so do
  // the ones that mean the opposite.
  if (/esc to interrupt/i.test(foot)) return null;
  if (/enter to (select|confirm)|esc to cancel|tab to amend/i.test(foot)) return foot;
  // The Submit tab has no status line of its own — it ends on its own little
  // menu. Without this the sequence gave up at exactly the step that lands on
  // it, which is the one step that must not be skipped, and every retry found
  // the window already parked there and sent nothing at all.
  const tail = lines.slice(-6).join('\n');
  if (/ready to submit your answers/i.test(tail) && /^\s*\d+\.\s*Cancel\s*$/i.test(foot)) return foot;
  return null;
}

/**
 * The question on screen, as a structure.
 *
 * An AskUserQuestion is a small form: a strip of tabs across the top with a
 * box per question showing whether it has been answered, the current question's
 * text, its choices, and — on a multi-select — a checkbox per choice and a
 * Submit row beneath them. All of it read off the pane, because no hook carries
 * any of it.
 *
 * One thing is deliberately *not* read: which tab is currently showing. The
 * active tab is marked by colour alone, and `capture-pane -p` returns none. So
 * nothing here guesses at it — the caller walks to a known end and counts from
 * there, which needs no colour and cannot drift.
 */
export function questionOf(screen) {
  const raw = String(screen ?? '').split('\n');
  const at = raw.findIndex((l) => /^\s*\u2190/.test(l) && /[\u2610\u2612]/.test(l));
  if (at < 0) return null;

  // `←  ☒ ProbeOne  ☐ ProbeTwo  ✔ Submit  →`, split on the runs of spaces that
  // separate the tabs. The titles are the question headers and can contain a
  // single space, which is why this is not a split on whitespace.
  const tabs = [];
  for (const piece of raw[at].trim().split(/\s{2,}/)) {
    const m = /^([\u2610\u2612\u2714])\s*(.+)$/.exec(piece.trim());
    if (m) tabs.push({ title: m[2].trim(), answered: m[1] === '\u2612', submit: m[1] === '\u2714' });
  }

  // A single-select draws a preview panel to the right of the choices, so every
  // line of the list has somebody else's box on the end of it. Cut by *column*,
  // not by box character: the panel's own text ("Notes: press n to add notes")
  // sits inside it on lines that carry no border at all, and cutting on the
  // border alone left that text looking like a choice's description.
  const rest = raw.slice(at + 1);
  const edge = rest.reduce((min, l) => {
    const c = l.search(/[\u250c\u2502\u2514\u2510\u2518]/);
    return c > 0 && c < min ? c : min;
  }, Infinity);
  const body = rest.map((l) => (edge === Infinity ? l : l.slice(0, edge)).replace(/\s+$/, ''));
  const said = body.filter((l) => l.trim());
  const question = said[0]?.trim() ?? null;

  // The Submit tab shows what you are about to send rather than a question.
  if (/ready to submit your answers/i.test(said.join('\n'))) {
    return { tabs, question: 'Review your answers', kind: 'review', options: [], cursor: -1, submit: false };
  }

  const options = [];
  let cursor = -1;
  let submit = false;
  let last = null;
  for (const line of body) {
    // A description belongs to the choice directly above it. A gap or a rule
    // ends that — past those the screen has moved on to its own furniture.
    if (!line.trim()) { last = null; continue; }
    if (/^\s*[\u2500\u2190]/.test(line)) { last = null; continue; }
    if (/^\s*Submit\s*$/.test(line)) { submit = true; last = null; continue; }
    const m = /^(\s*)([\u276f>])?\s*(\d+)\.\s+(.*\S)\s*$/.exec(line);
    if (m) {
      const text = m[4].trim();
      // Claude Code's own last item, an escape hatch into ordinary chat. Not one
      // of the answers, and offering it as one would send the operator somewhere
      // they did not ask to go.
      if (/^chat about this$/i.test(text)) { last = null; continue; }
      const box = /^\[([\s\u2714x])\]\s*(.*)$/.exec(text);
      const opt = {
        n: Number(m[3]),
        text: (box ? box[2] : text).trim(),
        checked: box ? box[1].trim() !== '' : null,
        // The free-text choice. Claude Code always offers one; picking it turns
        // the row into a field you type into.
        other: /^type something$/i.test((box ? box[2] : text).trim()),
      };
      if (m[2]) cursor = options.length;
      options.push(opt);
      last = opt;
      continue;
    }
    // A multi-select prints each choice's description under it. Worth keeping:
    // it is what the operator reads to choose.
    if (last && /^\s{2,}\S/.test(line)) {
      last.detail = `${last.detail ? `${last.detail} ` : ''}${line.trim()}`;
    }
  }

  return {
    tabs,
    question,
    kind: options.some((o) => o.checked !== null) ? 'multi' : 'single',
    options,
    cursor,
    submit,
  };
}

/**
 * Every question in the form, by walking the tabs.
 *
 * Reading takes keystrokes, because only one question is on screen at a time
 * and which one is marked by colour the capture does not carry. So this walks:
 * all the way left to a known end, then one Tab at a time, reading each.
 * Navigation is the one thing that changes nothing — arrows and Tab move the
 * view, they do not answer — so a read leaves the form exactly as it found it,
 * apart from which tab is showing, and it finishes back at the first.
 *
 * Bounded by the tab strip's own count, so a strip that stops changing cannot
 * spin this forever.
 */
export async function readQuestions(cwd) {
  const pane = await paneFor(cwd);
  if (!pane) return { ok: false, code: 'no_window', error: 'no Claude Code window is open for this repo' };
  if (!askingOf(await screenOf(pane.target))) {
    return { ok: false, code: 'no_prompt', error: 'the window is not holding a question' };
  }
  const first = questionOf(await screenOf(pane.target, 34));
  // No tab strip: this is a plain menu — a permission prompt — and walking it
  // with Tab would be pressing keys into somebody else's widget.
  if (!first) return { ok: false, code: 'not_a_form', error: 'the window is asking, but not with a question form' };
  // Left as many times as there are tabs: from anywhere in the strip that lands
  // on the first one, and pressing left at the left end does nothing.
  for (let i = 0; i < first.tabs.length; i++) {
    await tmux(['send-keys', '-t', pane.target, 'Left']);
    await sleep(STEP_MS);
  }
  const questions = [];
  for (let i = 0; i < first.tabs.length; i++) {
    const q = questionOf(await screenOf(pane.target, 34));
    if (!q) break;
    if (q.kind === 'review') break;   // the Submit tab; there is nothing to answer on it
    // The strip's own label for this question — its `header`, which is what the
    // window puts on the tab and therefore what the floor should too.
    questions.push({ ...q, tab: i, tab_title: first.tabs[i]?.title ?? null });
    await tmux(['send-keys', '-t', pane.target, 'Tab']);
    await sleep(STEP_MS);
  }
  // Back where it started, so the operator's window is not left on a tab they
  // did not choose.
  for (let i = 0; i < first.tabs.length; i++) {
    await tmux(['send-keys', '-t', pane.target, 'Left']);
    await sleep(STEP_MS);
  }
  return { ok: true, tabs: first.tabs, questions };
}

/** How long each step of a scripted answer is given to land before the next. */
const STEP_MS = Number(process.env.ORCH_STEP_MS ?? 350);

/**
 * Play a sequence of keys into a question, checking before every one that the
 * window is still asking.
 *
 * A permission prompt is one keystroke. An AskUserQuestion is not: measured on a
 * real one, a digit moves the cursor on a single-select and toggles a box on a
 * multi-select, Enter selects on the first and toggles on the second, tabs move
 * with arrows, and Submit raises its own confirmation. Answering is a script.
 *
 * The check before each step is the whole safety argument. A sequence aimed at a
 * question that has since been answered would otherwise type its digits into
 * whatever is there — which is how this repo's own driver put "2113" into the
 * operator's message and granted a standing permission nobody asked for.
 */
export async function answerQuestion(cwd, steps = []) {
  const pane = await paneFor(cwd);
  if (!pane) return { ok: false, code: 'no_window', error: 'no Claude Code window is open for this repo', done: [] };
  const done = [];
  let closed = false;
  for (const step of steps) {
    const asking = askingOf(await screenOf(pane.target));
    if (!asking) {
      // Past the point of submitting, the window closing is the *success*. The
      // confirmation may be taken by the digit or by the Enter after it
      // depending on where its cursor already sat, so whichever one lands, the
      // other finds nothing — and that is the answer having gone through, not a
      // failure to send it.
      // Not a return: "askingOf sees nothing" is good evidence the form is gone
      // but not proof, and the same optimism further down is what let an
      // unsubmitted confirmation be reported as an answer. Fall through to the
      // check below, which reads the pane instead of assuming.
      if (step.final) { closed = true; break; }
      return {
        ok: false,
        code: 'no_prompt',
        done,
        error: `the window stopped asking after ${done.length} of ${steps.length} step${steps.length === 1 ? '' : 's'}` +
          `, so the rest was not sent`,
      };
    }
    // `-l` sends the string literally; without it tmux reads words like "Enter"
    // and "Up" as key names, which is right for keys and wrong for an answer
    // somebody typed.
    const arg = typeof step.text === 'string' ? ['-l', step.text] : [String(step.key)];
    if (typeof step.text !== 'string' && !step.key) continue;
    const r = await tmux(['send-keys', '-t', pane.target, ...arg]);
    if (!r.ok) return { ok: false, error: r.error, done };
    await sleep(step.settle ?? STEP_MS);
    done.push(typeof step.text === 'string' ? `text(${step.text.length})` : String(step.key));
  }

  // Playing the last step is not the same as the answer having gone in. The
  // confirmation opens with its cursor already on "Submit answers", so the digit
  // before the Enter can be a no-op, and a press that arrives while the tab walk
  // is still settling is swallowed with nothing to show for it. Both were true
  // once: the script ran to its end, reported success, the floor cleared the
  // alert — and the window sat on "Ready to submit your answers?" for 42 seconds
  // until the operator pressed it in tmux themselves.
  //
  // The operator asked not to be the one to confirm. So the end of the script is
  // not the end of the job: look at the pane, and keep pressing while it is
  // still asking. This is why the count is a loop and not one more step.
  for (let i = 0; i < CONFIRM_TRIES; i++) {
    if (!CONFIRMING.test(await screenOf(pane.target))) break;
    const r = await tmux(['send-keys', '-t', pane.target, 'Enter']);
    if (!r.ok) return { ok: false, error: r.error, done };
    done.push('Enter(confirm)');
    await sleep(ANSWER_CONFIRM_MS);
  }

  const screen = await screenOf(pane.target);
  if (CONFIRMING.test(screen)) {
    return {
      ok: false,
      code: 'not_confirmed',
      done,
      screen,
      error: `the window is still showing "Ready to submit your answers?" after ${CONFIRM_TRIES}` +
        ` attempt${CONFIRM_TRIES === 1 ? '' : 's'} to confirm it`,
    };
  }
  return { ok: true, done, screen, closed };
}

/** The review screen's own words. Matching the question rather than the footer
 *  keeps this independent of how many choices the confirmation offers. */
const CONFIRMING = /ready to submit your answers/i;

/** Enough to cover a press landing mid-redraw, few enough that a window which is
 *  genuinely stuck says so instead of being hammered. */
const CONFIRM_TRIES = Number(process.env.ORCH_CONFIRM_TRIES ?? 3);

/** How long the window gets to act on an answer before we look at the result. */
const ANSWER_CONFIRM_MS = Number(process.env.ORCH_ANSWER_CONFIRM_MS ?? 900);

/**
 * Two menus are the same question if their options read the same. The cursor is
 * ignored: answering moves it, and a moved cursor over unchanged options is
 * still the same question.
 *
 * Exported for the same reason plannedAnswer is: this is the decision that
 * decides whether the board tells the operator their answer failed, and it
 * should be checkable without a tmux pane.
 */
export function sameQuestion(a, b) {
  if (!a.rows.length || a.rows.length !== b.rows.length) return false;
  return a.rows.every((line, i) => optionText(line) === optionText(b.rows[i]));
}

/**
 * Answer a prompt in this repo's window, and find out whether it took.
 *
 * `sendKeys` reports success the moment tmux accepts the keystroke, which says
 * nothing about the window. That mattered once the floor started clearing a
 * desk's prompt as soon as the operator decided: an answer that went nowhere
 * left the window sitting at a question the board had stopped showing, and the
 * only thing that would raise it again was the operator going to look.
 *
 * There is no event to wait for. Measured on a real prompt, a standing
 * permission request announces itself exactly twice — PermissionRequest, then
 * one Notification six seconds later — and then says nothing for as long as it
 * stands (33 seconds, in the run this was built from). And silence afterwards
 * proves nothing either: PreToolUse fires *before* the decision and PostToolUse
 * is not among the hooks we ask for, so an approved tool that runs for a minute
 * is exactly as quiet as an answer that never arrived.
 *
 * So the window is asked directly, the same way waitReady asks it. Two looks,
 * one before and one after:
 *
 *   - no menu before  → the prompt has already gone. Nothing is sent, which is
 *     the point: a bare "1" typed into a composer is how a row of 1s once
 *     arrived as somebody's message.
 *   - the same menu after → the key did not take. Said so, with what was seen.
 *
 * The one thing it can misread is a window that answers a question and
 * immediately asks an identical one. That reports a failure that did not
 * happen, and the cost of that is a prompt offered twice — the safe direction.
 */
export async function answerPrompt(cwd, key) {
  const pane = await paneFor(cwd);
  if (!pane) return { ok: false, error: 'no Claude Code window is open for this repo', code: 'no_window' };

  const beforeScreen = await screenOf(pane.target);
  // A menu on the screen is not the same as a menu waiting to be answered.
  //
  // The pane shows the conversation as well as the prompt, and a conversation
  // about permission prompts contains permission prompts: this very repo's
  // messages quote "1. Yes / 2. Yes, and don't ask again / 3. No" as prose.
  // menuOf cannot tell those apart, and read one as live — so an approve was
  // reported as having failed when it had not, and the guard below would have
  // typed a bare "1" into the composer it was written to protect.
  //
  // What separates them is the status line at the very bottom of the pane, which
  // says what the window will accept — see askingOf. It is positional, so no
  // amount of quoting above it can fake one. The composer was the first attempt
  // at this test, and it reads an AskUserQuestion as a composer: that menu's own
  // cursor is a `❯` with a rule below it.
  if (!askingOf(beforeScreen)) {
    return {
      ok: false,
      code: 'no_prompt',
      error: 'the window is back at its composer, so it is not waiting on a question and nothing was sent',
    };
  }
  const before = menuOf(beforeScreen);
  if (before.at < 0) {
    return {
      ok: false,
      code: 'no_prompt',
      error: 'the window was not showing a prompt any more, so nothing was sent',
    };
  }

  const sent = await tmux(['send-keys', '-t', pane.target, key]);
  if (!sent.ok) return { ok: false, error: sent.error };

  await sleep(ANSWER_CONFIRM_MS);
  const after = menuOf(await screenOf(pane.target));
  if (sameQuestion(before, after)) {
    return {
      ok: false,
      code: 'not_taken',
      error: `the window is still showing the same prompt ${Math.round(ANSWER_CONFIRM_MS / 100) / 10}s after the key was sent — ` +
        `it still reads "${optionText(before.rows[Math.max(0, before.at)]).slice(0, 60)}"`,
    };
  }
  return { ok: true, target: pane.target };
}

export async function sendKeys(cwd, ...keys) {
  const pane = await paneFor(cwd);
  if (!pane) return { ok: false, error: 'no Claude Code window is open for this repo', code: 'no_window' };
  const r = await tmux(['send-keys', '-t', pane.target, ...keys]);
  return r.ok ? { ok: true, target: pane.target } : { ok: false, error: r.error };
}

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
  try {
    await run('open', ['-a', 'Visual Studio Code', url], { timeout: 10_000 });
    return { ok: true, url };
  } catch (err) {
    return { ok: false, error: (err?.stderr || err?.message || String(err)).trim() };
  }
}

/**
 * Close the window the floor has been driving.
 *
 * Handing a conversation to the editor means giving it up here: two processes
 * resuming one session write to one transcript, and the person ends up talking
 * to whichever copy they are not looking at.
 */
export async function closeWindow(cwd) {
  const pane = await paneFor(cwd);
  if (!pane) return { ok: true, closed: false };   // nothing of ours is open
  const r = await tmux(['kill-window', '-t', pane.target]);
  return r.ok ? { ok: true, closed: true } : { ok: false, error: r.error };
}

/** Stop whatever the window is doing, the way Escape does for a person. */
export async function interrupt(cwd) {
  return sendKeys(cwd, 'Escape');
}

/** What the window looks like right now — for the floor to show while a turn runs. */
export async function screen(cwd, { lines = 60 } = {}) {
  const pane = await paneFor(cwd);
  if (!pane) return { ok: false, error: 'no Claude Code window is open for this repo', code: 'no_window' };
  const r = await tmux(['capture-pane', '-p', '-t', pane.target, '-S', `-${Math.max(1, lines)}`]);
  return r.ok ? { ok: true, text: r.out } : { ok: false, error: r.error };
}

/* ───────────────────────── the conversation ───────────────────────── */

/**
 * Claude Code's own transcript for a session. This is the mirror: both sides
 * of the conversation, written by Claude Code itself, whoever typed it and
 * from wherever. The floor tails it instead of being told about turns, which
 * is why a turn you type in your own terminal shows up on the floor without
 * anything reporting it.
 */
export function transcriptPath(cwd, sessionId) {
  const slug = cwd.replace(/[^A-Za-z0-9]/g, '-');
  return join(CLAUDE_HOME, 'projects', slug, `${sessionId}.jsonl`);
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
export async function readTranscript(path, { after = 0 } = {}) {
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
  for (const line of complete) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== 'user' && d.type !== 'assistant') continue;
    // Sidechain is a subagent's own conversation; it belongs inside the tool
    // call that owns it, not beside the turns of the session that spawned it.
    if (d.isMeta || d.isSidechain) continue;
    const at = d.timestamp ?? null;
    const uuid = d.uuid ?? null;

    if (d.type === 'user') {
      const text = textOf(d.message?.content);
      if (text.trim()) turns.push({ role: 'user', text, at, uuid });
      continue;
    }
    const content = d.message?.content;
    const text = textOf(content);
    if (text.trim()) turns.push({ role: 'assistant', text, at, uuid });
    for (const block of Array.isArray(content) ? content : []) {
      if (block?.type !== 'tool_use') continue;
      turns.push({ role: 'tool', text: '', tool_name: block.name ?? 'tool', tool_input: reduceToolInput(block.input), at, uuid });
    }
  }
  return { ok: true, turns, offset: after + consumed };
}

/** Small stable hash, only used to name a tmux buffer per repo. */
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

export const tmuxSession = SESSION;

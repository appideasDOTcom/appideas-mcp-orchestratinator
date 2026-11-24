/**
 * Claude Code's sign-in on this machine: whether it is signed in, and its own
 * sign-in, run for the person when they press Sign in on a desk (costmo,
 * 2026-11-19: "Host signs in"). Two of Claude Code's commands and nothing of
 * ours: `claude auth status --json` and `claude auth login`.
 *
 * Why the host asks at all. A window on a machine where Claude Code is signed
 * out stands at an ordinary composer with "Not logged in · run /login" at the
 * right of its footer, and a message typed into it is answered by an API
 * error record, "Not logged in · Please run /login" (measured on 2.1.329, a
 * window with no credentials, onboarding done). So the floor drew the desk as
 * idle, and then showed the operator a command as its answer. The host now
 * reads the machine's sign-in at every heartbeat, and at once when a window
 * records that error, and says it at registration (`signed_out`); the board
 * refuses messages to that host's desks and the desk offers Sign in.
 *
 * Measured beside it: `auth status --json` answers in about 0.25 s at load 67
 * (2026-11-19), so once a minute costs nothing worth naming; it prints
 * `{ "loggedIn": false, "authMethod": "none", … }` signed out and
 * `{ "loggedIn": true, "authMethod": "claude.ai", … }` signed in. And
 * `auth login` with no terminal opens the browser and waits on a local port
 * until the person finishes there (the desktop app's agent, 2026-11-09, which
 * runs it the same way for its own Sign in).
 */
import { spawn } from 'node:child_process';
import { userInfo } from 'node:os';

const CLAUDE = process.env.ORCH_HOST_CLAUDE ?? 'claude';
// It answers in a quarter of a second. The heartbeat asks it on the host's
// line before registering, so one that hangs must not hold the registration
// long: past this, the answer is "could not say" and the last one stands.
const STATUS_TIMEOUT_MS = Number(process.env.ORCH_AUTH_STATUS_TIMEOUT_MS ?? 5_000);
/** Long enough to find a password and a second factor; a page nobody finishes is ended. */
export const SIGNIN_TIMEOUT_MS = Number(process.env.ORCH_SIGNIN_TIMEOUT_MS ?? 15 * 60_000);

/**
 * The environment Claude Code is run in for these two: the host's own, with
 * USER and LOGNAME filled in when missing. With HOME and PATH alone Claude
 * Code says it is signed out on a signed-in Mac (the desktop app's agent,
 * measured 2026-11-09: it finds its Keychain item by user). launchd gives a
 * LaunchAgent both (read off the running host, 2026-11-19); a host started
 * by another parent may not have them, and every desk would then read as
 * signed out.
 */
export function claudeEnv(env = process.env) {
  if (env.USER && env.LOGNAME) return env;
  let user = env.USER || env.LOGNAME || '';
  if (!user) { try { user = userInfo().username; } catch { user = ''; } }
  return user ? { ...env, USER: env.USER || user, LOGNAME: env.LOGNAME || user } : env;
}

/**
 * What `claude auth status --json` printed, as true / false, or null when it
 * is not that. Asked through a shell (statusCommand), a profile that prints
 * a line of its own puts it ahead of the answer, and that line may hold a
 * brace of its own (QA's `welcome {to} my shell`, 0.14.5 review 3819). The
 * answer is an object that begins a line, so each line that opens with `{`
 * is tried, the last first, up to the last `}`.
 */
export function readSignedIn(output) {
  const s = String(output ?? '');
  const starts = [0];
  for (let at = s.indexOf('\n{'); at >= 0; at = s.indexOf('\n{', at + 1)) starts.push(at + 1);
  const end = s.lastIndexOf('}') + 1;
  for (const from of [...starts].reverse()) {
    try {
      const v = JSON.parse(from === 0 ? s : s.slice(from, end))?.loggedIn;
      if (typeof v === 'boolean') return v;
    } catch { /* the next start, or none */ }
  }
  return null;
}

/**
 * The words a window records when it is signed out: the text of the API
 * error record a message gets, "Not logged in · Please run /login". Anchored
 * at the start, so a turn that only mentions them is not taken for one.
 */
export const isNotLoggedIn = (text) => /^\s*Not logged in\b/i.test(String(text ?? ''));

/**
 * How `auth status` is asked: the way a window the host opens starts Claude
 * Code, so that the host reads the sign-in its windows will have (F1 of the
 * 0.14.5 review, 2026-11-21).
 *
 * A window's command is one shell line that tmux runs through its
 * `default-shell -c` (launchArgs in host/window.js), and zsh -c reads
 * ~/.zshenv. Asked with execFile and no shell, as it was, a credential
 * exported there was invisible to the host and visible to every window, so
 * a LaunchAgent host read "signed out" on a machine whose windows worked,
 * and the board refused every message to its desks (signedOutWhy). 0.12.12
 * had no such reading and delivered them. QA measured the split on 2.1.330:
 * loggedIn false under env -i for a key exported only in ~/.zshenv or
 * ~/.zshrc, true through `zsh -c`. (A key only in ~/.zshrc reaches no window
 * either: zsh -c reads no .zshrc, so there the host and its windows agree on
 * "signed out", which is the truth about them.)
 *
 * `shell` is the floor's (W.windowShell). With none, as on Windows, where a
 * window is the program itself with no shell around it, the command runs as
 * it is, which is again what a window does. The words are quoted the way
 * launchArgs quotes a window's, so fish reads them as sh does.
 */
export function statusCommand({ claude = CLAUDE, shell = null } = {}) {
  const argv = [claude, 'auth', 'status', '--json'];
  if (!shell) return { cmd: argv[0], args: argv.slice(1) };
  return { cmd: shell, args: ['-c', `exec ${argv.map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' ')}`] };
}

/** Whether Claude Code is signed in here: true, false, or null when it could not say. */
export function signedIn({ claude = CLAUDE, shell = null, env = process.env, timeoutMs = STATUS_TIMEOUT_MS } = {}) {
  const { cmd, args } = statusCommand({ claude, shell });
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    let child;
    try {
      // windowsHide: under the desktop app on Windows the host has no console,
      // so a console program it starts without it opens a window of its own,
      // and this runs at every heartbeat (orchestratinator-desktop-dev's
      // reading, 2026-11-24; the PC's walk is the measurement). A no-op
      // elsewhere, and on every other child the host starts.
      child = spawn(cmd, args, { env: claudeEnv(env), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch { finish(null); return; }
    child.stdout.on('data', (c) => { out += c; });
    // The answer when Claude Code itself is done, not when its pipe closes.
    // A profile that leaves a process of its own (QA's `sleep 12 &` in
    // ~/.zshenv, 0.14.5 review 3819) keeps the pipe open after the answer is
    // written, and waiting for the close held every heartbeat to the limit.
    // `exit` comes once the process is gone; what it wrote is in by then or
    // a moment after, so the stream is read until it ends or 100 ms pass.
    child.on('exit', () => {
      const t = setTimeout(() => finish(readSignedIn(out)), 100);
      child.stdout.on('end', () => { clearTimeout(t); finish(readSignedIn(out)); });
    });
    child.on('error', () => finish(null));
    // And a limit on it all, with SIGKILL: measured on Node 24.22.2, a child
    // that ignores SIGTERM kept execFile's answer 30,135 ms where SIGKILL
    // ended it at 303 ms (QA, 0.14.5 review 3800, saw the limit not hold).
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish(null); }, timeoutMs);
  });
}

/** The last line a process wrote, as words: escape codes and links taken out. */
export function lastLine(output) {
  const lines = String(output ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;]*[A-Za-z]/g, '')
    .split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.at(-1) ?? '';
}

/**
 * Claude Code's own sign-in, run as the person: it opens the browser on this
 * machine and ends when they have finished there. A process group of its
 * own, so a timeout ends whatever it started. Resolves { ok } or { ok: false,
 * error } in words: its own last line on stderr when it said one ("Couldn't
 * save your login. If your Mac's keychain is locked…").
 */
export function signIn({ timeoutMs = SIGNIN_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(CLAUDE, ['auth', 'login'], { env: claudeEnv(), stdio: ['ignore', 'ignore', 'pipe'], detached: true, windowsHide: true });
    } catch (err) {
      resolve({ ok: false, error: `Claude Code's sign-in could not be started: ${err.message}` });
      return;
    }
    let said = '';
    child.stderr?.on('data', (c) => { said += c.toString(); });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: `Claude Code's sign-in could not be started: ${err.message}` }); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ ok: true });
      const why = timedOut ? `nobody finished it in the browser within ${Math.round(timeoutMs / 60_000)} minutes`
        : code === null ? `it was stopped (${signal})` : `it ended with code ${code}`;
      const line = lastLine(said);
      resolve({ ok: false, error: line ? `${why}: ${line}` : why });
    });
  });
}

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
import { execFile, spawn } from 'node:child_process';
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

/** What `claude auth status --json` printed, as true / false, or null when it is not that. */
export function readSignedIn(output) {
  try {
    const v = JSON.parse(String(output ?? ''))?.loggedIn;
    return typeof v === 'boolean' ? v : null;
  } catch { return null; }
}

/**
 * The words a window records when it is signed out: the text of the API
 * error record a message gets, "Not logged in · Please run /login". Anchored
 * at the start, so a turn that only mentions them is not taken for one.
 */
export const isNotLoggedIn = (text) => /^\s*Not logged in\b/i.test(String(text ?? ''));

/** Whether Claude Code is signed in here: true, false, or null when it could not say. */
export function signedIn() {
  return new Promise((resolve) => {
    // Its answer is what counts, whatever it exits with (signed out exits 1).
    execFile(CLAUDE, ['auth', 'status', '--json'], { env: claudeEnv(), timeout: STATUS_TIMEOUT_MS }, (_err, stdout) => resolve(readSignedIn(stdout)));
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
      child = spawn(CLAUDE, ['auth', 'login'], { env: claudeEnv(), stdio: ['ignore', 'ignore', 'pipe'], detached: true });
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

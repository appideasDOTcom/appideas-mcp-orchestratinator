// What Windows' Task Scheduler starts (install.ps1 registers it): the host,
// kept running, and stopped cleanly when asked. launchd does both of those
// for the Mac's host (KeepAlive, and SIGTERM with time to finish); Task
// Scheduler does neither, measured by pc-developer on Windows 11, 2026-11-20:
//
// - **It does not restart a task that exits.** "Restart on failure" (count
//   999, every minute) is about a task that fails to start: a run that exited
//   with code 3 was not started again in the next two and a half minutes. The
//   host exits on purpose (after an update, on a fatal error), so something
//   has to start it again. This loop does, after RESTART_MS, whatever the code.
// - **Its stop is a kill.** Stop-ScheduledTask ended the probe within the
//   second, with no signal and not even `process.on('exit')` run. The host
//   finishes the work item in hand when it is told to stop (STOP_DRAIN_MS,
//   index.js), and a message half typed is the cost of not letting it. So a
//   stop is asked for: install.ps1 writes STOP_FILE, this sees it, tells the
//   host over its IPC channel (`{ type: 'stop' }`, which index.js treats as
//   SIGTERM), waits for it to leave, and exits itself. Only then does the
//   script stop the task, which by then has nothing to kill.
//
// It runs under `conhost.exe --headless`, the one way of starting it that put
// nothing on the screen (the same probe: node as the action opened a Windows
// Terminal window, and `powershell -WindowStyle Hidden` flashed one), so
// nothing it does may expect a console. Its own lines and the host's go to
// the same log, `~/.orchestratinator/log/host.log`, tagged `[host]` so that
// what reads that file for the Mac's host reads this one too.
//
// Not Windows-specific in itself, and run by nothing else today.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { userInfo } from 'node:os';
import { existsSync, mkdirSync, openSync, rmSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(homedir(), '.orchestratinator');
const LOG = join(DIR, 'log', 'host.log');
export const STOP_FILE = process.env.ORCH_SUPERVISE_STOP_FILE ?? join(DIR, 'host.stop');
const RESTART_MS = Number(process.env.ORCH_SUPERVISE_RESTART_MS ?? 10_000);
// Longer than the host's own drain (15 s) and its release and unregister
// (up to 2 s each), as the desktop app gives it (CLAUDE.md, "The host under
// the desktop app": 20 s).
const STOP_WAIT_MS = Number(process.env.ORCH_SUPERVISE_STOP_WAIT_MS ?? 20_000);
const POLL_MS = 1000;

mkdirSync(dirname(LOG), { recursive: true });
const say = (line) => appendFileSync(LOG, `[host] ${new Date().toISOString()} supervisor: ${line}\n`);

let child = null;
let stopping = false;

function start() {
  if (stopping) return;
  const out = openSync(LOG, 'a');
  child = spawn(process.execPath, [join(HERE, 'index.js'), ...process.argv.slice(2)], {
    cwd: HERE,
    stdio: ['ignore', out, out, 'ipc'],
    windowsHide: true,
  });
  const me = child;
  say(`started the host (pid ${me.pid})`);
  me.on('exit', (code, signal) => {
    if (child === me) child = null;
    if (stopping) return;
    // Signed: Windows reports a process ended by TerminateProcess (Task
    // Manager's End task) as 4294967295, which is -1 (measured).
    say(`the host exited (${signal ?? `code ${code | 0}`}); starting it again in ${RESTART_MS / 1000}s`);
    setTimeout(start, RESTART_MS);
  });
  me.on('error', (err) => say(`could not start the host: ${err.message}`));
}

async function stop() {
  if (stopping) return;
  stopping = true;
  const me = child;
  if (me) {
    say(`asked to stop; telling the host (pid ${me.pid}) and waiting up to ${STOP_WAIT_MS / 1000}s`);
    try { me.send({ type: 'stop' }); } catch { /* no channel: it is going anyway */ }
    const gone = await new Promise((resolve) => {
      if (me.exitCode !== null || me.signalCode !== null) return resolve(true);
      const t = setTimeout(() => resolve(false), STOP_WAIT_MS);
      me.once('exit', () => { clearTimeout(t); resolve(true); });
    });
    if (!gone) { say('the host did not leave in time; ending it'); try { me.kill(); } catch { /* gone */ } }
  }
  try { rmSync(STOP_FILE, { force: true }); } catch { /* the script removes it too */ }
  say('stopped');
  process.exit(0);
}

// One supervisor for this person's host (task 348 F3, pc-developer, measured
// on Windows 11): Task Scheduler's End kills only conhost, so this process
// and the host ran on, the task read Ready, and Start made a second
// supervisor and a second host with the same host id, which fought over every
// desk. A lock nobody can leave behind: a named pipe on Windows, which the
// system removes with its process, and a socket file elsewhere, taken over
// when nothing answers on it.
const LOCK = process.env.ORCH_SUPERVISE_LOCK
  ?? (process.platform === 'win32' ? `\\\\.\\pipe\\orchestratinator-supervisor-${userInfo().username}` : join(DIR, 'supervise.sock'));
const holdLock = () => new Promise((resolve) => {
  const server = net.createServer((c) => c.end());
  server.once('error', (err) => {
    if (err.code !== 'EADDRINUSE') { say(`could not take the one-supervisor lock (${err.code ?? err.message}); running without it`); resolve(true); return; }
    const probe = net.connect(LOCK);
    probe.once('connect', () => { probe.destroy(); resolve(false); });
    probe.once('error', () => {
      // A socket file with nobody on it: a supervisor that died. Taken over.
      try { rmSync(LOCK, { force: true }); } catch { /* not a file */ }
      server.once('error', () => resolve(true));
      server.listen(LOCK, () => resolve(true));
    });
  });
  server.listen(LOCK, () => resolve(true));
  server.unref();
});

// And it ends with the process that started it: when Task Scheduler's End
// kills conhost, this stops the host properly, as a stop file would, rather
// than run on without a task to show for it. On Windows an orphan keeps its
// parent's pid as ppid, which then names nothing; elsewhere it is adopted
// (ppid changes). ORCH_SUPERVISE_PARENT_WATCH=off for a parent that is meant
// to go (none today).
const PARENT = process.ppid;
const parentGone = () => {
  if (process.env.ORCH_SUPERVISE_PARENT_WATCH === 'off') return false;
  if (process.ppid !== PARENT) return true;
  try { process.kill(PARENT, 0); return false; } catch (err) { return err.code !== 'EPERM'; }
};

if (!(await holdLock())) {
  say(`another supervisor already runs this host (${LOCK}); this one is not starting a second`);
  process.exit(0);
}
// A stop file left from a stop that never finished would stop this run at
// once; it is from before this start, so it is not this run's.
try { rmSync(STOP_FILE, { force: true }); } catch { /* nothing to remove */ }
setInterval(() => {
  if (existsSync(STOP_FILE)) stop();
  else if (parentGone()) { say('the process that started this supervisor is gone (Task Scheduler\'s End); stopping the host'); stop(); }
}, POLL_MS);
start();

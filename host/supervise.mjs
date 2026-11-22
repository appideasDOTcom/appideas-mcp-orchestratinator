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

// A stop file left from a stop that never finished would stop this run at
// once; it is from before this start, so it is not this run's.
try { rmSync(STOP_FILE, { force: true }); } catch { /* nothing to remove */ }
setInterval(() => { if (existsSync(STOP_FILE)) stop(); }, POLL_MS);
start();

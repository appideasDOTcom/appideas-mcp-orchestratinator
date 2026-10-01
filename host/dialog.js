/**
 * The folder picker: one function, with each operating system's own folder
 * dialog behind it.
 *
 * "Take a desk" asks which folder an agent lives in, and the person answering
 * is sitting at the machine this host runs on — so the question is put to
 * them in the dialog they use for every other folder, not in a list the page
 * draws one level at a time (which is what it was, and what a host with no
 * backend here still gets).
 *
 * macOS is the one backend, and it is the one it is because of what was
 * measured, not what was reasoned (2026-10-01, macOS 26.6.2, a throwaway
 * LaunchAgent with this host's own plist shape, the frontmost app read every
 * 0.6 s). The question was whether a dialog opened from a background service
 * comes to the front at all, and "is drawn" turned out to be a different
 * answer from "is in front of the person":
 *
 *   - AppleScript's `choose folder`: drawn above every ordinary window (the
 *     panel sits at window level 8) and never focused — the browser stayed
 *     frontmost for the whole 12 s watched.
 *   - `activate`, then `choose folder`: the same. frontmost=false.
 *   - `tell application "System Events"` to activate and choose: frontmost in
 *     0.6 s — but the dialog is then System Events' own, so ending osascript
 *     leaves it on screen with nothing listening (still frontmost 4.5 s
 *     later), and it costs an Apple event to another app, which is a
 *     permission a machine can refuse.
 *   - osascript running the open panel itself, as an accessory app: frontmost
 *     within 1.2 s, the chosen path on stdout, focus back to the browser when
 *     it closes, and the dialog goes when the process does. No Apple event,
 *     nothing to install.
 *
 * The last is the JXA below. The two lines that make it work are the
 * activation policy and the activate call: osascript is a faceless process,
 * and one of those is not given the front for asking.
 *
 * A cross-platform dialog library was the other way to do this, and it was
 * tried rather than dismissed (same probe, same day): the one on npm that
 * runs on a Mac executes the plain `choose folder` above and stayed unfocused
 * for 20 s; the rest ship no macOS binary, no folder picker, or do not load.
 * So this is a switch per platform, by ruling, with no dependency.
 *
 * Linux and Windows have no backend yet, on purpose. Each is a few lines in
 * dialogCommand() — and each has to be watched for focus from this host's own
 * service before it is believed, because that is exactly the check three of
 * the four macOS ways failed. A backend written without that watch is a
 * dialog that may open behind the browser, which reads as a button that does
 * nothing. Until one is measured, such a host says it has no dialog
 * (`hasDialog()`), and the page draws its own list for it.
 */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

/** How long a dialog may sit open before the host closes it. Somebody who
 *  walked away has not chosen anything, and a dialog nobody remembers opening
 *  is the kind of surprise this host is built not to spring. */
export const PICK_TIMEOUT_MS = Number(process.env.ORCH_PICK_TIMEOUT_MS ?? 10 * 60_000);

const MESSAGE = 'Choose the folder your agent lives in';

/* argv, not interpolation: the start folder and the message reach the script
   as arguments, so a path with a quote in it is a path and never source.

   Only the chosen path comes back. "Where the panel was standing" would be
   the better thing to remember for next time, and the panel does not say:
   its directoryURL after Choose was measured to be the chosen folder itself
   whenever one was selected in the list, not the folder being shown. So the
   next dialog opens on the chosen folder's parent — see rememberDir in the
   page — which is where its siblings are. */
const JXA = `
ObjC.import('AppKit');
function run(argv) {
  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  const panel = $.NSOpenPanel.openPanel;
  panel.canChooseDirectories = true;
  panel.canChooseFiles = false;
  panel.allowsMultipleSelection = false;
  panel.message = $(argv[1]);
  panel.prompt = $('Choose');
  panel.directoryURL = $.NSURL.fileURLWithPath($(argv[0]));
  app.activateIgnoringOtherApps(true);
  if (panel.runModal != $.NSModalResponseOK) return JSON.stringify({ cancelled: true });
  return JSON.stringify({ path: ObjC.unwrap(panel.URL.path) });
}
`;

/**
 * The command that shows a folder dialog on this platform, or null where no
 * backend has been measured. Whatever it is, it is given the start folder and
 * answers on stdout with `{"path": "/…"}` or `{"cancelled": true}`.
 *
 * ORCH_FOLDER_DIALOG names a program to run in its place, with the start
 * folder as its one argument. It is the host suite's stand-in for a person —
 * a dialog cannot be clicked from a test — in the way ORCH_HOST_CLAUDE is its
 * stand-in for Claude Code.
 */
export function dialogCommand(start, { platform = process.platform, env = process.env } = {}) {
  if (env.ORCH_FOLDER_DIALOG) return { cmd: env.ORCH_FOLDER_DIALOG, args: [start] };
  if (platform === 'darwin') return { cmd: 'osascript', args: ['-l', 'JavaScript', '-e', JXA, start, MESSAGE] };
  return null;
}

/** Whether this host can show a folder dialog at all. Said to the board on
 *  every registration, so the page knows which picker to draw before anybody
 *  clicks anything. */
export function hasDialog(opts) {
  return dialogCommand('/', opts) !== null;
}

/**
 * Where a dialog asked to start at `path` actually starts: that folder if it
 * is still one, otherwise the nearest folder above it that is, otherwise home.
 *
 * The start is the folder the last choice was made in, remembered by a
 * browser, and a remembered folder can be gone by the time it is used — a
 * repo deleted, a drive unplugged. It must land somewhere that opens. One
 * level up is usually exactly where the person was working anyway.
 */
export function startFor(path, home = homedir()) {
  let p = typeof path === 'string' && path.startsWith('/') ? path : null;
  while (p) {
    try { if (statSync(p).isDirectory()) return p; } catch { /* gone, or not this account's to read: try the folder above */ }
    const up = dirname(p);
    if (up === p) break;
    p = up;
  }
  return home;
}

/**
 * Whether a request for the dialog is too old to act on, by the board's own
 * clock: `waited_ms` is stamped on the work item by the board as it hands it
 * over, so two machines' clocks are never compared.
 *
 * The page gives up on a host that has not answered in 8 s. A request that
 * reaches the host later than that — it was reconnecting, the board was
 * restarting — would open a dialog in front of somebody who stopped waiting
 * for one. A request with no stamp is from a board that does not send one,
 * and is acted on: refusing every request from an older board would be a
 * button that never works.
 */
export function pickIsStale(item, ttlMs) {
  const waited = Number(item?.waited_ms);
  return item?.waited_ms != null && Number.isFinite(waited) && waited > ttlMs;
}

/** What the dialog said, as one of three things — or what it printed, quoted,
 *  when it is none of them. Never a guess at why. */
export function readAnswer({ code, signal, stdout, stderr }) {
  const said = String(stdout ?? '').trim();
  let j = null;
  try { j = JSON.parse(said); } catch { /* not JSON: reported below as it came */ }
  if (code === 0 && j && typeof j.path === 'string' && j.path.startsWith('/')) return { ok: true, path: j.path };
  if (code === 0 && j && j.cancelled === true) return { ok: true, cancelled: true };
  const tail = String(stderr ?? '').trim().split('\n').pop() || said.split('\n').pop() || '';
  return { ok: false, error: `the folder dialog ended ${signal ? `on ${signal}` : `with exit code ${code}`}${tail ? `: ${tail}` : ' and said nothing'}` };
}

/**
 * Open the dialog and return at once: `done` settles when the person has
 * chosen or closed it, however long that takes. Not awaited by the work loop
 * — a person in a folder dialog takes as long as they take, and messages to
 * desks are delivered by the same loop.
 *
 * Its own process, on every platform, for the same reason and one more: a
 * dialog that lives in a child goes when the child does, so closing one that
 * was left open is ending a process rather than driving a window.
 */
export function openFolderDialog(start, { timeoutMs = PICK_TIMEOUT_MS, platform, env } = {}) {
  const c = dialogCommand(start, { platform, env });
  if (!c) return { ok: false, error: `this host has no folder dialog on ${platform ?? process.platform}` };
  let child;
  try {
    child = spawn(c.cmd, c.args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return { ok: false, error: `could not start the folder dialog (${c.cmd}): ${err.message}` };
  }
  let stdout = '';
  let stderr = '';
  let leftOpen = false;
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const timer = setTimeout(() => { leftOpen = true; child.kill('SIGTERM'); }, timeoutMs);
  const done = new Promise((resolve) => {
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: `could not start the folder dialog (${c.cmd}): ${err.message}` }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      // Ending the process is how the dialog is closed (measured: the window
      // goes with it), so a dialog this host closed is not a failure.
      if (leftOpen) return resolve({ ok: true, cancelled: true, why: `left open for ${Math.round(timeoutMs / 1000)}s` });
      return resolve(readAnswer({ code, signal, stdout, stderr }));
    });
  });
  return { ok: true, done, close: () => { try { child.kill('SIGTERM'); } catch { /* already gone */ } } };
}

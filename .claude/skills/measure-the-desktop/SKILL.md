---
name: measure-the-desktop
description: Find out what a dialog or window opened by the host actually does on the operator's screen — run it under a throwaway LaunchAgent with the host's own plist shape (macOS) or a hidden scheduled task like the installed host's (Windows), watch who is frontmost, and press it without a person. Use before adding or changing anything the host puts on the desktop (the folder dialog, a new platform backend, a terminal it opens), and before believing "it opens a dialog" means "the person can see and use it".
---

# Measuring what the host puts on the desktop

The host is a LaunchAgent. Something it opens on screen is opened by a
background service, and **"is drawn" and "is in front of the person" are
different answers** — that is the whole reason this skill exists. The first
three ways tried for the folder dialog all drew a dialog; none of them gave
it the keyboard, and a dialog sitting unfocused over a browser reads to the
person as a button that did nothing.

What was measured, and where it is written down: the header of
[`host/dialog.js`](../../../host/dialog.js) (four ways, macOS 26.6.2,
2026-10-01). Read it before proposing a fifth.

## The loop

```bash
D=.claude/skills/measure-the-desktop
$D/launch-probe.sh $D/dialog-probe.mjs /some/start/dir     # the shipped picker, under launchd
$D/watch-front.sh osascript 10                             # who is frontmost; where its windows sit
$D/press.sh NSOpenPanel 'key code 36'                      # Return — only if the dialog is frontmost
cat "${PROBE_DIR:-$TMPDIR/orch-desktop-probe}/out.jsonl"   # what the dialog answered
$D/launch-probe.sh --stop
```

`launch-probe.sh` runs any node script under a job shaped like the host's
plist — the node binary read out of the installed host's plist, the same
environment keys, the `gui/<uid>` domain. **Run from your own shell instead
and you have measured your shell**: a process started from a terminal is
already in front, and everything takes focus from there. The live host is
never touched; the probe is its own label and `--stop` removes it.

To measure something other than the shipped picker — a candidate backend, a
library — write a five-line `.mjs` that takes the out-file as its first
argument and spawns the thing the way the host would (`execFile`/`spawn`
from node), and hand that to `launch-probe.sh`. Keep it out of the repo
until it has passed.

## What to read off it

| Question | Where the answer is |
|---|---|
| Did it take the front? | `watch-front.sh`: `front=` is the frontmost app, `pid=` its pid — compare with the dialog's own pid |
| Is it merely drawn? | a window at `layer=8` (modal panel level) with somebody else frontmost: on top, without the keyboard |
| Who owns the window? | the owner column. A dialog shown through `tell application "System Events"` is System Events' window, not osascript's |
| Does it return what was chosen? | `out.jsonl`, the `done` line |
| Does it honour its start directory? | press Return on the untouched dialog: it returns the folder it opened in |
| Does it go when its process goes? | end the process, then `watch-front.sh` again — zero windows, or an orphan |
| Does focus go back? | `front=` after it closes |

A pass is all seven. The picker's bar, from issue #4: frontmost, returns a
path, honours the start directory, closes with its process.

## Six things that cost a round each

**`screencapture` puts a permission prompt on the operator's screen.** This
shell's responsible process is the host's node, so the prompt reads "node
would like to record this computer's screen" — and it sits there, on their
desktop, about a thing they never asked for. There is no screenshot in this
skill on purpose. Window owner, layer, bounds and stacking order come from
`CGWindowListCopyWindowInfo` without any permission (`windows.swift`); only
window *titles* need Screen Recording, and nothing here needs titles.

**A keystroke goes to whatever is frontmost.** If the dialog did not take
focus, Return lands in the operator's browser and sends whatever they were
typing. `press.sh` compares the frontmost pid with the dialog's pid and
sends nothing on a mismatch. Never send a bare `key code`.

**The button cannot be clicked by name.** An open panel's buttons live in a
separate view service; `click button "Choose" of window 1` fails with
"Can't get button", and walking `entire contents` finds none. The default
button answers Return, Cancel answers Escape, and typing a name selects a
row. And `tell process "osascript"` resolves to *your own* osascript, the one
running the query — address a process by `unix id`.

**Pressing the panel from inside is not a click.** A probe that calls the
panel's own `ok:` on a timer raises a small alert (260×234, layer 8) instead
of closing it, in any folder. Whatever that alert says, it is not what a
person's Return does — drive it from outside.

**A dialog owned by another app outlives the probe.** Ending osascript left
a System Events-owned dialog on the operator's screen, still frontmost
seconds later; the only way to clear it was to end System Events. Check for
leftovers before you stop (`watch-front.sh <owner> 1`), and never leave a
window of yours on their desktop.

**After Choose, the panel's `directoryURL` is the chosen folder, not the
folder it was showing** — whenever a row was selected. So "where the panel
stood" cannot be read back from it, which is why the page remembers the
chosen folder's parent instead.

Smaller ones: `pkill -f` takes a regex, so a pattern with parentheses in it
matches nothing and leaves the dialog up; BSD `sed` has no `\|`; and
`launchctl bootstrap` straight after `bootout` fails, which `launch-probe.sh`
waits out.

## Tell the operator first

A probe opens real dialogs on a real person's screen while they are working
at it. Say so before the first one — "a folder dialog will appear briefly" —
and keep each run to seconds.

## Windows

The Windows host is a hidden process too: Task Scheduler starts
`conhost.exe --headless node supervise.mjs` as the logged-on user
(`host/install.ps1`), and Windows' foreground lock stops a process that is
not in front from taking the front. The same question, the same rule:
**a window drawn is not a window in front**, and only a watch says which.
Measured 2026-11-20 (pc-developer, Windows 11 26200, Windows PowerShell 5.1,
costmo watching the screen). The rig is `windows/`:

```powershell
$D = '.claude\skills\measure-the-desktop\windows'
# 1. the watcher, hidden so it is not itself the window in front
Start-Process -WindowStyle Hidden powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',"$D\watch-front.ps1",'-Seconds','90'
# 2. the person clicks into the browser (the floor) - the real starting point
# 3. the thing under test, from a hidden scheduled task (no trigger), e.g. the folder dialog.
#    Full paths: the task runs in windows\, not where you are.
powershell -NoProfile -ExecutionPolicy Bypass -File "$D\probe-task.ps1" C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -File "$PWD\host\dialog-win.ps1" C:\Users
# 4. read what came back (printed by probe-task, kept in %TEMP%\orch-desktop-probe\out.jsonl)
#    and the foreground changes (%TEMP%\orch-desktop-probe\watch-front.log)
powershell -NoProfile -ExecutionPolicy Bypass -File "$D\probe-task.ps1" -Remove
```

`probe-task.ps1` registers a task with no trigger (it starts only when the
script starts it, and nothing can start it later), runs `launch.cjs` under
`conhost --headless` with Task Scheduler's environment, waits for its end
line, and prints it. `launch.cjs` starts the program with `execFile`, no
shell, `windowsHide` (or not, with `-Show`), and logs its exit, stdout and
stderr. `watch-front.ps1` writes the foreground window's process, pid, class
and title every time it changes. Every task registered is the person's to
allow (the auto-mode permission check stops one until they say so): ask, say
it has no trigger and will be removed, and remove it.

**Somebody watches the screen and says what they see.** The watcher says
which window has the keyboard; only a person says whether a window they can
see is behind another, or flashed. Ask after each round, in a question that
stands on its own, and tell them before each round to click into the
browser. A round they missed is run again, not guessed.

What to read off it:

| Question | Where the answer is |
|---|---|
| Did it take the front? | `watch-front.log`: the program's own process becomes the foreground (`powershell … class=#32770` for a dialog, `WindowsTerminal … class=CASCADIA_HOSTING_WINDOW_CLASS title='<the title it was given>'` for a terminal), from `chrome` where the person clicked |
| Is it merely drawn? | the person sees it on top while the foreground stays the browser or the terminal |
| Is it there at all? | enumerate top-level windows by the program's pid (`EnumWindows` + `GetWindowThreadProcessId` + `IsWindowVisible`): a visible window that is never the foreground is drawn and behind |
| What did it answer? | `out.jsonl`'s end line: exit code and stdout, as the host would read them |
| Does focus go back? | the next line in `watch-front.log` after it closes |
| Does it go when its process goes? | kill the program's process, enumerate again: no visible window of that title |

What was tried, and where the full account is (do not copy it here; read it
there before proposing another way):

| Window | Tried | Result | Record |
|---|---|---|---|
| Folder dialog | IFileOpenDialog, no owner | drawn behind the window in front | `host/dialog.js` header, `host/dialog-win.ps1` header |
| Folder dialog | owned by an always-on-top window | drawn above everything, not focused | same |
| Folder dialog | that owner brought to the front first (ALT tap + AttachThreadInput + SetForegroundWindow) | in front and focused, 1.5 s | same (the backend) |
| Windows Terminal (Open in tmux / Open in Claude) | `wt.exe -w new new-tab --title <t> --suppressApplicationTitle …`, then `host/front-win.ps1 <t>` | behind before; in front and focused 4 of 4 after, 1.0–1.3 s | `host/front-win.ps1` header, `attachWindowsTerminal` in `host/window.js` |

Traps that cost a round each:

- **`windowsHide` hides a window that is supposed to be seen.** Node passes
  SW_HIDE to the child, and Windows Terminal honours it: `wt.exe` started
  with it made a window that existed (psmux listed its client attached and
  focused) and the person saw nothing. Hide the helpers, never the window
  the person is meant to use (`launch.cjs -Show`).
- **`existsSync` says `wt.exe` is not there, and `execFile` runs it.**
  `%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe` is an app-execution alias, a
  reparse point that `fs.existsSync` reads as missing. Don't gate on it.
- **A `.cmd` or `.bat` stand-in is refused by `spawn` with EINVAL** (Node's
  fix for CVE-2024-27980: no batch file without a shell). A stand-in for
  `ORCH_FOLDER_DIALOG` on Windows is an `.exe`; `node.exe` with its behaviour
  preloaded through `NODE_OPTIONS=--import=<file:///….mjs>` works.
- **Your own window's environment leaks into whatever you start from it.**
  A psmux server started from a Claude Code window inherits `CLAUDE_*`
  (`CLAUDE_CODE_CHILD_SESSION` among them), and every claude in its panes
  says "Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION
  marker" and writes no transcript. Unset `CLAUDE_*` and `ANTHROPIC_*` for
  anything started by hand; a scheduled task has none of them.
- **Started from your window, it measures your window.** Your terminal is
  in front, or was a moment ago, and a process it starts inherits that. The
  first dialog round run from a shell said nothing about the host. Use the
  task.
- **`Select-Object -First N` on a child's output kills the child** when it
  has its N lines, so `install.ps1 … | Select-Object -First 3` read exit -1
  for an install that exited 0. Capture the output, then select.
- **`Stop-ScheduledTask` is a kill**: no signal, not even `process.on('exit')`
  runs. A clean stop is asked for first (the host's stop file, in
  `install.ps1`), and the task stopped after.
- **Task Scheduler does not restart a task whose program exits non-zero**,
  whatever RestartCount says (that is for a task that fails to start). The
  keep-alive is `host/supervise.mjs`.
- **`node -e` with JSON from Windows PowerShell 5.1 loses its quotes**: 5.1
  does not escape `"` inside an argument it passes to a native program. Pass
  values through the environment or a file, as `install.ps1` does.
- **The repo's `package.json` is `"type": "module"`**, so a CommonJS helper
  in the tree is `.cjs` (`launch.cjs`), or `require` is not defined.
- **A PowerShell script's first string parameter takes the first positional
  argument** unless `[CmdletBinding(PositionalBinding = $false)]`:
  `probe-task.ps1 <program>` named the task after the program until it was
  set.

Not measured on Windows: a locked screen (no window in front to take the
focus from), two monitors, and a Linux host under WSL.

## What this has not measured

A person's mouse click on Choose was checked by the operator by hand, not by
this (the press here is a keystroke). A browser in a full-screen Space the
same. Linux not at all: `host/dialog.js` has no backend for it, and a
backend goes in only after this loop — or that platform's equivalent of it
— has been run against it. Windows is measured, by the section above.

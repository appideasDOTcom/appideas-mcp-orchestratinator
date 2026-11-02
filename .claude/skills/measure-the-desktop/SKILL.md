---
name: measure-the-desktop
description: Find out what a dialog or window opened by the host actually does on the operator's screen — run it under a throwaway LaunchAgent with the host's own plist shape, watch who is frontmost, and press it without a person. Use before adding or changing anything the host puts on the desktop (the folder dialog, a new platform backend, a terminal it opens), and before believing "it opens a dialog" means "the person can see and use it".
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

## What this has not measured

A person's mouse click on Choose was checked by the operator by hand, not by
this (the press here is a keystroke). A browser in a full-screen Space the
same. Linux and Windows not at all: `host/dialog.js` has no backend for
either, and a backend goes in only after this loop — or that platform's
equivalent of it — has been run against it.

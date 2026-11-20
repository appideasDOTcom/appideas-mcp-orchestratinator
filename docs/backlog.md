# Backlog

Things worth doing that nobody is doing yet. One entry per item; say what was
seen, not what was guessed, and note where it came from so the next person can
find the thread.

## Better instructions for switching away from localhost / changing MCP servers

The README's only mention is one sentence in step 5 (install the host): if
desks point at more than one board, pin one with `./host/install.sh --url …`.
The example is localhost and it reads as an install-time tie-breaker.

What is missing:

- That the host serves exactly one board, and the board can be another
  machine on the network. The whole "production board on the LAN, development
  board on localhost" shape is undocumented.
- How to move a host to a different board: edit `url` in
  `~/.orchestratinator/host.json` (or re-run `install.sh --url`), then restart
  the LaunchAgent, then read the host log to see which desks it now serves and
  which it skips.
- What the floor says when the host is pinned elsewhere — "No host on this
  board is running that repo" — with no pointer to the host pin as the first
  thing to check.
- Where the MCP server address lives for each repo (`url` in its `.mcp.json`)
  versus where the host's board lives (`host.json`), and that both must name
  the same server for "Open on the floor" to appear.

Seen 2026-09-02, first live use of the floor against the production server:
this repo's `.mcp.json` pointed at the network board while the host stayed
pinned to localhost, and the floor reported no host.

## A window stopped on the folder-trust prompt: self-heal for the missing trust record

Seen 2026-09-02, first production round trip. "Open on the floor" opened the
window and it sat on Claude Code's folder-trust dialog ("These will apply
without asking. Only proceed if you trust this configuration … Yes, I trust
this folder"). The floor reported it correctly — "has not finished starting,
something on screen is waiting for an answer", pane quoted — and the operator
had to open a terminal, `tmux attach -t orch`, and answer it by hand.

**Shipped 2026-09-03: surfacing the prompt.** The host now reads a startup
dialog (folder trust or a new MCP server) off the pane and the desk carries
it as a prompt on the floor — "Before it can start, the window asks" — with
the dialog's own rows as buttons; the host presses only the row the operator
picks. `startupQuestionOf` / `answerStartup` in `host/window.js`, the
`startup` host event in `src/floor.js`. The reasoning that used to claim a
desk could never arrive at this prompt cold was wrong on two counts — a
VS Code session defers the MCP approval, and re-pointing `.mcp.json`
invalidates it — and the note beside `ANSWERS` says so now.

**Still open: self-heal where it is safe.** The observation that started this
still stands: this desk had been on the board all morning from VS Code, and
`~/.claude.json` still had `hasTrustDialogAccepted: false` for it in every
backup from the day, so VS Code sessions do not appear to write folder trust.
Detecting at open time that the trust record is missing for a repo that is
already a desk on this board, and saying so before opening — or writing the
record, if it turns out that is all the dialog checks — would close the gap
before the operator ever sees the prompt. Needs measuring
(`measure-a-real-window`), not assuming. Keep the decision the operator's:
this is about not asking a question whose answer is already known, not about
auto-answering one that isn't.

## Fixed in 0.12.11: an open question drops off the floor

Carried here from QA's review of PR #2 (2026-09-03) as "a startup prompt
drops off the floor while an editor session shares the desk", and narrower
than the defect. The milestone audit (2026-11-17, finding 1, High) measured
the whole of it: **any** open question (a permission prompt, an
AskUserQuestion, a startup question) disappeared from the floor when another
session on the desk made a tool call, and at **every board restart**, and
nothing raised it again, because a window standing on a question sends no
further hook. The heartbeat's `pending`, meant to carry open prompts across
a restart since 2026-08-28, was dead at both ends: the host never sent it
and the board had no case for it.

What ships, in 0.12.11:
- A prompt records the session that raised it, and only that session's own
  work closes it (`ingestHookEvent`'s clear in `src/floor.js`). A startup
  question records the window's, and closes when the host says it is gone.
- Every heartbeat carries `pending`: each floor window whose bottom line
  says it is asking (`askingIn` in `host/window.js`). The board raises
  any it has forgotten and asks the host to read its choices
  (`permission_request` in `applyHostEvent`), ignores one within
  `RESAY_QUIET_MS` of an answer, and closes one it raised when the host
  stops naming it. A host re-registers at once after a failed poll, so a
  restarted board has its questions back within seconds.
- Not covered: a question asked in an editor's chat. The host cannot read
  that window, so after a board restart it is raised again by that
  window's own next hook only.

Rows: `test:floor` "an open question stays on the floor" and the restart
row beside the suite's own board restart; `test:host` restarts the board
while a real pane asks and reads the question back on the floor.

## Linux and Windows backends for the folder picker

`host/dialog.js` has a native folder dialog for macOS only, so a Linux or Windows host gets the page's in-page list — issue #4 is held open as partially implemented until each backend is built and watched taking focus from the host's own service, or ruled out.

## A meeting room survives closing the app or the floor it came from

costmo, 2026-11-20, in meeting room 27: "meeting rooms should survive
closing the app or closing the floor". What was seen: in the desktop app he
closed a floor window and the room it had opened went with it, ending the
meeting. He had not expected that. Not dug into then: distribution came first.

Read, not measured: the app's open handler (`orchestratinator-desktop`,
`src/main/security.ts`, `setWindowOpenHandler`) lets a room's and a popout's
window open as a child of the page that asked. Electron closes a child with
its parent, and the comment above `openFloorAt` says it was measured for
floor windows, which are therefore opened as the app's own. And a room's window
closing is its meeting ending (pagehide ends the record, because the page
cannot tell a close from a reload): the desks are sent back to the floor
with a notice, and a second session made for the room is closed
(`sweepTwins`).

Two halves:

- **The app's:** open rooms and popouts as windows of its own, as floors
  are, and reopen them at launch the way it reopens floor windows. The page
  already works without a handle on the window: End goes to it as `end` on
  `orch.popouts`, and the raise as `focus` with the place. Contract
  `orchestratinator.window_moves` still holds.
- **This repo's:** a window closed by an app quit must not end the meeting.
  If it does, every desk is told it is back on the floor and then told
  again that it is in the room, and its second sessions are closed and
  reopened. The page needs a word from the app that it is quitting, so it
  leaves the record open. Then the reopened room's `/meeting/open` and
  `quiet` (the same others) send nothing. A crash with no word is still
  the case the twin sweep's timings are for. How "closing the floor" in a
  browser should treat a room is not decided: there a room already
  outlives the tab that opened it.

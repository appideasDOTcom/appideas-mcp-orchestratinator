# Working in this repo

Orientation for an agent that has not been here before. The README explains what
the orchestratinator is and how to install it; this file is the handful of things
that are easy to get wrong and expensive to re-learn.

## The one rule everything else follows from

**A conversation is one `claude` process, so one app holds it at a time.** Not a
document two windows can share. The floor shows who holds a desk, and moving it
is an explicit handoff: your editor's tab closes, the host opens a tmux window
with `claude --resume <session>`, and "Open in VS Code" reverses it.

**"Open in Claude" is deliberately not a third seat.** The floor's window
already *is* claude CLI, so there is nothing to hand off in that direction: the
button opens the desk's window if the floor has none and lands a terminal on
it (`case 'claude'` in [`host/index.js`](host/index.js)). The version that
mirrors the VS Code handoff — a bare `claude --resume` in the operator's own
terminal — was considered and rejected, and the reason is the failure mode, not
taste: closing an attached terminal is a detach and the desk carries on;
closing a bare one SIGHUPs the conversation dead, for the exact audience
(partners dropping in to run a slash command and leave) this button exists
for. Validated round-trip on the live board 2026-09-01. Do not re-propose the
handoff version as backlog.

**Nothing enforces this.** It is a rule the UI expresses, not a lock, and it is
worth knowing exactly how it fails before proposing to relax it. Two processes
can both `--resume` one session id and both run — measured 2026-09-01, along with
why it is not survivable: resume *reopens* rather than forks, so both append to
one transcript while neither re-reads it, and their contexts diverge silently.
The board now reports `holders` and says so on the desk rather than picking one
quietly. So: not "impossible", but "diverges without telling you", which is
worse. Do not design against it as a guarantee.

**The board's pin can name a conversation that does not exist, and a process
you cannot see can hold one that does.** Both measured 2026-09-09 on 2.1.258,
on one desk. The roster keeps a process's *first* session id, so a VS Code tab
that runs `/resume` inside writes every word into another file and leaves the
desk pinned to an id with no transcript — and `claude --resume` of that exits
on its first line. `resumable()` in [`host/window.js`](host/window.js) checks
the disk before handing an id over, falls back to the conversation with the
latest spoken turn (as `readTranscript` files it — a tab holding only
`/resume` and its output is not one), and says so on the floor as a line
labeled `host`. And Claude Code's daemon keeps a conversation running after
its tab has closed: `kind: bg` in the session file, `claude bg-spare` in `ps`,
"running as a background session (<job>)" when resumed. The watch follows
interactive sessions only, so such a desk reads as empty — and opening it
from the floor does the move: the host presses `claude stop <job>` itself,
waits for the roster to drop it, resumes the conversation in the window and
says so on the desk (`releaseBackground()`). That is the one thing the host
does on the person's behalf, and the reasoning is beside it: the click is the
handoff and there is no tab of theirs to close, `stop` keeps the conversation
in Claude Code's own words, and the version that told a partner to run
`claude stop` themselves stranded a working channel for an afternoon. **A
remedy is never handed to the operator as a command.** If the floor can name
it, the floor runs it on the click.

State lives in three places, and they must agree:

| What | Where | Read it with |
|---|---|---|
| Which processes are alive | Claude Code's roster | `claude agents --json` |
| Which pane runs which pid | tmux | `tmux list-panes -a -F …` |
| Who the board thinks holds it | the server | `curl -s localhost:8787/api/floor` |

`holderOf()` in [`host/window.js`](host/window.js) is the join of the first two:
a session in the roster with no pane means an editor has it. It reports three
more things, and they exist because `held` on its own is ambiguous:

- **`window_open`** — a pane in that repo, found by *directory*, whether or not a
  session has registered in it. The roster and tmux answer different questions
  and disagree for the whole of Claude Code's startup: a window stopped on the
  folder-trust or MCP question has written no session file, so `held` is null
  while a window sits on screen. `held: null` + `window_open: true` means
  **starting, not absent** — go and read the pane.
- **`holders`** — live processes claiming this conversation. Above 1, see above.
- **`clients`** — terminals attached to the tmux session, from
  `tmux list-clients` (~7ms). The floor's attach spinner settles on this rising,
  because opening a terminal changes nothing else the board can see.

## Three boards, one of them ours

Desks on this machine point at three different servers. **Only
`http://localhost:8787` is in scope.** `http://10.0.42.120:8787` is Chris's own
server and `https://appideas-mcp.ngrok.dev` is a tunnel — do not test against,
register with, or read from either. Most discovered desks point at 10.0.42.120,
so `[host] skipping <desk> — its board is http://10.0.42.120…` is correct
behaviour, not a fault. The host pins its board with `url` in
`~/.orchestratinator/host.json`; when desks disagree and nothing pins it, the
host refuses to start rather than guess.

## The host

A launchd job (`com.appideas.orchestratinator-host`), not part of the Docker
stack. It reaches out only — the server never connects to a workstation.

```
launchctl kickstart -k gui/$(id -u)/com.appideas.orchestratinator-host   # restart
tail -f ~/.orchestratinator/log/host.log                                 # watch
```

It logs almost nothing after startup, so absence of log is not absence of
activity. **After editing `host/*.js` you must restart it** — nothing reloads,
and a running process older than the file is the most common reason a fix
"didn't work". Compare `ps -o lstart=` against the file's mtime rather than
assuming.

**Every line it writes carries a UTC time, and a failed request names
itself** (issue #5, steps 1–2; `host/log.js`). Before that, the file
held 7,379 failure lines in 11,745 and not one time, and each failure read
`fetch failed` or "The operation was aborted due to timeout" for the
register, the work poll and the events alike. So a burst could be counted
but never lined up with `docker logs -t` or put against a route. The time
goes *after* the tag (`[host] 2026-11-03T19:54:18.123Z …`), because the file
is append-only and still holds every untimed line. Anything anchored on
`^\[host\]` reads both shapes; status.sh's desk-line pattern was widened for
the indent that now follows the time. A failure reads `<METHOD> <board><path>
<refused|timed out|failed (code)|→ status> after Nms`, with the limit beside
a timeout. Read the wait against the limit: the timer runs on the host's own
event loop, so a wait well past it is the host, not only the board.
**diagnose-handoff** has the greps. Nothing else changed with it: the
backoff, the re-register after a failure and the events requeue are as
they were, and the suite says so beside the new assertions.

**The board says when it could not answer** (issue #5 step 3, costmo's
"Hold + slow request"; `src/server.js`, `test/board-log.mjs`). Staged with
six 12 s holds of the board's event loop, the host logged six timeouts and
the board wrote nothing. It now writes `event loop held <N>ms`, a 250 ms tick
more than a second late, and `slow <METHOD> <path> <N>ms <status>` for a
request over 2 s. Method and path only. The two event streams are left out,
and so is the work poll up to its own wait. Read them together: the work
poll is nearly always mid-wait, so it reads slow on *any* hold, and only
another route reading slow names a culprit. Requests that arrive during a
hold read fast. Those lines and Docker Desktop's logs are gone within hours
(a deploy recreates the container; `monitor.log` keeps about 25 minutes),
so **capture-a-burst** saves them while a burst is still happening. The
two lines are the server half and reach the live board only with a rebuild.
What issue #5 turned out to be, once caught: the board shares Docker
Desktop's VM with everything else in Docker, and at 4 GiB a site e2e matrix
ran it out of memory. The board's loop was held 59.5 s until the VM's kernel
killed a MySQL, and Docker Desktop at 8 GiB fixed it (2026-11-03). A capture
summary's `OOM kills in the VM` line is that reading.

**The server is the other half, and it goes stale independently.** The
**deploy-both-halves** skill is the procedure — its `status.sh` reads both
halves against the tree, with symbol counts in what is served — and a deploy
task is closed with those readings, not with "rebuilt". `src/` is
baked into the image (`build.context: .`; only `/data` is a volume), so a change there
needs `docker compose up -d --build` — and that printing `Container … Running`
instead of `Recreated` means it did *not* take your change. Restart each in its
own command and then check both against the file mtimes. Chaining them behind
`npm test` once exceeded a seven-minute timeout and left a stale container **and**
a stale host while the suite reported green.

Two more facts about that rebuild, both measured 2026-09-01. It blanks
presence for every desk — presence is an MCP session in the server's memory —
while the relay rides out the restart on its own retries, so the board shows a
conversation flowing between desks that look absent. Nothing is broken; one
MCP tool call per desk brings each back. A **Docker Desktop restart** is
different for the session you are in (2026-11-03, the 8 GiB change). Its
orchestratinator tools disappear outright, with ECONNREFUSED at the moment
Docker went down, and no call brings them back; costmo reconnects them with
`/mcp`. Until then, read the board with curl or board-query.sh and say so.
And the `/data` volume is *named*:
the repo's own `data/` directory is test leftovers, not the live database, so
a row repair goes through `docker compose exec -T orchestratinator node` with
better-sqlite3 at `$DB_PATH`, never through a file in the working tree.

**A key written `${ORCH_AUTH_TOKEN}` is read in three environments, and
only one of them is the operator's shell** (PR #52, 0.12.4, 2026-11-06).
Claude Code expands `${VAR}` in a binding's headers from the window's
environment, and the host and the hook expand it the same way
(`expandEnv`, two copies; `:-` is for *unset* only, as 2.1.300 sends ""
for a set-but-empty variable). But the host runs under the LaunchAgent with
`PATH` + `HOME` and nothing else, and a window the host opens has the tmux
server's environment, which the host started. QA measured both: such a
desk gave the host no key, and its floor-opened windows sent the literal
placeholder. costmo's ruling: install.sh takes an exported
`ORCH_AUTH_TOKEN` into host.json when `--token` is not given, and the host
gives a window that one variable, set to its own key, with tmux `-e`
(`paneEnv`), only for a key that is nothing but a placeholder it could not
fill. Nothing is written to disk. `-e` and not the command's `env` prefix,
because tmux keeps and prints a pane's start command. And `new-session -e`
is not `new-window -e`: it writes the *session's* environment, which every
later window inherits and `show-environment` prints, so the window that
opens the session unsets it straight after (QA, finding 4). When the host has no
key at all, its startup line names the desk and the variable.

Two loops run side by side in [`host/index.js`](host/index.js): `watchLoop()`
relays the conversation, `run()` handles work. Keep them apart. When they shared
one loop, delivering a message blocked the relay for up to a minute — the floor
went silent mid-conversation and then dumped the backlog in one batch.

**Work that waits on a person, or walks the disk, is started and not
awaited.** The same reasoning one level down: `run()` handles work items in
order, so anything slow inside one holds every message behind it. The folder
dialog (`pick`), a conversation read whole (`read`), the recent list and a
search all return at once and answer later as events; the search goes further
and runs as a process of its own, because one 70 MB transcript is a third of a
second of `JSON.parse` on the event loop the relay shares.

**A tmux server can lose the right to read a desk's folder, and the host
moves every window to a fresh one rather than let a desk see it** (costmo,
2026-11-10: "I will not accept a user ever seeing this error, even once").
Measured that day on macOS 27.0.1: the `orch` server, up two days, was
refused `~/Documents` and everything under it (`System Policy: … deny(1)
file-read-data` in the kernel log, with tccd never consulted), except
folders the folder dialog had stamped with a `com.apple.macl` grant. So
desks taken through the dialog worked, and a desk bound any other way died
mid-session with "Can't read the current directory (EPERM)", as did every
window reopened for it. A fresh tmux server started the host's way read all
of it, and TCC still had the host's Documents grant. Why that one server
carried the refusal was not found (the log of its first day had rotated), so
the host does not guess. `checkServer()` runs a 16 ms `run-shell` read of
each window's folder at every heartbeat, and `open()` runs the same check
before it makes a window. When the server is refused and a fresh one is not,
`renewServer()` waits for working windows to end their turn (up to
`ORCH_RENEW_WAIT_MS`), kills the server, and resumes each conversation in a
fresh one; a window that had no conversation yet starts one there. An agent
whose turn was cut off, whose question was closed, or which had met the
refusal is told in the host's words, and each desk gets a `host` line
(`renewNote`). It refuses to kill a server that also runs sessions which are
not the floor's, and an `open()` of a folder that nothing can read (mode
000, or deleted under its window, which tmux still gives as the pane's path)
returns `unreadable` with nothing moved. Three rules from QA's review of
PR #54, each measured:
- **The read is `run-shell` with no `-t`.** With a target, a refused read
  writes "returned 1" into that pane and leaves it in view-mode, and
  `orch:` is a desk's window: its next message went to the mode and the
  host said `not_delivered`, with the floor's capture showing the screen
  underneath. Without `-t` the exit is still 1 and no pane changes. Any
  `run-shell` against the floor's server, by hand included, goes without
  one.
- **A move is made once for a refusal.** After the move, the folders are
  read again on the new server, before any agent is told "readable again".
  One still refused is said on its desk and kept in `stillRefused`: no
  check moves for it and no open makes a window in it until the server
  reads it again. Moving again was a full kill-and-resume at every
  heartbeat, 3 of 3. `freshReads` is a private socket with no tmux.conf,
  which is not the server a move makes, so "a fresh server reads it" never
  promised the move would clear it.
- **renew()'s own reopens never ask for a move.** They pass `moving`, and
  a refusal on the new server returns `unreadable` instead. Asking for a
  move from inside the move returned the promise that was running. It never
  resolved, so the window was not reopened, and `checkServer()`, awaited on
  the host's line in `run()`, never returned.

`test:renew` drives it on a socket of its own, never the default, because
the default socket is the live `orch`. Its refusal belongs to the server
running when it is set (`refuse()`), as on the day, or `sticky` to every
server for the move that does not clear it. What it does not drive is
`index.js`'s two lines, the heartbeat's call and the hook. `test:host` runs
its host on the default socket beside the live `orch` session, where a
move is a `kill-server` of the operator's floor (and `renew()`'s own guard
refuses it because of that session), so the host suite can reach only the
refusal. The words those two lines carry are `renewNote`, and `test:renew`
asserts them. **diagnose-handoff** has the readings.

It has been seen live once, and the floor was spared: on 2026-11-14 at
20:19:14Z the heartbeat moved all four windows, with a `host` line on each
desk. The same afternoon the refusal also landed on the operator's
terminal: from 12:13 local every process under iTerm2 was refused
`~/Documents`, so a conversation run there could not read its own repo. A
server it started was refused as well, and that is not the host's to move.
So an agent whose own commands get EPERM checks its own shell before
reading the floor's (diagnose-handoff, first step). Moving the conversation onto the floor
is what brought it back.

**The host puts one thing on the operator's screen itself, and how was
measured, not chosen.** The folder dialog is one function,
[`host/dialog.js`](host/dialog.js), with a backend per platform and only
macOS filled in. Its header is the record: four ways of opening a dialog
from a LaunchAgent were watched, three are *drawn and never focused* (or
outlive their process), and a cross-platform npm library was tried and is
one of the three. So: do not swap it for a library, and do not write a Linux
or Windows backend from first principles — a backend goes in after it has
been watched taking focus from the host's own service, which is what the
**measure-the-desktop** skill is for. A host with no backend says so on
registration (`dialog`) and the page draws its own list for it; that list is
the fallback, not leftover code.

## Driving a window

Everything the host knows about a window is a text capture of its pane, and
**every rule for typing into one was measured, not reasoned**. They are recorded
in [`.claude/skills/watch-the-window`](.claude/skills/watch-the-window/SKILL.md),
and the obvious guess is wrong in all four cases: on an AskUserQuestion a digit
*selects* on a single-select (and only *moves* on one drawn with previews,
below), *toggles* on a multi-select, the free-text row
*withdraws the form* on a single-select but *opens a field* on a multi, and the
Submit tab is arrived at by answering the last question rather than walked to. A
day was spent proving each of those; do not adjust `answerSteps()` in
[`src/floor.js`](src/floor.js) from first principles.

Three consequences worth knowing before touching `host/window.js`:

- **`-t orch` is not the session.** `new-window` takes a window index, and
  tmux resolves a bare name against window *names* first, by prefix — so the
  day a desk called `orch-slice1-demo` had a window, `-t orch` meant that
  window's index and every open on the board failed with `create window
  failed: index 1 in use` (3.7c, 2026-09-09). A session target carries the
  trailing colon: `orch:`.
- **And `orch:` is not only that session: the name is written `=orch`.**
  With no session of the exact name, tmux gives a session target to any
  session whose name *begins* with it. Measured on 3.7c (2026-11-16; QA,
  PR #57 round 2, read plus one measurement; repeated here on a socket
  with only a session called `orchid`): `has-session -t orch` exits 0,
  `list-panes -t orch` lists orchid's panes, `new-window -t orch:` makes
  its window in orchid, `send-keys -t orch:` types into it. So the first
  desk window after a reboot, or after the floor's last window closed, was
  made inside whatever session of the operator's own started with "orch":
  a suite's `orch-test-<pid>` on this machine, anybody's `orchestra` on
  theirs. costmo's ruling, by AskUserQuestion, the same day: fixed in
  PR #57 and not after it. Every target `host/window.js` writes from the
  name is `EXACT` (`=orch`) for a session and `${EXACT}:` for a window in
  it. Three things about `=`, each measured: it needs the colon wherever
  the target is a window's (`list-panes -t =orch` still listed orchid's
  pane, `-t =orch:` did not); the targets tmux hands back (`orch:@4.%7`)
  are left alone, because a window id is the server's own and `send-keys
  -t orch:@9.%9` is refused whatever else begins with "orch"; and `attach
  -t orch` is left too, since it is a line for a shell, where `=orch` is a
  command lookup in zsh, and it runs only after the exact `has-session`
  beside it. A tmux command written by hand against the floor, in a test
  or a skill, takes `=name` the same way: the window suite's own cleanup
  `kill-session -t orch-test-<pid>` would take a look-alike with it.
- **The host's panes are its own session's, and no other's** (costmo,
  2026-11-16, by AskUserQuestion to me and to QA the same hour: fixed in
  PR #57). `panes()` asked `list-panes -t <session> -a` under a comment
  that said "every live pane in our tmux session", and `-a` is every pane
  on the server whatever the target. Measured on a socket of its own, with
  `orch` standing and a session `mine` holding one pane in a desk's
  folder: `panes()` listed both sessions, `paneFor` gave `mine:@1.%1` as
  that desk's window, and `open()` answered ok, created false, with no
  window made (QA's reading of the same). So a message to that desk went
  into a pane the floor never opened, a plain shell as readily as Claude
  Code, and a Leave, a move or a reopen would have closed it
  (`closeWindow` kills what `paneFor` finds). It is `-s` now. A Claude
  Code somebody started in a tmux session of their own is then a process
  in no pane of the floor's, which `holderOf` already reads as held
  outside it, as an editor's is. "Keep it, any session counts" was the
  other offer; do not re-propose it. `windowNames()` still asks `-a`, on
  purpose: it is only the names a new window avoids, and avoiding more
  than it must costs nothing.
- **Pane width is set by whoever is attached.** A footer that fits on one line at
  160 columns wraps at 80, which broke `askingOf` and made a real fault look
  intermittent. Read footers as the last few lines rejoined.
- **A step count is a fact about the script, not the window.** Reporting
  `N of M steps` as failure said "your answers did not land" about answers that
  had landed — and, worse, said success about a sequence whose last key pressed
  Cancel. Finish by reading the pane.
- **`-S -N` is not "the last N lines".** It is N lines of scrollback *plus the
  whole visible pane*, so anything that greps a capture is grepping the
  conversation too. `busy()` did, and a window whose transcript said the words
  "esc to interrupt" read as busy for ever. Status is positional: `footOf` reads
  the bottom line, and nothing quoted above it can fake one.

- **tmux answers for another pane when the one named is gone.** Measured
  on 3.7c (2026-11-16, QA's PR #57 Info 10 and its second round). After
  `kill-pane` of `p:@1.%1`, `display-message -p -t 'p:@1.%1' '#{pane_dead}'`
  exits 0 and prints `0`: tmux resolved what it could of the target, the
  session, and answered for that session's current pane. When the pane was
  its session's only one and other sessions remain, it exits 0 and prints
  nothing. When it was the last pane of all, the server is gone: exit 1,
  "no server running on …" ("error connecting to …" for a socket that no
  longer exists). So a read through `-t <target>` proves nothing about
  *that* pane unless the answer carries the pane's own id: ask for
  `#{pane_id}` beside whatever is wanted and compare. `waitReady`'s exit
  check did not, took a killed window for a live one, and held the host's
  line for 45 s. A pane that exited is different: `remain-on-exit` keeps
  it, and `pane_dead` is 1.

- **A line in the composer that nobody typed is a prompt suggestion.**
  Claude Code 2.1.300 draws a suggested next prompt as ghost text after a
  turn ends — dim (SGR `2m`), after the cursor, which stays at column 2
  right behind the `❯`; typed text is in the default colour with the cursor
  at its end. Ten of twenty-one idle windows on this machine held one on
  2026-11-02, and three of them were reported as "typed into the composer
  and never sent" with no record anywhere, because nothing had entered
  them. `composerOf` reads a suggestion as the composer's contents. That is
  harmless for the paste check (it wants the composer to *change*) and the
  stuck check (it looks for the *sent* text), and measured on a probe, a
  paste through `send()` replaces the suggestion: one user record, the
  host's own words, nothing of it. It was **not** harmless for typing
  (2026-11-17, issue #31's first live test): `typeInto` waited for
  "suggestion + first line", typing replaces a suggestion, so the line read
  as lost and the message was pasted after all, reaching the agent in
  `<pasted_content>`. Every message of four lines or more was exposed, and
  every message with attachments is one. Reproduced on a probe on 2.1.326
  (wrapped, 10.1 s, against 3.3 s unwrapped), fixed by accepting the first
  line alone, and re-measured over two real suggestions (typed, unwrapped).
  A draft a person really typed is not replaced, so it still reads as
  draft + line. The fallback to a paste now says so in the host log; it
  used to be silent, which is why this went unseen. Tab or Enter in
  such a window would accept it. Before chasing a phantom keystroke source,
  read the row with `capture-pane -e` and the cursor with `#{cursor_x}`.

- **A composer taller than its box scrolls, and its `❯` row goes out of
  sight.** Measured on 2.1.326, 2026-11-17, in an unattached 80x24 window:
  at most 7 rows show, and the top rule becomes `─── ↑ 3 more ───`.
  `composerOf` found a box by its `❯` row, so it read null there (or, with
  an earlier message's `❯` echoed above, from that line down), and
  `typeInto`, comparing the whole box with the whole text, read the last
  line of a five-line message as lost and pasted it into
  `<pasted_content>`. A message with attachments at 80 columns is that
  tall. `composerOf` now reads a scrolled box by its header
  (`scrolledComposerOf`), and `scrolledOf` says when what it gives is only
  the end: a line is confirmed when the box changed and ends with it, and
  the finished message when the box shows its end. Re-measured on the same
  pane: the same message typed and recorded verbatim, 2 runs of 2.

`answer-the-form.mjs` in that skill answers a floor form and records the pane, so
none of this needs the operator to sit and click.

## A question on the floor

Four rules for an AskUserQuestion, from issue #7 (2026-10-01, measured on
2.1.284), and a fifth from 2026-11-14. Each is the opposite of what the code
did the day before, and each had a reasonable argument behind the old way —
which is why they are here.

- **A form with a question unanswered is never sent.** costmo's ruling. The
  window's own review screen warns "You have not answered all questions" and
  takes Enter anyway, and the floor used to match it on the argument that a
  second door should not be stricter than the first: a blank became a bare
  `Tab`. Measured, that half-sends — the form submits one answer short and the
  host logged it answered. Now Submit shows the first unanswered question and
  sends nothing, the route refuses the same form (`unansweredOf` in
  [`src/floor.js`](src/floor.js)), and `answerSteps` has no keys for one. A
  free-text choice with nothing typed is not an answer: its digit opens a
  field and the script's next key is typed into it. The page has its own copy
  of the rule (`askUnanswered`) so Submit can show the tab without a round
  trip; `test/floor.mjs` runs both over the same cases. Do not re-propose
  matching the window's leniency.
- **Nothing is answered until the form is gone from the pane.**
  `answerQuestion` used to look for the review screen once, straight after the
  last key, and call anything else an answer. Two real things were "anything
  else": a review screen drawn 2.5 s late, and a form standing on a free-text
  field. It now watches for up to `ORCH_ANSWER_GONE_MS` (8 s), confirms the
  review screen whenever it appears, and says `still_asking` with the pane's
  last two lines if the form is still there. The review screen is read from the
  bottom of the pane (`reviewingOf`), not found anywhere in the capture — a
  conversation that quotes "Ready to submit your answers?" above a composer
  would otherwise get three Enters in its message box.
- **A question is never a menu, and its form does not depend on the pane.**
  Claude Code draws on the alternate screen and **cuts the top off a form
  taller than its pane**; a window the host opened is 80x24 until somebody
  attaches. The header row `questionOf` finds a form by is the first thing
  cut, so the host read a 26-row form as a flat menu of five and the floor
  drew Approve / Deny / Cancel over a question. A tall *second* tab did worse:
  the walk returned one question of two as if it were the form. The words were
  never missing — the hook has carried `tool_input.questions` since
  2026-09-11 — so the board builds the form from the call (`formFromInput`),
  uses the pane's reading only when it has every question (`settleForm`), and
  the reader says `form_cut` instead of returning a part. A cut form still
  takes its keys; that was measured, not assumed, and the built form was set
  against the pane's reading on four real forms before anything was pressed
  with it. With no form from either, the panel says it could not read the
  question and offers the window and Cancel (`promptOffer`) — not Approve /
  Deny, and not the blind Yes / No, where Yes presses `1`. Two fixes that look
  available and are not: there is no scrollback to read more of (alternate
  screen), and resizing the operator's window to read it is moving his
  furniture.

- **A typed answer on a single-choice question withdraws the form, and
  every answer follows as one message.** The free-text row on a
  single-select is Claude Code's clarify hatch, not a fourth choice: taking
  it declines the whole tool call, and nothing picked on the other tabs
  reaches the agent. Measured on the live board (2026-11-02, 2.1.300,
  `qa-probe/issue7-probe-c`): the host logged a withdrawal, the agent got
  the tool declined and then "I like Dragon Fruit", and the colour and
  weekday chosen beside it were gone. costmo's ruling: nothing the operator
  chose is dropped — the board queues the withdrawing keys and then one chat
  carrying every answer in words, labelled by tab (`clarifyMessage` in
  [`src/floor.js`](src/floor.js), used by `/api/floor/answer`):
  `Colour: Orange. Fruit: I like Dragon Fruit. Weekday: Friday.` The page
  says so the moment "Type something." is ticked on a single-choice question
  (`askWithdrawText`), because "Submit all answers" otherwise promises a
  form that is not submitted. A multi-select's field is a real field and
  withdraws nothing. The alternatives — saying so on the page and dropping
  the picks, or re-measuring the row on the current window — were
  considered and not chosen; do not re-propose them.

- **A question with previews takes its digit as a move, and the host
  presses Enter once it has read the cursor on that row.** costmo answered
  such a form from the floor twice on 2026-11-14 and both failed ("the pane
  did not change after 1"); the host log holds four more from a designer
  desk, older than its timestamps. Measured on a probe on 2.1.325: a
  single-select where *any* option carries a `preview` is drawn side by
  side, with the choices beside the highlighted one's preview. It has no
  "Type something." row, and its status line reads "Enter to select · ↑/↓
  to navigate · n to add notes". There `2` moved the cursor and the form
  stood, and `Enter` recorded "→ Bravo". A plain question in the same form
  still takes its digit alone, so "digit, then Enter" everywhere is the old
  bug back: the Enter answers the next tab with its first row. Tab, Left,
  Right and Shift+Tab walk a preview tab like any other, and a multi-select
  given previews is an ordinary multi-select. So `answerSteps` is unchanged,
  and the host decides at the key: when the pane it is about to press a
  digit into is a preview question (`previewingOf`, the status line, read
  positionally and rejoined because it wraps at 80 columns), it sends the
  digit, waits to read the cursor on that row, presses Enter, and waits for
  the pane to change (`selectRow`). It is the host's and not the board's
  because the pane says which layout a question got. That holds for a form
  built from the call, on a desk whose plugin is older than the fix, and a
  wrong guess presses nothing. A digit with no row behind it ends as
  `not_on_row` with no Enter sent. That case is real: the form built from
  the call used to add "Type something." as row 4 of such a question. The
  hook now forwards `preview: true` for an option that has one, never the
  text, and `formFromInput` leaves the row out; that half reaches a desk
  with the next plugin update. The floor does not draw the previews
  themselves. That was not asked for and is not backlog by default: a
  preview is a mock-up of any size, and where it would go on the panel is
  costmo's call.

`form.mjs` in **measure-a-real-window** raises a real form on a probe window,
reads it both ways, and answers it through the host's own code. `raise.sh`
beside it raises one and leaves it standing, for pressing keys by hand
before there is a rule to play.

## A message to a desk that is working

**Type into it. Do not wait for the turn to end.** This is the one place the
floor used to differ from every other client, and the difference was the whole
of what made it feel broken: your message was held while the agent worked, and
the page gave up on it long before the window saw it.

The paragraph that used to be here said a paste into a running turn "is not
queued, it is dropped — it was losing two messages in three". **That is false**,
and it is worth knowing what replaced it, because the correction is what the
current design rests on. Measured against a live window on 2.1.220:

| | |
|---|---|
| five messages pasted into one running turn | five arrived, five queued, five recorded **in order**, none dropped |
| a desk doing ordinary multi-step work | enqueue → the agent reads it **0.8s**; → it answers **2.3s**, mid-task, and the original work carries on |

Claude Code writes the receipt down as it happens, which is what lets `send()`
say "delivered" without waiting for "answered":

```
{"type":"queue-operation","operation":"enqueue","content":"<the message>"}
{"type":"attachment","attachment":{"type":"queued_command","prompt":"<the message>"}}
```

Two things follow, and both were bugs before they were rules:

- **A queued message has two possible records, and you get exactly one.**
  Drained at the end of a turn it becomes an ordinary `user` record, *at
  consumption*. Injected mid-turn it is only ever the `attachment` — there is no
  `user` record, ever. `readTranscript` skipped attachments, so once mid-turn
  delivery became the common case the floor showed the agent answering a
  question nobody could see being asked.
- **Delivered and recorded are different moments, and the board says which.**
  `send()` returns `queued`, the host emits a `delivery` event, and the composer
  shows "queued — the desk is working" instead of counting to thirty and saying
  "not recorded — send again" about a message that arrived in under a second.
  The note is retired by the message *becoming a turn* — and by that in either
  order, because the host's two loops do not wait for each other and the relay
  genuinely does publish the turn first sometimes. It did, on the real board.

**A desk whose window is asking something takes no message, and that is
said at once** (#44 follow-up, from costmo's report, 2026-11-05). The
rule above is for a window that is *working*. A window holding a question
form, a permission menu or a startup question sends every key to the
prompt, so a pasted message never reaches the composer. `send()` used to
try 14 times over `PASTE_TIMEOUT_MS` (60 s), then fail. Measured on the
live board: three chats typed while a form was open each held the host's
line for a minute, and the operator's answer to that very form queued
behind the first, aged past `ANSWER_TTL_MS` (30 s) and was dropped as
"long gone" with its question on screen. The desk took nothing until he
answered in the window. Three fixes, each costmo's pick:
- The board refuses the message before it is queued (`askingWhy` in
  src/floor.js, on `/api/floor/chat` and in the desk's `nudge` verdict, so
  the bell, Nudge and a meeting room send nothing). The panel's Send dims,
  with the reason in the box.
- `send()` reads the pane first and returns `asking` in a second, quoting
  it, for a prompt that opened after the message was queued.
- An old answer is dropped only when its question is gone (`askedStill`):
  the board sends the form's headers and first choices with it, and the
  host presses it past the TTL when the screen still shows them. A
  different question in its place matches neither and is not answered.
  The TTL was right for an answer queued while no host was there, and
  wrong when the age was the host's own line. A permission decision goes
  the same way (QA, PR #49 finding 2), and it carries what it was for
  (`asks.subject`, the command or file from the prompt's summary), because
  every permission menu offers the same choices, and the choices alone
  could approve a different command.
A stale `live.pending` would refuse messages wrongly. It is cleared by the
window's next hook, by an answer from the floor, and at session end, and
the panel shows the prompt with Cancel, so the refusal does not outlive the
question for long. `test:host` drives both call sites end to end ("an
answer that waited in the host's line"). Its host runs with the TTL at -1,
so every answer is old, and its stand-in draws a permission menu or a form
from `prompt.flag`, in raw mode, because a tty in canonical mode holds a
bare key until a newline. `askedStill` is tested on captured screens in
`test:window`, and the board half (`asks`) in `test:floor`.

## A slash command, the model, and a compaction

Issues #9, #10 and #15, shipped as 0.10.9 (2026-11-03, measured on 2.1.300
on a probe desk through the host's own `send()`; the table is in the task's
record, the readers are in [`host/window.js`](host/window.js) and every one
was written against a capture). Each rule here replaced something that had
a reasonable argument behind it.

- **A command is confirmed on its own receipt, and each receipt is read
  where it is written** (`commandReceipt`). `deliveryOf` looks for a user
  record containing the text, and a command writes no such record: `/model
  sonnet` is a `<command-name>` record with the argument in its own tag,
  `/clear` writes into a *new* session's file (the issue's "writes nothing"
  counted the old one), `/btw` and `/cost` write nothing anywhere. So:
  `/clear` is the new file's first record; `/compact` is the command record
  and the window compacting; `/model` and `/effort` are the window's own
  stdout line; `/btw` is its overlay; anything else is its command record
  or the screen it opened (`overlayOf`), whose text goes to the desk as a
  line labeled by the command. A command that closes the window (`/exit`)
  has the pane's absence as its receipt. The sentence the desk shows is the
  window's own words where it has any.
- **Enter is pressed again only while the message is still in the composer**
  (`stillInComposer`). The retry used to press on any screen that had gone
  still, and a still screen is also a `/btw` answer and a `/model` picker:
  measured, it chose the picker's highlighted row with nobody choosing, and
  closed the overlay 1.3 s after the answer appeared. No composer on screen
  is "no" too. A `/btw` answer is read off the overlay, left
  `ORCH_BTW_LINGER_MS` for anyone looking at the window, then closed with
  Escape — the host does close it, on purpose, because a dialog left
  standing takes the next message instead of the composer.
- **A model or effort change from the floor is the window's own command,
  and so the default for new sessions** (costmo, 2026-11-14, reversing #10
  Decided 4, so the floor does what the window and the editor do). The
  host types `/model <name>` or `/effort <level>` like any other command
  (`send()`), and the window's line is the receipt and names what the
  board takes as confirmed (`switchedTo`): "Set model to Haiku 5.5 and
  saved as your default for new sessions", "Set effort level to low (saved
  as your default for new sessions): …". The default is the machine's the
  desk's host runs on (`~/.claude/settings.json` `model`,
  `modelSettings.<model>.effortLevel`). For the eleven days before, a
  change was "this session only": the host opened the window's picker,
  walked its rows and pressed `s` (`pick()`, PR #53's short-pane walk
  with it). That is removed, not kept with Enter in place of `s`, and the
  reason was measured on 2.1.325: Enter in the picker saves the cursor's
  row *and* the effort row together ("Set model to Sonnet 5.5 and saved
  as your default for new sessions with medium effort"), so an effort
  change on one desk re-saved that desk's model as the machine's default,
  over whatever another desk had just chosen. The commands save the one
  thing each names, resolve a family themselves ("fable" was Fable 5.2),
  and answer an unknown name in words with nothing saved. Do not bring
  the picker back for either. Four things the command path needed, each
  measured that day:
  - **"Switch model?" still stands between a `/model` and its line** on a
    conversation cached for its model, behind the command as behind the
    picker. The host answers `1`, once (`switchConfirmOf`, read from the
    pane's last lines; it used to match the words anywhere in the capture,
    and a conversation quoting them would have had a `1` typed into its
    composer).
  - **The same dialog has a second title, "Change effort level?", and the
    host answers it for an `/effort` the same way** (QA, PR #55 finding 1).
    It is in 2.1.325's strings with the model's lines under it, raised when
    an effort change would rewrite the cached prefix. It has not been seen
    on a window: `/effort <another level>` after a reply went straight
    through on Fable 5.2, Opus 5.5, Sonnet 5.5 and Haiku 5.5 (probe,
    2026-11-15), because those take effort per turn. So the read is the
    measured one with the binary's title, and a desk on a model that does
    not take effort per turn is where it would stand. Unanswered, on the
    suite's stand-in, the `/effort` ended `not_delivered` and the desk's
    next message was pasted into the dialog for a minute. A change the
    window was told to keep writes "Kept effort level as <level>" (the
    binary again), which names no level set and so clears the asked-for.
  - **A refusal is a `system` record, not a user one.** "Model 'x' not
    found" is written with subtype `local_command` and its text in
    `content`. Read as user records only, the host waited out twenty
    seconds on a window that had answered at once (`stdoutOf`).
  - **Neither is typed into a working window.** `/model haiku` into a
    running turn is taken at once and raises "Switch model?" over the
    work. `/effort` mid-turn was not measured and is held to the same
    rule. Refused before a key is pressed, in words on the desk.
  - **The page's selects are written only where they changed**
    (`fillSelect` in `src/ui/floor.js`). The panel is drawn again on every
    poll and stream event, and both selects were emptied and refilled each
    time: twice in the two seconds after a panel opens, then every 2 s.
    costmo's report was a pick in those first seconds not taking, with the
    drop-down left open. The rewrites were measured (a MutationObserver's
    count; 0 now). That they were the cause is read from how Chrome
    replaces an open select's menu when its rows change, and could not be
    watched, because a headless browser draws no menu. The selects are
    also dimmed, with the reason, whenever Send is: a choice goes out
    through `sendChat`, which sends nothing while the window is asking.
  The chat route still refuses a bare `/model` (a picker nobody is
  driving) and an effort level that is not one of the window's; the page
  shows asked-for beside confirmed until the window confirms —
  PreModelSwitch/PostModelSwitch, the window's line, and the `model` on
  the transcript's next reply, which is how the header follows a `/model`
  typed into the window. **A change that was not made stops being asked
  for** (costmo, the same day; `unask` in `applyHostEvent`). An asked-for
  used to be cleared only by a confirmation, so a change the host refused
  (a working desk) or the window did (an unknown name) left the select on
  the model that was picked, not the one the window was on, with "x asked"
  beside it. The host reports a reply's model only when it differs, so
  nothing on that conversation corrected it. Two things clear it now: a
  host error that names the command it was typing (`command` on the
  event; a host older than that names none, and the asked-for stays as it
  did), and a `/model` or `/effort` receipt that confirms nothing. It is
  cleared where the route wrote it, on the window's session, so an editor
  tab's own pending switch on the same desk is left alone. The error
  carries no session id on purpose: an error is filed by desk, and naming
  one would move where its line is drawn. A `not_delivered` clears it
  too. If the window did take the change, its hook or next reply confirms
  the model as it does for a `/model` typed into the window. **And a
  refused pick is not handed back to the message box** (costmo, the same
  day; `handedBack` in `src/ui/floor.js`). A select's choice is sent as a
  message and waits in the page's pending list, and an error turn hands
  that list back to the box, so the box got `/model opus` ahead of any
  draft, a command the operator never typed. A pick is marked now and
  left out. A `/model` typed into the box still comes back, like any
  typed words. Leaving it in the box so Enter could send it again was
  offered and not chosen. The page step that found it is in
  **verify-ui-change** (`check-chat-controls.mjs`).
- **A paste of four or more lines, or of more than 800 characters, is
  wrapped in `<pasted_content>`** and the model is told it "may contain
  instructions the user did not write" — exactly wrong for the operator's
  own message. Such a message is typed instead (`typeInto`): `send-keys -l`
  in 100-character pieces 60 ms apart (a 900-character burst in one
  send-keys was read as a paste and wrapped anyway), `M-Enter` between
  lines, every line confirmed in the composer before the next (one of two
  runs at 0.3 s a line lost a line); if it cannot be confirmed the message
  is pasted after all. What was pasted by hand is unwrapped on the way to
  the floor (`unwrapPaste`), by id, wherever the pair stands in a block.
- **A compaction is busy, and the hooks own its state.** The bottom line
  keeps "esc to interrupt" throughout, so `busy()` says only that; what
  says more is the spinner line directly above the composer, "Compacting
  conversation… (7s · ↓ 599 tokens)", read positionally (`compactingOf`) —
  elapsed seconds and the summary's tokens, no percentage, because the
  binary's progress never reaches the line. The desk's compacting state
  comes from PreCompact / PostCompact (and the SessionStart a compaction
  fires 30 ms before PostCompact, in case that never comes), the summary
  from the transcript (`isCompactSummary` → a `context` turn labeled
  `compact-summary`, drawn closed), the boundary from `compact_boundary`
  (a `context` line in the compaction's terms, which also ends the state).
  A message sent into one is taken, enqueued with no text (2.1.300 writes
  `queue-operation` records without `content`), and written as a turn only
  at the end — 37–150 s on real desks — so `send()` returns `held:
  'compacting'` the moment the spinner shows under it rather than erroring
  at twenty seconds. A `/compact` receipt says `compacting` only if the
  window is still at it; one that arrived after PostCompact once re-set the
  flag after the fact.
- **A StopFailure fires when auto-compact thrashes, not when it works.**
  Three rounds inside three turns (71k→12k, 69k→12k, 66k→9k, provoked
  with `/autocompact 100k`) ended in `{ error: "invalid_request",
  last_assistant_message: "Autocompact is thrashing: …" }` — 2.1.300's
  fields, which the plugin never forwarded, hence "the turn ended with an
  API error" on nine of the live board's thirty-two error turns. Its twin
  in the transcript is an `assistant` record flagged `isApiErrorMessage`
  with `model: "<synthetic>"`, which the relay now files as an `error` turn
  rather than the agent's words; the hook's turn is for a desk no host
  reads.
- **Only `startup` and `resume` are a session starting** (costmo, #15
  Decided 2; `isSessionStart`). SessionStart also fires with `source:
  compact` at every compaction and `clear` on `/clear`, and every
  SessionStart used to wake an archived floor and ask a rescan.
- **A command's receipt leaves one line, not a bubble.** The receipt note
  first stood as the pending bubble with the sentence as its caption, and
  costmo read it as "an artifact outlined in white saying /model opus … a
  message that has not yet sent". So: a done command draws no bubble, and
  the line labeled `host` carries what was typed and what happened —
  "/model opus — Set model to Opus 5.5 and saved as your default for new
  sessions" (the receipt since 2026-11-14; it read "for this session only"
  while the host drove the picker).
- **A live session outranks an ended one, and a hosted desk's session is
  its window's.** A `/clear` ends one session and starts the next in the
  same second, and on `updated_at` alone the two tied: the floor showed the
  ended row's compacting flag or the new row's empty model, by chance (his
  "works sometimes, not others"). Every "the desk's newest session" read
  orders `(ended_at IS NULL) DESC, updated_at DESC`, `buildFloor` shows the
  roster's `sdk_session_id` row while it is live, and the host names the
  window's session on every receipt — two live sessions on one desk (an
  editor tab beside the floor's window) put the picker's words on the other
  one until QA measured it (PR #32). A `/clear` carries the model and effort
  forward from the row it closed, because the window keeps its process
  (measured: the first reply after `/clear` named the model picked before
  it). And a compaction ends on any prompt, turn or tool, hook or relayed,
  and a floor `/compact` is watched to its end (`awaitCompaction`) and said
  in the window's closing words — a `/compact` with nothing to compact
  shows the spinner for a moment, writes nothing, and left the desk
  "compacting" for six minutes.

How this was built without deploying it: a throwaway server on :8905
running the tree's code, the probe folder rebound to it with `claude mcp
remove`/`add -s local`, a second host process pointed at it (the live host
then skips the folder as another board's), and the tree's `report.mjs`
registered in the probe's own `.claude/settings.json` beside the installed
plugin — so the real window, the real hooks and the new code met end to end
on the operator's machine with the live board untouched. The plugin cache
installs from the tree on `claude plugin update`; until then the installed
plugin's hooks fire for the old eight events only, and a desk's compacting
state and model switch reach the live board only from the transcript.

## A file attached to a message

Issue #31 (2026-11-17, costmo's rulings by AskUserQuestion that day). A file
dropped, pasted or picked in a desk's box, or a meeting room's, stands above
the box as a chip (a thumbnail for an image, larger on hover; its extension
for anything else) with its own ✕, and goes with the next Send. It is three
hops, because a window reads its own machine's disk and the board may be a
container on another one: the page uploads each file **on attach**
(`POST /api/floor/upload`, so the chip can say "ready" before Send), the
message names the staged ids, and the desk's host fetches each one, writes
it under `~/.orchestratinator/uploads/<id>/<name>` and types the path under
the words (`withAttachments` in [`host/uploads.js`](host/uploads.js)). Six
things behind it, each of which looks simpler than it is:

- **Outside every repo, and a window may read it there.** Inside the desk's
  folder an attachment is a change in somebody's working tree (costmo: not
  git-visible). Outside it, measured on 2.1.326 with a probe in **manual**
  mode: a Read of a text file and a PNG under `~/.orchestratinator` raised
  no permission prompt, and a message the host's own `send()` typed with
  two paths (one with a space) was recorded exactly and both were read. On
  a machine whose settings do ask, it is an ordinary prompt on the floor.
- **The path is typed, not pasted as an image.** An image path inside a
  typed or pasted message stays text: the files-only message is two lines,
  so `send()` pastes it rather than types it, and it was still recorded as
  text and read (same probe). The agent reads a file when it wants it,
  which is also what lets a 100 MB log go without filling the context.
- **Lifetime is Claude Code's own** (costmo: "the operator should not have
  to think about it"). The host keeps a file for `cleanupPeriodDays` from
  Claude Code's `settings.json`, 30 when unset, read at every heartbeat's
  sweep, never under a day (Claude Code reads 0 as "keep nothing"). That is
  how long the transcript naming the file lives. A file sent again is kept
  from that send. The board keeps its staged copy an hour from attach or
  last send, and does **not** delete it when a host fetches it: a meeting
  room sends one file to desks on several hosts, and an error turn hands
  the files back to the box to be sent again.
- **100 MB a file, twenty a message** (costmo). Refused on the page before a
  byte is sent, on the declared length before the board reads one, and cut
  off at the cap while streaming. The body is never parsed (server.js skips
  the path, so a `.json` file is not read as a request) and never held
  whole in memory: the board shares Docker's VM (issue #5).
- **A host says it takes files, as it says it takes seats.** `uploads: true`
  at registration, kept on `hosts.uploads`. A host from before ignores
  `files` and would type the words alone, so the board refuses files to it
  in words (`host_no_uploads`) and the paperclip is dimmed with the same
  sentence. The desk's `hosted.host_id` in `/api/floor` is how the page
  finds that row; it was not in the projection, and the page check's first
  row is there because the paperclip read live by fallback without it.
- **The board never serves an upload to a page.** Thumbnails are drawn from
  the File the page holds, so nothing from the operator's clipboard becomes
  a document on this origin. The route's reasoning is beside adminGuard's
  in [`src/web.js`](src/web.js) ("A route that takes bytes"), as the issue
  asked, not a widening of that comment.

What the page does with the result: the host writes the list as `Attached
by the operator:` (`Attached from the floor:` until costmo renamed it the
same day, still read) and one `- <path>` a line, after a blank line, and
`splitAttached` draws a user turn ending in exactly that as its words plus
file chips, the path on hover. Anything else that only looks like a list is
the operator's words, left as typed. The page and the host spell the header
once each and `test:floor` holds them to one. A pending message of files
alone is matched to its turn by the first file's id and name, which only
its own path holds (`attachMatch`): an empty match took the next user turn
of any kind, and the name alone took an earlier message carrying a file of
the same name (the room check sends one screenshot twice for that). The chips are one row,
scrolled sideways: two rows pushed the panel's foot off a 640px window.

Left out, with why: **thumbnails in the history** (the board keeps no bytes
after its hour, and a recorded turn is drawn from the transcript, which
holds a path); **a progress bar** (a local board takes 100 MB in about a
second; the chip's spinner is the receipt); **a slash command with files**
(the window reads the line as a command, so there is nowhere to put them;
refused on the page and the route). `check-attach.mjs` in
**verify-ui-change** is the page; the host's half is "a message with files
attached" in `test:host`.

## Moving a desk to another floor

Issues #24 and #18, 0.10.10 (2026-11-03, task 253; measured on 2.1.300).
A move is a seat change two doors lead to — Take a desk naming a folder
bound elsewhere, and **Move to another floor** on the desk's nameplate card
— and both end in one function, `seatDesk` in [`src/floor.js`](src/floor.js),
so they refuse the same things in the same words. Four rules, each the
opposite of what ran before.

- **A move that closes the floor's window starts a new conversation**
  (costmo, #24 Decided 2). It used to reopen on the one the window had been
  on, and that was refused every time on the live board — 10 of 10,
  2026-10-19 → 11-02: `open()` asks `holderOf` who holds the conversation it
  resumes, and the answer was the window just killed, still in the roster,
  alive and in no pane, so an editor (`outside_tmux`). On a fresh window the
  session file goes 4–14 ms after `kill-window` returns and the pid ~0.5 s
  later, so it is a race; why live windows lose it every time was not found
  (not swap, not background shells, not another claimant). Two fixes that
  look available and are not: waiting for the old pid to leave the roster
  and then resuming (a real second holder must still be refused, and telling
  the floor's own closing window from one by timing is the brittle part —
  and it was ruled), and resuming without asking (two copies of one
  conversation, the thing `holderOf` exists to stop). The old conversation
  stays in its folder; the picker and History reach it.
- **A move whose window is already closed opens on the last conversation**
  (costmo, #24 Decided 3: "Last conversation") — the open path in `bind`,
  unchanged. There is no closing window for it to meet, and a real second
  holder (an editor) is still refused there, naming its pid.
- **A move un-retires the agent's row on the floor it lands on** (#24
  Decided 1, ruled by QA). Every move retires the row it leaves, a retired
  agent has no desk, and only that agent's next MCP connect un-retired it —
  so a move *back* was in no floor's payload until its window connected,
  and for good when the window never came: 5 of the 10 refused live moves,
  the reported one among them. The `bound` handler un-retires beside the
  retire.
- **The card's route takes no path** (`POST /api/floor/desk/move`
  `{channel, agent, to}`). The folder and host are the board's own record of
  the desk (`hosted_desks`), so Take a desk's check — "never a path the board
  has not seen the host name" — is not widened for anything: this route never
  reaches it, and every request that carries a path still goes through it.
  The `bind` work no longer carries `resume`: it said `true` on every move
  and nothing read it.
- **A move the host refuses is said where the agent still is, and the page
  waits to find out** (QA, PR #33 finding 1). The board accepting a move is
  not the move: the host can still refuse it — a window the board took for
  idle is working, an `mcp add` fails. `bind()` used to say that for the
  *target* desk, which has no hosted row until `bound`, so the board dropped
  it (`applyHostEvent`'s ownership check) and no floor said anything — while
  the card's move had already taken the operator to the target. Now a
  refusal before anything is rebound is said on the desk it was moving
  *from* ("not moved to <floor> — …"), and both doors onto a move keep their
  dialog open until `moveOutcome` in `src/ui/app.js` reads the desk seated on
  the target (then the page follows) or that refusal (then the dialog shows
  it, and the page stays). The target's seat, made when the board took the
  move, stays behind undrawn (#20) — a new floor named in a refused move is
  an empty storey until removed, as with any take the host refuses.

- **Take a desk opened from a floor keeps that floor when a folder is
  chosen** (costmo, 2026-11-16, 0.12.8; `takeListing` in `src/ui/app.js`).
  A bound folder used to put its own floor in the form, so an operator
  standing on a floor who chose a folder to bring over got "bring it onto
  the floor it is already on". Now the floor is the operator's: the one
  the dialog opened on, or whatever they have picked in it since, and a
  folder bound elsewhere is a move to it, said by the title, the note and
  the button ("Move to lab") before anything is pressed. Opened from all
  floors, where no floor is being looked at, a bound folder still proposes
  its own. The reading taken of "should not change": a floor the operator
  picked by hand in the dialog also survives the next folder, where an
  unbound folder used to put it back to the floor the dialog opened on.
  Read on a page with a folder bound on another floor: from `lab` the
  form held `lab` and "Move to lab"; from all floors it held the folder's
  floor and "Bring onto the floor". The folder was chosen through
  `browseTo()`, which is what a row's click calls, not through a click.

Two page facts behind the card. **"All floors" with two or more floors is
the building, and a storey there is navigation** — a click on a desk rides
to its floor, so no card is ever open in it; a card opens on one floor, or
on a board with a single floor, where nothing is collapsed and no floor is
chosen. `floorOpenDesk(…, { follow: true })` goes to the target from both,
fetching `/api/floor` first, because a floor named a moment ago is not in
the payload yet and `render()` drops a filter naming a floor it does not
have. And **a desk with a hosted row is exactly as live as its host**
(`live_` in `buildFloor`), so the card's disabled Move — Take a desk's
`no_host` words under it — is only ever seen on a desk no host runs; a desk
whose host is gone is not drawn at all (#20).

How it was measured, for next time: `roster-linger.mjs` in
**measure-a-real-window** times a real window out of the roster after
`kill-window`; holding a window with `SIGSTOP` across a move reproduces the
live refusal word for word but not every time (something other than the
stopped process removes its session file, 6–14 ms after the kill — not
found); the host suite's stand-in has `linger.flag`, which is the
deterministic version. `seed-move.mjs` + `check-card-move.mjs` in
**verify-ui-change** drive the card on both views.

## One agent, several sessions

0.12.9 (costmo, 2026-11-16). One agent can be in several places at once, each
a session of its own: on several floors, and in several meeting rooms on one
floor. His case is the QA agent reviewing three projects' PRs at once, and
auditing with one agent while reviewing with another. It is built on one
measurement and four of his rulings, and each part of it replaced a sentence
that used to be true here.

**"One agent per checkout" was Claude Code's limit, and it is not one.**
[`docs/desk-from-the-floor.md`](docs/desk-from-the-floor.md) said so: local
scope holds one `orchestratinator` entry a directory, so every window in a
folder is that folder's desk. Measured 2026-11-16 on 2.1.325, on a throwaway
board and a tmux socket of its own: a folder bound as `ms-a/qa`, one window
started plain and one with `claude --mcp-config <file>` naming `ms-b/qa`
**under the same server name**. The board counted one MCP session on each
floor and two in all, so the file's entry takes the folder's place in that
window; no approval dialog was drawn. Then, through the tree's host: both
answered `I AM ms-a/qa` and `I AM ms-b/qa` to the same question, a third
answered `I AM ms-a/qa-2`, and one closed and reopened with `--resume <id>
--mcp-config <file>` answered with the word it had been told to remember
before it closed. [`host/seats.js`](host/seats.js) is the record.

The host calls such a desk a **seat**. Five things about it, each of which
looks like it could be simpler:

- **A seat is told from the folder's own desk by a tag on its tmux window**
  (`@orch_seat`), never by directory. "The directory is the identity, and the
  only one" (`paneIn`) is still true of the folder's own window, which is the
  one with **no** tag; so a host with no seats finds every window exactly as
  it did. Every function in `host/window.js` takes the folder, or
  `{ cwd, seat }` ("which window" there), and a desk's roster sessions are
  shared out the same way (`sessionsAt`): a seat's are the ones in its tagged
  window, the folder's own desk has the rest, an editor's included.
- **The tag is set in the tmux command that makes the window.** Set a moment
  later, a watch tick between the two read the new window as the folder's
  own. Measured on tmux 3.7c: `set-option -w` with no target after a
  detached `new-window` tags the *current* window, not the new one, and a
  window named with a dot in it cannot be named in a target (`p:=qa-desk.x`
  is "no such window": the dot is where the pane begins). So a seat's window
  name has no dot, and the tag is `; set-option -w -t <session>:=<name>`.
- **A seat's window is the first window of all, sometimes, and then what it
  was given must not stay in the session.** `new-session -e` writes the
  session's environment (the PR #52 lesson). A seat is given four variables,
  and left there the folder's own window, opened next, would inherit
  `ORCH_CHANNEL` and report every hook as the seat. All four are unset after
  the session is made. `test:seats` opens a seat first for exactly this.
- **The hook is told which desk its window is.** It finds a desk by folder,
  and in a seat's window the folder names another desk, so a permission
  prompt raised there would be drawn on, and answered into, the wrong
  window. The window carries `ORCH_DESK_CONFIG` (its binding file, read like
  a `.mcp.json`), `ORCH_DESK_ROOT`, and `ORCH_CHANNEL` / `ORCH_AGENT`. The
  last two are what the hook has let stand in for the folder's names since
  its first commit (2026-08-27; every copy in this machine's plugin cache,
  0.10.12 on, has it), which is why a seat reported correctly on real windows
  with the plugin that was installed before this was written. The file is
  what keeps it reporting when the folder's own desk has left.
- **A seat never resumes "the folder's newest conversation".** That is
  `resumable()`'s fallback for a pin with no transcript, and in a shared
  folder the newest is most likely the one another desk's window is running:
  two processes on one transcript. A seat starts a new one and says so on
  its desk; the folder's own desk skips conversations its seats are running;
  and a conversation live in another desk's window is refused
  (`held_by_other_desk`) and never typed into.

What the board adds, and costmo's four rulings (each an AskUserQuestion,
2026-11-16; do not re-propose the alternatives):

- **A second session on a floor the agent is already on is named with a
  number: `qa-2`, `qa-3`.** The board files turns, mail, tasks and a room's
  members by floor and agent, so it needs a name of its own there; on
  another floor it keeps the agent's name. `desk_twins` is the link, and the
  link is that row, never the spelling. It carries the agent's name and face
  (copied to its own profile row and kept the same by `setProfile`, not
  looked up through the link, because a profile is read by agent in a dozen
  places) and the nameplate adds the number: "Quinn · 2". `agent.2` was the
  other offer.
- **A plain name means the session in the sender's room.** `addressed` in
  [`src/tools.js`](src/tools.js): a message or task to `qa` from somebody in
  a live meeting room with `qa-2` goes to `qa-2`; otherwise to the first
  desk; `qa-2` written out goes exactly there. "Always the first desk" and
  "every session" were the other offers.
- **A session made for a meeting room closes when it is in none**
  (`sweepTwins`): End meeting, a Remove, Bring back, or the room's window
  gone without a word. Closed is the desk's own Leave, never mid-turn (it
  waits for the turn), and the desk leaves the floor whole: seat, row, link,
  and its conversations ended. The conversation stays in the folder, and
  Resume makes the session again on it (`meetingResumePlan`'s `twin` step).
  Keeping it as a desk was the other offer. Four timings, each for a
  reason: 30 s after it is made (its room is recorded a moment later, by the
  room's window), 15 s after a room ends by its window going away (a reload
  ends a room and opens it again; End meeting says `final` and is not
  waited for), two minutes for one its host never seated, and 90 s of
  watching an open room the sweep has found silent (below). The sweep runs
  from the routes a page polls, not on a timer of the board's own.
- **A window that slept is not gone** (QA, PR #57 finding 1;
  `stillWatched`, `TWIN_UNHEARD_MS`). "Gone without a word" was "not live
  after `MEETING_LIVE_SECONDS`", read at one look. A room that is open and
  150 s unheard is also every window stopped together, a laptop asleep, and
  then the page poll that runs the sweep reaches the board before the
  room's touch does. QA measured it: a browser stopped 165 s lost the
  session in 2 of 2 runs, in a meeting nobody had ended, and the room's
  window then saved itself without it. Now the silence counts from the
  look that first finds it. The watch is kept by the room's last touch
  (`live.unheard`: room id, when, and the `live_at` it was silent since),
  so a room heard from and silent again later is watched afresh with no
  look needed in between. 90 s, because a window that is there touches
  within 30 s, or within Chrome's one wake-up a minute when it is hidden.
  A crashed window's session closes that much later than it did. The
  number is the developer's, open to costmo's reversal; how long a room
  contains its broadcasts (150 s) is unchanged. A real sleep, where the
  board's clock stops too, is still not measured: if the clock has caught
  up by the first request the room reads silent and is watched, and if it
  has not the room still reads live. Do not go back to closing at the
  first silent look.
- **A second session's mail starts where it is made** (QA, PR #57 finding
  2; `desk_twins.start_cursor`). Its `agents` row is made when its window
  connects, and was made at cursor 0, so every broadcast the floor had
  ever carried read as unread for it (7 of 7 measured, 222 on this floor
  that day), the room's Nudge counted them, and its first poll with no
  `since` was handed the oldest hundred. A second session is not a new
  agent: what was sent before it was made is in its first desk's mail,
  read or waiting. So a name never on the board starts at the floor's
  newest message, and a name taken again starts where it stopped, so a
  message addressed to it while it was away is not lost. A row at 0 (one
  that never read, or a session made before this) starts at the newest
  too. The link holds the number, the row `touchAgent` makes takes it,
  `createTwin` brings an existing row up to it, and `poll_messages` floors
  `since` at it for a second session. Two readings that were not taken:
  the first desk's own cursor (both sessions would then read, and maybe
  act on, the same unread broadcasts), and the stored cursor as the
  default `since` for every agent (a change to the tool for everybody, at
  a release check). Left as it was, on purpose: New desk here on
  *another* floor is the agent's first desk there and starts at that
  floor's first message, as any agent arriving on a floor always has.
- **A bind does not take a name from a working seat** (QA, PR #57 finding
  3). A folder bound to names one of its seats already carries on that
  floor closes that seat's window (`bind()`: two desks cannot answer to
  one name, and the folder's own entry is what its windows connect with).
  Leave on that seat was refused mid-turn and the bind was not. Both doors
  onto a bind refuse it now in one sentence (`seatWorkingWords`, in
  `seatDesk`), and the host refuses from the pane, quoting it, for a
  window that started working after the board looked. The host says it on
  the desk the move is from, or on the seat itself for a take: both have a
  row.
- **Leave room asks first**, with the panel's own Leave desk dialog.

And two of his from the same day, on the nameplate card: **Leave room**
under Hide desk, and **nothing from Open conversation down can be pressed
while the desk is in a meeting room** (`cardRefusal`), with the one reason
under the buttons. One reason, not one a button: Hide desk had its own
there since PR #56 ("In a meeting: it stands in the meeting's box…"), and
two paragraphs beginning "In a meeting" under four dimmed buttons said one
thing twice, so it is folded in, with what becomes of a desk hidden before
it joined. check-meeting-box's three rows on that sentence read the one
reason now (they went red on the first cut, which is how it was noticed). A click on the desk itself still opens its panel, which
is where Bring back from the meeting room is, so the lock strands nobody.
**Bring back takes the agent out of every room**, on every floor
(`agentDesks`): an agent's desks are the ones of its name out of its folder
on its host. The name alone is not the agent, because `developer` on two
floors is two repos. The folder there is its last segment, since the
payload carries no path: two folders of one name on one host, each with an
agent of the same name, are one agent to it, and Bring back on either
takes both out of their rooms (QA, PR #57 Info 9, read, no fixture built).
Known and left: the fix is the path on the payload, which no finding has
asked for.

Two things found only by running it, and both are why the last tier is not
optional:

- **A closing window's last hooks re-seated the desk the board had just
  removed.** Every hook event upserts its session (which clears `ended_at`)
  and seats its desk. The plugin's SessionEnd arrives around the host's
  `unbound`, in no order, and one that landed after put the desk back: a
  seat with no host, its name taken for good. Seen on real windows: a
  session asked back as `qa-2` came back as `qa-3`. The suites' stand-in
  has no plugin and could not see it. A seat that was just left ignores its
  window's hooks for a minute (`live.left`), and is heard from at once if
  it is seated again.
- **A closed session's conversation read as a live window for an hour.**
  The next session made under the same name was drawn the moment the board
  named it, before any host had seated it (the browser check drew a desk
  for a session its host had refused). `unbound` for a seat ends its
  conversations.

**How a new thing was asked of the host, for the next one.** Three parts,
each of which has a failure behind it elsewhere in this file. A **work
kind of its own** (`seat`), never a flag on an existing one: a host from
before it ignores a kind it does not know ("work for a desk this host
doesn't have"), where `bind` with `seat: true` would have been carried out
as a move by every older host. A **word at registration** (`seats: true`),
kept by the board on the host's row (`hosts.seats`) and on the payload
(`hosts[].seats`), so the page can dim the control with the reason and the
route refuses in the same words (`noSeatsWords`), as `capabilities:
["finish"]` does for an update. **On its row, not in the server's
memory** (QA, PR #57 finding 5): it was a Map, a host registers once a
minute, and the board calls a host live from its row for 90 s, so for up
to a minute after every restart the board told the operator that a
current host "runs a build from before… Update it", just after a deploy.
What a host last said is kept where "when it was last seen" is. Anything
else the board decides from a registration and reads while the host is
still "live" has the same gap; the folder list and the update report are
the two that remain in memory, and both say "not reported yet" rather
than a refusal. And **the refusal said on a desk that has
a row**: a desk being made has none until `bound`, and an error for it is
dropped, so `sit()` says it on the desk it was made beside, as a refused
move is said where the agent still is.

Left out on purpose, with why:

- **A seat is not moved by the card** (`seat_no_move`). A move rebinds a
  folder, and a seat is not its folder's desk; done as leave-and-seat it
  would arrive under another name on a floor where the agent's name is
  free, and the page follows a move by name. The card says what to use: New
  desk here on the floor wanted, Leave room on this one. Open to costmo's
  reversal; it is two existing controls, not a missing capability.
- **A seat's conversation is not handed to an editor** (`seat_no_editor`;
  the panel does not draw the link). An editor opened in the folder loads
  the folder's binding, so the conversation would carry on as another desk.
  Nothing can give a VS Code chat a binding of its own. Open in tmux and
  Open in Claude reach it.
- **A desk in its own popout is still one place at a time.** Only a desk
  that is in a meeting room gets a second session for another room, which
  is what he asked for. And a room's **Add** offers what it did.

How it is tested: the decisions in `test:floor` ("one agent, several
sessions"), the host's half in **`test:seats`**, the hook in `test:plugin`,
a move to a fresh tmux server in `test:renew`, and the page in
**check-sessions.mjs** (**verify-ui-change**). The mutant lists are kept:
`mutants-sessions.suite.json` (**mutate-in-a-copy**) and
`mutants-sessions.page.json`. What only a real Claude Code can say is in
**measure-a-real-window** ("Two windows in one folder").

## History is read off the hosts, not the board

**`turns` is a live tail, not an archive**: the newest 400 rows a desk
(`TURN_RETENTION`), and a conversation picked from the list is joined
mid-stream. Measured on this board when it first had a real history
(2026-10-01): any row at all for 41% of the conversations on disk, about a
quarter of the turns, no titles in `agent_sessions`, and 180 session rows
for transcripts on no disk here. Anything that claims to cover *the
history* built on those tables covers part of it without saying which part.

So three things read the transcripts on the host instead, each answered as
events and held only in the server's memory — the recent list across desks,
the search, and a conversation opened to read whole
([`host/history.js`](host/history.js), `Host.readWhole`; the routes and the
reasoning are in [`docs/internals.md`](docs/internals.md)). Two rules come
with that, and both were rulings rather than accidents:

- **An answer names the hosts it is from.** A host that is offline is in the
  answer as offline and the page says its conversations are not covered. Do
  not "fix" an empty result by falling back to `turns`.
- **Reading is not resuming.** Opening a conversation to read closes, opens
  and moves nothing, so none of a reopen's refusals apply to it — an
  editor-held, current or mid-turn conversation can be read. It is drawn in
  its desk's panel as a *different shell*: a banner, a way back, and no
  message box or actions at all. Absent, not disabled.

Before measuring anything against these stores again, read the
**measure-live-data** skill: the first three numbers it produced were wrong
(a folder counted three times; a figure measured on one store and quoted
for the other; a byte scan mistaken for a search).

## The two surfaces

One page draws two views. `index.html` loads `app.js` then `floor.js`, and
`body.view-floor` toggles between them:

| | Payload | Script |
|---|---|---|
| **board** — rows per agent | `/api/state` | [`src/ui/app.js`](src/ui/app.js) |
| **floor** — an SVG room per channel, a desk per agent | `/api/floor` | [`src/ui/floor.js`](src/ui/floor.js) |

**Anything both surfaces show is derived once, in
[`src/agent-state.js`](src/agent-state.js).** Presence, the state label, the pill
counts. Two views deriving "is this agent working" from the same columns by
different code is precisely the drift to avoid — a desk and its board row must
not disagree. The same rule put `deliverable()` in `src/floor.js`: one answer to
"can this desk be typed into", used by the compose box and the Nudge button
alike.

**Archive is the one way to put a floor away, and both views read one
channel list.** Two rulings from issue #21 and #6 (costmo, 2026-11-02), and
each replaced something that had a reasonable argument behind it. There used
to be a browser-local "minimize" beside archive — a fold kept in
`localStorage`, undone from the board only, drawn in the floor picker's tail
next to archived floors. The argument for it was real (tidying your own
screen should not be an audited statement about the team's work), and the
failure was measured: with `channel_flags` at 0 rows, every floor an operator
reported as "still archived" was a minimized one. So: one mechanism, the
server's flag; a put-away floor is drawn in exactly one place on each view,
the pill list at the bottom (`pillBar` in `src/ui/app.js`, which the floor
calls through `window`), and the pill restores. Do not re-propose a quick
fold. And the floor's storeys were the keys of `personas` while the board's
rows were `agents ∪ messages ∪ tasks ∪ contracts`, so a channel whose only
trace was a hook-made desk was a floor with no board row to archive it from
— two of them on the live board. `listAllChannels` now includes `personas`
and `buildFloor` iterates that one list; a floor with no desks and a board
row with no agents are both the truth about such a channel, and the row's
delete sticks because `purgeChannel` sweeps `personas`. One more ruling
rides on the flag (Decided 6): **an archived floor comes back when
something starts on it**, and only then — `wakeChannel` in `src/db.js`,
called at four doors (a hook `SessionStart`, a host's `bound` and `session`
events, the Take a desk route, an MCP connect) and nowhere else, with an
audit row naming the door. The boundary is deliberate and tested: an agent
already on the floor writing does not restore it, because archive is not a
session kill and must not be undone by the work it does not kill. One
consequence looks like a bug and is not: a server rebuild drops every MCP
session, every live agent reconnects, and each reconnect is a start — so a
deploy restores every archived floor that has a working agent on it. QA
measured it on PR #29 and put it to costmo; ruled keep as built
(2026-11-03): a reconnect is a session opening, and archive is a statement
about floors nobody is working on. Do not special-case the reconnect.

**An empty desk is not drawn, and a desk put away by hand is the same flag
one level down.** Issue #20 (costmo, 2026-11-03, 0.10.8). The floor used
to draw a desk for every agent the board knows, and the comment in
`buildFloor` defending that — a room that lies about who works there, the
reminder of who still needs the plugin — is still true of the *payload*
and false of the *drawing*: measured on the live board, 15 of 35 drawn
desks had nothing live behind them (9 `host offline`, 5 `not reporting`,
1 the name alone). So the page leaves out any desk with `!live &&
!hosted?.live` — exactly those three nameplate readings, and nothing else
(`deskEmpty` in `src/ui/floor.js`, lifted into `test/floor.mjs`) — and it
is back the moment either turns true, with nothing clicked and nothing
written; an empty desk is not a pill. The deliberate hide is **Hide desk**
under Open conversation on the nameplate card: `desk_flags` in `src/db.js`,
the `desk/hide` and `desk/show` routes beside `channel/archive` in
`src/web.js`, an audit row each, `hidden` on the desk in `/api/floor`, and
a pill carrying the agent id (and its unread count) in a row under the
storey's last desk, inside the storey's SVG, which restores. Four rulings
ride on it, each tested: the payload keeps every desk and every count — a
hidden desk still counts in `N/M here`, the totals and the operator queue,
because hiding is not muting; nothing the agent does clears the flag —
not coming back, not any of `wakeChannel`'s doors, which touch
`channel_flags` only — so the pill restores it, and one other thing does,
found by QA on PR #30: a move. The flag is on the seat, `unseat` takes
the flag with the seat, and the handler logs a `desk.show` row on the
floor the desk left. Cleared rather than carried because the only way to
move a hidden desk is to take it from another floor's dialog, so the desk
on the new floor is one the operator just asked to see; left behind, the
row was found again by a move back, which arrived hidden with no row
saying why; archive wins, so a hidden desk on a put-away floor
is neither a desk nor a pill until the floor is back; and hide is not
retire. Two things that look like gaps and are not: a browser-local hide
was the minimize removed in #21 and is not to return under this name, and
the board view is untouched because the issue is the floor's drawing — the
board's row for a hidden agent is still the truth about the agent. The
card's own clicks are handled in a branch of their own that swallows
anything it does not name (`#desk-pop` in the click handler), so a new
button on the card goes there and not in the generic `[data-act]` chain —
the first cut put it in the chain and the button did nothing, which the
page check caught and the suite could not.

**Bulk selection is the one-desk controls, sent in a line** (issue #23,
0.10.16). **select desks** on a room's header checks desks and sends each
one what its own control sends: the bell's chat, the backlog dialog's
advance, the card's hide. That means one request and, for mark read and
hide, one audit row per desk. A nudge writes no row, from the bell or in
bulk; its record is the turn. Everything the page decides is in one lifted
section of `src/ui/floor.js` ("bulk selection: what the page decides"),
which `test/floor.mjs` runs over server-built desks. Three things behind it
were measured, and each looks like it could be done more simply:
- **The order is the host's line, not a preference.** The host types
  work one item at a time, and each delivery costs about 3 s even into an
  idle window (`settled()`, three quiet reads at `SUBMIT_SETTLE_MS`, then
  the receipt). A desk with no window holds every desk behind it for about
  1.5 s while it comes up, and for `READY_TIMEOUT_MS` (45 s) when it does
  not. Measured on a stand-in rig (task 267 step 1, #2874): behind a stuck
  window the three desks landed at 48, 52 and 55 s; sent first, at 3, 7 and
  10 s. So `nudgePlan` sends windowed desks first and windowless ones last.
  QA ruled the ordering a page-side how. A parallel or per-desk host queue
  was not built here; it would be a host change.
- **A bulk nudge's pending bubble waits on facts, not the click.** Its
  30 s silence clock (`SENDING_GRACE_MS`) said "not recorded — send again"
  about nudges still in line, in both cases QA named (two windowless desks
  where the first never comes up; ten windowed ones). `bulkWait` holds the
  clock while a desk of the same bulk is ahead on its host, and while its
  own window is still being opened, and starts it once both are clear. What
  happened to each desk is read off its turns (`nudgeOutcome`: the word as
  a user turn, or an error turn first) and the desk's `delivery` note,
  never off a timer. An error turn carries no tag naming its message, so an
  unrelated one reads as the nudge failing. That is the panel's own
  `settle()` rule, and the less harmful of the two wrong readings.
- **"Selecting with nothing checked" and "not selecting" are different
  signatures.** The rooms are redrawn only when their signature changes,
  and the first cut wrote both as `[]` beside a kept result. So after an
  action, "done selecting" and selecting again drew only when a later poll
  happened to change the payload, and on a still floor that was not within
  8 s. Unit tests could not see it; `check-select.mjs` in
  **verify-ui-change** did, intermittently at first. Not selecting is
  `null`.

The operator's calls on what the issue left open (Not established): a
click anywhere on a desk in a selecting room checks it and does nothing
else. Mark read shows its count on the control before it runs.

**Selection closes itself once an action is sent** (costmo, 2026-11-14,
0.12.x; `doneActing`). It used to stay on with the checks kept, so that
actions could chain and because the results were drawn on the checkboxes
and the toolbar. That was the developer's call, and he reversed it: a mode
still on after its action read as unfinished. All four actions close it:
Nudge, Mark read and Hide when their requests have answered, Meeting room
when its window opened. A nudge is closed on *sent*, not on *typed*, so
desks are still in line after it (130 ms to close, 41 s to the last
verdict in check-select.mjs), and the pending bubble's rule is unchanged.
With the mode gone, nothing drawn on it can report, so costmo chose where
a desk that was not reached is said: **one line on the room, under its
header, and only then** (`missedNote`, `missBar`). It is the action's
summary with the missed desks named and each reason on hover. A run that
reached every desk leaves nothing. A desk the Nudge control already said
it could not reach is on the line too. The line goes on a click, and when
selection is started or ended by hand (`settleBulk`), which keeps only a
nudge still in line. One that fails after that is new, and the line comes
back for it. Two alternatives were offered and not chosen: saying it on
each desk the way its own control does (the bell's 2.5 s red), and staying
open only on a failure. Do not re-propose either, or the mode staying on.
One exception is deliberate: a Meeting room window the browser blocked
leaves the room selecting with its checks, because nothing was done and
the remedy is the same click again. A second Nudge while one is in line is
still refused, now when the room is selected again.

Two more rulings went into the same diff:
- **A floor unread pill opens its dialog every time** (Decided 5). The
  backlog dialog reads `app.js`'s `/api/state` copy, which is polled every
  2.5 s, apart from the floor's 2 s `/api/floor`. A pill drawn between the
  two opened nothing, and that was already so at 39d5e4b. Now the floor
  passes the newest message id it drew, and `backlogBehind` reads the copy
  as behind when it has no backlog or an older one. `freshState` then waits
  out any poll already in flight and asks again. That poll may have been
  asked before the pill's message existed, and `tick()` returns at once
  while one is in flight, so calling it then reads nothing new. The board's
  poll never redraws an open dialog: `refreshDialog` runs only after an
  action inside one. An earlier note here said a late answer would close
  the dialog through it, and that was a misreading; QA's PR #38 Info 5 and
  a page mutant showed it.
- **A host error that sends the operator to the window names Open in
  tmux** (Decided 6). The two errors used to hand them `tmux attach -t …`
  to type, which is a remedy given as a command. Now they name the control
  through `OPEN_IN_TMUX` in `host/window.js`, and `test:window` holds that
  to the page's `LINK_LABEL.attach`.

**A desk's chat can be detached into a popup of its own, and every window
shares one stream** (issue #19, 0.10.18). The popout is this page with
`?popout=1&channel=&agent=`. It loads both scripts and draws only the panel,
with the desk drawn into it by the floor's own `desk()`, so every control in
it is the floor's code and every dialog is app.js's, opened in the window it
was clicked in. Rebuilding the panel as a separate page would be the second
implementation the pills' comment warns about. Five things behind it each
look like they could be done more simply:
- **No window opens a stream of its own.** A browser holds six
  connections to one host over HTTP/1.1, shared by all its windows, and the
  issue measured every fetch hanging once six streams were open. So
  `src/ui/hub.js` is a SharedWorker. Each window tells it which desk it
  shows, the worker holds one `/api/floor/stream?desks=[…]` for all of them,
  and every event names its desk. Measured on a mutant with the hub removed,
  so each window opened its own stream (`check-popout.mjs`): with the floor
  and popouts opening one by one, the check died waiting 10 s for a popout
  to draw its chat. With the hub, a fetch from the floor and six popouts
  answered in 2–13 ms, and every window's stream delivered. A worker outlives a
  deploy while any window is open, so a change to its messages bumps
  `HUB_P`. A browser with no SharedWorker, or one whose worker fails to
  start, gets the old one stream per window.
- **Which desks are out lives in the popouts, not in storage, and no timer
  keeps it.** Each popout holds a Web Lock named for its desk for as long
  as it is open, then says `here` on a BroadcastChannel (and again when a
  floor asks `who`), and says `gone` on pagehide. The floor keeps what it
  hears (`ui.outs`) and asks for the same lock, which the browser grants it
  only when the popout's window is gone, crashed included. It used to be a
  2 s beat with a 7 s expiry. QA measured that failing (PR #41 finding 1):
  Chrome gives a minimized window one timer wake-up a minute, so the floor
  drew a desk's composer beside its popout's in 9 samples of 25. The hub
  is the same rule one level down: each window holds a lock and says
  `hello` with its name, and the worker drops the window when it is granted
  it, not after 30 s of quiet. Web Locks need a secure context (localhost
  is one), and without them it is the beat and the silence, as before. A
  stored list would go stale against the windows it describes. A reloaded
  floor knows within milliseconds, and popouts cannot be reopened after a
  reload anyway, because the browser blocks `window.open` without a click.
  So they survive the reload instead.
- **A closed window is held out for 1.5 s before the floor takes the chat
  back** (`REJOIN_MS`). A popout being reloaded says `gone` and then `here`,
  and without the hold the floor's panel would open the chat and put it
  away again. Re-attach and Bring chat back here are not held: those are
  the operator asking for it now. And a closed window takes the panel only
  when the panel is shut or already on that desk (costmo, task 273). On
  another desk it is left alone, text and focus with it, because closing a
  window is not asking for that chat. QA measured the first cut taking the
  panel from a half-typed message and leaving focus on BODY.
- **"Left" is said after 4 s, not at once** (`FATE_GRACE_MS`). Read in
  `bind()` in `host/index.js`: a move re-registers the host without the old
  binding just before it reports the new one, so for a moment the desk
  reads as left. A move is recognised by the same agent bound to the same
  folder on the same host on another floor (`deskFate`). The payload carries
  no cwd, so it is the host's name and the folder's basename.
- **A popout polls less than a floor.** It skips `/api/activity` (envelopes
  need rooms), and app.js polls only `/api/state` there, for its dialogs.
  So a popout costs one `/api/floor`, one `/api/state` and its turns per
  period. The issue measured the live `/api/floor` at 250 KB in 20 ms. That
  is per window, and sharing it through the worker was not done; it is the
  next step if many popouts ever show up in the board's slow-request lines.

One change rode along: a scroll inside the chat panel no longer closes the
nameplate card. The card closed on any scroll, captured from every element,
so the transcript's own follow-the-newest-turn closed a card in the popout
the moment a turn arrived (red in the check once in five runs). The
transcript moves no desk, on the floor or in a popout.

The desk in a popout is drawn at the floor's own size (costmo, after a
first cut drew it smaller). The floor tab writes how many pixels it draws
per unit to `localStorage['orch.deskScale']`, and each popout sizes its
desk from that, again on the `storage` event, so a floor dragged wider
grows every popout's desk with it. With no floor to read, the floor's
widest is used. A popout wide enough to keep `POP_CHAT_MIN` (420 px) of chat
beside the desk puts the desk in a column of its own (`pop-wide`).
In that column the panel's foot stands under the desk (issue #43): the four controls, then the seat links, and the composer
beside it is the box and the Send row alone. `popLayout` moves the
`.p-foot` element there and back, so it stays one element. The other
ways to do this break things that already work. A second copy of the
foot gives every reader of the panel two of each control. CSS cannot
take the foot out of `.p-compose` without `display: contents`, and a
`display: contents` composer has no box, so `boxRoom`, which measures
from the panel's last child, reads a room of nothing. `drawPopDesk`
replaces only the desk's SVG, never the slot's children, because the
foot lives in the slot. The floor's own panel and a narrow popout are
untouched. `check-pop-foot.mjs` in **verify-ui-change** is the page.

Where #13's chat box meets a popout: `boxRoom` measures against the
panel's `max-height`, and a popout's panel has none, because it is the
window's height. So in a popout the room is the panel's own height, and
the transcript keeps its popout `min-height` (140px) instead of 60. Before
that, 18 lines or a drag took the box to 1,123px and the send row out of
the window at every size (`check-popout.mjs`, red at 440x980, 1100x760 and
440x700). In a window too short for the desk at the floor's size, the desk
gives way down to half (`popDeskScale`), never the send row.

Over the chat (a narrow popout), the desk gives way to the box too
(costmo, #43 follow-up, "Transcript, then desk"). The 140px transcript
and a desk sized for a box at its starting height left a popout under
~800px tall no room for the box. It sat at 55px, neither growing nor
taking a drag, and that was so before #43. Now the narrow transcript
keeps 60px, the floor's `BOX_TURNS_KEEP`. The box's room is its free
room plus `ui.popSlack`, which is how much shorter the desk can still
be drawn. popLayout leaves room for the box at `ui.boxDrawn`, so the box
grows into the transcript first and then into the desk, down to
`POP_DESK_MIN`. A drag moves the desk as it goes, on `pointermove`.
fitBox hands back to popLayout when the box's height *or its free room*
changes. The box's height alone was not enough: after a reload the
meta line filled in after the desk was sized, and the send row stood 6px
off the panel (`check-pop-foot.mjs`, red on that mutant). popLayout
depends only on the parts that are not the desk, so its call back into
fitBox finds both as it left them, and the two settle (the check counts
redraws over 2 s of quiet). Nothing stops the operator from making it
cramped. A long message or a deliberate drag can take the transcript to
60px and the desk to half its size. costmo's ruling on that (2026-11-05):
"trusting that our users are adults … we've struck a decent balance".
The bounds that do hold are the send row and the controls, which always
stay on the panel, and an emptied box, which gives the room back. Do not
add a cap on the drag, or a floor under the transcript, in the name of
protecting the operator from their own choice.

**A panel's turns are fetched under a session, and an answer is used only
under the session it was requested for** (issue #46, 0.10.22). A popout opens
its desk before its first `/api/floor`, so `sessionFilter()` had nothing to
scope by, and the first turns request went out unscoped. On a desk whose
new session had no turns yet, the answer was entirely the session before
it. When it landed after the first poll had reset the panel to the new
session, it stayed, because nothing clears a list whose filter does not
change again. That is why it showed only on a new session. So `loadTurns`
asks nothing until `/api/floor` has answered once, and drops an answer whose
filter is no longer the panel's. QA found either guard enough on its own
to turn the check green. Both stay, for reasons that come from reading the
code, not from a measurement. Without the first, an unscoped answer that
beats the first poll draws the old session for a moment before the reset
wipes it, and the check does not look in that window. Without the second,
the floor's own panel is exposed to the same late answer whenever a
session changes under it mid-request.
A new caller of `/api/floor/turns`, or anything else scoped by
`sessionFilter()`, needs the same check after its `await`. The race read
red in 1 of 8 runs to 2 of 3, and never on the first run, so
`run-check-popout-session.sh` in **verify-ui-change** runs it 12 times.

What a popout is not: a third seat (the conversation's process is
unchanged; only the page holding its composer moves), and part of a
room's selection (#23: selection is the floor's, and the popout's desk is
in no room). `check-popout.mjs` in **verify-ui-change** drives all of it,
including a floor reload and close. A popup opens only on real input
(`press()`), never on a dispatched click.

**A meeting room is a popout of several desks, out the popout's way**
(issue #44, 0.12.0). It is this page with `?meeting=<id>`, opened from a
room's selection toolbar or from Resume. Its code names are `meeting…`,
never `room…`, because `room(c)` is a channel's drawing (Decided 1). Seven
things behind it each look like they could be done more simply:
- **Presence is the popout's, under the same lock names.** The window takes
  `popLockName` for each participant with `ifAvailable` and says `here`
  with `meeting` on `orch.popouts`. So the floor's panel, the detach
  button, a floor nudge and the hub all step aside for it with no new
  machinery, and Decided 3's "one place at a time" is the lock: a desk
  whose popout or another room holds it is not taken, and the room says
  so. The floor's `here` handler used to drop every other key a window id
  held (a popout following a move). A meeting's `here` skips that, or each
  participant's `here` would undo the last one's.
- **No route types for a room.** A message is one `/api/floor/chat` per
  recipient, in `nudgePlan`'s order (windowed desks first), with every
  check that route makes. Each desk's delivery is read off that desk's
  turns and note (`meetingEntry`). The room's own send is only the
  addressing, never the record (CLAUDE.md's "a delivery is what the window
  recorded"). A user turn the room did not send, or whose send a reload
  lost, is folded by the same words within two minutes
  (`MEET_GROUP_MS`). Two identical messages typed into two windows inside
  that time read as one; that is the limit, and it was chosen over N
  copies of every message.
- **The prompt box is the panel's, lifted, not copied.** `drawAlert`
  draws a desk's box into any slot, and the handlers read the desk off
  the box (`targetOf`: `data-for-agent`, else `ui.open`). A new control in
  a prompt box goes through `targetOf` too, or it answers the open desk
  from a meeting room, which has none.
- **A desk leaves the room on moved, binding gone, or gone, never on a host
  offline.** deskFate reads a host gone offline as "left", and a host
  restart is that for a few seconds. A room losing its desks to a restart
  was the failure; such a desk stays, reads "away", and its messages are
  refused in the board's words.
- **A reload is End then Open.** pagehide ends the record with keepalive,
  because closing the window ends the meeting and the page cannot tell a
  close from a reload. The reloaded window's `/meeting/open` clears
  `ended_at`, and the floor holds its desks out for `REJOIN_MS`
  (`rejoin`), so its panel does not flash a composer. So "ended" is not
  final, and the Recent list leaves out rooms open in a window
  (`floorOpenMeetings`) rather than trusting the column.
- **Resume reuses the room's row, and asks before it reopens.** A new row
  per resume filled the list with copies of one room. The host's
  conversation list is asked first: `reopen` of an id gone from disk makes
  the host open the folder's newest instead (`resumable()`), which would
  move a desk off whatever it was on for nothing. A desk whose reopen
  fails (refused, the host's error turn, another conversation opened, 90 s)
  leaves the resumed room with the reason, so "in the room" always means
  "on the conversation it had". Add puts it back on whatever it is on now.
- **A resumed room shows what was said before, from each desk's own
  turns.** Each participant's part starts after the turn it first joined
  after (`since`, kept in the record), under its current conversation. The
  original addressing was the old window's and is gone, so an old message
  reads `you → Bo` there.

**A nudge is needed when a participant has unread mail on the board, and
the room says so** (costmo, on the first preview: "no indication that a
nudge is needed, nor is there any way to nudge"). Each participant is two
rows: its name, state and ✕, then its badges. The badges are the desk's
own `signPills` (✉ unread, ☰ assigned, ☑ claimed), each opening the floor's
dialog through `openPill`, so Mark all read, read to here, reassign and
Nudge agent are the backlog dialog's. Then its bell, the floor's `strike()`,
which now returns the board's refusal so the room can say it in the
transcript, having no drawn bell to put it on. Then its stop sign.
**Nudge** beside Send is "nudge all": one room message with each desk's
delivery under it (`meetingNudgeChip`).

**The room's Nudge goes only to the desks with something waiting, and
says how much** (costmo, 2026-11-16, 0.12.9). It used to nudge every desk
the To chips chose and read "Nudge everyone · 3 unread", so a room where
one agent had mail sent all of them off to check in. Now it reads
"Nudge all (3)", or the names when the chips narrow it, and the click
types the word into the chosen desks that have something waiting and no
others; the message in the transcript names who it went to. Two of his
picks: the count is unread messages **plus unclaimed tasks**
(`board.unread + board.assigned_open`, the ✉ and ☰ badges added; unread
alone was the other offer, and left the count missing while a task was
waiting), and with nothing waiting the button has no count and is
**dimmed, with why** (nudging everyone anyway was the other offer). A task
a desk has *claimed* is not waiting: it already knows about it. The bell
on a desk's box is the deliberate nudge, waiting or not, and is unchanged.
A desk with something waiting that the board will not nudge is still
counted, and is refused in the room in the board's words when the rest
are sent. Do not bring back "nudge everyone chosen".

**A room's conversation is contained, and that is the board's job, not
the page's** (costmo, on the second preview: agents on the floor outside a
room received its participants' broadcasts). A broadcast from an agent in
an open, live room is stamped with the room's participants
(`messages.audience`, `,bo,cy,`), and the three readers of "messages for
this agent" — `pollMessages`, `unreadCounts`, `unreadMessages` — skip it
for anyone outside, so the ✉ pill and the backlog agree with the poll. The
agent's `send_message` reply names who it reached. A direct message goes
where it is addressed, in or out of a room: an agent naming a recipient is
not the room's conversation, and refusing it would strand a real
escalation. costmo ruled it (2026-11-05), over refusing it and over
delivering it marked; do not re-propose either. "Live" is the window's 30 s `touch` within
`MEETING_LIVE_SECONDS` (150 s), not "not ended", because a crashed window
never sends its end and must not keep a floor's agents apart. Chrome
throttles a hidden window's timers to a minute, which the 150 s rides out.
A touch that finds the room ended (a reload's end landing after its open)
opens it again. The floor's envelopes for such a broadcast fly to the
roommates only (`outMeeting` in flyEnvelope).

A participant wears its desk's colours: its shirt down the left edge of
its box, its turns and its To chip, and its hair across the top of the box
and the chip (not the turns). The hair is costmo's call for recognition, "if
slightly", and may be undone. The payload's hair already falls back to
`DEFAULT_HAIR`. The unread and needs-you outlines colour every side, so the
stylesheet puts the hair back on top after them.

**Narrowing is chips plus `@name`, the names stripped** (costmo,
2026-11-05, both by AskUserQuestion). Names at the start of the box
(`meetingMentions`: id or persona, any case, `@everyone`/`@all`) choose
who hears that one message, and the agents receive the words after them.
An `@` later in a sentence is the operator's words. A name that is nobody
in the room sends nothing and leaves the box as it was. Mentions outrank
the chips for that message.

**A click on a name's chip means that desk, so with everyone lit it is a
solo** (costmo, 2026-11-14; `meetingToClick`). The chips were plain
toggles. With everyone lit, the first click on Bo took Bo *out*, and
"only Bo" in a room of four was three clicks on the others. He read it as
working "the opposite of how one would expect". His rule: everyone lit, a
click leaves only that desk; one lit, a click on it gives everyone back
and a click on another adds that one; some lit but not all, a click
toggles. So the chips never reach "nobody" by a click: the last lit chip
gives everyone back. A room still stands at nobody when the one desk
chosen leaves it, and a click then adds the desk clicked. Each chip's
tooltip says what a click on it will do (`meetingToTitle`, which reads it
off `meetingToClick`). The **everyone** chip is as it was. Do not bring
the plain toggle back.

**A choice that comes to name the whole room is everyone, stored as
everyone** (`meetingToLeft`; QA, PR #55 finding 2). The chips and the hint
are drawn from who is lit, the stored choice was a list, and the two came
apart when desks left: narrowed to Bo with the others removed, the room lit
**everyone** and said everyone hears, while the choice was still "Bo". A
desk added next was not lit, and the next message went to Bo alone in a
room that had just said everyone hears. Now a desk leaving takes itself out
of the choice, and a choice naming every desk left becomes everyone, as
`meetingToClick` already wrote it. This was the developer's pick of QA's
two readings (the other: keep the list and say "Only Bo" in a room of
one), on the ground that the page had already told the operator everyone
hears. It is open to costmo's reversal. The rule below about a desk added
to a narrowed room stands: such a room no longer reads as narrowed.

**The chips' choice stays after a send** (costmo, the same day, reversing
#44 Decided 2's "narrowed for this one message"). It used to go back to
everyone once a message was taken, so a run of messages to one desk was a
click before each. Now it stays until the operator changes it, and it is
kept on the page only (`ui.meeting.to`): a reload, or the room opened
again, starts at everyone, which he asked for. An `@name` at the start of
the box is still for that one message and leaves the chips as they were.
A desk added while the room is narrowed is not lit, because the choice
was made without it. Do not re-propose the reset.

**A participant's box is a control: a click on it hides or shows that
desk's part of the transcript** (costmo, 2026-11-14; `meetingShown`,
`m.hide`). The click is any part of the box that is not one of its
buttons. Each button has a `data-act` of its own and the handler takes
the nearest, so the box gets only the clicks that landed on none of them,
a dimmed button's included. Five things were decided in building it, none
of them his words, so each is open to his reversal:
- **A desk's conversation is what it said and what was said to it.** Its
  own turns go. A message goes only when every desk it went to is hidden,
  and one that stays is drawn whole, with the hidden desk's delivery line
  under it: a refusal is still said. The room's notes always stay.
- **Hiding is not muting.** A hidden desk still hears what the chips or an
  `@name` send it, and its prompt box still stands against the composer:
  a question that needs the operator is never put away. The hint under
  the box names a hidden desk that will hear the next message
  (`meetingHiddenNote`), and drops its own second half to make room. The
  longer line squeezed "Nudge everyone · 1 unread" onto two lines at the
  room's own width, seen in the check's picture and pinned there.
- **It lives on the page, like the chips' choice.** A reload or the room
  opened again shows everyone.
- **A hidden desk that leaves the room is shown again**, because what it
  said stays in the transcript and it has no box left to click.
- **The row of boxes keeps focus through its own redraw.** It is drawn
  whole whenever a desk's state changes, so Enter on a focused box worked
  once and then the next poll left focus on the body, one check run in
  two. `renderMeeting` now puts focus back on the same control of the
  same desk, which also holds for a bell or a pill reached by Tab.

The filter runs over the list `meetingItems` made and reorders nothing,
which is what puts a desk's turns back "properly inline" when it is shown
again. A reply being typed by a hidden desk is not drawn either; no
fixture streams a reply, so that one line is read, not measured.

**A desk Resume could not bring back for a reason that may pass stays in
the room's record, `absent`, and absent is on the floor**: it is not in
the room for containment either way, so its broadcasts reach the floor
and the room's do not reach it (QA, PR #49 finding 1: `liveMeetingOf`
and the audience matched the whole record). Busy window, host offline, an editor, out in
another window, the host refusing the reopen, or a 90 s timeout. The first
cut dropped any desk it skipped, so one busy window took a desk out of the
room for good. An absent entry is kept exactly as it was (`absentKept` in
src/floor.js). End does not re-read its conversation, because what its
desk is on now is not what it had in the room. A desk still being reopened
is saved the same way until the reopen lands. Saved as present, its record
took the conversation it was leaving, which the page check caught as
`sess-bo-x3`. A desk gone for good is not kept: moved, left, or its
conversation deleted. A reload leaves absent desks absent, and Resume
tries them again.

**Two forms on one page share radio groups unless their names differ.** A
radio group is by name across the document, not per form. With `q0` on
every form, ticking a choice in one participant's form unticked the other's
(check-meeting.mjs: "1 of 3 answered" on a form ticked in full). `askHtml`
names each input by its prompt's request id. The panel only ever drew one
form, which is why the name was never scoped before. A prompt box's
answering spinner is per desk for the same reason (`ui.answering` is a Map).

Left out on purpose. **Model and effort controls**: a desk's select types
`/model` or `/effort` into its own window, so a room would need one per
desk; `/model sonnet` narrowed to one desk takes the same route. **A reading view**: History
reads a meeting desk in the floor's panel, because reading types into
nothing (renderPanel's `outMeeting` branch). **Audit rows**: a room is a
window arrangement, like a popout, and popouts write none; the reopens a
Resume makes write their own `desk.reopen`. **`meeting_rooms` in backups**: it names
sessions on disks that may not be this machine's. `check-meeting.mjs` in
**verify-ui-change** drives all of it.

**A meeting's desks stand in a box of their own on the floor** (costmo,
2026-11-16; "a meeting on the floor" in `src/ui/floor.js`). A 2.5px light
grey edge, "In a meeting" on its upper left corner, and **End meeting**,
a button, on its upper right. On one floor the boxes are at the top, one
per meeting, stacked, three desks to a row, the floor's full width, and the
desks in no meeting follow under them. In the building a storey stays one
row: costmo's pick of three (stack above the row; box inside the row; no
box in the building). A meeting's desks come first in the row with the box
around them and scroll with it, so a meeting of four is four wide there and
the button reads "End" around a single desk. End acts at once, as the
room's own button does; asking first was offered and not chosen. Do not
re-propose the stacked building or a confirmation. Six things behind it:
- **Where a desk stands is the plan's, by agent.** `roomGeometry` and
  `deskXY(i)` are gone: a desk's place stopped being a function of its
  index. `floorPlan` returns `at`, the boxes and the room's size, and
  `room()`, the envelopes and the scroll arrows all read it. A floor with
  no meeting is laid out to the old numbers in the old order of arithmetic;
  `test/floor.mjs` keeps the two old functions as the reference and reads
  the layout constants out of floor.js by name.
- **Who is boxed is what the rooms' windows say** (`ui.outs`), the record
  that already takes a desk's composer off the floor's panel. Not the
  board's `meeting_rooms`: that row is for Resume and containment, and it
  lags a window by up to `MEETING_LIVE_SECONDS`. So the box is drawn in
  this browser's floor tabs only, which is where the window is.
- **The box is one box from the click.** The desks are out from the
  Meeting room click under no room number, tagged with that click
  (`batch`). The window then says `here` a desk at a time, and its first
  word names the room for the whole batch. Without that the floor drew two
  boxes for a moment (page mutant, red).
- **A `here` or `gone` that changes a box draws the rooms then**, not at
  the next poll. Both handlers used to redraw the panel only, because
  nothing on the floor moved when a desk went out.
- **End meeting on the floor is a message to the room's window** (`end`),
  which runs its own `endMeeting()`. The floor does not end the board's
  record: while the window stood, its next touch would open it again. A
  window that has not ended 1.5 s later did not hear it (one loaded before
  this build knows no `end`), and the floor closes it by its handle
  (`ui.popWins`), which ends a meeting as a closed window always has. A
  floor tab that did not open the window has no handle: the placard reads
  "Ending…" for 6 s and is a button again on a box that still stands.
- **A room that ended is not "ending" when it is resumed.** Resume reuses
  the room's number, and a box that came back four seconds after its End
  still read "Ending…" and could not be pressed (the page check's first
  run). `render()` drops the state for any room with no desk out.
- **End's 1.5 s close closes only the windows it asked.** The timer used
  to look up whatever window held the room's number when it fired, and
  Resume reuses the number: a room ended from the floor and resumed inside
  the 1.5 s had its new window closed by the old End. Not reported by
  anyone. It was found while writing PR #56 finding 1's rows, which ran 0.6 s
  after a Resume on the check's own fixture. `endMeetingHere` now keeps the
  handles it held at the press, and the check has a row for a room resumed
  inside the timer.
- **A desk in a meeting stands in its box, hidden or empty** (QA, PR #56
  finding 1; the developer's pick of QA's three, open to costmo's
  reversal). The box says who is in the room's window. With hide applied
  inside it, a hidden participant left the box and its sentences ("Bo and
  Dee are in a meeting room" with Cy in the room), and a meeting whose
  every desk was hidden had no box, no In a meeting and no End on the
  floor, while its window held three. `deskRows(c, boxed)` draws a boxed
  desk whatever its flag, and makes no pill of it. `floorRows` is the
  page's reading, and every caller that means "what the floor draws" uses
  it. The flag is kept, so the desk is a pill again when the meeting ends.
  Hide is refused while a desk is boxed, said under the card's dimmed
  buttons (since 0.12.9 in the card's one reason for a desk in a meeting
  room, `cardRefusal`, which carries what becomes of a desk hidden before
  it joined) and on the room's line for a bulk Hide (`hideRefusal`): pressed,
  it would write a flag that changes nothing until the meeting ends, a
  button that seems to do nothing. The other two picks, counting a hidden
  participant in the box's words only and leaving it as a pill, were not
  chosen. The first leaves the all-hidden meeting with no box to put the
  words on, and the second is a pill outside the box that speaks for it.

**"In a meeting" is a button too: a click brings that room's window to the
pointer** (costmo, the same day: three monitors, a dozen windows, rooms
that look alike, some minimized, some covered). `raiseMeeting` focuses the
window through its handle, fits it to the screen the click was made on if
it is larger, moves it so it is centred on the pointer and wholly on that
screen (`meetingRaisePlace`), and focuses it again. Focus comes first
because a minimized window has no place to be moved to until it is back.
A floor tab with no handle sends `focus` with the place, and the window
moves itself; whether it may raise itself is the browser's call. What was
measured, and where: on a headless Chrome the calls arrive in that order,
the browser's own bounds show the window under the pointer, and an
oversized window is resized first. Two things a headless browser cannot
say, so they were costmo's to see on his screen, and neither was held for
(his word: as close as reasonably possible, without delaying progress):
- **A minimized window. Measured by costmo on real Chrome on macOS**
  (2026-11-16): a click on In a meeting for a room whose window was
  minimized brought the window back, to the front, under the pointer, as
  for a covered one. Headless had left it minimized after `focus()`, which
  is headless's stand-in window and not Cocoa's: the check has no row for
  it, and his reading is the measurement. The fallback that was named in
  case it did not come back (close a window still `hidden` after a second
  and open the room again at the pointer) is not needed and is not to be
  built: it would reload rooms that are raised perfectly well.
- **Another monitor.** Measured by costmo on two 4K monitors and a
  laptop, the same day: without the browser's window-management
  permission, a room on another monitor came to the front and stopped in
  the corner of its own screen nearest the pointer. Chrome keeps a moved
  window on the screen it is on. So when the room's window stands on
  another screen than the click (`meetingElsewhere`: its centre is outside
  that screen), `raiseMeeting` asks for the permission from inside the
  click (`getScreenDetails()`), and makes the same move again once it is
  given. Chrome puts the question to the operator once per site. It is
  asked only then: never on a desktop of one screen (`screen.isExtended`),
  never for a window already on this screen. Refused, the behaviour is
  what he saw, which he called acceptable. That the grant makes the move
  cross is Chrome's documented behaviour and was not seen by me: the page
  check stages the desktop (`leave()`), so it proves the asking and the
  second move, not the crossing. His to see.

He reported the monitor case first, after trying it. He confirmed the
minimized case later the same day, when asked what the window did.

Riding along: a desk's open nameplate card now follows the desk when the
rooms are redrawn, since desks move with nothing clicked. One thing not
built, deliberate for now: the board view shows nothing of a meeting.
(A box for a meeting whose every desk was hidden or empty was the other,
and PR #56 finding 1 showed it was a meeting with no trace on the floor;
see the bullet above.) `check-meeting-box.mjs` in **verify-ui-change** is
the page. QA ran its twenty-five page mutants in PR #56's review: 23 red,
and the two greens were rows that saw their fault only by chance (a redraw
inside a reload's gap; the one-screen guard), both pinned since. The list
and the command are kept beside the check (`mutants-meeting-box.page.json`).

**A dialog holding a text field closes only from its own buttons and on
Escape, and a closed dialog stays closed.** Issue #11 and PR #36 (0.10.14,
2026-11-04). A click on the `<dialog>` element closes it only when it
carries no plain-text field (`holdsTyping` in `src/ui/app.js`, asked at the
click). That element is the target of three gestures, measured with real
input: the backdrop, a drag out of a field past the edge (a click goes to
the common ancestor of press and release), and a click in the dialog's own
padding. Two rulings ride on it. costmo ruled "Exactly as Decided": a
dialog with no field keeps all three, padding and drag-out included, and
narrowing those to a true backdrop click was offered and declined. And
costmo ruled "keep as built" on Sessions and History (QA's Info 3), whose
text box is always drawn, so they never close on a click outside. Do not
re-propose either. The second half came out of QA's review: History,
Sessions and Take a desk ask a host and draw its answer later, and a close
never cleared `ui.dlgCtx`, so the answer reopened a dialog the person had
just closed (History within a second; at the base too). Each of the three
now draws only while it is the current dialog *and open* (`drawsNow`),
and the `close` handler clears the context (`forgetDialog`) unless the
dialog is open again. Both halves are needed, because the `close` event is
not prompt: about 100 ms after the close here, and History's poll redrew
inside that gap on the first cut, which had only the event. `el.dlg.open`
is the one signal that is synchronous for every way a dialog closes,
Escape included. Both are in `check-backdrop.mjs` in **verify-ui-change**,
which is the only tier that sees them; the suite pins the decision and the
handlers' text.

**A host's answer is patched into its dialog, never drawn over it.**
Issue #37. History, Sessions and Take a desk draw again when a host
answers, on the host's clock, and drawn whole that took the text box's
focus (the keys after it went to `body`), and a button held down across
it fired no click: the pressed element was gone before the release. So
`openDialog(html, { as: form })` patches the body in place (`patchBody`
in `src/ui/app.js`) when the same form draws again while open, and every
other draw still replaces it. Two rules in it look loosenable and are
not. **An element is kept only as the same control** (its id, its
`data-do`/`data-go`/`data-id`, or the id of the field inside it), never
because it stands in the same place. Keyed by place, a press held on a
conversation fired on the one drawn into its spot, and Take a desk's Host
label, arriving above the Agent label with the host list, was patched
into it. And a match further down is reached by removing what stands
before it, never by moving it up: a moved element loses focus like a
replaced one, which is how the first cut lost Take a desk's Agent box when
its host list swapped the block above. **A field's value is written
wherever it differs from the form**, because `.value` stops following its attribute once somebody has
typed, and a bound folder's agent must still replace typed text. And Take
a desk's name is now emptied when another folder is *chosen*, not when
its listing arrives (`agentTyped`, in `takeListing`). The listing comes a
moment after the choice, and the first listing used to empty a name typed
for the folder the dialog opened on. One loss is left and is not this:
the `<dialog>` is centred, Take a desk grows 48 px with its first listing,
and a release at the old spot lands 24 px off. costmo ruled it left as
it is (2026-11-04, through QA): a top-anchored dialog would move every
dialog on the board, and reserving the chosen-path line would not stop the
note's wrap. Do not re-propose either. #40's update dialog and Settings'
updates section are patched too (costmo added them to #37):
`drawIfChanged` patches whatever it has drawn, and Settings keeps what it
drew on the section. Settings' old test, `sec.outerHTML !== html`, never
matched, because the template starts with whitespace, so every poll
replaced Check now. `data-commit` is in the key, so an Update now held
while a newer commit arrives starts neither update; without it the press
started the newer one. The update dialog shifts too, 77 px when an offer
arrives while it is open, which is the same centred-dialog move as Take a
desk's. `check-redraw.mjs` in **verify-ui-change** is the page; it prints
each move beside its row.

**The chat box grows with its text, and a height the operator drags it to
is theirs for that conversation.** Issue #13 (0.10.17). What the page
decides is one lifted section of `src/ui/floor.js` ("chat box height: what
the page decides"): `boxHeight`, `dragOutcome`, `boxCarry`. The drawing is
`fitBox`, and **check-chatbox.mjs** in **verify-ui-change** is the page.
Four things behind it look simpler than they are:
- **Only a drag sets a height, and a drag is a height that changed between
  a press and its release.** The page's own growing happens on `input`,
  never inside a press, so nothing has to tell the two apart by size.
  Measured: Chrome's native resize handle sends `pointerdown` to the
  textarea and `pointerup` to the document. A `ResizeObserver` would see
  the page's own growing as well, and so would CSS clamping a height the
  page set: the first long message would pin the box tall, which is the
  thing the issue forbids. A taller drag sets a height. A shorter one
  lowers a stored height when it ends below it, and otherwise stores
  nothing (`dragOutcome`'s `set`). A box its text holds up cannot be drawn
  shorter than the text: it springs back on release, and a floor stored
  under it surfaced only after the next send, as 8 lines instead of 3 (QA,
  PR #39 finding 1).
- **`stashDraft` is the funnel.** Every path that sets `.value` without an
  `input` event (the draft on open, a saved prompt, a lost message put
  back, the box emptied after a send, a completed command) already called
  it, so it calls `fitBox`. A new path that writes the box should go
  through it. `renderPanel` calls `fitBox` last, which is how a new session
  on an open desk is noticed: the shell is keyed by desk and is not rebuilt.
- **The room wins.** The drawn height, and the drag's `max-height`, are
  capped at the panel's max-height less everything on it that is not the
  box or the transcript, less 60px of transcript. `.deskpanel` is
  `overflow: hidden`, so a box that pushed the send row off it could not
  be scrolled back. With a permission prompt up at 800x700, that leaves a
  box of 81px. The room is measured from the parts (above the transcript,
  and from its bottom to the last child's), not from the panel's own
  height: the panel's height is clamped at its max-height, so "panel less
  box" grows with a box that overflows it. The first cut read it that way,
  and a page mutant without the drag's `max-height` showed the room
  following the drag off the panel.
- **A placeholder's height goes to the first real id the panel sees.**
  The page cannot see the server's rekey, and the next window on the desk
  opens under the same `host:<host>:<channel>:<agent>` string. So a real
  id with no height of its own takes it, and the placeholder's is dropped
  either way (`boxCarry`). The carry runs only while the desk's panel is
  open (`fitBox` draws nothing else), so a reload, a desk switch or a
  closed panel during that window leaves the height on the placeholder,
  and the first real id the panel sees after it inherits (QA, PR #39
  finding 3). That is the conversation that was opening, unless the
  session changed again before the panel came back.

`line-height: 1.2` on the box is the 15px that `normal` measured on this
font. It is stated so the page can count lines, and three rows are still
the 55px box of before.

**A user record is not all the operator, and the split is the relay's job.**
Claude Code glues machine-injected context — IDE state, slash-command records —
onto the person's message, and joining the blocks once put
`<ide_opened_file>…` on the floor as the operator's own words. `readTranscript`
now splits at the block boundary into `context` turns (tag in `tool_name` as
the label); the chat panel draws them as quiet labeled lines. Surface, never
suppress: hiding what the agent read recreates "a reply to a question nobody
could see being asked", and rendering it as the person is a false record.
Classify in the relay, not in a view — the derive-once rule again.

**A subagent's words are in a file of its own.** The Agent tool does not write
into the transcript that spawned it: each call gets
`<session dir>/subagents/agent-<id>.jsonl` beside an `agent-<id>.meta.json`
carrying its description, and the session's transcript holds only the
`tool_use` and the report. `readTranscript` skipped `isSidechain` from the days
they were inline, and once they moved out the floor showed "Agent: …" and then
nothing until the report came back, while the editor showed every "Let me
search for…" in between (2.1.258, 2026-09-03). The host now tails those files
too (`subagentTranscripts`), the relay labels each turn `via` the description,
the server stores that as a column, and the chat and bubble draw from it. The
subagent's brief and tool results are not turns — the brief is already the
Agent line on the floor, and neither is a person speaking.

**A subagent with no `.meta.json` yet is left unread, on purpose.** The two
files usually land in the same second, but not always: over 50 real pairs on
this machine two came meta-first and one transcript came 52 seconds before its
meta (QA, PR #3, 2026-09-03). Reading it meanwhile filed that subagent's first
turns under the id and the rest under the description, and **nothing
relabels** — a stored turn is not revisited. So `subagentTranscripts` skips a
meta-less file until the meta arrives, and reads it from its first word then;
only past `ORCH_SUBAGENT_META_GRACE_MS` (two minutes) does it fall back to the
id, in case the meta never comes. The cost of waiting is that a subagent's
first seconds reach the floor late; the cost of not waiting is one
conversation under two names, which no later tick repairs. So the guarantee
is exactly "one label unless the meta is later than the grace" — past it the
split returns, which is the old behaviour and not a new fault. Every delay
measured was 52 seconds or less against a two-minute grace, so that case is
outside anything yet observed; if it is ever seen, raise the grace rather than
teaching turns to relabel.

**Thinking is a turn too, under its own role.** Claude Code writes a
`thinking` block ahead of most steps and the window draws it in dim text; on
2.1.258 it is a sentence or two of narration, and the operator read one of
those in the window — "I'll leave the console checkboxes as is since…" — and
found nothing on the floor (2026-09-03). `readTranscript` files non-empty
thinking blocks as `role: 'thinking'`; the chat draws each as a thought
bubble — dotted edge, a trail of dots toward the thinker, no speaker header,
because with a header they read as a message from somebody called "thinking"
— and the desk's bubble quotes them like a reply: a thought bubble is where a
thought belongs, and between replies it is the one line that says what the
desk is doing. Empty thinking blocks are common — Claude Code writes one
ahead of most steps and only about one in five carries any text, so a desk
working steadily and thinking nothing visible is the normal case, not a
fault — and they are skipped.

**A new field on a turn crosses eight places, and missing one fails
silently.** Both `via` and the `thinking` role were added this way
(2026-09-03), and the chain is worth having in front of you rather than
rediscovering: `readTranscript` puts it on the turn → the desk watcher's
`emit` in [`host/index.js`](host/index.js) sends it → `applyHostEvent` reads
it off the event → **both** `turn()` helpers in
[`src/floor.js`](src/floor.js) take it (there are two, and updating one is
the easy miss) → the `INSERT` statement names it **and** `insertTurn`'s
wrapper passes it → every read query that the panel or the bubble uses
selects it → the hand-picked projection in the floor payload carries it →
`turnNode` draws it. Two of those bite without a word: the wrapper names its
parameters, so a column added to the statement alone makes **every** insert
throw `Missing named parameter`, and a column the query selects but the
projection drops simply arrives as `undefined` in the page. The floor suite
catches the first, nothing catches the second — read the new field out of
`/api/floor` before trusting anything drawn from it.

The two scripts talk over `window`, in both directions — `app.js` is a classic
script so its top-level functions are already global, `floor.js` is an IIFE and
exposes only what it assigns. Call across with `?.` so either surface loading
alone is not a crash.

For the vocabulary of the parts, see
[`docs/review/floor-nomenclature.png`](docs/review/floor-nomenclature.png) — it
is a labelled screenshot, and it exists because we spent a round meaning
different things by "the desk". Before claiming any UI change works, use the
**verify-ui-change** skill; the page is the only honest test, and it lists the
ways a green result has lied here.

## Updating from the page

Issue #40, 0.10.19. The board checks GitHub for a newer build and says so
in the header; **Update** has the host beside it bring the server, the host
and the plugin to that commit, and the page reloads itself onto it. The
server half is [`src/updates.js`](src/updates.js), the host half
[`host/update.js`](host/update.js), the page a lifted section of
`src/ui/app.js` ("updates: what the page decides"); the suite is
`test/update.mjs` and the page is **check-update.mjs** in
**verify-ui-change**. Each of these looks simpler than it is:

- **A build knows its commit because the image build reads `.git`.** The
  image has no `.git` and no git, and `.dockerignore` keeps `.git` out of
  the context. `docker-compose.yml` hands the clone's `.git` over as a
  second build context (`additional_contexts: gitmeta`), and the
  Dockerfile's last `RUN` bind-mounts it for one step and writes
  `BUILD_COMMIT` with `src/build-info.js` (plain fs: HEAD, the loose ref,
  packed-refs). Nothing of `.git` reaches a layer. Measured 2026-11-04: the
  image read `0c0a5e3` and `/gitmeta` did not exist in it. A plain
  `docker build .` has no such context and fails at that step; build
  through compose, or pass `--build-context gitmeta=./.git`. A dirty tree's
  build records HEAD and not the edits. `/health` and `/api/state` carry
  `commit`.
- **Commit decides; the version is only shown** (the issue's Decided). A
  check is one API request, the branch's last 100 commits: the newest, and
  this build's place in the list is how far behind it is. A build not in
  the list costs one compare (`diverged`, `ahead`, or `missing`, which reads
  as unknown and offers nothing). The version comes from
  raw.githubusercontent.com, which is not the API and not counted. The list
  is kept, so after an update the board reads "You have the latest" with
  nothing fetched.
- **Sixty requests an hour is shared by Check now.** Contacts are at least
  `ORCH_UPDATE_MIN_GAP_MS` (60 s) apart however often it is pressed; a press
  inside the gap answers from what is in hand and says when it may ask
  again, and a 403 with the limit spent stops all contact until the reset,
  said as a time. The automatic check is a 10-minute tick that does
  anything only while checking is on and nothing succeeded on the followed
  branch in 24 h (a failed try waits an hour), and only on a board in a
  container: every suite starts bare servers, and each would otherwise
  spend the operator's sixty an hour from his address and make the suites
  depend on GitHub (`test/update.mjs` holds that). Checking off means the tick
  does nothing and a change of branch asks nothing; only Check now
  contacts GitHub.
- **Which host updates: the one whose clone runs this board's container.**
  Inside Docker the hostname is the container's short id; the host asks
  Docker for the container labelled with its clone's compose working
  directory and service (`docker ps --filter label=…`, not `docker compose
  ps`, which needs `.env`) and reports it on every registration, beside its
  build, its clone (branch, HEAD, every uncommitted path, untracked
  included) and whether launchd supervises it (`XPC_SERVICE_NAME`). No
  other join says "the machine the board is on" without guessing. The
  board computes the refusal from that report (`refusalOf`) so the
  confirmation shows it instead of a button that would only be refused,
  and the host checks again before it touches anything.
- **Refusals are refusals.** A dirty clone, a clone off the followed
  branch, a clone with commits the branch lacks (not fast-forwardable), a
  host not under launchd (nothing would start it again; #26/#28), a board
  run bare (no container to replace). Never a stash, a reset or a checkout
  of another branch: on this machine the clone is a working tree, and
  `issues/40` is refused here by design.
- **The steps, and what a failure leaves.** preflight → fetch (over HTTPS
  from the public repo: a LaunchAgent has no ssh agent, and `origin` here
  is an ssh alias) → `git merge --ff-only` → `docker compose up -d --build`
  then `/health` answering as the commit → `claude plugin update` only when
  `plugin/` differs → exit, and launchd starts the new code. A build that
  fails, or compose saying `Running` (nothing replaced), puts the clone
  back with `git reset --keep`, so the clone and the board stay on the
  build that is running. Past the rebuild nothing is undone.
- **A run that stops past the rebuild stays on the page until it is
  finished** (QA, PR #42 finding 1). By then the board answers as the
  commit, so nothing is newer, the offer is gone, and the page has
  reloaded off the dialog. A failed plugin step or a host that never came
  back from its restart then left one log row and Settings reading "You
  have the latest" with the host on the old build. Now `stoppedOf` (a
  failed run whose commit is the running build and whose `from` is not)
  keeps an **Update stopped** button in the header and replaces "You have
  the latest" in Settings, and the dialog says what is on which build and
  offers **Finish the update**: the same steps for the same commit,
  carrying the stopped run's `from`. The host skips the rebuild when
  `/health` already answers as the commit (a rebuild of an unchanged tree
  only says `Running`) and compares `plugin/` from that `from`, since the
  clone is already at the commit. Finishing is the remedy because the
  alternative was telling the operator to type `claude plugin update`.
  Finish is asked only of a host whose report says `capabilities:
  ["finish"]` (`CAPABILITIES` in `host/update.js`). A host from before it
  (`e578070` and older) ignores `from`, skips the plugin and closes the run
  as done with the plugin old, and after a plugin failure that host was
  never restarted, so it is exactly the one that would be asked (QA, PR #42
  N1). It is refused in words instead. A new thing the board asks of a
  host's update code goes in that list the same way. A
  run that gave up on a silent host is closed as done when that host does
  come back as the commit. Two things that close a run when an event is
  lost at a restart are pinned in `test:update` (QA's Info 3): the board
  marks the server step done itself when it starts as the run's commit,
  and the host retries undelivered events for up to a minute before it
  exits.
- **The host is always restarted**, even when `host/` did not change, so
  every part reports the commit it was asked for. The run closes when the
  host registers again as that commit, not when it says it is going; a
  run with no word for 20 minutes ends as failed, naming its last step.
- **The page reloads only for an update, once.** It reloads when `/health`
  answers as a run's commit and the page was loaded from another build; a
  deploy by hand reloads nobody, and the reloaded page does not reload
  again. While a run is open it reads `/health` every 2 s whatever
  auto-refresh says. A desk's popout (#19) is the same page on the same
  build and does the same: its `tick()` returns early and draws nothing of
  the board, so it calls `renderUpdate` itself. Without that a popout kept
  the old page code after an update (found merging #19 in; red in
  check-update.mjs without the line).
- **Settings are rows, not localStorage** (`settings` table, `updates.*`
  keys), so every browser sees one value and the daily check is once per
  board. Not in `BACKUP_TABLES`: a restore that turned checking back on
  would be a setting changed by a file nobody looked inside.

A real update on the live board was read once, 2026-11-15, when costmo
merged PR #55, put the clone on `main` at the merge by hand and pressed
Update (run `mwi3pd86-ddfc8e0`, `e651798` → `ddfc8e0`). It took 8.6 s from
the run's start to the host back as the commit: preflight, 0.7 s; the
rebuild and `/health` answering as `ddfc8e0`, 6.5 s; the host's exit to
its registration under launchd, 0.8 s. The run closed `done`. The host
logged one failed work poll while the container was replaced, which is
the relay riding out the restart. Read afterwards: `/health` at the
commit, the served `floor.js`, `app.js` and `hub.js` byte for byte the
tree's, and the host's process started after every `host/*.js` on disk.
Two steps did nothing in that run, so they are still measured only on
stand-ins: the fetch and fast-forward (the clone was already at the
commit) and `claude plugin update` (`plugin/` was the same in both
commits). Before that day every step had been run against real git and
real processes with stand-ins for `docker` and `claude`, and the two
Docker halves (the image recording its commit, and the host finding the
live container from launchd's environment) each for real.

## Tests

**Every suite, check and scratch board on this machine needs a newer Node
than its default first on `PATH`.** The default is 20.20.1, and costmo's
ruling is that it stays. The `node_modules` here holds better-sqlite3
13.0.3, and under Node 20 loading it ends the process with exit 139 and
not a word (measured 2026-11-16: `node -e "require('better-sqlite3')…"`,
139 under v20.20.1, `ok` under v24.22.2), which reads as a suite or a
server that printed nothing. So a run names its own:
`export PATH=$HOME/.nvm/versions/node/v24.22.2/bin:$PATH` at the top of the
command. The host is the exception: it loads no database, and the live one
runs on 20 under launchd. One thing seen and not touched: on
`feature/agent-multi-session` `package.json` still reads `^11.8.0` and
`engines: >=20`, while the module installed is the 13 that `develop` took
in 0.12.6. The image builds from `package.json` with its own Node, so the
live board is unaffected; which of the two this branch should say is
costmo's.

`npm test` runs thirteen suites. `test:host` and `test:window` are not unit tests:
they drive **real tmux panes** against a **real server**, with a stand-in
`claude` (a `.cjs`, because this package is `"type": "module"`). They use their
own tmux session names and ports, so they are safe to run beside a live host —
but a suite killed halfway leaves a server on port 8896 and fixtures in `data/`,
which will poison the next run. Check for both before concluding a failure is
real.

Two more things about `test:window`, both from 2026-09-09. Its stand-in
fakes exactly what the host reads and no more: it answers `agents`, it
answers `stop <job>` by dropping the roster entry the test wrote for itself
(and refuses job `stuck-1`, for the failure path), and on `--resume` it
registers its own pid under that id, because readiness and delivery read the
roster — a case that opens a window from a message needs that, or it waits
out the 45s readiness timeout on "the roster had nothing at all". It writes
no transcript, so a send that opens a window can only end `not_delivered`
there; the case asserts the release, the window and the text arriving, and
delivery is proved by the section that writes its own transcript. And the
fixture panes used to be read a fixed 500 ms (700 ms for the alternate-screen
form) after creation: under editor load that went red with `its last line
reads ""` or `no_prompt` — twice on 2026-10-01, once on 2026-10-03, once in
QA's review of PR #25 — and green on every rerun. Since 2026-11-02 `drawn()`
in `test/window.mjs` waits up to 8 s for the pane to show anything instead,
the same settle-on-an-observable rule the host lives by. A red of that shape
now means the pane really drew nothing; read it rather than rerunning.

**Stopping a full run halfway takes more than killing `npm test`.** The
chain is `npm run smoke && npm run test:admin && …`, and on 2026-11-02
killing `npm test` and the `node test/host.mjs` under it left the chain's
next link, `node test/window.mjs`, starting on its own with a tmux session
and a fixture of its own. What a half-run leaves, all named by the suite's
pid: `node test/<suite>.mjs`, its `node src/server.js`, a tmux session
`orch-host-test-<pid>` or `orch-test-<pid>`, and `data/host-<pid>*`,
`data/window-fixture-<pid>` or `data/floor-<pid>*`. Kill the `node test/`
processes and their servers, `tmux kill-session` each test session, remove
the fixtures, then check `tmux ls` and `data/` again before the next run.
`lsof` and `netstat` are not on this machine; match on the command line
with `ps -Ao pid,command`. **The shell is zsh, which does not split an
unquoted variable**: `kill $PIDS` hands kill one word and kills nothing
(`illegal pid`, unseen behind `2>/dev/null`), and the same goes for a
command kept in `$T`. Use `xargs kill`, or `${=PIDS}`. That is how "the
stand-ins ignore SIGTERM" got told to QA as a measurement (task 263); they
never got the signal. Two more from 2026-11-04. A glob that matches nothing is an error in
zsh, not an empty list: `rm -f "$D"/x.db*` with no such file aborts the
whole `&&` chain behind it, so the server it was meant to start never ran
and the next step read a dead port. Name the files (`x.db x.db-wal
x.db-shm`). And a word starting with `=` is a command lookup, so `echo
===` prints `== not found`. Two more from 2026-11-05. In an agent's shell,
`grep` is a function that runs ugrep, which reads `-i'pat'` as a cluster of
flags (`invalid argument -m=eeting`). Use `command grep -i -e "pat"`. Shell
scripts are not affected, because `sh` does not load the function. And
`md5` is not installed: a comparison of two `$(md5 -q …)` is two empty
strings and always equal. Use `shasum`, and say which: with no flag it is
SHA-1, and one sent to QA unlabelled was set against their sha256 of the
same file and read as two files (PR #55 round 4). `shasum -a 256`.
Two more from 2026-11-16. **A heredoc whose delimiter is unquoted runs the
backticks in its text.** A Python edit fed through `<<EOF` carried
"\`npm test\`" in a sentence, so the shell started the whole chain. Smoke
failed against the load and stopped it, and its output was written into
the file in place of the two words. Quote the delimiter (`<<'EOF'`) for
any heredoc that holds prose, and pass values in through the environment
instead of `$VAR`. **`sysctl` is not on an agent shell's PATH.** A
wait-until-load-drops loop built on `sysctl -n vm.loadavg` read an empty
string, compared it as small, and reported "load ok" at 336. Use
`/usr/sbin/sysctl`, and make such a loop refuse an empty reading.

Three more reds were seen in `test:window` on 2026-10-01, in one full run
under load (load average 7–14): "the presser succeeds once the cursor is
confirmed on the right row", "and reports which row it took", "with Enter
actually reaching the window this time" — all in *answering a startup
question, against a real pane*. The suite alone straight after was green,
and so were the next two full runs and QA's. Nothing in that section had
been touched. The cause was not found; it is recorded here so the next one
is recognised, not so it is waved through — rerun, and if it repeats, read
the pane.

**QA's clean-clone runs share this machine's CPU, not its ports.** Their
suite announces itself on the channel with its ports (8896–8901, or 8871/
8872 when they stay off yours); a full run of yours overlapping it went
red in six `test:host` cases — "typing from the floor" and "reading the
conversation back", real panes — at load 5.5, and `test:host` alone
straight after was green (2026-11-03, task 247). Read the channel for
their announcement before a full run, and if you overlapped, rerun the
red suite alone before reading the pane.

**Load from other projects is expected, and nothing waits for it to
pass** (costmo, 2026-11-16: "work around high system load as needed … work
needs to continue on both fronts"). This machine also builds and tests a
mobile app, and PR #56's round ran at load averages of 100 to 350 from its
Xcode and Go builds. A wait-until-quiet loop was stopped by his word. Run
anyway, and make the run readable instead: mutants always beside an
unmutated control, a red rerun alone before it is called real, and fixture
rows kept apart from behaviour rows, so a slow machine reads as one. An
example is "the fixture held: Resume landed N ms after the End" in
check-meeting-box. Give the load beside the result. Do not widen a timeout
to make a load red go away: that is how a row stops seeing its fault, as
Info 5's 8 s wait did.

**One move-section red in `test:host` has now been seen twice with no other
suite on its ports.** "the new floor holds no session row for the
conversation it left" listed two ids: the stand-in's constant `1111…5555`
beside the fresh one. Seen on 2026-11-03, and on 2026-11-04 with nine more
reds after it in the same section (PR #38's full run from 15:46:47Z, load
5.5–7). That second run had company: QA's page checks, probes and
inversions ran from 15:46:28Z to 16:03:29Z, each with a server and a
headless Chrome on private ports. That was load, though not a collision,
and those ports were not announced. QA announces page-run ports too since
then. `test:host` alone straight after was green both times. The cause is
not found. A third sighting is the cue to read the session rows at the
moment of the move, not to rerun again. **Third sighting, 2026-11-05**, the
0.12.0 (#44) full run, load average 7.6 with nothing else on its ports or
running beside it: the same assertion, the same two ids, one red only.
`test:host` alone straight after was green. The session rows were not read
— the meeting room work it was run for touches no host or session code —
so the cue stands for the next one. **Fourth, the same day**, in QA's
re-review of PR #49 (dc6de34): red once in one of ten single-suite host runs
(inversion R8, whose mutant was elsewhere), green in the other nine and in
both full suites. Four sightings, each alone or under load, each green on
the next run: the session rows at the moment of the move are still unread,
and that is now overdue rather than next.

**Fifth, 2026-11-15**, in the PR #55 round, with seven reds before it in
*Take a desk* ("and within seconds the host has bound it and registered
the desk" and the six rows that read that binding): load average 57 at the
suite's start and 171 at its end, from another project's Android and Xcode
test builds on this machine, with a page-mutant run of ours beside it.
`test:host` alone at load 7 twenty minutes later read 327 ✓ and 0 ✗. The
session rows were again not read: the round was a review's fixes, none in
the move.

**Sixth, the same day**, in QA's close of PR #55 at f5c2a92: their first
chain run, load 16–27 with their own page lane beside it; 327 ✓ in the
second.

**The Take a desk seven again, 2026-11-16**, building 0.12.9: "and within
seconds the host has bound it and registered the desk" and the six rows
that read that binding, with this session's own floor suite and a mutant
lane running beside the host suite at load 22 to 34. Alone straight after,
at load 10 to 23: 327 ✓. Nothing in the bind had changed. It is the fifth
sighting's shape, and the same reading: a bind that did not land inside
its twenty seconds under load.

**That reading was wrong, and the seven are read now** (QA, PR #57 Info
10, the same day). QA printed the suite's own host log beside the reds:
the bind took 37 ms, and before it the host had logged nothing for 46 s.
The twenty seconds were gone before the bind began. What held the host's
line was the section above it, the placeholder-key desk: the floor opens
its window, the suite reads what the pane was given and kills the pane at
once. The host's `open` was still in `waitReady`, and whether it had seen
the window in the roster by then was a race, lost more often under load,
which is why it read as load. `waitReady` then waited out
`READY_TIMEOUT_MS`, 45 s, on a window that was not there, because its
"did it exit?" read could not see a killed pane (the bullet in *Driving a
window*, below "a prompt suggestion"). Everything behind it in `run()`
waited: the rescan the suite had asked for, then the bind.

Fixed in `waitReady`, which now says `window_gone` at its next look, and
pinned on every run: the suite arms `ready-delay.flag` for that window,
so the host is always still waiting when the pane goes, and a row reads
the host doing the next thing asked of it at once. With the fix out it is
that row and the seven, 8 red, every run. Two things to take from it. A
red that goes green on a rerun is not thereby load: four sightings of
this one were written down as load, each with a load average beside it.
And **the host's log beside the reds is what named it**: a gap in the log
is work held on the host's line, and the line before the gap is where to
look.

**The red now reads the rows itself** (2026-11-15, after the sixth). They
were never read because they are gone with the run's database before
anyone looks. When that assertion fails, the suite prints the session row
(its floor, and its times beside the board's clock), the newest turns
filed under the old conversation's id with the floor each was filed on,
and the host's log from the move on. A session row is keyed by its id
alone, so the red means something filed under the old id named the new
floor after the move. The print says which kind. Run with the mutant the
case was written against (the move's `bound` naming the conversation it
left; control 327 ✓, the mutant that one red), it read: the row on the
new floor, updated in the second of the bind, and every turn under that
id still on the old floor. So that mutant is an event that writes no
turn. A turn on the new floor in the print would instead be the relay
still reading the old transcript after the rebind. Which one the six
sightings were is not known. The next sighting is read, not rerun.

**Seventh, 2026-11-16, read** (QA's chain run at `da67c91`, load about
87; the printed block is in QA's evidence, `pr56/npm-test-da67c91.log`).
The old id's row was on `host-test-2`, updated at 18:33:03, the second of
the bind. All eight turns under that id were on `host-test`, the newest at
18:32:39. So it is the event that writes no turn. The host's log names the
gap: `found desk host-test-2/free` at .340, and `closed its window to
reopen` at .570. In between, the folder's old window is still running the
old conversation. `bind()` creates the new desk inside `rescan()` and sets
the reopen's intent only after that, and after an `await W.paneFor()`.
`watchLoop()` is a loop of its own and can tick in that await. A desk with
no intent adopts the newest live session (`watch()`'s newest-wins). That is
the old window's, and the desk emits `session` for it on the new floor,
which the board files by id alone. The comment above `fresh` in `bind()`
already says the intent must be set "before anything else can tick"; it is
set one await too late. Under load the tick lands in the gap, and that is
why every sighting was under load.

**Fixed the same day, at costmo's word.** `bind()` asks `paneFor` before
the rescan and hands the intent over in `intents`. The rescan sets it on
the desk as it creates it, so the desk has it from its first tick. The
same race was open on the live instance in any real move. `test:host`
sets `ORCH_HOST_BIND_GAP_MS=700`, a seam that holds the moment after the
rescan open for longer than a watch tick. The assertion now sees the race
on every run instead of under load only. Unset, the seam is no pause.
Measured in copies at load 6 to 26: the old order (the intent set after
the rescan) was red on that one assertion 3 of 3, with the same two ids
as every sighting. With no intent handed to the rescan it was red 1 of 1.
The control was 327 ✓. The list is
`.claude/skills/mutate-in-a-copy/mutants-move-race.suite.json`.

**Three more reds seen under other suites' load, none explained, written
down so the next one is recognised and read** (2026-11-16/17, PR #57's
rounds after the close; QA's logs are in the QA repo, `evidence/pr57/r3/`
and `r4/`).
- `test:host`, issue #5's section: "a failed poll still re-registers
  before the next" (got `["register","work","register"]`, wanted four),
  "the work poll is told apart from the register that shares its warning",
  and once "a refusal by status names the board as well as the path". Red
  in 5 of QA's runs across two commits, green in the next six on the same
  trees. Load average did not separate the two groups (12–36 red, 15–41
  green). What the red runs had was window suites, QA's and mine, on the
  default tmux server beside them. The rows share `runHost`, which ends
  the host after 8000 ms and wants four requests seen in that time.
- `test:host`, "a run leaves no stand-in claude running": one process
  alive 8 s after `kill-session`, once, at load 28 with five lanes going;
  328 ✓ twice alone straight after. Whether it was slow to die or outside
  the suite's session was not caught.
- `test:renew`, what an agent is told after a move: "the agent whose
  question was closed is told to ask it again" got the unreadable-folder
  sentence once in QA's lane, and "the agent that met the refusal is told
  it can carry on" failed once in mine. The first is not a wait running
  out: `renew()` read that window's screen as not asking
  (`p.asking = !!askingOf(screen)`, taken after the wait and before
  `kill-server`), while the test's `asking` file was still there. So the
  stand-in had not drawn the question or `askingOf` did not read what it
  drew. Neither repeated in three runs alone.
None is in code PR #57 touched. A fourth sighting of any of them is read
with its log kept (`run-mutants.mjs --logs`, or the suite's own output),
not rerun.

**A key log is read after a wait, not straight after `send()`** (QA,
PR #55 Info 9). The composer stand-in writes its log when a key reaches
it, and `send()` returns when tmux has taken the key. "which the host
closed afterwards, once" read the log at once and found no Escape in 1 of
QA's 4 window runs (load 24–84), with the composer back on the next row.
It waits for the Escape now and then counts it. A count of keys taken
straight after a send that ends on a key has the same gap. **And a count
by mode is not a count** (Info 10): the first Escape puts the stand-in
back in composer mode, so a second was logged there, and with the host
made to send two the row still read "once". It is the shape of the
effort dialog's "once", which needed a dialog that stands 700 ms: a key
log filtered by the mode a key ends cannot see a repeat. **And an absence
has nothing to wait on** (Info 11). The first fix counted the Escape in
every mode 400 ms after the composer was back, and an Escape logged
600 ms late went unseen. The row now stands at the end of the composer
section, after a dozen sends that each waited on their own receipts: every
Escape the pane took, by mode, is `btw` then `cost` and none in a
composer. When the thing to prove is that a key did not arrive, read the
whole log after later work has been observed, not after a sleep.

**A row that does something and then looks is answered by whatever tmux
says at that moment** (QA, PR #57 Info 11). "The last window of all,
closed while it is waited on" killed a pane and let `waitReady`'s next
look land where it landed. Asked about a server's last pane in the 400 ms
after the kill, tmux's first answer was empty in 27 of QA's 40 trials, a
failed call in the rest, and the two are read by different arms of the
code. So with the "no server running" arm taken out, the row still passed
one run in eight. Two things replaced the hope that it would not. The
decision is a function of tmux's answer (`paneGone`), with a row for each
answer in tmux's own words, which no timing can move. And the live row
for that arm waits until the server is gone before the look that counts.
When a mutant survives once in several runs, the row is being answered
by another path some of the time: find the second path before adding a
wait. **And count reds by what the suite printed**: `run-mutants.mjs`
read `FAIL ❌ — 2 failure(s)`, the closing line of most suites, as a
third red, from the day it learned to read `test:renew`'s `FAIL <name>`.
`--logs` keeps each run's output, so a count can be checked against it.

**Two more `test:host` reds seen once, in a mutant's run in a copy**
(2026-11-14, load 5.5, nothing else on the ports): "a turn written while
the send is still in flight reaches the floor anyway" and "the floor
gained a turn rather than replaying the transcript", both in *hearing the
desk while a message is still going in*, which waits 4 s on the relay.
The mutant was a field dropped from the host's error event, 500 lines
away. Run again beside an unmutated control, the control read 320 ✓ and
the mutant only its predicted red. The cause was not looked for.
`run-mutants.mjs --control` is how to tell such a red from a mutant's in
the same run (**mutate-in-a-copy**).

**The activity feed is newest-first, and a kind prefix is wider than it
looks.** `/api/activity` returns rows newest first, so `.slice(before)`
on it hands you the *oldest* rows; and `admin.desk.*` matches
`desk.moved` and `desk.bound` as well as `desk.hide` / `desk.show`. A
first cut of the move test asserted both ways, costmo pushed the tree
while its suite ran, and QA measured a red at that SHA (0d18a9f). Name the
kinds you mean, and find the new rows by diffing a set of the rows that
were there before — by identity, not by position or count.

**A fixture pane lives as long as its `sleep`, and the section around it
grows.** The answer-a-prompt panes end in `sleep 30`. On 2026-10-01 new cases
that each wait several seconds on a window were added above a later use of
the `talking` pane, it had exited by the time it was reached, and the refusal
under test read `no_window` instead of `no_prompt` — red for the fixture's
age, not the code. That pane now sleeps 180; give a pane used late the same.
A form that has to answer its keys (the tab walk) is a small node stand-in on
the alternate screen, `formPane` in `test/window.mjs` — a shell cannot redraw.

**The suites have a stand-in for the person, too.** `ORCH_FOLDER_DIALOG`
names a program the host runs in place of the operating system's folder
dialog — the host suite points it at a script whose answer is a file, so a
case says what "the person" does next (choose, cancel, take three seconds,
have the dialog die). It is to the dialog what `ORCH_HOST_CLAUDE` is to
Claude Code. That the *real* dialog takes the front cannot be seen by any
suite; it is measured on a desktop.

**Page logic is tested by lifting it out of the page.** `src/ui/app.js` is a
classic browser script with no exports, so `test/floor.mjs` slices a section
out between two section comments (`/* ---------- take a desk: what the
dialog reads ---------- */` and its closing twin) and imports it, the way
`test/markdown.mjs` lifts the renderer from `floor.js`. To make a page
decision testable, write it as a small pure function inside such a section
and leave the DOM code as its caller. If a slice fails, the section moved:
fix the markers, do not route around the test. What only a real page shows
— what is drawn, focused, in view — is `verify-ui-change`'s, and is reported
as measured there. There is still no browser tier in `npm test`.

**Never break the working tree to watch a test fail.** Mutation checks run
in a copy outside the repo — the **mutate-in-a-copy** skill, whose tool
refuses to edit a git checkout. The working tree is the commit surface at
every moment: on 2026-10-01 a mutation run edited `host/index.js` in place
with a restore step, the commit landed mid-run, and `8788a6d` reached
`origin/develop` with a line deliberately removed.

**A composer pane and a command-aware stand-in, since 0.10.9.** The window
suite's `composer-desk` pane (`run.cjs` in `test/window.mjs`) is a node
program on the alternate screen that draws what Claude Code draws — a
composer box, the `/btw` overlay with its answer arriving late, the
"Switch model?" warning (with `switch.flag`), the compaction spinner —
writes the records Claude Code writes (a `/model` or `/effort` line as a
user record, a refusal as a `system` one), drops the first Enter the way a
paste-consumed one is dropped, and logs every key it is sent by mode. That
log is how "no Enter after a command that opened something" and "the
warning got one key, the digit" are asserted rather than assumed. It drew
the model picker until 2026-11-14, when the host stopped driving one. The host suite's stand-in answers
`/clear` with a new session file and a roster change, `/btw` with an
overlay, and any other command with its `<command-name>` record. Neither
has a composer the way the real window does for a *typed* message, so the
typed delivery (`typeInto`) is proved on the composer pane and on a real
probe, and the plain stand-in gets a paste.

**Three fixtures from PR #55's review (2026-11-15), each for a path no
fixture reached.** The composer pane's `effort-ask.flag` makes an
`/effort` raise "Change effort level?", and that dialog stands 700 ms
after its digit, so a host that answers at every look is seen pressing
twice (the "once" in `send()`). A tab marked `deaf` in the window suite's
`previewPane` logs Enter and does nothing with it, which is the only way
`not_selected` is reached. And the host suite's `prompt.flag` takes
`preview`: a preview-layout question drawn once and never redrawn, so the
cursor stays on row 1 whatever digit is sent and the answer ends
`not_on_row`, said on the desk as "the form was not submitted". The desk's
form names a question's header `tab_title`; the first cut of that case
waited on `header` and was red at a pushed SHA (**answer-a-qa-review**).

**The host suite's stand-in can be slow to die, and can start fresh under
an id of its own, since 0.10.10** — two flag files, read the way the others
are because a pane's environment is the tmux server's (above).
`linger.flag` (ms) is read *at the hangup*, so it can be armed on a window
already open: the killed stand-in stays alive, and so in the roster, for
that long — the closing window a move's reopen used to meet (issue #24);
the suite never met it before because the stand-in died on the instant.
`fresh-id.flag` gives a window started with nothing to resume that id
instead of the constant, so "a new conversation" is an id the desk can be
seen to follow. Remove both when the case is done; the sections below
expect the constant. And **`argv.log` is one line per window started, and
a fresh one with no arguments is an empty line**: count launches with
`.split('\n').slice(0, -1)`, never `.trim().split('\n')`, which reads "no
window at all" as one launch with nothing to resume and passes a case that
should be red.

**A lingering stand-in is ended by a watchdog, and a run leaves none**
(task 263, 2026-11-03). The linger used to end on the stand-in's own
`setTimeout(process.exit)`, which never fired. After its pane's hangup, Node
reopens the dead pty (`uv_tty_init → open()`, 775 of 775 `sample`s on the
main thread), and on macOS that open never returns. So the two windows the
move case closes under the flag lived on, two per run and 105 by one
evening, parented to whichever tmux server held the suite's session: on
this machine the live one, because the suite uses the default socket. They
did not ignore signals: SIGHUP and SIGTERM each end one. A first reading
here said otherwise, from a zsh `kill $PIDS` that delivered nothing. The
linger's watchdog is a detached `sh` that SIGKILLs the pid once the linger
is up, and only if the pid is still this stand-in. The suite then counts
`node <its own FIX>/claude.cjs` after `killTmux` (scoped so a run beside it
is not counted), sweeps whatever is left, and does the same on SIGINT or
SIGTERM. Anything new that keeps a pane's process alive past its hangup
needs the same: its own event loop is not there to end it.

**A chain put in the background with `( … ) &` reports done at once.** The
agent's shell says "completed" for the command it ran, which was only the
launch, so the notification arrives with nothing to read and the suites
are still running (2026-11-16, three suites launched that way). Give the
harness the chain itself as the background command, or wait on the
process: `while kill -0 <pid> 2>/dev/null; do sleep 3; done`. And a suite
run beside your own floor suite or mutant lanes is run under load of your
making: the host suite read seven reds that way and 327 ✓ alone.

**`test:seats` is the host suite for several windows in one folder**
(0.12.9). The host suite's stand-in is one window at a time: it writes a
roster of one entry and one transcript, both named for the fixture's single
conversation, and a second window overwrites the first's. So seats have a
suite of their own, whose stand-in is what Claude Code is when several run
in a folder: each writes its own session file (the host's fast path) and
its own transcript, connects as the desk its `--mcp-config` file names (or
else the folder's), and answers every message "I AM <channel>/<agent> on
<conversation>", which is what lets a row say *which desk* a window is. It
runs on a tmux socket of its own, because it opens the session a seat's
window creates. Port 8902. It has no plugin, so what a real window's hooks
do at a close is not in it (see "One agent, several sessions": the fault it
missed). And **a row that says something "stays" proves nothing while the
thing is too young to be looked at**: "a session made by New desk here is
not a room's to close" was green on the mutant that closed it, because the
sweep leaves any session alone for its first 30 s. The row ages it first.

Three more from PR #57's round (2026-11-16), each a way a row read
something other than what it named:
- **A name the fixture uses twice carries the first use's holds.** The
  floor suite makes `quinn-3` for one room, ends the room, and makes
  `quinn-3` again. A room that ended inside 15 s still holds every session
  it lists, so the silent-room rows read "not closed" for the wrong reason
  and then "not closed" where they wanted a close. The rows age the ended
  rooms first, and say so. Before trusting a "stays" on a reused name,
  check what else on the floor still lists it.
- **A broadcast from a desk in a live room is contained, in a test too.**
  The mail rows first sent their "before" and "after" broadcasts from
  `rae`, which an earlier row had left in a live room, so nobody outside
  it heard them. They are sent by a desk in no room.
- **The floor suite restarts its board once**, on the same database, for
  the one thing only a restart shows (what a host said about seats). It
  is in the last section that talks to the server, because everything the
  board keeps in memory is gone after it. `startServer()` is the function;
  a new row that needs a restart goes beside that one, not earlier.

The seats stand-in can look mid-turn: a message containing `look busy`
draws "esc to interrupt" as the pane's last line, and `look idle` ends
it. Its last turn is still a reply, so the board takes it for idle, which
is the one case the host's own busy check is for. The floor suite runs its
board with `ORCH_TWIN_UNHEARD_MS=3000`, so the silent-room rows wait
seconds and not a minute and a half.

`test:plugin` covers the floor hook, which is the one part built to fail in
silence — `hooks.json` runs it detached with every stream sent to `/dev/null`, so
a fault there shows up as prompts quietly never reaching the floor while the
conversation keeps relaying. Most of its assertions are about what is *not* sent.
It drives `hooks.json`'s own shell line under real `sh` too, and asserts all
twelve events carry the identical command — editing one and not the rest is the
drift it guards against.
Its fixture lives in `tmpdir()`, not `data/`: the hook walks six levels up
looking for `.mcp.json`, and a fixture inside the repo reaches this repo's own —
so the "outside a repo" cases resolve against the real board and post to the
operator's live floor.

## Conventions

- **Run the suites a change reaches; the full `npm test` runs once, at the
  release.** costmo, 2026-11-16, in two steps. While building the meeting
  box: "limit tests you run during turn-by-turn development to those that
  are about code you've touched (and related)", and "I am in no way
  opposed to thorough testing … being confident that no release will pass
  without a full run." After PR #56's two rounds: "defer full suite
  testing until close to (or at) final release checks … running the full
  suite during turn-by-turn work is now causing tasks to take a very long
  time for little real benefit. If we test new + related code along the
  way, our processes make sure the full suite is covered prior to
  release." QA took the same ruling (their decisions/0015, msg 3242): the
  full chain runs once, at the SHA that ships, when he calls the release.
  So it is not run while building, while answering a QA review, while
  validating a merge or before a deploy, by you or by QA. Every one of
  those runs the suites the diff reaches, the page checks for the area,
  and the mutants that prove a new row. Long mutation batches and page
  checks that only *might* be affected wait for the release too. Write
  down what was left (beside the check, with the mutant list), and say it
  in the report. It is a rule about when, not about how much: do not thin
  a test to save a run.

  **And the full chain runs before any merge to main, unasked** (costmo,
  2026-11-17, at the end of PR #57: "When there are documentation-only
  changes, the full test suite does not need to be re-run, but it does
  need to be re-run prior to any main to merge"). QA and the developer
  both wrote "full chain not run, waits for the release" through five
  rounds, then called the PR approvable and told him the merge was his
  with the chain still unrun, and he had to ask what was stopping it.
  "Approvable" from a review of related suites is not the release check.
  So when a PR into main is approvable, the next thing done is the one
  `npm test` at the head, then the release page checks
  (`run-release-pages.sh`, **verify-ui-change**), and "approvable" reaches
  him with their results beside it, or with "the full chain is running" in
  the same sentence. A commit after that run that changes documentation
  only does not need it again; any other change does. Run the two one
  after the other, never beside QA's: QA runs its own chain too, queued
  behind yours (their decisions/0007).

- **Once a PR into main is approvable, nothing goes into the tree until he
  has merged** (costmo, the same evening: "I need for you to stop updating
  files if it is interrupting with and/or interfering with our PR
  progress"). PR #57 went from `a9fa870` to `185b4a5` over a dozen
  commits after its first close, most of them notes, skills, mutant lists
  and a facts re-anchor written into the tree as each round ended: he
  commits the tree when he sees it, and QA measures every push. A finding
  QA marks as not blocking is named to him as "after the merge", not
  started. Lessons for the repo are held and written once, after the
  merge, in one batch. The updater refuses a dirty clone too
  (`host/update.js`), so an uncommitted note also blocks his update.

  Which suites a change reaches, read from the paths each `test/*.mjs`
  names (QA's map, with two additions from that reading):

  | Changed | Run |
  |---|---|
  | `src/ui/*` | `test:floor`, and the page checks for the area (**verify-ui-change**); `test:window` and `test:markdown` also read `floor.js`, `test:update` reads `app.js` |
  | server `src/*.js` | `smoke`, `test:admin`, `test:auth`, `test:boardlog`, `test:floor` |
  | `host/index.js`, `dialog.js`, `history.js`, `log.js` | `test:host`, and `test:seats` for `index.js`; `test:floor` and `test:update` also read `index.js` |
  | `host/window.js` | `test:window`, `test:renew`, `test:markdown`, `test:seats`, and `test:host`, whose host runs it |
  | `host/seats.js`, `host/identity.js` | `test:seats`, `test:host` |
  | `src/updates.js`, `host/update.js` | `test:update` |
  | `src/uploads.js` | `test:floor`, and `test:host`, whose board runs it |
  | `host/uploads.js` | `test:host`, and `test:floor`, which reads its header |
  | `plugin/` | `test:plugin`, and `test:seats`, which runs the hook |
  | a version bump | `smoke` |

- **When the platform will not do all of it, ship the nearest thing that
  works and say what is unmeasured.** His words on the "In a meeting"
  click, where a browser decides what a page may do to a window: "I'll
  take as much as we can reasonably do … get as close to the desired
  features as possible without delaying progress." He then tried it on
  his three monitors and reported the one case that fell short, which is
  how the window-management permission was found in ten minutes. A
  headless browser could not have said. Do not hold a change for a
  measurement only his desktop can make, and do not build a fallback for
  a failure nobody has seen.
- **Git is Chris's.** Never commit, push, or offer to. Leave changes in the
  working tree; reviewing the diff is how he checks the work.
- **The tree is committed whenever costmo chooses, so an edit is not
  announced until its suite has run.** On 2026-11-02 "taking the Low" was
  posted with the fix in the tree and the window suite still running; he
  committed and pushed on that, the fix had a `ReferenceError` in it, and QA
  spent a run measuring a commit that could not pass. Say "in the tree,
  unverified" if you must say anything before the suite is green — and
  prefer saying nothing until it is.
- **The version lives in three files, so bump it with one command.**
  `npm run set-version <x.y.z>` writes `package.json`, `host/package.json` and
  `plugin/.claude-plugin/plugin.json`. They must agree — `npm run smoke` asserts
  it, along with `/health` and `/api/state` — because they did not: the plugin
  was bumped alone every time a hook changed and reached 0.6.0 while the header
  said 0.9.0. There is no way to make them read each other; Claude Code parses
  the plugin manifest off disk, so its number has to be a literal. The
  dashboard's number is the server's and comes from reading `package.json` at
  startup, so a bump needs `docker compose up -d --build` to show up.
- **You are an agent on this board, not only its author.** The protocol you are
  building is one you are also subject to:
  [`docs/multi-agent-team-playbook.md`](docs/multi-agent-team-playbook.md).
  Read §8 at least — **"nudge" is a trigger word**, not conversation. It means
  the operator can see something waiting on your channel, so poll before
  replying. Answering "nudge" with acknowledgement instead of a channel check is
  the most likely way to look broken while working perfectly.
- **A poll that comes back empty is not the end of a nudge. List the tasks.**
  Work is assigned as a task, and a task is not a message: `poll_messages`
  returned nothing on the nudge that carried issue #4, and the assignment
  was sitting in `list_tasks`. Do both, every time.
- **Your channel is the binding's, so leave it out of every call.** The
  connection's headers already name your channel and agent (`whoami`
  says which). A `channel` passed to a tool overrides them, and a wrong
  one fails silently. On 2026-11-04, after a context reset, a summary
  said "orchestratinator", and polls and posts named that instead of
  `appideas-mcp-orchestratinator`. Each poll came back empty, two posts
  went to a channel nobody reads, the first post created a new floor on
  the live board, and a deploy task sat unread until costmo asked about
  it. So call `whoami` first after a reset, and pass no `channel` or
  `agent` unless you mean another one. List with `status: "open"`: with
  `mine: true` the done tasks come back too, and on this channel that
  ran past the tool's output limit.
- **The board keeps each agent's cursor, and another machine's board
  keeps its own.** `agents.poll_cursor` (one row per channel and agent)
  is the last message delivered to that agent. That row, against
  `MAX(id)` of `messages`, settles any doubt about whether an agent is up
  to date. Read it read-only, inside the container. Message ids count up
  on each board separately, so a cursor remembered from a board on
  another computer is a number from a different sequence. A remembered
  cursor above this board's newest id is one of those. Polling here from
  it would skip everything below it.
- **Post, poll, then build.** When a task says to post a result before
  building on it, the post is where the operator rules — so poll after
  posting and before the first line of the build, and again at each phase
  boundary of a long task. A ruling on the folder picker sat unread for
  twenty minutes behind a build that had to be taken back out. A claim
  lapses fifteen minutes after it is made (`CLAIM_TTL_MINUTES`), working or
  not, and reopens; re-claim when a listing shows it open.
- **What needs the operator's call goes to the QA desk, not to him.** His
  standing rule since 2026-10-01: decisions, go-aheads and "which do you
  want" are sent to `appideas-qa` on the board with the options and the
  measurement, and come back as a task. He answers permission prompts in
  your window and can type to you whenever he likes; he is not to be left a
  question at the end of a turn in each of several windows. A ruling or a
  deploy go-ahead that arrives as a task "from costmo, through appideas-qa"
  is his.
- **That playbook is written for the agents who *use* this tool, and you are the
  one who builds it — so the last fifth of it is not about you, and where the
  two disagree this file wins.** It sits in `docs/` as the public worked
  example the README hands to new operators, which is why it closes with "your
  job is the product in front of you, not the dashboard behind it". Yours *is*
  the dashboard behind it. Four differences follow, and each has looked like
  misbehaviour at least once:
  - **Being seated on a channel is not being given its product.** You are on
    other teams' channels to watch real traffic and to test tools against live
    agents. So a binding you do not recognise is ordinary and needs no
    explanation — and it is not an invitation either: that channel's work
    belongs to its own specialists, and your lane is the orchestratinator.
  - **Reading traffic not addressed to you is sometimes the job.** The playbook
    tells an agent to drop what is not theirs, and for them that is right. You
    are also the instrumentation. Faults like "the floor showed the agent
    answering a question nobody could see being asked" are *only* visible in
    somebody else's live conversation. Read it to diagnose; never as grounds to
    act in their repo.
  - **Traffic you generate may be a test rather than work — say so in the
    message.** An exchange staged to prove delivery works is indistinguishable
    from a real request at the far end, and an agent that acts on your fixture
    has been handed work by a test harness.
  - **State on your own desk may be a fixture too** — claims, counts and prompts
    left by an interface test. Name them rather than clearing them; they may be
    the thing being demonstrated.

  What does not change: git is still his, you still write in this repo, and
  every measured rule above still binds you.
- **Errors state what is observed, never a guessed cause.** A message that named
  one likely reason for a stalled window sent two people after a dialog that was
  not on screen while the real prompt sat there unread. Quote the pane.
- Comments here explain *why*, especially where the obvious approach was tried
  and failed. Several say so outright. Preserve that when editing near them.
- **A deliberate omission needs its reasoning written down, or it reads as
  backlog.** This is the one that costs the most, because it costs it again
  every session: an agent meets a gap, makes the same reasonable guess about
  why it is there, and offers to fill it. Saying "this is deliberate" is not
  enough — what stops the question is showing that the failure mode being
  imagined does not occur. `ANSWERS` in [`host/window.js`](host/window.js) is
  the worked example: it says both why the host will not answer a trust
  question *and* what happens to a desk stranded on one — since 2026-09-03
  the question is read off the pane and offered on the floor, row for row,
  and the host presses only the row the person picked (`startupQuestionOf`,
  `answerStartup`). Its earlier claim that no desk could arrive cold was
  wrong twice over (a VS Code session defers the MCP approval; re-pointing
  `.mcp.json` invalidates it), and the note now says so. Write the second
  half. If you find yourself asking "is now the time to do this?" about
  something with no note beside it, the answer may well be no — and the fix is
  a paragraph, not a feature.

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
*selects* on a single-select, *toggles* on a multi-select, the free-text row
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

- **A line in the composer that nobody typed is a prompt suggestion.**
  Claude Code 2.1.300 draws a suggested next prompt as ghost text after a
  turn ends — dim (SGR `2m`), after the cursor, which stays at column 2
  right behind the `❯`; typed text is in the default colour with the cursor
  at its end. Ten of twenty-one idle windows on this machine held one on
  2026-11-02, and three of them were reported as "typed into the composer
  and never sent" with no record anywhere, because nothing had entered
  them. `composerOf` reads a suggestion as the composer's contents, and that
  is harmless where the host uses it — the paste check wants the composer to
  *change*, the stuck check looks for the *sent* text — and measured on a
  probe, a paste through `send()` replaces the suggestion: one user record,
  the host's own words, nothing of the suggestion in it. Tab or Enter in
  such a window would accept it. Before chasing a phantom keystroke source,
  read the row with `capture-pane -e` and the cursor with `#{cursor_x}`.

`answer-the-form.mjs` in that skill answers a floor form and records the pane, so
none of this needs the operator to sit and click.

## A question on the floor

Four rules for an AskUserQuestion, from issue #7 (2026-10-01, measured on
2.1.284). Each is the opposite of what the code did the day before, and each
had a reasonable argument behind the old way — which is why they are here.

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

`form.mjs` in **measure-a-real-window** raises a real form on a probe window,
reads it both ways, and answers it through the host's own code.

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
- **A model or effort change from the floor is this session's only**
  (costmo, #10 Decided 4). `/model <name>` and `/effort <level>` as commands
  write the person's machine-wide default (`~/.claude/settings.json`
  `model`, `modelSettings.<model>.effortLevel` — "saved as your default for
  new sessions"); the probe changed the operator's and they had to be put
  back by hand. The window's picker has `s` for this session only, so the
  host drives it (`pick`): `/model` + Enter, ↑/↓ to the row (a digit
  SELECTS and starts the switch, so digits are never pressed), ←/→ along
  the effort row, `s`, and `1` on the "Switch model?" cache warning. The
  chat route refuses a bare `/model` (a picker nobody is driving) and an
  effort level the picker has no row for; the page offers both as controls
  and shows asked-for beside confirmed until the window confirms —
  PreModelSwitch/PostModelSwitch, the stdout record, and the `model` on the
  transcript's next reply, which is how the header follows a `/model`
  typed into the window.
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
  "/model opus — Set model to Opus 5.5 for this session only".
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
else. The mode stays on after an action, with the checks kept, so the
actions chain, and only a second Nudge while one is still in line is
refused. Mark read shows its count on the control before it runs.

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
**Nudge** beside Send is "nudge all": it nudges whoever the To chips
choose, with the unread count in its label (`meetingNudgeChip`), as one
room message with each desk's delivery under it.

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

Left out on purpose. **Model and effort controls**: a desk's select drives
its window's picker, so a room would need one per desk; `/model sonnet`
narrowed to one desk takes the same route. **A reading view**: History
reads a meeting desk in the floor's panel, because reading types into
nothing (renderPanel's `outMeeting` branch). **Audit rows**: a room is a
window arrangement, like a popout, and popouts write none; the reopens a
Resume makes write their own `desk.reopen`. **`meeting_rooms` in backups**: it names
sessions on disks that may not be this machine's. `check-meeting.mjs` in
**verify-ui-change** drives all of it.

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

Not measured: a real update end to end on the live board. It replaces the
board's container and restarts the live host, which is costmo's to call;
every step was run against real git and real processes with stand-ins for
`docker` and `claude`, and the two Docker halves (the image recording its
commit, and the host finding the live container from launchd's
environment) were each run for real.

## Tests

`npm test` runs eleven suites. `test:host` and `test:window` are not unit tests:
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
strings and always equal. Use `shasum`.

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
composer box, the `/btw` overlay with its answer arriving late, the model
picker with its effort row, the compaction spinner — writes the records
Claude Code writes, drops the first Enter the way a paste-consumed one is
dropped, and logs every key it is sent by mode. That log is how "no Enter
after a command that opened something" and "two Downs then `s`, never a
digit" are asserted rather than assumed. The host suite's stand-in answers
`/clear` with a new session file and a roster change, `/btw` with an
overlay, and any other command with its `<command-name>` record. Neither
has a composer the way the real window does for a *typed* message, so the
typed delivery (`typeInto`) is proved on the composer pane and on a real
probe, and the plain stand-in gets a paste.

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

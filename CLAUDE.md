# Working in this repo

Orientation for an agent that has not been here before. The README explains what
the orchestratinator is and how to install it; this file is the handful of things
that are easy to get wrong and expensive to re-learn.

## The one rule everything else follows from

**A conversation is one `claude` process, so one app holds it at a time.** Not a
document two windows can share. The floor shows who holds a desk, and moving it
is an explicit handoff: "Open in VS Code" ends the desk's Claude Code and opens
the conversation in the editor; "Open in Claude" ends it and opens a terminal of
the operator's own running `claude --resume <session>`; the floor's next message
takes it back once that app has let it go.

**The floor's own Claude Code has no screen** (costmo, 2026-11-22). Each desk's
Claude Code is a process the host runs and speaks to as data, through Claude
Code's programmatic interface: `claude -p --input-format stream-json
--output-format stream-json --verbose --permission-prompt-tool stdio
--replay-user-messages` ([`host/agent.js`](host/agent.js),
[`host/desk.js`](host/desk.js)). It replaced a layer that ran each desk in a
tmux window and read and typed into its screen, which broke every couple of
days as Claude Code updates moved screens (`docs/robustness-review.md`). One
system, no switch, no tmux anywhere: his words were "I don't want 2 systems,
more complications and more user choices." Do not propose bringing tmux back,
for this or for anything else, and do not propose a per-desk choice between
the two. How it was measured before it was built is
[`docs/stream-json-spike.md`](docs/stream-json-spike.md); how it works is
"How a desk runs Claude Code", below.

**So "Open in Claude" is a handoff, and that was ruled with its cost**
(costmo, 2026-11-22, by AskUserQuestion: "Accept it"). With nothing to attach
to, the terminal runs its own Claude Code on the conversation. Closing that
terminal while a turn runs stops the turn; the conversation is on disk, and
the floor resumes it with its next message. The September rule that made this
button an attach to the floor's window ("not a third seat", validated
2026-09-01) is reversed by this, not forgotten: it protected a turn from a
closed terminal, and that is the price accepted for no tmux.

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
on its first line. `resumable()` in [`host/claude.js`](host/claude.js) checks
the disk before handing an id over (a desk's own resume and every reopen),
falls back to the conversation with the latest spoken turn (as
`readTranscript` files it — a tab holding only `/resume` and its output is not
one) that no seat runs, and says so on the floor as a line labeled `host`. And
Claude Code's daemon keeps a conversation running after its tab has closed:
`kind: bg` in the session file, `claude bg-spare` in `ps`, "running as a
background session (<job>)" when resumed. The watch follows interactive
sessions only, so such a desk reads as empty — and a message or an open from
the floor does the move: the host runs `claude stop <job>` itself, waits for
the roster to drop it, resumes the conversation in the desk's own process and
says so on the desk (`releaseBackground()` in `host/claude.js`, called from
`Desk.ensure`). That is the one thing the host does on the person's behalf,
and the reasoning is beside it: the click is the handoff and there is no tab
of theirs to close, `stop` keeps the conversation in Claude Code's own words,
and the version that told a partner to run `claude stop` themselves stranded
a working channel for an afternoon. The first cut of the process layer
refused such a conversation with "close it there", which was that stranding
again; it was put back the same day. **A remedy is never handed to the
operator as a command.** If the floor can name it, the floor runs it on the
click.

State lives in two places, and they must agree:

| What | Where | Read it with |
|---|---|---|
| Which Claude Code processes are alive, on which conversation | Claude Code's roster | `ls ~/.claude/sessions` (one file a process) or `claude agents --json` (slow) |
| Who the board thinks holds it | the server | `curl -s localhost:8787/api/floor` |

The host knows which roster pids are its own desks' processes
(`Host.ourPids()`), so the join is direct: a conversation's process that is a
desk's own is `held: 'floor'` (its `window` reads `proc:<pid>`), and any other
interactive process on it, an editor tab or a terminal, is `held: 'editor'`
(`outside_pid`). `holders` counts every live process claiming the
conversation; above 1, see above. `window_open` is still in the payload and
means only that the desk's process is running.

## How a desk runs Claude Code

[`host/agent.js`](host/agent.js) is the protocol and the process,
[`host/desk.js`](host/desk.js) is one desk, and `handle()` in
[`host/index.js`](host/index.js) is the floor's side. What each piece rests
on was measured on 2.1.330 before it was built
([`docs/stream-json-spike.md`](docs/stream-json-spike.md), both spikes).

- **The command line** is `agentArgs()`: `claude -p --input-format
  stream-json --output-format stream-json --verbose --permission-prompt-tool
  stdio --replay-user-messages`, with `--resume <id>` for a conversation and
  `--mcp-config <file>` for a seat. It is started through the person's
  shell, `<shell> -c 'exec "$0" "$@"' claude …` (`shellFor()` in
  [`host/claude.js`](host/claude.js)), because that shell's startup files
  are part of what Claude Code has: a credential exported in `~/.zshenv`
  was otherwise missing (F1 of the 0.14.5 review). `exec`, so the pid is
  Claude Code's own. On Windows there is no shell around it. Its
  environment is `agentEnv()`: a person's own and nothing of the host's
  settings (`windowEnv()`, "The clear of 2026-11-20"), plus the board's key
  where the binding names a variable for it, and a seat's four variables.
- **A desk never runs in Claude Code's `default` mode unless the person
  chose it** (costmo, 2026-11-23, the day 0.15.0 ran his `auto` desks in
  `default` and they asked about every tool: "'Default' from our
  perspective is, and ALWAYS will be, 'DON'T ANNOY THE SHIT OUT OF THE
  OPERATOR OR MAKE THE TOOL UNUSEABLE'"). `Desk.modeFor`, in order: the
  mode the conversation was left in, when an interactive session chose one
  (its last `permission-mode` record, `conversationMode` in
  `host/claude.js`, other than `default`, which an interactive session
  writes whether anybody chose it or not; a `-p` process writes no such
  record); else the person's `permissions.defaultMode` (folder
  `settings.local.json`, folder `settings.json`, user `settings.json`:
  `settingsMode`), passed as no flag so Claude Code applies it itself;
  else `--permission-mode auto`, for a new conversation, a resumed one, an
  unreadable transcript and a brand-new user alike. When `auto` is not
  available, Claude Code falls back to `default` and says so only in a
  `status` record at startup (2.1.331, auto disabled); the host then
  switches it to `acceptEdits` (`set_permission_mode`) and says so on the
  desk (`noteMode`). Measured on 2.1.331: each mode as a `-p` flag,
  `bypassPermissions` included; init `default` without a flag.
- **A new conversation is named when its process starts, not at its first
  message** (same day: New session spun for ever). `init` comes only with
  the first message, so the host reads the id from the process's own roster
  file (`sessionOfPid`, `Desk.learnNewId`), there within milliseconds of the
  start (measured on 2.1.331, nothing sent), and reports it, which is what
  the floor's New session waits on.
- **A desk's model and effort are said before its first message**
  (costmo, 2026-11-24: on a new session the floor's model and effort
  selects read "model…" and "effort…" while chat ran on his defaults).
  `init` waits for the first message and carries no effort, so as soon as
  a desk's conversation is named the host asks Claude Code's `get_settings`
  control, which answers with nothing sent: `applied.model`
  ("claude-opus-5-5") and `applied.effort` ("high"), measured on 2.1.331
  in 0.9 s. The host reports them as a `model` event carrying `effort`
  (`Desk.noteSettings`), and asks again after a /clear names the next
  conversation and after a /model, since effort is kept per model. An
  answer that names neither (an older Claude Code) says nothing, and the
  selects fill from the first reply as before. On a real 2.1.331 desk, a New
  session's selects read Opus and high 0.9 s after the click.
- **Nothing runs until something asks for it**: a message, Open on the floor
  (`open` work), a take or a move (unless it says `open: false`), a pick in
  Sessions (`reopen`), a new seat. One process a desk (`ensure`). A host
  that restarts starts none; each desk's conversation is resumed at its
  next message.
- **A message is delivered when Claude Code takes it.** The host writes a
  `user` record with a uuid, and Claude Code answers `command_lifecycle`
  with that uuid as `command_uuid`, `queued` then `started` and
  `completed`, the moment it has the message (2 ms in the probe, idle or
  mid-turn). That is the receipt; none within 30 s (`TAKEN_TIMEOUT_MS`) is
  "not delivered". The `isReplay` echo of the record is kept as a second
  receipt, and is not enough alone: it comes when the message is written
  into the conversation, which for a reply that uses no tool is the turn's
  end, so a long reply read as "not delivered" (found by the floor e2e,
  2026-11-22). A message sent while a turn runs is folded into that turn,
  and the host emits `delivery: queued` for it. **A message sent while a
  permission or question stands is held, not refused** (F17, costmo
  2026-11-23: with prompts several a second, a refused message never
  reached the desk). The host writes it at once and says `delivery: queued,
  held: 'asking'` ("held — it reaches the desk once you answer…"); its
  receipt clock starts only when nothing is asked (`armHeld` in
  `host/agent.js`). Measured on 2.1.331: written while a Write permission
  stood, it was `queued` in 1 ms, `started` 32 ms after the answer, and the
  reply answered both messages.
- **The host says when a turn starts and ends** (`state` events: `working`
  at `init`, `idle` at `result`). The board takes them for the desk's
  state, never over a standing host ask, and idle ends a compaction. Event
  batches go to the board one at a time (`flush()` is chained), so a
  turn's events arrive in order.
- **`/clear` names the next conversation by its `init`, not its reset.**
  `conversation_reset`'s `new_conversation_id` is not the session id; the
  following `init` is, and only that one has a transcript. A `/clear` sent
  mid-turn is applied after the turn.
- **What Claude Code asks arrives as data.** A permission is a
  `control_request` `can_use_tool` (tool, input, description, and the
  "don't ask again" rules as `permission_suggestions`). The host says it to
  the board as an `ask` event with the rows of `permissionRows()`: Yes,
  "Yes, and don't ask again for <rule>" (only when Claude Code offered
  one), and No. The answer comes back as data (`permission` work: a row's
  number, or allow, deny, cancel). Allow returns the input unchanged, the
  second row also returns the suggested rules, No is a deny carrying the
  operator's reason, and Cancel is a deny followed by an `interrupt`. An
  AskUserQuestion is the same request: the board builds the form from its
  questions (`formFromInput`) and sends the answers back as `{ question:
  answer }` (`answersForTool` in [`src/floor.js`](src/floor.js)), which the
  host returns as the tool's input with `answers` added. Typed words are an
  answer of their own; nothing is withdrawn. The plugin's permission hook
  does not raise the same request a second time. Every standing ask is said
  again at each heartbeat (`standingAsks`), so a board that restarted
  raises it again, and said `gone` when the process that asked has ended.
- **A desk can have several prompts open, and the floor shows them one at
  a time** (task 352 A, costmo 2026-11-23, from his first session on the
  PC: "it just looked a little broken"). Claude Code asks for parallel tool
  calls and for a subagent's tools beside its parent's, and the board held
  one prompt a desk: each new one took the last one's place, and answering
  the one shown left the composer free for a message the host then
  refused. `live.pending` is an `AskMap` in `src/floor.js`: `get` is the
  oldest prompt still open, with `more` counting the rest; a host's ask is
  `add`ed behind it; an answer `shift`s the next forward (said at once,
  `showNextAsk`), a withdrawal or `gone` `remove`s that one wherever it
  stands, and `delete` still drops all of a desk's (it left, its host went
  offline). A message while any stands is taken and held by the host (F17,
  above); the bell, Nudge and a room's notices still wait, naming how many
  (`askingWhy`). A subagent's `can_use_tool` carries `agent_id` and the
  conversation's own does not (measured on 2.1.330); the host reads the
  subagent's description from its meta file (`subagentLabel` in
  `host/claude.js`) and the box says "asked by the subagent …". On that
  run, three parallel Bash calls asked one at a time, each after the last
  was answered; his session saw four within 1.7 s, which is what the queue
  is for either way. Two faults QA found on a real 2.1.330 at patch E, a
  parent and a background subagent each asking, are rules now. **On a
  desk whose own Claude Code the host runs, a hook never raises a
  prompt** (`hostAsks` in `ingestHookEvent`): a subagent's
  PermissionRequest fires there, and its prompt stood in front of the
  host's ask for the same tool, answered into nothing. And **a turn's end
  clears only the conversation's own leftover asks** (`result` in
  `host/agent.js`): a background subagent asks after its parent's turn
  has ended, and clearing it left the subagent waiting for ever on a
  prompt nobody could see. A host ask is never dropped by a prompt set in
  front of it either (`AskMap.set` puts it behind).
- **The board's own tools ask nothing in a folder the floor took** (task
  352 B, costmo 2026-11-23). Every bind (take, import, move, release)
  writes one rule, `mcp__orchestratinator`, into the folder's
  `.claude/settings.local.json` (`allowBoardTools` in `host/mcp.js`), and
  Leave removes it. Measured on 2.1.330, a -p desk on a scratch board:
  with no rule, whoami and list_tasks each raised `can_use_tool`; with
  `mcp__orchestratinator` or `mcp__orchestratinator__*`, neither did. What
  the host added is kept in `board-tools-allowed.json` beside the desk-pid
  record, so Leave takes away only that: a rule the person wrote is never
  removed, and a file the host made for it alone goes with it. A settings
  file that is not JSON is left as it is, and the desk's board tools ask.
- **Four first-session faults found only by walking the real app**
  (costmo and desktop-dev on a fresh `newop` scratch app, 2026-11-23, every
  suite green before each). Each is a rule now:
  - **A host ask keeps the needs-you mark.** The host Claude Code's own
    PreToolUse fires for the very tool it asks about, and its hook cleared
    the mark on every ask: the desk read idle, "0 need you", with Approve
    only inside its panel. A hook in CLEARS_AWAITING leaves the mark while
    the shown prompt is a host ask, and a heartbeat's re-said ask puts a
    cleared mark back (R10).
  - **A host ask has a box signature of its own** (`drawAlert` in
    `src/ui/floor.js`). Keyed on the mark alone, a box drawn with no mark
    had signature '', so it was never redrawn: an answered ask stood on the
    panel until a reload, and a new one was not drawn at all (F14). An empty
    bold kind before the dash ("— WebSearch…") on a screenshot is this.
  - **Sign in stands over an error.** The turn that finds a desk signed out
    stands as awaiting 'error' (`authentication_failed`), and any awaiting
    kind hid the box. A prompt outranks Sign in; an error does not. The
    turn and the box say `SIGNED_OUT_WORDS` (host/claude.js and src/floor.js,
    one string), never Claude Code's "Please run /login": a remedy is never
    a command, and /login cannot run on a desk the host runs.
  - **The canary's own MCP server runs on a real Node** (`probeNode` in
    `host/canary.js`). Under the desktop app `process.execPath` is
    Electron's helper with RunAsNode off, so the probe's reconnect read
    "Connection closed" and every app launch showed a 31-of-32 banner. It
    runs on `~/.orchestratinator/bin/node`, else `node` on PATH.
- **Anything else Claude Code asks is declined and said on the desk** (the
  `ask` handler in `desk.js`). A dialog it would have drawn arrives, by the
  binary, as `request_user_dialog`; that has not been measured. Declined so
  the turn is not held for ever, and said with the request so it is not
  silent.
- **Commands** (`commandPlan` in `desk.js`): `/model <name>` is the
  `set_model` control request and `/effort <level>` is
  `apply_flag_settings`, each also saved as the default for new sessions
  (below); a bare `/model` or `/effort` is refused in words. `/btw` is
  `side_question`, its answer posted as a turn `via: '/btw'`. A bare `/mcp`
  or `/mcp reconnect` is `mcp_reconnect` for the desk's own server name, and
  `/mcp reconnect <name>` for that one. Everything else, `/compact`,
  `/clear` and `/cost` included, goes as a message: a compaction comes back
  as `status: compacting` and its result, and `/clear` as
  `conversation_reset`, after which the desk follows the conversation the
  next `init` names, from its first word. A command's receipt is one line labeled `host`: what
  was typed, then what happened.
- **A model or effort change from the floor is also saved as the default
  for new sessions** (costmo, 2026-11-22, by AskUserQuestion: "Also save as
  default", keeping his 2026-11-14 ruling that the floor does what the
  terminal does). On this path Claude Code makes the change for the one
  conversation ("for this session only", settings untouched, measured on
  2.1.330), so the host writes `~/.claude/settings.json` itself
  (`saveDefaults` in `claude.js`): `model`, and
  `modelSettings.<model id>.effortLevel`, nothing else, written to a file
  beside it and renamed over it. When it cannot, the line says "for this
  conversation; not saved as your default" and why.
- **The stop sign is the `interrupt` control request, and the board's
  `reconnect` work is `mcp_reconnect`** (`Desk.reconnect`), said on the desk.
- **Who holds the desk** (`Desk.report`): `floor` while the desk's process
  runs, with `window: proc:<pid>`, the mark the board has always read as the
  floor holding it; `editor` when another process in Claude Code's roster
  is on the desk's conversation, a terminal's or an editor's; `holders`
  counts them. A conversation another process holds is never resumed beside
  it: `ensure` refuses (`held_elsewhere`, with the pid). While the desk runs
  nothing, a conversation taken up in its folder by a terminal or an editor
  is followed, so what is said there reaches the floor. "Open in Claude"
  (and an older page's `attach`) ends the desk's process and opens the
  person's terminal on `claude --resume <id>`; "Open in VS Code" ends it and
  opens the editor.
- **A process that exits on its own is said on the desk** (`agent_exited`,
  with Claude Code's last stderr lines), and the next message starts it
  again. Stopping the host ends every desk's process: its input is closed,
  then SIGTERM after 5 s (`STOP_GRACE_MS`) and SIGKILL after 10 s if it has
  not left. The conversation is on disk.
- **An upgrade from 0.14.x leaves each desk's tmux window running, and the
  new host ends it** (task 341 C1, measured 2026-11-22 on a real 0.14.5
  board and host replaced by 0.15.0, on a private tmux socket). The old
  host's windows outlive it, their `claude` holds each desk's conversation,
  and the 0.15 host read every desk as held by an editor: Open on the floor
  said "Quit it there first" about a window in a detached session nobody
  could see. So at its start, and on each watch tick while any is waiting,
  the host ends every interactive Claude Code in one of its desks' folders
  whose roster entry names a pane of the legacy session (`tmux: "orch:@N.%N"`,
  as 2.1.330 writes it; `ORCH_TMUX_SESSION` if set), or that `tmux
  list-panes` shows in that session, and says it on the desk
  (`endLegacyWindows` in `host/claude.js`, `Host.sweepLegacy`). **One
  mid-turn (`status: "busy"`) is left to finish**: on this machine the
  desktop app runs its agents in exactly such windows, so the app's update
  is started while agents work, and cutting a turn off was not acceptable.
  Until its turn ends the desk reads as the floor's (`window:
  legacy:<pid>`), not an editor's, and a message is refused
  `legacy_busy` in words. A window in any other folder, any other session,
  and a machine with no tmux are left alone. On Windows (psmux) the roster's
  `tmux` field has not been measured; the `list-panes` path is the fallback.
- **A host that dies without its stop does not leave a desk running**
  (task 340, desktop-dev's measurement on 2.1.330). A Claude Code whose
  input closes finishes the turn it is in first: 38 s more on a 41 s tool
  call, with nobody listening, and the next run then met its conversation
  held by a process it did not know (`held_elsewhere`, "close it there":
  a remedy handed to the operator for the host's own leftover). So the host
  keeps its desks' pids in `desk-pids-<host id>.json` beside its
  `host.json` (`~/.orchestratinator` for a launchd host, the app's profile
  for the app's, as the seats and uploads are) at each start and exit (one
  file per host id, so two hosts never touch each other's), and its next run ends any
  that `ps` still shows as a Claude Code on the stream-JSON path before it
  does anything else (`endLeftoverDesks` in `host/claude.js`); a pid since
  reused is left alone. A host exiting on an uncaught error ends its desks
  in `process.on('exit')`. Not on Windows, which has no `ps` to tell a
  reused pid apart: there a leftover still finishes its turn and leaves.
  The measurement of the three ways a host goes (SIGTERM, input closed,
  parent killed) is the app repo's `scripts/probe-desk-stop.mjs`
  (`term | eof | parentkill`, its real-machine-proofs skill). The sweep
  itself is held by `test:host` on a stand-in; it has not been run against
  that probe on a real Claude Code.
- **The floor wakes a desk that has work waiting and no Claude Code
  running** (task 350, costmo 2026-11-23: the coordinator was down five
  and a half hours with five tasks waiting, and nothing started it).
  `wakeDue` in `src/floor.js`, run on the board's five-second timer beside
  `reconnectDue`: a desk with unread board messages or an open or claimed
  task, no process (`window_id`) and nobody else holding it
  (`outside_pid`), that the board would message (`deliverable`), not hidden,
  archived or asking, gone for `WAKE_AFTER_MS` (60 s), is sent the bell's
  word with its work named (`wakeText`: "nudge — the floor woke you: 1
  unread message waiting for you on the board…", QA L4: the word alone left
  an agent whose brief does not define it with its mail unread) and `woken`
  counts, and the host says "woken by the
  floor: 1 unread message" on the desk. Once per piece of work (the newest
  unread id and the task ids): a desk that came up is not woken again for
  the same backlog, only for something new. A start that never came up is
  tried again after 5 min, three tries, then said once as an error turn.
  One wake a host every 15 s, so a restart does not start every desk at
  once. Measured on a real 2.1.330: a message to a desk with no process,
  woken 13 s later on a 10 s grace, on its own conversation. On the app's
  board the morning it was built, 4 hosted desks and none would wake (all
  running); after the 0.15 upgrade ends their tmux windows, any with unread
  work would.
- **The host checks each new Claude Code version with the protocol probe**
  (task 351, costmo 2026-11-23: "Orchestratinator breaks every time
  anything comes in even with the slightest difference from before"). The
  checks are `host/canary.js` (`protocol-probe.mjs` in
  **measure-a-real-window** is a wrapper that prints them). `canaryCheck` in
  `host/index.js` runs them once per version it has not checked, in the
  background, in a kept folder beside `host.json` (so Claude Code's project
  list gains one entry, not one a run), and keeps the result in
  `claude-canary.json` there. It is said on every desk, sent as a `canary`
  event, and said again at each registration; the board puts a host whose
  probe differed, or could not run, in a banner at the top of the floor
  (`drawCanary`, **check-canary.mjs**). Desks are never held by it. A
  machine signed out is not probed; a probe whose first message does not
  come back is "could not be checked", kept, and not run again for that
  version. Measured on a real 2.1.330 host: 54 s, 32 of 32, a line on each
  desk; and by pc-developer on Windows, 56 s, 32 of 32. **The probe runs in
  `default` mode whatever the person's settings say** (`permissionMode:
  'default'` on its Agent, 0.15.1): its rows measure a permission being
  asked, and with `defaultMode: auto` in the settings nothing asks, so
  every new version would have read as Claude Code having changed
  (measured on 2.1.331: settings auto and no flag, init auto). The suites set
  `ORCH_CANARY=off` for every host they start, and `ORCH_TMUX` to a tmux
  that does not exist (a mutant of the legacy sweep once ended the
  operator's own agents' windows through the real one).
- **On Windows**, an npm install's `claude.cmd` is run through `cmd.exe /d
  /s /c` with each argument quoted (`spawnPlan`, `winQuote` in
  `host/agent.js`; task 348 F7), and a desk is stopped with `taskkill /T
  /F` so its tool's tree goes with it (`Agent.kill`, F5). One process
  escapes: one Git Bash's `exec` has already detached from Claude Code's
  tree (pc-developer, measured; a Job object would reach it, not built).
  The supervisor (`host/supervise.mjs`) holds a one-per-user lock (a named
  pipe) and stops the host when the process that started it is gone, which
  is what Task Scheduler's End does to it (F3). **Every console program
  the host starts carries `windowsHide: true`** (0.15.2): under the
  desktop app the host is a utility process with no console, so a child
  without it opens a console window of its own, and `claude auth status`
  runs at every heartbeat. The Docker install's host runs under
  `conhost --headless` and never showed it. The exception is `wt.exe`
  (Open in Claude), which is meant to be seen. A new spawn in `host/` takes
  the flag; it does nothing off Windows, so only the PC can prove it.
- **Claude Code's own records are never somebody's words**: a `<synthetic>`
  assistant record is a `context` line labeled `synthetic` ("No response
  requested."), "[Request interrupted by user…]" is a `context` line
  labeled `interrupted`, and a command output that is only the plugin's
  hook command echoed back is not shown (`readTranscript`). A turn the
  host's stop cut off is said on the desk, and the stop reads every
  transcript once more before its last flush, so a reply written just
  before it still reaches the floor.
- **The relay still tails the transcript** (`Desk.watch`, `readTranscript`,
  each subagent's file), on its own loop, so the floor shows what was said
  whoever said it. The desk's own process is in the roster while it runs
  (`kind: interactive`, `entrypoint: sdk-cli`).
- **No trust question and no MCP approval are asked on this path**, in a
  folder never trusted or with a project `.mcp.json`. Choosing the folder
  on the floor (Take a desk) is the consent. The first interactive Claude
  Code a person opens in such a folder asks the trust question once.
- **The protocol is 2** (`"protocol"` in both `package.json` files): the
  `ask` event is new, and answers reach the host as data, which a
  protocol-1 host would read wrongly (`protocolRefusal`).

**Two scripts prove it on a real Claude Code**, in
**measure-a-real-window**: `protocol-probe.mjs` (does Claude Code still
speak what `host/agent.js` reads; scratch folder, haiku, the operator's
settings.json hashed before and after) and `floor-e2e.mjs` (the floor's
routes end to end on a scratch board and a dev host). Run both after a
Claude Code update that changes anything on this path.

The skills written for the window layer open with what changed:
**measure-a-real-window** starts with the process layer's tools (the two
scripts above, a one-liner for a record order, signed out without signing
anyone out), **diagnose-handoff** with reading a desk's process, and
**watch-the-window** says what it no longer covers. Below those openings
they still describe tmux, which holds for an interactive Claude Code only.
Other skills mention tmux in passing (verify-ui-change, capture-a-burst,
measure-the-desktop, recover-a-lost-record).

## Three boards, one of them ours

Desks on this machine point at three different servers. **Only
`http://localhost:8787` is in scope.** `http://10.0.42.120:8787` is Chris's own
server and `https://appideas-mcp.ngrok.dev` is a tunnel — do not test against,
register with, or read from either. Most discovered desks point at 10.0.42.120,
so `[host] skipping <desk> — its board is http://10.0.42.120…` is correct
behaviour, not a fault. The host pins its board with `url` in
`~/.orchestratinator/host.json`; when desks disagree and nothing pins it, the
host refuses to start rather than guess.

**That paragraph is the launchd host's, and this folder's own window is no
longer on that board** (read 2026-11-19). Since costmo moved his work into
the desktop app (2026-11-08), this folder's binding in local scope is
`http://127.0.0.1:6724/mcp`, the app's own board, as `coordinator`, and the
app's agent is bound there too. So `whoami`, every poll and a meeting room
are on 6724, and `localhost:8787` is the Docker board the live clone runs,
with the launchd host: still never built, restarted or tested against from
here. A third board in a round is a scratch one of your own. Read the
binding, never assume it; the one-liner and the table are in
**catch-up-the-desktop-app**. And when costmo restarts the app, every
agent's orchestratinator tools go with its board (`ECONNREFUSED`) until he
runs `/mcp` in each window: read the board with curl meanwhile, and say so.

## The live instance runs from its own clone, and this one is for development

costmo's ruling, 2026-11-18, by AskUserQuestion through appideas-qa, when
the desktop app's work went back to `develop`: **the operator's live
instance (the board on `localhost:8787`, its host, and the plugin's
marketplace) runs from a second clone pinned to `main`,**
`…/appideas-site-dev/orchestratinator-live`. **This folder,
`…/appideas-site-dev/appideas-mcp-orchestratinator`, is the development
tree**, on `develop`, the 0.14.x line. His addition the same hour: "We'll be
doing desktop development with another agent in another session, so that
decision needs to survive." So it is written here, in the deploy skill, and
in the desktop channel's contract (`orchestratinator.consumed`).

Before it, one folder was both. The board's container was built from it,
the host's LaunchAgent ran its `host/run.sh`, and the plugin's marketplace
was a directory source pointing at it. With the folder on `develop`, the
next host restart (a crash under `KeepAlive`, a reboot, an Update) would
have started develop's host against main's board. Any `docker compose up`
here would have replaced the live board with develop's, which refuses
main's host for its protocol number.

So, in this folder:
- **Never `docker compose up`, `host/install.sh`, `launchctl kickstart` of
  the host, or `claude plugin update`.** Each one acts on the live
  instance. `container_name: appideas-orchestratinator` and port 8787 are
  in `docker-compose.yml`, so a compose run here collides with the live
  container rather than starting a second board beside it. That is a
  refusal by accident; do not "fix" it.
- **Development runs on its own ports**: the suites' defaults, a scratch
  board (`PORT=89xx DB_PATH=<scratch> node src/server.js`), page checks on
  private ports, and probes in scratch folders. A dev host started
  by hand or by the app must not register with `localhost:8787` under the
  live host's id: `ORCH_HOST_ID` defaults to the hostname, which is the
  live host's row and work queue. Give a dev host its own board, or at
  least its own `ORCH_HOST_ID`.
- **A release reaches the live clone through `main`**: a PR, QA's release
  check, costmo's merge, then in the live clone `git pull`, and the deploy
  from there (**deploy-both-halves**), or the page's Update, which
  fast-forwards the clone the host runs from. That is the live clone now.
- **A maintenance fix to the live service is a branch off `main`** (0.12.x,
  as 0.12.12 was), merged forward into `develop` after it ships. Both
  times so far, the forward merge conflicted on the version line, and
  taking main's side dropped develop's `"protocol": 1` beside it (bf8079d,
  e54004b). The field now sits after `"type"`, away from `"version"`, so a
  bump merges cleanly (measured with `git merge-file`). After any forward
  merge, read `"protocol"` in both `package.json` files. And keep
  develop's version: develop is 0.14.0 from the same evening (costmo's
  pick), so a 0.12.x bump merged forward conflicts on that line, and
  main's number is the wrong side to take.

**Two things since, both 2026-11-20.** The desktop app's releases do not
go through `main` at all: they are tags on `develop` ("A new machine's
first windows"). And the live instance has had no host on this machine
since that afternoon's clear, which removed the launchd job, its plist and
`host.json` ("The clear of 2026-11-20"). The container still runs. Until
costmo has `host/install.sh` run from the live clone, a board on 8787 with
no live host is that, not a fault to diagnose.

**Since 2026-11-22, `main` is the 0.14 line, and both releases meet
there.** For 0.14.5, costmo merged PR #61 (develop into main, 82a2dad,
whose tree is the candidate 154e5cc's exactly) and tagged `v0.14.5` on
main. The desktop app pins that tag, and its own `main` took the pin move
(ae2ef9e). So "`main` stays on 0.12.x" in "A new machine's first windows"
and the 0.12.x maintenance branch above are history. A maintenance fix now
branches off main at 0.14.x. The forward-merge rule about `"protocol"`
still holds. The order the round used, each step checked by QA before the
next:
1. Both release chains EXIT=0 at the candidate.
2. The PR merged, and the tag on main.
3. QA's identity check: the tag's tree object equals the candidate's.
4. The desktop pin moves to the tag, and the app's `check` passes at its
   own pin.
5. costmo commits and merges the desktop app.
6. The signed and notarized build, and QA's read of the artefact.
7. `publish:release` on costmo's word, and QA's read-back of the public
   bytes against the artefact's hashes.

There was no desktop tag. **The live clone has not moved**: read the same
day, it is on main at 5caf3b5, so the board on 8787 is still 0.12.12. Its
next `git pull` and deploy (**deploy-both-halves**) moves it to 0.14.5,
which refuses any host that does not send protocol 1. So a live host put
back afterwards has to be installed from the same pulled clone. The page's
Update cannot make this move: it needs a launchd host, and there has been
none since the 11-20 clear.

The database moved with the board: it is the named volume of the live
clone's compose project (`orchestratinator-live_orchestratinator-data`),
copied from the old one (`appideas-mcp-orchestratinator_orchestratinator-data`)
while both boards were stopped. The old volume is left as it was, as the
backup from that moment.

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
killed a MySQL, and Docker Desktop at 8 GiB fixed it (2026-11-03). The board
itself is small, measured 2026-11-17 with `docker stats`: 130 MiB, of about
420 MiB for everything in the VM that day. So the 8 GiB is the site e2e
matrices' (Syncinator Pro calls it the floor for its own), not the board's.
With only the board and light services in Docker, 4 GB is about ten times
what is used; with a matrix running in the same VM, 4 GB is the setting
that failed. A capture
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
Claude Code expands `${VAR}` in a binding's headers from its own
environment, and the host and the hook expand it the same way
(`expandEnv`, two copies; `:-` is for *unset* only, as 2.1.300 sends ""
for a set-but-empty variable). But the host runs under the LaunchAgent with
`PATH` + `HOME` and nothing else, so a Claude Code it starts would send the
literal placeholder (QA measured it on the window layer). costmo's ruling:
install.sh takes an exported `ORCH_AUTH_TOKEN` into host.json when
`--token` is not given, and the host gives a desk's Claude Code that one
variable, set to its key, in the process's environment (`agentEnv`, from
`paneEnv` and `keyVar`), for any binding whose key names a variable.
Nothing is written to disk. When the host has no key at all, its startup
line names the desk and the variable.

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

**Gone with the window layer: moving every window to a fresh tmux server
when the server lost the right to read `~/Documents`** (costmo, 2026-11-10:
"I will not accept a user ever seeing this error, even once"; seen live
once, 2026-11-14). The refusal measured then belonged to one long-running
tmux server. Whether a desk's Claude Code, now the host's own child, can
meet such a refusal has not been measured. The same refusal once landed on
the operator's own terminal (every process under iTerm2, 2026-11-14), so an
agent whose own commands get EPERM checks its own shell first
(**diagnose-handoff**, first step).

**The host puts one thing on the operator's screen itself, and how was
measured, not chosen.** The folder dialog is one function,
[`host/dialog.js`](host/dialog.js), with a backend per platform: macOS, and
Windows since issue #28 (`host/dialog-win.ps1`). Its header is the record:
four ways of opening a dialog from a LaunchAgent were watched, three are
*drawn and never focused* (or outlive their process), and a cross-platform
npm library was tried and is one of the three. On Windows, from the hidden
Task Scheduler process, the dialog alone opened behind the window in front,
an always-on-top owner made it drawn but not focused, and that owner brought
to the front first (an ALT tap and AttachThreadInput) made it the foreground
window (pc-developer, 2026-11-20, costmo watching). So: do not swap it for a
library, and do not write a Linux backend from first principles — a backend
goes in after it has been watched taking focus from the host's own service,
which is what the **measure-the-desktop** skill is for. A host with no backend says so on
registration (`dialog`) and the page draws its own list for it; that list is
the fallback, not leftover code.

## A question on the floor

From issue #7 (2026-10-01) and 2026-11-22. Each had a reasonable argument
behind the old way, which is why they are here.

- **A form with a question unanswered is never sent.** costmo's ruling. The
  window's own review screen warned "You have not answered all questions"
  and took Enter anyway, and the floor used to match it on the argument that
  a second door should not be stricter than the first. Measured, that
  half-sent: the form submitted one answer short. Now Submit shows the first
  unanswered question and sends nothing, and the route refuses the same form
  (`unansweredOf` in [`src/floor.js`](src/floor.js)). A free-text choice
  with nothing typed is not an answer. The page has its own copy of the rule
  (`askUnanswered`) so Submit can show the tab without a round trip;
  `test/floor.mjs` runs both over the same cases. Do not re-propose matching
  the window's leniency.
- **A question is never a menu, and its form is built from its questions.**
  The words have always been in the call (`tool_input.questions`), and the
  board builds the form from them (`formFromInput`): from the host's `ask`
  event for a desk the host runs, from the hook for any other.
- **A typed answer is an answer**, on a desk the host runs. On the window
  layer the free-text row of a single-select withdrew the whole form
  (Claude Code's clarify hatch, measured 2026-11-02 on 2.1.300), so the
  board sent every answer after it as one message in words
  (`clarifyMessage`, costmo's ruling that nothing chosen is dropped).
  Answers as data have no hatch: the typed words go back as that question's
  answer (`host_ask` in `/api/floor/answer`). The withdraw path is left
  only for a prompt that is not a host's ask.
- **A subagent's hooks do not close a question** (costmo's report,
  2026-11-22: a question vanished from the floor while two background
  agents ran, and every message to the desk was then refused with nothing
  on the floor to answer). The plugin forwards `agent_id`, which Claude
  Code sets only inside a subagent, and `CLEARS_AWAITING` in
  `src/floor.js` ignores an event that carries it. Also shipped on its own
  as 0.14.7, a patch on v0.14.6.
- **The floor does not draw a question's previews.** That was not asked for
  and is not backlog by default: a preview is a mock-up of any size, and
  where it would go on the panel is costmo's call.

## A screen the floor does not know (0.14.6), superseded

0.14.6 (costmo, 2026-11-22, after pc-developer's
`docs/robustness-review.md`: three desks on the PC stood dead behind "Teach
auto mode about your environment?", read as idle) taught the window layer
to read any screen it did not know as "needs you" instead of idle. The
process layer replaced it the same day, and the class it addressed is gone:
a desk's Claude Code has no screen, and what it asks arrives as data or is
declined and said ("How a desk runs Claude Code"). Two rulings from that
round still hold. Claude Code stays on Anthropic's stable channel, with
nobody held to a version the floor was checked against: do not re-propose
a pin. And a new Claude Code is said on every desk its host runs
(`host/version.js`: `claude --version` at each heartbeat, the last reading
kept in `~/.orchestratinator/claude-version.json`; report only, never a
gate).

## A message to a desk that is working

**It is taken into the turn.** A message sent while a turn runs is folded
into that turn (measured on the process path: one result answered both),
and the host emits `delivery: queued` the moment Claude Code takes it
(its lifecycle receipt). The
composer shows "queued — the desk is working" instead of counting to thirty
and saying "not recorded" about a message that arrived. The note is retired
by the message becoming a turn, in either order, because the host's two
loops do not wait for each other and the relay sometimes publishes the turn
first. Holding a message until the turn ended was the whole of what once
made the floor feel broken.

`readTranscript` files a message injected mid-turn from its
`queued_command` attachment record, because Claude Code writes no `user`
record for one (measured on 2.1.220). Without it the floor showed the agent
answering a question nobody could see being asked.

**A desk whose own Claude Code is asking something takes a message and
holds it until the answer; the board's own words wait** (F17, costmo
2026-11-23, replacing the #44 follow-up's refusal of 2026-11-05, which was
the window layer's: typed into a window, a message went into its prompt).
On `/api/floor/chat` a host's ask (`host_ask`) no longer refuses; a prompt
a hook raised still does (`askingWhy`), since nothing holds the message
there, and the panel dims Send only then. The desk's `nudge` verdict still
says `asking`, so the bell, Nudge and a room's notices send nothing. A stale `live.pending` would refuse messages
wrongly. It is cleared by an answer from the floor, by the host saying the
ask is `gone`, by the conversation's next hook, and at session end, and the
panel shows the prompt with Cancel.

## A slash command, the model, and a compaction

How a desk's Claude Code takes each command is in "How a desk runs Claude
Code". What still holds from issues #9, #10 and #15 (0.10.9) and the
2026-11-14 rulings, on the board and the page:

- **A command's receipt leaves one line, not a bubble.** costmo read the
  receipt drawn as the pending bubble as "an artifact outlined in white
  saying /model opus … a message that has not yet sent". So a done command
  draws no bubble, and the line labeled `host` carries what was typed and
  what happened: "/model opus — Set model to … and saved as your default
  for new sessions".
- **A change that was not made stops being asked for** (costmo, 2026-11-14;
  `unask` in `applyHostEvent`): a host error that names the command it was
  carrying out (`command` on the event), or a receipt that confirms
  nothing. Before it, the select stayed on the model picked, with "x asked"
  beside it, and nothing on that conversation corrected it. **And a refused
  pick is not handed back to the message box** (`handedBack` in
  `src/ui/floor.js`): a select's choice is not something the operator
  typed. The page's selects are written only where they changed
  (`fillSelect`), because rewriting them on every poll lost picks made in a
  panel's first seconds. The chat route refuses a bare `/model` and an
  effort level that is not one of Claude Code's.
- **Only `startup` and `resume` are a session starting** (costmo, #15
  Decided 2; `isSessionStart`). SessionStart also fires with `source:
  compact` at every compaction and `clear` on `/clear`, and every
  SessionStart used to wake an archived floor and ask a rescan.
- **A live session outranks an ended one.** A `/clear` ends one session and
  starts the next in the same second, and on `updated_at` alone the two
  tied: the floor showed the ended row's state or the new row's empty
  model, by chance (his "works sometimes, not others"). Every "the desk's
  newest session" read orders `(ended_at IS NULL) DESC, updated_at DESC`,
  and the host names its session on every receipt.
- **A compaction's state is the hooks' and the transcript's**: PreCompact /
  PostCompact (and the SessionStart a compaction fires just before
  PostCompact), the summary as a `context` turn labeled `compact-summary`
  (`isCompactSummary`), the boundary from `compact_boundary`. Any prompt,
  turn or tool ends a compaction the hooks never finished: a `/compact`
  with nothing to compact writes nothing, and once left a desk "compacting"
  for six minutes.
- **A StopFailure fires when auto-compact thrashes, not when it works**
  (2.1.300). Its twin in the transcript is an `assistant` record flagged
  `isApiErrorMessage` with `model: "<synthetic>"`, which the relay files as
  an `error` turn rather than the agent's words.
- **A paste wrapper is unwrapped on the way to the floor** (`unwrapPaste`):
  a long paste into a terminal is recorded inside `<pasted_content id=…>`,
  and the floor draws the words, not the tags.

## /mcp from the floor, a reconnect the board asks for, and a room's notices

costmo, 2026-11-19, three rulings by AskUserQuestion, measured then on
2.1.328 on the window layer, with a scratch board that was stopped and
started again.

- **A bare `/mcp` from a desk's box or a room reconnects the desk's own
  server** (`mcp_reconnect`, with the binding's server name: `server` from
  `deskIn` in `host/identity.js`, since a hand-written `.mcp.json` need not
  call it `orchestratinator`). In a terminal `/mcp` alone opens the "MCP
  servers" panel and reconnects nothing, which is what the floor used to
  meet. `/mcp reconnect <name>` names another server; `/mcp` with any other
  arguments goes as a message.
- **The board asks a host to reconnect a floor desk whose tools dropped**
  (`reconnectDue` in `src/floor.js`, work kind `reconnect`, `reconnect:
  true` at registration, kept on `hosts.reconnects`). The desktop app runs
  its board as a child process, so every launch is a fresh board, MCP
  sessions live in the board's memory, and Claude Code does not connect
  again by itself. He used to `/mcp` each desk by hand. "Dropped" is three
  facts together: a desk the floor holds, no MCP session, and an `agents`
  row. Only an MCP connect or a tool call makes that row, so a desk that
  never connected (every stand-in in the suites) is never asked. An idle
  connected desk never reads as dropped, because Claude Code holds its GET
  stream open and `sweepIdleSessions` skips a streaming session. A desk is
  asked after `RECONNECT_AFTER_MS` (20 s), once more two minutes later, then
  left alone until a session comes back. It is checked at the host's work
  poll and on a 5 s board timer that wakes the poll, because a poll can sit
  25 s in its wait. The host sends `mcp_reconnect` (on the process path the
  tools came back at once, measured) and says it on the desk. A lost
  `reconnect` item is said nowhere (`lostWorkWords`): the board asks again.
- **A desk is sent a message as it enters a meeting room, and another as
  it is back on the floor** (`roomNoticeText`, `roomNoticePlan`,
  `noticeRooms` in `src/floor.js`). He used to type the first one himself
  at the start of every room. His pick was a message at each change. The
  other offers were the note riding on the next message, and hidden
  context from the plugin's UserPromptSubmit hook. Do not re-propose
  either. Each notice is one line, wholly one `<meeting-room>…</meeting-room>`
  block, so the relay files it as a `context` turn labeled `meeting-room`
  (`contextTagOf`) and the floor draws it as a quiet line, never as his
  bubble. On a real window, each got one short line back ("Okay, I'm in
  the room."), which is the cost of that pick. What each desk was last told
  is the `room_told` table, not memory: the app restarts its board on
  every launch, and a desk told it is in a room is still owed the way
  back. Leaving uses the twin sweep's rule for whether a room still holds
  a desk (`roomHolds`), so a reload of the room's window (End, then Open
  within a second) sends neither notice, End meeting sends the way back at
  once, and a window that crashed sends it after `MEETING_LIVE_SECONDS`
  plus `TWIN_UNHEARD_MS`. A desk moved straight into another room is told
  of the new room only, and told nothing when the new room has the same
  others (`quiet`; his pick the same evening, after a stale room the app
  reopened and the room he opened beside it, the same two desks in each,
  sent the note twice). **A notice is never a queued note**: one that meets
  a working window comes back from the host as `delivery: queued`, and the
  page drew that as his bubble, "queued — the desk is working", which
  nothing retired, because a notice becomes a `context` turn and never a
  user one (desktop-dev, from his screenshot). The board drops a delivery
  for wholly-tagged text (`WHOLE_TAG`), and a context turn carrying the
  queued words retires a note as a user turn does. A second session made for a room is told nothing
  on the way out, because it is being closed. A desk whose window is
  asking, held by an editor, or on an offline host is not marked told,
  and is tried again at the next look. Run from the sweep: every route a
  page polls and every meeting route, a touch included, so a room's own
  window keeps it going with no floor tab open.

How it is tested: the decisions and both board halves in `test:floor`
("what a desk is told…", "reconnecting a floor window…"), the host's
`mcp_reconnect` in `test:host`, the slash menu and a notice's line in
`check-chat-controls.mjs`. The board's half was seen end to end on
2026-11-19, on the window layer: in costmo's app a 22 s relaunch healed by
itself, and a 6-minute one was reconnected by the host about 30 s after, on
both desks. A room opened and ended put both notices in the conversation,
filed as `meeting-room` lines.

## One floor of a backup

costmo, 2026-11-19: after a full import from the Docker instance he kept
working on one floor (`e3-roominator`) there, and wanted that floor in the
app's instance without losing what was said on it since. A whole-board
restore would have dropped everything done on the app since the import, and
the restore route's own comment refuses a merge for a reason that still
holds: ids count per instance. Read off the two real exports that evening:
the floor's 175 new messages carried ids 3526 to 3700, and the app had
given 3526 to 3620 to other floors' rows meanwhile. So **Settings → Recover
from a backup → "Or bring over one floor"** (`POST /api/admin/backup/floors`
lists a file's floors, `POST /api/admin/backup/restore-floor` confirmed by
typing the floor's name), with the rules on `restoreFloor` in `src/db.js`:

- **Nothing here is lost.** Refused, with nothing changed, when the floor
  here holds a message, task or audit row the file does not, a task the file
  has older, or a contract at a later version. Rows are matched by what they
  are (author, time, text), not by number: a number is the instance's, and a
  second import of the same floor would otherwise be refused over the rows
  the first one renumbered. The floor restore's own audit rows are this
  instance's and are kept across the next one.
- **An id never means two things.** A row the floor already has here keeps
  the number it has here. Any other keeps the file's number while that is
  free and later than every number given so far; past the first clash, every
  row is numbered above everything here, in the file's order, so the floor
  still reads in the order it was written. A free number after a clash is
  not kept, because it would sort before the renumbered rows.
- **Read positions follow their messages** (`poll_cursor` to the new number
  of the newest message it had read). An agent that remembers a number from
  the other instance can be handed messages again, never fewer: its `since`
  is from the other sequence and is below the renumbered rows.
- **A remembered task number cannot touch another floor's task**: the task
  tools are `WHERE channel = ? AND id = ?`. Renumbered tasks are said in the
  report and the audit row, and an agent that asks for its old number finds
  nothing and lists.
- **A whole file's routes take a whole file's size.** The board parses 4 MB
  everywhere but the restore paths (`RESTORE_PATHS` in server.js), and a real
  export is 14 MB: the first rehearsal on real data was refused at the door,
  which the suite's small fixture could not see. check-settings pads its
  file past 4 MB for that.
- **Names here win** (`agent_profile` is per agent): taken only for an agent
  with none here.

Rehearsed on the real exports (app 0.14.0 and Docker 0.12.12, 2026-11-19) on
a scratch board: the floor arrived whole (372 messages, 28 tasks, 9
contracts, 7 agents) in the order written, every other floor's rows were
unchanged by id and text, 175 messages and 6 tasks were renumbered, cursors
followed (3700 to 3875), and the same file restored a second time. Moving
the agents after it is the release (Take a desk on each folder), which
brings their conversations. Tested in `test:auth` ("one floor of a
backup"), `check-settings.mjs` ("one floor of a backup"), with
`mutants-floor-restore.suite.json` and `mutants-floor-restore.page.json`.

## Claude Code signed out on a desk's machine

costmo, 2026-11-19, in the release-prep round (meeting room 22 with
orchestratinator-desktop-dev): "Host signs in". Measured first on 2.1.329, a
window with no credentials and onboarding done, on a tmux socket of its own.
Idle, it is an ordinary composer with "Not logged in · run /login" at the
right of the status row under it, and nothing in the transcript. Sent a
message, it writes one assistant record, `isApiErrorMessage: true`, with the
text "Not logged in · Please run /login", and the composer reads "Once fixed,
resend your message". So the floor drew the desk as idle, then showed the
operator a command as its answer. Both are faults by this file's own rules.

- **The host reads the machine, not each desk** (host/auth.js).
  `claude auth status --json` (`loggedIn`, about 0.25 s at load 67) at every
  heartbeat, and at once when the relay sees that error record (`noteTurn`).
  It says the result at registration (`signed_out`, kept on the host's row).
  The transcript's record counts on its own (`auth.said`), because a
  credential that is there and no longer accepted can still read as signed
  in to `auth status`. A reply from any desk ends that.
- **USER and LOGNAME are filled in when missing** (`claudeEnv`). With HOME
  and PATH alone Claude Code says a signed-in Mac is signed out (the app's
  agent, measured 2026-11-09). launchd gives a LaunchAgent both (read off the
  running host); a host started by another parent may not have them, and
  every desk on it would then read as signed out. `test:host` starts its host
  with both empty for that row.
- **The board refuses what would fail, in words** (`signedOutWhy`, beside
  `askingWhy`): a message, the bell, a room's notice. The desk carries
  `signin` (`signinWhyNot`), and the panel draws a box with **Sign in** in
  the prompt box's place. A prompt the window shows outranks it. The tab
  pulses for it as for a question (`deskAsking`), because nothing the desk is
  asked can be answered until he presses it.
- **Sign in is the host running Claude Code's own sign-in** (`signin` work,
  `POST /api/floor/signin`, an audit row `claude.signin`). `claude auth login`
  with no terminal opens the browser on that machine and waits on a local
  port until the person finishes (the desktop app runs it the same way). It
  waits on a person, so it is started and not awaited, one at a time: a
  second press says the first is still open. A failure is an error turn in
  Claude Code's own last words. The app's own `?signin=1` seam was offered
  by desktop-dev and not used: the host's way is the same on the Docker
  board and in the app.
- **After a sign-in, each running desk's Claude Code is started again on
  its conversation** (`reopenSignedOut`). Whether a running process takes a
  sign-in made by another is not measured: it needs a real account, and an
  agent cannot sign in. A new process reads the credentials as it starts.
  Never mid-turn: a signed-out process cannot be working. It runs on the
  host's line (`later`, drained before each work poll), and the board hears
  "signed in" only after it, so nothing is sent to a desk while it is being
  started again.
- **A host says it can** (`signin: true` at registration, `hosts.signins`).
  A host from before it would drop the work, so the box dims Sign in with
  why. It is a field added, so the protocol number did not move.

Not measured, and left: whether the restart above is needed at all, and
`claude auth login` started from a launchd host on a real desktop (the
app's own run of it is measured). The first real sign-out on his machine
answers both. How it is tested: `test:host` ("Claude Code signed out on this
machine", the stand-in answers `auth status` and `auth login` from files),
`test:floor` ("Claude Code signed out on a host"), and **check-signin.mjs**
in **verify-ui-change**, with `mutants-signin.page.json` beside it.

## A new machine's first windows (0.14.0 to 0.14.3)

2026-11-20, the day the desktop app went out as a signed build and costmo
installed it on a second Mac. It showed three things, each fixed the same
day; two were in the window layer and went with it. **This section was written afterwards from the code's own
comments, the commits and the scratch logs of the session that did the
work**: that session's history was lost the same afternoon (the next
section), so nothing here is from memory, and where the record did not say,
this says "not known".

**A desktop release is a tag on `develop`** (costmo, 2026-11-19; recorded
in the app repo's `docs/follow-ups.md`, "Pin a release tag"). The desktop
and Docker releases are separate lines. A desktop release is not a merge to
`main`: he tags `develop` after `npm run release-gate` passes at that
commit, the app names the tag (`#v0.14.3`), and `main` stays on 0.12.x for
the Docker instance. So "a release reaches the live clone through `main`"
above is the Docker line's rule, and "the full chain runs before any merge
to main" reads, for the desktop line, as the gate before the tag. **The
app's version and this repo's are kept the same** (costmo, 2026-11-20). The
app took 0.14.1 alone, which is why there is no `v0.14.1` here: v0.14.0 is
b3127e4, v0.14.2 is d1fe63a, v0.14.3 is 5fcb0b8, v0.14.4 is 58a648f.
**From v0.14.5 (82a2dad) the tag is on `main`**, so the rest of this
paragraph describes 0.14.0 to 0.14.4 ("Since 2026-11-22", near the top).

- **The 0.14.0 gate's reds** (EXIT=1 at 6826bab, EXIT=0 at b3127e4). The
  one that still teaches: `drive.mjs`'s drag sent `mouseMoved` with
  `button: 'none'` while the button was held, and Chrome does not take that
  as a drag, so a textarea's resize handle stayed where it was
  (check-chatbox, check-pop-foot). A move with the button held names the
  button. The other two were in window-layer code, since replaced.
- **Inside the app the header shows the app's version** (0.14.2,
  `headerVersion` in `src/ui/app.js`, lifted into `test:floor`). The app
  was 0.14.1 on an Orchestratinator 0.14.0, the header said one and the
  app's Settings the other, and to a person that is one screen
  contradicting another. The number comes from the user-agent token the
  app already sends (`OrchestratinatorDesktop/<version>`); this instance's
  own number stays on the tooltip. In a browser nothing changed.
- **Backlog from that day, not built**: a meeting room should survive
  closing the app or the floor it came from (`docs/backlog.md`, with what
  each repo's half is).

The header is tested in `test:floor` and check-attention.

## The clear of 2026-11-20, and what the record is since

About 12:30 PST that day costmo ran the app's "A fresh install from
nothing" on this machine, meaning it for the test Mac. Read afterwards.
What it took, because each one explains something that will look wrong
later:

- **The launchd host of the live instance.** The job was booted out and
  its plist and `~/.orchestratinator/host.json` deleted. The Docker board
  on 8787 still runs (0.12.12, main) and has no host on this machine.
  Putting it back is `host/install.sh` run from the live clone, with the
  board's key, and it is costmo's to run or to ask for.
- **`~/.claude` and `~/.claude.json`**: every session's transcript, every
  folder's local-scope binding (so every desk that was not bound by a
  `.mcp.json` is unbound until it is taken again), the settings, the
  installed plugin, and each agent's memory directory.
- **The app's profile, so the app's board.** It was restored at 20:46Z
  from the newest whole backup in Downloads, which is the *Docker* board's
  export of 2026-11-20 03:00Z. On it this floor and the
  orchestratinator-desktop channel stop at 2026-11-19 05:11Z, the hour the
  work moved to the app's board. So the board lost two days of these two
  channels, not seventeen hours: every message and task written on them
  after that hour, and the desktop channel's contracts. A message number
  above 3525 cited in this file or the app's documents names a message
  that no longer exists, or another floor's: the restored board's newest id
  was 3700, and new messages count on from there.
- **The contracts were written again that afternoon**, from this file, the
  code and the app repo's documents, each with a `restated` line:
  `orchestratinator.attention`, `orchestratinator.window_moves`,
  `orchestratinator.app_setup`, and `orchestratinator.consumed` (v9 kept,
  its later sections added, v10). The board counts versions from 1 again,
  so "attention v3" in an older note is the content of today's v1.
- **What survived**: both repos, the Docker board and its volume, and the
  lost sessions' scratch directories under `/private/tmp/claude-501/`,
  which is where the gate results above were read from. `/tmp` goes at a
  reboot. No Time Machine backup exists (off since 2021), and no local
  snapshot.

How all of that was read, as three commands and the order they pay off
in, is the **recover-a-lost-record** skill.

**A desk's Claude Code gets a person's environment and nothing of the
host's** (found by the app's agent that afternoon; decided and built in
0.14.4, costmo having handed the call over: "make the open decision based
on what is going to be smoothest to the operator and end user
experience"). After that day's clear every window the app's host opened
carried the host's settings (`ORCH_URL`, `ORCH_AUTH_TOKEN`, `ORCH_HOST_ID`,
`ORCH_HOST_SUPERVISOR=app`, …) and no `TMPDIR`, so a host, board or suite
started by hand in one silently became the app's (measured: a host suite
run there read one red, the host meant to have no key having the app's).
So `windowEnv()` in `host/claude.js`, which is what a desk's process is
started with (`agentEnv`), gives:
1. **No `ORCH_` variable.** An agent's shell is somebody's terminal, and a
   board, host or suite started in it should behave as it would in any
   other. The suites reach their stand-ins by flag files for the same
   reason.
2. **The key only where the binding names a variable** (`keyVar` in
   `host/identity.js`), and a seat's four variables. A desk with a literal
   key, which is every desk the app binds, gets nothing: its key is in its
   binding.
3. **`TMPDIR` filled when missing** on macOS (`getconf
   DARWIN_USER_TEMP_DIR`), and **`USER` and `LOGNAME`**, because with HOME
   and PATH alone Claude Code says a signed-in Mac is signed out.
4. **None of the markers a Claude Code session sets for its children**
   (`PARENT_SESSION`): a Claude Code that inherits them writes no
   transcript ("A host on Windows").

Leaving the key in, and fixing it in the suites alone, were weighed and not
picked. It is written in `orchestratinator.consumed`,
`host.windows_inherit`.

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

- **Outside every repo, and Claude Code may read it there.** Inside the
  desk's folder an attachment is a change in somebody's working tree
  (costmo: not git-visible). Outside it, measured on 2.1.326 with a probe in
  **manual** mode: a Read of a text file and a PNG under
  `~/.orchestratinator` raised no permission prompt, and a message with two
  paths (one with a space) was recorded exactly and both were read. On a
  machine whose settings do ask, it is an ordinary prompt on the floor.
- **The path is text in the message, not an image.** The agent reads a file
  when it wants it, which is also what lets a 100 MB log go without filling
  the context.
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

What PR #58's review added (QA, 2026-11-17, 1 Low + 8 Info), each a rule
now:

- **A command is the board's `commandOf`, on the page too** (`commandLike`
  in the attachments section, a copy, and `test:floor` runs the two over
  the same messages). The page's first rule, "starts with / and a letter",
  refused files on "/Users/me/build.log keeps failing", which the board
  takes, and called it a command.
- **The host's error is the why, then "; nothing was typed"**, never "not
  sent — …": a meeting room puts "not delivered — " before a desk's error,
  and the two read as a stutter. A folder the host cannot write names its
  file ("x.png could not be written on this machine (EEXIST)").
- **Nothing in the box is cut.** Files a failed send hands back go back
  every one, and Send says when the box holds more than twenty and how
  many to take out. A `slice` there dropped them without a word.
- **A body shorter than its content-length never reaches the agent, and
  Node's fetch is what stops it**, measured on Node 24: it throws
  "terminated" before `fetchUpload`'s own size check runs, whether the
  board closes or drops the socket. That check is a second guard, so QA's
  mutant removing it survives by design; the row asserts the outcome.

One item was left for a later branch, and the reason is what stops it
being re-proposed as a gap:

- **A fetch may outlast the board's 90 s host-live window** (Info 8). It
  takes a board on another machine at about 9 Mbit/s or less to fetch
  100 MB that slowly; locally it is a second. The two fixes behave
  differently (the host touches the board while a fetch runs, or the fetch
  times out under 90 s and refuses large files on slow links), so it is a
  choice to make with a slow link measured, not a guess. Meanwhile the
  floor draws that host's desks unreachable until the fetch ends, then
  live again, and the message is sent then.

## The milestone audit's foundation (0.12.11)

QA's coverage and testing audit (2026-11-17, at 0771ea8) was the gate to a
milestone, and costmo's word for the round was "solidify our product and
provide the foundational proof before we pivot into some new features".
It ruled in findings 1–5 and two foundation items. The report is in the QA
repo (`projects/appideas-mcp-orchestratinator/audit-2026-11-17.md`).

- **An open question never leaves the floor while Claude Code asks it**
  (finding 1, High). docs/backlog.md has the whole account. A prompt is
  closed only by the work of the session that raised it, and every
  heartbeat says again what each desk's Claude Code is asking (`ask`
  events, `standingAsks`), which is how a board restart, every deploy, no
  longer forgets them.
- **Work a host takes is done once, handed out again, or said lost**
  (finding 4; the guarantee is written above `takeHostWork` in
  `src/db.js`). It used to be marked taken as it was handed out, and a
  host stopped mid-line lost the rest of its batch without a word. A host
  says each item finished as soon as it is (on the next poll, or at once
  while more of its batch is still to go: `sayDone`, after QA's L1 in the
  re-measure), a host stopping finishes the
  item in hand (`ORCH_STOP_DRAIN_MS`, 15 s) and hands back what it never
  started, and each run of a host has a `boot`, so the next run's
  registration sorts what an earlier one left: reads are handed out again
  (`REHANDED_WORK`), and anything that acts on a window is closed and
  said on its desk in an error turn (`lostWorkWords`). A chat's turn
  quotes the words, says it "may not have been sent" (the board cannot
  know), and an error turn is what hands them back to the box.
  At most once for window work, on purpose: a host can die after typing
  and before saying so, and a message typed twice is the worse failure.
- **The stop sign is tested at the process** (findings 2 and 3): it
  reaches Claude Code as its `interrupt` request and the turn ends. Press
  yes / no, a blind key for a prompt nobody could read, is refused by the
  host in words now that every prompt arrives as data. Rows in `test:host`.
- **One stack** (finding 5): Tests, above.
- **The release gate is one command: `npm run release-gate`** (item A).
  Every suite and the release page checks (eighteen since 0.14.6, which added check-plate-fit and check-ask), on the Node and the
  packages that ship, with one log whose first line names the head, the
  tree and `node -v`, and whose last is `EXIT=`. Both halves run even
  when the first is red. Measured with a red seeded in a copy, one in
  smoke and one in check-attach: `EXIT=1`, both named. It replaces
  running `npm test` and `run-release-pages.sh` by hand at a release.
- **The project owns a coverage reading: `npm run coverage`** (item B).
  The instrument is QA's from the audit, kept as measured
  (`scripts/coverage/`: the preload, `report.mjs`, `run.sh`; and
  drive.mjs records page coverage when `PAGECOV` is set). Over the
  audit's own snapshots, `report.mjs` gives QA's per-file table exactly:
  88.4 % code lines, 94.1 % functions, 77.8 % branches at 0771ea8, the
  baseline. Three things it needs, each found the hard way: a process ended
  by a signal writes no coverage, so the preload snapshots before every
  SIGKILL and on SIGTERM; each snapshot resets V8's counters, so every file
  is kept and summed; and page logic is tested from lifted copies in
  `data/`, which the preload keeps and the report credits back to
  `src/ui`. Not seen by it: the hub SharedWorker and windows a page opens
  itself.

## Moving a desk to another floor

Issues #24 and #18, 0.10.10 (2026-11-03, task 253; measured on 2.1.300).
A move is a seat change two doors lead to — Take a desk naming a folder
bound elsewhere, and **Move to another floor** on the desk's nameplate card
— and both end in one function, `seatDesk` in [`src/floor.js`](src/floor.js),
so they refuse the same things in the same words. Four rules, each the
opposite of what ran before.

- **A move that ends the floor's Claude Code starts a new conversation**
  (costmo, #24 Decided 2). It used to reopen on the one the window had been
  on, and that was refused every time on the live board, 10 of 10
  (2026-10-19 → 11-02): the window just closed was still in Claude Code's
  roster, and the check that refuses a conversation another process holds
  took it for an editor. Telling the floor's own closing process from a
  real second holder by timing is the brittle part, and it was ruled;
  resuming without asking is two copies of one conversation. The old
  conversation stays in its folder; the picker and History reach it.
- **A move whose desk runs no Claude Code opens on the last conversation**
  (costmo, #24 Decided 3: "Last conversation"), the open path in `bind`.
  There is no closing process for it to meet, and a real second holder (an
  editor) is still refused there, naming its pid.
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

`seed-move.mjs` + `check-card-move.mjs` in **verify-ui-change** drive the
card on both views.

## Releasing a folder from another instance

Task #292, 0.12.7 (2026-11-08; measured on 2.1.300 with two real hosts and
a real window, in both directions). Take a desk on a folder bound to
another instance used to say "is bound to <address>, not this board. Change
it there." It now releases the folder from that instance and seats it here.
The need was the desktop app: it runs an instance of its own, so every repo
of an operator who already uses the Docker one was bound elsewhere and
refused, and the instance being left may not be running to change anything
on.

**"Instance" is costmo's word, and the page's, for one running
orchestratinator.** This file says "board" for that all over, and also for
the rows-per-agent view. He asked what "board" meant (2026-11-08). New
words an operator reads say instance, release, and the address. The older
text is not renamed.

- **The reversal is costmo's, and it is narrow on purpose** ("We need to be
  able to 'release' an agent so that it can be opened by another
  instance"). `host/mcp.js` said an entry pointing at another instance is
  never touched, and that went in with Take a desk itself. No failure is
  recorded behind it; it is the one-instance rule applied to the config
  file. What it protected is kept by the shape. Only the folder the
  operator named is touched, on their click, on the floor taking it. The
  request names the instance being left (`from_board`). The board checks
  that against the host's last reading and the host against the disk at the
  bind, so a binding that changed since the click is refused, not followed.
  The host still only writes entries for its own instance, and a third
  instance's entry in the same file stays. Do not widen it to a host
  releasing on its own judgment.
- **A release is never a move.** `from` on a bind names a desk on *this*
  instance for the `bound` handler to unseat and retire. The names a
  folder carries elsewhere are nobody here, or, after a restore, a real row
  that is going nowhere. So `seatDesk` has a fourth mode, `release`, that
  sends `release: { board }` and no `from`, whatever floor it lands on.
- **Both scopes are cleared.** Local scope by the name each entry was
  written under (`localEntries`; a hand-added one need not be called
  `orchestratinator`), and the folder's `.mcp.json` for the named
  instance. Leaving the file's entry was not an option: beside a local one
  it raises the approval question on every fresh window, and under another
  server name the window connects to both instances. That file may be
  tracked, so a release can dirty a repo's tree, as an import already does.
  The dialog says so before the click.
- **The conversation goes by a move's two rules.** A Claude Code running in
  the folder is ended and a new conversation opens (#24's race is the same
  race): this host stops its own, and the instance being left lets its own
  go when it reads the folder's new binding (`letGoIfReleased`). With none
  running, the desk arrives on the conversation somebody last spoke in
  (`lastSpokenIn`, the session picker's bounded reads), because this host
  never watched the folder and has no pin. Measured on the window layer:
  the resumed conversation answered `whoami` as the new instance. With
  `open: false` nothing is opened, which is what a caller working through
  a list wants.
- **What became of a take is read from `GET /api/floor/take`**
  (`live.takes`: asked, then seated or refused in the host's words). The
  desk being released has no row on this instance, and the board drops a
  host's error for a desk it has no row for. That was the gap PR #33 closed
  for a move only, and a plain take's refusal was lost the same way; both
  are on record now. The host's refusals carry `taking` so the board knows
  which take. The dialog waits on it (`waitForTake`).
- **A host says it can (`release: true` at registration), and the protocol
  number did not move.** A host from before this reads the work as a plain
  take and leaves the old binding beside the new one, so the board refuses
  to ask one (`old_host`) and the dialog disables its button with the
  reason. A field was added and nothing was reshaped, which is the
  protocol's own rule.
- **The host being left looks before it acts** (`boundAt`,
  `letGoIfReleased` in `host/index.js`). It learns a binding has gone at
  its next rescan, up to a heartbeat later. Measured before the fix: the
  instance that was left received every turn of the new conversation for
  40 s, because its host found the other host's Claude Code by its folder
  and followed it. It now reads the binding when work arrives for a desk
  and when a Claude Code comes up in its folder (`Desk.watch`), and lets
  the desk go: 0.9 s on the same rig. A local-scope file that cannot be
  read concludes nothing. A host on an older build still takes its
  heartbeat.
- **A poll says when its cursor is another instance's** (`since_ahead`).
  Ids count per instance, so an agent arriving with a remembered `since`
  above this one's newest id polled empty for ever, and the empty poll
  wrote that number down as what the agent had read. The poll now reads
  from this instance's own record of the agent and says so. "Newest" is
  SQLite's counter for the column (`sqlite_sequence`), not `MAX(id)`:
  deleting a floor takes its messages, and `MAX(id)` would then fall below
  cursors this instance handed out itself.

Two calls on the dialog were costmo's, asked both ways (2026-11-08). A
folder bound elsewhere stays out of **Recently opened**, so five places do
not fill with another instance's desks on a machine that runs two; it is
reached with the folder dialog. And the dialog starts on **the floor it was
opened from**, not the floor the folder had on the other instance, which is
not offered at all unless this instance has a floor of that name. The agent
keeps the name the folder gives it. The first cut proposed the floor it
had; do not put that back.

What a release does not bring: messages, tasks, contracts and the agent's
floor on the other instance. Those come by backup and restore, and the
app's "bring everything over" is built on this route in its own repo. The
conversations are the folder's and come with it.

Not measured: a chat held in an editor across a release (it followed a
rebind on one instance in 2026-09; a change of address is the same
re-read, unwatched), and a host being left that runs an older build.

`two-instances.sh` in **measure-a-real-window** is the rig it was measured
with (two throwaway instances and a host each, on the window layer), and
`check-release.mjs` in **verify-ui-change** is the page.

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

The host calls such a desk a **seat**. Three things about it, each of which
looks like it could be simpler:

- **A seat is a Claude Code of its own, told apart by the host's record,
  never by directory.** It is started with `--mcp-config <its binding
  file>` (`seatConfig`) and four variables (`agentEnv`), and the host knows
  it from its own seat record (`host/seats.js`). A seat's roster sessions
  are its own process's only; the folder's own desk has the rest, a
  terminal's or an editor's included (`watch` in `host/index.js`).
- **The hook is told which desk its process is.** It finds a desk by
  folder, and in a seat's folder the folder names another desk, so a
  permission prompt raised there would be filed on the wrong desk. The
  process carries `ORCH_DESK_CONFIG` (its binding file, read like a
  `.mcp.json`), `ORCH_DESK_ROOT`, and `ORCH_CHANNEL` / `ORCH_AGENT`. The
  last two are what the hook has let stand in for the folder's names since
  its first commit (2026-08-27), which is why a seat reported correctly
  with the plugin installed before seats were written. The file is what
  keeps it reporting when the folder's own desk has left.
- **A seat never resumes "the folder's newest conversation".** That is
  `resumable()`'s fallback for a pin with no transcript, and in a shared
  folder the newest is most likely the one another desk's process is
  running: two processes on one transcript. A seat starts a new one and
  says so on its desk; the folder's own desk skips conversations its seats
  are running (`seatPids`); and a conversation another process holds is
  refused (`held_elsewhere`).

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
  floor closes that seat (`bind()`: two desks cannot answer to one name,
  and the folder's own entry is what its processes connect with). Leave on
  that seat was refused mid-turn and the bind was not. Both doors onto a
  bind refuse it now in one sentence (`seatWorkingWords`, in `seatDesk`),
  and the host refuses it too when the seat's Claude Code started a turn
  after the board looked (`proc.working`). The host says it on the desk
  the move is from, or on the seat itself for a take: both have a row.
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

**On develop, every seat was read as a released folder until 0.14.4**
(costmo's report, 2026-11-20: a second meeting room with two agents
already in one, "everything about it failed miserably", and the `-2`
desks could not be removed). A merge seam, not a fault in either half:
develop's release check (`boundAt`, 0.12.7, 11-09) read a desk's binding
off its folder, and main's seats (0.12.9, 11-16) are desks whose folder
names *another* desk, by design. The 11-18 merge put them together with no
conflict. So every piece of work for a seat (a room's message, its notice,
its Leave) was refused with "not done: <folder> is <the folder's desk> on
this instance now … The desk is let go here", and its window coming up did
the same at every watch tick, after which the rescan found the seat again
from its record: the app's host log carried four lines a second for every
seat, a seat on another floor included. `boundAt` reads a seat's own
record (`S.listSeats()`) now. Why 99 ✓ in `test:seats` never saw it: its
fixture HOME had no `~/.claude.json`, so the local scope read as
unreadable and `boundAt` concluded nothing. The fixture writes one now, as
every real machine has, and the change taken out is 33 red there. **Two
lessons for the next merge of main into develop**: a check that reads "the
folder's binding" is wrong for a seat, so grep both sides' new readers of
`readDesk`/`readLocalScope` against `desk.seat`; and a fixture that leaves
out a file every machine has can switch a whole check off in silence.

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
- **A seat's conversation is not handed to an editor or a terminal**
  (`seat_no_editor`). An editor or a terminal opened in the folder loads
  the folder's binding, so the conversation would carry on as another
  desk. Nothing can give a VS Code chat a binding of its own.
- **A desk in its own popout is still one place at a time.** Only a desk
  that is in a meeting room gets a second session for another room, which
  is what he asked for. And a room's **Add** offers what it did.

How it is tested: the decisions in `test:floor` ("one agent, several
sessions"), the host's half in **`test:seats`**, the hook in `test:plugin`,
and the page in **check-sessions.mjs** (**verify-ui-change**). The mutant
lists are kept: `mutants-sessions.suite.json` (**mutate-in-a-copy**) and
`mutants-sessions.page.json`. What only a real Claude Code can say was
measured on windows (**measure-a-real-window**, "Two windows in one
folder").

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

One more ruling went into the same diff:
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

**Several floors at once: a tab each, and each tab keeps its own floor**
(costmo, 2026-11-19, task 315 from the desktop app's agent, his picks by
AskUserQuestion to both of us). The floor a tab stands on used to live
only in localStorage `orch.floor`, which every tab shares, so a reload or a
second tab landed on whatever floor was picked last anywhere, and in the
desktop app, which has no address bar and no "new tab", there was no way
to have two floors up at all. Four parts, in "floor windows: what the page
decides" in `src/ui/floor.js`:
- **The address carries the floor**: `?floor=<channel>`, `?floor=` for all
  floors, `&view=board` for the rows view. Read at load, where it outranks
  the stored choice; kept current with `replaceState` on every draw
  (`syncAddress`), not only on a pick, because a floor put away under a tab
  drops it to all floors with nothing clicked. A bare `/` is still the
  stored choice, and `setFloor` still writes it, so a fresh open lands
  where the operator last was. All floors is written as `?floor=` and not
  left out: left out, a reload fell back to another tab's floor. The
  desktop app saves each window's address at quit and reopens it, so the
  forms are in its contract (`orchestratinator.consumed`,
  `dashboard.floor`). Only a floor tab writes it (`ui.floorTab`); a popout
  and a meeting room keep their own addresses and titles.
- **The title names the floor, first**: "lab · orchestratinator", "All
  floors · orchestratinator", "Board · orchestratinator". First because a
  macOS tab, a Dock or Window menu and a crowded browser strip cut a title
  from the end. A board with one floor is titled by it. The app copies the
  page's title to its window.
- **Each floor chip is a link** (`<a href="?floor=lab">`), so ⌘-click,
  middle-click and the browser's "Open Link in New Tab" work as on any
  page. A plain click is still the page's (`preventDefault`, then
  `setFloor`): followed, the link lands on the same floor by a reload,
  which throws away an open panel and a draft. `opensElsewhere` decides;
  Alt is not one of its keys, since Alt on a link downloads.
- **⧉ on each floor's chip opens it in a new tab** ("Open lab in a new
  window", costmo's pick over one button, a right-click menu, or the app's
  menu alone): `window.open(…, '_blank', 'noopener')`, no features and no
  target name, so each press opens one more and the new tab is a peer, not
  the opener's child. In the desktop app it is a window of the app's own
  (its agent maps Electron's disposition: the ⧉ to a window, a ⌘-click or
  middle-click to a macOS tab behind), and the app adds File ▸ New Floor
  Window ⌘N, macOS tabs and reopening at launch. The all-floors chip has
  no ⧉ (his pick's picture), but is a link like the rest.
- **Where the ⧉ opens is a setting: "Open new floors: In tabs | In
  windows", In tabs by default** (costmo, 2026-11-19, the same day). In a
  browser it is a row at the top of Settings, kept in this browser
  (`orch.floorOpen`), not a board row like the update settings: it is about
  one browser's windows, and a row on the board would reach the app's
  pages too. "In windows" is `window.open` with a `popup` features string,
  the size of the window it came from and set down 24 px, because a page
  cannot open a full browser window: the browser gives it one with no tab
  strip, and the row says so. **Inside the desktop app the page offers
  nothing and always opens with no features**: the app's own Preferences
  pane has the setting and maps the request, and two settings for one
  button would fight. The app says it is the app with
  `OrchestratinatorDesktop/<version>` on the user agent, its own token,
  not Electron's (any Electron browser carries that). There the ⧉ reads
  "Open <floor> in a new session", his word from the app's menu, since the
  page does not know which the app will do. The rule is `floorOpenMode` in
  the lifted section; Settings reaches it through `window.floorOpen`.
Two floor tabs were already safe together before this: each asks `who`
and holds its own record of which desks are out, and the hub is shared by
every window of the origin. What two tabs on one desk do (both may open
its panel) is as it was. `check-floor-windows.mjs` in **verify-ui-change**
is the page, with seventeen page mutants beside it, and it runs at every
release.

**A floor in the address is dropped only once a payload says it is not
there** (costmo, 2026-11-19: in the app every ⧉ opened all floors).
render() puts a tab on all floors when its floor is not among the floors
it has, which is right for a floor put away under it. Before the first
`/api/floor` answer it has none, and any draw then dropped the address's
floor for good: on his board a meeting room was open, it answered the new
tab's `who` with `here`, and that redraw came first. A failed first poll
does the same. The drop now waits for `floorRead`. The app's suite and
check-floor-windows both passed before, because neither had a room open:
desktop-dev found the mechanism from the app's side the same hour.

**What each window reports to the desktop app, and its nudge all**
(costmo, the same day). The app pulses a tab or window blue when it has
desks waiting for a nudge and amber when one is asking (amber wins),
badges counts over one, colours its tray bell and badges the Dock from
the whole board, lists windows in its tray, and offers "nudge all" per
window. All of that is drawn by the app; what a window *has* is the
page's, because only the page knows which desks it shows. So every page
window exposes `window.orchAttention` (`get`, `next(v)`, `nudgeAll`),
which the app's main process calls with executeJavaScript: the board's
pages have no preload, on purpose, so there is no event to send. The
contract is `orchestratinator.attention` on the orchestratinator-desktop
channel; the decisions are "window attention: what the page decides" in
`src/ui/floor.js`. Four of them were the developers', agreed between the
two agents in the room, and are open to his reversal:
- **A nudge is a desk, not a message**: the count is how many desks a
  nudge all would type into, which is desks with something waiting (the
  meeting room's rule, `nudgeWaiting`) that the board would nudge now. A
  desk with mail on an offline host is not counted. The room's own
  "Nudge all (N)" counts messages and tasks, by his pick (0.12.9); this is
  a different number on purpose, the badge on a button that nudges desks.
- **Asking is a prompt**: a permission menu, a question form or a startup
  question on a live desk. An error turn sets `awaiting_kind` too, and the
  floor counts it in "need you", but nothing waits on an answer to it.
- **A desk out in a popout or a room counts on its floor's tab as well
  as in that window** (costmo, the same evening, reversing the first cut:
  "If there's a nudge or pending permission/decision prompt, I want for
  the tab background to have the animated background color effect ...
  even if the agent is in a room on the floor"). The first cut gave such
  a desk to its window only, so the tray's list of windows counted it
  once. But a room window has no tab strip, so the tab stopped pulsing
  for exactly the desks he was talking to in a room. Now a sum over
  windows can count a desk twice. The board's values (the bell, the
  Dock) still count every desk once. A floor tab's nudge all reaches
  such a desk too, because the badge is the number a click sends, and
  the room folds that nudge into its transcript like any user turn it
  did not send. Which desks are out is the page's (`ui.outs`), so
  `test:floor` cannot see this rule: check-attention's page mutant (the
  old rule put back) is what holds it. Do not bring back "counted
  once".
- **A room's nudge all is every participant with something waiting**,
  whatever its To chips choose, and goes through the room's own send so
  the transcript records it.
A floor tab on the rows view reads `/api/floor` for the report only inside
the app (its user-agent token): the rows view polls nothing of the floor,
and a browser's board tab is left as it was. `check-attention.mjs` in
**verify-ui-change** drives the calls the app makes, and runs at every
release.

**Every setting is behind ⚙, and in the desktop app every setting is in
its Settings pane, drawn by this page** (costmo, 2026-11-19, four picks by
AskUserQuestion, with desktop-dev in meeting room 20; the contract is
`dashboard.settings` on the orchestratinator-desktop channel). Four parts:
- **`?settings=1` is the Settings dialog's sections as a page of their
  own** (`SETTINGS_PAGE` in `src/ui/app.js`), titled "Settings", with no
  header, floor or dialog around them; it polls `/api/state` like a popout
  and nothing of the floor (floor.js leaves the address alone). The app's
  pane shows it in a view under the app's own rows, on the floor windows'
  session. **Embedded, not rebuilt in the app**, his pick: the update and
  restore wording and rules exist once. The section's handlers sit on
  `#set-body`, not the dialog, because the page moves that element out of
  the dialog. The page is drawn whole once, on its first state, and patched
  after (renderUpdate), so a chosen backup and a half-typed RESTORE survive
  its polls.
- **In the app the copy is labels and controls only** (his answer to
  desktop-dev), plus what is a warning or a fact needed to act: the restore
  warning, what the chosen file holds, type RESTORE, errors, the result.
  `toolsPanel(compact)`; a browser keeps its paragraphs. Open new floors is
  left out there, as before: the app's own row has it.
- **The ⚙ in an app window opens the app's pane**, not a dialog (his
  answer, asked twice because desktop-dev's round had read "hidden"): the
  page `window.open`s `?settings=1` with no features and the app's open
  handler turns any board address with `settings=1` into its pane.
- **Auto-refresh is a setting**: a row in Settings, no longer a switch in
  the header; ↻ stays there, being an action. It is localStorage
  `orch.autoRefresh` (only `off` is off, so a fresh browser polls as the
  switch did), and every window applies a change at once on the `storage`
  event: a browser's tabs, and every app window, since the pane is a page
  on the same origin and session.
- **A board started with `ORCH_BOARD_SUPERVISOR=app` has no updates at
  all** (his pick: Updates in the app's pane only for a Docker board). The
  app sets it on its built-in board. `view()` is null, so the page draws no
  Updates section and no Update button, in a browser too; the update routes
  refuse in words (409); the timer and the tick both do nothing, so either
  guard alone keeps GitHub uncontacted and a mutant removing one survives
  by design. A Docker board seen from the app keeps its section, now in
  the app's pane.
Not covered by the check: a later change patched into the settings page's
Updates section (Check now on a scratch board would ask the real GitHub).
`check-settings.mjs` in **verify-ui-change** is the page, with
`mutants-settings.page.json` beside it; the server's rows are in
`test:update`, the stored value in `test:floor`
(`mutants-settings.suite.json`).

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

**A meeting outlives a quit of the desktop app, and closing its own window
still ends it** (0.14.4; costmo, 2026-11-20, "a meeting room shouldn't
disappear from a floor unless/until the meeting is ended", then three
rulings by AskUserQuestion the same hour). A room's window closing ends its
meeting because the page cannot tell a close from a reload, and that
stays: **closing the room's own window ends it** (his pick over "only End
meeting ends it"). What changed is that a close caused by the app quitting
does not, and a floor closing never did, since a room no longer closes
with the window that opened it (the app's half, `outlivesOpener`):
- **The app's word is `window.orchMeeting.hold()`**, which the app calls
  in every room's window before it quits and waits for (bounded at 3 s,
  its half). It posts `/api/floor/meeting/hold`, which sets `held_at`, and
  the window's pagehide then lets its desks go (`leaveHeld`) without
  ending the record. A room already ended answers false, and its close ends
  it as any close does. Contract `orchestratinator.consumed`,
  `dashboard.meeting_hold`. A crash with no word lapses as before.
- **A held meeting is a live one** wherever "live" is read
  (`liveMeetings`, `meetingsOn`, `allMeetings`): it contains its desks'
  broadcasts, its second sessions are not swept, its desks are still told
  they are in it. A touch or an open clears the hold, End clears it.
- **While no window shows it, its desks stay in it** (his pick over
  "usable from the floor"). `/api/floor` lists `meetings_held`, the floor
  writes each desk into `ui.outs` as `kept` (`heldPlan`, lifted into
  `test:floor`), so the box stands, and a desk's panel offers **Open the
  meeting room** in place of a message box and of Bring back, which asks a
  window there is none of. "In a meeting" opens the room; End meeting
  ends it on the board. Whether a meeting is held is read off the payload
  first (`meetingKept`): a held window's `gone` carries `rejoin`, and End
  pressed in that moment was sent to a window that was not there (the page
  check's first run).
- **In the app, a floor that loads with a held meeting no window shows
  opens its room** (his pick over "never by itself"), once per page, behind
  a Web Lock per meeting so two floor windows at a launch open it once, and
  only after `HELD_OPEN_AFTER_MS` so an open room has answered `who`. The
  app keeps no list of rooms. A browser opens nothing by itself (a popup
  needs a click there), and its box is a click away. The app has no popup
  blocker (desktop-dev, msg 3710), so the open needs no gesture.

`check-meeting-held.mjs` in **verify-ui-change** is the page (with popups
allowed, as in the app), `mutants-meeting-held.page.json` beside it, and
the board's rows are in `test:floor` with `mutants-0-14-4.suite.json`.

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

**In the desktop app the move is the raise** (costmo's report,
2026-11-19: minimized, nothing; covered, moved but left behind). Electron
ignores a page's `focus()` on a window completely: no restore, no focus,
and nothing reaches the app's main. Measured on Electron 45.2.3 in a
scratch script. A page's `moveTo` does reach main, as
`content-bounds-updated`, in every case: covered, minimized, the room
moving itself, and a move to the spot it already stands on. The app
raises the window there. So the page moves a window only to raise it,
and both raise paths always move. That is a contract,
`orchestratinator.window_moves` on the orchestratinator-desktop channel.
A page-driven move added for any other reason would raise that window in
the app, so it changes that entry first.

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

**A line on the floor is one line** (costmo, 2026-11-22, 0.14.6, three
screenshots from the 0.14.5 app). A nameplate's two lines are cut to
`PLATE_MAX_W` (180 room units: inside a meeting's box, clear of the next
desk) with "…", measured in their own font by a hidden SVG
(`textWidth`, `clampLine`). The role line cuts the **id** and keeps its
state whole after the "…" ("orchestratinator-des… · ready"), the way the
room's Nudge keeps its count, because the state is the part that changes.
A cut plate carries both lines whole as its hover. A meeting room's Nudge
is one line at most `min(240px, 45%)` wide: the names in a span cut with
an ellipsis, the count in its own span, and the whole label first on the
hover when the names are cut. And **under 900px the rooms keep the full
width**: there the body is a column with `align-items: flex-start`, so
`.rooms` sized to its contents, an SVG at `width: 100%` of it, and the
browser settled the cycle at the SVG's default 300px, a thumbnail of the
floor (his third screenshot; the page mutant reproduces it exactly). A
width, not `stretch`, because the building centres itself with auto
margins. **check-plate-fit.mjs** in **verify-ui-change** is the page.

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

## The host under the desktop app

Three tasks from the app's agent on the `orchestratinator-desktop` channel
(#288–#290, 0.12.5, 2026-11-07; the contract there is
`orchestratinator.consumed`). The app runs `host/index.js` as a child it
keeps running and shows the board in a webview, and three things that were
one number, one word and one process came apart:

- **The protocol is a number beside the version, and the board refuses a
  host that does not speak it.** `protocol` in `package.json` and
  `host/package.json`; `protocolRefusal` in `src/floor.js` says what it
  covers and when it moves (a reshaping, never a field added). Equal or
  refused, no range, and a host that sends none is refused as a build from
  before there was one — which is every hand-rolled registration in a
  suite, so each one sends `protocol: PROTOCOL` now. The page checks'
  stand-in hosts are hand-rolled registrations too, and six of them were
  missed for two days. The update check is the one that was run in that
  state: 15 of 19, "got []" and a selector timing out, over a 409 that
  nothing printed, so it read as a page fault. The stand-ins behind the
  backdrop, popout, redraw and meeting checks and the README shots sent no
  number either. They send what
  the board they are pointed at reports now (`board-protocol.mjs` in
  **verify-ui-change**), so a copy holding an older `src/` still works. A
  change to what the board demands of a host is not done until `grep -rl
  api/host/register .claude/skills test` has been read. A refused host keeps
  trying on its backoff, logs the words once, tells its parent over its
  port, and is on `/api/floor`'s `hosts` as `refused`. Its desks say
  "refused", never "offline": on the card's window row, the nameplate, the
  panel's header, the composer's placeholder and its hint, which carries
  the board's words (0.14.5, task 337; the panel said "offline" with
  "Start it" until then; **check-signin.mjs** and
  `mutants-signin.page.json` hold it). On this machine the
  mismatch it catches is a deploy that rebuilt the board and left the host
  running: the board now says so instead of a desk quietly taking no
  message. Do not widen it to a range until there is code that reads an
  older or newer side correctly; today there is not. It is 2 since
  2026-11-22 ("How a desk runs Claude Code").
- **`supervised` became `supervisor`**, and the page's update is launchd's
  only. `ORCH_HOST_SUPERVISOR=app` is the app; launchd is still read from
  `XPC_SERVICE_NAME`; `ORCH_HOST_SUPERVISED=1` is still the suites'
  stand-in for launchd. An app-run host has no clone to move, so the board
  offers nothing (`available` false, not a button that is only refused),
  Settings says the app installs updates, and preflight refuses in the
  same words. A report with `supervised` and no `supervisor` is an older
  host and means launchd (`supervisorOf`).
- **The folder dialog has a backend that is not a command.**
  `ORCH_FOLDER_DIALOG=parent` asks the process that started the host over
  Electron's `process.parentPort` or Node's IPC channel (the host suite is
  the app that way), with an id per ask so a late answer to a closed dialog
  is not the next one's, and `close` so the app takes its dialog down when
  the host times out or stops. It went in under the rule above it — a
  backend goes in after it has been watched taking focus — because the
  app's agent watched Electron's dialog take the front in the app and
  recorded the table; the header of `host/dialog.js` has it. A host told
  to ask a parent it was not started with has no dialog and says so at
  startup.
- **better-sqlite3 is 13, and it needs Node-API 10, so Node 22.14 or
  later** (task #291, 0.12.6; the board, the gate and the host are all on
  Node 24 since 0.12.11, Tests, "What ships is what is tested"). 11.x does not compile against Electron 45's V8, and
  12.11.1 still calls `v8::Context::GetIsolate`; 13 is Node-API with the
  prebuilt binary for each platform inside the package. Its binary is
  Node-API 10, and a Node that offers 9 (20.x, 22.x before 22.14) does not
  fail to load it: the process segfaults, exit 139, with no words.
  Measured on 20.20.1 — this machine's default `node`, and the one the
  host's LaunchAgent runs on — and on 22.11.0. So `src/node-floor.js`,
  imported ahead of better-sqlite3 in `src/db.js`, says it in words. The
  host has no dependencies, and ran on Node 20 then; the image was node:22
  and loaded it. Both are Node 24 since 0.12.11. Two things keep that from costing anyone a round here.
  `scripts/node-floor.sh` is sourced by every runner under `.claude/skills`
  (seven `run-check-*.sh` had drifted without it until 2026-11-19, and from
  a Node 20 shell such a runner printed nothing at all; a new runner is
  checked with `grep -L node-floor.sh .claude/skills/*/run-*.sh`, which
  should list nothing)
  and by hand before a suite (`. scripts/node-floor.sh && npm test`): it
  reads `process.versions.napi`, leaves a good `node` alone, and otherwise
  puts the oldest nvm Node that has Node-API 10 first on PATH, or refuses in
  words. And every skill script that opens better-sqlite3 itself, or starts
  the server as a child, imports the floor first, because a seed that
  segfaults says nothing and a server whose output goes to a log file reads
  as a dead port. A new seed, check or runner takes the same line; copy it
  from `seed-desk.mjs` or `run-check-pop-foot.sh`. **The machine's default
  Node stays 20, and that is costmo's ruling** (2026-11-08: "I don't want to
  mess with node versions"; he switches by hand, in one shell, only to run
  the desktop app). So nothing here may ask him to change it, set an nvm
  default, or add a version file that a shell acts on: the helper changes
  PATH inside the script that sources it and nowhere else. Do not re-propose
  moving his default as the simpler fix. 12.11.1's call is written
  `context->GetIsolate()`; the qualified name is in no file, which is how a
  grep by the compiler's name reads that version as clean.
- **What the app asks for is added beside what runs, never in place of it**
  (costmo, 2026-11-07: "I do not want to break our current tool along the
  way"). Each of the four above is off unless the app turns it on, or is
  the same for launchd as it was: a number both sides already agree on, a
  word launchd never sets, a dialog backend chosen by an environment
  variable, a dependency the image already had the Node for. So a task from
  that channel is closed with what it changes for the board, the launchd
  host and the plugin as they run today, measured and not reasoned — for a
  dependency, **try-a-dependency** reads the live database through the new
  version before the tree has it — and anything that would change what the
  existing tool does goes to him as a decision first. The one such change so
  far is the protocol check: a deploy that rebuilds the board and leaves the
  host running now reads as a refused host, in words, until the host is
  restarted.

**Catching the app up to develop, and a first run that asks nothing**
(2026-11-19, meeting room 1 with orchestratinator-desktop-dev, at costmo's
ask: everything since the app stopped following, around 11-09; install to
first use on macOS without Docker; connect to a local Docker board). His
rule for the round, again: nothing that works in the Docker+launchd app
today may break. What the app runs and places is the contract
`orchestratinator.app_setup` on the orchestratinator-desktop channel,
beside `orchestratinator.consumed`. Four things this repo changed or
decided for it, each additive:

- **A History search under the app runs in a worker thread.** The search
  is `process.execPath host/history.js`, a process of its own so a 70 MB
  `JSON.parse` stays off the relay's loop. Under Electron's utility process
  `execPath` is the app's helper binary, and the app's RunAsNode fuse is
  off, so that cannot start there. `SEARCH_IN_WORKER` (true under
  `process.versions.electron`, or `ORCH_SEARCH_IN=worker`, the suite's
  seam) sends it to `searchInWorker`, a `worker_threads` Worker with the
  same answer, the same words on a failure and `terminate()` for a newer
  search. Everywhere else the spawn is untouched. One trap, measured: a
  worker's `process.argv[1]` is the worker's file, so history.js's "run as
  a script" branch also ran in it and wrote a JSON error to the host's
  stderr; it is guarded with `isMainThread`. Not yet measured: a Worker
  loading history.js from inside the packaged app's asar (desktop-dev's
  packaged check reads it; a failure is said on the floor, not silent).
- **The hook runs without a node on PATH.** A Mac whose only Claude Code
  is Anthropic's native install has no `node`, so every hook died in
  silence: no prompt, question or stop ever reached the floor. The line in
  hooks.json tries `command -v node` first, as before, then
  `~/.orchestratinator/bin/node`, a link the app keeps to the Node it
  carries, then nothing. `test:plugin` runs all three under a bare PATH.
  The hook line is in hooks.json twelve times, so mutate.py's
  exactly-once rule cannot carry its mutants: both were run as a whole
  file (the old line; the link tried before PATH), each red on its row.
  The other four of the round are `mutants-desktop-catchup.suite.json`.
- **The app installs the plugin as its own directory marketplace,
  `orchestratinator-app`, and only when no `orchestratinator-floor@…` is
  installed** (`claude plugin list --json`). Two copies would fire every
  hook twice, and on costmo's machine the live clone's
  `appideas-orchestratinator` is the installed one. Measured on 2.1.328 in
  an empty config dir: `marketplace add <dir>` and `install` exit 0 with
  stdin closed, need no sign-in, are idempotent, and a directory
  marketplace loads in place, so rewriting the copy is the update.
- **The app's host does not run when a launchd host serves the same
  board.** Two hosts for one board would both find every folder bound to
  it, and both relay and run its desks.
- **The app stops its host with SIGTERM and waits 30 s, because the host
  needs that long and Electron gives two.** The host's stop finishes the
  item in hand (up to `ORCH_STOP_DRAIN_MS`, 15 s), then releases and
  unregisters at up to 2 s each. Electron's `utilityProcess.kill()` ends
  the process 2 s after asking, whatever it is doing (the app's agent,
  measured with a stand-in that takes 3 s to leave: gone at 2.2 s, last
  step never run). So before 2026-11-19 every stop of a *busy* host under
  the app (quit, leaving the board, a restart) was cut off with nothing
  handed back, and 0.12.11's hand-back never ran there. An idle host never
  showed it. Nothing changed in this repo; it is here because the host's
  stop is this repo's, and a supervisor that gives it less than 20 s
  breaks "done once, handed out again, or said lost". Since 2026-11-22 a
  stop also ends each desk's Claude Code after the release (input closed,
  SIGTERM at 5 s), so the app's grace went from 20 s to 30 s
  (`HOST_STOP_GRACE_MS`, desktop-dev, task 340): 15 s of drain, 5 s to the
  SIGTERM, then 2 + 2 s. A stop that is cut off anyway leaves desks the
  next run ends (the bullet on task 340, "How a desk runs Claude Code").

A board to test "connect to Docker" against is a scratch container from
this tree's image, never the live one, and it is a script:
`.claude/skills/catch-up-the-desktop-app/scratch-docker-board.sh up [port]
| status | down` (its own tag, name, loopback port and volume; it refuses
8787 and 6724). That is not `docker compose up`, which would collide with
the live container by name. The app reads such a board's key from `docker
inspect` (Config.Env `ORCH_AUTH_TOKEN`), so nobody pastes it, and `/health`
names it `appideas-orchestratinator`. The same skill has the read that says
which commit the app really runs (`app-pin-check.sh`), the plugin commands
on today's Claude Code (`plugin-install-probe.sh`), and how a round with
the app's agent goes.

## A host on Windows (feature/windows-implementation)

**Who measures what on Windows is two roles, not two names, on a PC that
comes and goes** (costmo, 2026-11-24). The PCs are fleet machines lent
from E3 Webcasting, a related company we also write software for, and go
back to the field. So expect a different PC, a different user profile and
paths (`C:\Users\<someone>\…`), and different agent names from one round
to the next, and read the board's `whoami` list for who is there now. The
two roles: **the Docker install on Windows** (the Windows twin of the
Mac's Docker board and launchd host; `pc-developer` in 2026-11) and **the
desktop app on Windows** (the twin of orchestratinator-desktop-dev, which
directs it; `windows-desktop-dev` in 2026-11). A change here that the app
carries is proven in the app by the second; the Docker side by the first.
A new PC starts with nothing: no Node 24 (portable Node, as the 2026-11
rounds used), no Python or build tools, no clone, and possibly no GitHub
ssh key. So a round on it begins with what is installed, measured, and a
Windows finding names the PC it was read on.
Below, "pc-developer" means the Docker role as it was on the PC of those
rounds. **The desktop app shipped for Windows in
0.15.2** (2026-11-24): a Squirrel Setup.exe, per user with no admin
(costmo's pick), with Squirrel.Windows updates from `win32/x64/RELEASES`
on the CDN, built on GitHub's Windows runner so a release needs no PC,
and **unsigned by his decision** after Microsoft refused him an account
for its signing service ("Windows users get no signed app… If Microsoft
wants to pull their heads out of their asses, I might change my mind").
Do not re-propose signing unless he raises it. The app's half is recorded
in the desktop repo (`docs/desktop-app.md`, "Windows: …";
`docs/release-checklist.md`). Windows users of the Docker install are not
expected, and its update path on Windows is not worked on (his word, same
day).

2026-11-20, costmo's scope: the Docker install working on Windows, the
desktop app later. Built from this folder and measured on his Windows 11 PC
by **pc-developer**, a Claude Code desk on this floor running there (it
reaches costmo's app board over an SSH tunnel and has a Docker board of its
own on that PC's 8787). Nothing here can be seen from the Mac: **a claim
about Windows is believed when pc-developer has measured it there**, by the
same rule as the folder dialog's. Ask it with send_message and say what to
read; costmo nudges it. Every step below was measured unless it says
otherwise, and the code beside each says how, so this is the map, not the
record.

- **No multiplexer.** A desk's Claude Code is the host's child, started
  with no shell around it and `windowsHide` (`host/agent.js`), and
  `claude.exe` is found by its path (`findExe` in `host/claude.js`:
  `where.exe`, then `~/.local/bin/claude.exe`), because a folder winget
  adds to PATH is seen only by processes started after the install. psmux,
  which the window layer needed there, is not used. **The process path has
  not been measured on Windows** (the second spike's last line).
- **Paths are a machine's own.** The board (Linux, in a container) takes
  `/…` or a drive (`C:\` or `C:/`) as absolute and compares a drive path
  with separators and case folded (`isAbsPath`, `underRoots`, `baseName` in
  [`src/floor.js`](src/floor.js)); the host uses `node:path`, which is
  native (`isUnder` in [`host/identity.js`](host/identity.js)); the page
  has its own copies. `claude mcp add -s local` keys `~/.claude.json` as
  `C:/Users/…` while Node gives `C:\Users\…`: the hook (`localAt`) and the
  host (`atFolder`) fold the two. `ORCH_HOST_ROOTS` splits on
  `path.delimiter`. A test that expects a path spells it with `resolve()`,
  and one that checks a Windows answer uses a path absolute on the machine
  running it (`readAnswer` is native; a drive path is not absolute on a Mac).
- **The supervisor is Task Scheduler, and it does neither of launchd's two
  jobs.** It does not restart a task that exits, and Stop-ScheduledTask is a
  kill with no signal. So the task runs [`host/supervise.mjs`](host/supervise.mjs)
  (restarts after any exit; on a stop file it sends the host `{type:'stop'}`
  over IPC, which index.js treats as SIGTERM), started by
  `conhost.exe --headless node.exe …`, the only way measured to put nothing
  on screen. [`host/install.ps1`](host/install.ps1) writes `host.json`,
  stops a running host through the stop file before the task, and registers
  an AtLogOn task (Interactive, Limited, IgnoreNew). `-Uninstall` removes it.
- **A hidden process may not take the front** (the foreground lock): a
  dialog or a Windows Terminal it opens lands behind. The unlock that was
  measured to work is an invisible always-on-top owner (for a dialog), an
  ALT tap, AttachThreadInput to the front window's thread, then
  SetForegroundWindow. It is in [`host/dialog-win.ps1`](host/dialog-win.ps1)
  (the folder dialog, #28) and [`host/front-win.ps1`](host/front-win.ps1)
  (Open in Claude, which titles its window with
  `--suppressApplicationTitle` so the script can find it). Both were 4 of 4
  in front and focused. Not measured: a locked screen, two monitors.
- **Windows PowerShell 5.1, which every Windows has, has three traps.** It
  refuses `&&`. It does not escape a `"` inside an argument handed to a
  program, so values go to `node -e` through the environment
  (`install.ps1`). And without `[Console]::OutputEncoding` set to UTF-8, a
  path with an accent is mangled on its way to node; `Get-Content` of the
  UTF-8 log needs `-Encoding UTF8`. Run a script with `-File` (arguments
  arrive whole), never `-Command`.
- **A host started from inside a Claude Code session hands that session's
  markers to its children** (`CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, …),
  and a Claude Code that inherits them writes no transcript ("Transcript
  saving is off", measured by pc-developer on 2.1.330). `windowEnv` leaves
  them out (`PARENT_SESSION`) on every platform, a person's own Claude Code
  settings kept.
- **What runs on Windows.** `test:plugin` runs there (from PowerShell too:
  its wrapper finds the bash beside `git.exe`). Node refuses to spawn a
  `.cmd` or `.bat` without a shell (the CVE-2024-27980 fix), so an
  `ORCH_FOLDER_DIALOG` stand-in there must be an `.exe` (`node.exe` with
  `NODE_OPTIONS=--import` worked). Hooks run under Git Bash; a `node`
  installed after the terminal that started Claude Code is not on its PATH
  until a new terminal.
- **"Teach auto mode about your environment?"** stood three desks dead on
  the PC on 2026-11-22, read as idle on the window layer
  (`docs/robustness-review.md` is pc-developer's write-up). On the process
  path no dialog is drawn: one Claude Code raises would arrive, by the
  binary, as `request_user_dialog`, which the host declines and says on the
  desk. Not measured.

Measured working there at 9e160cc, on the window layer: the README's Docker
install (with `/plugin marketplace add ./`), the installed host (silent
start, restart after a kill, clean stop, AtLogOn, uninstall), messages,
permissions and questions from the floor, `/mcp` reconnect, Take a desk with the native
dialog, seats, History, attachments, and both terminal buttons in front.
How to measure a window or a dialog there is **measure-the-desktop**'s
Windows section.

**Scope is costmo's, and a relay can widen it.** A "host-side native file
picker for attachments" was built across the board and page on a relayed
reading of "native file/folder pickers", and removed the same hour: the
paperclip already opens Windows' own dialog through the browser. Something
new that crosses board and page is confirmed with him before it is built,
however it arrived.

## Tests

**Every suite, check and scratch board on this machine needs a newer Node
than its default first on `PATH`.** The default is 20.20.1, and costmo's
ruling is that it stays. The `node_modules` here holds better-sqlite3
13.0.3, and under Node 20 loading it ends the process with exit 139 and
not a word (measured 2026-11-16: `node -e "require('better-sqlite3')…"`,
139 under v20.20.1, `ok` under v24.22.2), which reads as a suite or a
server that printed nothing. So a run names its own:
`export PATH=$HOME/.nvm/versions/node/v24.22.2/bin:$PATH` at the top of the
command. Or `. scripts/node-floor.sh && npm test`, which puts such a Node
first for the shell, chosen by what it needs (Node-API 10), not by its
number ("The host under the desktop app", above); every runner under
`.claude/skills` sources it.

**And the host's own `ORCH_` variables are not in a suite's environment.**
A suite's hosts are started with `...process.env`, so an inherited
`ORCH_AUTH_TOKEN` or `ORCH_HOST_SUPERVISOR=app` would be theirs too
(2026-11-20: a host meant to have no key had the app's, and the host suite
read one red). A desk's Claude Code is started with none of them ("The
clear of 2026-11-20"; a seat's carries its own four, which a suite does
not read), so `env | command grep -c '^ORCH_'` should print 0 (4 in a
seat's process) before a run whose result will be quoted. In a shell where it does not:

```
for v in $(env | command grep -o -E '^ORCH_[A-Z_]+'); do unset "$v"; done
export TMPDIR="$(getconf DARWIN_USER_TEMP_DIR)"
```

**What ships is what is tested: one Node major and one lockfile**
(costmo's ruling on the milestone audit's finding 5, 2026-11-17, in
0.12.11). Before it the suites ran Node 24 with better-sqlite3 13.0.3 and
SDK 1.29.0, while the image ran Node 22 and `npm install` resolved the
caret ranges fresh at every deploy (better-sqlite3 11.10.0, SDK 1.32.2 that
day), and the host ran under launchd on the shell's Node 20. Now:
- **Node 24 for all three.** The Dockerfile's `FROM` names the major, the
  release gate refuses any other (`scripts/release-gate.sh` reads the
  `FROM`), and the host runs on a Node 24 (PATH, nvm's newest v24,
  Homebrew's node@24, or `ORCH_NODE`), never "whatever node is first".
  The pick is `host/node.sh`'s, and the LaunchAgent starts `host/run.sh`,
  which picks at every start, so an update that moves the major moves the
  host at the restart it already does (QA's L3; a plist that named the
  binary kept the host on it). A plist written before 0.12.11 names the
  binary, and `install.sh` run once replaces it. The shell's default
  stays 20. The gate's package step is `npm ls --all` and
  `scripts/check-lock.mjs`, because `npm ls` passes a version inside the
  range that is not the lock's (QA's L2).
- **`package-lock.json` is committed** (it was gitignored) and the image
  installs it with `npm ci`, copying the lock beside `package.json` so a
  lock-only change rebuilds that layer and a lock out of step fails the
  build. The versions locked are the ones the suites had run on all along.
  `npm run set-version` writes the lock's two version fields too, and
  smoke holds all four files to one number.
- **The runtime dependencies are exact versions, the lock's own**
  (0.14.6, desktop-dev's reading of QA's 0.14.5 OK). The desktop app
  installs this package as a dependency, and npm ignores a dependency's
  lock, so a caret range let the app's board resolve MCP SDK 1.32.2 where
  every chain here ran 1.29.0. Exact versions make the app ship what was
  tested; the image is unchanged (it installs the lock with `npm ci`).
  Smoke holds `dependencies` to the lock's versions, and the lock's own
  record of them to `package.json`. A bump is `npm install --save-exact`
  and a chain run, never an edit to one file.
- **c8 10.1.3 is the one dev dependency**, pinned exactly, for
  `npm run coverage`. The image installs `--omit=dev` and ships none of it.
- npm 11 warns that better-sqlite3's install script is "not yet covered by
  allowScripts". It is advice about a future default, not a failure:
  measured, a real `docker build` of the round's tree loads it (SQLite
  3.53.4) on Node 24.22.2 / npm 11.19.1.

`npm test` runs thirteen suites. `test:host` and `test:seats` are not unit
tests: each runs a **real host** against a **real server**, and the host
runs a stand-in Claude Code for each desk (`ORCH_HOST_CLAUDE`) that speaks
stream-JSON the way 2.1.330 was measured to and writes what Claude Code
writes on disk that the host reads (its roster entry while it runs, its
transcript), under a fixture HOME. `test:agent` holds `host/agent.js`
against a protocol stand-in alone (what it does by the words of a message
is in its header), and `test:claude` holds what survived of the window
suite in `host/claude.js`: the roster, the transcripts, the picker, a
resume's fallback, the environment. A suite killed halfway leaves a server
on its port (8896 for the host suite, 8902 for seats) and fixtures in
`data/`, which will poison the next run. Check for both before concluding a
failure is real.

**A suite can run beside a mutant batch on ports of its own**:
`HOST_TEST_PORT`, `SEATS_TEST_PORT` and `FLOOR_TEST_PORT` move
`test:host`, `test:seats` and `test:floor` off 8896, 8902 and 8897, and
`run-mutants.mjs --dest <dir>` with those variables set runs a second batch
in its own copy (both used through 2026-11-22's 0.15.0 round, side by side,
every control green). Without them a second run on the same port reads the
first one's server.

**Stopping a full run halfway takes more than killing `npm test`.** The
chain is `npm run smoke && npm run test:admin && …`, and on 2026-11-02
killing `npm test` and the suite under it left the chain's next link
starting on its own. What a half-run leaves, all named by the suite's pid:
`node test/<suite>.mjs`, its `node src/server.js`, its stand-in Claude Code
processes, and its database and fixture under `data/` (`host-<pid>.db`,
`host-fixture-<pid>`, `seats-<pid>.db`, `floor-<pid>.db`, and the like).
Kill the `node test/` processes and their servers, remove the fixtures,
then check `data/` again before the next run.
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
One from 2026-11-18. **In zsh, `$var:h…` is a modifier, not a colon.**
`git show "$r:host/x.js"` takes `:h` as "head of the path", so git was
asked for `.ost/x.js` and said "ambiguous argument". It bit twice in one
evening, in a loop over commits. Write `"${r}:host/x.js"`.
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

**QA's clean-clone runs share this machine's CPU, not its ports.** Their
suite announces itself on the channel with its ports (8896–8901, or 8871/
8872 when they stay off yours); a full run of yours overlapping it went
red in six `test:host` cases at load 5.5, and `test:host` alone straight
after was green (2026-11-03, task 247). Read the channel for their
announcement before a full run, and if you overlapped, rerun the red suite
alone before reading anything else.

**Green suites did not prove a new operator's first session** (0.15.0,
2026-11-23). At a gate of 3259 ✓ and 19 of 19 pages, costmo's first session
in a fresh scratch app found four faults in an hour (above, "Four
first-session faults"). So before a build reaches him, a new operator's
first session is walked in the real app on a real Claude Code: launch, Take
a desk, first message, a permission, a question, signed out and Sign in, both
handoffs, each a pass or a break with a screenshot (desktop-dev's
start-scratch.mjs). The one step only a person takes is the browser sign-in;
nothing else is put on his list as a proof. Three things from the same round
about reading the gate:
- **A page check can find its port taken by another session's rig**
  (run-release-pages numbers ports 8941 up; QA's rig held 8952, so
  check-floor-windows printed "refusing: PORT … is taken" and no verdict).
  Rerun that check alone on a free port.
- **A red that reproduces alone under extreme load needs a control at the
  parent commit**, not a verdict: test:floor's silent-room row was red twice
  at load 545 on a tree that did not touch it, the parent was green at 285,
  and the tree was green alone at 49.
- **A rig in Claude Code's defaults hides a fault that only an operator's
  own settings show** (0.15.1, 2026-11-23). 0.15.0 passed 3259 ✓, 19 of 19
  pages and a first-session walk, then flooded costmo's desks with
  prompts within the hour: every rig ran in `default` mode, where asking is
  normal, and his desks had run in `auto`. Two things made it invisible.
  The suites' stand-in Claude Code reported `permissionMode: 'default'`
  whatever it was started with (it now reports the flag's mode), and a
  scratch config has no `defaultMode`. So an upgrade walk starts from an
  operator's real shape: conversations left in auto, a settings file with
  and without `defaultMode` (desktop-dev's `rehearse-upgrade.mjs` fails if
  a desk is in `default` after an update). And "it did not ask" in a probe
  proves nothing on this machine, whose settings allow most tools: force
  a prompt with `--settings` (**measure-a-real-window**, 5).
- **A mutant can survive because a test env names the thing twice**: the
  seat hook rows passed with the binding-file read removed, because the seat
  env also carries ORCH_CHANNEL / ORCH_AGENT. A row with the file alone
  catches it.

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

**He ruled it again on 2026-11-22, three times in one morning**, during
the 0.14.5 round's whole mutation runs at loads of 250 to 580. The last
one was after QA had set "GO when the load is under 30 for two minutes"
and the coordinator had passed that on without objecting: "this system
does more than just your work. You need to work around system resource
issues caused by other development projects that run at the same time."
So a proposal from any agent to wait for the load, ask for the machine,
or bring another project's load to him is refused on the spot, citing
this paragraph (QA's decisions/0016 is the same rule). Under that load,
whole suites went red once each on rows that were green alone. Read them
the rules' way:
- Rerun the row alone, with `uptime` beside it.
- A runner that cannot get past a red baseline restarts unchanged.
- After three red baselines, change the instrument (a mutant's own row
  as its control, `--quick`), never the timing.
- A mutant "caught" only by a timeout is listed apart from one caught by
  an assertion.
- Four such rows in the app's suite were each a test reading something
  before it was there or mid-write, and each fix waited on the thing
  itself, never on a longer timeout.

**Reading a red in `test:host`.** The window layer's host suite had a long
run of intermittent reds, each first written down as load. What still
holds from them:
- **A red that goes green on a rerun is not thereby load.** Four sightings
  of one were written down as load, each with a load average beside it,
  and it was a race (QA, PR #57 Info 10). **The host's log beside the reds
  is what names it**: the suite prints the host's log at its end, every
  line timed, and a gap in it is work held on the host's line; the line
  before the gap is where to look.
- **A move's session row on the new floor** ("the new floor holds no
  session row for the conversation it left") was a race between `bind()`
  and the watch loop, seven sightings, all under load, read on the seventh
  (2026-11-16). `test:host` sets `ORCH_HOST_BIND_GAP_MS=700`, a seam that
  holds the moment after `bind()`'s rescan open longer than a watch tick,
  so a race there is seen on every run, not only under load. Unset, the
  seam is no pause. When that assertion fails the suite prints the session
  row, the turns filed under the old id with their floor, and the host's
  log from the move on.
- **A row that restarts the host and then writes to the transcript waits
  for a turn to arrive first** (the primer turn): the desk joins the
  transcript where it stands at its first watch tick, and a marker written
  before that tick is behind the offset for good.
- **When a row proves something did not happen, read the whole log after
  later work has been observed, not after a sleep**: an absence has
  nothing to wait on (QA, PR #55 Info 11).
- **When a mutant survives once in several runs, the row is being answered
  by another path some of the time**: find the second path before adding a
  wait (QA, PR #57 Info 11). And count reds by what the suite printed:
  `run-mutants.mjs` once read `FAIL ❌ — 2 failure(s)`, the closing line of
  most suites, as a third red. `--logs` keeps each run's output, so a count
  can be checked against it, and `--control` runs an unmutated control
  beside the mutants (**mutate-in-a-copy**).
- **An A/B of a flaky row alternates which side goes first, and runs with
  nothing else of yours beside it** (2026-11-20: a reading of "0 of 4
  before, 3 of 4 after" was the second run of each pair starting under the
  first's load).
- **The heartbeat**: `last_seen` does not mark one (the host registers after
  every bind and rescan too), and it is checked when the work poll returns,
  up to 25 s late, not every 60 s on the dot.

Seen and not explained, written down so the next one is read with its log
kept rather than rerun: `test:host`'s issue #5 rows ("a failed poll still
re-registers before the next" and its neighbours, which share `runHost`,
ending the host after 8000 ms and wanting four requests in that time), red
in 5 of QA's runs across two commits (2026-11-16/17) and green in the next
six; and two `test:update` rows in the Finish the update flow, once at load
84–98 (2026-11-19), with 0 red alone straight after.

**The activity feed is newest-first, and a kind prefix is wider than it
looks.** `/api/activity` returns rows newest first, so `.slice(before)`
on it hands you the *oldest* rows; and `admin.desk.*` matches
`desk.moved` and `desk.bound` as well as `desk.hide` / `desk.show`. A
first cut of the move test asserted both ways, costmo pushed the tree
while its suite ran, and QA measured a red at that SHA (0d18a9f). Name the
kinds you mean, and find the new rows by diffing a set of the rows that
were there before — by identity, not by position or count.

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

**The host suite's stand-in starts a new conversation under an id the test
names** (`fresh-id.flag`, used once), so "a new conversation" is an id the
desk can be seen to follow. And **`argv.log` is one line per process
started**: count launches with `.split('\n').slice(0, -1)`, never
`.trim().split('\n')`, which reads "none at all" as one launch and passes a
case that should be red.

**A chain put in the background with `( … ) &` reports done at once.** The
agent's shell says "completed" for the command it ran, which was only the
launch, so the notification arrives with nothing to read and the suites
are still running (2026-11-16, three suites launched that way). Give the
harness the chain itself as the background command, or wait on the
process: `while kill -0 <pid> 2>/dev/null; do sleep 3; done`. And a suite
run beside your own floor suite or mutant lanes is run under load of your
making: the host suite read seven reds that way and 327 ✓ alone.

**`test:seats` is the host suite for several desks in one folder** (0.12.9;
rewritten for the process layer 2026-11-22). Its stand-in is what Claude
Code is when several run in a folder: each process writes its own session
file and transcript, connects as the desk its `--mcp-config` file names (or
else the folder's), and answers every message "I AM <channel>/<agent> on
<conversation>", which is what lets a row say *which desk* a process is.
`--resume` of a conversation with nothing in it ends the process on its
first line, as Claude Code does. Port 8902. It has no plugin, so what a
real Claude Code's hooks do at a close is not in it (see "One agent,
several sessions": the fault it missed). And **a row that says something
"stays" proves nothing while the thing is too young to be looked at**: the
sweep leaves any session alone for its first 30 s, so such a row ages it
first.

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

The seats stand-in can be mid-turn on purpose: a message containing `look
busy` is taken and left without a `result`, and `look idle` ends that turn.
The floor suite runs its board with `ORCH_TWIN_UNHEARD_MS=3000`, so the
silent-room rows wait seconds and not a minute and a half.

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

- **A release round starts only from a PR whose user paths the developer
  has already run and posted** (costmo, 2026-11-23, after 0.15.0: "Do this"
  to QA's four proposals, which QA records as its `decisions/0018`). The
  0.15.0 round measured upgrades and signed-in desks; the three things he
  found by looking (no Sign in on a signed-out desk, a false canary banner on
  every app launch, "0 need you" while a prompt stood) were all on a new
  operator's path, and cost him most of a day. So before asking QA for a
  round, the developer runs and posts, at the PR's head:
  1. **The update path**: an installed previous release replaced by this one,
     the way a user's update does it, desks open (C1's shape).
  2. **A new operator's first session**: a fresh profile and a signed-out
     Claude Code, the real screens driven up to the one click a person makes
     (the browser sign-in), then Take a desk, a message, a permission, a
     question, signed out and Sign in, both handoffs; each a pass or a break
     with a screenshot. The app's walk is desktop-dev's start-scratch.mjs; the
     Docker one is a scratch board and a scratch HOME.
  3. **Real Claude Code probes**: `protocol-probe.mjs` and, for anything that
     touches prompts, `ask-probe.mjs` with a background subagent asking
     (measure-a-real-window).
  The proof of a user path is a person's click on the real control, never an
  API call standing in for it, and never a command put on costmo's list. The
  other three, which bind the round: **scope is fixed** once the measured
  list is known (QA freezes it in writing; after that only what stops a new
  operator, loses work, or reads as broken on a first session blocks the
  tag); **the gates run once**, at the final commit; **a stuck agent is
  reported at once** (the floor wakes a desk with work waiting, `wakeDue`).

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
  | `src/ui/*` | `test:floor`, and the page checks for the area (**verify-ui-change**); `test:markdown` also reads `floor.js` (the renderer), `test:update` reads `app.js` |
  | server `src/*.js` | `smoke`, `test:admin`, `test:auth`, `test:boardlog`, `test:floor` |
  | `host/index.js`, `dialog.js`, `history.js`, `log.js` | `test:host`, and `test:seats` for `index.js`; `test:floor` and `test:update` also read `index.js` |
  | `host/dialog-win.ps1` | `test:host` (the command rows); what it does on a screen only by hand on Windows, from a hidden scheduled task, with somebody watching (the header of `host/dialog.js`) |
  | `host/front-win.ps1`, `host/install.ps1` | no suite: by hand on Windows through pc-developer (**measure-the-desktop**, Windows) |
  | `host/supervise.mjs` | `test:host` ("the supervisor Windows runs the host under") |
  | `host/agent.js` | `test:agent`, and `test:host` and `test:seats`, whose host runs it |
  | `host/desk.js` | `test:host`, `test:seats`, and `test:floor` (`commandPlan`) |
  | `host/claude.js` | `test:claude`, `test:host`, `test:seats` |
  | `host/seats.js`, `host/identity.js` | `test:seats`, `test:host` |
  | `host/auth.js` | `test:host` |
  | `host/version.js` | `test:host` (its unit rows and the version line on a desk) |
  | `host/canary.js` | `test:host` (`probeNode` only); the checks themselves only on a real Claude Code, `protocol-probe.mjs` (**measure-a-real-window**) |
  | `src/updates.js`, `host/update.js` | `test:update` |
  | `src/uploads.js` | `test:floor`, and `test:host`, whose board runs it |
  | `host/uploads.js` | `test:host`, and `test:floor`, which reads its header |
  | `host/install.sh`, `host/node.sh`, `host/run.sh` | `test:host` (its install rows, on stand-ins) |
  | `scripts/set-version.mjs`, `scripts/check-lock.mjs` | `smoke` |
  | `Dockerfile`, `package.json`'s dependencies, `package-lock.json` | no suite: a real `docker build` in a scratch tag, `npm ls` inside it against the lock, and `node -v` against the gate's |
  | `scripts/release-gate.sh`, `scripts/coverage/` | themselves: a seeded red in a copy for the gate; for coverage, `report.mjs` over a known set of snapshots |
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
  ran past the tool's output limit. **And pass `since` after a reset**:
  the last message id the summary names. `poll_messages` with no `since`
  starts at 0, and on 2026-11-22 it returned the floor's oldest hundred
  (from id 2220, three weeks old), past the output limit, while the new
  messages sat above them. With no id to hand, pass a `since` far above
  any id (`99999999`): the board answers `since_ahead` and reads from its
  own record of what you were given, which is exactly the unread
  (measured 2026-11-24).
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
  not on screen while the real prompt sat there unread. Quote what was seen: the log line, Claude Code's own words.
- Comments here explain *why*, especially where the obvious approach was tried
  and failed. Several say so outright. Preserve that when editing near them.
- **A deliberate omission needs its reasoning written down, or it reads as
  backlog.** This is the one that costs the most, because it costs it again
  every session: an agent meets a gap, makes the same reasonable guess about
  why it is there, and offers to fill it. Saying "this is deliberate" is not
  enough — what stops the question is showing that the failure mode being
  imagined does not occur. The `ask` handler in [`host/desk.js`](host/desk.js)
  is a worked example: it says both why the host declines a request the
  floor cannot answer (so the turn is not held for ever) *and* what the
  operator sees instead (a line on the desk naming the request). Write the
  second
  half. If you find yourself asking "is now the time to do this?" about
  something with no note beside it, the answer may well be no — and the fix is
  a paragraph, not a feature.

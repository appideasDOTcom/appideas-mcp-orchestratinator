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

**The server is the other half, and it goes stale independently.** `src/` is
baked into the image (`build: .`; only `/data` is a volume), so a change there
needs `docker compose up -d --build` — and that printing `Container … Running`
instead of `Recreated` means it did *not* take your change. Restart each in its
own command and then check both against the file mtimes. Chaining them behind
`npm test` once exceeded a seven-minute timeout and left a stale container **and**
a stale host while the suite reported green.

Two more facts about that rebuild, both measured 2026-09-01. It blanks
presence for every desk — presence is an MCP session in the server's memory —
while the relay rides out the restart on its own retries, so the board shows a
conversation flowing between desks that look absent. Nothing is broken; one
MCP tool call per desk brings each back. And the `/data` volume is *named*:
the repo's own `data/` directory is test leftovers, not the live database, so
a row repair goes through `docker compose exec -T orchestratinator node` with
better-sqlite3 at `$DB_PATH`, never through a file in the working tree.

Two loops run side by side in [`host/index.js`](host/index.js): `watchLoop()`
relays the conversation, `run()` handles work. Keep them apart. When they shared
one loop, delivering a message blocked the relay for up to a minute — the floor
went silent mid-conversation and then dumped the backlog in one batch.

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

`answer-the-form.mjs` in that skill answers a floor form and records the pane, so
none of this needs the operator to sit and click.

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
desk is doing. Empty thinking blocks are common and are skipped.

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

## Tests

`npm test` runs eight suites. `test:host` and `test:window` are not unit tests:
they drive **real tmux panes** against a **real server**, with a stand-in
`claude` (a `.cjs`, because this package is `"type": "module"`). They use their
own tmux session names and ports, so they are safe to run beside a live host —
but a suite killed halfway leaves a server on port 8896 and fixtures in `data/`,
which will poison the next run. Check for both before concluding a failure is
real.

`test:plugin` covers the floor hook, which is the one part built to fail in
silence — `hooks.json` runs it detached with every stream sent to `/dev/null`, so
a fault there shows up as prompts quietly never reaching the floor while the
conversation keeps relaying. Most of its assertions are about what is *not* sent.
It drives `hooks.json`'s own shell line under real `sh` too, and asserts all
eight events carry the identical command — editing one and not the rest is the
drift it guards against.
Its fixture lives in `tmpdir()`, not `data/`: the hook walks six levels up
looking for `.mcp.json`, and a fixture inside the repo reaches this repo's own —
so the "outside a repo" cases resolve against the real board and post to the
operator's live floor.

## Conventions

- **Git is Chris's.** Never commit, push, or offer to. Leave changes in the
  working tree; reviewing the diff is how he checks the work.
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

---
name: measure-a-real-window
description: Find out what Claude Code actually does — stand up a throwaway real Claude Code in an isolated tmux session, drive it, and read its transcript. Use before believing any claim about how a window behaves, including the claims written in this repo.
---

# Asking Claude Code instead of reasoning about it

This repo drives a program it does not own. Every rule in `host/window.js` is a
claim about how Claude Code behaves, and **the only thing that can settle such a
claim is a real Claude Code**. Neither of the other two options can:

- **`npm run test:window` uses a stand-in.** A `cat` that appends stdin accepts
  the Enter a TUI drops, never queues, never redraws, and has no transcript of
  its own. It proves the *delivery path*, which is why it exists — it cannot
  prove anything about the program at the other end.
- **The live board is the operator's.** Experimenting there puts test traffic in
  real conversations and permission prompts on the floor he is watching.

So: a third window, that belongs to you. It costs a few minutes and about a
minute of tokens, and it is the difference between knowing and guessing.

**This is not a last resort.** On 2026-09-01 the whole design of `send()` rested
on a comment saying a paste into a running turn "is not queued, it is dropped —
it was losing two messages in three". It had `measured` next to it. It was
false, and one probe disproved it in under five minutes:

| the claim | what a real window did |
|---|---|
| pastes into a running turn are dropped | five for five arrived, queued, and were recorded **in order** |
| a queued message waits for the turn to end | read after **0.8s**, answered after **2.3s**, mid-task |

**A comment saying "measured" is a claim about a version that has since moved.**
Re-measure before building on one.

## The script

[`probe.mjs`](probe.mjs) does the fiddly parts. Everything below is also written
out by hand, because when it misbehaves you need to know what it was doing.

```bash
SP=<your scratchpad>
node .claude/skills/measure-a-real-window/probe.mjs up   "$SP/probe" auto
node .claude/skills/measure-a-real-window/probe.mjs say  "$SP/probe" 'a long task…'
node .claude/skills/measure-a-real-window/probe.mjs watch "$SP/probe"      # busy? footer?
node .claude/skills/measure-a-real-window/probe.mjs say  "$SP/probe" 'PING: answer PING-OK'
node .claude/skills/measure-a-real-window/probe.mjs timeline "$SP/probe"  # every record, in order
node .claude/skills/measure-a-real-window/probe.mjs down
```

## Never the operator's session

Use a **separate tmux socket**, not just a separate window. `-L probe` is a
different server entirely, so nothing you do can reach `orch`, and
`tmux -L probe kill-server` cannot take his desks with it.

```bash
tmux -L probe new-session -d -s p -n probe -c "$SP/probe" -x 200 -y 50 'exec claude'
```

`-x 200 -y 50` matters. A detached session defaults to 80 columns, and **pane
width changes what parses** — a footer that fits at 160 wraps at 80 and the
capture no longer contains the string you are looking for.

**Say which window you are working in.** The operator can attach to any socket,
and on 2026-09-01 he did — typing into the probe pane while it was being
measured, which read as a phantom keystroke source and cost a round to chase
down. He is not doing anything wrong; he cannot see a window he was not told
about. Name it, and give him one you are not using if he wants to play.

**The same goes for background sessions.** `claude agents --json` lists every
one on the machine, and `claude stop <id>` on one that is not yours ends
somebody's conversation holder with nobody watching. Make your own to
measure against — see "A background session" below — and stop only that.

## The probe inherits your environment

A fresh `tmux -L probe` server takes its environment from whoever starts it,
and when that is a Bash tool inside a Claude Code session the pane gets
`CLAUDECODE=1`, `CLAUDE_CODE_ENTRYPOINT=claude-vscode`, `CLAUDE_CODE_SESSION_ID`
and a dozen more — a window that is, as far as Claude Code can tell, nested
inside an IDE session. Read what the pane actually got, not what you exported:

```bash
ps eww -o command= -p "$(tmux -L probe list-panes -t p:probe -F '#{pane_pid}')" | tr ' ' '\n' | grep '^CLAUDE'
```

Strip them with a loop under `bash -c`, not with an `env -u` list held in a
variable: zsh does not word-split `$UNSET`, so `env $UNSET …` hands `env` one
argument, unsets nothing, and prints no error (measured 2026-09-03).

```bash
bash -c 'for v in $(env | grep -oE "^CLAUDE[^=]*"); do unset "$v"; done
         node .claude/skills/measure-a-real-window/probe.mjs up "$1" auto' _ "$SP/probe"
```

One thing this did not unlock: `CLAUDE_FORCE_DISPLAY_SURVEY=1` never drew the
"How is Claude doing this session?" survey in a probe on 2.1.258 — three runs,
stripped or not, watched for over a minute after the turn. Whatever gates it is
not the environment alone, so the survey is not something a probe can currently
be made to show; `open()` in `host/window.js` says what was done about it
instead.

## Getting a window up

Two dialogs stand between `exec claude` and a usable window, and **neither is
auto-answered** — `ANSWERS` in `host/window.js` is deliberately one question
long. Answer them yourself:

```bash
# trust dialog: an arrow list with the cursor on "No, exit" — move down, then confirm
tmux -L probe send-keys -t p:probe Down; sleep 0.5; tmux -L probe send-keys -t p:probe Enter
# MCP dialog: an arrow list too, cursor starts on "Continue without using this MCP
# server" — Enter there *disables* the server. Up twice lands on "Use this MCP
# server"; a digit moves nothing (measured 2026-09-03, see host/window.js's
# startupQuestionOf).
tmux -L probe send-keys -t p:probe Up; sleep 0.4; tmux -L probe send-keys -t p:probe Up
sleep 0.4; tmux -L probe send-keys -t p:probe Enter
```

- `Quick safety check: Is this a project you created or one you trust?` — the
  folder-trust dialog, on any directory Claude Code has not seen. On 2.1.258
  it is `❯ No, exit / Yes, I trust this folder` with the cursor on **exit**:
  a digit does nothing and Enter alone quits (measured 2026-09-03 — "1 then
  Enter" exited rc=1 three runs in a row, and every capture afterwards said
  "no server running", because the pane's exit took the server with it).
  Run the pane as `claude; echo "[exited $?]"; sleep 900` while measuring, so
  an exit is something you can read rather than a server that is gone.
- `New MCP server found in this project` — if the scratch dir is under a repo
  with an `.mcp.json`. Keep the probe dir somewhere with none.

Permission mode is cycled with `BTab` (**not** `S-Tab`), in the order
auto → manual → accept edits → plan → auto. Loop until the footer reads what you
want rather than counting presses:

```bash
for i in 1 2 3 4 5; do
  case "$(tmux -L probe capture-pane -p -t p:probe -S -2 | tail -1)" in *"auto mode on"*) break;; esac
  tmux -L probe send-keys -t p:probe BTab; sleep 1
done
```

Use **auto** when you want tool calls to run, **manual** when you are trying to
raise a permission prompt on purpose.

## Making it busy — and the shape of the task decides the answer

This is the part that produced the one wrong number in that session, and it is
worth more than the mechanics.

| task | what it measures |
|---|---|
| `write out the numbers from 1 to 3000, one per line` | one uninterrupted assistant message. **No step boundary until it ends.** |
| `do this as six SEPARATE Bash calls, one at a time: echo A … echo F` | ordinary agent work: a boundary every few seconds |

A queued message injected into the first shape waited **41 seconds** — and that
number is an artefact of the task, not a fact about Claude Code. The same
measurement against the second shape was **0.8 seconds**. Quoting the first would
have described a working feature as impossible.

**Match the task shape to the behaviour you are claiming.** If the answer turns
on a boundary — a step, a tool return, a poll — the task must actually have them.
The single-message form is still worth running, as the *worst* case; just never
report it as the case.

Whether it is working is the status line, positionally:

```bash
tmux -L probe capture-pane -p -t p:probe | tail -1   # "· esc to interrupt ·" → busy
```

Not a grep of the capture. `capture-pane -S -N` is N lines of scrollback **plus
the whole visible pane**, so a grep matches the conversation too — including a
window discussing this very string.

## The transcript is the instrument

The pane tells you what a person would see; the transcript tells you what
happened, with timestamps to the millisecond.

```
~/.claude/projects/<cwd with / and . replaced by ->/<session-id>.jsonl
```

**Parse every record type.** This is the mistake that cost the most time in that
session: a probe that only looked at `type: 'user'` and `type: 'assistant'`
concluded a queued message was never recorded, when three other records had
written it down immediately. `readTranscript()` in `host/window.js` had the same
blind spot, and it was a real bug, not just a measurement error.

Types seen so far — dump them all before filtering:

| type | what it is |
|---|---|
| `user` / `assistant` | the conversation |
| `queue-operation` | `enqueue` when a message is queued, `remove` when read. `content` holds the text |
| `attachment` | `attachment.type === 'queued_command'` is a message injected mid-turn — **the only record of one** |
| `system`, `summary` | noise for most purposes |

```bash
node -e 'const fs=require("fs");
for (const l of fs.readFileSync(process.argv[1],"utf8").split("\n")) { if(!l.trim())continue;
  const j=JSON.parse(l);
  console.log(String(j.type).padEnd(16), String(j.operation||j.attachment?.type||"").padEnd(15), j.timestamp); }' <transcript>
```

## A line in the composer that nobody typed

Since 2.1.300 Claude Code draws a **prompt suggestion** a few seconds after
a turn ends: a plausible next message, as ghost text after the cursor. On a
plain capture it is indistinguishable from a typed draft, and on
2026-11-02 three such lines on probe desks were reported as "typed into the
composer and never sent", with no record of what typed them — because
nothing had. Two reads tell them apart, and neither presses anything:

```bash
tmux -L probe capture-pane -p -e -t p:probe | grep '❯'      # SGR 2m (dim) = a suggestion
tmux -L probe display -p -t p:probe '#{cursor_x},#{cursor_y}' # column 2 = nothing typed
```

A suggestion is dim (`\x1b[2m`) and the cursor stays at column 2, behind
the `❯`; typed text is in the default colour with the cursor at its end.
The transcript has no record of a suggestion. `composerOf` reads it as the
composer's contents, which matters to nothing the host does with that
reading, and a paste through `send()` replaces it — measured: one user
record with the host's own words and none of the suggestion. Tab or Enter
would accept it, so never press either "to see what happens" on a window
that is not yours. Not every turn gets one: a one-word reply drew none in
60 s, a turn with three Bash calls drew `cat notes.txt` after 2 s.

[`suggestion.mjs`](suggestion.mjs) does the whole measurement on the probe —
a work-shaped turn, the wait for the dim row, `composerOf` and the cursor,
then `send()` over it and the user records that followed. Run it on a new
Claude Code before trusting the paragraph above.

## Recording the pane over time

For anything about *timing* on screen, a single capture is not enough — see
[`watch-the-window`](../watch-the-window/SKILL.md), which is the sibling of this
skill: it records panes and the board's awaiting state for a window that already
exists. Use that one for a desk that is misbehaving, this one for a question
about Claude Code itself.

## A question form

[`form.mjs`](form.mjs) raises a real AskUserQuestion on the probe, reads it
every way the floor does, and — given answers — plays them through the host's
own `answerSteps` and `answerQuestion` and reads the tool result back out of
the transcript.

```bash
PROBE_SOCKET=probe node .claude/skills/measure-a-real-window/form.mjs "$SP/probe" \
  'two single-select questions: header "One", question "Which one?", options Alpha, Bravo; header "Two", question "And which?", options Red, Green' \
  '[{"choose":[1]},{"choose":[2]}]'
# pane 200x50 alternate_on=1; top line …
# readQuestions  → One[single,3] Two[single,3]
# formFromInput  → One[single,3] Two[single,3]
#   rows, numbers, free-text rows, kinds and strip: IDENTICAL
# settleForm     → from=pane: a form of 2 question(s) read off the pane
# answerSteps    → Left Left Left 1 2
# answerQuestion → ok=true code=- done=[Left Left Left 1 2 Enter(confirm)] in 4612 ms
# tool result    → "Your questions have been answered: …"
```

Leave the answers off and it cancels with Escape.

A typed answer on a single-choice question is a different path: the keys end
at `N Enter`, the tool result is the decline, and the floor then sends one
message carrying every answer. `form.mjs` plays the first half;
[`clarify.mjs`](clarify.mjs) plays the second from the same answers and
reads the receipt — the user record and the agent's reply — which is the
only proof the ruling on issue #7 (2026-11-02) is what runs:

```bash
PROBE_SOCKET=probe node .claude/skills/measure-a-real-window/form.mjs "$SP/probe" \
  'three single-select questions: header "Colour" …; header "Fruit" …; header "Weekday" …' \
  '[{"choose":[3]},{"choose":[4],"text":"I like Dragon Fruit"},{"choose":[3]}]'
# answerSteps    → Left Left Left Left 3 4 Enter
# tool result    → "The user doesn't want to proceed with this tool use…"
PROBE_SOCKET=probe node .claude/skills/measure-a-real-window/clarify.mjs "$SP/probe" \
  '[{"choose":[3]},{"choose":[4],"text":"I like Dragon Fruit"},{"choose":[3]}]'
# clarifyMessage → "Colour: Orange. Fruit: I like Dragon Fruit. Weekday: Friday."
# user record    → 2026-11-02T20:24:29.867Z "Colour: Orange. Fruit: I like Dragon Fruit. Weekday: Friday."
```

What `form.mjs` was built to measure, and what it found on 2.1.284
(2026-10-01, issue #7):

- **`#{alternate_on}` is 1.** The window draws on the alternate screen, so
  `capture-pane -S -N` above the visible pane is *startup output*, not the
  conversation, and nothing a redraw removes is anywhere.
- **A form taller than the pane loses its top rows.** Resize before raising
  (`tmux -L probe resize-window -t p:probe -x 80 -y 24` — what a window is
  until somebody attaches) and a 26-row form has no header row: `readQuestions`
  says `not_a_form`. Make only the second tab tall and it says `form_cut`.
  The form built from the call's input is unaffected, and the cut form still
  takes its keys.
- **A bare paste is declined.** Given only a pasted block, the window answers
  "Your message contained only pasted text, with nothing from you saying what
  to do with it" and waits. Type the instruction (`send-keys -l`), which is
  what `form.mjs` does; `probe.mjs say` pastes, and is right for everything
  that is not an instruction to follow.
- **The open call is the last one without a result.** Two questions with the
  same text fail validation at once, the model retries, and the form on
  screen belongs to the retry.
- **A late key.** Point `ORCH_TMUX` at a wrapper that holds one `send-keys`
  back a few seconds and the host sees what a stalled window looks like;
  `form.mjs` reads the pane on the socket directly, so only the host's keys
  are delayed.

Timing on a probe is the floor of it, not the case: last digit to "Ready to
submit your answers?" was 28–57 ms on a window with a short conversation. A
desk with a long one was not measured — forms are not raised on his desks.

## A probe desk on a throwaway board — the whole path, without deploying

The probe above answers "what does Claude Code do". When the question is
"what does *our* code do with it" — a receipt in `send()`, a hook the plugin
forwards, a state the page draws — the throwaway window is not enough: the
host's `send()`, the server's `ingestHookEvent` and the page all have to be
in the loop, and the live board is the operator's. This is how the 0.10.9
round (issues #9/#10/#15, 2026-11-03) was built and driven end to end with
the live board untouched; the tools are in [`probe-desk/`](probe-desk/).

```bash
D=.claude/skills/measure-a-real-window/probe-desk
P=/Users/costmo/Documents/dev/appideas/coord-probe-NNN        # under the host's roots, a name of your own
$D/make-probe.sh "$P"                                         # hooks → $P/hooks.log, a CLAUDE.md, filler.txt

# the throwaway server, from the tree, on a private port, with its own key
PORT=8905 DB_PATH=./data/scratch-NNN.db ORCH_AUTH_TOKEN=probe-NNN ORCH_AUTH_MODE=enforce node src/server.js &
# bind the probe to it (Claude Code's own CLI; the live host then skips the folder as "another board")
( cd "$P" && claude mcp add -s local --transport http orchestratinator http://localhost:8905/mcp \
    -H "X-Channel: coord-probe" -H "X-Agent: probe" -H "X-Orchestratinator-Key: probe-NNN" )
# a second host, from the tree, pointed at it — it discovers only the probe (every other desk is another board's)
ORCH_URL=http://localhost:8905 ORCH_AUTH_TOKEN=probe-NNN ORCH_HOST_ROOTS=/Users/costmo/Documents/dev/appideas \
  ORCH_HOST_ID=probe-host ORCH_HOST_NAME='probe host' ORCH_TMUX_SESSION=orch ORCH_HOST_CONFIG=/nonexistent/host.json \
  node host/index.js 2>&1 | while IFS= read -r l; do printf '%s %s\n' "$(date -u +%H:%M:%S)" "$l"; done > rec/host.log &
# open the window from the floor: POST /api/floor/open {channel, agent}; the pane is orch:<folder name>
# the tree's hook, beside the installed plugin's, so the new events reach the throwaway board
#   (the installed plugin fires only the events its cached hooks.json names; the probe's own
#    settings.json can run plugin/hooks/report.mjs from the tree for all twelve — see make-probe.sh's output)

mkdir -p rec
$D/pane-recorder.sh rec/pane.log orch:coord-probe-NNN &                     # every change, 150 ms
$D/floor-recorder.sh rec/floor.log http://localhost:8905 coord-probe probe & # the desk, on change
PROBE_DIR="$P" REC="$PWD/rec" BOARD=8905 CHANNEL=coord-probe AGENT=probe \
  node $D/probe-send.mjs send '/btw what is 2+2?' 25     # → host log, floor changes, hooks, every record, pane frames
node $D/size-matrix.mjs 3 240                             # a 3-line 240-char message for the wrapper matrix
```

What to know before trusting a reading from it:

- **Which plugin a window runs is decided at its start.** The installed
  plugin fires only the events its cached `hooks.json` names; the window has
  to be reopened to take a new one (`claude plugin update` says "Restart to
  apply"). Register the tree's `report.mjs` in the probe's *own*
  `.claude/settings.json` for the events under test, and `/exit` + reopen
  from the floor when the settings change.
- **`/model <name>` and `/effort <level>` as commands write the operator's
  machine-wide default** (`~/.claude/settings.json` `model`,
  `modelSettings.<model>.effortLevel`). The probe changed his, twice, and
  they were put back by hand — read that file before and after any
  measurement that touches a model, and restore it. The picker's `s` does
  not write it.
- **A compaction needs a context behind it.** Read `filler.txt` once (~85k
  tokens) for a 10–15 s manual one; `/autocompact 100k` and two reads
  provoked an auto one that thrashed three times and ended in a StopFailure
  — which is the measurement you want for that error, and costs about a
  dollar on Sonnet.
- **The pane's width is whoever is attached.** The `orch` session had a
  client, so the probe pane was 180 columns, not 80 — read footers rejoined.
- **Tear down everything, by name.** Leave the desk through the floor
  (`POST /api/floor/desk/leave`: the host closes the window and removes the
  binding), kill the second host and the server, the recorders and any
  headless Chrome (`pkill -f orch-cdp`), delete the scratch DB and the probe
  folder, and `POST /api/admin/channel/delete {channel, confirm: channel}`
  on the *live* board if the probe was ever taken there — the persona rows
  stay otherwise.

### Tighter isolation, and a move measured end to end (task 253)

The recipe above shares two things with the operator: the probe pane lands
in his `orch` tmux session, and the probe folder sits under the live host's
roots, kept off his board only by the "another board" skip. For issue #24
both were taken away, and nothing of the probe was ever visible to the live
host:

```bash
E=$SP/e2e; mkdir -p $E/root $E/rec
$D/make-probe.sh $E/root/probe-desk                        # the scratchpad: no host's roots reach it
printf '#!/bin/sh\nexec tmux -L probe253e "$@"\n' > $E/tmuxw; chmod +x $E/tmuxw   # a tmux server of its own
# the second host: ORCH_TMUX names the wrapper, ORCH_HOST_ROOTS only the probe's parent,
# and every line stamped to the millisecond, because a race is read off this log
ORCH_TMUX=$E/tmuxw ORCH_TMUX_SESSION=orch ORCH_HOST_ROOTS=$E/root ORCH_URL=http://localhost:8905 … node host/index.js 2>&1 \
  | perl -MTime::HiRes=time -ne 'BEGIN{$|=1} my $t=time; my @g=gmtime($t); printf "%02d:%02d:%02d.%03d %s",$g[2],$g[1],$g[0],($t-int($t))*1000,$_' > $E/rec/host.log &
# take the desk through the floor's own routes — POST /api/floor/browse {host_id, path: $E/root}, then
# POST /api/floor/desk {host_id, path, channel, agent} — which runs the real `claude mcp add`;
# answer the trust question on the wrapper's socket (Down, Enter), since nobody else can see it
```

Strip the `CLAUDE*` environment from the host's shell as for any probe —
the host passes it on to every window it opens. Its tmux pane is then
`$E/tmuxw list-panes -a`, its sessions `rec-roster.mjs`, its desk on every
floor `rec-floor.mjs`, and a move with the window held is
[`held-move.mjs`](probe-desk/held-move.mjs):

```bash
node $D/rec-floor.mjs  $E/rec/floor.log  http://localhost:8905 probe 600 &      # the desk on every floor, 100 ms
node $D/rec-roster.mjs $E/rec/roster.log <session-prefix> probe-desk 600 &     # the roster, 5 ms
ORCH_CDP_PORT=9253 node --experimental-websocket $D/held-move.mjs http://localhost:8905 probe-host \
  $E/root/probe-desk $E/tmuxw probe coord-probe-a coord-probe-b 6000 $E/shots card
```

What reading those four side by side showed, at 9d0e652 and then on the
fix: the closing window out of the roster 4–14 ms after the host's "closed
its window" line, the reopen 78–85 ms after it, and — the thing nobody had
predicted — a desk moved back to a floor it had left by a move missing from
*every* floor's payload, because the move had retired its row there. Give
the recorders a deadline (`seconds`) longer than the session you plan: they
stopped at ten minutes here, one move before the last reading was taken.

### Two instances on one machine (task 292)

Anything that happens *between* instances needs two of them, a host each,
and windows both hosts can see. [`two-instances.sh`](probe-desk/two-instances.sh)
is that rig, with the isolation above: both hosts' roots are one directory
of yours, and their windows are on a tmux socket named for the rig, in one
session called `orch`, because two hosts in one session is the real case.

```bash
T=$D/two-instances.sh; E=$SP/rel
$T up "$E" "$PWD"                         # servers on 8962 (a) and 8963 (b), from the tree; keys probe-a, probe-b
$D/make-probe.sh "$E/root/rel-desk"
$T api "$E" a POST /api/floor/browse "{\"host_id\":\"rel-host-a\",\"path\":\"$E/root/rel-desk\"}"
$T api "$E" a POST /api/floor/desk   "{\"host_id\":\"rel-host-a\",\"path\":\"$E/root/rel-desk\",\"channel\":\"rel-old\",\"agent\":\"probe\"}"
$T tmux "$E" send-keys -t orch: Down; sleep 0.6; $T tmux "$E" send-keys -t orch: Enter     # the trust question
# … then the same two calls on b, with "from_board":"http://localhost:8962": the release
$T api "$E" b GET "/api/floor/take?host_id=rel-host-b&channel=rel-new&agent=probe"
$T hosts "$E" "$PWD"                      # after editing host/*.js: the hosts only, the servers stay
$T api "$E" a POST /api/floor/desk/leave '{"channel":"rel-old","agent":"probe"}'            # removes the binding
$T down "$E"
```

To ask a window which instance it is on, send it a message through that
instance's floor (`/api/floor/chat`) asking it to call `whoami` and repeat
the channel. That costs a few tokens and is the only proof the window's
connection moved. What it measured on 2026-11-08: a release with the other
host's window open seated in 1.2 s and opened a new conversation; one with
no window resumed the conversation last spoken in (`claude --resume <id>`
in `ps`), and that window answered as the new instance. Before the host
looked at bindings, the instance that was left got every turn of the new
conversation for 40 s; after, its host let go in 0.9 s.

Three things about running it. **A host started from a script keeps the
script's stdout**, so `up … | tail` never returned until every stream of
the pair went to the log. **Stop by the pid files, never by a pattern**: a
`ps | grep "host/index.js"` in a command that itself names that file
killed the shell running it (exit 144), and the live host matches the same
pattern. And **a command the harness moved to the background is still
running**: one that hung on `up` carried on into its `hosts` and `down`
when its pipe closed, on the same directory as the rerun, and the two
scripts overwrote each other's pid files.

## How long a closed window stays in the roster

Issue #24 (task 253, 2026-11-03, 2.1.300): a move closed a desk's window
and reopened the same conversation, and the reopen found the window it had
just killed still holding it. [`roster-linger.mjs`](roster-linger.mjs)
times that gap on a throwaway window — every change to the session file and
the pid after `kill-window`, 5 ms apart, and any other session file naming
the conversation or the folder:

```bash
bash -c 'for v in $(env | grep -oE "^CLAUDE[^=]*"); do unset "$v"; done
  node .claude/skills/measure-a-real-window/roster-linger.mjs "$1" 3' _ "$SP/linger"
# {"run":1,"shape":"fresh","pid":74106,"killReturnedMs":27,"changes":"27:FP 33:-P 577:--"}
```

On 2.1.300 the file went 4–14 ms after `kill-window` returned and the pid
0.5–0.8 s after, on fresh, resumed (a 4.5 MB transcript too) and busy
windows alike; nothing else claimed the conversation. Against that, the
live board lost the race 10 times in 10 — so the gap on a long-lived desk
is longer than any probe showed, and why was not found.

**Holding a window with `kill -STOP` reproduces it, but not every time.**
Stopped across a move, a real window was refused with its own pid, word for
word the live line — and on the next try the move went through, because
something other than the stopped process removed its session file 6–14 ms
after the kill (no child process, no daemon found). For a red you can rely
on, the host suite's stand-in has `linger.flag`. `kill -CONT` it afterwards,
or the window's pid sits stopped with its pane gone.

## A background session

Claude Code's daemon can hold a conversation with no terminal at all, and
on 2.1.258 that is what a VS Code tab can leave behind when it closes. The
host releases one on a floor open (`releaseBackground()` in
[`host/window.js`](../../../host/window.js)); this is how that was measured,
and how to measure it again when a release changes it. It costs one short
prompt of tokens.

```bash
cd "$SP/bg" && mkdir -p . && claude --bg "This is a measurement fixture for the orchestratinator host. Reply with the single word pong and nothing else."
# prints:  backgrounded · <job>   — the job id is what attach/logs/stop take
sleep 8; ls -t ~/.claude/sessions/*.json | head -1 | xargs cat      # kind "bg", jobId, sessionId, cwd
claude agents --json | python3 -c "import json,sys;[print(s['pid'], s['kind'], s['id'], s['sessionId']) for s in json.load(sys.stdin) if s.get('id')=='<job>']"
claude logs <job> | tail -3                                           # the raw pane, ANSI and all
claude stop <job>                                                     # "stopped <job>", at once
claude agents --json | grep -c '<job>'                                # 0 — the roster entry and the pid are gone
tmux -L probe new-session -d -s p -n bg -c "$SP/bg" -x 200 -y 50 "exec claude --resume <sessionId>"
```

What it showed, 2026-09-09: the session file says `kind: "bg"` and carries
`jobId`; `claude agents --json` says `kind: "background"` and puts the job in
`id`; `name` is a label made from the prompt and may be several words, so
never hand `name` to `stop`. `stop` returned in under a second, the roster
file and the process were gone at once, and `--resume <sessionId>` in the
probe pane came up on the conversation — the trust question first, the
folder being new — with the pane's own roster entry `interactive` under the
same session id, which is what lets `holderOf` join it to the pane. A
`--resume` *before* the stop is refused on the first line with "running as a
background session (<job>). Run claude attach <job> to open it, or claude
stop <job> first to resume it here", and `remain-on-exit` is what keeps that
line readable. `claude attach` was not measured: a pane running the attach
client would not carry the session's pid, so it is not a window the host can
join, and there was no reason to find out more.

## Teardown

```bash
tmux -L probe kill-server
```

The scratch dir goes with the scratchpad. Its entry under `~/.claude/projects/`
does not — small, and harmless to leave, but it is there if a later probe of the
same path picks up an old conversation with `--continue`.

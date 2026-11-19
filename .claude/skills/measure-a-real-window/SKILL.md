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

## A probe can update the machine's Claude Code

A window started on a profile of its own (`CLAUDE_CONFIG_DIR` pointing at an
empty directory, as for a first-start measurement) updates the one global
install of Claude Code that every desk runs. The footer reads
"Auto-updating…" while it does. **Do not kill the probe until that footer is
gone.** On 2026-11-09 a probe was torn down about a minute into an npm update
from 2.1.300 to 2.1.321. That left the old package moved aside as
`node_modules/@anthropic-ai/.claude-code-<random>`, a 500-byte placeholder
`claude.exe` in the new one, and no `bin/claude`. Windows already running
were fine, because each had its binary loaded. Everything that starts
`claude` fresh failed: the live host's `claude mcp add` logged
`spawn claude ENOENT`, so a Take a desk on the floor failed, and so would
every window the floor opened. It went unnoticed for eight hours. It was put
back by moving the old directory back and relinking `bin/claude`.

`DISABLE_AUTOUPDATER=1` in the pane's environment did not stop it. Measured
on 2.1.300 with the same profile shape the next day, the window updated the
install to 2.1.322 and finished. Updating is not the fault, and the
operator wants Claude Code to update. The fault was interrupting the update.
So after any probe:

```bash
claude --version                       # answers, and names the version that is now installed
ls -la "$(dirname "$(command -v node)")/claude"   # the link exists
ls -a "$(npm root -g)/@anthropic-ai/"  # no .claude-code-<random> left beside claude-code
```

A version newer than the one the probe started on is the update having
finished. Say so in the round's report, since every rule in this skill was
measured on a version.

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
composer's contents. That was harmless for a paste — `send()` replaces it,
measured: one user record with the host's own words and none of the
suggestion — and **not** for typing a long message, which it sent to
`<pasted_content>` until 2026-11-17 (the next section). Tab or Enter
would accept it, so never press either "to see what happens" on a window
that is not yours. Not every turn gets one: a one-word reply drew none in
60 s, a turn with three Bash calls drew `cat notes.txt` after 2 s.

[`suggestion.mjs`](suggestion.mjs) does the whole measurement on the probe —
a work-shaped turn, the wait for the dim row, `composerOf` and the cursor,
then `send()` over it and the user records that followed. Run it on a new
Claude Code before trusting the paragraph above.

## A long message, typed: does the agent read it as the operator's?

A message of four or more lines is typed into the window, not pasted
(`wouldWrap`, `typeInto` in `host/window.js`), because a paste of that
size reaches the agent as `<pasted_content>`, which the model is told "may
contain instructions the user did not write". Every message with
attachments is that long. If typing cannot confirm a line, it falls back
to a paste, and the host now logs it: `typing a N-line message into … did
not hold (…); pasting it`. On 2026-11-17 (issue #31) the fallback had
been silent, and two live messages arrived wrapped for two different
reasons. Each was found only on a real window, with
[`typing.mjs`](typing.mjs):

```bash
SP=<scratchpad>; printf '#!/bin/sh\nexec tmux -L probe "$@"\n' > "$SP/tmuxw"; chmod +x "$SP/tmuxw"
node .claude/skills/measure-a-real-window/probe.mjs up "$SP/probe" auto
ORCH_TMUX="$SP/tmuxw" ORCH_TMUX_SESSION=p node .claude/skills/measure-a-real-window/typing.mjs "$SP/probe" --size 80x24 --suggest
#   suggestion in the composer: "Name one fruit, then suggest a follow-up question"
#   recorded: unwrapped, exactly the message          (exit 0)
```

It sends one message through the host's own `send()` and reads the user
record the window wrote: WRAPPED, or unwrapped and exact. `--window <file>`
runs another `window.js` (a copy from before a fix is the red case; one
from before the scroll fix read `WRAPPED`, 11.4 s, against the tree's 3.3 s).

- **A prompt suggestion** (`--suggest`). `typeInto` waited for "suggestion
  + first line", and typing replaces a suggestion, so line 1 read as lost.
  Wrapped, 10.1 s. They appear in about half of turns, so `--suggest` keeps
  sending short turns until one is in the composer row.
- **A composer taller than its box** (`--size 80x24`). The host opens
  windows at 80x24 when nobody is attached, and there the composer shows 7
  rows with `─── ↑ 3 more ───` for its top border. Its `❯` row is out of
  sight, so `composerOf` read null and line 5 "did not appear". probe.mjs
  makes 200x50, where the same message never scrolls: a probe at its
  default size cannot see this one. Measure at the size the host uses.

Five traps, each met once in that session:

- **Read the composer row at the bottom of the pane, nothing above it.** A
  grep for `❯` anywhere found an earlier user message echoed in the
  transcript and called it a suggestion.
- **Auto mode for the probe.** In manual mode the agent asked permission
  for an `ls` of the path it was given, the window stood at the question,
  and `send()` answered `asking` correctly. It read as a failure of the fix.
- **`send-keys -l --` for text that starts with `-`.** An attachment line
  is `- /path`, and without `--` tmux takes it as a flag ("invalid flag").
- **zsh does not split `$size`**: `set -- $size` gave one word and
  `resize-window` an empty `-y`, so two runs meant to be at 80 columns
  were both at 200. Read the pane's size back (`typing.mjs` prints it).
- **An agent's account of a file is not the file.** The probe told the
  operator an uploaded PDF was "only pages 1–8 of the 54". The upload was
  byte-identical to the original (`shasum -a 256`, and the page tree's
  `/Count 54`); the agent had read part of it. Check the bytes before
  calling an upload broken.

To see why typing did not hold, not only that it did not, copy `host/`
into the scratchpad, add a `console.error` of `composerOf`'s reading and
the `want` at the miss in `typeInto`, and pass that copy as `--window`.
That is how both causes were named, in one run each.

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

**A question with previews** (2.1.325, 2026-11-14). Ask for options that
"each carry the optional preview field" and the window draws the question
side by side. What was measured, each on a real form:

| form | keys | what the window did |
|---|---|---|
| one question, previews | `2` | cursor to row 2, preview swapped, form standing |
| | then `Enter` | "→ Bravo", form gone, no review screen |
| preview question, then a plain one | `Left Left Left 2 Enter` | first tab ☒, second tab showing |
| | then `3` | review screen with Bravo and Blue |
| plain, preview, plain | `Tab`, `Left`, `Right`, `BTab` on the preview tab | each walked the strip as on a plain tab |
| one option of three with a preview | (drawn) | the whole question side by side; "No preview available" on the other rows |
| multi-select given previews | (drawn) | an ordinary multi-select, with "Type something" |
| one question, previews, three rows | `4` | nothing: no such row, cursor still on row 1 |

The layout has no "Type something." row, its status line is "Enter to select
· ↑/↓ to navigate · n to add notes · Esc to cancel" (with "Tab to switch
questions" before the last part in a form of several, wrapping at 80
columns), and a preview taller than the pane's room is clipped by the
window ("✂ 5 lines hidden"), so the form itself was not cut at 80x24.
`form.mjs` answers these through the host as any other form; the rows it
prints for `formFromInput` match the pane's now that the call-built form
leaves the free-text row out.

[`raise.sh`](raise.sh) is how the table was made: it raises a form and
leaves it standing, where `form.mjs` answers or cancels the one it raises.

```bash
.claude/skills/measure-a-real-window/raise.sh 'one single-select question: header "Where", …' 14
tmux -L probe send-keys -t p:probe 2; tmux -L probe capture-pane -p -t p:probe | grep -v '^\s*$' | tail -12
tmux -L probe send-keys -t p:probe Escape     # when done
```

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
  `modelSettings.<model>.effortLevel`), and so does Enter in the picker.
  The probe changed his, twice, and they were put back by hand — copy that
  file before any measurement that touches a model and put it back after
  ("A model or effort change", below). Only the picker's `s` does not
  write it.
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

## A board that goes away: the reconnect and a room's notices

The rig that showed both features of 2026-11-19 working on a real window
(CLAUDE.md, "/mcp from the floor, a reconnect the board asks for, and a
room's notices"): a scratch board, the probe folder bound to it in local
scope, a dev host on the probe's socket, and the probe window. All of it
is in [`probe-host.sh`](probe-host.sh).

```bash
export PROBE_HOST_STATE=$SP/ph                           # its pids, logs and database
H=.claude/skills/measure-a-real-window/probe-host.sh
$H up "$SP/rig"                                          # board :8931, binding, host probe-rig-host
bash -c 'for v in $(env | grep -oE "^CLAUDE[^=]*"); do unset "$v"; done
         node .claude/skills/measure-a-real-window/probe.mjs up "$1" auto' _ "$SP/rig"
$H outage 5        # 2.1.328: sessions=1 within seconds, no host line (it healed by itself)
$H outage 90       # 2.1.328: the host's line "the desk's tools had lost the board, so the
                   # host ran /mcp — Reconnected to orchestratinator", 25 s after the board
$H room            # the window's two notes, filed as context/meeting-room
$H down; node .claude/skills/measure-a-real-window/probe.mjs down
```

Bind before the window starts: a window reads its MCP servers at start.
`up` refuses 8787, 6724 and any port that answers, and the host's id is
its own, never the hostname (the live host's row). Read without a
script, `/mcp` itself on 2.1.328: bare, it opens the "MCP servers" panel
(an arrow list, `✘ orchestratinator` when dropped). `/mcp reconnect
<name>` writes "Reconnected to <name>", "Couldn't reconnect to <name>"
with the board down, or `MCP server "x" not found`, each as
local-command-stdout. `reconnect all` adds "1 still not connected" for
the disabled computer-use. Typed into a running turn, it vanished: no
record, no queue entry.

## When `claude --version` moves: the reader sweep

Claude Code 2.1.326 moved two screens the host reads by position, and the
floor failed on every desk without a word that blamed the update: a model
change ended "no sign of running it within 20s", and a multi-question form
was called answered while it stood unsubmitted (CLAUDE.md, "A Claude Code
update can move a line the host reads by position"; 0.12.12). The sweep
that found both, and `/cost`, took about forty minutes on 2.1.327
(2026-11-18). Run it when the version moves, before believing a report
that the floor "stopped working". Every step goes through the tree's own
host code against a probe on `-L probe`, at **80x24**, the size the host
opens windows at.

```bash
SP=<scratchpad>; export PATH=$HOME/.nvm/versions/node/v24.22.2/bin:$PATH
printf '#!/bin/sh\nexec tmux -L probe "$@"\n' > "$SP/tmuxw"; chmod +x "$SP/tmuxw"
export ORCH_TMUX="$SP/tmuxw" ORCH_TMUX_SESSION=p
cp -p ~/.claude/settings.json "$SP/settings.json.before"     # /model writes it
mkdir -p "$SP/p" "$SP/panes"   # a NEW folder each time, so the trust question is asked
# `claude; sleep 30`, not `exec claude`: an exit stays on screen to read.
tmux -L probe new-session -d -s p -n probe -c "$SP/p" -x 80 -y 24 'claude; sleep 30'
```

1. **Trust question**: capture the pane, read it with `startupQuestionOf`,
   then `answerStartup(dir, 2)` (the host's presser). 2.1.327: read, and
   "Yes, I trust this folder" chosen.
2. **Permission menu**: restart with `claude --permission-mode default`,
   ask for a `touch`, then `readPrompt`, `promptChoices`, and
   `answerPrompt(dir, String(deny))`. 2.1.327 has four rows ("Yes, and
   switch to auto mode" is new) and Deny is row 4; the floor finds Approve
   and Deny by their words, so it held.
3. **Forms**: `form.mjs` with two single-selects, then a preview question
   plus a multi-select (the Usage at the top of `form.mjs`). The receipt is
   the tool result in the transcript. "readQuestions → … Submit[single,2]"
   or "tool result NONE" is the review screen not being read.
4. **Commands**: `send.mjs` with `/model <other>` on a conversation that
   has a reply cached (the "Switch model?" path), then `/btw …`, then
   `/cost` and a plain message after it (the message must reach the
   composer). Then `send.mjs '/mcp reconnect orchestratinator'` on a
   window started with an MCP server (`probe-host.sh up` first, or
   `claude --mcp-config`): the receipt is "Reconnected to …" as the
   window's stdout, and a bare `/mcp` from the floor depends on it
   (`typedCommand`). The automatic reconnect depends on it as well:
   `probe-host.sh outage 90`.
5. Put the settings back: `restore-settings.py "$SP/settings.json.before"`,
   then `tmux -L probe kill-server`.

Save every pane you read (`capture-pane -p > "$SP/panes/<name>.txt"`):
the fixes' rows in `test/window.mjs` are built from those captures, and QA
asks for them. A reader that fails gets its fix, a row from the real
capture beside the old shape's, and a mutant
(`mutants-claude-2-1-326.suite.json` is the list from that day).

**2.1.328, the same sweep (2026-11-19, a subagent, about five minutes).**
Every reader held. One fault, in a presser and not a reader: under a load
average near 100 `answerStartup` read the cursor 80 ms after its key,
before the redraw, and refused the trust question with the cursor already
on "Yes, I trust this folder". It reads until the cursor lands now
(CLAUDE.md, "The host under the desktop app"). Three things that moved and
broke nothing: the permission menu has a line under "Bash command", "Tip:
auto mode handles these prompts for you…", which lands in the question's
text; `/cost` is listed as "/usage (cost)" and still opens the settings
screen on its Usage tab; and `/model sonnet` on a conversation whose
replies were Fable's raised no "Switch model?" (0 of 34 frames), while
`/model haiku` after one more reply did, which is not what "whenever the
conversation has a reply cached" says below. Not chased. The sweep is a
good thing to hand a subagent whole: give it this section, the scratchpad,
and "never the default socket, never 8787 or 6724, restore settings.json".

Unexplained, seen once on 2.1.327: `probe.mjs up` printed "up" with an
empty footer, and the probe's tmux server was gone (its pane runs `exec
claude`, so an exit leaves nothing to read). Started by hand as above, the
same folder worked. If `up` does that again, start it by hand and read
what Claude Code says before it exits.

## A model or effort change

Since 2026-11-14 the floor changes a model or an effort level by typing the
window's own command, which saves the choice as the default for new
sessions (costmo's ruling; before it the host drove the picker and pressed
`s`). Everything below was read off a probe on 2.1.325 that day. The probe
runs on the operator's own profile, so every one of these writes his
`~/.claude/settings.json`:

```bash
cp -p ~/.claude/settings.json "$SP/settings.json.before"; shasum -a 256 ~/.claude/settings.json
# … measure …
python3 .claude/skills/measure-a-real-window/restore-settings.py "$SP/settings.json.before"
# differs before restore: {"model": ["claude-fable-5-2", "haiku"]}
# restored byte for byte — sha256 d4fc2d75…        ← the hash from before
```

Copying the whole file back also undoes anything else that changed in it
meanwhile, and the operator changes his own effort level from his windows
(he had, minutes before the 2026-11-15 measurement). So
[`restore-settings.py`](restore-settings.py) puts back `model`,
`modelSettings` and `effortLevel` alone. When nothing else differs it
writes the saved bytes and the hash is the one from before. When another
key differs it keeps that key, names it, and the hash is a new one. Run on
two throwaway files (a second argument names the file to restore): keys of
a probe's only, byte for byte; `theme` changed meanwhile, kept and named; a
file that is not JSON, exit 2 and nothing written.

A window started while the file is changed starts on the probe's model, so
keep the stretch short and put the file back before reading results.

| keys | the window's line | what settings.json gained |
|---|---|---|
| `/model`, ↓ to Haiku, Enter | Set model to Haiku 5.5 and saved as your default for new sessions | `model: haiku` |
| `/model`, ↑ to Sonnet, → on the effort row, Enter | …Sonnet 5.5 and saved as your default for new sessions with high effort | `model: sonnet`, `modelSettings.claude-sonnet-5-5.effortLevel: high` |
| `/model`, ← on the effort row only, Enter | …Sonnet 5.5 and saved as your default for new sessions with medium effort | the model again, and the effort |
| `/model opus` | Set model to Opus 5.5 and saved as your default for new sessions | `model: opus` |
| `/model fable` | Set model to Fable 5.2 and saved… | `model: fable` |
| `/model nonsense-9` | Model 'nonsense-9' not found | nothing |
| `/effort low` | Set effort level to low (saved as your default for new sessions): Quick, straightforward… | `modelSettings.<current model>.effortLevel: low`, `model` untouched |

The third row is why the host types the commands and does not press Enter
in the picker: an effort change there saves the model too. Three more
things, each seen once on purpose:

- **"Switch model?"** stands between a `/model` and its line whenever the
  conversation has a reply cached for the current model, behind the command
  and behind the picker alike. It replaces the composer, its last two lines
  are `❯ 1. Yes, switch to X` and `2. No, go back`, and `1` answers it.
  With no reply since the last switch it does not appear.
- **Into a running turn**, `/model haiku` is taken at once and the warning
  is drawn over the work. Answered `1`, the line appears as a notice above
  the composer and the turn carries on. The host refuses instead.
- **A refusal is recorded differently.** A command that ran writes its
  `<command-name>` and `<local-command-stdout>` as user records; "Model
  'x' not found" writes both as `system` records with subtype
  `local_command` and the text in `content`.

- **"Change effort level?" is the same dialog under another title, and
  no probe has raised it** (QA, PR #55 finding 1; 2026-11-15, 2.1.325).
  The binary's strings hold both titles over the same lines and the same
  two choices, and its condition for the effort one is a change that would
  rewrite the cached prefix: a model that does not take effort per turn.
  Each of the four families the floor offers was given a reply and then
  `/effort <another level>` through `send.mjs`, with the pane recorded:

  | model | change | the window's line | frames with the dialog |
  |---|---|---|---|
  | Fable 5.2 | high → medium | Set effort level to medium (saved as your default…) | 0 |
  | Opus 5.5 | high → low | Set effort level to low (saved…) | 0 |
  | Sonnet 5.5 | (default) → low | Set effort level to low (saved…) | 0 |
  | Haiku 5.5 | (default) → low, a reply, → high | Set effort level to high (saved…) | 0 |

  "Switch model?" stood in the same recordings on each `/model` between
  them (1–3 frames) and was answered. So the host's read of the effort
  title is the model's measured shape with the binary's words, and
  `test/window.mjs`'s stand-in raises it under `effort-ask.flag`. To read
  the strings again on a new version (the binary is the platform package,
  not `bin/claude.exe`'s wrapper):

  ```bash
  B="$(npm root -g)/@anthropic-ai/claude-code/node_modules/@anthropic-ai/claude-code-darwin-arm64/claude"
  python3 -I -c "import sys,re;d=open(sys.argv[1],'rb').read();m=re.search(rb'Change effort level\?',d);print(d[m.start()-80:m.end()+420].decode('utf8','replace') if m else 'gone')" "$B"
  ```

  If a probe ever does show it, record its last lines and what `1` and
  `2` write, and put the real "Kept effort level as …" record's type
  (user or `system`) beside `stdoutOf`.

[`send.mjs`](send.mjs) plays any of these through the host's own `send()`
from the tree, against the probe, with no board or host in the loop. To see
the host meet the warning, give the conversation a turn first, record the
pane while it sends, and look for the choice in the recording:

```bash
.claude/skills/measure-a-real-window/record-pane.sh "$SP/rec-model.log" -- \
  env ORCH_TMUX="$SP/tmuxw" ORCH_TMUX_SESSION=p \
  node .claude/skills/measure-a-real-window/send.mjs "$SP/probe" '/model sonnet'
# frames: <how many were taken>
# frames with 'Switch model?': <1 to 3 on 2026-11-15>   ← above 0: the warning stood, and the send still ended ok
# frames with 'Change effort level?': 0
```

[`record-pane.sh`](record-pane.sh) records the pane about seven times a
second while any command runs, and counts the frames holding each `-p
<words>` (the two titles when none is given). The frames stay in the log.
**A count of 0 is a reading only beside a count above 0 from the same
recorder**: the four 0s in the effort table above stand because "Switch
model?" was counted in the same recordings. It can be run with no Claude
Code at all, on a tmux socket of its own (`PROBE_SOCKET`): a pane that
drew "Change effort level?" for a second read 8 frames of it and 0 of the
other title, and with no pane on the socket it exits 2 and says so.

## Two windows in one folder, each a different desk

One agent with several sessions (0.12.9, `host/seats.js`) rests on what
Claude Code does with `--mcp-config` beside a folder's own binding. It was
measured on 2.1.325 (2026-11-16) and costs no tokens for the first half:
an MCP server connects when a window starts, and the board counts sessions.

```bash
SP=<your scratchpad>/ms; mkdir -p $SP/root/qa-desk $SP/rec
PORT=8931 DB_PATH=$SP/probe.db ORCH_AUTH_TOKEN=probe-ms ORCH_AUTH_MODE=enforce node src/server.js &   # Node 22.14+
( cd $SP/root/qa-desk && claude mcp add -s local --transport http orchestratinator http://localhost:8931/mcp \
    -H "X-Channel: ms-a" -H "X-Agent: qa" -H "X-Orchestratinator-Key: probe-ms" )
echo '{"mcpServers":{"orchestratinator":{"type":"http","url":"http://localhost:8931/mcp","headers":{"X-Channel":"ms-b","X-Agent":"qa","X-Orchestratinator-Key":"probe-ms"}}}}' > $SP/seat-b.json
tmux -L probems new-session -d -s p -n a -c $SP/root/qa-desk -x 200 -y 50 'claude; echo "[exited $?]"; sleep 900'
# trust dialog: Down, Enter. Then the second window, with a binding of its own:
tmux -L probems new-window -d -t p: -n b -c $SP/root/qa-desk "claude --mcp-config '$SP/seat-b.json'; echo \"[exited \$?]\"; sleep 900"
curl -s localhost:8931/health          # "sessions": 2
curl -s -H 'x-orchestratinator-key: probe-ms' localhost:8931/api/state   # ms-a/qa and ms-b/qa, one session each
```

| what | read |
|---|---|
| a window started plain in the bound folder | one MCP session, `ms-a/qa` |
| a second started with `--mcp-config` naming `ms-b/qa` under the **same server name** | one session on `ms-b`, still one on `ms-a`, two in all: the file's entry replaces the folder's in that window, it is not added beside it |
| an approval dialog for the file's server | none |
| `-e ORCH_DESK_CHANNEL=…` on the window, read by a `SessionStart` hook | the hook's environment has it: a hook sees what its window was given |
| `~/.claude/sessions/` | one file a window, the same `cwd` in each: nothing on disk says which desk a window is |

The second half is the tree's own host on the same board, on its tmux
socket (the "Tighter isolation" recipe above, with `ORCH_HOST_SEATS` naming
a scratch directory), and the floor's routes:

```bash
post /api/floor/open  '{"channel":"ms-a","agent":"qa"}'
post /api/floor/desk  '{"host_id":"probe-host","path":"<the folder>","channel":"ms-b","agent":"qa","seat":true}'
post /api/floor/chat  '{"channel":"ms-b","agent":"qa","text":"… call whoami once and reply with exactly: I AM <channel>/<agent>"}'
post /api/floor/desk/twin '{"channel":"ms-a","agent":"qa"}'        # → qa-2, a third window in the folder
```

Read that day: `I AM ms-a/qa`, `I AM ms-b/qa` and `I AM ms-a/qa-2` from
three windows in one folder; each desk's hook sessions filed under itself
by the plugin that was already installed (it honours `ORCH_CHANNEL` and
`ORCH_AGENT`); a session told to remember a word, left, and asked back
with `session_id` answered with the word under its own name (`--resume
<id> --mcp-config <file>` together). And the fault only a real window
shows: **the plugin's SessionEnd, fired as a closing window dies, re-seated
the desk the board had just removed**. Read the `personas` row's
`assigned_at` against the `desk.left` row's time in `admin_events`: the
same second. A stand-in has no plugin, so after any change to how a desk
is closed, close a real one and read those two rows.

**The whole of it in one run, from a browser:**
[`two-rooms-fixture.sh`](two-rooms-fixture.sh) and [`two-rooms.mjs`](two-rooms.mjs).
The fixture is everything above done for you: a board from the tree, three
folders bound as `ms-a/qa`, `ms-a/dev` and `ms-a/ops`, the tree's host on a
tmux socket of its own, each desk's window opened from the floor and its
trust question answered. Then a headless Chrome on the floor does what the
operator does: QA and the developer into one meeting room, QA and the
service agent into a second, a question asked in each room, Bring back on
QA's desk.

```bash
F=.claude/skills/measure-a-real-window/two-rooms-fixture.sh; S="$SP/two-rooms"      # S outside the repo
$F up "$S"                    # 10 s: three desks reading held=floor; no tokens
ORCH_CDP_PORT=9293 node --experimental-websocket .claude/skills/measure-a-real-window/two-rooms.mjs http://localhost:8931 "$S/shots"
# … PASS · 13 of 13        (about a minute; four short replies of tokens; Node 22.14+ first on PATH)
$F rows "$S"                  # the desks, the windows and their tags, the seats, the board's desk.* rows in order
$F down "$S"                  # leaves every desk, stops it all, says what is still bound (none) and claude's version
```

`rows` is the reading to take after anything that makes or closes a second
session: it prints, side by side, what the floor says of each desk, each
window's tag on the socket, the host's own record of its seats, and the
board's `personas`, `desk_twins`, conversations and `desk.*` audit rows
with their times. The SessionEnd fault below is one line of it: a
`personas` row for `qa-2` stamped the second its `desk.left` row was
written. The fixture refuses a port that answers, a socket already up, a
scratch directory inside the repo, and a Node older than the board needs
(it finds the newest under `~/.nvm` itself; `NODE=` names another). All
four refusals and the whole loop were run on 2026-11-16.

Run twice on 2026-11-16, 13 of 13 both times: the second room held `ops`
and `qa-2`, whose host started a real fourth window in QA's folder; asked
in the second room it answered `I AM ms-a/qa-2` and `ops` answered `I AM
ms-a/ops`; asked in the first, `I AM ms-a/qa` and `I AM ms-a/dev`; neither
room held a word of the other's; the floor's panel read "Bring back from
all 2 meeting rooms", and pressed, the board closed the second session
(`desk.leave`, actor `board`) and its window went, with QA back on the
conversation it had. The second run made `qa-2` again: the name was free,
which is the closing window's hooks not re-seating it, on real windows.
It leaves both rooms ended; the three desks are left for you to leave.

Teardown is the windows, the host, the server, **and the binding**, which
is what `two-rooms-fixture.sh down` does: `POST /api/floor/desk/leave` for
each desk (its host closes the window and removes the binding; seats
first, since leaving a folder's own desk does not take its seats), then
the host and the board by their environment (`ps eww`, matched on the
probe's port and host id, so the live host is never a candidate), the
socket, the Chrome on the CDP port, and a read of `~/.claude.json` for any
probe folder still bound. By hand, a folder left bound stays a desk of a
board that is gone.

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

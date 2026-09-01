---
name: watch-the-window
description: Measure what a window and the floor actually do over time — record every change to a tmux pane and every change to the board's awaiting state, then read the two against each other. Use before theorising about any timing, stall, or "it only showed up in tmux" problem.
---

# Watching, rather than guessing

> **Two skills, two questions.** This one watches a window that already exists,
> which is what you want when a *desk* is misbehaving. When the question is
> "what does Claude Code actually do when…", stand up a throwaway one instead
> and read its transcript — see
> [`measure-a-real-window`](../measure-a-real-window/SKILL.md). Guessing at that
> question from the code is how a false claim about dropped pastes survived in
> `CLAUDE.md` long enough to shape the design.

Nearly every hard bug in this repo has been a **timing** question — did the key
land, did the prompt arrive, how long did the operator stare at nothing — and a
single `capture-pane` cannot answer any of them. It shows you one moment, and
the moment you care about has usually already passed.

Two recorders answer them. Both write **only when something changes**, which is
the property that makes them worth having: a gap in the file is real dead time,
not a sampling artefact. That is how a 42-second stall was found, and how a
pasted message was told apart from a typed one.

Put both in the scratchpad and start them **before** the thing you want to see.

## The pane recorder

```bash
#!/bin/zsh
# Every change on the pane, whatever it looks like — not just numbered menus.
# A prompt may render states with no numbered rows at all (a text box, a tab
# strip), and those are exactly the ones worth seeing.
OUT="$1"; PANE="$2"; : > "$OUT"; last=""
for i in $(seq 1 1200); do
  scr=$(tmux capture-pane -p -t "$PANE" -S -34 2>/dev/null)
  if [ "$scr" != "$last" ]; then
    { echo "=== $(date '+%H:%M:%S') ==="; print -r -- "$scr"; echo; } >> "$OUT"
    last="$scr"
  fi
  sleep 0.15
done
```

Find the target first — there is normally exactly one:

```bash
tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_current_path}'
```

1200 × 0.15s is **three minutes**. It dies silently at the end, so a capture that
looks empty may just have expired before the operator acted. Re-arm per round.

## The floor recorder

The same idea against the board, so you can line up "what the window showed"
with "what the operator's screen showed".

```bash
#!/bin/zsh
OUT="$1"; : > "$OUT"; last=""
for i in $(seq 1 400); do
  now=$(curl -s --max-time 2 localhost:8787/api/floor \
    | tr ',' '\n' | grep -E 'awaiting_kind|awaiting_message|request_id|"agent"' | tr -d ' ')
  if [ "$now" != "$last" ]; then
    { echo "=== $(date '+%H:%M:%S') ==="; print -r -- "$now"; echo; } >> "$OUT"
    last="$now"
  fi
  sleep 0.5
done
```

## Reading them without fooling yourself

**Your own words are on the pane.** This is the trap, and it has now cost two
separate rounds. The window shows the conversation — including everything *you*
just wrote. Grep a capture for "Ready to submit your answers" and you will match
your own report about it, from ten minutes earlier, and conclude the form was
still open. Exactly the bug `menuOf` had, repeated as a measurement error.

Match on things only the live widget produces, and take the *last*, not the
first:

| Want | Match |
|---|---|
| a live question | the footer `Enter to select · Tab/Arrow keys to navigate` |
| a live confirmation | the row `1. Submit answers` |
| answers accepted | the result arrow, `→ <the option text>` |

```bash
awk '/^=== /{ts=$2} /Enter to select · Tab\/Arrow keys/{last=ts} END{print last}' live.txt
```

**A gap between frames is the finding.** Two consecutive frames 42 seconds apart
with identical content means nothing moved for 42 seconds. Conversely, an empty
composer in one frame and a complete sentence in the next — with no partial
states between — is a paste, not typing. That single observation is how "did the
floor deliver this, or did the operator type it?" gets answered.

## The other half: did the hook fire at all?

Symptom to know by heart: **the conversation relays but prompts never appear on
the floor.** Those are different paths. The host reads turns off the pane, so
chat works from anywhere; the alert depends on the plugin hook posting. So a
healthy-looking floor and an invisible prompt is a hook problem, not a relay one.

The hook is wired `>/dev/null 2>&1 &` — it can never say anything went wrong.
Run it by hand, with the output visible:

```bash
printf '%s' '{"session_id":"<real one>","hook_event_name":"PermissionRequest",
              "cwd":"<dir>","tool_name":"Bash"}' \
  | node plugin/hooks/report.mjs
```

Then read the desk back. Use the **real** session id — an invented one has no
desk to attach to and reports nothing, which reads as a failure and is not one:

```bash
curl -s localhost:8787/api/floor | tr '{' '\n' \
  | grep '"session_id":"<real one>"' | grep -o 'awaiting_kind":"[^"]*"'
```

Clear it again with a `Stop` event before the next test, and **run one at a
time** — `Stop` is what clears awaiting, so firing it alongside a
`PermissionRequest` cancels the very thing being measured.

Vary one input at a time. Varying `cwd` this way is what found the bug the
session memo now fixes.

## Only localhost

`http://10.0.42.120:8787` and `https://appideas-mcp.ngrok.dev` are not ours.
Every recorder here names `localhost:8787` on purpose — do not repoint them.

## Answering the form yourself

A prompt raised by `AskUserQuestion` goes to whoever holds the conversation, so
it looks as though only the operator can answer it. **He cannot be the harness.**
Asked to answer the same form five times while nothing changed between rounds, he
said so — and every round cost him a switch between VS Code and the floor.

[`answer-the-form.mjs`](answer-the-form.mjs) closes the loop instead. Start it
*before* the tool call; it polls `/api/floor` for the standing request, POSTs
`/api/floor/answer` exactly as the browser does, and records every pane change
beside it.

```bash
nohup node .claude/skills/watch-the-window/answer-the-form.mjs "$SP/run.log" last &
# then raise the AskUserQuestion, and read $SP/run.log afterwards
```

Its third argument picks the answers: `last` takes the final real option on each
question (and the last two on a multi-select), `free` takes the free-text row on
the first single-select and supplies words.

**Answer with a non-first option.** The bug this was built to find substituted
option 1 for every choice after the first, so every round that had chosen option
1 passed while broken. A test that cannot fail is not a test — pick option 3 and
say in advance what should come back.

**Do not rebuild the stack while a form is standing.** The host loses the server,
retries the work item, and plays the whole key sequence into the pane twice.

**Get him out of the floor first.** Every Bash command you run raises a
permission prompt there, and those land in the middle of what you are measuring.

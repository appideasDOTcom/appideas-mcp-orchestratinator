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

## Recording the pane over time

For anything about *timing* on screen, a single capture is not enough — see
[`watch-the-window`](../watch-the-window/SKILL.md), which is the sibling of this
skill: it records panes and the board's awaiting state for a window that already
exists. Use that one for a desk that is misbehaving, this one for a question
about Claude Code itself.

## Teardown

```bash
tmux -L probe kill-server
```

The scratch dir goes with the scratchpad. Its entry under `~/.claude/projects/`
does not — small, and harmless to leave, but it is there if a later probe of the
same path picks up an old conversation with `--continue`.

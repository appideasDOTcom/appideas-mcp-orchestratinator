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

## A window stopped on the folder-trust prompt: self-heal, or surface it on the floor

Seen 2026-09-02, first production round trip. "Open on the floor" opened the
window and it sat on Claude Code's folder-trust dialog ("These will apply
without asking. Only proceed if you trust this configuration … Yes, I trust
this folder"). The floor reported it correctly — "has not finished starting,
something on screen is waiting for an answer", pane quoted — and the operator
had to open a terminal, `tmux attach -t orch`, and answer it by hand.

The host answers only the resume-mode question, on purpose; the reasoning
beside `ANSWERS` in `host/window.js` says trust and MCP approval are the
operator's decisions. That reasoning also says a desk cannot arrive at this
prompt cold, because bootstrapping writes the approval to disk. What was
observed disagrees for one case: this desk had been on the board all morning
from VS Code, and `~/.claude.json` still had `hasTrustDialogAccepted: false`
for it in every backup from the day. VS Code sessions do not appear to write
folder trust, so the first time the floor opens such a desk in tmux, the
prompt is genuinely new.

Two directions, either would do:

- **Self-heal** where it is safe: detect at open time that the trust record
  is missing for a repo that is already a desk on this board, and say so
  before opening — or write the record, if it turns out that is all the
  dialog checks. Needs measuring (`measure-a-real-window`), not assuming.
- **Surface the prompt** on the floor: the pane text is already read and
  quoted in the error; render it as a prompt with its options so the operator
  can answer from the floor without a terminal. Same rule as any alert the
  floor cannot parse — never leave the operator without a button.

Whichever, keep the decision the operator's. The fix is a door onto the
prompt, not an auto-answer.

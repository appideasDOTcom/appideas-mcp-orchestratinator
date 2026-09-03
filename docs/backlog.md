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

---
name: diagnose-handoff
description: Find out why a desk on the orchestratinator floor is not behaving — a message that will not send, a reply that never arrives, a window that stalls, or a conversation that seems to be in the wrong place. Use before forming any theory about the host, the server, or Claude Code.
---

# Diagnosing a desk

Every failure this system has produced looked like something it was not. The
rule that broke them all open: **read the actual state before theorising, and
when a window misbehaves, look at its screen.** Work down this list. Stop at the
first step that disagrees with what you expected — that is the bug.

## 1. Where am I actually running?

```bash
echo "TMUX_PANE=${TMUX_PANE:-<none>}"
ps -o pid,lstart,command -p $PPID | tail -1
```

`TMUX_PANE` set and a parent of `claude --resume <id>` means the floor holds this
conversation. Unset, with a VS Code extension parent, means the editor does.
Never infer this from the conversation; ask the process.

## 2. Who does everything else think holds it?

```bash
tmux ls; tmux list-panes -a -F '#{session_name}:#{window_id}.#{pane_id} dead=#{pane_dead} pid=#{pane_pid}'
claude agents --json | python3 -c "import json,sys;[print(s['pid'], s['sessionId'], s['cwd']) for s in json.load(sys.stdin)]"
curl -s localhost:8787/api/floor | python3 -c "
import json,sys
for c in json.load(sys.stdin).get('channels',[]):
    for k in c.get('desks',[]):
        h=k.get('hosted')
        if h: print(c['channel'], k['agent'], h.get('held'), h.get('window_open'), h.get('holders'), h.get('clients'), h.get('session_id'))"
```

A session in the roster with **no matching pane** is read as an editor holding
it, and the floor will refuse to send. That is correct when an editor really has
it — and a trap in tests, where a killed stand-in leaves its roster entry behind.

Read `held` together with the three fields beside it, because `held` alone is
ambiguous and each pairing means something different:

| `held` | `window_open` | what it is |
|---|---|---|
| `null` | `false` | nothing running — the floor correctly offers to open one |
| `null` | `true` | **a window that has not registered** — almost always stopped on a startup question. Go straight to step 4 |
| `'floor'` / `'editor'` | — | a registered session; `holders` says how many processes claim it |

`holders > 1` is two live copies of one conversation. Nothing prevents it, they
share a transcript and not their context, and `holderOf` reports the first one it
finds — so a desk that flips between `'floor'` and `'editor'` between polls is
not a glitch, it is two processes. `clients` is terminals attached to the host's
tmux session, and is what the attach spinner settles against.

## 3. Is the relay actually live, or batching?

Compare how far apart turns were *recorded*. Real-time relay puts seconds
between them; a blocked relay records a whole stretch at one timestamp.

```bash
curl -s "http://localhost:8787/api/floor/turns?channel=<ch>&agent=<agent>" | python3 -c "
import json,sys
for t in (json.load(sys.stdin).get('rows') or [])[-12:]:
    print(t.get('created_at'), t['role'], (t.get('text') or '').replace(chr(10),' ')[:60])"
```

Several turns sharing one `created_at` to the second means something blocked
`watchLoop()`. A message that reached the desk but showed red **send again** on
the floor is the same fault seen from the other end: the floor's pending grace is
30s, so anything that stalls the echo longer than that looks like a failed send.

**A desk that is working is not a reason for a message to be late.** The floor
types into a running turn on purpose — the window queues it and reads it at its
next step, in about a second — so "it was busy" no longer explains anything.
Check what the desk says it did with the message:

```bash
curl -s localhost:8787/api/floor | python3 -c "
import json,sys
for c in json.load(sys.stdin).get('channels',[]):
    for k in c.get('desks',[]):
        if k.get('delivery'): print(c['channel'], k['agent'], k['delivery'])"
grep 'queued a message' ~/.orchestratinator/log/host.log | tail
```

A `delivery` note standing for more than a few seconds means the message is in
the window's queue and the turn it is behind has not reached a step boundary —
which for one long uninterrupted reply is genuinely possible. A note standing for
*minutes*, with the desk idle, is a bug: what retires one is the message becoming
a turn, and `readTranscript` has to see it to do that. Compare against the
transcript directly, and remember a mid-turn message is written down **only** as
`attachment.queued_command` — never as a `user` record.

## 4. What is on the window's screen?

The single highest-value step, and the one that is skipped. A window that is up
but never registers is *waiting for an answer* — and which answer matters.

```bash
tmux capture-pane -p -t <session>:<window> -S -50 | grep -v '^$' | tail -30
```

This is not hypothetical and the cost of skipping it is measured: on 2026-09-01 a
desk sat at `held: null` with a live pane for over a minute while the floor
offered to open a window that was already on screen. The pane said
`New MCP server found in this project` the entire time. Reasoning from the code
produced two wrong theories first; one `capture-pane` ended it.

Seen in practice: `New MCP server found in this project` (after a server is
enabled or first added — approving it once writes `enabledMcpjsonServers` into
`.claude/settings.local.json`, which is **not committed**, so every machine hits
it), and the folder-trust dialog. Do not guess between them. Look.

**Since 2026-09-03 the floor shows these.** The host reads a startup dialog
off the pane and the desk carries it as a prompt — "Before it can start, the
window asks" — with the dialog's own rows as buttons, and the host presses
only the row the operator picks (`startupQuestionOf` / `answerStartup` in
[`host/window.js`](../../../host/window.js)). A desk that says "starting" with
no such prompt is therefore a desk whose host is not running the new code, or
a dialog the reader does not know; capture the pane and add it there.

**The host still answers only the resume-mode question, on purpose.** A
VS Code session defers the MCP approval and a re-pointed `.mcp.json`
invalidates it, so these dialogs are ordinary now — but the answer stays a
person's. If one stands on a desk that has been talking to the board for
days, it is still worth checking why the approval went missing:

```bash
cat <desk repo>/.claude/settings.local.json     # expect enabledMcpjsonServers
```

Missing, on a desk that has been talking to the board, means the file was
removed after the fact — it is gitignored, so a fresh clone or `git clean -x`
takes it. Answer the dialog once by hand and the desk is well again. The
reasoning for keeping `ANSWERS` one question long is written where the change
would be made, beside `ANSWERS` in [`host/window.js`](../../../host/window.js).

## 5. Is the running host even the code you edited?

```bash
ps -o lstart= -p $(pgrep -f "host/index.js" | head -1)
ls -lT host/index.js
```

Nothing hot-reloads. A process older than the file is running the old code:

```bash
launchctl kickstart -k gui/$(id -u)/com.appideas.orchestratinator-host
```

Also confirm the host picked the right board — `grep '→ http' ~/.orchestratinator/log/host.log`
should say `http://localhost:8787`. The log goes quiet after startup, so silence
proves nothing.

**And check the desks, not just the code — but a stale list is not a `kickstart`
matter any more.** `discoverDesks()` used to run once, in `main()`, so a repo
bound to the board after the host started stayed invisible until a restart.
Since 2026-09-03 the host rescans its roots before every heartbeat, and the
server asks every live host to look immediately when a session starts on a
desk none of them runs (`host/index.js`'s `rescan()`, `askRescan()` in
`src/floor.js`) — see [[host-desk-rescan-blocks-handoff]]. A binding that has
genuinely changed therefore self-heals within the heartbeat interval (a
minute) on its own, and the floor's "No host on this board is running that
repo" hint carries a **Look now** button (`/api/floor/rescan`) that forces the
same look immediately, for anyone who would rather not wait. Compare the
host's start time against the *repo's* `.mcp.json` only to confirm the host
is actually running the rescanning code, not as the fix itself:

```bash
ps -o lstart= -p $(pgrep -f "host/index.js" | head -1)
ls -lT host/index.js host/window.js   # a process older than these predates the rescan
ls -lT .mcp.json                      # X-Channel / X-Agent live in here
grep -A3 '→ http' ~/.orchestratinator/log/host.log | tail -4   # what it actually serves
grep -E 'found desk|dropped desk' ~/.orchestratinator/log/host.log | tail -8   # what changed, and when
```

A `not_hosted` message that outlives one heartbeat with a current host running
is the real anomaly — reach for `Look now` before a restart, and restart only
if the host log shows it predates the rescan code.

## 6. Is the server the code you edited?

The stack runs from a Docker image. Compare its build time against `src/`:

```bash
docker image inspect appideas-mcp-orchestratinator-orchestratinator --format '{{.Created}}'
docker compose up -d --build   # if src/ is newer
```

## Two symptoms with known signatures

Both measured on the live board 2026-09-01. Check these before inventing a
theory that fits either shape.

**The conversation flows but desks look absent — "thought bubbles and not much
else".** Presence is an MCP session in the server's memory, so a rebuild or
restart of the container blanks it for every desk at once, while the relay —
plain HTTP from the host, with its own retries — carries on. The board looked
"disconnected" for 40 minutes while relaying perfectly.

```bash
curl -s localhost:8787/health     # sessions near 0, opened/superseded counters young
docker ps --format '{{.Names}}\t{{.Status}}' | grep orchestratinator   # "Up N minutes" ≈ when presence died
```

If the container's age matches when the desks went blank, nothing is broken and
nothing needs restarting: one MCP tool call per desk brings each back. Do not
chase the connection.

**A turn's text is mangled — `[object Object]`, or injected context glued to a
person's words.** That is a transcript record whose shape drifted under its
reader: Claude Code changes record shapes between releases (2.1.220 wrote
`queued_command.prompt` as a string; 2.1.251 writes a content-block list, and a
`String()` in `readTranscript` showed every mid-turn message as
`[object Object]`). Read the actual record from the session's `.jsonl` and
compare it with the reader in `host/window.js` before any other theory — the
fix belongs in the reader (`textOf` handles both shapes; `contextTagOf` splits
injected context).

Two follow-ons that cost real time: already-relayed rows never self-correct,
because the relay's offset never re-reads old bytes — and the live database is
**not** `data/` in the repo (that is test leftovers; the volume is named).
Repair rows through the container, and expect turn retention to have already
pruned old ones:

```bash
docker compose exec -T orchestratinator node < fix.js   # better-sqlite3 at $DB_PATH
```

## What not to do

- Do not theorise about environment drift, versions, or infrastructure until
  steps 1–6 are exhausted. Every real cause so far was visible in one of them.
- Do not trust an error message's stated cause over the pane's contents.
- Do not touch `10.0.42.120` or the ngrok tunnel. Only `localhost:8787` is ours.

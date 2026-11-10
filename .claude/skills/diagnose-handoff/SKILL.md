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
claude agents --json | python3 -c "import json,sys;[print(s['pid'], s.get('kind'), s.get('id'), s['sessionId'], s['cwd']) for s in json.load(sys.stdin)]"
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

**Read `kind` too.** `interactive` is a tab or a terminal with a person at it.
`background` (the session file says `bg`, `ps` says `claude bg-spare`) is
Claude Code's daemon keeping the conversation running after its tab closed —
nobody is at it, and it is what `--resume` of that id means by "running as a
background session (<id>)". The desk reads as *empty*, not held, because the
watch follows interactive sessions only. Opening the desk from the floor does
the move on its own since 2026-09-09: the host presses `claude stop <id>`,
waits for the roster to drop it, and resumes the conversation in the window
(`releaseBackground()` in [`host/window.js`](../../../host/window.js)). So a
desk that *stays* empty after an open, with a `background` entry still in the
roster, is that release failing — the desk's error quotes what `claude stop`
said. Do not run `stop` by hand on a desk that is not yours; it is somebody's
conversation, and the floor is the door onto it.

Read `held` together with the three fields beside it, because `held` alone is
ambiguous and each pairing means something different:

| `held` | `window_open` | what it is |
|---|---|---|
| `null` | `false` | nothing running — the floor correctly offers to open one. **Or a background session**: check the roster's `kind` before believing "nothing" |
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

**Every open on the board fails with `create window failed: index N in
use`.** tmux, not the host: `new-window` takes a window *index*, and a bare
`-t orch` is resolved against window names first, by prefix — so one window
whose name starts with the session's name (a desk in a folder called
`orch-slice1-demo`) makes `-t orch` mean that window's index, and every desk
on the machine stops opening at once (3.7c, 2026-09-09). The target carries a
trailing colon now (`orch:`); a return of this error means something else is
passing the bare name. Reproduce it in a throwaway session before touching
anything: `tmux new-session -d -s zz -n zz-demo sleep 60; tmux new-window -d
-t zz -n x sleep 60` fails, `-t zz:` works.

**The window opens and dies on its first line, and the desk's error quotes
`No conversation found with session ID: <id>`.** The board's pin names a
session that never became a transcript. The roster keeps a process's *first*
id, so a VS Code tab that ran `/resume` inside registered as one session and
wrote every word under another; when it closed, the desk was left pinned to
the first. Since 2026-09-09 `resumable()` checks the disk and falls back to
the folder's conversation with the latest spoken turn, saying so on the desk
as a line labeled `host` — so seeing this error means that fallback found
nothing to open, or the host predates it. What the board knows and what the
disk has are two different lists; read both:

```bash
docker compose exec -T orchestratinator node <<'EOF'      # what the board has for the desk
const db = new (require('better-sqlite3'))(process.env.DB_PATH, { readonly: true });
for (const r of db.prepare(`SELECT session_id, started_at, ended_at, pid, awaiting_kind FROM agent_sessions
  WHERE channel = ? AND agent = ? ORDER BY started_at DESC LIMIT 8`).all('<channel>', '<agent>')) console.log(JSON.stringify(r));
EOF
ls -lt ~/.claude/projects/$(python3 -c "import re;print(re.sub(r'[^A-Za-z0-9]','-','<desk cwd>'))")/*.jsonl | head   # what exists
```

A row with no file is a tab opened and closed without a word, or a process
that resumed something else. A file whose mtime is today and whose last
`"type":"user"` record is older was *reopened* without a turn — a
`bridge-session` record moves the mtime — which is why the fallback goes by
the last turn, not the file. The table is `agent_sessions`; there is no
`sessions` table, and guessing that cost a round.

**The window opens and dies on its first line, and the error says `running
as a background session (<id>)`.** See `kind` in step 2: the daemon holds
it, and the host now stops it before opening. Reaching this message means the
release did not happen — a host older than `releaseBackground()`, or a
`claude stop` that failed, which the desk's error will quote.

## A form the floor says it answered, still standing in the window

The report arrives as "it appeared to submit, and when I opened the window
later the form was still waiting". Before any theory, match the answer to
its receipt with [`match-answer.mjs`](match-answer.mjs):

```bash
node .claude/skills/diagnose-handoff/match-answer.mjs qa-probe issue7-probe-c --since '2026-11-02 18:00'
# admin_events #1662 2026-11-02 20:06:22Z permission.clarified: │ Of the three colours…
#   ee8f0ab2 asked 2026-11-02T20:05:47.759Z → tool_result 2026-11-02T20:06:22.866Z — SUBMITTED
```

The server's `admin_events` row is the desk, the second and what was pressed;
the desk's transcript is the proof — a `tool_result` for the call means it
submitted, none means it is standing. The host log line ("answered with N of
N step(s)") carries its time only from a host running the issue #5 code, and
the board's `turns` never holds the result, so neither settles it alone. On the deployed code since 2026-11-02 a
form still there after 8 s is logged "the form was not submitted"
(`still_asking`) rather than "answered"; a report against an older host is
read against that host's own log.

## A desk that took nothing for minutes — read the host's line

The report: red error turns on a desk, every message failing, an answer that
"didn't take", until the operator opened the window and did it by hand.
Before reading the pane or forming a theory, read the host's line. The host
takes its work **one item at a time** (`run()`), so one slow item holds
everything behind it, and `host_outbox` records when each item was queued and
when it was taken:

```bash
docker compose exec -T orchestratinator node - <<'EOF'
const db = new (require('better-sqlite3'))(process.env.DB_PATH, { readonly: true });
for (const r of db.prepare(`SELECT id, kind, substr(payload,1,80) AS payload, created_at, taken_at FROM host_outbox
    WHERE channel = ? AND agent = ? AND created_at > ? ORDER BY id`).all('<channel>', '<agent>', '2026-11-05 16:05')) console.log(JSON.stringify(r));
EOF
```

A gap between `created_at` and `taken_at` is time the item sat behind the
one before it, and the item before it is the culprit. Measured on
2026-11-05 (#44 follow-up): three `chat` items, each taken at once and each
held for 60 s. They were pasting into a window showing an AskUserQuestion,
which takes no composer input ("pasted in 14 times over 60s"). The `answer`
to that very form was queued 4 s after the first chat and taken 60 s later.
At that age the host dropped it as "long gone", so the form never closed.
Two cheap readings first ruled out the expensive theory, the board's and
the host's clocks disagreeing: `date -u` beside `docker compose exec -T
orchestratinator node -e 'console.log(new Date().toISOString())'` agreed to
the second. Since then the board refuses a message to an asking desk
(`askingWhy`), `send()` refuses in a second (`asking`), and an old answer
is pressed while its question is still on screen (`askedStill`). A gap
like this is now a new fault, not that one.

## Who held a conversation that is gone — after the fact

The question in issue #24 (task 253): a reopen was refused "outside tmux
(pid N)" days ago; was pid N the window the host had just closed, or a real
second holder? The pid is gone and the session file with it. Three things
still answer it, all read-only:

- **When it happened.** A `host.log` line written by a host running the
  issue #5 code carries its UTC time after the tag (`[host]
  2026-11-03T19:54:18.123Z …`); every line before that host's first start
  has none, and the file holds both. For an untimed stretch, `/api/activity`
  has times to the second, newest first, a thousand rows a page: page it with
  `?limit=1000&offset=N` and keep the `admin.desk.*` rows (`desk.take` with
  its mode, `desk.moved`, `desk.bound`, `desk.new`), then line them up
  against the log's order. The log's refusal comes straight after its
  "closed its window to reopen on <id>".
- **When the conversation's process ended.** Claude Code writes
  `last-prompt` and a `cost-state` record into the transcript as it exits,
  and on a window that was not resumed `cost-state.startTime +
  totalDuration` is the moment its exit handler ran, to the millisecond
  (measured: a probe killed at .311 wrote .328). For the coordinator move on
  2026-11-02 that put the process's end at 19:23:24.922, in the same second
  as `desk.moved`: the window the host closed. On a resumed window
  `startTime` is the conversation's first start and the sum is not a clock —
  check the `cost-state` count against the kills you expect instead.
- **Who else wrote.** Every record carries `entrypoint` (`cli`,
  `claude-vscode`, …) and `version`. One `cli` writer and nothing else rules
  out an editor tab.

`ps -o pid= -p N` only tells you N is gone, which it always is by then.

## The host could not reach the board — which request, and when

Issue #5 (steps 1–2). Every line the host writes carries its UTC time after
the tag, and a failed host→board request is one sentence naming its method,
the whole URL (board and path in one token), what failed and how long it
waited (`request()` in `host/index.js`, the words in `host/log.js`):

```
[host] 2026-11-03T19:54:18.123Z POST http://localhost:8787/api/host/register refused (ECONNREFUSED) after 2ms; retrying in 1s
[host] 2026-11-03T19:55:02.410Z GET http://localhost:8787/api/host/work?host_id=…&wait=1 timed out after 10703ms (limit 10700ms); retrying in 1s
[host] 2026-11-03T19:55:09.002Z events not delivered (POST http://localhost:8787/api/host/events → 503 after 4ms); will retry with the next batch
```

`refused` is said only for ECONNREFUSED. Any other socket fault is named by
its own code (`failed (UND_ERR_SOCKET: other side closed)`), and a 200 whose
body never parsed reads `→ 200, body failed (…)` or `→ 200, body timed out`.
The `retrying in Ns` after a run-loop failure is still the backoff step. It
is back at 1 s only after a work poll got through and every item in it was
handled, or in a fresh process. What the counts are by:

```bash
L=~/.orchestratinator/log/host.log
grep -oE '(GET|POST) [^ ]+/api/host/[a-z]+' $L | sort | uniq -c                    # by route and board
grep -oE '/api/host/[a-z]+[^ ]* (refused|timed out|failed|→ [0-9]+)' $L | sed -E 's/\?[^ ]*//' | sort | uniq -c   # by route and outcome
grep -E 'timed out after' $L | awk '{print $2}' | cut -c1-16 | uniq -c                   # timeouts per minute, to line up with docker logs -t
```

**What a run of failures usually is**, from dating all 7,066 lines issue #5
had (task 262 and its reproduction, 2026-11-03). Read the shape before
theorising; the cause of each was measured:

| the run looks like | it was | check |
|---|---|---|
| one line, `UND_ERR_SOCKET` or `refused`, then nothing | a deploy's container swap | an image build or `Recreated` in the same minute (`docker images -a`) |
| work-poll timeouts at the `1s` step, no `events not delivered`, nothing else logged, overnight or idle | **the Mac asleep**: a poll in flight when it sleeps fails on a DarkWake, and the next one gets through | `pmset -g log` Sleep / DarkWake in the minute; with times since 0.10.11, the wait reads far past its limit |
| awake; event POSTs failing too; board `event loop held` lines | the board's loop starved, in issue #5's case **Docker's VM out of memory** under an e2e matrix | the capture's `OOM kills in the VM`; Docker Desktop's memory (8 GiB since 2026-11-03) |
| `refused` at the `30s` cap for hours | the board not running at all | `docker ps`; Docker Desktop itself |

The sleep row is the commonest by far: 2,506 lines, and none in the three
days the Mac stayed awake. It is harmless, since nobody is at a floor when
it happens, and the capture does not open on it: about one a DarkWake is
below its 5-in-10-minutes threshold.

**A timeout that waited well past its limit is not only the board.** The
timer that ends the wait runs on the host's own event loop, so `timed out
after 14210ms (limit 5000ms)` is a host that could not get to its own
timer for nine seconds. The board being slow cannot make the wait longer
than the limit. Read the wait against the limit before going to the board's
log.

**The board's side, and the minutes around it.** A board with issue #5's
step 3 writes `event loop held <N>ms` and `slow <METHOD> <path> <N>ms
<status>` (`docker logs -t appideas-orchestratinator | grep -E 'event loop
held|slow '`). Those lines, and Docker Desktop's logs for the same minutes,
are gone within hours, so do not go looking for them after the fact. The
**capture-a-burst** skill saves them while the burst is under way into
`~/.orchestratinator/captures/<first failure>/`, along with probes that tell
the board, the forwarder, the VM and the host apart. Its SKILL.md has the
table for reading one.

## A window that cannot read its own folder (EPERM)

"Can't read the current directory (EPERM)" on a window's first line, or an
agent's tools getting `Operation not permitted` on its own repo (2026-11-10).
POSIX modes are not the cause here; the cause is which process is asking.
The host now moves every window to a fresh server when this happens (CLAUDE.md, "A tmux
server can lose the right to read a desk's folder"), so seeing it means that
move did not run or did not work. Read these in order:

```sh
D=/path/to/the/desk
# 1. Does the floor's server read it? (exit 0 = yes). Its forks are its windows.
#    No -t: given a target, a refused read leaves that pane (orch: is a
#    desk's window) in view-mode, and the desk's next message goes to the
#    mode, not to Claude Code (QA, PR #54 finding 1). If one is parked, `q`.
tmux run-shell "cd -- '$D' && /bin/ls -a >/dev/null 2>&1"; echo $?
# 2. Does a fresh server? (the host's freshReads, by hand)
tmux -L chk -f /dev/null new-session -d -s c 'sleep 30'
tmux -L chk run-shell "cd -- '$D' && /bin/ls -a >/dev/null 2>&1"; echo $?
tmux -L chk kill-server
# 3. The kernel's word. Use /usr/bin/log: zsh has a `log` builtin that eats
#    the arguments ("too many arguments").
/usr/bin/log show --last 5m --style compact \
  --predicate 'eventMessage CONTAINS "System Policy" AND eventMessage CONTAINS "'"$D"'"'
# 4. Which folders that server can read: those carrying a macl grant.
xattr -px com.apple.macl "$D" 2>/dev/null | tr -d ' \n'; echo
```

1 refused and 2 reads is the stale server, and the host's heartbeat check
(`checkServer`, every `ORCH_HOST_HEARTBEAT_MS`) should already have moved
it. Read `host.log` for "the tmux server cannot read". If both refuse, the
problem is macOS's grant to the host's process tree, not the server, and
`open()` says `unreadable`. The agent's own diagnosis will be wrong: on the
day, it blamed its own `cd` and saved that as a memory. Its process cannot
lose a grant by changing directory.

## What not to do

- Do not theorise about environment drift, versions, or infrastructure until
  steps 1–6 are exhausted. Every real cause so far was visible in one of them.
- Do not trust an error message's stated cause over the pane's contents.
- Do not touch `10.0.42.120` or the ngrok tunnel. Only `localhost:8787` is ours.

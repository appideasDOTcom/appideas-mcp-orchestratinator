# appideas-mcp-orchestratinator

A tiny, self-hosted **MCP coordination server** that lets Claude Code agents
living in **separate VS Code windows** work together — without opening a shared
parent folder and without merging their scopes.

Each agent stays in its own repo/window as usual. They share one thing: this
server, running in Docker, which gives them a common **mailbox**, a set of
shared **contracts** (the agreed interface between two plugins), and a lightweight
**task** board. One container serves any number of plugin pairs.

---

## Simplest use case
- Run the host on your machine once (`./host/install.sh <your projects dir>`); it
  stays running and finds every repo that is a desk.
- Open the floor at `http://localhost:8787/` and type to a desk. If no Claude Code
  window is open for that repo, one opens; if one is already open, the message
  lands in it.
- Sit at any desk yourself whenever you want: `tmux attach -t orch`. Each desk is
  a window in that session. Type there instead — same conversation, and the floor
  keeps showing it.

There is nothing to hand over and nothing to stop. You are never choosing between
the floor and your terminal; they are two windows on the same session.

## Start to finish

Everything below is done once per machine, in order. Steps 1–7 are setup; step 8
is the part you do every day.

**Before you start** you need Docker, `tmux`, and Claude Code installed and
signed in — the host runs the same `claude` binary your terminal does, with your
login. (Node 20 is only needed if you intend to run `npm test`.)

**1. Get the code.**

```bash
git clone git@github.com:appideasDOTcom/appideas-mcp-orchestratinator.git
cd appideas-mcp-orchestratinator
```

Everything below is run from this directory unless it says otherwise.

**2. Make a shared secret.**

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Put it in `.env` at the root of this repo:

```ini
ORCH_AUTH_TOKEN=<the generated value>
ORCH_AUTH_MODE=enforce
```

**3. Start the server.**

```bash
docker compose up -d
curl -s localhost:8787/health          # {"ok":true,...}
```

It listens on `127.0.0.1` only, and keeps its data in a Docker volume.

**4. Make each repo a desk.**

A repo joins the board by declaring itself in its own `.mcp.json` — there is no
central list, and no shared parent folder:

```jsonc
{
  "mcpServers": {
    "orchestratinator": {
      "type": "http",
      "url": "http://localhost:8787/mcp",
      "headers": {
        "X-Channel": "your-channel",
        "X-Agent": "this-repo's-role",
        "X-Orchestratinator-Key": "<the ORCH_AUTH_TOKEN from .env>"
      }
    }
  }
}
```

Repos sharing a `X-Channel` share a floor, a mailbox, and a task board. The
`X-Agent` is that repo's seat on it. A directory without this file is invisible
to the whole system.

**5. Install the plugin** (this is what puts each session on the floor):

```
/plugin marketplace add .
/plugin install orchestratinator-floor
```

The `.` is the clone from step 1, so this works when the Claude Code session you
type it in was opened there. From any other window, give the full path to the
clone instead.

**6. Install the host** (this is what lets the floor open and drive windows):

```bash
./host/install.sh ~/path/to/your/projects
```

Name the directory your repos live under. It finds every desk beneath it,
registers a LaunchAgent so it starts at login, and reads the server address and
secret from the first desk it finds. Nothing else to configure.

**7. Open the floor.**

```
open [http://localhost:8787/](http://localhost:8787/) in a web browser.
```

That lands on the dashboard; the board/floor switch is top right. Every desk you
wired up in step 4 should be there.

**8. Using it.**

Work in your editor exactly as you always have. Nothing about Claude Code
changes, and the floor shows the conversation as it happens.

When you want to drive a desk from the floor instead:

- **Close that conversation's tab in your editor.** A conversation is one
  process, so one app holds it at a time. While your editor has it, the floor
  shows it read-only and says so — the composer is greyed and the desk reads
  *"open in your editor"*.
- **A second or two later the composer comes alive.** Type and send. If no
  window is open, the host opens one and *resumes the same conversation* — your
  history is still there, and the reply continues it rather than starting over.
- **To take it back, press "Open in VS Code."** The host closes its own window
  first, then opens the conversation in your editor, with everything you did
  from the floor already in it.

Two things follow from "one app at a time", and both are visible rather than
silent:

- **Answer permission prompts where the conversation is.** If your editor holds
  it, the floor shows the prompt but no buttons — answering means pressing a key
  in the window that asked, and the floor has none to press. It says *"answer
  this in your editor"* instead of offering a button that cannot work.
- **You can sit in a window the floor opened.** `tmux attach -t orch` — each desk
  the host has opened is a window in that session. Typing there is the same as
  typing on the floor, because it is the same window.

## Some useful commands
In a terminal:
```
docker compose up -d                       // start (add --build after code changes)
docker compose down                        // stop; data kept in the volume
docker compose logs -f orchestratinator    // tail
curl -s localhost:8787/health              // is it up?
open http://localhost:8787/                // the dashboard — who's connected, what they're doing
                                           //   (the board/floor switch is top right)
npm test                                   // all six suites: coordination, operator actions, the doors,
                                           //   the floor, the host, and the window
```
In a chat window:
```
whoami                                     // confirm channel/agent wiring
list_tasks status=open                     // what's pending for me
list_tasks status=claimed                  // in-progress claims (stale ones auto-reopen)
get_contract                               // read the whole agreed interface
```

## Two different questions, two different mechanisms

**Agents talking to each other is pull.** MCP is client-initiated: this server can
**hold** shared state and messages, but an agent only sees new messages and tasks
when it calls a tool to check. Coordination between two agents is a cooperative
protocol, not remote control, and nothing here pretends otherwise.

**A human talking to an agent is push.** That is a different problem with a
different answer. Claude Code runs in a tmux pane, so the floor types into it the
way you would — `tmux send-keys`, as one bracketed paste. The window does not
have to be idle, does not have to be polling, and does not have to be yours: you
can be attached to the same pane at the same time.

This used to be one question with one answer, and the answer was wrong. The floor
had a *driver* per desk — a window you had open "owned" its session, so the floor
stood aside and offered you a copy button. That was built on the belief that a
live Claude Code window cannot be typed into from outside. It can. Everything
that belief produced — the driver, the release, the fork-versus-resume, the
process watching, the session TTL, and a second half-built chat client called
`orch` — is gone.

What the floor still cannot do is make an agent act *on the board*: leaving a task
in `list_tasks` does not wake anybody. Type to them on the floor instead, which
now actually reaches them.

---

## Channels: one server, many plugin pairs

Everything is scoped by a **channel**. A channel is one coordination space —
normally one free/pro plugin pair. Adding a new pair later needs **no server or
Docker change**: the two new agents simply use a new channel name in their
`.mcp.json`. The `appideas-site-syncinator` pair uses channel
`appideas-site-syncinator`; a future pair just picks its own.

Identity (channel + who you are) is bound **per connection via HTTP headers** set
in each repo's `.mcp.json`:

- `X-Channel` — which coordination space this repo belongs to.
- `X-Agent` — this repo's role on that channel (`free` / `pro`).
- `X-Orchestratinator-Key` — the shared secret, same for every client. See
  [The shared secret](#the-shared-secret).

Because identity rides on the connection, the agent almost never has to pass
`channel`/`agent` to a tool — but every tool accepts them as an override.

---

## The dashboard

Open **`http://localhost:8787/`** in a browser — or the machine's address on your
network, if you've published the port beyond loopback. It's a view of the same
SQLite database the tools write to, refreshing itself every couple of seconds; no
reload needed. Reading it changes nothing. It can also take a small set of
deliberate **operator actions** — see *Operator actions* below.

There is no sign-in. The board is open to anything that can reach the port, and
the only credential in the system guards `/mcp` (see *The shared secret*). That
is a deliberate trade for one machine on one trusted network: the boundary is the
network, not a password. Publish the port somewhere less friendly and you have
handed out the board.

You get three things:

**Channels & agents.** One card per channel, one row per agent, with a presence
dot: green = a live MCP session, amber = no live session but it called something
in the last 5 minutes, red = gone.

A caveat worth knowing, because it's an MCP fact rather than a bug here: a
session ends when the client says so, and clients vary. Some reuse one session
for the life of the window; others (Claude Code driving a `/loop`, for instance)
open a fresh session per turn and never tear the old one down. The server
therefore prunes for them — a new session for a given channel+agent supersedes
that pair's older idle sessions, and anything untouched for `SESSION_TTL_MINUTES`
(default 15) is closed. Clients recover silently, since an unknown session id
answers `404`, which is the spec's cue to re-initialize. The practical
consequence: green means "we heard from this window recently", and a window you
closed goes red within the TTL rather than instantly.

**Approximate last-known state.** Each agent gets a state chip. If the agent has
called `set_status` and that status hasn't expired, its declared state wins and
is shown with its age — `waiting · 3m ago` — with the detail line beneath
(`e2e public tier, ~8m`). The four states are `working`, `waiting`, `blocked`
and `idle`; the chip's colour comes from the state the agent declared, never
from guessing at its words. Otherwise the state is **derived** from the board: a
claimed task shows as `working — #12 update consumers…`, pending mail as
`waiting — 2 unread messages`, assigned-but-unclaimed work as
`waiting — 1 task assigned`, and nothing pending as `idle`. It's an
approximation by design — the server can't see inside the agent's turn, only
what it last told the board (see *it's pull, not push* above).

**A status expires.** Every `set_status` carries a TTL (`ttl_seconds`, default
900, override with `STATUS_TTL_SECONDS`). Past it the status is treated as
absent and the chip falls back to a derived state. This is the load-bearing
part: without it an agent that crashes mid-run leaves `waiting` on the board
forever and the human keeps trusting it. The displayed age exists for the same
reason — `waiting · 40m ago` reads as suspect in a way a bare `waiting` cannot.

Note what is deliberately **not** inferred: a long gap since an agent's last
tool call is never read as "waiting". That gap looks identical whether the agent
is blocked, crashed, or simply finished and quiet, so only the agent can say —
which is what `set_status` is for.

**Minimize a channel to change your focus.** The `–` on any channel header folds
that card into a pill beneath the board; clicking the pill unfolds it, and `show
all` brings everything back at once. This is *focus*, not a decision: it lives in
`localStorage` in one browser, so nobody else's board changes, nothing is
audited, and there's no server round-trip — which is the whole difference from
archiving a channel, which is a shared and semi-permanent statement (see
*Operator actions*). A pill keeps the channel's unread count on it, so narrowing
your focus never hides news.

**Activity log.** Every interesting write — messages, task opened/claimed/done,
contract versions, and operator actions — merged into one newest-first list,
filterable by channel, by kind, and by free text. Click any row to expand the
full stored value (message body, task note, contract JSON).

To make the state chips exact rather than inferred, have the agent call
`set_status` as it works — e.g. add "call `set_status` when you start and finish
a step, and always before anything long-running" to the repo's `CLAUDE.md`.
Setting `ttl_seconds` to roughly how long the work should take is what makes a
`waiting` chip self-correcting when the agent never comes back.

---

## The floor

The `board` / `floor` switch in the top bar gives you a second view of the same
server: **one room per channel, one desk per agent**. It exists for the people
who operate this system without having built it. The board answers *what is the
state*; the floor answers *who is stuck, and what do I do about it* — the
question that was otherwise being answered by holding several chat windows and a
dashboard in one head at once.

A floor is a channel. Nothing else would be honest: a channel is one project with
one set of boundaries, and putting two of them in a room would draw a wall that
isn't there.

**What you get.** A ranked **Needs you** list at the top — who is blocked on a
human, why, for how long, and which window to go to, longest wait first. Below
it, a room per channel: each desk shows the person's state, the last thing they
said or the tool they're running, and a red badge when they need you. Envelopes
fly desk to desk on real `send_message` rows, never on a timer. Click any desk
for that agent's conversation, live, with tool calls collapsed to one line.

**What the floor knows that the board cannot.** The board is pull-based and
cannot see inside an agent's turn — that limit is real and is the subject of
*it's pull, not push* above. The floor closes the gap from the other end: Claude
Code can see inside its own turn and will say so through hooks, so each
workstation runs a small plugin that posts what its session is doing. That is
the only new moving part, and it is optional — without it the board behaves
exactly as it always has.

Nothing on the floor is inferred from silence. A desk shows `needs you` only
because Claude Code raised a permission or idle prompt, and it clears the moment
real work happens. A quiet desk is drawn quiet, because quiet is indistinguishable
from blocked, crashed, and finished — which is the same reason the board never
guesses either.

### Installing the plugin

Once per machine, from anywhere:

```
/plugin marketplace add /path/to/appideas-mcp-orchestratinator
/plugin install orchestratinator-floor
```

That is the whole setup. There is nothing to configure, because there is nothing
new to tell it: the hook reads the repo's own `.mcp.json` — the file that already
declares `X-Channel` and `X-Agent` — and posts to `/api/ingest` on the same
origin as `/mcp`, with the same shared secret. A directory whose `.mcp.json`
doesn't name the orchestratinator is not part of this system, so the hook exits
in silence and that project never appears on a floor.

It reports on session start and end, on each prompt you submit and each reply
that finishes, as a tool starts, and when Claude Code needs you. Every hook
detaches immediately, so none of it is on the critical path of a turn, and every
failure — server down, network gone, malformed config — exits quietly. A floor
going stale is visible on the floor; a red line in somebody's terminal is a bug
report about a feature they weren't thinking about. A session the host runs is
reported by the host instead, and the hook stays silent for it.

### Chatting with a desk

A desk is one of two things, and the panel says which.

A **reported** desk is a window on somebody's machine — a VS Code session the
plugin tells the floor about. You can watch it; you cannot type into it, because
nothing can. (Remote Control is the one thing that sends into an interactive
session, and only claude.ai and the Claude apps can drive it.) The composer on a
reported desk offers **copy**: it puts your text on the clipboard and names the
window to paste it into.

A **hosted** desk is a session the floor runs. A small service on the
workstation — the host, under [`host/`](host/) — runs each agent through the
Agent SDK: the same engine, tools, `.mcp.json`, hooks and `CLAUDE.md` as an
interactive window in that directory, driven over a pipe instead of a keyboard.
Type on the floor and it is a user turn in that session; the reply streams back
into the panel; a permission prompt becomes **Approve / Deny** on the desk and in
the *Needs you* list. The human is still the one deciding — from one screen
instead of one per agent. Enter sends, Shift+Enter is a new line, **stop**
interrupts the turn.

The host only ever reaches *out*. It registers with the server, then holds a
request open asking for work; the server never connects to a workstation and
nothing on the workstation listens. If the server is down the host retries; if
the host is down the floor says so and the composer goes back to copy. Sessions
survive host restarts — the server remembers each desk's session id and the host
resumes it.

#### Installing the host

Once per machine, from this repo:

```
./host/install.sh ~/Documents/dev/appideas
```

Name the directory (or directories) your orchestratinator repos live under. The
script finds them — a repo is a desk if its `.mcp.json` carries `X-Channel` and
`X-Agent` — reads the server address and the shared secret from the first one,
installs the host's single dependency, and registers a LaunchAgent so the host
starts at login and comes back if it stops. `claude` has to be on the PATH and
signed in: the host runs the same binary your terminal does, with the same login.

To run it by hand instead: `ORCH_HOST_ROOTS=~/Documents/dev/appideas npm run host`.

### What this puts on the server

Full prompts and full replies, on a dashboard that has no sign-in. That is a
bigger claim than the board ever made and is worth being deliberate about — read
the note on publishing the port, above, and mean it. Three things follow:

- `/api/ingest` takes the **same shared secret as `/mcp`**, and refuses without it.
- `turns` and `agent_sessions` are **excluded from backups**. A backup is meant to
  be a file you can email yourself; that stops being true the moment it carries
  everything anyone typed. The cast (`personas`) is included, since it's an
  operator decision that would otherwise vanish on a restore.
- Conversations are **trimmed** to the newest `TURN_RETENTION` turns per desk
  (default 400). The floor shows a live tail, not an archive — the archive is the
  transcript on the workstation that produced it, which is complete already.

`tool_input` never crosses the wire whole: the hook reduces it to the one
descriptive field that becomes the collapsed line, so writing a file does not put
that file on the network.

---

## Operator actions

Sooner or later the board shows something only a human can resolve: an agent
whose window you closed days ago, still holding 139 unread; a task nobody will
ever claim; a channel you created by typo. Hover a row and you get the small set
of actions for that: unread counts and task counts become clickable, and a trash
can appears on each agent row (the channel header gets its own).

Nothing here is a new power. `complete_task` has never had an ownership check and
`poll_messages` has always taken an `agent` override, so any connected agent
could already close anyone's task and advance anyone's cursor. These buttons make
that deliberate, attribute it to `operator`, and write it where the log can show
it.

| Action | What it does |
| --- | --- |
| **Mark read** | Advances that agent's `poll_cursor`, clamped with `MAX()` so it can only move forward. The agent never sees the messages. Cosmetic in one specific sense: delivery is driven by the `since` each agent passes itself, so the cursor is what the *board* counts, not what the agent can still fetch. |
| **Close / reassign a task** | Marks it done with a note, or moves the assignee. Never deletes — the row stays `done` and the log keeps the record. |
| **Remove an agent** | Clears its backlog, closes its live MCP sessions, and hides the row behind a `retired` chip. |
| **Archive a channel** | Hides it from the board for everyone, and says so in the log. Nothing is deleted and agents on it keep working. Semi-permanent by intent — if you only want it out of your way for the next hour, minimize it instead (see *The dashboard*). |
| **Delete a channel** | Permanent. Sweeps messages, tasks, contracts and contract history in one transaction; guarded by having to type the channel name. |

Two behaviours worth knowing before you use them:

**A removed agent comes back by itself.** Retiring closes its sessions, and an
unknown session id answers `404` — the spec's cue to re-initialize — so a window
that is genuinely still alive reconnects and un-retires itself within a turn.
Only one that is really gone stays gone. This is deliberate: an agent that is
working while invisible on the board is a worse failure than a cluttered board.
The flip side is that "remove" is not how you stop an agent; close its window.

**Retired agents and archived channels are hidden, never dropped.** Both keep a
count on screen (`1 retired`, `2 archived channels`) that reveals them again.
Silently omitting a row would make the board lie, which is the one thing it must
not do.

Deleting a channel removes it from the board but **not** from the activity log:
`admin_events` is deliberately not swept, because an audit trail you can erase by
deleting the thing it describes isn't one. The log goes on saying you deleted it,
and what it contained.

### What guards them

One thing, and it isn't authentication: **`/api/admin/*` refuses a request that
came from another site.** A foreign `Origin` or `Sec-Fetch-Site: cross-site` is a
`403`. That is the whole check.

It's worth having even with the board wide open, because "open to this machine"
and "open to every page this machine's browser happens to load" are very
different statements and only the first one was intended. Any web page you visit
can fire a `POST` at `localhost:8787`; none of them may drive your board.

It is explicitly *not* doing the other half of the job. Anything that can reach
the port and speak HTTP can take any operator action — no key, no cookie, no
token. On a machine behind a firewall, on a network you control, that's the trade
this build makes on purpose. It is also what makes the routes trivially
scriptable:

```bash
curl -s -X POST http://localhost:8787/api/admin/agent/advance \
  -H 'content-type: application/json' \
  -d '{"channel":"my-channel","agent":"pro","up_to_id":560}'
```

---

## Settings: export and restore

The **⚙** in the top bar opens one panel: export and restore. There is nothing to
unlock — see *What guards them* above for the only check these routes make.

**Export** downloads the whole board as one JSON file: every message, task,
contract with its version history, agent, channel flag, and operator-action
record. JSON rather than a copy of the SQLite file on purpose — it can be opened,
diffed and grepped, and it loads into a build whose schema has moved on (unknown
columns are reported and skipped rather than fatal).

One thing is deliberately **not** in it: **the shared MCP secret.** These files
end up in Downloads folders and cloud drives, and that key is what every agent
authenticates with — a backup carrying it would turn "a copy of my board" into
"the key to it". You get a truncated SHA-256 fingerprint instead, which answers
the only question that actually comes up on the far end ("is this the same key my
agents already have?").

Everything else in the file is board data. There are no accounts and no password
hashes in it, because there are none anywhere — see *A note on the sign-in that
used to be here*.

**Recover from a backup** replaces everything on the board with the file's
contents. Not a merge: ids are per-board, so blending two histories gives you one
task `#14` that means two different things. Pick the file — the panel shows you
when it was taken, from which version, and what's in it, before anything is sent —
then type `RESTORE`.

Before overwriting, the current board is written next to the database as
`data/pre-restore-*.json`, so a restore you regret is recoverable. Live MCP
sessions are closed and reconnect by themselves.

A backup taken by a version that still had dashboard accounts restores fine. Its
`users` table is ignored rather than written, and the report says so rather than
dropping it on the floor in silence.

### A note on the sign-in that used to be here

Earlier versions had dashboard accounts: a `users` table of scrypt hashes, login
cookies in `ui_sessions`, a sign-in page, and a per-process admin token the page
exchanged its credential for. All of it is gone, and **the first start after
upgrading drops both tables** — announced in the log, because a migration that
destroys data silently is one you find out about from its absence.

It was ceremony for the shape this actually runs in: one machine, one person, one
trusted network. A password in front of a board that only that machine's owner
can route to was buying nothing and costing a login page, a throttle, a cookie
policy, and a read-only mode to maintain.

What's left is the honest version of the same boundary. Agents authenticate to
`/mcp` with the shared secret. The board doesn't authenticate anyone, so operator
actions in the log are attributed to the literal `operator` — the board knows a
human did it, and no more than that. If you ever need to hand this to more than
one person, the sign-in is in the git history rather than in this file.

### Moving to a permanent host

The whole point of the above. On the new host:

1. Copy `docker-compose.yml` and write a `.env` with **the same
   `ORCH_AUTH_TOKEN`** as the old one — that part does not travel in the backup,
   and it's what every agent's `.mcp.json` presents. (Or generate a new one and
   update every `.mcp.json`; the fingerprint in the backup file tells you which
   situation you're in.)
2. `docker compose up -d --build` and open the board.
3. ⚙ → pick the exported file → `RESTORE`.
4. Point the agents at the new URL. Nothing else in their `.mcp.json` changes.

Both halves are also scriptable, for a cron-driven backup:

```bash
# export
curl -s http://localhost:8787/api/admin/backup -o board-$(date +%F).json

# restore — replaces everything; `confirm` must be the literal word
jq -n --slurpfile b board-2026-07-30.json '{confirm:"RESTORE", backup:$b[0]}' \
  | curl -s -X POST http://localhost:8787/api/admin/backup/restore \
      -H 'content-type: application/json' --data-binary @-
```

---

## Run the server (Docker)

```bash
cd appideas-mcp-orchestratinator
cp .env.example .env                 # then set ORCH_AUTH_TOKEN — see "The shared secret"
docker compose up -d --build
```

Compose reads `.env` (gitignored) and refuses to start without `ORCH_AUTH_TOKEN`,
rather than quietly bringing up an unlocked server.

MCP clients connect to `http://localhost:8787/mcp`; the dashboard is at
`http://localhost:8787/`. The SQLite database persists in the named volume
`orchestratinator-data` (survives rebuilds).

```bash
curl -s http://localhost:8787/health        # {"ok":true,...}
docker compose logs -f orchestratinator      # tail logs
docker compose down                          # stop (data is kept in the volume)
```

### Run locally without Docker (for hacking on it)

```bash
npm install
npm start            # MCP on /mcp, dashboard on /, db at ./data/orchestratinator.db
npm run smoke        # end-to-end self-test (spawns its own server, cleans up)
```

Environment variables (see `.env.example`):
`ORCH_AUTH_TOKEN` (the shared secret; empty disables auth),
`ORCH_AUTH_MODE` (`off` / `warn` / `enforce`, default `enforce` when a token is set),
`PORT` (default `8787`),
`HOST` (default `0.0.0.0` — must stay that inside Docker. Set `HOST=127.0.0.1`
when running bare and you want this machine only),
`DB_PATH` (default `./data/orchestratinator.db`; `/data/...` in Docker),
`CLAIM_TTL_MINUTES` (default `15`; how long a claim can sit before it auto-reopens),
`SESSION_TTL_MINUTES` (default `15`; how long an untouched MCP session is kept).

`curl -s localhost:8787/health` reports the live session count and lifetime
connection churn (`opened` / `superseded` / `expired`) — a large `superseded` just
means a client opens a session per turn, which is normal and handled.

---

## The shared secret

Every MCP client presents one shared key. It's a doorlock, not a security model:
one static token for all agents, no rotation, and `X-Agent` is still
self-asserted — anyone holding the key can claim to be anyone. It exists so
something that stumbles onto the port can't read and write the board. The
compose file still publishes on `127.0.0.1` only; this is the second lock, not
a reason to remove the first.

Generate one and put it in `.env` (gitignored, and read by both `docker compose`
and `npm start`):

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

```ini
# .env
ORCH_AUTH_TOKEN=<the generated value>
ORCH_AUTH_MODE=enforce
```

Clients send it as `X-Orchestratinator-Key: <token>` (or
`Authorization: Bearer <token>`). `/health` stays open so the container
healthcheck keeps working.

### Turning it on without interrupting anyone

Restarting straight into `enforce` cuts off every agent whose `.mcp.json` hasn't
been updated yet — including one that's mid-task. `ORCH_AUTH_MODE=warn` exists
for that window: a missing or wrong key is logged and **allowed through**.

1. Set `ORCH_AUTH_TOKEN` and `ORCH_AUTH_MODE=warn` in `.env`, then
   `docker compose up -d`.
2. Add the header to each repo's `.mcp.json` (below) and reload those windows.
3. Watch `docker compose logs -f orchestratinator` until no `auth WARN` lines
   appear — that means every live client is sending the key.
4. Flip to `ORCH_AUTH_MODE=enforce`, `docker compose up -d`.

A rejected client gets `401` with a JSON-RPC error explaining which header to
set — it never reaches a tool and never appears on the dashboard.

### The dashboard

The secret does not guard it. `/`, `/api/state`, `/api/activity` and every
`/api/admin/*` route answer anything that can reach the port — no key, no cookie,
no sign-in. The only refusal is a cross-origin write; see *What guards them*.

So the port is the boundary. `docker-compose.yml` publishes it on every interface
so other machines on your network can use the board, which is right for a trusted
LAN and wrong for anything else. Put back the `127.0.0.1:` prefix on the `ports:`
line to make it this machine only, and don't forward it through a tunnel unless
you mean to hand out the board.

An earlier version had real dashboard accounts. They're gone on purpose — see
*A note on the sign-in that used to be here*.

---

## Wire up the two plugin repos

Copy the matching file from [`clients/`](clients/) into each repo as
`.mcp.json` (Claude Code reads project-scoped MCP servers from there — no shared
parent folder required):

- Free repo  → [`clients/syncinator-free.mcp.json`](clients/syncinator-free.mcp.json)
- Pro repo   → [`clients/syncinator-pro.mcp.json`](clients/syncinator-pro.mcp.json)

```jsonc
// .mcp.json in the FREE plugin repo
{
  "mcpServers": {
    "orchestratinator": {
      "type": "http",
      "url": "http://localhost:8787/mcp",
      "headers": {
        "X-Channel": "appideas-site-syncinator",
        "X-Agent": "free",
        "X-Orchestratinator-Key": "<the ORCH_AUTH_TOKEN from .env>"
      }
    }
  }
}
```

The pro repo is identical except `"X-Agent": "pro"`. Reload each VS Code window
(or restart the Claude Code session) so it picks up the new server, then ask the
agent to run `whoami` to confirm it's bound to the right channel/agent.

The files in `clients/` carry a `PASTE_ORCH_AUTH_TOKEN_HERE` placeholder —
they're committed, so the real token never goes in them. Each repo's `.mcp.json`
holds a copy of the secret, so gitignore it there unless the repo is private.

> If your Claude Code version predates inline `.mcp.json` header support, add it
> from the CLI instead:
> `claude mcp add --transport http orchestratinator http://localhost:8787/mcp --header "X-Channel: appideas-site-syncinator" --header "X-Agent: free" --header "X-Orchestratinator-Key: <token>"`

Also drop [`clients/CLAUDE.snippet.md`](clients/CLAUDE.snippet.md) into each
repo's `CLAUDE.md` so the agent knows when to reach for these tools.

---

## Adding another plugin pair later

1. Start the server (it's already running — nothing to change).
2. In the two new repos, add a `.mcp.json` like above with a **new** `X-Channel`
   (e.g. `my-other-plugin`), `X-Agent` of `free` / `pro`, and the same
   `X-Orchestratinator-Key` — the key is per-server, not per-channel.

That's it. The channels are isolated; the same container serves them all.

---

## Tools

All tools inherit `channel`/`agent` from the connection headers; both can be
overridden per call. Contract values and message bodies may be strings or
structured objects.

| Tool             | Purpose |
|------------------|---------|
| `whoami`         | Show the bound channel/agent and who's present. Call first to confirm wiring. An agent the operator has retired is not listed as present — removal is honest towards agents too, not just the board — and it reappears as soon as it calls anything. |
| `set_status`     | Declare your state — `working`/`waiting`/`blocked`/`idle` — plus a `detail` line and optional `ttl_seconds`. Shows on the dashboard with its age; nothing reads it back. |
| `send_message`   | Post to the channel. Omit `to` to broadcast; set `to` (e.g. `"pro"`) to DM. |
| `poll_messages`  | Fetch messages for you newer than `since`; returns a `cursor` to pass next time. |
| `set_contract`   | Create/update a shared interface entry by `key`. Bumps version, records history. |
| `get_contract`   | Read one entry by `key`, or all entries if `key` is omitted. |
| `open_task`      | Open a task, optionally `assignee`d to an agent. |
| `list_tasks`     | List tasks; filter by `status` (`open`/`claimed`/`done`) and/or `mine`. Listing open tasks auto-reopens stale claims. |
| `claim_task`     | Claim an open task so the other agent knows you've got it. |
| `complete_task`  | Mark a task done, with an optional `note`. |

### A typical exchange

The free plugin changes a filter the pro plugin consumes:

```
free →  set_contract  key="filters.sync_payload"
                      value={ args:["post_id","payload","ctx"], since:"1.1" }
free →  open_task     title="update consumers to 3-arg filter" assignee="pro"

# later, in the pro window (on a poll loop, or when you next talk to it):
pro  →  poll_messages
pro  →  list_tasks    status="open"     → sees the task
pro  →  claim_task     id=7
pro  →  get_contract   key="filters.sync_payload"   → reads the new shape
pro  →  complete_task  id=7  note="updated in PR #42"
```

---

## Does this change the VS Code experience?

No. These tools are called by the **same agent you're already driving** in each
window. Progress/streaming output and the usual tool-approval prompts appear
exactly as they do for any MCP tool — per window, per agent. There's no
background agent acting on its own; the server is a passive shared service that
each agent talks to when *you* (or a poll loop) prompt it to.

---

## How it works (internals)

- **Transport:** Streamable HTTP (`@modelcontextprotocol/sdk`), so multiple VS
  Code windows connect to one shared process. (stdio would spawn a *separate*
  server per window with no shared state — which defeats the purpose.)
- **Session binding:** on `initialize`, the server reads `X-Channel`/`X-Agent`
  from the request headers and binds them to that MCP session; a fresh
  per-session `McpServer` closes over that context. Sessions are pruned by
  supersession (a new one for the same channel+agent closes that pair's older
  idle ones) and by an idle sweep, so a client that never sends `DELETE` can't
  leak `McpServer` instances. In-flight requests and open SSE streams are exempt.
- **Storage:** SQLite via `better-sqlite3`. One Node process means writes
  serialize naturally — no cross-process locking. Data lives in a Docker volume.
- **Schema:** `messages`, `contracts` (+ `contract_history`), `tasks`, `agents`
  (presence), `channel_flags` (archive), `admin_events` (operator audit) — all
  keyed by `channel` — plus `users` and `ui_sessions`, which are the only two
  tables that aren't. See [`src/db.js`](src/db.js). A channel is never a row of
  its own; it's a key shared across those tables, which is why archiving needs a
  flag table and deleting has to sweep all of them in one transaction.
- **Dashboard:** a separate Express router on the same port. `GET /api/state`
  builds the channel/agent view; `GET /api/activity` is a `UNION ALL` over
  messages, task transitions, contract history and operator actions, ordered
  newest-first. The page polls both every 2.5s, so it stays current without a
  reload. Live presence comes from an in-memory registry of open MCP sessions,
  which is why closing a VS Code window shows up immediately rather than aging out
  of the database.
- **Operator actions:** `POST /api/admin/*`, guarded independently of the read
  side (custom-header token + same-origin check; see *Operator actions*). Each one
  writes an `admin_events` row, and `retire`/`delete` also reach into the session
  registry to close live sessions — a database-only change would be undone by the
  next tick, since a live session is itself a source of presence.
- **Human auth:** none. There is no guard in front of the dashboard router at
  all, which is why there is nothing here to describe — the shape of this section
  is the point. `/api/admin/*` gets one middleware that compares `Origin` against
  `Host` and rejects `Sec-Fetch-Site: cross-site`; absence of `Origin` passes,
  since a same-origin `GET` and curl both omit it.
- **Backups:** [`src/backup.js`](src/backup.js) dumps and reloads a fixed table
  list, generically, via `PRAGMA table_info` — the column set is the file's own
  rows intersected with the live schema, which is what lets a file survive a
  migration in either direction. The reload is one `db.transaction` over every
  table, because a half-restored board is worse than a refused one. `/api/admin/backup/restore`
  is the single route with a raised body limit (`RESTORE_BODY_LIMIT`, default
  128mb); everything else stays capped at 4mb.
- **Self-heal:** a claim with no completion after `CLAIM_TTL_MINUTES` (default 15)
  reverts to `open` on the next open-poll, so an abandoned claim (agent claimed a
  task, then its turn died) can't sit invisibly in `claimed`. `status=claimed`
  inspections never trigger this — only actionable open-task listings do.

```
src/
  server.js   Express + Streamable HTTP wiring, per-session header binding
  db.js       SQLite schema + channel-scoped data operations
  tools.js    The MCP tool definitions
  web.js      Dashboard router: /api/state, /api/activity, /api/admin/*, static UI
  auth.js     The shared-secret guard on /mcp, and the cross-origin check on writes
  backup.js   Export and restore the whole board as one JSON document
  ui/         The dashboard page (no build step, no external assets)
clients/      Ready-to-copy .mcp.json files + a CLAUDE.md snippet
test/
  smoke.mjs   End-to-end self-test: coordination + dashboard reads (npm run smoke)
  admin.mjs   End-to-end self-test: operator actions + their guards (npm run test:admin)
  auth.mjs    End-to-end self-test: both doors + export/restore (npm run test:auth)
```

---

## Notes & limits

- **The network is the boundary. There is no second one for the dashboard.** The
  shared secret keeps a casual port-scan off `/mcp`, but it's one static key for
  every agent, and the board itself asks for nothing at all — it renders every
  message body on every channel to anyone who can reach the port, and its operator
  buttons work for them too. Compose publishes on every interface, which is the
  right answer for a machine on a LAN you control and the wrong answer everywhere
  else. Do not put this on a real address or forward it through a tunnel. If you
  ever need to, the sign-in that used to be here is in the git history.
- **`X-Agent` is honor-system identity**, not a security boundary — everyone
  shares one key, so holding it lets you claim to be any agent. Fine for
  coordinating your own agents.
- **`operator` is a name, not an identity.** Every action under `/api/admin/*` is
  attributed to the literal `operator`, because with no sign-in the server
  genuinely cannot say who took it — only that it wasn't an agent. That much the
  label is good for: human cleanup never gets mistaken for an agent finishing work.
- **A restore is the one action with more reach than channel deletion.** It
  replaces every table a backup covers. The typed confirmation and the
  `data/pre-restore-*.json` snapshot are the whole safety net; there is no undo
  button.
- The paired agents must agree on channel/role names; the `.mcp.json` files here
  are the source of truth for the syncinator pair.

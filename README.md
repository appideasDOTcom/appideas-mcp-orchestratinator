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
- On the Pro plugin chat window
```
/loop 60s Poll the orchestratinator: list_tasks status=open, and poll_messages.
Claim and handle anything for pro per CLAUDE.md, then complete_task.
If nothing is pending, report idle and do nothing else.
```
- Chat from the Free window. Try to be clear about Pro implementation vs. Free
- Stop the loop when done

## Some useful commands
In a terminal:
```
docker compose up -d                       // start (add --build after code changes)
docker compose down                        // stop; data kept in the volume
docker compose logs -f orchestratinator    // tail
curl -s localhost:8787/health              // is it up?
open http://localhost:8787/                // the dashboard — who's connected, what they're doing
open "http://localhost:8787/?key=$KEY"     // ...same, without signing in (also the way back in)
npm test                                   // all three suites: coordination, operator actions, sign-in
```
In a chat window:
```
whoami                                     // confirm channel/agent wiring
list_tasks status=open                     // what's pending for me
list_tasks status=claimed                  // in-progress claims (stale ones auto-reopen)
get_contract                               // read the whole agreed interface
```

## The one concept that shapes everything: it's pull, not push

MCP is client-initiated. This server can **hold** shared state and messages, but
it **cannot wake an idle agent** in another window and make it act. An agent only
sees new messages/tasks when it calls a tool to check. So coordination is a
cooperative protocol, not remote control. In practice you bridge that gap one of
three ways:

1. **Nudge** — tell the other window's agent "check the orchestratinator." Simplest.
   The dashboard can send that nudge for you (the 👋 on any agent row), so you don't
   have to have that window in front of you — see *Operator actions*.
2. **Poll on a loop** — have the consuming agent run `poll_messages` / `list_tasks`
   every N minutes (e.g. Claude Code's `/loop`).
3. **Poll at boundaries** — a Stop/PostToolUse hook that checks the board when the
   agent finishes a step.

Start with #1. #1 and #2 together are the useful combination: the loop is what
makes a nudge from the dashboard land without you touching that window at all.

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

Open **`http://localhost:8787/`** in a browser. It's a view of the same SQLite
database the tools write to, refreshing itself every couple of seconds; no
reload needed. Reading it changes nothing. It can also take a small set of
deliberate **operator actions** — see *Operator actions* below — which are off
until the browser proves it's entitled to them, by signing in or by presenting
the shared secret. If accounts exist, you'll meet a sign-in page first; see
*Settings: accounts and backups*.

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
*Operator actions*). Because it isn't an operator action, minimize works on a
read-only board too. A pill keeps the channel's unread count on it, so narrowing
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

## Operator actions

Sooner or later the board shows something only a human can resolve: an agent
whose window you closed days ago, still holding 139 unread; a task nobody will
ever claim; a channel you created by typo. Or, most often, an agent that just
needs a poke. Hover a row and you get the small set of actions for that: unread
counts and task counts become clickable, and a 👋 and a trash can appear on each
agent row (the channel header gets its own trash can).

The 👋 is the one you'll reach for daily — it's a nudge you send from the board
instead of from that agent's own window, which is the difference between watching
one screen and watching six.

Nothing here is a new power. `complete_task` has never had an ownership check and
`poll_messages` has always taken an `agent` override, so any connected agent
could already close anyone's task and advance anyone's cursor. These buttons make
that deliberate, attribute it to `operator`, and write it where the log can show
it.

| Action | What it does |
| --- | --- |
| **Nudge** | Queues the message you'd otherwise have typed into that agent's window: poll your messages, look at the board, handle what's yours, respond normally. Works on an agent with an empty mailbox, which is the usual reason to nudge one. Type in the box (Enter sends) to send your own words instead. |
| **Catch up quietly** | The same delivery with the opposite instruction: skim the backlog, act only on what's urgent or addressed directly to it, reply only if a reply is genuinely needed. For draining 139 unread without inviting 139 answers. Only offered when there *is* a backlog. |
| **Mark read** | Advances that agent's `poll_cursor`, clamped with `MAX()` so it can only move forward. The agent never sees the messages. Cosmetic in one specific sense: delivery is driven by the `since` each agent passes itself, so the cursor is what the *board* counts, not what the agent can still fetch. |
| **Close / reassign a task** | Marks it done with a note, or moves the assignee. Never deletes — the row stays `done` and the log keeps the record. |
| **Remove an agent** | Clears its backlog, closes its live MCP sessions, and hides the row behind a `retired` chip. |
| **Archive a channel** | Hides it from the board for everyone, and says so in the log. Nothing is deleted and agents on it keep working. Semi-permanent by intent — if you only want it out of your way for the next hour, minimize it instead (see *The dashboard*). |
| **Delete a channel** | Permanent. Sweeps messages, tasks, contracts and contract history in one transaction; guarded by having to type the channel name. |

Three behaviours worth knowing before you use them:

**A nudge is a queued message, not a wake-up.** It's the same pull-only limit as
everything else here: the server has no way to make another window take a turn.
An agent on a poll loop picks a nudge up within one loop interval, which is what
makes the button a real replacement for typing into that window — so if you plan
to drive agents from the board, put them on `/loop` (see *it's pull, not push*).
An agent idling at a prompt will not see it until someone talks to it. The dialog
tells you where in the queue the nudge landed for exactly this reason: a nudge
behind 40 unread messages is not the prompt reply you were expecting.

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

### Unlocking them

Mutating endpoints are enforced regardless of how open the read side is, so
`ORCH_AUTH_PROTECT_UI=false` (the default) gets you an open board and locked
buttons. Until the browser proves it's entitled to write, every affordance
renders as plain text and the top bar says `read-only`.

Two ways to prove it. **Sign in** — if any account exists, that's all it takes,
and it's the reason accounts are worth having (see *Settings: accounts and
backups*). Or open the dashboard once as
**`http://localhost:8787/?key=<shared secret>`**, which drops an httpOnly cookie
and redirects to a clean URL so the secret doesn't stay in the address bar or leak
through a `Referer`. Either way the page then exchanges what it holds for a
short-lived admin token (`GET /api/admin/token`) and sends that as a custom header
on every write.

The custom header is the point: a cross-origin `POST` carrying one requires a
CORS preflight, which this server never answers, so a random page you visit can't
drive your dashboard even though it's on localhost. Requests are also refused
outright if they arrive with a foreign `Origin` or `Sec-Fetch-Site: cross-site`.
A cookie on its own would not be enough here — cookies are exactly what CSRF
rides on, which is precisely why a sign-in cookie is *not* accepted as
authorisation for a write: it only buys the token, over a same-origin `GET`. If
the server has no secret configured at all (`ORCH_AUTH_MODE=off`), the token is
handed out freely and that CSRF lock is all that's left.

For scripting, the endpoints under `/api/admin/*` also accept the shared secret
directly:

```bash
curl -s -X POST http://localhost:8787/api/admin/agent/advance \
  -H 'content-type: application/json' \
  -H "X-Orchestratinator-Key: $ORCH_AUTH_TOKEN" \
  -d '{"channel":"my-channel","agent":"pro","up_to_id":560}'

# nudge: `style` is "normal" (the default) or "quiet"; any `text` is sent verbatim
curl -s -X POST http://localhost:8787/api/admin/agent/nudge \
  -H 'content-type: application/json' \
  -H "X-Orchestratinator-Key: $ORCH_AUTH_TOKEN" \
  -d '{"channel":"my-channel","agent":"pro","text":"the interface contract changed — re-read iface.v1"}'
```

---

## Settings: accounts and backups

The **⚙** in the top bar opens two tabs: **Users** and **Tools**. Both are
operator surfaces, so both need the board unlocked (above).

### Users — a door for people rather than for agents

The shared secret is the wrong shape for a person. It's one static string
everybody holds: you can't revoke it for one holder, and it can't tell you who did
something. Accounts fix both. They're independent of the MCP key — **agents are
completely unaffected by any of this** and keep coordinating whether or not
anyone is signed in.

**Creating the first account is what turns sign-in on.** There's deliberately no
separate "require login" switch to disagree with the user list: one enabled
account means a sign-in page, and deleting them all opens the board again. So

- **Seed it from the environment.** Set `ORCH_ADMIN_USER` and
  `ORCH_ADMIN_PASSWORD` in `.env` and restart. This only ever fires when the user
  table is *completely empty*, so leaving the values there can't undo a password
  you later change in the UI. It's also the way back in if everyone forgets:
  delete every account, set these, restart.
- **Or create it by hand.** Open `/?key=<shared secret>` once, then use the gear.

After that, everything is in the panel: `+ Add user`, a per-row enable/disable
toggle, a pencil that swaps the username for *username / new password / verify*
(leave the password blank to rename without touching it), and a trash can that
asks first.

Every account is an admin. There are no roles, because the model is "people I know
by name" and a permission system you don't need is a permission system you get
wrong. The only two rules are the ones that stop you locking yourself out: **you
cannot disable or delete the account you're signed in as.** Both are enforced by
the server, not just greyed out in the UI. A caller using the shared secret
instead of a login is exempt from them — it has no account of its own to strand,
and it's the way back in when someone does.

Details worth knowing:

- **Disabling bites immediately.** Sessions are rows in the database joined
  against the user on every request, not self-contained signed cookies, so a
  disabled account stops working on its next request rather than whenever its
  cookie would have expired. Re-enabling brings the same sessions back; nobody has
  to reissue a password.
- **Changing a password signs that person out everywhere else** — but not in the
  browser making the change, because being logged out by your own password change
  reads as a bug. Renaming signs nobody out: the account is the same account.
- **Passwords are scrypt hashes** (`node:crypto`, no new dependency, no native
  build). Nothing can show you an existing one. Cost parameters live in the stored
  string, so they can be raised later without invalidating anyone.
- **Sign-in lasts `ORCH_SESSION_DAYS`** (default 30) per browser, sliding while in
  use. Failed logins are throttled per *(username, source IP)* rather than per
  account, so somebody guessing at your name can't lock you out of your own board.
  A wrong username and a wrong password give the identical message, and take the
  same amount of time, so neither answers "does this person have an account here".
  One caveat, stated because it's easy to assume otherwise: under Docker with
  nothing in front of it, every request arrives from the bridge gateway, so that
  throttle sees one address for the world and degrades to per-username. Put a proxy
  in front and set `TRUST_PROXY` to get real client addresses back. `/?key=…`
  remains a way in regardless.
- **Every change is in the activity log**, attributed to the account that made it
  — `costmo → dana`, not a generic `operator`. Server-wide actions have no channel
  of their own, so they're filed under `(server)`; that never appears as a card on
  the board.
- **Cookies get `Secure` automatically** when the request arrived over TLS.
  `ORCH_COOKIE_SECURE=true` forces it once there's a certificate in front of this
  for good. Behind a reverse proxy, set `TRUST_PROXY` so `X-Forwarded-For` is
  believed — the login throttle keys on the client IP.

### Tools — export and restore

**Export** downloads the whole board as one JSON file: every message, task,
contract with its version history, agent, channel flag, operator-action record,
and account. JSON rather than a copy of the SQLite file on purpose — it can be
opened, diffed and grepped, and it loads into a build whose schema has moved on
(unknown columns are reported and skipped rather than fatal).

Two things are deliberately **not** in it:

- **The shared MCP secret.** These files end up in Downloads folders and cloud
  drives, and that key is what every agent authenticates with — a backup carrying
  it would turn "a copy of my board" into "the key to it". You get a truncated
  SHA-256 fingerprint instead, which answers the only question that actually comes
  up on the far end ("is this the same key my agents already have?").
- **Live sign-in cookies.** Those are credentials, and restoring them onto another
  host would resurrect logins nobody made there.

It *does* carry password hashes, since they're part of the configuration you're
moving. Treat the file as a credential.

**Recover from a backup** replaces everything on the board with the file's
contents. Not a merge: ids are per-board, so blending two histories gives you one
task `#14` that means two different things. Pick the file — the panel shows you
when it was taken, from which version, and what's in it, before anything is sent —
then type `RESTORE`.

Before overwriting, the current board is written next to the database as
`data/pre-restore-*.json`, so a restore you regret is recoverable. Live MCP
sessions are closed and reconnect by themselves.

Two rules keep a restore from leaving an unusable server:

- **A backup with no enabled accounts doesn't replace the current ones.**
  Restoring it literally would produce a server that demands a sign-in and has
  nobody who can satisfy it, which reads as a broken restore rather than the
  faithful reproduction it technically is.
- **When accounts *are* replaced, every login drops** — except the browser doing
  the restoring, provided the restored table still lists it as an enabled account.
  Otherwise you'd never see the report of what you just did.

### Moving to a permanent host

The whole point of the above. On the new host:

1. Copy `docker-compose.yml` and write a `.env` with **the same
   `ORCH_AUTH_TOKEN`** as the old one — that part does not travel in the backup,
   and it's what every agent's `.mcp.json` presents. (Or generate a new one and
   update every `.mcp.json`; the fingerprint in the backup file tells you which
   situation you're in.)
2. `docker compose up -d --build`, then sign in — via `ORCH_ADMIN_USER` or
   `/?key=…`, since the new instance has no accounts yet.
3. ⚙ → Tools → pick the exported file → `RESTORE`.
4. Point the agents at the new URL. Nothing else in their `.mcp.json` changes.

Both halves are also scriptable, for a cron-driven backup:

```bash
# export (the shared secret is accepted directly, same as the other admin routes)
curl -s http://localhost:8787/api/admin/backup \
  -H "X-Orchestratinator-Key: $ORCH_AUTH_TOKEN" -o board-$(date +%F).json

# restore — replaces everything; `confirm` must be the literal word
jq -n --slurpfile b board-2026-07-30.json '{confirm:"RESTORE", backup:$b[0]}' \
  | curl -s -X POST http://localhost:8787/api/admin/backup/restore \
      -H 'content-type: application/json' \
      -H "X-Orchestratinator-Key: $ORCH_AUTH_TOKEN" --data-binary @-
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
`ORCH_AUTH_PROTECT_UI` (default `false`),
`PORT` (default `8787`),
`HOST` (default `0.0.0.0` — must stay that inside Docker; compose publishes the
port on `127.0.0.1` only. Set `HOST=127.0.0.1` when running bare),
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

With no accounts configured, *reading* `/` and `/api/*` is **not** protected by
default, because a browser can't send a custom header and locking yourself out of
the board is the worse failure. Set `ORCH_AUTH_PROTECT_UI=true` to guard them too;
then open `http://localhost:8787/?key=<token>` once — the server sets an
`HttpOnly` cookie and redirects to a clean URL, so the secret doesn't sit in the
address bar.

Once one enabled account exists, that flag stops being the thing that matters: a
sign-in is required either way, and `/?key=…` becomes the alternative rather than
the only route. See *Settings: accounts and backups*.

*Writing* is a different matter. `/api/admin/*` always demands a credential and
ignores `warn` mode, in both settings of `ORCH_AUTH_PROTECT_UI` — an open board is
a reasonable choice, "anyone who reaches the port may delete a channel" is not.
The same `?key=` visit above is what unlocks the buttons; see *Operator actions*.

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

# later, in the pro window (after a nudge or on a poll loop):
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
  next tick, since a live session is itself a source of presence. A nudge adds no
  delivery path of its own: it is an ordinary `messages` row from `operator`, so an
  agent needs no special handling to receive one.
- **Human auth:** a login is a random 32-byte id in `ui_sessions`, joined against
  `users` on every request — which is what makes disabling an account take effect
  immediately rather than at cookie expiry, the property a signed self-contained
  cookie could not give. Whether a sign-in is required at all is derived from
  `COUNT(*) WHERE enabled` (cached, busted by the user routes), so there is no
  separate flag that can disagree with the user list. The three routes a locked-out
  browser must reach — `/api/login`, `/api/logout`, `/api/session` — are mounted
  *ahead* of the guard, so the guard itself needs no exemptions.
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
  auth.js     Shared-secret guards, passwords/logins, the operator-action token
  backup.js   Export and restore the whole board as one JSON document
  ui/         The dashboard page + the sign-in page (no build step, no external assets)
clients/      Ready-to-copy .mcp.json files + a CLAUDE.md snippet
test/
  smoke.mjs   End-to-end self-test: coordination + dashboard reads (npm run smoke)
  admin.mjs   End-to-end self-test: operator actions + their guards (npm run test:admin)
  auth.mjs    End-to-end self-test: sign-in, accounts, export/restore (npm run test:auth)
```

---

## Notes & limits

- **Localhost by default, and worth keeping that way.** The shared secret keeps a
  casual port-scan off the MCP endpoint, but it's one static key for every agent,
  and the dashboard renders every message body on the channel. Compose publishes
  the port on `127.0.0.1` only. Dashboard accounts are real authentication for the
  *human* side and make exposing the board a defensible choice rather than a
  reckless one — but they say nothing about the MCP endpoint, which is still one
  shared key. If you put this on a real address, terminate TLS in front of it, set
  `ORCH_COOKIE_SECURE=true` and `TRUST_PROXY`, and don't let that one key be the
  only thing standing between the world and your agents.
- **`X-Agent` is honor-system identity**, not a security boundary — everyone
  shares one key, so holding it lets you claim to be any agent. Fine for
  coordinating your own agents.
- **`operator` is a name, not an identity — unless someone signed in.** Actions
  taken from a signed-in browser are attributed to that account, which is real
  evidence of who clicked. Actions authorised by the shared key are attributed to
  the literal `operator`, because that key genuinely cannot say who was holding it.
  Either way the label keeps human cleanup from being mistaken for an agent
  finishing work. Anything under `/api/admin/*` is trusted-operator territory.
- **A restore is the one action with more reach than channel deletion.** It
  replaces every table a backup covers, including the account list. The typed
  confirmation and the `data/pre-restore-*.json` snapshot are the whole safety net;
  there is no undo button.
- The paired agents must agree on channel/role names; the `.mcp.json` files here
  are the source of truth for the syncinator pair.

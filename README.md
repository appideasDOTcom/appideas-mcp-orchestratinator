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
2. **Poll on a loop** — have the consuming agent run `poll_messages` / `list_tasks`
   every N minutes (e.g. Claude Code's `/loop`).
3. **Poll at boundaries** — a Stop/PostToolUse hook that checks the board when the
   agent finishes a step.

Start with #1; reach for #2/#3 only if the manual nudge gets tedious.

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

Open **`http://localhost:8787/`** in a browser. It's a read-only view of the
same SQLite database the tools write to — nothing on this page can change
coordination state, it only reflects it. It refreshes itself every couple of
seconds; no reload needed.

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

**Activity log.** Every interesting write — messages, task opened/claimed/done,
contract versions — merged into one newest-first list, filterable by channel,
by kind, and by free text. Click any row to expand the full stored value
(message body, task note, contract JSON).

To make the state chips exact rather than inferred, have the agent call
`set_status` as it works — e.g. add "call `set_status` when you start and finish
a step, and always before anything long-running" to the repo's `CLAUDE.md`.
Setting `ttl_seconds` to roughly how long the work should take is what makes a
`waiting` chip self-correcting when the agent never comes back.

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

`/` and `/api/*` are **not** protected by default, because a browser can't send
a custom header and locking yourself out of the board is the worse failure. Set
`ORCH_AUTH_PROTECT_UI=true` to guard them too; then open
`http://localhost:8787/?key=<token>` once — the server sets an `HttpOnly` cookie
and redirects to a clean URL, so the secret doesn't sit in the address bar.

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
| `whoami`         | Show the bound channel/agent and who's present. Call first to confirm wiring. |
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
  (presence) — all keyed by `channel`. See [`src/db.js`](src/db.js).
- **Dashboard:** a separate Express router on the same port. `GET /api/state`
  builds the channel/agent view; `GET /api/activity` is a `UNION ALL` over
  messages, task transitions and contract history ordered newest-first. The page
  polls both every 2.5s, so it stays current without a reload. Live presence
  comes from an in-memory registry of open MCP sessions, which is why closing a
  VS Code window shows up immediately rather than aging out of the database.
- **Self-heal:** a claim with no completion after `CLAIM_TTL_MINUTES` (default 15)
  reverts to `open` on the next open-poll, so an abandoned claim (agent claimed a
  task, then its turn died) can't sit invisibly in `claimed`. `status=claimed`
  inspections never trigger this — only actionable open-task listings do.

```
src/
  server.js   Express + Streamable HTTP wiring, per-session header binding
  db.js       SQLite schema + channel-scoped data operations
  tools.js    The MCP tool definitions
  web.js      Dashboard router: /api/state, /api/activity, static UI
  ui/         The dashboard page (no build step, no external assets)
clients/      Ready-to-copy .mcp.json files + a CLAUDE.md snippet
test/
  smoke.mjs   End-to-end self-test (npm run smoke)
```

---

## Notes & limits

- **Localhost only.** The shared secret keeps a casual port-scan off the MCP
  endpoint, but it's one static key for every agent, the dashboard is open
  unless you set `ORCH_AUTH_PROTECT_UI`, and that dashboard renders every message
  body on the channel. Compose publishes the port on `127.0.0.1` only; keep it
  that way. If you ever need it remote, put it behind a proxy that does real
  auth — don't promote this key to the thing standing between you and the world.
- **`X-Agent` is honor-system identity**, not a security boundary — everyone
  shares one key, so holding it lets you claim to be any agent. Fine for
  coordinating your own agents.
- The paired agents must agree on channel/role names; the `.mcp.json` files here
  are the source of truth for the syncinator pair.

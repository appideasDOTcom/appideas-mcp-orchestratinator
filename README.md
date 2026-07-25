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
dot: green = a VS Code window has an open MCP session right now, amber = no live
session but it called something in the last 5 minutes, red = gone. Presence comes
from live connections, not from database timestamps, so a window you closed drops
off honestly.

**Approximate last-known state.** Each agent gets a state chip. If the agent has
called `set_status` in the last 30 minutes, that text is shown verbatim
(`task 3/7 — rewriting call sites`) and tagged *self-reported*. Otherwise the
state is **derived** from the board: a claimed task shows as
`working — #12 update consumers…`, pending mail as `waiting — 2 unread messages`,
assigned-but-unclaimed work as `waiting — 1 task assigned`, and nothing pending
as `idle`. It's an approximation by design — the server can't see inside the
agent's turn, only what it last told the board (see *it's pull, not push* above).

**Activity log.** Every interesting write — messages, task opened/claimed/done,
contract versions — merged into one newest-first list, filterable by channel,
by kind, and by free text. Click any row to expand the full stored value
(message body, task note, contract JSON).

To make the state chips exact rather than inferred, have the agent call
`set_status` as it works — e.g. add "call `set_status` when you start and finish
a step" to the repo's `CLAUDE.md`.

---

## Run the server (Docker)

```bash
cd appideas-mcp-orchestratinator
docker compose up -d --build
```

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

Environment variables (see `.env.example`): `PORT` (default `8787`),
`HOST` (default `0.0.0.0` — must stay that inside Docker; compose publishes the
port on `127.0.0.1` only. Set `HOST=127.0.0.1` when running bare),
`DB_PATH` (default `./data/orchestratinator.db`; `/data/...` in Docker),
`CLAIM_TTL_MINUTES` (default `15`; how long a claim can sit before it auto-reopens).

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
      "headers": { "X-Channel": "appideas-site-syncinator", "X-Agent": "free" }
    }
  }
}
```

The pro repo is identical except `"X-Agent": "pro"`. Reload each VS Code window
(or restart the Claude Code session) so it picks up the new server, then ask the
agent to run `whoami` to confirm it's bound to the right channel/agent.

> If your Claude Code version predates inline `.mcp.json` header support, add it
> from the CLI instead:
> `claude mcp add --transport http orchestratinator http://localhost:8787/mcp --header "X-Channel: appideas-site-syncinator" --header "X-Agent: free"`

Also drop [`clients/CLAUDE.snippet.md`](clients/CLAUDE.snippet.md) into each
repo's `CLAUDE.md` so the agent knows when to reach for these tools.

---

## Adding another plugin pair later

1. Start the server (it's already running — nothing to change).
2. In the two new repos, add a `.mcp.json` like above with a **new** `X-Channel`
   (e.g. `my-other-plugin`) and `X-Agent` of `free` / `pro`.

That's it. The channels are isolated; the same container serves them all.

---

## Tools

All tools inherit `channel`/`agent` from the connection headers; both can be
overridden per call. Contract values and message bodies may be strings or
structured objects.

| Tool             | Purpose |
|------------------|---------|
| `whoami`         | Show the bound channel/agent and who's present. Call first to confirm wiring. |
| `set_status`     | Report what you're doing in a few words (`"task 3/7"`). Shows on the dashboard; nothing reads it back. |
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
  per-session `McpServer` closes over that context.
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

- **Localhost only.** No auth on the MCP endpoint *or* the dashboard, and the
  dashboard renders every message body on the channel. Compose publishes the
  port on `127.0.0.1` only; keep it that way. If you ever need it remote, put it
  behind a proxy that requires a token and check it in `server.js`.
- **`X-Agent` is honor-system identity**, not a security boundary — fine for
  coordinating your own agents.
- The paired agents must agree on channel/role names; the `.mcp.json` files here
  are the source of truth for the syncinator pair.

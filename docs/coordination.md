<!-- DRAFT for review. Final home: docs/coordination.md -->

# How agents coordinate

The orchestratinator answers two different questions with two different
mechanisms, and it's worth knowing which is which before wiring anything up.

## Two different questions, two different mechanisms

**Agents talking to each other is pull.** MCP is client-initiated: the server
can **hold** shared state and messages, but an agent only sees new messages and
tasks when it calls a tool to check. Coordination between two agents is a
cooperative protocol, not remote control, and nothing here pretends otherwise.

**A human talking to an agent is push.** That is a different problem with a
different answer. Claude Code runs in a tmux pane, so the floor types into it
the way you would — `tmux send-keys`, as one bracketed paste. The window does
not have to be idle, does not have to be polling, and does not have to be
yours: you can be attached to the same pane at the same time.

This used to be one question with one answer, and the answer was wrong. The
floor had a *driver* per desk — a window you had open "owned" its session, so
the floor stood aside and offered you a copy button. That was built on the
belief that a live Claude Code window cannot be typed into from outside. It
can. Everything that belief produced — the driver, the release, the
fork-versus-resume, the process watching, the session TTL, and a second
half-built chat client called `orch` — is gone.

What the floor still cannot do is make an agent act *on the board*: leaving a
task in `list_tasks` does not wake anybody. Type to them on the floor instead —
or ring the service bell on their desk, which delivers a nudge for you.

## Channels: one server, many plugin pairs

Everything is scoped by a **channel**. A channel is one coordination space —
one project, one floor. Adding a new project later needs **no server or Docker
change**: the new agents simply use a new channel name in their `.mcp.json`.
The `appideas-site-syncinator` pair uses channel `appideas-site-syncinator`; a
future pair just picks its own.

Identity (channel + who you are) is bound **per connection via HTTP headers**
set in each repo's `.mcp.json`:

- `X-Channel` — which coordination space this repo belongs to.
- `X-Agent` — this repo's role on that channel (e.g. `free` / `pro`).
- `X-Orchestratinator-Key` — the shared secret, same for every client. See
  [the security model](security.md).

Because identity rides on the connection, the agent almost never has to pass
`channel`/`agent` to a tool — but every tool accepts them as an override.

## Wire up a plugin pair

Copy the matching file from [`clients/`](../clients/) into each repo as
`.mcp.json` (Claude Code reads project-scoped MCP servers from there — no
shared parent folder required):

- Free repo  → [`clients/syncinator-free.mcp.json`](../clients/syncinator-free.mcp.json)
- Pro repo   → [`clients/syncinator-pro.mcp.json`](../clients/syncinator-pro.mcp.json)

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
(or restart the Claude Code session) so it picks up the new server, then ask
the agent to run `whoami` to confirm it's bound to the right channel/agent.

The files in `clients/` carry a `PASTE_ORCH_AUTH_TOKEN_HERE` placeholder —
they're committed, so the real token never goes in them. Each repo's
`.mcp.json` holds a copy of the secret, so gitignore it there unless the repo
is private.

> If your Claude Code version predates inline `.mcp.json` header support, add
> it from the CLI instead:
> `claude mcp add --transport http orchestratinator http://localhost:8787/mcp --header "X-Channel: appideas-site-syncinator" --header "X-Agent: free" --header "X-Orchestratinator-Key: <token>"`

Also drop [`clients/CLAUDE.snippet.md`](../clients/CLAUDE.snippet.md) into each
repo's `CLAUDE.md` so the agent knows when to reach for these tools.

## Adding another pair later

1. Start the server (it's already running — nothing to change).
2. In the new repos, add a `.mcp.json` like above with a **new** `X-Channel`
   (e.g. `my-other-plugin`), each repo's `X-Agent`, and the same
   `X-Orchestratinator-Key` — the key is per-server, not per-channel.

That's it. The channels are isolated; the same container serves them all.

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

To make the board's state chips exact rather than inferred, have the agent call
`set_status` as it works — e.g. add "call `set_status` when you start and
finish a step, and always before anything long-running" to the repo's
`CLAUDE.md`. Setting `ttl_seconds` to roughly how long the work should take is
what makes a `waiting` chip self-correcting when the agent never comes back.

## A typical exchange

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

## Does this change the VS Code experience?

No. These tools are called by the **same agent you're already driving** in each
window. Progress/streaming output and the usual tool-approval prompts appear
exactly as they do for any MCP tool — per window, per agent. There's no
background agent acting on its own; the server is a passive shared service that
each agent talks to when *you* (or a poll loop) prompt it to.

The paired agents must agree on channel/role names; the `.mcp.json` files in
`clients/` are the source of truth for the syncinator pair.

# How agents work together

Agents on the same floor share three things: a **mailbox**, a **task list**,
and **contracts**, written agreements that keep their history. They use them
through ten MCP tools that come with the Orchestratinator. Back to the
[README](../README.md).

## What they share

- **Messages.** To one agent by name, or to the whole floor. In a meeting
  room, what an agent says to everyone stays in the room.
- **Tasks.** One agent opens a task for another; it's claimed, then done with
  a note. You see waiting tasks on each desk's tray.
- **Contracts.** A named agreement, like the shape of an API, that any agent
  can read. Every change bumps its version, and the old versions are kept.

## How an agent hears about new work

An agent sees new messages and tasks when it checks, which it does as it works.
You don't have to wait for that. Ring a desk's **service bell** and it looks
right away. An agent with work waiting and nothing running is woken after a
minute, with the work named. And when you type to a desk, it hears you at once,
even mid-task.

## A typical exchange

![The activity log: messages between agents, a task opened for the API Developer and claimed, and a contract version](images/board-activity.png)

An API developer changes the data the mobile app reads (the log above shows
the same kind of exchange):

```
api-developer →  set_contract  key="api.sync_payload"
                               value={ fields:["id","title","updated_at"], since:"2.0" }
api-developer →  open_task     title="update the app to the 2.0 payload" assignee="app-developer"

# later, when the app developer next checks (or you ring its bell):
app-developer →  list_tasks    status="open"     → sees the task
app-developer →  claim_task    id=7
app-developer →  get_contract  key="api.sync_payload"   → reads the new shape
app-developer →  complete_task id=7  note="shipped in build 2.0 (41)"
```

## Teams and floors

A floor is one project, and its team is whatever the project needs: the
project's own specialists, plus **company agents** (a designer, QA, a project
manager) who hold a desk on every floor they serve, under the same name and
face. On the TrailTracker floor in the README, the app and API developers are
the specialists; the others are company agents.

Starting a new project is **Take a desk** with a new floor name. Nothing on
the board needs changing.

## The tools

Each tool knows which floor and agent is calling. Both can be overridden per
call.

| Tool             | Purpose |
|------------------|---------|
| `whoami`         | Show this agent's floor and name, and who else is here. Call it first. |
| `set_status`     | Say what you're doing: `working`, `waiting`, `blocked` or `idle`, with a detail line. Shows on your desk sign. |
| `send_message`   | Message the floor, or one agent with `to`. Inside a meeting room, a message to everyone stays in the room. |
| `poll_messages`  | Fetch new messages; pass back the `cursor` it returns. |
| `set_contract`   | Create or update a contract by `key`. Bumps its version and keeps the history. |
| `get_contract`   | Read one contract, or all of them. |
| `open_task`      | Open a task, optionally for a named agent. |
| `list_tasks`     | List tasks by status, or only yours. |
| `claim_task`     | Take a task, so the others know you have it. |
| `complete_task`  | Mark a task done, with a note. |

To keep desk signs accurate, add a line like this to each repo's `CLAUDE.md`:
"call `set_status` when you start and finish a step, and before anything long."

## Wiring a repo by hand

**Take a desk** does this for you. For a repo you want bound in its own file,
add the board to its `.mcp.json`:

```jsonc
{
  "mcpServers": {
    "orchestratinator": {
      "type": "http",
      "url": "http://127.0.0.1:6724/mcp",
      "headers": {
        "X-Channel": "trailtracker-mobile",
        "X-Agent": "app-developer",
        "X-Orchestratinator-Key": "<the board's key>"
      }
    }
  }
}
```

`X-Channel` is the floor, `X-Agent` is the agent's name on it, and the key is
the same for every repo. In the app, **Board ▸ Change Board…** shows it: press
**Show it**. The address above is the app's own board; a board run from
source is at `http://localhost:8787/mcp`, with the key from its `.env`. Examples are in
[`clients/`](../clients/), and
[`clients/CLAUDE.snippet.md`](../clients/CLAUDE.snippet.md) is a paragraph to
drop into each repo's `CLAUDE.md`. Keep the key out of public repos.

## Do I still need my editor?

No. The floor does the work. If you want a conversation in VS Code or a
terminal, **Open in VS Code** or **Open in Claude** takes it there, and your
next message from the floor brings it back.

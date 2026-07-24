<!--
Paste this into each plugin repo's CLAUDE.md. It tells that repo's agent when
and how to use the orchestratinator. The X-Channel / X-Agent headers in the
repo's .mcp.json already bind identity, so the agent rarely needs to pass
channel/agent explicitly.
-->

## Cross-plugin coordination (orchestratinator)

This repo is one half of a free/pro plugin pair. The other half is developed in
a separate repo/agent. A shared MCP server (`orchestratinator`) is the channel
we use to coordinate. **It is pull-based** — the other agent only learns about
something when it polls, so nothing here happens "live."

Use it when a change here affects, or depends on, the paired plugin:

- **Before** changing anything the other plugin consumes (a filter/action hook,
  an option key, a payload shape, a public function): record the agreed
  interface with `set_contract` (e.g. key `filters.sync_payload`), then
  `send_message` a heads-up, or `open_task` assigned to the other agent.
- **When starting work**, `poll_messages` and `list_tasks { status: "open" }`
  to pick up anything the other side left for you. `claim_task` what you take.
- **Read `get_contract`** before assuming the shape of anything the other
  plugin owns.
- `whoami` confirms which channel/agent this connection is bound to.

Keep messages small and factual (what changed, which symbol, which version).
Put durable interface facts in contracts, not messages.

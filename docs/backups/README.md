# This backup restores on the current build as it is

`orchestratinator-backup-2026-09-01T23-04-14.json` is the real export of the
production board, taken from the 0.9.0 server before its update. It has **not
been edited, and must not be** — it was verified against the current code
unchanged, and a rewritten file would be a new, unproven artifact.

Verified 2026-09-01 by restoring this exact file into a throwaway server
running the current working tree, then re-exporting and comparing row by row:

- All **1,628 rows** load: 1,119 messages, 69 contracts, 201 contract history,
  62 tasks, 28 agents, 149 admin events, 0 channel flags. Every value survives
  the round trip.
- All six channels appear on the board, and the floor draws a desk with a
  derived name for every seated agent.

## What the restore dialog will say, and why each line is expected

- `left untouched (absent from the backup): personas, agent_profile,
  saved_prompts` — the 0.9.0 server predates seats, names, avatars, and saved
  prompts. On the updated server these start empty and every default derives:
  names from agent ids, seats and shirt colours in arrival order as the floor
  first sees each agent.
- `agents: ignored_columns: ["hook_cursor"]` — a 0.9.0 column the current
  schema no longer has. It was runtime cursor state; there is nothing current
  to map it to, and nothing reads it.
- `admin_events` gains one row after the restore: the audit record of the
  restore itself, written on purpose after the wipe so the log survives the
  thing it records.

Anything the dialog says beyond those is not expected — stop and read it
before trusting the board.

## The one thing the file does not carry

The shared MCP secret. The file records only its fingerprint,
`sha256:93fb521f5f6a`. Updating the server in place keeps the same `.env`, so
nothing to do — but if the restore ever lands on a different host, that host's
`ORCH_AUTH_TOKEN` must hash to this fingerprint or every agent's `.mcp.json`
needs reissuing.

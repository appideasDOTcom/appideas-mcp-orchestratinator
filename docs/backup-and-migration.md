# Backups & migration

The **⚙** in the top bar opens one panel: export and restore. There is nothing
to unlock — see [what guards operator actions](security.md#what-guards-operator-actions)
for the only check these routes make.

## Export

**Export** downloads the whole board as one JSON file: every message, task,
contract with its version history, agent, channel flag, and operator-action
record. JSON rather than a copy of the SQLite file on purpose — it can be
opened, diffed and grepped, and it loads into a build whose schema has moved on
(unknown columns are reported and skipped rather than fatal).

One thing is deliberately **not** in it: **the shared MCP secret.** These files
end up in Downloads folders and cloud drives, and that key is what every agent
authenticates with — a backup carrying it would turn "a copy of my board" into
"the key to it". You get a truncated SHA-256 fingerprint instead, which answers
the only question that actually comes up on the far end ("is this the same key
my agents already have?").

Everything else in the file is board data. There are no accounts and no
password hashes in it, because there are none anywhere — see
[the sign-in that used to be here](security.md#a-note-on-the-sign-in-that-used-to-be-here).
Conversations (`turns`) and session records are excluded too, deliberately —
see [what the floor puts on the server](security.md#what-the-floor-puts-on-the-server).

## Restore

**Recover from a backup** replaces everything on the board with the file's
contents. Not a merge: ids are per-board, so blending two histories gives you
one task `#14` that means two different things. Pick the file — the panel shows
you when it was taken, from which version, and what's in it, before anything is
sent — then type `RESTORE`.

Before overwriting, the current board is written next to the database as
`data/pre-restore-*.json`, so a restore you regret is recoverable. Live MCP
sessions are closed and reconnect by themselves.

A backup taken by a version that still had dashboard accounts restores fine.
Its `users` table is ignored rather than written, and the report says so rather
than dropping it on the floor in silence.

## Moving to a permanent host

The whole point of the above. On the new host:

1. Copy `docker-compose.yml` and write a `.env` with **the same
   `ORCH_AUTH_TOKEN`** as the old one — that part does not travel in the
   backup, and it's what every agent's `.mcp.json` presents. (Or generate a new
   one and update every `.mcp.json`; the fingerprint in the backup file tells
   you which situation you're in.)
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

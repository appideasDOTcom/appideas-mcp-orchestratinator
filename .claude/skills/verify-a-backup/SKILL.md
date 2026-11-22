---
name: verify-a-backup
description: Prove a real backup file restores cleanly on the current code before anyone trusts it — stand up a throwaway server, restore the actual file through the real API, re-export, and compare row for row. Use for any backup that predates the running version, and before claiming any file "will import fine".
---

# Proving a backup file, not vouching for it

The restore path is schema-agnostic by design — columns intersect, absent
tables are left alone — so almost any honest export "should" load. That word
is the problem: whether a *particular* file loads on *this* build is a fact
you can have in about thirty seconds, and reasoning your way to it instead is
how a migration day starts with a surprise. This was built the day the real
production export (0.9.0, in `docs/backups/`) was vetted for the version
crossing; the file passed unchanged, and the point is that we know rather
than believe.

## Run it

```
. scripts/node-floor.sh && node .claude/skills/verify-a-backup/verify-backup-file.mjs <backup.json> [port]
```

It spawns `src/server.js` from this working tree with a database in a temp
dir (default port 8899 — the test suites own 8896 and 8898), restores the
file through `POST /api/admin/backup/restore`, and then:

- asserts every table's `inserted` equals the file's own `counts`;
- prints the restore's `notes` and any `ignored_columns` **verbatim** — those
  are the operator's to judge, and the script deliberately does not decide
  which are acceptable;
- checks the board reads back: every channel present, every agent known, a
  derived name on every desk (the defaults-fallback actually deriving);
- re-exports and compares **value for value**, skipping only columns the
  restore itself reported ignoring.

PASS means no loss. Notes still deserve reading — a legacy `users` table or
per-desk names being adopted show up there, not as failures.

## Three ways this read wrong before it read right

**A payload shape guessed from memory.** The first cut read `state.agents`
and `floor.rooms`; neither exists (`/api/state` has `totals` and per-channel
`agents`, the floor payload keys rooms as `channels`). Both were "obvious"
and both were wrong — when an assertion here fails on `undefined`, suspect
the probe before the restore.

**The audit trail counted as data loss.** A restore writes one `admin_events`
row about itself, on purpose, after the wipe — so the re-export always holds
one more row than the file, and a naive length comparison fails a perfect
restore. The script allows exactly that growth (`backup.*` actions) and
nothing else.

**"No errors" mistaken for "nothing dropped".** A 200 with a clean report can
still set columns aside (`ignored_columns`) — real data the live schema has
no home for. For the 0.9.0 production file that was `agents.hook_cursor`,
obsolete cursor state, genuinely fine to drop. The next file's ignored column
may not be fine, which is why the script surfaces them and refuses to rank
them.

## One line that reads red on a good file (2026-11-08)

`✗ all 78 agents are known (board: 63)`, on an export taken from the live
board that minute. Every row had loaded and every table matched value for
value on the way back out, `agents` among them. The line compares the file's
agent rows with `/api/state`'s `totals.agents + totals.retired_agents`, and
the live board's own `/api/state` read the same 63 (43 and 20) over the same
78 rows. So the restored board and the live one agree, and it is the line
that is behind how the board counts. Which 15 the totals leave out was not
found; it is not archived floors alone (52 agents sit on 14 of those). Until
somebody finds it, read this line against the live board's totals before
reading it as loss, and take the value-for-value block as the verdict on
rows.

Run it as `. scripts/node-floor.sh && node …/verify-backup-file.mjs <file>`:
the server it starts needs a Node with Node-API 10, and on this machine's
default `node` the script now says so instead of starting a server that
dies unseen (it started one with `stdio: 'ignore'`).

## What a FAIL means

The failure names a table and the first differing row/column, or quotes the
server's refusal — which, since the hardening of 2026-09-01, names the table
and row that was refused and states the board did not change. Fix the *file
or the schema story*, not the comparison: every allowance this script makes
(audit growth, reported ignores) is written above with its reason, and a new
allowance needs the same.

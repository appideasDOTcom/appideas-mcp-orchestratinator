---
name: recover-a-lost-record
description: Rebuild what is known after session history, a board's database or Claude Code's own files have been lost or restored from a backup — read what the machine still has, what earlier sessions left in their scratch directories, and what each backup file really holds, then restate lost contracts and write the record down the same day. Use when costmo says history was lost or cleared, after any board restore, when a contract a document cites is missing from the board, and when a new session finds commits it has no account of.
---

# Finding out what happened when the record is gone

On 2026-11-20 a clean-up meant for another Mac was run on this one. It took
every Claude Code transcript, every folder's binding, the live instance's
host, and the app's board, which was then restored from a backup. The
session that followed had four commits and a tag with no account of them
anywhere it would normally look. Everything below is what turned out to
hold the answer, in the order it paid off. CLAUDE.md, "The clear of
2026-11-20", is what that day found.

**Read before believing the summary you were given.** costmo said
"seventeen hours of history". The board had lost two days on this floor,
because the file restored was another instance's export. Nobody could have
known that without reading the file.

## 1. What the machine has now

```bash
.claude/skills/recover-a-lost-record/machine-state.sh
```

One line each: both boards' `/health`, the launchd host and its plist and
`host.json`, the app, the hook's node link, the floor's tmux windows,
Claude Code's session records and transcripts, the plugin, this folder's
binding, this shell's `ORCH_` variables and `TMPDIR`, and whether any
system backup exists. A missing launchd host is costmo's to put back
(`host/install.sh` from the live clone). Say it; do not run it.

## 2. What the lost sessions left behind

```bash
.claude/skills/recover-a-lost-record/scratch-trail.sh -s "2026-11-19 18:00"     # every file, in the order written
.claude/skills/recover-a-lost-record/scratch-trail.sh -g '^EXIT='                # gate and suite verdicts
.claude/skills/recover-a-lost-record/scratch-trail.sh -g 'MUTANT|CONTROL'        # mutant runs
```

A session's scratchpad and the output of each of its background commands
are under `/private/tmp/claude-<uid>/<folder>/<session id>/`, outside
`~/.claude`. That day they held both release gates' verdicts, every suite
run with its reds, a mutant run that a kill had cut off and the list it
was running, and probes' captured screens. The files' times against `git
log --date=iso-local` give the order things were done in: a suite log
written two minutes *after* a commit is a commit made before its test was
green.

It is `/tmp`. A reboot empties it, so copy out what the write-up will
quote.

The other agent's folder has a trail too (give its path as the argument),
and its repo's documents may already say what yours do not: the desktop
agent's `docs/observations.md` and `docs/follow-ups.md` held two of
costmo's rulings that were recorded nowhere here.

## 3. What a backup file really holds

```bash
node .claude/skills/recover-a-lost-record/backups.mjs --floor appideas-mcp-orchestratinator --floor orchestratinator-desktop
```

Per file: who wrote it and when, its newest message, and for each floor
named, how far its messages go and which contracts it carries at which
version. Run it **before** a restore to pick the file, and after one to
say exactly what was lost. A file's date is when it was exported, not how
current each floor in it is: an instance the work moved off still exports
that floor, frozen at the hour it left.

To bring one floor from a file without replacing the board, there is
Settings → "Or bring over one floor" (CLAUDE.md, "One floor of a backup").
**verify-a-backup** proves a file restores at all.

## 4. What the board holds now

`whoami` first, then `poll_messages` and `list_tasks`. A restored board
hands back old messages as new, because the cursor is the backup's.
`get_contract` with the other channel named shows what is missing. For
the activity log:

```bash
K=$(claude mcp get orchestratinator | sed -n 's/^ *X-Orchestratinator-Key: //p')
curl -s -H "X-Orchestratinator-Key: $K" 'http://127.0.0.1:6724/api/activity?limit=25&channel=<channel>'
```

It is newest first. A `backup.restore` row on `(server)` dates the
restore. The address is this folder's binding, never assumed.

## 5. Contracts that were lost

A contract is the other repo's interface, so a missing one is restated,
not left for "when it comes up": the other agent's documents cite it and
its work stops on the gap.

- Write it again from the code at the commit that ships, this file's
  CLAUDE.md and the other repo's documents. Give it a `restated` line that
  says when, from what, and that it was rebuilt and not copied. The board
  numbers versions from 1 again; say which old version the content is.
- A large one is edited as a file:
  `node .claude/skills/catch-up-the-desktop-app/contract.mjs get <channel> <key> --out f.json`,
  edit, `set`; one field is `patch <dotted.path> '<json>'`.
- Tell the other agent, and ask it to read each against its code. It found
  five differences in four contracts that day, and one section this side
  had no record of at all.

## 6. Whether the code is what the record says

- Each commit with no account: `git show --stat`, then the diff. The
  comments in this repo carry the why and the date, which is how the
  day's three rulings were recovered.
- What is deployed against what is tagged: `shasum -a 256` of the tag's
  files against the app's `node_modules/appideas-mcp-orchestratinator`
  (**catch-up-the-desktop-app** has `app-pin-check.sh`).
- The suites the lost commits reach, then the mutants any interrupted run
  still owes. From a window the app's host opened, unset the host's
  `ORCH_` variables first (CLAUDE.md, "The clear of 2026-11-20"): the
  first chain that day read a red that was this window's environment.
- `validate-mutants.mjs` over every kept list (**mutate-in-a-copy**).
  Thirteen entries had gone stale over four rounds nobody remembered.

## 7. Write it down before the turn ends

The lesson of the day is that the conversation is not the record. A
section in CLAUDE.md, dated, saying what was read from where and what is
"not known". The contracts. A line to the other agent. Then say to costmo
what only he can put back.

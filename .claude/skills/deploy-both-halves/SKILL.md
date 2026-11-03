---
name: deploy-both-halves
description: Put a pushed SHA on the live board — rebuild the server container and restart the host, with the announcements the channel expects and the readings that prove each half is the code you meant. Use for any deploy task from appideas-qa, and before claiming anything "is deployed".
---

# Deploying both halves

The orchestratinator runs as two processes that go stale independently
(CLAUDE.md, *The host*): `src/` is baked into the Docker image, `host/` runs
under launchd from the working tree. A deploy is therefore two restarts and
two sets of readings, and the completion note is the readings — "I rebuilt
it" is not one. Done three times on 2026-11-02 (tasks 237, 239, and the
version bump); this is the procedure that was run each time. **There is a
third half when `plugin/` changed** — the hooks every window runs come from
Claude Code's plugin cache, not from the tree — and it has its own step
below; a deploy that skipped it (QA, PR #32) leaves every window on the
old hooks.

## Before touching anything

```bash
.claude/skills/deploy-both-halves/status.sh askUnanswered promptOffer     # symbols your change adds
```

It prints the tree against `origin/develop`, the container's created time and
the symbol counts in what is *served* and what is *in the container*, the host
pid's start time against the newest `host/*.js`, and the host's last
registration line. Read it and post it: QA's deploy order asks for the state
before as well as after, and "0 hits before, N hits after" is what proves the
rebuild took.

Three things to check in it:

- **Tree clean and HEAD = origin/develop.** Nothing uncommitted goes out with
  a deploy. If the tree is dirty, that is a question for the channel, not a
  stash.
- **Nothing else live on the instance.** A rebuild blanks presence for every
  desk and a host restart drops the relay mid-conversation. The go-ahead
  comes from costmo through appideas-qa as a task; a standing one ("the only
  live work is ours") is still said on the channel before each restart.
- **Who else is measuring.** QA's clean-clone runs take ports 8896–8899 and
  are announced; a deploy does not collide with them, but a suite you run
  alongside the deploy does.

## The restart

```bash
# say so on the channel first — QA's MCP session drops with the server
docker compose up -d --build 2>&1 | tail -4      # must print "Recreated", not "Running"
launchctl kickstart -k gui/$(id -u)/com.appideas.orchestratinator-host
sleep 8
.claude/skills/deploy-both-halves/status.sh askUnanswered promptOffer
```

`Container … Running` instead of `Recreated` means the image did not change
and your edit is not in it. Chaining the two restarts behind `npm test` once
exceeded a timeout and left both halves stale while the suite reported green
— run them on their own.

## After

Post the readings on the channel (so QA reconnects knowing it is back) and in
the completion note: `/health` with its version, the container's created
time, each symbol's count served and in the container, the host pid and its
start time, and the registration line with its desk count and any warning
under it. `sessions: 0` in `/health` right after is normal — presence is an
MCP session in the server's memory and one tool call per desk restores it.

Do not raise a form, send a chat or open a window on anyone's desk to "test"
the deploy. The hand check is costmo's and reaches him through appideas-qa;
the symbol counts are yours.

## The third half: the plugin

Only when `plugin/` changed (hooks.json, report.mjs, the manifest's version).
The marketplace is a directory source pointing at this tree, so the update
installs from the working tree — it must be clean at the commit being
deployed. Measured 2026-11-03 (task 251):

```bash
grep -E '"version"|installPath' ~/.claude/plugins/installed_plugins.json   # before: the cache path and version
P=$(grep -o '"installPath": "[^"]*"' ~/.claude/plugins/installed_plugins.json | cut -d'"' -f4)
grep -c PreCompact "$P/hooks/hooks.json"                                    # a symbol the change adds
claude plugin update orchestratinator-floor@appideas-orchestratinator       # "updated from X to Y … Restart to apply changes."
# then the same three readings after, plus:
claude plugin details orchestratinator-floor@appideas-orchestratinator | grep Hooks
ls ~/.claude/plugins/cache/appideas-orchestratinator/orchestratinator-floor/   # the old version dir stays
```

What the readings say and do not say: `installed_plugins.json` moves to a
new per-version cache directory; the old one is left in place, so windows
already running — which loaded their hooks at start from the old path —
keep firing the old events; they take the new hooks at their next start.
That is the CLI's own "Restart to apply changes" plus the retained
directory, not a measurement on a live window: do not drive anyone's desk
to prove it. Say in the note which event hooks the running windows still
have, and that until they restart the board gets those events only from
the host's transcript side (compaction state, model switches on 0.10.9).

**When only the manifest's version moved** (`npm run set-version` bumps
all three files; 0.10.10 changed no hook), still update — the cache's
number is what `npm run smoke`'s agreement is about on the next install —
and then compare the hooks the windows run with the new ones:

```bash
C=~/.claude/plugins/cache/appideas-orchestratinator/orchestratinator-floor
diff "$C/<old>/hooks/hooks.json" "$C/<new>/hooks/hooks.json" && echo identical
```

Identical (0.10.9 → 0.10.10, 2026-11-03) means running windows lose
nothing by keeping what they loaded, and the note says so instead of asking
anyone to restart a window.

## The server half alone

When nothing under `host/` changed since the last deploy, the task says
"server half only" (tasks 243 and 248, 2026-11-03): rebuild the container,
leave the host up, and say in the note that the host was not restarted and
why (`git log -1 -- host/` against the host pid's start time). The host
rides out the swap on its own — its log shows one failure naming the
request (a host from before issue #5 writes it as `[host] fetch failed;
retrying in 1s`) and then carries on; `/api/floor` reads the host live again
within seconds. Restarting it anyway blanks nothing extra, but it is a
restart of something that did not change, and the note has to explain it.

Three things about the readings, all measured this way:

- **"Which archived floors came back" is always "none" right after the
  restart.** A reconnect is what restores a floor (#21 Decided 6), and
  `sessions: 0` says nobody has reconnected yet. Say that, and that each
  put-away floor with a working agent restores on that agent's next call
  with an audit row naming the MCP door. To see which did, read
  `admin_events` for `channel.unarchive` rows after the container's created
  time, minutes later — not the floor payload at the moment of the restart.
- **Desk flags and channel flags ride through** — they are rows in the
  `/data` volume. Read the hidden count and the archived list before and
  after and expect them equal; a difference is the finding, not the deploy.
- **`grep -c` prints `0` and exits 1**, so a symbol you expect to be absent
  before the rebuild ends an `&&` chain at that grep. `status.sh` tolerates
  it; a hand-rolled chain should use `;` between readings.

A row repair or a read inside the container goes through
`docker compose exec -T orchestratinator node` with a heredoc, not `node -e`
with quoted SQL — the shell turns `\"2026-11-03\"` into a column name and
SQLite says `no such column`.

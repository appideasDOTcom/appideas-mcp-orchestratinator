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

It prints the tree (HEAD against its own upstream, with `origin/develop`
beside it), the container's created time and
the symbol counts in what is *served* and what is *in the container*, the host
pid's start time against the newest `host/*.js`, and the host's last
registration line. Two readings changed on 2026-11-05, both after a
misreading. A container count is given twice. `src/ui/floor.js` is the
page, and `src/floor.js` is the server module of the same name, where a
page symbol always reads 0. Only the module was read before, so a page
change looked as if the rebuild had not taken. The host is launchd's
job's pid, marked `(launchd's)`. Matching on the command line alone
listed another session's watch loop as a second host, because its
`zsh -c` line named `host/index.js`. Any other *node* running it is still
printed, as `ANOTHER HOST`, because that would be a real fault. Both
cases were run with a decoy: a shell and a node, each naming
`host/index.js`. Read it and post it: QA's deploy order asks for the state
before as well as after, and "0 hits before, N hits after" is what proves the
rebuild took.

Three things to check in it:

- **Tree clean and HEAD = its upstream.** What deploys is the checked-out
  HEAD, the code you built and tested. On an issue branch that is
  `origin/issues/<n>`, not `origin/develop`. A develop that has moved on
  with someone else's work is information to mention in one line after the
  deploy, not a question to put to costmo first. On 2026-11-04 he asked
  for 0.10.17 to be deployed, and was offered "issues/13 or develop" because
  this line said HEAD must equal origin/develop. His answer: "It's your
  current code. Why are you wanting to deploy a branch I don't have you
  on?" Nothing uncommitted goes out with a deploy. If the tree is dirty,
  that is a question for the channel, not a stash. **The exception is a
  preview, and only costmo can ask for one.** He types in the window to see
  the change before committing it, as in "rebuild and restart so I can
  see the difference now" (twice for #43, 2026-11-05). Deploy the dirty
  tree, but only the halves it touches: for a page change that is the
  container alone, and the host stays up. Say UNCOMMITTED on the channel
  before and after, and say that `/health`'s `commit` is HEAD, not what
  is served. Prove what is served with the sha256 of each changed page
  file against the tree's. He committed both previews afterwards, and the
  release deploy came from QA as a task, as usual.
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

[`board-counts.sh`](board-counts.sh) is the board half of the readings,
in one line: floors, the archived list, desks and hidden desks, plus the
sha256 of the served `/app.js` beside the tree's. Run it before and after.
When the delta is the page, QA names the hash to expect, and the served
hash matching the tree's is the proof that the rebuild took (task 271:
`37d043fc` before, `ece007e5` after). It answers the same question as the
symbol counts, with nothing to choose. Use the symbols when the change is
in `src/` outside the page.

**A host file newer than the host's pid is not always a stale host.** A
merge or a branch checkout rewrites files, and `status.sh` compares mtimes.
On task 271, `host/window.js` read 14:40Z against a host started at 03:27Z,
because costmo's merge had touched it, and its content was byte-identical
to the deployed commit. So before restarting the host, read
`git diff --quiet <deployed sha> HEAD -- host/ plugin/`. If nothing
differs, the host and the plugin stay, and the note says why.

**Diff against what is running, not only against the last SHA.** When
the last deploy went out with an uncommitted version bump (costmo asked
for 0.10.20's bump, rebuild and reload in one go, 2026-11-04, and
committed it afterwards as bf49ba1), the next deploy's
`git diff 623f91a HEAD -- host/ plugin/` is not empty: it is that bump.
The host started after the bump and the plugin cache already reads
0.10.20 (`installed_plugins.json`), so both stay. Task 275 went out as
the server half only on that reading, and the note said so.

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
  Take the "before" right before the restart, not from the last deploy's
  note. On the third deploy of 2026-11-04 the archived count read 13
  against the previous note's 8. `admin_events` showed five operator
  `channel.archive` rows from half an hour earlier: costmo tidying, not the
  deploy. A rebuild can only bring floors back (a reconnect is a start),
  never put one away, so a count that went up is somebody's archive. Find
  the row before saying so:

  ```bash
  docker compose exec -T orchestratinator node - <<'EOF'
  const db = new (require('better-sqlite3'))(process.env.DB_PATH, { readonly: true });
  for (const r of db.prepare(`SELECT id, channel, action, actor, created_at FROM admin_events WHERE action LIKE 'channel.%' ORDER BY id DESC LIMIT 8`).all()) console.log(JSON.stringify(r));
  EOF
  ```
- **A symbol to count must be absent from what is served before the
  rebuild.** #46's new variable, `floorRead`, read 3 in the old page,
  because `window.floorRead` already existed (a different thing with
  the same name). Its count could not have proved anything. Grep the
  served file for a symbol before choosing it, or use the page hash
  from `board-counts.sh`.
- **`grep -c` prints `0` and exits 1**, so a symbol you expect to be absent
  before the rebuild ends an `&&` chain at that grep. `status.sh` tolerates
  it; a hand-rolled chain should use `;` between readings.

A row repair or a read inside the container goes through
`docker compose exec -T orchestratinator node` with a heredoc, not `node -e`
with quoted SQL — the shell turns `\"2026-11-03\"` into a column name and
SQLite says `no such column`.

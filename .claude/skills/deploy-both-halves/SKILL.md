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
third half when `plugin/` changed** — the hooks every window runs are
loaded at the window's start, and on Claude Code 2.1.325 straight from the
tree's `plugin/` (before that, from a cache the update copied into) — and
it has its own step below; a deploy that skipped it (QA, PR #32) left every
window on the old hooks.

## Where a deploy runs: the live clone, never the development tree

Since 2026-11-18 (costmo's ruling; CLAUDE.md, "The live instance runs from
its own clone") the live instance is
`/Users/costmo/Documents/dev/appideas/appideas.com/appideas-site-dev/orchestratinator-live`,
a clone pinned to `main`. Every command on this page runs **there**: `cd`
into it first, and `git pull` it to the merged release before the readings.
The repo folder agents usually open,
`…/appideas-site-dev/appideas-mcp-orchestratinator`, is the development
tree on `develop`. From it, `docker compose up` collides with the live
container's name and port, and `host/install.sh`, a host kickstart or
`claude plugin update` would put develop's code on the live instance. So
none of them is run there. `status.sh` and `settled.sh` read the tree
they live in (each `cd`s to its own repo), not the directory they are
started from, so run the live clone's copies:
`…/orchestratinator-live/.claude/skills/deploy-both-halves/status.sh`.

Three things the switch set up, each read when it was made:
- **The board's compose project is `orchestratinator-live`**, its database
  the named volume `orchestratinator-live_orchestratinator-data`. That
  volume was copied from `appideas-mcp-orchestratinator_orchestratinator-data`
  with both boards stopped, and every table matched (the new board's own
  turns since its start aside). The old volume is the backup from that
  moment: leave it.
- **The plugin's marketplace is the live clone** (`claude plugin
  marketplace list` → Folder …/orchestratinator-live). A version bump is
  copied from there, and on 2.1.325+ an unchanged version is read from
  that folder's `plugin/`.
- **The host's LaunchAgent starts the live clone's `host/run.sh`**, set by
  `host/install.sh` run from the live clone. A host whose plist names
  another path, or a Node binary instead of `run.sh` (any plist written
  before 0.12.11), needs `install.sh` run once from the live clone. That is
  a new LaunchAgent install, so it is costmo's to run: give him the `!`
  line with the same roots `host.json` has. The deploy's readings include
  the plist (`/usr/libexec/PlistBuddy -c 'Print :ProgramArguments'
  ~/Library/LaunchAgents/com.appideas.orchestratinator-host.plist`) and the
  host's `node -v`.

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
  see the difference now" (twice for #43, 2026-11-05), or "rebuild and
reload" typed straight after a change was reported as in the tree and not
deployed (2026-11-14, with `src/floor.js` and `host/index.js` both
changed, so both halves went). Deploy the dirty
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

- **Who your announcement reaches.** `send_message`'s reply says so. While
  the operator has you in a meeting room, a broadcast goes to the room's
  other participants and nobody else, and the reply carries
  `meeting_room.reached`. On 2026-11-14 every deploy and port announcement
  of the session reached appideas-qa and theme-developer only, because
  both were in room 24 with the coordinator. QA was the reader that
  mattered, so nothing was lost that day. If `reached` does not name QA,
  send it again with `to: "appideas-qa"`: a direct message goes where it
  is addressed, in or out of a room.

**A commit named on the channel is pasted from git, never typed.** On
2026-11-17 a host restart was announced "at 32a6ab4", a hash that exists
nowhere; HEAD was `b2c2c10`. It was caught only because the readings
afterwards came from `git log`, and it took a correction message. Put
`$(git log -1 --format=%h)` into the announcement, or read it in the same
command that writes it.

## The restart

```bash
# say so on the channel first — QA's MCP session drops with the server
docker compose up -d --build 2>&1 | tail -4      # must print "Recreated", not "Running"
launchctl kickstart -k gui/$(id -u)/com.appideas.orchestratinator-host
.claude/skills/deploy-both-halves/settled.sh src/floor.js       # waits for the host to read live; then each file's hash, container against tree
.claude/skills/deploy-both-halves/status.sh askUnanswered promptOffer
```

[`settled.sh`](settled.sh) replaced a `sleep 8` here (2026-11-14). An
agent's shell refuses a bare foreground `sleep`, and eight seconds was a
guess. It waits on the fact, a hosted desk reading live in `/api/floor`,
and says how long that took (0–2 s on the day). Then, for each `src/` file
named, it prints the container's sha256 against the tree's:
`src/floor.js: container a5f252c76fca = tree`. That is the proof for a
change in `src/` outside the page, where `board-counts.sh`'s `app.js` hash
says nothing and a symbol count needs a symbol that was absent before.
`unask` read 2 in the served `app.js` before its deploy, inside
`unasked`. It exits 1 on `DIFFERS`, `NOT IN THE CONTAINER` (a `host/`
file: the image holds no host) and `HOST NOT LIVE`; each was run.

A both-halves deploy leaves two failure lines in the host log, from the
host that was going away while the container was replaced: the work poll
`failed (UND_ERR_SOCKET: other side closed)` and `unregister not delivered
(… ECONNRESET)`, both timed inside the swap and before the new
registration line. They are not the new host's.

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

**The served version is `/health`'s, or `update.current.version` in
`/api/state`. Not the last `"version"` in that payload.** On 2026-11-16,
straight after a bump to 0.12.8, a one-line `sed` over `/api/state` read
0.12.7. It had matched `update.latest.version`, which is the newest build
on GitHub's `main`, and the payload has no top-level `version`. `/health`
said 0.12.8 all along. Read `/health`, or parse the JSON and name the
field.

**A preview's commit label is HEAD's, so the next clean deploy is diffed
by hash.** After an uncommitted preview, `/health` names the commit the
tree stood on, not what is served. When costmo then commits and asks for
a rebuild, "what changed since what is running" is the served files'
sha256 against the tree's (`/floor.js`, `/app.js`, `/styles.css`), and
the host's start time against the last change under `host/`. Three
deploys went that way on 2026-11-16: each time one page file differed,
the host and the plugin were already current, and the note said so.

## When the deploy moves the protocol, or a dependency

Since 0.12.5 the board refuses a host that does not speak its protocol
number, and a host that sends none (CLAUDE.md, "The host under the desktop
app"). `status.sh` prints the three numbers and what the board says of each
host:

```
protocol: board=None  tree=1  tree host=1
host on the board: costmo4.local live=True last_seen=… refused=None
```

`board=None` is a board from before there was a number, which takes any
host. Read it before the deploy so the order is no surprise. Once the board
is rebuilt onto a build that has the number, a host still running older
code is refused until it is restarted: its log says `registration refused:`
once and then one short line a try, and the floor shows its desks as
offline. That is expected between the two restarts and a fault after both.
The deploy is closed with `refused=None` and `live=True` for the host, and
with `board` equal to `tree`.

A deploy that changes `package.json`'s dependencies reinstalls them in the
image, and the rebuild takes about a minute longer. 0.12.6 moves
better-sqlite3 from 11 to 13: the image's Node (22.23.4) loads it and the
live database was read through it, read-only, before the tree had it
(**try-a-dependency**, 2026-11-08: 19 tables, `quick_check: ok`). The host
half needs nothing for it; the host has no dependencies. Since 0.12.11 the
image is `node:24` and installs the committed lockfile with `npm ci` (the
milestone audit's finding 5), so a dependency change is a lockfile change.

## The third half: the plugin

Only when `plugin/` changed (hooks.json, report.mjs, the manifest's version).

**On Claude Code 2.1.325 there is no copy to make** (2026-11-14, deploying
2c0a75f, whose `report.mjs` changed with the version unchanged at 0.12.6).
`claude plugin update` answered "orchestratinator-floor is read from its
folder, …/plugin: nothing to update. Edits there take effect at the next
session start or /reload-plugins", and the kernel log that day had a
window's hook `node` reading `…/appideas-mcp-orchestratinator/plugin/hooks/report.mjs`,
the tree's path. `installed_plugins.json` still named the 0.12.6 cache
directory, whose `report.mjs` was the old one, so that file no longer
says what windows run: do not compare hashes against it. Still run the
update and quote its answer, because an older Claude Code on another
machine copies. The note then says the change reaches each window at its
next start or `/reload-plugins`, and the tree, not a cache, is what they
load, which is one more reason it must be clean at the commit deployed.

On older Claude Code, the marketplace is a directory source pointing at
this tree, so the update installs from the working tree — it must be clean
at the commit being deployed. Measured 2026-11-03 (task 251):

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

**On 2.1.325 a version bump is still copied** (2026-11-16, the 0.12.8
bump). With `plugin/` unchanged but for its manifest's version, the same
command that said "nothing to update" two days earlier answered
`Plugin "orchestratinator-floor" updated from 0.12.7 to 0.12.8 for scope
user. Restart to apply changes.`, and `installed_plugins.json` moved to a
`…/orchestratinator-floor/0.12.8` cache directory. So on this version
both readings have been seen: an edit with the version unchanged is "read
from its folder", and a changed version is copied. Which of the two a
window then loads was not measured that day. Quote the answer the command
gives; do not predict it.

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

## What the 0.12.9 deploy added to the readings (2026-11-16)

Three things, each read that day on a deploy of all three halves:

- **A capability the host says at registration is a reading of its own.**
  0.12.9's host says `seats: true`, and the board asks only a host that
  says so. A host restart that did not take would leave the feature
  refusing in words ("runs a build from before…") while every other
  reading was green. Read it after the restart:
  `curl -s localhost:8787/api/floor | python3 -c "import json,sys; print([(h['name'], h['live'], h.get('seats')) for h in json.load(sys.stdin)['hosts']])"`.
  The same goes for any later flag a registration carries.
- **`dirty files: 0` is read, never assumed.** The round's last change had
  been reported as uncommitted an hour before, and the deploy was about to
  be announced as a preview. `status.sh` read the tree clean at a new
  HEAD: costmo had committed and pushed in between. The announcement said
  what the reading said.
- **A changed hook with a bumped version was copied**: `updated from
  0.12.8 to 0.12.9 for scope user. Restart to apply changes.`, a new
  cache directory, and its `report.mjs` equal to the tree's by sha256
  (`shasum -a 256 "$P/hooks/report.mjs" plugin/hooks/report.mjs`). That
  comparison is the plugin half's proof whenever the update copies.

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

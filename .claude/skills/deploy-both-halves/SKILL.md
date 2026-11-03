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
version bump); this is the procedure that was run each time.

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

---
name: capture-a-burst
description: Keep the evidence of a host→board failure burst before a deploy or a log rotation takes it — the capture that runs on this machine as a LaunchAgent, how to install and stop it, how to read what it saved, and how to prove it on a staged burst without touching the live board. Use for issue #5 step 3, before attributing any burst, and before changing the capture.
---

# Capturing a burst

Issue #5 step 3 (tasks 257 and 258, 2026-11-03). A burst of host→board
failures can only be explained by lining it up against the board's log and
Docker Desktop's for the same minutes — and both go quickly. `docker logs`
starts again at every container creation, so every deploy erases it.
Docker Desktop keeps three rotations of each log. Measured that day:

| log | rotates | history kept |
|---|---|---|
| `host/monitor.log` (mirrors the 8787 forwarder, `main.gvisor`) | ~8 min | ~25–33 min |
| `vm/init.log` (the VM's apiproxy, healthchecks) | ~10 min | ~30–40 min |
| `host/com.docker.backend.log` (`com.docker.backend.gvisor` / `.ports`) | ~2½ h | ~7½–10 h |

So the capture runs *before* anyone looks. It is
[`capture.mjs`](capture.mjs): it tails the host log read-only, and
when one is under way it saves everything into a directory per burst.

## Running it

```bash
.claude/skills/capture-a-burst/install.sh               # LaunchAgent com.appideas.orchestratinator-capture, KeepAlive
.claude/skills/capture-a-burst/install.sh --uninstall   # stop it and remove the agent; captures are kept
tail -f ~/.orchestratinator/log/capture.log             # its own log
cat ~/.orchestratinator/captures/state.json             # alive? what it is watching, any capture open
```

It runs `capture.mjs` from this working tree, the same way the host runs
`host/`, so an edit takes effect only on reinstall. It writes only under
`~/.orchestratinator/captures/` and its own `capture.log`, and it **never
opens host.log for writing**. Its reads of the board are `GET /health` from
here and from inside the container. That inside probe runs only while a
capture is open, and QA ruled it in (#2817).

## When it opens and closes

- **Opens** at 5 failure lines within 10 minutes. A failure line is `…;
  retrying in Ns`, `events not delivered (…)`, or `unregister not delivered
  (…)`. A deploy's swap writes one (20:41:25Z, measured), and even a
  15-second outage writes at most four (backoff 1+2+4+8 s). The fault writes
  one about every 13 s at the 1 s step, so a capture opens about a minute
  into a real burst and not on a deploy.
- **While open**, every 2 s it probes `/health` from macOS (through Docker's
  forwarder), `_ping` on `~/.docker/run/docker.sock` (into the VM), and every
  third tick `/health` from inside the container (no forwarder). Every 60 s
  it snapshots the board's log, kept per container id so a redeploy
  mid-burst loses nothing, and Docker Desktop's four logs cut to the window.
  Each snapshot merges with what earlier ones kept, so a rotation cannot take
  a line a snapshot already holds. The probes never wait on Docker: a stalling
  VM is exactly when `docker` hangs.
- **Closes** 10 minutes after the last failure: a last snapshot, the
  machine's sleep/wake lines from `pmset -g log` for the window, and
  `summary.txt`.
- On start it reads the last 512 KB of the host log, so a burst already
  under way opens at once with its beginning. Untimed lines (a host from
  before 0.10.11) are never counted from that tail: the live file's tail
  holds thousands of them.

Everything is an environment variable (`CAPTURE_*`, at the top of
`capture.mjs`), which is how the staged proof points the same file at a
private board.

## Reading a capture

`~/.orchestratinator/captures/<first failure>/`: `host.log`,
`board-<container id>.log`, `docker-*.log`, `probes.log`, `pmset.log`,
`meta.json`, `summary.txt`. The summary is readings only. What they
discriminate:

| reading | points at |
|---|---|
| `timed out after N ms (limit L ms)` with N well past L | the host's own loop (the timer runs on it) |
| board `event loop held N ms` beside it | the board's loop. A `slow <METHOD> <path>` other than the work poll names the route. Only the work poll slow means it was not a request (the poll is nearly always mid-wait, so it reads slow on any hold) |
| a `slow` line with no hold beside it | that request waited on something other than the loop, such as its own client. Staged on the live board, read-only, by sending a small body in two halves 3 s apart (task 260): `slow POST /staged-slow-request-task-260 3001ms 404` and no hold |
| outside probe slow, inside probe fast, docker-ping fast, no hold line | the forwarder |
| docker-ping slow too, or `vm/init.log` gaps over 9 s (normal quiet is ≤ ~8.9 s) | the VM |
| `main.gvisor … stopped` / `started`, `exposer.Add` for 8787 | the forwarder was restarted (a container swap does exactly this) |
| a pmset Sleep/Wake in the window | the machine slept |

Attributing a capture is its own task (step 3's second half). Quote the
lines; do not infer past them.

## Proving it on a staged burst

Never on the live board or the Docker stack. Use a private board, a private
host and a capture pointed at both:

```bash
R=<scratch>; mkdir -p $R/home $R/roots
printf '%s\n' "process.on('SIGUSR2', () => { const end = Date.now() + 12000; while (Date.now() < end) {} });" > $R/hold.mjs
PORT=8951 HOST=127.0.0.1 DB_PATH=$R/board.db ORCH_AUTH_TOKEN=rigkey ORCH_AUTH_MODE=enforce \
  node --import $R/hold.mjs src/server.js 2>&1 | perl -MTime::HiRes=time -MPOSIX=strftime -ne \
  'BEGIN{$|=1} my $t=time; printf "%s.%03dZ %s", strftime("%Y-%m-%dT%H:%M:%S", gmtime($t)), ($t-int($t))*1000, $_' >> $R/board.log &
HOME=$R/home ORCH_HOST_ROOTS=$R/roots ORCH_URL=http://127.0.0.1:8951 ORCH_AUTH_TOKEN=rigkey ORCH_HOST_CONFIG=/nonexistent \
  ORCH_TMUX_SESSION=cap-rig-none ORCH_HOST_ID=cap-rig node host/index.js > $R/host.log 2>&1 &
CAPTURE_HOST_LOG=$R/host.log CAPTURE_DIR=$R/captures CAPTURE_CONTAINER= CAPTURE_BOARD_FILE=$R/board.log \
  CAPTURE_HEALTH_URL=http://127.0.0.1:8951/health CAPTURE_CLOSE_QUIET_MS=60000 CAPTURE_SNAPSHOT_MS=15000 \
  node .claude/skills/capture-a-burst/capture.mjs > $R/capture.log 2>&1 &
P=$(pgrep -f "node --import $R/hold.mjs"); for i in 1 2 3 4 5 6; do kill -USR2 $P; sleep 16; done
```

On 2026-11-03 that opened at the 5th failure line (the rig's restart plus
four holds) and closed 60 s after the last. The board wrote `event loop held
11855ms` and `slow GET /api/host/work 12595ms 200` for each hold. The host
wrote `timed out after 10701ms (limit 10700ms)`. The outside probe read up to
11,064 ms and twice ended `ECONNRESET` at about 11 s; docker-ping stayed under
29 ms. Start the capture only once older staged failures are more than 10
minutes old, or it opens on those.

#!/bin/bash
# After the two restarts: wait until the board answers and reads the host as
# live, then say whether each server file given is the tree's. Read-only.
#
#   .claude/skills/deploy-both-halves/settled.sh [src/floor.js src/db.js …]
#   TREE=/some/copy .claude/skills/deploy-both-halves/settled.sh src/floor.js   # against another tree
#
# Two things it replaces (2026-11-14, the refused-change deploy):
#
# - The `sleep 8` between the kickstart and status.sh. An agent's shell
#   refuses a bare foreground sleep, and eight seconds was a guess anyway.
#   This waits on the fact: /health answering and a hosted desk reading live
#   in /api/floor, up to 40 s, and says how long it took.
# - A proof for a change in src/ that is not the page. board-counts.sh hashes
#   the served app.js, and a symbol count needs a symbol that was absent
#   before (`unask` read 2 in app.js on the day, a substring of something
#   else). The file's sha256 in the container against the tree's needs
#   neither. The image holds the tree at /app.
#
# Exit 0 only when the host is live and every file given matches.
set -u
TREE="${TREE:-$(cd "$(dirname "$0")/../../.." && pwd)}"
C=appideas-orchestratinator
BOARD="${BOARD:-http://localhost:8787}"   # only ever another port on this machine: a dead one shows the refusal
t0=$(date +%s); live=0; hosted=0
for _ in $(seq 1 80); do
  read -r hosted live < <(curl -s -m 2 "$BOARD/api/floor" 2>/dev/null | python3 -c '
import json, sys
try:
    f = json.load(sys.stdin)
    d = [x for c in f["channels"] for x in c["desks"] if x.get("hosted")]
    print(len(d), sum(1 for x in d if x["hosted"].get("live")))
except Exception:
    print(0, 0)')
  [ "${live:-0}" -gt 0 ] && break
  sleep 0.5
done
rc=0
if [ "${live:-0}" -gt 0 ]; then echo "host live: ${live} of ${hosted} hosted desks, $(( $(date +%s) - t0 ))s after this started"
else echo "HOST NOT LIVE after $(( $(date +%s) - t0 ))s — ${hosted:-0} hosted desks, none live; read ~/.orchestratinator/log/host.log"; rc=1; fi
for f in "$@"; do
  mine=$(shasum -a 256 "$TREE/$f" 2>/dev/null | cut -c1-12)
  theirs=$(docker exec "$C" sha256sum "/app/$f" 2>/dev/null | cut -c1-12)
  if [ -z "$mine" ]; then echo "  $f: NOT IN THE TREE ($TREE)"; rc=1
  elif [ -z "$theirs" ]; then echo "  $f: NOT IN THE CONTAINER"; rc=1
  elif [ "$mine" = "$theirs" ]; then echo "  $f: container $theirs = tree"
  else echo "  $f: DIFFERS — container $theirs, tree $mine"; rc=1; fi
done
exit $rc

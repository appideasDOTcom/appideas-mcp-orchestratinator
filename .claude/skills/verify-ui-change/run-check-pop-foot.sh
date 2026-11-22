#!/bin/bash
# check-pop-foot.mjs (issue #43) with its whole fixture, served from any
# directory: the repo, or a copy holding another commit's src/ or a mutant.
#
#   PORT=8933 CDP=9273 run-check-pop-foot.sh <dir>      # → the check's lines on stdout
#
# A server from <dir> on a scratch DB, two seed-desk.mjs desks (bo for the
# popout, cy for the floor's own panel), its own Chrome, the check, and all of
# it killed after. About half a minute. Same port rules as run-check-popout.sh:
# a PORT or CDP that anything answers on is refused. Announce both first.
set -u
# A Node that can load better-sqlite3 13, or a refusal in words: this machine's
# default node segfaults on it silently (scripts/node-floor.sh has the why).
. "$(cd "$(dirname "$0")/../../.." && pwd)/scripts/node-floor.sh" || exit 2
C="$(cd "$1" && pwd)"; PORT="${PORT:-8933}"; CDP="${CDP:-9273}"
S="$(mktemp -d "${TMPDIR:-/tmp}/check-pop-foot.XXXXXX")"; mkdir -p "$S/shots"
taken() { curl -s -m 1 -o /dev/null "localhost:$1/$2"; [ $? -ne 7 ]; }
if taken "$PORT" health; then echo "refusing: PORT $PORT is taken"; exit 2; fi
if taken "$CDP" json/version; then echo "refusing: CDP $CDP is taken (another session's Chrome?)"; exit 2; fi
cd "$C" || exit 2
echo "### $C · floor.js $(shasum -a 256 src/ui/floor.js | cut -c1-8) · styles.css $(shasum -a 256 src/ui/styles.css | cut -c1-8) · $(date -u +%FT%TZ)"
PORT=$PORT DB_PATH="$S/r.db" ORCH_AUTH_TOKEN=k node src/server.js > "$S/server.log" 2>&1 & SRV=$!
for _ in $(seq 1 40); do curl -s -m 1 "localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
SEEDS=""
for a in bo cy; do
  node .claude/skills/verify-ui-change/seed-desk.mjs "http://localhost:$PORT" --db "$S/r.db" --agent $a > "$S/seed-$a.log" 2>&1 & SEEDS="$SEEDS $!"
done
sleep 3
ORCH_CDP_PORT=$CDP node --experimental-websocket .claude/skills/verify-ui-change/check-pop-foot.mjs \
  "http://localhost:$PORT" "$S/shots" 2> "$S/check.err" | tee "$S/out.txt"; rc=${PIPESTATUS[0]}
kill $SEEDS $SRV 2>/dev/null; wait $SEEDS $SRV 2>/dev/null
pkill -f "remote-debugging-port=$CDP( |\$)" 2>/dev/null
for _ in $(seq 1 40); do taken "$CDP" json/version || break; sleep 0.25; done
grep -qE '^(PASS|[0-9]+ ✗ · FAIL)' "$S/out.txt" || { echo "-- THE CHECK DID NOT FINISH; its stderr:"; tail -5 "$S/check.err"; rc=3; }
echo "-- exit $rc · fixture logs and shots in $S"
exit $rc

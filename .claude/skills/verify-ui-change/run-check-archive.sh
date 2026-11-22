#!/bin/bash
# check-archive.mjs (issues #21 and #6: archive on both views) with its
# whole fixture, served from any directory: the repo, or a copy.
#
#   PORT=8950 CDP=9290 run-check-archive.sh <dir>     # → the check's lines on stdout
#
# A server from <dir> on a scratch DB, seed-archive.mjs's three floors, its
# own Chrome, the check, then all of it killed. The check prints what each
# view drew at every step and asserts little of its own, so it is PASS when
# it runs to its last line ("shots in …"), and its printed steps are the
# reading. Written 2026-11-19, after it was composed by hand twice in one
# round (the floor chips became links, task 315).
set -u
C="$(cd "$1" && pwd)"; PORT="${PORT:-8950}"; CDP="${CDP:-9290}"
. "$(cd "$(dirname "$0")/../../.." && pwd)/scripts/node-floor.sh" || exit 2
S="$(mktemp -d "${TMPDIR:-/tmp}/check-archive.XXXXXX")"; mkdir -p "$S/shots"
taken() { curl -s -m 1 -o /dev/null "localhost:$1/$2"; [ $? -ne 7 ]; }
if taken "$PORT" health; then echo "refusing: PORT $PORT is taken"; exit 2; fi
if taken "$CDP" json/version; then echo "refusing: CDP $CDP is taken (another session's Chrome?)"; exit 2; fi
cd "$C" || exit 2
HERE=.claude/skills/verify-ui-change
echo "### $C · floor.js $(shasum -a 256 src/ui/floor.js | cut -c1-8) · $(date -u +%FT%TZ)"
PORT=$PORT DB_PATH="$S/r.db" ORCH_AUTH_TOKEN=k node src/server.js > "$S/server.log" 2>&1 & SRV=$!
for _ in $(seq 1 40); do curl -s -m 1 "localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
node $HERE/seed-archive.mjs "http://localhost:$PORT" "$S/r.db" > "$S/seed.log" 2>&1 & SEED=$!
sleep 2
ORCH_CDP_PORT=$CDP node --experimental-websocket $HERE/check-archive.mjs "http://localhost:$PORT" "$S/shots" 2> "$S/check.err" | tee "$S/out.txt"; rc=${PIPESTATUS[0]}
kill $SEED $SRV 2>/dev/null; wait $SEED $SRV 2>/dev/null
pkill -f "remote-debugging-port=$CDP( |\$)" 2>/dev/null
for _ in $(seq 1 40); do taken "$CDP" json/version || break; sleep 0.25; done
grep -q '^shots in ' "$S/out.txt" && [ "$rc" = 0 ] && echo "PASS · ran to its last step" || { echo "FAIL · the check did not finish; its stderr:"; tail -5 "$S/check.err"; rc=3; }
echo "-- exit $rc · fixture logs and shots in $S"
exit $rc

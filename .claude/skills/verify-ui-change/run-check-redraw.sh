#!/bin/bash
# check-redraw.mjs with its whole fixture, served from any directory: the
# repo, or a copy holding another commit's src/ or a mutant (issue #37).
#
#   run-check-redraw.sh <dir> [after|before]          # → the check's table on stdout
#   PORT=8913 CDP=9255 run-check-redraw.sh "$PWD" after
#
# The same shape as run-check-backdrop.sh: a server from <dir> on a scratch
# DB, seed-desk.mjs and answering-host.mjs on that DB, the check, then all
# of it killed. Two differences. The server runs with History's and
# Sessions' 5 s host throttles at 0, so every open asks its host and the
# rows do not have to wait each other out. And answering-host reads an
# answers file in the scratch directory, which the check rewrites before
# each row to time the host's answer. About a minute. Announce PORT and CDP
# first.
set -u
# A Node that can load better-sqlite3 13, or a refusal in words: this machine's
# default node segfaults on it silently (scripts/node-floor.sh has the why).
. "$(cd "$(dirname "$0")/../../.." && pwd)/scripts/node-floor.sh" || exit 2
C="$(cd "$1" && pwd)"; EXP="${2:-after}"; PORT="${PORT:-8913}"; CDP="${CDP:-9255}"
S="$(mktemp -d "${TMPDIR:-/tmp}/check-redraw.XXXXXX")"
taken() { curl -s -m 1 -o /dev/null "localhost:$1/$2"; [ $? -ne 7 ]; }
if taken "$PORT" health; then echo "refusing: PORT $PORT is taken"; exit 2; fi
if taken "$CDP" json/version; then echo "refusing: CDP $CDP is taken (another session's Chrome?)"; exit 2; fi
cd "$C" || exit 2
HERE=.claude/skills/verify-ui-change
echo "### $C · --expect $EXP · app.js $(shasum -a 256 src/ui/app.js | cut -c1-8) · $(date -u +%FT%TZ)"
echo '{}' > "$S/answers.json"
ORCH_SESSIONS_MIN_MS=0 ORCH_HISTORY_MIN_MS=0 PORT=$PORT DB_PATH="$S/r.db" ORCH_AUTH_TOKEN=k node src/server.js > "$S/server.log" 2>&1 & SRV=$!
for _ in $(seq 1 40); do curl -s -m 1 "localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
node $HERE/seed-desk.mjs "http://localhost:$PORT" --db "$S/r.db" > "$S/seed.log" 2>&1 & SEED=$!
sleep 2
node $HERE/answering-host.mjs "http://localhost:$PORT" --db "$S/r.db" --answers "$S/answers.json" > "$S/host.jsonl" 2> "$S/host.err" & AH=$!
sleep 1
ORCH_CDP_PORT=$CDP node --experimental-websocket $HERE/check-redraw.mjs \
  "http://localhost:$PORT" --answers "$S/answers.json" --expect "$EXP" 2> "$S/check.err" | tee "$S/out.txt"; rc=${PIPESTATUS[0]}
kill $AH $SEED $SRV 2>/dev/null; wait $AH $SEED $SRV 2>/dev/null
pkill -f "remote-debugging-port=$CDP( |\$)" 2>/dev/null
for _ in $(seq 1 40); do taken "$CDP" json/version || break; sleep 0.25; done
grep -qE '^(PASS|FAIL) ' "$S/out.txt" || { echo "-- THE CHECK DID NOT FINISH; its stderr:"; tail -5 "$S/check.err"; rc=3; }
echo "-- exit $rc · fixture logs in $S"
exit $rc

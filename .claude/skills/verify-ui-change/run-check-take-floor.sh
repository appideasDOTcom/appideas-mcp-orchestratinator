#!/bin/bash
# check-take-floor.mjs (Take a desk keeps the floor it was opened from) with
# its whole fixture, served from any directory: the repo, or a copy holding
# a mutant or an older app.js.
#
#   PORT=8947 CDP=9287 run-check-take-floor.sh <dir>     # → the check's lines on stdout
#
# A server from <dir> on a scratch DB, seed-desk.mjs's desk on `lab`,
# answering-host.mjs with one folder bound on another floor, its own Chrome,
# the check, then all of it killed. About fifteen seconds. A PORT or CDP that
# anything answers on is refused, and the pkill matches the port exactly.
set -u
. "$(cd "$(dirname "$0")/../../.." && pwd)/scripts/node-floor.sh" || exit 2
C="$(cd "$1" && pwd)"; PORT="${PORT:-8947}"; CDP="${CDP:-9287}"
S="$(mktemp -d "${TMPDIR:-/tmp}/check-take-floor.XXXXXX")"; mkdir -p "$S/shots"
taken() { curl -s -m 1 -o /dev/null "localhost:$1/$2"; [ $? -ne 7 ]; }
if taken "$PORT" health; then echo "refusing: PORT $PORT is taken"; exit 2; fi
if taken "$CDP" json/version; then echo "refusing: CDP $CDP is taken (another session's Chrome?)"; exit 2; fi
cd "$C" || exit 2
HERE=.claude/skills/verify-ui-change
echo "### $C · app.js $(shasum -a 256 src/ui/app.js | cut -c1-8) · $(date -u +%FT%TZ)"
echo '{"browse":{"bound":{"/repo/deep/nest/bound-here":{"channel":"elsewhere","agent":"cy","scope":"local"}}}}' > "$S/answers.json"
PORT=$PORT DB_PATH="$S/r.db" ORCH_AUTH_TOKEN=k node src/server.js > "$S/server.log" 2>&1 & SRV=$!
for _ in $(seq 1 40); do curl -s -m 1 "localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
node $HERE/seed-desk.mjs "http://localhost:$PORT" --db "$S/r.db" > "$S/seed.log" 2>&1 & SEED=$!
sleep 2
node $HERE/answering-host.mjs "http://localhost:$PORT" --db "$S/r.db" --answers "$S/answers.json" > "$S/host.jsonl" 2> "$S/host.err" & AH=$!
sleep 1
ORCH_CDP_PORT=$CDP node --experimental-websocket $HERE/check-take-floor.mjs "http://localhost:$PORT" "$S/shots" 2> "$S/check.err" | tee "$S/out.txt"; rc=${PIPESTATUS[0]}
kill $AH $SEED $SRV 2>/dev/null; wait $AH $SEED $SRV 2>/dev/null
pkill -f "remote-debugging-port=$CDP( |\$)" 2>/dev/null
for _ in $(seq 1 40); do taken "$CDP" json/version || break; sleep 0.25; done
grep -qE '^(PASS|FAIL) · ' "$S/out.txt" || { echo "-- THE CHECK DID NOT FINISH; its stderr:"; tail -5 "$S/check.err"; rc=3; }
echo "-- exit $rc · fixture logs and shots in $S"
exit $rc

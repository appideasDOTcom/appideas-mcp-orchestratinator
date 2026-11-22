#!/bin/bash
# check-release.mjs with its whole fixture, served from any directory: the
# repo, or a copy holding another commit's src/ or a mutant (task 292).
#
#   run-check-release.sh <dir>                       # → the check's lines on stdout
#   PORT=8961 CDP=9291 run-check-release.sh "$PWD"
#
# A server from <dir> on a scratch DB, seed-desk.mjs for a floor to stand on
# (`lab`, on h1, which answering-host then answers for), answering-host.mjs twice on it (h1
# `testbox`, which can release and has a folder dialog; h2 `oldbox`, which
# says neither), the check, then all of it killed. answering-host reads an
# answers file the check rewrites between steps, and its stdout is the work
# the page sent. About twenty seconds. Refuses a PORT or CDP that anything
# answers on, like the other runners.
set -u
. "$(cd "$(dirname "$0")/../../.." && pwd)/scripts/node-floor.sh" || exit 2
C="$(cd "$1" && pwd)"; PORT="${PORT:-8961}"; CDP="${CDP:-9291}"
S="$(mktemp -d "${TMPDIR:-/tmp}/check-release.XXXXXX")"
taken() { curl -s -m 1 -o /dev/null "localhost:$1/$2"; [ $? -ne 7 ]; }
if taken "$PORT" health; then echo "refusing: PORT $PORT is taken"; exit 2; fi
if taken "$CDP" json/version; then echo "refusing: CDP $CDP is taken (another session's Chrome?)"; exit 2; fi
cd "$C" || exit 2
HERE=.claude/skills/verify-ui-change
echo "### $C · app.js $(shasum -a 256 src/ui/app.js | cut -c1-8) · $(date -u +%FT%TZ)"
echo '{}' > "$S/answers.json"
PORT=$PORT DB_PATH="$S/r.db" ORCH_AUTH_TOKEN=k node src/server.js > "$S/server.log" 2>&1 & SRV=$!
for _ in $(seq 1 40); do curl -s -m 1 "localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
node $HERE/seed-desk.mjs "http://localhost:$PORT" --db "$S/r.db" > "$S/seed.log" 2>&1 & SEED=$!
sleep 2
node $HERE/answering-host.mjs "http://localhost:$PORT" --db "$S/r.db" --answers "$S/answers.json" > "$S/host.jsonl" 2> "$S/host.err" & AH=$!
node $HERE/answering-host.mjs "http://localhost:$PORT" --db "$S/r.db" --host h2 --name oldbox --no-dialog --no-release > "$S/host2.jsonl" 2> "$S/host2.err" & AH2=$!
sleep 2
ORCH_CDP_PORT=$CDP node --experimental-websocket $HERE/check-release.mjs \
  "http://localhost:$PORT" --answers "$S/answers.json" --work "$S/host.jsonl" --out "$S" 2> "$S/check.err" | tee "$S/out.txt"; rc=${PIPESTATUS[0]}
kill $AH $AH2 $SEED $SRV 2>/dev/null; wait $AH $AH2 $SEED $SRV 2>/dev/null
pkill -f "remote-debugging-port=$CDP( |\$)" 2>/dev/null
for _ in $(seq 1 40); do taken "$CDP" json/version || break; sleep 0.25; done
grep -qE '^(PASS|FAIL) ' "$S/out.txt" || { echo "-- THE CHECK DID NOT FINISH; its stderr:"; tail -5 "$S/check.err"; rc=3; }
echo "-- exit $rc · fixture logs and shots in $S"
exit $rc

#!/bin/bash
# check-popout-session.mjs (issue #46) with its whole fixture, served from any
# directory: the repo, or a copy holding another commit's src/ or a mutant.
#
#   PORT=8935 CDP=9275 RUNS=12 run-check-popout-session.sh <dir>   # → the check's lines on stdout
#
# A server from <dir> on a scratch DB, one seed-desk.mjs desk (lab/bo), its own
# Chrome, the check, and all of it killed after. About ten seconds a run. The red
# is a race, so RUNS defaults to 12: the pre-fix page read red in 2 of 3 runs once,
# 1 of 8 (QA, and again here: run 7), and its first run was clean every time. Same port
# rules as run-check-popout.sh: a PORT or CDP that anything answers on is
# refused. Announce both first.
set -u
C="$(cd "$1" && pwd)"; PORT="${PORT:-8935}"; CDP="${CDP:-9275}"; RUNS="${RUNS:-12}"
S="$(mktemp -d "${TMPDIR:-/tmp}/check-popout-session.XXXXXX")"
taken() { curl -s -m 1 -o /dev/null "localhost:$1/$2"; [ $? -ne 7 ]; }
if taken "$PORT" health; then echo "refusing: PORT $PORT is taken"; exit 2; fi
if taken "$CDP" json/version; then echo "refusing: CDP $CDP is taken (another session's Chrome?)"; exit 2; fi
cd "$C" || exit 2
echo "### $C · floor.js $(shasum -a 256 src/ui/floor.js | cut -c1-8) · $(date -u +%FT%TZ)"
PORT=$PORT DB_PATH="$S/r.db" ORCH_AUTH_TOKEN=k node src/server.js > "$S/server.log" 2>&1 & SRV=$!
for _ in $(seq 1 40); do curl -s -m 1 "localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
node .claude/skills/verify-ui-change/seed-desk.mjs "http://localhost:$PORT" --db "$S/r.db" --agent bo > "$S/seed.log" 2>&1 & SEED=$!
sleep 3
ORCH_CDP_PORT=$CDP node --experimental-websocket .claude/skills/verify-ui-change/check-popout-session.mjs \
  "http://localhost:$PORT" "$RUNS" 2> "$S/check.err" | tee "$S/out.txt"; rc=${PIPESTATUS[0]}
kill $SEED $SRV 2>/dev/null; wait $SEED $SRV 2>/dev/null
pkill -f "remote-debugging-port=$CDP( |\$)" 2>/dev/null
for _ in $(seq 1 40); do taken "$CDP" json/version || break; sleep 0.25; done
grep -qE '^(PASS|FAIL) · ' "$S/out.txt" || { echo "-- THE CHECK DID NOT FINISH; its stderr:"; tail -5 "$S/check.err"; rc=3; }
echo "-- exit $rc · fixture logs in $S"
exit $rc

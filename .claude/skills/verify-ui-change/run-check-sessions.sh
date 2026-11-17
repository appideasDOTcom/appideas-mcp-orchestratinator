#!/bin/bash
# check-sessions.mjs (one agent, several sessions: the card, a second room,
# Bring back, Resume, Take a desk's New desk here) with its whole fixture,
# served from any directory: the repo, or a copy holding a mutant.
#
#   PORT=8949 CDP=9289 run-check-sessions.sh <dir>     # → the check's lines on stdout
#
# A server from <dir> on a scratch DB, seed-sessions.mjs's floor and host on
# it (a host that registers, seats and unseats as the board asks), its own
# Chrome, the check, then all of it killed. About two minutes. A PORT or CDP
# that anything answers on is refused (drive.mjs reuses a Chrome already on
# its port), and the pkill matches the port exactly. Announce PORT and CDP on
# the channel first. Run it with a Node the board can start on (22.14+).
set -u
C="$(cd "$1" && pwd)"; PORT="${PORT:-8949}"; CDP="${CDP:-9289}"
S="$(mktemp -d "${TMPDIR:-/tmp}/check-sessions.XXXXXX")"; mkdir -p "$S/shots"
taken() { curl -s -m 1 -o /dev/null "localhost:$1/$2"; [ $? -ne 7 ]; }
if taken "$PORT" health; then echo "refusing: PORT $PORT is taken"; exit 2; fi
if taken "$CDP" json/version; then echo "refusing: CDP $CDP is taken (another session's Chrome?)"; exit 2; fi
cd "$C" || exit 2
HERE=.claude/skills/verify-ui-change
echo "### $C · floor.js $(shasum -a 256 src/ui/floor.js | cut -c1-8) · app.js $(shasum -a 256 src/ui/app.js | cut -c1-8) · $(date -u +%FT%TZ)"
PORT=$PORT DB_PATH="$S/r.db" ORCH_AUTH_TOKEN=k node src/server.js > "$S/server.log" 2>&1 & SRV=$!
for _ in $(seq 1 40); do curl -s -m 1 "localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
echo '{}' > "$S/ctl.json"
node $HERE/seed-sessions.mjs "http://localhost:$PORT" --ctl "$S/ctl.json" > "$S/work.jsonl" 2> "$S/seed.err" & SEED=$!
sleep 3
ORCH_CDP_PORT=$CDP node --experimental-websocket $HERE/check-sessions.mjs \
  "http://localhost:$PORT" "$S/shots" "$S/work.jsonl" "$S/r.db" "$S/ctl.json" 2> "$S/check.err" | tee "$S/out.txt"; rc=${PIPESTATUS[0]}
kill $SEED $SRV 2>/dev/null; wait $SEED $SRV 2>/dev/null
pkill -f "remote-debugging-port=$CDP( |\$)" 2>/dev/null
for _ in $(seq 1 40); do taken "$CDP" json/version || break; sleep 0.25; done
grep -qE '^(PASS|FAIL) · ' "$S/out.txt" || { echo "-- THE CHECK DID NOT FINISH; its stderr:"; tail -5 "$S/check.err"; rc=3; }
echo "-- exit $rc · fixture logs and shots in $S"
exit $rc

#!/bin/bash
# check-popout.mjs (issue #19) with its whole fixture, served from any
# directory: the repo, or a copy holding another commit's src/ or a mutant.
#
#   PORT=8931 CDP=9271 run-check-popout.sh <dir>        # → the check's lines on stdout
#
# It starts a server from <dir> on a scratch DB, seven seed-desk.mjs desks on
# that DB (bo, cy, d1–d5: the floor plus six popouts is the seven-window step)
# and seed-form.mjs on a host of its own (h-form: two seeds on one host take
# each other's desks away), launches its own Chrome with the throttling grace
# shortened to 10 s for the minimized-popout step, runs the check and kills
# all of it. About five minutes. Same port rules as run-check-chatbox.sh: a
# PORT or CDP that anything answers on is refused, because drive.mjs reuses a
# Chrome already on its port (without the flag the minimized step reads its
# own timers unthrottled and fails), and the pkill matches the port exactly.
# Announce PORT and CDP on the channel first.
#
# For a page mutant (mutate-in-a-copy), from the copy:
#   run-page-mutant.sh "<what>" src/ui/floor.js '<old>' '<new>' \
#     'PORT=8932 CDP=9272 .claude/skills/verify-ui-change/run-check-popout.sh "$PWD"'
set -u
C="$(cd "$1" && pwd)"; PORT="${PORT:-8931}"; CDP="${CDP:-9271}"
S="$(mktemp -d "${TMPDIR:-/tmp}/check-popout.XXXXXX")"; mkdir -p "$S/shots"
taken() { curl -s -m 1 -o /dev/null "localhost:$1/$2"; [ $? -ne 7 ]; }
if taken "$PORT" health; then echo "refusing: PORT $PORT is taken"; exit 2; fi
if taken "$CDP" json/version; then echo "refusing: CDP $CDP is taken (another session's Chrome?)"; exit 2; fi
cd "$C" || exit 2
echo "### $C · floor.js $(shasum -a 256 src/ui/floor.js | cut -c1-8) · hub.js $(shasum -a 256 src/ui/hub.js | cut -c1-8) · drive.mjs $(shasum -a 256 .claude/skills/verify-ui-change/drive.mjs | cut -c1-8) · $(date -u +%FT%TZ)"
PORT=$PORT DB_PATH="$S/r.db" ORCH_AUTH_TOKEN=k node src/server.js > "$S/server.log" 2>&1 & SRV=$!
for _ in $(seq 1 40); do curl -s -m 1 "localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
SEEDS=""
for a in bo cy d1 d2 d3 d4 d5; do
  node .claude/skills/verify-ui-change/seed-desk.mjs "http://localhost:$PORT" --db "$S/r.db" --agent $a > "$S/seed-$a.log" 2>&1 & SEEDS="$SEEDS $!"
done
node .claude/skills/verify-ui-change/seed-form.mjs "http://localhost:$PORT" --host h-form > "$S/seed-form.log" 2>&1 & SEEDS="$SEEDS $!"
sleep 3
ORCH_CDP_PORT=$CDP ORCH_CHROME_ARGS=--enable-features=IntensiveWakeUpThrottling:grace_period_seconds/10 \
  node --experimental-websocket .claude/skills/verify-ui-change/check-popout.mjs \
  "http://localhost:$PORT" "$S/shots" 2> "$S/check.err" | tee "$S/out.txt"; rc=${PIPESTATUS[0]}
kill $SEEDS $SRV 2>/dev/null; wait $SEEDS $SRV 2>/dev/null
pkill -f "remote-debugging-port=$CDP( |\$)" 2>/dev/null
for _ in $(seq 1 40); do taken "$CDP" json/version || break; sleep 0.25; done
grep -qE '^(PASS|[0-9]+ ✗ · FAIL)' "$S/out.txt" || { echo "-- THE CHECK DID NOT FINISH; its stderr:"; tail -5 "$S/check.err"; rc=3; }
echo "-- exit $rc · fixture logs and shots in $S"
exit $rc

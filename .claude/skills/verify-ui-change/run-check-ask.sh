#!/bin/bash
# check-ask.mjs (what a desk's Claude Code asks (a permission, a question) on its panel; the floor
# does not know, on a desk's panel; 0.14.6) with its whole fixture, served
# from any directory: the repo, or a copy holding a mutant.
#
#   PORT=8965 CDP=9299 run-check-ask.sh <dir>
#
# A server from <dir> on a scratch DB, seed-meeting.mjs's floor and host on
# it, its own Chrome, the check, then all of it killed. About twenty seconds.
set -u
. "$(cd "$(dirname "$0")/../../.." && pwd)/scripts/node-floor.sh" || exit 2
C="$(cd "$1" && pwd)"; PORT="${PORT:-8965}"; CDP="${CDP:-9299}"
S="$(mktemp -d "${TMPDIR:-/tmp}/check-ask.XXXXXX")"; mkdir -p "$S/shots"
taken() { curl -s -m 1 -o /dev/null "localhost:$1/$2"; [ $? -ne 7 ]; }
if taken "$PORT" health; then echo "refusing: PORT $PORT is taken"; exit 2; fi
if taken "$CDP" json/version; then echo "refusing: CDP $CDP is taken (another session's Chrome?)"; exit 2; fi
cd "$C" || exit 2
echo "### $C · floor.js $(shasum -a 256 src/ui/floor.js | cut -c1-8) · $(date -u +%FT%TZ)"
PORT=$PORT DB_PATH="$S/r.db" ORCH_AUTH_TOKEN=k node src/server.js > "$S/server.log" 2>&1 & SRV=$!
for _ in $(seq 1 40); do curl -s -m 1 "localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
echo '{}' > "$S/ctl.json"
node .claude/skills/verify-ui-change/seed-meeting.mjs "http://localhost:$PORT" --db "$S/r.db" --ctl "$S/ctl.json" > "$S/work.jsonl" 2> "$S/seed.err" & SEED=$!
sleep 2
ORCH_CDP_PORT=$CDP node --experimental-websocket .claude/skills/verify-ui-change/check-ask.mjs \
  "http://localhost:$PORT" "$S/shots" "$S/work.jsonl" 2> "$S/check.err" | tee "$S/out.txt"; rc=${PIPESTATUS[0]}
kill $SEED $SRV 2>/dev/null; wait $SEED $SRV 2>/dev/null
pkill -f "remote-debugging-port=$CDP( |\$)" 2>/dev/null
for _ in $(seq 1 40); do taken "$CDP" json/version || break; sleep 0.25; done
grep -qE '^(PASS|FAIL) · ' "$S/out.txt" || { echo "-- THE CHECK DID NOT FINISH; its stderr:"; tail -5 "$S/check.err"; rc=3; }
echo "-- exit $rc · fixture logs and shots in $S"
exit $rc

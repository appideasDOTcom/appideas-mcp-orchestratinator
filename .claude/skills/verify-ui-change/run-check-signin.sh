#!/bin/bash
# check-signin.mjs (costmo, 2026-11-19: a desk whose host's Claude Code is
# signed out) with its whole fixture, served from any directory: the repo,
# or a copy holding a mutant.
#
#   PORT=8953 CDP=9293 run-check-signin.sh <dir>     # → the check's lines on stdout
#
# A server from <dir> on a scratch DB, seed-select.mjs's floor and host on
# it, its own Chrome, the check, then all of it killed. About forty
# seconds. A PORT or CDP that anything answers on is refused (drive.mjs reuses a Chrome already on
# its port), and the pkill matches the port exactly. Announce PORT and CDP
# on the channel first.
set -u
. "$(cd "$(dirname "$0")/../../.." && pwd)/scripts/node-floor.sh" || exit 2
C="$(cd "$1" && pwd)"; PORT="${PORT:-8953}"; CDP="${CDP:-9293}"
S="$(mktemp -d "${TMPDIR:-/tmp}/check-signin.XXXXXX")"; mkdir -p "$S/shots"
taken() { curl -s -m 1 -o /dev/null "localhost:$1/$2"; [ $? -ne 7 ]; }
if taken "$PORT" health; then echo "refusing: PORT $PORT is taken"; exit 2; fi
if taken "$CDP" json/version; then echo "refusing: CDP $CDP is taken (another session's Chrome?)"; exit 2; fi
cd "$C" || exit 2
echo "### $C · floor.js $(shasum -a 256 src/ui/floor.js | cut -c1-8) · $(date -u +%FT%TZ)"
PORT=$PORT DB_PATH="$S/r.db" ORCH_AUTH_TOKEN=k node src/server.js > "$S/server.log" 2>&1 & SRV=$!
for _ in $(seq 1 40); do curl -s -m 1 "localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
echo '{}' > "$S/host.json"
node .claude/skills/verify-ui-change/seed-select.mjs "http://localhost:$PORT" "$S/r.db" "$S/host.json" > "$S/work.jsonl" 2> "$S/seed.err" & SEED=$!
sleep 2
ORCH_CDP_PORT=$CDP node --experimental-websocket .claude/skills/verify-ui-change/check-signin.mjs \
  "http://localhost:$PORT" "$S/shots" "$S/r.db" "$S/host.json" "$S/work.jsonl" 2> "$S/check.err" | tee "$S/out.txt"; rc=${PIPESTATUS[0]}
kill $SEED $SRV 2>/dev/null; wait $SEED $SRV 2>/dev/null
pkill -f "remote-debugging-port=$CDP( |\$)" 2>/dev/null
for _ in $(seq 1 40); do taken "$CDP" json/version || break; sleep 0.25; done
grep -qE '^(PASS|FAIL) · ' "$S/out.txt" || { echo "-- THE CHECK DID NOT FINISH; its stderr:"; tail -5 "$S/check.err"; rc=3; }
echo "-- exit $rc · fixture logs and shots in $S"
exit $rc

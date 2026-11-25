#!/bin/bash
# check-relayed.mjs (the page from a relayed origin; contract board.relay)
# with its fixture: a board from <dir> with a relay secret, relay-hop.mjs in
# front of it, seed-select.mjs's floors and host on the board directly, its
# own Chrome.
#
#   PORT=8958 CDP=9298 run-check-relayed.sh <dir>     # the hop on PORT+30 unless HOP says
set -u
C="$(cd "$1" && pwd)"; PORT="${PORT:-8958}"; HOP="${HOP:-$((PORT + 30))}"; CDP="${CDP:-9298}"
. "$(cd "$(dirname "$0")/../../.." && pwd)/scripts/node-floor.sh" || exit 2
S="$(mktemp -d "${TMPDIR:-/tmp}/check-relayed.XXXXXX")"; mkdir -p "$S/shots"
taken() { curl -s -m 1 -o /dev/null "localhost:$1/$2"; [ $? -ne 7 ]; }
for P in "$PORT" "$HOP"; do if taken "$P" health; then echo "refusing: PORT $P is taken"; exit 2; fi; done
if taken "$CDP" json/version; then echo "refusing: CDP $CDP is taken"; exit 2; fi
cd "$C" || exit 2
HERE=.claude/skills/verify-ui-change
SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
echo "### $C · relay.js $(shasum -a 256 src/relay.js | cut -c1-8) · $(date -u +%FT%TZ)"
PORT=$PORT DB_PATH="$S/b.db" ORCH_AUTH_TOKEN=k ORCH_RELAY_SECRET=$SECRET node src/server.js > "$S/server.log" 2>&1 & SRV=$!
for _ in $(seq 1 40); do curl -s -m 1 "localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
node $HERE/relay-hop.mjs "$HOP" "http://127.0.0.1:$PORT" k "$SECRET" > "$S/hop.log" 2>&1 & HOPP=$!
echo '{}' > "$S/host.json"
node $HERE/seed-select.mjs "http://localhost:$PORT" "$S/b.db" "$S/host.json" > "$S/work.jsonl" 2> "$S/seed.err" & SEED=$!
sleep 2
ORCH_CDP_PORT=$CDP node --experimental-websocket $HERE/check-relayed.mjs "http://b7k2.localhost:$HOP" "$S/shots" "http://localhost:$PORT" 2> "$S/check.err" | tee "$S/out.txt"; rc=${PIPESTATUS[0]}
kill $SEED $SRV $HOPP 2>/dev/null; wait $SEED $SRV $HOPP 2>/dev/null
pkill -f "remote-debugging-port=$CDP( |\$)" 2>/dev/null
for _ in $(seq 1 40); do taken "$CDP" json/version || break; sleep 0.25; done
grep -qE '^(PASS|FAIL) · ' "$S/out.txt" || { echo "-- THE CHECK DID NOT FINISH; its stderr:"; tail -5 "$S/check.err"; rc=3; }
echo "-- exit $rc · fixture logs and shots in $S"
exit $rc

#!/bin/bash
# check-guest.mjs (a guest in an owner's building; board.relay v5, M2) with
# its fixture: a board from <dir> with a relay secret, seed-select.mjs's
# floors and owner's host on it, beta moved into a building "Shared", a
# guest's host and desk (gwen) filed as Gail's, and two relay-hop.mjs
# stand-ins: the owner's on HOP, Gail's on HOP+1.
#
#   PORT=8966 CDP=9306 run-check-guest.sh <dir>     # the hops on PORT+30, +31
set -u
C="$(cd "$1" && pwd)"; PORT="${PORT:-8966}"; HOP="${HOP:-$((PORT + 30))}"; GHOP=$((HOP + 1)); CDP="${CDP:-9306}"
. "$(cd "$(dirname "$0")/../../.." && pwd)/scripts/node-floor.sh" || exit 2
S="$(mktemp -d "${TMPDIR:-/tmp}/check-guest.XXXXXX")"; mkdir -p "$S/shots"
taken() { curl -s -m 1 -o /dev/null "localhost:$1/$2"; [ $? -ne 7 ]; }
for P in "$PORT" "$HOP" "$GHOP"; do if taken "$P" health; then echo "refusing: PORT $P is taken"; exit 2; fi; done
if taken "$CDP" json/version; then echo "refusing: CDP $CDP is taken"; exit 2; fi
cd "$C" || exit 2
HERE=.claude/skills/verify-ui-change
SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
echo "### $C · relay.js $(shasum -a 256 src/relay.js | cut -c1-8) · floor.js $(shasum -a 256 src/ui/floor.js | cut -c1-8) · $(date -u +%FT%TZ)"
PORT=$PORT DB_PATH="$S/b.db" ORCH_AUTH_TOKEN=k ORCH_RELAY_SECRET=$SECRET node src/server.js > "$S/server.log" 2>&1 & SRV=$!
for _ in $(seq 1 40); do curl -s -m 1 "localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
echo '{}' > "$S/host.json"
node $HERE/seed-select.mjs "http://localhost:$PORT" "$S/b.db" "$S/host.json" > "$S/work.jsonl" 2> "$S/seed.err" & SEED=$!
sleep 2
SHARED=$(curl -s -X POST -H 'content-type: application/json' -d '{"name":"Shared"}' "localhost:$PORT/api/admin/building/create" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id))")
curl -s -o /dev/null -X POST -H 'content-type: application/json' -d "{\"channel\":\"beta\",\"building\":\"$SHARED\"}" "localhost:$PORT/api/admin/floor/building"
# Gail's host and desk, registered through her own hop as she would be.
PROTO=$(node -e "console.log(require('./package.json').protocol)")
HOP_ROLE=guest HOP_OP=op_guest HOP_BUILDINGS=$SHARED node $HERE/relay-hop.mjs "$GHOP" "http://127.0.0.1:$PORT" k "$SECRET" Gail > "$S/ghop.log" 2>&1 & GH=$!
node $HERE/relay-hop.mjs "$HOP" "http://127.0.0.1:$PORT" k "$SECRET" Chris > "$S/hop.log" 2>&1 & OH=$!
sleep 1
( for _ in $(seq 1 200); do curl -s -o /dev/null -X POST -H 'content-type: application/json' -d "{\"host_id\":\"op_guest~mac\",\"name\":\"gails-mac\",\"protocol\":$PROTO,\"desks\":[{\"channel\":\"beta\",\"agent\":\"gwen\",\"cwd\":\"/g/gwen\",\"window\":\"gwen-window\"}]}" "localhost:$GHOP/api/host/register"; sleep 20; done ) & REG=$!
sleep 1
# Each desk on its conversation, as a host says when it adopts one, so the
# panels are scoped to the turns the hosts write.
curl -s -o /dev/null -X POST -H 'content-type: application/json' -H 'x-orchestratinator-key: k' -d '{"host_id":"h1","events":[{"type":"session","channel":"beta","agent":"fay","session_id":"s-fay","cwd":"/repo/fay"}]}' "localhost:$PORT/api/host/events"
curl -s -o /dev/null -X POST -H 'content-type: application/json' -d '{"host_id":"op_guest~mac","events":[{"type":"session","channel":"beta","agent":"gwen","session_id":"s-gwen","cwd":"/g/gwen"}]}' "localhost:$GHOP/api/host/events"
curl -s -o /dev/null "localhost:$HOP/api/relay/hello"
ORCH_CDP_PORT=$CDP node --experimental-websocket $HERE/check-guest.mjs "http://b7k2.localhost:$HOP" "http://g9q4.localhost:$GHOP" "http://localhost:$PORT" "$S/shots" "$(node -e 'console.log(require("os").hostname())')" 2> "$S/check.err" | tee "$S/out.txt"; rc=${PIPESTATUS[0]}
kill $REG $SEED $SRV $OH $GH 2>/dev/null; wait $REG $SEED $SRV $OH $GH 2>/dev/null
pkill -f "remote-debugging-port=$CDP( |\$)" 2>/dev/null
for _ in $(seq 1 40); do taken "$CDP" json/version || break; sleep 0.25; done
grep -qE '^(PASS|FAIL) · ' "$S/out.txt" || { echo "-- THE CHECK DID NOT FINISH; its stderr:"; tail -5 "$S/check.err"; rc=3; }
echo "-- exit $rc · fixture logs and shots in $S"
exit $rc

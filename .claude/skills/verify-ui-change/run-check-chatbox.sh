#!/bin/bash
# check-chatbox.mjs (issue #13) with its whole fixture, served from any
# directory: the repo, or a copy holding another commit's src/ or a mutant.
#
#   PORT=8915 CDP=9265 run-check-chatbox.sh <dir>        # → the check's lines on stdout
#
# It starts a server from <dir> on a scratch DB, two seed-desk.mjs desks on
# that same DB (bo, which the check drives, and cy, the desk it switches
# to), runs the check and kills all of it. Same port rules as
# run-check-backdrop.sh, for the same reason (QA, PR #38 finding 1): a PORT
# or CDP anything answers on is refused, and the pkill matches the port
# exactly. About a minute. Announce PORT and CDP first.
set -u
C="$(cd "$1" && pwd)"; PORT="${PORT:-8915}"; CDP="${CDP:-9265}"
S="$(mktemp -d "${TMPDIR:-/tmp}/check-chatbox.XXXXXX")"
taken() { curl -s -m 1 -o /dev/null "localhost:$1/$2"; [ $? -ne 7 ]; }
if taken "$PORT" health; then echo "refusing: PORT $PORT is taken"; exit 2; fi
if taken "$CDP" json/version; then echo "refusing: CDP $CDP is taken (another session's Chrome?)"; exit 2; fi
cd "$C" || exit 2
echo "### $C · floor.js $(shasum -a 256 src/ui/floor.js | cut -c1-8) · drive.mjs $(shasum -a 256 .claude/skills/verify-ui-change/drive.mjs | cut -c1-8) · $(date -u +%FT%TZ)"
PORT=$PORT DB_PATH="$S/r.db" ORCH_AUTH_TOKEN=k node src/server.js > "$S/server.log" 2>&1 & SRV=$!
for _ in $(seq 1 40); do curl -s -m 1 "localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
node .claude/skills/verify-ui-change/seed-desk.mjs "http://localhost:$PORT" --db "$S/r.db" > "$S/seed-bo.log" 2>&1 & SB=$!
sleep 1.5
node .claude/skills/verify-ui-change/seed-desk.mjs "http://localhost:$PORT" --db "$S/r.db" --agent cy > "$S/seed-cy.log" 2>&1 & SC=$!
sleep 1.5
ORCH_CDP_PORT=$CDP node --experimental-websocket .claude/skills/verify-ui-change/check-chatbox.mjs \
  "http://localhost:$PORT" "$S/r.db" 2> "$S/check.err" | tee "$S/out.txt"; rc=${PIPESTATUS[0]}
kill $SB $SC $SRV 2>/dev/null; wait $SB $SC $SRV 2>/dev/null
pkill -f "remote-debugging-port=$CDP( |\$)" 2>/dev/null
for _ in $(seq 1 40); do taken "$CDP" json/version || break; sleep 0.25; done
grep -qE '^(PASS|FAIL) ' "$S/out.txt" || { echo "-- THE CHECK DID NOT FINISH; its stderr:"; tail -5 "$S/check.err"; rc=3; }
echo "-- exit $rc · fixture logs in $S"
exit $rc

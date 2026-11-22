#!/bin/bash
# check-settings.mjs (every setting behind ⚙, and ?settings=1 for the
# desktop app's Settings pane; costmo, 2026-11-19) with its whole fixture,
# served from any directory: the repo, or a copy holding a mutant.
#
#   PORT=8955 CDP=9295 run-check-settings.sh <dir>     # the app's board on PORT+40 unless APP_PORT says
#
# Two servers from <dir> on scratch DBs: a board as Docker runs it, and one
# with ORCH_BOARD_SUPERVISOR=app as the app runs its own. No seed: an empty
# board exports and restores. Its own Chrome, the check, then all of it
# killed. About forty seconds. A port anything answers on is refused, and
# the pkill matches the CDP port exactly.
set -u
C="$(cd "$1" && pwd)"; PORT="${PORT:-8955}"; APP_PORT="${APP_PORT:-$((PORT + 40))}"; CDP="${CDP:-9295}"
. "$(cd "$(dirname "$0")/../../.." && pwd)/scripts/node-floor.sh" || exit 2
S="$(mktemp -d "${TMPDIR:-/tmp}/check-settings.XXXXXX")"; mkdir -p "$S/shots"
taken() { curl -s -m 1 -o /dev/null "localhost:$1/$2"; [ $? -ne 7 ]; }
for P in "$PORT" "$APP_PORT"; do if taken "$P" health; then echo "refusing: PORT $P is taken"; exit 2; fi; done
if taken "$CDP" json/version; then echo "refusing: CDP $CDP is taken (another session's Chrome?)"; exit 2; fi
cd "$C" || exit 2
HERE=.claude/skills/verify-ui-change
echo "### $C · app.js $(shasum -a 256 src/ui/app.js | cut -c1-8) · $(date -u +%FT%TZ)"
PORT=$PORT DB_PATH="$S/r.db" ORCH_AUTH_TOKEN=k node src/server.js > "$S/server.log" 2>&1 & SRV=$!
PORT=$APP_PORT DB_PATH="$S/app.db" ORCH_AUTH_TOKEN=k ORCH_BOARD_SUPERVISOR=app node src/server.js > "$S/app-server.log" 2>&1 & APP=$!
for P in "$PORT" "$APP_PORT"; do for _ in $(seq 1 40); do curl -s -m 1 "localhost:$P/health" >/dev/null && break; sleep 0.25; done; done
ORCH_CDP_PORT=$CDP node --experimental-websocket $HERE/check-settings.mjs "http://localhost:$PORT" "http://localhost:$APP_PORT" "$S/shots" 2> "$S/check.err" | tee "$S/out.txt"; rc=${PIPESTATUS[0]}
kill $SRV $APP 2>/dev/null; wait $SRV $APP 2>/dev/null
pkill -f "remote-debugging-port=$CDP( |\$)" 2>/dev/null
for _ in $(seq 1 40); do taken "$CDP" json/version || break; sleep 0.25; done
grep -qE '^(PASS|FAIL) · ' "$S/out.txt" || { echo "-- THE CHECK DID NOT FINISH; its stderr:"; tail -5 "$S/check.err"; rc=3; }
echo "-- exit $rc · fixture logs and shots in $S"
exit $rc

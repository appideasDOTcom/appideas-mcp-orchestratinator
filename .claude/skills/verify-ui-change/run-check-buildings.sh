#!/bin/bash
# check-buildings.mjs (buildings on the page; the service round, 2026-11-24)
# with its whole fixture, served from any directory: the repo, or a copy
# holding a mutant.
#
#   PORT=8957 CDP=9297 run-check-buildings.sh <dir>
#
# One server from <dir> on a scratch DB, three floors made as agents make
# them (an MCP connect and a message each), its own Chrome, the check, then
# all of it killed. A port anything answers on is refused.
set -u
C="$(cd "$1" && pwd)"; PORT="${PORT:-8957}"; CDP="${CDP:-9297}"
. "$(cd "$(dirname "$0")/../../.." && pwd)/scripts/node-floor.sh" || exit 2
S="$(mktemp -d "${TMPDIR:-/tmp}/check-buildings.XXXXXX")"; mkdir -p "$S/shots"
taken() { curl -s -m 1 -o /dev/null "localhost:$1/$2"; [ $? -ne 7 ]; }
if taken "$PORT" health; then echo "refusing: PORT $PORT is taken"; exit 2; fi
if taken "$CDP" json/version; then echo "refusing: CDP $CDP is taken (another session's Chrome?)"; exit 2; fi
cd "$C" || exit 2
HERE=.claude/skills/verify-ui-change
echo "### $C · app.js $(shasum -a 256 src/ui/app.js | cut -c1-8) · $(date -u +%FT%TZ)"
PORT=$PORT DB_PATH="$S/b.db" ORCH_AUTH_TOKEN=k ORCH_RELAY_SECRET= node src/server.js > "$S/server.log" 2>&1 & SRV=$!
for _ in $(seq 1 40); do curl -s -m 1 "localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
BASE="http://localhost:$PORT" node -e '
const base = process.env.BASE;
const h = (c, sid) => ({ "content-type": "application/json", accept: "application/json, text/event-stream", "x-orchestratinator-key": "k", "x-channel": c, "x-agent": "dev", ...(sid ? { "mcp-session-id": sid } : {}) });
(async () => { for (const c of ["alpha", "beta", "gamma"]) {
  const i = await fetch(`${base}/mcp`, { method: "POST", headers: h(c), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "seed", version: "1" } } }) });
  const sid = i.headers.get("mcp-session-id"); await i.text();
  const r = await fetch(`${base}/mcp`, { method: "POST", headers: h(c, sid), body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "send_message", arguments: { body: "seed" } } }) }); await r.text();
} })();' || { echo "seed failed"; kill $SRV; exit 2; }
ORCH_CDP_PORT=$CDP node --experimental-websocket $HERE/check-buildings.mjs "http://localhost:$PORT" "$S/shots" 2> "$S/check.err" | tee "$S/out.txt"; rc=${PIPESTATUS[0]}
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
pkill -f "remote-debugging-port=$CDP( |\$)" 2>/dev/null
for _ in $(seq 1 40); do taken "$CDP" json/version || break; sleep 0.25; done
grep -qE '^(PASS|FAIL) · ' "$S/out.txt" || { echo "-- THE CHECK DID NOT FINISH; its stderr:"; tail -5 "$S/check.err"; rc=3; }
echo "-- exit $rc · fixture logs and shots in $S"
exit $rc

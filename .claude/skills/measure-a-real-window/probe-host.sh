#!/bin/bash
# A real window, our board and our host, all three from the tree, none of
# them the operator's: the rig that showed the automatic reconnect and a
# meeting room's notices working end to end (2026-11-19). SKILL.md, "A board
# that goes away: the reconnect and a room's notices".
#
#   probe-host.sh up <probe dir> [port]  # scratch board (default 8931), the dir bound to it
#                                        # in local scope as probe-floor/probe, and a dev host
#                                        # on the probe socket (-L probe, session p) rooted at
#                                        # the dir alone. Then start the window:
#                                        #   node probe.mjs up <probe dir> auto
#   probe-host.sh outage <seconds>       # stop the board, wait, start it again, then watch up
#                                        # to 90 s for the window's MCP session and the host's
#                                        # reconnect line. 5 s healed by itself on 2.1.328; 90 s
#                                        # did not, and the host reconnected it 25 s after.
#   probe-host.sh room                   # open a meeting room with the probe desk, end it, and
#                                        # print what the window was sent and the floor filed
#   probe-host.sh down                   # stop the host and the board, remove the binding
#
# Refuses 8787 and 6724 (the live Docker board and the app's), and any
# port something already answers on. The host's id is its own
# (probe-rig-host), never the hostname, which is the live host's row.
set -u
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
. "$REPO/scripts/node-floor.sh" >/dev/null || exit 2
ST="${PROBE_HOST_STATE:-${TMPDIR:-/tmp}/probe-host}"
mkdir -p "$ST"
J='content-type: application/json'
val() { cat "$ST/$1" 2>/dev/null; }
sessions() { curl -s -m 2 "localhost:$(val port)/health" | python3 -c "import sys,json; print(json.load(sys.stdin)['sessions'])" 2>/dev/null; }
board_up() {
  ( cd "$REPO" && PORT="$(val port)" DB_PATH="$ST/board.db" ORCH_AUTH_MODE=off nohup node src/server.js >> "$ST/board.log" 2>&1 & echo $! > "$ST/board.pid" )
  for _ in $(seq 1 40); do curl -s -m 1 "localhost:$(val port)/health" >/dev/null && return 0; sleep 0.25; done
  echo "the board did not come up; $ST/board.log"; return 1
}
board_down() { [ -s "$ST/board.pid" ] && kill "$(val board.pid)" 2>/dev/null; rm -f "$ST/board.pid"; }

case "${1:-}" in
  up)
    DIR="$(cd "${2:?probe dir}" && pwd)"; PORT="${3:-8931}"
    case "$PORT" in 8787|6724) echo "refusing: $PORT is a live board"; exit 2;; esac
    if curl -s -m 1 -o /dev/null "localhost:$PORT/health"; then echo "refusing: something answers on $PORT"; exit 2; fi
    echo "$DIR" > "$ST/dir"; echo "$PORT" > "$ST/port"
    printf '#!/bin/sh\nexec tmux -L probe "$@"\n' > "$ST/tmuxw"; chmod +x "$ST/tmuxw"
    board_up || exit 1
    ( cd "$DIR" && claude mcp add -s local --transport http orchestratinator "http://127.0.0.1:$PORT/mcp" \
        -H "X-Channel: probe-floor" -H "X-Agent: probe" >/dev/null 2>&1 ) || { echo "claude mcp add failed"; exit 1; }
    ( cd "$REPO" && ORCH_HOST_CONFIG=/nonexistent/host.json ORCH_URL="http://127.0.0.1:$PORT" \
        ORCH_HOST_ID=probe-rig-host ORCH_HOST_NAME=probe-rig ORCH_HOST_ROOTS="$DIR" \
        ORCH_TMUX="$ST/tmuxw" ORCH_TMUX_SESSION=p nohup node host/index.js >> "$ST/host.log" 2>&1 & echo $! > "$ST/host.pid" )
    sleep 3
    grep -q "1 desk" "$ST/host.log" && echo "up: board :$PORT, $DIR bound as probe-floor/probe, host probe-rig-host (logs in $ST)" \
      || { echo "the host did not find the desk:"; tail -5 "$ST/host.log"; exit 1; }
    ;;
  outage)
    SECS="${2:?seconds}"
    echo "before: sessions=$(sessions)"
    board_down; echo "board stopped at $(date -u +%T)"; sleep "$SECS"
    board_up || exit 1; echo "board back at $(date -u +%T)"
    MARK=$(wc -l < "$ST/host.log")
    for _ in $(seq 1 45); do
      [ "$(sessions)" = "1" ] && break; sleep 2
    done
    echo "$(date -u +%T) sessions=$(sessions)"
    tail -n +"$((MARK + 1))" "$ST/host.log" | grep -e "lost the board" -e "reconnect" || echo "(no reconnect by the host: the window came back by itself, or not at all)"
    ;;
  room)
    R=$(curl -s -X POST "localhost:$(val port)/api/floor/meeting" -H "$J" -d '{"channel":"probe-floor","agents":["probe"]}')
    ID=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin)['room']['id'])") || { echo "no room: $R"; exit 1; }
    echo "room $ID opened at $(date -u +%T)"
    for _ in $(seq 1 30); do "$ST/tmuxw" capture-pane -p -t p:probe | grep -q "Messages the operator sends" && break; sleep 2; done
    sleep 6
    curl -s -X POST "localhost:$(val port)/api/floor/meeting/end" -H "$J" -d "{\"id\":$ID,\"final\":true}" >/dev/null; echo "ended at $(date -u +%T)"
    for _ in $(seq 1 30); do "$ST/tmuxw" capture-pane -p -t p:probe | grep -q "left the meeting room" && break; sleep 2; done
    sleep 6
    curl -s "localhost:$(val port)/api/floor/turns?channel=probe-floor&agent=probe&limit=10" | python3 -c "
import sys,json
for t in json.load(sys.stdin).get('rows',[])[-6:]: print(' ', t['role'], t.get('tool_name') or '', (t.get('text') or '')[:100])"
    ;;
  down)
    [ -s "$ST/host.pid" ] && kill "$(val host.pid)" 2>/dev/null; rm -f "$ST/host.pid"
    board_down
    [ -s "$ST/dir" ] && ( cd "$(val dir)" && claude mcp remove -s local orchestratinator >/dev/null 2>&1 )
    echo "down: host and board stopped, binding removed (the probe window is probe.mjs down's)"
    ;;
  *) sed -n '2,24p' "$0"; exit 1;;
esac

#!/bin/bash
# The fixture two-rooms.mjs runs on: three real Claude Code windows, each the
# desk of its own folder, on a throwaway board with the tree's own host — the
# operator's board, host and tmux session untouched.
#
#   two-rooms-fixture.sh up   <scratch dir>   # → three desks reading held=floor
#   two-rooms-fixture.sh rows <scratch dir>   # the desks, the windows and their tags, the board's rows
#   two-rooms-fixture.sh down <scratch dir>   # leave every desk, stop it all, check nothing is left bound
#
# Between `up` and `down`:
#   ORCH_CDP_PORT=9293 node --experimental-websocket two-rooms.mjs http://localhost:8931 <scratch dir>/shots
#
# Written after doing all of this by hand (2026-11-16, 0.12.9), which took
# longer than the measurement. What it does, in the order that matters:
#
#   up    a board from the tree on PORT (8931) with a scratch database; three
#         folders under <scratch>/root bound in local scope as ms-a/qa, ms-a/dev
#         and ms-a/ops (Claude Code's own `mcp add`, which writes
#         ~/.claude.json); the tree's host on a tmux socket of its own
#         (SOCK, probems), its roots that folder alone, its seats under
#         <scratch>/seats; each desk's window opened through the floor's own
#         route; the folder-trust question each new folder asks, answered on
#         that socket (Down, Enter: the cursor starts on "No, exit"). Opening
#         a window costs no tokens.
#   down  each desk left through the floor, which is what closes its window
#         and removes its binding; then the host, the board, the socket and
#         the Chrome on CDP. It ends by reading ~/.claude.json for any probe
#         folder still bound and `claude --version` (a probe can update the
#         machine's Claude Code: SKILL.md).
#
# The board needs Node 22.14 or later (better-sqlite3 13) and this machine's
# default is 20, so NODE names the binary for it: the newest under ~/.nvm when
# unset. The host runs on whatever `node` is. Refuses a PORT that answers.
set -u
CMD="${1:-}"; S="${2:-}"
[ -n "$CMD" ] && [ -n "$S" ] || { echo "usage: two-rooms-fixture.sh up|rows|down <scratch dir>" >&2; exit 2; }
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
case "$S" in "$REPO"|"$REPO"/*) echo "refusing: the scratch directory is inside the repo ($S)" >&2; exit 2;; esac
PORT="${PORT:-8931}"; SOCK="${SOCK:-probems}"; CDP="${CDP:-9293}"; KEY="${KEY:-probe-ms}"
BASE="http://localhost:$PORT"
NODE="${NODE:-$(ls -d "$HOME"/.nvm/versions/node/v2[2-9]*/bin/node 2>/dev/null | sort -V | tail -1)}"
NODE="${NODE:-node}"
# A window started from inside a Claude Code session is a nested one unless
# these are gone (SKILL.md, "The probe inherits your environment").
for v in $(env | grep -oE '^CLAUDE[^=]*'); do unset "$v"; done
T() { tmux -L "$SOCK" "$@"; }
post() { curl -s -X POST -H "x-orchestratinator-key: $KEY" -H 'content-type: application/json' "$BASE$1" -d "$2"; }
desks() {
  curl -s -H "x-orchestratinator-key: $KEY" "$BASE/api/floor" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for c in d['channels']:
    for k in c['desks']:
        h=k.get('hosted') or {}; t=k.get('twin')
        print(f\"  {c['channel']}/{k['agent']:8} {'seat' if h.get('seat') else 'own ':4} live={h.get('live')} held={h.get('held')} session={(h.get('session_id') or '')[:8]} twin={t['of']+'#'+str(t['n']) if t else '-'} last={((k.get('last_turn') or {}).get('text') or '')[:40]!r}\")
print('  hosts:', [(h['name'], h['live'], 'seats' if h.get('seats') else 'no seats') for h in d['hosts']])"
}
held() { desks | grep -c 'held=floor'; }

case "$CMD" in
up)
  ver="$("$NODE" -p 'process.versions.node' 2>/dev/null)"
  "$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=14)?0:1)' 2>/dev/null \
    || { echo "refusing: the board needs Node 22.14+, and $NODE is ${ver:-not a node}. Set NODE=<path to one>." >&2; exit 2; }
  curl -s -m 1 -o /dev/null "$BASE/health"; [ $? -eq 7 ] || { echo "refusing: something answers on port $PORT" >&2; exit 2; }
  T has-session 2>/dev/null && { echo "refusing: a tmux server is already on socket $SOCK" >&2; exit 2; }
  mkdir -p "$S/root" "$S/seats" "$S/rec" "$S/shots"
  printf '#!/bin/sh\nexec tmux -L %s "$@"\n' "$SOCK" > "$S/tmuxw"; chmod +x "$S/tmuxw"
  rm -f "$S/board.db" "$S/board.db-wal" "$S/board.db-shm"
  ( cd "$REPO" && PORT=$PORT DB_PATH="$S/board.db" ORCH_AUTH_TOKEN=$KEY ORCH_AUTH_MODE=warn nohup "$NODE" src/server.js > "$S/rec/server.log" 2>&1 & )
  for _ in $(seq 1 40); do curl -s -m 1 "$BASE/health" >/dev/null && break; sleep 0.25; done
  curl -s -m 1 "$BASE/health" >/dev/null || { echo "the board did not come up; see $S/rec/server.log" >&2; exit 1; }
  for a in qa dev ops; do
    mkdir -p "$S/root/$a-desk"; echo "probe folder for $a" > "$S/root/$a-desk/README.md"
    ( cd "$S/root/$a-desk" && claude mcp add -s local --transport http orchestratinator "$BASE/mcp" \
        -H "X-Channel: ms-a" -H "X-Agent: $a" -H "X-Orchestratinator-Key: $KEY" >/dev/null 2>&1 ) || { echo "claude mcp add failed in $a-desk" >&2; exit 1; }
  done
  ( cd "$REPO" && ORCH_TMUX="$S/tmuxw" ORCH_TMUX_SESSION=orch ORCH_HOST_ROOTS="$S/root" ORCH_URL="$BASE" ORCH_AUTH_TOKEN=$KEY \
      ORCH_HOST_ID=probe-host ORCH_HOST_NAME='probe host' ORCH_HOST_CONFIG=/nonexistent/host.json ORCH_HOST_SEATS="$S/seats" \
      ORCH_HOST_HEARTBEAT_MS=15000 nohup node host/index.js > "$S/rec/host.log" 2>&1 & )
  for _ in $(seq 1 40); do [ "$(desks | grep -c 'live=True')" = 3 ] && break; sleep 0.5; done
  for a in qa dev ops; do post /api/floor/open "{\"channel\":\"ms-a\",\"agent\":\"$a\"}" >/dev/null; done
  # Each new folder asks the trust question before it registers. Answered on
  # this socket, where nobody else is: Down to "Yes, I trust this folder", Enter.
  for _ in $(seq 1 60); do
    [ "$(held)" = 3 ] && break
    for w in $(T list-windows -a -F '#{window_name}' 2>/dev/null); do
      if T capture-pane -p -t "orch:=$w" 2>/dev/null | grep -q 'Yes, I trust this folder'; then
        T send-keys -t "orch:=$w" Down; sleep 0.6; T send-keys -t "orch:=$w" Enter
      fi
    done
    sleep 1
  done
  desks
  [ "$(held)" = 3 ] || { echo "NOT UP: fewer than three desks read held=floor. The windows:" >&2; T list-panes -a -F '  #{window_name} pid=#{pane_pid}' >&2; exit 1; }
  echo "up: $BASE · tmux -L $SOCK · scratch $S"
  ;;
rows)
  desks
  echo "  windows:"; T list-panes -a -F '    #{window_name} seat=#{@orch_seat} pid=#{pane_pid}' 2>/dev/null || echo "    (no tmux server on $SOCK)"
  echo "  seats on the host's record: $(tr -d '\n ' < "$S/seats/seats.json" 2>/dev/null || echo none)"
  ( cd "$REPO" && "$NODE" -e '
    const db = new (require("better-sqlite3"))(process.argv[1], { readonly: true });
    const all = (q, ...a) => db.prepare(q).all(...a);
    console.log("  seats:", all("SELECT channel, agent, assigned_at FROM personas").map((r) => `${r.channel}/${r.agent}@${r.assigned_at.slice(11)}`).join(" "));
    console.log("  second sessions:", JSON.stringify(all("SELECT channel, agent, base, n, for_meeting FROM desk_twins")));
    console.log("  conversations:", all("SELECT agent, substr(session_id,1,8) s, runner, ended_at FROM agent_sessions").map((r) => `${r.agent}:${r.s}:${r.runner}${r.ended_at ? ":ended" : ""}`).join(" "));
    for (const r of all("SELECT action, actor, target, created_at FROM admin_events WHERE action LIKE ? ORDER BY id", "desk.%")) console.log(`    ${r.created_at.slice(11)} ${r.action} ${r.target} (${r.actor})`);
  ' "$S/board.db" )
  ;;
down)
  for k in $(curl -s -H "x-orchestratinator-key: $KEY" "$BASE/api/floor" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
# seats first: leaving the folder's own desk does not take its seats with it
ds=[(c['channel'],k['agent'],bool((k.get('hosted') or {}).get('seat'))) for c in d['channels'] for k in c['desks'] if (k.get('hosted') or {}).get('live')]
for ch,a,s in sorted(ds, key=lambda x: not x[2]): print(ch+'|'+a)" 2>/dev/null); do
    post /api/floor/desk/leave "{\"channel\":\"${k%%|*}\",\"agent\":\"${k##*|}\"}" >/dev/null; sleep 3
  done
  for p in $(ps -Ao pid,command | grep -E 'node[^ ]* (src/server.js|host/index.js)$' | awk '{print $1}'); do
    ps eww -o command= -p "$p" | grep -q "PORT=$PORT\|ORCH_HOST_ID=probe-host" && kill "$p" && echo "stopped probe process $p"
  done
  T kill-server 2>/dev/null
  pkill -f "remote-debugging-port=$CDP( |\$)" 2>/dev/null
  left="$(python3 -c "
import json,os,sys
j=json.load(open(os.path.expanduser('~/.claude.json')))
print(' '.join(k for k,v in j.get('projects',{}).items() if k.startswith(os.path.realpath(sys.argv[1])) and (v.get('mcpServers') or {})))" "$S/root" 2>/dev/null)"
  for d in $left; do ( cd "$d" && claude mcp remove -s local orchestratinator >/dev/null 2>&1 ) && echo "removed a binding the leave did not: $d"; done
  curl -s -m 1 -o /dev/null "$BASE/health"; echo "board on $PORT: $([ $? -eq 7 ] && echo gone || echo STILL ANSWERING)"
  echo "probe folders still bound in ~/.claude.json: ${left:-none}"
  echo "claude: $(claude --version 2>&1)"
  ;;
*) echo "usage: two-rooms-fixture.sh up|rows|down <scratch dir>" >&2; exit 2;;
esac

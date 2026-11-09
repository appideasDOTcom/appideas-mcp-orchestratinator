#!/bin/bash
# Two throwaway instances from a tree, a host for each, and a tmux server of
# their own: the rig for anything that happens BETWEEN instances on one
# machine (a release, task 292). Nothing of it is visible to the live host:
# the folder is in a directory of yours, both hosts' roots are only that
# directory, and their windows are on a tmux socket named for the rig.
#
#   two-instances.sh up   <dir> [tree]      # servers on $PORT_A/$PORT_B, hosts rel-host-a/-b, one tmux session `orch`
#   two-instances.sh api  <dir> a|b METHOD /path ['{"json":…}']
#   two-instances.sh tmux <dir> <tmux args…>   # the rig's own tmux server (capture-pane, send-keys, list-panes -a)
#   two-instances.sh hosts <dir> [tree]     # stop and start the two hosts only (after editing host/*.js)
#   two-instances.sh down <dir>
#
# <dir> holds everything: root/ (put the probe folder there, make-probe.sh),
# rec/host-a.log and host-b.log with every line stamped to the millisecond,
# a.db, b.db, and the pid files. Keys are probe-a and probe-b. Both hosts
# use the session name `orch` on purpose: two hosts in one session is the
# case on an operator's machine that runs two instances.
#
# Everything is stopped by the pid it was started with. Not by a pattern:
# `pkill -f host/index.js` is the live host too, and a `ps | grep` in a
# command that itself names host/index.js kills the shell running it (exit
# 144; it happened building this).
set -u
CMD="${1:?up|api|tmux|hosts|down}"; E="$(mkdir -p "${2:?a directory for the rig}" && cd "$2" && pwd)"
PORT_A="${PORT_A:-8962}"; PORT_B="${PORT_B:-8963}"
SOCK="rig$(printf '%s' "$E" | shasum | cut -c1-8)"
stamp() { perl -MTime::HiRes=time -ne 'BEGIN{$|=1} my $t=time; my @g=gmtime($t); printf "%02d:%02d:%02d.%03d %s",$g[2],$g[1],$g[0],($t-int($t))*1000,$_'; }
start_hosts() {
  cd "$1" || exit 2
  # The host hands its environment to every window it opens: not a nested session's.
  for v in $(env | grep -oE "^CLAUDE[^=]*"); do unset "$v"; done
  for x in "a:$PORT_A" "b:$PORT_B"; do
    n=${x%%:*}; port=${x##*:}
    # Every stream of the pair goes to the log or nowhere. Left on this
    # script's stdout, a host outlives the script holding it open, and
    # `two-instances.sh up … | tail` never returns (it did not, once).
    ( ORCH_TMUX="$E/tmuxw" ORCH_TMUX_SESSION=orch ORCH_HOST_ROOTS="$E/root" ORCH_URL="http://localhost:$port" ORCH_AUTH_TOKEN="probe-$n" \
        ORCH_HOST_ID="rel-host-$n" ORCH_HOST_NAME="host of instance $n" ORCH_HOST_CONFIG=/nonexistent/host.json \
        nohup node host/index.js 2>&1 & echo $! > "$E/host-$n.pid"; wait ) </dev/null 2>/dev/null | stamp >> "$E/rec/host-$n.log" 2>/dev/null &
  done
  sleep 3
}
stop_hosts() { for n in a b; do [ -f "$E/host-$n.pid" ] && kill "$(cat "$E/host-$n.pid")" 2>/dev/null; rm -f "$E/host-$n.pid"; done; sleep 1; }
case "$CMD" in
  up)
    TREE="$(cd "${3:-$PWD}" && pwd)"; mkdir -p "$E/root" "$E/rec"
    for p in "$PORT_A" "$PORT_B"; do curl -s -m 1 -o /dev/null "localhost:$p/health"; [ $? -eq 7 ] || { echo "refusing: port $p is taken"; exit 2; }; done
    printf '#!/bin/sh\nexec tmux -L %s "$@"\n' "$SOCK" > "$E/tmuxw"; chmod +x "$E/tmuxw"
    ( cd "$TREE" && . scripts/node-floor.sh >/dev/null 2>&1
      for x in "a:$PORT_A" "b:$PORT_B"; do
        n=${x%%:*}; port=${x##*:}
        PORT=$port DB_PATH="$E/$n.db" ORCH_AUTH_TOKEN="probe-$n" ORCH_AUTH_MODE=enforce nohup node src/server.js </dev/null > "$E/rec/server-$n.log" 2>&1 & echo $! > "$E/server-$n.pid"
      done )
    for p in "$PORT_A" "$PORT_B"; do for _ in $(seq 1 40); do curl -sf -m 1 "localhost:$p/health" >/dev/null && break; sleep 0.25; done; done
    start_hosts "$TREE"
    for p in "$PORT_A" "$PORT_B"; do curl -s -m 2 "localhost:$p/health" | cut -c1-110; echo; done
    echo "hosts: $(cat "$E/host-a.pid" 2>/dev/null) $(cat "$E/host-b.pid" 2>/dev/null) · tmux socket $SOCK ($E/tmuxw) · probe folders go in $E/root"
    ;;
  hosts) stop_hosts; start_hosts "$(cd "${3:-$PWD}" && pwd)"; tail -1 "$E/rec/host-a.log" | cut -c1-160; tail -1 "$E/rec/host-b.log" | cut -c1-160 ;;
  api)
    case "${3:?a|b}" in a) port=$PORT_A;; b) port=$PORT_B;; *) echo "a or b"; exit 2;; esac
    if [ -n "${6:-}" ]; then curl -s -m 10 -X "$4" "localhost:$port$5" -H 'content-type: application/json' -H "x-orchestratinator-key: probe-$3" -d "$6"
    else curl -s -m 10 -X "${4:?METHOD}" "localhost:$port${5:?/path}" -H "x-orchestratinator-key: probe-$3"; fi
    echo ;;
  tmux) shift 2; exec "$E/tmuxw" "$@" ;;
  down)
    stop_hosts
    for n in a b; do [ -f "$E/server-$n.pid" ] && kill "$(cat "$E/server-$n.pid")" 2>/dev/null; rm -f "$E/server-$n.pid"; done
    [ -x "$E/tmuxw" ] && "$E/tmuxw" kill-server 2>/dev/null
    sleep 1
    for p in "$PORT_A" "$PORT_B"; do curl -s -m 1 -o /dev/null "localhost:$p/health"; [ $? -eq 7 ] && echo "port $p: nothing there" || echo "port $p: STILL ANSWERING"; done
    echo "left in place: $E (logs, databases). A probe folder's binding is removed by leaving its desk from a floor BEFORE down."
    ;;
  *) echo "up|api|tmux|hosts|down"; exit 2 ;;
esac

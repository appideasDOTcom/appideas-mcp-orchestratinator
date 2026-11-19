#!/bin/bash
# The page checks owed at a release, one at a time, in a copy of the tree
# outside the repo, with a verdict line each and one at the end.
#
#   .claude/skills/verify-ui-change/run-release-pages.sh                # all thirteen
#   .claude/skills/verify-ui-change/run-release-pages.sh card-move hide # some of them
#
# Written after PR #57 (2026-11-17), whose release run did this by hand:
# six checks have a run-check-*.sh, and card-move, hide and update did not,
# so their server, seed and Chrome were composed at the prompt, and the hide
# run died on a shots folder that did not exist. That took three tries in
# front of costmo at the end of a long review. Run this instead.
#
# The copy is taken once from the working tree (copy-repo.sh), so the tree
# is never touched while it runs: a PR being closed must not move. Ports are
# 8941-8953 and CDP 9311-9323, one pair per check (floor-windows, the
# twelfth, from task 315; attention, the thirteenth, from the app's tab
# and tray round, 2026-11-19); a pair that is taken is
# refused by the runners, so read the channel for QA's ports first. Run it
# after the full `npm test`, never beside it: two tmux-driving suites, or a
# suite and these Chromes, on one machine is what made PR #57's Info 12.
#
# check-hide asserts nothing of its own (its rows are in test:floor); it is
# PASS when it runs to its last step, and its printed steps are the reading.
# check-card-move and check-hide have no run-check-*.sh of their own; their
# fixture (a server, the seed that is also their host) is started here.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
. "$REPO/scripts/node-floor.sh" || exit 2
ALL="backdrop chat-controls chatbox pop-foot popout popout-session card-move hide update attach attach-meeting floor-windows attention"
LIST="${*:-$ALL}"
COPY="$("$REPO/.claude/skills/mutate-in-a-copy/copy-repo.sh" "${TMPDIR:-/tmp}/orch-release-pages")" || exit 2
OUT="$(mktemp -d "${TMPDIR:-/tmp}/release-pages-out.XXXXXX")"
HEAD="$(cd "$REPO" && git rev-parse --short HEAD)$(cd "$REPO" && [ -n "$(git status --porcelain)" ] && echo ' + uncommitted')"
echo "### release page checks · $HEAD · copy $COPY · logs $OUT"
cd "$COPY" || exit 2
up() { for _ in $(seq 1 40); do curl -s -m 1 "localhost:$1/health" >/dev/null && return 0; sleep 0.25; done; return 1; }
n=0; red=0
for c in $LIST; do
  n=$((n + 1)); PORT=$((8940 + n)); CDP=$((9310 + n)); LOG="$OUT/$c.log"
  case "$c" in
    card-move|hide)
      W="$(mktemp -d "${TMPDIR:-/tmp}/release-$c.XXXXXX")"
      PORT=$PORT DB_PATH="$W/r.db" ORCH_AUTH_TOKEN=k node src/server.js > "$W/server.log" 2>&1 & SRV=$!
      up $PORT || { echo "check-$c: the server did not start"; red=$((red + 1)); continue; }
      if [ "$c" = card-move ]; then
        node .claude/skills/verify-ui-change/seed-move.mjs "http://localhost:$PORT" "$W/r.db" > "$W/work.jsonl" 2> "$W/seed.err" & SEED=$!
        sleep 3
        ORCH_CDP_PORT=$CDP node --experimental-websocket .claude/skills/verify-ui-change/check-card-move.mjs "http://localhost:$PORT" "$W/shots" "$W/work.jsonl" > "$LOG" 2>&1; rc=$?
      else
        node .claude/skills/verify-ui-change/seed-hide.mjs "http://localhost:$PORT" "$W/r.db" > "$W/seed.log" 2>&1 & SEED=$!
        sleep 3
        ORCH_CDP_PORT=$CDP node --experimental-websocket .claude/skills/verify-ui-change/check-hide.mjs "http://localhost:$PORT" "$W/shots" "$W/r.db" > "$LOG" 2>&1; rc=$?
        grep -q '^shots in ' "$LOG" || rc=3
      fi
      kill $SEED $SRV 2>/dev/null; wait $SEED $SRV 2>/dev/null
      pkill -f "remote-debugging-port=$CDP( |\$)" 2>/dev/null ;;
    update)
      node --experimental-websocket .claude/skills/verify-ui-change/check-update.mjs "$PWD" $PORT $((PORT + 20)) $CDP "$OUT/shots-update" > "$LOG" 2>&1; rc=$?
      pkill -f "remote-debugging-port=$CDP( |\$)" 2>/dev/null ;;
    *)
      PORT=$PORT CDP=$CDP .claude/skills/verify-ui-change/run-check-$c.sh "$COPY" > "$LOG" 2>&1; rc=$? ;;
  esac
  verdict="$(grep -E '^(PASS|FAIL)|PASS ·|FAIL ·|✗ · FAIL' "$LOG" | tail -1 | cut -c1-80)"
  [ "$c" = hide ] && [ $rc -eq 0 ] && verdict="PASS · ran to its last step (it asserts nothing; read its steps in the log)"
  reds="$(grep -c '✗' "$LOG")"
  [ $rc -eq 0 ] && [ "$reds" -eq 0 ] || red=$((red + 1))
  echo "check-$c · exit $rc · ✓ $(grep -c '✓' "$LOG") ✗ $reds · ${verdict:-no verdict line} · load $(/usr/sbin/sysctl -n vm.loadavg)"
  grep '✗' "$LOG" | head -5 | cut -c1-220 | sed 's/^/    /'
  [ $rc -eq 3 ] && { echo "    did not finish:"; tail -4 "$LOG" | sed 's/^/    /'; }
done
echo "### $((n - red)) of $n passed · logs $OUT"
[ $red -eq 0 ]

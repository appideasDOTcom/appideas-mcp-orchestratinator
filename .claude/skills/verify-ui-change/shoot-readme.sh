#!/bin/sh
# Every image the docs use, end to end, from a fresh fixture: the README's
# five and docs/operating.md's five, plus the landing set with --landing:
#
#   .claude/skills/verify-ui-change/shoot-readme.sh [repo] [--landing]
#
# Starts a throwaway server on :8906 with ./data/landing.db (the path the
# page header prints, so never a home-directory path), the fixture, and the
# host that answers the meeting room; runs landing-shot.mjs and
# readme-shot.mjs; copies the five into docs/images under the README's
# names; and tears everything down, its own Chrome included. With
# --landing it also refreshes docs/review/landing/ from the same run.
#
# Its Chrome is on CDP 9273, never drive.mjs's default 9222: QA keeps a
# Chrome on 9222, drive.mjs reuses whatever is on its port, and the teardown
# kills by port. Run on 9222, this would shoot through QA's browser and then
# kill it.
#
# Read the images afterwards; a green run proves only that every wait was met.
set -u
# A Node that can load better-sqlite3 13, or a refusal in words: this machine's
# default node segfaults on it silently (scripts/node-floor.sh has the why).
. "$(cd "$(dirname "$0")/../../.." && pwd)/scripts/node-floor.sh" || exit 2
REPO=${1:-$PWD}
LANDING=${2:-}
cd "$REPO" || exit 1
SK=.claude/skills/verify-ui-change
OUT=$(mktemp -d "${TMPDIR:-/tmp}/readme-shots.XXXXXX")
CDP=9273
PIDS=""

down() {
  for p in $PIDS; do kill "$p" 2>/dev/null; done
  pkill -f "remote-debugging-port=$CDP( |$)" 2>/dev/null
  sleep 1
  rm -f data/landing.db data/landing.db-wal data/landing.db-shm
}
trap down EXIT INT TERM

rm -f data/landing.db data/landing.db-wal data/landing.db-shm
PORT=8906 DB_PATH=./data/landing.db ORCH_AUTH_TOKEN=k node src/server.js > "$OUT/server.log" 2>&1 & PIDS="$PIDS $!"
sleep 1.5
node $SK/landing-seed.mjs > "$OUT/seed.log" 2>&1 & PIDS="$PIDS $!"
node $SK/landing-host.mjs > "$OUT/host.log" 2>&1 & PIDS="$PIDS $!"
sleep 6
grep -q "heartbeat running" "$OUT/seed.log" || { echo "seed did not come up:"; tail -5 "$OUT/seed.log"; exit 1; }

export ORCH_CDP_PORT=$CDP
node --experimental-websocket $SK/landing-shot.mjs "$OUT" || { echo "landing-shot failed"; exit 1; }
# Before readme-shot: its meeting room adds turns, and operating.md's images are the seed as it stands.
node --experimental-websocket $SK/operating-shot.mjs "$OUT" || { echo "operating-shot failed"; exit 1; }
node --experimental-websocket $SK/readme-shot.mjs "$OUT" || { echo "readme-shot failed"; exit 1; }

cp "$OUT/02-building.png" docs/images/building.png
cp "$OUT/01-room-prompt.png" docs/images/room.png
cp "$OUT/05-board-activity.png" docs/images/board.png
cp "$OUT/meeting-room.png" "$OUT/popouts.png" docs/images/
# operating.md draws the meeting room at 700 CSS, 1:1 with the landing capture.
cp "$OUT/06-meeting-room.png" docs/images/meeting-room-700.png
for f in board-offline board-card board-activity floor-desk floor-panel; do cp "$OUT/$f.png" docs/images/; done
if [ "$LANDING" = "--landing" ]; then
  cp "$OUT"/0[1-6]-*.png docs/review/landing/
fi
echo "wrote docs/images${LANDING:+ and docs/review/landing} (shots kept in $OUT)"

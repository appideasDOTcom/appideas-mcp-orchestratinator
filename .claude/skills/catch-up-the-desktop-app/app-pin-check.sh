#!/bin/sh
# Is the desktop app running the Orchestratinator commit you think it is?
#
#   .claude/skills/catch-up-the-desktop-app/app-pin-check.sh [<commit>] [<app repo>]
#
# Reads only. Compares every file under host/, src/ and plugin/ in the app's
# installed copy (node_modules/appideas-mcp-orchestratinator) with the same
# file at <commit> in this repo (default: origin/develop), names each file
# that differs, and prints the commit the app's lockfile resolves, the app's
# board (/health) and its host's row. Exit 0 when every file is the same.
#
# Why a script: "the app is on c64ed76" was claimed from the lockfile, and a
# lockfile is what npm was asked for, not what is on disk. `npm install` keeps
# an old commit however far the branch has gone, and the app that is running
# is whatever was built when it started.
set -u
HERE=$(cd "$(dirname "$0")/../../.." && pwd)
COMMIT=${1:-origin/develop}
APP=${2:-$HERE/../orchestratinator-desktop}
PKG=$APP/node_modules/appideas-mcp-orchestratinator
[ -d "$PKG" ] || { echo "no installed copy at $PKG: is $APP the app's repo, and has npm install run?" >&2; exit 2; }
SHA=$(git -C "$HERE" rev-parse --verify -q "$COMMIT^{commit}") || { echo "no commit $COMMIT in $HERE (git fetch?)" >&2; exit 2; }
echo "comparing $PKG"
echo "     with $(git -C "$HERE" log --oneline -1 "$SHA")"
echo "lockfile resolves: $(grep -A3 '"node_modules/appideas-mcp-orchestratinator"' "$APP/package-lock.json" 2>/dev/null | grep -o '#[0-9a-f]\{40\}' | cut -c2-13 || echo '(no lockfile entry)')"
bad=0; n=0
for f in $(git -C "$HERE" ls-tree -r --name-only "$SHA" -- host src plugin .claude-plugin); do
  n=$((n+1))
  if [ ! -f "$PKG/$f" ]; then echo "  MISSING in the app: $f"; bad=$((bad+1)); continue; fi
  a=$(shasum -a 256 "$PKG/$f" | cut -d' ' -f1)
  b=$(git -C "$HERE" show "${SHA}:$f" | shasum -a 256 | cut -d' ' -f1)
  [ "$a" = "$b" ] || { echo "  DIFFERS: $f"; bad=$((bad+1)); }
done
echo "$n files read, $bad not the commit's"
PORT=${APP_BOARD_PORT:-6724}
H=$(curl -s -m 4 "http://127.0.0.1:$PORT/health") && [ -n "$H" ] && {
  echo "board on $PORT: $(printf '%s' "$H" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('version'),'protocol',d.get('protocol'))")"
  curl -s -m 4 "http://127.0.0.1:$PORT/api/floor" | python3 -c "
import json,sys
for h in json.load(sys.stdin).get('hosts',[]): print('  host',h['host_id'],'live' if h['live'] else 'NOT live','refused: '+h['refused'] if h.get('refused') else '')"
} || echo "no board answering on 127.0.0.1:$PORT (the app is not running, or runs elsewhere: APP_BOARD_PORT=)"
[ "$bad" -eq 0 ]

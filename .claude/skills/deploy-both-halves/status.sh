#!/bin/bash
# What is actually running on the live board, set against the tree — before a
# deploy and again after it. Read-only. Every line is a reading, not a guess:
#
#   .claude/skills/deploy-both-halves/status.sh [symbol ...]
#
# Each symbol given is grepped in the served /floor.js, the served /app.js and
# the container's /app/src/floor.js, so "did my change reach the server half"
# is a count and not a feeling. The host half is the pid's start time against
# host/*.js mtimes — a running process older than the file is the most common
# reason a fix "didn't work" (CLAUDE.md, The host).
set -u
cd "$(dirname "$0")/../../.." || exit 1
echo "== tree"
git fetch -q origin develop 2>/dev/null
echo "HEAD $(git rev-parse --short HEAD)  origin/develop $(git rev-parse --short origin/develop 2>/dev/null)  dirty files: $(git status --short | wc -l | tr -d ' ')"
echo "== server half"
curl -s localhost:8787/health; echo
docker inspect -f 'container created={{.Created}} started={{.State.StartedAt}}' appideas-orchestratinator 2>/dev/null
for sym in "$@"; do
  printf '  %-28s served floor.js=%s app.js=%s container src/floor.js=%s\n' "$sym" \
    "$(curl -s localhost:8787/floor.js | grep -c -- "$sym")" \
    "$(curl -s localhost:8787/app.js | grep -c -- "$sym")" \
    "$(docker compose exec -T orchestratinator grep -c -- "$sym" /app/src/floor.js 2>/dev/null | tr -d '\r')"
done
echo "== host half"
for p in $(pgrep -f 'host/index.js'); do
  echo "pid $p started $(ps -o lstart= -p "$p")"
done
echo "newest host/*.js: $(ls -t host/*.js | head -1) modified $(stat -f '%Sm' "$(ls -t host/*.js | head -1)")"
line=$(grep -n '\[host\] costmo4\|\[host\] .* → http' ~/.orchestratinator/log/host.log | tail -1)
echo "last registration: ${line:-none}"
n=${line%%:*}
if [ -n "$n" ]; then tail -n +"$n" ~/.orchestratinator/log/host.log | grep -v '^\[host\]   ' | grep -i 'warn\|error\|skipping' | head -3; fi

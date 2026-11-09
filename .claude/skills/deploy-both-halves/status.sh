#!/bin/bash
# What is actually running on the live board, set against the tree — before a
# deploy and again after it. Read-only. Every line is a reading, not a guess:
#
#   .claude/skills/deploy-both-halves/status.sh [symbol ...]
#
# Each symbol given is grepped in the served /floor.js and /app.js, in the
# container's page (/app/src/ui/floor.js) and in its server module
# (/app/src/floor.js), so "did my change reach the server half" is a count
# and not a feeling. The page and the module share a name: a page symbol
# reads 0 in the module however well the rebuild took (2026-11-05, #43). The host half is the pid's start time against
# host/*.js mtimes — a running process older than the file is the most common
# reason a fix "didn't work" (CLAUDE.md, The host).
set -u
cd "$(dirname "$0")/../../.." || exit 1
echo "== tree"
git fetch -q origin 2>/dev/null
# What deploys is HEAD. Its own upstream says whether it is pushed; develop is
# beside it for information only (SKILL.md, "Before touching anything").
echo "HEAD $(git rev-parse --short HEAD) on $(git rev-parse --abbrev-ref HEAD)  upstream $(git rev-parse --short '@{u}' 2>/dev/null || echo none)  origin/develop $(git rev-parse --short origin/develop 2>/dev/null)  dirty files: $(git status --short | wc -l | tr -d ' ')"
echo "== server half"
curl -s localhost:8787/health; echo
# The protocol each side speaks (0.12.5). A board that carries none is a
# build from before there was one. Unequal is not a fault before a deploy; it
# is the reading that says the host must be restarted with this one.
printf 'protocol: board=%s  tree=%s  tree host=%s\n' \
  "$(curl -s localhost:8787/health | python3 -c 'import sys,json; print(json.load(sys.stdin).get("protocol"))' 2>/dev/null)" \
  "$(python3 -c 'import json; print(json.load(open("package.json")).get("protocol"))')" \
  "$(python3 -c 'import json; print(json.load(open("host/package.json")).get("protocol"))')"
docker inspect -f 'container created={{.Created}} started={{.State.StartedAt}}' appideas-orchestratinator 2>/dev/null
for sym in "$@"; do
  printf '  %-28s served floor.js=%s app.js=%s · container src/ui/floor.js=%s src/floor.js=%s\n' "$sym" \
    "$(curl -s localhost:8787/floor.js | grep -c -- "$sym")" \
    "$(curl -s localhost:8787/app.js | grep -c -- "$sym")" \
    "$(docker compose exec -T orchestratinator grep -c -- "$sym" /app/src/ui/floor.js 2>/dev/null | tr -d '\r')" \
    "$(docker compose exec -T orchestratinator grep -c -- "$sym" /app/src/floor.js 2>/dev/null | tr -d '\r')"
done
echo "== host half"
# The host is launchd's job's pid. A match on the command line alone is not:
# on 2026-11-05 another session's watch loop, waiting for this very deploy,
# had host/index.js in its zsh -c line and read as a second host. Any other
# node running host/index.js is listed as what it is, because two hosts would
# be a real fault.
job=$(launchctl print "gui/$(id -u)/com.appideas.orchestratinator-host" 2>/dev/null | awk '/^\tpid = /{print $3; exit}')
if [ -n "$job" ]; then echo "pid $job started $(ps -o lstart= -p "$job")  (launchd's)"; else echo "pid none — the launchd job is not running"; fi
for p in $(pgrep -f 'host/index.js'); do
  [ "$p" = "$job" ] && continue
  case "$(ps -o comm= -p "$p")" in
    *node) echo "ANOTHER HOST: pid $p started $(ps -o lstart= -p "$p") — not launchd's";;
  esac
done
# What the board says of its hosts. `refused` in words is a host whose
# protocol the board would not take: expected between the two halves of a
# deploy that moves the number, and a fault once both are done.
curl -s localhost:8787/api/floor | python3 -c '
import sys, json
try: hosts = json.load(sys.stdin).get("hosts", [])
except Exception as e: print("hosts on the board: unreadable (%s)" % e); sys.exit()
for h in hosts: print("host on the board: %s live=%s last_seen=%s refused=%s" % (h.get("name"), h.get("live"), h.get("last_seen"), h.get("refused")))
if not hosts: print("hosts on the board: none")'
echo "newest host/*.js: $(ls -t host/*.js | head -1) modified $(stat -f '%Sm' "$(ls -t host/*.js | head -1)")"
line=$(grep -n '\[host\] costmo4\|\[host\] .* → http' ~/.orchestratinator/log/host.log | tail -1)
echo "last registration: ${line:-none}"
n=${line%%:*}
# The desk list under the banner is indented after the tag, and is left out so
# a folder name cannot pass for a warning. Since issue #5 a line carries its
# UTC time between the tag and the words (`[host] 2026-11-03T19:54:18.123Z …`)
# and the file holds both shapes, so the indent is looked for after either.
if [ -n "$n" ]; then tail -n +"$n" ~/.orchestratinator/log/host.log | grep -Ev '^\[host\] ([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z )?  ' | grep -i 'warn\|error\|skipping' | head -3; fi

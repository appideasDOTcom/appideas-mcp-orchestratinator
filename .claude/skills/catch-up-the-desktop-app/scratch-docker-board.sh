#!/bin/sh
# A "local Docker board" to test the desktop app's connect against, that is
# not the operator's live one.
#
#   .claude/skills/catch-up-the-desktop-app/scratch-docker-board.sh up [<port>]    # default 8981
#   .claude/skills/catch-up-the-desktop-app/scratch-docker-board.sh status
#   .claude/skills/catch-up-the-desktop-app/scratch-docker-board.sh down
#
# `up` builds this tree's image under its own tag and runs it under its own
# name, port (loopback only) and volume, with auth enforced and a key made
# for it, then reads /health and a keyless register (401). It prints how the
# app finds the key with nothing typed (docker inspect). `down` removes the
# container, the volume and the image.
#
# Never `docker compose up` here: compose names the container
# appideas-orchestratinator and publishes 8787, which are the live board's
# (CLAUDE.md, "The live instance runs from its own clone"). This refuses
# 8787 and 6724 (the app's own board) outright.
set -eu
HERE=$(cd "$(dirname "$0")/../../.." && pwd)
NAME=orch-dev-scratch; TAG=orch-dev-scratch:develop; VOL=orch-dev-scratch-data
case "${1:-}" in
  up)
    PORT=${2:-8981}
    case "$PORT" in 8787|6724) echo "refusing port $PORT: 8787 is the live board's and 6724 is the desktop app's own" >&2; exit 2 ;; esac
    docker ps -a --format '{{.Names}}' | grep -qx "$NAME" && { echo "$NAME already exists: \`$0 status\` or \`$0 down\`" >&2; exit 2; }
    docker build -q --build-context gitmeta="$HERE/.git" -t "$TAG" "$HERE" >/dev/null
    KEY=$(openssl rand -hex 24)
    docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8787" -e ORCH_AUTH_TOKEN="$KEY" -e ORCH_AUTH_MODE=enforce \
      -e PORT=8787 -e DB_PATH=/data/orchestratinator.db -e CLAIM_TTL_MINUTES=15 -e SESSION_TTL_MINUTES=15 -e STATUS_TTL_SECONDS=900 \
      -v "$VOL:/data" "$TAG" >/dev/null
    i=0; until curl -s -m 2 "http://127.0.0.1:$PORT/health" | grep -q '"ok":true'; do i=$((i+1)); [ $i -gt 30 ] && { echo "no /health on $PORT after 30 s:" >&2; docker logs --tail 20 "$NAME" >&2; exit 1; }; sleep 1; done
    echo "up: http://127.0.0.1:$PORT  $(curl -s "http://127.0.0.1:$PORT/health" | cut -c1-110)…"
    echo "a register with no key answers $(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/host/register" -H 'content-type: application/json' -d '{}') (401 is auth enforced)"
    echo "the key, as the app reads it:  docker inspect $NAME --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^ORCH_AUTH_TOKEN='"
    echo "found by port:                 docker ps --filter publish=$PORT --format '{{.ID}} {{.Names}}'"
    ;;
  status)
    docker ps -a --filter "name=^${NAME}$" --format '{{.Names}}  {{.Status}}  {{.Ports}}' | grep . || { echo "no $NAME container"; exit 1; }
    ;;
  down)
    docker rm -f "$NAME" >/dev/null 2>&1 && echo "removed container $NAME" || echo "no container $NAME"
    docker volume rm "$VOL" >/dev/null 2>&1 && echo "removed volume $VOL" || echo "no volume $VOL"
    docker rmi "$TAG" >/dev/null 2>&1 && echo "removed image $TAG" || echo "no image $TAG"
    ;;
  *) echo "usage: $0 up [<port>] | status | down" >&2; exit 2 ;;
esac

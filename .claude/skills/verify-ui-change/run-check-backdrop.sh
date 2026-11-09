#!/bin/bash
# check-backdrop.mjs with its whole fixture, served from any directory:
# the repo, or a copy holding another commit's src/ or a mutant.
#
#   run-check-backdrop.sh <dir> [after|before]          # → the check's table on stdout
#   PORT=8912 CDP=9254 run-check-backdrop.sh "$PWD" after
#
# It starts a server from <dir> on a scratch DB, seed-desk.mjs and
# answering-host.mjs on that same DB, runs the check and kills all three.
# Pass --db on every call: seed-desk's default is ./data/scratch.db, and a
# server on another DB then serves a board with no desk on it.
#
# At a base SHA (PR #36 round 1, mutate-in-a-copy):
#   CP="$(.claude/skills/mutate-in-a-copy/copy-repo.sh "$TMPDIR/orch-base")"
#   for f in $(git diff --name-only <sha> HEAD -- src/); do git show <sha>:$f > "$CP/$f"; done
#   .claude/skills/verify-ui-change/run-check-backdrop.sh "$CP" before
# The copy keeps today's check and drive.mjs, so it is today's check at the
# old page. A full run takes about 2.5 minutes. Announce PORT and CDP first.
set -u
# A Node that can load better-sqlite3 13, or a refusal in words: this machine's
# default node segfaults on it silently (scripts/node-floor.sh has the why).
. "$(cd "$(dirname "$0")/../../.." && pwd)/scripts/node-floor.sh" || exit 2
C="$(cd "$1" && pwd)"; EXP="${2:-after}"; PORT="${PORT:-8912}"; CDP="${CDP:-9254}"
S="$(mktemp -d "${TMPDIR:-/tmp}/check-backdrop.XXXXXX")"
# Both ports must be free, and "free" means nothing accepts the connection
# (curl's 7). drive.mjs's browser() reuses any Chrome already on CDP, and
# the pkill at the end kills what is on it, so a CDP port another session
# holds was driven and then killed (QA, PR #38 finding 1: a stand-in on
# 9273 ran the whole check and was dead after). Refused here, the Chrome
# on CDP at the end is one this run started.
taken() { curl -s -m 1 -o /dev/null "localhost:$1/$2"; [ $? -ne 7 ]; }
if taken "$PORT" health; then echo "refusing: PORT $PORT is taken"; exit 2; fi
if taken "$CDP" json/version; then echo "refusing: CDP $CDP is taken (another session's Chrome?)"; exit 2; fi
cd "$C" || exit 2
echo "### $C · --expect $EXP · app.js $(shasum -a 256 src/ui/app.js | cut -c1-8) · drive.mjs $(shasum -a 256 .claude/skills/verify-ui-change/drive.mjs | cut -c1-8) · $(date -u +%FT%TZ)"
PORT=$PORT DB_PATH="$S/r.db" ORCH_AUTH_TOKEN=k node src/server.js > "$S/server.log" 2>&1 & SRV=$!
for _ in $(seq 1 40); do curl -s -m 1 "localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
node .claude/skills/verify-ui-change/seed-desk.mjs "http://localhost:$PORT" --db "$S/r.db" --unread 2 > "$S/seed.log" 2>&1 & SEED=$!
sleep 2
node .claude/skills/verify-ui-change/answering-host.mjs "http://localhost:$PORT" --db "$S/r.db" > "$S/host.jsonl" 2> "$S/host.err" & AH=$!
sleep 1
ORCH_CDP_PORT=$CDP node --experimental-websocket .claude/skills/verify-ui-change/check-backdrop.mjs \
  "http://localhost:$PORT" --expect "$EXP" 2> "$S/check.err" | tee "$S/out.txt"; rc=${PIPESTATUS[0]}
kill $AH $SEED $SRV 2>/dev/null; wait $AH $SEED $SRV 2>/dev/null
# The port and nothing longer: a bare "=9254" also matches "=92540".
pkill -f "remote-debugging-port=$CDP( |\$)" 2>/dev/null
# Chrome takes a moment to go on SIGTERM, and until it has, the next run on
# this CDP would be refused as taken — run-page-mutant.sh runs this back to
# back. Wait for the port, up to 10 s.
for _ in $(seq 1 40); do taken "$CDP" json/version || break; sleep 0.25; done
# A crash exits 1 like a FAIL, so the verdict line is what says the check ran
# to its end (a waitFor that timed out is a check that did not finish).
grep -qE '^(PASS|FAIL) ' "$S/out.txt" || { echo "-- THE CHECK DID NOT FINISH; its stderr:"; tail -5 "$S/check.err"; rc=3; }
echo "-- exit $rc · fixture logs in $S"
exit $rc

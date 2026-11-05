#!/bin/bash
# One PAGE mutant, in the copy: apply it, run a page check against the
# copy's own server, report the check's red lines, put the file back.
#
#   cd "$(copy-repo.sh "$TMPDIR/orch-page-copy")"
#   run-page-mutant.sh "<what is now wrong>" <file> '<old>' '<new>' '<check command>'
#
# The check command runs in the copy under bash and must start what it
# needs and kill it again — a server from the copy on a private port, the
# seed, the verify-ui-change check — so the mutant is served, not the repo.
# The one task 253 used (issue #18's card move; port 8906, CDP 9253):
#
#   CHECK='rm -f /tmp/pm.db*; PORT=8906 DB_PATH=/tmp/pm.db ORCH_AUTH_TOKEN=k node src/server.js >/dev/null 2>&1 & S=$!;
#     until curl -sf localhost:8906/health >/dev/null; do sleep 0.2; done;
#     node .claude/skills/verify-ui-change/seed-move.mjs http://localhost:8906 /tmp/pm.db >/tmp/pm.jsonl 2>/dev/null & K=$!; sleep 3;
#     ORCH_CDP_PORT=9253 timeout 120 node --experimental-websocket .claude/skills/verify-ui-change/check-card-move.mjs http://localhost:8906 /tmp/pm-shots /tmp/pm.jsonl;
#     kill $K $S'
#
# For check-backdrop.mjs (issue #11, PR #36) the whole fixture is one command,
# run from the copy so the mutant is what is served:
#
#   CHECK='PORT=8912 CDP=9254 .claude/skills/verify-ui-change/run-check-backdrop.sh "$PWD" after'
#
# check-popout.mjs (issue #19, PR #41) and check-chatbox.mjs (issue #13) have
# runners of the same shape (about five minutes and one minute):
#
#   CHECK='PORT=8932 CDP=9272 .claude/skills/verify-ui-change/run-check-popout.sh "$PWD"'
#   CHECK='PORT=8916 CDP=9266 .claude/skills/verify-ui-change/run-check-chatbox.sh "$PWD"'
#
# `timeout` is coreutils and not on every machine (it is not on the Mac
# mini, 2026-11-03): there the line above is "command not found", which a
# `2>/dev/null` hides and this reports as a check that did not finish. The
# drivers carry their own deadline per command, so leave it out there.
#
# A page check that dies on a waitFor instead of printing ✗ has still
# caught the mutant — "the card follows on the 200 again" killed step 3b by
# timing out on a refusal the dialog never drew — and this says so.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="$1"; FILE="$2"; OLD="$3"; NEW="$4"; CHECK="$5"
[ -d .git ] && { echo "refusing: this is a git checkout, not the copy" >&2; exit 2; }
cp "$FILE" "$FILE.unmutated"
if python3 "$HERE/mutate.py" "$FILE" "$OLD" "$NEW"; then
  OUT="$(bash -c "$CHECK" 2>&1)"
  N="$(echo "$OUT" | grep -c '✗')"
  T="$(echo "$OUT" | grep -q 'waitFor timed out' && echo ' (+ a wait timed out)')"
  if [ "$N" != 0 ] || [ -n "$T" ]; then
    echo "PAGE MUTANT [$NAME]: $N failing$T"
    echo "$OUT" | grep -E '✗|waitFor timed out' | head -4 | sed 's/^/    /' | cut -c1-220
  elif echo "$OUT" | grep -q '^PASS'; then
    echo "PAGE MUTANT [$NAME]: 0 failing — SURVIVED (the check passed)"
  else
    # Neither a red nor a PASS: the check itself did not run to the end. That
    # is not a survivor — the first cut of this script called a check that
    # crashed on a missing shots folder one (task 253). Read it.
    echo "PAGE MUTANT [$NAME]: THE CHECK DID NOT FINISH — not a result. Its last lines:"
    echo "$OUT" | tail -5 | sed 's/^/    /' | cut -c1-220
  fi
else
  echo "PAGE MUTANT [$NAME]: DID NOT APPLY"
fi
mv "$FILE.unmutated" "$FILE"

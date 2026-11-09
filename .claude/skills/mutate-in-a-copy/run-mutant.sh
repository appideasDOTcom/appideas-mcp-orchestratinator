#!/bin/bash
# One mutant, one suite, in the copy: apply, run, report the first failing
# assertion, put the file back.
#
#   cd "$(copy-repo.sh)"
#   run-mutant.sh "<what the mutant is>" <suite> <file> '<old>' '<new>'
#   run-mutant.sh "names dropped from the response" floor src/floor.js 'hosts, names });' 'hosts });'
#
# <suite> is the part after `test:` in package.json (floor, host, window…).
# 0 failing is a survivor: either no test covers that behaviour, or something
# downstream makes the mutation invisible (see SKILL.md) — find out which.
set -u
# A Node that can load better-sqlite3 13, or a refusal in words: this machine's
# default node segfaults on it silently (scripts/node-floor.sh has the why).
. "$(cd "$(dirname "$0")/../../.." && pwd)/scripts/node-floor.sh" || exit 2
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="$1"; SUITE="$2"; FILE="$3"
[ -d .git ] && { echo "refusing: this is a git checkout, not the copy" >&2; exit 2; }
cp "$FILE" "$FILE.unmutated"
if python3 "$HERE/mutate.py" "$FILE" "$4" "$5"; then
  # Every suite is `test:<name>` in package.json but smoke, which is `smoke`.
  SCRIPT="test:$SUITE"; [ "$SUITE" = smoke ] && SCRIPT=smoke
  OUT="$(npm run "$SCRIPT" 2>&1)"
  R="$(echo "$OUT" | grep -c '✗')"; G="$(echo "$OUT" | grep -c '✓')"
  if [ "$R" = 0 ] && [ "$G" = 0 ]; then
    # No ✗ and no ✓: the suite never ran (a script name npm does not have, a
    # Node that cannot load the server). That is not a survivor, and "0
    # failing" said it was one for the smoke suite until 2026-11-08. Read it.
    echo "MUTANT [$NAME] ($SUITE): THE SUITE DID NOT RUN — not a result. Its last lines:"
    echo "$OUT" | grep -v '^$' | tail -4 | sed 's/^/    /' | cut -c1-220
  elif [ "$R" = 0 ]; then
    echo "MUTANT [$NAME] ($SUITE): 0 failing — SURVIVED ($G ✓)"
  else
    echo "MUTANT [$NAME] ($SUITE): $R failing — $(echo "$OUT" | grep '✗' | head -1 | cut -c1-200)"
  fi
else
  echo "MUTANT [$NAME]: DID NOT APPLY"
fi
mv "$FILE.unmutated" "$FILE"

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
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="$1"; SUITE="$2"; FILE="$3"
[ -d .git ] && { echo "refusing: this is a git checkout, not the copy" >&2; exit 2; }
cp "$FILE" "$FILE.unmutated"
if python3 "$HERE/mutate.py" "$FILE" "$4" "$5"; then
  OUT="$(npm run "test:$SUITE" 2>&1)"
  echo "MUTANT [$NAME] ($SUITE): $(echo "$OUT" | grep -c '✗') failing — $(echo "$OUT" | grep '✗' | head -1 | cut -c1-200)"
else
  echo "MUTANT [$NAME]: DID NOT APPLY"
fi
mv "$FILE.unmutated" "$FILE"

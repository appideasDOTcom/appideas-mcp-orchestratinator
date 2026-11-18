#!/bin/bash
# The project's coverage reading: every suite under V8 coverage, every
# current page check under Chrome's, and one report.
#
#   npm run coverage                    # out in a fresh temp folder
#   scripts/coverage/run.sh <out dir>   # out there
#
# costmo's ruling on the milestone audit (2026-11-17, item B): the project
# owns a coverage reading, and the audit's (at 0771ea8: 88.4 % code lines,
# 94.1 % functions, 77.8 % branches) is the baseline new work is measured
# against. The instrument is QA's, validated in that audit and kept as it was
# measured: preload.cjs is its preload, drive.mjs's PAGECOV is its page
# patch, and report.mjs is a line-for-line port of its report, which gave
# QA's per-file table exactly when run over the audit's own snapshots. So a
# number that moves is the code, not the ruler.
#
# Steps, each said in the log:
#   1. npm test with NODE_V8_COVERAGE and the preload (a SIGKILL is still a
#      SIGKILL; the preload snapshots first). The suites' pass/fail is the
#      gate's business (npm run release-gate), but a red chain is said here,
#      because a chain that stopped early covers less and reads as a drop.
#   2. The release page checks and the six other current ones
#      (verify-ui-change), with PAGECOV set, one at a time.
#   3. scripts/coverage/report.mjs → <out>/table.md (per file, and **all**).
#   4. The lifted page sections the preload kept in data/ are removed.
# Node: the major the image ships, as the release gate finds it. About 35
# minutes; run it alone, as the gate is run.
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO" || exit 2
OUT="${1:-}"
[ -n "$OUT" ] || OUT="$(mktemp -d "${TMPDIR:-/tmp}/coverage.XXXXXX")"
mkdir -p "$OUT" && OUT="$(cd "$OUT" && pwd)"
NCOV="$OUT/node"; PCOV="$OUT/page"; LOG="$OUT/coverage.log"
rm -rf "$NCOV" "$PCOV"; mkdir -p "$NCOV" "$PCOV"

WANT="$(sed -n 's/^FROM node:\([0-9][0-9]*\).*/\1/p' Dockerfile | head -1)"
major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null; }
NODE=""
for cand in "${ORCH_NODE:-}" "$(command -v node || true)" "$(ls -d "$HOME"/.nvm/versions/node/v"$WANT".*/bin/node 2>/dev/null | sort -t. -k2,2n -k3,3n | tail -1)" /opt/homebrew/opt/node@"$WANT"/bin/node /usr/local/opt/node@"$WANT"/bin/node; do
  if [ -n "$cand" ] && [ -x "$cand" ] && [ "$(major "$cand")" = "$WANT" ]; then NODE="$cand"; break; fi
done
[ -z "$NODE" ] && { echo "no Node ${WANT:-?} found (the Dockerfile's FROM); name one with ORCH_NODE" >&2; exit 2; }
export PATH="$(dirname "$NODE"):$PATH"
SHA="$(git rev-parse --short HEAD 2>/dev/null || echo no-git)"
load() { /usr/sbin/sysctl -n vm.loadavg 2>/dev/null | tr -d '{}' | xargs; }
T0=$(date +%s)
echo "### coverage · head $SHA · $(git status --porcelain 2>/dev/null | grep -vc '^?? node_modules' || true) tracked change(s) · node $(node -v) · $(date -u +%FT%TZ) · load $(load)" | tee "$LOG"

# 1. The suites.
echo "### npm test under V8 coverage · $(date -u +%FT%TZ)" | tee -a "$LOG"
NODE_V8_COVERAGE="$NCOV" NODE_OPTIONS="--require $REPO/scripts/coverage/preload.cjs" npm test > "$OUT/npm-test.log" 2>&1
CHAIN=$?
echo "### npm test: EXIT=$CHAIN · ✓ $(grep -c '✓' "$OUT/npm-test.log") · ✗ $(grep -c '✗' "$OUT/npm-test.log") · snapshots $(ls "$NCOV" | wc -l | xargs)$([ $CHAIN -ne 0 ] && echo ' · RED: the chain stopped early, so this reading covers less than a green one')" | tee -a "$LOG"

# 2. The page checks.
echo "### page checks under Chrome coverage · $(date -u +%FT%TZ)" | tee -a "$LOG"
PAGECOV="$PCOV" .claude/skills/verify-ui-change/run-release-pages.sh > "$OUT/release-pages.log" 2>&1
PAGES=$?
echo "### release pages: EXIT=$PAGES · $(grep -E '^### [0-9]+ of [0-9]+ passed' "$OUT/release-pages.log" | sed 's/^### //; s/ · logs.*//')" | tee -a "$LOG"
p=8952; c=9322
for f in meeting meeting-box redraw select sessions take-floor; do
  PAGECOV="$PCOV" PORT=$p CDP=$c .claude/skills/verify-ui-change/run-check-$f.sh "$REPO" > "$OUT/check-$f.log" 2>&1; rc=$?
  echo "### check-$f: EXIT=$rc · $(grep -E '^(PASS|FAIL)' "$OUT/check-$f.log" | tail -1 | cut -c1-60)" | tee -a "$LOG"
  [ $rc -eq 0 ] || PAGES=1
  p=$((p + 1)); c=$((c + 1))
done
echo "### page snapshots $(ls "$PCOV" | wc -l | xargs)" | tee -a "$LOG"

# 3. The report.
node scripts/coverage/report.mjs "$REPO" "$NCOV" "$PCOV" "$OUT/report" > "$OUT/report.log" 2>&1
REP=$?
cp "$OUT/report/table.md" "$OUT/table.md" 2>/dev/null
echo "### report: EXIT=$REP · $OUT/table.md" | tee -a "$LOG"
grep '^| \*\*all' "$OUT/table.md" 2>/dev/null | tee -a "$LOG"

# 4. The lifted sections the preload kept.
find data -maxdepth 1 -type f -regex '.*/[A-Za-z0-9-]*-[0-9][0-9]*\.mjs' -delete 2>/dev/null

RC=0; [ $CHAIN -eq 0 ] && [ $PAGES -eq 0 ] && [ $REP -eq 0 ] || RC=1
echo "EXIT=$RC · npm test $CHAIN · pages $PAGES · report $REP · $(( $(date +%s) - T0 )) s · $(date -u +%FT%TZ) · out $OUT" | tee -a "$LOG"
exit $RC

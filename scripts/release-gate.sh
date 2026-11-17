#!/bin/bash
# The release gate as one command: every suite and every release page check,
# on the Node and the packages that ship, with one log and one exit code.
#
#   npm run release-gate                  # log in a fresh temp folder
#   scripts/release-gate.sh <out dir>     # log there
#
# costmo's ruling on the milestone audit (2026-11-17, item A). Before this a
# release check was two commands run by hand (`npm test`, then
# .claude/skills/verify-ui-change/run-release-pages.sh), each with its own log
# and its own idea of which Node it ran on, and a red in the second was easy
# to report beside a green first. Now:
#   - The Node is the major the board's image ships (the Dockerfile's FROM),
#     found the way host/install.sh finds it; the gate refuses to run on any
#     other, so "tested" and "shipped" cannot drift apart again (finding 5).
#   - The installed packages must be the lockfile's (`npm ls --all`): the
#     image installs with `npm ci`, so a node_modules that differs from the
#     lock is testing something that does not ship.
#   - `npm test` (the whole chain) and then the release page checks, both
#     run even when the first is red, so one run says everything.
#   - One log. Its first line names the head, whether the tree is clean, the
#     Node and the load; its last line is `EXIT=<n>`, 0 only when every part
#     passed.
# Run it alone on the machine: two tmux-driving suites, or a suite and these
# Chromes, beside each other is how reds that are not the code happen
# (CLAUDE.md, Tests). Ports are the suites' defaults and the page checks'
# 8941–8951 / CDP 9311–9321.
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 2
OUT="${1:-$(mktemp -d "${TMPDIR:-/tmp}/release-gate.XXXXXX")}"
mkdir -p "$OUT"
# A copy of the tree (mutate-in-a-copy) has no .git: it is named as one.
SHA="$(git rev-parse --short HEAD 2>/dev/null || echo no-git)"
LOG="$OUT/release-gate-$SHA.log"

# The Node: the major the image ships, never the shell's default.
WANT="$(sed -n 's/^FROM node:\([0-9][0-9]*\).*/\1/p' Dockerfile | head -1)"
major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null; }
NODE=""
for cand in "${ORCH_NODE:-}" "$(command -v node || true)" "$(ls -d "$HOME"/.nvm/versions/node/v"$WANT".*/bin/node 2>/dev/null | sort -t. -k2,2n -k3,3n | tail -1)" /opt/homebrew/opt/node@"$WANT"/bin/node /usr/local/opt/node@"$WANT"/bin/node; do
  if [ -n "$cand" ] && [ -x "$cand" ] && [ "$(major "$cand")" = "$WANT" ]; then NODE="$cand"; break; fi
done
if [ -z "$WANT" ] || [ -z "$NODE" ]; then
  echo "### release gate · head $SHA · no Node ${WANT:-?} found (the Dockerfile's FROM); install one or name it with ORCH_NODE" | tee "$LOG"
  echo "EXIT=2" | tee -a "$LOG"
  exit 2
fi
export PATH="$(dirname "$NODE"):$PATH"

CHANGES="$(git status --porcelain 2>/dev/null | grep -vc '^?? node_modules' || true)"
[ "$SHA" = no-git ] && CHANGES='?'
load() { /usr/sbin/sysctl -n vm.loadavg 2>/dev/null | tr -d '{}' | xargs; }
T0=$(date +%s)
echo "### release gate · head $SHA · $CHANGES tracked change(s) · node $(node -v) · started $(date -u +%FT%TZ) · load $(load)" | tee "$LOG"

# The packages: the lockfile's, or nothing here is what ships.
if npm ls --all > "$OUT/npm-ls.txt" 2>&1; then LOCK=0; echo "### packages: node_modules matches package-lock.json" | tee -a "$LOG"
else LOCK=1; echo "### packages: node_modules does NOT match package-lock.json (npm ls --all, in $OUT/npm-ls.txt): run npm ci" | tee -a "$LOG"; fi

# Every suite.
echo "### npm test · $(date -u +%FT%TZ)" | tee -a "$LOG"
npm test > "$OUT/npm-test.log" 2>&1
CHAIN=$?
cat "$OUT/npm-test.log" >> "$LOG"
echo "### npm test: EXIT=$CHAIN · ✓ $(grep -c '✓' "$OUT/npm-test.log") · ✗ $(grep -c '✗' "$OUT/npm-test.log") · $(( $(date +%s) - T0 )) s · load $(load)" | tee -a "$LOG"

# Every release page check, in a copy of the tree.
echo "### release pages · $(date -u +%FT%TZ)" | tee -a "$LOG"
.claude/skills/verify-ui-change/run-release-pages.sh > "$OUT/release-pages.log" 2>&1
PAGES=$?
cat "$OUT/release-pages.log" >> "$LOG"
echo "### release pages: EXIT=$PAGES · $(grep -E '^### [0-9]+ of [0-9]+ passed' "$OUT/release-pages.log" | sed 's/^### //; s/ · logs.*//') · load $(load)" | tee -a "$LOG"

RC=0
[ $LOCK -eq 0 ] && [ $CHAIN -eq 0 ] && [ $PAGES -eq 0 ] || RC=1
echo "EXIT=$RC · packages $LOCK · npm test $CHAIN · pages $PAGES · $(( $(date +%s) - T0 )) s · $(date -u +%FT%TZ) · log $LOG" | tee -a "$LOG"
exit $RC

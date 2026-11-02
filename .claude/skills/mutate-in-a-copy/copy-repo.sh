#!/bin/bash
# A copy of the working tree outside the repo, ready to run the suites in.
#
#   copy-repo.sh [dest]        default: $TMPDIR/orch-mutate-copy
#
# Everything but .git, data/ and node_modules is copied; node_modules is a
# symlink back to the repo's, so nothing is installed. The copy has its own
# empty data/ — the suites write their databases and fixtures there, by pid.
# Run it again to refresh the copy after the tree changes: it starts clean.
set -eu
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DEST="${1:-${TMPDIR:-/tmp}/orch-mutate-copy}"
case "$DEST" in "$REPO"|"$REPO"/*) echo "refusing: $DEST is inside the repo" >&2; exit 2 ;; esac
rm -rf "$DEST"
mkdir -p "$DEST/data"
rsync -a --exclude .git --exclude data --exclude node_modules "$REPO/" "$DEST/"
ln -s "$REPO/node_modules" "$DEST/node_modules"
echo "$DEST"

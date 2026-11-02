#!/bin/bash
# Run a node script against the live board's database, read-only, inside the
# server's container — where the database and better-sqlite3 both are.
#
#   board-query.sh <script.js>            # stdout is the script's
#
# The script is passed on stdin (`node -`), not with `-e`: SQL has quotes in
# it, and a script inside shell quotes inside `docker compose exec` lost a
# round to "no such column" before a line of it ran. In the script:
#
#   const db = new (require('better-sqlite3'))(process.env.DB_PATH, { readonly: true });
#
# Open it read-only, always. The live database is the operator's board.
set -eu
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO"
docker compose exec -T orchestratinator node - < "$1"

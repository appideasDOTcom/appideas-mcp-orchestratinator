#!/bin/sh
# The board's shape in one line, for a deploy's before and after:
#
#   board-counts.sh [board]          # default http://localhost:8787
#   → floors 18 · archived 8 [a, b, …] · desks 57 · hidden 0 · app.js ece007e5 (tree ece007e5)
#
# Floors, the archived list, desks and hidden desks come from /api/floor.
# They are rows in the /data volume and must read the same before and
# after a restart; a difference is the finding, not the deploy. The last
# field is the sha256 of the /app.js the board serves, beside the tree's.
# A server-only deploy whose delta is the page is proved by those two
# agreeing (task 271). A count that moved for another reason is named
# where it came from: on 2026-11-04 a 19th floor was a channel a
# mistyped tool override had created, not the deploy.
B="${1:-http://localhost:8787}"
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
curl -s "$B/api/floor" | node -e '
let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => {
  const ch = JSON.parse(s).channels ?? [];
  const arch = ch.filter((c) => c.archived).map((c) => c.channel).sort();
  const desks = ch.flatMap((c) => c.desks ?? []);
  process.stdout.write(`floors ${ch.length} · archived ${arch.length} [${arch.join(", ")}] · desks ${desks.length} · hidden ${desks.filter((d) => d.hidden).length}`);
});'
echo " · app.js $(curl -s "$B/app.js" | shasum -a 256 | cut -c1-8) (tree $(shasum -a 256 "$REPO/src/ui/app.js" | cut -c1-8))"

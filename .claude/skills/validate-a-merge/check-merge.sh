#!/bin/bash
# What a merge did beyond git's own merge, read-only.
#
#   check-merge.sh                  # a merge in progress: HEAD + MERGE_HEAD against the index
#   check-merge.sh <merge-commit>   # a committed merge: its two parents against its tree
#
# 1. Recomputes the merge with `git merge-tree` (no worktree, no refs) and
#    lists every file whose result differs from git's own. For a file git
#    merged cleanly, a difference is a hand edit. For a conflicted file it
#    is the resolution, and the lines are counted apart from the markers.
# 2. Conflict markers left anywhere in the files the merge touched.
# 3. Keep-both seams in Markdown: where a marker stood between two
#    non-blank lines that now sit next to each other. On 2026-11-04 that
#    joined issue #11's paragraph onto the last bullet of #23's list in
#    CLAUDE.md, where Markdown renders it as part of the bullet.
# 4. The version in package.json, host/package.json and the plugin
#    manifest. They must agree (`npm run smoke`).
# 5. Remote branches carrying commits on the merged side's line that the
#    merge does not include: origin/issues/11 had e672b8b, pushed after
#    PR #36 was merged, so merging main did not bring it. That one was
#    deliberate (merged last), so this reports and does not judge.
#
# It writes nothing: no objects beyond what merge-tree stores, no refs, no
# index, no files.
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2
if [ $# -ge 1 ]; then
  M="$1"; OURS=$(git rev-parse "$M^1") || exit 2; THEIRS=$(git rev-parse "$M^2") || exit 2
  RESULT=$(git rev-parse "$M^{tree}"); SPEC="$M:"
else
  [ -f "$(git rev-parse --git-dir)/MERGE_HEAD" ] || { echo "no merge in progress, and no merge commit given"; exit 2; }
  OURS=$(git rev-parse HEAD); THEIRS=$(git rev-parse MERGE_HEAD)
  U=$(git diff --name-only --diff-filter=U)
  [ -n "$U" ] && { echo "unresolved, not yet staged:"; echo "$U" | sed 's/^/  /'; exit 1; }
  RESULT=$(git write-tree); SPEC=":"
fi
BASE=$(git merge-base "$OURS" "$THEIRS")
AUTO=$(git merge-tree --write-tree "$OURS" "$THEIRS" | head -1)
CONFLICTED=$(git merge-tree --write-tree --name-only "$OURS" "$THEIRS" | sed -n '2,/^$/p' | sed '/^$/d')
echo "ours $(git rev-parse --short "$OURS") · theirs $(git rev-parse --short "$THEIRS") · base $(git rev-parse --short "$BASE")"
echo "git conflicted on: $(echo $CONFLICTED)"
FLAGS=0

echo "== 1. the result against git's own merge"
CHANGED=$(git diff --name-only "$AUTO" "$RESULT")
for f in $CHANGED; do
  if echo "$CONFLICTED" | grep -qxF "$f"; then
    NON=$(git diff -U0 "$AUTO" "$RESULT" -- "$f" | grep -E '^[-+]' | grep -vE '^(\+\+\+|---)' \
      | grep -vcE '^-(<<<<<<<|=======$|>>>>>>>)')
    echo "  $f: resolved; $NON line(s) beyond removing the markers"
  else
    echo "  $f: HAND-EDITED, though git merged it cleanly"; FLAGS=$((FLAGS + 1))
  fi
done
[ -z "$CHANGED" ] && echo "  identical: every file is git's own merge"

echo "== 2. conflict markers left"
TOUCHED=$(git diff --name-only "$OURS" "$RESULT"; git diff --name-only "$THEIRS" "$RESULT")
LEFT=$(for f in $(echo "$TOUCHED" | sort -u); do
  git show "$SPEC$f" 2>/dev/null | grep -nE '^(<<<<<<<|>>>>>>>)' | sed "s|^|  $f:|"; done)
if [ -n "$LEFT" ]; then echo "$LEFT"; FLAGS=$((FLAGS + 1)); else echo "  none"; fi

echo "== 3. keep-both seams in Markdown"
SEAMS=0
for f in $CONFLICTED; do
  case "$f" in *.md) ;; *) continue ;; esac
  OUT=$(node -e '
    const [auto, result, name] = [process.argv[1], process.argv[2], process.argv[3]];
    const a = auto.split("\n"), r = result.split("\n");
    const marker = (l) => /^(<<<<<<<|=======$|>>>>>>>)/.test(l);
    const pairs = new Set(r.slice(1).map((l, i) => r[i] + "\u0000" + l));
    for (let i = 0; i < a.length; i++) {
      if (!marker(a[i])) continue;
      let p = i - 1; while (p >= 0 && marker(a[p])) p--;
      let n = i + 1; while (n < a.length && marker(a[n])) n++;
      if (p < 0 || n >= a.length || !a[p].trim() || !a[n].trim()) continue;
      if (pairs.has(a[p] + "\u0000" + a[n]))
        console.log(`  ${name}: no blank line where "${a[i].slice(0, 7)}" stood — «${a[p].trim().slice(0, 50)}» then «${a[n].trim().slice(0, 50)}»`);
    }' "$(git show "$AUTO:$f")" "$(git show "$SPEC$f")" "$f")
  [ -n "$OUT" ] && { echo "$OUT"; SEAMS=1; }
done
[ "$SEAMS" = 0 ] && echo "  none" || FLAGS=$((FLAGS + 1))

echo "== 4. versions"
V=$(for f in package.json host/package.json plugin/.claude-plugin/plugin.json; do
  git show "$SPEC$f" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))'; done)
echo "  $(echo $V)"
[ "$(echo "$V" | sort -u | wc -l | tr -d ' ')" = 1 ] || { echo "  THE THREE DISAGREE"; FLAGS=$((FLAGS + 1)); }

echo "== 5. commits on the merged side's line that the merge does not include"
SIDE=$(git rev-list "$BASE..$THEIRS")
FOUND=0
for b in $(git for-each-ref --format='%(refname)' refs/remotes | grep -v '/HEAD$' | sed 's|^refs/remotes/||'); do
  N=$(git rev-list --count "$b" "^$OURS" "^$THEIRS")
  [ "$N" -gt 0 ] || continue
  # A branch that already holds this merge has moved on past it; its later
  # commits are later work, not something the merge left out.
  [ -n "${M:-}" ] && git merge-base --is-ancestor "$M" "$b" && continue
  # Only a branch that shares the merged side's own commits, not every
  # unrelated branch that is ahead of both.
  echo "$SIDE" | grep -qxF -f <(git rev-list "$BASE..$b") 2>/dev/null || continue
  echo "  $b: $N commit(s) not in this merge — $(git log --format='%h %s' "$b" "^$OURS" "^$THEIRS" | head -3 | tr '\n' ';')"
  FOUND=1
done
[ "$FOUND" = 0 ] && echo "  none"

echo "== $FLAGS flag(s). Section 5 is information: it reports branches and does not judge."
exit $((FLAGS > 0))

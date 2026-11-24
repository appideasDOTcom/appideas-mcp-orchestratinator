---
name: post-a-patch
description: Hand an uncommitted fix to QA, desktop-dev or pc-developer during a release round, the way the 0.15.0 round did it — a cumulative diff on the base commit with sha256s, posted on the board as this desk, readings in a second message, and the row that is red without the fix named. Use whenever QA asks for "a patch with sha256s", when another agent cannot reach your scratchpad, and when desktop-dev needs a tree to pack into a scratch app.
---

# Posting a patch during a round

costmo commits; nobody else does (CLAUDE.md, "Git is Chris's"). So in a
release round every fix travels as an uncommitted diff, and three readers
need the same bytes: QA re-measures it, desktop-dev packs the tree into a
scratch app (`npm pack` of this folder), and pc-developer applies it on the
Windows PC, which cannot read this machine's scratchpad. The 0.15.0 round
went A to L this way, and these are the habits that kept the readers on one
tree.

## The patch

- **Cumulative on the last commit costmo made**, never on the previous
  patch: `git diff <base> > $SP/patch-<release>-<letter>.diff`. When he
  commits mid-round (he did, twice), the next patch is on the new commit, and
  the message says the base.
- **Fingerprints**: `shasum -a 256` of the diff file, and of every changed
  file (`git status --porcelain | awk '{print $2}' | while read f; do shasum
  -a 256 "$f"; done`). Name `-a 256`; plain shasum is SHA-1 (CLAUDE.md,
  Tests).
- **What changed since the previous patch**, by file, so a reader can tell a
  test-only step from a product change. A test-only patch says so: the
  scratch app's pack stays valid.
- **Only the fix asked for.** When QA freezes scope, a second change waits for
  the follow-up list, however small. An idea that a mutant shows does not
  hold (its row survives) is backed out before the patch goes, not shipped
  "as well".

## Posting it

The body is the diff itself, so it is posted from the file, not retyped:

```
. scripts/node-floor.sh
node .claude/skills/post-a-patch/post-patch.mjs appideas-qa "$SP/patch-015-k.diff" \
  "coordinator → appideas-qa: PATCH K (cumulative on b1a774a). sha256 …"
```

Then a second, short message through the MCP tool with the readings: the
cause in a few lines, the rows and which are red without the fix, the suites
and page checks run with their counts and the load, the mutants, and what is
NOT done. pc-developer gets the same diff posted to it directly; it has asked
for that, because the scratchpad path in a message is no use on Windows.

## The proof that goes with it

- A row that is red at the base and green with the fix, for each fix, and
  its mutant in `mutants-<release>.suite.json` (or the page list). A mutant
  that survives means the row does not hold the fix; say so, never post it
  as proven.
- The suites the diff reaches (CLAUDE.md, Conventions table), and for
  anything a person sees, the page check, with a screenshot read by eye.
- For anything a new operator meets, desktop-dev's walk of the real app at
  that tree before it reaches costmo (CLAUDE.md, Tests, "Green suites did not
  prove a new operator's first session").

---
name: reanchor-marketing-facts
description: Move docs/marketing-facts.md's line references to the commit costmo just pushed — the dry run, the write, the ranges the script cannot place, the facts that changed in substance, and the self-check that proves every reference resolves. Use after every commit that moves code, before QA re-measures it.
---

# Re-anchoring the marketing facts after a commit

`docs/marketing-facts.md` is what the landing page may say, and every fact
in it cites `path:line` at the commit named in its header. Code moves; the
facts do not. QA reads the file at every review and a stale anchor is a Low
(PR #29, task 244). The script is `scripts/reanchor-facts.mjs`, and it reads
`git show <sha>:<path>`, so **it cannot run before the commit exists** —
this is a step after costmo's push, not part of the task that moved the
code. Say so in the completion note of the task; do the re-anchor on the
next nudge that shows the push.

## The loop

```bash
OLD=$(sed -n 's/.*at commit `\([0-9a-f]*\)`.*/\1/p' docs/marketing-facts.md | head -1)   # the header's anchor
NEW=$(git rev-parse --short origin/develop)
node scripts/reanchor-facts.mjs $OLD $NEW            # dry run: SAME / MOVED / UNSURE per reference
node scripts/reanchor-facts.mjs $OLD $NEW --write    # rewrites the MOVED ones only
```

Then by hand, each time:

1. **Every UNSURE.** The usual shape is a *range whose first line is found
   once but whose block grew* — the schema `db.exec` block when a table was
   added, `BACKUP_TABLES` when an entry was. The script reports `1 matches`
   and still says UNSURE because the range's last line no longer matches at
   the same offset. Find the new end by reading, not by arithmetic:

   ```bash
   git show $OLD:src/db.js | sed -n '245p'          # what the old range ended on
   git show $NEW:src/db.js | grep -n 'idx_saved_prompts_title'   # where that line is now
   ```

   and write the new range in. A reference the script says `0 matches` for
   is a line that was rewritten; read the new code and cite the line that
   says the same thing, or mark the fact changed.
2. **The header**: the anchor SHA, the date, and one clause saying what
   this re-anchor did (how many moved, which were placed by hand, which
   facts changed in substance). The line `Line numbers are for \`<sha>\`` a
   few lines down too.
3. **Facts that changed in substance.** The version fact (section 6) on
   every bump; a count that grew ("the ten tables a backup carries" became
   eleven when `desk_flags` was added); a list of what the server stores.
   Read the diff of the commit for anything the file describes — a new
   table, a new route, a changed behaviour — and either update the fact or
   add a line under the nearest "honest limit" (issue #20 added one under
   "nothing is inferred from silence": an empty desk is not drawn).
4. **Self-check**:

   ```bash
   node scripts/reanchor-facts.mjs $NEW $NEW     # → "N same, 0 moved, 0 unsure"
   ```

   This proves every cited line *exists* at the new commit — a reference
   past the end of a file or to a missing file would be UNSURE. It does not
   prove a hand-placed range is right; that is step 1's reading.

Tell QA on the channel what moved and what was placed by hand, with the
line numbers, so they can predict their own `reanchor-facts` reading before
they run it. The file is in the tree, uncommitted; costmo commits it as its
own commit (`67a1104` was one), and that commit carries QA's measurement of
the code by identity — say "docs only, no code touched" so they know.

## What has gone wrong

- **Re-anchored by hand with a regex** (2026-11-02): six references in list
  form (`src/floor.js:2244, 2269, …`) were missed; QA found them by reading.
  The script matches every form the file uses — add a form to it, never a
  second regex.
- **A grown block written as the old length** would cite a range that stops
  short of its last entry. Read the end line.
- **The version fact left at the old number** is the one QA checks first.

---
name: validate-a-merge
description: Check costmo's merge before he commits it, or a merge already committed. Recompute git's own merge and compare the result with it, find conflict markers, "keep both" seams that join two Markdown blocks, version files that disagree, and commits on the merged branch that the merge left out. Then run the suites and the page checks of both sides. Use when he says "validate my merge" or "check my conflict resolution", and before any review of a merge commit.
---

# Validating a merge

costmo merges branches himself (main back into develop, a feature branch
into develop) and asks for a check before he commits. Git is his: read
everything, change nothing in git. The finished state is a short
account and, at most, a file edit he stages himself. Done once in full
on 2026-11-04 (main at 9062dae, PR #36 / issue #11, into develop at
c9b0b7d, issue #23). This is that procedure.

## 1. The mechanical half: [`check-merge.sh`](check-merge.sh)

```bash
.claude/skills/validate-a-merge/check-merge.sh            # a merge in progress (HEAD + MERGE_HEAD vs the index)
.claude/skills/validate-a-merge/check-merge.sh 9eef816    # a committed merge (its parents vs its tree)
```

It recomputes the merge with `git merge-tree --write-tree`, which touches
no worktree, index or ref, and reads five things:

1. **Every file whose result differs from git's own merge.** A cleanly
   merged file that differs was edited by hand. That's not wrong, but
   it's worth asking about. A conflicted file's resolution is counted in
   lines beyond the removed markers.
2. **Conflict markers left** in any file the merge touched.
3. **Keep-both seams in Markdown.** These are places where a marker
   stood between two non-blank lines that are now adjacent. That is the
   one fault the 2026-11-04 merge had. #23's last bullet and #11's
   paragraph met with no blank line, so Markdown rendered the paragraph
   inside the bullet. The fix was one blank line.
4. **The three version files**, which must agree (`npm run smoke`
   asserts it). The usual conflict is each side's bump. Keep the newer
   one, and say if the merged tree now holds work that the deployed
   build of that number does not.
5. **Remote branches with commits on the merged side's line that the
   merge does not include.** On 2026-11-04 `origin/issues/11` held
   e672b8b, pushed after its PR was merged, so merging `main` left it
   out. costmo had sequenced that on purpose ("I was intentionally
   putting that off until the end"). Report it as a fact. It is not a
   recommendation.

It exits 1 on any flag in 1–4. Section 5 never flags. When replaying old
history (below), branches that later took the real merge show up in
section 5 too. That is the replay, not the merge.

Red and green: replayed in a scratch clone (`git clone -s`, then a fetch
of the remote refs, then `git merge --no-commit` of the same two
parents). The "keep both" resolution exactly as first staged gave 1
flag, the seam named with both lines. With the blank line it gave 0
flags. The committed 9eef816 reads 0 flags, and section 5 names only
e672b8b.

## 2. The half only running it shows

A clean mechanical result says the files are what git and the resolver
made. It does not say the two sides work together. Both sides usually
touched the same page script (here `src/ui/app.js`: #23's
`backlogBehind`/`freshState` and #11's `forgetDialog`/`drawsNow`). So:

- **Read where the two meet.** Here that was the backlog dialog. It is
  async now and holds no text field, so #11's backdrop rule keeps
  closing it. Name the meeting point in the report.
- **`npm test` in full.** Announce the ports on the channel first. The
  count should be both sides' sums. Here it was 1,899 + 9 = 1,908 ✓.
- **Each side's page check**, since the suites can't see the page:
  `check-select.mjs` for #23 and `run-check-backdrop.sh` for #11, on
  private ports (**verify-ui-change**). Both passed on the merged tree,
  54 ✓ and 65 of 65.
- **Not the live board.** A merge in progress is not deployed. The
  deploy is its own task (**deploy-both-halves**).

## Reporting

Lead with the verdict (good to commit, or the one thing to fix). Then
the readings, one line each. Put a fix in the working tree only when it
is unambiguous, like the blank line. Then say it needs `git add`, because
the merge commit takes the index, not the worktree. That is the one
place git state belongs in a report to him. Flag what the merge does not
include (section 5) and any version number now shared by two different
builds, in a line each.

---
name: answer-a-qa-review
description: Take a QA review of a PR from the task it arrives as to the thread reply and the completion note — read the review and its threads with gh, fix in the tree, prove the test with a mutant, reply in the thread, leave it open. Use whenever appideas-qa opens a task titled "PR #N review".
---

# Answering a QA review

`appideas-qa` reviews every PR from a clean clone with mutation testing and
posts the review on GitHub from costmo's account, then opens a task on the
channel naming what to address (usually one Low) and what is Info. The
closing protocol is theirs and does not change: fix or write why not, reply
in the thread, **leave the thread open** — they re-measure at the pushed SHA
and resolve it. Never resolve a QA thread yourself.

## Reading it

```bash
PR=30
gh api repos/appideasDOTcom/appideas-mcp-orchestratinator/pulls/$PR/comments \
  --jq '.[] | {id, path, line, in_reply_to_id, body: .body[0:600]}'          # the threads
gh api repos/appideasDOTcom/appideas-mcp-orchestratinator/pulls/$PR/reviews/<review-id> --jq .body   # the review body
```

The review body is the record: a findings table with severity, instrument
and `file:line`, the red-verified inversions table, what was read with no
finding, and the rerun line. Read the whole body before the fix — the
finding's two or three candidate resolutions are usually there, and the
inversions table says which of your assertions they already trust.

## The fix

- **Measure before choosing**, with their probe if they named one. For a
  finding with two resolutions (PR #30: "the flag follows the desk" vs "the
  move clears it with a row"), pick the one that reads as a rule the
  operator would recognise, write the reasoning beside the code, and put
  the rule where its siblings are (CLAUDE.md's paragraph for the issue,
  the operating doc's bullet).
- **One named test at the tier that can see it**, beside its siblings in the
  suite — not necessarily at the line they pointed at. Say where you put it.
- **Read the payload the assertion reads before writing it.** The activity
  feed is newest-first and `admin.desk.*` matches more kinds than hide and
  show; a first cut asserted both wrongly, costmo pushed the tree while the
  suite ran, and QA measured a red at that SHA (0d18a9f). Diff rows by
  identity against a set taken before.
- **One mutant per fault line**, in a copy (**mutate-in-a-copy**): the fix
  removed must turn exactly the new assertion red. Name the mutant and the
  assertion in the reply; QA predicts their own inversions from it.
- **The suite that covers it, then the full run** — and read the channel
  first: their clean-clone runs share this machine's CPU, and a full run
  overlapping theirs went red in six `test:host` pane cases that were green
  alone (CLAUDE.md, Tests).

## Replying in the thread

A review-comment thread is answered through the replies endpoint — the
plain comments endpoint with `in_reply_to` is refused with a 422 about
`positioning`:

```bash
gh api -X POST repos/appideasDOTcom/appideas-mcp-orchestratinator/pulls/$PR/comments/<thread-root-id>/replies \
  -f body="$(cat <<'EOF'
Chosen: …
Test: …
Mutants: …
Leaving the thread open for your re-measure at the next push.
EOF
)" --jq .id
```

Say in the reply: what you chose and why; where the test is and what it
asserts in order; the mutants and the assertion each turned red; which SHA
holds what (costmo may have pushed mid-work — say "the pushed X has the
first cut; the rework is in the working tree"). The same goes in the task's
completion note, with the suite's exit and counts.

## What the channel gets

Announce ports before every run and release them after; QA stays off your
port when you hold it, and says so. The completion note is the account: the
choice, the file and test, the suite exit and count, the mutants, what is
pushed versus in the tree. Then idle, and poll — the re-measure, the close
and a deploy task for the fix (the server half alone when `host/` is
untouched; **deploy-both-halves**) follow as messages and tasks.

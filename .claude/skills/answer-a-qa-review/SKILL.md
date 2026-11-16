---
name: answer-a-qa-review
description: Take a QA review of a PR from the task or direct message it arrives as to the thread reply and the completion note — read the review and its threads with gh, fix in the tree, prove the test with a mutant, reply in the thread, leave it open. Use whenever appideas-qa opens a task titled "PR #N review", or messages you that a review of your PR is posted.
---

# Answering a QA review

`appideas-qa` reviews every PR from a clean clone with mutation testing and
posts the review on GitHub from costmo's account, then opens a task on the
channel naming what to address (usually one Low) and what is Info. It can
come as a **direct message** instead (PR #49, 2026-11-05: "QA review of PR
#49 is posted at …", with no task), and it is the same review. A nudge
that finds no task is not the end of it: read the poll. The completion
note then goes back as a message to `appideas-qa`, since there is no task
to complete. The
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
- **A new case in a slow suite is run before it rests in the tree.** On
  2026-11-15 (PR #55) costmo committed the tree as `d5c391b` and nudged QA
  while the round was still being written, with nothing announced. The
  two fixes in it were green. A new `test:host` case was not: it waited on
  `questions[0].header`, and the desk's form calls that field `tab_title`.
  The host suite takes five minutes and had not been run, so the SHA had
  four ✗ of mine in it. Write such a case, run its suite straight away
  (or in a copy, **mutate-in-a-copy**), and only then go on to the next
  file. When a push lands mid-round anyway, tell QA at once what is in it,
  file by file: green there, red there, half done there, only in the tree.
  They hold the lanes that cannot be measured and say which half they
  measured.
- **One mutant per fault line**, in a copy (**mutate-in-a-copy**): the fix
  removed must turn exactly the new assertion red. Name the mutant and the
  assertion in the reply; QA predicts their own inversions from it.
- **The suites that cover it, not the full run.** That means each changed
  file's suite (`test:floor` for the page's lifted sections, `test:host`
  for `host/`), the page checks that read the changed code, and the
  mutants. The full `npm test` waits for the release check, and QA runs it
  at every review anyway (costmo, 2026-11-16, after PR #56; CLAUDE.md,
  Conventions). PR #56's two rounds went that way and both closed green.
  Read the channel before anything long: their clean-clone runs share this
  machine's CPU, and a run of yours overlapping theirs went red in six
  `test:host` pane cases that were green alone (CLAUDE.md, Tests).
- **When costmo commits mid-round, prove what was measured was the
  commit.** He committed PR #56's fixes twice while mutants were still
  running in copies. The copy was taken before the commit, so the reading
  is the commit's only if the files are. Compare `shasum -a 256` of each
  changed file in the copy with `git show <sha>:<file>` and put both hashes
  in the account. QA compares by identity, and hashes say which algorithm.

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

## The rounds after the first close

A close is not always the end. QA's closing message can carry a new Info
item marked "for your notes" or "yours to take or leave", found while
re-measuring. PR #55 had three (Info 9, 10 and 11), each a way the last
round's own test could miss its fault, and so four closes, at `f5c2a92`,
`72017ab`, `0387b47` and `27efc57`. Each is a small round of the same
shape: fix in the tree, a control and the mutants in a copy, the account
to `appideas-qa` as a message (every thread is resolved by then, so there
is nothing to reply under), and QA re-measures at costmo's next push and
posts a closing note. What those rounds taught:

- **Tell costmo the PR was approvable at the close.** The later rounds
  harden tests and block nothing, and merge and deploy are his at any of
  them. Say so in the report, in one line, each time.
- **The candidate test is run from outside the tree** (`run-batches.mjs
  --overlay`, **mutate-in-a-copy**), and copied in when its control is
  green. This is the rule above, with the tool that makes it the easy way.
- **Take QA's pin as a mutant and run it** before answering, and before
  offering a different fix. Their pin is usually a change to a stand-in.
  Four runs settle it: control, fault, fault with the pin, pin alone.
- **A fix for "the test reads too early" is not a longer wait.** Info 9
  was a read straight after `send()`, Info 10 a count that could not see a
  repeat, Info 11 the 400 ms sleep that answered Info 10. What held was a
  row that needs no timer: the whole key log, read at the end of the
  section, after later sends had waited on their own receipts (CLAUDE.md,
  Tests, "an absence has nothing to wait on").
- **A hash is given with its algorithm.** Bare `shasum` is SHA-1, QA
  reads sha256, and the two were taken for two files.

## What the channel gets

Announce ports before every run and release them after; QA stays off your
port when you hold it, and says so. The completion note is the account: the
choice, the file and test, the suite exit and count, the mutants, what is
pushed versus in the tree. Then idle, and poll — the re-measure, the close
and a deploy task for the fix (the server half alone when `host/` is
untouched; **deploy-both-halves**) follow as messages and tasks.

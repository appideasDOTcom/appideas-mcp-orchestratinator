---
name: mutate-in-a-copy
description: Prove a test fails without the behaviour it names — break the code in a copy of the repo outside the working tree, run the suite there, and read which assertion went red. Use whenever a task asks for "a named test that fails without it", before claiming a test covers something, and any time you are about to edit a file "just to see the test fail".
---

# Breaking the code to check the tests — in a copy

A test that has never been seen to fail has not been shown to test anything.
The check is to break the behaviour and watch the named assertion go red.

**Never do it in the working tree.** The working tree is the operator's
commit surface at every moment: he commits when he chooses, and cannot see
that a file is deliberately broken for the next ninety seconds. On
2026-10-01 a mutation run edited `host/index.js` in place with a restore
step after each suite; he committed mid-run, and `8788a6d` went to
`origin/develop` with `this.emit(listing);` missing from `Host.pick()` — the
native folder picker broken, three host-suite assertions red at that SHA,
and QA about to measure it. A restore step is not protection. The window is
minutes long, and a killed or timed-out job leaves the mutant behind for
good.

## The loop

```bash
D="$PWD/.claude/skills/mutate-in-a-copy"
cd "$($D/copy-repo.sh)"                 # a copy under $TMPDIR; node_modules is a symlink
$D/run-mutant.sh "names dropped from the response" floor src/floor.js \
    'hosts, names });' 'hosts });'
# MUTANT [names dropped from the response] (floor): 5 failing —   ✗ the folders response carries the saved name…
```

`copy-repo.sh` refuses a destination inside the repo. `mutate.py` refuses a
file inside any git checkout — the copy has no `.git`, the repo does — and
refuses unless the old text occurs **exactly once**: a mutation that
silently does not apply is a mutant that "survives" against unchanged code.
`run-mutant.sh` puts the file back whatever happened.

Refresh the copy (`copy-repo.sh` again) whenever the tree has changed; a
stale copy tests yesterday's code and tests.

For more than two or three mutants, or for any whose old or new text holds
backticks, `${}` or both kinds of quote, write them as a JSON list and hand
it to `run-mutants.mjs`, which makes the copy once and runs each through
`run-mutant.sh` with no shell in between:

```bash
node .claude/skills/mutate-in-a-copy/run-mutants.mjs /tmp/mutants.json > /tmp/mutants.log
# [["a pill is not the restore control", "floor", "src/ui/app.js", "data-act=\"unarchive\" data-channel", "data-act=\"restore\" data-channel"], …]
```

**Red at the old SHA, and batches, are [`run-batches.mjs`](run-batches.mjs).**
A task that asks for "a named test, red at <sha>" wants the new tests run
against the old code. `--base <sha> --base-paths host/ --base-suite host`
puts those paths back to that SHA in a fresh copy, removing files that did
not exist then, and runs today's tests. It is the only honest form of the
claim. Then each batch is a list of mutants applied together for one suite
run, with an empty list as the control. From task 255 (issue #5): fourteen
host mutants went as one base run and five batches, about eight minutes in
all. The base read 11 of 14 new assertions red and the 3 guarding unchanged
behaviour green. Every batch's reds were the ones predicted for its mutants.
In the report, say which assertions are expected to stay green at the base
and why.

**A red you did not predict in an older section is load first** (task 255,
20:27Z): QA's clean-clone suite started on the same ports during the
tool's base run, and the base read 19 red. Those were the predicted 11,
plus 8 in sections nobody touched (the thought, the subagent's words, the
folder dialog). Read the channel for a QA announcement before believing
those, and rerun once the ports are quiet. Rerun at 20:53Z with nothing
else on them, it read the predicted 11 and 268 ✓.

Keep the JSON file outside the repo. A mutant whose new text is the old
text plus a dead branch is a no-op and proves nothing — one was written
that way on 2026-11-02 and had to be discounted in the report; say so if
it happens rather than counting it as a survivor.

The suites take their own ports (8896–8898) and tmux session names by pid,
so the copy runs exactly like the repo — and collides with a run in the
repo or in QA's clone for the same reason. One at a time, and say so on the
channel first, as for any suite run.

## Choosing the mutants

One per behaviour the task names, each the smallest change that removes it:
a guard deleted, a condition made always-true, a field dropped from a
projection, a sort removed, a limit raised. Name each mutant by what is now
wrong ("a row for a desk the host does not run is served"), not by the edit.

The host and window suites take minutes. Batch mutants into one run **only
when their assertions cannot overlap** — different sections, different
facts — and read which assertions went red, not the count:

- A mutant that breaks a precondition takes everything after it down and
  hides the others. "The host does not say it has a dialog" in the same
  batch as "the work loop waits for the person" produced nine failures, all
  from the first; the second had to be run again alone.
- A mutant that makes a helper return `null` usually ends the suite on a
  `TypeError` at the next line. That is a kill, but check the assertion
  before it was the one you meant.

## Reading a survivor

Zero failing is information, and it is one of three things:

1. **No test covers it.** Write the test, in the repo, then mutate again.
2. **Something downstream makes the mutation invisible.** Removing the
   host's own sort of the recent list changed nothing, because the server
   sorts again when it merges hosts. The host's sort still mattered — it
   runs *before the list is cut to its limit* — so the missing test was
   about the cut, not the order. Ask what the line is for before calling it
   redundant.
3. **The fixture cannot tell.** "A folder named twice is read once" survived
   until the fixture named a folder twice; "search results are ordered
   before they are cut" survived a query that did not match the conversation
   that would have been wrongly kept. A test whose fixture cannot produce
   the wrong answer passes for every implementation. Print what the fixture
   holds before believing either result.

Say plainly what stayed untested and why — "a newer search ending an older
one: the fixture's searches finish in 40 ms, nothing observes it" — rather
than leaving a survivor out of the report.

**A survivor can be the test's clock, not the code's** (PR #32, 2026-11-03):
"two live sessions on one desk" wrote both rows in the same second, so "the
desk's newest" and "the window's session" were the same row and three
mutants that moved a write between them stayed green. The fix was in the
test — `sleep(1100)` and a touch to make the other row strictly newer,
before *each* write under test (the ask itself bumps the window row's
clock, so the second write needed its own gap). When a mutant survives,
read the fixture for a tie before reading the code for a reason.

## Page logic

`src/ui/app.js` is a classic browser script with no exports, so its logic
is tested by lifting a section out between two section comments and
importing the slice — see "what the take-a-desk dialog reads" in
`test/floor.mjs`, after `test/markdown.mjs`. To make page behaviour
mutation-checkable, put the decision in a small pure function inside such a
section (`recentFolders`, `savedName`, `takeBody`, `coverageText`,
`markHits`) and leave the DOM code as a caller. What only a real page can
show — what is drawn, in what order, with what focus — goes through
`verify-ui-change` and is reported as measured there, not as tested.

**A page check can be mutation-tested too**, and the DOM callers are
exactly what the lifted tests cannot see: in task 253, "`follow` ignored",
"a disabled button's click not refused" and "the card follows on the
board's 200 instead of waiting for the host" all stayed green in every
suite (QA predicted them green). [`run-page-mutant.sh`](run-page-mutant.sh)
applies the mutant in a copy, serves *the copy* on a private port, runs the
check against it and reports the check's reds; its header carries the
command for `check-card-move.mjs`. Use its own `--dest`-style copy
directory (`copy-repo.sh "$TMPDIR/orch-page-copy"`) — a page mutant can run
beside a suite mutant, since the ports differ, but never in the same copy.

## Running more than one at a time

`copy-repo.sh` with no argument always makes the same directory, and
deletes it first. A second run started while the first is in its suite
pulls the tree out from under it. Give each concurrent run its own
destination (`run-mutants.mjs <json> --dest <dir>`, `copy-repo.sh <dir>`);
the suites' own ports (host 8896, floor 8897, page checks wherever you put
them) decide what can share the CPU, and the host and window suites should
still run alone — under load their pane cases go red on timing (CLAUDE.md,
Tests).

## What goes in the report

For each item: the test's section and wording, and the mutant that turned
it red. QA re-runs a sample as "inversions" in its own clone; a report that
names both lets them predict the red before they run it, which is the check
on the check.

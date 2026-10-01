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

## What goes in the report

For each item: the test's section and wording, and the mutant that turned
it red. QA re-runs a sample as "inversions" in its own clone; a report that
names both lets them predict the red before they run it, which is the check
on the check.

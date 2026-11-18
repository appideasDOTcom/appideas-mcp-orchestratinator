# Coverage and testing: the milestone audit, and where it stands

The orchestratinator's first coverage and testing audit, by appideas-qa on
2026-11-17 at `0771ea8` (0.12.10), and the fix round that answered it,
0.12.11, re-measured by QA on 2026-11-18 at `37672c4` + `7bebe22`,
with four Lows that re-measure found fixed after it. costmo's
word for the round: "solidify our product and provide the foundational
proof before we pivot into some new features".

This page is the summary that lives with the code. The record is QA's, in
the QA repo:

- the report: `projects/appideas-mcp-orchestratinator/audit-2026-11-17.md`
- the notes, with the fix round's re-measure under "Fix round re-measure at
  37672c4": `projects/appideas-mcp-orchestratinator/audit-2026-11-17-notes.md`
- the evidence: `projects/appideas-mcp-orchestratinator/evidence/audit-2026-11-17/`
  (the re-measure in `r37/`)

Every figure below is from those runs, or from the developer's own runs at
the same commits, named where used.

## Topline

| Measure | Baseline, `0771ea8` (QA, one run) | 0.12.11, `37672c4` (developer's run) | 0.12.11, `37672c4` (QA's run) |
|---|---|---|---|
| Suites in `npm test` | 13, EXIT=0 | 13, EXIT=0 | 13, EXIT=0 |
| Assertions passing (✓) | 2,858 · 0 ✗ | 2,913 · 0 ✗ | 2,913 · 0 ✗ |
| Page checks | 17 of 17 | 17 of 17 | 16 of 17 (check-hide killed after its last step: the hang below) |
| **Code lines run** | **88.4 %** (15,681 / 17,747) | **88.3 %** (15,956 / 18,069) | **89.0 %** (16,085 / 18,069) |
| **Functions run** | **94.1 %** (1,064 / 1,131) | **94.3 %** (1,073 / 1,138) | **94.5 %** (1,075 / 1,138) |
| **Branches run** | **77.8 %** (8,061 / 10,366) | **78.1 %** (8,264 / 10,584) | **79.0 %** (8,124 / 10,288) |

The release gate at `37672c4` (`npm run release-gate`, developer's run):
`EXIT=0 · packages 0 · npm test 0 · pages 0`, 2,913 ✓ 0 ✗, release pages 11
of 11, Node v24.22.2, 1,139 s.

### Two runs of one commit do not read the same

The two 0.12.11 columns are the same tree, the same 17 checks and the same
instrument, and they differ by 0.7 points on lines, 0.2 on functions and
0.9 on branches. Almost all of it is `src/ui/floor.js`, which did not
change between the baseline and 0.12.11. Its lines read 86.3 %, 87.6 % and
90.0 % across the three runs (page-run lines 4,554, 4,621 and 4,773), and
its branch denominator 3,164, 3,294 and 2,982. Two things make the page
tier move:

- what a page runs depends on timing: polls, streams, one-second coverage
  takes and the machine's load (about 4 to 76 across these runs, as their
  logs record it: the developer's 4–9, QA's 11–35, the baseline's chain 7–9
  and its pages 11–76);
- V8 reports the inner blocks of a function only when the function ran, so
  the branch denominator grows and shrinks with what ran. That also moves
  branch counts on server and host files whose lines read identically
  (`host/index.js`: 580 / 739 in one run, 597 / 755 in the other).

So **a move of less than about 1 point on all, or about 4 points on
`src/ui/floor.js`, is not a measured change.** The three runs of the
unchanged `floor.js` span 3.7.

### Against the baseline, like for like

The topline's 0.12.11 columns count `scripts/coverage/report.mjs`, which
the baseline did not have (below). With it out of both:

| Measure | Baseline | 0.12.11, developer's run | 0.12.11, QA's run |
|---|---|---|---|
| Code lines | 88.4 % (15,681 / 17,747) | 89.1 % (15,956 / 17,909) | 89.8 % (16,085 / 17,909) |
| Functions | 94.1 % (1,064 / 1,131) | 94.4 % (1,073 / 1,137) | 94.5 % (1,075 / 1,137) |
| Branches | 77.8 % (8,061 / 10,366) | 78.1 % (8,264 / 10,583) | 79.0 % (8,124 / 10,287) |

Per measure:

- **Functions** moved 0.3 and 0.4 points, inside the spread.
- **Lines** moved 0.7 on the developer's run, about the spread, and 1.4 on
  QA's, more than it.
- **Branches** moved 0.3 on the developer's run, inside the spread, and
  1.2 on QA's, more than it.

The baseline is one run, so none of that can be called a gain: one
reading of the old code cannot say where its own spread lies. The changes
that are measured are the rows where the code changed, below.

"`report.mjs` gives QA's table exactly" is a claim about **identical
data**: run over the audit's own snapshots, the repo's report reproduces
QA's table row for row (31 of 31, `per-file.json` identical). QA also
recomputed the developer's run from its snapshots and got its table row for
row, except the lifted-section credit (Info I3, below). It is not a claim
that two runs agree.

### Where the code changed, the numbers moved for real

The same in both 0.12.11 runs:

| File | Baseline | 0.12.11 | Why |
|---|---|---|---|
| `host/index.js` | 86.3 % (989 / 1,146) | 87.7 % (1,032 / 1,177) | finding 4's acks, release and boot, finding 1's `pending`, all run |
| `host/window.js` | 88.8 % (1,774 / 1,998) | 90.4 % (1,813 / 2,006) | `askingIn`, `lineArrived`; stop and press now run at the window |
| `src/floor.js` | 96.1 % (2,175 / 2,264) | 96.9 % (2,276 / 2,349) | the `permission_request` case, the boot sweep, `release` |
| `src/db.js` | 96.8 % (1,404 / 1,450) | 96.9 % (1,428 / 1,474) | the work guarantee's queries |

Two rows went down, and neither is a test lost:

- `scripts/coverage/report.mjs` is new: 160 code lines at 0 %. It runs
  after the snapshots are taken, and the audit's rule counts every
  `scripts/**/*.mjs` (Info I2). It costs 0.8 points on all lines: the
  developer's run reads 88.3 % with it and 89.1 % without it.
- `scripts/set-version.mjs` went from 32.4 % (12 / 37) to 25.5 %
  (13 / 51): its new lines write the lockfile's version fields, and no
  suite runs the script (`smoke` checks only that the four files agree).

## By layer, at 0.12.11

| Layer | Code lines | Functions | Branches | Notes |
|---|---|---|---|---|
| `src/` server (12 files) | 81.5–100 % (11 of 12 ≥ 94.6 %; `build-info.js` 81.5 %) | 96.1–100 % | 65.7–87.6 % | `floor.js` 96.9 / 100 / 83.7; `db.js` 96.9 / 96.1 / 87.6 |
| `host/` (10 files) | 87.7–100 % | 85.7–100 % | 71.2–87.5 % | `index.js` 87.7 / 92.2 / 78.5–79.1; `window.js` 90.4 / 95.1 / 84.4–84.5 |
| `plugin/hooks/report.mjs` | 99.6 % | 100 % | 91.2 % | unchanged |
| `src/ui/floor.js` (page) | 87.6–90.0 % | 95.1–95.6 % | 73.2–75.6 % | the spread above; code unchanged since the baseline |
| `src/ui/app.js` (page) | 78.0 % | 85.6 % | 68.4–68.6 % | unchanged |
| `src/ui/hub.js` | 0 % | 0 % | 0 % | not measured: it runs in a SharedWorker, which the page coverage does not see |
| `scripts/` | `set-version.mjs` 25.5 %, `reanchor-facts.mjs` 0 %, `coverage/report.mjs` 0 % | | | release and coverage tooling |

Where a range is given for one file, it is the two 0.12.11 runs. The full
per-file tables: the developer's is the output of `npm run coverage` at
`37672c4`; QA's is `evidence/audit-2026-11-17/r37/coverage/table.md`, with
a copy of the developer's beside it.

How the numbers are counted, kept as the audit counted them
(`scripts/coverage/report.mjs`'s header has the rules):

- **Code lines** exclude blank and comment-only lines. c8 scores a comment
  by the function around it, and this codebase is comment-heavy.
- **Functions and branches** are c8's, from V8's own coverage.
- **Page files** are credited from two sources and shown as a union: the
  page checks under Chrome's coverage, and the sections of `src/ui/*.js`
  that `test:floor` and `test:markdown` lift out and import.

## The findings, and what became of each

Ruled in for 0.12.11 by costmo: findings 1–5 and items A–C. Findings 6–10
were not in the round and stand as the report wrote them.

| # | Severity | Finding | Status at 0.12.11 |
|---|---|---|---|
| 1 | High | An open question disappears from the floor at every board restart, and on a second session's tool call; nothing re-says it | **Fixed.** A prompt is cleared only by the session that raised it. Every heartbeat names the floor windows still asking (`pending`), and the board re-applies them. QA's probes: two sessions, the prompt stays (one-session control closes it); a restart, the heartbeat brings it back (an old host's, without `pending`, does not). Rows in `test:floor` and `test:host`. |
| 2 | Medium | What the stop sign sends to the window is not tested | **Fixed.** Rows in `test:window` (Escape, and no Enter) and `test:host`. QA's mutant F2 is red on named rows. |
| 3 | Medium | "Press yes / no" and its composer refusal are not tested | **Fixed.** Yes is `1`, no is Escape, nothing is pressed into a window back at its composer. Rows in `test:window`, `test:host` and the press route's in `test:floor`. Mutant F3a is red on named rows. |
| 4 | Medium | Work a host took is lost if the host stops before doing it | **Fixed and written down** (above `takeHostWork` in `src/db.js`). A host acknowledges what it finished, finishes the item in hand at a stop and hands back the rest, and the next run of a host sorts what an earlier one left: reads are handed out again, and window work is closed and said on its desk with the words handed back. At most once for window work, on purpose. QA's probe P2b: a killed run gives three error turns quoting the words, nothing handed out twice; a graceful stop gives done 1, released 2, and the next run gets them; an old host closes nothing. Not reached by P2b: a read-kind item being handed out again (rows in `test:floor` reach it). |
| 5 | Medium | The suites test a different stack from the one that ships | **Fixed as ruled** ("lock it and test what ships"). `package-lock.json` committed, the image installs it with `npm ci` on `node:24`, `install.sh` gives the host a Node 24, the gate refuses any other major. QA: the image is v24.22.2 with the lock's versions, a stale lock fails the build, and the install pick is right in all three cases. The live host is still on Node 20 until `install.sh` is re-run, once, at the 0.12.11 deploy (L3). |
| 6 | Low | Desktop hand-off work kinds (`handback`, `attach`, `claude`) have no host-tier test | Open, not in this round. |
| 7 | Low | Re-addressing a message has no test | Open, not in this round. QA's mutant A5 still survives, as predicted. |
| 8 | Low | Rows that assert less than their label | Open, not in this round. Mutant B1 still survives, as predicted. |
| 9 | Low | What runs only at an upgrade or a release (migration bodies, release tooling) is not run by the suites | Open, not in this round. |
| 10 | Info | Dead code; page functions no check reaches; instrument blind spots | Open, not in this round. |

And the three foundation items:

| Item | What | Status |
|---|---|---|
| A | The release gate as one command | **Done:** `npm run release-gate`. One log, one exit, on the shipped Node and packages. QA's seeded run in a copy (a red row in `test:markdown` and a broken page style) read `EXIT=1 · packages 0 · npm test 1 · pages 1`, with both seeds named and the pages run after the red chain. |
| B | The project owns a coverage reading | **Done:** `npm run coverage` (`scripts/coverage/`). QA's instrument, kept as measured; equal to QA's table on identical data. One defect found while re-measuring and fixed in the round: below. |
| C | QA re-proves the developer's kept mutants | **Done:** 191 of 191 red at `0771ea8`, each on a named ✗ row. |

The developer's 17 milestone mutants, in QA's lanes at `37672c4`: all red
(`.claude/skills/mutate-in-a-copy/mutants-milestone.suite.json`). F5 is red
only by the host suite stopping, not on a named row (L4, since given rows of its own). QA's own lanes
there: floor 50 of 52, host 13 of 15, window 18 of 18, seats 14 of 14,
every result as predicted. The four survivors are A5 and B1 (findings 7 and
8, not in this round) and A2 and A3, the same faults as F2 and F3a, which
the window suite catches on named rows. Controls: floor 1,416 ✓, admin
113 ✓, host 364 ✓, window 444 ✓, seats 99 ✓, renew 60 ✓.

**Fixed while re-measuring: `npm run coverage` could hang for ever under
load** (`7bebe22`). With page coverage on, `drive.mjs` took a reading every
second and `close()` never stopped it. A check that ends by running out of
code (check-hide) then never exited if a reading landed while its socket
was closing: each one armed a 30-second timer on a socket that would never
answer, and the next armed another. QA's run sat an hour on it at load 34.
`close()` now stops the readings first and still takes the last one.
Proved in a copy that holds the event loop past `close()`: the old file
hung 3 of 3, the fix exited 3 of 3 with the same nine coverage files, and
both exited without page coverage. The developer and QA each ran it.

## Found in the re-measure

Four Lows, each fixed in 0.12.11 at costmo's word (2026-11-18: "fix all
four"), and seven Infos left as known gaps.

**Low, fixed**

- **L1. A host killed mid-batch called finished work unsent.** The acks for
  a batch rode the next work poll, after the whole batch, so a host killed
  (not stopped) partway through had the items it did finish said "not
  sent … send it again", though they were typed. Now a host says each
  item finished as soon as it is, while the rest of its batch is still to
  go (`sayDone` in `host/index.js`, the release route with nothing to
  release). A host killed between typing a message and saying so has still
  typed it, so the words for a lost message say what the board knows: "may
  not have been sent: the host restarted while this message was in line.
  If it is not in the conversation, send it again". Row in `test:host`
  ("work finished in the middle of a batch, and then the host is killed").
- **L2. The gate's package check did not check the lock.** `npm ls --all`
  passed an installed version that differs from the lock but sits inside
  the range (1.4.0 against a locked 1.2.3). The gate now also runs
  `scripts/check-lock.mjs`, which holds every package to the lock's exact
  version (206 of 206 here). Rows in `smoke`, on a fabricated project.
- **L3. An update did not move the host to a new Node.** The updater's host
  step exits and launchd starts the host again, and the plist named a Node
  binary. The LaunchAgent now starts `host/run.sh`, which picks the Node
  at every start (`host/node.sh` has the rule, shared with `install.sh`),
  so a later bump is that one number and the restart an update already
  does. The live host's plist predates this and names Node 20, so the
  0.12.11 deploy re-runs `install.sh` once.
- **L4. `install.sh`'s Node pick had no named row.** The row passed with the
  old "first node on PATH" because the fixture's PATH held only Node 24
  (QA's Q1 survived). Now: a Node 20 first on PATH with a Node 24 after it,
  for `install.sh` and for `run.sh`; no Node 24 at all; and `node.sh`'s
  major against the Dockerfile's `FROM`. Rows in `test:host`.

The mutants for these are kept in
`.claude/skills/mutate-in-a-copy/mutants-milestone-lows.suite.json`.
And from QA's reading of this page: `smoke` read only each versioned file's
top-level `version`, so the lock's `packages[""]`, which `set-version` also
writes, went unchecked. It is checked now.

**Info**

- **I1.** The image's apt toolchain layer is unused: better-sqlite3 loads
  from its prebuilt binary.
- **I2.** `report.mjs` counts its own source (160 lines at 0 %) in all.
- **I3.** `run.sh` deletes the lifted page sections at its end, so a run's
  output folder cannot be recomputed whole. They belong in the output
  folder.
- **I4.** The `&&` chain hides every suite's verdict after the first red,
  and the gate's summary does not list which suites ran.
- **I5.** `run-release-pages.sh` has no per-check timeout. The gate itself
  has not been seen to hang.
- **I6.** In a copy of the tree (no `.git`), the release pages' header
  prints git's "fatal" twice and an empty head.
- **I7.** `check-popout` sometimes loses a 30-second CDP evaluate around
  its reattach click, which closes the window it evaluates in: 2 of 7 runs
  at load 19–26 on QA's seeded copy, 0 of 8 at load 13 or less on clean
  code. It follows the load and is not attributed to code.

## What the numbers cannot see

From the report (§6), still true:

- **A real Claude Code window and a real desktop.** The suites drive
  stand-ins that draw what the host reads. Typing into a real window is
  measured with a probe (`measure-a-real-window`), and opening a terminal
  or an editor is a desktop measurement.
- **A page over time.** A check runs a fresh page for about a minute.
- **The hub SharedWorker and windows a page opens itself** (popouts,
  meeting rooms): Chrome's coverage here is per page the driver holds.
- **Executed is not asserted.** A line that ran is not a line a row
  checks: mutant B1 survives on a line coverage reads as run. The mutants,
  not the percentages, are the proof that a behaviour is tested.

And from this round:

- **Run-to-run spread.** One run is not a measurement of a change smaller
  than the spread above.
- **Coverage tooling counts itself.** `scripts/` is in the denominator,
  including the report.

## How to rerun

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.2/bin:$PATH   # the gate finds Node 24 itself; the shell's default is 20
npm run release-gate     # every suite and the 11 release page checks; last line EXIT=
npm run coverage         # the suites and 17 page checks under coverage; out/table.md
```

Run each alone on the machine: about 20 and 25 minutes. Both name their
output folder on their last line. The instrument is QA's
(`scripts/audit-2026-11-17/` in the QA repo: `cov-chain.sh`,
`page-cov-run.sh`, `cov-report.py`); `scripts/coverage/` is its port, and
its counting rules are not to be changed without moving the baseline on
purpose. To compare against this page, run twice and read the change
against the spread.

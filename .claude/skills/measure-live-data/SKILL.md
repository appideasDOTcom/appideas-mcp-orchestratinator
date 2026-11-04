---
name: measure-live-data
description: Put numbers behind a design choice before building it — read the live board's database read-only inside its container, read the transcripts on the host's disk with the host's own parser, and set the two against each other. Use when a task says "measure first", when two stores could answer the same question (the board's `turns` and `agent_sessions` versus the JSONL on a host), and before claiming how much of anything the board has. Also for dating something that happened before anything recorded its time (an untimed host-log stretch, a past burst): anchoring the log's order to admin_events, turn lag, what ran on this machine when, and the machine's other clocks.
---

# Measuring what the board and the disk actually hold

Rulings on this project are made on measurements, and the measurement is
usually the first step of the task: *what share of the real data can each
option see, and what does one query cost*. This is the routine that produced
the numbers issue #8 was decided on, with the three ways it produced a wrong
number first.

## The two stores

| | where | read it with |
|---|---|---|
| the board's copy | SQLite in the server's **named volume** — not `data/` in the repo, which is test leftovers | `board-query.sh <script.js>` |
| the transcripts | `~/.claude/projects/<slug>/<session>.jsonl` on each host, subagents in `<session>/subagents/` | `host/window.js` — `readTranscript`, `sessionsIn`, `projectDir` |

```bash
D=.claude/skills/measure-live-data
$D/board-query.sh $D/board-snapshot.js | tee /tmp/board.out | grep -v '^@@JSON@@'
grep '^@@JSON@@' /tmp/board.out | sed 's/^@@JSON@@//' > /tmp/board.json
node $D/disk-join.mjs /tmp/board.json
```

`channel-sets.js` answers one specific question that has come up twice: which
channels each source yields — `listAllChannels`, `agents`, `messages`,
`tasks`, `contracts`, `personas`, `channel_flags`, `hosted_desks` — with the
names in every difference and the row counts behind the channels that are
only in one. It is the measurement issues #21 and #6 were decided on, and
the first thing to run when the board and the floor disagree about how many
floors there are.

`board-snapshot.js` and `disk-join.mjs` answer the general questions — how
many rows, sessions and desks; how many conversations are on disk; how many
of those the board has any row for; what it costs to read them all. For the
question in hand, copy one and add to it. Keep the output files out of the
repo.

Both are read-only and neither touches the host or restarts anything. Open
the database `{ readonly: true }`, always: it is the operator's live board.

## What the board's copy is

Know this before measuring anything against it, because every one of these
has been mistaken for a fault:

- **`turns` is a tail, by design**: the newest `TURN_RETENTION` (400) rows a
  desk, pruned on a timer (`src/db.js`). Twenty-odd desks sit at exactly 400.
  It is not an archive and was never meant to be one.
- **A conversation picked from the list is joined mid-stream** — at its last
  64 KB if the board had never seen it, at its end if it had — so the rows
  the board holds for it start in the middle and keep their holes.
- **`turns` rows include subagent turns** (`via`), which on disk are in
  separate files. Counting main transcripts only makes the board look more
  complete than it is; two conversations read "154%" that way.
- **A `tool` row's text is one line** — the tool's name and the first 300
  characters of its command or path — never its output. Tool rows are about
  two thirds of all rows.
- **`agent_sessions` has no titles**, a model for one row in four, rows for
  transcripts that are on no disk you can read (other machines, imported
  data), and no row at all for a conversation the hook never reported.
- **`hosted_desks` keeps a row for every desk a folder has ever been.** The
  same `cwd` is in it several times.

## Three wrong numbers, and why

**306 files for 104 conversations.** The list of folders came from
`hosted_desks`, which names some folders three times; every conversation was
read three times and listed under three desks, and a search "took 7.7 s".
One folder once: dedupe by canonical `cwd` (`disk-join.mjs` does). And say
which list you used — the board's table (19 folders, 104 conversations that
day) and the host's own live desks (17 folders, 98) are different counts of
the same disk, and both appeared in one thread.

**"Including tool calls adds 0–2 conversations."** True of the board's copy,
which is where it was measured; reported as if it were true of the
transcripts, which is what got built. On the transcripts the same switch
took "osascript" from 4 conversations to 10 and "npm test" from 11 to 25.
QA caught it. **A number is about the store it was measured on. Measure the
option that will be built, on the store it will run on, and label every
figure with its store.**

**A raw byte scan is nine times faster and the wrong search.** `grep` finds
"osascript" in 24 files; it was said in 4 conversations. Most of a
transcript is tool output and JSON. Anything about "what was said" has to
go through `readTranscript`.

## Timing

Time the thing as it will run. A search measured in-process (2.7 s) was
built as a child process, so it was measured again as one (`/usr/bin/time -p
node host/history.js < ask.json`: 2.9 s wall). Give the file count and the
machine with every timing; "2.7 s" means nothing without "104 conversations,
645 MB, this laptop".

`created_at` in SQLite is to the second. Anything derived from it — an age,
a `waited_ms` — carries up to a second of phantom time.

## Dating what happened before anything recorded the time

Task 262 (issue #5, 2026-11-03): 7,066 host→board failure lines in a log
with no times, to be dated and named the same day rather than waiting for a
capture. It worked, and costmo closed the issue on it. The tools:

```bash
D=.claude/skills/measure-live-data
$D/board-query.sh $D/dating-dump.js > /tmp/board.json              # turns, admin_events, messages; read-only
node $D/align-host-log.mjs ~/.orchestratinator/log/host.log /tmp/board.json --min 40   # every failure run, bounded by timed anchors
node $D/turn-lag.mjs "$PWD" /tmp/board.json                          # arrival vs written, by role; releases across desks
node $D/what-ran.mjs 2026-11-02T17:40:00Z 2026-11-02T18:15:00Z --grep 'e2e|playwright|docker'   # what any session ran then
```

`what-ran.mjs` cuts a long command (180 characters) or result (200)
around the first match, between `…` marks, so the reason a line was
printed is on it. It used to print the first 180 characters, and in the
window above 3 of 4 lines matched past the cut (QA, PR #38 Info 6).

**The log's order is a clock once anchored.** Host lines that answer the
operator (an answered form, a new conversation, a bind, a reopen by id, a
move by path) pair with timed `admin_events` rows, and each failure run
sits between two of them. Use the longest chain, never a greedy walk: greedy
drifted by days and put 2,700 lines into 35 minutes. The chain reproduced
QA's own placement of a run to the second.

**Other clocks on this machine**, measured that day, with how far back each
reaches:

| clock | read with | reaches |
|---|---|---|
| sleep / wake | `pmset -g log \| grep -E '^[0-9-]+ [0-9:]+ [+-][0-9]{4} (Sleep\|Wake\|DarkWake) '` (the event column; Assertion lines also say "Wake Lock") | ~4 days (a ring) |
| deploys | `docker images -a --format '{{.ID}} {{.CreatedAt}}'`: one build per `up --build` | as long as old images aren't pruned |
| reboots | `last reboot` | since wtmp began |
| VM under load | `/Library/Logs/DiagnosticReports/com.apple.Virtualization.VirtualMachine_*.cpu_resource.diag` | recent days |
| Docker Desktop's logs | capture-a-burst's table | ~25 min (monitor.log) to ~10 h (backend) |
| docker events | `docker events --since …` | **minutes only**, useless for history |
| what ran | `what-ran.mjs` over every transcript | as long as transcripts are kept |

**What it named, so the next reader starts there**, from the 7,066 lines:
- **Deploy swaps:** one line each, which an image build time matches.
- **The laptop asleep:** 2,506 lines. These are work-poll timeouts at the 1 s step, with no event failure and nobody working. They matched the DarkWake counts (136 vs 146), and stopped when the Mac stopped sleeping.
- **The board unreachable for hours:** 3,997 lines, not named.
- **Awake, with events failing too:** 237 lines, which began with QA's e2e matrix. A reproduction then caught it: the Docker VM out of memory at 4 GiB.

**Three wrong turns:**
- **Turn lag read across roles.** Only user turns are a clean clock (p50 0.27 s). Assistant and thinking turns carry generation time, so on their own they look like a lagging relay.
- **Turn lag used to date a stall that never held events.** The sleep population left no trace in `turns` at all.
- **A "Docker-heavy" pattern that also matched this repo's own deploys.** It took a window days wide as an overlap. Ask what ran in the minute a burst *started*.

## Reporting it

To the QA desk on the channel, as the ruling's raw material: what was
measured and how, each store's coverage and cost with real examples, the
options that follow, and your own read in a sentence. Then keep building
whatever does not depend on the answer, and poll before building what does —
the ruling arrives as a task.

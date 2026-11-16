---
name: verify-ui-change
description: See a board or floor change actually work in a browser before reporting it — seed a throwaway server, drive the real page headlessly, and read the result. Use for any change to src/ui/*, and before claiming any UI behaviour is fixed.
---

# Seeing a UI change actually work

Both surfaces are drawn from live server state, so source that reads correctly
can still be wrong on the page. The only honest test is the real page against a
real server. This is how to get one in about a minute, and — more importantly —
the specific ways this has produced a **false pass**.

## Ten ways a green result has lied here

**Probing the panel before it has caught up.** Clicking a desk renders its
panel *asynchronously* — `openDesk()` fetches turns first, then renders — and
"the panel is visible" was already true from the previous desk. A probe waited
on visibility, read desk A's buttons against desk B's name, and reported two
gating states swapped; the assertions were right and the fixture was right,
and the read was still of the wrong desk. The panel now says whose it is:
**wait on `#floor-panel` having `dataset.agent === '<agent>'`**, which is set
in the same synchronous pass that gates the links, so once it matches, the
strip is that desk's.

**Testing one of two entry points.** The same dialog opens from the board and
from the floor, and they do not share a path: floor pills call
`window.taskDialog(...)` directly, board pills go through a `[data-do]` click
handler. A change was verified through the floor and reported working while the
board path threw `TypeError` on every click — for two rounds. **List the entry
points before testing, and drive each one.**

**Testing the twin.** A scratch server was left running from an earlier attempt;
the new one died on `EADDRINUSE` and the results being read came from the old
process against a different DB. Everything looked plausible and none of it was
the code under test. Confirm the thing answering is the thing you just started.

**Asserting the fixture instead of the feature.** A probe that sets up the wrong
state passes or fails for reasons that have nothing to do with the change. Two
real cases, one after the other: a check for "the desk is still awaiting" failed
because `/api/floor/answer` clears awaiting the instant it queues work — the
assertion was backwards, not the code. And a fallback was probed with an
`idle_prompt`, which correctly raises nothing, so the feature looked broken when
the fixture was simply inert. **Before believing a FAIL, print the state you
built and confirm it is the state you meant.** Read `/api/floor` directly; the
payload shape is not what you assume either — an alert hangs off
`channels[].desks[].permission`, and a `permission_prompt` notification creates
one of those with every choice `null`.

**A fallback that happens to match the fixture.** A new payload field was read
in the page as `` `tmux attach -t ${h?.tmux ?? 'orch'}` ``. The probe showed
`tmux attach -t orch`, which was the right answer — arriving entirely from the
`?? 'orch'` default, because the field was `null` the whole time. The query
selected the column; the hand-picked projection that builds `hosted` in
`src/floor.js` silently dropped it, and **a column the query selects is not a
column the page gets.** Two lessons: read a new field's value out of
`/api/floor` before trusting anything drawn from it, and **seed a fixture whose
value cannot equal the fallback** — the second run used a host whose tmux session
was named `deskside`, which failed instantly and correctly.

**A page that says "nothing here" while the API says otherwise.** The chat
panel does not fetch a desk's turns flatly — `sessionFilter()` scopes them to
`hosted.session_id`, so a fixture whose `turns.session_id` is anything else is
fetched by nobody. The symptom points away from the cause: `/api/floor/turns`
with no `session` parameter returns every row, so the API looks perfect while
the panel draws *"No conversation captured yet."* Seed `hosted_desks.
sdk_session_id` and the events' `session_id` as the same string, which
`seed-desk.mjs` below does. The same shape bites anything else scoped by a key
the fixture does not carry: check what the *page* asks for, not what you can
get the API to answer.

**Reading the served file from the wrong path.** The UI is served from the
root — `/floor.js`, `/app.js`, `/styles.css` — because `express.static(UI_DIR)`
mounts it there, not under `/ui/`. `curl …/ui/floor.js` returns Express's
404 page, and grepping *that* for your change reports the change missing, which
reads exactly like a stale container. Fetch `/floor.js`.

**Measuring the container instead of the contents.** `getBoundingClientRect()`
includes padding, so "is there padding?" answered itself wrongly. Read computed
styles, or measure the child. On an **SVG shape it is the fill box and excludes
the stroke** — a 16px-tall octagon in a 16px box measures 14.78, and its visible
edge is another half a stroke beyond that. To check what a mark looks aligned
*to*, add `stroke-width / 2` at each edge; comparing raw rects will say a glyph
overflows its button when it sits exactly on the line. Related: `color-mix()` computes to
`color(srgb 0..1)` floats while a hex literal computes to `rgb(0..255)` — compare
those directly and a darker colour reports as lighter. Convert before comparing.

**Reading the text when the fault is in the drawing.** A probe returned
`/repo/deep/nest/zeta-newest` for a row's path and the row was wrong: on
screen it read `repo/deep/nest/zeta-newest/`, the leading slash drawn at the
far end, because `direction: rtl` (used to cut a long path at the left)
reorders a neutral character. `textContent` is the logical string and will
never show that. **Anything about how text is laid out — truncation, bidi,
wrapping, which end is cut — is only in a screenshot.** Take one with
`page.shot()` and look at it; the fix there was a `<bdi>` around the path.

**Shooting an element below the fold.** `page.shot(path, selector)` clips
the viewport at the element's rect, and an element that sits under the
window's bottom edge comes out as a band of whatever is painted there — the
floor's pill list at y=1077 in a 913px window was captured as a strip of
building wall, which read as "the pills are not drawn" while a rect probe
put them exactly where they belonged (2026-11-02). For anything that may be
below the fold, probe `getBoundingClientRect()` first, and shoot with
`shot(path, null, { full: true })`.

**Clicking a button a person could not.** `page.click()` dispatches a
`MouseEvent`, and a delegated `[data-do]` handler runs for it whether or not
the button is `disabled`. A check clicked "Choose folder…" while it was
disabled and saying "looking…" — left that way by a flag nothing cleared
after a change of host — and the flow carried on, green, through a control no
person could have pressed. **Read `disabled` off the button before clicking
it**, as part of the probe, and treat a disabled button you expected to
press as the finding.

## A throwaway server

Never seed `:8787`. Its pill counts are a deliberate demo fixture the operator
is looking at, and reseeding silently destroys the thing being demonstrated.

**Order matters — the server creates the schema, so start it before seeding.**

```bash
PORT=8905 DB_PATH=./data/scratch.db ORCH_AUTH_TOKEN=k node src/server.js &
for i in $(seq 1 40); do curl -sf localhost:8905/health >/dev/null && break; sleep 0.25; done
node <your-seed>.mjs        # only now
```

Seed scripts live in the scratchpad, which is **outside the repo**, so
`import Database from 'better-sqlite3'` will not resolve. Point the resolver at
the repo instead of moving the file into it:

```js
import { createRequire } from 'node:module';
const require = createRequire('<repo>/package.json');
const Database = require('better-sqlite3');
```

Seed `agents` and `personas` for board rows, `messages`/`tasks` for pill counts.
Check the result through `/api/state` and `/api/floor` before opening a browser —
if the payload is wrong the page cannot be right, and the API says so faster.

**Read the schema rather than this file.** `personas` is
`(channel, agent, seat, assigned_at)` — there is no `persona` column, because the
name is derived from the agent id rather than stored. Any column list written
down here is one migration from being a lie that costs a round:

```bash
node -e 'const r=require("module").createRequire(process.cwd()+"/package.json");
  const db=new (r("better-sqlite3"))("./data/scratch.db",{readonly:true});
  for (const t of ["personas","hosts","hosted_desks"])
    console.log(t, db.prepare(`PRAGMA table_info(${t})`).all().map(c=>c.name).join(", "));'
```

**Some state has no table at all.** Anything on `live` in `src/floor.js` — the
streaming reply, a held permission prompt, the "queued" delivery note — is in
memory and cannot be seeded with SQL. Put it there the way a host would, through
`/api/host/events` with the shared key, which also exercises the path under test:

```bash
curl -s -X POST localhost:8905/api/host/events -H 'content-type: application/json' \
  -H 'x-orchestratinator-key: k' \
  -d '{"host_id":"h1","events":[{"type":"delivery","channel":"…","agent":"…","state":"queued","text":"…"}]}'
```

## Making a desk chattable or nudgeable

The Nudge button and the compose box are gated by `deliverable()` in
`src/floor.js`, which wants a `hosts` row, a `hosted_desks` row, and
`outside_pid` NULL (non-null means an editor holds it):

```js
db.prepare(`INSERT OR REPLACE INTO hosts (host_id,name,last_seen) VALUES (?,?,datetime('now'))`).run('h1','testbox');
db.prepare(`INSERT OR REPLACE INTO hosted_desks (channel,agent,host_id,cwd,window_id,outside_pid,state,updated_at)
            VALUES (?,?,?,?,?,NULL,'idle',datetime('now'))`).run(CH,'bo','h1','/repo/bo','bo-window');
```

**A seeded host goes stale in 90 seconds** (`HOST_STALE_SECONDS`), which is less
than a browser run takes. Without a heartbeat the button silently becomes
"host is offline" mid-test and the failure looks like the feature. Run a beat
alongside:

```js
setInterval(() => db.prepare(`UPDATE hosts SET last_seen=datetime('now') WHERE host_id='h1'`).run(), 2000);
```

That staleness is also the cheapest way to test a *refused* action: let it age,
or age it deliberately between rendering a dialog and clicking its button.

### seed-desk.mjs — the whole fixture, in one command

Most checks of the chat panel or a desk's bubble need the same thing: a live
host, a desk it runs, and turns of every kind on it. [`seed-desk.mjs`](seed-desk.mjs)
builds that, keeps the host's heartbeat going for as long as it runs, and
prints what the server made of it — so the API has answered before a browser is
opened.

```bash
node .claude/skills/verify-ui-change/seed-desk.mjs http://localhost:8905 &
# → events: 200 {"ok":true,"applied":8}
#   turns the panel will fetch (session-scoped): 8
#   … one row per kind: user, assistant, tool, subagent turns carrying `via`,
#     a thought from the subagent, a thought from the main thread
#   bubble  : "I'll leave the console checkboxes as is since…"
```

Turns go in through `/api/host/events`, never SQL: `applyHostEvent` refuses an
event whose desk it does not own, so posting them exercises the path a real
host uses and rows no host could have produced cannot be seeded by accident.
**`{"ok":true,"applied":0}` is the failure to watch for** — a 200 with every
event refused, usually a `hosted_desks` row that did not land or names another
host. It is not an error in any log.

### seed-form.mjs — a desk holding a question form

A check of the question panel needs a desk with an AskUserQuestion on it,
and a `PermissionRequest` through `/api/ingest` is not enough on its own:
the panel draws `permission.questions`, which the board fills only when a
host's `prompt` event settles the form. [`seed-form.mjs`](seed-form.mjs)
posts the call with three questions (two single-choice, one multi), takes
the host's work and answers it as a host that read no form off the pane, so
the form is drawn from the call — and keeps the host fresh while it runs.

```bash
node .claude/skills/verify-ui-change/seed-form.mjs http://localhost:8905 &
# form     Colour[single,3] Fruit[single,3] Days[multi,3] | hosted true | from call
```

Then in the page: click `.desk[data-agent="typist"] .deskHit`, wait on
`#floor-panel .p-ask`, tick inputs with a bubbling `change` event (the page
redraws the lines under the form on `change` and `input`), and read
`.p-ask-warn` and `.p-ask-note`. The free-text radio is
`.p-q[data-q="1"] input[data-other="1"]`; its field `.p-other` is enabled
once it is ticked. Measured 2026-11-02 for the withdraw note (issue #7,
round 2): hidden at start, shown with `display: block` the instant the row
is ticked, hidden again when a pick replaces it, never shown for the multi.

### seed-archive.mjs and check-archive.mjs — archive on both views

Issues #21 and #6 (2026-11-02): archive is the one way to put a floor away,
the pill lists at the bottom of both views are the only place a put-away
floor is drawn, and the board and the floor list the same channels.
[`seed-archive.mjs`](seed-archive.mjs) builds the fixture — two ordinary
channels, one with unread mail and an open task so a pill has counts to
carry, and `solo-only`, a desk made by a hook event alone with no agents
row (the #6 shape) — and keeps a host heartbeat so Take a desk draws its
dropdown. [`check-archive.mjs`](check-archive.mjs) then drives both views
through the round trip with [`probe-archive.js`](probe-archive.js) and
prints what each page drew at every step:

```bash
PORT=8905 DB_PATH=./data/scratch.db ORCH_AUTH_TOKEN=k node src/server.js &
node .claude/skills/verify-ui-change/seed-archive.mjs http://localhost:8905 ./data/scratch.db &
node --experimental-websocket .claude/skills/verify-ui-change/check-archive.mjs http://localhost:8905 /tmp/shots
```

Read the output for: no `–` buttons and no archived toggle on the board; a
put-away floor in neither view's cards, rooms, chips, filter or Floor
dropdown and in both pill lists with its unread count; "put away" on a
storey opening the channel dialog; the hook-only floor archived from the
floor turning up as a pill on the board; a floor archived under you landing
you on all floors. The assertions themselves are in `test/floor.mjs`
("archive is the one way to put a floor away, on both views"); this shows
the page.

### seed-move.mjs and check-card-move.mjs — the card's move, on both views

Issue #18 (2026-11-03): **Move to another floor** on a desk's nameplate
card. [`seed-move.mjs`](seed-move.mjs) is the fixture *and* the host: one
floor (`alpha`) with a desk the host runs (`ann`), one live by its hooks
with no host (`ed`, the disabled button) and one whose host is two days
gone (`cy`, not drawn at all — a hosted desk is as live as its host); it
long-polls the host's work and answers a move's `bind` as `host/index.js`
does (`bound` with `from`, then a new session), printing every work item as
a JSON line. [`check-card-move.mjs`](check-card-move.mjs) drives the card
from all floors and from one floor, the refusal in the dialog, and where
the page lands, and reads the binds back out of that log:

```bash
PORT=8906 DB_PATH=/tmp/move.db ORCH_AUTH_TOKEN=k node src/server.js &
node .claude/skills/verify-ui-change/seed-move.mjs http://localhost:8906 /tmp/move.db > /tmp/work.jsonl &
node --experimental-websocket .claude/skills/verify-ui-change/check-card-move.mjs http://localhost:8906 /tmp/shots /tmp/work.jsonl
# … 23 ✓ · PASS
```

Two things it taught, both about reading the page rather than the feature:

- **"All floors" is two views.** With two or more floors it is the
  building, where a click on a desk rides to its floor and no card opens;
  with one floor nothing is collapsed and no floor is chosen. The seed
  starts with one floor so the all-floors move is a thing a person can do.
- **Where the page stands is `localStorage['orch.floor']`, not the lit
  chip.** The picker draws no chips with one floor on the board, and a move
  that empties the floor it left can leave exactly one — the first cut
  waited for a chip that would never be drawn, and timed out on a move
  that had landed.

### seed-hide.mjs and check-hide.mjs — empty desks and Hide desk

Issue #20 (2026-11-03): a desk with nothing live behind it is not drawn, a
desk the operator hides is a pill under its storey, and the pill restores.
[`seed-hide.mjs`](seed-hide.mjs) builds one floor with a desk per nameplate
reading — hosted and ready, live by hooks with unread mail, an agents row
alone, hosted on a host two days dead, a session that ended — plus a floor
with one live desk and one whose only desk is empty, and keeps the live
host's heartbeat. [`check-hide.mjs`](check-hide.mjs) drives the floor with
[`probe-hide.js`](probe-hide.js):

```bash
PORT=8905 DB_PATH=./data/scratch.db ORCH_AUTH_TOKEN=k node src/server.js &
node .claude/skills/verify-ui-change/seed-hide.mjs http://localhost:8905 ./data/scratch.db &
node --experimental-websocket .claude/skills/verify-ui-change/check-hide.mjs http://localhost:8905 /tmp/shots ./data/scratch.db
```

Read the output for: two desks drawn of five with `2/5 here` on the header
and the all-empty storey ending at its header band (`h=88`); Hide desk on
the card and the card gone on the click; the pill with its count under the
last desk, `N/M here` unchanged; an empty desk hidden by API as a pill and
restored to *nothing* (it is empty); the host coming back drawing a desk
with nothing clicked; archive leaving neither desk nor pill, and the pill
back on restore, under the collapsed storey too; Enter on a focused pill.
The check tells the two "the click did nothing" causes apart — the card's
own click branch swallows a button it does not name, which is how the
first cut of Hide desk failed here and not in the suite.

### seed-meeting.mjs and check-meeting.mjs — a meeting room (#44)

Issue #44 (0.12.0): several desks of one floor in one window.
[`seed-meeting.mjs`](seed-meeting.mjs) is the floor *and* its host: `lab`
has bo, cy, dee (live), ed (held by an editor) and `lab2` has zed, with
two unread board messages for bo and one for cy. As host
it records each chat as the desk's user turn and answers it, cy saying
`queued` first. It answers a `/command` with a `receipt`, `sessions` with
the desk's conversations, and `reopen` by moving the desk's session. It
prints every work item as a JSON line, which is how the check reads who
was sent what. A `--ctl` file moves a desk's session between steps.
[`check-meeting.mjs`](check-meeting.mjs) drives create, the floor while
desks are out, send to everyone, a nudge (the unread badges, one desk's
bell, the backlog dialog's Mark all read, Nudge everyone), a click on each To chip (solo with
everyone lit, everyone back from the last lit one, a toggle between, and each chip's hover words;
`chipClick('bo')` is how a later step narrows to one desk; the choice stays after a send, so a
step that needs everyone again clicks `[data-act="m-to-all"]`), narrowing, a refusal, a permission
prompt, Stop, a command receipt, a question form, Remove, Bring back, a
reload, End, the Recent list, Resume and close, about a minute and a half:

```bash
PORT=8941 CDP=9281 .claude/skills/verify-ui-change/run-check-meeting.sh "$PWD"
# … PASS
```

Since 2026-11-16 (0.12.9) its nudge step reads the button as "Nudge all
(3)" and then "Nudge all (1)", presses it with one desk's mail waiting and
reads the host's work: one chat, to that desk, with the transcript's line
naming it alone. Then, with nothing waiting for anybody, the button with no
count, dimmed, a click sent to it nudging nobody, and a desk's own bell
still nudging that desk. 143 rows. Its mutants are kept:
[`mutants-room-nudge.page.json`](mutants-room-nudge.page.json) (the click
typing into every desk chosen: two red) and, for the label and the choice
of desks, `../mutate-in-a-copy/mutants-room-nudge.suite.json` (four, all
red in `test:floor`). **The README's and the operating guide's meeting-room
pictures still show the old label** ("Nudge everyone · 1 unread"); they are
retaken with `readme-shot.mjs` at the next docs round, whose width note is
about that label and wants re-measuring for the shorter one.

Since 2026-11-14 it also drives a participant's box as a control: every
box clicked off and on again, a real click on a name and on a state word,
a dimmed button in the box (which must not toggle it), Enter on the
focused box, a turn arriving while its desk is hidden, a hidden desk
removed, and a reload. `rows()` reads the transcript as `{ key, by, to,
body }`, with `by` from `data-said-by` on a desk's turn and `to` from a
message's delivery lines; `boxOf(a)` reads a box. Two things from building
it. **Count the fixture before writing the expectation.** The first cut
expected one message to Cy alone to go with Cy, and the room held two: the
one sent by name, and the nudge Cy's bell had rung eighty lines earlier.
The page was right and the check was red. The step now finds them by
their delivery lines and says how many it found. And **a step that reads
focus needs a redraw forced under it**: focus survived on one run in two
only because no poll had redrawn the row yet, so the step makes Bo start
working first. A third came from its mutants: **a wrapped label inside a
fixed-height button does not change the button's height.** The Nudge
button is 28px whatever its label does, so a check on its rect passed
with "unread" spilled under it and the mutant survived. `scrollHeight`
reads it (26px on one line, 40px wrapped).

Two things it cost a round to learn. A label drawn with `text-transform:
uppercase` reads `CY` through `innerText`; read `textContent` for what the
page wrote. And this check's own server is found by its PID: `node
src/server.js` carries its port and DB in the environment, so a `ps | grep
8951` kill matches nothing. On 2026-11-05 that left a server from the run
before answering on the port, and check-select read a desk the last run
had hidden as missing ("testing the twin" above). Kill what you started,
by the PID you got when you started it. To tell which throwaway server is
which once they are running, read each one's environment:
`ps eww -p <pid> | tr ' ' '\n' | grep -E '^(PORT|DB_PATH)='`. A QA page
run or a `run-check-*.sh` may own one, so kill only yours.

### check-meeting-box.mjs — a meeting's box on the floor (2026-11-16)

The desks in a meeting room stand in a box of their own on the floor, with
"In a meeting" and an End meeting button on its corners.
[`run-check-meeting-box.sh`](run-check-meeting-box.sh) serves any directory
with `seed-meeting.mjs --more` (five more live desks on `lab`, nine in all,
so one floor holds two meetings and desks besides; without the flag the
seed is as check-meeting.mjs expects), its own Chrome, and
[`check-meeting-box.mjs`](check-meeting-box.mjs), reading the page through
[`probe-meeting-box.js`](probe-meeting-box.js):

```bash
PORT=8945 CDP=9285 .claude/skills/verify-ui-change/run-check-meeting-box.sh "$PWD"
# … PASS · 105 of 105      (about a minute and a half)
```

It opens real meeting windows from the selection toolbar and reads: the box
from the click and one box throughout; three to a row, the box's edge and
both placards with their words measured on their plates; an envelope
leaving a boxed desk from where it is drawn; a second meeting stacked
under the first; a desk brought back; End pressed in a selecting room; the
building (boxes side by side in the one row, "End" around one desk, a real
press that does not ride to the floor, a press on the box's carpet that
does); End by keyboard with every desk back where it stood and an open
card following its desk; Resume; a window that never hears `end`, closed
by the floor; a second floor tab with no window to close; a reload of the
room's window; and both themes. Pictures land in the run's `shots/`. What
it taught:

- **A state drawn for a moment is read from a MutationObserver's log**
  (`watchBoxes`). Two boxes for one meeting half-way through its desks, a
  placard reading "Ending…", a box emptying a desk at a time: each is gone
  before a poll reads it. The log keeps each box's room, button text,
  whether it can be pressed, and who its label names.
- **A second press can be swallowed by the first one's state.** The first
  run read two reds that were one bug: a room resumed four seconds after
  its End came back still "Ending…", and the next step's press on it did
  nothing. That step asserts the fixture too (`dropped === 1`), which is
  what showed the press had not been taken.
- **"The window did not hear it" is staged on the sender.** The floor's
  `BroadcastChannel.prototype.postMessage` is wrapped to drop `end`
  (`deaf()`), which is what a window loaded before the build is. The
  receiver's handler is inside the page's closure and cannot be reached.
- **A page that moves another window is read in two places.** A click on
  "In a meeting" brings the room's window to the pointer. `watchCalls`
  wraps the room window's own `moveTo`, `resizeTo` and `focus` (the floor
  calls them through its handle, which finds the wrapped ones), so the
  order and the arguments are read. `page.windowBounds()` in `drive.mjs`
  is the browser's own word for where the window then is, and
  `windowBounds({ left, top, width, height })` places it first: a headless
  screen is 800x600 and a window that fills it cannot be told from one
  that never moved.
- **A desktop the browser does not have is told to the page, and the row
  says so.** Moving a window to another screen needs Chrome's
  window-management permission, asked with `getScreenDetails()`. A headless
  Chrome has one screen and puts no question, so `leave(page, 'granted' |
  'denied' | null)` sets `screen.isExtended` and the answer, and the
  window is put past the screen's edge with `windowBounds`. The rows prove
  that the page asks once, only for a window on another screen, and moves
  again when the answer is yes. They do not prove the window crosses: that
  is Chrome's, seen on costmo's three screens or not at all. The first
  row of the step is the fixture's own (`far.left >= scr.width`).
- **Headless is not the desktop for a raise.** Headless left a minimized
  window minimized after `focus()` (measured 2026-11-16 with
  `windowState('minimized')`, then `windowBounds()` reading `minimized`
  after the click). That says nothing about Chrome on macOS, so the check
  has no row for it. On real Chrome on macOS costmo measured it the same
  day: the window came back, to the front, under the pointer. A desktop
  behaviour he has watched is measured. Record what he saw and where;
  do not leave it written up as unmeasured.
- **A control never seen to fail may never have run.** The suite's rows
  for the new placement reused a name already declared in their block,
  and `test:floor` died on a SyntaxError before its first row. A grep for
  `✗|PASS|FAIL` printed nothing for it and the next command's PASS stood
  alone on the screen. `run-mutants.mjs --control` said `0 ✓` and the
  error. Read the suite's verdict line itself, not the absence of a ✗.
- **Count the fixture before writing the expectation**, again: a row
  expected Ed to move up 100px when a one-row box left; it moves 44.
- **`page.scheme('light' | 'dark' | null)`** in `drive.mjs` sets the
  colour scheme the page is told. A headless Chrome takes the machine's,
  so a colour that only works in one theme is otherwise never looked at.
- **What is clipped is asked with `elementFromPoint`.** A rect is the same
  whether or not a clip path cuts it. The storey's clip is widened for a
  box, and the row for it asks what is under a point on the box's edge.

Mutants, as QA ran them in PR #56's review at `b8c0d73` (2026-11-16; the
review is the record): the suite list, 17 of 17 red (fifteen of ours and
two of QA's). The page list, 23 of 25 red. The two greens were rows that
saw their fault only by chance, and each has a row of its own now: the
reload row read a redraw only if a poll landed in the gap, and is now
given one in the gap (Info 2); and no row reached the one-screen guard on
the window-management question, which the tab with no handle now does
(Info 3). QA's own page mutants QP3 (the storey lit under the label) and
QP4 (the box leaving after its window closes only at the next poll) were
green too. Both have rows now: the label is hovered, not pressed (`hover()`
in drive.mjs), and the box must leave with the floor's poll held
(`holdPolls`), inside five seconds of the press. A row that waited eight
let the mutant through even with the poll held: End's own "Ending…" timer
redraws the rooms at six seconds. And the reload's gap is drawn after
*each* desk's going, not the first. With one desk still in, the box
stood around it and the mutant's log read one box throughout. The fixes for the review, and one bug the new rows found
(End's close timer closed a room resumed inside it), added eight page
mutants and two suite mutants to the lists, marked `PR #56`.

Both lists are kept beside the check, because a list in a scratchpad is
gone with the session: [`mutants-meeting-box.page.json`](mutants-meeting-box.page.json)
(thirty-three; the last eight are PR #56's) and
[`mutants-meeting-box.suite.json`](mutants-meeting-box.suite.json):

```bash
node .claude/skills/mutate-in-a-copy/run-page-mutants.mjs .claude/skills/verify-ui-change/mutants-meeting-box.page.json \
  'PORT=8946 CDP=9286 .claude/skills/verify-ui-change/run-check-meeting-box.sh "$PWD"' --dest "$TMPDIR/orch-page-copy-box"
node .claude/skills/mutate-in-a-copy/run-mutants.mjs .claude/skills/verify-ui-change/mutants-meeting-box.suite.json \
  --dest "$TMPDIR/orch-suite-copy-box" --control
```

A kept list goes stale as the code moves. That fails safe: `mutate.py`
wants each old text exactly once and says DID NOT APPLY otherwise, so a
stale entry is re-pointed at the line's new wording, never counted as a
survivor. Each entry's first field says what is wrong with the mutant,
which is what to predict the red from.

**The 0.12.8 round's owed page checks were run at the hand-off** (QA,
PR #56): check-popout PASS, check-backdrop 71 of 71, check-redraw 19 of 19
and check-card-move PASS at the head. check-hide and check-archive drew the
same at the head as at the base.

**A desk in a meeting stands in its box, hidden or not** (PR #56 finding
1). The step "a desk in a meeting stays in its box" covers it. A bulk Hide
of a boxed desk is refused on the room's line, and the board is asked
nothing. Cy, hidden on the board, keeps an open card with Hide dimmed and
the reason under it, and stays in the box and its sentences. With all
three hidden the box stands with In a meeting and End, and there are no
pills. Shown again, Hide is still refused while the meeting lasts. The flag is read
off the card's words, because a hidden desk in a box draws nothing else
that a poll changes.

**A timer in an unfocused tab can fire hundreds of milliseconds late.** In
this check a 30 ms `setTimeout` in the floor tab, set from a BroadcastChannel
handler, fired after 400 ms, after the room's window was back. A row that
has to act inside a gap acts in the handler itself, not on a timer.

### check-sessions.mjs — one agent, several sessions (0.12.9)

The nameplate card's **Leave room** and its controls going dim in a meeting
room; a desk that is already in a room checked for a second one and joining
it as a second session; each room typing to its own session; **Bring back**
taking the agent out of every room; a room of second sessions ended from
the floor and resumed; a second session its host refuses; and Take a desk's
**New desk here** (refused, slow, made, then left from its card).

```bash
PORT=8949 CDP=9289 .claude/skills/verify-ui-change/run-check-sessions.sh "$PWD"
# … PASS · 81 of 81          (about two minutes; Node 22.14+ first on PATH)
```

[`run-check-sessions.sh`](run-check-sessions.sh) serves any directory with
[`seed-sessions.mjs`](seed-sessions.mjs), which is a host and not a seed: it
registers through `/api/host/register` every two seconds with `seats:
true`, names every desk it runs, and answers `seat`, `unbind`, `browse`,
`chat`, `sessions` and `reopen` as events. Nothing is written into the
database behind the board, because the board asks only a host that *says*
it can seat a second desk, and reads which desks a host runs off its
registration. Its control file takes `seatFail: ["qa-2"]` (the host's
refusal, said on the desk the session was made beside, in `sit()`'s words)
and `seatSlow: 3000`. Its mutants are kept:
[`mutants-sessions.page.json`](mutants-sessions.page.json), eleven, all red,
with the control green:

```bash
node .claude/skills/mutate-in-a-copy/run-page-mutants.mjs .claude/skills/verify-ui-change/mutants-sessions.page.json \
  'PORT=8951 CDP=9291 .claude/skills/verify-ui-change/run-check-sessions.sh "$PWD"' --dest "$TMPDIR/orch-page-sessions"
```

What writing it found, each a fault no suite had seen:

- **A desk for a session nobody had seated.** A second session that closed
  left its conversation row open, and the next one made under the same name
  was drawn live the moment the board named it. The row that caught it was
  about a session the fixture's host *refuses*: "nor is there a desk for it
  on the floor". A refusal path is worth a row of its own for what it
  leaves behind, not only for what it says.
- **A retry under another name.** A New desk here the host refused left its
  undrawn seat, and the second press took `qa-2` on a floor where nobody
  used `qa`. Found by putting the refused case *before* the working one in
  the same dialog, which is the order a person meets them in.
- **A row that could not see a wait.** "The dialog closes when the desk is
  there" is true whether or not the page waited for the host. The mutant
  that took the wait out survived, so the fixture's host got `seatSlow` and
  the row reads the dialog while the host is still working.

One step is the fixture's and is said in its own row: a second session made
for a meeting room is left alone for 30 s after it is made, so the check
ages it in the database (`desk_twins.created_at`) before taking it out of
its room, instead of sleeping half a minute three times.

**What the 0.12.9 round ran, and what it left for the release** (costmo's
rule: the suites and page checks a change reaches, the full chain once at
the SHA that ships). Run, each alone, on the tree as it stood at the end:
all twelve suites (`smoke`, `admin`, `auth`, `boardlog`, `capture`,
`floor`, `markdown`, `plugin`, `update`, `host`, `window`, `renew`,
`seats`); 55 suite mutants and 11 page mutants, every one red, controls
green; check-sessions, and the page checks whose code it touched:
check-take-floor, check-meeting-box, check-meeting, check-select and
check-redraw (their results are in the round's report). **Not run, and
owed at the release**: `npm test` as one chain; check-popout, check-chatbox,
check-pop-foot, check-popout-session, check-card-move, check-hide,
check-backdrop, check-chat-controls and check-update, none of whose code
paths were changed except through `deskFate`/`boundTo` (a popout following
a move), which `test:floor` pins. **Measured once on real windows, from a real browser, in one run**: one
agent in two meeting rooms (`two-rooms.mjs` in **measure-a-real-window**,
13 of 13, twice). **Not measured at all**: a move to a fresh tmux server
with a real seat in it (`test:renew` has it on stand-ins); New desk here
onto another floor from the real page (the browser check has it against
seed-sessions' host, and real windows have it through the floor's route,
`I AM ms-b/qa`); and Resume of a room with a real second session in it
(the browser check has it; a real window has the `--resume` half, asked
back through the route). **Also owed, after the commit that ships it**: the
marketing facts' re-anchor (**reanchor-marketing-facts**; the round moved
`host/window.js`, `host/index.js`, `src/floor.js`, `src/db.js` and both
page scripts), with three facts changed in substance: the version
(0.12.9), a new table (`desk_twins`), and twelve suites where the file
says eleven. No network call was added: a seat's binding file is written
by the host on its own disk.

### check-take-floor.mjs — Take a desk keeps the floor it was opened from (0.12.8)

Opened while standing on a floor, Take a desk leaves the floor field alone
when a folder is chosen, so a folder bound elsewhere is a move to this
floor; from all floors a bound folder still proposes its own.

```bash
PORT=8947 CDP=9287 .claude/skills/verify-ui-change/run-check-take-floor.sh "$PWD"
# … PASS · 8 of 8          (about fifteen seconds)
```

[`run-check-take-floor.sh`](run-check-take-floor.sh) serves any directory
with `seed-desk.mjs`'s desk on `lab` and `answering-host.mjs`, whose
answers file binds `/repo/deep/nest/bound-here` as `cy` on `elsewhere`.
Its red was run on a copy holding the app.js from before the change
(`copy-repo.sh`, then `git show 0f1ecb3:src/ui/app.js` into it): four of
eight red, and the all-floors row green, since that behaviour did not
change. Three things it taught in an afternoon:

- **A fixture value equal to the old code's answer passes on the old
  code.** "A floor picked by hand is kept" first picked the first floor
  that was not `lab`, which was `elsewhere`, the bound folder's own floor
  and exactly what the old rule wrote. The row was green on the old code.
  It picks a floor that is neither now ("a fallback that happens to match
  the fixture", above, from the other side).
- **Choosing a folder before the dialog knows its host asks nobody.**
  `browseTo()` returns at once while the form has no host, and the form
  has none until `/api/floor/folders` answers. The first cut chose at
  once. Its first section passed because two rows of reading came first,
  and its second died on a ten-second wait with nothing sent. Wait for
  the Choose folder button to be enabled, which is what a person waits
  for.
- **A wait that times out should say what the page held.** `choose()`
  throws with the dialog's agent, floor and text. "waitFor timed out"
  said nothing; the dialog's text showed a form still on `lab` with no
  folder, and the host's work log showed no browse had been sent.
- A folder is chosen with `browseTo()`, the function a row's click calls,
  because this host has a folder dialog and the page draws no rows. Say
  so when reporting from it.

### seed-select.mjs and check-select.mjs — bulk selection on a room (#23)

Issue #23 (2026-11-04, 0.10.16): **select desks** on a room, check desks,
and Nudge / Mark read / Hide them. [`seed-select.mjs`](seed-select.mjs) is
the fixture *and* the host. `alpha` has a desk per nudge verdict: two with
windows, two without (they open), one held by an editor, one live by hooks
with no host. It also has two backlogs. `beta` has one desk, so the
building has two storeys. As host it answers each chat **one at a time, in
queue order**, as `run()` does: windowed desks after `delayMs`, windowless
after their window comes up, and a desk named in `never` with waitReady's
error after `neverMs`. The answers file is re-read per item.
[`check-select.mjs`](check-select.mjs) drives both views with
[`probe-select.js`](probe-select.js), about 2 minutes. Since 2026-11-14
the selection closes itself once an action is sent, so after each action
the check waits for `svg.room.selecting` to be gone and reads the room's
own line (`miss` and `missTitle` in the probe), not tags on checkboxes:

```bash
PORT=8943 CDP=9283 .claude/skills/verify-ui-change/run-check-select.sh "$PWD"     # the repo, or a copy holding a mutant
# … PASS · 73 of 73
```

[`run-check-select.sh`](run-check-select.sh) starts the server, the seed
and a Chrome of its own and kills all three (it had no runner until PR
#55, and QA wrote their own to review it). By hand it is the three lines
in `seed-select.mjs`'s header. Two things about its rows, both from QA's
review of PR #55 (Info 4):

- **A wait for the behaviour under test is a row** (`waited()` in the
  check): "the room stopped selecting by itself" used to be a bare
  `await page.waitFor(…)`, so a page that never stopped selecting ended
  the check on the wait's exception with no ✗ and no verdict, and
  `run-page-mutants.mjs` reported the mutant as "THE CHECK DID NOT
  FINISH", which reads as the machine. A wait that only sets up the next
  step may stay bare; one that *is* the claim goes through `ok()`.
  `check-chat-controls.mjs` had the same at the selects being dimmed.
  Rows alone were not enough: with the Nudge's `doneActing` out, the
  check printed twelve ✗ and then died on a `press` of a line that was not
  drawn, still with no verdict (QA, at d5c391b). So the three checks that
  go through the mutant runner (select, chat-controls, meeting) also end
  on any thrown step with a ✗ row naming it and the FAIL verdict
  (`stopped`, on `uncaughtException` and `unhandledRejection`; a
  top-level `await` that rejects reaches both).
- **The verdict line is `PASS · N of N` or `FAIL · M of N red`.** It was
  `N ✗ · FAIL` and a bare `PASS`: the first holds a ✗, which
  `run-page-mutant.sh` counts as a red row, and neither starts with the
  `PASS · ` / `FAIL · ` the runners look for. `check-popout.mjs` and
  `check-pop-foot.mjs` still print the old form, and their runners match
  it; change both together if either is put through the mutant runner.
- **Something on the page for a second is caught by an observer, not a
  poll.** An envelope lives 1.4 s at most and goes with any redraw of its
  room. The step that reads where one leaves from (Info 6: under the
  room's line, not a band above the desk) first polled for
  `.envelope animateMotion` every 50 ms, and on an unmutated page read
  nothing in 8 s, then on a mutant found the envelope with its path
  already gone. It now installs a `MutationObserver` before the message
  is written and records the path, the sender's place and the line in
  the task that adds the node. Anything drawn and removed inside a poll
  interval wants the same.

What it proves beyond the suite: a click on a selecting storey in the
building checks a desk instead of riding to it. The selection survives a
rebuild and a change of view, and Space keeps focus on the checkbox. The
room stops selecting by itself after each of Nudge, Mark read and Hide
(130 ms after the Nudge click, with four desks still in line). The room's
line names the desks not reached and follows the line as it resolves; a
real click on it in the building dismisses it without riding to the
floor, and the room's height comes back; mark read and hide, which reach
every desk, leave no line. A line left by a desk the board refused goes
when selection is started by hand, and ending it by hand does not bring
it back (the last step; without `settleBulk` in `toggleSelecting` the
missed desk keeps its tag in the new selection and the line returns when
it ends, two rows red). With
the panel open on the desk last in line behind a window that never comes
up, its bubble still reads `in line — 1 desk ahead on testbox` **past the
30 s grace**. The host's work log reads windowed first, then windowless,
and nothing for the two it can't reach. A message landing after the page
drew stays unread. Outside selection, the bell, the card, its Hide desk and
the backlog dialog still work. The dialog is opened from a pill **newer than
the board half's /api/state copy** (Decided 5). The board half's poll is
switched off with the `#autorefresh` box first, so the pill is newer for
certain and not by luck: once with nothing in the copy, once with an older
backlog of one against a pill reading two. Two red-then-green lessons came
out of it:

- **`textContent` includes an SVG `<title>`.** Every tag and label on the
  room carries its tooltip as a `<title>` child, and the first probe read
  `not nudgedNo host on this board…`. A wait on `<in line>` then never
  matched, so the nudge loop ended after a second and reported a dozen
  false reds. `own()` in the probe reads the element's own text nodes.
- **A toggle that changes nothing in the signature draws nothing.** The
  rooms are rebuilt only when their signature changes. The first cut wrote
  "selecting, nothing checked" and "not selecting" alike once a result was
  kept, so "done selecting" and selecting again both did nothing. The last
  step of the check exists for that: select again and leave by hand while
  a nudge is still in line, then wait for the room's line when it fails.

Three other checks pressed "done selecting" after an action and had to
stop: check-meeting.mjs, check-popout.mjs and readme-shot.mjs. A click on
`[data-act="select-room"]` after an action now *starts* a selection. Wait
for `!document.querySelector('svg.room.selecting')` instead.

### check-chatbox.mjs — the chat box's height (issue #13, 0.10.17)

The box grows with its text and keeps a height the operator drags it to,
per channel + agent + session. [`run-check-chatbox.sh`](run-check-chatbox.sh)
serves any directory (the repo, or a copy holding a mutant or an old SHA) on
a scratch DB with two `seed-desk.mjs` desks, `bo` and `cy`, runs the check
and kills all of it. It has the same port refusals as `run-check-backdrop.sh`:

```bash
PORT=8915 CDP=9265 .claude/skills/verify-ui-change/run-check-chatbox.sh "$PWD"
# … PASS · 69 of 69        (about a minute)
```

What it drives, with real input: typing a line at a time with Shift+Enter
(55px, then 15px a line from the fourth to the fourteenth, flat at 220px,
scrolling inside past it), and shrinking as text goes. Every way text gets
into the box without an `input` event: Enter's send, a lost message put
back by an error turn, a saved prompt, a Tab-completed command, a draft
loaded on open. Then the box's own resize handle, dragged through
`press()`: a floor the text grows past, kept across a desk switch, a closed
panel, a reload and a second tab, and cleared by a drag to the start. A
real click in the text, which must not read as a drag. A shorter drag of a
box its text grew, which stores nothing, and a shorter drag of a box at its
stored height, which lowers it (QA, PR #39 findings 1 and 2). A
session change on the open desk (host `session` events), a height set on
the placeholder session carried to the real id, and the alert slot, send
row and links still on the panel at three viewports with a permission
prompt up and the handle dragged as far as it goes.

Three things it taught:

- **The native resize handle is visible to the page.** Measured on Chrome
  through `press()` (2026-11-04): `pointerdown` and `mousedown` on the
  textarea, `pointerup` and `mouseup` on the document (target `DIV`).
  So the page tells a drag from its own growing by the height changing
  between a press and its release (`dragOutcome`).
- **A Chrome left with a crashed check's tabs stopped answering.** After a
  few runs that threw mid-way, `Page.navigate` went 30 s without an answer,
  and the saved-prompt menu was closed by two `scroll` events on `#p-turns`
  that a fresh Chrome never fired. Kill the CDP Chrome (`pkill -f
  "remote-debugging-port=<port>( |$)"`) before believing either. The
  runner kills its own at the end.
- **The panel's turns reload races turns landing in the same moment as a
  session change.** Measured on HEAD's page as well as this one: a host
  `session` event and 30 turns posted together drew 30 of 38 turns on the
  base and 38 on the tree, and on one run of the check none at all. Not
  issue #13's. The check lets the old session's turns in before posting
  more. Probably the mechanism found in #46 (0.10.22), though not
  re-measured: a turns answer that lands after a session change has
  reset the panel. Since #46, `loadTurns` drops an answer requested under
  another session filter. If this race is ever seen again on 0.10.22 or
  later, the cause is something else.

- **Some readings must be taken at once, and some mid-gesture.** The
  panel renders every 2 s and refits the box, so a step that waited for a
  height passed with `stashDraft`'s fit removed. The text-setting steps
  read with no wait (`NOW`). And the page refits the box on release, so
  the drag's own limit (its `max-height`) is visible only while the handle
  is held. The panel step reads it through `press(…, { held })`.

`drive.mjs` gained three things for it:
- `type(text)`, one `Input.insertText`: an `input` event, like a keystroke
  or a paste.
- `key(name, { shift, text })`. A `rawKeyDown` types nothing, so Shift+Enter
  adds its newline only as `key('Enter', { shift: true, text: '\r' })`.
- `press(from, to, { held })`. `held` runs with the button still down,
  and its result comes back as `during`.

Page mutants (2026-11-04, `run-page-mutant.sh` with `CHECK='PORT=8916
CDP=9266 .claude/skills/verify-ui-change/run-check-chatbox.sh "$PWD"'`) went
red on the assertion each was aimed at. Among them: no floor under the
dragged height, the box's own growing recorded, `stashDraft` without its
fit, `renderPanel` without its fit, the carry, the drag listener, the
clear, the drag's `max-height`, and the room as a whole. Two survive, and
each is held by the other half. The drawn height ignoring the room is held
by the box's `max-height`, and the room read off the panel's clamped
height is never wrong while that `max-height` keeps the box on the panel.
`test/floor.mjs` holds `boxHeight`'s room rule on its own.

### check-update.mjs — Update available, Settings, and the reload (issue #40)

Self-contained: a stand-in GitHub, the server from `<dir>` (started twice —
the second time as the new commit on the same database, which is what a
rebuild is), and the host played through `/api/host/register`, `/work` and
`/events`. Refuses a port anything answers on.

```bash
node --experimental-websocket .claude/skills/verify-ui-change/check-update.mjs "$PWD" 8925 8926 9275 /tmp/shots
# … PASS · 42 of 42        (about forty seconds)
pkill -f "remote-debugging-port=9275( |$)"
```

It drives: the header button with checking on by default; Settings' facts;
unticking Check for updates taking the button away and staying unticked
across polls; Check now with checking off; develop and back; the
confirmation naming what is interrupted; a clone turning dirty replacing
Update now with the refusal; a failed run (the banner names the step, the
steps as far as they got, the update still offered); a good run with the
board killed mid-update ("the board is away"), the page — and a desk's
popout open beside it — reloading itself once when it answers as the new
commit, a plugin step failing after that (the header keeping an
**Update stopped** button, Settings not saying "You have the latest", the
dialog saying what is on which build, and **Finish the update** queueing a
finish from where the update started), and the run closing when the host
registers as the commit. Shots of each dialog land in the shots directory.

### check-chat-controls.mjs and probe-chat-panel.js — the chat panel's controls (0.10.9)

```bash
node --experimental-websocket .claude/skills/verify-ui-change/check-chat-controls.mjs http://localhost:8905 /tmp/out lab bo k h1
```

Against `seed-desk.mjs`'s desk: the slash menu and Tab, a /btw from the box
with the host's receipt and `host` line posted as the seed host (`h1`),
the model select showing the ask and the hooks confirming it, a same-second
/clear carrying model and effort, the foot as two rows of two. Two doors it
uses that other checks do not: hook state goes in through `/api/ingest`
with the seed's key (`PreModelSwitch`, `PreCompact`, `SessionEnd` +
`SessionStart {source: 'clear'}`), host events through `/api/host/events`
as the seed host — the same doors a plugin and a host use, so nothing here
is a state no host could have produced. `probe-chat-panel.js` reads the
meta line, both selects, the asked-for note, the slash rows and the last
rows (with the compaction summary's open/closed) in one call.

Since 2026-11-14 it also carries a verdict for the two selects (✓ / ✗ lines,
then `PASS · the selects`), and a runner with the whole fixture, so a page
mutant can be read off it:

```bash
PORT=8922 CDP=9262 .claude/skills/verify-ui-change/run-check-chat-controls.sh "$PWD"
#   ✓ neither select is rewritten while nothing about it changes — an open menu is left standing
#   ✓ while the window asks, both are dimmed and say why — a pick then would be dropped
#   ✓ over the whole run each is rewritten once — its placeholder row leaving …
#   ✓ a model change the host refused is no longer shown as asked for
#   ✓ and the select is back on the model the window is on, not the one that was picked
#   ✓ and the message box holds the draft it held, with no command put into it
```

The last two are a refused change: a pick of `opus`, then the host's
`error` posted as the seed host with `command: 'model'`, which is how the
board knows what was refused. A host event is a full step here because the
seed host is registered; no real host is needed to show a refusal. The
step also puts a draft in the box first and reads it back after. That
line exists because the step, when it only printed the box, showed
`/model sonnet\n\n/model opus` in it: `settle()` hands pending messages
back to the box on an error turn, and a select's pick is pending in the
same list. No suite and no earlier check had looked at the box after a
refusal. costmo ruled it out of the box the same day (`handedBack`). When
a step drives a control, print what is around it as well as the control;
this one was found by a `box:` field added in passing.

Three things from building that part:

- **"Is this element being redrawn?" is a MutationObserver's count, not a
  look.** The panel is drawn on every poll and stream event, and a control
  rebuilt with identical contents looks the same in every probe and every
  screenshot. Observe `childList` on the element, let polls go by, and read
  the count. Wait on the polls themselves, not on a sleep:
  `performance.getEntriesByType('resource').filter((e) => e.name.endsWith('/api/floor')).length`
  rising by three. Before the fix it read one rewrite of each select per
  poll and two in the first two seconds of a panel; after, 0.
- **A headless browser draws no `<select>` menu, so no check can click
  one.** What the operator reported (a pick not taking, the drop-down left
  open) happens in the menu, which Chrome on macOS takes down and puts up
  again when the select's rows change. The check proves the rows are left
  alone; that this cures the report was costmo's to see on his screen. Say
  which of the two a result is.
- **A regex in a template string loses its backslashes.** `` `/\/api\/floor$/` ``
  inside backticks is `//api/floor$/`, a comment, and the page threw
  "Unexpected token 'for'" on the next line. Use `endsWith`, or put the
  browser code in a probe file, which is what `probe()` is for.

### check-backdrop.mjs — a click outside a dialog's contents (issue #11)

Every dialog on the board, four gestures each, through `press()` and
`key()` in `drive.mjs` — real input, because a dispatched click names its
own target and the target is the whole question here. A click goes to the
nearest common ancestor of where the button went down and where it came
up, so a drag out of a field onto the backdrop is a click on the `<dialog>`;
so is a click in the dialog's own padding, inside its visible box.

```bash
PORT=8912 CDP=9254 .claude/skills/verify-ui-change/run-check-backdrop.sh "$PWD" after
# rename  backdrop  open  kept   0 close  ✓ … close, then wait … PASS · 71 of 71
```

[`run-check-backdrop.sh`](run-check-backdrop.sh) starts the server from the
directory it is given, seeds `seed-desk.mjs` (with `--unread 2`, so the
backlog dialog has mail to open on) and `answering-host.mjs` on the same
scratch DB (with `--db`: seed-desk's default is `./data/scratch.db`, so a
server on any other DB serves a board with no desk), runs the check, and
kills all of it. Because it serves whatever directory it is given, the same
command reads the old page at a base SHA or a page mutant in a copy; the
header has the recipe. It reports a check that died before its verdict
line as not finished. A crash exits 1, like a FAIL.

**It refuses a `PORT` or a `CDP` that anything answers on** (QA, PR #38
finding 1). `browser()` in `drive.mjs` reuses whatever Chrome is already on
its port and never closes one, so the runner's closing `pkill` is the only
cleanup. Given another session's CDP port, the check ran inside that
session's Chrome and then killed it, and the pattern also matched a longer
port with the same prefix (`=9254` in `=92540`). Now a taken port is refused
before anything starts, the `pkill` matches the port exactly, and the
runner waits for its Chrome to let go of the port: Chrome takes a moment
to exit on SIGTERM, and a run straight after (`run-page-mutant.sh` runs it
back to back) would otherwise be refused as taken. Any new runner around
`drive.mjs` needs the same three things.

`--expect after` is #11's ruling: a dialog carrying a text field stays
open with its text on backdrop, drag-out and padding and closes on Escape;
one without closes on all four. `--expect before` is what the issue
reported, and it read every dialog closing on every gesture (2026-11-03,
0.10.12). Each row counts the `close` events its gesture fired, and `open`
passes only with none: a dialog waiting on its host used to be drawn back
open by the host's answer inside the row's 120 ms, so "closed and drawn
back" read as "never closed" (PR #36, QA finding 2, mutant P4).

Then **close, then wait** (PR #36, QA finding 1): History, Sessions and
Take a desk (opened on a folder, so its host is asked a `browse`), each
closed 150 ms after opening with Escape and with its own Close button,
watched for ten seconds, against the task list as a control. Before the
fix all three came back; History within a second. A close-then-wait row
only catches a redraw that happens to land between `close()` and the late
`close` event about one run in three, so three more rows put it there
every time: each dialog closed and redrawn in the same task. One closes
Sessions and opens Retire while Sessions' loop is still running, which must
not draw over it. Last, one row closes History and opens it again in the
same task, which the late `close` must leave drawn. Under a red row the
check prints the page's own log of every `showModal`, `close()` and
`close` event with its time, which is how the gap was found.

**The backlog dialog is in both tables** (QA, PR #38 Info 5: where #23
meets #11). It is what a floor unread pill opens (Decided 5), so it has four
gesture rows (no text field: it closes on all four) and a close-then-wait
row. Its gesture rows bite: a page mutant giving it a text field turned
exactly its backdrop, drag and padding rows red. The close-then-wait row is
a control, like the task list. A mutant removing both `refreshDialog`'s
open guard and `forgetDialog` left it green, and that taught the thing worth
knowing: **the board's poll never redraws an open dialog.** `tick()` draws
the board, and `refreshDialog` runs only after an action inside a dialog
(reassign, advance). A note in `app.js` and in CLAUDE.md had said a late
poll would close the backlog dialog through it. That was reasoned rather
than read, and it was wrong.

Six things it taught, each a red that was the check:

- **A `close` event is a queued task**, and the page's handler for it
  empties `#dlg-body`. Closing one dialog and opening the next in the same
  breath drew the second and then wiped it: an open dialog with nothing in
  it, on some runs and not others. Let the event loop turn between them.
  The handler now leaves a dialog that is open again alone, and the
  same-breath row holds it to that; the check still turns the loop, so a
  row measures its gesture and not the one before.
- **A gesture is not done when `press()` returns, and its `close` event
  is later still.** A drag is ten input events. Its `close()` landed
  about 320 ms after the gesture started, and the event came about
  100 ms after that. A fixed 120 ms read saw the dialog shut with no close
  counted, and failed a working dialog, 1–2 rows in 2 control runs. A row
  now waits for the close to be counted, and gives a row that should stay
  open 600 ms. And Take a desk redraws taller when its host list arrives,
  so its Cancel is pressed only once the button has held still.
- **Sessions redrew whole when its host answered**, and the redraw took
  focus out of the filter; the value survived in the form's state. So the
  marker was typed and focused until the same field element had held it
  across two polls. Since issue #37 the answer is patched in, so the
  marker is typed once and must hold across two polls with nothing typed
  back; a field that does not is the finding, said as one.
- **A non-empty `type="search"` field spends the first Escape clearing
  itself.** That is the browser's (History's query has no handler for it),
  so the row says `escape×2` rather than calling Escape broken.
- **A click held across a redraw is no click** (QA, PR #36 N1). `press()`
  used to send a click's six moves too, which made press to release take
  300–600 ms under load. Take a desk, opened on a folder, redraws
  `#dlg-body` when its listing arrives, 525–590 ms after opening. When
  that fell inside the press, the button went down on one Cancel and up on
  another element, so no click fired and the Close-button row read "the
  close never landed" on a correct build, in 3 of QA's 11 runs. A press
  at one point is now a plain click with no moves, 1–2 ms from press to
  release. A drag keeps its moves. Measured with the dialog's own render
  pinned 50 ms after the press: no moves lost 0 of 10, the six moves lost
  10 of 10.
- **A row that stops watching early hands the next row a throttle** (QA,
  PR #36 N2). History and Sessions ask their host at most once per 5 s.
  When a row stopped at the comeback, History's Close-button row opened
  inside its Escape row's window at the base, asked nobody, and could not
  come back. Every close-then-wait row now watches the full ten seconds.

### check-redraw.mjs — a host's answer under the operator's hands (issue #37)

History, Sessions and Take a desk draw again when their host answers.
Drawn whole, that took the focus out of the box being typed in (the keys
after it went to `body`), Take a desk's name with it, and a button held
down across it fired no click. [`check-redraw.mjs`](check-redraw.mjs)
lands each dialog's answer while real keys are going in or a real press is
held, and reads what survived:

```bash
PORT=8913 CDP=9255 .claude/skills/verify-ui-change/run-check-redraw.sh "$PWD" after    # PASS · 19 of 19
PORT=8913 CDP=9255 .claude/skills/verify-ui-change/run-check-redraw.sh "$CP" before    # HEAD's app.js in a copy
```

[`run-check-redraw.sh`](run-check-redraw.sh) is `run-check-backdrop.sh`'s
shape with two differences: the server runs with
`ORCH_SESSIONS_MIN_MS=0 ORCH_HISTORY_MIN_MS=0`, so every open asks its host
and no row waits out the one before it, and `answering-host.mjs` reads an
answers file the check rewrites before each row to time the answer
(`browse.delay`, `recent.delay`, `sessions.answer` + `delay`, and
`browse.bound` for a folder bound on this board). About a minute.

Every row proves its own fixture: the three render functions are wrapped
(they are the global's properties, so the page's own calls go through the
wrappers), the time the answer drew is recorded, and a row whose answer
did not land inside the typing or the press is red as *the fixture*. At
e88a951 (`--expect before`) it read the issue's numbers again: Take a desk
took 12 of 36 keys and held 0 letters, Sessions 16 of 36, focus on `BODY`
for both; every held row lost; Sessions' and Take a desk's Cancel 0 of 5
under their own redraw, History's 5 of 5 (its rows were already redrawn
apart from its box and buttons). Two mutants of the patch in a copy: rows
keyed by place without `data-id` turned "moved on" red (the held press
fired on the conversation drawn into its spot, `session-resume
bo-other`), leaving a field's value alone turned the three name rows
red, and moving a keyed match up past what stood above it (the first cut)
turned "its host list arriving above the box" red with focus on `BODY`.

**#40's two surfaces, five rows more** (task 274; costmo added them to #37).
The update dialog's ✕ and Settings' Check now are held while `renderUpdate`
draws a real change 50 ms in: a newer commit on the branch for the dialog,
Check now's own note for Settings. A redraw of the same HTML is not a
test, because `drawIfChanged` rightly draws nothing. Then Update now is
held while another commit takes its place, and both buttons are watched
through 6 s of a still board. At bf49ba1 (its `before`, since the three
dialogs are fixed there) both read 0 of 5, and Settings' Check now was a
new element on every poll: `sec.outerHTML !== html` never matched,
because the template starts with whitespace. That is QA's unexplained
"4 of 5 with no redraw". Five mutants: replacing the dialog sends ✕ to 0
of 5; replacing the section sends Check now to 0 of 5 and makes the
quiet poll read `replaced 3×`. Dropping `data-commit` from the key makes
the held Update now **start the update to the newer build** (`upd start
2345678`). Two mutants survive, both equivalent: patching Settings on
every poll writes nothing when nothing changed, and `data-upd` in the key
is not pinned, because no update control ever stands where another one
stood.

**Known flake in the update dialog's row, not fixed** (QA's Low in msg
2942 at 2ba600a, waiting on costmo's call). The row writes a fake newer
commit into `ui.state.update`, and the page's own 2.5 s poll (`timer`
in app.js) can land mid-press. The poll redraws from the real state,
which wipes the fake commit, and the ✕ jumps 77 px after `follow` has
measured it. Two of QA's equivalent mutants read 4 of 5 by chance (3 of 4
runs and 1 of 4). QA's measured fix is `clearInterval(timer)` around the
#40 rows, after which the head and both mutants passed 3 of 3. So a 4 of 5
on that row whose per-press list shows a ✗ after the first press is this
race, not the patch; rerun it before reading it as red. The rule
generalizes: **a row that writes state into the page races the page's
own poll**, so stop the poll for the row or redraw from state the poll
also brings.

Four things it taught:

- **A move is a removal, for focus.** The first cut moved a keyed element
  up past siblings that had gone, and a moved element loses focus like a
  replaced one. Take a desk opened on no folder lost its Agent box's focus
  that way when the host list swapped the folder block above it, value and
  element intact. This check passed; check-backdrop's simplified `fresh()`
  went red on it (`same: true`, `active: BODY`). The patch now removes what
  it passes, and the row replays that arrival, because the board answers
  the host list faster than a person reaches the box.

- **A click needs the same element, and it needs it to stay put.** Take a
  desk's `<dialog>` is centred, and its first listing makes it 48 px
  taller, so everything in it moves 24 px up. A release at the old spot is
  on the next row, and no click fires whether or not the row survived.
  `press()` has `follow` for this: it measures a selector `to` again after
  `held`, so the row asks whether the element survived, and prints how far
  it moved. That move is a loss the patch cannot prevent, and costmo
  ruled it left as it is (2026-11-04); the printed move is a record, not
  a red. The update dialog does the same, at 77 px: an offer of Update now
  arriving while it is open grows the centred dialog, and without `follow`
  the row read 4 of 5, the miss being the first press every time. Its rows
  follow and print the move per press (`✓-77 ✓0 …`).
- **Swallow clicks only in the rows that press to observe.** The first cut
  swallowed every click in the dialog in the capture phase, so the rows
  that press a folder to move to it moved nowhere and went red for the
  fixture.
- **A form value set from code must still be drawn into a typed box.**
  `.value` stops following the `value` attribute once a person has typed,
  so the patch writes the property wherever it differs from the form. A
  bound folder's agent arriving under typed text is the case.

### check-poll-timeout.mjs and hold-proxy.mjs — a hung poll must not freeze the page

Task 264 (2026-11-03). [`hold-proxy.mjs`](hold-proxy.mjs) stands in for a
forwarder that keeps the browser's connection open when the board behind it
dies. [`check-poll-timeout.mjs`](check-poll-timeout.mjs) serves any copy of
the repo on 8951 behind it on 8953, kills the board with the page's requests
held, starts a fresh one, and samples both views once a second:

```bash
node --experimental-websocket .claude/skills/verify-ui-change/check-poll-timeout.mjs "$PWD" /tmp/out   # the tree
# red at a commit: a copy holding that commit's src/ui (copy-repo.sh, then git show <sha>:src/ui/… into it)
```

Measured before the fix, and kept here because it looked like nothing was
wrong: **the dot stayed green and "connected" with no poll at all** for as
long as the page stayed open. `inFlight` was set by a fetch nothing would
ever end, though a fresh board had been answering for the last 30 s. The
floor's own poll, with no guard, sent its next `/api/floor` 22 s after one
was held. After the fix the dot reads `cannot reach the server: no answer
in 8 s`, the header's server time moves again once the board is back, and
the floor's worst gap is the 8 s limit.

### answering-host.mjs — a host that answers the page's questions

`seed-desk.mjs` and `seed-folders.mjs` put state on the board; neither takes
work. Anything on the page that *asks a host and waits* — the folder dialog
and the in-page list in Take a desk, the History dialog's recent list and
search, a conversation opened to read — sits for eight seconds against them
and says the host did not answer. [`answering-host.mjs`](answering-host.mjs)
long-polls the work queue for its host and answers each item the way
`host/index.js` does, as events:

```bash
node .claude/skills/verify-ui-change/seed-desk.mjs http://localhost:8905 &
node .claude/skills/verify-ui-change/answering-host.mjs http://localhost:8905 --answers /tmp/answers.json > /tmp/work.jsonl &
# a second host with no folder dialog, to see the page's own list:
node .claude/skills/verify-ui-change/answering-host.mjs http://localhost:8905 --host h2 --no-dialog &
```

- **Its stdout is what the page sent**: one JSON line per work item, payload
  included. That is how to check the remembered start directory reached the
  host (`"kind":"pick","payload":{"start":"/repo/deep/nest"}`) or that the
  switch did (`"deep":true`) — the effect, not the appearance.
- **`--answers` is re-read on every item**, so a check changes what "the
  person" does between steps by rewriting one file: `{"pick":{"mode":"chosen",
  "path":"…","delay":1500}}`, then `cancelled` (with `why`), `failed` (with
  `error`), `silent` (says nothing — the page's 8-second path).
  `browse`, `recent` and `search` take a `delay`; `browse.bound` maps a path
  to a binding on this board. **Sessions is not answered** unless
  `sessions.answer` is true: check-backdrop's rows need a Sessions that
  waits out its 8 s.
- A conversation whose id ends `-old` reads as thirty turns in two pages,
  with a tool call, a thought, a subagent label, and one turn containing
  `<b>all</b>` — which must arrive on the page as those characters.
- An offline host for the "not covered" line is a row, not a process:
  `INSERT OR REPLACE INTO hosts (host_id, name, last_seen) VALUES ('h2',
  'oldbox', datetime('now', '-2 days'))`.

Three things about waiting on a page that waits on a host, each a red that
was the check and not the page:

- **Do not wait on a state shorter than the page's poll.** The page reads the
  host's answer every 500 ms; with a 300 ms delay between `open` and
  `cancelled` it never draws "the dialog is open" at all, and a `waitFor` on
  that text times out against a page that is right. Wait on the outcome, or
  make the delay longer than the poll.
- **`waitFor` gives up at 8 s by default, and so does the page.** Checking
  the page's own "did not answer in 8 s" path needs `waitFor(expr, { timeout:
  14000 })` — an options object; a bare number is ignored.
- **A redraw must not take what was typed.** Answers arrive on the host's
  clock, and a dialog that rebuilds itself on each one empties the box under
  the person's fingers. After the answer lands, read the field's value and
  `document.activeElement` — the History dialog redraws only its list for
  this reason, and the check for it is one line.

### check-popout.mjs — a desk's chat in a window of its own (issue #19)

One command, with its whole fixture. [`run-check-popout.sh`](run-check-popout.sh)
serves any directory (the repo, or a copy holding a mutant), seeds seven
desks and the form desk on a scratch DB, launches its own Chrome with the
throttling flag, runs the check and kills all of it:

```bash
PORT=8931 CDP=9271 .claude/skills/verify-ui-change/run-check-popout.sh "$PWD"
# … PASS, 60 ✓, about five minutes
```

It refuses a PORT or CDP that anything answers on. For a page mutant,
hand it to `run-page-mutant.sh` as the check, from the copy (the header
has the line). By hand, the fixture is:

```bash
PORT=8931 DB_PATH=/tmp/pop.db ORCH_AUTH_TOKEN=k node src/server.js &
for a in bo cy d1 d2 d3 d4 d5; do
  node .claude/skills/verify-ui-change/seed-desk.mjs http://localhost:8931 --db /tmp/pop.db --agent $a > /dev/null &
done
node .claude/skills/verify-ui-change/seed-form.mjs http://localhost:8931 --host h-form > /dev/null &
pkill -f "remote-debugging-port=9271( |$)"     # the flags below reach only a Chrome the check launches
ORCH_CDP_PORT=9271 ORCH_CHROME_ARGS=--enable-features=IntensiveWakeUpThrottling:grace_period_seconds/10 \
  node --experimental-websocket .claude/skills/verify-ui-change/check-popout.mjs http://localhost:8931 /tmp/shots
```

It covers detach with the floor's draft, the floor's panel while a desk is
out, the stream reaching the popout, the bell, card, dialogs and Send in the
popout, a floor nudge's bubble and a History row landing in the popout,
every way back (each with its draft), a floor reload and then a closed
floor, hide, move (followed, draft and address with it) and leave, and the
floor plus six popouts all live at once. Four things it taught:

- **A popup is a target of its own, and only real input opens one.**
  `attach(match)` in `drive.mjs` finds a window the page opened, by URL,
  and `targets()` lists the pages open now, which is how "closed" and "no
  second window" are read. `window.open` from a dispatched click returns
  null, because the browser wants a user gesture, so detach is pressed with
  `press()`.
- **One window per desk is two facts.** The window's name makes a second
  `window.open` reuse the first window, so a count of windows cannot fail.
  Without the "already out" guard the second detach reloads the popout
  instead of bringing it forward, and a mutant doing exactly that survived
  the count. The check now puts a mark on the popout's page and reads it
  back.
- **The seven-window step is the issue's own measurement.** With the
  hub mutated out, each window opening its own stream, the step dies
  waiting for a popout's composer. That is the six-connection cap holding
  the page itself. A green run there means one connection for all seven.
- **A step that depends on the page's payload waits for the page.** The
  bulk-nudge step makes bo windowless so it queues last. The first cut
  waited on its own fetch of `/api/floor`, pressed Nudge, and the plan,
  made from the page's copy a poll behind, put bo first. It now waits for
  the room to draw "no window" on bo.
- **A hidden window's timers are the browser's.** QA's PR #41 finding:
  presence on a 2 s beat failed once a minimized popout was throttled to a
  wake-up a minute. The step minimizes the popout with `windowState()`
  (CDP `Browser.setWindowBounds`) under `ORCH_CHROME_ARGS`' 10 s grace and
  samples the floor for 150 s. It also measures the popout's own timer gaps
  and fails if none reached 20 s, because a first cut sampling 100 s saw 14 s
  at most and proved nothing. Throttling began about 65 s in.
- **The console is read, not assumed.** `page.console()` in `drive.mjs`
  returns every console warning and error and every uncaught exception
  since the page connected. The check's last step asserts there were none
  in the floor or the popouts.
- **Headless ignores a popup's size.** The window comes up at 800×533
  whatever the features asked, so the check sets 440×980 with `resize()`
  before it takes a picture.

### check-popout-session.mjs — a new session, then detach (issue #46)

```bash
PORT=8935 CDP=9275 .claude/skills/verify-ui-change/run-check-popout-session.sh "$PWD"
# … PASS · 12 of 12        (about two minutes; RUNS=<n> to change the count)
```

[`run-check-popout-session.sh`](run-check-popout-session.sh) serves any
directory, the repo or a copy, with its own scratch DB, desk and Chrome. It
refuses taken ports like the other runners and kills everything after.
The red is proved on the copy: `copy-repo.sh` from **mutate-in-a-copy**,
then `git show c20a893:src/ui/floor.js` into the copy's `src/ui/`
(2026-11-05: `FAIL · 1 of 8`, on run 7).

**Loading the popout's URL directly is not the bug's path.** The first
repro used `goto(base + '?popout=1&…')` on a desk already on its new
session, and it passed 4 of 4 on the broken page. The check now does what
the operator does: the floor's panel is open on the old session, the
session changes under it, and detach is pressed with `press()`. That
version read red on the same page. A repro that passes before the fix has
not reproduced anything yet.

The floor's panel is open on bo, a host `session` event moves the desk
onto a new id with no turns, and detach is pressed. Each run reads the
popout as it first draws and again 5 s later. Before the fix, 2 of 3 runs
showed the old session's eight turns, and they were still there 5 s later.
After it, 8 of 8 runs drew none. A popout opens its desk before its first
`/api/floor`, so its first turns fetch had no session to scope to. When
that fetch answered after the first poll had reset the panel, its rows
stayed, because the filter did not change again. The red is a race, so
**run several times**. One clean run proves nothing, and the first run
was clean on the base too.

### check-pop-foot.mjs — a wide popout's foot under the desk (issue #43)

```bash
PORT=8933 CDP=9273 .claude/skills/verify-ui-change/run-check-pop-foot.sh "$PWD"
# … PASS, 39 ✓, about half a minute
```

Two seeded desks: bo is popped out, and cy is the floor's own panel. The
check covers narrow (the foot is the composer's last part), wide (the foot
in the desk's column, controls under the desk and links under them, every
control inside the column, two rows of two, the desk still the floor's
size, nothing under the Send row but padding), a desk redraw (one desk and
one foot, still in the column), Sessions and Leave desk opening their
dialogs from the column, wide and short at 1100×640 and 1100×520 (the desk
gives way and the foot still fits), narrow again, and the floor's panel.
Pictures: `pop-foot-wide.png`, `pop-foot-short.png`, `pop-foot-narrow.png`.
Its reds were run, one per behavior. HEAD before #43 fails "the foot is in
the desk's column". A mutant with `drawPopDesk` back on
`slot.replaceChildren(svg)` fails "one desk, one foot", because the first
redraw deletes the foot. When the foot is missing, the check stops at that
assertion and does not crash on it.

Its last section is the narrow, short popout's box (the #43 follow-up),
at 500×760 and 440×640:
- six lines grow it;
- 26 lines take the transcript to 60px and then the desk, no further than
  half, with the send row on the panel;
- emptied, the box and the desk go back to where they were;
- a drag takes the box to its room;
- the dragged height survives a reload;
- nothing redraws over 2 s of quiet.

Its reds: HEAD before the follow-up fails six (55 → 55px everywhere, as
reported). A mutant whose fitBox re-lays the desk on the box's height
alone fails only the reload, desk 158px against 151, send row 6px off.
Moving the probes from scratch into the check is what found that one.

QA's M8 (#43 review) survived at first: the wide desk sized without the
foot's height. At 1100×900 there is room either way, so nothing shows.
At 1100×520 flex shrinks the drawing's height but not its width, and the
column stands 45px wider. Two pins were added for it. At 1100×900 the
column must be the desk's width plus the slot's padding. In the short
loop the desk must keep its viewBox's proportions, with the column
within 4px of desk plus padding; at 520 tall the foot is 3px wider than
the desk. M8 now fails the short loop, with the desk drawn 230×230.

check-popout's "send row in the window" step now measures `.p-compose`,
not `.p-foot`. When wide, the foot is in the left column and no longer
stands for the send row.

## Driving the page

**Use `drive.mjs`, in this directory.** Headless Chrome over CDP, no
dependencies — it launches the browser if one is not already up, and a whole
check is about ten lines:

```js
// check.mjs — run with: node --experimental-websocket check.mjs
import { open } from '<repo>/.claude/skills/verify-ui-change/drive.mjs';

const page = await open({ base: 'http://localhost:8905', view: 'floor', floor: '' });
console.log(await page.probe('probe.js'));            // a file of browser code
await page.click('#floor-away .min-pill[data-channel="beta"]');   // a put-away floor's pill restores it
await page.waitFor(`document.querySelectorAll('#floor-rooms .room').length === 2`);
console.log(await page.probe('probe.js'));
await page.shot('out.png', '#floor-pick');            // a PNG of one element
await page.close();
```

It exists because the same thirty lines were written from scratch six times in
one session. Four things are built into it, and they are the four that have
cost rounds here — worth knowing even if you hand-roll something else:

- **`exceptionDetails` is surfaced, as a throw.** A handler that threw otherwise
  reads exactly like a handler that ran and did nothing, and "the click did
  nothing" is a much more interesting-looking bug than the real one.
- **The localStorage dance.** Which view loads is `localStorage` — but it cannot
  be set from `about:blank`, which has no origin and answers `SecurityError:
  Access is denied for this document`. `open()` navigates to get an origin,
  writes, and navigates again. The inverse — a first visit, where a key must be
  *absent* — is not a parameter: `open({ view: null })`, then
  `evalJs("localStorage.clear()")` and `goto(base)` again. The headless Chrome
  is reused across checks, so without the clear a "fresh" run inherits whatever
  the last check stored.
- **`waitFor(expr)` rather than sleeps.** A fixed sleep is either slower than it
  needs to be or shorter — and the short one is indistinguishable from a broken
  feature. Wait on the thing you expect to become true.
- **`click()` dispatches a bubbling `MouseEvent`.** Floor pills are delegated and
  read the event target; a bare `.click()` on some of them does nothing.

Beyond those four, a check has these (issues #13 and #19, and the 0.12.8
round for the last two):

- **`page.windowBounds()`** is the page's window as the browser has it
  (`left`, `top`, `width`, `height`, `windowState`), and
  `windowBounds({ … })` places it first. Use it when a page moves or
  raises another window: what the page's own `screenX` says is the page's
  word.
- **`page.scheme('light' | 'dark' | null)`** sets the colour scheme the
  page is told. A headless Chrome takes the machine's, so one of the two
  palettes is otherwise never looked at.
- **`page.hover(to, { held })`** moves the pointer onto a selector or a
  point with no button down: real input, so `:hover` is a person's. Use it
  for a control whose press does something else to read. "In a meeting"
  raises a window, so PR #56 Info 4's row hovers it to read the storey's
  carpet. `press()` is for a click.

Three patterns from PR #56, each in check-meeting-box.mjs, for a row that
has to see something happen at a particular moment:

- **Hold the floor's poll to prove what redrew** (`holdPolls`). Wrap
  `window.fetch` so `/api/floor` waits until let go, then is made for
  real: a pass-through, not a stub, so nothing this check awaits deadlocks
  (see "A driver that produces nothing at all" below). Let a poll already on its way land
  first. Then whatever changed on the page was drawn by something else.
  Bound the wait below the next timer that redraws on its own. End's
  "Ending…" timer at 6 s took the box away in an 8 s wait and let a
  mutant through.
- **Act inside a gap from the message that opens it**, not on a timer. A
  check's own `BroadcastChannel('orch.popouts')` in the floor tab hears
  what the floor hears, after the floor's handler, because the floor's
  channel was made first. A `setTimeout(…, 30)` there fired 400 ms late,
  after the gap had closed. Act on *every* message of the gap, not the
  first: one desk still out kept the box standing.
- **Find what closed a window by tracing into localStorage.** A floor tab
  and its popups share an origin, so a popup can log into `localStorage`
  (its `window.close` wrapped with a stack, its `pagehide`, the messages
  it hears) and the floor reads the log after the popup is gone. In the
  floor, wrap `BroadcastChannel.prototype.postMessage` and `setTimeout`
  with the time each was armed. That is how a 1.5 s close timer armed by
  one room's End was found closing the next room. **`evalJs` on a closed
  popup does not fail, it waits 30 s.** Read anything you need from a
  window (its `location.href`) before the step that may close it, and
  never loop `evalJs` over a window that may be gone: sixteen such calls
  held a run for eight minutes.

- **`attach(match)` and `targets()`**, exported beside `open()`. A popup a
  page opens is a CDP target of its own: `attach` waits for one whose URL
  matches and drives it like any page, and `targets()` lists the pages open
  now, which is how "it closed" and "no second window" are read. Only real
  input opens a popup (`press()`); `window.open` from a dispatched click is
  blocked and returns null.
- **`page.console()`** returns every console warning and error and every
  uncaught exception since the page connected (`{ clear: true }` empties
  it). A requirement like "no console warnings or errors" can only be
  answered from here, not from the DOM.
- **`page.windowState('minimized' | 'normal')`** minimizes the page's own
  window, which makes it `hidden`, and its timers subject to throttling.
- **`ORCH_CHROME_ARGS`** adds flags to a Chrome that `browser()` launches.
  A Chrome already on the port keeps the flags it was started with, so kill
  it first.
- **`press(from, to, { held })`, `key(name, { shift, text })` and
  `type(text)`** are real input: a drag with a reading taken mid-gesture,
  Shift+Enter that really types its newline, and text that arrives with
  one `input` event (see check-chatbox below).

Put injected browser code in its own file and pass its path to `probe()`. Nested
backticks inside a heredoc inside a shell command will break it in ways that look
like a page bug. Return state as a `JSON.stringify` blob so one call answers the
whole question.

### Where to click

| Target | Selector |
|---|---|
| board unread pill | `[data-act="unread"][data-agent="…"]` |
| board task pills | `[data-act="tasks"][data-kind="assigned"\|"claimed"]` |
| floor pills | `.desk[data-agent="…"] .pill[data-act="unread"]`, `.pill[data-act="tasks"][data-kind="assigned"\|"claimed"]` — the unread pill has no `data-kind` (a wait on one timed out, #23) |
| floor — open the chat panel | `.desk[data-agent="…"] .deskHit` |
| floor — whose panel is open | `#floor-panel` `dataset.channel`/`dataset.agent` — wait on this, not on visibility |
| floor — the panel's link strip | `#floor-panel [data-act="openhere"\|"handback"\|"attach"\|"claude"]` |
| floor — details popover | `.faceHit` (the sign), `.plateHit` (the nameplate) |
| in-dialog actions | `#dlg [data-do="…"]`, Nudge is `#dlg .nudge` |
| dialog error | `#dlg .dlg-err:not([hidden])` |
| a message on its way | `#p-turns .t-pending` (`.t-body`, `.t-when`) |
| Take a desk | `#take-desk`; then `#dlg .desk-pick [data-do="desk-pick"]` (host has a dialog) or `#dlg .dir-row[data-go]` / `.crumb[data-go]` (the page's list); recent rows `#dlg .dlg-recent .recent-row[data-go="…"]`; the name `#dlg #desk-name`; `#dlg [data-do="desk-take"]` |
| History | `#history`; `#dlg #hist-query` (type, then dispatch a `keydown` with `key: 'Enter'`), `#dlg #hist-deep`, rows `#dlg .hist-row`, the coverage line `#dlg .hist-cover` |
| a conversation open to read | `#floor-panel` `dataset.reading` (the session id — wait on this), `.p-reading-state`, `[data-act="read-back"]`; `#p-text` must be absent |
| a desk's Sessions rows | `#floor-panel [data-act="sessions"]`, then `#dlg .sess-row` (`.sess-title`, `.sess-meta`, `.sess-detail`) |
| a meeting's box on the floor | `svg.room .meetBox[data-meeting="<room id>"]`: `.meetFrame` (the edge), `.meetLabel` ("In a meeting", `data-act="meet-raise"`), `.meetEnd` (`data-act="meet-end"`, `aria-disabled`). Read a placard's words from `.meetTabText`'s own text nodes: its `<title>` is a sibling in the same group |
| Take a desk's floor and button | `#dlg #desk-channel` (its `value`), `#dlg [data-do="desk-take"]` (its words: Take desk / Move to <floor> / Bring onto the floor); wait for `#dlg [data-do="desk-pick"]` enabled before choosing a folder |

Floor pills need `dispatchEvent(new MouseEvent('click',{bubbles:true}))` — the
handler is delegated and reads the event target.

`app.js` is a classic script, so its top-level functions are already on `window`;
`floor.js` is an IIFE and exposes only what it explicitly assigns. That is the
whole cross-script contract, and it runs in both directions —
`floor.js` calls `window.taskDialog` / `window.backlogDialog`, `app.js` calls
`window.floorNudged`. Adding a new crossing means assigning it in the IIFE and
calling it with `?.` so the other surface loading alone is not a crash.

## Prove the effect, not just the appearance

A dialog closing is not evidence a message was sent. For anything that queues
work, read `host_outbox` afterwards and confirm the row — kind, payload, and
that a *refused* attempt left nothing behind.

## When it hangs instead of failing

**A driver that produces nothing at all is almost always your own injected
code, not the browser.** `evalJs` sends `awaitPromise: true`, so
`Runtime.evaluate` does not answer until the expression's promise settles —
injected code whose promise never settles hangs the run for ever, with no
error, no output and no `exceptionDetails`.

The measured case (2026-09-04): a shot script stubbed `window.fetch` to freeze
the page's polling while it measured element rects, and the overlay injected
straight afterwards opened with `await fetch('./styles.css')`. Self-inflicted
deadlock. **If you stub `fetch` or XHR to freeze a page, nothing injected after
it may use them** — read the CSSOM instead, or capture the real `fetch` first.

`cmd()` now carries a 30s deadline (`ORCH_CDP_TIMEOUT_MS`) and throws saying so,
so this costs seconds rather than the hour it cost once. Worth knowing anyway,
because the shape invites expensive theories: that hour went on stale Chrome
processes, a CDP origin flag, and Node's WebSocket — all wrong, all disproved
afterwards by testing the socket on its own. **Suspect the page-side promise
first.**

## Two fixture traps specific to this board

Both cost a re-seed before they were understood, and both look like the feature
is broken rather than the fixture:

- **Deleting a `personas` row does not remove a desk.** `buildFloor` calls
  `ensurePersona()` for every `agents` row it reads, so the seat is recreated on
  the very next poll. To take a desk off the floor set `agents.retired_at` —
  that is the product's own mechanism and the only one that holds.
- **`working` is the host's state, not a reading of the turns.** `isWorking()`
  is `hosted_desks.state === 'working' || lastTurn.role === 'tool'`, and a
  `UserPromptSubmit` ingest sets that state — so a desk stays `working` until a
  `Stop` arrives, whatever its turns say. Seed the `Stop` when you want a desk
  merely `here`, or every hosted desk in your fixture animates its thought trail.

## Shooting a documentation image

The labelled floor picture in [`docs/floor-nomenclature.png`](../../../docs/floor-nomenclature.png)
— the one the team playbook uses — is regenerated by three files here, not by
hand:

```bash
PORT=8907 DB_PATH=./data/nomen.db ORCH_AUTH_TOKEN=k node src/server.js &
node .claude/skills/verify-ui-change/nomenclature-seed.mjs &   # keeps a heartbeat; leave it up
node --experimental-websocket .claude/skills/verify-ui-change/nomenclature-shot.mjs
```

`nomenclature-seed.mjs` builds a four-desk room showing all four desk states at
once; `nomenclature-overlay.js` measures every labelled part off its own real
element and draws the numbers and legend; `nomenclature-shot.mjs` sets the
viewport, injects the overlay and captures at 2×.

Three things in there are deliberate and worth keeping if you edit it. The
overlay **throws on a part it cannot find**, because a label silently missing
from a reference image teaches a reader a name for nothing. The shot **refuses
to write a cropped image** if the legend does not fit the viewport — the failure
it guards against is real, and it is silent otherwise. And it **states its own
viewport** with `page.resize()` rather than inheriting whatever the browser was
launched with, because `browser()` reuses any Chrome already on the port and a
picture composed against someone else's window size is wrong in a way nothing
reports.

**These live here rather than in a scratchpad on purpose.** The previous version
of this pipeline lived in a session scratchpad, was lost, and had to be rebuilt
from nothing when the image next needed regenerating.

## Shooting the landing-page captures

The five captures the appideas.com page uses (`docs/review/landing/`) come
from two files here, the same shape as the nomenclature shot:

```bash
PORT=8906 DB_PATH=./data/landing.db ORCH_AUTH_TOKEN=k node src/server.js &
node .claude/skills/verify-ui-change/landing-seed.mjs &      # the README fixture; keeps a heartbeat
node --experimental-websocket .claude/skills/verify-ui-change/landing-shot.mjs
```

`landing-seed.mjs` is the README's fictional company rebuilt through the
real doors — the original seed lived in a scratchpad and was lost, which is
why this one is here. Three things in `landing-shot.mjs` are worth keeping:

- **The moment is frozen by replaying polls, not by stubbing them dead.**
  `fetch` is wrapped so the first answer to `/api/state`, `/api/floor` and
  `/api/activity` is cached and every later poll gets the cache. Auto-refresh
  stays on and the clock stops, and — unlike `fetch = () => new Promise(...)`
  — clicking another desk, switching to the building and striking a bell all
  still work, because POSTs and `/api/floor/turns` pass through.
- **`resize(w, h, { dpr })` and `shot(path, null, { full: true })`** exist for
  this: a capture asked for at device pixel ratio 2, and a view taller than
  the window (the building, the board) captured whole rather than cut.
- **An open task backdated by `created_at` alone reads as "task reopened"**
  in the activity log — the query treats `updated_at > created_at` on an
  open task as a stale claim reopening. Move both.

## Shooting the README images

Every image in `docs/images/` (2026-11-05 at 0.12.3) comes from one fresh
seed. The README's five are the landing captures plus two of their own, and
`docs/operating.md`'s five are element crops at DPR 2 (`operating-shot.mjs`:
two board cards, the activity log, a desk, a panel). One command does all of
it and tears down after itself (about 55 s):

```bash
.claude/skills/verify-ui-change/shoot-readme.sh "$PWD"             # docs/images
.claude/skills/verify-ui-change/shoot-readme.sh "$PWD" --landing   # and docs/review/landing
```

`--landing` writes six: the five above and `06-meeting-room.png`, the README's
meeting room in a narrow window for the page's 514 px slot. Its width is the
narrowest from 560 at which the room's "Nudge everyone · 1 unread" stays on
one line (700 at 0.12.3: below that it wraps and spills under the room's
edge, a page fault). Its height is the shortest with no transcript scrolling.
The script prints both. The same capture is also copied to
`docs/images/meeting-room-700.png` on every run, because `docs/operating.md`
draws the meeting room at width 700, 1:1. The README's `meeting-room.png` is
2200 px and would put text near 6 px at that width (appideas-designer, msg
3032). Two files, two widths, on purpose.

Re-run it after any version bump: the header's version is in every image.
Then **read the five images**. Its red case was run: without
`landing-host.mjs` it fails on the meeting room's replies and leaves
`docs/images` untouched. By hand, the steps are:

```bash
PORT=8906 DB_PATH=./data/landing.db ORCH_AUTH_TOKEN=k node src/server.js &
node .claude/skills/verify-ui-change/landing-seed.mjs &
node .claude/skills/verify-ui-change/landing-host.mjs &      # the desks answer what they are sent
ORCH_CDP_PORT=9273 node --experimental-websocket .claude/skills/verify-ui-change/landing-shot.mjs <dir>
ORCH_CDP_PORT=9273 node --experimental-websocket .claude/skills/verify-ui-change/readme-shot.mjs <dir>
```

**Set `ORCH_CDP_PORT` for any run of your own.** drive.mjs defaults to 9222,
which is where QA keeps a Chrome. `browser()` reuses whatever is on its port,
so a run on the default shoots through QA's browser, and a teardown by port
then kills it. The 2026-11-05 shoot ran on the default and once tore down
with `pkill -f orch-cdp`, the broad match the teardown section warns
against. No QA check was running at the time, so that was luck, not care.

`building.png`, `room.png` and `board.png` are landing-shot's 02, 01 and 05
under the README's names; `meeting-room.png` and `popouts.png` are
readme-shot's. Four things worth knowing first:

- **`DB_PATH` is printed in the page's header.** A scratchpad path puts the
  operator's home directory in a published image. Keep it `./data/landing.db`
  (`data/` is ignored).
- **The seed's database is `ORCH_SHOT_DB`, not `DB_PATH`.** Given neither,
  it opens `data/landing.db` itself, so a server started on another path
  leaves the seed writing a file nobody reads: `no such table: agent_profile`.
- **A meeting room needs a host that takes work.** landing-seed registers the
  host and never polls `/api/host/work`, so every room message sits at
  "sending". `landing-host.mjs` answers each chat with the desk's user turn
  and a scripted reply in the fixture's story. The App Developer is left out
  of the room because it is asking a permission question, and a desk that is
  asking takes no message (`askingWhy`).
- **An element crop paints only inside the window.** drive.mjs's `shot()`
  with a selector takes the element's window rect, and the capture paints
  nothing past the window: the activity log, which starts near the bottom
  of a 1000-px board, came out as four rows of twelve over dark ground.
  Pass `{ beyond: true }` for an element that may run past the window. Three
  wrong fixes were tried first: lifting the scroll box's cap, resizing the
  window, and scrolling the element into view. The last moves the window
  rect but not the page coordinates the clip is read in. Count the rows in
  the DOM before guessing.
- **`popouts.png` is a composite.** A popout is its own window, so each
  window is captured alone and the three are laid side by side on a backdrop
  drawn in the same headless browser. Nothing inside a window is retouched.
  Seed fresh for every run: a second run finds the first room's messages in
  the desks' turns.

## Teardown, because leftovers poison the next run

Neither `lsof` nor `netstat` is installed on this machine. Env vars are not
in `ps -A`'s command column, but `ps eww -o command= -p <pid>` shows them for
your own processes, so a scratch server is found by its `PORT=` without
touching anyone else's. This was used throughout issue #19:

```bash
for pid in $(pgrep -f "node src/server.js"); do ps eww -o command= -p $pid | grep -q "PORT=8931" && kill $pid; done
```

Or match on the script:

**And watch what your own command line says while you do it.** `ps | grep
"[s]rc/server.js"` matches the shell running it if that same command *also*
mentions `src/server.js` further along — the bracket trick hides the pattern
from itself, not from the rest of your line. Killing your own shell mid-teardown
looks like an unexplained exit code 144 and has happened three times here,
the third in issue #19 from an agent that had not read this section first:
`ps | grep -E "localhost:8933|…"` in a command that itself named
localhost:8933. Write the
PID to a file when you start the server, or keep the kill in a command that
mentions nothing else.

```bash
for p in $(ps -Ao pid,command | grep "[s]rc/server.js" | awk '{print $1}'); do kill $p; done
rm -f ./data/scratch.db ./data/scratch.db-wal ./data/scratch.db-shm
pkill -f "remote-debugging-port=9271( |$)"   # YOUR drive.mjs Chrome, by its exact port
```

Not `pkill -f orch-cdp`, which used to stand here. Every Chrome `drive.mjs`
launches has `orch-cdp` in its profile path, QA's included (they keep one on
9222 and others on announced ports), so it kills their runs as well as yours.

Deleting the DB while the server holds it frees nothing — kill first, then
delete, then confirm the port is actually dead. A test suite killed halfway
leaves a server on **8896** and fixtures in `data/`; check for both before
believing a later failure is real.

Finish by rebuilding the live stack, since `:8787` serves from the image and not
from `src/`. Do not chain a single curl onto it — `Started` prints before the
server binds, and the immediate probe answers `000` about a container that is
fine (measured 2026-09-01; it answers about two seconds later). Poll, then read
one fact out of the new image to prove it is the one serving:

```bash
docker compose up -d --build          # must print Recreated, not Running
for i in $(seq 1 40); do curl -sf localhost:8787/health >/dev/null && break; sleep 0.5; done
curl -s localhost:8787/health
```

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
[`probe-select.js`](probe-select.js), about 2 minutes:

```bash
PORT=8905 DB_PATH=/tmp/select.db ORCH_AUTH_TOKEN=k node src/server.js &
node .claude/skills/verify-ui-change/seed-select.mjs http://localhost:8905 /tmp/select.db /tmp/select-host.json > /tmp/select-work.jsonl &
node --experimental-websocket .claude/skills/verify-ui-change/check-select.mjs http://localhost:8905 /tmp/shots /tmp/select.db /tmp/select-host.json /tmp/select-work.jsonl
# … 54 ✓ · PASS
```

What it proves beyond the suite: a click on a selecting storey in the
building checks a desk instead of riding to it. The selection survives a
rebuild and a change of view, and Space keeps focus on the checkbox. With
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
  step of the check exists for that: leave and come back while a nudge is
  still in line.

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

## Teardown, because leftovers poison the next run

Neither `lsof` nor `netstat` is installed on this machine, and env vars do not appear in `ps`, so a
server started as `PORT=… DB_PATH=… node src/server.js` cannot be found by
either. Match on the script:

**And watch what your own command line says while you do it.** `ps | grep
"[s]rc/server.js"` matches the shell running it if that same command *also*
mentions `src/server.js` further along — the bracket trick hides the pattern
from itself, not from the rest of your line. Killing your own shell mid-teardown
looks like an unexplained exit code 144 and has happened twice here. Write the
PID to a file when you start the server, or keep the kill in a command that
mentions nothing else.

```bash
for p in $(ps -Ao pid,command | grep "[s]rc/server.js" | awk '{print $1}'); do kill $p; done
rm -f ./data/scratch.db ./data/scratch.db-wal ./data/scratch.db-shm
pkill -f "orch-cdp"       # drive.mjs's browser (profiles live in tmpdir)
```

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

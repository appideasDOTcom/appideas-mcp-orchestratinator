---
name: verify-ui-change
description: See a board or floor change actually work in a browser before reporting it — seed a throwaway server, drive the real page headlessly, and read the result. Use for any change to src/ui/*, and before claiming any UI behaviour is fixed.
---

# Seeing a UI change actually work

Both surfaces are drawn from live server state, so source that reads correctly
can still be wrong on the page. The only honest test is the real page against a
real server. This is how to get one in about a minute, and — more importantly —
the specific ways this has produced a **false pass**.

## Eight ways a green result has lied here

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

## Driving the page

**Use `drive.mjs`, in this directory.** Headless Chrome over CDP, no
dependencies — it launches the browser if one is not already up, and a whole
check is about ten lines:

```js
// check.mjs — run with: node --experimental-websocket check.mjs
import { open } from '<repo>/.claude/skills/verify-ui-change/drive.mjs';

const page = await open({ base: 'http://localhost:8905', view: 'floor', floor: '', minimized: ['beta'] });
console.log(await page.probe('probe.js'));            // a file of browser code
await page.click('#floor-pick .chip.folded');
await page.waitFor(`document.querySelectorAll('#floor-rooms .room').length === 1`);
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
| floor pills | `.desk[data-agent="…"] .pill[data-kind="unread"\|"assigned"\|"claimed"]` |
| floor — open the chat panel | `.desk[data-agent="…"] .deskHit` |
| floor — whose panel is open | `#floor-panel` `dataset.channel`/`dataset.agent` — wait on this, not on visibility |
| floor — the panel's link strip | `#floor-panel [data-act="openhere"\|"handback"\|"attach"\|"claude"]` |
| floor — details popover | `.faceHit` (the sign), `.plateHit` (the nameplate) |
| in-dialog actions | `#dlg [data-do="…"]`, Nudge is `#dlg .nudge` |
| dialog error | `#dlg .dlg-err:not([hidden])` |
| a message on its way | `#p-turns .t-pending` (`.t-body`, `.t-when`) |

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

## Teardown, because leftovers poison the next run

`lsof` is not installed on this machine, and env vars do not appear in `ps`, so a
server started as `PORT=… DB_PATH=… node src/server.js` cannot be found by
either. Match on the script:

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

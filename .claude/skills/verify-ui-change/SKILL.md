---
name: verify-ui-change
description: See a board or floor change actually work in a browser before reporting it — seed a throwaway server, drive the real page headlessly, and read the result. Use for any change to src/ui/*, and before claiming any UI behaviour is fixed.
---

# Seeing a UI change actually work

Both surfaces are drawn from live server state, so source that reads correctly
can still be wrong on the page. The only honest test is the real page against a
real server. This is how to get one in about a minute, and — more importantly —
the specific ways this has produced a **false pass**.

## Four ways a green result has lied here

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

**Measuring the container instead of the contents.** `getBoundingClientRect()`
includes padding, so "is there padding?" answered itself wrongly. Read computed
styles, or measure the child. Related: `color-mix()` computes to
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

## Driving the page

Headless Chrome over CDP. `node --experimental-websocket` needs no dependencies.

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --remote-debugging-port=9222 --disable-gpu --no-first-run \
  --user-data-dir="$SP/cprof" --window-size=1400,1000 about:blank &
```

Then `Runtime.evaluate` with `returnByValue: true`. Two things worth building in
from the start: **surface `exceptionDetails`** — a thrown handler otherwise reads
as a silent no-op and looks like "the click did nothing" — and return state as a
`JSON.stringify` blob so one call answers the whole question.

Put injected browser code in its own file. Nested backticks inside a heredoc
inside a shell command will break it in ways that look like a page bug.

Which view loads is `localStorage`, set before navigating:

```js
localStorage.setItem('orch.view','floor');   // or 'board'
localStorage.setItem('orch.floor','<channel>');
```

### Where to click

| Target | Selector |
|---|---|
| board unread pill | `[data-act="unread"][data-agent="…"]` |
| board task pills | `[data-act="tasks"][data-kind="assigned"\|"claimed"]` |
| floor pills | `.desk[data-agent="…"] .pill[data-kind="unread"\|"assigned"\|"claimed"]` |
| floor — open the chat panel | `.desk[data-agent="…"] .deskHit` |
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
pkill -f "cprof"          # the browser profile dir
```

Deleting the DB while the server holds it frees nothing — kill first, then
delete, then confirm the port is actually dead. A test suite killed halfway
leaves a server on **8896** and fixtures in `data/`; check for both before
believing a later failure is real.

Finish by rebuilding the live stack, since `:8787` serves from the image and not
from `src/`:

```bash
docker compose up -d --build && curl -s -o /dev/null -w '%{http_code}\n' localhost:8787/health
```

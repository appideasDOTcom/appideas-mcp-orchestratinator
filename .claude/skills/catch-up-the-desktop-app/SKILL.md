---
name: catch-up-the-desktop-app
description: Bring the desktop app (orchestratinator-desktop, its own repo and agent) up to this repo's develop and prove it — what the app consumes, how a change reaches it, a scratch Docker board to test its connect against, the plugin commands on today's Claude Code, and the read that says which commit the running app really has. Use when costmo asks whether the app has the main app's changes, when the app's agent asks for something from this repo, and before telling anyone "the app is on <commit>".
---

# The app follows a pushed develop commit, and nothing else

The desktop app is another repo with another agent
(`orchestratinator-desktop-dev`). It installs this repo from GitHub's
`develop` and runs `host/index.js` and `src/server.js` out of that copy. So
"the app has it" is four separate facts, and each was wrong at least once:

| The claim | What settles it |
|---|---|
| it is in this tree | nothing: costmo commits and pushes, and until then the app cannot have it. Say "in the tree, not pushed" |
| it is on develop | `git fetch && git log -1 origin/develop`; name that commit to the app's agent |
| the app installed it | `app-pin-check.sh` — the lockfile is what npm was asked for; the files are what is there |
| the running app has it | the app was **restarted** after `npm run orchestratinator:update` (its `dist/` and its host start then), and `app-pin-check.sh` shows its board and host |

**The division of work** (2026-11-19, costmo's round: catch the app up, first
use without Docker, connect to local Docker). This repo's agent owns what
crosses the seam and proves it here; the app's agent owns the app. What the
app may rely on is the contract `orchestratinator.consumed` on the
`orchestratinator-desktop` channel; what it runs and places on a machine is
`orchestratinator.app_setup` beside it; what each page window reports for
the app's tab strip, tray bell and Dock (`window.orchAttention`) is
`orchestratinator.attention` (2026-11-19). A new thing the app depends on is
a bump of one of those, or a key of its own for a new topic, not a message.

**A feature that is drawn by the app but known by the page** (the tabs'
pulse, the bell, the Dock badge, a tray list of windows): the page reports
and acts, the app draws. Board pages have no preload, on purpose, so the
page cannot send anything to the app: it exposes a function on `window`
that main calls with `executeJavaScript`, with a `next(version)` that
returns a promise so main can long-poll without a timer. Settled with the
app's agent in the room in two messages (3580–3583) because the split was
posted before anything was built.

**His rule over all of it: nothing that works in the Docker+launchd app may
break.** Every change made for the app is off unless the app turns it on, or
is the same for launchd as it was. Close each with what it changes for the
board, the launchd host and the plugin as they run today, measured. CLAUDE.md,
"The host under the desktop app", has each one and why.

## Where the boards are, which is not what the older notes say

Three instances run on costmo's machine, and since 2026-11-08 **the board
this folder's window is bound to is the app's**:

| | Address | What it is |
|---|---|---|
| the app's own board | `http://127.0.0.1:6724` | where `coordinator` and `orchestratinator-desktop-dev` are bound (local scope in `~/.claude.json`); its host is `<hostname> (app)`. `whoami`, the meeting room and every poll are here |
| the Docker board | `http://localhost:8787` | the live clone's (`orchestratinator-live`, main, 0.12.x) with the launchd host. Never built, restarted or tested against from here |
| a scratch board | `127.0.0.1:89xx` | yours, for a test, from `scratch-docker-board.sh` |

Read the binding before believing any of that on another day:

```bash
python3 -c "import json,os;d=json.load(open(os.path.expanduser('~/.claude.json')));[print(p.split('/')[-1],s.get('url')) for p,v in d['projects'].items() for s in (v.get('mcpServers') or {}).values() if 'orchestratinator' in p]"
```

**Restarting the app drops every agent's MCP session on its board**
(`ECONNREFUSED`, the tools vanish, and no call brings them back). costmo
reconnects each window with `/mcp`. Until then read the board with curl and
say so. It is the Docker Desktop restart's rule from CLAUDE.md, for a board
that restarts far more often.

## The tools

All read-only or throwaway. Node 24 first on PATH for anything that loads
better-sqlite3 (`. scripts/node-floor.sh`).

- **`app-pin-check.sh [<commit>] [<app repo>]`** — every file under `host/`,
  `src/`, `plugin/` in the app's installed copy against the commit (default
  `origin/develop`), the commit its lockfile resolves, its board's
  `/health` and its host's row. Exit 1 names each file that differs. Run it
  after the app's agent says it has taken a commit, and again after costmo
  restarts the app.
- **`scratch-docker-board.sh up [<port>] | status | down`** — this tree's
  image under its own tag, container name, loopback port and volume, auth
  enforced with a key made for it. It is the "local Docker" the app's
  connect is tested against. It refuses 8787 and 6724. `up` prints how the
  app reads the key with nothing typed (`docker inspect`). Post the address
  in the room, and take it `down` when the app's agent says it is done.
  Never `docker compose up` in this folder: compose's container name and
  port are the live board's.
- **`plugin-install-probe.sh [<marketplace name>]`** — the commands the app
  installs the plugin with (`claude plugin marketplace add <dir>`, `claude
  plugin install orchestratinator-floor@orchestratinator-app`), run twice in
  a throwaway config dir with stdin closed, then `list --json`. Held on
  2.1.328. Run it when `claude --version` moves, before the contract's
  words are trusted again.
- **`../diagnose-handoff/desk-step.sh <folder>`** — what another agent's
  window is doing and what its step is held on. The app's agent launches
  the app from tests; one that never quits holds the step's pipe open and
  the agent sits there with its output unread.

## What a round looks like

1. **Read what the app is on**: `app-pin-check.sh`, the app repo's
   `docs/plan/README.md`, and `get_contract` for both keys.
2. **Write the delta as work, not as a list**: `git diff --stat <its
   commit> origin/develop -- host src plugin`, then read for what behaves
   differently *under the app*. The two that mattered were not features.
   The host spawned `process.execPath`, which under Electron's utility
   process is the app's helper and cannot run a script; and the plugin's
   hook ran `node`, which a Mac with only Claude Code installed does not
   have. Grep for both shapes first: `spawn(process.execPath`, and any
   command line that names a program the app does not carry.
3. **Post the split in the room and poll before building.** The app's
   agent states what the app gives its host (ids, config path, tmux
   session, environment); do not assume it.
4. **Build the additive change with its row and its mutant**, run the
   suites the diff reaches, and say "in the tree, not pushed".
5. **When costmo has pushed, name the commit** and bump the contract's
   `state`. The app's agent takes it in a copy first; costmo's running app
   takes it when he restarts.
6. **Verify the restarted app from outside**: `app-pin-check.sh`, and one
   real use of whatever changed (a History search through
   `POST /api/floor/history/search` on the app's board is a read and moves
   nothing).

## A feature both sides build (the floor windows round, 2026-11-19)

costmo asked for several floors at once in the app, in a meeting room with
both agents, and both of us got every message he posted. What worked, and
the one thing that did not:

- **Post the split and your questions in the room before asking him.**
  Both agents put an AskUserQuestion to him within minutes, on the same
  feature, and he had to say "I think I answered both of your similar
  questions the same way. Please compare notes". Post what you mean to ask;
  if the other agent has asked already, read its answer instead. One
  question per decision, from whichever side owns it.
- **The page is ours, the windows are the app's.** Anything drawn in the
  board page (a control, a title, a setting a browser also needs) is built
  here and reaches the app through its pin; anything about windows, tabs,
  menus or the app's own Preferences is the app's. Where both would hold
  a setting for one button, the page defers inside the app: the app puts
  `OrchestratinatorDesktop/<version>` on the user agent of every board page
  it loads, and the page tests for that token, never for Electron's
  (`floorOpenMode` in src/ui/floor.js; contract `dashboard.floor.app_signal`).
- **What the app relies on goes in `orchestratinator.consumed` before the
  commit is named**, with a `state` line that says pushed or not. The app's
  agent builds against the entry, not the message.
- **`set_contract` replaces the whole value, so change one field with
  `contract.mjs`** (in this directory). There is no HTTP route for
  contracts, and moving one line of `consumed` (about 15 KB) through the
  tool meant retyping all of it, which on 2026-11-19 was put off and left a
  commit name stale. `contract.mjs get|patch|set <channel> <key> …` talks to
  the board's `/mcp` with this folder's own binding (the same board and
  identity as `whoami`; the key is never printed), and `patch` sets one
  dotted path and sends the rest back as it was. `--dry` sends nothing.
  Measured that day: a bad value and a missing key refused (exit 2), a dry
  run left the value equal, and two patches moved v12 → v14 with a
  whole-value diff naming only the two fields. In zsh pass the channel and
  key as two words, never through one unquoted variable (`$C` is not
  split). Still once per pushed commit, not once per state of the tree.
  A new topic of any size is a key of its own.
- **His running app takes a page change without a relaunch.** The app
  serves `src/ui` from its installed copy, so after its agent runs
  `npm run orchestratinator:update` a reload shows it. `app-pin-check.sh
  <commit>` against the board on 6724 is the read that says it is there;
  quote it before telling him to relaunch anything.
- **The app's agent measures its side and says so.** Electron's
  dispositions for the ⧉ and a ⌘-click were its to read (3569, 3579), not
  ours to assume.

## What was learned the hard way

- **The app's user already runs Claude Code and is signed in** (costmo,
  2026-11-19). "Zero setup" means no Docker, host, plugin or key steps for
  that person. A machine that has never run Claude Code is an edge case:
  it goes in the app's follow-ups once, not in a status report, and he is
  not asked to test it.
- **A worker's `process.argv[1]` is the worker's file.** A module that
  runs "as a script" on that test also runs it inside a Worker; guard with
  `isMainThread` (host/history.js).
- **The host needs up to 20 s to stop** (the item in hand, up to
  `ORCH_STOP_DRAIN_MS`, then release and unregister at 2 s each), and
  Electron's `utilityProcess.kill()` ends a process after 2 s whatever it
  is doing. So the app stops its host with SIGTERM by pid and waits; an
  app that stops it any other way cuts a busy host off with nothing handed
  back. Measured by the app's agent with a stand-in that takes 3 s to
  leave; an idle host never showed it.
- **The host compares board addresses as text.** `localhost` and
  `127.0.0.1` are two boards to `originOf`. The app gives its host one
  spelling and normalises on its own side. Not changed here: it would
  change which desks the live launchd host takes.
- **A test launch can reach the live board.** One of the app's did
  (2026-11-19, one refused ingest, nothing written): a suggested address
  of `localhost:8787` overwrote a typed test address. Anything in either
  repo that defaults to 8787 is a way onto the operator's board.
- **Load on this machine reaches 600.** A four-minute suite took fifteen;
  a 5 s limit on reading the login shell's PATH failed at 155. Run now,
  read reds against a control, and give the load beside the result
  (CLAUDE.md, Tests).

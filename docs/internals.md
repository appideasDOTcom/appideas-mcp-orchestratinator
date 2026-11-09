# Internals & development

## Run the server (Docker)

```bash
cd appideas-mcp-orchestratinator
cp .env.example .env                 # then set ORCH_AUTH_TOKEN — see the security model
docker compose up -d --build
```

Compose reads `.env` (gitignored) and refuses to start without
`ORCH_AUTH_TOKEN`, rather than quietly bringing up an unlocked server.

MCP clients connect to `http://localhost:8787/mcp`; the dashboard is at
`http://localhost:8787/`. The SQLite database persists in the named volume
`orchestratinator-data` (survives rebuilds).

```bash
curl -s http://localhost:8787/health        # {"ok":true,...}
docker compose logs -f orchestratinator      # tail logs
docker compose down                          # stop (data is kept in the volume)
```

`src/` is baked into the image, so a change there needs
`docker compose up -d --build` to show up on the running board.

The image records the commit it was built from (`/health` → `commit`), which
is what the board compares with GitHub to offer an update. Compose passes
the clone's `.git` as a second build context for that one step; it is never
copied into the image. A plain `docker build .` fails at that step — build
through compose, or add `--build-context gitmeta=./.git`.

## Run locally without Docker (for hacking on it)

Node 22.14 or later. better-sqlite3 13 is a Node-API 10 binary, and a Node
that offers Node-API 9 (20.x, 22.x before 22.14) dies on loading it with no
words at all — exit 139 — so `src/node-floor.js` says so first. The board's
image is node:22 and has it; the host has no dependencies and still runs on
Node 20. `. scripts/node-floor.sh` puts a suitable Node first on PATH for the
shell it is sourced in (the oldest one nvm has that will do), or says there
is none.

```bash
. scripts/node-floor.sh   # only if `node -p process.versions.napi` is under 10
npm install
npm start            # MCP on /mcp, dashboard on /, db at ./data/orchestratinator.db
npm run smoke        # end-to-end self-test (spawns its own server, cleans up)
npm test             # every suite — coordination (smoke), operator actions,
                     #   the doors, the board's log, the capture, the floor,
                     #   markdown, the plugin, updates, the host, the window
```

The host can also run by hand instead of as a LaunchAgent:
`ORCH_HOST_ROOTS=~/Documents/dev/appideas npm run host`. It has no dependencies
of its own; it needs Node, `tmux`, and `claude` on the PATH and signed in.

## Bumping the version

**One command, because three files carry it.** The server package, the host
package and the Claude Code plugin manifest each hold a number, and none of
them can read another at install time — Claude Code parses the manifest
straight off disk, so its version has to be a literal.

```bash
npm run set-version 0.9.2
docker compose up -d --build     # the dashboard's number comes from the server
```

The dashboard header shows the *server's* version and gets it by reading
`package.json` at startup rather than carrying a copy, so that half cannot
drift. The other half is enforced: `npm run smoke` asserts all three files
agree and that `/health` and `/api/state` report the same number. Bump one on
its own — the plugin used to be bumped alone every time a hook changed — and
the suite goes red instead of the board quietly advertising a build nobody has.

**The protocol number is separate from the version, and is checked.**
`protocol` in `package.json` and `host/package.json` (one integer, `1` since
0.12.5) is the host↔board protocol: what crosses `/api/host/*` — the
register body and reply, the work items, the events. The board reads its
own off `package.json` (`/health` and `/api/state` carry it), the host
reads its own off `host/package.json` and sends it on every registration,
and a host whose number is not the board's is refused in words
(`protocolRefusal` in `src/floor.js`): the host logs them once, tells the
process that started it over its port if it has one, keeps trying on its
usual backoff, and `/api/floor`'s `hosts` rows carry them as `refused`. A
host that sends no number is one from before there was one and is refused
the same way. The version still moves in lockstep; the protocol moves only
when one side would read the other's words wrongly — a field renamed, a
kind dropped, a reply reshaped — never for a field added. It exists for
the desktop app, whose packaged host updates on its own schedule
(docs/desktop-app.md); on a launchd install the mismatch it catches is a
board rebuilt beside a host nobody restarted, which the board then says
instead of a desk quietly taking no message.

## Environment variables

See `.env.example`:

- `ORCH_AUTH_TOKEN` — the shared secret; empty disables auth.
- `ORCH_AUTH_MODE` — `off` / `warn` / `enforce`; default `enforce` when a token
  is set.
- `PORT` — default `8787`.
- `HOST` — default `0.0.0.0`, which it must stay inside Docker. Set
  `HOST=127.0.0.1` when running bare and you want this machine only.
- `DB_PATH` — default `./data/orchestratinator.db`; `/data/...` in Docker.
- `CLAIM_TTL_MINUTES` — default `15`; how long a claim can sit before it
  auto-reopens.
- `SESSION_TTL_MINUTES` — default `15`; how long an untouched MCP session is
  kept.

Updates (issue #40) — the defaults are what a real board wants; the rest
exist for the suites:

- `ORCH_UPDATE_REPO` — default `appideasDOTcom/appideas-mcp-orchestratinator`;
  the public repo checked and fetched.
- `ORCH_UPDATE_MIN_GAP_MS` — default `60000`; the least time between two
  contacts with GitHub, however often Check now is pressed.
- `ORCH_UPDATE_TICK_MS` — default `600000`; how often the board asks itself
  whether the daily check is due. Only a board in a container checks by
  itself; one run bare checks only on Check now.
- `ORCH_UPDATE_SILENT_MS` — default `1200000`; an update with no word from
  its host for this long ends as failed.
- `ORCH_GITHUB_API`, `ORCH_GITHUB_RAW`, `ORCH_BUILD_COMMIT`,
  `ORCH_BOARD_CONTAINER` — stand-ins: where GitHub is, which commit this
  build is, and which container it runs in.
- On the host: `ORCH_HOST_CLONE` (default the directory above `host/`),
  `ORCH_HOST_DOCKER`, `ORCH_UPDATE_FETCH_URL`, `ORCH_UPDATE_BUILD_TIMEOUT_MS`
  (15 min), `ORCH_UPDATE_HEALTH_TIMEOUT_MS` (3 min), and
  `ORCH_HOST_SUPERVISED=1`, which stands in for launchd.

The host under the desktop app (tasks #288–#290 on the desktop channel):

- `ORCH_HOST_SUPERVISOR` — who starts the host again after it exits: `app`
  for the desktop app. launchd is read from `XPC_SERVICE_NAME` and needs
  nothing set. Reported as `supervisor` on every registration; the page
  offers no update for an app-run host (the app updates it), and the host
  refuses one at preflight in the same words.
- `ORCH_FOLDER_DIALOG=parent` — the folder dialog is the process that started
  the host, asked over Electron's `process.parentPort` or Node's IPC
  channel; the messages are in the header of `host/dialog.js`. Any other
  value is a program to run in the dialog's place (the suites' stand-in).
- `ORCH_HOST_PROTOCOL` — the suites only: stand in for a host from another
  build. Nothing installed sets it.

`curl -s localhost:8787/health` reports the live session count and lifetime
connection churn (`opened` / `superseded` / `expired`) — a large `superseded`
just means a client opens a session per turn, which is normal and handled.

## How it works

- **Transport:** Streamable HTTP (`@modelcontextprotocol/sdk`), so multiple VS
  Code windows connect to one shared process. (stdio would spawn a *separate*
  server per window with no shared state — which defeats the purpose.)
- **Session binding:** on `initialize`, the server reads `X-Channel`/`X-Agent`
  from the request headers and binds them to that MCP session; a fresh
  per-session `McpServer` closes over that context. Sessions are pruned by
  supersession (a new one for the same channel+agent closes that pair's older
  idle ones) and by an idle sweep, so a client that never sends `DELETE` can't
  leak `McpServer` instances. In-flight requests and open SSE streams are
  exempt.
- **Storage:** SQLite via `better-sqlite3`. One Node process means writes
  serialize naturally — no cross-process locking. Data lives in a Docker
  volume.
- **Schema:** `messages`, `contracts` (+ `contract_history`), `tasks`, `agents`
  (presence), `channel_flags` (archive), `desk_flags` (a desk hidden by
  hand), `admin_events` (operator audit) — all
  keyed by `channel` — plus the floor's tables: `agent_sessions` and `turns`
  (what each window reported), `agent_profile` and `personas` (who each agent
  is and where it sits), `hosts`, `hosted_desks`, `host_outbox`,
  `saved_prompts` and `meeting_rooms`. See [`src/db.js`](../src/db.js). A channel is never a row of
  its own; it's a key shared across those tables, which is why archiving needs
  a flag table and deleting has to sweep all of them in one transaction.
- **The floor's chat controls (0.10.9):** `agent_sessions` carries `effort`,
  `model_requested`, `effort_requested`, `compacting_since` and
  `compacting_trigger`. The hooks write the confirmed side (PreCompact /
  PostCompact, PreModelSwitch / PostModelSwitch, `effort_level` on every
  tool-context event, SessionStart with `source`); `POST /api/floor/chat`
  writes the asked-for side when the text is `/model <name>` or `/effort
  <level>`, refuses a bare `/model` and an unknown level, and hands every
  slash command to the host as chat work. The host answers with two events
  of its own: `receipt` (a command confirmed on its own receipt — the
  sentence, and for the picker the model and effort it set) and `model`
  (the model the transcript's latest reply names). `FLOOR_COMMANDS` in
  [`src/floor.js`](../src/floor.js) is the list the composer offers; the
  page carries the same list, and `test/floor.mjs` checks the two agree.
- **Dashboard:** a separate Express router on the same port. `GET /api/state`
  builds the channel/agent view; `GET /api/activity` is a `UNION ALL` over
  messages, task transitions, contract history and operator actions, ordered
  newest-first. The page polls both every 2.5s, so it stays current without a
  reload. Live presence comes from an in-memory registry of open MCP sessions,
  which is why closing a VS Code window shows up immediately rather than aging
  out of the database.
- **Operator actions:** `POST /api/admin/*`, guarded independently of the read
  side (same-origin check; see [the security model](security.md)). Each one
  writes an `admin_events` row, and `retire`/`delete` also reach into the
  session registry to close live sessions — a database-only change would be
  undone by the next tick, since a live session is itself a source of presence.
- **Human auth:** none. There is no guard in front of the dashboard router at
  all, which is why there is nothing here to describe — the shape of this
  section is the point. `/api/admin/*` gets one middleware that compares
  `Origin` against `Host` and rejects `Sec-Fetch-Site: cross-site`; absence of
  `Origin` passes, since a same-origin `GET` and curl both omit it.
- **Backups:** [`src/backup.js`](../src/backup.js) dumps and reloads a fixed
  table list, generically, via `PRAGMA table_info` — the column set is the
  file's own rows intersected with the live schema, which is what lets a file
  survive a migration in either direction. The reload is one `db.transaction`
  over every table, because a half-restored board is worse than a refused one.
  `/api/admin/backup/restore` is the single route with a raised body limit
  (`RESTORE_BODY_LIMIT`, default 128mb); everything else stays capped at 4mb.
- **Self-heal:** a claim with no completion after `CLAIM_TTL_MINUTES` (default
  15) reverts to `open` on the next open-poll, so an abandoned claim (agent
  claimed a task, then its turn died) can't sit invisibly in `claimed`.
  `status=claimed` inspections never trigger this — only actionable open-task
  listings do.
- **What became of a take:** `POST /api/floor/desk` answers when the board
  has handed the bind to a host, not when the host has made it. The board
  keeps each take in memory (`live.takes`, by host, floor and agent) and
  `GET /api/floor/take?host_id=&channel=&agent=` reads it: `state` is
  `asked`, then `seated` (the host's `bound`) or `refused` with the host's
  `error` and `code`. Null after a restart. A take of a folder bound to
  another instance needs `from_board` and is mode `release`; without it
  the refusal is `other_board` and carries the address, with a stale one
  `board_changed`, and from a host that has not said `release: true`,
  `old_host`.
- **The folder list:** each host reports, on every registration, the folders
  under its roots that could become a desk — bound or not, and from which
  file, with the time of the newest transcript Claude Code wrote there. It is
  in memory only (`live.folders`) and served by `GET /api/floor/folders` on
  demand, never in `/api/floor`. A field on a folder crosses six places, all
  hand-picked, and a drop in any one arrives on the page as `undefined`:
  `discover()` in `host/identity.js` builds it → `register()` in
  `host/index.js` posts it (paths canonical, `other_board` set against this
  host's origin) → `/api/host/register` validates it (`cleanFolders`: absolute,
  under a posted root, capped at 300) → `live.folders` → the GET's projection →
  the dialog. The floor suite reads each field back through the GET with a
  fixture value that cannot equal a fallback. The dialog draws the top of that
  list as **Recently opened** — the folders Claude Code has been run in,
  newest first, five of them (`recentFolders` in `src/ui/app.js`); the list as
  a whole was taken out of the dialog for being every candidate by its last
  path segment, and five with their paths is as long as it gets. The same GET
  carries `names`: the names somebody has saved, by agent id, which the dialog
  shows for the agent being seated instead of asking for one — an agent with
  nothing saved is absent from the map and reads "none", not the name the
  board would derive from its id.
- **The folder dialog:** "Take a desk" chooses its folder in the operating
  system's own dialog, opened by the host on the machine it runs on. One
  function, `host/dialog.js`, with a backend per platform — macOS only so
  far, and that file's header is the record of why it is the backend it is
  (four ways were watched from a LaunchAgent; three are drawn and never take
  focus, or outlive their process) and why it is not a library (the one on
  npm that runs on a Mac is one of the three). A host says whether it has a
  dialog on every registration (`dialog` beside its folder list), and the
  page draws its own one-level list for a host that has none, or whose dialog
  failed. The ask is `POST /api/floor/pick` → a `pick` work item → the dialog
  in a child process, not awaited, because the same loop delivers messages →
  `pick` events (`open`, then `chosen` / `cancelled` / `failed`) → `GET
  /api/floor/pick`, which the page polls: 8 s for `open`, then for as long as
  the person takes. A chosen folder is sent as an ordinary `browse` listing
  first, so the form is filled and a take is checked exactly as for a folder
  opened in the list — the board still never sends a path the host has not
  named. Work items carry `waited_ms`, stamped by the board as it hands them
  over, so the host can drop a request the page has given up on without
  comparing two machines' clocks. Where the dialog opens is the folder the
  last choice was made in, remembered per host in the browser
  (`localStorage['orch.desk.dir']`) and sent as a hint; the host opens the
  nearest folder above it that still exists.

- **History, and reading a conversation whole:** three things on the floor
  read the transcripts on the hosts rather than this server's tables, and
  the reason is in `host/history.js`'s header with the numbers it was
  decided on — `turns` is a live tail (the newest 400 rows a desk), and a
  list or a search built on it covers part of the history without saying
  which part.
  - *Recent across desks* (`POST`/`GET /api/floor/history/recent`): a
    `recent` work item to every live host; each answers with its desks'
    conversations, the picker's own bounded read of each file, as a
    `history` event. Throttled per host (`ORCH_HISTORY_MIN_MS`, 5 s).
  - *Search* (`POST`/`GET /api/floor/history/search`): a `search` work item;
    the host runs `host/history.js` as a process of its own (a 70 MB
    transcript is a third of a second of `JSON.parse`, and the relay shares
    the host's event loop), ends it if a newer search arrives, and answers
    with the conversations that matched, how many turns in each, and the
    first few. Said text only unless `deep`, which adds tool calls, thoughts,
    injected context and the subagents' transcripts. Each search is its own
    record by id, so two people can search at once.
  - *Reading one* (`POST`/`GET /api/floor/read`): a `read` work item to the
    desk's host, which pages the whole transcript — subagents merged in by
    time — up as `transcript` events. Rows are built by the rules a relayed
    turn is (`toolSummary`, the context tag, `via`) and held in memory, the
    newest four reads, never written to `turns`. Nothing a reopen refuses is
    refused: reading closes and moves nothing.
  Every answer names the hosts it is from; a host that is offline is in the
  answer as offline, and the page says its conversations are not covered. A
  row a host sends for a desk it does not run is dropped. The page draws the
  first two in the History dialog (`historyDialog` in `src/ui/app.js`) and
  the third in the desk's own chat panel (`readingShell` in
  `src/ui/floor.js`): a different shell with a banner and a way back, the
  same `turnNode`, and no composer or actions at all.
- **Meeting rooms (issue #44, 0.12.0):** several desks of one floor in one
  window, which is the page with `?meeting=<id>` — a popout's sibling, out
  the popout's way (a Web Lock per desk under `popLockName`, taken
  `ifAvailable`, and `here` on the `orch.popouts` BroadcastChannel carrying
  `meeting`), so the floor's panel, the detach button and a floor nudge all
  step aside for it exactly as they do for a popout. Its stream is the
  SharedWorker's, asked for every participant. The board adds no route that
  types into a window: a room's message is one `POST /api/floor/chat` per
  recipient, in `nudgePlan`'s order, and each desk's delivery is read off
  that desk's own turns and delivery note (`meetingEntry`). What the board
  keeps is `meeting_rooms`, for Resume: the floor and each participant's
  agent, conversation, host, folder and starting turn, written by `POST
  /api/floor/meeting` (create), `/meeting/participants` (Add, Remove, a
  conversation changing), `/meeting/open` (a reload or a Resume clears
  `ended_at`) and `/meeting/end` (End, or the window's pagehide, with
  keepalive), and listed newest first by `GET /api/floor/meetings`. Bounded
  at `MEETINGS_KEEP` (20), pruned as each room is created; swept by
  `purgeChannel`; not in `BACKUP_TABLES`. Resume reopens each desk through
  `POST /api/floor/reopen`, after asking its host's conversation list, and
  says why for each desk it does not (`meetingResumePlan`). A room's
  conversation is contained: `send_message` with no `to` from an agent in a
  room that is open and live (its window's `POST /meeting/touch` within
  `MEETING_LIVE_SECONDS`, 150 s) stores the room's participants in
  `messages.audience`, which `pollMessages`, `unreadCounts` and
  `unreadMessages` honour. Direct messages are unaffected.

```
src/
  server.js   Express + Streamable HTTP wiring, per-session header binding
  db.js       SQLite schema + channel-scoped data operations
  tools.js    The MCP tool definitions
  floor.js    The floor's server half: ingest, hosts, the live layer
  agent-state.js  One derivation of "what is this agent doing", used by both views
  palette.js  The avatar colours, shared by server validation and the picker
  web.js      Dashboard router: /api/state, /api/activity, /api/admin/*, static UI
  auth.js     The shared-secret guard on /mcp + /api/ingest, and the cross-origin check on writes
  backup.js   Export and restore the whole board as one JSON document
  ui/         The dashboard page (no build step, no external assets)
host/         The workstation service that runs desks in tmux windows
plugin/       The Claude Code plugin (orchestratinator-floor) — the floor's hooks
clients/      Ready-to-copy .mcp.json files + a CLAUDE.md snippet
scripts/
  set-version.mjs   Writes the version into all three files that carry one
test/         Eight suites; test:host and test:window drive real tmux panes
              against a real server
```

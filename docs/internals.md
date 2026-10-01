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

## Run locally without Docker (for hacking on it)

```bash
npm install
npm start            # MCP on /mcp, dashboard on /, db at ./data/orchestratinator.db
npm run smoke        # end-to-end self-test (spawns its own server, cleans up)
npm test             # all eight suites — coordination (smoke), operator actions,
                     #   the doors, the floor, the host, the window, the plugin,
                     #   and markdown
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
  (presence), `channel_flags` (archive), `admin_events` (operator audit) — all
  keyed by `channel` — plus the floor's tables: `agent_sessions` and `turns`
  (what each window reported), `agent_profile` and `personas` (who each agent
  is and where it sits), `hosts`, `hosted_desks`, `host_outbox` and
  `saved_prompts`. See [`src/db.js`](../src/db.js). A channel is never a row of
  its own; it's a key shared across those tables, which is why archiving needs
  a flag table and deleting has to sweep all of them in one transaction.
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

<!-- DRAFT for review. Final home: docs/internals.md -->

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

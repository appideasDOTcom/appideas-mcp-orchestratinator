# The security model

Short version: **the network is the boundary.** Agents authenticate to `/mcp`
with one shared secret; the dashboard asks for nothing at all. That is a
deliberate trade for the shape this runs in — one machine, one person, one
trusted network — and this page is where the trade is spelled out so you can
decide whether it fits yours.

## The shared secret

Every MCP client presents one shared key. It's a doorlock, not a security
model: one static token for all agents, no rotation, and `X-Agent` is still
self-asserted — anyone holding the key can claim to be anyone. It exists so
something that stumbles onto the port can't read and write the board.

Generate one and put it in `.env` (gitignored, and read by both
`docker compose` and `npm start`):

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

```ini
# .env
ORCH_AUTH_TOKEN=<the generated value>
ORCH_AUTH_MODE=enforce
```

Clients send it as `X-Orchestratinator-Key: <token>` (or
`Authorization: Bearer <token>`). `/health` stays open so the container
healthcheck keeps working. Compose refuses to start without `ORCH_AUTH_TOKEN`,
rather than quietly bringing up an unlocked server.

### Turning it on without interrupting anyone

Restarting straight into `enforce` cuts off every agent whose `.mcp.json`
hasn't been updated yet — including one that's mid-task. `ORCH_AUTH_MODE=warn`
exists for that window: a missing or wrong key is logged and **allowed
through**.

1. Set `ORCH_AUTH_TOKEN` and `ORCH_AUTH_MODE=warn` in `.env`, then
   `docker compose up -d`.
2. Add the header to each repo's `.mcp.json` and reload those windows.
3. Watch `docker compose logs -f orchestratinator` until no `auth WARN` lines
   appear — that means every live client is sending the key.
4. Flip to `ORCH_AUTH_MODE=enforce`, `docker compose up -d`.

A rejected client gets `401` with a JSON-RPC error explaining which header to
set — it never reaches a tool and never appears on the dashboard.

## The dashboard is not guarded

The secret does not guard the page. `/`, `/api/state`, `/api/activity` and
every `/api/admin/*` route answer anything that can reach the port — no key, no
cookie, no sign-in. The board renders every message body on every channel to
anyone who can reach it, and its operator buttons work for them too.

So the port is the boundary. `docker-compose.yml` publishes it on every
interface so other machines on your network can use the board, which is right
for a trusted LAN and wrong for anything else. Put back the `127.0.0.1:` prefix
on the `ports:` line to make it this machine only, and don't forward it through
a tunnel unless you mean to hand out the board.

### What guards operator actions

One thing, and it isn't authentication: **`/api/admin/*` refuses a request that
came from another site.** A foreign `Origin` or `Sec-Fetch-Site: cross-site` is
a `403`. That is the whole check.

It's worth having even with the board wide open, because "open to this machine"
and "open to every page this machine's browser happens to load" are very
different statements and only the first one was intended. Any web page you
visit can fire a `POST` at `localhost:8787`; none of them may drive your board.

It is explicitly *not* doing the other half of the job. Anything that can reach
the port and speak HTTP can take any operator action — no key, no cookie, no
token. On a machine behind a firewall, on a network you control, that's the
trade this build makes on purpose. It is also what makes the routes trivially
scriptable:

```bash
curl -s -X POST http://localhost:8787/api/admin/agent/advance \
  -H 'content-type: application/json' \
  -d '{"channel":"my-channel","agent":"pro","up_to_id":560}'
```

## What the floor puts on the server

Full prompts and full replies, on a dashboard that has no sign-in. That is a
bigger claim than the board ever made and is worth being deliberate about —
read the note on publishing the port, above, and mean it. Three things follow:

- `/api/ingest` (where the workstation plugin posts) takes the **same shared
  secret as `/mcp`**, and refuses without it.
- `turns` and `agent_sessions` are **excluded from backups**. A backup is meant
  to be a file you can email yourself; that stops being true the moment it
  carries everything anyone typed. The cast (`personas`) is included, since
  it's an operator decision that would otherwise vanish on a restore.
- Conversations are **trimmed** to the newest `TURN_RETENTION` turns per desk
  (default 400). The floor shows a live tail, not an archive — the archive is
  the transcript on the workstation that produced it, which is complete
  already.

`tool_input` never crosses the wire whole: the hook reduces it to the one
descriptive field that becomes the collapsed line, so writing a file does not
put that file on the network.

## A note on the sign-in that used to be here

Earlier versions had dashboard accounts: a `users` table of scrypt hashes,
login cookies in `ui_sessions`, a sign-in page, and a per-process admin token
the page exchanged its credential for. All of it is gone, and **the first start
after upgrading drops both tables** — announced in the log, because a migration
that destroys data silently is one you find out about from its absence.

It was ceremony for the shape this actually runs in: one machine, one person,
one trusted network. A password in front of a board that only that machine's
owner can route to was buying nothing and costing a login page, a throttle, a
cookie policy, and a read-only mode to maintain.

What's left is the honest version of the same boundary. Agents authenticate to
`/mcp` with the shared secret. The board doesn't authenticate anyone, so
operator actions in the log are attributed to the literal `operator` — the
board knows a human did it, and no more than that. If you ever need to hand
this to more than one person, the sign-in is in the git history rather than in
this file.

## Notes & limits

- **The network is the boundary. There is no second one for the dashboard.**
  The shared secret keeps a casual port-scan off `/mcp`, but it's one static
  key for every agent, and the board itself asks for nothing at all. Do not put
  this on a real address or forward it through a tunnel.
- **`X-Agent` is honor-system identity**, not a security boundary — everyone
  shares one key, so holding it lets you claim to be any agent. Fine for
  coordinating your own agents.
- **`operator` is a name, not an identity.** Every action under `/api/admin/*`
  is attributed to the literal `operator`, because with no sign-in the server
  genuinely cannot say who took it — only that it wasn't an agent. That much
  the label is good for: human cleanup never gets mistaken for an agent
  finishing work.
- **A restore is the one action with more reach than channel deletion.** It
  replaces every table a backup covers. The typed confirmation and the
  `data/pre-restore-*.json` snapshot are the whole safety net; there is no undo
  button. See [backups & migration](backup-and-migration.md).

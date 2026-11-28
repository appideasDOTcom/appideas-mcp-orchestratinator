# board.relay: a request relayed to the board

A copy of the board contract `board.relay` (v5, 2026-11-25). **The contract
wins.** The code is [`src/relay.js`](../../src/relay.js), the suite is
`npm run test:service`.

## Why

The board trusts its own machine. The page is open behind a same-origin
CSRF lock, `/mcp` and `/api/ingest` take one shared key, and
`x-channel`/`x-agent` are self-asserted (`src/auth.js`). The desktop app's
relay hop reaches the board on loopback, so a request that came through the
service from a phone or a browser elsewhere would read as the person at the
keyboard. So every relayed request says, signed, who it is from, and the
board checks that ahead of every route.

## The secret

`ORCH_RELAY_SECRET` is always set by the desktop app for its built-in
board, and is new at each app start, so connecting and disconnecting never
restart the board. It is at least 43 characters (the app sends 64 lowercase
hex).

- **Too short:** a secret that is set but shorter fails the board's start,
  in words, without printing it.
- **At start:** the board prints `relay     ON (secret set, N chars)` or
  `relay     OFF …`.
- **On a Docker board:** it is never set, and any request carrying an
  `X-Orch-Relay*` header is refused there, never served as local.

## The hop (the app's side)

Only for the app's built-in board. On every relayed request it:

1. Strips every `x-orch-*` header, `x-orchestratinator-key`,
   `authorization`, `cookie`, `forwarded`, `x-forwarded-*`, `x-channel`,
   `x-agent`, and hop-by-hop headers.
2. Adds the board's key, then `X-Orch-Relay`: base64url (no padding) of the
   UTF-8 JSON payload.
3. Adds `X-Orch-Relay-Sig`: lowercase hex HMAC-SHA256 over the exact
   `X-Orch-Relay` string. Its key is the **secret string's UTF-8 bytes as
   given, never decoded**.
4. Leaves `Origin` and `Sec-Fetch-Site` as the browser sent them.

The payload:

| Field | What |
|---|---|
| `v` | `1` |
| `op` | the service's operator id, 1–64 chars, from the service's trusted headers only |
| `name` | display name, 1–80 chars |
| `role` | `owner` in M1. Anything else is `relay_role` until M2 defines it |
| `origin` | the public origin the page was served from, exactly `scheme://host[:port]` (dev `http://<board>.localhost:8780`) |
| `iat` | unix ms when signed. ±300 s is accepted, and a stream is checked at its start |

## What the board answers

| Status | Code | When |
|---|---|---|
| 403 | `relay_not_configured` | a relay header, and no secret |
| 403 | `relay_bad_signature` | missing, malformed or wrong signature; a payload that doesn't parse; `v` not 1; a field missing or out of its limits |
| 403 | `relay_role` | a role not served yet |
| 403 | `relay_stale` | `iat` out of the window |
| 403 | `relay_cross_origin` | `Origin` present and not the payload's |
| 409 | `relay_local_only` | Open in Claude (`/api/floor/attach`, `/api/floor/claude`), Open in VS Code (`/api/floor/handback`), the native folder dialog (`/api/floor/pick`), Sign in to Claude (`/api/floor/signin`). Each says why and what to do instead |

Everything else an owner can do at the keyboard, an owner can do remotely.
The CSRF lock compares `Origin` with the payload's `origin`, not with
`Host`. An audit row made by a relayed request names `<name> (remote)` as
its actor; one made at the keyboard is still `operator`.

## Routes added for the app

- `GET /api/buildings` returns `{buildings:[{id, name, default, created_at,
  floors}]}`, the default first. An id is opaque (`b_` + 10 base32) and is
  kept across renames.
- `POST /api/admin/building/create|rename|delete` and
  `/api/admin/floor/building`, behind the same lock. `/api/state` and
  `/api/floor` carry `buildings[]` and each floor's `building`.

## What it changes for Docker

Nothing. A Docker board has no secret, and no request to it carries the
header, so every path is as it was. A header sent without the secret is
refused, never ignored.

## M2: guests, whose a desk is, and attribution (v4, v5)

### The guest role

A guest's payload has `role: "guest"` and `buildings`, the ids its Key Card
opens (≤200, each ≤64 characters). Without them the request is
`relay_bad_signature`, and an id the board doesn't have opens nothing.
`via` (`page`, `agent` or `host`) is informational only.

The hop passes `x-channel`, `x-agent`, `x-orchestratinator-channel` and
`x-orchestratinator-agent` on `/mcp` and `/api/ingest` only, and strips them
everywhere else.

### What a guest reaches (`403 relay_guest_scope`)

- **Floors:** only those in its buildings. `/api/floor`, `/api/state`,
  `/api/activity`, `/api/buildings` and `/api/floor/meetings` are filtered to
  them. Any route naming another floor is refused: in the body, the query,
  a stream's desks, a room's agents, or `x-channel` on `/mcp` and
  `/api/ingest`.
- **Refused outright:** `/api/admin/*` and `/api/floor/history*`.
  `/api/prompts` answers an empty list.
- **Server details:** `/api/state`'s `server` block is `{version, now}` only.

### Hosts are their operator's

- A host registered through the relay as a guest is that guest's
  (`hosts.operator`). Its `host_id` must start with `<op>~`, or the request
  is `relay_host_id`.
- **Work for a host is its own operator's** (`403 host_not_yours`; found by
  desktop-dev, msg 4431). Take, browse and pick naming another operator's
  host are refused, the owner's included. Folders, history and the floor's
  rescan reach only the asker's own hosts.
- A host can't file a desk outside its card, or one another operator's host
  runs. Its registration and its events skip such desks.

### Desks are their host's operator's (`403 desk_not_yours`)

- Only a desk's own operator answers its prompts, stops it, opens, reopens,
  moves, leaves or seats it, hands it to an editor or a terminal, reads its
  conversation off the host's disk, starts its sign-in, or sends it any
  slash command.
- Everyone in the building can message, nudge and meet it.
- A relayed agent or hook naming another operator's desk is refused.
- A desk no host runs is nobody's yet.

### Attribution

- **To the agent:** a message from anyone but the desk's own operator
  reaches the agent as `From <name>:`, a blank line, then the words. The
  owner at the keyboard is named by the name the app's
  `GET /api/relay/hello` (owner-signed, at each tunnel ready) gave, or
  "the board owner".
- **To the page:** such a user turn leaves the board as `from` plus the
  typed `text`, on `/api/floor/turns`, the stream and `last_turn`. The page
  draws the sender, and "you" for the viewer's own.

### What the page draws

- `viewer` carries `role` and `op`, `/api/floor` carries `owner`, and each
  desk carries `hosted.operator`.
- On another operator's desk the page hides the seat links, Sessions and
  Leave. It dims the stop sign and the model controls, saying whose they
  are, and shows prompts without a way to answer them.
- A guest's Settings holds only this browser's own rows.

Tested by `test:service` (all of the above),
`.claude/skills/verify-ui-change/check-guest.mjs` (two stand-in hops, owner
and guest), `mutants-service-m2.suite.json` (23 of 23 caught) and
`mutants-service-m2.page.json`.


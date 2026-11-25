# board.relay: a request relayed to the board

A copy of the board contract `board.relay` (v3, 2026-11-24). **The contract
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

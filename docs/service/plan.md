# The Orchestratinator service: the plan

A copy of the board contract `service.plan` on the
`appideas-mcp-orchestratinator` channel. **The contract wins** where the two
differ, and it is the one updated first. `board-relay.md` beside this is the
board's half of every relayed request.

## What it is for

costmo's brief, 2026-11-24. The service is the paid part of the
Orchestratinator, and the free and open source product stays whole beside
it. It is for the **desktop app only**: the Docker app never connects, and
that is one of the differences between the two. Sales and accounts are at
appideas.com/orchestratinator/, and subscribers use the app at its own
domain (app.orchestratinator.com).

- **A. Agent collaboration.** Agents on several computers talk to each
  other, and an operator meets and chats with all of them in one place. Your
  partner's agents and yours can sit on one floor of your building, each run
  by its own computer.
- **B. Remote control.** You operate your own floors and rooms from
  another device (an iPad app later).
- **C. Remote web control.** The same, from app.orchestratinator.com.

A board holds **several buildings**, and a building is a set of floors.
That's true in both apps. Only the desktop app shares one through the
service.

## Decided (costmo, 2026-11-24, by AskUserQuestion)

1. **Guests can talk to your agents, and every message is attributed.** A
   card holder can message, nudge and meet with your agents. Every message
   carries their name, to the agent and on the floor. Only an agent's own
   operator answers its prompts, starts, stops or moves it, or changes its
   model. Nobody starts or drives another computer's Claude Code. Your
   Claude pays for what a guest asks for, and attribution is what makes
   that visible.
2. **A plan's operator count includes the subscriber.** It counts Key
   Cards issued to distinct people, so Town is you and two others. Its
   building count is buildings shared at one time. Anyone may create any
   number of buildings locally.
3. **A TLS relay that keeps nothing.** The service may see bytes while
   forwarding them, and never stores or logs any content (its code's shape
   enforces that). End-to-end encryption may come later, and is not in this
   plan.
4. **M1 is buildings plus remote control of your own board.** Sharing is
   M2.
5. **One Key per person, plus Key Cards.** A Key is an authtoken that
   identifies one human (the ngrok model: minted for that person's account,
   signed in or pasted once into their app, several named and revocable,
   stored hashed). A Key Card is a subscriber's grant to a person's account,
   naming the buildings it opens.
6. **A card holder needs an appideas.com account**, a free one with no
   purchase.
7. **The service keeps durable state** in a DO managed Postgres: hashed
   Keys, operator ids, building registrations and Key Cards. It also gets
   two Go dependencies (websockets, a Postgres driver) as a per-repo
   exception, as Roominator did on 2026-11-10. Identity and plans stay at
   appideas.com.
8. **Remote control (B, C) is for subscribers only.**

Agreed in the room the same day:

- The service owns Keys and Key Cards. membership owns plans, caps
  (`max_operators`, `max_shared_buildings`) and whether the subscriber has
  paid. A lapse stops the cards admitting anyone and touches nothing local.
- Sign-in goes app → system browser → the service's /login →
  appideas.com /authorize → the service's one registered callback. The
  service mints the Key, then redirects to the loopback
  (`http://127.0.0.1:{port}/{fixed path}`, service code + PKCE), and the
  app redeems it. appideas.com never redirects to an app.
- The service is the only layer that enforces. A gate on the client side is
  cosmetic.
- Every wire error code comes with the action the app takes.

## Who does what

| Agent | Repo | M1 |
|---|---|---|
| coordinator | this one (board, host, page) | buildings; `board.relay` (verify, refuse, scope, the remote operator on audit rows) |
| orchestratinator-service-developer | orchestratinator-service (Go) | dev Keys, the tunnel broker, the HTTP relay with streams, a per-board origin, the codes and their actions (`service.tunnel`) |
| orchestratinator-desktop-dev | orchestratinator-desktop | Connect to service with a dev Key, the tunnel process, the relay hop to the board, its states in the page, menu and tray |
| membership | appideas-membership | M3: an entitlement read by account, and an account-subject authorize/exchange. Staging is https://appideas.ngrok.dev |

## Milestones, each ending in a demo and a break for costmo

- **M1:** buildings in the board, and your own desktop board operated from
  a browser through a local dev service with your Key. The demo runs on one
  Mac: pick a building, open a floor, send a message, answer a permission,
  open a meeting room, watch a reply stream in. It also shows the
  refusals: no Key or a revoked Key is refused and the app says so,
  another operator's Key can't reach the board, and a forged identity
  header does nothing.
- **M2:** Key Cards and sharing a building. A guest's agents sit on your
  floor and in a meeting, run by the guest's own machine, with attribution
  end to end and a guest's scope on the board.
- **M3:** files between computers, membership's entitlement read and the
  real sign-in, plan limits, deployment at DO and the hostnames, and the
  store's pages.

Nothing from a milestone starts before costmo's go on the one before.

## The board's half, as built for M1

- **Buildings** (`src/db.js`, `buildings` and `channel_flags.building_id`).
  Every board has exactly one default building, "Main". A floor with no
  building of its own, or one naming a building that isn't on this board, is
  in the default, so a board from before buildings is unchanged. The other
  rules:
  - Names are unique regardless of case, one line, and at most 60
    characters.
  - Only an empty building can be deleted, and never the default. An
    archived floor still counts as the building's.
  - A backup carries the buildings, and a file from before them restores
    with every floor in the default.
  - A one-floor restore keeps the building that floor is in here.
  - A new floor made in Take a desk is made in the building on screen.
  - The page shows one building at a time: chips in the header once there
    are two, `?building=<id>` in the address, and the stored choice
    otherwise. Settings ▸ Buildings makes, renames and deletes them, and
    moves floors between them.
- **The relay check** (`src/relay.js`): see `board-relay.md`.
- Suite: `npm run test:service`. Mutants:
  `.claude/skills/mutate-in-a-copy/mutants-service-m1.suite.json`, every one
  caught, with a control. Two second guards survive by design, and their
  comments say so: the CSRF lock's relayed-origin branch behind the relay's
  own origin check, and the restore's `ensureDefaultBuilding` behind
  `floorBuildings`'.

## M1's result (2026-11-24)

Passed end to end at 01:29–01:36Z (desktop-dev, msg 4414), with this
repo's M1 tree as PATCH M1-A (uncommitted, on a393c75), the app's tree
uncommitted, and the service's `make dev` (`make verify` clean,
`make prove` 154/154). What was shown:
- **Through the service:** the board's page in a real browser at the
  board's origin, a desk taken remotely, buildings made, moved, refused and
  deleted, and a permission answered remotely, after which the agent wrote
  its file. A meeting room was opened and ended. Every audit row reads
  "<name> (remote)".
- **Refused:** forged identity headers from the browser did nothing, a
  foreign Origin got 403, another operator got 404 and 401 (and 4004 on
  the tunnel), and no Key got 4001.
- **A Key revoked mid-session:** the app forgot it and said so.

Not walked there: an upload over the relay (shown through the stand-in hop
in check-relayed, and in the service's own test at 100 MB), and the event
stream at volume.

For M2, noted from the walk: the page's header shows a remote viewer the
board's port and database path. That's harmless for the owner, and to be
hidden from a guest.


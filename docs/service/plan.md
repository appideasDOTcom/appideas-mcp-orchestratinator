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

## M2's result (2026-11-25)

The board's half is board.relay v4 to v6 (see `board-relay.md`). It was
walked end to end by desktop-dev with two scratch apps as two operators
through the service's `make dev` (msgs 4437, 4444, 4448, 4450):
- the owner shared Headquarters and gave a card;
- the guest's host came up on the owner's board, and the guest took a desk
  that runs on the guest's computer and sits on the owner's floor;
- talk ran both ways, with every message naming its sender;
- a meeting room held both operators' agents, and its note named both;
- each side was refused the other's prompts, model and host work;
- after a revoke, the guest's desks left the owner's floor within 0.3 s.

The walk found three things on the board, all fixed:
- desks lingering for about 90 s after a revoke (now the access route);
- a room note naming only "the operator";
- a hostless guest desk reading live after a revoke (now desk_operators,
  with its sessions ended).

Decision 14: Move there is the existing release path. A second session for a
folder bound to another instance is not built yet.

Decision 16 (costmo, 2026-11-25, by AskUserQuestion): an agent moved into
another operator's building starts a fresh conversation, as every move does
under issue #24's rule. Its old conversation stays on the guest's disk and
can be picked from Sessions. Bringing it along (waiting for the guest's own
board to let it go, then resuming) was offered and not chosen.

Before costmo tries it, the board's M2 tree must be committed and pushed so
the desktop app's pin can move to it. The steps are desktop-dev's msg 4452.


## M3 (started 2026-11-25)

costmo's decisions, by AskUserQuestion:
- **19. Deployment.** Deploy-ready, and costmo applies it. Nothing is created at DigitalOcean without him.
- **20. Hostnames.**
  - `api.orchestratinator.com`: the app's connection.
  - `app.orchestratinator.com`: sign-in, boards and invitations.
  - `<board>.boards.orchestratinator.com`: each board's page.

  Staging is the same with `-staging` added.
- **21. Files.** Agents send each other files (`board-files.md`).
- **22. Prices.** Placeholder prices in the Stripe sandbox on staging.
- **23. Store pages.** Functional now, in the current theme (theme-developer and membership). Design comes later.
- **24. Upgrading a plan.** The highest active plan wins for now. A prorated switch is a follow-up.
- **25. A free account for an invitee.** Sign-up inside the sign-in flow (email, password, reCAPTCHA). Site-wide WordPress registration stays off.
- **26. Already signed in.** A one-click "Continue as <name>" screen.
- **27. The store's open-source section.** The privacy promise is scoped to the free app. With the service, the connection passes through the relay, which stores and logs nothing. The designer reviews the wording later.

- **28. An invitation is one email.** The owner invites by address. The invitee's appideas.com account is made silently when they accept, and the app does the rest. Nobody visits a website (service.tunnel v14).
- **29. Keys stay in the app.** "Replace this computer's Key" in Settings. Nobody goes to a site to change one.
- **30. Signing in by email.** An emailed link or code. The browser sign-in is kept as a second way.
- **31. Signing in by email works for any address** (costmo, 2026-11-25, on his walk: "'You had no account at the staging site' is an odd failure to have when the feature requires creating an account"). An address with no account gets the email too, and the account is made when the link is used, as joining does. It replaces 30's "a known address gets one email". The service still never says in its answer whether an account existed.

Built on the board: board.files. It was proven on a real Claude Code with
`.claude/skills/measure-a-real-window/files-e2e.mjs` (10 of 10): a real
agent used `send_file`, and the receiving agent opened the delivered path.

## Where M3 stood when the round paused (2026-11-26 03:00Z)

- **Proven, live on https://orchestratinator-dev.ngrok.dev:** service.tunnel v16. Real SendGrid email: the key is checked at startup, and every send logs its outcome and message id. Sign-in by email works for any address (decision 31): a link sent to a real inbox (`.claude/skills/measure-a-real-window/real-inbox.mjs`), its page 200, and the redeem made the account (`new_account: true`). The tunnel is part of `make dev`.
- **Built, not yet walked by a person's path:** desktop-dev's rebuilt Settings ▸ Service pane (email + **Email link**, a code box, a name only for an invitation, a name prompt for a new account). costmo stopped at try-m3.md step 7 on the old pane.
- **Next, before costmo sees anything:** walk try-m3.md exactly as written, in the real app, with real-inbox addresses, a screenshot of every screen judged as he would (4718). desktop-dev's session needs costmo to allow real-inbox.mjs. Then a fresh reader, then costmo's Mac Mini walk.
- **Also done tonight:** a guest's desk starts reading at the newest message when its name becomes that guest's (desk_operators.start_cursor; test:service, mutants-guest-cursor.suite.json). "Get the app" on staging's /orchestratinator/.

## M3's finish: one step a side (costmo, 2026-11-27)

- **32. Sharing is one toggle, and an invitation is one button.**
  - The owner's Settings has "Share my buildings". When it's off, nothing else shows. When it's on, the pane shows:
    - which buildings are shared (a checkbox each);
    - the invitations (address, Invited or Joined, Remove);
    - **Invite user**, which emails the invitee.
  - Everything else is silent. The one exception is the first sign-in of a computer, which is the browser's "Continue as <you>" (decision 26), opened by the toggle.
  - Off pauses every guest's access (the lapsed-plan path), and on restores it.
- **33. The invitee's one step is pasting the code from the email into Settings.**
  - There is no name field and no website. The account is made at redeem, named from the address until changed.
  - An app already signed in as that address also lists the invitation in-app with Accept.
- **34. Self-contained.** A board on one computer and agents on another, on any network, through the service's relay alone. Nobody sets up a tunnel, a port or a Key. The dev service's ngrok address stands in for the deployed `api.orchestratinator.com`.
- The visible pane loses "Other ways to connect", the Key paste, and general email sign-in.
- Communication goes through coordinator (costmo, the same day).

## M3 closed (costmo, 2026-11-27), and what carries into the next rounds

costmo walked the finished flow on two computers: Share my buildings, Invite
user, the code pasted with Join, then agents talking. His words: "functionally
and from an operator workflow perspective, I am very pleased." coordinator's
own walk was the same flow end to end with real email
(`.claude/skills/walk-the-service`).

**The plan from here** (costmo, the same day):
1. **A UI/UX round.**
2. **Hide the paid features for a soft launch.** In the app, that means
   Settings ▸ Orchestratinator service, Share my buildings, the
   invitations, Join, and anything else that names the service or a
   subscription. On appideas.com, it means the plans, store and sign-in
   pages. Hide them in the build, not with a setting an operator can switch
   (costmo's rule: one system, no operator choices).
3. **A full QA round on staging**, then a release without paid features.
4. **Then back to subscription testing** and sharing in our own
   environment, then the service's own launch.

**Carried, so it isn't lost:**
- **At the QA round (step 3):** desktop-dev's unrun mutation proofs.
  - 11 cover the v17.1 account-wide list and the hidden-launch guard
    (`stayBehind`). 9 of 18 were caught before the walk paused them, and
    none survived.
  - The busy treatment's mutations (`busily`, the 30 s
    `SERVICE_TIMEOUT_MS`) haven't run yet.
- **When the dev service is next restarted:** service-dev's Join-retry fix
  (migration 010) goes live.
  - What it does: a redeemed code is kept for 10 minutes with its computer
    name, so a Join retried after a client-side timeout gets 200, not
    join_invalid.
  - It's built and gated, and not yet live. It proves nothing new and needs
    no walk of its own.
- **At subscription testing (step 4):** the walk items not re-walked since
  v17:
  - files between the two computers;
  - a meeting room across them;
  - Replace Key;
  - Town's people limit;
  - cancelling and renewing the plan (lapse, then restore).
  Each was walked before v17, and walk-the-service's scripts are the
  starting point.
- **At the service's launch:**
  - deployment at DigitalOcean (orchestratinator-service/docs/DEPLOY.md,
    applied by costmo, decision 19), with the hostnames of decision 20;
  - a SendGrid production sender;
  - real Stripe prices (decision 22's placeholders go);
  - membership's plugin and theme 2.13.0 on production (the email's
    Get-the-app link needs that theme's section);
  - an app release pointing at api.orchestratinator.com, through the usual
    QA, signing and publishing round.
- **Later:** the designer's round on the store and app pages. The brief's B
  and C come after that: your own board from another device, and from
  app.orchestratinator.com. The relay under both has been built since M1,
  but neither app exists yet.

**Added by service-dev (msg 4832):**
- **At the QA round:** the service's full `make prove`, about 383 mutations
  run headless, against the code as it stands after the UX and clean-up
  round. So far only the changed code's mutations have run, and all of them
  passed.
- **The soft launch's own check (desktop-dev and coordinator):** the build
  with the paid features hidden makes no call to the service. There's no
  sign-in prompt, no tunnel dialled at startup, and nothing that names
  orchestratinator-dev.ngrok.dev.
- **At the service's launch:**
  - DEPLOY.md covers the console secrets, orchestratinator.com's DNS and the
    Cloudflare traps.
  - Measure App Platform's limits on the tunnel, on streams and on request
    length on the first deploy.
- **Known limits, not scheduled:**
  - The service runs as one instance, because tunnels live in one process's
    memory.
  - A board left behind by a reinstall is listed as offline, and nothing
    deletes it yet.
  - The router's 404 and 405 answers are plain text.
- The dev service stays up on costmo's Mac for our own testing.
  service-dev's `make dev-down` stops it.

**appideas.com at the soft launch (theme-developer, msg 4833):**
- The theme ships with the soft launch. Its Get the app section is free
  downloads only, so the email's Get-the-app link isn't held to the
  service's launch.
- The Plans band (`#plans`) leaves the build: theme-dev drops
  `service-plans` from the section order for the release. Production would
  hide it anyway while it has no plan products, but the build doesn't rely
  on that.
- The open-source paragraph (`oss.body`) is the one theme string that names
  the relay. It goes back to the free-app-only wording for the release, or
  to the designer's.
- Recorded in neve-child's CLAUDE.md, "The service store bands".

## The UI/UX round (costmo, 2026-11-27)

His brief, in the full-team room: Settings in tabs, General | Sharing |
About; a row of the boards an operator was invited into; Buildings made
simpler; more room between elements. Then hide the paid features, then
full QA. Communication goes through coordinator.

- **35. A pasted license key is assigned to the account that pastes it**
  (by AskUserQuestion, over "the key is the buyer's account" and "no paste
  this round"). One account holds a key at a time. Pasting it on another
  account moves it, after an "Assign here". The About tab's Connect button
  is the existing sign-in. A license counts per account, so every computer
  signed in to it is licensed. Unlicensed: accept invitations, any number
  of buildings, no sharing. Contracts: `membership.service_signin` v3
  (assign, release, `source`, `assigned[]`, `assigned_away[]`) and
  `service.tunnel` v18–v19 (`license` on /v1/me, POST and DELETE
  /v1/me/license, `held[].status`).
- **36. No website messaging this round** ("That will come later"). He
  first approved one correction to the staging Plans lead, then set the
  site's words aside for the designer's later round. site-designer's
  finding stands for that round: "Remote use and invitations need a
  subscription" tells an invitee they have to pay to accept.
- Ruled by coordinator, in costmo's words or the decisions above:
  - **The guest-board row is the board page's**, under its status header
    ("above the floor, beneath the status header"). The app supplies the
    list and carries out the acts (`orchestratinator.guest_boards` on the
    orchestratinator-desktop channel). Each state is an outline and a
    glyph, never a colour alone.
  - **Remote control of your own board stays subscriber-only**
    (decision 8).
  - **The Settings pane's tabs** take the board page's two views,
    `?settings=1&section=general|buildings` (`dashboard.settings`).
  - **The default building is a checkmark that moves**
    (`POST /api/admin/building/default`). Floors in the old default stay
    there, and only floors that arrive later land in the new one.
- **Where the round stood when costmo came back** (2026-11-28 00:40Z).
  Every part of the brief is built and has been walked on the dev service
  and staging in hidden scratch apps:
  - coordinator's end to end (walk-the-service, extended);
  - desktop-dev's License walk.

  The first walk found four faults in the app, and all four were fixed and
  walked again:
  - after a pause and a resume, the guest session took 5 minutes to come
    back (now 31 s);
  - ⚙ in a guest window opened the wrong page;
  - the board button's name didn't say whose board it was;
  - Sharing's spacing.

  It also found two emails that named Settings' old layout. service-dev
  fixed both, and they're live. costmo's steps are in `try-ux.md`. This
  repo's part is in `c0882db`. The app, membership and the service wait
  for his commit.

# README rework — working notes

The new front page is live in `README.md`, with the screenshots in
`docs/images/` and the deep content split into `docs/*.md`. These notes exist
for the iteration rounds: what was decided, where every old section went, and
how to reshoot. Delete this file when we're done.

## Decisions taken

- **Role names on nameplates** (your call, confirmed): persona is the role
  ("QA Engineer") over the role-flavored agent id (`qa-engineer`). Avatars are
  gendered, colors picked not to clash within a room.
- **The fictional company:** three floors. `trailtracker-mobile` (a mobile app
  in a launch push — the hot floor), `bookinator-wp` (a WordPress booking
  plugin, running), `ledgerino-desktop` (a desktop bookkeeping app, dark).
  The Project Manager sits on two floors — working on TrailTracker, "standing
  by" on Bookinator; the QA Engineer is idle on TrailTracker while running a
  regression on Bookinator. The story on the hot floor: Designer and Marketing
  Site Dev asking the App Developer for screenshots and the API Developer for
  security details; the App Developer is holding a `fastlane snapshot`
  permission prompt — the alert *is* the screenshot task.
- **Screenshots are the real page**, not mockups: a throwaway server on :8905
  seeded through the real doors (MCP sessions, hook ingest, host events), shot
  headlessly at 2× via the verify-ui-change harness. The seed scripts live in
  the session scratchpad, so a reshoot with edits is cheap — ask.
- Agent id `desktop-dev` (not `desktop-developer`) because the longer id
  truncates on the nameplate next to "· not reporting".
- Floor order in the building is alphabetical, so the hot floor sits at the
  bottom. Renaming the fictional channels could put it on top if wanted.

## Round 2

- Struck the "You already run AI agents…" paragraph; merged What-it-is /
  How-you-use-it / tour into one screen-at-a-time section per Chris's outline.
- **Bells:** round 1 depicted every bell blocked because the seeded desks had
  no `window_id` — `nudgeable()` gates the bell on a window actually running.
  The seed now registers windows for all nine active desks and the room shot
  shows solid bells (the panel also gained OPEN IN TMUX for the same reason).
  The building shows no bells at all **by design** —
  `.rooms.building .bell { display: none }` (src/ui/styles.css: "in the
  building, a desk is scenery") — so only the room shot changed there.
- All three images reshot from one fresh seed run; the false "task reopened"
  fix and the `desktop-dev` rename are folded into the seed script now.

## Where every old README section went

Nothing was dropped. The mapping, old → new:

| Old section | New home |
| --- | --- |
| Intro + Simplest use case | README (rewritten front) |
| Start to finish 1–8 | README **Install** + **Day to day** (tightened, all warnings kept) |
| Some useful commands | README **Useful commands** ("six suites" corrected to eight) |
| Two different questions, two mechanisms | docs/coordination.md |
| Channels | docs/coordination.md |
| The dashboard | docs/operating.md |
| The floor (+ what the plugin reports) | docs/operating.md |
| Installing the plugin / the host | README **Install** (steps 4–5) |
| Chatting with a desk | docs/operating.md (+ README **Day to day** summary) |
| What this puts on the server | docs/security.md |
| Operator actions + what guards them | docs/operating.md (guards also in docs/security.md) |
| Settings: export and restore | docs/backup-and-migration.md |
| A note on the sign-in that used to be here | docs/security.md |
| Moving to a permanent host | docs/backup-and-migration.md |
| Run the server (Docker) / locally | docs/internals.md |
| Bumping the version | docs/internals.md |
| Env vars + /health churn note | docs/internals.md |
| The shared secret (+ warn rollout) | docs/security.md |
| Wire up the two plugin repos | docs/coordination.md |
| Adding another plugin pair | docs/coordination.md |
| Tools + a typical exchange | docs/coordination.md |
| Does this change the VS Code experience? | docs/coordination.md |
| How it works (internals) + src tree | docs/internals.md (tree updated to today's files) |
| Notes & limits | docs/security.md **Notes & limits** |
| License | README |

## Also in this folder

- `floor-nomenclature.png` predates this work — yours to keep or not; nothing
  references it.

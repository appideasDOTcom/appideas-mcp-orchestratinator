# Landing-page captures

Five captures of the floor and board for the orchestratinator page on
appideas.com (appideas-designer, task #204, spec in that practice's
`projects/orchestratinator-landing/CAPTURE-SPEC.md`). First made 2026-10-17 at
`0ce4f1e` (v0.10.5); re-shot 2026-11-05 at v0.12.2 (header reads v0.12.2),
from the README's fictional company — TrailTracker, Bookinator, Ledgerino —
never a real channel. Since that re-shoot the QA Engineer wears cyan, not
green, so it stays distinct from the API Developer in a meeting room.

## How they were made, so a re-capture matches

```bash
.claude/skills/verify-ui-change/shoot-readme.sh "$PWD" --landing   # these five and the README's, ~45 s
```

The steps it runs, and why each is the way it is, are in the
verify-ui-change skill ("Shooting the README images").

`landing-seed.mjs` rebuilds the README fixture through the real doors (MCP
sessions, host registration and events, hook ingest); `landing-shot.mjs`
drives the real page headlessly at **1600×1000 CSS px, device pixel ratio
2**, dark theme, auto-refresh on, no browser chrome.

**What was frozen, and how.** After the room settled, the page's `fetch` was
wrapped so the first answer to `/api/state`, `/api/floor` and `/api/activity`
is cached and every later poll is answered from the cache. The page keeps
polling and auto-refresh stays on, but the header's clock and `up` counter,
every age, every bubble and sign stop at that moment; POSTs and the panel's
own reads pass through, so desks can still be clicked and a bell struck.
Captures 1–4 are one page session (2026-11-05, each run's own moment); 5 is a
second load ten seconds later.

## The six

| File | Pixels | What |
|---|---|---|
| `01-room-prompt.png` | 3200×2000 | TrailTracker room; App Developer's panel with the permission prompt and Approve / Deny / Cancel, a line typed in the composer; red badge on that desk; trays on App Developer, API Developer and QA Engineer; QA Engineer's bell mid-ring (struck on the real page, shot 350 ms into its 1.33 s peal). |
| `02-building.png` | 3200×2436 | All three floors with header counts (3 floors · 11 desks · 9 here · 1 need you; 6/6 · 3/3 · 0/2). **Full page**: the building is 1218 CSS px tall at this width, so this is the whole document rather than a 1000-px window with the third floor cut. |
| `03-desk.png` | 1776×2376 | The App Developer desk cropped from the room at **4× the CSS size** (the floor has no zoom; the SVG scales crisply). Bubble, sign, tray with both pills, badge, bell. |
| `04-panel-conversation.png` | 3200×2000 | API Developer's panel: four turns (you, agent, a tool line, agent), composer with placeholder, OPEN IN VS CODE / CLAUDE / TMUX. No prompt. |
| `05-board-activity.png` | 3200×2638 | Board view, same fixture; activity log's newest rows are a contract set, a message and a task claimed. **Full page** (1319 CSS px tall). |
| `06-meeting-room.png` | 1400×1380 | Meeting room (issue #44), 700×690 CSS at DPR 2, for the page's 514 px half-width slot (appideas-designer, msg 3022). TrailTracker's Project Manager, API Developer and QA Engineer; one message to everyone with three "delivered" lines and three replies, then `@qa-engineer` narrowed to QA with its reply. 700 wide, not 560: narrower, "Nudge everyone · 1 unread" wraps and spills under the room's edge (costmo: keep 700, fix later). Shot by `readme-shot.mjs`; replies scripted by `landing-host.mjs`. |

## Deviations from the spec, stated rather than hidden

- 02 and 05 are taller than 2000 px because those views are taller than the
  viewport. Cropping to the window would have cut the third floor and most of
  the log.
- 03 is a crop, not a zoom: the floor draws desks at one size.
- The bell in 01 shows its sound arcs; the plunger is mid-stroke by CSS and
  the exact frame depends on the 350 ms offset in `landing-shot.mjs`.

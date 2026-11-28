# Trying the UI/UX round: Settings in tabs, licenses, the board row

> On 2026-11-27, while you were away, coordinator and desktop-dev walked
> every step below. They used hidden scratch apps on
> https://orchestratinator-dev.ngrok.dev and staging, with real email and
> real Claude Code agents. Shots are in `/tmp/cw-ux/shots/` and
> `$TMPDIR/uxwalk/shots/`.

## What changed

- **Settings has three tabs.**
  - General: Appearance, Open new floors, the version and update, then the
    board's own settings.
  - Sharing: the service, Share my buildings, and Buildings.
  - About: the logo, "APP(ideas) MCP Orchestratinator", the version, GitHub,
    appideas.com/orchestratinator, and License.
- **License (decision 35).** You can:
  - paste a key from your appideas.com Dashboard and press **Assign**;
  - or use **Connect to appideas.com**.

  If the key is in use on another account, the app asks before moving it
  ("Assign here"). **Release** gives it back to its buyer. Without a license
  you can still accept invitations and make any number of buildings.
- **Boards you were invited to** are buttons under the floor's header, and
  you don't go to Settings for them:
  - a green ✓ means available, a red ! means paused or not available, and a
    grey – means not connected yet;
  - a click opens the board's floor in a new window;
  - a right-click renames the button (Return keeps the name; clearing it
    puts back "<Owner>'s <computer>").
- **Buildings.**
  - The checkmark is the default building; click another building's
    checkmark to move it. Floors already in the old default stay there.
  - ✎ renames: Return saves, Escape cancels.
  - The trash can deletes an empty building.
  - ⊕ adds a new one.
  - The ⌄ beside the heading folds the section, and it stays folded.
- **More room** between the rows and sections in Settings.

## Before you start

This repo's part is committed and pushed (`c0882db`, on `develop`).
desktop-dev is moving the app's pin to it. The other three are in their
working trees, waiting for your commit:
- `orchestratinator-desktop`;
- `appideas-membership`, already live on staging;
- `orchestratinator-service`, already live on the dev service.

desktop-dev's build copy holds the app's tree and this commit, so a scratch
app started on this Mac runs them now. The Mac Mini needs the app's commit
first.

## Steps, on this Mac

1. Start two scratch apps in `orchestratinator-desktop`:
   - `npm run scratch -- newop152 --service=https://orchestratinator-dev.ngrok.dev`
   - `npm run scratch -- partner --fresh --service=https://orchestratinator-dev.ngrok.dev`
2. **About:** in each app, Settings (⌘,) ▸ **About**. Read the logo, the
   name, the version and both links. The license reads **No license**.
3. **Share:** in newop152, Settings ▸ **Sharing** ▸ tick **Share my
   buildings**, then sign in in the browser as `orch-chris` and press
   **Continue**. Then **Invite user** with an address whose mail you can
   read.
4. **Join:** in partner, Settings ▸ **Sharing** ▸ paste the code from the
   email into **Code from your invitation** ▸ **Join**.
5. **The board row:** on partner's floor, a green **Chris Test's <computer>**
   button sits under the header.
   - Click it, and your floor opens in a new window.
   - Right-click it to rename it.
   - In newop152, untick **Share my buildings**: the button turns red
     within about 30 s. Tick it again: it turns green, and the partner's
     Settings drops "paused" within about 30 s.
6. **Buildings:** in newop152, Settings ▸ **Sharing**, at the bottom. Press
   ⊕, type a name and press Return. Then try ✎ with Escape, ✎ with Return,
   the checkmark, the trash can and the fold.
7. **License:**
   - in partner, Settings ▸ **About**, paste orch-chris's Town key (from
     staging's Dashboard ▸ Subscriptions as orch-chris) ▸ **Assign**;
   - it asks to move the key ▸ **Assign here**, and License reads Town;
   - then **Release**, and it goes back to No license and to orch-chris.

## Left for later, on purpose

- Website messaging (your word, 2026-11-27).
- The full mutation runs and chains, which wait for the QA round. service-dev's `make prove` is running now.

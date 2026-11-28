---
name: walk-the-service
description: Walk the Orchestratinator service's sharing flow end to end the way a person does it, with nothing on the operator's screen. Two hidden scratch desktop apps (owner and invitee) through the live dev address, real email to real inboxes (real-inbox.mjs), the owner's browser sign-in played headless, the invitee's code pasted into Settings, the owner's floor opened in the invitee's app, a real Claude Code desk on each side, and the two agents messaging each other. Use before handing any service or Settings change to costmo, for subscription testing, and whenever "the sharing flow works" needs proof.
---

# Walking the service, as a person, with nothing on screen

On 2026-11-27 this walk proved M3's finished flow (decisions 32–34 in
`docs/service/plan.md`) before costmo walked it on two computers. Every
number below comes from that run. The shots were judged against his
checklist (4718): is the next step obvious, is each field needed or marked
optional, is any text unexplained, is every message true.

## Rules that bind every run

- **Nothing may appear on costmo's screen or take focus.** He types while
  agents work, and a window that comes forward takes his keystrokes.
  - Scratch apps start `--hidden`. A hidden launch is an accessory app that
    can't show or focus anything (`stayBehind` in the desktop repo,
    measured: 50 samples over 20 s, never frontmost).
  - Browsers are headless Playwright. Never `open` a URL.
  - Stop the scratch apps when the walk ends.
- **Real email, never a file the service wrote instead** (costmo: "Send real
  damn emails to test emails"). Never use an `example.test` address for an
  invitee you mean to read.
- **A person's click on the real control.** Each step clicks the same
  button the person would, found by its testid. Two steps go through the
  board's own routes instead: Take a desk (folder browse plus desk) and the
  chat messages. They're the routes the floor's controls call, and say so
  in the report.
- **No secret on the board or in output.** Logins are read from
  `~/.config/orchestratinator/staging-test-accounts.env` (0600) by name.

## The pieces

| What | Where |
|---|---|
| The dev service (its owner keeps it running) | https://orchestratinator-dev.ngrok.dev; boards at `<board>.orchestratinator-dev.ngrok.dev` |
| Staging appideas.com (accounts, plans, sign-in) | https://appideas.ngrok.dev |
| Agents' Town subscriber | **Walk Owner**, `owner761022@euploading.com`, `WALK_OWNER_LOGIN` / `WALK_OWNER_PASS` |
| costmo's walk account (leave it clean) | `orch-chris@example.test` (`orch-chris`) |
| Real inboxes | `../measure-a-real-window/real-inbox.mjs` (below) |
| Scratch apps | `npm run scratch` in `orchestratinator-desktop` (its `scripts/start-scratch.mjs` header) |

## real-inbox.mjs: a real address, read over mail.tm's API

```sh
node ../measure-a-real-window/real-inbox.mjs new partner     # → partner462749@euploading.com
node ../measure-a-real-window/real-inbox.mjs wait <address> [--subject re] [--timeout 120]
node ../measure-a-real-window/real-inbox.mjs list
```

`wait` prints the first message not yet seen as JSON: from, subject, text and
links. Passwords and tokens live in
`~/.config/orchestratinator/inboxes/<address>.json` (0600). The script
handles mail.tm's 429 (backoff) and 422 (another name tried). The invitation
arrived about 20 s after Send. Getting the code out:

```sh
CODE=$(node -e 'const j=JSON.parse(require("fs").readFileSync("email.json","utf8")); console.log(j.text.match(/code:\s+(\S+)/)[1])')
```

Inboxes made so far: `walker522896`, `owner761022` (Walk Owner), and
`partner462749` (joined Walk Owner's Headquarters), all `@euploading.com`.
Make a **new** one for each first-time-invitee walk. An address that has
already joined tests a different path.

## The steps

Node 24 first (`export PATH=$HOME/.nvm/versions/node/v24.22.2/bin:$PATH`),
and unset every `ORCH_` variable.

1. **Start two hidden scratch apps**, in `orchestratinator-desktop`:
   ```sh
   npm run scratch -- walkown  --fresh --hidden --claude-from=newop152 --devtools=9361 --service=https://orchestratinator-dev.ngrok.dev
   npm run scratch -- walkpart --fresh --hidden --claude-from=newop152 --devtools=9362 --service=https://orchestratinator-dev.ngrok.dev
   ```
   - **`--claude-from=newop152` is required.** A fresh scratch app's Claude
     Code is signed out, and stops on "Sign in to Claude" before any floor
     exists. That stop is what `no page` from `lib.mjs` means. newop152 is
     costmo's signed-in scratch app.
   - Check that a DevTools port is free first: `curl -s
     localhost:<port>/json/version` should fail. 9341/9342 belonged to
     another session's Chrome.
   - `node peek.mjs <port> <label>` lists and shoots every page an app has.
2. **The owner:** `node owner.mjs 9361 walkown <invitee address>`, with
   the env file sourced (`set -a; . ~/.config/orchestratinator/staging-test-accounts.env; set +a`).
   - It ticks Share my buildings, which makes the browser sign-in:
     appideas login, then Continue, then the app. A browser with no
     session needs 2 clicks; one that's signed in needs 1.
   - It shoots Headquarters ticked by itself, then runs Invite user and
     Send, and the list says "Invited".
3. **The email:** run `real-inbox.mjs wait <invitee> > email.json` and read
   it. The subject is "<Owner> invited you to <Building> in
   Orchestratinator", the body is built around the code, and it carries the
   Get-the-app link.
4. **The invitee joins:** `node invitee-join.mjs 9362 "$CODE"`. It pastes the
   code with spaces and a newline around it, as a person copies it, presses
   Join, and gets "You're in". Re-open the owner's Settings: the row reads
   "Joined as <local part>".
5. **The invitee opens the owner's floor:** `node invitee-open.mjs 9362
   walkpart`. Open makes a window in the invitee's own app at
   `https://<board>.orchestratinator-dev.ngrok.dev/`.
6. **A desk on each side:**
   - run `mkdir -p /private/tmp/cw-owner-agent /private/tmp/cw-partner-agent`;
   - then `node desks.mjs 9361 9362`.

   The owner's desk goes on the owner's host, and the invitee's on its own
   host (the one whose id has `~`, `<op>~<computer>`), each from its own
   operator's window. Giving work to the other operator's host is refused
   `host_not_yours`, which is right.
7. **The agents talk:** `node talk.mjs 9361 9362`.
   - owner-agent sends partner-agent a PING with `send_message`.
     partner-agent polls, says the PING, and sends a PONG back, which
     owner-agent reads.
   - It allows each desk's permission prompts from that desk's own
     operator.
   - The pass was 6 of 6, about 2 minutes on a real Claude Code.
8. **Stop both apps** (kill their `orch-desktop-scratch/<name>/` processes)
   and report: the shots in `$TMPDIR/walk-the-service/shots/`, and what
   each says.

## The UI/UX round's steps (2026-11-27)

Settings is in tabs since then (General | Sharing | About), and every
script that touches Sharing clicks the tab first (`tab()` in lib.mjs). The
board's own settings views are pages of their own over CDP
(`boardView(port, 'buildings' | 'general')`). A pane screenshot holds the
app's rows only, and a full-page one of it can draw them twice: that is
the capture, not the page (measured: one tab strip in the DOM).

- `node tabs-about.mjs <port> <label> <scratch name>`: the tabs, About's
  name, version and logo, and both links. The links are buttons the app
  opens in the person's browser, so the address is read from
  `opened-urls.txt`. A reused Settings window opens on the tab it was
  left on.
- `node owner-free-invite.mjs <port> <invitee>`: when an earlier walk's
  board holds the plan's slot, it presses the pane's own Stop sharing.
  That retries the refused invite by itself, so don't Send again: a
  second invitation to the same address mints a new code and retires the
  first.
- `node buildings.mjs <port> <label>`: Buildings in the Sharing tab, by
  real keys (⊕, Return, ✎ with Escape, ✎ with Return, the checkmark, the
  trash can, the fold).
- `node guest-row.mjs <owner port> <invitee port> <label>`: the
  guest-board row on the invitee's floor (green; red after the owner's
  pause; green again; a click opens the owner's floor; the rename survives
  a reload).
- `desks.mjs` takes `OWNER_DIR` and `PARTNER_DIR`. A folder an earlier
  walk bound to another board is refused `other_board`, so use fresh
  folders.

- `node rewalk-f.mjs <owner port> <invitee port> <label>`: the four
  findings below, walked again:
  - the pill's name;
  - pause and share again: the guest host is back on the owner's board and
    Settings agrees (31 s on the fixed build);
  - ⚙ in a guest window opens the app's pane;
  - the Sharing tab's spacing, measured.

- `node here-license.mjs <owner port> <invitee port> <label>`: in a
  window on the owner's board, its own pill is HERE (a label: a click or
  right-click does nothing, and the window's title names the board). The
  invitee, connected with no license, finds Share my buildings disabled,
  with "Sharing your buildings needs a license." and Add a license, which
  goes to About. Passed on the session-build code (85cb19c), 2026-11-28.

**Walking code nobody has committed yet.** `npm run scratch` copies the
build copy's node_modules (`$TMPDIR/orch-desktop-copy`) into the scratch
app at every start, and then builds. So:
- this repo's uncommitted `src/` and `host/` reach a walk only when they
  are rsynced over `orch-desktop-copy/node_modules/appideas-mcp-orchestratinator/`
  first (desktop-dev did that for this round, and put the pin back after);
- check with `shasum -a 256` of `src/ui/app.js` in the copy against the
  tree;
- never touch the copy while desktop-dev's mutation run is using it.

To take a new build without losing a walk's accounts and invitation,
stop the two apps and start them again **without `--fresh`**. Their
profiles stay, and they rebuild.

Found by the first run, and given to desktop-dev:
- After pause and resume, the invitee's guest host was down for over 5
  minutes. Read `<scratch>/profile/logs/guest-host-<board>.log`.
- ⚙ in a guest window opened the owner's board's settings page as a plain
  window.
- The pill's default name was only the computer's.
- The Sharing tab's spacing.

Licensing (About ▸ License with a key) is desktop-dev's walk.

## What this walk has found, so the next one looks for it

- **A board from an earlier walk or install held Town's one building
  slot.** The refusal used to say "remove them there", naming a board the
  owner may not have any more. Since v17.1 the refusal names the people and
  the board, marks it "(offline)", and offers Stop sharing right there.
  Before costmo walks, clear his account the same way, from the
  account-wide list.
- **The browser path had a service page and a confirmation page in it.**
  Since 4783 the sign-in is appideas.com's Continue-as and nothing else.
- **Under heavy load, Join timed out** ("The service didn't answer"). Since
  then every action shows a spinner with the pane held, the wording changes
  after 10 s, and the timeout is 30 s. On the service, a Join retried
  within 10 minutes from the same computer succeeds (migration 010).
- **Decisions the walk relies on:**
  - Every invitation waits for the invitee's code or Accept.
  - Signing in accepts nothing.
  - Unticking the toggle pauses guests ("Walk Owner has paused sharing.
    Nothing has been deleted.") and ticking it restores them.

## Not covered here yet

The parts saved for subscription testing (plan.md, "M3 closed"):
- files across the two computers (`../measure-a-real-window/files-e2e.mjs`
  is the earlier proof);
- a meeting room across them;
- Replace Key;
- Town's people limit;
- cancelling and renewing the plan.

Add each one here as a script when it's walked.

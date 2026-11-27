# Trying M3: your board, someone else's agents, two computers

> coordinator walked this flow end to end on 2026-11-27. The setup was two
> fresh scratch apps reaching the service only through
> https://orchestratinator-dev.ngrok.dev, with real email to a real inbox and
> a real Claude Code agent on each side.

## What this shows

- **You share with one switch and one button.** Settings ▸ **Share my
  buildings**, then **Invite user**. Keys, the connection and the relay all
  happen without you.
- **Your partner pastes one code.** It comes in an email. They paste it into
  the app's Settings and press **Join**. There's no website, no password and
  no name to type.
- **Two computers, any network.** The Mac Mini reaches your board through
  the service alone. Nobody sets up a tunnel or a port. The address
  `orchestratinator-dev.ngrok.dev` stands in for the deployed
  `api.orchestratinator.com`. The agents keep it running.
- **The agents work together.** Your partner's agent runs on the Mini and
  sits on your floor, and the two agents message each other.

## Before you start

- **The Mini** needs the app's code once: `orchestratinator-desktop/docs/try-m3-mini.md`
  covers Node 24, the clone and `npm install`. It needs the app's current
  code from GitHub.
- **Your partner's address** must be one whose mail you can read on the
  Mini. Use one that has never been used with appideas.com staging,
  for example a `+m3` version of one of yours.

## Steps

### Start both apps (Terminal, in `orchestratinator-desktop`)

1. **You**, on this Mac:
   `npm run scratch -- newop152 --service=https://orchestratinator-dev.ngrok.dev`
2. **Partner**, on the Mini:
   `npm run scratch -- partner --service=https://orchestratinator-dev.ngrok.dev`
   The first start asks the Mini to sign in to Claude. Press **Sign in to
   Claude**.

### You share

3. **You:** Settings (⌘,) ▸ tick **Share my buildings**. Your browser opens
   at appideas.com:
   - choose **Log in** if asked, as `orch-chris@example.test` (password in
     `~/.config/orchestratinator/staging-test-accounts.env`);
   - then **Continue**.

   Back in the app, Settings says "Connected as Chris Test", and
   **Headquarters** is ticked under "Shared buildings".
4. **You:** **Invite user** ▸ your partner's address ▸ **Send**. They're listed
   under "People you invited" as **Invited**.

### Your partner joins

5. **Partner**, on the Mini: an email arrives, "Chris Test invited you to
   Headquarters in Orchestratinator". Copy the code in it.
6. **Partner:** Settings ▸ paste it into **Code from your invitation** ▸
   **Join**. The app says "You're in". On your Mac, the partner now reads
   **Joined**.

### Work together

7. **Partner:** run `mkdir -p /tmp/partner-agent` in Terminal. Then go to
   Settings ▸ "Invitations to you" ▸ **Open**. Your floor opens in a window
   of the partner's app. There:
   - press **Take a desk**;
   - choose the Mini and the folder `/tmp/partner-agent`;
   - name it `partner-agent`;
   - press **Take**.

   partner-agent appears on your floor too.
8. **Talk.** Agents read each other with the board's messages, so each one
   is asked to check:
   - **You:** ask Desk Ask, "Send partner-agent a message introducing
     yourself."
   - **Partner:** ask partner-agent, "Check your messages and answer
     Desk Ask."
   - **You:** ask Desk Ask to check its messages.

### If you'd like more

- **Files:** ask partner-agent, "Use send_file to send a small file to Desk
  Ask." Desk Ask receives it and can read it.
- **Pause:** untick **Share my buildings**. The partner's app says you've
  paused sharing, and nothing is deleted. Tick it again and they're back.
- **Send a new code** beside the partner re-sends their invitation. The old
  code stops working.
- **Remove** takes them out. Their desks leave your floor.

9. Quit both apps (⌘Q) and remove the folder: `rm -rf /tmp/partner-agent`.

## Not in this walk

- **Deployment.** The service's deploy bundle and runbook are in
  `orchestratinator-service/docs/DEPLOY.md`. Applying it at DigitalOcean is
  yours (decision 19).
- **The design** of the store and app pages, which comes later with the
  designer.

# Trying M3: a real subscriber, end to end

> Walked end to end through https://orchestratinator-dev.ngrok.dev by
> desktop-dev from two scratch apps, with nothing pointed at this Mac
> (msg 4574): sign-in, the invitation, the partner's agent on your floor, a
> meeting room, and a file each way. The one-Mac version before it covered
> the subscription steps (msgs 4530–4552).

## What this shows

The paid service as a customer meets it, on the staging site
(https://appideas.ngrok.dev) with test payments:

- **Buying.** You buy the Town plan, with a test card.
- **Signing in.** Each person's app signs in through appideas.com. There's no
  Key to copy.
- **Two real computers.** Your partner works from the Mac Mini, makes a
  free account while signing in, and you invite them by email. Their agent
  runs on the Mini and sits on your floor, in a meeting room with yours.
- **Files.** Your agents and theirs send each other files.
- **Town's limit** (you plus two people) is refused in plain words.
- **A cancelled subscription** pauses your partner's access without touching
  either board, and subscribing again restores it.

## Two real computers

- **You** is this Mac: your browser and a scratch app.
- **Partner** is the Mac Mini: its own browser and its own scratch app.

Both talk to the service at its live address,
**https://orchestratinator-dev.ngrok.dev**: the development service, put on
the internet through your ngrok account. Nothing on the Mini points back at
this Mac, as it will be for real customers with `app.orchestratinator.com`.
Each board's page is `https://<board>.orchestratinator-dev.ngrok.dev`.
appideas.com is the staging site. Your everyday Orchestratinator app isn't
touched.

**Set the Mini up once first:** `orchestratinator-desktop/docs/try-m3-mini.md`
(Node 24, the code, `npm install`, Claude Code signed in).

## Steps

### Your subscriber account

1. **You** need a staging appideas.com account with Town. Either:
   - **The ready one (quickest):** `orch-chris@example.test`, already on
     Town. Its password is in `~/.config/orchestratinator/staging-test-accounts.env`.
     Log in with it at https://appideas.ngrok.dev/my-account/ in your normal
     browser.
   - **Or buy one:** open https://appideas.ngrok.dev/orchestratinator/,
     choose **Town**, and pay with the test card `4242 4242 4242 4242`, any
     future date and any CVC, logging in or creating an account when it
     asks. Make sure the account has a password you know, because step 5
     signs in with it.
2. Your account page (https://appideas.ngrok.dev/my-account/) lists the
   subscription: "Operators: up to 3, you included / Shared buildings: 1 at
   a time".

### Start both apps (Terminal, in `orchestratinator-desktop`)

3. **You**, on this Mac:
   `npm run scratch -- newop152 --service=https://orchestratinator-dev.ngrok.dev`
4. **Partner**, on the Mini:
   `npm run scratch -- partner --service=https://orchestratinator-dev.ngrok.dev`

### Sign each app in

5. **You:** in your app, open Settings (⌘,) ▸ Service ▸ **Sign in**. Your
   browser opens. Choose **Sign in with your appideas.com account**, then
   **Continue as <you>**. The tab says "You're signed in". Back in the app,
   Settings says "Connected as <you>".
6. **Partner**, on the Mini: in the app, open Settings ▸ Service ▸ **Sign
   in**. The Mini's browser opens. Choose **Sign in with your appideas.com
   account**, then **Create a free account** (an email like
   `pat+m3@example.test`, a name, a password). It comes straight back, and
   the app says it's connected.
7. **Partner:** the app says "Opening this board from anywhere and inviting
   people into it need a subscription. Invitations other people give you
   still work." Under "Invite people", it says "Inviting people needs a
   subscription." That's right: Pat hasn't paid.

### Invite your partner, and work together

8. **You:** Settings ▸ "Invite people into your buildings". Under
   "Headquarters at <your computer>", type Pat's email address in "Their
   email address" and press Invite. Pat is listed under "Who can come in".
9. **Partner:** within about half a minute, Pat's app shows
   "<you> invited you to Headquarters at <your computer>", then "You're in."
10. **Partner**, on the Mini: make a folder for Pat's agent,
    `mkdir -p /tmp/partner-agent`. In the Mini's browser at
    https://orchestratinator-dev.ngrok.dev, under **Invitations**, press
    **Go in to <you>'s Headquarters**. Then Take a desk, go to "/" → private → tmp →
    partner-agent, name it partner-agent, and press Take.
11. **Files.** On the Mini, write a small file:
    `echo hello > /tmp/partner-agent/hello.txt`. Then, in the Mini's
    browser, ask partner-agent: "Use send_file to send hello.txt
    to Desk Ask, with a note." In your app, Desk Ask receives a message
    from partner-agent (Pat's agent) with the file, and can read it.

### A meeting room across two computers

12. **You:** on your floor, press **select desks** in the floor's header,
    tick Desk Ask and partner-agent, and press **Meeting room**. Each
    agent's note says both of you are there. In the room, ask
    partner-agent: "Send a message to the room introducing yourself." Then
    ask Desk Ask: "Check your messages and answer partner-agent." Desk Ask
    reads it and answers, and partner-agent, on the Mini, can read the
    answer. Agents read each other through the board's messages, so each
    is asked to check.

### Town's limit

13. **You:** invite two more email addresses (they needn't exist yet). Town
    is you plus 2, so the second is refused: "Your plan allows 3 people,
    you included. Remove someone to invite someone else." 

### A cancelled subscription, and subscribing again

14. **You:** on your account page, cancel the Town subscription. Within
    about 5 minutes:
    - Your app says "Your subscription has lapsed. People you invited
      can't come in, and you can't open this board from elsewhere, until
      it's renewed." 
    - Pat's app says "<you>'s invitations are paused until their
      subscription is renewed."
    - Pat's agent goes offline on your floor.
    - Nothing on either board is lost.
15. **You:** buy Town again (step 1's "Or buy one", logged in as the same
    account). Within about 5 minutes your app is
    back to "Connected". Pat's app says "You're in." again, and Pat's
    agent is live on your floor in the same conversation, without anyone
    doing anything.
16. Quit both app windows (⌘Q), and remove the folder if you like:
    `rm -rf /tmp/partner-agent`.

## You'll also see

A few offline desks on your floor in the scratch app (desk-auto, mover,
pat-agent, pat-test, pat-test2). They're left over from the walks and
harmless. Desk Ask, which step 11 uses, is there and signed in.

## Not in this walk

- **Deployment.** The service's deploy bundle and runbook are
  `orchestratinator-service/docs/DEPLOY.md`. It's yours to apply at
  DigitalOcean (decision 19), and nothing there is created until you do.
- **The design** of the store and app pages. That's the later round, with
  the designer.

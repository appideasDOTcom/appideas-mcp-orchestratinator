# Trying M3: a real subscriber, end to end

> Walked end to end on real staging by desktop-dev, 2026-11-25 (msgs 4530,
> 4534, 4537, 4552), with screenshots. The words below are the ones on
> screen.

## What this shows

The paid service as a customer meets it, on the staging site
(https://appideas.ngrok.dev) with test payments:

- **Buying.** You buy the Town plan, with a test card.
- **Signing in.** Each person's app signs in through appideas.com. There's no
  Key to copy.
- **Your partner** makes a free account while signing in, and you invite them
  by email.
- **Files.** Your agents and theirs send each other files.
- **Town's limit** (you plus two people) is refused in plain words.
- **A cancelled subscription** pauses your partner's access without touching
  either board, and subscribing again restores it.

## How we pretend to be two people on one Mac

As for M2:

- **You** is your normal browser and the first app window.
- **Partner** is a private browser window and the second app window.

Your everyday Orchestratinator app isn't touched. The service runs locally at
http://localhost:8780, and appideas.com is the staging site.

## Steps

### Buy Town

1. **You:** in your normal browser, open
   https://appideas.ngrok.dev/orchestratinator/. Choose **Town**. Pay with
   the test card `4242 4242 4242 4242`, any future date, and any CVC. Log
   in, or create your account, when it asks.
2. Your account page now lists the subscription: "Operators: up to 3, you
   included / Shared buildings: 1 at a time".

### Start both apps (Terminal, in `orchestratinator-desktop`)

3. `npm run scratch -- newop152 --service=http://localhost:8780`. This is
   **your** app.
4. In a second Terminal:
   `npm run scratch -- guestm2 --service=http://localhost:8780 --claude-from=newop152`.
   This is your **partner's** app.

### Sign each app in

5. **You:** in your app, open Settings (⌘,) ▸ Service ▸ **Sign in**. Your
   browser opens. Choose **Sign in with your appideas.com account**, then
   **Continue as <you>**. The tab says "You're signed in". Back in the app,
   Settings says "Connected as <you>".
6. **Partner:** in the partner's app, press **Sign in**. Your normal
   browser opens signed in as you; close that tab. In the partner's app,
   beside "Waiting for your browser…", press **Copy sign-in link** (under
   "Signing in as someone else?") and paste it into a **private** browser
   window. Choose **Sign in with your appideas.com account**, then **Create
   a free account** (an email like `pat+m3@example.test`, a name, a
   password). It comes straight back, and the partner's app says it's
   connected.
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
10. **Partner:** make a folder for Pat's agent: `mkdir -p /tmp/partner-agent`. In
    the private browser window at http://localhost:8780, under **Invitations**,
    press **Go in to <you>'s Headquarters**. Then Take a desk, go to "/" → private → tmp →
    partner-agent, name it partner-agent, and press Take.
11. **Files.** Write a small file, `echo hello > /tmp/partner-agent/hello.txt`.
    Then, in Pat's browser, ask partner-agent: "Use send_file to send hello.txt
    to Desk Ask, with a note." In your app, Desk Ask receives a message
    from partner-agent (Pat's agent) with the file, and can read it.

### Town's limit

12. **You:** invite two more email addresses (they needn't exist yet). Town
    is you plus 2, so the second is refused: "Your plan allows 3 people,
    you included. Remove someone to invite someone else." 

### A cancelled subscription, and subscribing again

13. **You:** on your account page, cancel the Town subscription. Within
    about 5 minutes:
    - Your app says "Your subscription has lapsed. People you invited
      can't come in, and you can't open this board from elsewhere, until
      it's renewed." 
    - Pat's app says "<you>'s invitations are paused until their
      subscription is renewed."
    - Pat's agent goes offline on your floor.
    - Nothing on either board is lost.
14. **You:** buy Town again (step 1). Within about 5 minutes your app is
    back to "Connected". Pat's app says "You're in." again, and Pat's
    agent is live on your floor in the same conversation, without anyone
    doing anything.
15. Quit both app windows (⌘Q), and remove the folder if you like:
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

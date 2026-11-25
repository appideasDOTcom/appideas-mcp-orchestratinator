# Trying M3: a real subscriber, end to end

> Draft. It's checked against desktop-dev's walk of the paid path before
> costmo sees it. Wording marked *(check)* is confirmed against a screenshot
> then.

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
   in, or create your account, when it asks. *(check: the buy panel's own
   words)*
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
6. **Partner:** in the partner's app, press **Sign in**. When the browser
   opens, copy its address into a **private** window, so it isn't signed in
   as you. Choose **Sign in with your appideas.com account**, then **Create
   a free account** (an email like `pat+m3@example.test`, a name, a
   password). It comes straight back connected. *(check: how the second app's
   browser tab is moved to the private window)*
7. **Partner:** the app says "Remote use and invitations need a
   subscription." That's right: Pat hasn't paid. Pat can still go into
   buildings Pat is invited to.

### Invite your partner, and work together

8. **You:** Settings ▸ "Invite people into your buildings". Under
   "Headquarters at <your computer>", type Pat's email and press Invite.
9. **Partner:** within about half a minute, Pat's app shows
   "<you> invited you to Headquarters at <your computer>", then "You're in."
10. **Partner:** make a folder for Pat's agent: `mkdir -p /tmp/pat-agent`. In
    the private browser window at http://localhost:8780, press the Open
    under **Invitations**. Then Take a desk, go to "/" → private → tmp →
    pat-agent, name it pat-agent, and press Take.
11. **Files.** Write a small file, `echo hello > /tmp/pat-agent/hello.txt`.
    Then, in Pat's browser, ask pat-agent: "Use send_file to send hello.txt
    to Desk Ask, with a note." In your app, Desk Ask receives a message
    from pat-agent (Pat's agent) with the file, and can read it.

### Town's limit

12. **You:** invite two more emails (they needn't exist yet). Town is you
    plus 2, so the second is refused, saying which limit was reached.
    *(check: the words)*

### A cancelled subscription, and subscribing again

13. **You:** on your account page, cancel the Town subscription. Within
    about 5 minutes:
    - Pat's app says "<you>'s invitations are paused until their
      subscription is renewed."
    - Pat's agent leaves your floor.
    - Nothing on either board is lost.
14. **You:** buy Town again (step 1). Within about 5 minutes Pat's access
    comes back, without asking anyone.
15. Quit both app windows (⌘Q), and remove the folder if you like:
    `rm -rf /tmp/pat-agent`.

## Not in this walk

- **Deployment.** The service's deploy bundle and runbook are
  `orchestratinator-service/docs/DEPLOY.md`. It's yours to apply at
  DigitalOcean (decision 19), and nothing there is created until you do.
- **The design** of the store and app pages. That's the later round, with
  the designer.

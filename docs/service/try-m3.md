# Trying M3: a real subscriber, end to end

> The flow below (decisions 28 to 30: an invitation by email, an account
> made silently, nobody on a website) was walked end to end through
> https://orchestratinator-dev.ngrok.dev by desktop-dev from two scratch
> apps, with the emails written to files instead of sent (msg 4667). Your
> walk is the same with real email, and with the partner on the Mac Mini.

## What this shows

The paid service as a customer meets it, with the staging site
(https://appideas.ngrok.dev) and test payments behind it:

- **Your partner opens one email and never visits a website.** You invite
  them by address. Their appideas.com account is made for them when they
  accept, and their app does the rest.
- **Two real computers.** Their agent runs on the Mini and sits on your
  floor, in a meeting room with yours.
- **Files.** Your agents and theirs send each other files.
- **Keys stay in the app.** Your partner replaces their computer's Key in
  Settings, and stays in.
- **Town's limit** (you plus two people) is refused in plain words.
- **A cancelled subscription** pauses your partner's access without touching
  either board, and subscribing again restores it.

## Two real computers

- **You** is this Mac: a scratch app.
- **Partner** is the Mac Mini: its own scratch app and its own mail.

Both reach the service at **https://orchestratinator-dev.ngrok.dev**, the
development service put on the internet through your ngrok account. Nothing
on the Mini points back at this Mac. Your everyday Orchestratinator app
isn't touched.

**Set the Mini up once first:** `orchestratinator-desktop/docs/try-m3-mini.md`
(Node 24, the code, `npm install`, Claude Code signed in).

## Before you start (this Mac, once)

1. **The live address** is the agents' to keep running: nothing for you to
   do. If https://orchestratinator-dev.ngrok.dev ever doesn't answer, say so.
2. **Email.** Make `~/.config/orchestratinator/sendgrid.env` with two lines:

   ```sh
   SENDGRID_API_KEY=<your SendGrid key>
   ORCH_MAIL_FROM="Orchestratinator <an address at appideas.com>"
   ```

   The sender must be on appideas.com, the domain SendGrid has authenticated.
   Then run `chmod 600 ~/.config/orchestratinator/sendgrid.env` and tell me.
   service-dev restarts the service so it sends real email from then on.
3. **Your partner's address.** Use an address whose mail you can read on the
   Mini and that has no account on the staging site yet, for example a
   `+m3` version of one of yours. The invitation goes there.

## Steps

### Your subscriber account

4. **You** need a staging appideas.com account with Town. The ready one is
   `orch-chris@example.test`. Its password is in
   `~/.config/orchestratinator/staging-test-accounts.env`. To buy one
   instead: https://appideas.ngrok.dev/orchestratinator/, choose **Town**,
   and pay with the test card `4242 4242 4242 4242`, any future date and any
   CVC.

### Start both apps (Terminal, in `orchestratinator-desktop`)

5. **You**, on this Mac:
   `npm run scratch -- newop152 --service=https://orchestratinator-dev.ngrok.dev`
6. **Partner**, on the Mini:
   `npm run scratch -- partner --service=https://orchestratinator-dev.ngrok.dev`

### Sign your app in

7. **You:** Settings (⌘,) ▸ Service ▸ Other ways to connect ▸ **Sign in in
   the browser**.
   Your browser opens. Choose **Sign in with your appideas.com account**,
   then **Continue as <you>**. The app says "Connected as <you>".
   (An address that gets mail can use **Sign in by email** instead: type it,
   and paste the code from the email that arrives. The ready account's
   `example.test` address gets no mail.)

### Invite your partner

8. **You:** Settings ▸ "Invite people into your buildings". Under
   "Headquarters", type your partner's address and press **Invite**. They're
   listed under "Who can come in".
9. **Partner**, on the Mini: an email arrives, "<you> invited you to
   Headquarters in Orchestratinator". Click its link.
   - The scratch app is a development build, which can't answer the link
     itself. So the link opens a page showing the code. Copy it.
   - An installed app opens from the link instead, with Settings in front
     and the code already filled in: "You've been invited. Type your name as
     others will see it, then press Connect."
10. **Partner:** in the app, Settings ▸ Service ▸ **Code from an email**.
    Paste the code (or the whole link), type the partner's name in **Your
    name, as others will see it**, and press **Connect**. The app connects,
    and says "You're in". The partner's appideas.com account was
    made at that moment, with no password to choose and no website visited.

### Work together

11. **Partner:** run `mkdir -p /tmp/partner-agent` in Terminal. Then
    Settings ▸ Invitations ▸ **Open**. Your floor opens in a window of the
    partner's app. Press **Take a desk**, choose the Mini and the folder
    `/tmp/partner-agent`, name it `partner-agent`, and press **Take**.
12. **Files.** On the Mini: `echo hello > /tmp/partner-agent/hello.txt`.
    Then, in that window, ask partner-agent: "Use send_file to send
    hello.txt to Desk Ask, with a note." In your app, Desk Ask receives a
    message from partner-agent with the file, and can read it. Then ask
    Desk Ask to send a file back the same way.
13. **A meeting room.** **You:** on your floor, press **select desks**,
    tick Desk Ask and partner-agent, and press **Meeting room**. Ask
    partner-agent: "Send a message to the room introducing yourself." Then
    ask Desk Ask: "Check your messages and answer partner-agent." Each sees
    who sent what. Agents read each other through the board's messages, so
    each is asked to check.

### A new Key, in the app

14. **Partner:** Settings ▸ Service ▸ **Replace this computer's Key**. The
    app says "This computer has a new Key. The old one no longer works."
    It still says "You're in", and partner-agent is still live on your
    floor.

### Town's limit

15. **You:** invite two more addresses (they needn't exist). Town is you
    plus 2, so the second is refused: "Your plan allows 3 people, you
    included. Remove someone to invite someone else."

### A cancelled subscription, and subscribing again

16. **You:** on your account page (https://appideas.ngrok.dev/my-account/),
    cancel Town. Within about 5 minutes:
    - your app says your subscription has lapsed;
    - the partner's app says your invitations are paused until it's renewed;
    - partner-agent goes offline on your floor;
    - nothing on either board is lost.
17. **You:** buy Town again (step 4's "buy one", as the same account).
    Within about 5 minutes your app is back to "Connected", the partner's
    says "You're in." again, and partner-agent is live on your floor in the
    same conversation, with nobody doing anything.
18. Quit both apps (⌘Q). Stop the tunnel with Ctrl-C if you like, and
    remove the folder: `rm -rf /tmp/partner-agent`.

## You'll also see

A few offline desks on your floor in the scratch app (desk-auto, mover,
pat-agent, pat-test, pat-test2), left over from the walks and harmless. Desk
Ask, which steps 12 and 13 use, is there and signed in.

## Not in this walk

- **Deployment.** The service's deploy bundle and runbook are
  `orchestratinator-service/docs/DEPLOY.md`. It's yours to apply at
  DigitalOcean (decision 19), and nothing there is created until you do.
- **The design** of the store and app pages. That's the later round, with
  the designer.

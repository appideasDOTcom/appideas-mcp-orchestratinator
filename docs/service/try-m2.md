# Trying M2: inviting someone into your building

## What this shows

You and a partner each run Orchestratinator on your own computer. You
invite your partner into one of your buildings. After that:

- **Their agents sit on your floor.** They still run on your partner's own
  computer, with your partner's Claude.
- **You can talk to their agents and they to yours.** Every message says
  who sent it.
- **Each agent stays its own operator's.** Only your partner answers their
  agent's questions or stops it, and only you answer yours.
- **Removing your partner takes their agents off your floor at once.**

## How we pretend to be two people on one Mac

You play both people. Each person needs two things:

- **Their own Orchestratinator app.** Your partner's is a second app
  window, started with a second command.
- **Their own sign-in on the service.** The service's website is
  http://localhost:8780 for this test. Your partner signs in from a private
  browser window, because one browser can only be signed in as one person
  at a time.

Below, **You** means your normal browser and the first app window.
**Partner** means the private browser window and the second app window.
Your own everyday Orchestratinator app is not touched.

## Steps

### Start both apps (Terminal, in `orchestratinator-desktop`)

1. `npm run scratch -- newop152 --service=http://localhost:8780`. This is
   **your** app.
2. In a second Terminal:
   `npm run scratch -- guestm2 --service=http://localhost:8780 --claude-from=newop152`.
   This is your **partner's** app. It borrows the first one's Claude
   sign-in, so you don't sign in to Claude twice.

### Connect each app to the service

A Key is what connects one computer's app to the service.

3. **You:** in your normal browser, open http://localhost:8780. Type your
   name and press Sign in. Under Keys, type a name for this computer in
   "Which computer?" (say "My Mac"), press New Key, and copy the Key. It
   is shown once.
4. **You:** in your app, open Settings (⌘,). Under Service, paste the Key
   and press Connect. It says "Connected as <your name>".
5. **Partner:** in a private browser window, open http://localhost:8780.
   Type a name for your partner (say "Pat") and press Sign in. Make a Key
   ("Pat's Mac") and paste it into the **partner's** app the same way.

### Invite your partner

6. **You:** in your app, Settings ▸ "Invite people into your buildings".
   Under "Headquarters at <your computer>", type "Pat" and press Invite.
   Pat is listed under "Who can come in".
7. **Partner:** within about half a minute, the partner's app's Settings
   shows "<you> invited you to Headquarters at <your computer>", then
   "You're in."

### Bring an agent into your building

8. **Partner:** in the private browser window, reload. Pat's page lists
   two things that each have an Open: "Your boards" (Pat's own board) and,
   below it, **Invitations**. Press the Open beside "<you> invited you to
   Headquarters at <your computer>". That's your floor, as Pat sees it.
9. **Partner:** first, in Terminal, make a folder for Pat's agent to live
   in, so nothing touches a real project: `mkdir -p /tmp/pat-agent`. Then,
   on your floor in Pat's browser, press Take a desk. Pat can only take a
   desk on Pat's own computer, so the dialog goes straight to its folders.
   Click "/" → private → tmp → pat-agent, give the agent a name
   (pat-agent), and press Take. That agent runs on Pat's computer and now
   sits on your floor.

### Work together

10. **You:** in your app, open your floor. Pat's agent is there. Click it
    and send it a message; it is told the message is from you, and Pat
    sees your name on it.
11. **Partner:** click Desk Ask (your agent) and send it a message asking
    it to write a small file. It asks permission. In Pat's browser the
    question is shown, dimmed, with "<you> answers Desk Ask's prompts", and
    it doesn't count as "needs you" there. In your app it does: answer it
    there, and the file is written.
12. **You:** on your floor, press "select desks" in the floor's header,
    tick Desk Ask and Pat's agent, and press Meeting room. A room window
    opens, and each agent's note says both of you are there.

### Remove your partner

13. **You:** in Settings, press Remove beside Pat. Pat's agent leaves your
    floor at once, and Pat's app says "<you> removed you."
14. Quit both app windows (⌘Q), and remove the folder if you like:
    `rm -rf /tmp/pat-agent`.

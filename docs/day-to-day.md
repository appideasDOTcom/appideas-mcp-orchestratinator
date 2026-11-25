# Day to day

The daily loop on the floor, step by step. Back to the [README](../README.md).

One rule underneath everything: a conversation is one `claude` process, so
**one app holds it at a time**. The floor always says who holds each desk. The
daily loop:

**1. Open the app** (or <http://localhost:8787/> when you
[run it from source](run-from-source.md)). Glance at the building; the header
counts who's here and who needs you. Go where it points.

**2. Work from the floor, your editor, or both.** A session you start in VS
Code or Claude Code, in a project on the floor, comes alive on its desk: your
conversation, state and prompts appear as they happen. A repo you bound with a
hand-written `.mcp.json` stops its first session on *"New MCP server found in
this project"*. Approve it once and that repo is settled for good. A folder
you took with **Take a desk** asks nothing.

**3. Click into a room, then a desk,** to read that agent's conversation live.

**4. Answer what needs you.** If the floor holds the desk, permission prompts
have **Approve / Deny** buttons right on it. If your editor or a terminal
holds it, the floor shows the question and says to answer it in that app.

**5. Ring the service bell** on any desk whose tray shows waiting messages or
tasks. The agent picks them up. A desk whose Claude Code is not running shows
its bell half-lit: ringing it starts it first — the conversation resumes where
it left off — and then nudges. To nudge several at once, or mark their messages
read, or hide them, use **select desks** on the room's header, check the desks,
and pick the action.

**6. Type to a desk from the floor** by first closing that conversation's tab
in your editor and clicking **Open on the floor** — one app at a time. The
composer comes alive a second or two later; if the desk's Claude Code is not running,
the host starts it and *resumes the same conversation*, history intact.

The composer takes a slash command too: `/clear`, `/compact`, `/btw <question>`
and anything else Claude Code knows, each confirmed by Claude Code's own
receipt and said in its own terms — a new conversation started, compacting,
answered on the side (with the answer). The model and effort controls on
the panel's foot are Claude Code's own `/model` and `/effort`, so a choice is
also **saved as the default for new sessions** on that desk's machine, the
way it is when you change it in Claude Code or your editor. While a
desk compacts, the floor says so, and a message sent meanwhile is taken and
answered when the compaction ends.

**7. Pop a chat out, or bring several desks into one.** **⧉** on a desk's
panel detaches its chat into a window of its own; open as many as you like
beside the floor. To talk to several agents together, **select desks**, check
them, and press **Meeting room**. An agent that is already in a room can be
checked for another, and gets a second session there; **Take a desk → New
desk here** does the same across floors. All of it is in
[Operating the board](operating.md#chatting-with-a-desk).

**8. Take a conversation back whenever you want** — for any feature the floor
chat doesn't provide. **Open in VS Code** moves it to your editor with
everything you did from the floor already in it; **Open in Claude** opens a
terminal of your own `claude` on the same conversation. Either one takes the
conversation from the floor, and the floor's next message takes it back.

**9. Keep it current.** The app updates itself: a new version downloads in the
background and installs when you restart it (or at once, with **Restart to
Update**). On a source install, the header shows **Update available** when the
branch the board follows has a commit this build lacks; it checks GitHub once
a day. **Update** says what it will interrupt, then the host on the board's
machine fetches the commit, rebuilds the server, updates the plugin when its
hooks changed, and restarts itself, and the page reloads onto the new build.
An update is refused, in words, when the clone has local changes or is not on
the followed branch. One that stops after the server was rebuilt (the plugin
update failed, say) leaves **Update stopped** in the header, and **Finish the
update** runs what is left. **Settings** (⚙) turns the daily check off,
switches to the development version (`develop` instead of `main`), and has
**Check now**. The page's Update restarts a host that launchd runs (macOS). On
Windows, pull the clone and run `host\install.ps1` again, which stops the
running host cleanly and starts the new one.

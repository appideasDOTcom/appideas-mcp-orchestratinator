# Marketing facts

What the landing page may say about the orchestratinator, checked against the
code. Every fact names the file and line that holds it, at commit `d108f3f`
(branch `develop`, 0.15.0, 2026-11-22; first written at `0ce4f1e`, 2026-10-17;
re-anchored at `c6f9474` on 2026-11-02 — sixteen references had moved, none
had changed — at `8f4a703` on 2026-11-03 — six moved and one was placed by
hand, the hook door's host check, which now sits under the Decided 6 wake;
none changed — and again here for issue #20: nine moved and two were placed
by hand, the schema and the backup list, which both grew by `desk_flags`;
the version and the stored-tables facts changed, nothing else — and once
more at `e2df53f`, the PR #30 fix: four moved, none placed by hand, none
changed — and at `cc52a23` for issues #9/#10/#15: twenty-seven moved and
five placed by hand (the hooks list, the hook's payload block and the
hook-content block, which grew; the transcript reader, whose context line
was rewritten); the version, the events, what the plugin sends and the
floor's per-desk table changed in substance — at `46d57a6`, the three
hand-test fixes after the 0.10.9 deploy: twenty-six moved, none placed by
hand; the per-desk rows for a compaction and for a command changed in
substance — and at `9ca6772` for issues #24 and #18: nineteen moved, none
placed by hand; the version changed and one per-desk row was added, moving
a desk from its nameplate card — and at `0acf764` for issue #5 steps 1–2,
0.10.11: six moved and one placed by hand, the host's one `fetch`, which
now sits inside `request()`'s failure handling; the version changed,
nothing else — and at `08a0641` for issue #5 step 3, 0.10.12: one moved,
the `POST /mcp` route, below the board's new hold and slow-request lines;
none placed by hand; the version changed, nothing else — and at `4d742bb`
for the poll time limit (task 264): five moved in src/ui/floor.js, below
its new POLL_TIMEOUT_MS; none placed by hand, none changed — and at
`3a57e39` for issue #23, bulk selection, 0.10.16: fifteen moved, none placed
by hand; the version changed and one per-desk row was added, acting on
several desks at once — and at `ef56655` for 0.10.17 to 0.12.0 (issues
#11, #13, #19, #37, #40, #43, #44, #46): forty-two moved and ten placed by
hand (the seven `src/tools.js` tool lines, twelve lower under
`send_message`'s meeting-room containment; the compose file, which grew; the
no-Docker block in internals.md; the host's permission block). In
substance: the version, the plugin's hook count (it said eight beside a
list of twelve), `send_message`'s line, what the server stores, and **what
leaves the machine** — the update check (#40) contacts GitHub, so "the
server makes no outbound connections" no longer holds and section 4 says
what does. Rows added for popouts, meeting rooms and updating from the
page — and at `56d04eb`, the 0.12.2 bump: none moved, the version
changed, nothing else — and at `5dae536` for the 0.12.3 bump that follows it:
none moved, the version changed, nothing else — and at `d5c391b` for 0.12.4
to 0.12.7 (QA, PR #55 finding 3), in two steps: to the PR's head `1cb1eb2`,
fifty-two moved and three placed by hand, then twelve more moved to
`d5c391b`, which answers the review in `host/window.js` and
`src/ui/floor.js`.
Two are blocks that grew, the host's permission block and the hook's
`reduceToolInput`. The third is the model and effort row, which cited
`pick()`, the picker driver 0.12.7 removes; it now cites the two places the
window's own line is read, `switchedTo` and the receipt for the two
commands. The version changed; that row's wording was already 0.12.7's
— and at `9448dc8` for 0.12.8 and PR #56's first round: seven moved and
one placed by hand, the page's `deskRows`, whose signature changed. Two
facts changed in substance: the version, and the empty-desk line, because
a desk in a meeting is drawn in its box whatever it reads — and at
`9a344f5` for 0.12.9 and the round that answered QA's review of PR #57:
forty-eight moved and seventeen placed by hand. The hand-placed ones are
the eleven `src/tools.js` lines, which all sit lower under `addressed()`;
the move's reopen line in `host/index.js`, which was rewritten and says
the same; the schema block, which grew by `desk_twins`; and the four
`src/db.js` lines of the meeting-room row, a list the script leaves whole
when one of its lines repeats. Three facts changed in substance: the
version, what the server stores (`desk_twins`), and one row added, an
agent with several sessions. No network call was added: a second desk's
binding file is written by the host on its own disk — and at `c26d3db`
for the rounds after QA's close of PR #57, which changed `host/window.js`
alone: eleven moved, none placed by hand. One fact gained a sentence, the
host's: it types into, and closes, only the windows of its own tmux
session, which it names exactly. The version is unchanged — and at
`d108f3f` for 0.12.9 to 0.15.0, where the tmux window layer was replaced
by a Claude Code process per desk spoken to as stream-JSON
(`host/window.js` is gone; `host/agent.js`, `host/desk.js` and
`host/claude.js` hold what it did): forty-two moved and forty-five placed
by hand or rewritten. Every `host/window.js` reference now cites
`host/claude.js`, `host/desk.js` or `host/agent.js`; the ten `src/tools.js`
lines sit lower under `send_message`'s empty-body refusal and
`poll_messages`' `since_ahead`; the schema block grew by `room_told`; the
meeting-room row's four `src/db.js` lines were placed as a list. In
substance: the version (0.15.0, protocol 2); the host's paragraph and its
requirements (a process per desk, no tmux, Node 24, no longer typing into
or reading a screen); the per-desk rows for prompts, answers, compaction,
model and effort, slash commands, the bell, typing, and the two handoffs
(Open in tmux is gone); the hook's `node` fallback; the host's OS line,
which now names the Windows installer and dialog as present and not
claimed; what the plugin sends (a subagent's id), what the host sends
(the ask, and what a registration carries), what the server stores
(`room_told`, attachments staged an hour); and section 4 gained the
desks' own Claude Code and Sign in, the attachment fetch and the update's
`/health` read, all to the same board or Claude Code's own).
Cite
this file; do not restate a fact from memory or from the README. Where a
claim did not hold, it is narrowed here or marked **not claimed**. Where the
answer is not this repo's to give, it says whose it is.

Line numbers are for `d108f3f`. A later commit may move them; the file names
will not. `npm run reanchor-facts <old-sha> <new-sha> -- --write` moves every
reference whose line is found once at the new commit and lists the rest.

## 1. The three parts, and where each runs

**The server.** A Node process serving MCP over Streamable HTTP at `/mcp`
and the dashboard page at `/`, with SQLite underneath. Shipped as one Docker
container; `src/` is baked into the image and the database lives in a named
volume. Runs anywhere Docker runs. Without Docker it runs as `npm start` on
Node 24, the major the image ships (better-sqlite3 13 needs Node-API 10).

- Docker: `Dockerfile:1` (`node:24-bookworm-slim`), `docker-compose.yml:1-44`.
- Transport and tools: `src/server.js:282` (`POST /mcp`), `src/tools.js:53`.
- Node floor: `package.json` `engines.node` `>=24` (the board's image and the
  release gate's major), `src/node-floor.js`; `docs/internals.md`, "Run
  locally without Docker", for the no-Docker path.
- Dashboard and floor pages: `src/ui/index.html`, `src/ui/app.js`,
  `src/ui/floor.js`.

**The plugin.** A Claude Code plugin named `orchestratinator-floor`, served
from this repo's own marketplace. It is only hooks: twelve Claude Code hook
events, each running one detached Node script that posts the session's state
to the server. It has no UI and no settings. There is **no VS Code extension
of our own**; "VS Code" here means Claude Code's own VS Code extension, which
shares plugin installs with the terminal `claude`. One install covers both.

- Manifest: `plugin/.claude-plugin/plugin.json`; marketplace
  `.claude-plugin/marketplace.json:9-16` (`source: ./plugin`).
- The twelve events: `plugin/hooks/hooks.json:4-135` — SessionStart,
  SessionEnd, UserPromptSubmit, PreToolUse, PermissionRequest, Notification,
  Stop, StopFailure, PreCompact, PostCompact, PreModelSwitch,
  PostModelSwitch. All twelve run the identical command line.
- The reporter: `plugin/hooks/report.mjs`. Identity is read from the repo's
  own `.mcp.json` or Claude Code's local-scope entry, never configured
  (`report.mjs:25-29`, `report.mjs:149-194`).
- OS: the hook line is POSIX shell plus a `node`: the one on PATH, or,
  with none there, the Node the desktop app keeps a link to at
  `~/.orchestratinator/bin/node`; with neither the hook does nothing
  (`hooks.json:9`). Measured on macOS only. Linux is expected to work and
  is **not measured**. Windows is **not claimed**.

**The host.** A Node service on each workstation that runs each desk's
Claude Code as a process of its own and speaks to it as data, through
Claude Code's programmatic interface (stream-JSON in and out): a message
goes in as a record and counts as delivered when Claude Code says it has
taken it (its receipt names the record), and a permission or a question comes out as a request the floor
answers. Nothing is read off a screen and no keys are typed; there is no
tmux (since 0.15.0). It tails each conversation's transcript to the
server, and does what the floor asks: deliver a message, answer a prompt,
stop a turn, start a desk's Claude Code, hand the conversation to the
editor or a terminal. It has no npm dependencies. It only ever reaches
out; the server never connects to a workstation and nothing on the
workstation listens. A desk's Claude Code is started only while no other
Claude Code holds its conversation: one an editor or a terminal of the
operator's own holds is refused, naming its process, and the desk reads
as held outside the floor (`host/desk.js:127-141, 333-334`).

- What a desk's process is, and the protocol: `host/agent.js:1-38`, the
  command line `host/agent.js:53-64`; one desk: `host/desk.js:1-15`.
- The reach-out rule: `host/index.js:27-29`.
- Zero dependencies: `host/package.json` (`"dependencies": {}`),
  `host/install.sh:104-107`.
- Requirements enforced by the installer: a Node 24 (`host/install.sh:75-77`,
  `host/node.sh:19-38`) and a `claude` on PATH (`host/install.sh:78`). No
  tmux.
- **OS: macOS.** The installer writes a LaunchAgent (`host/install.sh:6, 25`).
  "Open in VS Code" uses macOS `open -a` (`host/claude.js:496`); "Open in
  Claude" drives Terminal.app or iTerm through `osascript`
  (`host/claude.js:518-542, 607`); the folder dialog has a macOS backend
  (`host/dialog.js:1-41, 213`). The tree also carries a Windows installer
  (Task Scheduler, `host/install.ps1:1-35`), a Windows folder dialog
  (`host/dialog.js:42-63, 214`) and Windows Terminal for Open in Claude
  (`host/claude.js:587-601`), measured on one PC on the window layer before
  0.15.0; the process layer has not been measured on Windows
  (`docs/stream-json-spike.md:119-121`), and the README says macOS. Linux
  has no folder dialog (`host/dialog.js:65-71`).
  Say "macOS" for the host; Windows is **not claimed**.
- Two texts in the tree still describe the window layer: `host/package.json`'s
  `description` ("in a tmux pane") and the header of `host/index.js`
  (`host/index.js:1-14`, and `ORCH_TMUX_SESSION` at line 35). Neither is
  read by the code that runs a desk; do not quote either.

## 2. What the floor shows per desk, and which part each needs

The server's own state (MCP tables) needs neither plugin nor host. The plugin
adds *state* from inside the session. The host adds the full conversation and
every action that reaches a desk's Claude Code. The decider on the server is
one function, `deliverable()` (`src/floor.js:418-440`): no host, a host
offline or refused by the board, or the conversation open in another app (an
editor, or `claude` in a terminal) means nothing can be sent to it.

| Shown on the desk | Needs | Where |
| --- | --- | --- |
| Status word, detail line, age, TTL expiry | nothing beyond the MCP tools | `src/tools.js:87-108`, `src/agent-state.js:56-139` |
| Tray: unread, assigned, claimed counts; derived state when no status is set | nothing beyond the MCP tools | `src/agent-state.js:102-139, 221` |
| Needs-you badge and the ranked "Needs you" queue | plugin (PermissionRequest / Notification hook sets `awaiting_kind`), or for a desk the host runs, the host's `ask` event | `src/floor.js:1707-1756`, `src/floor.js:2757-2788`, `src/floor.js:3054-3079`, `src/db.js:135-140` |
| Permission prompt text, the tool asking | plugin, or the host for a desk it runs (what Claude Code sent, as data) | `src/floor.js:1707-1722`, `host/desk.js:214-222` |
| Approve / Deny / the question's own choices | host, and only when the floor holds the conversation: the answer goes back to Claude Code as data (allow, deny with the operator's reason, or a question's answers); a prompt asked in another app says to answer it in that app | `src/floor.js:3072-3077`, `src/ui/floor.js:5151, 5163-5164`, `host/index.js:1476-1495`, `host/desk.js:240-262` |
| Live conversation, partial: the typed prompt, the final reply, each tool call as it starts | plugin alone, used only when no host is tailing that desk | `src/floor.js:1527-1538, 1676-1697` |
| Live conversation, complete: every reply, every tool call, subagent turns labelled by description, injected context as labelled lines | host (reads Claude Code's transcript) | `host/claude.js:1041, 993-1179` |
| The desk compacting, from its start to its end; a compaction the hooks never finish ends on the next prompt, turn or tool, and a `/compact` from the floor is said as it starts ("compacting") and as it ends ("Compacted", or the compaction's own result) | plugin (`PreCompact` / `PostCompact`) for the state; host for a `/compact` from the floor, from Claude Code's own status records, and the summary (drawn as a labelled context line) | `src/floor.js:1643-1652, 1581, 2597-2604`, `host/desk.js:178-181`, `host/claude.js:1133-1135` |
| The model and effort level, what was asked for beside what was confirmed; a change from the floor reaches Claude Code as its own control request, and the host also saves it as the default for new sessions on that machine (`model`, and that model's `effortLevel`, in Claude Code's `settings.json`), or says on the desk why it could not | plugin (`PreModelSwitch` / `PostModelSwitch`, `effort_level`); host (the control request's answer, the transcript's next reply) | `src/floor.js:1662-1674, 2620`, `host/desk.js:29-30, 303-307`, `host/claude.js:1248-1258` |
| A slash command from the composer, said as one line labelled `host` with what was typed and what happened ("/model opus — Set model to … and saved as your default for new sessions"): `/model` and `/effort` are control requests, `/btw` a side question answered on the desk, a bare `/mcp` reconnects the desk's tools, and anything else (`/compact`, `/clear`, `/cost`) goes as a message; after a `/clear` the desk follows the new conversation | host | `src/floor.js:249, 2570`, `host/desk.js:24-37, 297-312`, `host/agent.js:109` |
| Thinking, drawn as a thought bubble | host | `host/claude.js:1163-1164` |
| Service bell (nudge) | host; a desk whose Claude Code is not running has it started first, on its conversation | `src/floor.js:523`, `src/ui/floor.js:1880-1893`, `host/desk.js:285` |
| Typing to a desk, Enter sends, stop interrupts; a message is delivered when Claude Code's receipt names it, and one sent while a turn runs is taken into that turn and shown as queued | host, floor-held | `src/floor.js:426`, `host/index.js:1443, 1501`, `host/agent.js:90-100`, `host/desk.js:315-322` |
| Open in VS Code: the desk's Claude Code ends, then the conversation opens in the editor | host (macOS) | `host/index.js:1512`, `host/claude.js:481-501` |
| Open in Claude: the desk's Claude Code ends, then a terminal of the operator's own opens on `claude --resume` of the conversation; what is said there still reaches the floor | host (macOS) | `host/index.js:1549-1565`, `host/claude.js:585-613` |
| Take a desk (bind a folder from the floor, no `.mcp.json` by hand) | host | `src/floor.js:4129`, `host/dialog.js` |
| Move an agent to another floor from its nameplate card — only the floor is picked, the desk's own folder and host do the rest; a move that ends the desk's running Claude Code opens a new conversation there, one with none running resumes its last; it lands on the new floor drawn, even a floor it left before | host | `src/floor.js:4257, 2233`, `src/ui/floor.js:660`, `host/index.js:745, 801` |
| Several desks at once: select desks on a room, check them, and nudge, mark read or hide them together — desks whose Claude Code is running are nudged before those that must start one, a desk that cannot be nudged is named with the reason, the selection closes itself once the action is sent, and a desk it did not reach is named on the room with the reason | host for the nudge; mark read and hide need nothing beyond the board | `src/ui/floor.js:3686, 3228, 3271, 9095` |
| A desk's chat in a window of its own (⧉): the whole panel, live, beside the floor, several at once on one shared stream; it follows its desk to another floor, survives a floor reload, and Re-attach brings it back with whatever was typed | host to send to it; reading needs only what the floor's panel needs | `src/ui/floor.js:6583`, `src/ui/floor.js:4170`, `src/ui/hub.js:1-20` |
| A meeting room: several desks of one floor in one window, one composer, `@names` at the start narrowing a message to some of them, each desk's delivery under the message, and while the room is open its desks' broadcasts reach the room and nobody else on the floor (a direct message still goes where it is addressed) | host for each desk's delivery; the containment is the board's | `src/ui/floor.js:7680, 6116, 5879`, `src/floor.js:4837, 4886`, `src/db.js:694, 808, 1109, 2243` |
| One agent in several places at once: a second desk for it on another floor, or on its own floor under its name with a number (`qa-2`), each a session of its own in the same folder; a desk already in a meeting room joins a second room as another session, which closes when it is in no room and is made again by Resume; a second session starts with nothing unread, and a name another agent writes means the session in the writer's room | host, one that says it can seat a second desk in a folder | `src/floor.js:4210, 4335, 697`, `host/index.js:828`, `host/seats.js:1-12`, `src/db.js:341`, `src/tools.js:40` |
| Update from the page: the header says a newer build is on the followed branch (`main`, or `develop` in Settings); Update has the host beside the board fetch it, rebuild the server, update the plugin when its hooks changed and restart itself, and the page reloads onto it; refused in words for a dirty clone, another branch, local commits, or a host not under launchd; a host the desktop app runs, and a board it runs, are the app's to update and offer nothing | host on the board's own machine, **macOS** (launchd restarts it) | `src/updates.js:1-34, 107-132, 158, 167`, `host/update.js:113-117` |
| Recent conversations, search, read a conversation whole | host | `host/history.js:1-29`, `host/index.js:1535-1542` |
| Tool calls on the plugin path carry only one descriptive field (command, path, pattern, description, prompt, url), clipped to 300 characters | plugin | `plugin/hooks/report.mjs:42, 348-376` |

Two honest limits worth not contradicting on the page:

- Nothing is inferred from silence. A desk reads "needs you" only because
  Claude Code raised a prompt; a quiet desk is drawn quiet
  (`docs/operating.md`, "Nothing on the floor is inferred from silence";
  `src/agent-state.js:102-139`). Since 0.10.8 a desk with nothing live
  behind it — no session reporting, no host, or the host offline — is not
  drawn at all, and comes back on its own when something is; the storey
  still counts it in `N/M here` (`src/ui/floor.js:2927, 2949-2956`, issue #20).
  A desk whose host the board refused for its protocol is drawn, saying
  why it takes nothing (same line).
  The one exception is a desk in a meeting room, which stands in the
  meeting's box on the floor while the meeting lasts, empty or hidden
  (PR #56).
  Do not say "a desk for every agent": say every agent with something
  running has one.
- The floor is a live tail, not an archive: the newest 400 turns per desk
  (`TURN_RETENTION`, `src/db.js:718`). History is read off the hosts'
  transcripts, not the server (`host/history.js`).

## 3. The ten MCP tools

All ten are registered in `src/tools.js`; the one-liners below are from the
descriptions in that file.

| Tool | One line | Line |
| --- | --- | --- |
| `whoami` | Report the channel and agent bound to this connection and who is present on the channel. | `src/tools.js:60` |
| `set_status` | Declare working / waiting / blocked / idle with a detail line and a TTL; shows on the dashboard, nothing reads it back. | `src/tools.js:87` |
| `send_message` | Post to the channel; omit `to` to broadcast, name an agent to direct-message. While the operator has the sender in a meeting room, a broadcast reaches only the room's other desks, and the reply names them. A message with no `body` is refused, not sent empty. | `src/tools.js:110-151` |
| `poll_messages` | Fetch messages addressed to you newer than `since`; returns a cursor. A `since` from another instance is said (`since_ahead`) and read from this board's own record instead. | `src/tools.js:153` |
| `set_contract` | Create or update a shared interface entry by key; bumps the version and records history. | `src/tools.js:201` |
| `get_contract` | Read one contract entry by key, or every entry on the channel. | `src/tools.js:218` |
| `open_task` | Open a task on the channel, optionally assigned to an agent. | `src/tools.js:238` |
| `list_tasks` | List tasks by status and/or mine; stale claims reopen on an actionable listing. | `src/tools.js:261` |
| `claim_task` | Claim an open task so others know you have it. | `src/tools.js:283` |
| `complete_task` | Mark a task done with an optional note. | `src/tools.js:299` |

Claim TTL defaults to 15 minutes (`docker-compose.yml:34`); status TTL to
900 seconds (`docker-compose.yml:36`, `src/tools.js:95-96`).

## 4. What leaves the machine

**Where it goes.** Everything goes to one place: the server named in the
repo's own binding (`url` in `.mcp.json`), on the same origin as `/mcp`.
The plugin posts to `<that origin>/api/ingest`
(`plugin/hooks/report.mjs:323-334, 431`); the host talks to
`<that origin>/api/host/*` (`host/index.js:219, 224`), fetches a message's
attachments from there (`host/uploads.js:113`), and during an update reads
that board's `/health` (`host/update.js:64`). Nothing about your work goes
anywhere else: no message, task, contract, turn, path or prompt is sent to
any third party.

**The desks' Claude Code is your own.** The host runs the `claude` already
signed in on that machine (`host/install.sh:104-107`); what Claude Code
itself sends to Anthropic is Claude Code's, under your account, and the
orchestratinator adds no destination to it. **Sign in** on a desk runs
Claude Code's own `claude auth login` on that machine, which opens the
browser there (`host/auth.js:1-23, 159`).

**The one outside contact: checking for updates** (issue #40, since
0.10.19). The board asks GitHub whether the branch it follows has a newer
commit: an unauthenticated `GET` of this public repo's last 100 commits on
that branch from `api.github.com`, a compare when this build is not among
them, and the newer build's `package.json` from `raw.githubusercontent.com`
(`src/updates.js:138-139, 229, 246, 253`). Those requests carry no data of
yours. The only thing they say is a user agent naming the build's version
(`src/updates.js:187`), and GitHub sees the address they come from. The
automatic check is **on by default** (`src/updates.js:167`), runs only for a
board in a Docker container, and is due once a day (`src/updates.js:543-558`).
A board the desktop app runs checks nothing at all (`src/updates.js:158, 552`).
Settings (⚙) turns it off, and then only a press of **Check now** contacts
GitHub. The host contacts GitHub only when someone presses **Update**: a
`git fetch` of the public repo over HTTPS (`host/update.js:166, 185`).
**Earlier versions of this file said the server makes no outbound
connections. Since #40 that is false. Do not say it.**

**What the plugin sends**, per hook event (`plugin/hooks/report.mjs:434-486`):
channel, agent, session id, event name, the transcript's *path* on the
workstation, the repo's path on the workstation, permission mode, model
name, git branch, and the event's own fields: the prompt you typed
(`UserPromptSubmit`), the final reply of a turn (`Stop`), the tool name and
one descriptive field (`PreToolUse`, `PermissionRequest`), the subagent's id
when the hook fired inside one, a notification's
type and message, an error's code, details, type and message
(`StopFailure`), the session's effort level, a compaction's trigger (never
its summary), and a model switch's from, to and requested model. Text is
clipped to 20,000
characters (`report.mjs:39`), tool input to the listed keys at 300
characters each (`report.mjs:42, 352`). A `Write` of a file never puts the
file on the wire (`report.mjs:15-17`).

**What the host sends.** The conversation itself, read from Claude Code's
transcript: user, assistant, tool, thinking, context and subagent turns
(`host/claude.js:993-1179`); who holds each desk; and what a desk's Claude
Code asks, as Claude Code sent it (the tool and its input, a question's
words; `host/desk.js:214-222`). On every registration: each desk's folder
and conversation id, the folders under its roots, the Claude Code version
and whether it is signed in, and the host's own build and clone (branch,
HEAD, uncommitted paths) (`host/index.js:312-374`, `host/update.js:157`).
The server clips each turn to 20,000 characters (`src/floor.js:50, 272`).

**What the server stores** (`src/db.js:19-351`): messages, contracts and
their history, tasks, agent presence and status, channel flags, desk flags
(a desk hidden by hand, issue #20), an operator audit log, floor sessions (`agent_sessions`, including the workstation paths
above), turns, agent names and avatars, seats, hosts, hosted desks, the
host work queue, saved prompts, the board's settings (the update check's
on/off and branch, issue #40), the last meeting rooms (which desks and
which conversations, issue #44), which meeting room each desk was last
told it is in (`room_told`), and which desk is a second session of which
agent on a floor (`desk_twins`, 0.12.9; like the meeting rooms, not in a
backup). A file attached to a message is staged on the server's disk, not
in the database, for an hour from attach or last send, until a host fetches
it; it is never served back to a page (`src/uploads.js:1-27, 39`, `src/server.js:419-420`). The host
writes it outside every repo, under `~/.orchestratinator/uploads`, and keeps
it as long as Claude Code keeps its transcripts (`host/uploads.js:1-29`).
A broadcast sent inside a meeting room
carries the room's desks as its `audience` (`src/db.js:394`). Turns are pruned to the newest 400 per
desk (`src/db.js:718`). **Backups exclude `turns` and `agent_sessions`**
(`src/db.js:774-786` lists the eleven tables a backup carries).

**The network boundary.** The shared secret guards `/mcp`, `/api/ingest` and
the host routes, and nothing else (`src/auth.js:29-30, 156`;
`src/floor.js:3403, 3432, 3627, 3680, 3696`). The dashboard has no sign-in at all;
anything that can reach the port can read every message on every channel
and take operator actions. Compose publishes port 8787 on every interface by
default, so by default that is the LAN; one edit makes it loopback only
(`docker-compose.yml:11-18`). `/api/admin/*` refuses cross-site requests and
that is its whole guard (`docs/security.md`, "What guards operator
actions"). The intended shape is one machine, one person, one trusted
network behind a firewall (`docs/security.md:1-7`). `X-Agent` is
self-asserted; anyone holding the key can claim any seat
(`docs/security.md`, "The shared secret").

A statement the page may make, in these words: *Your work stays on your
network. The plugin and the host talk only to the server you run, over the
address in your own config, with a shared secret you generated. Nothing about
your work is sent to us or to anyone else. The one outside contact is a
check of the public GitHub repo for a newer build, which you can turn off.
The dashboard has no login; the network is the boundary.*

Note: `ngrok.sh` at the repo root is a one-line convenience the author uses
to tunnel the board. It is not part of the product, and
`docs/security.md` tells operators not to forward the port through a tunnel.
Do not mention it.

## 5. Requirements

| For | Needs | Where |
| --- | --- | --- |
| The server | Docker and Docker Compose, or Node 24 without Docker | `docker-compose.yml`, `package.json` `engines`, `docs/internals.md:33-50` |
| The plugin | Claude Code (terminal or VS Code extension) and a `node` for the hook: on PATH, or the desktop app's link to its own | `hooks.json:9`, `README.md` step 4 |
| The host | macOS, Node 24, and `claude` on PATH signed in; no tmux | `host/install.sh:75-78`, `host/node.sh:19-38`, `host/package.json` `engines` |
| A desk | a repo with the orchestratinator in its `.mcp.json` or local scope, with `X-Channel` and `X-Agent` | `host/identity.js:8-31`, `plugin/hooks/report.mjs:88-101` |

**VS Code alone, without the `claude` CLI.** Nothing in the *plugin* path
needs the CLI: the hook runs inside whichever Claude Code raised it, and the
host reads every Claude Code process in Claude Code's own roster, a VS Code
session included (`host/claude.js:302-307`), and any on a desk's
conversation that is not the desk's own process reads as held outside the
floor (`host/desk.js:333-334`). The *host* refuses to install without
`claude` on PATH (`host/install.sh:78`), because it runs each desk's Claude
Code with it; without a host the
floor shows what section 2 lists under "plugin". Whether the VS Code
extension itself runs with no CLI installed is Claude Code's fact, not this
repo's, and is **not measured here**. Safe wording: "the host needs Claude
Code's `claude` command; the plugin works from a terminal session or from
VS Code."

## 6. Licence, version, and the install-by-agent path

- **Licence: GPL-3.0-only.** `package.json` `license`, `host/package.json`
  `license`, `LICENSE` (GPLv3 text), README "License" section. No file
  headers; do not add any.
- **Version: 0.15.0** at `d108f3f` (the release that replaced the tmux
  window layer with a process per desk; host and board speak protocol 2,
  `"protocol"` in `package.json` and `host/package.json`), in all three
  places that carry it:
  `package.json`, `host/package.json`, `plugin/.claude-plugin/plugin.json`.
  They are kept equal by `npm run set-version` (`scripts/set-version.mjs`)
  and `npm run smoke` asserts it. The dashboard header reports the server's.
- **The install-by-agent path.** The README opens Install with *"install the
  orchestratinator by following the README"* (`README.md`, "Install"). No
  automated test exercises that path: `test/` has nothing matching it. What
  the repo does record is that the README's six install steps were checked
  against the code rather than memory (`docs/review/README-notes.md`,
  "Round 4"). Whether an agent has run it end to end on a clean machine is
  not written down anywhere in the repo. **Ask Costmo before claiming it is
  tested.** Safe wording until then: "the README is written to be followed
  by an agent."

## 7. README claims to source from here, not from the README

Checked line by line against `ef56655`, plus the platform line added under
Install after it (in the working tree). The top section was rewritten for
0.12.0 (appideas-designer's copy, 2026-11-05). The claims below were read
again against the README at `d108f3f`, where its words for Take a desk and
for what Install needs changed with 0.15.0. Each holds, and each has a
source:

- **"a complete Agentic Development Environment (ADE)"**: positioning, not
  a code fact. What backs it is the list under it.
- **"Answer from one screen… a question is a form"**: section 2's
  Approve / Deny row. The form is built from the question's own words
  (`formFromInput`, CLAUDE.md "A question on the floor").
- **"Take a desk: choose a folder, name the floor and the seat, and its
  Claude Code starts there, already on the board"**: section 2's Take a
  desk row. The README makes no claim about the folder picker: the native
  dialog is macOS's (Windows has one too, not claimed; `host/dialog.js`),
  and a host with none gets a list drawn by the page.
- **"⧉ pops any desk's chat into a window of its own… Re-attach brings it
  back, with whatever you'd typed"**: section 2's popout row.
- **"Check the desks, press Meeting room… `@names` narrows a message"**,
  and the caption's "what its agents broadcast to each other stays in the
  room": section 2's meeting room row, section 3's `send_message` row.
- **"Update in the header rebuilds the server, updates the plugin and
  restarts the host (on macOS, for now)"**: section 2's update row.
- **"The host… runs on macOS for now; the server and the board run
  anywhere Docker does, and the plugin wherever Claude Code has a POSIX
  shell"**: section 1. Say macOS for the host. The plugin's hook is a POSIX
  shell line, measured on macOS, Linux expected, Windows not claimed. **"A desk with no host behind it is still
  on the floor… read there, not typed into"**: section 2, the plugin-only
  rows and `deliverable()`.

Nothing in the README is false at HEAD. Four older points still need care:

- **"A plugin for Claude Code or Visual Studio Code — either one, or both."**
  True, but the page must not call it a VS Code extension. It is one Claude
  Code plugin that both surfaces share (section 1). There is no extension
  listing and no marketplace entry outside this repo.
- **"Open on the Floor."** The button is labelled "Open on the floor"
  (`src/ui/floor.js:78`). Capitalisation only.
- **The VS Code `/plugin` menu behaviour** (README step 4: "the `/plugin`
  command doesn't take arguments… answers *isn't available in this
  environment*") is a statement about Claude Code's extension, not this
  code. It was true when written and is not something this repo can hold
  still. Do not quote it on the page.
- **"Everything here is done once per machine. You need Docker, Node 24,
  and Claude Code (the `claude` command) installed and signed in."** True
  for the whole stack; tmux is no longer in it. The page should
  say which part needs which (section 5), because the server alone needs
  only Docker.

Two README phrasings that hold and are worth keeping verbatim: *"A
conversation is one `claude` process, so one app holds it at a time"*
(`CLAUDE.md`, first rule; enforced by `src/floor.js:418-440`), and *"Nothing
merges, nothing is shared but the board"* (agents never touch each other's
repos; the server holds messages, tasks and contracts and nothing else).

## Not this repo's to answer

- Whether the Claude Code VS Code extension runs without the CLI (section 5).
- Whether the install-by-agent path has been run end to end (section 6).
- Anything about Claude Code's own behaviour quoted in the README (section 7).

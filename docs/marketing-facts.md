# Marketing facts

What the landing page may say about the orchestratinator, checked against the
code. Every fact names the file and line that holds it, at commit `56d04eb`
(branch `develop`, 2026-11-05; first written at `0ce4f1e`, 2026-10-17;
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
changed, nothing else). Cite
this file; do not restate a fact from memory or from the README. Where a
claim did not hold, it is narrowed here or marked **not claimed**. Where the
answer is not this repo's to give, it says whose it is.

Line numbers are for `56d04eb`. A later commit may move them; the file names
will not. `npm run reanchor-facts <old-sha> <new-sha> -- --write` moves every
reference whose line is found once at the new commit and lists the rest.

## 1. The three parts, and where each runs

**The server.** A Node process serving MCP over Streamable HTTP at `/mcp`
and the dashboard page at `/`, with SQLite underneath. Shipped as one Docker
container; `src/` is baked into the image and the database lives in a named
volume. Runs anywhere Docker runs. Without Docker it runs as `npm start` on
Node 20 or later.

- Docker: `Dockerfile:1` (`node:22-bookworm-slim`), `docker-compose.yml:1-44`.
- Transport and tools: `src/server.js:259` (`POST /mcp`), `src/tools.js:28`.
- Node floor: `package.json` `engines.node` `>=20`; `docs/internals.md:33-39`
  for the no-Docker path.
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
  (`report.mjs:25-29`, `report.mjs:97-142`).
- OS: the hook line is POSIX shell plus `node` on PATH (`hooks.json:9`).
  Measured on macOS only. Linux is expected to work and is **not measured**.
  Windows is **not claimed**.

**The host.** A Node service on each workstation that runs desks' Claude Code
windows in one tmux session, tails their transcripts to the server, and does
what the floor asks: deliver a message, answer a prompt, stop a turn, open a
window, open the editor or a terminal. It has no npm dependencies. It only
ever reaches out; the server never connects to a workstation and nothing on
the workstation listens.

- Purpose and the reach-out rule: `host/index.js:1-36`.
- Zero dependencies: `host/package.json` (`"dependencies": {}`),
  `host/install.sh:91-93`.
- Requirements enforced by the installer: `tmux` (`host/install.sh:26-35`),
  `node` and a `claude` on PATH (`host/install.sh:63-65`).
- **OS: macOS.** The installer writes a LaunchAgent (`host/install.sh:6,19`).
  "Open in VS Code" uses macOS `open -a` (`host/window.js:3083`); "Open in
  Claude" and "Open in tmux" drive Terminal.app or iTerm through `osascript`
  (`host/window.js:3104-3128, 3195`); the folder dialog has a macOS backend
  and no other, by ruling (`host/dialog.js:1-50, 99-101`). The host's core
  loop is portable Node, but no other platform is installed, measured or
  claimed. Say "macOS" for the host.

## 2. What the floor shows per desk, and which part each needs

The server's own state (MCP tables) needs neither plugin nor host. The plugin
adds *state* from inside the session. The host adds the full conversation and
every action that types into a window. The decider on the server is one
function, `deliverable()` (`src/floor.js:299-314`): no host, host offline, or
conversation open in an editor means nothing can be typed in.

| Shown on the desk | Needs | Where |
| --- | --- | --- |
| Status word, detail line, age, TTL expiry | nothing beyond the MCP tools | `src/tools.js:54-75`, `src/agent-state.js:56-139` |
| Tray: unread, assigned, claimed counts; derived state when no status is set | nothing beyond the MCP tools | `src/agent-state.js:102-139, 221` |
| Needs-you badge and the ranked "Needs you" queue | plugin (PermissionRequest / Notification hook sets `awaiting_kind`) | `src/floor.js:1232-1279`, `src/floor.js:2377-2402`, `src/db.js:134-139` |
| Permission prompt text, the tool asking | plugin | `src/floor.js:1232-1244` |
| Approve / Deny / the question's own choices | host, and only when the floor holds the window; editor-held prompts say "answer this in your editor" | `src/floor.js:2395-2400`, `src/ui/floor.js:4152-4153`, `host/index.js:1306-1466` |
| Live conversation, partial: the typed prompt, the final reply, each tool call as it starts | plugin alone, used only when no host is tailing that desk | `src/floor.js:1069-1080, 1201-1222` |
| Live conversation, complete: every reply, every tool call, subagent turns labelled by description, injected context as labelled lines | host (reads Claude Code's transcript) | `host/window.js:3644, 3596-3782` |
| The window compacting, from its start to its end, and a message sent meanwhile held rather than timed out; a compaction the hooks never finish ends on the window's next prompt, turn or tool, and a `/compact` from the floor is watched to its end and said in the window's closing words ("Compacted…", or "no compaction ran") | plugin (`PreCompact` / `PostCompact`) for the state; host for the held message, the summary (drawn as a system record) and the watched end | `src/floor.js:1168-1177`, `host/window.js:1267` |
| The model and effort level, what was asked for beside what the window confirmed; a change from the floor is this session only, through the window's own picker | plugin (`PreModelSwitch` / `PostModelSwitch`, `effort_level`); host (the picker, the transcript's next reply) | `src/floor.js:1187-1199, 1966`, `host/window.js:2095` |
| A slash command from the composer, confirmed on the command's own receipt and said in its terms as one line labelled `host` ("/model opus — Set model to Opus 5.5 for this session only"); a `/clear` shows the new session at once with the model and effort the window keeps; a long message typed in so the window never wraps it | host | `src/floor.js:189, 1921`, `host/window.js:1413, 1224, 1498, 3566` |
| Thinking, drawn as a thought bubble | host | `host/window.js:3766-3767` |
| Service bell (nudge) | host; a desk with no window gets its window opened first | `src/floor.js:363`, `src/ui/floor.js:1520-1533` |
| Typing to a desk, Enter sends, stop interrupts | host, floor-held | `src/floor.js:299`, `host/index.js:1303, 1485` |
| Open in VS Code | host (macOS) | `host/index.js:1488`, `host/window.js:3071-3087` |
| Open in Claude, Open in tmux | host (macOS) | `host/index.js:1543-1554`, `host/window.js:3167` |
| Take a desk (bind a folder from the floor, no `.mcp.json` by hand) | host | `src/floor.js:3150`, `host/dialog.js` |
| Move an agent to another floor from its nameplate card — only the floor is picked, the desk's own folder and host do the rest; a move that closes its window opens a new conversation there, one with no window open resumes its last; it lands on the new floor drawn, even a floor it left before | host | `src/floor.js:3212, 1665`, `src/ui/floor.js:619`, `host/index.js:900` |
| Several desks at once: select desks on a room, check them, and nudge, mark read or hide them together — desks with a window are nudged before those that must open one, a desk that cannot be nudged is named with the reason, and each desk shows what happened to it | host for the nudge; mark read and hide need nothing beyond the board | `src/ui/floor.js:2767, 2388, 2431, 7011` |
| A desk's chat in a window of its own (⧉): the whole panel, live, beside the floor, several at once on one shared stream; it follows its desk to another floor, survives a floor reload, and Re-attach brings it back with whatever was typed | host to type into it; reading needs only what the floor's panel needs | `src/ui/floor.js:5094`, `src/ui/floor.js:3233`, `src/ui/hub.js:1-20` |
| A meeting room: several desks of one floor in one window, one composer, `@names` at the start narrowing a message to some of them, each desk's delivery under the message, and while the room is open its desks' broadcasts reach the room and nobody else on the floor (a direct message still goes where it is addressed) | host for each desk's delivery; the containment is the board's | `src/ui/floor.js:5982, 4807, 4643`, `src/floor.js:3706, 3733`, `src/db.js:582, 696, 918, 1736` |
| Update from the page: the header says a newer build is on the followed branch (`main`, or `develop` in Settings); Update has the host beside the board fetch it, rebuild the server, update the plugin when its hooks changed and restart itself, and the page reloads onto it; refused in words for a dirty clone, another branch, local commits, or a host not under launchd | host on the board's own machine, **macOS** (launchd restarts it) | `src/updates.js:1-34, 103-116, 147`, `host/update.js:88` |
| Recent conversations, search, read a conversation whole | host | `host/history.js:1-37`, `host/index.js:1525-1537` |
| Tool calls on the plugin path carry only one descriptive field (command, path, pattern, description, prompt, url), clipped to 300 characters | plugin | `plugin/hooks/report.mjs:42, 267-290` |

Two honest limits worth not contradicting on the page:

- Nothing is inferred from silence. A desk reads "needs you" only because
  Claude Code raised a prompt; a quiet desk is drawn quiet
  (`docs/operating.md`, "Nothing on the floor is inferred from silence";
  `src/agent-state.js:102-139`). Since 0.10.8 a desk with nothing live
  behind it — no session reporting, no host, or the host offline — is not
  drawn at all, and comes back on its own when something is; the storey
  still counts it in `N/M here` (`src/ui/floor.js:2242, 2254-2261`, issue #20).
  Do not say "a desk for every agent": say every agent with something
  running has one.
- The floor is a live tail, not an archive: the newest 400 turns per desk
  (`TURN_RETENTION`, `src/db.js:606`). History is read off the hosts'
  transcripts, not the server (`host/history.js`).

## 3. The ten MCP tools

All ten are registered in `src/tools.js`; the one-liners below are from the
descriptions in that file.

| Tool | One line | Line |
| --- | --- | --- |
| `whoami` | Report the channel and agent bound to this connection and who is present on the channel. | `src/tools.js:35` |
| `set_status` | Declare working / waiting / blocked / idle with a detail line and a TTL; shows on the dashboard, nothing reads it back. | `src/tools.js:54` |
| `send_message` | Post to the channel; omit `to` to broadcast, name an agent to direct-message. While the operator has the sender in a meeting room, a broadcast reaches only the room's other desks, and the reply names them. | `src/tools.js:77-104` |
| `poll_messages` | Fetch messages addressed to you newer than `since`; returns a cursor. | `src/tools.js:106` |
| `set_contract` | Create or update a shared interface entry by key; bumps the version and records history. | `src/tools.js:128` |
| `get_contract` | Read one contract entry by key, or every entry on the channel. | `src/tools.js:145` |
| `open_task` | Open a task on the channel, optionally assigned to an agent. | `src/tools.js:165` |
| `list_tasks` | List tasks by status and/or mine; stale claims reopen on an actionable listing. | `src/tools.js:183` |
| `claim_task` | Claim an open task so others know you have it. | `src/tools.js:205` |
| `complete_task` | Mark a task done with an optional note. | `src/tools.js:221` |

Claim TTL defaults to 15 minutes (`docker-compose.yml:34`); status TTL to
900 seconds (`docker-compose.yml:36`, `src/tools.js:62-63`).

## 4. What leaves the machine

**Where it goes.** Everything goes to one place: the server named in the
repo's own binding (`url` in `.mcp.json`), on the same origin as `/mcp`.
The plugin posts to `<that origin>/api/ingest`
(`plugin/hooks/report.mjs:242-253, 340`); the host talks to
`<that origin>/api/host/*` (`host/index.js:608, 613`). Nothing about your
work goes anywhere else: no message, task, contract, turn, path or prompt is
sent to any third party.

**The one outside contact: checking for updates** (issue #40, since
0.10.19). The board asks GitHub whether the branch it follows has a newer
commit: an unauthenticated `GET` of this public repo's last 100 commits on
that branch from `api.github.com`, a compare when this build is not among
them, and the newer build's `package.json` from `raw.githubusercontent.com`
(`src/updates.js:126-127, 209, 226, 233`). Those requests carry no data of
yours. The only thing they say is a user agent naming the build's version
(`src/updates.js:167`), and GitHub sees the address they come from. The
automatic check is **on by default** (`src/updates.js:147`), runs only for a
board in a Docker container, and is due once a day (`src/updates.js:515-530`).
Settings (⚙) turns it off, and then only a press of **Check now** contacts
GitHub. The host contacts GitHub only when someone presses **Update**: a
`git fetch` of the public repo over HTTPS (`host/update.js:133, 151`).
**Earlier versions of this file said the server makes no outbound
connections. Since #40 that is false. Do not say it.**

**What the plugin sends**, per hook event (`plugin/hooks/report.mjs:343-391`):
channel, agent, session id, event name, the transcript's *path* on the
workstation, the repo's path on the workstation, permission mode, model
name, git branch, and the event's own fields: the prompt you typed
(`UserPromptSubmit`), the final reply of a turn (`Stop`), the tool name and
one descriptive field (`PreToolUse`, `PermissionRequest`), a notification's
type and message, an error's code, details, type and message
(`StopFailure`), the session's effort level, a compaction's trigger (never
its summary), and a model switch's from, to and requested model. Text is
clipped to 20,000
characters (`report.mjs:39`), tool input to the listed keys at 300
characters each (`report.mjs:42, 271`). A `Write` of a file never puts the
file on the wire (`report.mjs:15-17`).

**What the host sends.** The conversation itself, read from Claude Code's
transcript: user, assistant, tool, thinking, context and subagent turns
(`host/window.js:3596-3782`), plus who holds each desk and what its pane
shows when a prompt is open. The server clips each turn to 20,000 characters
(`src/floor.js:50, 211`).

**What the server stores** (`src/db.js:19-302`): messages, contracts and
their history, tasks, agent presence and status, channel flags, desk flags
(a desk hidden by hand, issue #20), an operator audit log, floor sessions (`agent_sessions`, including the workstation paths
above), turns, agent names and avatars, seats, hosts, hosted desks, the
host work queue, saved prompts, the board's settings (the update check's
on/off and branch, issue #40), and the last meeting rooms (which desks and
which conversations, issue #44). A broadcast sent inside a meeting room
carries the room's desks as its `audience` (`src/db.js:346`). Turns are pruned to the newest 400 per
desk (`src/db.js:606`). **Backups exclude `turns` and `agent_sessions`**
(`src/db.js:662-674` lists the eleven tables a backup carries).

**The network boundary.** The shared secret guards `/mcp`, `/api/ingest` and
the host routes, and nothing else (`src/auth.js:29-30, 156`;
`src/floor.js:2662, 2687, 2807, 2833`). The dashboard has no sign-in at all;
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
| The server | Docker and Docker Compose, or Node 20+ without Docker | `docker-compose.yml`, `package.json` `engines`, `docs/internals.md:33-39` |
| The plugin | Claude Code (terminal or VS Code extension) and `node` on PATH for the hook | `hooks.json:9`, `README.md` step 4 |
| The host | macOS, Node 20+, `tmux`, and `claude` on PATH signed in | `host/install.sh:26-35, 63-65`, `host/package.json` `engines` |
| A desk | a repo with the orchestratinator in its `.mcp.json` or local scope, with `X-Channel` and `X-Agent` | `host/identity.js:7-30`, `plugin/hooks/report.mjs:67-80` |

**VS Code alone, without the `claude` CLI.** Nothing in the *plugin* path
needs the CLI: the hook runs inside whichever Claude Code raised it, and the
host's roster recognises VS Code sessions as editor-held (`host/window.js:248, 359, 390`). The *host* refuses to install without `claude` on PATH
(`host/install.sh:65`), because it opens desks with it; without a host the
floor shows what section 2 lists under "plugin". Whether the VS Code
extension itself runs with no CLI installed is Claude Code's fact, not this
repo's, and is **not measured here**. Safe wording: "the host needs Claude
Code's `claude` command; the plugin works from a terminal session or from
VS Code."

## 6. Licence, version, and the install-by-agent path

- **Licence: GPL-3.0-only.** `package.json` `license`, `host/package.json`
  `license`, `LICENSE` (GPLv3 text), README "License" section. No file
  headers; do not add any.
- **Version: 0.12.2** at `56d04eb` (0.12.1 and 0.12.2 are docs releases on
  top of 0.12.0), in all three places that carry it:
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
0.12.0 (appideas-designer's copy, 2026-11-05). Each claim it adds holds, and
each has a source:

- **"a complete Agentic Development Environment (ADE)"**: positioning, not
  a code fact. What backs it is the list under it.
- **"Answer from one screen… a question is a form"**: section 2's
  Approve / Deny row. The form is built from the question's own words
  (`formFromInput`, CLAUDE.md "A question on the floor").
- **"Take a desk: choose a folder, name the floor and the seat, and a
  window opens there"**: section 2's Take a desk row. The README makes no
  claim about the folder picker: the native dialog is macOS only
  (`host/dialog.js`), and a host with none gets a list drawn by the page.
- **"⧉ pops any desk's chat into a window of its own… Re-attach brings it
  back, with whatever you'd typed"**: section 2's popout row.
- **"Check the desks, press Meeting room… `@names` narrows a message"**,
  and the caption's "what its agents broadcast to each other stays in the
  room": section 2's meeting room row, section 3's `send_message` row.
- **"Update in the header rebuilds the server, updates the plugin and
  restarts the host (on macOS, for now)"**: section 2's update row.
- **"The host… runs on macOS for now; the server and the board run
  anywhere Docker does, and the plugin wherever Claude Code has a POSIX
  shell"**: section 1. The host is macOS-only. The plugin's hook is a POSIX
  shell line, measured on macOS, Linux expected, Windows not claimed. **"A desk with no host behind it is still
  on the floor… read there, not typed into"**: section 2, the plugin-only
  rows and `deliverable()`.

Nothing in the README is false at HEAD. Four older points still need care:

- **"A plugin for Claude Code or Visual Studio Code — either one, or both."**
  True, but the page must not call it a VS Code extension. It is one Claude
  Code plugin that both surfaces share (section 1). There is no extension
  listing and no marketplace entry outside this repo.
- **"Open on the Floor."** The button is labelled "Open on the floor"
  (`src/ui/floor.js:71`). Capitalisation only.
- **The VS Code `/plugin` menu behaviour** (README step 4: "the `/plugin`
  command doesn't take arguments… answers *isn't available in this
  environment*") is a statement about Claude Code's extension, not this
  code. It was true when written and is not something this repo can hold
  still. Do not quote it on the page.
- **"Everything here is done once per machine. You need Docker, tmux,
  Node 20+, and Claude Code."** True for the whole stack. The page should
  say which part needs which (section 5), because the server alone needs
  only Docker.

Two README phrasings that hold and are worth keeping verbatim: *"A
conversation is one `claude` process, so one app holds it at a time"*
(`CLAUDE.md`, first rule; enforced by `src/floor.js:299-314`), and *"Nothing
merges, nothing is shared but the board"* (agents never touch each other's
repos; the server holds messages, tasks and contracts and nothing else).

## Not this repo's to answer

- Whether the Claude Code VS Code extension runs without the CLI (section 5).
- Whether the install-by-agent path has been run end to end (section 6).
- Anything about Claude Code's own behaviour quoted in the README (section 7).

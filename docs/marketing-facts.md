# Marketing facts

What the landing page may say about the orchestratinator, checked against the
code. Every fact names the file and line that holds it, at commit `c6f9474`
(branch `develop`, 2026-11-02; first written at `0ce4f1e`, 2026-10-17, and
re-anchored line by line — sixteen references had moved, none had changed). Cite
this file; do not restate a fact from memory or from the README. Where a
claim did not hold, it is narrowed here or marked **not claimed**. Where the
answer is not this repo's to give, it says whose it is.

Line numbers are for `c6f9474`. A later commit may move them; the file names
will not.

## 1. The three parts, and where each runs

**The server.** A Node process serving MCP over Streamable HTTP at `/mcp`
and the dashboard page at `/`, with SQLite underneath. Shipped as one Docker
container; `src/` is baked into the image and the database lives in a named
volume. Runs anywhere Docker runs. Without Docker it runs as `npm start` on
Node 20 or later.

- Docker: `Dockerfile:1` (`node:22-bookworm-slim`), `docker-compose.yml:1-39`.
- Transport and tools: `src/server.js:212` (`POST /mcp`), `src/tools.js:28`.
- Node floor: `package.json` `engines.node` `>=20`; `docs/internals.md:27-33`
  for the no-Docker path.
- Dashboard and floor pages: `src/ui/index.html`, `src/ui/app.js`,
  `src/ui/floor.js`.

**The plugin.** A Claude Code plugin named `orchestratinator-floor`, served
from this repo's own marketplace. It is only hooks: eight Claude Code hook
events, each running one detached Node script that posts the session's state
to the server. It has no UI and no settings. There is **no VS Code extension
of our own**; "VS Code" here means Claude Code's own VS Code extension, which
shares plugin installs with the terminal `claude`. One install covers both.

- Manifest: `plugin/.claude-plugin/plugin.json`; marketplace
  `.claude-plugin/marketplace.json:9-16` (`source: ./plugin`).
- The eight events: `plugin/hooks/hooks.json:4-91` — SessionStart,
  SessionEnd, UserPromptSubmit, PreToolUse, PermissionRequest, Notification,
  Stop, StopFailure. All eight run the identical command line.
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
  "Open in VS Code" uses macOS `open -a` (`host/window.js:2366`); "Open in
  Claude" and "Open in tmux" drive Terminal.app or iTerm through `osascript`
  (`host/window.js:2387-2411, 2478`); the folder dialog has a macOS backend
  and no other, by ruling (`host/dialog.js:1-50, 99-101`). The host's core
  loop is portable Node, but no other platform is installed, measured or
  claimed. Say "macOS" for the host.

## 2. What the floor shows per desk, and which part each needs

The server's own state (MCP tables) needs neither plugin nor host. The plugin
adds *state* from inside the session. The host adds the full conversation and
every action that types into a window. The decider on the server is one
function, `deliverable()` (`src/floor.js:254-269`): no host, host offline, or
conversation open in an editor means nothing can be typed in.

| Shown on the desk | Needs | Where |
| --- | --- | --- |
| Status word, detail line, age, TTL expiry | nothing beyond the MCP tools | `src/tools.js:54-75`, `src/agent-state.js:56-139` |
| Tray: unread, assigned, claimed counts; derived state when no status is set | nothing beyond the MCP tools | `src/agent-state.js:102-139, 221` |
| Needs-you badge and the ranked "Needs you" queue | plugin (PermissionRequest / Notification hook sets `awaiting_kind`) | `src/floor.js:1039-1086`, `src/floor.js:2026-2051`, `src/db.js:119-124` |
| Permission prompt text, the tool asking | plugin | `src/floor.js:1039-1051` |
| Approve / Deny / the question's own choices | host, and only when the floor holds the window; editor-held prompts say "answer this in your editor" | `src/floor.js:2044-2049`, `src/ui/floor.js:2714-2715`, `host/index.js:1154-1298` |
| Live conversation, partial: the typed prompt, the final reply, each tool call as it starts | plugin alone, used only when no host is tailing that desk | `src/floor.js:944-956, 1008-1037` |
| Live conversation, complete: every reply, every tool call, subagent turns labelled by description, injected context as labelled lines | host (reads Claude Code's transcript) | `host/window.js:2906, 2964-3026` |
| Thinking, drawn as a thought bubble | host | `host/window.js:2993-2994` |
| Service bell (nudge) | host; a desk with no window gets its window opened first | `src/floor.js:295`, `src/ui/floor.js:1168-1181` |
| Typing to a desk, Enter sends, stop interrupts | host, floor-held | `src/floor.js:254`, `host/index.js:1151, 1317` |
| Open in VS Code | host (macOS) | `host/index.js:1320`, `host/window.js:2354-2370` |
| Open in Claude, Open in tmux | host (macOS) | `host/index.js:1375-1386`, `host/window.js:2450` |
| Take a desk (bind a folder from the floor, no `.mcp.json` by hand) | host | `src/floor.js:2722`, `host/dialog.js` |
| Recent conversations, search, read a conversation whole | host | `host/history.js:1-37`, `host/index.js:1357-1369` |
| Tool calls on the plugin path carry only one descriptive field (command, path, pattern, description, prompt, url), clipped to 300 characters | plugin | `plugin/hooks/report.mjs:42, 267-290` |

Two honest limits worth not contradicting on the page:

- Nothing is inferred from silence. A desk reads "needs you" only because
  Claude Code raised a prompt; a quiet desk is drawn quiet
  (`docs/operating.md`, "Nothing on the floor is inferred from silence";
  `src/agent-state.js:102-139`).
- The floor is a live tail, not an archive: the newest 400 turns per desk
  (`TURN_RETENTION`, `src/db.js:509`). History is read off the hosts'
  transcripts, not the server (`host/history.js`).

## 3. The ten MCP tools

All ten are registered in `src/tools.js`; the one-liners below are from the
descriptions in that file.

| Tool | One line | Line |
| --- | --- | --- |
| `whoami` | Report the channel and agent bound to this connection and who is present on the channel. | `src/tools.js:35` |
| `set_status` | Declare working / waiting / blocked / idle with a detail line and a TTL; shows on the dashboard, nothing reads it back. | `src/tools.js:54` |
| `send_message` | Post to the channel; omit `to` to broadcast, name an agent to direct-message. | `src/tools.js:77` |
| `poll_messages` | Fetch messages addressed to you newer than `since`; returns a cursor. | `src/tools.js:94` |
| `set_contract` | Create or update a shared interface entry by key; bumps the version and records history. | `src/tools.js:116` |
| `get_contract` | Read one contract entry by key, or every entry on the channel. | `src/tools.js:133` |
| `open_task` | Open a task on the channel, optionally assigned to an agent. | `src/tools.js:153` |
| `list_tasks` | List tasks by status and/or mine; stale claims reopen on an actionable listing. | `src/tools.js:171` |
| `claim_task` | Claim an open task so others know you have it. | `src/tools.js:193` |
| `complete_task` | Mark a task done with an optional note. | `src/tools.js:209` |

Claim TTL defaults to 15 minutes (`docker-compose.yml:29`); status TTL to
900 seconds (`docker-compose.yml:31`, `src/tools.js:62-63`).

## 4. What leaves the machine

**Where it goes.** Everything goes to one place: the server named in the
repo's own binding (`url` in `.mcp.json`), on the same origin as `/mcp`.
The plugin posts to `<that origin>/api/ingest`
(`plugin/hooks/report.mjs:242-253, 340`); the host talks to
`<that origin>/api/host/*` (`host/index.js:520`). There is no other network
destination in the server, the plugin or the host: the only `fetch` calls
are those two, and no third-party URL appears in `src/`, `host/` or
`plugin/`. **Nothing goes to any third party.** The server itself makes no
outbound connections.

**What the plugin sends**, per hook event (`plugin/hooks/report.mjs:343-369`):
channel, agent, session id, event name, the transcript's *path* on the
workstation, the repo's path on the workstation, permission mode, model
name, git branch, and the event's own fields: the prompt you typed
(`UserPromptSubmit`), the final reply of a turn (`Stop`), the tool name and
one descriptive field (`PreToolUse`, `PermissionRequest`), a notification's
type and message, an error's type and message. Text is clipped to 20,000
characters (`report.mjs:39`), tool input to the listed keys at 300
characters each (`report.mjs:42, 271`). A `Write` of a file never puts the
file on the wire (`report.mjs:15-17`).

**What the host sends.** The conversation itself, read from Claude Code's
transcript: user, assistant, tool, thinking, context and subagent turns
(`host/window.js:2906-3026`), plus who holds each desk and what its pane
shows when a prompt is open. The server clips each turn to 20,000 characters
(`src/floor.js:50, 170`).

**What the server stores** (`src/db.js:20-245`): messages, contracts and
their history, tasks, agent presence and status, channel flags, an operator
audit log, floor sessions (`agent_sessions`, including the workstation paths
above), turns, agent names and avatars, seats, hosts, hosted desks, the
host work queue, and saved prompts. Turns are pruned to the newest 400 per
desk (`src/db.js:509`). **Backups exclude `turns` and `agent_sessions`**
(`src/db.js:565-576` lists the ten tables a backup carries).

**The network boundary.** The shared secret guards `/mcp`, `/api/ingest` and
the host routes, and nothing else (`src/auth.js:29-30, 156`;
`src/floor.js:2285, 2310, 2427, 2453`). The dashboard has no sign-in at all;
anything that can reach the port can read every message on every channel
and take operator actions. Compose publishes port 8787 on every interface by
default, so by default that is the LAN; one edit makes it loopback only
(`docker-compose.yml:6-13`). `/api/admin/*` refuses cross-site requests and
that is its whole guard (`docs/security.md`, "What guards operator
actions"). The intended shape is one machine, one person, one trusted
network behind a firewall (`docs/security.md:1-7`). `X-Agent` is
self-asserted; anyone holding the key can claim any seat
(`docs/security.md`, "The shared secret").

A statement the page may make, in these words: *Everything stays on your
network. The plugin and the host talk only to the server you run, over the
address in your own config, with a shared secret you generated. The server
makes no outbound connections and nothing is sent to us or to anyone else.
The dashboard has no login; the network is the boundary.*

Note: `ngrok.sh` at the repo root is a one-line convenience the author uses
to tunnel the board. It is not part of the product, and
`docs/security.md` tells operators not to forward the port through a tunnel.
Do not mention it.

## 5. Requirements

| For | Needs | Where |
| --- | --- | --- |
| The server | Docker and Docker Compose, or Node 20+ without Docker | `docker-compose.yml`, `package.json` `engines`, `docs/internals.md:27-33` |
| The plugin | Claude Code (terminal or VS Code extension) and `node` on PATH for the hook | `hooks.json:9`, `README.md` step 4 |
| The host | macOS, Node 20+, `tmux`, and `claude` on PATH signed in | `host/install.sh:26-35, 63-65`, `host/package.json` `engines` |
| A desk | a repo with the orchestratinator in its `.mcp.json` or local scope, with `X-Channel` and `X-Agent` | `host/identity.js:7-30`, `plugin/hooks/report.mjs:67-80` |

**VS Code alone, without the `claude` CLI.** Nothing in the *plugin* path
needs the CLI: the hook runs inside whichever Claude Code raised it, and the
host's roster recognises VS Code sessions as editor-held (`host/window.js:240,
351, 382`). The *host* refuses to install without `claude` on PATH
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
- **Version: 0.10.6** at `c6f9474`, in all three places that carry it:
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

Checked line by line against `c6f9474` (the README is byte-identical to its
`0ce4f1e` text, where it was first checked). Nothing in the README is false at
HEAD. Four things need care:

- **"A plugin for Claude Code or Visual Studio Code — either one, or both."**
  True, but the page must not call it a VS Code extension. It is one Claude
  Code plugin that both surfaces share (section 1). There is no extension
  listing and no marketplace entry outside this repo.
- **"Open on the Floor."** The button is labelled "Open on the floor"
  (`src/ui/floor.js:62`). Capitalisation only.
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
(`CLAUDE.md`, first rule; enforced by `src/floor.js:254-269`), and *"Nothing
merges, nothing is shared but the board"* (agents never touch each other's
repos; the server holds messages, tasks and contracts and nothing else).

## Not this repo's to answer

- Whether the Claude Code VS Code extension runs without the CLI (section 5).
- Whether the install-by-agent path has been run end to end (section 6).
- Anything about Claude Code's own behaviour quoted in the README (section 7).

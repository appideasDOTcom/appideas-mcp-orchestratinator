# Adding a desk from the floor

An analysis, not a feature. Written 2026-09-08 against Claude Code 2.1.258,
before anything was built, so the effort and the risks below are what the
measurements say and not what the code has since become. The earlier design
notes for this idea are not in the repo; when they turn up, fold them in here.

## The ask

The people running floors say the same thing in the same words: *"why can't I
click a plus sign on a floor, type an agent name, and have the agent show up at
a new desk?"* — and its sibling, *move this agent to that other floor*. Today
both mean opening a repo's `.mcp.json` in an editor, changing `X-Channel` or
`X-Agent`, and then sitting through Claude Code's "New MCP server found in this
project" dialog because re-pointing the file invalidates the old approval. That
is a programmer's chore in the middle of a manager's workflow, which is
precisely the thing the floor exists to remove.

## What a desk is made of today

Three readers, one file. A repo is a desk because its `.mcp.json` carries
`X-Channel` and `X-Agent`, and all three parts of the system learn that from
the file itself:

| who reads it | why | where |
|---|---|---|
| Claude Code | to connect to `/mcp` with those headers | project scope, `.mcp.json` in the repo root |
| the plugin hook | to know which desk a hook event belongs to, and the key to post it with | `findIdentity` in [`plugin/hooks/report.mjs`](../plugin/hooks/report.mjs), walking up from cwd |
| the host | to know which directories under its roots are desks | `discoverDesks` in [`host/identity.js`](../host/identity.js) |

And one dialog that is not about the file at all: a directory Claude Code has
never opened asks the folder-trust question. The floor already reads that off
the pane and offers it as a prompt (`startupQuestionOf` in
[`host/window.js`](../host/window.js)), so it is a click, not a blocker.

So "no file to edit" means moving all three readers to a different source of
truth, and the candidate has to be one Claude Code itself honours — otherwise
the agent connects as one identity while the floor files it under another.

## What was measured

Claude Code has three places a server can be declared, and the documentation
says only one of them asks for approval: project scope (`.mcp.json`) prompts in
interactive sessions; local scope and user scope (both in `~/.claude.json`) and
`--mcp-config` on the command line do not. That claim decides the whole
feature, so it was measured rather than believed — on a throwaway server
(`127.0.0.1:8899`, its own database) and a throwaway tmux socket (`-L probe`),
never the operator's board, with the `CLAUDE*` environment stripped so the
window was not a nested one. Every "whoami" below is the real MCP tool answering
inside the window, checked against the throwaway board's `/api/state`.

| route | where the binding lives | trust dialog | MCP approval dialog | `whoami` | notes |
|---|---|---|---|---|---|
| `claude mcp add -s local --transport http orchestratinator <url> -H X-Channel… -H X-Agent… -H X-Orchestratinator-Key…` | `~/.claude.json` → `projects["<dir>"].mcpServers.orchestratinator` | yes — a new directory | **no** | bound as declared; on the board before the window's first turn | non-interactive, exit 0, prints the file it modified; `claude mcp get orchestratinator` reports it as local scope and *Connected* |
| the switch: `claude mcp remove -s local orchestratinator`, then `add` with the new `X-Channel`, then `claude --resume <session id>` | same | no | **no** | the **new** channel | the same transcript file carried on — both answers in one `.jsonl`, 53 records; ready in 1s. `add` on a name that exists is refused (`already exists in local config`, exit 1), so a switch is remove-then-add |
| `claude --mcp-config <file.json>` | nowhere on disk for that directory (`mcpServers: {}` in its project entry) | yes — a new directory | **no** | bound as declared | good for a window the host launches; invisible to a VS Code session in the same folder and to the hook |

Two more facts from the same windows:

- `claude agents --json` lists a local-scope window exactly like any other
  (pid, cwd, session id), so `holderOf`, the relay and the transcript tail are
  untouched by where the binding lives.
- The plugin hook reported **nothing** for these desks — `reporting: false`,
  no session row on the throwaway floor — because `findIdentity` looks only for
  `.mcp.json`. Expected, and it is the one part of the plugin this feature has
  to change. Without it a desk bound this way relays its conversation but
  never shows a permission prompt, which is the "answering a question nobody
  could see being asked" failure in a new coat.

Two routes considered and set aside:

- **`${ORCH_CHANNEL}` expansion inside `.mcp.json`.** Claude Code expands
  `${VAR}` in `headers`, so a repo could carry one fixed file and take its
  channel from the environment. But the file still has to be in the repo, a
  VS Code session has no such environment, and the host and the hook read the
  file literally and would see the unexpanded text. It moves the edit; it does
  not remove it.
- **`--mcp-config` as the primary.** Zero writes to disk, which is attractive,
  but the binding then exists only in the process the host launched. "Open in
  VS Code" would hand the conversation to a window with no board on it, and
  the hook could not learn the desk from disk. Worth keeping as a fallback for
  a floor-opened window if the local-scope write ever fails; not the design.

## The design that falls out

**Local scope, written by the host, through Claude Code's own CLI.** Four
reasons, and each one is a failure mode avoided rather than a preference:

1. **It is Claude Code's feature, not a scraped dialog.** `claude mcp add` is
   documented, non-interactive, and versioned with the binary. Nothing here
   presses keys at a screen.
2. **It is on disk, so all three readers can find it.** The host and the hook
   read one well-known file by directory; a VS Code session in that folder
   loads the same entry (documented; *not yet measured* — see the risks).
3. **The secret never crosses from the board to the host.** The host already
   holds the token (`cfg.token`, from `host.json` or the first desk it found)
   and writes it itself. The board sends a channel, an agent and a choice of
   directory; it never sends a key.
4. **It takes the key out of the repo tree.** `.mcp.json` is gitignored here,
   but a zip is not git: on 2026-08-27 a plugin build shipped with its
   `.mcp.json`, live key inside, and another agent caught it. A binding in
   `~/.claude.json` cannot be packaged with a repo by accident.

End to end:

1. **Floor.** A `+` in the room's header band. The dialog asks for the agent
   name (a slug, the same rule `X-Agent` follows today) and *where*: a list
   the host reports of directories under its roots that are not yet desks, or
   "a new folder under `<root>`" for an agent that needs no checkout — a
   coordinator, a reviewer. Persona and avatar go through the profile editor
   that already exists; nothing new there.
2. **Server.** `POST /api/floor/desk` behind `adminGuard`, like every other
   floor action: validate the names, refuse a channel/agent pair that already
   has a desk, `ensurePersona` so the desk is drawn at once (as *not hosted*,
   which `buildFloor` already knows how to draw), enqueue a `bind` work item
   for the host that reported the directory.
3. **Host.** `bind` → canonicalise the directory and refuse anything outside
   the roots → `claude mcp add -s local …` with `cwd` set to it → `rescan()`
   (which must now read local scope too) → `register()`, so the desk turns
   *hosted* in this tick → optionally the existing `open`, whose trust prompt
   surfaces on the floor as it does today.
4. **Move.** `POST /api/floor/desk/move` → the host runs remove-then-add. If
   the floor holds a window there, close it and reopen with `--resume`
   (measured to continue the conversation). If the editor holds it, refuse
   with the same words `handback` uses — one app holds a conversation, and the
   editor's process would keep the old headers until it restarts. If the desk
   is mid-turn, refuse rather than kill the turn.
5. **Remove a desk** is the same route backwards, and it should be offered:
   a binding that can only be made from the floor and only unmade in a file is
   the old problem with a new front.

What does not change: one conversation per desk; the trust question stays the
person's and is never pressed for them; `.mcp.json` keeps working, so nothing
already bound has to move.

## Effort

Sized by the seam, with what drives each. S is an afternoon, M is a day or two.

| piece | size | what it is |
|---|---|---|
| `host/identity.js` | S | read `~/.claude.json` (honouring `CLAUDE_CONFIG_DIR`) beside the `.mcp.json` walk; local wins over project, which is Claude Code's own precedence |
| `host/index.js` | M | `bind`, `move`, `unbind` work kinds; a list of candidate directories in `register()`; every bind logged, because a window opened in a folder the operator did not name is the kind of surprise this host is built not to spring |
| `plugin/hooks/report.mjs` | S–M | `findIdentity` also answers from local scope for the session's root; the plugin suite gains the "bound in local scope" and "both files present" cases. Ships through the plugin path (`set-version`, `claude plugin update`, handoff) |
| `src/floor.js` | M | three routes, name validation, the `bind`/`move`/`unbind` kinds in `host_outbox`, candidates in the floor payload (a new field crosses the eight places CLAUDE.md lists) |
| `src/ui/floor.js` | M | the `+` in the room header, the dialog (the profile editor is the pattern), *move* and *remove* on the nameplate card |
| tests | M | `test:host` drives a stand-in `claude`; it must grow `mcp add`/`mcp remove`/`mcp get` against a fixture `HOME`, or the suite runs the real CLI with `HOME` redirected. Then **verify-ui-change** on the real page |
| docs | S | README step 3 becomes "or add it from the floor"; `security.md` gets the paragraph below; this file becomes the record |

Call it **three to five working days for one agent**, and the spread is not
the code: the top of the range is the two measurements still owed (VS Code
picking up local scope; the hook on a moved desk) and the three-halves deploy
— server, host and plugin all go stale independently, and this feature is the
first that needs all three new at once.

## Risks, and which ones cannot be closed

**The security boundary does not move; the reach behind it widens.** Today
anything that can reach the port can already type any message into any desk
and press *Approve* on its prompts — the board is code execution by proxy on
every host, and [`security.md`](security.md) says so. This adds one thing: the
board can bind a directory the host has not been told is a desk, and open a
window in it. The fence is the host's roots. It must be a hard one: the board
picks from what the host offers, never sends a path, and the host canonicalises
and refuses anything outside `cfg.roots`. What this does **not** close, and
cannot, is the one the whole design accepts on purpose — the board has no
sign-in, so "who clicked the plus" is `operator`, whoever that was on the LAN.
Anyone who can reach the port can add a desk. That is the same statement as
"anyone who can reach the port can drive your agents", and it is why the port
stays on a trusted network. Nothing new to fill; one more reason to mean it.

**The secret's exposure goes down, not up.** The key already sits in plain
text in every desk's `.mcp.json`. With this it sits in `~/.claude.json`,
mode 600, outside every repo, and it never travels board → host. The board
still never needs it.

**`~/.claude.json` is Claude Code's file, and it is busy.** It is 150 KB here
and rewritten constantly. Never edit it directly; write only through
`claude mcp add` / `remove`, which is what the measurements used, and read it
as a file only because the CLI has no JSON read today. The format is not a
contract — a Claude Code release can move it, and `CLAUDE_CONFIG_DIR` already
can. This is the same class of dependency as `claude agents --json` and the
transcript path: a fact about a version, to re-measure when the version moves.

**Two sources of truth in one repo.** A repo with both a `.mcp.json` and a
local-scope entry connects with the local one (higher precedence). The host and
the hook must apply the same rule, or the floor files the desk under one name
while the agent speaks under another — which no later tick repairs. A test for
exactly this case belongs in both suites.

**The plugin has to ship with it.** A host and server that bind desks this
way, with an older plugin on the workstation, give a desk that relays every
turn and never raises a prompt. Silent, and the worst kind of silent. The
deploy order is plugin first, then host, then server, and the version bump
asserts all three agree.

**VS Code is documented, not measured.** Local scope "loads only in the
project where you added it", and the extension uses the same configuration
loader, so a VS Code window opened in a bound folder should carry the binding
with no dialog. The measurement above was CLI-only. Verify on the first real
desk before telling a partner it works from the editor — and if it does not,
the fallback is the same file: `.mcp.json` is still honoured everywhere.

**A running window keeps its old headers.** MCP config is read at start, so a
move is a close and a resume, which was measured to keep the conversation but
does end whatever was on screen. Refuse while the desk is working; do it in
the gap, the same rule `handback` follows.

**"Just a name" is not quite the whole form.** A desk is a checkout, so the
plus needs a directory as well as a name. The host can offer the choice (an
unbound repo under its roots, or a fresh folder), which keeps it a click — but
it is a second question, and it should be asked rather than guessed, because
the guess is a window opening in the wrong project. One binding per directory
per scope also means one agent per checkout, as today: the same agent on two
floors is still two directories.

**The trust dialog stays.** A never-opened directory asks it, and the floor
offers it as a prompt. The self-heal in [`backlog.md`](backlog.md) would make
that one click fewer; it is not in this feature's way.

**Not possible from here, and not worth pretending otherwise:** an editor
session that is already open in a folder cannot be rebound without a restart;
a binding cannot be made for a machine with no host on this board; and the
floor cannot learn who pressed the button.

## Measured, slice 0 (2026-09-08/09, Claude Code 2.1.258)

The facts the plan in `~/.claude/plans/` depends on, each run on the
throwaway server (`127.0.0.1:8899`) and the `-L probe` tmux socket with
`CLAUDE*` stripped. Nothing here touched the operator's board or session.

**(b) A project entry and a local entry of the same name.** A folder whose
`.mcp.json` declares `orchestratinator` as `probe/both-project`, plus
`claude mcp add -s local` declaring it as `probe/both-local`:

| step | what happened |
|---|---|
| `claude mcp add -s local` with the project entry present | exit 0 — the "already exists" refusal is scope-specific |
| `claude mcp get orchestratinator` / `claude mcp list` | local scope, *Connected*, listed once; the project entry is not mentioned |
| `exec claude` in the folder | trust dialog (new folder), **then "New MCP server found in this project: orchestratinator"** — the project entry's approval is asked even though the local one shadows it |
| that dialog cancelled (an Esc reached it) | nothing recorded: `enabledMcpjsonServers` and `disabledMcpjsonServers` both `[]`; the window came up anyway |
| `whoami` | `channel=probe agent=both-local` — **local wins the connection** regardless of the dialog |
| project entry removed (file left as `{"mcpServers":{}}`) while the window ran, then `claude --resume <id>` | **no dialog of any kind**, ready in 1 s, same transcript continued (50 records, both earlier answers present), `whoami` → `both-local` |

So "import and remove" is not a tidiness choice: a shadowed project entry
keeps raising the approval dialog on every fresh window until it is approved
or gone. Removing it is what makes the floor's binding dialog-free. An empty
`mcpServers` object left behind raises nothing, so `dropProjectEntry` need
not delete the file.

**(c) CLI facts.**

| fact | measured |
|---|---|
| `claude mcp remove -s local orchestratinator` on an absent name | exit 1, stderr `No MCP server named "orchestratinator" in local scope` |
| `projects[…]` key when cwd is reached through a symlink (`/tmp/x`) | the **resolved** path (`/private/tmp/x`) — look up by `canonical(dir)` |
| `claude mcp add` via `execFile`, no TTY, `CLAUDE*` stripped | exit 0, ~0.6–0.7 s |
| the same under a launchd-shaped environment (`HOME` and `PATH` only) | exit 0, ~0.6 s — no shell profile needed |
| `CLAUDE_CONFIG_DIR=<dir>` set | writes `<dir>/.claude.json` (and a `backups/` beside it); the real `~/.claude.json` is untouched — honour the variable when reading |
| `add` in a never-opened folder | does **not** write `hasTrustDialogAccepted`; the trust question still comes on first open, and the floor's existing prompt handles it |

The per-call budget the plan assumed (10–30 s, from `claude agents --json`)
was pessimistic: `mcp add` and `mcp remove` are sub-second here. Keep the
60 s timeout as a ceiling, not an estimate.

**(a) VS Code and local scope.** A scratch folder outside every root, bound
with `claude mcp add -s local` as `probe/vsc-a`, then opened in VS Code by
the operator with a Claude Code chat started in it (2026-09-09):

| step | what happened |
|---|---|
| chat opened in the bound folder | **no MCP approval dialog**; the session's own "Session check" reported *agent vsc-a on orchestratinator channel probe* |
| the throwaway board | one MCP session, `probe/vsc-a`, presence row for `vsc-a` |
| `~/.claude.json` afterwards | `hasTrustDialogAccepted` still `false` — a VS Code session does not write folder trust, as the backlog already suspected |

So a VS Code window in a floor-bound folder carries the binding, and
decision 1 (import into local scope, remove from the file) stands as decided.
The second case, rebinding under an already-open chat, split the two clients:

| client | binding changed with `mcp remove` + `mcp add` while the session ran | `whoami` in that same session afterwards |
|---|---|---|
| **VS Code** chat (`vsc-a` → `vsc-a2`) | **followed it** — the same chat answered `vsc-a2` on its next call, and noted itself that it "was vsc-a a moment ago"; a fresh chat answered `vsc-a2` too | the editor re-reads the configuration and reconnects on its own |
| **CLI** window (`live-1` → `live-2`), both calls verified as real tool calls in the transcript and on the board | **kept `live-1`** | the CLI holds the connection it made at start; a close and `--resume` is what takes the new binding (measured above) |

Two design consequences. A move on a **floor-held** desk is close + `--resume`,
as planned. A move on an **editor-held** desk needs no refusal: the host
rebinds the folder, the editor's chat follows on its next tool call, and the
new desk adopts that live session — the dialog says so rather than refusing.
The session picker still refuses an editor-held desk, because a resume means
closing a window the floor does not hold.

Seen in passing, not ours: every fresh window prints a page of
`Permission allow rule (~/.claude/settings.json): … has a wildcard before the
rest of the command` warnings above the dialogs. They scroll off and do not
disturb `startupQuestionOf`, which reads the option block from the footer up.

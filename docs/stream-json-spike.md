# Driving Claude Code without its screen: the spike (review item 5)

*2026-11-22, coordinator, for costmo's decision. Item 5 of
[`robustness-review.md`](robustness-review.md). Measured on Claude Code
2.1.330 on this Mac, in a scratch folder, on Haiku 5.5 (the turns cost under
a cent each). Nothing in the product was changed for this; the driver is a
60-line script in the session's scratchpad. Not measured is said as such.*

## What was asked

Can a desk be one Claude Code process driven through its programmatic
interface (`claude -p --input-format stream-json --output-format
stream-json`, which the Agent SDK sits on) instead of a terminal screen the
host reads? The review named five things to settle first: a message, a
permission, a question form, a model change and a resume, plus what becomes
of the terminal view and of slash commands.

## What a real 2.1.330 did

| Asked | What came back | Read off a screen? |
|---|---|---|
| A message | `system/init` (session id, model, permission mode, slash commands, MCP servers), the `assistant` record, then `result` with its text, cost and turn count | No |
| A permission (`Bash: touch spike-x.txt`, default mode, `--permission-prompt-tool stdio`) | A `control_request` `can_use_tool`: tool name, input, a description, and the "don't ask again" choices as `permission_suggestions` rules. Answered with one JSON line (`behavior: allow` with the input, or `deny` with a message). The file was made, the turn went on | No |
| A two-question AskUserQuestion | The same `can_use_tool`, with every question, header and option in `input.questions`. Answered by returning the input with `answers`; the agent was told `"Pick a colour"="Blue", "Pick a day"="Friday"` and replied `COLOUR=Blue DAY=Friday` | No |
| A model change | A `control_request` `set_model` (`"sonnet"`), answered `{"model":"claude-sonnet-5-5"}`; the conversation recorded "Set model to sonnet"; the next `init` named the new model | No |
| A resume (`--resume <id>`, a new process) | Same session id; it remembered the day chosen two processes earlier (`DAY=Friday`) | No |
| The plugin's hooks | They fire in `-p` mode (`hook_started` / `hook_response` records), so the floor's hook events keep arriving | — |
| The transcript | Written to the same `~/.claude/projects/<folder>/<id>.jsonl` the relay already reads | — |

Every case that has broken the floor this month (the review's table of
eight) is a screen. None of them exists on this path: there is no trust
question drawn, no dialog, no footer to wrap, no composer to type into or
read back, no redraw timing.

## What it would change, and what is not known

- **The terminal view.** A `-p` process has no screen to attach to. Two
  ways to keep what Open in tmux gives today, neither measured: the floor's
  panel is the view (it already draws the conversation), and **Open in
  Claude / VS Code becomes the handoff**: the floor's process ends, the
  person's `claude --resume <id>` takes the conversation, and the floor takes
  it back when they are done, which is the one-process rule CLAUDE.md
  already lives by.
- **Slash commands.** `/model` has `set_model`; the SDK also has
  `set_permission_mode` and `interrupt` (not tried here). `/compact`,
  `/clear`, `/mcp reconnect`, `/btw` and `/cost` were not tried: some may be
  user text the `-p` process runs, some may not exist there. This is the
  biggest unknown, and the first thing a second spike would measure.
- **Startup questions.** Folder trust and MCP approval: `-p` did not ask in
  an already trusted folder. A fresh folder was not tried.
- **Who is "live".** A `-p` process was not seen in `~/.claude/sessions`
  after it exited; whether it is listed while running was not read. The
  host's roster join (`holderOf`) would change to "the process the host
  started".
- **Sign-in, settings and plugins** behaved as in the terminal for these
  turns (signed-in account, user settings' auto mode, the plugin's hooks);
  not tried signed out.
- **Cost.** A process per desk, as now. A `-p` process can stay running
  between turns (stream-JSON input is a stream), so it is not a cold start
  per message. That was not timed.

## The middle path, and the recommendation

The review's middle path (keep the terminal window, take every state from
hooks and the transcript) is partly what 0.14.6 already does: a screen the
host does not know now reaches the desk as "needs you" instead of idle, any
dialog of Claude Code's own shape is read generically, and nothing is typed
into a window that is not provably at its message box. That stops a new
screen from breaking a desk silently. It does not stop the host from
needing to type into a screen.

The spike says the programmatic path covers the core of what the floor does
(messages, permissions, questions, a model change, resume) with no screen
at all, on today's Claude Code. **My recommendation: a second, larger spike
before any redesign**: one desk on a scratch board driven end to end by a
host that speaks stream-JSON, measuring the slash commands the floor sends,
a fresh folder's first run, the roster while running, and the editor
handoff. Then the decision on whether it replaces the window layer, behind
a per-desk switch so both run side by side, which is costmo's rule for
anything that changes what works today.

**costmo's decision, 2026-11-22, by AskUserQuestion: "Second spike
first."** The next round measures the unknowns above with one desk on a
scratch board and a host that speaks stream-JSON, and brings the result
back to him before any redesign. Nothing of it is in 0.14.6.

## The second spike (2026-11-22, the same evening)

One stream-JSON process per run, kept open across turns, on 2.1.330 and
Haiku 5.5, in scratch folders, with a scratch board on its own port for
the MCP rows. The driver is the session's scratch script, not product code.

| Asked | What a real 2.1.330 did |
|---|---|
| A folder never trusted | Ran. No trust question on this path |
| A project `.mcp.json` in such a folder | Connected and used, no MCP approval asked |
| A folder bound in local scope | Its tools loaded, no approval |
| The roster while running | Listed: `kind: interactive`, `entrypoint: sdk-cli`, pid, session id, cwd |
| `/cost` typed as a message | The usage text, as the reply |
| `/btw` typed | "/btw isn't available in this environment." The `side_question` control request answers instead ("Four") |
| `/mcp` typed | A one-line summary. The `mcp_status` control request gives every server's state as data |
| `/compact` typed | `status: compacting`, a `compact_boundary` record, and the turns after it went on |
| `/clear` typed | A `conversation_reset` record naming the new id, then the new session's `init` |
| The board stopped and started under it | Tool calls failed ("not connected"). The `mcp_reconnect` control request (`serverName`) brought it back at once, nothing typed |
| A message sent while a turn ran | Taken into the running turn: one result answered both |
| The `interrupt` control request | The turn ended "[Request interrupted by user]"; the next message was answered |
| Effort, as `apply_flag_settings` `{ effortLevel }` | Accepted; `~/.claude/settings.json` unchanged (same sha256 before and after). Whether the level took effect was not shown |
| Handed to a terminal and back | `claude --resume <id>` in tmux took the conversation and answered there; `/exit`; the stream-JSON process resumed it and knew what was said in the terminal |
| A dialog like "Teach auto mode" | Not raised; the binary has a `request_user_dialog` record on this path, so it would arrive as data. Not measured |

What this settles: everything the floor does today has a programmatic form
except `/btw` typed (its control request replaces it), and the editor or
terminal handoff is the one-process rule as it already stands: the floor's
process ends, the person's resumes, and back. What it changes that matters:
**no trust question and no MCP approval are asked on this path**, so the
operator's choice of a folder (Take a desk) is the only consent; and a desk
has no screen to attach to while the floor holds it.

What is still not measured: a dialog arriving as `request_user_dialog`, the
effort actually applied, a process held open for hours, signed out, and
Windows.

# Why the floor breaks, and how to stop it

*Written 2026-11-22 by pc-developer, on the Windows test PC, for later review. Nothing here has been measured unless it says so. Everything about the incident is read from the host log, the panes and the board on this PC.*

## The requirement, and where the implementation left it

The requirement was to use Claude Code, so that nobody rewrites it. Agents keep Claude Code's tools, sessions, permissions, models and transcripts, and the floor lets one person run many of them.

The implementation met that requirement by **driving Claude Code's interactive terminal screen**. The host types keys into a tmux pane and reads the screen back as text. It decides what a window is doing by recognising screens it has seen before: the message box, the permission menu, the question form, the trust question, "Switch model?", the `/btw` overlay, and so on.

That was the developers' choice, not a requirement. It has a built-in flaw. A terminal screen is drawn for a person to read, not for a program, and Claude Code changes it whenever it likes, without notice, sometimes several times a week. An implementation that depends on recognising screens is **wrong by default**: every screen it has not seen yet is a fault waiting to happen. That is the pattern costmo is reporting, and the record shows it is accurate.

## The pattern, from the repo's own record

Each of these broke the floor, and each was fixed by teaching the host one more screen (all from CLAUDE.md):

| When | What Claude Code changed or showed | What the floor did |
|---|---|---|
| 2.1.300 | Ghost-text prompt suggestions in the message box | Read as text "typed and never sent"; later made typed messages fall back to pasting |
| 2.1.326 | "Switch model?" gained a last line | Never pressed `1`; model changes from the floor failed |
| 2.1.326 | The review screen lost "Ready to submit your answers?" | Called an unsubmitted form answered |
| 2.1.326 | `/cost` opened a 41-line settings screen | Send ended `not_delivered`, screen left standing |
| 2.1.326 | A message box taller than its frame scrolls | Read the last line as lost; pasted the message |
| 2.1.318 | "Claude in Chrome extension detected" question | Host refused to type; the floor had nothing to answer it with |
| 2.1.328 | The trust question's cursor redraw came 80 ms late | Refused the first question every new desk asks |
| 2.1.330 | **"Teach auto mode about your environment?"** (today) | Read as idle; every message from the floor went into the dialog |

That is eight in about three weeks. Each fix was correct and narrow. None of them made the next one less likely.

## Today's incident (2026-11-22, this PC's board on 8787)

- **18:44Z** All three e3-roominator windows (`roominator-mobile-dev`, `roominator-service-developer`, `unifier-dev`) were closed and reopened on a new conversation, then given `/effort high`. The host log records this as floor work. What asked for it is not known.
- On Claude Code **2.1.330**, each new window drew "Teach auto mode about your environment?" (1 Yes / 2 Not now / 3 Don't show again) above its message box. The dialog takes every key.
- The host has no reader for that dialog, so it reported each window as **idle**. The floor kept accepting messages for desks that could not receive them, and said nothing.
- **18:58Z** Open in Claude ran three times and opened Windows Terminal each time. Windows kept every one behind other windows ("opened but was not brought to the front"), so to the operator it looked like nothing happened.
- **About 19:05Z** The operator chose "Don't show again", pressed in each window by pc-developer after checking the dialog was on screen. All three agents worked at once. One picked up a message that had been waiting.

The agents were never dead. They were waiting on a question the floor could not see. The agents were not the failure; the floor was, because it said "idle" about a screen it did not understand.

## What to change

Ranked by how much breakage each removes for its cost.

### 1. A screen the host does not recognise means "needs you", never "idle"

Today the readers are a list of known screens, and anything that matches none of them falls through to idle. Turn that around:

- A window is **idle only on proof**: the bottom of the pane is exactly an empty message box, with nothing drawn above it.
- Anything else is **"the window is showing something the floor doesn't know"**. The desk shows the pane's text, offers Open in tmux, and the floor refuses messages, saying why.
- CLAUDE.md already has this rule ("idle is read, never assumed"), but only for the 30 s reopen. It should be how the host reads every window.

**Effect:** a new Claude Code screen becomes a visible prompt instead of a silent dead desk. Today would have been one obvious box on the floor. **Cost:** small, in `host/window.js`'s readers and the desk state they feed.

### 2. Never report a message as delivered without proof

- The host already confirms delivery from the transcript. Every path that cannot confirm it must end in **"not delivered"**, quoting the pane, including the fallback where typing "did not hold" and the host pasted instead (logged twice today at 18:33Z).
- The floor should never be quiet about a message it could not place.

**Cost:** small.

### 3. Read Claude Code's menus by their shape, not their title

Claude Code's dialogs share one layout: a title, numbered rows with a `❯` cursor, and an "Enter to confirm · Esc to cancel" line.

- One generic reader for that layout puts **any** menu on the floor with its rows as buttons, and the operator picks one. Today's dialog would have arrived as three buttons, with no code change.
- Specific readers stay only where the host must understand the meaning: permissions (Approve / Deny), the question form, and "Switch model?", which it answers itself.

**Cost:** medium. It replaces several one-off readers with one, which also shrinks what can break.

### 4. Notice a Claude Code update before the operator does

- The host reads `claude --version` at each heartbeat. When it changes, it runs the reader checks that are done by hand today on a throwaway window (**measure-a-real-window**: trust question, permission menu, a two-question form, `/model`, `/mcp reconnect`). It puts the result on the floor: "Claude Code 2.1.330 arrived; all checks passed", or which one failed.
- Optional: turn off Claude Code's auto-update for the floor's windows and update deliberately once the checks pass. The cost is getting Claude Code fixes somewhat later. That trade is costmo's to make.

**Cost:** medium. It is mostly automating what is already done by hand.

### 5. Talk to Claude Code through its programmatic interfaces, not its screen

This is the fix that matches the requirement. It still **uses** Claude Code, the same program, sessions, tools, settings, plugins and transcripts, but through the interfaces Claude Code provides for programs instead of the one it draws for people:

- **Hooks**: structured events Claude Code fires itself (session start, permission requests, prompts submitted, stop, compaction). The floor already uses some of these. A hook can also decide a permission request (allow or deny) without anyone reading a menu.
- **The transcript**: already the floor's source of truth for what was said.
- **Stream-JSON / the Agent SDK** (`claude -p --input-format stream-json --output-format stream-json`, or the SDK on top of it): messages in and events out as JSON, with options for model, effort, permission mode and MCP servers. There is no screen to misread, so trust questions, tips, dialogs and redraw timing stop mattering.

What has to be settled before choosing it, none of it measured yet:

- **Watching or typing into a live agent in a terminal.** An SDK-driven process has no terminal to attach to. The floor already shows the conversation; a terminal view would become a transcript viewer, or a handoff (`claude --resume` in a terminal, with the floor letting go), by the one-process-per-conversation rule.
- **Slash commands.** Which commands the operator uses from the floor (`/model`, `/effort`, `/compact`, `/clear`, `/mcp`) have programmatic equivalents, and which do not.
- **Questions (AskUserQuestion) and permission prompts.** How each reaches the floor and is answered over the programmatic interface.
- **Sign-in, plugins and settings**: confirming they behave as in the terminal.

A middle path is worth weighing: keep the terminal window, but take **every state the floor reports** from hooks and the transcript instead of the screen, and keep screen reading only for typing input. That removes most of the misreads (1 and 3 above) without changing how windows are opened or watched.

**Cost:** large. It is a redesign of the host's window layer, done after this release, with a measured spike first: drive one desk through stream-JSON end to end on a probe, covering a message, a permission, a question form, `/model` and a resume.

## Recommendation

- **Now (small, removes most of today's class of failure):** 1 and 2.
- **Next:** 3 and 4.
- **Decide after the release:** 5, starting with the spike. It is the only item that stops this class of breakage at the source instead of reacting to it faster.

## Already done today

- The three e3-roominator windows were unstuck by answering the dialog with "Don't show again".
- Not yet done: reporting the 2.1.330 dialog to coordinator as a missing startup question. pc-developer's board tools were disconnected at the time of writing.

# A first session of new agents on the Windows PC (2026-11-23)

*Written 2026-11-23 by orchestratinator-dev, on the Windows PC (host `e3-pc15`), at costmo's request during a QA round. It is a read of one hour on one machine, not a test. Everything here comes from the host log, the board's database and logs, the agents' settings files, and one transcript. The timestamps are UTC.*

## What was asked

Three new agents on the `pc-unifier` floor (`unifier-app-dev`, `roominator-mobile-dev`, `roominator-service-dev`) raised a rapid run of permission prompts. costmo answered each one with Yes or "Yes, and don't ask again". Errors flashed on the floor and did not stay, and every agent said it had missed no answer and had nothing denied. The question was whether anything was wrong with the tooling, the orchestratinator, or the messaging.

**The answer is no.** Everything below behaved as designed. Two of the errors had a cause worth recording, and so did the volume of prompts.

## The setup

- Build 0.15.0 at `7c9ca84` (develop) and protocol 2. Claude Code was 2.1.330, which the host's protocol probe passed 32 of 32 at 16:06:52.
- The board is Docker on this PC, on `localhost:8787`, with auth `enforce`. The host runs under Task Scheduler.
- The three desks were taken from the floor between 16:16:36 and 16:17:40, each on a new conversation, then set with `/model opus` and `/effort high` from the floor. Every one of those six commands was confirmed on the desk.
- A meeting room with the three desks was opened at about 16:51.

## "Don't ask again" is saved, and a saved rule is not asked again

Each desk's folder has a `.claude/settings.local.json` holding the rules from the "don't ask again" answers: `mcp__orchestratinator__*` tools, `Bash(docker compose *)`, `Bash(npm test *)`, and exact command lines.

Some tools were asked about more than once. The host log, set against the order of rules in each file, shows the same thing every time: the earlier prompts were answered with a plain Yes, and the rule appears at the prompt answered with "don't ask again". **No tool was asked about after its rule was written.** For example, on `roominator-mobile-dev`:

| Tool | Asked | Rule written |
|---|---|---|
| Set Status | 16:44:12, 16:55:51 | at the 16:55:51 answer (4th in the file, after send_message) |
| List Tasks | 16:44:08, 17:01:23 | at the 17:01:23 answer (5th, before claim_task at 17:01:44) |

`roominator-service-dev` follows the same pattern for Set Status (16:44:12, 16:51:55, 17:01:28) and Poll Messages (16:44:08, 16:51:43).

**Why there were so many prompts.** These are new agents in folders that have never had any rules, so every tool is asked about once per folder. That includes each orchestratinator tool. A user-scope rule `"mcp__orchestratinator"` in `~/.claude/settings.json` would allow all of the board's tools in every folder. This was offered to costmo, and nothing has been changed.

## The errors on the floor

The board holds exactly two error turns on `pc-unifier` today, and both are the host refusing a message while a prompt stood:

```
16:52:24 roominator-mobile-dev  not delivered: its Claude Code is waiting on an answer to what it asked (permission for Read), …
17:05:17 unifier-app-dev        not delivered: its Claude Code is waiting on an answer to what it asked (permission for PowerShell), …
```

This is the designed behaviour (`Agent.send` in `host/agent.js`). Claude Code takes no message while it waits on an answer, so the host refuses the message at once and says so. Otherwise the message would read "not taken" after 30 s and then arrive anyway. Both refusals were correct at the moment they were made:

- **roominator-mobile-dev, 16:52:24.** The desk had raised four Read prompts in 1.7 s (16:51:30.698 to 16:51:32.343, parallel tool calls), and its next prompt came at 16:55:30. A Read prompt was still open when the message arrived.
- **unifier-app-dev, 17:05:17.** The prompt named was opened at 17:03:00 (`probe-drivers.ps1`). Between it and the refusal, the host logged Bash prompts at 17:03:06, 17:04:23 and 17:04:55 for the same desk. Those came from the background subagent the desk had started at 17:02:54 ("Build incidents.ps1 capture", `run_in_background`): **a subagent's prompts reach the floor on its parent's desk, interleaved with the parent's own.** The transcript shows the PowerShell call's result only at 17:05:48, after the refusal, so that prompt really was still open. The desk took the next message (a nudge, queued at 17:05:51) normally.

So both errors were real refusals. Neither was a stale prompt: the host's record of standing asks matched what Claude Code was waiting on. The earlier fault where a subagent's hooks closed a question on the floor (0.14.7, `CLAUDE.md`, "A subagent's hooks do not close a question") belonged to the hook path. A desk the host runs gets its prompts as data on the stream-JSON path, and nothing here suggests the fault has come back.

**Worth a look in the QA round, as a matter of experience and not as a fault.** When a parent desk and its background subagent both have prompts open, the operator sees one desk with a run of prompts from two lines of work. A message sent meanwhile is refused while any one of them is open. The floor said so, in words, and nothing was lost. But two of the three agents in this session made parallel or subagent prompts, so the situation is common rather than an edge case.

## The board restart at 16:25

The board container was recreated at 16:25:06 (`docker compose up -d` after the port mapping in `docker-compose.yml` was changed back from `127.0.0.1:8787` to `8787`, so agents on another computer can connect). This is what followed, in order:

- The host logged one failed work poll: `UND_ERR_SOCKET: other side closed` after 169 ms, retried in 1 s.
- The board logged eight `refused GET /mcp (stream) … unknown session` lines, two for each of the four desks. These were the MCP sessions from before the restart, which live in the board's memory.
- At 16:25:27, 21 s later, the host reconnected every desk's tools (`mcp_reconnect`) and said so on each desk. This is `reconnectDue` working as designed (`RECONNECT_AFTER_MS`, 20 s).

## `server/discover` refused

The board logged 15 `refused POST /mcp (server/discover) session=none — no session and no initialize` lines, spread across the hour (4 at 16:25, then about one every few minutes). Claude Code 2.1.330 sometimes sends this method without a session, and the board answers 400 (`src/server.js`). Tool calls before and after each one succeeded, so it is harmless today. It is recorded because it is a request from Claude Code that the board does not recognise. If a later Claude Code comes to depend on the answer, this is where it would show first.

## What was not looked at

- Prompts answered from the meeting room's window, as opposed to the floor's panel. The host log does not say which window an answer came from.
- Who sent the two refused messages (the meeting room or the floor). The board's turns show that each was refused, not where it came from.
- Agents on another computer. At the time of writing no inbound firewall rule exists for 8787 on this PC (the Wi-Fi profile is Public), so none could connect yet.

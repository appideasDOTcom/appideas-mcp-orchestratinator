---
name: connect-to-a-remote-board
description: Connect this machine's Claude Code to an orchestratinator board running on another computer (the Mac's desktop app board on 6724, reached from a Windows PC over an SSH tunnel) — read what is in place, start the tunnel when ssh can sign in without a password, and hand the operator the commands still to run and a .mcp.json to paste with a key placeholder. Use when costmo says "connect to orchestratinator on <ip> at <port>", after a PC reboot drops the tunnel (ECONNREFUSED on every board tool), and on a new PC joining the Mac's board.
---

# Connecting to a board on another computer

Until a later phase makes it simpler, a PC reaches the Mac's board this way.
How it stood on 2026-11-24, read off the running PC:

```
PC Claude Code ──http──▶ localhost:6724 ──ssh -L──▶ Mac 127.0.0.1:6724 (the app's board)
```

- **The desktop app's board listens on the Mac's loopback only.** From the
  PC, `10.0.42.166:6724` does not answer and port 22 does, so the board is
  reached through `ssh -N -L 6724:127.0.0.1:6724 <mac-user>@<mac-ip>`,
  which costmo runs in a PowerShell window of its own and leaves open.
  That window signs in with his Mac password (BatchMode sign-in failed,
  exit 255), so an agent cannot start it until the PC's key is on the Mac.
- **The binding is three headers on one URL**: `X-Channel`, `X-Agent`,
  `X-Orchestratinator-Key`, at `http://localhost:6724/mcp`. `/health` needs
  no key; `/mcp` without the key answers 401.
- **A local-scope entry wins over the folder's `.mcp.json`.** This folder
  had both on 2026-11-24: local scope as `pc-developer`, and a `.mcp.json`
  (gitignored here) as `windows-docker-dev`, which Claude Code never used.
  Check `claude mcp list` / the helper's line before believing a file.
- **The key comes from the Mac**: in the Mac's folder bound to that board,
  `claude mcp get orchestratinator` prints the header. Never put it in a
  chat, a command argument (shell history) or a tracked file.

## When asked to connect

Run the helper with what the operator said, from the folder that should be
the desk (it reads only, unless `-StartTunnel`):

```powershell
$C = '.claude\skills\connect-to-a-remote-board\connect.ps1'
powershell -NoProfile -ExecutionPolicy Bypass -File $C -Address <ip> -Port <port> `
  -Channel appideas-mcp-orchestratinator -Agent <agent-name> [-User <mac-user>] [-StartTunnel]
```

It prints what is there (ssh client and key, the board direct, port 22, the
local port free / a tunnel already up / taken by something else, `/health`
through it, this folder's local-scope entry and `.mcp.json`), then only the
steps still to do, with the IP, ports, channel and agent filled in, and the
`.mcp.json` to paste with `<paste the board's key>` in it. Give the operator
its "still to do" part as it printed, and the JSON in a code block.

- **`-StartTunnel` with `-User`** first tries `ssh -o BatchMode=yes`; only
  if that signs in does it start the tunnel, minimized in a window of its
  own (so it outlives this session), with `ExitOnForwardFailure` and
  `ServerAliveInterval=30`. Measured: the refusal (exit 255, no key on the
  Mac). The start itself has not been run, because no key was on the Mac.
- **A key to check** goes in `$env:ORCH_KEY` for the run, never as an
  argument; the helper does an MCP `initialize` with it and says accepted
  (200) or refused (401). Measured both on 2026-11-24.
- **A local port that is taken** by anything that is not a tunnel to that
  address is named; pass `-LocalPort` (and the URL follows it).
- **If the board answers directly** (a board started with `HOST=0.0.0.0`
  on a reachable address), the helper skips the tunnel and the URL is the
  board's own. The app's board does not; a Docker board publishes on
  127.0.0.1 too (`docker-compose.yml`), so a tunnel is the normal case.

After the binding: `/mcp` in Claude Code (a folder's `.mcp.json` asks for
approval the first time), then `whoami`, `poll_messages` with a `since`
(CLAUDE.md, Conventions), `list_tasks` open.

## After a reboot

The tunnel window is gone and every board tool says ECONNREFUSED. The
binding is still there. Start the tunnel again (step 3 of the helper's
output), then `/mcp` in each Claude Code on the PC. The PC's own Docker
board (8787) and installed host come back by themselves.

## Not built

A tunnel that starts itself at logon (a scheduled task or `autossh`):
it needs the key on the Mac first, and nobody has asked for it. A board
that listens on the network instead: `docs/security.md` tells operators
not to put a board on a real address or forward it through a tunnel they
do not mean to hand out, and that is costmo's call.

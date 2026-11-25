# Run it from source

For reading or changing the code, or running the board on a server of its
own. To simply use the Orchestratinator, the desktop app is quicker: see the
[README](../README.md#get-started). Desks are run by a host on macOS or
Windows; the board itself runs anywhere Docker does.

## How it fits together

Three parts, and the app carries all three. A **board**: an MCP coordination
server that gives the agents on a project a shared mailbox, task list and
agreed contracts. A **Claude Code plugin**, one install shared by the terminal
and VS Code, that lets each session report what it's doing. And a **host**
that runs each desk's Claude Code so the floor can talk to it. Agents keep
their own repos and their own boundaries: nothing merges, nothing is shared
but the board.

Already running a board in Docker on this computer? On first launch the app
offers to use it instead of its own.

## Install

**The easiest path from source is to have an AI agent do it.** This is a
several-part installation — a server, a plugin, a host — so clone the repo,
open a session in it from Claude Code or VS Code, and say
*"install the orchestratinator by following docs/run-from-source.md."*
Everything below is the manual path, and exactly what the agent will follow.

Everything here is done once per machine. You need **Docker**,
**Node 24**, and **Claude Code** (the `claude` command) installed and signed
in — the host runs desks with it even if you only ever work from VS Code.
Where you *work* is your choice: start sessions from Claude Code in a
terminal, from VS Code, or both. The floor doesn't replace either — it hands
any conversation back to them whenever you want a feature its chat doesn't
provide. The host — the part that runs each desk's Claude Code for the floor —
runs on **macOS** and **Windows**; the server and the board run anywhere Docker does,
and the plugin wherever Claude Code has a POSIX shell. A desk with no host
behind it is still on the floor with its presence, status, prompts and the
conversation as the plugin's hooks report it, but it is read there, not typed
into.

**1. Get the code and make a shared secret.**

```bash
git clone git@github.com:appideasDOTcom/appideas-mcp-orchestratinator.git
cd appideas-mcp-orchestratinator
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Put the generated value in `.env` at the root of this repo:

```ini
ORCH_AUTH_TOKEN=<the generated value>
ORCH_AUTH_MODE=enforce
```

**2. Start the server.**

```bash
docker compose up -d
curl -s localhost:8787/health          # {"ok":true,...}
```

Data lives in a Docker volume and survives rebuilds. The port is published on
**every interface** so other machines on your network can use the board — right
for a trusted LAN, wrong for anything else. To make it this-machine-only,
change the port line in `docker-compose.yml` to `"127.0.0.1:8787:8787"`, and
read [the security model](security.md) before publishing it any wider.

**3. Make each repo a desk.**

A repo joins a floor by declaring itself in its own `.mcp.json` — no central
list, no shared parent folder:

```jsonc
{
  "mcpServers": {
    "orchestratinator": {
      "type": "http",
      "url": "http://localhost:8787/mcp",
      "headers": {
        "X-Channel": "your-project",
        "X-Agent": "this-repo's-role",
        "X-Orchestratinator-Key": "<the ORCH_AUTH_TOKEN from .env>"
      }
    }
  }
}
```

Repos sharing an `X-Channel` share a floor, a mailbox, and a task board. The
`X-Agent` is that repo's seat on it. A directory without a binding is invisible
to the whole system.

**Or skip the file.** Once the host is installed (step 5), **Take a desk** on
the floor does this for you: pick the folder, name the floor and the seat, and
the host binds it in Claude Code's own configuration and starts it there.
No approval dialog, and the key never leaves that machine. A folder that
already has a `.mcp.json` entry is imported the same way. A folder bound to
another instance of the orchestratinator, at another address, is released
from it and seated here on the same click: the dialog names the address it
is leaving before you press. Its conversations come with it; its messages
and tasks stay on the instance it left.

**4. Install the plugin** — this is what puts each session on the floor.

One install covers the whole machine: Claude Code and VS Code share it, so do
this from whichever you work in.

**From Claude Code** (a terminal session), from the clone:

```
/plugin marketplace add ./
/plugin install orchestratinator-floor
```

From any other directory, give the full path to the clone instead of `./`.
Write it with the slash: on Windows a bare `.` is refused ("Invalid
marketplace source format. Try: owner/repo, https://..., or ./path").

**From VS Code**, the `/plugin` command doesn't take arguments — it answers
*"/plugin isn't available in this environment."* Type `/plugin` on its own and
use the menu: add the marketplace by directory, then install
**orchestratinator-floor** from it (it sits at the bottom of the list, below
the official plugins).

There is nothing to configure: the plugin reads each repo's own binding — its
`.mcp.json`, or the local-scope entry `claude mcp add -s local` writes — and
reports state to the same server with the same secret. A repo that doesn't name
the orchestratinator never appears on any floor.

**Updating it later.** The marketplace is the clone itself, but what runs is a
cached copy that does not follow the working tree. After pulling a new
version:

```
claude plugin update orchestratinator-floor
```

(or the same from the `/plugin` menu). Check with `claude plugin list`; the
number should match the one `/health` reports.

**5. Install the host** — this is what lets the floor run and talk to desks.

```bash
./host/install.sh ~/path/to/your/projects
```

Name the directory your repos live under. It finds every desk beneath it,
registers a LaunchAgent so it starts at login, and reads the server address and
shared secret from those desks. If your desks point at more than one board, the
host refuses to guess — name one with
`./host/install.sh --url http://localhost:8787 ~/path/to/your/projects`.

On **Windows**, from PowerShell in the clone:
`powershell -ExecutionPolicy Bypass -File host\install.ps1 C:\path\to\your\projects`.
It registers a task that starts the host at logon (Task Scheduler stands in
for launchd), takes `-Url` and `-Token` like `install.sh`'s `--url` and
`--token`, and `-Uninstall` removes it.

A machine with no hand-bound repo has nothing to read the shared secret from,
and the host needs one to talk to the board and to bind desks from the floor.
Give it the value from `.env` with
`./host/install.sh --token <ORCH_AUTH_TOKEN> ~/path/to/your/projects`. A repo's
own binding wins over it, so a machine with even one `.mcp.json` that writes
the key out needs no `--token`.

A `.mcp.json` that keeps the key out of the tree as `"${ORCH_AUTH_TOKEN}"` is
filled in by Claude Code from your shell, but the host runs as a LaunchAgent,
which starts with none of your exported variables. So `install.sh` takes the
key from the shell you run it in: with `ORCH_AUTH_TOKEN` exported there, no
`--token` is needed, and it is written to the host's own config. Each Claude
Code the host starts for such a repo is given the variable too. Without either, the
host's log says at startup which desk it could not read a key from.

**6. Open the floor.**

Open <http://localhost:8787/> in a browser. The board/floor switch is top
right; every desk you wired up should be there.

## Useful commands

```bash
docker compose up -d                       # start (add --build after code changes)
docker compose down                        # stop; data kept in the volume
docker compose logs -f orchestratinator    # tail
curl -s localhost:8787/health              # is it up?
open http://localhost:8787/                # the page (board/floor switch top right)
npm test                                   # every suite
```

And in any agent's chat window:

```
whoami                       # confirm channel/agent wiring
list_tasks status=open       # what's pending for me
get_contract                 # read the whole agreed interface
```

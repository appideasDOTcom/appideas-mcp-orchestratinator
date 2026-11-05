# The desktop app: structure and framework

Discussion notes, 2026-11-05, written to be copied into the desktop app's
repo when it is started. Nothing here is built. It assumes the hosted-service
idea: Orchestratinator boards hosted for paying customers and reached through
an authenticated desktop app, with the browser kept localhost-only.

## Decisions so far

1. **The desktop app is its own repo, with its own agent.** It pins this
   repo's code as a dependency and never copies it.
2. **The app is the host, packaged**: the host plus token enrollment plus a
   webview of the floor, and optionally the board itself for an app-only
   install.
3. **Electron, not Tauri.**

## 1. Repo structure

### The split

| Repo | Holds | Visibility |
|---|---|---|
| **appideas-mcp-orchestratinator** (this one) | Everything that speaks the protocol, on either side: server, host, plugin, floor UI. Auth checks go in the server too, behind a seam: none on localhost, a token check when remote. | Public |
| **Desktop app** | The app shell, packaging, signing and notarization, auto-update, token enrollment and keychain storage, tray, keeping the host process running (in place of launchd for app installs) | Undecided |
| **Service** | Tenant provisioning on Digital Ocean, accounts, billing, issuing tokens | Private |

The app pins versions of this repo's host, server and built UI, and shows
the UI in a webview. An app-only install with the board on board ("MCP
services self-contained") therefore runs the same server code, not a second
copy. `host/` already has its own `package.json`, so publishing it as a
package is a short step. The server and UI would need the same.

### The rule that stops duplication

**If code speaks the host↔board protocol or the MCP tools, it lives in this
repo.** The app repo can wrap it, start it and package it, but never
reimplements it.

If the app's agent finds something it needs changed here, that change is a
task on this repo's channel, not a patch in the app repo. Orchestratinator
coordinating its own two repos is a decent first test of it.

**Where it can still go wrong:** the app's agent forking a file "just for
now" because the change it needs here is slow to land. Making cross-repo
requests cheap on the board guards against that better than any repo
layout.

### What has to change in this repo first

1. **Versioning stops being one number.** Today the server, host and plugin
   move in lockstep: `npm run set-version` writes all three, and the update
   from the page (#40) moves all three to one commit from a git clone. A
   packaged host updates through the app's own updater, on its own schedule,
   against a hosted server that updates on ours. So the protocol needs a
   version that both sides check at registration, with a clear refusal when
   they disagree. `CAPABILITIES` in `host/update.js` (today just `finish`)
   is that idea in miniature; widen it to the whole protocol.
2. **#40 cannot update a packaged host.** It refuses a host launchd is not
   supervising (`XPC_SERVICE_NAME`), and it updates with `git merge` in a
   clone. In hosted mode it is switched off (the board must never start an
   update on a customer's machine) and the app's updater takes its place.
   The "supervised by launchd" check needs an equivalent that recognises the
   app.
3. **Licensing (GPL-3.0-only).** A distributed desktop app with the GPL host
   and server inside it is a GPL distribution, so the app is GPL too. That
   matters only if the app is meant to be closed source. Running the server
   as a hosted service does not trigger the GPL's source requirement; the
   AGPL would have. A free app and a paid service fits that cleanly. The
   copyright holder can license the code however they choose, and that
   freedom needs a CLA if outside contributors ever land code here.

## 2. Framework: Electron, not Tauri

Tauri is a good framework, but its advantages do not apply to this app, and
its costs fall exactly where this project has spent the most measurement.

### What is being wrapped is Node

The host is Node. The bundled server is Node with better-sqlite3, a native
module.

- **Electron** has Node built in. The host and server run in a utility
  process unchanged. better-sqlite3 needs rebuilding for Electron's ABI,
  which is a solved problem (`@electron/rebuild`).
- **Tauri** has no Node runtime. Node would ship as a sidecar binary per
  platform. A Node binary is tens of megabytes, which gives back most of
  the size advantage Tauri is usually chosen for, and the stack gains Rust.

### The floor was measured on Chromium

Tauri renders in the system webview: WKWebView on macOS, WebKitGTK on
Linux, WebView2 (Chromium) on Windows. The floor relies on behaviour this
repo measured in Chrome specifically:

- the SharedWorker hub (`src/ui/hub.js`), shared between windows, and the
  Web Locks that tell the floor when a popout has gone (#19)
- `window.open` popouts sharing one stream
- Chrome giving a minimized window one timer wake-up a minute, which the
  lock design exists to survive
- the textarea's native resize handle sending `pointerdown` to the textarea
  and `pointerup` to the document (#13)

Each of those would need measuring again on WebKit, and some would behave
differently. A webview window is not a browser window for `window.open` or
for sharing a worker. Electron's windows are Chromium renderers in one
session, which is what the **verify-ui-change** checks already drive.

### Tauri's usual case does not apply

Its pitch is a small download, a small memory footprint and a tight
permission model. People installing this already run Claude Code, tmux and
several agents, so 150 MB does not matter to them. Electron's hardening is
standard and well documented: context isolation on, Node integration off in
the renderer, the remote page sandboxed.

### Cross-platform is decided by the host, not the shell

The host needs tmux, and its folder dialog (`host/dialog.js`) has a macOS
backend only. The shell widens the platform list neither way.

### When Tauri would be right

If the app were only a thin window onto a remote board, with nothing
running locally. That never happens here, because the host has to run on
the workstation.

## To measure, whichever framework

**The folder dialog moves from a LaunchAgent into the app process.** That
probably fixes the focus problem `host/dialog.js` works around (three of the
four ways measured from a LaunchAgent draw a dialog that never takes focus).
Confirm it with the **measure-the-desktop** skill rather than assuming it.
Until then the dialog stays where it is, and the rule in this repo's
CLAUDE.md holds: no backend goes in before it has been watched taking focus.

#!/usr/bin/env bash
# Install the orchestratinator host on this Mac and keep it running.
#
#   ./host/install.sh <projects-dir> [more dirs…]
#
# Writes ~/.orchestratinator/host.json and registers a LaunchAgent so the host
# starts at login and comes back if it stops. The server address and the shared secret are read from the first
# orchestratinator .mcp.json found under the directories you name, so there is
# nothing else to type. Run it again to change the directories.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.appideas.orchestratinator-host"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CONF_DIR="$HOME/.orchestratinator"
CONF="$CONF_DIR/host.json"
LOG_DIR="$CONF_DIR/log"

# tmux is how the floor drives Claude Code: each desk is a window in one tmux
# session, which the floor types into and you can attach to. Without it the
# host has nothing to drive, so this is a hard requirement rather than a hint.
if ! command -v tmux >/dev/null 2>&1; then
  echo
  echo "tmux is not installed, and the host needs it — each desk is a tmux window." >&2
  if command -v brew >/dev/null 2>&1; then
    echo "Install it with:  brew install tmux" >&2
  else
    echo "Install it with your package manager (e.g. apt install tmux)." >&2
  fi
  exit 1
fi

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <projects-dir> [more dirs…]" >&2
  echo "       the directories your orchestratinator repos live under" >&2
  exit 2
fi

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then echo "node is not on PATH" >&2; exit 1; fi
if ! command -v claude >/dev/null; then echo "claude is not on PATH — install Claude Code and sign in first" >&2; exit 1; fi

mkdir -p "$CONF_DIR" "$LOG_DIR"

# Roots as a JSON array, absolute.
ROOTS="["
for d in "$@"; do
  abs="$(cd "$d" 2>/dev/null && pwd || true)"
  if [ -z "$abs" ]; then echo "not a directory: $d" >&2; exit 1; fi
  ROOTS="$ROOTS\"$abs\","
done
ROOTS="${ROOTS%,}]"

# Keep anything already in the file that this script doesn't manage (url, token, name).
if [ -f "$CONF" ]; then
  "$NODE" -e '
    const fs = require("fs"); const f = process.argv[1]; const roots = JSON.parse(process.argv[2]);
    let c = {}; try { c = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
    c.roots = roots; fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");
  ' "$CONF" "$ROOTS"
else
  printf '{\n  "roots": %s\n}\n' "$ROOTS" > "$CONF"
fi
echo "wrote $CONF"

# No install step: the host has no dependencies. It drives the `claude` already
# on this machine — the one that is signed in — through tmux, and talks to the
# server with fetch. Nothing to download, nothing to keep in step with a release.

# The LaunchAgent. PATH is set explicitly because launchd does not read your
# shell profile, and the host needs to find both node and claude.
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$HERE/index.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE"):$(dirname "$(command -v claude)"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>WorkingDirectory</key><string>$HERE</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/host.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/host.log</string>
</dict>
</plist>
PLIST

# bootout is asynchronous: bootstrapping straight after it fails with launchd's
# "5: Input/output error" while the old job is still going away. Wait for it.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
  sleep 1
done
STARTED=""
for _ in 1 2 3 4 5; do
  if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then STARTED=1; break; fi
  sleep 1
done
if [ -z "$STARTED" ]; then
  echo "could not start $LABEL — try: launchctl bootstrap gui/$(id -u) $PLIST" >&2
  exit 1
fi
echo "started $LABEL — log: $LOG_DIR/host.log"

echo
echo "To sit at a desk yourself:          tmux attach -t ${ORCH_TMUX_SESSION:-orch}"
echo "  (each desk is a window in it — the same session the floor types into)"
echo "To stop the host:                   launchctl bootout gui/$(id -u)/$LABEL"
echo "To see it:                          tail -f $LOG_DIR/host.log"

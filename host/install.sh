#!/usr/bin/env bash
# Install the orchestratinator host on this Mac and keep it running.
#
#   ./host/install.sh [--url <board>] <projects-dir> [more dirs…]
#
# Writes ~/.orchestratinator/host.json and registers a LaunchAgent so the host
# starts at login and comes back if it stops. The shared secret is read from a
# desk's .mcp.json, so there is nothing else to type. The server address is read
# the same way when every desk agrees on one; when they don't, --url settles it
# and the host refuses to start until something does. Run it again to change the
# directories.
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

URL=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --url) URL="${2:-}"; [ -n "$URL" ] || { echo "--url needs a value, e.g. --url http://localhost:8787" >&2; exit 2; }; shift 2 ;;
    --url=*) URL="${1#--url=}"; shift ;;
    --) shift; break ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) break ;;
  esac
done

if [ "$#" -lt 1 ]; then
  echo "usage: $0 [--url <board>] <projects-dir> [more dirs…]" >&2
  echo "       the directories your orchestratinator repos live under" >&2
  echo "       --url pins the board this host serves, for a machine whose desks" >&2
  echo "            point at more than one (e.g. --url http://localhost:8787)" >&2
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

# Keep anything already in the file that this script doesn't manage (token, name),
# and the url too unless --url was given. Writing roots is the whole job here;
# everything else in that file was put there deliberately.
"$NODE" -e '
  const fs = require("fs"); const [f, rootsJson, url] = process.argv.slice(1);
  let c = {}; try { c = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  c.roots = JSON.parse(rootsJson);
  if (url) c.url = url.replace(/\/+$/, "");
  fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");
' "$CONF" "$ROOTS" "$URL"
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

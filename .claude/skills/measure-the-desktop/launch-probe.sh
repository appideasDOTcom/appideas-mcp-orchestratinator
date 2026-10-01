#!/bin/bash
# Run a node script under a throwaway LaunchAgent with the host's own plist
# shape — same node binary, same environment keys, gui domain — so what it
# does to the desktop is what the host would do.
#
#   launch-probe.sh <script.mjs> [args for the script…]
#   launch-probe.sh --stop
#
# The script is handed the path of an out.jsonl as its first argument, then
# yours. Work files go in $PROBE_DIR (default: a directory under $TMPDIR),
# never in the repo. The live host is not touched: this is a separate job
# with its own label, and --stop removes it.
set -u
LABEL="com.appideas.orchestratinator-desktop-probe"
DIR="${PROBE_DIR:-${TMPDIR:-/tmp}/orch-desktop-probe}"
if [ "${1:-}" = "--stop" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
  echo "stopped; left in $DIR: $(ls "$DIR" 2>/dev/null | tr '\n' ' ')"
  exit 0
fi
SCRIPT="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"; shift
mkdir -p "$DIR"; : > "$DIR/out.jsonl"; : > "$DIR/probe.log"
# The node the installed host runs with, read from its plist — a probe under a
# different node is a probe of a different thing (TCC attributes by binary).
NODE="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$HOME/Library/LaunchAgents/com.appideas.orchestratinator-host.plist" 2>/dev/null || command -v node)"
ARGS="<string>$NODE</string><string>$SCRIPT</string><string>$DIR/out.jsonl</string>"
for a in "$@"; do ARGS="$ARGS<string>$a</string>"; done
cat > "$DIR/probe.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>$ARGS</array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$NODE"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$DIR/probe.log</string>
  <key>StandardErrorPath</key><string>$DIR/probe.log</string>
</dict></plist>
PL
# bootout is asynchronous; bootstrapping straight after it fails. Same wait as host/install.sh.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
for _ in 1 2 3 4 5; do launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break; sleep 0.3; done
launchctl bootstrap "gui/$(id -u)" "$DIR/probe.plist" && echo "started under launchd; reading $DIR/out.jsonl"

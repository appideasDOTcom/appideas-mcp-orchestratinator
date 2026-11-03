#!/bin/bash
# Run capture.mjs on this machine as a LaunchAgent, so it watches with no
# session open — and stop it again.
#
#   .claude/skills/capture-a-burst/install.sh             # install (or reinstall) and start
#   .claude/skills/capture-a-burst/install.sh --uninstall # stop it and remove the agent
#
# It runs capture.mjs from this working tree, like the host runs host/: an
# edit takes effect on the next reinstall (or `launchctl kickstart -k`).
# Captures go to ~/.orchestratinator/captures/, its own log to
# ~/.orchestratinator/log/capture.log. It never writes host.log.
set -eu
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL=com.appideas.orchestratinator-capture
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/.orchestratinator/log"

stop() {
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  # bootout is asynchronous (host/install.sh): wait for the job to go.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || return 0
    sleep 1
  done
}

if [ "${1:-}" = "--uninstall" ]; then
  stop
  rm -f "$PLIST"
  echo "stopped $LABEL and removed $PLIST (captures kept in ~/.orchestratinator/captures)"
  exit 0
fi

# The node the host runs under, so both read the same version; else the PATH's.
NODE="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$HOME/Library/LaunchAgents/com.appideas.orchestratinator-host.plist" 2>/dev/null || command -v node)"
mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$HERE/capture.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE"):/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>WorkingDirectory</key><string>$HERE</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/capture.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/capture.log</string>
</dict>
</plist>
PLIST

stop
for _ in 1 2 3 4 5; do
  if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
    echo "started $LABEL — log: $LOG_DIR/capture.log, captures: ~/.orchestratinator/captures"
    echo "To stop it:  $HERE/install.sh --uninstall"
    exit 0
  fi
  sleep 1
done
echo "could not start $LABEL — try: launchctl bootstrap gui/$(id -u) $PLIST" >&2
exit 1

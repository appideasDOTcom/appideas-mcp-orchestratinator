#!/bin/bash
# Who is frontmost, and where a process's windows sit, every 0.6 s.
#
#   watch-front.sh <window-owner-name> [ticks]     e.g. watch-front.sh osascript 12
#
# Frontmost comes from lsappinfo and the windows from CGWindowList (windows,
# built from windows.swift) — neither needs a permission. `layer=8` is a modal
# panel: drawn above every ordinary window whether or not it has the keyboard,
# which is exactly the difference this exists to see.
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="${PROBE_DIR:-${TMPDIR:-/tmp}/orch-desktop-probe}/windows"
[ -x "$BIN" ] || { mkdir -p "$(dirname "$BIN")"; swiftc -O "$HERE/windows.swift" -o "$BIN" || exit 1; }
OWNER="$1"; N="${2:-10}"
for i in $(seq 1 "$N"); do
  sleep 0.6
  echo "t$i front=$(lsappinfo info -only name "$(lsappinfo front)" | cut -d= -f2) pid=$(lsappinfo info -only pid "$(lsappinfo front)" | cut -d= -f2) | $("$BIN" "$OWNER" | grep "	$OWNER	" | tr '\n' ' ')"
done

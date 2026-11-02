#!/bin/bash
# Send one key to a dialog — only if that dialog's process is the frontmost one.
#
#   press.sh <pgrep -f pattern for the dialog's process> <System Events action>
#   press.sh NSOpenPanel 'key code 36'        # Return: the default button
#   press.sh NSOpenPanel 'key code 53'        # Escape: Cancel
#   press.sh NSOpenPanel 'keystroke "beta"'   # type-select a row
#
# A keystroke goes to whatever is frontmost. If that is not the dialog it is
# the operator's browser, and Return there sends whatever they were typing.
# So the frontmost pid is compared with the dialog's pid first, and nothing
# is sent on a mismatch.
P=$(pgrep -f "$1" | head -1)
F=$(lsappinfo info -only pid "$(lsappinfo front)" | cut -d= -f2)
if [ -n "$P" ] && [ "$P" = "$F" ]; then
  osascript -e "tell application \"System Events\" to $2" && echo "sent: $2"
else
  echo "NOT sent ($2): dialog pid=${P:-none} frontmost pid=$F"; exit 1
fi

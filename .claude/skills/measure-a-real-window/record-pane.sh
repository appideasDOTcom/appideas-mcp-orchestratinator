#!/bin/bash
# Record the probe's pane while a command runs, then count the frames that
# showed each thing looked for. It answers "did this dialog ever stand on
# the window?", which the pane afterwards cannot: the host answers a dialog
# in well under a second, and a dialog that never came looks the same.
#
#   record-pane.sh [-p <words>]… <log> -- <command…>
#
#   SP=…/scratchpad
#   .claude/skills/measure-a-real-window/record-pane.sh "$SP/rec-opus-effort.log" -- \
#     env ORCH_TMUX="$SP/tmuxw" ORCH_TMUX_SESSION=p \
#     node .claude/skills/measure-a-real-window/send.mjs "$SP/probe" '/effort low'
#   # frames: <how many were taken>
#   # frames with 'Switch model?': 0
#   # frames with 'Change effort level?': 0
#
# A frame is the pane's last ten non-empty lines on one line, joined by |,
# taken about seven times a second (an 80 ms pause plus tmux's own time) from
# before the command starts until half a second after it ends. With no -p it
# looks for the two titles of the cache warning.
# The words are matched as they are (grep -F), so a ? is a ?.
#
# PROBE_SOCKET (default `probe`) and PROBE_TARGET (default `p:probe`) name
# the pane, as probe.mjs makes it. The exit code is the command's.
#
# Written for PR #55 finding 1 (2026-11-15): nine recordings across four
# model families, 0 frames of "Change effort level?" and 1–3 of "Switch
# model?" on each /model between them. A count of 0 means something only
# beside a count above 0 from the same recorder, so record a /model on a
# conversation with a reply in it first and see its warning counted.
# A /model or /effort writes the operator's settings.json: restore-settings.py.
set -u
SOCK="${PROBE_SOCKET:-probe}"; TARGET="${PROBE_TARGET:-p:probe}"
pats=()
while [ "${1:-}" = "-p" ]; do
  [ -n "${2:-}" ] || { echo "record-pane.sh: -p takes the words to look for" >&2; exit 2; }
  pats+=("$2"); shift 2
done
if [ -z "${1:-}" ] || [ "${2:-}" != "--" ] || [ -z "${3:-}" ]; then
  echo "usage: record-pane.sh [-p <words>]… <log> -- <command…>" >&2; exit 2
fi
LOG="$1"; shift 2
[ ${#pats[@]} -gt 0 ] || pats=('Switch model?' 'Change effort level?')
if ! tmux -L "$SOCK" list-panes -t "$TARGET" >/dev/null 2>&1; then
  echo "record-pane.sh: no pane $TARGET on tmux socket $SOCK — is the probe up?" >&2; exit 2
fi
frame() { tmux -L "$SOCK" capture-pane -p -t "$TARGET" | grep -v '^[[:space:]]*$' | tail -10 | tr '\n' '|'; echo; }
RUN="$LOG.recording"; : > "$RUN"; : > "$LOG"
( while [ -e "$RUN" ]; do frame; sleep 0.08; done ) >> "$LOG" &
REC=$!
"$@"; CODE=$?
sleep 0.5; rm -f "$RUN"; wait "$REC"
echo "frames: $(wc -l < "$LOG" | tr -d ' ')"
for p in "${pats[@]}"; do echo "frames with '$p': $(grep -c -F -e "$p" "$LOG")"; done
echo "--- the pane now"
tmux -L "$SOCK" capture-pane -p -t "$TARGET" | grep -v '^[[:space:]]*$' | tail -12
exit "$CODE"

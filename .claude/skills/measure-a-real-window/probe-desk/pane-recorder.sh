#!/bin/zsh
# Every change to a pane's visible screen, with ms stamps — the bottom line is
# the status line, so footers read positionally. 0.15 s samples for 90 min.
#   pane-recorder.sh <out-file> <tmux-target>     e.g. orch:coord-probe-249
OUT="$1"; PANE="$2"; : > "$OUT"; last=""
for i in $(seq 1 36000); do
  scr=$(tmux capture-pane -p -t "$PANE" 2>/dev/null)
  if [ "$scr" != "$last" ]; then
    { echo "=== $(perl -MTime::HiRes=time -e 'my $t=time; my @g=gmtime($t); printf "%02d:%02d:%02d.%03d", $g[2],$g[1],$g[0],($t-int($t))*1000') ==="; print -r -- "$scr"; echo; } >> "$OUT"
    last="$scr"
  fi
  sleep 0.15
done

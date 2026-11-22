#!/bin/sh
# What is that desk's window doing right now, and what is its step held on?
#
#   .claude/skills/diagnose-handoff/desk-step.sh <folder name or part of its path> [<tmux session>]
#
# Reads only: nothing is typed, killed or resized. For the floor window whose
# folder matches, it prints the bottom of the pane (the turn's elapsed time
# and the step's own label and time are there), then every process under the
# pane with how long each has run, oldest first. Exit 1 with words when no
# window matches, 2 when several do.
#
# What to read in it (2026-11-19, a desk that said "about two minutes" and
# had run seven): a step is `zsh -c … | tail` and it ends when every process
# holding the pipe has exited. There the script had finished and deleted its
# own scratch folder, and the test app it launched was still alive, so tail
# never saw the end of its input. A leaf process older than the step's
# estimate, with a parent that is done, is the thing holding it. A long step
# whose leaves are seconds old is slow, not stuck: at a load average of 600
# a four-minute suite took fifteen.
#
# Another agent's processes are not yours to kill. Message the agent with
# what you read; if the operator wants it freed now, hand him the one
# command (`! kill -9 <pid>`), which the permission check will refuse you.
set -u
WANT=${1:-}; SESSION=${2:-orch}
[ -n "$WANT" ] || { echo "usage: $0 <folder name or part of its path> [<tmux session>]" >&2; exit 2; }
ROWS=$(tmux list-panes -s -t "=$SESSION:" -F '#{session_name}:#{window_id}.#{pane_id} #{pane_pid} #{pane_current_path}' 2>/dev/null) || { echo "no tmux session named exactly \"$SESSION\" on the default socket" >&2; exit 1; }
HIT=$(printf '%s\n' "$ROWS" | awk -v w="$WANT" 'index($3, w)')
N=$(printf '%s' "$HIT" | grep -c . || true)
[ "$N" -eq 0 ] && { echo "no window in $SESSION whose folder contains \"$WANT\". Its windows:" >&2; printf '%s\n' "$ROWS" | awk '{print "  " $3}' >&2; exit 1; }
[ "$N" -gt 1 ] && { echo "\"$WANT\" matches $N windows; say more of the path:" >&2; printf '%s\n' "$HIT" | awk '{print "  " $3}' >&2; exit 2; }
TARGET=$(printf '%s' "$HIT" | awk '{print $1}'); PID=$(printf '%s' "$HIT" | awk '{print $2}')
echo "$(date '+%l:%M:%S%p %Z')  load$(/usr/sbin/sysctl -n vm.loadavg)  window $TARGET  $(printf '%s' "$HIT" | awk '{print $3}')"
echo "── the pane's last lines ──"
tmux capture-pane -p -S -40 -t "$TARGET" | grep -v '^[[:space:]]*$' | tail -18 | cut -c1-200
echo "── processes under it (pid, running for, command) ──"
ps -Ao pid=,ppid=,etime=,command= | python3 -c "
import sys
rows=[l.split(None,3) for l in sys.stdin if len(l.split(None,3))==4]
kids={}
for pid,ppid,et,cmd in rows: kids.setdefault(ppid,[]).append((pid,et,cmd))
n=[0]
def walk(pid,d):
    for p,et,cmd in kids.get(pid,[]):
        n[0]+=1; print('  '*d+p, et, ' '.join(cmd.split())[:150]); walk(p,d+1)
for p,et,cmd in kids.get('$PID',[]): walk(p,1)
if not n[0]: print('  (none: no step is running; the window is at its prompt or thinking)')
"

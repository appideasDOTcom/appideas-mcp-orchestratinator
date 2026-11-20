#!/bin/sh
# What this machine has of the orchestratinator right now, one reading a line:
# the two boards, the hosts, the floor's tmux session, Claude Code's own
# records, the plugin, and this window's environment. Read-only; prints no key.
#
#   machine-state.sh
#
# Written 2026-11-20, after a clean-up meant for another Mac was run on this
# one. Each line is something that was gone, or looked gone, that afternoon.
say() { printf '%-22s %s\n' "$1" "$2"; }
health() { curl -s -m 3 "$1/health" 2>/dev/null | sed -E 's/.*"version":"([^"]*)".*"commit":("?[^,"]*"?).*/\1 commit \2/' ; }

for b in http://localhost:8787 http://127.0.0.1:6724; do
  h=$(health "$b"); say "board $b" "${h:-not answering}"
done
say "launchd host" "$(launchctl print "gui/$(id -u)/com.appideas.orchestratinator-host" 2>&1 | grep -m1 -e 'state =' -e 'Could not find' | sed 's/^[[:space:]]*//')"
say "its plist" "$(ls "$HOME/Library/LaunchAgents/com.appideas.orchestratinator-host.plist" 2>/dev/null || echo missing)"
say "host.json" "$([ -f "$HOME/.orchestratinator/host.json" ] && sed -n 's/.*"url"[^"]*"\([^"]*\)".*/url \1/p' "$HOME/.orchestratinator/host.json" || echo missing)"
say "app's host" "$(pgrep -f 'Orchestratinator|orchestratinator-desktop/node_modules/electron' >/dev/null && echo 'an Orchestratinator app process is running' || echo 'no app process')"
say "hook's node link" "$(ls -l "$HOME/.orchestratinator/bin/node" 2>/dev/null | sed 's/.*-> /-> /' || echo missing)"
say "tmux (default)" "$(tmux ls 2>&1 | tr '\n' ';' | cut -c1-120)"
say "floor windows" "$(tmux list-panes -s -t '=orch:' -F '#{window_index}:#{pane_pid}:#{b:pane_current_path}' 2>/dev/null | tr '\n' ' ')"
say "session records" "$(ls "$HOME/.claude/sessions" 2>/dev/null | grep -c '^[0-9]*\.json$') in ~/.claude/sessions"
say "transcripts" "$(ls "$HOME/.claude/projects" 2>/dev/null | wc -l | tr -d ' ') project folders in ~/.claude/projects"
say "claude" "$(command -v claude || echo 'not on PATH') $(claude --version 2>/dev/null)"
say "plugin" "$(claude plugin list 2>/dev/null | grep -A1 -e 'orchestratinator-floor' | tr -s ' \n' ' ' | cut -c1-110)"
say "this folder's board" "$(claude mcp get orchestratinator 2>/dev/null | sed -n 's/^ *URL: //p;s/^ *X-Channel: /channel /p;s/^ *X-Agent: /agent /p' | tr '\n' ' ')"
say "ORCH_ in this shell" "$(env | grep -c '^ORCH_') variables$(env | grep -o -E '^ORCH_[A-Z_]+' | tr '\n' ' ' | sed 's/^/: /')"
say "TMPDIR" "${TMPDIR:-unset (os.tmpdir() is /tmp)}"
say "Time Machine" "$(defaults read /Library/Preferences/com.apple.TimeMachine AutoBackup 2>/dev/null | sed 's/^0$/off/;s/^1$/on/') · local snapshots: $(tmutil listlocalsnapshots / 2>/dev/null | grep -c 'com.apple')"

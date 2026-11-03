#!/bin/sh
# A probe folder for the floor to take as a desk, with its own hook capture.
#   make-probe.sh <folder>          e.g. /Users/you/Documents/dev/appideas/coord-probe-NNN  (under the host's roots)
# Writes .claude/settings.json registering hooklog.sh on every hook event, so
# each payload lands in <folder>/hooks.log with a millisecond stamp; a
# CLAUDE.md that tells the probe it is a fixture; and a filler file to read
# when a compaction needs a real context behind it (~85k tokens a read).
# Then: POST /api/floor/browse for the parent, GET it, POST /api/floor/desk —
# see SKILL.md "A probe desk on a throwaway board".
set -e
P="$1"; [ -n "$P" ] || { echo "usage: make-probe.sh <folder>" >&2; exit 2; }
mkdir -p "$P/.claude"
cp "$(dirname "$0")/hooklog.sh" "$P/.claude/hooklog.sh"; chmod +x "$P/.claude/hooklog.sh"
node -e '
const ev=["SessionStart","SessionEnd","UserPromptSubmit","Stop","StopFailure","PreCompact","PostCompact","PreModelSwitch","PostModelSwitch","Notification","PreToolUse","PostToolUse"];
const hooks={};for(const e of ev)hooks[e]=[{hooks:[{type:"command",command:process.argv[1]+"/.claude/hooklog.sh",timeout:10}]}];
require("fs").writeFileSync(process.argv[1]+"/.claude/settings.json",JSON.stringify({hooks},null,2)+"\n");' "$P"
cat > "$P/CLAUDE.md" <<'MD'
# probe

A throwaway measurement fixture for the orchestratinator. Nothing here is real work. When asked to reply with a single word, do exactly that and nothing else.
MD
for i in $(seq 1 1200); do echo "row $i: $(openssl rand -hex 48)"; done > "$P/filler.txt"
: > "$P/hooks.log"
echo "probe folder ready: $P (hooks → $P/hooks.log)"

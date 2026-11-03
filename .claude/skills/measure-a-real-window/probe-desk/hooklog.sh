#!/bin/sh
# Append every hook payload to <folder>/hooks.log with a millisecond UTC stamp.
# The folder is the script's grandparent (<folder>/.claude/hooklog.sh).
p=$(cat)
ts=$(perl -MTime::HiRes=time -e 'my $t=time; my @g=gmtime($t); printf "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", $g[5]+1900,$g[4]+1,$g[3],$g[2],$g[1],$g[0],($t-int($t))*1000')
printf '%s %s\n' "$ts" "$p" >> "$(cd "$(dirname "$0")/.." && pwd)/hooks.log"
exit 0

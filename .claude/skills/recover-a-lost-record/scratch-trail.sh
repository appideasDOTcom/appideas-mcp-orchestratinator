#!/bin/sh
# What earlier sessions in a folder left in their scratch directories, in the
# order it was written: every log, list and task output, with its time.
#
#   scratch-trail.sh [-s <since, e.g. "2026-11-19 18:00">] [folder]
#   scratch-trail.sh -g <pattern> [folder]      # the lines that match, by file
#
# folder defaults to the current directory. Read-only.
#
# Why it exists (2026-11-20): every transcript of this project was deleted
# with ~/.claude, and the record of the lost day's work turned out to be
# here. A session's scratchpad and the outputs of its background commands
# are under /private/tmp/claude-<uid>/<the folder, slashes as dashes>/<session
# id>/, which is not under ~/.claude. From it that day: both release gates'
# results, which suite runs were red and on which rows, the mutant run a
# kill had cut off and its list, and the probes' captured screens.
#
# It is /tmp: a reboot empties it. Copy out what matters the same day.
SINCE=""; PAT=""
while getopts "s:g:" o; do case "$o" in s) SINCE="$OPTARG" ;; g) PAT="$OPTARG" ;; *) exit 2 ;; esac; done
shift $((OPTIND - 1))
DIR="$(cd "${1:-.}" && pwd -P)" || exit 2
ROOT="/private/tmp/claude-$(id -u)/$(printf '%s' "$DIR" | sed 's|[/.]|-|g')"
[ -d "$ROOT" ] || { echo "nothing at $ROOT (no session of this folder left a scratch directory, or the machine was restarted)"; exit 1; }
echo "# $ROOT"
for s in $(ls -tr "$ROOT"); do
  [ -d "$ROOT/$s" ] || continue
  if [ -n "$PAT" ]; then
    grep -r -l -a -e "$PAT" "$ROOT/$s" 2>/dev/null | while read -r f; do
      echo "== ${f#"$ROOT"/}"; grep -a -n -e "$PAT" "$f" | cut -c1-240 | head -20
    done
    continue
  fi
  n=$(find "$ROOT/$s" -type f ${SINCE:+-newermt "$SINCE"} 2>/dev/null | wc -l | tr -d ' ')
  [ "$n" = 0 ] && continue
  echo "== session $s ($n files${SINCE:+ since $SINCE})"
  find "$ROOT/$s" -maxdepth 4 -type f ${SINCE:+-newermt "$SINCE"} -exec stat -f '%Sm %z %N' -t '%m-%d %H:%M:%S' {} + 2>/dev/null \
    | sort | sed "s|$ROOT/$s/||" | awk '{ printf "  %s %s %9s  %s\n", $1, $2, $3, $4 }'
done

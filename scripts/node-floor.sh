# Source this, do not run it:
#
#   . scripts/node-floor.sh || exit 2        # in a script
#   . scripts/node-floor.sh && npm test      # by hand
#
# It leaves a Node that can load this tree's better-sqlite3 first on PATH for
# the rest of the shell, or says in words that this machine has none.
#
# Why it exists (task #291, 2026-11-07; CLAUDE.md, "The host under the desktop
# app"): better-sqlite3 13 is a Node-API 10 binary, and a Node that offers
# Node-API 9 (20.x, 22.x before 22.14) does not fail to load it. The process
# segfaults, exit 139, with no words. The server says so first
# (src/node-floor.js), but a script that starts the server with its output in
# a log file reads a dead port, and one that requires better-sqlite3 itself
# reads nothing at all. This machine's default `node` is nvm's 20.20.1, so
# every runner under .claude/skills sources this before it starts anything.
#
# What it decides by is process.versions.napi, the thing actually required,
# never the version number. With a `node` on PATH that has it, nothing
# changes. Otherwise the oldest Node under nvm that has it goes first on
# PATH, said on stderr. Oldest, not newest: it is the one nearest the board's
# image (node:22) and the one the suites were run on, and a major installed
# yesterday should not become what every check runs on by being newest (the
# first cut picked 26.13.0 the day it appeared beside 24.22.2). It picks
# rather than refuses because the remedy is known and the same every time; it
# refuses, in words, only when there is nothing to pick.
_orch_node_floor() {
  _orch_cur=$(command -v node 2>/dev/null)
  _orch_was="no node"
  _orch_napi=0
  if [ -n "$_orch_cur" ]; then
    _orch_was=$("$_orch_cur" -v 2>/dev/null)
    _orch_napi=$("$_orch_cur" -p 'process.versions.napi' 2>/dev/null)
  fi
  case "$_orch_napi" in ''|*[!0-9]*) _orch_napi=0 ;; esac
  if [ "$_orch_napi" -ge 10 ]; then return 0; fi
  _orch_root="${NVM_DIR:-$HOME/.nvm}/versions/node"
  # Oldest first, by number and not as text: v9 sorts after v10 as text.
  for _orch_v in $(ls "$_orch_root" 2>/dev/null | sort -t. -k1.2,1n -k2,2n -k3,3n); do
    _orch_n=$("$_orch_root/$_orch_v/bin/node" -p 'process.versions.napi' 2>/dev/null)
    case "$_orch_n" in ''|*[!0-9]*) continue ;; esac
    if [ "$_orch_n" -ge 10 ]; then
      PATH="$_orch_root/$_orch_v/bin:$PATH"; export PATH
      echo "node-floor: node on PATH is $_orch_was (Node-API $_orch_napi); using $_orch_root/$_orch_v/bin for this shell" >&2
      return 0
    fi
  done
  echo "node-floor: node on PATH is $_orch_was (Node-API $_orch_napi) and nothing under $_orch_root offers Node-API 10. This tree's better-sqlite3 needs Node 22.14 or later; an older one dies loading it with no words (exit 139)." >&2
  return 1
}
_orch_node_floor

#!/bin/sh
# What the LaunchAgent starts (install.sh writes it into the plist): pick the
# host's Node now, at this start, and become it. node.sh has the rule and why
# it is picked here and not at install. `exec`, so launchd's job is the host
# process itself: its pid, its signals, its exit.
#
# No Node of the major: the reason goes to the host log and the job exits 1;
# launchd tries again (KeepAlive) about every ten seconds, and each try says it.
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/node.sh"
if ! pick_node; then
  echo "[host] $(date -u +%Y-%m-%dT%H:%M:%S.000Z) not started: see the line above" >&2
  exit 1
fi
# First on PATH, as the plist's PATH put the installed Node when it named
# one: what the host starts by name (a `claude` whose shebang is
# `env node`) finds this one.
PATH="$(dirname "$NODE"):$PATH"
export PATH
exec "$NODE" "$HERE/index.js" "$@"

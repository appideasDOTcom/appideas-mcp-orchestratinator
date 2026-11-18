# Which Node the host runs on. Sourced, never run: by install.sh, which
# says it when it installs the LaunchAgent, and by run.sh, which the
# LaunchAgent starts and which picks again at every start.
#
# The major is the one the board's image ships and the release gate tests
# (costmo's ruling on the milestone audit's finding 5, 2026-11-17: one major
# for what ships and what is tested). The Dockerfile's FROM says which, and
# test:host holds this number to it. Not "whatever node is first on PATH":
# on this machine that is a Node 20 kept as the shell's default, and the
# host ran on it while every suite ran the host on 24. ORCH_NODE names one
# outright; otherwise the first Node of this major of: PATH, nvm's newest,
# Homebrew's node@<major>. The shell's default node is left alone either way.
#
# Picked at every start, not once at install (QA, the milestone audit's
# re-measure, L3): an update restarts the host by exiting and letting
# launchd start it again, and a plist that named a Node binary kept the
# host on that binary through any update that moved the major. With the
# pick here, a bump is this number and the restart the update already does.
ORCH_NODE_MAJOR=24

node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null; }

# Sets NODE, or says why not on stderr and returns 1.
pick_node() {
  NODE=""
  if [ -n "${ORCH_NODE:-}" ]; then
    if [ "$(node_major "$ORCH_NODE")" != "$ORCH_NODE_MAJOR" ]; then
      echo "ORCH_NODE is $ORCH_NODE, which is not Node $ORCH_NODE_MAJOR (the host runs on the major the board ships and the suites test)" >&2
      return 1
    fi
    NODE="$ORCH_NODE"
    return 0
  fi
  for cand in "$(command -v node || true)" "$(ls -d "$HOME"/.nvm/versions/node/v$ORCH_NODE_MAJOR.*/bin/node 2>/dev/null | sort -t. -k2,2n -k3,3n | tail -1)" /opt/homebrew/opt/node@$ORCH_NODE_MAJOR/bin/node /usr/local/opt/node@$ORCH_NODE_MAJOR/bin/node; do
    if [ -n "$cand" ] && [ -x "$cand" ] && [ "$(node_major "$cand")" = "$ORCH_NODE_MAJOR" ]; then NODE="$cand"; return 0; fi
  done
  echo "no Node $ORCH_NODE_MAJOR found (PATH, ~/.nvm, Homebrew node@$ORCH_NODE_MAJOR): install one, or name it with ORCH_NODE=/path/to/node" >&2
  return 1
}

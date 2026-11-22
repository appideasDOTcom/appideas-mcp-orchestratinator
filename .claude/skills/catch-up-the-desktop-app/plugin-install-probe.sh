#!/bin/sh
# What does `claude plugin` do with this tree's plugin as a directory
# marketplace, on the Claude Code installed now, with nobody to answer?
#
#   .claude/skills/catch-up-the-desktop-app/plugin-install-probe.sh [<marketplace name>]
#
# It is how the desktop app installs the plugin (contract
# orchestratinator.app_setup): copy .claude-plugin/marketplace.json and
# plugin/ to a real directory, rename the marketplace, `marketplace add`,
# `install`. This runs exactly that in a throwaway HOME and CLAUDE_CONFIG_DIR
# with stdin closed, twice (the second time must be a no-op), and reads
# `claude plugin list --json`. The operator's own plugins are never touched:
# nothing here runs without the throwaway config dir set.
#
# Exit 0 when both commands exit 0 both times and the list shows
# orchestratinator-floor@<name>, enabled, read from the copy. Run it when
# `claude --version` moves, before telling the app's agent the commands hold.
set -u
HERE=$(cd "$(dirname "$0")/../../.." && pwd)
NAME=${1:-orchestratinator-app}
T=$(mktemp -d "${TMPDIR:-/tmp}/orch-plugin-probe.XXXXXX")
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/home" "$T/mkt/.claude-plugin"
cp -R "$HERE/plugin" "$T/mkt/plugin" || exit 2
sed "s/\"name\": \"appideas-orchestratinator\"/\"name\": \"$NAME\"/" "$HERE/.claude-plugin/marketplace.json" > "$T/mkt/.claude-plugin/marketplace.json"
grep -q "\"name\": \"$NAME\"" "$T/mkt/.claude-plugin/marketplace.json" || { echo "the marketplace's name line is not where this script expects it in .claude-plugin/marketplace.json" >&2; exit 2; }
export HOME="$T/home" CLAUDE_CONFIG_DIR="$T/home/.claude" DISABLE_AUTOUPDATER=1
cd "$T/home" || exit 2
echo "claude $(claude --version 2>&1)"
fail=0
run() { out=$("$@" </dev/null 2>&1); rc=$?; echo "  exit $rc: $* -> $(printf '%s' "$out" | tr '\n' ' ' | sed "s|$T|<tmp>|g" | cut -c1-200)"; [ $rc -eq 0 ] || fail=1; }
for pass in first second; do
  echo "$pass pass"
  run claude plugin marketplace add "$T/mkt"
  run claude plugin install "orchestratinator-floor@$NAME"
done
claude plugin list --json </dev/null > "$T/list.json" 2>/dev/null || fail=1
python3 - "$T/list.json" "$NAME" "$T" <<'PY' || fail=1
import json,sys
rows=json.load(open(sys.argv[1])); want='orchestratinator-floor@'+sys.argv[2]
mine=[r for r in rows if r.get('id')==want]
if len(rows)!=1 or len(mine)!=1: print('  list --json: wanted exactly',want,'and got',[r.get('id') for r in rows]); sys.exit(1)
r=mine[0]; ok=r.get('enabled') is True and str(r.get('readFromFolder','')).endswith('/mkt/plugin')
print('  list --json:',r['id'],r.get('version'),'scope',r.get('scope'),'enabled',r.get('enabled'),'readFromFolder',str(r.get('readFromFolder')).replace(sys.argv[3],'<tmp>'))
sys.exit(0 if ok else 1)
PY
[ $fail -eq 0 ] && echo "holds: both commands exit 0 with stdin closed, twice, and the plugin loads in place from the copy" || echo "DOES NOT HOLD: read the lines above"
exit $fail

#!/bin/bash
# What a dependency at a version actually does here, before package.json
# changes: under every Node on this machine, inside the board's image base,
# against the live database, and in its own source. Readings only. It
# installs into a scratch folder, mounts the live data read-only, and builds
# the tree's image under a throwaway tag it removes; the tree, the live
# container and the live database are never written. SKILL.md has the why.
#
#   try-dep.sh <name>@<version> [--probe file.cjs] [--grep 'text'] [--live-db] [--image]
#
#   try-dep.sh better-sqlite3@13.0.3
#   try-dep.sh better-sqlite3@13.0.3 --live-db
#   try-dep.sh better-sqlite3@12.11.1 --grep 'context->GetIsolate()'
#   try-dep.sh better-sqlite3@13.0.3 --image      # after package.json has the version
#
# --probe   a CommonJS file run in place of the default. The default is
#           probe-<name>.cjs beside this script when there is one, and a bare
#           `require(name)` when there is not. A bare require proves little
#           for a native module: better-sqlite3 opens its binary at the first
#           `new Database()`, so its require succeeds on a Node that then
#           segfaults. A probe has to use the thing. It gets TRY_DEP_NAME, and
#           DB_PATH with --live-db.
# --grep    count a fixed string in the published package's files (npm pack).
#           Grep the call as the source writes it, not the name a compiler
#           error gives it: v8::Context::GetIsolate is `context->GetIsolate()`
#           in the file, and the qualified name is in no file at all.
# --live-db mount the board's named volume read-only at /data for the runs
#           inside Docker. Nothing on this machine's own disk is the live data.
# --image   also build the tree's image (what compose builds, with its .git
#           context) and run the probe in it: the tree's package.json, not
#           the argument, decides the version there.
# KEEP=1    leave the scratch folder and print where it is.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
SPEC="${1:-}"
if [ -z "$SPEC" ] || [ "${SPEC#-}" != "$SPEC" ]; then sed -n '2,33p' "$0"; exit 2; fi
shift
PROBE=""; GREP=""; LIVE=0; IMAGE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --probe) PROBE="$2"; shift 2 ;;
    --grep) GREP="$2"; shift 2 ;;
    --live-db) LIVE=1; shift ;;
    --image) IMAGE=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
NAME="${SPEC%@*}"
S="$(mktemp -d "${TMPDIR:-/tmp}/try-dep.XXXXXX")"
done_() { if [ "${KEEP:-0}" = 1 ]; then echo "scratch kept: $S"; else rm -rf "$S"; fi; }
trap done_ EXIT
mkdir -p "$S/linux"
seed() { mkdir -p "$1" && printf '{"name":"try-dep","private":true}\n' > "$1/package.json" && cp "$S/probe.cjs" "$1/probe.cjs"; }
[ -z "$PROBE" ] && [ -f "$HERE/probe-$NAME.cjs" ] && PROBE="$HERE/probe-$NAME.cjs"
if [ -n "$PROBE" ]; then cp "$PROBE" "$S/probe.cjs" || exit 2; PROBE_SAYS="probe: $PROBE"; else PROBE_SAYS="probe: a bare require, which a native module can pass and still not run — write probe-$NAME.cjs"; cat > "$S/probe.cjs" <<'PROBE_EOF'
const name = process.env.TRY_DEP_NAME;
const m = require(name);
const v = JSON.parse(require('fs').readFileSync(`node_modules/${name}/package.json`, 'utf8')).version;
console.log(`loaded ${name} ${v} (${typeof m}; required only, not used)`);
PROBE_EOF
fi
seed "$S/linux"

# An exit code is said by name. 139 is a segfault and prints nothing, and a
# pipe after the command reports the pipe's code: `… | tail` hid one for a
# round in task #291.
means() { case "$1" in 0) echo ok ;; 139) echo "SEGFAULT, no words" ;; 134) echo aborted ;; *) echo "failed" ;; esac; }

echo "== $SPEC"
echo "engines (what it claims; the loads below are what is true): $(npm view "$SPEC" engines --json 2>/dev/null | tr -d '\n ' )"

echo "$PROBE_SAYS"
# Installed by each Node for itself, because that is what a person on that
# Node does, and a package that fetches or compiles a binary at install gets
# that Node's and no other's: one install shared by every Node would read as
# five failures that are only the wrong binary.
echo "== installed and used under each Node here (the one on PATH, and nvm's from 20 up)"
NODES="$(command -v node 2>/dev/null)"
for v in $(ls "${NVM_DIR:-$HOME/.nvm}/versions/node" 2>/dev/null | sort -t. -k1.2,1n -k2,2n -k3,3n); do
  major=${v#v}; major=${major%%.*}
  [ "$major" -ge 20 ] 2>/dev/null && NODES="$NODES ${NVM_DIR:-$HOME/.nvm}/versions/node/$v/bin/node"
done
SEEN=" "
for n in $NODES; do
  ver=$("$n" -v 2>/dev/null); case "$SEEN" in *" $ver "*) continue ;; esac; SEEN="$SEEN$ver "
  D="$S/mac-$ver"; seed "$D"
  ( cd "$D" && PATH="$(dirname "$n"):$PATH" npm install "$SPEC" > install.log 2>&1 ); irc=$?
  ( cd "$D" && TRY_DEP_NAME="$NAME" "$n" probe.cjs ) > "$S/out.txt" 2>&1; rc=$?
  printf '  %-10s Node-API %-3s install %s%s · exit %-3s %-18s %s\n' "$ver" "$("$n" -p process.versions.napi)" "$irc" "$([ "$(grep -c EBADENGINE "$D/install.log")" -gt 0 ] && echo ' (engine warning)')" "$rc" "$(means $rc)" "$(grep -v '^$' "$S/out.txt" | grep -e '^loaded\|Error' | head -1 | cut -c1-120)"
  LAST="$D"
done
BINS=$(find "$LAST/node_modules/$NAME" -name '*.node' 2>/dev/null | sed "s|$LAST/node_modules/$NAME/||" | head -4 | tr '\n' ' ')
echo "native binaries in the package as installed: ${BINS:-none}"

BASE=$(awk '/^FROM /{print $2; exit}' "$REPO/Dockerfile")
VOL=$(cd "$REPO" && docker compose config 2>/dev/null | awk '/^volumes:/{f=1} f && /name:/{print $2; exit}')
MOUNT=()
if [ "$LIVE" = 1 ]; then
  [ -z "$VOL" ] && { echo "no named volume found in compose config" >&2; exit 2; }
  MOUNT=(-v "$VOL:/data:ro" -e DB_PATH=/data/orchestratinator.db)
fi
echo "== inside $BASE, the image's base (installed there, not copied from this machine)${VOL:+ · live data ${VOL} read-only: $([ "$LIVE" = 1 ] && echo yes || echo no)}"
docker run --rm -v "$S/linux":/w -w /w -e TRY_DEP_NAME="$NAME" ${MOUNT[@]+"${MOUNT[@]}"} "$BASE" sh -c '
  printf "  %s Node-API %s\n" "$(node -v)" "$(node -p process.versions.napi)"
  npm install "$0" > install.log 2>&1; echo "  npm install exit $?  $(grep -c EBADENGINE install.log) engine warning line(s)  $(grep -c -i "gyp\|prebuild" install.log) build line(s)"
  node probe.cjs > /tmp/out 2>&1; rc=$?; grep -v "^$" /tmp/out | head -6 | sed "s/^/  /"; echo "  probe exit $rc"' "$SPEC" 2>&1

if [ "$IMAGE" = 1 ]; then
  TAG="orch-try-dep-$$"
  echo "== the tree's own image (compose's build, throwaway tag $TAG)"
  if docker build -q --build-context gitmeta="$REPO/.git" -t "$TAG" "$REPO" > "$S/build.log" 2>&1; then
    docker run --rm -v "$S/probe.cjs":/app/probe.cjs:ro -e TRY_DEP_NAME="$NAME" ${MOUNT[@]+"${MOUNT[@]}"} "$TAG" sh -c '
      printf "  %s Node-API %s · %s in the image: %s\n" "$(node -v)" "$(node -p process.versions.napi)" "$TRY_DEP_NAME" "$(node -p "require(\"./node_modules/$TRY_DEP_NAME/package.json\").version")"
      node probe.cjs > /tmp/out 2>&1; rc=$?; grep -v "^$" /tmp/out | head -6 | sed "s/^/  /"; echo "  probe exit $rc"' 2>&1
    docker rmi "$TAG" > /dev/null 2>&1 && echo "  image removed"
  else
    echo "  build failed:"; tail -8 "$S/build.log" | sed 's/^/  /'
  fi
fi

if [ -n "$GREP" ]; then
  echo "== \"$GREP\" in the published package"
  mkdir -p "$S/src" && ( cd "$S/src" && npm pack "$SPEC" > /dev/null 2>&1 && tar xzf ./*.tgz )
  HITS=$(grep -rc -F -- "$GREP" "$S/src/package" 2>/dev/null | grep -v ':0$' | sed "s|$S/src/package/||")
  if [ -n "$HITS" ]; then echo "$HITS" | head -8 | sed 's/^/  /'; else echo "  in no file"; fi
fi

---
name: try-a-dependency
description: See what a dependency at a version actually does before package.json changes — install and use it under every Node on this machine and inside the board's image, read the live database through it read-only, build the tree's image with it under a throwaway tag, and grep its published source. Use before bumping anything in package.json, when another repo asks for a bump, and before believing an `engines` field or a changelog.
---

# Trying a dependency before the tree has it

A version bump is one line, and what it does is in four places that line does
not show: the Node a person runs the suites on, the Node in the board's
image, the data the live board already holds, and the source the package
actually ships. `try-dep.sh` reads all four and changes nothing: it installs
into a scratch folder, mounts the live data read-only, and removes the image
it builds.

```bash
.claude/skills/try-a-dependency/try-dep.sh better-sqlite3@13.0.3 --live-db
.claude/skills/try-a-dependency/try-dep.sh better-sqlite3@12.11.1 --grep 'context->GetIsolate()'
.claude/skills/try-a-dependency/try-dep.sh better-sqlite3@13.0.3 --live-db --image    # once package.json has it
```

About a minute; three with `--image`. The flags are in the script's header.

## What each block answers

- **engines** is what the package claims. It is printed first so it can be
  set against the rows under it, and it was wrong the one time it mattered:
  13.0.3 says `>=22` and kills 22.11.0.
- **Installed and used under each Node here.** One row per Node: the one on
  PATH and every nvm version from 20 up, each installing for itself, because
  a package that fetches or compiles a binary at install gets that Node's
  binary and no other's. The row is the probe's exit code, said by name.
- **Inside the image's base.** Installed there, not copied from macOS: a
  binary built here says nothing about Linux. With `--live-db` the board's
  named volume is mounted read-only at `/data`, and the probe reads the real
  tables through the version under test.
- **The tree's own image** (`--image`). The same build compose does, with the
  clone's `.git` as its second context, under a tag of its own that is
  removed after. Here the tree's `package.json` decides the version, so this
  is for after the edit: it proves the Dockerfile still installs it.
- **`--grep`** counts a fixed string in the files npm publishes.

## What cost a round, each once (task #291, better-sqlite3 11 → 13)

- **An exit code behind a pipe is the pipe's.** A load that segfaulted was
  piped to `tail`, which printed nothing and exited 0, and read as "loaded,
  quietly". The tool runs the probe unpiped and names 139.
- **A segfault has no words.** better-sqlite3 13 is a Node-API 10 binary.
  On a Node that offers Node-API 9 it does not fail to load: the process
  dies, exit 139, nothing on either stream. The row to read is
  `process.versions.napi`, which the tool prints beside each Node, not the
  version number: 22.11.0 is "Node 22" and has 9.
- **A bare `require` proves little for a native module.** better-sqlite3
  opens its binary at the first `new Database()`, so `require` passes on a
  Node that then segfaults. A probe has to use the thing.
  `probe-better-sqlite3.cjs` does, and the tool picks up `probe-<name>.cjs`
  beside it for any package. With none it says the probe was a bare require.
- **Grep the call as the source writes it.** The compiler's error named
  `v8::Context::GetIsolate`. The source says `context->GetIsolate()`, and
  the qualified name is in no file. Grepped by the error's name, 12.11.1
  read as clean, and it is not (`src/better_sqlite3.cpp:53`).
- **The live data is the named volume, mounted read-only, in a container of
  its own.** Not the live container, which runs the old version and must not
  be touched, and not the repo's `data/`, which is test leftovers. The
  database is in WAL mode, so a read-only open needs the `-shm` file the
  running board keeps. With the board stopped, a failure to open is that,
  not the dependency.

## Proven with a red and a green (2026-11-08)

| | red | green |
|---|---|---|
| a Node too old | 13.0.3 under 20.20.1, 20.11.1, 21.6.2, 22.11.0: `exit 139 SEGFAULT, no words` | 24.22.2 and 26.13.0: `exit 0 ok` |
| the source | 12.11.1 `--grep 'context->GetIsolate()'`: `src/better_sqlite3.cpp:1` | 13.0.3: `in no file` |
| the live data | | 13.0.3 in node:22-bookworm-slim and in the tree's image: 19 tables, `quick_check: ok`, the counts |

## After the readings, the bump itself

The tool does not run the suites. Once the readings are clean:

1. Edit `package.json`, then `. scripts/node-floor.sh && npm install`.
2. If the Node it needs moved, say so in three places that agree:
   `engines` in `package.json`, `src/node-floor.js` (the words a too-old
   Node gets instead of a segfault), and `scripts/node-floor.sh` (which
   finds a suitable Node for every runner under `.claude/skills`).
3. `. scripts/node-floor.sh && npm test`, with `test:host` alone if it goes
   red beside another suite.
4. Run this tool again with `--image --live-db`.
5. `npm run set-version`, and if another repo consumes the dependency, the
   contract on its channel (`orchestratinator.consumed` for the desktop app).

A dependency with no binary still earns the first two blocks: an `engines`
change or a dropped export shows there before a suite is run.

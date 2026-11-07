// The Node floor, said in words before better-sqlite3 is loaded.
//
// Imported first in src/db.js, ahead of better-sqlite3 (ES modules evaluate
// their imports in order, so this runs before that module's binary is
// opened). better-sqlite3 13 is a Node-API 10 binary — prebuilds/<platform>
// .node inside the package, nothing compiled at install — moved to for the
// desktop app, whose Electron 45 has no V8 the 11.x source builds against
// (task #291, 2026-11-07). Opened by a Node that offers Node-API 9 it does
// not fail to load: the process dies with SIGSEGV, exit 139, and not one
// word, before any JavaScript could say why. Measured on 20.20.1 (this
// machine's default node) and 22.11.0; 22.23.4 (the board's image,
// node:22-bookworm-slim) and 24.22.2 load it. Node-API 10 arrived in
// 22.14.0, which is the engines floor in package.json. So the floor is
// stated here, from the thing that is actually required, not the version.
// The host has no dependencies and stays at Node 20.
const napi = Number(process.versions.napi);
if (!(napi >= 10)) {
  throw new Error(
    `Node ${process.versions.node} offers Node-API ${process.versions.napi}, and better-sqlite3 13 needs Node-API 10 ` +
    `(Node 22.14 or later). Run the board on Node 22.14+; an older Node dies without a word.`
  );
}

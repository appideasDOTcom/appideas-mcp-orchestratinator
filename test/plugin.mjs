// The hook that puts a window's state on the floor.
//
// This is the one piece of the system that had no test, and it is the piece
// designed to fail in silence: hooks.json runs it detached with every stream
// redirected to /dev/null, because a hook that prints an error interrupts
// somebody who is concentrating on something else. That is the right behaviour
// and it is also why a fault here can run for days — a prompt simply never
// reaches the floor, the conversation keeps relaying because the host reads
// that off the pane, and nothing anywhere says a word.
//
// It ran that way. `findIdentity` walks up from the event's cwd looking for
// `.mcp.json`, so the moment a session worked out of a scratch directory there
// was nothing above it to find and every prompt went unreported. Measured
// against a live board: cwd in the repo raised the alert, cwd in /private/tmp
// raised nothing.
//
// So these assertions are mostly about what is *not* sent. The hook is spawned
// as a real child process against a stub server, with HOME pointed at a fixture
// so the session memo it writes cannot touch the real one.
//   npm run test:plugin
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

// Outside the repo, deliberately. `findIdentity` walks six levels up from the
// event's cwd, so a fixture under ./data reaches the repo's own .mcp.json — the
// "outside a repo" cases would then resolve against the real board and post to
// the operator's live floor. Found the hard way: the first run of this file did
// exactly that.
const FIX = join(tmpdir(), `orch-plugin-fixture-${process.pid}`);
const HOOK = resolve('./plugin/hooks/report.mjs');
const CH = 'plugin-lab';
const AGENT = 'bo';
const KEY = 'test-key-not-a-real-one';

let failures = 0;
const assert = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures++;
};
const eq = (actual, expected, msg) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? '✓' : '✗'} ${msg}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
  if (!ok) failures++;
};

/** Everything the stub server was asked to accept, newest last. */
const received = [];
let server;
let PORT;

function startStub() {
  return new Promise((ok) => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* recorded as null */ }
        received.push({ url: req.url, headers: req.headers, body: parsed });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    server.listen(0, '127.0.0.1', () => { PORT = server.address().port; ok(); });
  });
}

/**
 * Run the hook exactly as hooks.json does: a child process, the event on stdin.
 *
 * HOME is the fixture, so `~/.orchestratinator/sessions.json` is the fixture's
 * and not the machine's. A test that wrote to the real memo would change the
 * behaviour of the operator's live session.
 */
function fire(event, { home = FIX } = {}) {
  return new Promise((done) => {
    const child = execFile(process.execPath, [HOOK], { env: { ...process.env, HOME: home } },
      (err, stdout, stderr) => done({ code: err?.code ?? 0, stdout, stderr }));
    child.stdin.end(JSON.stringify(event));
  });
}

const settle = () => new Promise((r) => setTimeout(r, 250));
const memoPath = `${FIX}/.orchestratinator/sessions.json`;
const readMemo = () => (existsSync(memoPath) ? JSON.parse(readFileSync(memoPath, 'utf8')) : null);

/** A directory that is on the board, and one that is not. */
function writeFixture() {
  rmSync(FIX, { recursive: true, force: true });
  mkdirSync(`${FIX}/repo`, { recursive: true });
  mkdirSync(`${FIX}/elsewhere/deep/deeper`, { recursive: true });
  mkdirSync(`${FIX}/broken`, { recursive: true });
  writeFileSync(`${FIX}/repo/.mcp.json`, JSON.stringify({
    mcpServers: {
      orchestratinator: {
        type: 'http',
        url: `http://127.0.0.1:${PORT}/mcp`,
        headers: { 'X-Channel': CH, 'X-Agent': AGENT, 'X-Orchestratinator-Key': KEY },
      },
    },
  }));
  // Malformed on purpose: a broken .mcp.json is already breaking this person's
  // MCP connection and they will hear about it from somewhere that can help.
  writeFileSync(`${FIX}/broken/.mcp.json`, '{ this is not json');
}

async function main() {
  await startStub();
  writeFixture();
  console.log('plugin');

  try {
    const SID = 'session-under-test';

    // ---- an event from the repo is reported, and reported correctly ----
    await fire({ session_id: SID, hook_event_name: 'SessionStart', cwd: `${FIX}/repo`, source: 'startup' });
    await settle();
    eq(received.length, 1, 'an event raised inside the repo is reported');
    const first = received[0];
    eq(first.url, '/api/ingest', 'to the ingest path on the same origin as the MCP url');
    eq(first.body?.channel, CH, 'carrying the channel from .mcp.json');
    eq(first.body?.agent, AGENT, 'and the agent');
    eq(first.headers['x-orchestratinator-key'], KEY, 'and the key, as a header rather than in the body');

    // ---- the memo remembers where, and only where ----
    const memo = readMemo();
    assert(memo && memo[SID]?.root, 'the session is remembered against the repo it was seen in');
    eq(memo[SID].root, `${FIX}/repo`, 'by path');
    // The key is deliberately not stored: it is re-read from .mcp.json every
    // time, so this file never becomes a second copy of a credential.
    assert(!JSON.stringify(memo).includes(KEY), 'and the memo holds no credential — only the path');

    // ---- the bug this was written for ----
    received.length = 0;
    await fire({ session_id: SID, hook_event_name: 'PermissionRequest', cwd: `${FIX}/elsewhere/deep/deeper`, tool_name: 'Bash' });
    await settle();
    eq(received.length, 1, 'a prompt raised from outside the repo still reaches the board');
    eq(received[0].body?.channel, CH, 'as the same desk');
    // A desk is a checkout, not a cursor. Sending the raw cwd would file the
    // session under /private/tmp the moment its agent used a scratch directory.
    eq(received[0].body?.cwd, `${FIX}/repo`, 'filed under the repo, not under wherever it was standing');
    eq(received[0].body?.tool_name, 'Bash', 'with the event’s own fields intact');

    // ---- what must never be reported ----
    received.length = 0;
    await fire({ session_id: 'a-session-never-seen-in-a-repo', hook_event_name: 'PermissionRequest', cwd: `${FIX}/elsewhere`, tool_name: 'Bash' });
    await settle();
    eq(received.length, 0, 'a session that has never been in a repo reports nothing — this is what keeps other projects off the board');

    await fire({ session_id: 'broken-repo-session', hook_event_name: 'SessionStart', cwd: `${FIX}/broken` });
    await settle();
    eq(received.length, 0, 'a malformed .mcp.json reports nothing rather than half of something');

    await fire({ session_id: SID, hook_event_name: 'Stop', cwd: `${FIX}/repo` }, { home: FIX });
    await settle();
    eq(received.length, 1, 'and an ordinary event still goes through afterwards');

    // ---- never fail loudly: this runs on the critical path of somebody's work ----
    received.length = 0;
    const empty = await fire('');
    eq(empty.code, 0, 'empty stdin exits 0');
    const garbage = await new Promise((done) => {
      const child = execFile(process.execPath, [HOOK], { env: { ...process.env, HOME: FIX } },
        (err, stdout, stderr) => done({ code: err?.code ?? 0, stdout, stderr }));
      child.stdin.end('not json at all');
    });
    eq(garbage.code, 0, 'unparseable stdin exits 0');
    eq(garbage.stderr, '', 'and says nothing on stderr — a hook that prints interrupts the person it is reporting on');
    await settle();
    eq(received.length, 0, 'and nothing was sent for either');

    // ---- a remembered repo that has left the board is not remembered as its old self ----
    received.length = 0;
    rmSync(`${FIX}/repo/.mcp.json`);
    await fire({ session_id: SID, hook_event_name: 'PermissionRequest', cwd: `${FIX}/elsewhere`, tool_name: 'Bash' });
    await settle();
    eq(received.length, 0, 'the memo is re-resolved, not replayed — a repo whose .mcp.json has gone reports nothing');
  } finally {
    server?.close();
    rmSync(FIX, { recursive: true, force: true });
  }
}

await main();
console.log(`\n${failures === 0 ? 'plugin: all passed' : `plugin: ${failures} failure(s)`}`);
process.exit(failures ? 1 : 0);

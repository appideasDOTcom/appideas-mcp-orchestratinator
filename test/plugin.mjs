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
// So these assertions are mostly about what is *not* sent. The hook lives by
// three rules (its own header states them): never fail loudly, never block,
// never send more than the floor uses. Each rule has a section here, alongside
// the identity walk, the session memo, and the hooks.json wrapper itself. The
// hook is spawned as a real child process against a stub server, with HOME
// pointed at a fixture so the session memo it writes cannot touch the real one.
//   npm run test:plugin
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
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
const PLUGIN_ROOT = resolve('./plugin');
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
/** A port with nothing behind it, for the floor-is-down cases. Reserved by
 *  binding and releasing, which is as race-safe as this needs to be. */
let DEAD_PORT;

function startStub() {
  return new Promise((ok) => {
    server = createServer((req, res) => {
      // A request to /stall is accepted and then never answered — the hook's
      // own timeout is the only thing that can end that exchange.
      if (req.url === '/stall') return;
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

function reserveDeadPort() {
  return new Promise((ok) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      DEAD_PORT = s.address().port;
      s.close(() => ok());
    });
  });
}

/**
 * Run the hook exactly as hooks.json does: a child process, the event on stdin.
 *
 * HOME is the fixture, so `~/.orchestratinator/sessions.json` is the fixture's
 * and not the machine's. A test that wrote to the real memo would change the
 * behaviour of the operator's live session. `cwd` matters for the same reason:
 * the hook falls back to process.cwd() when the event carries none, and this
 * test's own cwd is the repo — so any test of that fallback must pin the child
 * somewhere inside the fixture or it reports to whatever board this checkout
 * points at.
 */
function fire(event, { home = FIX, env = {}, cwd } = {}) {
  return new Promise((done) => {
    const started = Date.now();
    const child = execFile(process.execPath, [HOOK], { cwd, env: { ...process.env, HOME: home, ...env } },
      (err, stdout, stderr) => done({ code: err?.code ?? 0, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(typeof event === 'string' ? event : JSON.stringify(event));
  });
}

const settle = () => new Promise((r) => setTimeout(r, 250));
const memoPath = `${FIX}/.orchestratinator/sessions.json`;
const readMemo = () => (existsSync(memoPath) ? JSON.parse(readFileSync(memoPath, 'utf8')) : null);

const repoMcp = () => JSON.stringify({
  mcpServers: {
    orchestratinator: {
      type: 'http',
      url: `http://127.0.0.1:${PORT}/mcp`,
      headers: { 'X-Channel': CH, 'X-Agent': AGENT, 'X-Orchestratinator-Key': KEY },
    },
  },
});

/** A directory that is on the board, several that are not, and the edge cases
 *  in between. Each gets its own directory so the walk cannot cross fixtures. */
function writeFixture() {
  rmSync(FIX, { recursive: true, force: true });
  mkdirSync(`${FIX}/repo`, { recursive: true });
  mkdirSync(`${FIX}/elsewhere/deep/deeper`, { recursive: true });
  mkdirSync(`${FIX}/broken`, { recursive: true });
  writeFileSync(`${FIX}/repo/.mcp.json`, repoMcp());
  // Malformed on purpose: a broken .mcp.json is already breaking this person's
  // MCP connection and they will hear about it from somewhere that can help.
  writeFileSync(`${FIX}/broken/.mcp.json`, '{ this is not json');

  // A malformed file *below* a healthy one — vendored junk, a half-written
  // experiment. The walk must step over it, not stop at it.
  mkdirSync(`${FIX}/repo/vendor`, { recursive: true });
  writeFileSync(`${FIX}/repo/vendor/.mcp.json`, 'also { not json');

  // Six directories under the repo. The walk checks the starting directory and
  // five parents, so l5 is the deepest place the repo is still visible from and
  // l6 is one step too far.
  mkdirSync(`${FIX}/repo/l1/l2/l3/l4/l5/l6`, { recursive: true });

  // Hand-written header spellings, and no key — both legal.
  mkdirSync(`${FIX}/lowercase`, { recursive: true });
  writeFileSync(`${FIX}/lowercase/.mcp.json`, JSON.stringify({
    mcpServers: { board: { url: `http://127.0.0.1:${PORT}/mcp`, headers: { 'x-channel': CH, 'x-agent': 'casey' } } },
  }));

  // MCP servers that are not the orchestratinator: one with no headers, one
  // with only half the signature, one with the pair but no url. None qualify.
  mkdirSync(`${FIX}/notours`, { recursive: true });
  writeFileSync(`${FIX}/notours/.mcp.json`, JSON.stringify({
    mcpServers: {
      github: { url: 'http://127.0.0.1:9/mcp' },
      half: { url: `http://127.0.0.1:${PORT}/mcp`, headers: { 'X-Channel': CH } },
      nourl: { headers: { 'X-Channel': CH, 'X-Agent': 'ghost' } },
      blank: { url: `http://127.0.0.1:${PORT}/mcp`, headers: { 'X-Channel': '   ', 'X-Agent': 'ghost' } },
    },
  }));

  // The signature is the pair of headers, not the entry's name — a crowd of
  // unrelated servers around an oddly named one must still resolve.
  mkdirSync(`${FIX}/crowd`, { recursive: true });
  writeFileSync(`${FIX}/crowd/.mcp.json`, JSON.stringify({
    mcpServers: {
      filesystem: { url: 'http://127.0.0.1:9/mcp' },
      'my-weird-board-name': { url: `http://127.0.0.1:${PORT}/prefix/mcp/`, headers: { 'X-Channel': CH, 'X-Agent': 'crowd-agent' } },
    },
  }));

  // The pair is present but the url cannot become an ingest url.
  mkdirSync(`${FIX}/badurl`, { recursive: true });
  writeFileSync(`${FIX}/badurl/.mcp.json`, JSON.stringify({
    mcpServers: { o: { url: 'not a url at all', headers: { 'X-Channel': CH, 'X-Agent': 'lost' } } },
  }));

  // A board that is off. The hook must treat this exactly like a board that is
  // on: say nothing, exit 0.
  mkdirSync(`${FIX}/downboard`, { recursive: true });
  writeFileSync(`${FIX}/downboard/.mcp.json`, JSON.stringify({
    mcpServers: { o: { url: `http://127.0.0.1:${DEAD_PORT}/mcp`, headers: { 'X-Channel': CH, 'X-Agent': 'patient' } } },
  }));
}

async function main() {
  await startStub();
  await reserveDeadPort();
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
    eq(first.body?.source, 'startup', 'and the event’s own fields');
    eq(first.headers['x-orchestratinator-key'], KEY, 'and the key, as a header rather than in the body');
    assert(!JSON.stringify(first.body).includes(KEY), 'the body itself never carries the key');
    eq(first.body?.git_branch, null, 'no .git means no branch, not a guess');
    eq(first.body?.model, null, 'no model on the event means null, not undefined');

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
    const garbage = await fire('not json at all');
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
    writeFileSync(`${FIX}/repo/.mcp.json`, repoMcp()); // back on the board for the rest of the suite

    // ================================================================
    console.log('\nnever send more than the floor uses');
    // Rule 3 in the hook's own header. The floor's collapsed line reads seven
    // descriptive tool_input keys and nothing else; everything below is about a
    // Write of a whole file not putting that file on the network.

    received.length = 0;
    const SECRET = 'THE-ENTIRE-FILE-BODY-THAT-MUST-NOT-TRAVEL';
    await fire({
      session_id: SID, hook_event_name: 'PreToolUse', cwd: `${FIX}/repo`, tool_name: 'Write',
      tool_input: {
        file_path: '/somewhere/notes.md',
        content: SECRET.repeat(40),
        old_string: SECRET,
        new_string: SECRET,
        command: 'x'.repeat(400),
        pattern: '   ',
        edits: [{ old: SECRET }],
        count: 7,
      },
    });
    await settle();
    eq(received.length, 1, 'a PreToolUse with a full tool_input is reported');
    const reduced = received[0].body?.tool_input;
    eq(Object.keys(reduced ?? {}).sort(), ['command', 'file_path'], 'but only the descriptive keys survive');
    assert(!JSON.stringify(received[0].body).includes(SECRET), 'the file being written never appears anywhere in the payload');
    eq(reduced?.command.length, 300, 'and what does survive is clipped to 300 characters');
    // pattern was whitespace, edits an array, count a number: none qualify.

    received.length = 0;
    await fire({ session_id: SID, hook_event_name: 'PreToolUse', cwd: `${FIX}/repo`, tool_name: 'Write', tool_input: { content: SECRET, count: 7 } });
    await settle();
    eq(received[0]?.body?.tool_input, null, 'a tool_input with nothing descriptive in it is sent as null, not as an empty shell');

    // The payload is built field by field, never spread from the event — a
    // refactor to `...ev` would ship whatever Claude Code adds next.
    received.length = 0;
    await fire({ session_id: SID, hook_event_name: 'Stop', cwd: `${FIX}/repo`, transcript: SECRET, some_future_field: SECRET });
    await settle();
    assert(received.length === 1 && !JSON.stringify(received[0].body).includes(SECRET), 'fields the hook does not know are not forwarded');

    // The clip limits match the server's own per-turn caps; past them is
    // payload the board would only throw away.
    received.length = 0;
    await fire({
      session_id: SID, hook_event_name: 'Stop', cwd: `${FIX}/repo`,
      message: 'm'.repeat(25_000),
      last_assistant_message: 'a'.repeat(25_000),
      notification_message: 'n'.repeat(2_000),
      error_message: 'e'.repeat(5_000),
    });
    await settle();
    eq(received[0]?.body?.message.length, 20_000, 'message is clipped to the per-turn cap');
    eq(received[0]?.body?.last_assistant_message.length, 20_000, 'so is last_assistant_message');
    eq(received[0]?.body?.notification_message.length, 500, 'notification_message to 500');
    eq(received[0]?.body?.error_message.length, 2_000, 'error_message to 2000');

    // ================================================================
    console.log('\nthe rest of the payload');

    // Claude Code has sent `model` as both a string and an object across
    // versions; the floor wants the id either way.
    received.length = 0;
    await fire({ session_id: SID, hook_event_name: 'Stop', cwd: `${FIX}/repo`, model: 'claude-x' });
    await fire({ session_id: SID, hook_event_name: 'Stop', cwd: `${FIX}/repo`, model: { id: 'claude-y', display_name: 'Y' } });
    await settle();
    eq(received[0]?.body?.model, 'claude-x', 'a model sent as a string passes through');
    eq(received[1]?.body?.model, 'claude-y', 'a model sent as an object is reduced to its id');

    // The branch comes from one read of .git/HEAD, not a git spawn, on a path
    // that runs many times a minute.
    mkdirSync(`${FIX}/repo/.git`, { recursive: true });
    writeFileSync(`${FIX}/repo/.git/HEAD`, 'ref: refs/heads/feature/floor-tests\n');
    received.length = 0;
    await fire({ session_id: SID, hook_event_name: 'Stop', cwd: `${FIX}/repo` });
    await settle();
    eq(received[0]?.body?.git_branch, 'feature/floor-tests', 'the branch is read from .git/HEAD');

    writeFileSync(`${FIX}/repo/.git/HEAD`, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n');
    received.length = 0;
    await fire({ session_id: SID, hook_event_name: 'Stop', cwd: `${FIX}/repo` });
    await settle();
    eq(received[0]?.body?.git_branch, null, 'a detached HEAD is null, not a sha pretending to be a branch');

    // ================================================================
    console.log('\nfinding the identity');

    // Header names in hand-written JSON are whatever the person typing felt
    // like that day; both spellings work over HTTP so both work here.
    received.length = 0;
    await fire({ session_id: 'lowercase-session', hook_event_name: 'SessionStart', cwd: `${FIX}/lowercase` });
    await settle();
    eq(received.length, 1, 'lowercase x-channel / x-agent still identify a repo');
    eq(received[0].body?.agent, 'casey', 'with the right agent');
    eq(received[0].headers['x-orchestratinator-key'], undefined, 'and a repo with no key sends no key header');

    // The signature is the X-Channel + X-Agent pair on an entry with a url.
    // Anything less is some other MCP server and must not put a repo on the
    // board by accident.
    received.length = 0;
    await fire({ session_id: 'notours-session', hook_event_name: 'SessionStart', cwd: `${FIX}/notours` });
    await settle();
    eq(received.length, 0, 'half a signature — or a blank one, or one with no url — is not an identity');

    await fire({ session_id: 'crowd-session', hook_event_name: 'SessionStart', cwd: `${FIX}/crowd` });
    await settle();
    eq(received.length, 1, 'the entry is found by its signature among unrelated servers, whatever it is named');
    eq(received[0].url, '/prefix/api/ingest', 'and a path-prefixed MCP url (trailing slash and all) derives a prefixed ingest url');

    // The walk steps over a malformed .mcp.json rather than stopping at it —
    // vendored junk below a healthy repo must not knock the repo off the board.
    received.length = 0;
    await fire({ session_id: 'vendor-session', hook_event_name: 'SessionStart', cwd: `${FIX}/repo/vendor` });
    await settle();
    eq(received.length, 1, 'a malformed .mcp.json below a healthy one does not stop the walk');
    eq(received[0].body?.cwd, `${FIX}/repo`, 'which resolves to the healthy repo above it');

    // Six levels: the starting directory plus five parents. l5 sees the repo,
    // l6 does not — and a fresh session at l6 has no memo to fall back on.
    received.length = 0;
    await fire({ session_id: 'depth-5-session', hook_event_name: 'SessionStart', cwd: `${FIX}/repo/l1/l2/l3/l4/l5` });
    await settle();
    eq(received.length, 1, 'the repo is visible from five directories down');
    received.length = 0;
    await fire({ session_id: 'depth-6-session', hook_event_name: 'SessionStart', cwd: `${FIX}/repo/l1/l2/l3/l4/l5/l6` });
    await settle();
    eq(received.length, 0, 'and not from six — the walk is bounded');

    // An identity whose url cannot become an ingest url has nowhere to report.
    await fire({ session_id: 'badurl-session', hook_event_name: 'SessionStart', cwd: `${FIX}/badurl` });
    await settle();
    eq(received.length, 0, 'a url that does not parse reports nothing rather than throwing');

    // The event may carry no cwd at all; the hook falls back to where the
    // process stands. The child is pinned inside the fixture because this
    // test's own cwd is the real repo.
    received.length = 0;
    await fire({ session_id: 'no-cwd-session', hook_event_name: 'SessionStart' }, { cwd: `${FIX}/repo` });
    await settle();
    eq(received.length, 1, 'an event with no cwd falls back to the process cwd');
    // process.cwd() comes back with symlinks resolved (on macOS /var/folders is
    // /private/var/folders), so the repo files under its real path — compare
    // against the same.
    eq(received[0].body?.cwd, realpathSync(`${FIX}/repo`), 'and is filed under the repo found there');

    // ================================================================
    console.log('\nenvironment overrides');
    // ORCH_FLOOR_URL / ORCH_CHANNEL / ORCH_AGENT exist so a lab (this file
    // included) can point a real hook somewhere specific without editing a
    // repo's .mcp.json. They override the derived values, nothing else.
    received.length = 0;
    await fire({ session_id: SID, hook_event_name: 'Stop', cwd: `${FIX}/repo` }, {
      env: { ORCH_FLOOR_URL: `http://127.0.0.1:${PORT}/somewhere/else`, ORCH_CHANNEL: 'lab-channel', ORCH_AGENT: 'lab-agent' },
    });
    await settle();
    eq(received[0]?.url, '/somewhere/else', 'ORCH_FLOOR_URL wins over the derived ingest url');
    eq(received[0]?.body?.channel, 'lab-channel', 'ORCH_CHANNEL wins over .mcp.json');
    eq(received[0]?.body?.agent, 'lab-agent', 'so does ORCH_AGENT');
    eq(received[0]?.headers['x-orchestratinator-key'], KEY, 'while the key still comes from the repo');

    // ================================================================
    console.log('\nthe memo keeps itself small and honest');

    // Entries older than the TTL and beyond the cap are pruned on write, so
    // the file never accumulates a machine's whole history.
    const now = Date.now();
    const seeded = { 'stale-session': { root: `${FIX}/repo`, at: now - 8 * 24 * 60 * 60 * 1000 } };
    for (let i = 0; i < 200; i++) seeded[`bulk-${i}`] = { root: `${FIX}/repo`, at: now - i * 1000 };
    writeFileSync(memoPath, JSON.stringify(seeded));
    await fire({ session_id: 'the-201st-session', hook_event_name: 'SessionStart', cwd: `${FIX}/repo` });
    await settle();
    const pruned = readMemo();
    assert(!pruned['stale-session'], 'an entry older than the TTL is pruned');
    eq(Object.keys(pruned).length, 200, 'the memo never holds more than 200 sessions');
    assert(pruned['the-201st-session'], 'the newest session is among them');
    assert(!pruned['bulk-199'], 'at the cost of the oldest');

    // Several hooks write this file at once; one that reads as garbage is a
    // memo with nothing to say, not a crash — and the next write replaces it.
    writeFileSync(memoPath, '{ torn mid-wri');
    received.length = 0;
    const torn = await fire({ session_id: 'after-the-tear', hook_event_name: 'SessionStart', cwd: `${FIX}/repo` });
    await settle();
    eq(torn.code, 0, 'a torn memo does not make the hook fail');
    eq(received.length, 1, 'the event is still reported');
    assert(readMemo()?.['after-the-tear'], 'and the memo is whole again afterwards');

    // A session already remembered at the same root is not rewritten — this
    // path runs on every event of every session, and the early return is what
    // keeps eight hooks from fighting over one file.
    await fire({ session_id: 'settled-session', hook_event_name: 'SessionStart', cwd: `${FIX}/repo` });
    const before = readMemo()['settled-session'];
    await fire({ session_id: 'settled-session', hook_event_name: 'Stop', cwd: `${FIX}/repo` });
    eq(readMemo()['settled-session'].at, before.at, 'an unchanged session is not rewritten');

    // No session id, nothing to remember — but the event itself still counts.
    writeFileSync(memoPath, '{}');
    received.length = 0;
    await fire({ hook_event_name: 'SessionStart', cwd: `${FIX}/repo` });
    await settle();
    eq(received.length, 1, 'an event with no session id is still reported');
    eq(readMemo(), {}, 'and remembered against nothing');

    // ================================================================
    console.log('\nthe floor being down is not an event');
    // Rules 1 and 2: the floor is a convenience. A person whose server is off
    // should notice on the board, never in their terminal.

    received.length = 0;
    const down = await fire({ session_id: 'down-session', hook_event_name: 'SessionStart', cwd: `${FIX}/downboard` });
    eq(down.code, 0, 'a connection refused exits 0');
    eq(down.stderr, '', 'in silence');

    // A server that accepts and never answers is worse than one that is off;
    // the request carries its own timeout so the hook cannot hang a turn.
    const stalled = await fire({ session_id: SID, hook_event_name: 'Stop', cwd: `${FIX}/repo` }, {
      env: { ORCH_FLOOR_URL: `http://127.0.0.1:${PORT}/stall`, ORCH_FLOOR_TIMEOUT_MS: '200' },
    });
    eq(stalled.code, 0, 'a server that never answers exits 0');
    eq(stalled.stderr, '', 'in silence');
    assert(stalled.ms < 2000, `bounded by its own timeout, not the server's mood (took ${stalled.ms}ms)`);
    await settle();
    eq(received.length, 0, 'and neither case reached the board');

    // ================================================================
    console.log('\nthe wrapper in hooks.json');
    // The hook is only ever run through this shell line, so the line is part
    // of the plugin. It reads stdin, hands it to a detached node, and exits 0
    // no matter what — which is why a fault inside can run for days, and why
    // the wrapper itself needs the same assertions as the script.

    const hooksJson = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));
    const EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure'];
    eq(Object.keys(hooksJson.hooks).sort(), [...EVENTS].sort(), 'exactly the eight events the floor reads are hooked');
    const commands = EVENTS.map((e) => hooksJson.hooks[e]?.[0]?.hooks?.[0]);
    assert(commands.every((c) => c?.type === 'command' && c?.timeout === 5), 'every event runs a command with the same short timeout');
    eq(new Set(commands.map((c) => c?.command)).size, 1, 'and every event runs the identical line — editing one and not the rest is drift');

    // Run that line under a real shell, exactly as Claude Code would.
    const CMD = commands[0].command;
    const runWrapper = (stdin, env = {}) => new Promise((done) => {
      const started = Date.now();
      const child = execFile('/bin/sh', ['-c', CMD], { env: { ...process.env, HOME: FIX, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...env } },
        (err, stdout, stderr) => done({ code: err?.code ?? 0, stdout, stderr, ms: Date.now() - started }));
      child.stdin.end(stdin);
    });

    received.length = 0;
    const wrapped = await runWrapper(JSON.stringify({ session_id: 'wrapper-session', hook_event_name: 'UserPromptSubmit', cwd: `${FIX}/repo`, message: 'hello floor' }));
    eq(wrapped.code, 0, 'the wrapper exits 0');
    eq(wrapped.stdout + wrapped.stderr, '', 'and prints nothing — every stream of the real work goes to /dev/null');
    assert(wrapped.ms < 1500, `without waiting for the report to land (returned in ${wrapped.ms}ms)`);
    await settle();
    eq(received.length, 1, 'while the detached report still arrives');
    eq(received[0].body?.message, 'hello floor', 'intact');

    received.length = 0;
    const wrappedEmpty = await runWrapper('');
    eq(wrappedEmpty.code, 0, 'empty stdin exits 0 without spawning anything');
    const wrappedBroken = await runWrapper(JSON.stringify({ session_id: 'wrapper-session', cwd: `${FIX}/repo` }), { CLAUDE_PLUGIN_ROOT: `${FIX}/nowhere` });
    eq(wrappedBroken.code, 0, 'a plugin root that does not exist still exits 0');
    eq(wrappedBroken.stdout + wrappedBroken.stderr, '', 'in silence — node’s own crash goes to /dev/null with everything else');
    await settle();
    eq(received.length, 0, 'and neither case reached the board');
  } finally {
    server?.closeAllConnections?.();
    server?.close();
    rmSync(FIX, { recursive: true, force: true });
  }
}

await main();
console.log(`\n${failures === 0 ? 'plugin: all passed' : `plugin: ${failures} failure(s)`}`);
process.exit(failures ? 1 : 0);

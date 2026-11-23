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
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
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
    // USERPROFILE beside HOME: on Windows Node's homedir() reads USERPROFILE
    // and ignores HOME, so with HOME alone the hook read the real
    // ~/.claude.json and memo there, and a binding in it reached a live board.
    const child = execFile(process.execPath, [HOOK], { cwd, env: { ...process.env, HOME: home, USERPROFILE: home, ...env } },
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

  // A key kept out of the tree as a placeholder, which Claude Code expands.
  mkdirSync(`${FIX}/placeholder`, { recursive: true });
  writeFileSync(`${FIX}/placeholder/.mcp.json`, JSON.stringify({
    mcpServers: { board: { url: `http://127.0.0.1:${PORT}/mcp`, headers: { 'X-Channel': CH, 'X-Agent': 'pat', 'X-Orchestratinator-Key': '${ORCH_TEST_HOOK_KEY}' } } },
  }));
  // …with a default, and inside a longer value (QA, PR #52 Info 3).
  for (const [dir, key] of [['placeholder-default', `\${ORCH_TEST_HOOK_KEY:-${KEY}}`], ['placeholder-pre', 'pre-${ORCH_TEST_HOOK_KEY}']]) {
    mkdirSync(`${FIX}/${dir}`, { recursive: true });
    writeFileSync(`${FIX}/${dir}/.mcp.json`, JSON.stringify({
      mcpServers: { board: { url: `http://127.0.0.1:${PORT}/mcp`, headers: { 'X-Channel': CH, 'X-Agent': 'pat', 'X-Orchestratinator-Key': key } } },
    }));
  }

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

  // Local scope. `claude mcp add -s local` writes a repo's binding into
  // ~/.claude.json (HOME is the fixture here) rather than into the repo, and
  // the floor binds desks that way. Keyed by the resolved path, as Claude Code
  // writes it — tmpdir() is a symlink on macOS, so this is the lookup that has
  // to work. One repo bound only there; one bound both ways, where the local
  // entry must win because it is the one Claude Code connects with.
  mkdirSync(`${FIX}/localrepo/sub`, { recursive: true });
  mkdirSync(`${FIX}/bothrepo`, { recursive: true });
  writeFileSync(`${FIX}/bothrepo/.mcp.json`, JSON.stringify({
    mcpServers: { orchestratinator: { type: 'http', url: `http://127.0.0.1:${PORT}/mcp`, headers: { 'X-Channel': CH, 'X-Agent': 'both-project', 'X-Orchestratinator-Key': KEY } } },
  }));
  writeFileSync(`${FIX}/.claude.json`, JSON.stringify(localScopeFile({
    [realpathSync(`${FIX}/localrepo`)]: 'local-agent',
    [realpathSync(`${FIX}/bothrepo`)]: 'both-local',
  })));
}

/** A ~/.claude.json with one local-scope orchestratinator entry per directory. */
function localScopeFile(agents) {
  const projects = {};
  for (const [dir, agent] of Object.entries(agents)) {
    projects[dir] = { mcpServers: { orchestratinator: { type: 'http', url: `http://127.0.0.1:${PORT}/mcp`, headers: { 'X-Channel': CH, 'X-Agent': agent, 'X-Orchestratinator-Key': KEY } } } };
  }
  return { projects };
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
    eq(memo[SID].root, resolve(`${FIX}/repo`), 'by path');
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
    eq(received[0].body?.cwd, resolve(`${FIX}/repo`), 'filed under the repo, not under wherever it was standing');
    eq(received[0].body?.tool_name, 'Bash', 'with the event’s own fields intact');

    // ---- a session standing in another desk's repo is still its own ----
    // The QA agent works inside the repo it audits, so every hook it fires has
    // that repo as cwd; the walk found that repo's binding and filed the QA
    // session — its prompts included — under the other desk, while its own
    // desk fell silent for four days (2026-09-11). The transcript path names
    // the folder a session started in, and that is what a session is.
    received.length = 0;
    const transcriptFor = (dir, sid) => `${FIX}/.claude/projects/${realpathSync(dir).replace(/[^A-Za-z0-9]/g, '-')}/${sid}.jsonl`;
    await fire({ session_id: 'qa-session', hook_event_name: 'SessionStart', cwd: `${FIX}/repo`, transcript_path: transcriptFor(`${FIX}/repo`, 'qa-session') });
    await settle();
    received.length = 0;
    await fire({ session_id: 'qa-session', hook_event_name: 'Notification', notification_type: 'permission_prompt', cwd: `${FIX}/bothrepo`, transcript_path: transcriptFor(`${FIX}/repo`, 'qa-session') });
    await settle();
    eq(received.length, 1, 'a prompt raised while standing in another desk\'s repo is reported');
    eq(received[0].body?.agent, AGENT, 'as the desk the session started in, not the one it is standing in');
    eq(received[0].body?.cwd, resolve(`${FIX}/repo`), 'and filed under its own repo');
    eq(readMemo()?.['qa-session']?.root, resolve(`${FIX}/repo`), 'and its memo still says its own repo — never overwritten by where it stood');
    received.length = 0;
    await fire({ session_id: 'local-qa', hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: `${FIX}/repo`, transcript_path: transcriptFor(`${FIX}/localrepo`, 'local-qa') });
    await settle();
    eq(received[0]?.body?.agent, 'local-agent', 'a local-scope desk\'s session is found by its transcript alone, with no memo and no walk');
    received.length = 0;
    mkdirSync(`${FIX}/repo/src`, { recursive: true });
    await fire({ session_id: 'sub-session', hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: `${FIX}/repo/src`, transcript_path: transcriptFor(`${FIX}/repo/src`, 'sub-session') });
    await settle();
    eq(received[0]?.body?.agent, AGENT, 'a session started in a subfolder of its repo is that repo\'s');
    received.length = 0;
    await fire({ session_id: 'scratch-session', hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: `${FIX}/repo`, transcript_path: transcriptFor(`${FIX}/elsewhere`, 'scratch-session') });
    await settle();
    eq(received.length, 0, 'a session that started outside every desk reports nothing, however deep in a desk\'s repo it is standing');

    // ---- a subagent's hook says it is a subagent's ----
    // Claude Code sets agent_id on a hook fired inside a subagent (2.1.330);
    // the board must not read a subagent's tool call as the conversation
    // answering its question.
    received.length = 0;
    await fire({ session_id: SID, hook_event_name: 'PreToolUse', cwd: `${FIX}/repo`, tool_name: 'Read', tool_input: { file_path: '/x' }, agent_id: 'a1b2c3' });
    await fire({ session_id: SID, hook_event_name: 'PreToolUse', cwd: `${FIX}/repo`, tool_name: 'Read', tool_input: { file_path: '/y' } });
    await settle();
    eq(received.map((r) => r.body?.agent_id ?? null), ['a1b2c3', null], 'a subagent\'s hook carries its agent_id to the board, and the conversation\'s own carries none');

    // ---- a question's words travel with it ----
    received.length = 0;
    await fire({ session_id: SID, hook_event_name: 'PermissionRequest', cwd: `${FIX}/repo`, tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which scope should step one audit?', header: 'Scope', multiSelect: false, options: [{ label: 'Baseline only', description: 'Audit just the baseline.' }, { label: 'Everything' }] }, { not: 'a question' }] } });
    await settle();
    eq(received[0]?.body?.tool_input?.questions?.map((q) => `${q.header}|${q.question}|${q.options.length}`), ['Scope|Which scope should step one audit?|2'],
      'an AskUserQuestion carries its questions, headers and options — the floor drew choices under the tool\'s name without them');
    assert(!('not' in (received[0]?.body?.tool_input?.questions?.[1] ?? {})), 'and nothing that is not a question');
    eq(received[0]?.body?.tool_input?.questions?.[0]?.options.map((o) => 'preview' in o), [false, false], 'an option with no preview says nothing about one');

    // A preview changes how the window draws the question (no free-text row,
    // a digit that only moves), so that an option has one travels — as a
    // fact. The text does not: a preview is a mock-up of any length.
    received.length = 0;
    await fire({ session_id: SID, hook_event_name: 'PermissionRequest', cwd: `${FIX}/repo`, tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Where should it go?', header: 'Where', multiSelect: false, options: [{ label: 'Alpha', description: 'first', preview: '┌────┐\n│ AAA │\n└────┘' }, { label: 'Bravo', preview: '   ' }, { label: 'Charlie' }] }] } });
    await settle();
    eq(received[0]?.body?.tool_input?.questions?.[0]?.options.map((o) => o.preview ?? null), [true, null, null],
      'an option with a preview is flagged, and one whose preview is blank or absent is not');
    assert(!JSON.stringify(received[0]?.body ?? {}).includes('AAA'), 'and the preview\'s own text is not sent');

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

    // ---- local scope: bound with `claude mcp add -s local`, nothing in the repo ----
    received.length = 0;
    await fire({ session_id: 'local-session', hook_event_name: 'SessionStart', cwd: `${FIX}/localrepo/sub` });
    await settle();
    eq(received.length, 1, 'a session in a repo bound only in ~/.claude.json is reported');
    eq(received[0]?.body?.agent, 'local-agent', 'as the local-scope identity');
    eq(received[0]?.body?.cwd, resolve(`${FIX}/localrepo`), 'filed under the bound directory, found by walking up');
    eq(received[0]?.headers['x-orchestratinator-key'], KEY, 'with the key from that entry');

    received.length = 0;
    await fire({ session_id: 'both-session', hook_event_name: 'SessionStart', cwd: `${FIX}/bothrepo` });
    await settle();
    eq(received[0]?.body?.agent, 'both-local', 'a repo bound both ways reports the local identity — the one Claude Code connects with');

    // CLAUDE_CONFIG_DIR moves the file; the hook follows it.
    received.length = 0;
    mkdirSync(`${FIX}/cfg`, { recursive: true });
    mkdirSync(`${FIX}/cfgrepo`, { recursive: true });
    writeFileSync(`${FIX}/cfg/.claude.json`, JSON.stringify(localScopeFile({ [realpathSync(`${FIX}/cfgrepo`)]: 'cfg-agent' })));
    await fire({ session_id: 'cfg-session', hook_event_name: 'SessionStart', cwd: `${FIX}/cfgrepo` }, { env: { CLAUDE_CONFIG_DIR: `${FIX}/cfg` } });
    await settle();
    eq(received[0]?.body?.agent, 'cfg-agent', 'a binding under CLAUDE_CONFIG_DIR is found there');

    // ---- Windows: Claude Code and Node spell one folder two ways ----
    // `claude mcp add -s local` on Windows keys the folder as C:/Users/…, and
    // path.resolve gives C:\Users\…; the exact lookup missed and every hook
    // there reported nothing (measured 2026-11-20). The key here is the
    // folder with the *other* separator and its case changed: on Windows that
    // is Claude Code's own spelling, and on a Mac it is a spelling only the
    // Windows comparison can match. ORCH_HOOK_PLATFORM makes the hook compare
    // as Windows does, on any machine.
    received.length = 0;
    mkdirSync(`${FIX}/winrepo/sub`, { recursive: true });
    mkdirSync(`${FIX}/wincfg`, { recursive: true });
    const winReal = realpathSync(`${FIX}/winrepo`);
    const otherSpelling = (process.platform === 'win32' ? winReal.replace(/\\/g, '/') : winReal.replace(/\//g, '\\')).toUpperCase();
    writeFileSync(`${FIX}/wincfg/.claude.json`, JSON.stringify(localScopeFile({ [otherSpelling]: 'win-agent' })));
    await fire({ session_id: 'win-session', hook_event_name: 'SessionStart', cwd: `${FIX}/winrepo/sub` }, { env: { CLAUDE_CONFIG_DIR: `${FIX}/wincfg`, ORCH_HOOK_PLATFORM: 'win32' } });
    await settle();
    eq(received.length, 1, 'on Windows, a folder bound under another spelling of its path is reported');
    eq(received[0]?.body?.agent, 'win-agent', 'as that binding');
    eq(received[0]?.body?.cwd, resolve(`${FIX}/winrepo`), 'filed under the folder as Node spells it, not as the lowered key');

    // Off Windows a backslash is a character in a file name and case matters,
    // so the same spelling is a different folder there and stays unmatched.
    if (process.platform !== 'win32') {
      received.length = 0;
      await fire({ session_id: 'win-session-posix', hook_event_name: 'SessionStart', cwd: `${FIX}/winrepo/sub` }, { env: { CLAUDE_CONFIG_DIR: `${FIX}/wincfg`, ORCH_HOOK_PLATFORM: undefined } });
      await settle();
      eq(received.length, 0, 'elsewhere that spelling is another folder, and nothing is reported');
    }

    // The host reads the same file the same way (host/identity.js: readDesk,
    // localEntries), so a Windows host would miss the binding the hook now
    // finds and never take the desk up. Its twin rule, on the same fixture.
    // A child process, because the platform is read when the module loads.
    const hostReads = (platform) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { readDesk, localEntries } from ${JSON.stringify(new URL('../host/identity.js', import.meta.url).href)};
      const dir = process.argv.at(-1);
      process.stdout.write(JSON.stringify({ desk: readDesk(dir)?.agent ?? null, entries: localEntries(dir).entries.map((e) => e.agent) }));
    `, resolve(`${FIX}/winrepo`)], { env: { ...process.env, CLAUDE_CONFIG_DIR: `${FIX}/wincfg`, ORCH_HOST_PLATFORM: platform ?? '' } }).toString());
    const winHost = hostReads('win32');
    eq(winHost.desk, 'win-agent', 'on Windows, the host finds that folder\'s desk under the other spelling too');
    eq(winHost.entries, ['win-agent'], 'and names its local-scope entry, which a release removes by name');
    if (process.platform !== 'win32') {
      const posixHost = hostReads(process.platform);
      eq([posixHost.desk, posixHost.entries], [null, []], 'elsewhere the host leaves that spelling unmatched, as the hook does');
    }

    // ---- one agent, several sessions: a window started as a desk of its own ----
    // The host starts a second window in a folder that is already a desk with
    // a binding file of its own, and gives the window that file's path
    // (host/seats.js). Every event from it is that desk's, whatever the
    // folder says.
    received.length = 0;
    mkdirSync(`${FIX}/seats`, { recursive: true });
    const seatFile = `${FIX}/seats/other-floor_bo.mcp.json`;
    writeFileSync(seatFile, JSON.stringify({ mcpServers: { orchestratinator: {
      type: 'http', url: `http://127.0.0.1:${PORT}/mcp`,
      headers: { 'X-Channel': 'other-floor', 'X-Agent': 'bo-2', 'X-Orchestratinator-Key': 'the-seat-key' },
    } } }));
    await fire({ session_id: 'seat-session', hook_event_name: 'SessionStart', cwd: `${FIX}/repo` }, { env: { ORCH_DESK_CONFIG: seatFile, ORCH_DESK_ROOT: `${FIX}/repo` } });
    await settle();
    eq(received.length, 1, 'a window started with a binding file of its own is reported');
    eq([received[0]?.body?.channel, received[0]?.body?.agent], ['other-floor', 'bo-2'], 'as the desk that file names, not the desk its folder is bound as');
    eq(received[0]?.headers['x-orchestratinator-key'], 'the-seat-key', 'with that file\'s key');
    eq(received[0]?.body?.cwd, `${FIX}/repo`, 'filed under the folder the window was started in');
    received.length = 0;
    await fire({ session_id: 'seat-session', hook_event_name: 'Stop', cwd: `${FIX}/elsewhere/deep` }, { env: { ORCH_DESK_CONFIG: seatFile, ORCH_DESK_ROOT: `${FIX}/repo` } });
    await settle();
    eq([received.length, received[0]?.body?.agent, received[0]?.body?.cwd], [1, 'bo-2', `${FIX}/repo`], 'and still that desk when the agent is standing in a folder that is on no board at all');
    received.length = 0;
    await fire({ session_id: 'seat-session-2', hook_event_name: 'SessionStart', cwd: `${FIX}/repo` }, { env: { ORCH_DESK_CONFIG: `${FIX}/seats/gone.mcp.json`, ORCH_CHANNEL: 'other-floor', ORCH_AGENT: 'bo-2' } });
    await settle();
    eq([received[0]?.body?.channel, received[0]?.body?.agent, received[0]?.headers['x-orchestratinator-key']], ['other-floor', 'bo-2', KEY],
      'a binding file that has gone is no answer: the folder\'s binding carries the event, under the two names the window was given');
    received.length = 0;
    writeFileSync(`${FIX}/seats/broken.mcp.json`, '{ not json');
    await fire({ session_id: 'seat-session-3', hook_event_name: 'SessionStart', cwd: `${FIX}/repo` }, { env: { ORCH_DESK_CONFIG: `${FIX}/seats/broken.mcp.json` } });
    await settle();
    eq([received.length, received[0]?.body?.agent], [1, AGENT], 'and one that cannot be read leaves the folder\'s desk reporting as itself, in silence');
    received.length = 0;
    await fire({ session_id: 'plain-session', hook_event_name: 'SessionStart', cwd: `${FIX}/repo` });
    await settle();
    eq([received[0]?.body?.channel, received[0]?.body?.agent], [CH, AGENT], 'a window with no file of its own is the folder\'s desk, as before');

    // A torn or broken ~/.claude.json must not take the .mcp.json desks with it:
    // Claude Code rewrites the file constantly, and a read that lands mid-write
    // is an ordinary event, not a reason to go silent.
    received.length = 0;
    const goodLocal = readFileSync(`${FIX}/.claude.json`, 'utf8');
    writeFileSync(`${FIX}/.claude.json`, '{ "projects": { half-written');
    await fire({ session_id: SID, hook_event_name: 'Stop', cwd: `${FIX}/repo` });
    await settle();
    eq(received[0]?.body?.agent, AGENT, 'an unreadable ~/.claude.json falls back to .mcp.json rather than reporting nothing');

    // Removed from local scope → no longer a desk, memo or not.
    received.length = 0;
    writeFileSync(`${FIX}/.claude.json`, JSON.stringify({ projects: {} }));
    await fire({ session_id: 'local-session', hook_event_name: 'PermissionRequest', cwd: `${FIX}/elsewhere`, tool_name: 'Bash' });
    await settle();
    eq(received.length, 0, 'a local-scope binding that has been removed reports nothing — the memo is re-resolved, not replayed');
    writeFileSync(`${FIX}/.claude.json`, goodLocal);

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
    console.log('\nwhat the 2.1.300 hooks carry (issues #9, #10, #15)');

    // StopFailure on 2.1.300 says `error` (a code) and puts the words in
    // last_assistant_message; the floor drew "the turn ended with an API
    // error" for every one because only the 2.1.2xx fields were read.
    received.length = 0;
    await fire({ session_id: SID, hook_event_name: 'StopFailure', cwd: `${FIX}/repo`, error: 'invalid_request', error_details: { status: 400 }, last_assistant_message: 'Autocompact is thrashing' });
    await settle();
    eq(received[0]?.body?.error, 'invalid_request', 'a StopFailure\'s `error` is forwarded');
    eq(received[0]?.body?.error_details, '{"status":400}', 'and its details, as text');
    eq(received[0]?.body?.last_assistant_message, 'Autocompact is thrashing', 'with the words');

    // Every tool-context hook carries the session's effort; it is the only
    // receipt /effort has besides the window's own stdout line.
    received.length = 0;
    await fire({ session_id: SID, hook_event_name: 'Stop', cwd: `${FIX}/repo`, effort: { level: 'xhigh' } });
    await settle();
    eq(received[0]?.body?.effort_level, 'xhigh', 'effort.level is forwarded as effort_level');

    // The compaction hooks: the trigger goes up, the summary does not — content
    // is the transcript's, and the host files the summary from there.
    received.length = 0;
    await fire({ session_id: SID, hook_event_name: 'PreCompact', cwd: `${FIX}/repo`, trigger: 'auto', custom_instructions: null });
    await fire({ session_id: SID, hook_event_name: 'PostCompact', cwd: `${FIX}/repo`, trigger: 'manual', compact_summary: 'S'.repeat(6000) });
    await settle();
    eq(received[0]?.body?.trigger, 'auto', 'PreCompact carries its trigger');
    eq(received[1]?.body?.trigger, 'manual', 'so does PostCompact');
    eq(received[1]?.body?.compact_summary, undefined, 'and the summary is not sent — the transcript owns it');

    // A model switch: what was asked for, what it resolved to, and from where.
    received.length = 0;
    await fire({ session_id: SID, hook_event_name: 'PreModelSwitch', cwd: `${FIX}/repo`, from_model: 'claude-a', to_model: 'claude-b', requested_model: 'b', source: 'picker' });
    await settle();
    eq([received[0]?.body?.from_model, received[0]?.body?.to_model, received[0]?.body?.requested_model, received[0]?.body?.source],
      ['claude-a', 'claude-b', 'b', 'picker'], 'PreModelSwitch\'s from, to, requested and source are forwarded');

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

    // `${VAR}` in the key is expanded from the window's environment, as Claude
    // Code's own connection does; read literally it was sent as the text.
    received.length = 0;
    await fire({ session_id: 'placeholder-session', hook_event_name: 'SessionStart', cwd: `${FIX}/placeholder` }, { env: { ORCH_TEST_HOOK_KEY: KEY } });
    await settle();
    eq(received[0]?.headers['x-orchestratinator-key'], KEY, 'a ${VAR} key is sent as the variable\'s value');
    // `undefined` leaves the variable out of the hook's environment
    // altogether: unset, which is not the same as empty below.
    received.length = 0;
    await fire({ session_id: 'placeholder-session-2', hook_event_name: 'SessionStart', cwd: `${FIX}/placeholder` }, { env: { ORCH_TEST_HOOK_KEY: undefined } });
    await settle();
    eq(received.length, 1, 'a ${VAR} key with VAR unset still identifies the repo');
    eq(received[0]?.headers['x-orchestratinator-key'], undefined, 'and sends no key rather than the placeholder');
    received.length = 0;
    await fire({ session_id: 'placeholder-session-3', hook_event_name: 'SessionStart', cwd: `${FIX}/placeholder-pre` }, { env: { ORCH_TEST_HOOK_KEY: undefined } });
    await settle();
    eq([received.length, received[0]?.headers['x-orchestratinator-key']], [1, undefined],
      'an unset VAR inside a longer key sends no key, not the text around it');
    received.length = 0;
    await fire({ session_id: 'placeholder-session-4', hook_event_name: 'SessionStart', cwd: `${FIX}/placeholder-default` }, { env: { ORCH_TEST_HOOK_KEY: undefined } });
    await settle();
    eq(received[0]?.headers['x-orchestratinator-key'], KEY, '${VAR:-default} with VAR unset sends the default');
    // Claude Code 2.1.300 sends "" here, not the default: `:-` is for unset
    // only (measured by QA, PR #52 Info 2). An empty key is no key.
    received.length = 0;
    await fire({ session_id: 'placeholder-session-5', hook_event_name: 'SessionStart', cwd: `${FIX}/placeholder-default` }, { env: { ORCH_TEST_HOOK_KEY: '' } });
    await settle();
    eq([received.length, received[0]?.headers['x-orchestratinator-key']], [1, undefined],
      'and with VAR set but empty sends no key, as Claude Code sends empty rather than the default');

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
    eq(received[0].body?.cwd, resolve(`${FIX}/repo`), 'which resolves to the healthy repo above it');

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
    const EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure',
      'PreCompact', 'PostCompact', 'PreModelSwitch', 'PostModelSwitch'];
    eq(Object.keys(hooksJson.hooks).sort(), [...EVENTS].sort(), 'exactly the twelve events the floor reads are hooked');
    const commands = EVENTS.map((e) => hooksJson.hooks[e]?.[0]?.hooks?.[0]);
    assert(commands.every((c) => c?.type === 'command' && c?.timeout === 5), 'every event runs a command with the same short timeout');
    eq(new Set(commands.map((c) => c?.command)).size, 1, 'and every event runs the identical line — editing one and not the rest is drift');

    // Run that line under a real shell, exactly as Claude Code would. On
    // Windows that is Git Bash, which Claude Code runs every hook under
    // (pc-developer, 2026-11-20): there is no /bin/sh to name, so the suite
    // takes the one Claude Code is told to use, else the bash beside git.exe
    // (Git for Windows puts only Git\cmd on PATH, so from PowerShell `sh` is
    // not found by name: measured), else `sh` on PATH.
    const CMD = commands[0].command;
    const gitBash = () => {
      try {
        const git = execFileSync('where.exe', ['git'], { encoding: 'utf8' }).split(/\r?\n/).find((l) => /git\.exe$/i.test(l.trim()))?.trim();
        const bash = git && join(git, '..', '..', 'bin', 'bash.exe');
        return bash && existsSync(bash) ? bash : null;
      } catch { return null; }
    };
    const SH = process.platform === 'win32' ? (process.env.CLAUDE_CODE_GIT_BASH_PATH || gitBash() || 'sh') : '/bin/sh';
    const runWrapper = (stdin, env = {}) => new Promise((done) => {
      const started = Date.now();
      const child = execFile(SH, ['-c', CMD], { env: { ...process.env, HOME: FIX, USERPROFILE: FIX, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...env } },
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

    // Which node runs it. A Mac whose only Claude Code is Anthropic's native
    // install has no node on PATH, and the line used to die there in silence
    // on every event: no prompt, question or stop ever reached the floor. The
    // desktop app keeps ~/.orchestratinator/bin/node linked to the Node it
    // carries, and the line falls back to it. node on PATH still comes first.
    // The fallback is the desktop app's, which runs on macOS only so far, and
    // the rows below build a POSIX PATH and a symlink: off Windows only.
    if (process.platform !== 'win32') {
    const NO_NODE_PATH = '/usr/bin:/bin';
    assert(!execFileSync('/bin/sh', ['-c', 'command -v node || true'], { env: { PATH: NO_NODE_PATH } }).toString().trim(), `the fixture's bare PATH (${NO_NODE_PATH}) has no node`);
    const event = (n) => JSON.stringify({ session_id: 'wrapper-session', hook_event_name: 'UserPromptSubmit', cwd: `${FIX}/repo`, message: n });
    received.length = 0;
    const noNode = await runWrapper(event('no node anywhere'), { PATH: NO_NODE_PATH });
    eq([noNode.code, noNode.stdout + noNode.stderr], [0, ''], 'with no node on PATH and no fallback, the line still exits 0 in silence');
    await settle();
    eq(received.length, 0, 'and nothing reaches the board');
    const binDir = join(FIX, '.orchestratinator', 'bin');
    mkdirSync(binDir, { recursive: true });
    symlinkSync(process.execPath, join(binDir, 'node'));
    received.length = 0;
    const viaFallback = await runWrapper(event('through the app\'s node'), { PATH: NO_NODE_PATH });
    eq([viaFallback.code, viaFallback.stdout + viaFallback.stderr], [0, ''], 'with no node on PATH and the app\'s link in place, it exits 0 in silence');
    await settle();
    eq(received.map((r) => r.body?.message), ['through the app\'s node'], 'and the report arrives, run by the linked node');
    // A fallback that is not node, to see which one ran.
    rmSync(join(binDir, 'node'));
    writeFileSync(join(binDir, 'node'), `#!/bin/sh\ntouch "${FIX}/fallback-ran"\n`, { mode: 0o755 });
    received.length = 0;
    await runWrapper(event('node on PATH first'));
    await settle();
    eq([received.map((r) => r.body?.message), existsSync(join(FIX, 'fallback-ran'))], [['node on PATH first'], false], 'a node on PATH outranks the link: the line is what it was wherever node is installed');
    rmSync(join(FIX, '.orchestratinator'), { recursive: true, force: true });
    }
  } finally {
    server?.closeAllConnections?.();
    server?.close();
    rmSync(FIX, { recursive: true, force: true });
  }
}

await main();
console.log(`\n${failures === 0 ? 'plugin: all passed' : `plugin: ${failures} failure(s)`}`);
process.exit(failures ? 1 : 0);

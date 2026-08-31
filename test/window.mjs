// The window: proving that a live interactive program in a tmux pane can be
// typed into from outside it, which is the whole basis for there being no
// "driver" any more.
//
// Claude Code itself is not launched here — that would spend tokens and need a
// login. ORCH_HOST_CLAUDE points at a stand-in that appends whatever it is
// given to a file, so the assertions are about the delivery path: does the
// text arrive, does it arrive whole, and does a message with a newline in it
// arrive as one turn instead of submitting halfway through.
//
// The multi-line case is the one that matters. `send-keys -l` would deliver
// "line one\nline two" as two turns, because every newline is an Enter to the
// program reading the pane. A bracketed paste arrives as one block, which is
// why send() uses a tmux buffer.
//   npm run test:window
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const FIX = resolve(`./data/window-fixture-${process.pid}`);
const SINK = `${FIX}/received.txt`;
const TMUX_SESSION = `orch-test-${process.pid}`;

// Set before importing: the module reads these at load.
process.env.ORCH_TMUX_SESSION = TMUX_SESSION;
process.env.ORCH_HOST_CLAUDE = `${FIX}/stand-in.sh`;
// Claude Code's own files, pointed at the fixture. These tests have to say
// exactly what is and is not in a transcript, which is the whole question when
// deciding whether a message was really delivered.
const CLAUDE_HOME = `${FIX}/claude`;
process.env.ORCH_CLAUDE_HOME = CLAUDE_HOME;
process.env.ORCH_LAND_TIMEOUT_MS = '4000';

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

/**
 * The stand-in reads stdin forever and appends it, like a TUI would.
 *
 * It asks for bracketed paste first (`CSI ?2004h`) because that is what makes
 * the test meaningful: tmux only wraps a paste in the markers when the program
 * in the pane has enabled the mode. Claude Code enables it; a bare `cat` does
 * not, and would let a broken multi-line send pass unnoticed.
 */
function writeFixture() {
  mkdirSync(FIX, { recursive: true });
  writeFileSync(SINK, '');
  // It answers `agents --json` too: send() asks the roster which conversation
  // it is typing into so it can confirm the message landed. Without this the
  // stand-in would sit reading stdin and every send would wait out the timeout.
  writeFileSync(`${FIX}/roster.json`, '[]');
  writeFileSync(`${FIX}/stand-in.sh`,
    `#!/bin/sh\n` +
    `if [ "$1" = "agents" ]; then cat ${JSON.stringify(`${FIX}/roster.json`)}; exit 0; fi\n` +
    `printf '\\033[?2004h'\n` +
    `exec cat >> "$PWD/received.txt"\n`);
  chmodSync(`${FIX}/stand-in.sh`, 0o755);
}

/** Poll rather than guess: a pane takes an unpredictable moment to start. */
async function until(fn, ms = 5000) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
}

const received = () => (existsSync(SINK) ? readFileSync(SINK, 'utf8') : '');
/** Strip the bracketed-paste markers a real TUI would consume itself. */
const clean = (s) => s.replace(/\x1b\[20[01]~/g, '');

async function main() {
  const W = await import('../host/window.js');

  if (!(await W.tmuxAvailable())) {
    console.log('window: tmux is not installed — skipping (install it with `brew install tmux`)');
    process.exit(0);
  }

  writeFixture();
  const canonicalFix = W.canonical(FIX);
  console.log('window');

  try {
    // Names are tmux targets, so they cannot carry tmux's target syntax.
    eq(W.windowName('/a/b/my-repo'), 'my-repo', 'window name is the repo directory');
    eq(W.windowName('/a/b/we:ird name'), 'we-ird-name', 'characters tmux would read as a target are replaced');

    // Reading the composer, which is how a paste is confirmed to have landed.
    // The case that matters is the one that is NOT a composer: `❯` is also the
    // selection cursor in Claude Code's menus, and a menu mistaken for a
    // composer is compared against itself forever.
    const RULE = '\u2500'.repeat(60);
    const box = (...body) => [RULE, ...body, RULE, '  auto mode on (shift+tab to cycle)'].join('\n');
    const menu = (title, ...opts) => [RULE, `  ${title}`, ...opts, '  Enter to confirm \u00b7 Esc to cancel'].join('\n');
    eq(W.composerOf(box('\u276f ')), '', 'an empty composer reads as empty, not as missing');
    eq(W.composerOf(box('\u276f hello there')), ' hello there', 'and a typed one gives back what is in it');
    assert(W.composerOf(box('\u276f one')) !== W.composerOf(box('\u276f two')),
           'two different composers do not compare equal — this is the whole paste check');
    eq(W.composerOf(menu('Do you trust the files in this folder?', '  \u276f 1. Yes, proceed', '    2. No, exit')), null,
       'the folder-trust menu is not a composer, however much its cursor looks like one');
    eq(W.composerOf(menu('This session is 2d 22h old and 287.9k tokens.', '  \u276f 1. Resume from summary', '    2. Resume full session as-is', '    3. Don\u2019t ask me again')), null,
       'nor is the resume-mode question a large --resume opens with — the one that ate a message for sixty seconds');
    eq(W.composerOf(menu('New MCP server found in this project', '  \u276f 1. Use this MCP server', '    2. Continue without it')), null,
       'nor the MCP approval');
    eq(W.composerOf('nothing on screen at all'), null, 'and a screen with no box at all is null, so the caller falls back to it');

    // Answering a startup question on the operator's behalf. The decision is
    // separated from the keystrokes precisely so it can be checked here: this
    // is code that presses Enter in someone's window, and the only thing
    // standing between it and the wrong answer is which line it matched.
    const resumeAsk = menu(
      'This session is 2d 22h old and 287.9k tokens.',
      '  Resuming the full session will consume a substantial portion of your usage limits.',
      '  \u276f 1. Resume from summary (recommended)',
      '    2. Resume full session as-is',
      '    3. Don\u2019t ask me again',
    );
    const plan = W.plannedAnswer(resumeAsk);
    eq(plan?.name, 'resume mode', 'the resume-mode question is one the host answers');
    eq(plan?.chose, '2. Resume full session as-is',
       'and it picks the full session — a summary is a copy of a conversation, not the conversation, and a handoff that forks one has not moved anything');
    eq([plan?.from, plan?.to], [0, 1], 'by walking the cursor to that line rather than pressing its number');

    // The cursor may already be there, or below it; the plan is a position, not
    // a direction.
    const already = W.plannedAnswer(menu('x', '  Resuming the full session will consume a lot',
        '    1. Resume from summary', '  \u276f 2. Resume full session as-is'));
    eq(already?.to, 1, 'a cursor already on the answer plans no movement at all');
    // An option is named by its words, cursor or no cursor. Comparing raw lines
    // instead is how the confirm step silently never fired: it planned against a
    // line with no cursor and read back the same line with one, decided they
    // disagreed, and declined to press Enter — leaving the cursor moved and the
    // question standing. The unit tests all passed; only the real dialog showed it.
    eq(already?.chose, '2. Resume full session as-is', 'and the option it names carries no cursor glyph');

    // Everything else is left for a person, and this is the assertion that
    // matters most: these numbers mean opposite things.
    eq(W.plannedAnswer(menu('Do you trust the files in this folder?', '  \u276f 1. Yes, proceed', '    2. No, exit')), null,
       'the folder-trust question is NOT answered for you — pressing 2 there exits');
    eq(W.plannedAnswer(menu('New MCP server found in this project', '  \u276f 1. Use this MCP server', '    2. Continue without it')), null,
       'nor is the MCP approval — that is a decision about what may run on your machine');
    eq(W.plannedAnswer(box('\u276f ')), null, 'and an ordinary composer is not a question at all');

    // Answered once. Still on screen next time round means it was not really
    // answered, and pressing Enter at it again is guessing.
    eq(W.plannedAnswer(resumeAsk, new Set(['resume mode'])), null,
       'a question already answered is not answered a second time');

    // The words are what is matched. A menu whose wording has moved on is a
    // menu we no longer recognise, which is the safe answer, not a silent one.
    eq(W.plannedAnswer(menu('x', '  Resuming the full session will consume a lot',
        '  \u276f 1. Resume from summary', '    2. Resume the whole thing')), null,
       'and an option whose wording has changed is left alone rather than guessed at by position');

    // Nothing is open yet, and send() says so rather than pretending.
    const cold = await W.send(FIX, 'anyone there?');
    eq(cold.code, 'no_window', 'a message to a repo with no window is refused with a reason');

    // Open one.
    const opened = await W.open(FIX);
    assert(opened.ok, `open() starts a window${opened.ok ? '' : ` — ${opened.error}`}`);
    assert(opened.created === true, 'the first open creates the pane');
    const again = await W.open(FIX);
    eq(again.created, false, 'opening a repo that already has a window reuses it');
    eq(again.target, opened.target, 'and reuses the same pane');

    assert(await until(() => existsSync(SINK)), 'the pane is running');

    // The environment the host actually runs in.
    //
    // tmux escapes its own `-F` output the way it would for a terminal, so
    // under a non-UTF-8 locale — and under launchd there is no locale at all —
    // a tab in the format comes back as `_`. That ran every field together:
    // paneFor() matched nothing, so every send opened a *second* window for a
    // repo that already had one and then fired at a target like
    // `orch:@3.%3_8235`. Run by hand from a shell it was invisible, because a
    // shell has a locale.
    //
    // LC_ALL=C reproduces it exactly. It also pins the right fix: this passes
    // because the format no longer uses a character tmux will rewrite, not
    // because the locale is defaulted for tmux elsewhere.
    const probe = await run(process.execPath, ['--input-type=module', '-e',
      `const W = await import(${JSON.stringify(resolve('./host/window.js'))});` +
      `process.stdout.write(JSON.stringify(await W.paneFor(${JSON.stringify(FIX)})))`,
    ], { env: { ...process.env, LC_ALL: 'C' } }).then((r) => JSON.parse(r.stdout)).catch(() => null);
    eq(probe?.target, opened.target, 'the pane is still found with no usable locale, as under launchd');
    eq(probe?.cwd, canonicalFix, 'and its directory comes back whole rather than run together with the next field');

    // The single-line case.
    const one = await W.send(FIX, 'hello from the floor');
    assert(one.ok, `send() delivers${one.ok ? '' : ` — ${one.error}`}`);
    assert(await until(() => clean(received()).includes('hello from the floor')), 'the text arrives in the live pane');

    // The case that made a driver seem necessary: a message with a newline.
    const before = received().length;
    const many = await W.send(FIX, 'line one\nline two\nline three');
    assert(many.ok, 'send() delivers a multi-line message');
    assert(await until(() => clean(received()).includes('line three')), 'every line arrives');
    const delivered = received().slice(before);
    assert(/\x1b\[200~/.test(delivered), 'it is delivered as a bracketed paste, so it is one turn, not three');
    assert(clean(delivered).includes('line one\nline two\nline three'), 'and arrives intact');

    // Text a shell would have mangled if this were interpolated into a command.
    const nasty = `quotes ' " and $(echo pwned) and \`backticks\``;
    await W.send(FIX, nasty);
    assert(await until(() => clean(received()).includes(nasty)), 'shell metacharacters survive verbatim');

    // Two repos ending in the same path segment. The window name is the same
    // for both, so anything matching on the name alone delivers one desk's
    // message into the other desk's window — which is worse than not sending.
    console.log('\n  two desks whose folders share a name');
    const a = `${FIX}/one/shared-name`;
    const b = `${FIX}/two/shared-name`;
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    eq(W.windowName(a), W.windowName(b), 'they want the same window name');
    const oa = await W.open(a);
    const ob = await W.open(b);
    assert(oa.ok && ob.ok, 'both open');
    assert(oa.target !== ob.target, 'and get their own pane rather than sharing one');
    await W.send(a, 'for the first desk');
    await W.send(b, 'for the second desk');
    const readAt = (d) => (existsSync(`${d}/received.txt`) ? readFileSync(`${d}/received.txt`, 'utf8') : '');
    assert(await until(() => clean(readAt(a)).includes('for the first desk')), 'the first desk gets its own message');
    assert(await until(() => clean(readAt(b)).includes('for the second desk')), 'the second desk gets its own message');
    assert(!clean(readAt(a)).includes('for the second desk'), "and neither receives the other's");
    assert(!clean(readAt(b)).includes('for the first desk'), 'in either direction');

    // Delivery is proved by the message, not by the file moving.
    //
    // Two sends in three were being lost: pasted into a window that was
    // mid-turn, dropped, then reported as delivered because the transcript
    // happened to grow for some other reason. The transcript here is ours, so
    // "it grew" and "it contains the message" can be told apart.
    console.log('\n  proving a message actually landed');
    const sessionId = 'land-test';
    const jsonl = W.transcriptPath(W.canonical(FIX), sessionId);
    mkdirSync(dirname(jsonl), { recursive: true });
    writeFileSync(jsonl, '');
    mkdirSync(`${CLAUDE_HOME}/sessions`, { recursive: true });
    writeFileSync(`${CLAUDE_HOME}/sessions/${opened.pid}.json`,
      JSON.stringify({ pid: opened.pid, sessionId, cwd: FIX, kind: 'interactive', startedAt: Date.now() }));

    // The stand-in takes the text and writes nothing to the transcript, which
    // is exactly what a real window does with a paste it drops.
    const lost = await W.send(FIX, 'this one never becomes a turn');
    eq(lost.ok, false, 'a message the window never submits is a failure, not a success');
    eq(lost.code, 'not_delivered', 'and says which failure it is');

    // Growth alone must not satisfy it. This is the exact shape of the bug:
    // unrelated lines arrive in the transcript while the send is waiting.
    const noise = W.send(FIX, 'this one is not in the file either');
    for (let i = 0; i < 5; i++) {
      await sleep(400);
      appendFileSync(jsonl, `${JSON.stringify({ type: 'assistant', uuid: `n${i}`, message: { content: [{ type: 'text', text: 'something else entirely' }] } })}\n`);
    }
    eq((await noise).code, 'not_delivered', 'a transcript growing for other reasons is not delivery');

    // And when the message really does arrive, that is what confirms it.
    const willLand = 'this one becomes a turn';
    const landing = W.send(FIX, willLand);
    await sleep(1000);
    appendFileSync(jsonl, `${JSON.stringify({ type: 'user', uuid: 'landed', message: { content: willLand } })}\n`);
    const arrived = await landing;
    assert(arrived.ok && arrived.confirmed === true,
      `a message found in the transcript is confirmed${arrived.ok ? '' : ` — ${arrived.error}`}`);

    // The failure a person is most likely to actually hit: `claude` is not on
    // PATH, or whatever runs in its place dies on its first line. That used to
    // be indistinguishable from a window sitting on a trust dialog — the same
    // sentence, after the full readiness timeout, describing something that
    // had not happened.
    console.log('\n  a window that exits the moment it opens');
    const doomed = `${FIX}/doomed`;
    mkdirSync(doomed, { recursive: true });
    writeFileSync(`${FIX}/broken.sh`, `#!/bin/sh\necho 'claude: command not found' >&2\nexit 127\n`);
    chmodSync(`${FIX}/broken.sh`, 0o755);
    const died = await run(process.execPath, ['--input-type=module', '-e',
      `const W = await import(${JSON.stringify(resolve('./host/window.js'))});` +
      `process.stdout.write(JSON.stringify(await W.send(${JSON.stringify(doomed)}, 'anyone home?', { open: true })))`,
    ], { env: { ...process.env, ORCH_HOST_CLAUDE: `${FIX}/broken.sh`, ORCH_READY_TIMEOUT_MS: '8000' } })
      .then((r) => JSON.parse(r.stdout))
      .catch((e) => ({ error: String(e.message) }));
    eq(died.code, 'window_exited', 'a window that dies on start is reported as having died, not as still starting');
    assert(/command not found/.test(died.error ?? ''), `and repeats what it said on the way out — ${died.error}`);
    // The screen is readable, for the floor to show while a turn runs.
    const shot = await W.screen(FIX);
    assert(shot.ok && typeof shot.text === 'string', 'the pane can be captured for the floor');

    // Transcript parsing, on a synthetic file — the shape Claude Code writes.
    const t = `${FIX}/t.jsonl`;
    writeFileSync(t, [
      JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-08-27T00:00:00Z', message: { content: 'first' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'reply' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'a2', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent noise' }] } }),
      JSON.stringify({ type: 'system', uuid: 's1', message: { content: 'ignored' } }),
      '',
    ].join('\n'));
    const first = await W.readTranscript(t);
    eq(first.turns.map((x) => `${x.role}:${x.text}`), ['user:first', 'assistant:reply'], 'transcript yields both sides and skips subagent/system noise');

    // Tailing: read from the offset, get only what is new.
    const empty = await W.readTranscript(t, { after: first.offset });
    eq(empty.turns.length, 0, 'nothing new is nothing new');
    writeFileSync(t, `${readFileSync(t, 'utf8')}${JSON.stringify({ type: 'user', uuid: 'u2', message: { content: 'second' } })}\n`);
    const next = await W.readTranscript(t, { after: first.offset });
    eq(next.turns.map((x) => x.text), ['second'], 'a tail returns only the new turn');

    // A half-written line must not be parsed or skipped past.
    writeFileSync(t, `${readFileSync(t, 'utf8')}{"type":"user","message":{"content":"trunc`);
    const torn = await W.readTranscript(t, { after: next.offset });
    eq(torn.turns.length, 0, 'a partially written line is left for the next read');
    eq(torn.offset, next.offset, 'and the offset does not advance past it');
  } finally {
    await run('tmux', ['kill-session', '-t', TMUX_SESSION]).catch(() => {});
    rmSync(FIX, { recursive: true, force: true });
  }

  console.log(failures ? `\nwindow: ${failures} failed` : '\nwindow: all passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  run('tmux', ['kill-session', '-t', TMUX_SESSION]).catch(() => {});
  rmSync(FIX, { recursive: true, force: true });
  process.exit(1);
});

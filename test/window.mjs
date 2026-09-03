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

    /* The composer once a message is queued behind a running turn.
     *
     * Claude Code puts its own prompt where the caret would be, and read as
     * contents it says the exact opposite of the truth: the box is empty, which
     * is what proves the message left it. Left unhandled, send() reported "it
     * is still in the composer" about a message already queued and answered.
     */
    const QUEUED_BOX = [
      '  ❯ the message that was queued a moment ago',
      RULE,
      '❯ Press up to edit queued messages',
      RULE,
      '  auto mode on · esc to interrupt',
    ].join('\n');
    eq(W.composerOf(QUEUED_BOX), '', 'the queue placeholder reads as an empty composer, not as typed text');
    eq(W.queueing(QUEUED_BOX), true, 'and the window is reported as holding a queue');
    eq(W.queueing(box('❯ hello there')), false, 'an ordinary composer is not');

    /* The status line is positional, and that is load-bearing.
     *
     * `busy` used to grep the capture — and `-S -6` is six lines of scrollback
     * plus the whole visible pane, so the conversation was in scope. A window
     * whose transcript happened to contain "esc to interrupt" read as busy for
     * ever; back when a send waited on that, the message waited out the full
     * five minutes and was refused as "working for too long". This repo's own
     * window is the one that hit it.
     */
    const QUOTES_BUSY = [
      '  ❯ why does it say esc to interrupt when nothing is running?',
      '  ⏺ Because that string is how the host decides a window is working.',
      RULE,
      '❯ ',
      RULE,
      '  auto mode on (shift+tab to cycle)',
    ].join('\n');
    assert(!/esc to interrupt/i.test(W.footOf(QUOTES_BUSY)),
           'a window merely talking about "esc to interrupt" is not working');
    assert(/esc to interrupt/i.test(W.footOf(QUEUED_BOX)),
           'and one whose status line says it is, is');

    // Telling a live prompt from a conversation that is talking about one.
    //
    // Both of these are real captures of this repo's own window. The first is a
    // permission prompt actually waiting. The second is the transcript a minute
    // later, showing a message that quoted that prompt — and menuOf reads the
    // quotation as a menu, because as text it is one. Answering on that basis
    // reported an approve as failed when it had not been, and would have typed
    // a bare "1" into the composer. The composer is the difference: while the
    // window holds a question there is nowhere to type.
    const LIVE_PROMPT = [
      "  Ran 1 shell command",
      "\u23fa Capturing. Now a prompt to look at \u2014 give it about five seconds before you",
      "  answer, so the capture catches it. Answer however you like.",
      "\u23fa Running 1 shell command\u2026",
      "  \u23bf  $ touch /Users/costmo/Documents/orch-menu-probe.tmp && rm -f",
      "     /Users/costmo/Documents/orch-menu-probe.tmp && echo done",
      "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
      " Bash command",
      "   touch /Users/costmo/Documents/orch-menu-probe.tmp && rm -f",
      "   /Users/costmo/Documents/orch-menu-probe.tmp && echo done",
      "   Create and remove a scratch file outside the working directory",
      " Do you want to proceed?",
      " \u276f 1. Yes",
      "   2. Yes, and don't ask again for similar commands in /Users/costmo/Documents/d",
      "      ev/appideas/appideas.com/appideas-site-dev/appideas-mcp-orchestratinator",
      "   3. No",
      " Esc to cancel \u00b7 Tab to amend \u00b7 ctrl+e to explain",
    ].join('\n');
    const QUOTED_PROMPT = [
      "  Ran 3 shell commands",
      "\u23fa That's the whole picture. The real prompt:",
      "   Bash command",
      "     touch \u2026 && rm -f \u2026 && echo done",
      "   Do you want to proceed?",
      "   \u276f 1. Yes",
      "     2. Yes, and don't ask again for similar commands in",
      "  /Users/costmo/Documents/d",
      "        ev/appideas/appideas.com/appideas-site-dev/appideas-mcp-orchestratinator",
      "     3. No",
      "   Esc to cancel \u00b7 Tab to amend \u00b7 ctrl+e to explain",
      "  Three findings that change the work:",
      "  Your model is right, and our current Deny is wrong. 1. Yes, 3. No and Esc to",
      "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
      "\u276f",
      "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
      "  \u23f8 manual mode on \u00b7 esc to interrupt \u00b7 \u2190 for agents                        /rc",
    ].join('\n');
    eq(W.composerOf(LIVE_PROMPT), null, 'a window holding a question has no composer');
    assert(W.composerOf(QUOTED_PROMPT) !== null, 'a window that has answered and is waiting for you does');
    assert(W.menuOf(QUOTED_PROMPT).at >= 0,
           'and menuOf alone cannot tell them apart — the quoted options really are numbered rows, which is why the composer has to be checked');
    assert(W.menuOf(LIVE_PROMPT).at >= 0, 'while the live one is a menu by both measures');

    // Is the window holding a question at all?
    //
    // This is the test every keystroke is gated on, so it is the one that has to
    // survive a conversation that quotes prompts — which this repo's does,
    // constantly. It reads the bottom line, which quoting cannot move.
    const ASK_SINGLE = [
      '\u2190  \u2610 ProbeOne  \u2610 ProbeTwo  \u2714 Submit  \u2192',
      '\u276f 1. Alpha', '  2. Bravo', '  3. Charlie',
      'Enter to select \u00b7 \u2191/\u2193 to navigate \u00b7 n to add notes',
    ].join('\n');
    const ASK_MULTI = [
      '\u2190  \u2612 ProbeOne  \u2610 ProbeTwo  \u2714 Submit  \u2192',
      '\u276f 1. [ ] Red', '  2. [ ] Green', '  3. [\u2714] Blue', '     Submit',
      'Enter to select \u00b7 Tab/Arrow keys to navigate \u00b7 Esc to cancel',
    ].join('\n');
    assert(!!W.askingOf(ASK_SINGLE), 'a single-select question is a window asking');
    assert(!!W.askingOf(ASK_MULTI), 'so is a multi-select one');
    assert(!!W.askingOf(LIVE_PROMPT), 'and so is a permission prompt');
    eq(W.askingOf(QUOTED_PROMPT), null, 'a transcript quoting one is not, however much of it is on screen');
    eq(W.askingOf('nothing at all'), null, 'nor is a screen with no status line');
    // The Submit tab is the exception that broke a real submission: it carries
    // no status line, ending instead on its own two-item menu. Read as "not
    // asking", a sequence gives up at the one step that lands on it — and every
    // retry then finds the window parked there and sends nothing at all.
    const REVIEW_TAIL = [
      '\u2190  \u2612 ProbeOne  \u2612 ProbeTwo  \u2714 Submit  \u2192',
      'Review your answers',
      ' \u25cf Probe one', '   \u2192 Bravo',
      'Ready to submit your answers?',
      '\u276f 1. Submit answers',
      '  2. Cancel',
    ].join('\n');
    assert(!!W.askingOf(REVIEW_TAIL), 'the Submit tab is a window asking, though it has no status line');
    eq(W.askingOf(['Ready to submit your answers?', '  2. Cancel'].join('\n')) !== null, true,
       'recognised by what it ends with rather than by a footer it does not have');
    eq(W.askingOf(['some prose mentioning 2. Cancel in passing', '\u23f8 manual mode on \u00b7 esc to interrupt'].join('\n')), null,
       'and a composer still wins, whatever is quoted above it');
    // (composerOf reads a real AskUserQuestion as a composer — its cursor is a
    // \u276f with a rule below it — which is why this test is positional instead.
    // Not asserted here: reproducing that needs the whole box, and the fixtures
    // above are the parts that matter.)

    // The whole form, off the pane. All three of these are real captures of this
    // repo's own window answering a two-question probe.
    const Q_SINGLE = [
      "\u2190  \u2610 ProbeOne  \u2610 ProbeTwo  \u2714 Submit  \u2192",
      "Probe one \u2014 press 2 on this one, so I can see what a digit does to a single-select.",
      "  1. Alpha                        \u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510",
      "\u276f 2. Bravo                        \u2502 BRAVO \u2014 press 2 for this                 \u2502",
      "  3. Charlie                      \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518",
      "  4. Type something.",
      "                                  Notes: press n to add notes",
      "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
      "  Chat about this",
      "Enter to select \u00b7 \u2191/\u2193 to navigate \u00b7 n to add notes \u00b7 Tab to switch questions \u00b7 Esc to cancel",
    ].join('\n');
    const Q_MULTI = [
      "\u2190  \u2612 ProbeOne  \u2610 ProbeTwo  \u2714 Submit  \u2192",
      "Probe two \u2014 press 1, then 1 again, then 3, then submit.",
      "\u276f 1. [ ] Red",
      "  Press 1 twice here. If a digit toggles, this should end up unchecked again.",
      "  2. [ ] Green",
      "  Leave this one alone, so an untouched box can be compared against a touched one.",
      "  3. [ ] Blue",
      "  Press 3 once. If digits toggle, this should finish checked.",
      "  4. [ ] Type something",
      "     Submit",
      "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
      "  5. Chat about this",
    ].join('\n');
    const Q_REVIEW = [
      "\u2190  \u2612 ProbeOne  \u2612 ProbeTwo  \u2714 Submit  \u2192",
      "Review your answers",
      " \u25cf Probe one \u2014 press 2 on this one, so I can see what a digit does to a single-select.",
      "   \u2192 Bravo",
      " \u25cf Probe two \u2014 press 1, then 1 again, then 3, then submit.",
      "   \u2192 Blue",
      "Ready to submit your answers?",
      "\u276f 1. Submit answers",
      "  2. Cancel",
    ].join('\n');

    // The dialog a Write under .claude/skills/ raises, captured off a real pane.
    // It is here because the refusal it produced said "the window is back at its
    // composer" while composerOf returned null — a message naming a cause nobody
    // had looked for, which sent two people hunting the wrong thing.
    const Q_SKILL = [
      "\u254c".repeat(80),
      " Do you want to create probe-note.md?",
      " \u276f 1. Yes",
      "   2. Yes, and allow Claude to edit its own settings for this session",
      "   3. No",
      "",
      " Esc to cancel \u00b7 Tab to amend",
    ].join('\n');
    assert(W.askingOf(Q_SKILL), 'the skill-write dialog is a live question — its footer says what it takes');
    eq(W.composerOf(Q_SKILL), null, 'and it is not a composer, whatever the refusal used to claim');
    eq(W.menuOf(Q_SKILL).rows.length, 3, 'its three choices are readable');

    // What the refusal says now: observed, never guessed.
    const BUSY = ['\u2500'.repeat(60), '\u23fa Running 1 shell command\u2026', '  esc to interrupt'].join('\n');
    assert(/busy/.test(W.whyNotAsking(BUSY)), 'a window part way through a tool is called busy, not "back at its composer"');
    assert(/esc to interrupt/.test(W.whyNotAsking(BUSY)), 'and quotes the status line it read that from');
    const COMPOSER = ['\u2500'.repeat(60), '\u276f ', '\u2500'.repeat(60), '  auto mode on'].join('\n');
    assert(/back at its composer/.test(W.whyNotAsking(COMPOSER)), 'an actual composer is still named as one');
    const ODD = ['\u2500'.repeat(60), '  Something nobody has seen before', '  press F to pay respects'].join('\n');
    assert(/not offering anything to answer/.test(W.whyNotAsking(ODD)), 'and anything else says so rather than inventing a reason');
    assert(/press F to pay respects/.test(W.whyNotAsking(ODD)), 'quoting the line it actually saw');

    const qs = W.questionOf(Q_SINGLE);
    eq(qs.kind, 'single', 'a question with no checkboxes is a single-select');
    eq(qs.tabs.map((t) => `${t.title}${t.answered ? '\u2713' : ''}${t.submit ? '*' : ''}`), ['ProbeOne', 'ProbeTwo', 'Submit*'],
       'the tab strip is read, with which questions are answered and which one submits');
    eq(qs.options.map((o) => o.text), ['Alpha', 'Bravo', 'Charlie', 'Type something.'], 'the choices, without their numbers');
    // The two widgets spell this differently — "Type something." here, "Type
    // something" inside a checkbox below — and an anchored match on one of them
    // renders no text field at all for the other. Which is what happened: the row
    // was on the floor to click and clicking it did nothing.
    eq(qs.options.filter((o) => o.other).map((o) => o.n), [4],
       'the free-text choice is spotted even with the full stop a single-select puts on it');
    eq(qs.cursor, 1, 'and where the cursor is sitting');
    eq(qs.submit, false, 'a single-select has no Submit row of its own');
    eq(qs.strip, true, 'and several questions draw a tab strip to walk');

    // One question draws no strip at all — its header stands alone, no arrows,
    // no Submit tab. Captured off a real 2.1.258 pane 2026-09-03, after the
    // floor showed "permission prompt — AskUserQuestion" with the choices and
    // no question: this returned null, the host fell back to the menu reader,
    // and the operator inferred the question from its answers.
    const Q_ONE = [
      '─'.repeat(80),
      ' ☐ Routing',
      'Which routing should I use for the High findings?',
      '❯ 1. You route it; I hand you the paths only',
      '     I give you just the file paths for the High findings and you handle routing them from there.',
      '  2. Post, and open one task per High finding',
      '     Post the findings and create a separate task for each High finding.',
      '  3. Hold them for review',
      '     Keep the High findings in place, unrouted, pending your review.',
      '  4. Type something.',
      '─'.repeat(80),
      '  5. Chat about this',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n');
    assert(W.askingOf(Q_ONE), 'a one-question form is a live question by its footer');
    const q1 = W.questionOf(Q_ONE);
    assert(!!q1, 'and it is read as a form, not left to the permission-prompt reader');
    eq(q1?.question, 'Which routing should I use for the High findings?', 'with its question — the line the floor was missing');
    eq(q1?.tabs.map((t) => t.title), ['Routing'], 'one tab, from the lone header');
    eq(q1?.strip, false, 'and no strip to walk');
    eq(q1?.options.map((o) => o.text), ['You route it; I hand you the paths only', 'Post, and open one task per High finding', 'Hold them for review', 'Type something.'],
       'its choices, with "Chat about this" left out as on every form');
    eq(q1?.kind, 'single', 'a single-select');

    /* The questions Claude Code asks before it has a session. Both captured
     * raw off a real 2.1.258 pane 2026-09-03 — blank lines and all, because
     * the blank lines are how the option block is told apart from the prose
     * above it. Neither is ever answered by the host; both are read so the
     * floor can offer their rows. */
    const RAW_TRUST = [
      '─'.repeat(80),
      ' Accessing workspace:',
      '',
      ' /tmp/somewhere',
      '',
      " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this",
      ' folder first.',
      '',
      " Claude Code'll be able to read, edit, and execute files here.",
      '',
      ' Security guide',
      '',
      ' ❯ No, exit',
      '   Yes, I trust this folder',
      '',
      ' Enter to confirm · Esc to cancel',
      '',
    ].join('\n');
    const RAW_MCP = [
      '',
      '─'.repeat(80),
      '  New MCP server found in this project: orchestratinator',
      '',
      '  MCP servers may execute code or access system resources. All tool calls require approval. Learn more in the MCP documentation.',
      '',
      '    Use this MCP server',
      '    Use this and all future MCP servers in this project',
      '  ❯ Continue without using this MCP server',
      '',
      '  Enter to confirm · Esc to cancel',
      '',
    ].join('\n');
    const trust = W.startupQuestionOf(RAW_TRUST);
    eq(trust?.kind, 'trust', 'the folder-trust dialog is recognised');
    eq(trust?.options.map((o) => o.text), ['No, exit', 'Yes, I trust this folder'], 'its two rows are read, and "Security guide" above the blank line is not one of them');
    eq(trust?.at, 0, 'with the cursor on exit — which is why nothing here is ever pressed blind');
    const mcp = W.startupQuestionOf(RAW_MCP);
    eq(mcp?.kind, 'mcp', 'the new-MCP-server dialog is recognised');
    eq(mcp?.asks, 'New MCP server found in this project: orchestratinator', 'and names the server it is asking about');
    eq(mcp?.options.map((o) => o.text), ['Use this MCP server', 'Use this and all future MCP servers in this project', 'Continue without using this MCP server'],
       'its three rows are read, and the description sentence above them is not one');
    eq(mcp?.at, 2, 'with the cursor on "continue without" — Enter alone would disable the server');
    eq(W.startupQuestionOf(Q_ONE), null, 'a question form is not a startup question');
    eq(W.startupQuestionOf(COMPOSER), null, 'nor is a composer');

    /* answerIsStale: the TTL drop that used to apply to a startup answer too,
     * on a premise that is false for one — the dialog stands until it is
     * answered, unlike an ordinary permission prompt. A pure function so this
     * is checked directly, with a fixed clock, rather than through a real
     * host racing a real one. */
    console.log('\n  a queued answer past its TTL');
    const T0 = 1_000_000;
    const startupOld = { request_id: 'startup:@9:mcp', queued_at: T0 - 90_000 };
    eq(W.answerIsStale(startupOld, 30_000, T0), false, 'a startup answer is never dropped for age — the dialog it answers is still standing');
    const ordinaryOld = { request_id: 's4:AskUserQuestion:123', queued_at: T0 - 90_000 };
    eq(W.answerIsStale(ordinaryOld, 30_000, T0), true, 'an ordinary permission answer past the TTL is dropped, same as before');
    const ordinaryFresh = { request_id: 's4:AskUserQuestion:123', queued_at: T0 - 5_000 };
    eq(W.answerIsStale(ordinaryFresh, 30_000, T0), false, 'and one still inside it is not');
    eq(W.answerIsStale({ request_id: 's4:AskUserQuestion:123' }, 30_000, T0), false, 'no queued_at at all — an old-shaped payload with nothing to measure age against — is not dropped either');
    // The preview panel to the right, and Claude Code's own trailing item, are
    // furniture rather than choices. Both used to arrive attached to Charlie.
    assert(qs.options.every((o) => !o.detail), 'nothing from the preview panel is mistaken for a choice\u2019s description');
    assert(!qs.options.some((o) => /chat about this/i.test(o.text)), 'and "Chat about this" is not offered as an answer');

    const qm = W.questionOf(Q_MULTI);
    eq(qm.kind, 'multi', 'checkboxes make it a multi-select');
    eq(qm.options.map((o) => [o.n, o.text, o.checked]),
       [[1, 'Red', false], [2, 'Green', false], [3, 'Blue', false], [4, 'Type something', false]],
       'every box is read with its number and its state');
    eq(qm.options.filter((o) => o.other).map((o) => o.n), [4], 'the free-text choice is marked as such rather than left looking ordinary');
    eq(qm.submit, true, 'and the Submit row is seen');
    assert(/digit toggles/.test(qm.options[0].detail ?? ''), 'a choice keeps the description printed under it');
    eq(qs.tabs[0].answered, false, 'an unanswered question reads unanswered');
    eq(qm.tabs[0].answered, true, 'and an answered one reads answered');

    const qr = W.questionOf(Q_REVIEW);
    eq(qr.kind, 'review', 'the Submit tab is a review, not a question');
    eq(qr.options.length, 0, 'with nothing to choose on it');

    eq(W.questionOf('no tab strip here'), null, 'and a screen that is not a question at all is null');

    // Reading what the window is offering.
    //
    // No hook carries the choices — the board learns them only by looking. The
    // wrap matters: "don't ask again for similar commands in <path>" is longer
    // than the window is wide, and a plain capture hands back the two halves
    // split at whatever column the break fell on, mid-path.
    eq(W.promptOptions(LIVE_PROMPT).map((o) => o.n), [1, 2, 3], 'every numbered choice is found');
    eq(W.promptOptions(LIVE_PROMPT)[0].text, 'Yes', 'with its text, and without its number or cursor');
    eq(W.promptOptions('nothing numbered here').length, 0, 'and a screen with no list yields none');
    // The joined form is what readPrompt actually reads; this is the same option
    // as tmux -J returns it.
    eq(W.promptOptions("   2. Yes, and don't ask again for similar commands in /Users/costmo/x")[0].text,
       "Yes, and don't ask again for similar commands in /Users/costmo/x",
       'a long choice comes back whole');

    // Whether an answer took.
    //
    // The floor drops a desk's prompt as soon as the operator decides, so the
    // only thing standing between "your approve went nowhere" and silence is
    // this comparison. Measured against a real prompt, nothing re-announces a
    // standing one — two events six seconds apart and then 33 seconds of
    // nothing — so there is no event to wait for and the window has to be
    // looked at.
    const ask = menu('Do you want to proceed?',
      '  \u276f 1. Yes',
      '    2. Yes, and don\u2019t ask again for touch commands',
      '    3. No, and tell Claude what to do differently (esc)');
    const m = (screen) => W.menuOf(screen);
    assert(W.sameQuestion(m(ask), m(ask)), 'the same prompt still on screen is the same question — the answer did not take');
    assert(!W.sameQuestion(m(ask), m('nothing on screen at all')),
           'the prompt gone is not the same question — that is what an answer that took looks like');
    assert(!W.sameQuestion(m(ask), m(box('\u276f '))),
           'nor is a composer, which is what the window falls back to');
    assert(!W.sameQuestion(m(ask), m(menu('Do you want to proceed?', '  \u276f 1. Yes', '    2. No'))),
           'a different set of options is a different question, so the next prompt is not read as a failure');
    // The cursor moves when you answer even if nothing else does. Reading that
    // as progress would report success for an answer that only highlighted a
    // different line — the exact bug that shipped in plannedAnswer's read-back.
    const moved = menu('Do you want to proceed?',
      '    1. Yes',
      '  \u276f 2. Yes, and don\u2019t ask again for touch commands',
      '    3. No, and tell Claude what to do differently (esc)');
    assert(W.sameQuestion(m(ask), m(moved)),
           'a moved cursor over the same options is still the same question, not progress');
    assert(!W.sameQuestion(m('no menu here'), m('no menu here')),
           'and two screens with no menu at all are not "the same question" — there is nothing to be the same');

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
    eq(arrived.queued, false, 'and it is not reported as queued — it went straight in');

    /* A message sent to a desk that is working.
     *
     * This is the case the floor exists for and the one it used to refuse: you
     * type while the agent is mid-task, exactly as you would in any other
     * client. Claude Code takes it and reads it at its next step, and writes
     * the receipt down as it happens — so "delivered" no longer has to mean
     * "already answered", which on a long turn is a minute away.
     *
     * Both record shapes are here because Claude Code writes both, and a
     * confirmation that only knows one of them is one release away from
     * reporting every queued message as lost. Measured on 2.1.220:
     *   {"type":"queue-operation","operation":"enqueue","content":"…"}
     *   {"type":"attachment","attachment":{"type":"queued_command","prompt":"…"}}
     */
    console.log('\n  a message sent to a desk that is working');
    const queuedText = 'this one is queued behind a running turn';
    const queueingSend = W.send(FIX, queuedText);
    await sleep(1000);
    appendFileSync(jsonl, `${JSON.stringify({
      type: 'queue-operation', operation: 'enqueue', content: queuedText,
    })}\n`);
    const wasQueued = await queueingSend;
    assert(wasQueued.ok, `an enqueue receipt is a delivery${wasQueued.ok ? '' : ` — ${wasQueued.error}`}`);
    eq(wasQueued.queued, true, 'and it is reported as queued rather than as a turn');

    const attachText = 'this one is queued and only the attachment says so';
    const viaAttachment = W.send(FIX, attachText);
    await sleep(1000);
    // The block-list prompt shape 2.1.251 writes — the receipt has to read it,
    // or every mid-turn send on a current build reports as lost.
    appendFileSync(jsonl, `${JSON.stringify({
      type: 'attachment', uuid: 'q2',
      attachment: { type: 'queued_command', prompt: [{ type: 'text', text: attachText }], origin: { kind: 'human' } },
    })}\n`);
    const attached = await viaAttachment;
    assert(attached.ok && attached.queued === true,
      `the queued_command attachment is the same receipt${attached.ok ? '' : ` — ${attached.error}`}`);

    // Somebody else's queued message is not this one's receipt. Without this,
    // any queue traffic at all would confirm whatever send happened to be
    // waiting — the same mistake as watching the transcript merely grow.
    const mine = W.send(FIX, 'this one is never queued');
    for (let i = 0; i < 4; i++) {
      await sleep(400);
      appendFileSync(jsonl, `${JSON.stringify({
        type: 'queue-operation', operation: 'enqueue', content: `something else #${i}`,
      })}\n`);
    }
    eq((await mine).code, 'not_delivered', "another message's queue record is not delivery");

    /* And the window is not waited for.
     *
     * send() used to hold a message until the turn ended — up to five minutes —
     * which is what made the floor feel unlike every other client. This desk's
     * status line says it is working for as long as it lives, so under the old
     * code this call could not return inside the test's patience at all.
     */
    console.log('\n  a working window is typed into, not waited for');
    const busyDir = `${FIX}/busy-desk`;
    mkdirSync(busyDir, { recursive: true });
    // The status line is the last line of the pane, which is where footOf reads
    // it. Everything after this is echoed input, so the footer is last exactly
    // while the decision is being made.
    writeFileSync(`${FIX}/busy-stand-in.sh`,
      `#!/bin/sh\n` +
      `if [ "$1" = "agents" ]; then cat ${JSON.stringify(`${FIX}/roster.json`)}; exit 0; fi\n` +
      `printf '\\033[?2004h'\n` +
      `printf 'Cooking… (12s) esc to interrupt\\n'\n` +
      `exec cat >> "$PWD/received.txt"\n`);
    chmodSync(`${FIX}/busy-stand-in.sh`, 0o755);
    const wasClaude = process.env.ORCH_HOST_CLAUDE;
    process.env.ORCH_HOST_CLAUDE = `${FIX}/busy-stand-in.sh`;
    const busyPane = await W.open(busyDir);
    assert(busyPane.ok, 'a window that reports itself working is open');
    const busyJsonl = W.transcriptPath(W.canonical(busyDir), 'busy-test');
    mkdirSync(dirname(busyJsonl), { recursive: true });
    writeFileSync(busyJsonl, '');
    writeFileSync(`${CLAUDE_HOME}/sessions/${busyPane.pid}.json`,
      JSON.stringify({ pid: busyPane.pid, sessionId: 'busy-test', cwd: busyDir, kind: 'interactive', startedAt: Date.now() }));

    const busyText = 'typed in while the desk was working';
    const startedAt = Date.now();
    const intoBusy = W.send(busyDir, busyText);
    await sleep(1200);
    appendFileSync(busyJsonl, `${JSON.stringify({
      type: 'queue-operation', operation: 'enqueue', content: busyText,
    })}\n`);
    const tookIt = await intoBusy;
    const tookMs = Date.now() - startedAt;
    process.env.ORCH_HOST_CLAUDE = wasClaude;
    assert(tookIt.ok && tookIt.queued === true,
      `a working window takes the message${tookIt.ok ? '' : ` — ${tookIt.error}`}`);
    assert(await until(() => clean(readAt(busyDir)).includes(busyText)),
      'and the text really arrived in the window rather than being reported in');
    // The old code waited ORCH_IDLE_TIMEOUT_MS — five minutes — before typing a
    // character. Anything near that is the wait having come back.
    assert(tookMs < 30_000, `and did not wait out the turn to do it — ${(tookMs / 1000).toFixed(1)}s`);

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

    /* A message the agent read mid-turn is a turn, and it has only one record.
     *
     * Claude Code writes a queued message as a `user` record when it drains at
     * the end of a turn, and as this attachment when it is injected mid-turn —
     * one or the other, never both. Skipping the attachment is how the floor
     * came to show an answer to a question nobody could see being asked.
     */
    const queuedT = `${CLAUDE_HOME}/projects/queued-shape/q.jsonl`;
    mkdirSync(dirname(queuedT), { recursive: true });
    writeFileSync(queuedT, [
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'steer me' }),
      JSON.stringify({ type: 'attachment', uuid: 'qa1', isSidechain: false, attachment: { type: 'queued_command', prompt: 'steer me', origin: { kind: 'human' } } }),
      JSON.stringify({ type: 'queue-operation', operation: 'remove', content: 'steer me' }),
      // By 2.1.251 the prompt is a content-block list and the enqueue carries
      // no content. Read off a live transcript 2026-09-01, when String() was
      // putting "[object Object]" on the floor as the operator's own words.
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
      JSON.stringify({ type: 'attachment', uuid: 'qa1b', isSidechain: false, attachment: { type: 'queued_command', prompt: [{ type: 'text', text: 'steer me again' }], origin: { kind: 'human' } } }),
      JSON.stringify({ type: 'queue-operation', operation: 'remove' }),
      JSON.stringify({ type: 'assistant', uuid: 'qa2', message: { content: [{ type: 'text', text: 'steering' }] } }),
      // Any other attachment is not a turn — an image or a file is part of the
      // message it hangs off, not a thing somebody said.
      JSON.stringify({ type: 'attachment', uuid: 'qa3', attachment: { type: 'image', path: '/tmp/shot.png' } }),
    ].join('\n') + '\n');
    const queuedRead = await W.readTranscript(queuedT);
    eq(queuedRead.turns.map((x) => `${x.role}:${x.text}`), ['user:steer me', 'user:steer me again', 'assistant:steering'],
       'a mid-turn message is a user turn in both prompt shapes, and other attachments are not turns at all');

    /* Injected context is the system's words, not the person's. Claude Code
     * glues IDE state and slash-command records onto user records — a separate
     * text block beside the message, or a whole record of wrappers. Read from
     * a live transcript 2026-09-01, when the floor showed "<ide_opened_file>…"
     * glued to the front of what the operator actually typed, as theirs. */
    const ctxT = `${CLAUDE_HOME}/projects/context-shape/c.jsonl`;
    mkdirSync(dirname(ctxT), { recursive: true });
    writeFileSync(ctxT, [
      JSON.stringify({ type: 'user', uuid: 'c1', message: { content: [
        { type: 'text', text: '<ide_opened_file>The user opened the file src/db.js in the IDE.</ide_opened_file>' },
        { type: 'text', text: 'check our service?' },
      ] } }),
      JSON.stringify({ type: 'user', uuid: 'c2', message: { content: '<command-name>/model</command-name>\n<command-message>model</command-message>' } }),
      JSON.stringify({ type: 'assistant', uuid: 'c3', message: { content: [{ type: 'text', text: 'on it' }] } }),
    ].join('\n') + '\n');
    const ctxRead = await W.readTranscript(ctxT);
    eq(ctxRead.turns.map((x) => `${x.role}:${x.text}`), [
      'context:<ide_opened_file>The user opened the file src/db.js in the IDE.</ide_opened_file>',
      'user:check our service?',
      'context:<command-name>/model</command-name>\n<command-message>model</command-message>',
      'assistant:on it',
    ], 'injected context splits into its own turns and the person keeps only their words');
    eq(ctxRead.turns[0].tool_name, 'ide_opened_file', 'a context turn is labeled by its tag');
    eq(ctxRead.turns[2].tool_name, 'command-name', 'and by the first tag when a record is several wrappers');

    /* Claude Code's own notices come in by the message queue too — a
     * background command finishing, a subagent's result — as one
     * <task-notification> block in a queued_command. Read from the qa desk's
     * live transcript 2026-09-02, when the floor showed "YOU" over fourteen
     * kilobytes of another agent's report, as plain text. */
    const noteT = `${CLAUDE_HOME}/projects/note-shape/n.jsonl`;
    mkdirSync(dirname(noteT), { recursive: true });
    const notice = '<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<summary>Agent "review" finished</summary>\n<result>## Findings\n\n**1.** none</result>\n</task-notification>';
    writeFileSync(noteT, [
      JSON.stringify({ type: 'attachment', uuid: 'n1', isSidechain: false, attachment: { type: 'queued_command', prompt: [{ type: 'text', text: notice }], origin: { kind: 'system' } } }),
      JSON.stringify({ type: 'attachment', uuid: 'n2', isSidechain: false, attachment: { type: 'queued_command', prompt: 'and a person is still a person', origin: { kind: 'human' } } }),
    ].join('\n') + '\n');
    const noteRead = await W.readTranscript(noteT);
    eq(noteRead.turns.map((x) => `${x.role}:${x.tool_name ?? ''}`), ['context:task-notification', 'user:'],
       'a queued notice from Claude Code itself is context labeled by its tag; a queued message from a person is still the person');
    eq(noteRead.turns[0].text, notice, 'with the whole block kept, result and all, for the panel to draw');

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
    // Answering a prompt, against panes that really are showing one.
    //
    // The unit assertions above decide what "the same question" means; these
    // decide whether the host can tell. A stand-in that ignores the key is the
    // whole point — sendKeys reported success for exactly that case, and the
    // floor now clears the desk on the strength of it.
    const PROMPT_DIR = `${FIX}-prompt`;
    mkdirSync(PROMPT_DIR, { recursive: true });
    const RULE60 = '\u2500'.repeat(40);
    const askLines = [
      `printf '%s\\n' ${JSON.stringify(RULE60)}`,
      `printf '%s\\n' '  Do you want to proceed?'`,
      `printf '%s\\n' '  \u276f 1. Yes'`,
      `printf '%s\\n' '    2. Yes, and do not ask again'`,
      `printf '%s\\n' '    3. No, and tell Claude what to do differently (esc)'`,
      // The status line Claude Code keeps at the bottom of the pane. Not
      // decoration: it is how askingOf tells a window holding a question from
      // one idling under a transcript that quotes one, and a fixture without it
      // is a window that does not exist.
      `printf '%s\\n' '  Esc to cancel \u00b7 Tab to amend \u00b7 ctrl+e to explain'`,
    ];
    const pane = async (name, ...body) => {
      const sh = `${PROMPT_DIR}/${name}.sh`;
      writeFileSync(sh, ['#!/bin/sh', ...body].join('\n'));
      chmodSync(sh, 0o755);
      const dir = `${PROMPT_DIR}/${name}`;
      mkdirSync(dir, { recursive: true });
      await run('tmux', ['new-window', '-d', '-t', TMUX_SESSION, '-c', dir, sh]).catch(() => {});
      await sleep(500);
      return dir;
    };

    // Ignores the key entirely: the question is still there afterwards.
    const deaf = await pane('deaf', ...askLines, 'sleep 30');
    const notTaken = await W.answerPrompt(deaf, '1');
    eq(notTaken.ok, false, 'a window that ignores the key does not report success');
    eq(notTaken.code, 'not_taken', 'it says the answer was not taken');
    assert(/still showing the same prompt/.test(notTaken.error ?? ''),
           `and quotes what is on screen rather than guessing why — ${notTaken.error}`);

    // Takes the key and moves on.
    //
    // Two things this stand-in has to get right, both learned the hard way.
    // `stty raw` because the host sends a bare "1" with no Enter, as a person
    // pressing a key would, and a tty in canonical mode blocks until a newline
    // that never comes. And the question has to leave the *captured* screen,
    // which is the last dozen lines — real Claude Code repaints its prompt away
    // in place, checked directly against a live pane where an answered prompt
    // left no numbered row anywhere in sixty lines of scrollback. Reproducing
    // that repaint in a shell script is more fiction than fixture, so this
    // scrolls it off instead: what is under test is whether the question is
    // still on screen, not how it stopped being there.
    const hears = await pane('hears', ...askLines,
      'stty raw -echo', 'dd bs=1 count=1 >/dev/null 2>&1', 'stty sane',
      // Enough to clear both halves of what screenOf captures: `-S -12` is
      // twelve lines of history *plus the whole visible pane*, so a handful of
      // lines scrolls nothing at all and the question stays in shot.
      `i=0; while [ $i -lt 60 ]; do printf '%s\\n' '  running your command'; i=$((i+1)); done`,
      'sleep 30');
    const took = await W.answerPrompt(hears, '1');
    assert(took.ok, `a window that acts on the key reports success — ${took.error ?? ''}`);

    // Nothing to answer. Sending the key here types a bare "1" into whatever is
    // on screen, which is how a row of 1s once arrived as somebody's message.
    const quiet = await pane('quiet', `printf '%s\\n' ${JSON.stringify(RULE60)}`, `printf '%s\\n' '  \u276f '`, 'sleep 30');
    const nothing = await W.answerPrompt(quiet, '1');
    eq(nothing.ok, false, 'a window with no prompt on it is not answered at all');
    eq(nothing.code, 'no_prompt', 'and says so, rather than pressing 1 into the composer');

    // The one that got through in the wild: a window sitting at its composer with
    // a menu quoted in the conversation above it. menuOf sees a menu; there is
    // nothing to answer.
    const talking = await pane('talking',
      `printf '%s\\n' '  Here is what the prompt looked like:'`,
      `printf '%s\\n' '  \u276f 1. Yes'`,
      `printf '%s\\n' '    2. Yes, and do not ask again'`,
      `printf '%s\\n' '    3. No'`,
      `printf '%s\\n' ${JSON.stringify(RULE60)}`,
      `printf '%s\\n' '\u276f '`,
      `printf '%s\\n' ${JSON.stringify(RULE60)}`,
      'sleep 30');
    const quoting = await W.answerPrompt(talking, '1');
    eq(quoting.ok, false, 'a window talking about a prompt is not answered');
    eq(quoting.code, 'no_prompt', 'it is back at its composer, so there is no question to answer');

    // Reading the options off a real pane, wrap and all. The line is longer than
    // the pane is wide on purpose: that is the case tmux -J exists for, and the
    // case a plain capture gets wrong.
    const LONG = "Yes, and don't ask again for similar commands in /Users/costmo/Documents/dev/appideas/appideas.com/appideas-site-dev";
    const offering = await pane('offering',
      `printf '%s\\n' '  Do you want to proceed?'`,
      `printf '%s\\n' '  \u276f 1. Yes'`,
      `printf '%s\\n' ${JSON.stringify('    2. ' + LONG)}`,
      `printf '%s\\n' '    3. No'`,
      `printf '%s\\n' '  Esc to cancel \u00b7 Tab to amend'`,
      // No echo, because Claude Code has none: a cooked tty prints every key
      // back onto the pane, which moves the bottom line and makes the window
      // look like it stopped asking half way through a sequence.
      'stty raw -echo', 'sleep 30');
    const read = await W.readPrompt(offering);
    assert(read.ok, `a window holding a question gives up its choices — ${read.error ?? ''}`);
    eq(read.options?.map((o) => o.n), [1, 2, 3], 'all of them');
    eq(read.options?.[1]?.text, LONG, 'including the one that wrapped, rejoined rather than cut at the column');

    const nothingOffered = await W.readPrompt(talking);
    eq(nothingOffered.code, 'no_prompt', 'a window back at its composer offers nothing, whatever is quoted above it');

    // Playing a sequence, and refusing to play one into a window that stopped
    // asking part way through. A permission prompt is one keystroke; a question
    // is a script, and a script aimed at the wrong moment types its digits into
    // whatever is there.
    const seq = await W.answerQuestion(offering, [{ key: '2' }, { key: '3' }]);
    assert(seq.ok, `a live question takes a sequence — ${seq.error ?? ''}`);
    eq(seq.done, ['2', '3'], 'and reports what it pressed, in order');

    const intoNothing = await W.answerQuestion(talking, [{ key: '1' }, { key: 'Enter' }]);
    eq(intoNothing.ok, false, 'a window that is not asking takes nothing');
    eq(intoNothing.done, [], 'not even the first step');
    eq(intoNothing.code, 'no_prompt', 'and says why');

    // Past the point of submitting, the window closing is success rather than
    // failure: the confirmation may be taken by the digit or by the Enter after
    // it, and whichever lands, the other finds nothing.
    const closes = await W.answerQuestion(talking, [{ key: '1', final: true }, { key: 'Enter', final: true }]);
    assert(closes.ok, 'a final step meeting a closed window is the answer having gone through');
    eq(closes.closed, true, 'and says so, rather than reporting what it did not press');

    // The confirmation is its own screen, and playing the last step is not the
    // same as that screen having been taken. This is the shape of a real
    // failure: every step played, the host reported success, the floor cleared
    // the alert — and the window sat on "Ready to submit your answers?" until
    // the operator pressed it in tmux themselves. Silent success is the bug.
    const unconfirmed = await pane('unconfirmed',
      `printf '%s\\n' '  ←  ☒ After submit  ☒ Rough edges  ✔ Submit  →'`,
      `printf '%s\\n' '  Review your answers'`,
      `printf '%s\\n' '  Ready to submit your answers?'`,
      `printf '%s\\n' '  ❯ 1. Submit answers'`,
      `printf '%s\\n' '    2. Cancel'`,
      'stty raw -echo', 'sleep 30');

    const stuck = await W.answerQuestion(unconfirmed, [{ key: '1', final: true }, { key: 'Enter', final: true }]);
    eq(stuck.ok, false, 'a confirmation the window never takes is not a submitted answer');
    eq(stuck.code, 'not_confirmed', 'and it is reported as unconfirmed rather than as an answer');
    assert(/ready to submit your answers/i.test(stuck.error ?? ''),
      `and quotes the screen rather than guessing why — ${stuck.error ?? ''}`);
    eq(stuck.done.filter((d) => d === 'Enter(confirm)').length, 3,
      'having pressed it more than once, in case the first arrived mid-redraw');

    // Busy is not stopped, and the difference cost a whole form.
    //
    // A sequence is a dozen keystrokes and the window works between them. When
    // the gap was read as "it stopped asking", the run was abandoned part way
    // and what had already been typed went in as the answer: measured on a real
    // form, "the window stopped asking after 13 of 28 steps — the window is
    // busy". So a busy window is waited for; a closed one still is not.
    const busyThenAsking = await pane('busy-then-asking',
      `printf '%s\\n' '  Do you want to proceed?'`,
      `printf '%s\\n' '  \u276f 1. Yes'`,
      `printf '%s\\n' '    2. No'`,
      // Busy first, and only then the line that says it will take an answer.
      `printf '%s\\n' '  esc to interrupt'`,
      'stty raw -echo', 'sleep 1',
      `printf '%s\\n' '  Esc to cancel \u00b7 Tab to amend'`,
      'sleep 30');
    const waited = await W.answerQuestion(busyThenAsking, [{ key: '1' }]);
    assert(waited.ok, `a window that is merely busy is waited for, not abandoned — ${waited.error ?? ''}`);
    eq(waited.done, ['1'], 'and the step is played once it is asking again');

    // Refusing with a reason is two acts, and the guard belongs on the first.
    // The words are typed only after the digit has been accepted by a window
    // that was demonstrably asking — otherwise a refusal aimed at a prompt that
    // has gone types a sentence into somebody's message box.
    const denyGone = await W.denyWithReason(talking, '3', 'use the staging bucket');
    eq(denyGone.ok, false, 'a reasoned refusal is not typed into a window that has stopped asking');
    eq(denyGone.code, 'no_prompt', 'it fails on the same guard a bare answer does');
    const denyNoWindow = await W.denyWithReason(`${PROMPT_DIR}/never-opened`, '3', 'anything');
    eq(denyNoWindow.code, 'no_window', 'and a repo with no window never gets as far as the words');

    const nowhere = await W.answerQuestion(`${PROMPT_DIR}/never-opened`, [{ key: '1' }]);
    eq(nowhere.code, 'no_window', 'and a repo with no window is its own answer');

    const missing = await W.answerPrompt(`${PROMPT_DIR}/never-opened`, '1');
    eq(missing.code, 'no_window', 'and a repo with no window at all is its own answer');

    // The presser that can disable an MCP server, against a real pane.
    //
    // Nothing at any tier reached answerStartup before this: the cursor check
    // it exists for — "under !== want.text", the whole reason nothing here is
    // ever pressed blind — was provably dead, disabling it left every suite
    // green. A shell's stty/dd tricks (used above for a single bare digit)
    // proved fragile for something byte-exact ("was Enter really sent, and
    // only after the cursor actually got where it was walked to"), so this is
    // a tiny node stand-in instead: it prints its screen once and never
    // redraws — indistinguishable, to anything reading the capture, from a
    // cursor that refuses to move — and notes every Enter it receives to a
    // marker file regardless of anything else it does or does not do.
    console.log('\n  answering a startup question, against a real pane');
    const enterMark = `${PROMPT_DIR}/startup-enter.mark`;
    const mcpBody = (at) => [
      '',
      '─'.repeat(80),
      '  New MCP server found in this project: orchestratinator',
      '',
      '  MCP servers may execute code or access system resources. All tool calls require approval. Learn more in the MCP documentation.',
      '',
      ...['Use this MCP server', 'Use this and all future MCP servers in this project', 'Continue without using this MCP server']
        .map((t, i) => (i === at ? `  ❯ ${t}` : `    ${t}`)),
      '',
      '  Enter to confirm · Esc to cancel',
      '',
    ];
    const spawnStartupPane = async (name, lines) => {
      const dir = `${PROMPT_DIR}/${name}`;
      mkdirSync(dir, { recursive: true });
      const script = `${dir}/run.cjs`;
      writeFileSync(script, [
        '#!/usr/bin/env node',
        `const fs = require('fs');`,
        ...lines.map((l) => `process.stdout.write(${JSON.stringify(`${l}\n`)});`),
        `try { fs.unlinkSync(${JSON.stringify(enterMark)}); } catch {}`,
        `if (process.stdin.isTTY) process.stdin.setRawMode(true);`,
        `process.stdin.resume();`,
        `let resolved = false;`,
        // CR in raw mode, or LF if something along the way translated it —
        // either is "Enter arrived", and telling them apart buys nothing here.
        // The real dialog disappears once answered; answerStartup's own
        // success check reads exactly that (the question is gone from the
        // next capture), so a stand-in that never redraws would fail the
        // presser's positive path for a reason that has nothing to do with
        // what the path is testing. `-S -30` is not "the last 30 lines" — see
        // busy()'s own note in host/window.js — it is 30 lines of scrollback
        // *plus the whole visible pane*, so nothing short of genuinely
        // scrolling the dialog out of the pane's history defeats it. Printed
        // once, and generously past any plausible pane height.
        `process.stdin.on('data', (buf) => {`,
        `  if (!buf.includes(0x0d) && !buf.includes(0x0a)) return;`,
        `  fs.appendFileSync(${JSON.stringify(enterMark)}, 'x');`,
        `  if (resolved) return;`,
        `  resolved = true;`,
        `  for (let i = 0; i < 200; i++) process.stdout.write('  \\n');`,
        `});`,
      ].join('\n'));
      chmodSync(script, 0o755);
      await run('tmux', ['new-window', '-d', '-t', TMUX_SESSION, '-c', dir, script]).catch(() => {});
      await sleep(500);
      return dir;
    };

    // Cursor stuck on "Continue without…" (index 2) — the dialog's real
    // starting position. answerStartup wants row 1 ("Use this MCP server"),
    // walks Up twice, and must find the cursor still where it started before
    // it may press Enter.
    const cursorStuck = await spawnStartupPane('startup-stuck', mcpBody(2));
    const stuckResult = await W.answerStartup(cursorStuck, 1);
    eq(stuckResult.ok, false, 'a cursor that does not move is not pressed past');
    eq(stuckResult.code, 'not_taken', 'and the reason is that the cursor never got there');
    assert(/is not on/.test(stuckResult.error ?? ''), `quoting what the window actually reads rather than assuming — ${stuckResult.error}`);
    assert(!existsSync(enterMark), 'and Enter itself was never sent — the one keystroke here with a cost when wrong');

    // Cursor already on the wanted row (no walk needed) — the positive path,
    // proving Enter really is sent once the check passes.
    const there = await spawnStartupPane('startup-there', mcpBody(0));
    const thereResult = await W.answerStartup(there, 1);
    eq(thereResult.ok, true, `the presser succeeds once the cursor is confirmed on the right row — ${thereResult.error ?? ''}`);
    eq(thereResult.chose, 'Use this MCP server', 'and reports which row it took');
    assert(existsSync(enterMark), 'with Enter actually reaching the window this time');

    // waitReady's early return. A window sitting on this dialog is registered
    // — it is a live interactive tty — but must never be waited out to the
    // full timeout: the watch loop has already put the question on the floor,
    // and sitting here would only delay the operator's own answer reaching it.
    const askingStill = await spawnStartupPane('startup-waiting', mcpBody(2));
    const askingPane = await W.paneFor(askingStill);
    assert(!!askingPane, 'the spawned window is found by its directory');
    const waitReadyStartedAt = Date.now();
    const wr = await W.waitReady(askingStill, { timeoutMs: 20_000, target: askingPane.target });
    const waitedMs = Date.now() - waitReadyStartedAt;
    eq(wr.ok, false, 'a window on a startup question is not reported ready');
    eq(wr.code, 'startup_question', 'and says which kind of not-ready this is');
    assert(/Continue without/.test(wr.error ?? ''), `quoting the dialog rather than saying only "not ready" — ${wr.error}`);
    assert(waitedMs < 5000, `and returns as soon as the question is seen, not after the full ${20_000}ms timeout — took ${waitedMs}ms`);
  } finally {
    await run('tmux', ['kill-session', '-t', TMUX_SESSION]).catch(() => {});
    rmSync(FIX, { recursive: true, force: true });
    rmSync(`${FIX}-prompt`, { recursive: true, force: true });
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

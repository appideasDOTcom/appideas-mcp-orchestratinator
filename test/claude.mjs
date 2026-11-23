#!/usr/bin/env node
/**
 * host/claude.js: what the host reads of Claude Code on this machine (the
 * roster, the transcripts, the picker's list, a resume's fallback) and the
 * environment a desk's Claude Code is started in. These rows are the ones of
 * the old window suite (test/window.mjs) whose code survived the window
 * layer's replacement (costmo, 2026-11-22); the rest went with the code.
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, appendFileSync, utimesSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const FIX = resolve(`./data/claude-fixture-${process.pid}`);
const CLAUDE_HOME = `${FIX}/claude`;
process.env.ORCH_CLAUDE_HOME = CLAUDE_HOME;
let failures = 0;
const assert = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) failures++; };
const eq = (actual, expected, msg) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? '✓' : '✗'} ${msg}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
  if (!ok) failures++;
};
const until = async (fn, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (await fn()) return true; return false; };
mkdirSync(CLAUDE_HOME, { recursive: true });
const W = await import('../host/claude.js');
console.log('claude');
try {
    console.log('\n  what a window inherits from the host');
    {
      const host = { HOME: '/h', PATH: '/p', ORCH_URL: 'http://b', ORCH_AUTH_TOKEN: 'k', ORCH_HOST_SUPERVISOR: 'app', LANG: 'en_GB.UTF-8' };
      const e = W.windowEnv(host, { platform: 'darwin', tempDir: () => '/var/folders/x/T/', user: () => 'pat' });
      eq(Object.keys(e).filter((k) => k.startsWith('ORCH_')), [], 'windowEnv: none of the host\'s ORCH_ variables');
      eq([e.HOME, e.PATH, e.LC_ALL], ['/h', '/p', 'en_GB.UTF-8'], 'and everything else, with the locale');
      eq([e.TMPDIR, e.USER, e.LOGNAME], ['/var/folders/x/T/', 'pat', 'pat'], 'TMPDIR, USER and LOGNAME filled where the host has none (macOS)');
      const own = W.windowEnv({ ...host, TMPDIR: '/mine/', USER: 'me', LOGNAME: 'me' }, { platform: 'darwin', tempDir: () => '/var/folders/x/T/', user: () => 'pat' });
      eq([own.TMPDIR, own.USER, own.LOGNAME], ['/mine/', 'me', 'me'], 'and left as they are where it has them');
      eq(W.windowEnv(host, { platform: 'linux', tempDir: () => '/var/folders/x/T/', user: () => 'pat' }).TMPDIR, undefined, 'TMPDIR is filled on macOS only');
      // A host started from inside a Claude Code window carries that
      // session's markers, and a window that inherits them writes no
      // transcript (pc-developer, Windows, 2026-11-20). Only the markers go.
      const parent = { ...host, CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_EFFORT: 'max',
        CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_API_KEY: 'sk' };
      const pe = W.windowEnv(parent, { platform: 'darwin', tempDir: () => '/t/', user: () => 'pat' });
      eq(Object.keys(pe).filter((k) => /^(CLAUDE|ANTHROPIC)/.test(k)).sort(), ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CONFIG_DIR'],
        'windowEnv: none of a parent Claude Code session\'s markers, and every setting a person gives Claude Code');
    }

    // What a window runs. On Windows there is no exec, so a shell line leaves
    // the shell as the pane's process and the pane's pid never meets the
    // roster's (pc-developer, psmux 3.4.0, 2026-11-20): an argument list.
    console.log('\n  a desk pinned to a session that never wrote a transcript');
    const stale = `${FIX}/stale-pin`;
    mkdirSync(stale, { recursive: true });
    const pdir = W.projectDir(W.canonical(stale));
    mkdirSync(pdir, { recursive: true });
    const rec = (type, ts) => JSON.stringify({ type, uuid: `${type}-${ts}`, timestamp: ts, message: { content: 'hi' } });
    writeFileSync(`${pdir}/older.jsonl`, [rec('user', '2026-09-08T10:00:00Z'), rec('assistant', '2026-09-08T10:00:05Z'), ''].join('\n'));
    writeFileSync(`${pdir}/newest.jsonl`, [rec('user', '2026-09-09T15:30:00Z'), rec('assistant', '2026-09-09T15:40:29Z'), ''].join('\n'));
    // Opened, /resume typed, closed: a command and its output, which the
    // transcript reader files as context and nobody's words — and the latest
    // timestamps in the folder, so anything counting records picks it.
    const cmd = (content, ts) => JSON.stringify({ type: 'user', uuid: `c-${ts}`, timestamp: ts, message: { role: 'user', content } });
    writeFileSync(`${pdir}/empty.jsonl`, [
      cmd('<command-name>/resume</command-name>\n<command-message>resume</command-message>\n<command-args></command-args>', '2026-09-09T16:41:03Z'),
      cmd('<local-command-stdout>Session newest is running as a background session (bg-1234).</local-command-stdout>', '2026-09-09T16:41:03Z'),
      JSON.stringify({ type: 'bridge-session', sessionId: 'empty' }), '',
    ].join('\n'));
    // mtime disagrees with the turns on purpose: a resume appends metadata
    // without a turn, so the older conversation is the one touched last.
    const now = Date.now() / 1000;
    utimesSync(`${pdir}/newest.jsonl`, now - 600, now - 600);
    utimesSync(`${pdir}/older.jsonl`, now - 1, now - 1);
    eq(await W.resumable(stale, 'newest'), { id: 'newest', note: null }, 'a pin whose transcript exists is resumed as it is');
    const pick = await W.resumable(stale, 'never-written');
    eq(pick.id, 'newest', 'a pin with no transcript falls back to the conversation with the latest turn, not the youngest file');
    eq((await W.resumable(stale, 'empty')).id, 'newest', 'a pin whose transcript holds only a slash command and its output is not a conversation either');
    assert(/never-written/.test(pick.note ?? '') && /newest/.test(pick.note ?? ''), `and the note says what was asked for and what was opened — ${pick.note}`);
    const bare = `${FIX}/bare-pin`;
    mkdirSync(bare, { recursive: true });
    const none = await W.resumable(bare, 'ghost');
    eq(none.id, null, 'with nothing on disk there is nothing to resume');
    assert(/ghost/.test(none.note ?? '') && /new conversation/.test(none.note ?? ''), `and the note says a new one starts — ${none.note}`);
    eq(await W.resumable(bare, null), { id: null, note: null }, 'no pin at all is no fallback: a fresh desk starts fresh, and silently');

    // Which model the window comes up on. A plain `--resume` restores the
    // conversation's last model over the operator's settings (2.1.258's
    // restoreModelFromSession — measured 2026-09-14, see defaultModel()), so
    // open() passes the default as `--model` when the operator has one, and
    // nothing when they have not.
    console.log('\n  the conversations in a folder, for the picker');
    const picker = `${FIX}/picker`;
    mkdirSync(picker, { recursive: true });
    const pkdir = W.projectDir(W.canonical(picker));
    mkdirSync(`${pkdir}/plain/subagents`, { recursive: true });
    const line = (o) => JSON.stringify(o);
    writeFileSync(`${pkdir}/named.jsonl`, [
      line({ type: 'user', uuid: 'n1', timestamp: '2026-09-09T10:00:00Z', gitBranch: 'main', message: { content: [{ type: 'text', text: '<ide_opened_file>x.js</ide_opened_file>' }, { type: 'text', text: 'Rename the widget, please' }] } }),
      line({ type: 'ai-title', aiTitle: 'Widget rename', sessionId: 'named' }),
      line({ type: 'assistant', uuid: 'n1b', timestamp: '2026-09-09T10:00:03Z', gitBranch: 'main', message: { model: 'claude-early-1', content: [{ type: 'text', text: 'looking' }] } }),
      line({ type: 'assistant', uuid: 'n2', timestamp: '2026-09-09T10:00:05Z', gitBranch: 'feature/widgets', message: { model: 'claude-later-2', content: [{ type: 'text', text: 'done' }] } }),
      line({ type: 'assistant', uuid: 'n3', timestamp: '2026-09-09T10:00:06Z', isSidechain: true, gitBranch: 'sidechain-branch', message: { model: 'claude-sidechain-9', content: [{ type: 'text', text: 'a subagent, not this conversation' }] } }),
      line({ type: 'assistant', uuid: 'n4', gitBranch: 'feature/widgets', message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }] } }),
      line({ type: 'custom-title', customTitle: 'Widgets', sessionId: 'named' }),
      '',
    ].join('\n'));
    writeFileSync(`${pkdir}/ai.jsonl`, [
      line({ type: 'user', uuid: 'a1', timestamp: '2026-09-08T10:00:00Z', message: { content: 'first words here' } }),
      line({ type: 'ai-title', aiTitle: 'Machine-named', sessionId: 'ai' }),
      line({ type: 'assistant', uuid: 'a2', timestamp: '2026-09-08T10:00:09Z', message: { content: [{ type: 'text', text: 'ok' }] } }),
      '',
    ].join('\n'));
    writeFileSync(`${pkdir}/plain.jsonl`, [
      line({ type: 'user', uuid: 'p0', isMeta: true, timestamp: '2026-09-07T09:59:00Z', message: { content: 'meta noise' } }),
      line({ type: 'user', uuid: 'p1', timestamp: '2026-09-07T10:00:00Z', message: { content: [{ type: 'text', text: '<ide_opened_file>y.js</ide_opened_file>' }, { type: 'text', text: `A very long first prompt ${'x'.repeat(120)}` }] } }),
      line({ type: 'assistant', uuid: 'p2', timestamp: '2026-09-07T10:00:07Z', message: { content: [{ type: 'text', text: 'ok' }] } }),
      '',
    ].join('\n'));
    writeFileSync(`${pkdir}/plain/subagents/agent-z.jsonl`, `${line({ type: 'user', uuid: 'z', isSidechain: true, timestamp: '2026-09-09T12:00:00Z', message: { content: 'not top level' } })}\n`);
    writeFileSync(`${pkdir}/empty.jsonl`, `${line({ type: 'bridge-session', sessionId: 'empty' })}\n`);
    const t0 = Date.now() / 1000;
    utimesSync(`${pkdir}/plain.jsonl`, t0 - 400, t0 - 400);
    utimesSync(`${pkdir}/ai.jsonl`, t0 - 300, t0 - 300);
    utimesSync(`${pkdir}/named.jsonl`, t0 - 200, t0 - 200);
    utimesSync(`${pkdir}/empty.jsonl`, t0 - 100, t0 - 100);
    mkdirSync(`${CLAUDE_HOME}/sessions`, { recursive: true });
    const liveFile = `${CLAUDE_HOME}/sessions/${process.pid}.json`;
    writeFileSync(liveFile, JSON.stringify({ pid: process.pid, sessionId: 'named', cwd: picker, kind: 'interactive', startedAt: Date.now() }));
    const listed = await W.sessionsIn(picker);
    eq(listed.map((r) => r.id), ['empty', 'named', 'ai', 'plain'], 'newest file first, and a subagent transcript is not a conversation');
    const byId = Object.fromEntries(listed.map((r) => [r.id, r]));
    eq([byId.named.title, byId.named.title_source], ['Widgets', 'custom'], 'a name the person gave wins, from the tail');
    eq([byId.ai.title, byId.ai.title_source], ['Machine-named', 'ai'], 'else the name Claude Code gave');
    eq(byId.plain.title_source, 'prompt', 'else the first prompt');
    assert(byId.plain.title.startsWith('A very long first prompt') && byId.plain.title.length <= 80 && byId.plain.title.endsWith('…'), `clipped — ${byId.plain.title}`);
    eq(byId.named.first_prompt, 'Rename the widget, please', 'and the first prompt is the person\'s words, not the IDE block glued in front of them');
    eq(byId.plain.started_at, '2026-09-07T10:00:00Z', 'a conversation began when the person first spoke, meta records aside');
    eq(byId.named.last_at, '2026-09-09T10:00:05Z', 'and was last spoken in at its last user or assistant turn');
    eq([byId.empty.title, byId.empty.spoken], [null, false], 'a file with no words is listed with no title and says nothing was said');
    // Row detail (issue #8): the branch and the model are the transcript's
    // own, the newest record that says — not the board's agent_sessions,
    // which has no model for three sessions in four.
    eq([byId.named.branch, byId.named.model], ['feature/widgets', 'claude-later-2'],
      'a row carries the branch and the model the conversation last had — the newest record wins, a subagent\'s record and Claude Code\'s own "<synthetic>" message aside');
    eq([byId.ai.branch, byId.ai.model, byId.empty.branch, byId.empty.model], [null, null, null, null], 'and neither, rather than a guess, for a transcript that never says');
    eq([byId.named.live, byId.named.held, byId.ai.live], [true, 'editor', false], 'the roster marks the live one, and one the host does not run is another app\'s (an editor, a terminal)');
    const ours = Object.fromEntries((await W.sessionsIn(picker, { ours: new Set([process.pid]) })).map((r) => [r.id, r]));
    eq(ours.named.held, 'floor', 'and one the host runs for a desk is the floor\'s');
    eq((await W.sessionsIn(picker, { limit: 2 })).map((r) => r.id), ['empty', 'named'], 'the limit takes the newest');
    eq(await W.sessionsIn(`${FIX}/never-opened`), [], 'a folder Claude Code never opened has none');
    rmSync(liveFile);

    // A conversation held by a background session. Claude Code's daemon keeps
    // one running after its tab closes; the roster lists it as kind `bg` with
    // a job id, and a `--resume` of it exits on its first line. Opening the
    // desk is the handoff, so the host stops it and resumes it here — and a
    // desk that said "run `claude stop`" instead stranded a channel (2026-09-09).
    console.log('\n  what a message is: a command, or a paste the window would wrap');
    eq(W.commandOf('/clear'), { name: 'clear', args: '' }, 'a bare slash word is a command');
    eq(W.commandOf('/model sonnet'), { name: 'model', args: 'sonnet' }, 'with its argument');
    eq(W.commandOf('  /btw what is 2+2? '), { name: 'btw', args: 'what is 2+2?' }, 'whitespace around it is not part of it');
    eq(W.commandOf('/btw first\nsecond'), null, 'a message with a newline in it is a message, whatever its first character');
    eq(W.commandOf('look at /tmp/x'), null, 'and so is a slash anywhere but first');
    eq(W.commandOf(''), null, 'nothing is not a command');
    eq(W.unwrapPaste('<pasted_content id="4a60">\nhello there\n</pasted_content id="4a60">'), 'hello there',
      'the wrapper the window puts round a long paste comes off, by its id');
    eq(W.unwrapPaste('look:\n<pasted_content id="1">\nA\n</pasted_content id="1">\nand <pasted_content id="2">B</pasted_content id="2">'), 'look:\nA\nand B',
      'every pair in a block, wherever it stands');
    eq(W.unwrapPaste('<pasted_content id="1">\nA\n</pasted_content id="2">'), '<pasted_content id="1">\nA\n</pasted_content id="2">',
      'and a pair whose ids differ is not a pair');


    // Transcript parsing, on a synthetic file — the shape Claude Code writes.
    const t = `${FIX}/t.jsonl`;
    writeFileSync(t, [
      JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-08-27T00:00:00Z', message: { content: 'first' } }),
      // A thinking block ahead of the words, as Claude Code writes them — and
      // an empty one, which it also writes, often.
      JSON.stringify({ type: 'assistant', uuid: 'a1', message: { content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'thinking', thinking: 'weigh it up first', signature: 'x' }, { type: 'text', text: 'reply' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'a2', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent noise' }] } }),
      JSON.stringify({ type: 'system', uuid: 's1', message: { content: 'ignored' } }),
      '',
    ].join('\n'));
    const first = await W.readTranscript(t);
    eq(first.turns.map((x) => `${x.role}:${x.text}`), ['user:first', 'thinking:weigh it up first', 'assistant:reply'],
      'transcript yields both sides, the thinking ahead of the reply as its own role, and skips empty thinking and subagent/system noise');

    /* A subagent writes a transcript of its own beside the session's, and its
     * words are read from there — labeled, so they are never mistaken for the
     * desk's own thread. Shape read on a live session, 2.1.258, 2026-09-03. */
    mkdirSync(`${FIX}/t/subagents`, { recursive: true });
    writeFileSync(`${FIX}/t/subagents/agent-abc123.meta.json`, JSON.stringify({ agentType: 'claude-code-guide', description: 'Docs lookup', toolUseId: 'toolu_1', spawnDepth: 1 }));
    writeFileSync(`${FIX}/t/subagents/agent-abc123.jsonl`, [
      JSON.stringify({ type: 'user', uuid: 'su1', isSidechain: true, agentId: 'abc123', timestamp: '2026-09-03T18:38:22Z', message: { content: 'the brief' } }),
      JSON.stringify({ type: 'assistant', uuid: 'sa1', isSidechain: true, agentId: 'abc123', timestamp: '2026-09-03T18:38:26Z', message: { content: [{ type: 'text', text: "I'll search the docs" }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'sa2', isSidechain: true, agentId: 'abc123', timestamp: '2026-09-03T18:38:27Z', message: { content: [{ type: 'tool_use', name: 'WebFetch', input: { url: 'https://example.test/docs' } }] } }),
      JSON.stringify({ type: 'user', uuid: 'su2', isSidechain: true, agentId: 'abc123', timestamp: '2026-09-03T18:38:36Z', message: { content: [{ type: 'tool_result', content: 'fetched' }] } }),
      '',
    ].join('\n'));
    const subs = await W.subagentTranscripts(t);
    eq(subs.map((x) => `${x.id}:${x.label}`), ['abc123:Docs lookup'], "a session's subagent files are found beside it, labeled by the description the caller gave");
    const subRead = await W.readTranscript(subs[0].path, { via: subs[0].label });
    eq(subRead.turns.map((x) => `${x.role}:${x.via}:${x.text || x.tool_name}`),
      ["assistant:Docs lookup:I'll search the docs", 'tool:Docs lookup:WebFetch'],
      "a subagent's words and tool calls are read with its label, and its brief and tool results are not turns");
    eq((await W.readTranscript(subs[0].path)).turns.length, 0, 'and without a label the same file reads as sidechain noise, as before');
    eq(await W.subagentTranscripts(`${FIX}/nothing.jsonl`), [], 'a session with no subagents has none');
    /* A transcript whose meta has not landed yet is left alone, so its turns are
     * never filed under the id and then the description. Measured by QA over 50
     * real pairs: one transcript came 52 s before its meta (PR #3, 2026-09-03).
     * Only past a long grace is it read under its id, in case the meta never
     * comes. */
    writeFileSync(`${FIX}/t/subagents/agent-late.jsonl`, `${JSON.stringify({ type: 'assistant', uuid: 'sl1', isSidechain: true, agentId: 'late', timestamp: '2026-09-03T18:40:00Z', message: { content: [{ type: 'text', text: 'first words' }] } })}\n`);
    eq((await W.subagentTranscripts(t)).map((s) => s.id), ['abc123'], 'a subagent transcript with no meta beside it is not read yet');
    eq((await W.subagentTranscripts(t, { metaGraceMs: 0 })).map((s) => `${s.id}:${s.label}`), ['abc123:Docs lookup', 'late:late'],
      'past the grace it is read under its id, in case the meta never comes');
    writeFileSync(`${FIX}/t/subagents/agent-late.meta.json`, JSON.stringify({ agentType: 'Explore', description: 'Late arrival' }));
    eq((await W.subagentTranscripts(t)).map((s) => `${s.id}:${s.label}`), ['abc123:Docs lookup', 'late:Late arrival'],
      'and once the meta lands it is read from the first word under the description');

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

    // A record Claude Code writes itself (model "<synthetic>"), such as the
    // "No response requested." a resumed, cut-off turn leaves (task 348 F4):
    // never the agent's words. An API error is still an error turn.
    const synT = ctxT.replace(/\.jsonl$/, '-syn.jsonl');
    writeFileSync(synT, [
      JSON.stringify({ type: 'assistant', uuid: 's1', message: { model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 's2', isApiErrorMessage: true, message: { model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 's3', message: { model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'real words' }] } }),
    ].join('\n') + '\n');
    eq((await W.readTranscript(synT)).turns.map((x) => `${x.role}${x.tool_name ? `/${x.tool_name}` : ''}:${x.text}`),
      ['context/synthetic:No response requested.', 'error:Not logged in · Please run /login', 'assistant:real words'],
      'a record Claude Code wrote itself is a quiet line, not the agent\'s words; an API error is still an error');
    // A Claude Code resuming a conversation, read off a process's command
    // line (task 348 F6): a terminal's, an npm install's, VS Code's; never a
    // desk's own (-p).
    eq([
      W.resumingIdOf('claude --resume 4cbfb241-1111-2222-3333-444444444444'),
      W.resumingIdOf('/Users/a/.local/bin/claude --resume=98a15be9-970b-4f74-ae2c-a6302c36d919 --setting-sources=user'),
      W.resumingIdOf('"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js --resume 7f75d964-aaaa-bbbb-cccc-dddddddddddd'),
      W.resumingIdOf('claude -p --input-format stream-json --resume 4cbfb241-1111-2222-3333-444444444444'),
      W.resumingIdOf('node /some/other/tool.js --resume 4cbfb241-1111-2222-3333-444444444444'),
    ], ['4cbfb241-1111-2222-3333-444444444444', '98a15be9-970b-4f74-ae2c-a6302c36d919', '7f75d964-aaaa-bbbb-cccc-dddddddddddd', null, null],
    'a Claude Code resuming a conversation is read off its command line, an npm install\'s node cli.js included, and a desk\'s own (-p) and anything else are not');

    // Claude Code's own marks in a user record (QA L2, pc-developer I1): its
    // record of a stop, and a command's output that is only the plugin's hook
    // command echoed back. Neither is the operator speaking.
    const markT = ctxT.replace(/\.jsonl$/, '-mark.jsonl');
    writeFileSync(markT, [
      JSON.stringify({ type: 'user', uuid: 'm1', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }),
      JSON.stringify({ type: 'user', uuid: 'm2', message: { content: '<local-command-stdout>Compacted PreCompact [p=$(cat); [ -n "$p" ] && (printf \'%s\' "$p" | node /x/plugin/hooks/report.mjs) ] completed successfully</local-command-stdout>' } }),
      JSON.stringify({ type: 'user', uuid: 'm3', message: { content: 'carry on' } }),
    ].join('\n') + '\n');
    eq((await W.readTranscript(markT)).turns.map((x) => `${x.role}${x.tool_name ? `/${x.tool_name}` : ''}:${x.text}`),
      ['context/interrupted:[Request interrupted by user for tool use]', 'user:carry on'],
      'Claude Code\'s record of a stop is a quiet line, and the hook command echoed after /compact is not shown');

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

  console.log('\n  a model or effort change saved as the default (costmo, 2026-11-22)');
  {
    const f = `${FIX}/settings.json`;
    writeFileSync(f, `${JSON.stringify({ model: 'opus', theme: 'dark', modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } }, null, 2)}\n`);
    eq(W.saveDefaults({ model: 'haiku' }, f).ok, true, 'a model change is saved');
    let d = JSON.parse(readFileSync(f, 'utf8'));
    eq([d.model, d.theme, d.modelSettings['claude-opus-5-5'].effortLevel], ['haiku', 'dark', 'high'], 'as the name given, and nothing else in the file changes');
    W.saveDefaults({ effort: 'low', modelId: 'claude-haiku-5-5' }, f);
    d = JSON.parse(readFileSync(f, 'utf8'));
    eq([d.modelSettings['claude-haiku-5-5'], d.modelSettings['claude-opus-5-5']], [{ effortLevel: 'low' }, { effortLevel: 'high' }], 'an effort change under its model\'s own key, as Claude Code keeps it, the other models\' left alone');
    eq(W.saveDefaults({ effort: 'low' }, f), { ok: true, wrote: false }, 'and an effort with no model known changes nothing, rather than guess where it goes, and says it wrote nothing');
    eq(JSON.parse(readFileSync(f, 'utf8')), d, 'the file as it was');
    const fresh = `${FIX}/none/settings.json`;
    eq([W.saveDefaults({ model: 'sonnet' }, fresh).ok, JSON.parse(readFileSync(fresh, 'utf8')).model], [true, 'sonnet'], 'a machine with no settings file yet gets one');
    writeFileSync(f, '{ not json');
    eq(W.saveDefaults({ model: 'x' }, f).ok, false, 'and a file it cannot read is refused, never overwritten');
    eq(readFileSync(f, 'utf8'), '{ not json', 'left exactly as it was');
  }
} catch (err) {
  console.log(`  ✗ the suite stopped: ${err.stack}`);
  failures++;
} finally {
  rmSync(FIX, { recursive: true, force: true });
}
console.log(failures ? `\nclaude: ${failures} failed` : '\nclaude: all passed');
process.exit(failures ? 1 : 0);

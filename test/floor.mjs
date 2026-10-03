// End-to-end test for the floor: the ingest door, what each hook event does to
// a desk, and the operator queue derived from it.
//
// The floor is the one part of this server that holds conversation content, and
// the assertions that matter most are the ones about restraint rather than
// features: the ingest door stays shut without the shared secret, a repo that
// never posts never appears, a status is only ever "waiting" because Claude Code
// said so, and re-notifying about the same prompt does not reset the clock the
// operator is reading. Each of those is a way the room could quietly start
// lying, and none of them would be caught by the other suites.
//   npm run test:floor
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { rmSync, readFileSync, writeFileSync } from 'node:fs';
import { deliverable, nudgeable, stoppable, isWorking, promptChoices, answerSteps, unansweredOf, formFromInput, settleForm, claudeable, switchable } from '../src/floor.js';

const PORT = Number(process.env.FLOOR_TEST_PORT ?? 8897);
const DB_PATH = `./data/floor-${process.pid}.db`;
const HOST = `http://localhost:${PORT}`;
const KEY = 'floor-shared-secret';
const CH = 'floor-test';

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

const rmDb = (p) => { for (const ext of ['', '-wal', '-shm']) { try { rmSync(p + ext); } catch { /* ignore */ } } };

async function waitHealthy() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${HOST}/health`)).ok) return true; } catch { /* retry */ }
    await sleep(100);
  }
  return false;
}

const post = (body, key = KEY) =>
  fetch(`${HOST}/api/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'x-orchestratinator-key': key } : {}) },
    body: JSON.stringify(body),
  });

const floor = () => fetch(`${HOST}/api/floor`).then((r) => r.json());
const turns = (agent, channel = CH) =>
  fetch(`${HOST}/api/floor/turns?channel=${encodeURIComponent(channel)}&agent=${encodeURIComponent(agent)}`)
    .then((r) => r.json());

/** The subset of a hook payload every event carries. */
const ev = (agent, session, event, extra = {}) => ({
  channel: CH, agent, session_id: session, hook_event_name: event,
  cwd: `/repo/${agent}`, ...extra,
});

const deskOf = (f, agent, channel = CH) =>
  f.channels.find((c) => c.channel === channel)?.desks.find((d) => d.agent === agent);

rmDb(DB_PATH);
const server = spawn('node', ['src/server.js'], {
  // FLOOR_SESSION_TTL_MINUTES at its 1-minute floor, so the staleness assertions
  // can age a session out with a direct SQL touch instead of a real hour.
  env: {
    ...process.env, PORT: String(PORT), DB_PATH,
    ORCH_AUTH_TOKEN: KEY, ORCH_AUTH_MODE: 'enforce', FLOOR_SESSION_TTL_MINUTES: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

try {
  if (!(await waitHealthy())) throw new Error('server never became healthy');

  console.log('\nthe ingest door');
  eq((await post({}, null)).status, 401, 'no key → 401, the same secret that guards /mcp');
  eq((await post({}, 'wrong-key')).status, 401, 'a wrong key → 401');
  eq((await post({ channel: CH, agent: 'a' })).status, 400, 'a key alone is not an event — session_id is required');
  const empty = await floor();
  eq(empty.channels.length, 0, 'and nothing rejected has left a desk behind');

  console.log('\na session appears, and is given a face');
  await post(ev('free', 's1', 'SessionStart', { model: 'claude-opus-5', git_branch: 'main', transcript_path: '/t/a.jsonl' }));
  let f = await floor();
  const free = deskOf(f, 'free');
  assert(!!free, 'one hook event is enough to get a seat');
  eq(free.persona, 'Free', "an agent's name is derived from its own id, not from the order it arrived in");
  eq(free.live, true, 'and is live');
  eq(free.session.window, 'free', 'the window name is the last segment of cwd, which is what the tab says');
  eq(free.session.git_branch, 'main', 'the branch it is on');
  eq(f.queue.length, 0, 'nobody is waiting on a human yet');

  console.log('\nthe conversation');
  await post(ev('free', 's1', 'UserPromptSubmit', { message: 'change the filter' }));
  await post(ev('free', 's1', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } }));
  await post(ev('free', 's1', 'Stop', { last_assistant_message: 'done' }));
  const t = await turns('free');
  eq(t.rows.map((r) => r.role), ['user', 'tool', 'assistant'], 'both sides of the turn are recorded, oldest first');
  eq(t.rows[1].text, 'Bash: npm test', 'a tool call collapses to one useful line, not just its name');
  eq(t.rows[1].tool_name, 'Bash', 'and keeps the tool name for the panel to expand');

  console.log('\nCOALESCE: a later event must not blank what an earlier one knew');
  await post(ev('free', 's1', 'Stop', { last_assistant_message: 'again' }));
  f = await floor();
  eq(deskOf(f, 'free').session.model, 'claude-opus-5', 'the model a SessionStart knew survives a Stop that never mentions one');

  console.log('\nwaiting is only ever what Claude Code said it was waiting for');
  await post(ev('pro', 's2', 'SessionStart'));
  f = await floor();
  eq(deskOf(f, 'pro').persona, 'Pro', 'and so is the second one — arrival order decides the seat, never the name');
  eq(f.queue.length, 0, 'a quiet desk is not inferred to be waiting');
  await post(ev('pro', 's2', 'Notification', { notification_type: 'auth_success', notification_message: 'signed in' }));
  eq((await floor()).queue.length, 0, 'and news that is not a blocker stays out of the queue');

  // An idle composer is not a question. Claude Code says so after sixty seconds
  // of quiet, which is the resting state of every agent waiting to be told what
  // is next — so it lit the desk and put an alert above the compose box with
  // nothing on it to press, and read as a desk that was stuck.
  await post(ev('pro', 's2', 'Notification', { notification_type: 'idle_prompt', notification_message: 'Claude is waiting for your input' }));
  f = await floor();
  eq(f.queue.length, 0, 'an agent idling with nothing to do is not blocked on a human');
  eq(deskOf(f, 'pro').session.awaiting_kind, null, 'and its desk raises nothing');

  await post(ev('pro', 's2', 'Notification', { notification_type: 'permission_prompt', notification_message: 'needs permission to run: git push' }));
  f = await floor();
  eq(f.queue.length, 1, 'a permission prompt puts exactly one person in the queue');
  eq(f.queue[0].agent, 'pro', 'the right one');
  eq(f.queue[0].window, 'pro', 'named by the window to go to');
  eq(deskOf(f, 'pro').session.awaiting_kind, 'permission_prompt', 'and the desk says why');

  console.log('\nthe clock the operator reads');
  const firstSince = f.queue[0].since;
  await sleep(1100);
  await post(ev('pro', 's2', 'Notification', { notification_type: 'permission_prompt', notification_message: 'still waiting' }));
  f = await floor();
  eq(f.queue.length, 1, 're-notifying does not queue the same person twice');
  eq(f.queue[0].since, firstSince, 'and does not restart the clock — the queue is ranked by how long a human has been the blocker');

  console.log('\nand it clears when work actually happens');
  await post(ev('pro', 's2', 'UserPromptSubmit', { message: 'yes, push it' }));
  f = await floor();
  eq(f.queue.length, 0, 'the human typed, so by definition they are no longer the blocker');
  eq(deskOf(f, 'pro').session.awaiting_kind, null, 'the desk agrees');

  console.log('\nan API error is the other way a window silently stops');
  await post(ev('pro', 's2', 'StopFailure', { error_type: 'overloaded', error_message: 'API overloaded' }));
  f = await floor();
  eq(f.queue.length, 1, 'a dead turn goes in the queue so nobody waits on it');
  eq(f.queue[0].kind, 'error', 'labelled as what it is');
  eq((await turns('pro')).rows.at(-1).role, 'error', 'and is visible in the conversation');

  console.log('\nleaving');
  await post(ev('e2e', 's3', 'SessionStart'));
  await post(ev('e2e', 's3', 'SessionEnd', { reason: 'prompt_input_exit' }));
  f = await floor();
  eq(deskOf(f, 'e2e').live, false, 'a closed window empties its chair');
  assert(!!deskOf(f, 'e2e'), 'but the desk stays — the person is away, not deleted');

  console.log('\nresuming');
  await post(ev('e2e', 's3', 'SessionStart', { reason: 'resume' }));
  eq(deskOf(await floor(), 'e2e').live, true, 'and any activity sits them back down');

  console.log('\ncasting');
  const before = deskOf(await floor(), 'pro').seat;
  let r = await fetch(`${HOST}/api/floor/persona`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: CH, agent: 'pro', persona: 'Marguerite' }),
  });
  eq(r.status, 200, 'an operator can rename a desk');
  f = await floor();
  eq(deskOf(f, 'pro').persona, 'Marguerite', 'and everyone sees it, because it is stored on the server');
  eq(deskOf(f, 'free').persona, 'Free', 'and renaming one desk leaves every other name alone');
  eq(deskOf(f, 'pro').seat, before, 'the seat does not move — renaming somebody is not rearranging the room');
  await post(ev('pro', 's2', 'Stop', { last_assistant_message: 'still here' }));
  eq(deskOf(await floor(), 'pro').persona, 'Marguerite', 'and the next hook event does not undo it');

  console.log('\navatars');
  eq(deskOf(await floor(), 'pro').gender, 'neutral',
     'an agent nobody has drawn is neutral — the figure exactly as it was before avatars existed');
  const profile = (body) => fetch(`${HOST}/api/floor/profile`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  eq((await profile({ channel: CH, agent: 'pro', gender: 'male' })).status, 200, 'an operator can choose one');
  eq(deskOf(await floor(), 'pro').gender, 'male', 'and the desk says so');
  eq(deskOf(await floor(), 'pro').persona, 'Marguerite',
     'while the name is untouched — the two are edited in one dialog but stored apart');
  eq((await profile({ channel: CH, agent: 'pro', gender: 'wizard' })).status, 400,
     'a value the drawing code has no shape for is refused, not stored — it would save and then draw as neutral forever');
  eq(deskOf(await floor(), 'pro').gender, 'male', 'and the refusal changed nothing');
  eq((await profile({ channel: CH, agent: 'pro', persona: 'Marguerite II' })).status, 200, 'a name-only edit is allowed');
  eq(deskOf(await floor(), 'pro').gender, 'male', 'and leaves the avatar alone, which is the other half of the same rule');
  eq((await profile({ channel: CH, agent: 'pro' })).status, 400, 'an edit that changes nothing is refused rather than logged');

  console.log('\navatar colours');
  const paletteOf = async () => (await (await fetch(`${HOST}/api/state`)).json()).palette;
  const pal = await paletteOf();
  eq([pal.shirt.length, pal.hair.length, pal.skin.length], [20, 6, 6],
     'the page is sent the colours it may offer, so picker and validator cannot disagree');
  const proDesk = deskOf(await floor(), 'pro');
  eq(proDesk.hair, pal.hair[pal.hair.length - 1], 'hair starts at the darkest brown — the colour every figure had before this');
  eq(proDesk.skin, pal.skin[0], 'and skin at the neutral placeholder, which is the head as it was already drawn');
  assert(pal.shirt.includes(proDesk.shirt), 'the shirt it was given is one of the shirts on offer');

  // The shirt is a fact about arrival order, so it is written down rather than
  // recomputed: a desk removed from ahead of this one must not repaint it.
  eq(deskOf(await floor(), 'free').shirt === deskOf(await floor(), 'pro').shirt, false,
     'two desks that arrived at different seats do not share a shirt');

  eq((await profile({ channel: CH, agent: 'pro', shirt: pal.shirt[11], hair: pal.hair[0], skin: pal.skin[4] })).status, 200,
     'an operator can set all three at once');
  let coloured = deskOf(await floor(), 'pro');
  eq([coloured.shirt, coloured.hair, coloured.skin], [pal.shirt[11], pal.hair[0], pal.skin[4]], 'and each one lands');
  eq(coloured.persona, 'Marguerite II', 'while the name is untouched');
  eq(coloured.gender, 'male', 'and so is the avatar shape');

  eq((await profile({ channel: CH, agent: 'pro', hair: '#ff00ff' })).status, 400,
     'a colour that is not on the list is refused — it would render, which is exactly why nothing downstream would catch it');
  eq(deskOf(await floor(), 'pro').hair, pal.hair[0], 'and the refusal changed nothing');

  console.log('\na crashed window cannot stay live forever');
  await post(ev('ghost', 's4', 'SessionStart'));
  eq(deskOf(await floor(), 'ghost').live, true, 'a fresh session is live');
  // Age the session past the TTL directly — the crash we are simulating is
  // precisely "no more events arrive", so there is no event to send.
  {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(DB_PATH);
    db.prepare(`UPDATE agent_sessions SET updated_at = datetime('now', '-2 minutes') WHERE session_id = 's4'`).run();
    db.close();
  }
  f = await floor();
  eq(deskOf(f, 'ghost').live, false, 'past the TTL a silent session shows as away — live is a recency claim, like the board presence dot');
  assert(!!deskOf(f, 'ghost'), 'the desk itself stays');
  await post(ev('ghost', 's4', 'Stop', { last_assistant_message: 'back' }));
  eq(deskOf(await floor(), 'ghost').live, true, 'and any event revives it');

  console.log('\nbut a desk waiting on a human is exempt from staleness');
  await post(ev('ghost', 's4', 'Notification', { notification_type: 'permission_prompt', notification_message: 'may I?' }));
  {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(DB_PATH);
    db.prepare(`UPDATE agent_sessions SET updated_at = datetime('now', '-2 minutes') WHERE session_id = 's4'`).run();
    db.close();
  }
  f = await floor();
  eq(deskOf(f, 'ghost').live, true, 'silence at a prompt is expected — no hooks fire while Claude Code waits');
  eq(f.queue.some((q) => q.agent === 'ghost'), true, 'so the longest-waiting person is never aged out of the queue built to surface them');
  await post(ev('ghost', 's4', 'UserPromptSubmit', { message: 'yes' }));

  console.log('\nevery agent the board knows gets a desk');
  {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(DB_PATH);
    db.prepare(`INSERT OR IGNORE INTO agents (channel, agent) VALUES (?, ?)`).run(CH, 'boardonly');
    db.prepare(`INSERT OR IGNORE INTO agents (channel, agent, retired_at) VALUES (?, ?, datetime('now'))`).run(CH, 'retiredone');
    db.close();
  }
  f = await floor();
  const bo = deskOf(f, 'boardonly');
  assert(!!bo, 'an agent that only ever talked to the board still has a seat — a floor is a channel, not a plugin roster');
  eq(bo.reporting, false, 'and is marked as not reporting, which is the reminder of who still needs the plugin');
  eq(bo.live, false, 'not live');
  assert(!!bo.persona, `and has a face (${bo.persona})`);
  eq(deskOf(f, 'retiredone'), undefined, 'a retired agent stays off the floor, matching the board');
  eq(f.queue.some((q) => q.agent === 'boardonly'), false, 'and nothing is inferred about it — no session, no queue entry');

  console.log('\nthe trash can on the board empties the desk on the floor');
  // The case above retires an agent that never had a seat. The one that
  // matters is an agent that did: its persona already exists, and the floor
  // used to keep drawing the desk off that row after the board had hidden it.
  // A desk that is waiting on a human is the strongest version — it was still
  // being counted in the queue after the operator had removed the agent.
  const ghostFace = deskOf(f, 'ghost').persona;
  await post(ev('ghost', 's4', 'Notification', { notification_type: 'permission_prompt', notification_message: 'still here?' }));
  {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(DB_PATH);
    db.prepare(`INSERT OR IGNORE INTO agents (channel, agent) VALUES (?, ?)`).run(CH, 'ghost');
    db.prepare(`UPDATE agents SET retired_at = datetime('now') WHERE channel = ? AND agent = ?`).run(CH, 'ghost');
    db.close();
  }
  f = await floor();
  eq(deskOf(f, 'ghost'), undefined, 'an agent removed on the board loses its desk on the floor, seat and all');
  eq(f.queue.some((q) => q.agent === 'ghost'), false, 'and leaves the queue with it — a prompt nobody can see is not "1 need you"');
  {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(DB_PATH);
    db.prepare(`UPDATE agents SET retired_at = NULL WHERE channel = ? AND agent = ?`).run(CH, 'ghost');
    db.close();
  }
  f = await floor();
  assert(!!deskOf(f, 'ghost'), 'restored on the board, it is back on the floor');
  eq(deskOf(f, 'ghost').persona, ghostFace, 'in the same chair with the same face — the persona survives retirement, only the desk is withheld');
  eq(f.queue.some((q) => q.agent === 'ghost'), true, 'and its prompt is back in the queue');
  await post(ev('ghost', 's4', 'UserPromptSubmit', { message: 'yes' }));

  console.log('\nchannels are floors, and stay separate');
  await post({ ...ev('free', 's9', 'SessionStart'), channel: 'other-floor' });
  f = await floor();
  eq(f.channels.length, 2, 'a new channel is a new floor with no server change');
  eq(deskOf(f, 'free', 'other-floor').persona, 'Free',
     'where the same id gets the same name — which is the point: a name means one thing everywhere');
  eq(f.totals.channels, 2, 'and the totals agree');

  // The bug this replaced: a rename wrote one (channel, agent) row, so the same
  // worker answered to two names depending on which room you were looking at —
  // while the *derived* name, coming from the id, was identical on both. The
  // default propagated and the override did not.
  await post({ ...ev('pro', 's10', 'SessionStart'), channel: 'other-floor' });
  eq(deskOf(await floor(), 'pro', 'other-floor').persona, 'Marguerite II',
     'a name given on one channel is the name on every channel — it belongs to the agent, not the desk');
  r = await fetch(`${HOST}/api/floor/persona`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'other-floor', agent: 'pro', persona: 'Bocefus' }),
  });
  eq(r.status, 200, 'and renaming from the other channel is the same edit');
  f = await floor();
  eq(deskOf(f, 'pro', 'other-floor').persona, 'Bocefus', 'seen where it was typed');
  eq(deskOf(f, 'pro', CH).persona, 'Bocefus', 'and back on the channel it was first named from');
  eq(deskOf(f, 'free', CH).persona, 'Free', 'while a different id is still untouched');
  eq(deskOf(f, 'pro', 'other-floor').gender, 'male',
     'and the avatar travels with the agent for the same reason the name does');
  eq(deskOf(f, 'pro', 'other-floor').hair, deskOf(f, 'pro', CH).hair,
     'colours travel too — one agent, one appearance, whichever room you are looking at');

  console.log('\nwho can be nudged, which is who can be messaged plus whether the window is still to come');
  // Plain objects rather than a seeded desk: these are the shapes the two
  // callers actually hand in, and one of them is the shape that broke.
  const fresh = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const live = { state: 'idle', host_seen: fresh, host_name: 'boxy', window_id: 'w1', outside_pid: null };
  assert(!deliverable(live).error, 'a hosted desk with a live host takes messages');
  assert(!nudgeable(live).error, 'and can be nudged');

  const noWindow = { ...live, window_id: null };
  assert(!deliverable(noWindow).error,
         'a desk with no window still takes a message — sending one is what opens the window');
  const wake = nudgeable(noWindow);
  assert(!wake.error && wake.opens,
         'and can be nudged, with `opens` set: the bell opens the window first — typing "nudge" into the composer did exactly that, so refusing here only moved the tap');
  assert(!nudgeable(live).opens, 'a desk with a window is nudged without opening anything');

  eq(nudgeable({ ...live, outside_pid: 4242 }).code, 'held_by_editor', 'nor can one an editor is holding');
  eq(nudgeable(null).code, 'not_hosted', 'nor one no host is running');

  // The regression that sent this looking: buildFloor hands over a desk whose
  // host_seen it has ALREADY converted to ISO. iso() ran over it a second time
  // and produced a trailing ZZ; Date.parse said NaN; `NaN >= TTL` is false; and
  // a host ten minutes dead was reported as ready to nudge.
  const stale = new Date(Date.now() - 10 * 60_000).toISOString().replace('T', ' ').slice(0, 19);
  eq(nudgeable({ ...live, host_seen: stale }).code, 'host_offline', 'a stale host is offline');
  eq(nudgeable({ ...live, host_seen: `${stale.replace(' ', 'T')}Z` }).code, 'host_offline',
     'and is still offline when the timestamp arrives already converted — the double conversion that used to read as live');
  eq(nudgeable({ ...live, host_seen: 'not a date' }).code, 'host_offline',
     'a timestamp that makes no sense fails closed, because the one thing it must never do is make a desk look alive');

  console.log('\nwho can be stopped, which is stricter again');
  // Stopping is Escape pressed in a pane, so it wants everything a nudge wants
  // and one thing more: something has to be running to interrupt.
  const busy = { ...live, state: 'working' };
  assert(isWorking(busy, null), 'a desk whose state says working is working');
  assert(isWorking(live, { role: 'tool' }),
         'and so is an idle-looking one whose newest turn is a tool call — PreToolUse is recorded as the tool starts, so this is the beat before the state event lands');
  assert(!isWorking(live, { role: 'assistant' }), 'a desk that has just spoken is not');
  // Not hosted, and still working: an agent that reports through the hooks with
  // no host row is exactly this shape, and the floor has always drawn it busy
  // off its turns alone. Worth pinning, because "working" and "stoppable" part
  // company right here — the desk below is drawn mid-command and its sign is
  // dark, since there is no window of ours to press Escape in.
  assert(isWorking(null, { role: 'tool' }), 'a desk with no host row is still working if its newest turn is a tool call');
  eq(stoppable(null, { role: 'tool' }).code, 'not_hosted', 'but it cannot be stopped, which is the one case where those two answers differ');

  assert(!stoppable(busy, null).error, 'a working desk on a live host can be stopped');
  assert(!stoppable(live, { role: 'tool' }).error, 'so can one mid-tool-call');
  eq(stoppable(live, null).code, 'not_working',
     'an idle desk cannot: there is nothing to interrupt, and the endpoint says so rather than pressing Escape into a waiting prompt');
  eq(stoppable({ ...busy, window_id: null }, null).code, 'no_window',
     'nor one with no window — unlike chat, this cannot open one, because there is nothing running in a window that does not exist');
  eq(stoppable({ ...busy, outside_pid: 4242 }, null).code, 'held_by_editor', 'nor one an editor is holding');
  eq(stoppable(null, null).code, 'not_hosted', 'nor one no host is running');
  eq(stoppable({ ...busy, host_seen: 'not a date' }, null).code, 'host_offline',
     'and an unreadable host timestamp fails closed here too');
  // The words are re-written per action even though the conditions are shared:
  // "send a message instead — that opens one" is no help to someone trying to
  // stop one, and it is the sentence that ends up in the sign's tooltip.
  assert(!/nudge|Send a message/i.test(stoppable({ ...busy, window_id: null }, null).error),
         'and its refusal is written for stopping, not borrowed from the nudge that shares the condition');

  console.log('\nwho can be opened in claude CLI, which is attach with one condition loosened');
  assert(!claudeable(live).error, 'a desk with a window on a live host can be opened in Claude');
  const noWin = claudeable({ ...live, window_id: null });
  assert(!noWin.error && noWin.opens,
         'and so can one with NO window — opening it is half of what the button does, which is the condition attach refuses on');
  eq(claudeable({ ...live, outside_pid: 4242 }).code, 'held_by_editor', 'but not one another process holds');
  assert(/CLI|terminal/i.test(claudeable({ ...live, outside_pid: 4242 }).error),
         'and that refusal names a CLI as well as an editor — the person clicking this button is the one whose holder IS a terminal');
  eq(claudeable(null).code, 'not_hosted', 'nor one no host is running');
  eq(claudeable({ ...live, host_seen: stale }).code, 'host_offline',
     'nor one whose host is offline — only the host can open the window this button may need to open');

  // Changing a binding: left, or moved. An editor holding the conversation is
  // not a refusal when the caller says so — a VS Code chat follows a rebind on
  // its own next call (measured 2026-09-09) — but working always is.
  eq(switchable(null).code, 'not_hosted', 'a binding cannot be changed where no host runs the repo');
  eq(switchable({ ...live, host_seen: stale }).code, 'host_offline', 'nor when its host is offline');
  eq(switchable({ ...live, outside_pid: 4242 }).code, 'held_by_editor', 'an editor holding it refuses by default');
  assert(!switchable({ ...live, outside_pid: 4242 }, null, Date.now(), { editorOk: true }).error, 'and is allowed when the caller knows the editor will follow');
  eq(switchable({ ...live, state: 'working' }).code, 'working', 'a working desk refuses — a rebind mid-turn changes who the agent is');
  eq(switchable(live, { role: 'tool' }).code, 'working', 'as does one whose last turn is a tool call');
  assert(!switchable(live, { role: 'assistant' }).error, 'an idle desk may be changed');

  console.log('\nputting a conversation back on the floor');
  // The direction that was missing. handback moves a conversation into the
  // editor; nothing moved it the other way, so a desk whose editor had let go
  // sat with no window and no way to be given one. The host could always do it
  // — its `case 'open'` was simply unreachable.
  const HK = { 'content-type': 'application/json', 'x-orchestratinator-key': KEY };
  // A real host names every desk it has on every registration, and the server
  // now reads a desk missing from that list as one the host no longer runs. So
  // this helper accumulates: each call re-sends everything registered so far,
  // which is what the sections below always assumed a registration meant.
  const known = new Map();
  const register = (desk) => {
    known.set(desk.agent, desk);
    return fetch(`${HOST}/api/host/register`, {
      method: 'POST', headers: HK,
      body: JSON.stringify({ host_id: 'h-open', name: 'openbox', tmux: 'orch', desks: [...known.values()] }),
    });
  };
  // Applied-count returned, not just the status: this endpoint answers 200 for a
  // batch it dropped entirely, so a test that read the status would pass on an
  // event that never landed.
  const hostEvents = (events) =>
    fetch(`${HOST}/api/host/events`, {
      method: 'POST', headers: HK,
      body: JSON.stringify({ host_id: 'h-open', events }),
    }).then((r) => r.json());
  const takeWork = () =>
    fetch(`${HOST}/api/host/work?host_id=h-open&wait=0`, { headers: HK })
      .then((r) => r.json())
      .then((b) => (b.work ?? []).map((i) => i.kind));
  const askOpen = () =>
    fetch(`${HOST}/api/floor/open`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: CH, agent: 'wanderer' }),
    });

  // No window and no editor: what closing a VS Code chat leaves behind.
  await register({ channel: CH, agent: 'wanderer', cwd: '/repo/wanderer' });
  let opened = await askOpen();
  eq(opened.status, 200, 'a desk with no window can be asked to open one');
  eq(await takeWork(), ['open'], 'and the host is handed exactly that work');

  // An editor still has it. Opening here would put two processes on one
  // transcript, which is the thing handback closes its own window to avoid.
  await register({ channel: CH, agent: 'wanderer', cwd: '/repo/wanderer', outside_pid: 4242 });
  opened = await askOpen();
  eq(opened.status, 409, 'refused while an editor holds it');
  eq((await opened.json()).code, 'held_by_editor', 'and says which of the two apps to close');
  eq(await takeWork(), [], 'a refused open queues nothing — the host is never asked to make a second copy');

  // Already on the floor: nothing to do, and saying so is not an error.
  await register({ channel: CH, agent: 'wanderer', cwd: '/repo/wanderer', window: '@7', scope: 'project' });
  eq(deskOf(await fetch(`${HOST}/api/floor`).then((x) => x.json()), 'wanderer')?.hosted?.scope, 'project',
     'a registration carries which file the host read the binding from — read off /api/floor, where it once arrived as null');
  opened = await askOpen();
  eq(opened.status, 200, 'asking for a window that is already open is not a failure');
  eq((await opened.json()).already, true, 'it says the window was already there');
  eq(await takeWork(), [], 'and queues nothing');

  const nowhere = await fetch(`${HOST}/api/floor/open`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: CH, agent: 'nobody-hosts-me' }),
  });
  eq(nowhere.status, 409, 'a desk no host runs cannot be opened');

  console.log('\nthe session picker\'s routes');
  const sessionsOf = () => fetch(`${HOST}/api/floor/sessions?channel=${CH}&agent=wanderer`).then((r) => r.json());
  const askSessions = () => fetch(`${HOST}/api/floor/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: CH, agent: 'wanderer' }),
  });
  const reopen = (body) => fetch(`${HOST}/api/floor/reopen`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: CH, agent: 'wanderer', ...body }),
  });
  eq((await sessionsOf()).at, null, 'before any host has listed them, a desk\'s sessions have no time — not an empty list that could mean anything');
  let askedList = await askSessions();
  eq([askedList.status, (await askedList.json()).asked], [200, true], 'the floor can ask the host to list a hosted desk\'s conversations');
  eq(await takeWork(), ['sessions'], 'and the host is handed exactly that work');
  askedList = await askSessions();
  eq((await askedList.json()).asked, false, 'asked again inside the throttle, the board says so and queues nothing');
  eq(await takeWork(), [], 'so a busy picker cannot have a host walking its folder on every redraw');
  const LISTED_AT = '2026-09-10T01:02:03.000Z';
  const listedRows = [
    { id: 's-alpha', title: 'Alpha work', title_source: 'custom', first_prompt: 'do alpha', started_at: '2026-09-09T10:00:00Z', last_at: '2026-09-09T11:00:00Z', modified_at: '2026-09-09T11:00:00Z', size: 1234, spoken: true, live: true, held: 'editor', kind: 'interactive', pid: 4242, branch: 'feature/alpha', model: 'claude-test-7' },
    { id: 's-beta', title: null, title_source: null, spoken: false, live: false, held: null },
    { title: 'no id at all' },
  ];
  eq((await hostEvents([{ type: 'sessions', channel: CH, agent: 'wanderer', at: LISTED_AT, rows: listedRows }])).applied, 1, 'the host answers with an event');
  const gotList = await sessionsOf();
  eq(gotList.at, LISTED_AT, 'served back with the host\'s own time on it');
  eq(gotList.rows.map((r) => r.id), ['s-alpha', 's-beta'], 'every row with an id, none without');
  eq([gotList.rows[0].title, gotList.rows[0].title_source, gotList.rows[0].held, gotList.rows[0].live, gotList.rows[0].size], ['Alpha work', 'custom', 'editor', true, 1234], 'with the fields the picker draws');
  eq([gotList.rows[0].branch, gotList.rows[0].model, gotList.rows[0].started_at, gotList.rows[0].last_at], ['feature/alpha', 'claude-test-7', '2026-09-09T10:00:00Z', '2026-09-09T11:00:00Z'],
    'and the row\'s detail — its branch, its model, and the two times its length is drawn from — crosses whole');
  eq([gotList.rows[1].branch, gotList.rows[1].model], [null, null], 'a row the host gave neither for has neither, not a default');
  eq([gotList.rows[0].known, gotList.rows[1].known], [false, false], 'and none known to the board yet');
  eq(gotList.current, null, 'the desk\'s current conversation is the board\'s to say — none registered here');
  eq((await hostEvents([{ type: 'turn', channel: CH, agent: 'wanderer', session_id: 's-alpha', role: 'assistant', text: 'alpha spoke' }])).applied, 1, 'a turn of one of them reaches the board');
  eq((await sessionsOf()).rows.map((r) => r.known), [true, false], 'and that one is known now');
  const strangerList = await fetch(`${HOST}/api/host/events`, {
    method: 'POST', headers: HK, body: JSON.stringify({ host_id: 'h-stranger', events: [{ type: 'sessions', channel: CH, agent: 'wanderer', at: '2030-01-01T00:00:00.000Z', rows: [{ id: 's-fake' }] }] }),
  }).then((r) => r.json());
  eq(strangerList.applied, 0, 'a list from a host that does not run the desk is refused');
  eq((await sessionsOf()).at, LISTED_AT, 'and changes nothing');

  let pick = await reopen({ session_id: 's-alpha' });
  eq([pick.status, (await pick.json()).known], [200, true], 'a pick of a known conversation is queued as known');
  pick = await reopen({ session_id: 's-beta' });
  eq((await pick.json()).known, false, 'and of an unknown one as unknown — the host joins those at the tail');
  pick = await reopen({ session_id: null });
  eq([pick.status, (await pick.json()).session_id], [200, null], 'start new is a reopen of nothing');
  eq(await takeWork(), ['reopen', 'reopen', 'reopen'], 'each one work for the host');
  eq((await reopen({ session_id: 'not a/session id' })).status, 400, 'a session id that could not be a file name is refused');
  await register({ channel: CH, agent: 'wanderer', cwd: '/repo/wanderer', outside_pid: 4242 });
  pick = await reopen({ session_id: 's-alpha' });
  eq([pick.status, (await pick.json()).code], [409, 'held_by_editor'], 'refused while an editor holds the desk — a resume closes a window the floor must hold');
  eq(await takeWork(), [], 'and queues nothing');
  await register({ channel: CH, agent: 'wanderer', cwd: '/repo/wanderer', window: '@7', scope: 'project' });
  eq((await fetch(`${HOST}/api/floor/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: CH, agent: 'nobody-hosts-me' }) })).status, 409,
    'a desk no host runs has no folder to list');

  /* ── opening a conversation to read, as it was (issue #8, Remaining 4) ──────
   * The board's own copy of a conversation is a tail, so reading one means
   * the host reading the whole transcript and the board holding it — in
   * memory, briefly, never in `turns`. And reading is not resuming: every
   * refusal a reopen makes is absent here, on purpose. */
  console.log('\nopening a conversation to read, as it was');
  let rd;
  const readWorkFull = () => fetch(`${HOST}/api/host/work?host_id=h-open&wait=0`, { headers: HK }).then((r) => r.json()).then((w) => w.work ?? []);
  const readAsk = (body) => fetch(`${HOST}/api/floor/read`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: CH, agent: 'wanderer', ...body }) });
  const readGet = (session, extra = '') => fetch(`${HOST}/api/floor/read?channel=${CH}&agent=wanderer&session=${session}${extra}`).then((r) => r.json());
  const page = (session, requestId, more) => hostEvents([{ type: 'transcript', channel: CH, agent: 'wanderer', session_id: session, request_id: requestId, at: '2026-09-11T01:02:03.000Z', ...more }]);
  eq((await readAsk({})).status, 400, 'a conversation has to be named to be read');
  rd = await readAsk({ session_id: '../../etc/passwd' });
  eq([rd.status, (await rd.json()).code], [400, 'bad_session'], 'by an id that could be a file name and nothing else');
  rd = await fetch(`${HOST}/api/floor/read`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: CH, agent: 'nobody-hosts-me', session_id: 's-alpha' }) });
  eq([rd.status, (await rd.json()).code], [409, 'not_hosted'], 'and on a desk some host runs — the conversation is on that host\'s disk');
  let got = await readGet('s-alpha');
  eq([got.request_id, got.at, got.done, got.rows], [null, null, false, []], 'before anybody has asked, there is nothing to read — not an empty conversation');
  eq(await takeWork(), [], 'and none of those refusals queued anything');
  const turnsBeforeRead = ((await turns('wanderer')).rows ?? []).length;
  const sessionBeforeRead = deskOf(await floor(), 'wanderer')?.hosted?.session_id ?? null;
  await register({ channel: CH, agent: 'wanderer', cwd: '/repo/wanderer', outside_pid: 4242 });
  rd = await readAsk({ session_id: 's-alpha' });
  const asked1 = await rd.json();
  eq([rd.status, asked1.session_id, typeof asked1.request_id], [200, 's-alpha', 'string'], 'a conversation an editor holds can be read — reading closes nothing, so the reopen\'s refusal does not apply');
  const readWork = await readWorkFull();
  eq(readWork.map((w) => `${w.kind}:${w.agent}:${w.payload.session_id}:${w.payload.request_id === asked1.request_id}`), ['read:wanderer:s-alpha:true'], 'the desk\'s host is handed the read, naming the request it answers');
  eq((await page('s-alpha', asked1.request_id, { turns: [
    { role: 'user', text: 'first words', at: '2026-09-09T10:00:00Z' },
    { role: 'context', text: '<ide_opened_file>x.js</ide_opened_file>', tool_name: 'ide_opened_file', at: '2026-09-09T10:00:00Z' },
    { role: 'thinking', text: 'a thought before speaking', at: '2026-09-09T10:00:02Z' },
    { role: 'assistant', text: 'the reply', at: '2026-09-09T10:00:03Z' },
    { role: 'tool', text: '', tool_name: 'Bash', tool_input: { command: 'ls -la' }, at: '2026-09-09T10:00:04Z' },
    { role: 'assistant', text: 'a subagent searching', via: 'Find the widget', at: '2026-09-09T10:00:05Z' },
    { role: 'banana', text: 'not a role', at: '2026-09-09T10:00:06Z' },
    { role: 'assistant', text: '', at: '2026-09-09T10:00:07Z' },
  ] })).applied, 1, 'the host answers with a page of the transcript');
  got = await readGet('s-alpha');
  eq([got.done, got.total, got.request_id === asked1.request_id], [false, 6, true], 'which the board holds and serves while more is on its way — six turns, the two that are not turns dropped');
  eq(got.rows.map((r) => `${r.id}|${r.role}|${r.text}|${r.tool_name ?? ''}|${r.via ?? ''}`), [
    '1|user|first words||', '2|context|<ide_opened_file>x.js</ide_opened_file>|ide_opened_file|', '3|thinking|a thought before speaking||',
    '4|assistant|the reply||', '5|tool|Bash: ls -la|Bash|', '6|assistant|a subagent searching||Find the widget',
  ], 'each row as a relayed turn would be: a tool is its one-line summary, context keeps its tag, a subagent\'s turn its label');
  eq(got.rows[0].created_at, '2026-09-09T10:00:00Z', 'dated when it was said, not when it was read');
  eq((await page('s-alpha', 'some-other-request', { turns: [{ role: 'user', text: 'from a stale read' }], done: true })).applied, 0, 'a page answering a request nobody is waiting on is not taken');
  eq((await fetch(`${HOST}/api/host/events`, { method: 'POST', headers: HK, body: JSON.stringify({ host_id: 'h-stranger', events: [{ type: 'transcript', channel: CH, agent: 'wanderer', session_id: 's-alpha', request_id: asked1.request_id, turns: [{ role: 'user', text: 'forged' }], done: true }] }) }).then((r) => r.json())).applied, 0,
    'nor is one from a host that does not run the desk');
  eq((await page('s-alpha', asked1.request_id, { turns: [{ role: 'assistant', text: 'the last word', at: '2026-09-09T11:00:00Z' }], done: true })).applied, 1, 'the last page says it is the last');
  got = await readGet('s-alpha');
  eq([got.done, got.total, got.rows.at(-1).id, got.rows.at(-1).text], [true, 7, 7, 'the last word'], 'and the board says the conversation is whole');
  got = await readGet('s-alpha', '&from=2&limit=3');
  eq([got.from, got.rows.map((r) => r.id), got.total], [2, [3, 4, 5], 7], 'it is served in pages, so a long one is not one enormous answer');
  eq(((await turns('wanderer')).rows ?? []).length, turnsBeforeRead, 'none of it was written into the desk\'s turns — reading a conversation is not having it');
  eq(deskOf(await floor(), 'wanderer')?.hosted?.session_id ?? null, sessionBeforeRead, 'and the desk is on the conversation it was on');
  rd = await readAsk({ session_id: 's-alpha' });
  const asked2 = await rd.json();
  got = await readGet('s-alpha');
  eq([asked2.request_id !== asked1.request_id, got.total, got.done], [true, 0, false], 'asking again starts again — the transcript may have grown since');
  eq((await page('s-alpha', asked2.request_id, { error: 'no conversation s-alpha in /repo/wanderer: no transcript yet', done: true })).applied, 1, 'a conversation the host cannot find is answered as that');
  got = await readGet('s-alpha');
  eq([got.done, got.error], [true, 'no conversation s-alpha in /repo/wanderer: no transcript yet'], 'in the host\'s words, naming the folder');
  for (const id of ['s-1', 's-2', 's-3', 's-4']) await readAsk({ session_id: id });
  eq([(await readGet('s-alpha')).request_id, typeof (await readGet('s-4')).request_id, typeof (await readGet('s-1')).request_id], [null, 'string', 'string'],
    'the board holds the newest four reads and lets the oldest go — it is a reading desk, not a second archive');
  await takeWork();
  await register({ channel: CH, agent: 'wanderer', cwd: '/repo/wanderer', window: '@7', scope: 'project' });

  /* ── history across every desk: recent, and search (issue #8, Remaining 2, 3) ─
   * Both are asked of every host on the board and answered from the
   * transcripts on its disk; the board merges, and says which hosts
   * answered. What a host does with the ask is the host suite's. */
  {
  console.log('\nrecent conversations across every desk');
  const hPost = (path, body = {}) => fetch(`${HOST}/api/floor/history/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const hGet = (path) => fetch(`${HOST}/api/floor/history/${path}`).then((r) => r.json());
  const hWork = () => fetch(`${HOST}/api/host/work?host_id=h-open&wait=0`, { headers: HK }).then((r) => r.json()).then((w) => w.work ?? []);
  const hEvent = (ev, host = 'h-open') => fetch(`${HOST}/api/host/events`, { method: 'POST', headers: HK, body: JSON.stringify({ host_id: host, events: [{ type: 'history', ...ev }] }) }).then((r) => r.json());
  let hist = await hGet('recent');
  eq([hist.rows, hist.hosts.find((h) => h.host_id === 'h-open')?.at ?? null, hist.hosts.find((h) => h.host_id === 'h-open')?.asked], [[], null, false],
    'before any host has been asked there is no recent list — and the answer says the host has not been asked, not that it has nothing');
  let hr = await hPost('recent');
  eq([hr.status, (await hr.json()).asked], [200, ['openbox']], 'the floor asks every host on the board for its recent conversations');
  const recentWork = await hWork();
  eq(recentWork.map((w) => `${w.kind}:${w.channel}:${typeof w.payload.request_id}`), ['recent:*:string'], 'each is handed that work, about the machine rather than a desk');
  hr = await hPost('recent');
  eq([(await hr.json()).asked, await hWork()], [[], []], 'asked again inside the throttle, nobody is asked — a list is a walk of every folder\'s transcripts');
  const recentRows = [
    { id: 'r-old', channel: CH, agent: 'wanderer', title: 'Older work', title_source: 'ai', started_at: '2026-09-01T10:00:00Z', last_at: '2026-09-01T11:00:00Z', modified_at: '2026-09-01T11:00:00Z', size: 10, spoken: true, live: false, held: null, branch: 'main', model: 'claude-old-1' },
    { id: 'r-new', channel: CH, agent: 'wanderer', title: 'Newer work', title_source: 'custom', started_at: '2026-09-20T10:00:00Z', last_at: '2026-09-20T12:30:00Z', modified_at: '2026-09-20T12:30:00Z', size: 20, spoken: true, live: true, held: 'floor', branch: 'feature/new', model: 'claude-new-2' },
    { id: 'r-stray', channel: CH, agent: 'nobody-hosts-me', title: 'A desk this host does not run', last_at: '2026-09-25T10:00:00Z' },
    { id: 'r-nodesk', title: 'No desk named at all', last_at: '2026-09-26T10:00:00Z' },
  ];
  eq((await hEvent({ kind: 'recent', request_id: 'not-the-request', at: '2026-09-27T00:00:00.000Z', rows: recentRows })).applied, 0, 'an answer to a request the board did not make is not taken');
  eq((await hEvent({ kind: 'recent', request_id: recentWork[0].payload.request_id, at: '2026-09-27T01:02:03.000Z', rows: recentRows })).applied, 1, 'the host answers with its desks\' conversations');
  hist = await hGet('recent');
  eq(hist.rows.map((r) => r.id), ['r-new', 'r-old'], 'served most recently spoken in first — and a row for a desk the host does not run, or for no desk, is dropped: it could not be opened');
  eq([hist.rows[0].channel, hist.rows[0].agent, hist.rows[0].host, hist.rows[0].title, hist.rows[0].branch, hist.rows[0].model, hist.rows[0].started_at, hist.rows[0].live],
    [CH, 'wanderer', 'openbox', 'Newer work', 'feature/new', 'claude-new-2', '2026-09-20T10:00:00Z', true],
    'each row says which desk and host it is on, and carries the same detail a desk\'s own list does');
  assert(typeof hist.rows[0].persona === 'string' && hist.rows[0].persona.length > 0, `with the desk\'s name as the floor shows it — ${hist.rows[0].persona}`);
  const openHost = hist.hosts.find((h) => h.host_id === 'h-open');
  eq([openHost.live, openHost.asked, openHost.at, openHost.rows], [true, true, '2026-09-27T01:02:03.000Z', 2], 'and the answer says which host answered, and when');
  eq((await hEvent({ kind: 'recent', request_id: recentWork[0].payload.request_id, at: '2030-01-01T00:00:00.000Z', rows: [{ id: 'forged', channel: CH, agent: 'wanderer' }] }, 'h-stranger')).applied, 0,
    'a list from a host that was not asked changes nothing');
  const hostsSeen = (await hGet('recent')).hosts.map((h) => `${h.host_id}:${h.live}:${h.asked}`);
  assert(hostsSeen.includes('h-open:true:true') && hostsSeen.length >= 1, `and every host the board knows is in the answer with whether it is there and whether it was asked — ${hostsSeen.join(', ')}`);

  console.log('\nsearching what was said, across every desk');
  hr = await hPost('search', { query: 'x' });
  eq([hr.status, (await hr.json()).code], [400, 'short_query'], 'a search of one character is refused — it would match every turn there is');
  hr = await hPost('search', { query: 'y'.repeat(201) });
  eq((await hr.json()).code, 'long_query', 'and so is one longer than a sentence');
  eq(await hWork(), [], 'neither queued anything');
  hr = await hPost('search', { query: '  widget rename  ' });
  const s1 = await hr.json();
  eq([hr.status, s1.asked, s1.query, s1.deep], [200, true, 'widget rename', false], 'a search is accepted, for what was said — tool calls and thinking are not searched unless asked for');
  let searchWork = await hWork();
  eq(searchWork.map((w) => `${w.kind}:${w.payload.query}:${w.payload.deep}:${w.payload.request_id === s1.id}`), ['search:widget rename:false:true'], 'and every host is handed it, with whether to look deeper');
  hr = await hPost('search', { query: 'widget rename' });
  const s1again = await hr.json();
  eq([s1again.asked, s1again.id, await hWork()], [false, s1.id, []], 'the same words again, at once, are answered by the search already running — not a second walk of every disk');
  hr = await hPost('search', { query: 'widget rename', deep: true });
  const s2 = await hr.json();
  searchWork = await hWork();
  eq([s2.asked, s2.id !== s1.id, searchWork.map((w) => w.payload.deep)], [true, true, [true]], 'the same words with tool calls and thinking included is a different search');
  let found = await hGet(`search?id=${s1.id}`);
  eq([found.done, found.rows, found.hosts.find((h) => h.host_id === 'h-open')?.asked, found.hosts.find((h) => h.host_id === 'h-open')?.at], [false, [], true, null],
    'until the host answers, the search is not done and says who it is waiting for');
  eq((await hEvent({ kind: 'search', request_id: s1.id, query: 'widget rename', deep: false, at: '2026-09-27T02:00:00.000Z', files: 104, ms: 2700, rows: [
    { id: 'r-old', channel: CH, agent: 'wanderer', title: 'Older work', last_at: '2026-09-01T11:00:00Z', hits: 2, snippets: [{ role: 'user', at: '2026-09-01T10:00:00Z', text: '…please do the widget rename today…' }, { role: 'assistant', at: '2026-09-01T10:01:00Z', via: 'Find the widget', text: 'the widget rename is done' }, { role: null, text: 'no role' }] },
    { id: 'r-new', channel: CH, agent: 'wanderer', title: 'Newer work', last_at: '2026-09-20T12:30:00Z', hits: 1, snippets: [{ role: 'assistant', text: 'after the widget rename…' }] },
    { id: 'r-stray', channel: CH, agent: 'nobody-hosts-me', title: 'not this host\'s desk', hits: 9, snippets: [] },
  ] })).applied, 1, 'the host answers with the conversations it found, how many files it read and how long it took');
  found = await hGet(`search?id=${s1.id}`);
  eq([found.done, found.query, found.deep, found.rows.map((r) => `${r.id}:${r.hits}`)], [true, 'widget rename', false, ['r-new:1', 'r-old:2']], 'served most recently spoken in first, each with how many turns matched');
  eq(found.rows[1].snippets.map((sn) => `${sn.role}|${sn.via ?? ''}|${sn.text}`), ['user||…please do the widget rename today…', 'assistant|Find the widget|the widget rename is done'], 'and the first of them, as said — who, and under which subagent');
  const answered = found.hosts.find((h) => h.host_id === 'h-open');
  eq([answered.at, answered.files, answered.ms, answered.rows, answered.error], ['2026-09-27T02:00:00.000Z', 104, 2700, 2, null], 'the answer says which host answered, over how many files, in how long');
  eq((await hGet(`search?id=${s2.id}`)).done, false, 'and the other search is still its own, unanswered');
  eq((await hEvent({ kind: 'search', request_id: s2.id, query: 'widget rename', deep: true, at: '2026-09-27T02:00:05.000Z', rows: [], error: 'the search ended with exit code 1: out of memory' })).applied, 1, 'a search that failed on a host says so');
  found = await hGet(`search?id=${s2.id}`);
  eq([found.done, found.hosts.find((h) => h.host_id === 'h-open')?.error], [true, 'the search ended with exit code 1: out of memory'], 'in the host\'s words, on that host\'s line');
  eq((await fetch(`${HOST}/api/floor/history/search?id=nonsense`)).status, 404, 'a search the board is not holding says so');
  await hWork();
  }

  console.log('\nthe folders a host offers');
  // The list the "take a desk" dialog draws. Every value here is one that
  // cannot be a fallback — a name, a time, a count that nothing on the server
  // could have made up — so a field that arrives on the page came through the
  // whole chain (see docs/internals.md) rather than being defaulted into place.
  const registerWith = (extra) =>
    fetch(`${HOST}/api/host/register`, {
      method: 'POST', headers: HK,
      body: JSON.stringify({ host_id: 'h-open', name: 'openbox', tmux: 'orch', desks: [...known.values()], ...extra }),
    });
  const folders = () => fetch(`${HOST}/api/floor/folders`).then((r) => r.json());
  eq((await folders()).hosts.find((h) => h.host_id === 'h-open')?.at ?? null, null,
    'a host that has never reported folders has a null time — not an empty list, which could mean anything');
  const offered = [
    { path: '/repo/zeta-newest', name: 'zeta-newest', depth: 1, bound: null, has_mcp_json: false, other_board: null, trusted: true, last_active: '2026-09-09T01:02:03.000Z', sessions: 7 },
    { path: '/repo/alpha-older', name: 'alpha-older', depth: 1, bound: { channel: CH, agent: 'alpha', scope: 'local', board: HOST }, has_mcp_json: false, other_board: null, trusted: false, last_active: '2026-09-08T01:02:03.000Z', sessions: 2 },
    { path: '/repo/elsewhere-bound', name: 'elsewhere-bound', depth: 1, bound: { channel: 'x', agent: 'y', scope: 'project', board: 'http://10.0.0.9:8787' }, has_mcp_json: true, other_board: 'http://10.0.0.9:8787', trusted: false, last_active: null, sessions: 0 },
    { path: '/etc/not-under-a-root', name: 'not-under-a-root', depth: 1, bound: null },
    { path: 'relative/nonsense', name: 'nonsense', depth: 1, bound: null },
  ];
  await registerWith({ roots: ['/repo'], folders: offered });
  const mine = (await folders()).hosts.find((h) => h.host_id === 'h-open');
  eq(mine?.live, true, 'the host is live');
  eq(mine?.roots, ['/repo'], 'its roots are served');
  eq(mine?.folders.map((f) => f.name), ['zeta-newest', 'alpha-older', 'elsewhere-bound'],
    'every folder under its roots is served in the order the host gave, and one outside them — or not a path at all — is dropped');
  eq(mine?.folders[1].bound, { channel: CH, agent: 'alpha', scope: 'local', board: HOST }, 'a binding crosses whole');
  eq(mine?.folders[0].last_active, '2026-09-09T01:02:03.000Z', 'so does the activity time');
  eq(mine?.folders[0].sessions, 7, 'and the session count');
  eq(mine?.folders[0].trusted, true, 'and the trust mark');
  eq(mine?.folders[2].other_board, 'http://10.0.0.9:8787', 'and the other-board mark');
  eq(mine?.folders[2].has_mcp_json, true, 'and whether a .mcp.json entry exists to import');
  assert(typeof mine?.at === 'string' && mine.at.length > 10, 'with the time the list was reported');
  const flood = Array.from({ length: 301 }, (_, i) => ({ path: `/repo/f${i}`, name: `f${i}`, depth: 1, bound: null }));
  await registerWith({ roots: ['/repo'], folders: flood });
  eq((await folders()).hosts.find((h) => h.host_id === 'h-open')?.folders.length, 300, 'a list is capped at 300 entries');
  const fl = await (await fetch(`${HOST}/api/floor`)).json();
  assert(typeof fl.hosts.find((h) => h.host_id === 'h-open')?.folders_at === 'string', '/api/floor carries only when the list was reported, never the list');
  assert(!('folders' in (fl.hosts.find((h) => h.host_id === 'h-open') ?? {})), 'the list itself stays off the payload every page polls');
  await registerWith({ roots: ['/repo'], folders: offered });

  /* ── taking a desk ──────────────────────────────────────────────────────────
   * What the route checks is what the board knows; what the host does is the
   * host suite's. Every refusal must queue nothing. */
  console.log('\ntaking a desk from the floor');
  const takeWorkFull = () =>
    fetch(`${HOST}/api/host/work?host_id=h-open&wait=0`, { headers: HK }).then((r) => r.json()).then((b) => b.work ?? []);
  const take = (body) => fetch(`${HOST}/api/floor/desk`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  await takeWork();
  let rr = await take({ host_id: 'h-open', path: '/repo/zeta-newest', channel: CH, agent: 'has space' });
  eq(rr.status, 400, 'an agent name that is not a name is refused');
  eq((await rr.json()).code, 'bad_name', 'with the rule');
  rr = await take({ host_id: 'h-open', path: '/repo/zeta-newest', channel: 'brand new channel', agent: 'fresh' });
  eq((await rr.json()).code, 'bad_name', 'a typed channel name follows the same rule');
  rr = await take({ host_id: 'nobody', path: '/repo/zeta-newest', channel: CH, agent: 'fresh' });
  eq((await rr.json()).code, 'no_host', 'a host the board does not have is refused');
  rr = await take({ host_id: 'h-open', path: '/repo/not-offered', channel: CH, agent: 'fresh' });
  eq((await rr.json()).code, 'unknown_folder', 'a folder the host did not offer is refused — the board never sends a path the host did not name');
  rr = await take({ host_id: 'h-open', path: '/repo/elsewhere-bound', channel: 'x', agent: 'y' });
  eq((await rr.json()).code, 'other_board', 'a folder bound to another board is refused');
  rr = await take({ host_id: 'h-open', path: '/repo/zeta-newest', channel: CH, agent: 'wanderer' });
  eq((await rr.json()).code, 'desk_taken', 'a name already seated live at another folder is refused');
  rr = await take({ host_id: 'h-open', path: '/repo/alpha-older', channel: CH, agent: 'someone-else' });
  eq([rr.status, (await rr.json()).code], [400, 'agent_fixed'], 'a folder that names its agent cannot be taken under another name — only the floor can change');
  eq(await takeWork(), [], 'and none of those queued anything');

  /* The picker: the host lists one folder at a time, and a folder it has
   * shown that way can be taken, whether or not the flat list offered it. */
  console.log('\nthe folder picker');
  const browse = (body) => fetch(`${HOST}/api/floor/browse`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const browsed = (path) => fetch(`${HOST}/api/floor/browse?host_id=h-open${path ? `&path=${encodeURIComponent(path)}` : ''}`).then((r) => r.json());
  eq((await browsed()).at, null, 'before a host has listed anything, there is nothing to show — not an empty folder');
  eq((await browsed()).roots, ['/repo'], 'but the picker knows where to start');
  rr = await browse({ host_id: 'h-open' });
  eq(rr.status, 200, 'the floor can ask a host to list its root');
  eq(await takeWork(), ['browse'], 'and the host is handed exactly that work');
  eq((await browse({ host_id: 'nobody' })).status, 409, 'a host the board does not have cannot be asked');
  eq((await browse({ host_id: 'h-open', path: 'relative/nonsense' })).status, 400, 'nor for a path that is not absolute');
  const LISTED = '2026-09-10T02:03:04.000Z';
  eq((await hostEvents([{
    type: 'browse', requested: '/repo', path: '/repo', root: '/repo', parent: null, at: LISTED,
    self: { path: '/repo', name: 'repo', depth: 0, bound: null, has_mcp_json: false, other_board: null, trusted: true, git: false, last_active: null, sessions: 0 },
    entries: [
      { path: '/repo/gamma-deep', name: 'gamma-deep', depth: 1, bound: null, has_mcp_json: false, other_board: null, trusted: false, git: true, last_active: null, sessions: 0 },
      { path: '/repo/alpha-older', name: 'alpha-older', depth: 1, bound: { channel: CH, agent: 'alpha', scope: 'local', board: HOST }, has_mcp_json: false, other_board: null, trusted: false, git: true, last_active: '2026-09-08T01:02:03.000Z', sessions: 2 },
      { name: 'no-path' },
    ],
  }])).applied, 1, 'the host answers with the folder and what is inside it');
  let shown = await browsed('/repo');
  eq([shown.at, shown.path, shown.parent], [LISTED, '/repo', null], 'served back with the host\'s time, for the path asked');
  eq(shown.entries.map((f) => f.name), ['gamma-deep', 'alpha-older'], 'every folder with a path, none without');
  eq([shown.entries[1].bound?.agent, shown.entries[0].git], ['alpha', true], 'with what each is bound as, and whether it is a checkout');
  eq((await browsed('/repo/somewhere-else')).at, null, 'and nothing for a path the host has not listed');
  rr = await take({ host_id: 'h-open', path: '/repo/gamma-deep', channel: CH, agent: 'gamma' });
  eq([rr.status, (await rr.json()).mode], [200, 'take'], 'a folder the picker showed can be taken, though the flat list never offered it');
  eq((await takeWorkFull()).map((w) => `${w.kind}:${w.payload.path}`), ['bind:/repo/gamma-deep'], 'and the host is handed the bind');
  rr = await take({ host_id: 'h-open', path: '/repo/alpha-older', channel: 'other-floor', agent: 'alpha' });
  eq([rr.status, (await rr.json()).mode], [200, 'move'], 'a bound folder taken onto another floor, under its own name, is a move');
  const moveWork = await takeWorkFull();
  eq(moveWork.map((w) => `${w.kind}:${w.payload.from?.channel}/${w.payload.from?.agent}:${w.payload.resume}:${w.payload.import}`), [`bind:${CH}/alpha:true:true`],
    'which the host is told where from, and to resume the conversation');
  eq((await hostEvents([{ type: 'bound', channel: 'other-floor', agent: 'alpha', cwd: '/repo/alpha-older', scope: 'local', session_id: 'sess-alpha', from: { channel: CH, agent: 'alpha' } }])).applied, 1,
    'the host answers bound, saying where from');
  const afterMove = await fetch(`${HOST}/api/floor`).then((x) => x.json());
  eq(deskOf(afterMove, 'alpha', 'other-floor')?.hosted?.session_id, 'sess-alpha', 'the desk is on the new floor, on its conversation');
  eq(deskOf(afterMove, 'alpha', CH) ?? null, null, 'and its old seat is gone from the old one');

  rr = await take({ host_id: 'h-open', path: '/repo/zeta-newest', channel: CH, agent: 'fresh', persona: 'Fresh Face' });
  eq(rr.status, 200, 'an unbound folder can be taken');
  eq((await rr.json()).mode, 'take', 'as a fresh binding');
  const bindWork = await takeWorkFull();
  eq(bindWork.map((w) => w.kind), ['bind'], 'the host is handed exactly one bind');
  eq(bindWork[0]?.payload && { path: bindWork[0].payload.path, channel: bindWork[0].payload.channel, agent: bindWork[0].payload.agent, import: bindWork[0].payload.import, open: bindWork[0].payload.open },
     { path: '/repo/zeta-newest', channel: CH, agent: 'fresh', import: false, open: true }, 'with the folder, the names, and no key — the host binds with its own');
  const seated = deskOf(await fetch(`${HOST}/api/floor`).then((x) => x.json()), 'fresh');
  eq(seated?.persona, 'Fresh Face', 'the desk is drawn at once with the name it was given');
  eq(seated?.hosted ?? null, null, 'as not hosted, until the host says otherwise');
  rr = await take({ host_id: 'h-open', path: '/repo/alpha-older', channel: CH, agent: 'alpha' });
  eq((await rr.json()).mode, 'import', 'a folder bound in its .mcp.json as these same names is an import');
  eq((await takeWorkFull()).map((w) => `${w.kind}:${w.payload.import}`), ['bind:true'], 'which the host is told');

  // The host answers with `bound`: a row for a desk that had none.
  eq((await hostEvents([{ type: 'bound', channel: CH, agent: 'fresh', cwd: '/repo/zeta-newest', scope: 'local', session_id: 'sess-fresh' }])).applied, 1,
    'a bound event is taken for a desk the host did not have before');
  const bound = deskOf(await fetch(`${HOST}/api/floor`).then((x) => x.json()), 'fresh');
  eq(bound?.hosted?.scope, 'local', 'and the desk is hosted, in local scope');
  eq(bound?.hosted?.session_id, 'sess-fresh', 'following the session it was given');
  // Leaving: refused where it should be, queued where it should be.
  const leave = (body) => fetch(`${HOST}/api/floor/desk/leave`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  rr = await leave({ channel: CH, agent: 'nobody-hosts-me' });
  eq((await rr.json()).code, 'not_hosted', 'a desk no host runs cannot be left');
  known.set('fresh', { channel: CH, agent: 'fresh', cwd: '/repo/zeta-newest', outside_pid: 777 });
  await registerWith({ roots: ['/repo'], folders: offered });
  rr = await leave({ channel: CH, agent: 'fresh' });
  eq(rr.status, 200, 'a desk held by an editor can still be left — the editor chat follows the binding by itself');
  eq(await takeWork(), ['unbind'], 'and the host is handed the unbind');
  eq((await hostEvents([{ type: 'unbound', channel: CH, agent: 'fresh' }])).applied, 1, 'the host answers with unbound');
  const gone = deskOf(await fetch(`${HOST}/api/floor`).then((x) => x.json()), 'fresh');
  eq(gone?.hosted?.state, 'offline', 'the desk is offline');
  eq(gone?.persona, 'Fresh Face', 'and the seat stays');
  known.delete('fresh');
  await registerWith({ roots: ['/repo'], folders: offered });

  /* ── the host's own folder dialog (issue #4, items 1 and 2) ─────────────────
   * The board's half: whether a host has a dialog at all, the ask, where the
   * dialog has got to, and the rule that survives all of it — a take is only
   * ever for a folder the host has named. What the host does with the ask is
   * the host suite's. */
  console.log('\nthe host\'s own folder dialog');
  const dialogAsk = (body) => fetch(`${HOST}/api/floor/pick`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const dialogAt = () => fetch(`${HOST}/api/floor/pick?host_id=h-open`).then((r) => r.json());
  const hostOpen = async () => (await folders()).hosts.find((h) => h.host_id === 'h-open');
  eq((await hostOpen())?.dialog, false, 'a host that has not said it can show a folder dialog is taken not to have one — the page lists its folders itself');
  rr = await dialogAsk({ host_id: 'h-open' });
  eq([rr.status, (await rr.json()).code], [409, 'no_dialog'], 'and it is not asked for one');
  eq(await takeWork(), [], 'nothing is queued for it');
  await registerWith({ roots: ['/repo'], folders: offered, dialog: 'yes' });
  eq((await hostOpen())?.dialog, false, 'only a plain true counts as saying so');
  await registerWith({ roots: ['/repo'], folders: offered, dialog: true });
  eq((await hostOpen())?.dialog, true, 'a host that says it can is served as one that can — the flag crosses registration to the dialog');
  eq((await dialogAt()).at, null, 'before a dialog has been asked for there is nothing to read — not a stale answer');
  rr = await dialogAsk({ host_id: 'nobody' });
  eq((await rr.json()).code, 'no_host', 'a host the board does not have cannot be asked');
  rr = await dialogAsk({ host_id: 'h-open', start: 'relative/nonsense' });
  eq([rr.status, (await rr.json()).code], [400, 'bad_path'], 'nor can a dialog be started somewhere that is not an absolute path');
  eq(await takeWork(), [], 'and neither refusal queued anything');
  rr = await dialogAsk({ host_id: 'h-open', start: '/repo/last-place' });
  eq(rr.status, 200, 'the floor can ask a host to open its folder dialog');
  let pickWork = await takeWorkFull();
  eq(pickWork.map((w) => `${w.kind}:${w.payload.start}`), ['pick:/repo/last-place'], 'the host is handed the ask, with where to open: the folder the last choice was made in');
  assert(Number.isInteger(pickWork[0]?.waited_ms) && pickWork[0].waited_ms >= 0 && pickWork[0].waited_ms < 5000,
    `stamped with how long it waited on the board, by the board's own clock — ${pickWork[0]?.waited_ms}ms — which is how a host knows a request nobody is waiting for any more`);
  await dialogAsk({ host_id: 'h-open' });
  pickWork = await takeWorkFull();
  eq(pickWork.map((w) => `${w.kind}:${w.payload.start}`), ['pick:null'], 'with nothing remembered there is no start, and the host opens at home');

  const OPENED = '2026-10-01T02:03:04.000Z';
  eq((await hostEvents([{ type: 'pick', state: 'open', at: OPENED, start: '/repo' }])).applied, 1, 'the host says the dialog is open');
  let pk = await dialogAt();
  eq([pk.at, pk.state, pk.start, pk.path], [OPENED, 'open', '/repo', null], 'which the page reads, with the host\'s time on it — from here it waits for the person, not a clock');
  eq((await hostEvents([{ type: 'pick', state: 'thinking', at: '2026-10-01T02:03:05.000Z' }, { type: 'pick', state: 'chosen', at: '2026-10-01T02:03:06.000Z' }])).applied, 0,
    'a state the board does not know, and a choice with no folder, are not taken');
  eq((await dialogAt()).at, OPENED, 'and leave what the page reads as it was');
  const CHOSEN = '2026-10-01T02:03:09.000Z';
  eq((await hostEvents([
    { type: 'browse', requested: '/elsewhere/picked', path: '/elsewhere/picked', root: '/', parent: '/elsewhere', at: CHOSEN,
      self: { path: '/elsewhere/picked', name: 'picked', depth: 2, bound: null, has_mcp_json: false, other_board: null, trusted: false, git: true, last_active: null, sessions: 0 }, entries: [] },
    { type: 'pick', state: 'chosen', at: CHOSEN, start: '/repo', path: '/elsewhere/picked', parent: '/elsewhere' },
  ])).applied, 2, 'a choice arrives as the host\'s listing of the folder, then the word that it was chosen');
  pk = await dialogAt();
  eq([pk.state, pk.path, pk.parent], ['chosen', '/elsewhere/picked', '/elsewhere'], 'the page reads the folder chosen, and the folder it sits in — where the next dialog will open');
  eq((await browsed('/elsewhere/picked')).self?.name, 'picked', 'and reads the host\'s record of that folder from the same place a listed one comes from');
  rr = await take({ host_id: 'h-open', path: '/elsewhere/picked', channel: CH, agent: 'picked-one' });
  eq([rr.status, (await rr.json()).mode], [200, 'take'], 'so a folder the dialog returned can be taken — outside the roots, never in the flat list, but named by the host');
  eq((await takeWorkFull()).map((w) => `${w.kind}:${w.payload.path}`), ['bind:/elsewhere/picked'], 'and the host is handed the bind');
  rr = await take({ host_id: 'h-open', path: '/elsewhere/remembered-only', channel: CH, agent: 'ghost' });
  eq((await rr.json()).code, 'unknown_folder', 'while a path the host has not named is refused as before, whatever a dialog or a memory says');
  eq((await hostEvents([{ type: 'pick', state: 'cancelled', at: '2026-10-01T02:04:00.000Z', start: '/repo', why: 'left open for 600s' }])).applied, 1, 'a dialog closed without a choice is said as that');
  pk = await dialogAt();
  eq([pk.state, pk.why, pk.path], ['cancelled', 'left open for 600s', null], 'with why, when the host closed it itself, and no folder');
  eq((await hostEvents([{ type: 'pick', state: 'failed', at: '2026-10-01T02:05:00.000Z', start: '/repo', error: 'the folder dialog ended with exit code 1: no screen' }])).applied, 1, 'and one that failed says so');
  pk = await dialogAt();
  eq([pk.state, pk.error], ['failed', 'the folder dialog ended with exit code 1: no screen'], 'in the host\'s own words, for the page to show');
  await registerWith({ roots: ['/repo'], folders: offered });

  /* ── what the take-a-desk dialog reads rather than asks for (issue #4) ──────
   * Two things: the agent's saved name, and the folders opened most recently.
   * The server's half is `names` on the folders response; the page's half is
   * three small functions in src/ui/app.js, lifted out by their section
   * comments the way test/markdown.mjs lifts the renderer — app.js is a
   * browser script with no exports. If the slice fails, the section moved:
   * update the markers, do not route around the test. What the dialog then
   * draws with them is measured on the real page (verify-ui-change). */
  console.log('\nthe name a desk already carries, read rather than typed');
  const persona = (body) => fetch(`${HOST}/api/floor/persona`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  eq((await persona({ channel: CH, agent: 'alpha', persona: 'Alpha Prime' })).status, 200, 'an operator saves a name for an agent');
  const named = (await folders()).names;
  eq(named?.alpha, 'Alpha Prime', 'the folders response carries the saved name, by agent id — the dialog shows it instead of asking');
  eq(named?.fresh, 'Fresh Face', 'whichever way it was saved');
  const gammaDesk = deskOf(await floor(), 'gamma');
  assert(typeof gammaDesk?.persona === 'string' && gammaDesk.persona.length > 0, `an agent nobody has named still has a name on its desk, derived from its id — ${gammaDesk?.persona}`);
  eq(Object.hasOwn(named ?? {}, 'gamma'), false, 'but it is not served as a saved name: nothing is saved, and the dialog says "none"');
  rr = await take({ host_id: 'h-open', path: '/repo/zeta-newest', channel: CH, agent: 'fresh' });
  eq(rr.status, 200, 'a take that sends no name is accepted');
  await takeWork();
  eq((await folders()).names?.fresh, 'Fresh Face', 'and leaves the saved name exactly as it was');

  const lifted = await (async () => {
    const src = readFileSync('src/ui/app.js', 'utf8');
    const a = src.indexOf('/* ---------- take a desk: what the dialog reads ---------- */');
    const b = src.indexOf('/* ---------- take a desk: the dialog ---------- */');
    if (a < 0 || b < 0 || b < a) throw new Error('the take-a-desk section was not found in src/ui/app.js between its two section comments');
    const tmp = `./data/desk-dialog-${process.pid}.mjs`;
    writeFileSync(tmp, `${src.slice(a, b)}\nexport { savedName, recentFolders, takeBody, RECENT_MAX, rememberedDir, rememberDir };\n`);
    try { return await import(new URL(tmp, `file://${process.cwd()}/`)); } finally { rmSync(tmp, { force: true }); }
  })();
  const { savedName, recentFolders, takeBody, RECENT_MAX, rememberedDir, rememberDir } = lifted;
  eq(savedName(named, 'alpha'), 'Alpha Prime', 'the dialog reads an agent\'s saved name from that map');
  eq(savedName(named, '  alpha '), 'Alpha Prime', 'whatever space was typed around the id');
  eq(savedName(named, 'gamma'), null, 'and reads none for an agent with nothing saved — drawn as "none"');
  eq([savedName(named, ''), savedName(null, 'alpha'), savedName({ alpha: '   ' }, 'alpha'), savedName(named, 'constructor')], [null, null, null, null],
    'no id, no map, a blank name and a name that is only an object\'s own plumbing are all none');
  eq(takeBody({ hostId: 'h-open', path: '/repo/zeta-newest', channel: CH, newChannel: '', agent: ' fresh ', persona: 'Typed Name' }),
    { host_id: 'h-open', path: '/repo/zeta-newest', channel: CH, agent: 'fresh', open: true },
    'what the dialog sends on a take names the host, the folder, the floor and the agent — and no name, even if a form somehow held one');
  eq(takeBody({ hostId: 'h-open', path: '/repo/x', channel: '__new__', newChannel: ' brand-new ', agent: 'x' }).channel, 'brand-new', 'a new floor is sent by the name typed for it');

  console.log('\nrecently opened');
  const hostList = (await folders()).hosts.find((h) => h.host_id === 'h-open')?.folders ?? [];
  eq(recentFolders(hostList).map((f) => f.name), ['zeta-newest', 'alpha-older'],
    'the dialog offers the folders Claude Code has been run in, newest first — not one never opened, and not one bound to another board');
  eq(recentFolders(hostList)[1].bound?.agent, 'alpha', 'each still carrying the host\'s record of it, which is what says it is already a desk');
  const many = Array.from({ length: 40 }, (_, i) => ({ path: `/repo/r${i}`, name: `r${i}`, last_active: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), other_board: null }));
  eq(RECENT_MAX, 5, 'a recent list is short');
  eq(recentFolders(many).map((f) => f.name), ['r39', 'r38', 'r37', 'r36', 'r35'], 'five of forty, the newest five, whatever order they arrived in');
  eq(recentFolders([...many].reverse()).map((f) => f.name), ['r39', 'r38', 'r37', 'r36', 'r35'], 'the same five from the same list reversed');
  eq(recentFolders([
    { path: '/repo/never', name: 'never', last_active: null, other_board: null },
    { path: '/repo/once', name: 'once', last_active: '2026-09-30T00:00:00.000Z', other_board: null },
  ]).map((f) => f.name), ['once'], 'a folder Claude Code has never been run in is not recent, wherever it sits in the host\'s list');
  eq(recentFolders([{ path: '/repo/elsewhere', name: 'elsewhere', last_active: '2026-09-30T00:00:00.000Z', other_board: 'http://10.0.0.9:8787' }]), [],
    'a folder bound to another board is not offered, however recent — it could only be refused');
  eq([recentFolders(undefined), recentFolders([]), recentFolders([{ name: 'no-path', last_active: '2026-09-30T00:00:00.000Z' }])], [[], [], []],
    'no list, an empty list and a folder with no path are all nothing to offer');

  console.log('\nwhat a session row says under its title');
  const sessLift = await (async () => {
    const src = readFileSync('src/ui/app.js', 'utf8');
    const a = src.indexOf('/* ---------- sessions: what a row says ---------- */');
    const b = src.indexOf('/* ---------- sessions: the dialog ---------- */');
    if (a < 0 || b < 0 || b < a) throw new Error('the session-row section was not found in src/ui/app.js between its two section comments');
    const tmp = `./data/session-row-${process.pid}.mjs`;
    writeFileSync(tmp, `${src.slice(a, b)}\nexport { spanText, sessionDetail };\n`);
    try { return await import(new URL(tmp, `file://${process.cwd()}/`)); } finally { rmSync(tmp, { force: true }); }
  })();
  const { spanText, sessionDetail } = sessLift;
  {
    // JavaScript accepts a `case` label written twice and runs only the first,
    // so a second copy of a handler is dead code nothing reports: the three
    // session cases were in the click handler twice (issue #8, "Also").
    const src = readFileSync('src/ui/app.js', 'utf8');
    const count = (label) => src.split(`case '${label}':`).length - 1;
    eq([count('session-resume'), count('session-new'), count('session-look')], [1, 1, 1], 'each of the picker\'s three actions is handled in one place — a duplicated case is unreachable, and silently so');
  }
  eq(sessionDetail(gotList.rows[0]), ['1h long', 'feature/alpha', 'claude-test-7'], 'how long it ran, its branch, its model — in that order, from the row the board served');
  eq(sessionDetail(gotList.rows[1]), [], 'and nothing at all for a row with none of the three — no line of dashes');
  eq(sessionDetail({ started_at: '2026-09-09T10:00:00Z', last_at: '2026-09-09T10:00:00Z', branch: ' ', model: 'claude-x' }), ['under a minute long', 'claude-x'], 'each part only when there is one');
  eq([spanText('2026-09-09T10:00:00Z', '2026-09-09T10:00:59Z'), spanText('2026-09-09T10:00:00Z', '2026-09-09T10:14:30Z'), spanText('2026-09-09T10:00:00Z', '2026-09-09T12:14:00Z'), spanText('2026-09-09T10:00:00Z', '2026-09-09T12:00:00Z')],
    ['under a minute', '14m', '2h 14m', '2h'], 'a length reads as minutes, then hours and minutes');
  eq([spanText('2026-09-09T10:00:00Z', '2026-09-11T09:59:00Z'), spanText('2026-09-09T10:00:00Z', '2026-09-12T14:00:00Z'), spanText('2026-09-09T10:00:00Z', '2026-09-12T10:30:00Z')],
    ['47h 59m', '3d 4h', '3d'], 'and past two days as days and hours — wall-clock, because a conversation picked up the next morning is a day long');
  eq([spanText(null, '2026-09-09T10:00:00Z'), spanText('2026-09-09T10:00:00Z', null), spanText('nonsense', 'more'), spanText('2026-09-09T11:00:00Z', '2026-09-09T10:00:00Z')],
    [null, null, null, null], 'no start, no end, times that are not times, and an end before its start are no length at all');

  console.log('\nwhat the History dialog says about its answer');
  const histLift = await (async () => {
    const src = readFileSync('src/ui/app.js', 'utf8');
    const a = src.indexOf('/* ---------- history: what the dialog says about its answer ---------- */');
    const b = src.indexOf('/* ---------- history: the dialog ---------- */');
    if (a < 0 || b < 0 || b < a) throw new Error('the history section was not found in src/ui/app.js between its two section comments');
    const tmp = `./data/history-${process.pid}.mjs`;
    writeFileSync(tmp, `${src.slice(a, b)}\nexport { coverageText, hitsText, markHits };\n`);
    try { return await import(new URL(tmp, `file://${process.cwd()}/`)); } finally { rmSync(tmp, { force: true }); }
  })();
  const { coverageText, hitsText, markHits } = histLift;
  const H1 = { name: 'alpha', live: true, asked: true, at: '2026-10-01T00:00:00Z', error: null, files: 104, ms: 2700 };
  eq(coverageText([H1]), ['from alpha'], 'a recent list says which host it is from');
  eq(coverageText([H1], 'search'), ['alpha read 104 conversations in 2.7 s'], 'a search says how much that host read, and how long it took');
  eq(coverageText([{ ...H1, files: 1, ms: 40 }], 'search'), ['alpha read 1 conversation in 0.0 s'], 'one conversation is one conversation');
  eq(coverageText([H1, { name: 'beta', live: false, asked: false, at: null }]), ['from alpha', 'beta is offline — its conversations are not covered'],
    'a host that is offline is named as not covered — the half of the history this answer does not have');
  eq(coverageText([H1, { name: 'beta', live: false }, { name: 'gamma', live: false }]).at(-1), 'beta, gamma are offline — their conversations are not covered', 'however many of them there are');
  eq(coverageText([{ name: 'alpha', live: true, asked: true, at: null }]), ['waiting for alpha'], 'a host that was asked and has not answered is being waited for');
  eq(coverageText([{ name: 'alpha', live: true, asked: false, at: null }]), ['alpha has not been asked'], 'one that came onto the board after the question has not been asked');
  eq(coverageText([{ name: 'alpha', live: true, asked: true, at: '2026-10-01T00:00:00Z', error: 'the search ended with exit code 1: boom' }], 'search'), ['alpha: the search ended with exit code 1: boom'],
    'and one whose search failed says what it said, instead of counting as an answer');
  eq([coverageText([]), coverageText(null), coverageText(undefined)], [['no host is on this board, and the conversations are on the hosts\' disks'], [], []],
    'a board with no host says so; an answer not read yet says nothing rather than that');
  eq([hitsText(1), hitsText(3), hitsText(0), hitsText('x')], ['1 turn matched', '3 turns matched', '0 turns matched', '0 turns matched'], 'how many turns matched, in words');
  const safe = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  eq(markHits('the Widget Rename and the widget rename', 'widget rename', safe), 'the <mark>Widget Rename</mark> and the <mark>widget rename</mark>', 'every occurrence in a snippet is marked, whatever its case, as it was written');
  eq(markHits('<b>bold</b> widget & <script>', 'widget', safe), '&lt;b&gt;bold&lt;/b&gt; <mark>widget</mark> &amp; &lt;script&gt;', 'and what is around it is drawn as the characters it is — a snippet is somebody\'s pasted text');
  eq(markHits('a <mark> in the text', '<mark>', safe), 'a <mark>&lt;mark&gt;</mark> in the text', 'even when the thing searched for is markup');
  eq([markHits('nothing to mark', '', safe), markHits('nothing to mark', 'zzz', safe), markHits(null, 'x', safe)], ['nothing to mark', 'nothing to mark', ''], 'no search, no match and no text are left as they are');

  console.log('\nwhere the folder dialog opens: the last place a choice was made');
  const browserStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, m }; };
  const st = browserStore();
  eq(rememberedDir(st, 'h1'), null, 'a browser that has chosen nothing remembers nothing, and the dialog opens at home');
  rememberDir(st, 'h1', '/Users/me/dev/plugins');
  eq(rememberedDir(st, 'h1'), '/Users/me/dev/plugins', 'after a choice it remembers the folder the choice was made in');
  eq(rememberedDir(st, 'h2'), null, 'per host — a path on one machine means nothing on another');
  rememberDir(st, 'h2', '/home/other/src');
  eq([rememberedDir(st, 'h1'), rememberedDir(st, 'h2')], ['/Users/me/dev/plugins', '/home/other/src'], 'and remembering one host\'s leaves the other\'s alone');
  rememberDir(st, 'h1', '/Users/me/dev/sites');
  eq(rememberedDir(st, 'h1'), '/Users/me/dev/sites', 'the last choice replaces the one before');
  rememberDir(st, 'h1', null); rememberDir(st, 'h1', 'relative/path'); rememberDir(st, '', '/x');
  eq([rememberedDir(st, 'h1'), [...st.m.keys()]], ['/Users/me/dev/sites', ['orch.desk.dir']], 'no folder, a path that is not absolute and no host are not choices — nothing is overwritten, nothing else is written');
  st.m.set('orch.desk.dir', 'not json at all');
  eq(rememberedDir(st, 'h1'), null, 'a store holding something else is no memory at all');
  rememberDir(st, 'h1', '/Users/me/dev/again');
  eq(rememberedDir(st, 'h1'), '/Users/me/dev/again', 'and is written over by the next choice');
  st.m.set('orch.desk.dir', JSON.stringify({ h1: 'not/absolute', h2: 42 }));
  eq([rememberedDir(st, 'h1'), rememberedDir(st, 'h2')], [null, null], 'nor is a remembered value that is not an absolute path ever sent as a start');
  const deadStore = { getItem: () => { throw new Error('storage is off'); }, setItem: () => { throw new Error('storage is off'); } };
  let threw = false;
  try { rememberDir(deadStore, 'h1', '/x'); } catch { threw = true; }
  eq([rememberedDir(deadStore, 'h1'), threw], [null, false], 'and a browser with storage turned off simply starts at home each time');

  console.log('\na host that names the conversation it is following');
  // The host's one-time `session` event can be lost to its own startup: the
  // watch loop adopts a session and reports it before the first registration
  // has created the desk row, and applyHostEvent drops an event for a desk it
  // does not know. Nothing re-sends it. The heartbeat carries the id every
  // minute, so registering with one has to be enough on its own.
  await register({ channel: CH, agent: 'nomad', cwd: '/repo/nomad', session_id: 'sdk-nomad-1' });
  f = await floor();
  eq(deskOf(f, 'nomad').hosted.session_id, 'sdk-nomad-1',
     'a desk registered with a session id adopts it — the session event that normally does this may never have landed');
  await hostEvents([{ type: 'turn', channel: CH, agent: 'nomad', role: 'assistant', text: 'relayed under the real id' }]);
  {
    const scoped = await fetch(`${HOST}/api/floor/turns?channel=${CH}&agent=nomad&session=sdk-nomad-1`).then((r) => r.json());
    eq(scoped.rows.map((t) => t.text), ['relayed under the real id'],
       'so the turns the host relays are the turns the chat panel is scoped to — the empty-panel failure this closes');
  }
  const reregistered = await register({ channel: CH, agent: 'nomad', cwd: '/repo/nomad' }).then((r) => r.json());
  eq(reregistered.desks.find((d) => d.agent === 'nomad').sdk_session_id, 'sdk-nomad-1',
     'a host that names no session (it just restarted) does not blank the stored one, and is handed it back');

  /* A message the desk took while it was working.
   *
   * The window queues it and reads it at its next step, so for a few seconds it
   * exists without being a turn. The note is what the composer says "queued"
   * from, and the only thing that matters about it is that it goes away again —
   * a note that stands for ever is the "not recorded — send again" lie in a
   * nicer font.
   *
   * Both orders are tested because both happen. Two loops run in the host and
   * neither waits for the other: the relay reads the transcript every 700ms and
   * the work loop delivers, so the turn genuinely can arrive first. It did, on
   * the real board, and the note it left behind outlived the run that made it.
   */
  console.log('\na message queued behind a running turn');
  const noteOn = async (agent) => deskOf(await floor(), agent)?.delivery ?? null;
  const QUEUED = 'have a look at the auth path while you are in there';

  await register({ channel: CH, agent: 'queueing', cwd: '/repo/queueing', window: '@11' });
  await hostEvents([{ type: 'session', channel: CH, agent: 'queueing', session_id: 's-queue', cwd: '/repo/queueing' }]);

  await hostEvents([{ type: 'delivery', channel: CH, agent: 'queueing', state: 'queued', text: QUEUED }]);
  eq((await noteOn('queueing'))?.state, 'queued', 'the desk says the window is holding the message');
  eq((await noteOn('queueing'))?.text, QUEUED, 'and which message it is holding');

  await hostEvents([{ type: 'turn', channel: CH, agent: 'queueing', role: 'user', text: QUEUED }]);
  eq(await noteOn('queueing'), null, 'and stops saying so once it becomes a turn');

  // The other order: the turn is already in the conversation when the host gets
  // round to reporting the delivery. Nothing should be put back.
  await register({ channel: CH, agent: 'racer', cwd: '/repo/racer', window: '@12' });
  await hostEvents([{ type: 'session', channel: CH, agent: 'racer', session_id: 's-race', cwd: '/repo/racer' }]);
  await hostEvents([{ type: 'turn', channel: CH, agent: 'racer', role: 'user', text: QUEUED }]);
  await hostEvents([{ type: 'delivery', channel: CH, agent: 'racer', state: 'queued', text: QUEUED }]);
  eq(await noteOn('racer'), null,
     'a delivery reported after its own turn leaves no note — the message is already in the conversation');

  // A different message is not that one. Without this the note would be retired
  // by whatever the desk happened to say next.
  await hostEvents([{ type: 'delivery', channel: CH, agent: 'racer', state: 'queued', text: 'and this one is still waiting' }]);
  await hostEvents([{ type: 'turn', channel: CH, agent: 'racer', role: 'assistant', text: 'working on it' }]);
  eq((await noteOn('racer'))?.text, 'and this one is still waiting',
     "another turn does not retire a queued message that is still queued");

  // Injected context the host split off a user record. It must land as its own
  // role with the tag as its label — not be dropped by the unknown-role guard,
  // and not retire a queued note the way a person's turn does.
  const CTX = '<ide_opened_file>opened src/db.js</ide_opened_file>';
  await hostEvents([{ type: 'turn', channel: CH, agent: 'racer', role: 'context', text: CTX, tool_name: 'ide_opened_file' }]);
  const ctxRows = (await turns('racer')).rows ?? [];
  const ctxRow = ctxRows.find((r) => r.role === 'context');
  eq(ctxRow?.text, CTX, 'a context turn arrives with its text intact');
  eq(ctxRow?.tool_name, 'ide_opened_file', 'and carries its tag as the label');
  eq((await noteOn('racer'))?.text, 'and this one is still waiting',
     'and a context turn retires no queued note — only the person becoming a turn does that');

  // A repeat. The desk's last user turn already says the same words — the
  // operator nudged earlier and is nudging again — but that turn is from
  // BEFORE this send, so it is not this message arriving. Matching on the
  // words alone dropped the note here every time, and "nudge" is the most
  // repeated message on the board.
  await register({ channel: CH, agent: 'repeater', cwd: '/repo/repeater', window: '@13' });
  await hostEvents([{ type: 'session', channel: CH, agent: 'repeater', session_id: 's-repeat', cwd: '/repo/repeater' }]);
  await hostEvents([{ type: 'turn', channel: CH, agent: 'repeater', role: 'user', text: 'nudge' }]);
  const again = await fetch(`${HOST}/api/floor/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: CH, agent: 'repeater', text: 'nudge' }),
  });
  eq(again.status, 200, 'the second nudge is accepted');
  eq(await takeWork(), ['chat'], 'and queued for the host');
  await hostEvents([{ type: 'delivery', channel: CH, agent: 'repeater', state: 'queued', text: 'nudge' }]);
  eq((await noteOn('repeater'))?.text, 'nudge',
     'a delivery matching a turn from before the send is not that turn arriving — the note stands');
  await hostEvents([{ type: 'turn', channel: CH, agent: 'repeater', role: 'user', text: 'nudge' }]);
  eq(await noteOn('repeater'), null, 'and the turn recorded after the send retires it');

  console.log('\nstopping a turn');
  // End to end this time, because the interesting part is that the endpoint and
  // the sign refuse on the same facts. The desk is driven into `working` by a
  // real hook event rather than a SQL touch, so the state under test is the one
  // the floor actually gets.
  const askStop = (agent) =>
    fetch(`${HOST}/api/floor/interrupt`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: CH, agent }),
    });

  await register({ channel: CH, agent: 'runner', cwd: '/repo/runner', window: '@9' });
  await post(ev('runner', 's-run', 'SessionStart'));
  let refused = await askStop('runner');
  eq(refused.status, 409, 'an idle desk cannot be stopped');
  eq((await refused.json()).code, 'not_working', 'and is told there is nothing running, not that it went wrong');
  eq(await takeWork(), [], 'a refused stop queues nothing');

  await post(ev('runner', 's-run', 'UserPromptSubmit', { message: 'go' }));
  let stopped = await askStop('runner');
  eq(stopped.status, 200, 'a working desk can be stopped');
  eq(await takeWork(), ['interrupt'], 'and the host is handed exactly that work');

  // The chat panel draws its stop sign from the same verdict, so the payload has
  // to carry it — a live-looking sign over a refusing endpoint is the drift this
  // pairing exists to prevent.
  let f2 = await floor();
  eq(deskOf(f2, 'runner').working, true, 'the desk says it is working');
  eq(deskOf(f2, 'runner').stop.ok, true, 'and that its stop sign is live');

  await post(ev('runner', 's-run', 'Stop', { last_assistant_message: 'done' }));
  f2 = await floor();
  eq(deskOf(f2, 'runner').working, false, 'when the turn ends the desk says so');
  eq(deskOf(f2, 'runner').stop.ok, false, 'and the sign dims with it');
  eq(deskOf(f2, 'runner').stop.code, 'not_working', 'carrying the reason the endpoint would give');

  console.log('\none prompt, one clock');
  // A prompt announces itself twice under two names, six seconds apart. Counted
  // as two waits the clock restarted, so every prompt's age read six seconds
  // short — which matters because the age is what tells an operator a prompt
  // has been sitting there.
  await register({ channel: CH, agent: 'ticker', cwd: '/repo/ticker', window: '@41' });
  await hostEvents([{ type: 'session', channel: CH, agent: 'ticker', session_id: 's-tick', cwd: '/repo/ticker' }]);
  await post(ev('ticker', 's-tick', 'SessionStart'));
  // A question is summarised by its words. The hook carries them since
  // 2026-09-11; before that the desk drew the choices under "AskUserQuestion".
  await post(ev('asker', 's-ask', 'PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which scope should step one audit?', header: 'Scope', options: [{ label: 'Baseline only' }] }] } }));
  const askDesk = deskOf(await floor(), 'asker');
  eq(askDesk?.permission?.summary, 'Scope: Which scope should step one audit?', 'a question\'s prompt is summarised by its header and words, not the tool\'s name');
  eq(askDesk?.session?.awaiting_message, 'Scope: Which scope should step one audit?', 'and the desk\'s awaiting line says the same');
  await post(ev('ticker', 's-tick', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'git push' } }));
  let ft = await floor();
  const startedAt = deskOf(ft, 'ticker').session.awaiting_since;
  assert(!!startedAt, 'the wait has a start');

  await sleep(1100);
  await post(ev('ticker', 's-tick', 'Notification', { notification_type: 'permission_prompt', notification_message: 'still waiting' }));
  ft = await floor();
  eq(deskOf(ft, 'ticker').session.awaiting_kind, 'permission_prompt', 'the second announcement changes what it is called');
  eq(deskOf(ft, 'ticker').session.awaiting_since, startedAt, 'but not when it started — it is the same wait under another name');

  // A genuinely different wait still starts its own clock.
  await post(ev('ticker', 's-tick', 'StopFailure', { error_message: 'the turn died' }));
  ft = await floor();
  eq(deskOf(ft, 'ticker').session.awaiting_kind, 'error', 'a different kind of wait is a different kind');
  assert(deskOf(ft, 'ticker').session.awaiting_since !== startedAt, 'and starts its own clock');
  await takeWork();

  console.log('\na prompt announced only by the notification is still answerable');
  // The state an operator got stuck in: the window was holding a permission
  // question, the floor knew it, and the alert had no summary and no buttons —
  // so the desk read as stuck with nothing on screen to do about it, while every
  // message sent to that window bounced off the standing prompt.
  //
  // Two independent hooks announce a prompt. Only the second one arrived.
  await register({ channel: CH, agent: 'halfheard', cwd: '/repo/halfheard', window: '@21' });
  await hostEvents([{ type: 'session', channel: CH, agent: 'halfheard', session_id: 's-half', cwd: '/repo/halfheard' }]);
  await post(ev('halfheard', 's-half', 'SessionStart'));
  await post(ev('halfheard', 's-half', 'Notification', { notification_type: 'permission_prompt', notification_message: 'needs permission to run: git push' }));

  let fh = await floor();
  const half = () => deskOf(fh, 'halfheard');
  eq(half().session.awaiting_kind, 'permission_prompt', 'the desk knows it is being asked');
  assert(!!half().permission?.request_id, 'and has something to answer with, though no PermissionRequest ever arrived');
  eq(half().permission.summary, 'needs permission to run: git push', 'saying what the window said');

  const halfAnswer = await fetch(`${HOST}/api/floor/permission`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: CH, agent: 'halfheard', request_id: half().permission.request_id, decision: 'allow' }),
  });
  eq(halfAnswer.status, 200, 'and the answer is accepted like any other');
  eq(await takeWork(), ['prompt', 'permission'],
     'reaching the host as a keystroke — behind the request to go and read what the window is offering');
  fh = await floor();
  eq(half().session.awaiting_kind, null, 'the desk stops asking');

  // A notification that carries no words still has to say something. On a desk
  // of its own: after an answer, a notification on the same desk is an echo and
  // is deliberately ignored, which is the next thing tested below.
  await register({ channel: CH, agent: 'wordless', cwd: '/repo/wordless', window: '@23' });
  await hostEvents([{ type: 'session', channel: CH, agent: 'wordless', session_id: 's-word', cwd: '/repo/wordless' }]);
  await post(ev('wordless', 's-word', 'SessionStart'));
  await post(ev('wordless', 's-word', 'Notification', { notification_type: 'permission_prompt' }));
  fh = await floor();
  assert(!!deskOf(fh, 'wordless').permission?.summary,
    'a notification with no message still gives the operator a sentence, not an empty dash');
  await takeWork();

  // The echo. Claude Code announces one prompt twice, about six seconds apart,
  // and answering promptly means the second announcement lands after the answer.
  // Treated as new it rebuilt the prompt that had just been dealt with, and the
  // operator clicked a ghost.
  await post(ev('halfheard', 's-half', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'git push' } }));
  await takeWork();
  fh = await floor();
  await fetch(`${HOST}/api/floor/permission`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: CH, agent: 'halfheard', request_id: half().permission.request_id, decision: 'allow' }),
  });
  await takeWork();   // the keystroke this answer queued; this block is about what comes after
  fh = await floor();
  eq(half().session.awaiting_kind, null, 'answered, so the desk is clear');
  await post(ev('halfheard', 's-half', 'Notification', { notification_type: 'permission_prompt', notification_message: 'needs permission to run: git push' }));
  fh = await floor();
  eq(half().session.awaiting_kind, null, 'and the late notification for it does not raise the desk again');
  eq(half().permission, null, 'nor rebuild the prompt that was just answered');
  eq(await takeWork(), [], 'and it asks the host for nothing');


  console.log('\nturning a filled-in form into keystrokes');
  {
    // Every mechanic below was measured on a real AskUserQuestion, and two are
    // the opposite of the obvious guess. On a single-select a digit only moves
    // the cursor and Enter selects; on a multi-select a digit toggles the box
    // outright and Enter would toggle whatever the cursor sits on instead.
    const single = { kind: 'single', question: 'Which one?', options: [{ n: 1, text: 'Alpha' }, { n: 2, text: 'Bravo' }] };
    const multi = {
      kind: 'multi', question: 'Which ones?',
      options: [{ n: 1, text: 'Red' }, { n: 2, text: 'Green' }, { n: 3, text: 'Type something', other: true }],
    };
    const keys = (st) => st.map((x) => x.key ?? `text:${x.text}`);

    const one = answerSteps([single], [{ choose: [2] }]);
    assert(keys(one).slice(0, 2).every((k) => k === 'Left'), 'it walks to a known end first, because which tab is showing is only marked in colour');
    assert(keys(one).includes('2'), 'the choice is pressed by the window\u2019s own number');
    // One key, not two. Recorded off a real form: the digit selects and the tab
    // advances by itself, so an Enter after it answers the *next* question with
    // whatever is highlighted there — always its first option. That silently
    // overwrote the operator's choice on every tab after the first.
    assert(!keys(one).includes('Enter'), 'and nothing follows it — the digit selects, it does not merely move the cursor');

    // A one-question form has no strip: Left and Tab do nothing there, and the
    // digit both selects and submits (measured 2026-09-03). So the whole answer
    // is the one key, and nothing walks first.
    const alone = answerSteps([{ ...single, strip: false }], [{ choose: [2] }]);
    eq(keys(alone), ['2'], 'a form with no tab strip is answered with the digit alone — no walk to a known end, nothing after');

    const many = answerSteps([multi], [{ choose: [1, 2] }]);
    const body = keys(many).filter((k) => k !== 'Left');
    eq(body.slice(0, 3), ['1', '2', 'Tab'], 'a multi-select presses each box by number and moves on with Tab, never Enter');

    const typed = keys(answerSteps([multi], [{ choose: [3], text: 'something else entirely' }]));
    assert(typed.includes('text:something else entirely'), 'the free-text choice is followed by the words to type');
    assert(typed.indexOf('3') < typed.indexOf('text:something else entirely'),
      'after selecting it, not before — the field does not exist until the box is ticked');
    // Measured the hard way: a digit ticks the box without moving the cursor, so
    // the field opens under a cursor that is somewhere else and the words go
    // wherever it is. It has to be stood on first, and where it is cannot be
    // read, so it is normalised — up to the top, then down a counted number.
    const stand = typed.slice(typed.indexOf('3') + 1, typed.indexOf('text:something else entirely'));
    assert(stand.length > 0, 'the cursor is moved onto the free-text row before anything is typed');
    assert(stand.filter((k) => k === 'Up').length >= 3, 'walked to the top first, because where the cursor sits cannot be read');
    eq(stand.filter((k) => k === 'Down').length, 2, 'then down to that row — the third of three');

    // Typing into a multi-select's field is not finished by moving on. The field
    // keeps focus and the row grows a "Next" under it, so Tab there is a
    // character rather than navigation — recorded as the whole sequence playing
    // out with the form still on tab one and every later tab unreached.
    eq(typed.slice(-2), ['Down', 'Enter'], 'a multi-select with typed words is walked off the field onto "Next"');
    assert(!typed.slice(typed.indexOf('text:something else entirely')).includes('Tab'),
      'and never Tab, which the focused field swallows along with Enter');
    const plainMulti = keys(answerSteps([multi], [{ choose: [1] }]));
    eq(plainMulti.slice(-1), ['Tab'], 'while a multi-select with nothing typed still moves on with Tab');

    // Nothing typed means nothing to stand on.
    const plain = keys(answerSteps([multi], [{ choose: [1] }]));
    assert(!plain.includes('Up') && !plain.includes('Down'), 'a choice with no free text moves no cursor at all');
    // Text without its box ticked is not typed into a field that never opened.
    const orphan = keys(answerSteps([multi], [{ choose: [1], text: 'stray' }]));
    assert(!orphan.some((k) => k.startsWith('text:')), 'and text is dropped unless the choice that opens the field was chosen');

    // Submitting is NOT walked to. Recorded off a real window: answering the last
    // question advances to Submit on its own and the review screen opens with
    // "1. Submit answers" already under the cursor. The walk that used to follow
    // started from there instead of arriving, and an odd number of Tabs on a
    // two-entry screen lands on "2. Cancel" — so the Enter meant to submit threw
    // every answer away. "User declined to answer questions", one frame after
    // "Ready to submit your answers?".
    const end = answerSteps([single, multi], [{ choose: [1] }, { choose: [2] }]);
    assert(!end.some((st) => st.key === 'Tab' && st.final), 'nothing is walked to Submit after the last answer');
    eq(keys(end).slice(-1), ['Tab'], 'the sequence ends where the last question left it — a multi moves on with Tab');
    const endSingles = answerSteps([single, single], [{ choose: [1] }, { choose: [2] }]);
    eq(keys(endSingles).slice(-2), ['1', '2'], 'and a run of single-selects is one key each, in order');
    assert(!keys(endSingles).slice(3).includes('Tab'),
      'with no blind tab walk behind it — that walk is what pressed Cancel');

    // A form with a question unanswered has no keys at all — issue #7, item 1.
    //
    // This used to assert the opposite: a blank was "stepped past" with a bare
    // Tab. Measured on 2.1.284, that Tab half-sends the form — `Left Left Left
    // Tab 2` submitted with one answer and the host logged it as answered.
    // costmo's ruling (2026-10-01): never submitted, Submit moves to the first
    // unanswered question instead.
    eq(keys(answerSteps([single, multi], [{}, { choose: [1] }])), [],
      'a form whose first question is unanswered produces no keys \u2014 not a Tab past it');
    eq(keys(answerSteps([single, single], [{ choose: [1] }, {}])), [],
      'nor one whose last question is \u2014 the Tab that used to stand in for it is what half-sent the form');
    eq(keys(answerSteps([single, single], [{ choose: [1] }])), [],
      'nor one with fewer answers than questions');
    eq(unansweredOf([single, multi, single], [{}, { choose: [1] }, { choose: [] }]), [0, 2],
      'unansweredOf names every question without an answer, by index');
    eq(unansweredOf([single, multi], [{ choose: [2] }, { choose: [1, 2] }]), [],
      'and none when each has one');

    // A number the window never offered is dropped rather than pressed — and a
    // question answered only by such a number has no answer.
    const bogus = keys(answerSteps([single], [{ choose: [9] }]));
    assert(!bogus.includes('9'), 'a choice the window does not have is never pressed');
    eq(unansweredOf([single], [{ choose: [9] }]), [0], 'and choosing only that leaves the question unanswered');

    // The free-text row on a single-select is not a fourth answer. Taking it
    // withdraws the whole form and sends the words back as a clarification,
    // which is a different event with a different sequence — and getting it
    // wrong is what produced "the window stopped asking after 13 of 20 steps"
    // twice, with the operator's words landing nowhere.
    const singleFree = {
      kind: 'single', question: 'Which one?',
      options: [{ n: 1, text: 'Alpha' }, { n: 2, text: 'Bravo' }, { n: 3, text: 'Type something.', other: true }],
    };
    const clar = answerSteps([singleFree, multi], [{ choose: [3], text: 'none of these' }, { choose: [1] }]);
    const ck = keys(clar).filter((k) => k !== 'Left');
    // No field is opened and nothing is typed here. Recorded: the form is on
    // screen with the free-text row under the cursor, and 318ms after the Enter
    // the pane reads "User declined to answer questions" above a composer. The
    // words are sent afterwards, as an ordinary message.
    eq(ck, ['3', 'Enter'], 'the digit stands on the row and Enter withdraws the form — that is all it can do');
    assert(!ck.some((k) => k.startsWith('text:')),
      'the words are not keystrokes in a form that no longer exists by the time they would be typed');
    assert(!ck.includes('Up') && !ck.includes('Down'),
      'and no cursor walk, because on a single-select the digit is what moves the cursor');
    const last = clar[clar.length - 1];
    assert(last.clarify === true, 'the closing Enter is marked as a clarification, not an answer');
    assert(last.final === true, 'and final, because the form being gone afterwards is the success');
    eq(clar.filter((st) => st.clarify).length, 1, 'exactly one step ends the form');

    // Nothing can follow it: the form is withdrawn, so the second question is
    // never reached and there is no Submit tab left to confirm on.
    assert(!keys(clar).slice(keys(clar).indexOf('3')).includes('Tab'),
      'no later tab is walked to, because the form is gone');
    eq(clar.length, keys(clar).lastIndexOf('Enter') + 1, 'the sequence stops at the Enter that withdraws the form');

    // A free-text choice with nothing typed is not an answer — issue #7, item 1.
    //
    // This used to assert that the row's digit was pressed as an ordinary
    // answer. Measured on 2.1.284: the digit opens a field, and the next key
    // of the script is typed into it — `4` then `1` left the form standing
    // with "1" in the field, nothing answered, and the host said answered.
    eq(unansweredOf([singleFree], [{ choose: [3] }]), [0],
      'the free-text row ticked with nothing typed leaves a single-select unanswered');
    eq(unansweredOf([singleFree], [{ choose: [3], text: '   ' }]), [0], 'and so do spaces');
    eq(keys(answerSteps([singleFree, multi], [{ choose: [3] }, { choose: [1] }])), [],
      'so its digit is never pressed: the form has no keys');
    eq(unansweredOf([multi], [{ choose: [1, 3] }]), [0],
      'on a multi-select too, whatever else is ticked beside it — the ticked row is not quietly dropped');
    eq(unansweredOf([multi], [{ choose: [1, 3], text: 'and this' }]), [],
      'with words in it, it is an answer');
    eq(unansweredOf([multi], [{ choose: [1], text: 'stray' }]), [],
      'and words without the row ticked do not make an answered question unanswered');

    // The page asks itself the same question before it posts, so Submit can
    // show the tab. Its copy is lifted out of the browser script by its section
    // comments, the way test/markdown.mjs lifts the renderer, and run over the
    // same cases as the server's: the two must not drift. If the slice fails,
    // the section moved — fix the markers, do not route around the test.
    const page = await (async () => {
      const src = readFileSync('src/ui/floor.js', 'utf8');
      const a = src.indexOf('  /* ---------- a question form: what the page decides ---------- */');
      const b = src.indexOf('  /* ---------- a question the window is asking ---------- */');
      if (a < 0 || b < 0 || b < a) throw new Error('the question-form section was not found in src/ui/floor.js between its two section comments');
      const tmp = `./data/ask-form-${process.pid}.mjs`;
      writeFileSync(tmp, `${src.slice(a, b)}\nexport { askUnanswered, askWarnText };\n`);
      try { return await import(new URL(tmp, `file://${process.cwd()}/`)); } finally { rmSync(tmp, { force: true }); }
    })();
    const cases = [
      [[single, multi], [{ choose: [1] }, { choose: [2] }]],
      [[single, multi], [{}, { choose: [1] }]],
      [[single, single], [{ choose: [1] }, {}]],
      [[single, single], [{ choose: [1] }]],
      [[single], [{ choose: [9] }]],
      [[singleFree], [{ choose: [3] }]],
      [[singleFree], [{ choose: [3], text: 'none of these' }]],
      [[multi], [{ choose: [1, 3] }]],
      [[multi], [{ choose: [1, 3], text: 'and this' }]],
      [[multi], [{ choose: [1], text: 'stray' }]],
      [[single, multi, singleFree], []],
      [[], []],
    ];
    eq(cases.map(([q, a]) => page.askUnanswered(q, a)), cases.map(([q, a]) => unansweredOf(q, a)),
      `the page’s askUnanswered and the server’s unansweredOf agree on all ${cases.length} cases`);
    eq(page.askUnanswered([single, multi, singleFree], [{ choose: [1] }, {}, { choose: [3] }]), [1, 2],
      'and the page names the first unanswered question, which is the tab Submit shows');
    eq(page.askWarnText([], 3), null, 'with every question answered there is nothing to say under the form');
    const warned = page.askWarnText([1, 2], 3);
    assert(warned.includes('1 of 3 answered'), `otherwise the line counts them — "${warned}"`);
    assert(!/you can still submit/i.test(warned) && /sends nothing/i.test(warned),
      'and no longer says "you can still submit": it says Submit sends nothing until they are all answered');
  }

  console.log('\nthe window\u2019s own choices');
  {
    // Sorting the window's list into the three that always show and the rest.
    // What "deny" presses comes from here, so the buttons and the endpoint
    // cannot disagree about it.
    const real = [
      { n: 1, text: 'Yes' },
      { n: 2, text: "Yes, and don't ask again for similar commands in /Users/costmo/x" },
      { n: 3, text: 'No' },
    ];
    const c = promptChoices(real);
    eq(c.approve, 1, 'approve is the first Yes, not merely the first option');
    eq(c.deny, 3, 'deny is the No — which is not always 3, and here it is');
    eq(c.extras.map((o) => o.n), [2], 'and the "don\u2019t ask again" variant gets a row of its own');

    // A two-option menu with no "No" at all — the folder-trust question.
    const trust = promptChoices([{ n: 1, text: 'Yes, proceed' }, { n: 2, text: 'No, exit' }]);
    eq(trust.approve, 1, 'a trust question still has an approve');
    eq(trust.deny, 2, 'and its No, wherever it sits');
    eq(trust.extras.length, 0, 'with nothing left over');

    // Nothing read off the window yet: the three still have to work.
    const none = promptChoices(undefined);
    eq([none.approve, none.deny, none.extras.length], [null, null, 0], 'no list is not a crash, it is no list');

    // A menu whose first option is not a Yes at all.
    const odd = promptChoices([{ n: 1, text: 'Use this MCP server' }, { n: 2, text: 'Continue without it' }]);
    eq(odd.approve, 1, 'approve falls back to the first option when nothing says Yes');
    eq(odd.deny, null, 'and deny stays empty rather than guessing at one');
  }

  console.log('\nanswering with one of them');
  await register({ channel: CH, agent: 'chooser', cwd: '/repo/chooser', window: '@31' });
  await hostEvents([{ type: 'session', channel: CH, agent: 'chooser', session_id: 's-choose', cwd: '/repo/chooser' }]);
  await post(ev('chooser', 's-choose', 'SessionStart'));
  await takeWork();   // whatever the blocks above left queued; this one is about its own
  await post(ev('chooser', 's-choose', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'touch x' } }));
  eq(await takeWork(), ['prompt'], 'a prompt opening asks the host what the window is offering');

  let fc = await floor();
  const chooser = () => deskOf(fc, 'chooser');
  const reqC = chooser().permission.request_id;
  eq(chooser().permission.choices.extras.length, 0, 'until it answers, there is nothing extra to show');

  await hostEvents([{
    type: 'prompt', channel: CH, agent: 'chooser', request_id: reqC,
    options: [{ n: 1, text: 'Yes' }, { n: 2, text: "Yes, and don't ask again" }, { n: 3, text: 'No' }],
  }]);
  fc = await floor();
  eq(chooser().permission.choices.extras.map((o) => o.text), ["Yes, and don't ask again"],
     'once it has, the extra choice is on the desk with its own words');

  const choose = (decision) =>
    fetch(`${HOST}/api/floor/permission`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: CH, agent: 'chooser', request_id: reqC, decision }),
    });

  eq((await choose('9')).status, 409, 'a choice the window never offered is refused');
  eq(await takeWork(), [], 'and presses nothing');

  const picked = await choose('2');
  eq(picked.status, 200, 'one it did offer is accepted');
  eq((await picked.json()).sent, '2', 'and reaches the host as that option\u2019s own number');

  // Deny presses the No, not Escape — they are different things, and the
  // prompt's own footer lists them apart.
  await post(ev('chooser', 's-choose', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'touch y' } }));
  await takeWork();
  fc = await floor();
  const reqD = chooser().permission.request_id;
  await hostEvents([{ type: 'prompt', channel: CH, agent: 'chooser', request_id: reqD,
    options: [{ n: 1, text: 'Yes' }, { n: 2, text: 'Yes, and do not ask again' }, { n: 3, text: 'No' }] }]);
  const denied = await fetch(`${HOST}/api/floor/permission`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: CH, agent: 'chooser', request_id: reqD, decision: 'deny' }),
  });
  eq((await denied.json()).sent, '3', 'deny presses the window\u2019s own No');

  // Cancel is Escape, which no menu numbers.
  await post(ev('chooser', 's-choose', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'touch z' } }));
  await takeWork();
  fc = await floor();
  const cancelled = await fetch(`${HOST}/api/floor/permission`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: CH, agent: 'chooser', request_id: chooser().permission.request_id, decision: 'cancel' }),
  });
  eq(cancelled.status, 200, 'cancel is an answer like the others');
  eq((await cancelled.json()).sent, 'cancel', 'and stays cancel, for the host to turn into Escape');

  console.log('\nanswering a prompt stops the desk asking, now');
  // The indicators the operator is looking at — the alert above the compose box,
  // the exclamation mark on the desk, the count in the header — are all drawn
  // from awaiting_kind. That is the hook's word, and the hook does not speak
  // again until Claude Code has moved on: a host round trip later. Left that
  // way, an answered prompt goes on looking unanswered, and the next one to
  // arrive is indistinguishable from the last one you dealt with.
  await register({ channel: CH, agent: 'asker', cwd: '/repo/asker', window: '@11' });
  // The host says which conversation it is watching, the way a real one does.
  // Its later events carry no session id of their own and are filed against
  // this; without it they land on a placeholder row the floor never reads.
  await hostEvents([{ type: 'session', channel: CH, agent: 'asker', session_id: 's-ask', cwd: '/repo/asker' }]);
  await post(ev('asker', 's-ask', 'SessionStart'));
  await takeWork();   // as above — start from an empty queue
  await post(ev('asker', 's-ask', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'git push' } }));

  let fa = await floor();
  const askerDesk = () => deskOf(fa, 'asker');
  eq(askerDesk().session.awaiting_kind, 'permission_request', 'the desk is asking');
  assert(!!askerDesk().permission?.request_id, 'and carries the prompt to answer');
  assert(fa.queue.some((q) => q.agent === 'asker'), 'and is counted among those blocking on a human');
  const reqId = askerDesk().permission.request_id;

  const answer = (request_id, decision = 'allow') =>
    fetch(`${HOST}/api/floor/permission`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: CH, agent: 'asker', request_id, decision }),
    });

  const wrongId = await answer('not-the-open-one');
  eq(wrongId.status, 409, 'answering a prompt that is not the open one is refused');
  fa = await floor();
  eq(askerDesk().session.awaiting_kind, 'permission_request', 'and a refused answer leaves the desk asking');

  const answered = await answer(reqId, 'allow');
  eq(answered.status, 200, 'the open prompt can be answered');
  eq(await takeWork(), ['prompt', 'permission'], 'and the host is handed the keystroke');

  fa = await floor();
  eq(askerDesk().session.awaiting_kind, null, 'the desk stops asking the moment the operator decides');
  eq(askerDesk().permission, null, 'the buttons go with it');
  eq(fa.queue.some((q) => q.agent === 'asker'), false, 'and it leaves the blocked-on-a-human list');

  // Answering twice is a no-op, not a second keystroke into whatever the window
  // is showing by then.
  eq((await answer(reqId)).status, 409, 'the same prompt cannot be answered twice');
  eq(await takeWork(), [], 'and the second click queues nothing');

  // The one risk of clearing early: an answer the host cannot deliver would
  // leave the window at a question the board has stopped showing. The host says
  // so, and that puts the desk back up with the reason.
  const reported = await hostEvents([{
    type: 'error', channel: CH, agent: 'asker',
    message: 'the approve never reached the window — no window for /repo/asker',
  }]);
  eq(reported.applied, 1, 'the host can report a failed answer');
  fa = await floor();
  eq(askerDesk().session.awaiting_kind, 'error', 'an answer that never landed puts the desk back up');
  assert(String(askerDesk().session.awaiting_message).includes('never reached the window'),
    'saying what was observed, so the operator knows to go and look');

  // A form that fails to land comes back as a form.
  //
  // Untested until now, and the gap showed on the floor: the operator answered
  // an AskUserQuestion, the answer was reported as failed, and what came back
  // was the Approve/Deny/Cancel panel — because the panel draws a form only
  // when `questions` is present. Cancelling that closed the form the window was
  // still holding, which is how one prompt became "I received the form twice".
  await post(ev('asker', 's-ask', 'PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: {} }));
  await takeWork();
  fa = await floor();
  const formId = askerDesk().permission.request_id;
  const QS = [
    { kind: 'single', tab_title: 'One', question: 'Which one?', options: [{ n: 1, text: 'Alpha' }, { n: 2, text: 'Bravo' }] },
    { kind: 'single', tab_title: 'Two', question: 'And which?', options: [{ n: 1, text: 'Red' }, { n: 2, text: 'Green' }] },
  ];
  await hostEvents([{ type: 'prompt', channel: CH, agent: 'asker', request_id: formId, options: [], questions: QS, tabs: ['One', 'Two'] }]);
  fa = await floor();
  eq(askerDesk().permission?.questions?.length, 2, 'the form reaches the panel');

  // Nothing accepts a form with a question unanswered — issue #7, item 1. The
  // page refuses first; this is the board refusing whatever posts to it.
  const partForm = await fetch(`${HOST}/api/floor/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: CH, agent: 'asker', request_id: formId, answers: [{ choose: [1] }, {}] }),
  });
  eq(partForm.status, 400, 'a form with a question unanswered is refused by the board');
  const partBody = await partForm.json();
  eq([partBody.code, partBody.question], ['unanswered', 1], 'saying which question — the second — so the page can show it');
  eq(await takeWork(), [], 'and nothing is queued for the host: not one key goes to the window');
  fa = await floor();
  eq([askerDesk().permission?.request_id, askerDesk().permission?.questions?.length, askerDesk().session.awaiting_kind],
    [formId, 2, 'permission_request'], 'the form is still open on the desk exactly as it was, and the desk still asking');

  const sentForm = await fetch(`${HOST}/api/floor/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: CH, agent: 'asker', request_id: formId, answers: [{ choose: [1] }, { choose: [2] }] }),
  });
  eq(sentForm.status, 200, 'the form can be answered');
  await takeWork();

  await hostEvents([{
    type: 'error', code: 'answer_failed', channel: CH, agent: 'asker',
    message: 'your answers did not land — the window stopped asking after 6 of 12 steps',
  }]);
  fa = await floor();
  eq(askerDesk().permission?.request_id, formId, 'a failed answer puts the same request back up');
  eq(askerDesk().permission?.questions?.length, 2,
    'and it comes back as the form, not as Approve/Deny — the panel has no other way to know it is one');

  // Once. A failure that is itself mistaken would otherwise put the form back
  // the instant it is answered, and answering is then the one thing that cannot
  // end it.
  await fetch(`${HOST}/api/floor/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: CH, agent: 'asker', request_id: formId, answers: [{ choose: [1] }, { choose: [2] }] }),
  });
  await takeWork();
  await hostEvents([{
    type: 'error', code: 'answer_failed', channel: CH, agent: 'asker',
    message: 'your answers did not land — again',
  }]);
  fa = await floor();
  eq(askerDesk().permission, null, 'the second failure does not offer it a third time');
  assert(String(askerDesk().session.awaiting_message).includes('not being offered again'),
    'and says so, rather than leaving the operator wondering where the form went');

  console.log('\na question is never drawn as Approve / Deny');
  {
    // Issue #7, item 3. Measured on 2.1.284: a window the host opened is 80x24
    // until somebody attaches, Claude Code cuts the top off a form taller than
    // its pane, and the host — finding no form header — read the pane as a
    // flat menu. The floor drew Approve on the question's first choice and
    // Deny on the first one starting "No".
    //
    // The two forms below are real: the call's input and the pane's reading of
    // it, captured off the same window at 200x50 (2026-10-01). They are what
    // "the form built from the call equals the form the host reads" was
    // measured on, and the keys at the end are the ones that answered the same
    // form at 80x24, where the host could read none of it.
    const INPUT = [
      { question: 'Which colour should the probe use?', header: 'Colour', multiSelect: false, options: [
        { label: 'Red', description: 'Use red for the probe.' }, { label: 'Green', description: 'Use green for the probe.' }, { label: 'Blue', description: 'Use blue for the probe.' }] },
      { question: 'Which toppings should the probe add?', header: 'Toppings', multiSelect: true, options: [
        { label: 'Olives', description: 'Add olives to the probe.' }, { label: 'Peppers', description: 'Add peppers to the probe.' },
        { label: 'Onions', description: 'Add onions to the probe.' }, { label: 'Capers', description: 'Add capers to the probe.' }] },
    ];
    const PANE = [
      { tab: 0, tab_title: 'Colour', strip: true, kind: 'single', question: 'Which colour should the probe use?', options: [
        { n: 1, text: 'Red', checked: null, other: false }, { n: 2, text: 'Green', checked: null, other: false },
        { n: 3, text: 'Blue', checked: null, other: false }, { n: 4, text: 'Type something.', checked: null, other: true }] },
      { tab: 1, tab_title: 'Toppings', strip: true, kind: 'multi', question: 'Which toppings should the probe add?', options: [
        { n: 1, text: 'Olives', checked: false, other: false }, { n: 2, text: 'Peppers', checked: false, other: false },
        { n: 3, text: 'Onions', checked: false, other: false }, { n: 4, text: 'Capers', checked: false, other: false },
        { n: 5, text: 'Type something', checked: false, other: true }] },
    ];
    const rows = (qs) => qs.map((q) => ({
      tab: q.tab, tab_title: q.tab_title, strip: q.strip, kind: q.kind, question: q.question,
      options: q.options.map((o) => ({ n: o.n, text: o.text, checked: o.checked, other: o.other })),
    }));
    const built = formFromInput(INPUT);
    eq(rows(built.questions), PANE,
      'form-from-input: built from the call, a single then a multi has the rows, numbers, free-text rows, kinds and strip the host read off the real pane');
    eq(rows(formFromInput(INPUT.slice(0, 1)).questions)[0].strip, false, 'a lone single-select has no strip, as on the pane');
    eq(rows(formFromInput(INPUT.slice(1)).questions).map((q) => [q.strip, q.options.at(-1).n, q.options.at(-1).text]), [[true, 5, 'Type something']],
      'a lone multi-select has one, and its free-text row is the next number, spelled as a multi spells it');
    eq(built.questions[0].options[0].detail, 'Use red for the probe.', 'each choice keeps its description');
    eq(built.tabs.map((t) => t.title), ['Colour', 'Toppings', 'Submit'], 'and the tabs are the headers, then Submit');
    eq([formFromInput(null), formFromInput([]), formFromInput([{ question: 'Q?', options: [{ label: 'A' }, { description: 'no label' }] }]),
      formFromInput([{ question: 'Q?', options: Array.from({ length: 12 }, (_, i) => ({ label: `c${i}` })) }])],
    [null, null, null, null],
    'no form is built when the numbering cannot be trusted: no questions, a choice with no label, a list the hook may have cut');

    // Which reading is drawn.
    eq(settleForm(built, PANE, ['x']).from, 'pane', 'settleForm: the host’s reading is used when it has every question the call asked');
    const barred = [{ ...PANE[0], question: '│ Which colour should the probe' }, PANE[1]];
    eq(settleForm(built, barred).questions[0].question, 'Which colour should the probe use?',
      'with the question’s own words from the call — the pane gives one screen line, with the window’s bar on it');
    eq(settleForm(built, PANE).questions[1].options[0].detail, 'Add olives to the probe.', 'and each choice’s description, where the row is the same row');
    eq([settleForm(built, [PANE[0]]).from, settleForm(built, [PANE[0]]).questions.length], ['call', 2],
      'a reading with fewer questions than were asked is not drawn: the form comes from the call');
    eq([settleForm(built, null).from, settleForm(built, null).questions.length], ['call', 2], 'nor is no reading at all');
    eq(settleForm(null, PANE).questions, PANE, 'with nothing from the hook, the host’s reading stands as it is');
    eq([settleForm(null, null).from, settleForm(null, null).questions], [null, null], 'and with neither there is no form');

    // The board, end to end. The host's event is the measured misreading: no
    // form, and the pane's five rows as a flat menu.
    const MENU = [{ n: 1, text: 'Red' }, { n: 2, text: 'Green' }, { n: 3, text: 'No colour' }, { n: 4, text: 'Type something.' }, { n: 5, text: 'Chat about this' }];
    const NOFORM = 'the window is asking, and no question form’s header is on its 80x24 pane';
    const tall = () => deskOf(fa, 'tall');
    await register({ channel: CH, agent: 'tall', cwd: '/repo/tall', window: '@77' });
    await hostEvents([{ type: 'session', channel: CH, agent: 'tall', session_id: 's-tall', cwd: '/repo/tall' }]);
    await post(ev('tall', 's-tall', 'SessionStart'));
    await takeWork();
    await post(ev('tall', 's-tall', 'PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: { questions: INPUT } }));
    await takeWork();
    fa = await floor();
    const tallId = tall().permission.request_id;
    eq(Object.hasOwn(tall().permission, 'asked') && tall().permission.asked !== undefined, false, 'the board’s own copy of the call is not sent to the page a second time');
    await hostEvents([{ type: 'prompt', channel: CH, agent: 'tall', request_id: tallId, options: MENU, questions: null, tabs: null, form_error: NOFORM }]);
    fa = await floor();
    eq(tall().permission.questions?.map((q) => `${q.tab_title}:${q.kind}:${q.options.length}`), ['Colour:single:4', 'Toppings:multi:5'],
      'a question the host read as a menu is drawn as its form, every choice under its own words');
    eq([tall().permission.options, tall().permission.choices.approve, tall().permission.choices.deny], [[], null, null],
      'and the menu is gone: nothing for Approve or Deny to press');
    eq(tall().permission.form_from, 'call', 'the payload says the form is the call’s, not the pane’s');
    const tallSent = await fetch(`${HOST}/api/floor/answer`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: CH, agent: 'tall', request_id: tallId, answers: [{ choose: [2] }, { choose: [1, 3] }] }),
    });
    eq(tallSent.status, 200, 'that form can be answered');
    const tallWork = (await takeWorkFull()).find((w) => w.kind === 'answer');
    eq((tallWork?.payload?.steps ?? []).map((st) => st.key), ['Left', 'Left', 'Left', '2', '1', '3', 'Tab'],
      'with the keys that answered the same form on a real 80x24 window: Left Left Left 2 1 3 Tab');

    // No form from the host and none from the hook: said, not guessed at.
    await post(ev('tall', 's-tall', 'PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: {} }));
    await takeWork();
    fa = await floor();
    const blindId = tall().permission.request_id;
    await hostEvents([{ type: 'prompt', channel: CH, agent: 'tall', request_id: blindId, options: MENU, questions: null, tabs: null, form_error: NOFORM }]);
    fa = await floor();
    eq([tall().permission.questions, tall().permission.options, tall().permission.choices.approve, tall().permission.choices.deny], [null, [], null, null],
      'a question nobody could read has no form and no menu either');
    eq(tall().permission.form_unread, NOFORM, 'and carries what the host saw, for the panel to say');
    const unreadReq = tall().permission;

    // A prompt announced only by its Notification has no tool name. The menu
    // says what it is: "Chat about this" is the last row of every question
    // form and of nothing else.
    await register({ channel: CH, agent: 'tallquiet', cwd: '/repo/tallquiet', window: '@78' });
    await hostEvents([{ type: 'session', channel: CH, agent: 'tallquiet', session_id: 's-tq', cwd: '/repo/tallquiet' }]);
    await post(ev('tallquiet', 's-tq', 'SessionStart'));
    await post(ev('tallquiet', 's-tq', 'Notification', { notification_type: 'permission_prompt', notification_message: 'Claude needs your attention' }));
    await takeWork();
    fa = await floor();
    await hostEvents([{ type: 'prompt', channel: CH, agent: 'tallquiet', request_id: deskOf(fa, 'tallquiet').permission.request_id, options: MENU, questions: null, tabs: null, form_error: NOFORM }]);
    fa = await floor();
    eq([deskOf(fa, 'tallquiet').permission.tool, deskOf(fa, 'tallquiet').permission.choices.approve], ['AskUserQuestion', null],
      'a menu ending in "Chat about this" is known for a question even when the hook never named the tool');
    // And an ordinary permission prompt is still a menu.
    await register({ channel: CH, agent: 'tallbash', cwd: '/repo/tallbash', window: '@79' });
    await hostEvents([{ type: 'session', channel: CH, agent: 'tallbash', session_id: 's-tb', cwd: '/repo/tallbash' }]);
    await post(ev('tallbash', 's-tb', 'SessionStart'));
    await post(ev('tallbash', 's-tb', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'git push' } }));
    await takeWork();
    fa = await floor();
    await hostEvents([{ type: 'prompt', channel: CH, agent: 'tallbash', request_id: deskOf(fa, 'tallbash').permission.request_id,
      options: [{ n: 1, text: 'Yes' }, { n: 2, text: 'No' }], questions: null, tabs: null, form_error: NOFORM }]);
    fa = await floor();
    const bashReq = deskOf(fa, 'tallbash').permission;
    eq([bashReq.choices.approve, bashReq.choices.deny], [1, 2], 'a permission prompt keeps its Approve and Deny');

    // What the panel offers for each — the page's own decision, lifted out of
    // the browser script by its section comments.
    const { promptOffer } = await (async () => {
      const src = readFileSync('src/ui/floor.js', 'utf8');
      const a = src.indexOf('  /* ---------- a question form: what the page decides ---------- */');
      const b = src.indexOf('  /* ---------- a question the window is asking ---------- */');
      if (a < 0 || b < 0 || b < a) throw new Error('the question-form section was not found in src/ui/floor.js between its two section comments');
      const tmp = `./data/prompt-offer-${process.pid}.mjs`;
      writeFileSync(tmp, `${src.slice(a, b)}\nexport { promptOffer };\n`);
      try { return await import(new URL(tmp, `file://${process.cwd()}/`)); } finally { rmSync(tmp, { force: true }); }
    })();
    eq(promptOffer(unreadReq, false), 'question-unread', 'promptOffer: a question with no form is said to be unread — the window and Cancel, not Approve / Deny');
    eq(promptOffer({ ...unreadReq, read: false, reading: true }, false), 'question-unread',
      'and so is one the host never came back about, once the reading spinner gives up');
    eq(promptOffer({ ...unreadReq, read: true, options: [], choices: { approve: null, deny: null, extras: [] } }, false), 'question-unread',
      'never the guess buttons either: Yes there presses 1, which on a question is its first choice');
    eq(promptOffer({ ...unreadReq, reading: true }, true), 'reading', 'while it is still being read it is the spinner');
    eq(promptOffer(deskOf(fa, 'tallquiet').permission, false), 'question-unread', 'the question known by its menu is unread too');
    eq(promptOffer(bashReq, false), 'menu', 'a permission prompt is the menu');
    eq(promptOffer({ tool: 'Bash', read: true, choices: { approve: null, deny: null, extras: [] } }, false), 'unreadable',
      'a prompt that is not a question, with nothing to press, keeps the guess buttons');
    eq(promptOffer({ tool: 'startup', startup: true, read: true, options: [{ n: 1, text: 'Yes' }], choices: { approve: 1 } }, false), 'startup', 'a startup question its rows');
    eq(promptOffer({ ...unreadReq, questions: PANE }, false), 'form', 'and a question with a form is the form');
    eq(promptOffer(null, false), 'none', 'no prompt, nothing offered');
  }

  console.log('\nan interrupt marker is not the operator talking');
  // Claude Code writes `[Request interrupted by user]` into the transcript as a
  // user turn. Counted as one, the bubble would say "Thinking…" at the exact
  // moment the operator stopped the agent thinking.
  //
  // Deliberately an UNhosted desk: a hosted one is `mirrored`, so its hooks file
  // no turns at all and every assertion below would pass for that reason instead
  // of the one under test.
  const spoke = async (agent) => !!deskOf(await floor(), agent).heard;
  await post(ev('marks', 's-mark', 'SessionStart'));
  await post(ev('marks', 's-mark', 'UserPromptSubmit', { message: 'do a thing' }));
  eq(await spoke('marks'), true, 'the operator speaks and the desk knows it');
  await post(ev('marks', 's-mark', 'Stop', { last_assistant_message: 'done' }));
  eq(await spoke('marks'), false, 'the agent answers and it stops waiting');

  await post(ev('marks', 's-mark', 'UserPromptSubmit', { message: '[Request interrupted by user]' }));
  eq(await spoke('marks'), false, 'a bare interrupt marker does not make the desk look spoken-to');
  // The row has to be there for that to mean anything: excluded by the filter,
  // not missing because nothing was written.
  const said = (await turns('marks')).rows.map((t) => t.text);
  assert(said.includes('[Request interrupted by user]'),
         'and the marker is in the conversation all the same — the panel shows it, the bubble just does not count it');

  await post(ev('marks', 's-mark', 'UserPromptSubmit', { message: '[Request interrupted by user] do the other thing instead' }));
  eq(await spoke('marks'), true,
     'but the marker with a message after it does — that one is the operator, interrupting by typing');

  // Archiving is the board's control and it hides a channel from the board. The
  // floor has to mean the same thing by it without being a second place to set
  // it — and the failure worth testing is not "the room disappeared", it is the
  // two halves disagreeing: a room out of the building but still in the totals,
  // or out of both but also out of the picker, which is hidden with no way back.
  console.log('\nan archived channel is put away, not deleted');
  {
    const before = await floor();
    const wasChannels = before.totals.channels;
    const wasDesks = before.totals.desks;
    const shelvedDesks = before.channels.find((c) => c.channel === 'other-floor').desks.length;
    // Waiting on a human, in the room about to be put away.
    await post({ ...ev('free', 's9', 'Notification', { notification_type: 'permission_prompt', notification_message: 'may I?' }), channel: 'other-floor' });
    eq((await floor()).queue.some((q) => q.channel === 'other-floor'), true,
       'first: that desk is in the queue, so its absence below means something');

    const { default: Database } = await import('better-sqlite3');
    const db = new Database(DB_PATH);
    // A desk here that the *board* knows too. Every other desk in this suite was
    // made by hook events alone, and those legitimately have no sign to paint —
    // so without this the sign assertion below would pass on a null it was never
    // testing.
    db.prepare(`INSERT OR REPLACE INTO agents (channel, agent, last_seen)
                VALUES ('other-floor', 'pro', datetime('now'))`).run();
    db.prepare(`INSERT OR REPLACE INTO channel_flags (channel, archived_at, archived_by)
                VALUES ('other-floor', datetime('now'), 'operator')`).run();
    db.close();

    f = await floor();
    const shelved = f.channels.find((c) => c.channel === 'other-floor');
    assert(!!shelved, 'the channel is still in the payload — dropping it would take its chip in the floor picker with it, and a room you cannot reach is not archived, it is gone');
    eq(shelved.archived, true, 'flagged, so the page can leave it out of the building and still offer the way in');
    eq(shelved.desks.length, shelvedDesks, 'with every desk still on it — an agent on an archived channel keeps working, which the board already promises');
    assert(!!shelved.desks.find((d) => d.agent === 'pro')?.board,
       'and a desk the board knows keeps its sign, so the room is drawn whole when somebody does walk into it rather than as a row of blank desks');
    eq(f.totals.channels, wasChannels - 1, 'the totals line describes the building, and this floor is not in it');
    eq(f.totals.desks, wasDesks - shelvedDesks, 'nor are its desks');
    eq(f.totals.archived, 1, 'counted separately instead, the same way the board counts them');
    eq(f.queue.some((q) => q.channel === 'other-floor'), false,
       'and a prompt in a room the operator put away does not page them from it');

    const db2 = new Database(DB_PATH);
    db2.prepare(`UPDATE channel_flags SET archived_at = NULL WHERE channel = 'other-floor'`).run();
    db2.close();
    f = await floor();
    eq(f.channels.find((c) => c.channel === 'other-floor').archived, false, 'restoring puts it back');
    eq([f.totals.channels, f.totals.archived], [wasChannels, 0], 'totals and all');
    eq(f.queue.some((q) => q.channel === 'other-floor'), true, 'and the desk that was waiting is waiting on the floor again');
    await post({ ...ev('free', 's9', 'UserPromptSubmit', { message: 'yes' }), channel: 'other-floor' });
  }

  console.log('\nwhat a backup carries');
  const backup = await (await fetch(`${HOST}/api/admin/backup`)).json();
  const tables = Object.keys(backup.tables ?? {});
  assert(!tables.includes('turns'), 'turns are NOT in a backup — it holds what people typed, and the file is meant to be safe to email yourself');
  assert(!tables.includes('agent_sessions'), 'nor are sessions');
  assert(tables.includes('personas'), 'but names are, because a rename is an operator decision that would otherwise be lost');

  /* ── a host that looks again ────────────────────────────────────────────────
   * Desks used to be discovered once, when a host started. Binding a repo to
   * the board afterwards — the most ordinary thing a person does — left the
   * floor saying "No host on this board is running that repo" until the
   * service was restarted. Two halves close that: the host rescans, and the
   * board (a) marks a desk the host stops naming as offline and (b) asks every
   * host to look when a session starts somewhere none of them runs. Last in
   * this file on purpose: the asks land in h-open's queue too, and the sections
   * above read that queue expecting only their own work. */
  console.log('\na host that looks again');
  const registerMove = (...desks) =>
    fetch(`${HOST}/api/host/register`, {
      method: 'POST', headers: HK,
      body: JSON.stringify({ host_id: 'h-move', name: 'movebox', tmux: 'orch', desks }),
    }).then((r) => r.json());
  const workMove = () =>
    fetch(`${HOST}/api/host/work?host_id=h-move&wait=0`, { headers: HK })
      .then((r) => r.json())
      .then((b) => (b.work ?? []).map((i) => i.kind));
  const moverA = { channel: CH, agent: 'mover-a', cwd: '/repo/mover-a' };
  const moverB = { channel: CH, agent: 'mover-b', cwd: '/repo/mover-b', session_id: 'sdk-mover-b' };
  await registerMove(moverA, moverB);
  await workMove();   // a work poll is what keeps a host counted as here
  f = await floor();
  eq([deskOf(f, 'mover-a').hosted.live, deskOf(f, 'mover-b').hosted.live], [true, true], 'two desks named, two hosted');
  await registerMove(moverA);
  f = await floor();
  eq(deskOf(f, 'mover-a').hosted.live, true, 'a desk the host still names stays hosted');
  eq([deskOf(f, 'mover-b').hosted.state, deskOf(f, 'mover-b').hosted.live], ['offline', false],
     'a desk the host stopped naming goes offline — its binding was removed or moved, and a row that kept reading hosted took messages nobody would drain');
  eq(deskOf(f, 'mover-b').hosted.session_id, 'sdk-mover-b', 'keeping the conversation it had, so a return resumes rather than restarts');
  await registerMove(moverA, moverB);
  eq(deskOf(await floor(), 'mover-b').hosted.live, true, 'and naming it again brings it back');

  await post(ev('stranger', 's-stranger', 'SessionStart'));
  eq(await workMove(), ['rescan'], 'a session starting on a desk no host runs asks every host here to look at its roots again');
  await post(ev('stranger-2', 's-stranger-2', 'SessionStart'));
  eq(await workMove(), [], 'once per throttle — a machine with no host at all must not keep every other host walking its disk');
  await post(ev('mover-a', 's-mover-a', 'SessionStart'));
  eq(await workMove(), [], 'and a session starting on a hosted desk asks nothing');
  const look = await fetch(`${HOST}/api/floor/rescan`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  eq(look.status, 200, 'the button asks outright');
  assert((await look.json()).asked >= 1, 'and says how many hosts it asked');
  eq(await workMove(), ['rescan'], 'past the throttle — one click, one look');

  /* ── a window asking before it starts ───────────────────────────────────────
   * Folder trust and "New MCP server found" are asked before a session exists,
   * so no hook reports them. The host reads them off the pane and says so; the
   * board offers their rows like any prompt; the answer goes back down the
   * permission route as a row number. A VS Code session defers the MCP approval
   * and a re-pointed .mcp.json invalidates it, so this is the first thing a
   * new user meets — and used to be a desk that said "starting" for ever. */
  console.log('\na window asking before it starts');
  const eventsMove = (events) =>
    fetch(`${HOST}/api/host/events`, { method: 'POST', headers: HK, body: JSON.stringify({ host_id: 'h-move', events }) }).then((r) => r.json());
  const moverDesk = () => floor().then((fl) => deskOf(fl, 'mover-a'));
  const MCP_ROWS = [
    { n: 1, text: 'Use this MCP server' },
    { n: 2, text: 'Use this and all future MCP servers in this project' },
    { n: 3, text: 'Continue without using this MCP server' },
  ];
  eq((await eventsMove([{
    type: 'startup', channel: CH, agent: 'mover-a', request_id: 'startup:@9:mcp', kind: 'mcp',
    asks: 'New MCP server found in this project: orchestratinator', options: MCP_ROWS, window: '@9',
  }])).applied, 1, 'the host reports a startup question on a desk whose window has not registered');
  let md = await moverDesk();
  eq(md.permission?.startup, true, 'and the desk carries it as a prompt of its own kind');
  eq(md.permission?.options.map((o) => o.text), MCP_ROWS.map((o) => o.text), 'with the dialog’s own rows');

  // A re-say of the same standing question — nothing chosen, nothing gone in
  // between — must not reset when it was first seen. The host repeats a
  // startup question every STARTUP_RESAY_MS while it stands, and the queue's
  // wait age falls back to this `at` whenever the desk's newest session isn't
  // the one carrying the awaiting mark (an editor session sharing the desk,
  // say) — a fresh `at` on every re-say restarted that clock each time.
  const firstAt = md.permission.at;
  assert(!!firstAt, 'the pending request carries when it was first seen');
  await sleep(30);
  await eventsMove([{
    type: 'startup', channel: CH, agent: 'mover-a', request_id: 'startup:@9:mcp', kind: 'mcp',
    asks: 'New MCP server found in this project: orchestratinator', options: MCP_ROWS, window: '@9',
  }]);
  eq((await moverDesk()).permission?.at, firstAt,
     'and a re-say of the same standing question keeps it, rather than the moment the host happened to repeat itself');

  // The desk's current session is whichever row was touched last — here the
  // hook session from the rescan section, and on a real desk an editor whose
  // hooks keep firing — so the queue must not depend on that row being marked.
  eq((await floor()).queue.some((q) => q.agent === 'mover-a'), true, 'the desk is in the queue on the strength of the question alone, so "N need you" counts it');
  eq((await floor()).channels.find((c) => c.channel === CH).awaiting >= 1, true, 'and the floor’s own count agrees');
  const chose = await fetch(`${HOST}/api/floor/permission`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: CH, agent: 'mover-a', request_id: 'startup:@9:mcp', decision: '1' }),
  });
  eq(chose.status, 200, 'a row is chosen through the same route as any prompt');
  const work = await fetch(`${HOST}/api/host/work?host_id=h-move&wait=0`, { headers: HK }).then((r) => r.json());
  eq(work.work.map((w) => `${w.kind}:${w.payload.decision}:${w.payload.request_id}`), ['permission:1:startup:@9:mcp'],
     'and reaches the host as that row, on that request — which is what routes it to the startup presser');
  eq((await moverDesk()).permission ?? null, null, 'the prompt comes down the moment the choice is made');
  await eventsMove([{ type: 'startup', channel: CH, agent: 'mover-a', request_id: 'startup:@9:mcp', kind: 'mcp', asks: 'New MCP server found in this project: orchestratinator', options: MCP_ROWS }]);
  eq((await moverDesk()).permission?.startup, true, 'said again while it stands (a restarted server hears it a minute later)');
  await eventsMove([{ type: 'startup', channel: CH, agent: 'mover-a', request_id: 'startup:@9:mcp', gone: true }]);
  md = await moverDesk();
  eq(md.permission ?? null, null, 'and gone when the host sees the dialog leave');
  eq((await floor()).queue.some((q) => q.agent === 'mover-a'), false, 'with the desk out of the queue');

  console.log('\na startup answer that fails to land comes back once');
  // Same shape as the AskUserQuestion re-offer above, for the other kind of
  // prompt that can now fail to land. Before this it painted the desk red
  // with "your approve did not land" — wrong verb for a row that was never
  // approve/deny — and under the old bare `answer_failed`-only gate it never
  // re-offered at all, so the operator was left at a plain error for up to a
  // minute even though the dialog was still standing right there.
  await eventsMove([{
    type: 'startup', channel: CH, agent: 'mover-a', request_id: 'startup:@9:mcp', kind: 'mcp',
    asks: 'New MCP server found in this project: orchestratinator', options: MCP_ROWS, window: '@9',
  }]);
  eq((await moverDesk()).permission?.startup, true, 'raised again for this section');
  const chose2 = await fetch(`${HOST}/api/floor/permission`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: CH, agent: 'mover-a', request_id: 'startup:@9:mcp', decision: '1' }),
  });
  eq(chose2.status, 200, 'the row is chosen');
  await eventsMove([{
    type: 'error', code: 'startup_answer_failed', channel: CH, agent: 'mover-a',
    message: 'your choice did not reach the window — no window is open for this repo',
  }]);
  md = await moverDesk();
  eq(md.permission?.request_id, 'startup:@9:mcp', 'a failed startup answer puts the same request back up');
  eq(md.permission?.startup, true, 'and it comes back as the startup prompt, not as Approve/Deny');
  eq(md.permission?.options.map((o) => o.text), MCP_ROWS.map((o) => o.text), 'with its own rows intact');

  // Once, same rule as the form: a mistaken failure must not put the prompt
  // back the instant it is answered, or answering becomes the one thing that
  // cannot end it.
  await fetch(`${HOST}/api/floor/permission`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: CH, agent: 'mover-a', request_id: 'startup:@9:mcp', decision: '1' }),
  });
  await eventsMove([{
    type: 'error', code: 'startup_answer_failed', channel: CH, agent: 'mover-a',
    message: 'your choice did not reach the window — again',
  }]);
  md = await moverDesk();
  eq(md.permission, null, 'the second failure does not offer it a third time');
  // Not md.session.awaiting_message: which session is "current" for a desk is
  // decided by updated_at, which SQLite's datetime('now') only carries to the
  // second — two rows touched in the same second (the placeholder this error
  // is marked on, and mover-a's earlier hook session from the rescan section,
  // both touched within this same fast-running test) tie, and which one wins
  // the tie is not something to depend on. The error turn is unambiguous:
  // appended once, read back by id, regardless of any session's timestamp.
  const moverTurns = (await turns('mover-a')).rows ?? [];
  assert(String(moverTurns.at(-1)?.text ?? '').includes('not being offered again'),
    'and says so, rather than leaving the operator wondering where the dialog went');
  await eventsMove([{ type: 'startup', channel: CH, agent: 'mover-a', request_id: 'startup:@9:mcp', gone: true }]);
} catch (err) {
  failures++;
  console.error(`\n  ✗ ${err.stack ?? err}`);
} finally {
  server.kill();
  await sleep(150);
  rmDb(DB_PATH);
}

console.log(failures ? `\nFAIL ❌ — ${failures} failure(s)` : '\nPASS ✅ — 0 failure(s)');
process.exit(failures ? 1 : 0);

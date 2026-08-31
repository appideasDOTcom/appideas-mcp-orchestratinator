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
import { rmSync } from 'node:fs';
import { deliverable, nudgeable } from '../src/floor.js';

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

  console.log('\nwho can be nudged, which is a stricter question than who can be messaged');
  // Plain objects rather than a seeded desk: these are the shapes the two
  // callers actually hand in, and one of them is the shape that broke.
  const fresh = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const live = { state: 'idle', host_seen: fresh, host_name: 'boxy', window_id: 'w1', outside_pid: null };
  assert(!deliverable(live).error, 'a hosted desk with a live host takes messages');
  assert(!nudgeable(live).error, 'and can be nudged');

  const noWindow = { ...live, window_id: null };
  assert(!deliverable(noWindow).error,
         'a desk with no window still takes a message — sending one is what opens the window');
  eq(nudgeable(noWindow).code, 'no_window',
     'but it cannot be nudged: a nudge means "something is waiting on your channel", which is nothing to say to an empty desk');

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

  console.log('\nputting a conversation back on the floor');
  // The direction that was missing. handback moves a conversation into the
  // editor; nothing moved it the other way, so a desk whose editor had let go
  // sat with no window and no way to be given one. The host could always do it
  // — its `case 'open'` was simply unreachable.
  const HK = { 'content-type': 'application/json', 'x-orchestratinator-key': KEY };
  const register = (desk) =>
    fetch(`${HOST}/api/host/register`, {
      method: 'POST', headers: HK,
      body: JSON.stringify({ host_id: 'h-open', name: 'openbox', tmux: 'orch', desks: [desk] }),
    });
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
  await register({ channel: CH, agent: 'wanderer', cwd: '/repo/wanderer', window: '@7' });
  opened = await askOpen();
  eq(opened.status, 200, 'asking for a window that is already open is not a failure');
  eq((await opened.json()).already, true, 'it says the window was already there');
  eq(await takeWork(), [], 'and queues nothing');

  const nowhere = await fetch(`${HOST}/api/floor/open`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: CH, agent: 'nobody-hosts-me' }),
  });
  eq(nowhere.status, 409, 'a desk no host runs cannot be opened');

  console.log('\nwhat a backup carries');
  const backup = await (await fetch(`${HOST}/api/admin/backup`)).json();
  const tables = Object.keys(backup.tables ?? {});
  assert(!tables.includes('turns'), 'turns are NOT in a backup — it holds what people typed, and the file is meant to be safe to email yourself');
  assert(!tables.includes('agent_sessions'), 'nor are sessions');
  assert(tables.includes('personas'), 'but names are, because a rename is an operator decision that would otherwise be lost');
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

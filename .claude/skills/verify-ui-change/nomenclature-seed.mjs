/*
 * Seed one room for the labelled nomenclature shot (0.9.3).
 *
 * Four desks, chosen so all twelve named parts are visible at once and no two
 * labels have to point at the same desk:
 *
 *   seat 0  app-developer      working — bubble (a thought), thought trail,
 *                              person, monitor typing, counter, sign
 *   seat 1  qa-engineer        the whole cell, nameplate, a three-pill tray,
 *                              a live bell
 *   seat 2  designer           needs-you — the badge
 *   seat 3  marketing-site-dev away and never reported — the nameplate's
 *                              other ending, unlabelled, for contrast
 *
 * Cast is the README's fictional company on purpose: an agent who has read the
 * README recognises the room. Everything goes through the real doors.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/* Everything is derived from this file's own location so the script survives
   being moved, and so it never again lives only in a session scratchpad —
   which is exactly where the previous version of this pipeline was when it
   was lost, costing a rebuild from scratch. */
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BASE = process.env.ORCH_SHOT_BASE ?? 'http://localhost:8907';
const require = createRequire(join(REPO, 'package.json'));
const Database = require('better-sqlite3');

const KEY = process.env.ORCH_AUTH_TOKEN ?? 'k';
const DB = process.env.ORCH_SHOT_DB ?? join(REPO, 'data', 'nomen.db');
const TT = 'trailtracker-mobile';

const db = new Database(DB);

/* ---------- avatars & seats (operator decisions, so SQL is honest) ---------- */

const upProfile = db.prepare(`INSERT INTO agent_profile (agent, persona, gender, shirt, hair, skin)
  VALUES (?,?,?,?,?,?)
  ON CONFLICT(agent) DO UPDATE SET persona=excluded.persona, gender=excluded.gender,
    shirt=excluded.shirt, hair=excluded.hair, skin=excluded.skin`);
const upSeat = db.prepare(`INSERT INTO personas (channel, agent, seat) VALUES (?,?,?)
  ON CONFLICT(channel, agent) DO UPDATE SET seat=excluded.seat`);

const cast = [
  // agent, persona, gender, shirt, hair, skin, seat
  ['app-developer',      'App Developer',      'male',   '#7aa2ff', '#5a4130', '#af7e57', 0],
  ['qa-engineer',        'QA Engineer',        'female', '#f2905f', '#3a2a1e', '#8d5524', 1],
  ['designer',           'Designer',           'female', '#e77edc', '#5a4130', '#d5ab88', 2],
  ['marketing-site-dev', 'Marketing Site Dev', 'female', '#b39bfa', '#e8c99b', '#f7dece', 3],
];
for (const [agent, persona, gender, shirt, hair, skin, seat] of cast) {
  upProfile.run(agent, persona, gender, shirt, hair, skin);
  upSeat.run(TT, agent, seat);
}

/* ---------- the host and the three desks it runs ---------- */

// marketing-site-dev is deliberately absent: no host and no hook session is
// what "· not reporting" means, and it is the only way to draw that ending.
const desks = [
  { channel: TT, agent: 'app-developer', cwd: '/Users/sam/dev/trailtracker/trailtracker-app',  window: 'tt-app' },
  { channel: TT, agent: 'qa-engineer',   cwd: '/Users/sam/dev/trailtracker/trailtracker-qa',   window: 'tt-qa' },
  { channel: TT, agent: 'designer',      cwd: '/Users/sam/dev/trailtracker/design-system',     window: 'tt-designer' },
];

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-orchestratinator-key': KEY },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) console.error(`POST ${path} -> ${r.status}: ${text.slice(0, 200)}`);
  return text;
}

await post('/api/host/register', { host_id: 'h1', name: 'studio-mac', tmux: 'orch', desks });

/* ---------- MCP sessions: presence, statuses, and the board writes the tray counts from ---------- */

async function mcp(channel, agent) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'x-channel': channel, 'x-agent': agent, 'x-orchestratinator-key': KEY,
  };
  const init = await fetch(`${BASE}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'seed', version: '1.0' } } }),
  });
  const sid = init.headers.get('mcp-session-id');
  await init.text();
  if (!sid) throw new Error(`no session id for ${channel}/${agent}`);
  const h2 = { ...headers, 'mcp-session-id': sid };
  await fetch(`${BASE}/mcp`, { method: 'POST', headers: h2,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }).then((r) => r.text());
  let id = 1;
  return {
    call: async (name, args = {}) => {
      const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: h2,
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
      const text = await r.text();
      if (!r.ok || /"isError":true/.test(text)) console.error(`${channel}/${agent} ${name} -> ${r.status}: ${text.slice(0, 300)}`);
      return text;
    },
  };
}

const app = await mcp(TT, 'app-developer');
const qa = await mcp(TT, 'qa-engineer');
const des = await mcp(TT, 'designer');
const pm = await mcp(TT, 'project-manager');

// The sign shows the DETAIL line, so every status here carries one worth reading.
await app.call('set_status', { status: 'working', detail: 'Capturing the App Store screenshot set', ttl_seconds: 3600 });
await des.call('set_status', { status: 'working', detail: 'App Store listing artwork — final pass', ttl_seconds: 3600 });
await qa.call('set_status', { status: 'waiting', detail: 'Release candidate — regression suite staged', ttl_seconds: 3600 });

// The tray: one pill of each kind on the same desk, which is the only way to
// label all three at once. Two unread, one open task assigned, one held.
await pm.call('send_message', { to: 'qa-engineer', body: 'Regression run is yours as soon as the release candidate lands.' });
await des.call('send_message', { to: 'qa-engineer', body: 'Listing artwork is final — nothing for you to re-check there.' });
await pm.call('open_task', { title: 'Stage the release-candidate regression run', assignee: 'qa-engineer' });   // 1
await pm.call('open_task', { title: 'Verify onboarding flow on iOS 27', assignee: 'qa-engineer' });             // 2
await qa.call('claim_task', { id: 2 });

/* ---------- the windows, their hook state, and the conversation ---------- */

const sessions = [
  [TT, 'app-developer', 'sess-app', '/Users/sam/dev/trailtracker/trailtracker-app', 'release/2.0'],
  [TT, 'qa-engineer',   'sess-qa',  '/Users/sam/dev/trailtracker/trailtracker-qa',  'main'],
  [TT, 'designer',      'sess-des', '/Users/sam/dev/trailtracker/design-system',    'main'],
];

await post('/api/host/events', { host_id: 'h1',
  events: sessions.map(([channel, agent, session_id, cwd]) => ({ type: 'session', channel, agent, session_id, cwd })) });

const ingest = (channel, agent, session_id, cwd, git_branch, event, extra = {}) =>
  post('/api/ingest', { channel, agent, session_id, cwd, git_branch, model: 'claude-opus-5',
    permission_mode: 'default', hook_event_name: event, ...extra });

/* `working` is the SERVER's answer — the host's own state, not a second reading
   of the turns — so a UserPromptSubmit is what makes a desk work and a Stop is
   what ends it. Without the Stop, qa-engineer is working too and the thought
   trail label has two desks to point at. */
for (const [channel, agent, sid, cwd, branch] of sessions) {
  await ingest(channel, agent, sid, cwd, branch, 'UserPromptSubmit');
  if (agent === 'qa-engineer') await ingest(channel, agent, sid, cwd, branch, 'Stop');
}

// The badge. An ordinary tool permission — the common case, and unlike an
// AskUserQuestion it needs no pane read to be a complete alert.
await ingest(TT, 'designer', 'sess-des', '/Users/sam/dev/trailtracker/design-system', 'main',
  'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'sips -Z 2048 exports/*.png' } });

/* Conversation. Order is id order, and three things are read off it:
   the bubble takes the newest assistant-or-thinking text, the monitor takes
   the tool turns, and deskState reads the last turn — so app-developer's must
   END on a tool call for the desk to be working and the trail to run. */
const turn = (channel, agent, session_id, role, text, tool_name, tool_input) =>
  ({ type: 'turn', channel, agent, session_id, role, text, tool_name, tool_input });

await post('/api/host/events', { host_id: 'h1', events: [
  turn(TT, 'app-developer', 'sess-app', 'user',
    'Release build is green. Capture the App Store screenshot set — 6.7-inch phone and 13-inch iPad.'),
  turn(TT, 'app-developer', 'sess-app', 'assistant',
    'Build verified on the release scheme. Running the capture across all four launch locales now.'),
  turn(TT, 'app-developer', 'sess-app', 'tool', null, 'Bash',
    { command: 'xcodebuild -scheme TrailTracker -configuration Release' }),
  turn(TT, 'app-developer', 'sess-app', 'thinking',
    'The iPad set needs the landscape variant too — I should check the fastlane config before running the capture.'),
  turn(TT, 'app-developer', 'sess-app', 'tool', null, 'Read', { file_path: 'fastlane/Snapfile' }),

  // No tool turn for qa-engineer, deliberately: the last turn's role is what
  // makes a desk `working`, and a second working desk would put a second
  // thought trail in frame for label 11 to be ambiguous about.
  turn(TT, 'qa-engineer', 'sess-qa', 'assistant',
    'Regression suite is staged and ready — standing by for the release candidate.'),

  turn(TT, 'designer', 'sess-des', 'assistant',
    'Listing artwork is exported. Resizing the 2048px set for the store now.'),
] });

/* project-manager wrote the tasks and the mail, so it has an agents row and a
   seat — but it is not one of the four desks this shot is composed around, and
   a fifth figure only adds a second empty chair. Its work stays; its seat goes.

   Deleting the personas row does NOT do this: buildFloor calls ensurePersona()
   for every agents row it reads, so the seat is recreated on the next poll and
   the desk comes back. `retired_at` is the product's own answer and the only
   one that holds. */
db.prepare(`UPDATE agents SET retired_at = datetime('now') WHERE channel = ? AND agent = ?`)
  .run(TT, 'project-manager');

/* The absent teammate gets a board row with an old last_seen, so its sign reads
   the derived `idle` rather than nothing at all. A desk with no sign whatsoever
   is a desk the board has never heard of, which is a third state and not the
   one being drawn here. */
db.prepare(`INSERT INTO agents (channel, agent, last_seen) VALUES (?,?,datetime('now','-2 days'))
  ON CONFLICT(channel, agent) DO UPDATE SET last_seen=excluded.last_seen`).run(TT, 'marketing-site-dev');

/* The sign only rolls when its text CHANGES, so a freshly-seeded board draws
   every card mid-turn on first paint. Settled by seeding the status once and
   leaving it — nothing here changes it a second time. */

console.log('seeded. verifying through /api/floor:');
const floor = await (await fetch(`${BASE}/api/floor`)).json();
const room = floor.channels.find((c) => c.channel === TT);
for (const d of room.desks) {
  const deskState = !d.live ? 'away' : d.session?.awaiting_kind ? 'needs-you' : d.working ? 'working' : 'here';
  console.log(
    `  ${d.agent.padEnd(19)} state=${deskState.padEnd(9)}`,
    `live=${String(d.live).padEnd(5)} reporting=${String(d.reporting).padEnd(5)}`,
    `plate="${d.hosted ? (d.hosted.live ? 'ready' : 'host offline') : d.reporting ? '' : 'not reporting'}"`,
    `sign="${(d.board?.state?.detail ?? d.board?.state?.label ?? '').slice(0, 40)}"`,
    `pills=[u${d.board?.unread ?? 0} a${d.board?.assigned_open ?? 0} c${d.board?.claimed_tasks?.length ?? 0}]`,
    `bell=${d.nudge?.ok ? 'live' : 'BLOCKED'}`,
    `cmds=${d.commands?.length ?? 0}`,
    `bubble="${(d.heard ? 'Thinking…' : d.last_message?.text ?? '').slice(0, 40)}"`
  );
}
console.log(`  room header: ${room.live}/${room.desks.length} here · ${room.awaiting} need you`);

// A seeded host goes stale in 90s, which is less than a browser run takes.
setInterval(() => db.prepare(`UPDATE hosts SET last_seen=datetime('now') WHERE host_id='h1'`).run(), 2000);
console.log('heartbeat running — leave this process up while shooting');

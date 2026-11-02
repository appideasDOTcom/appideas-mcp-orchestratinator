/*
 * Seed the README's fictional company for the appideas.com landing-page
 * captures (task #204, 2026-10-17): three floors, eleven desks, one host.
 *
 * This is the fixture the README images were made from, rebuilt — the
 * original seed lived in a session scratchpad and was lost, which is why this
 * one lives here beside nomenclature-seed.mjs. Everything goes through the
 * real doors: MCP sessions for presence, statuses, mail, tasks and the
 * contract; /api/host/register and /api/host/events for the host, its windows
 * and the conversations; /api/ingest for what each window's hook reports.
 * SQL touches only what no door can set: avatars, seats, retirement, and the
 * ages of rows (so the activity log does not read "0m ago" twelve times).
 *
 *   trailtracker-mobile   the hot floor: six seated, App Developer holding a
 *                         permission prompt (the badge), two desks with trays
 *   bookinator-wp         running quietly: three seated, QA with a tray
 *   ledgerino-desktop     dark: two desks, nobody reporting, seen 2d ago
 *
 * Company agents sit on more than one floor under one name: the Project
 * Manager drives TrailTracker and stands by on Bookinator; the QA Engineer is
 * idle on TrailTracker while running a regression on Bookinator; the Designer
 * is working on TrailTracker and dark on Ledgerino.
 *
 *   PORT=8906 DB_PATH=./data/landing.db ORCH_AUTH_TOKEN=k node src/server.js &
 *   node .claude/skills/verify-ui-change/landing-seed.mjs &     # keeps a heartbeat
 *   node --experimental-websocket .claude/skills/verify-ui-change/landing-shot.mjs
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BASE = process.env.ORCH_SHOT_BASE ?? 'http://localhost:8906';
const require = createRequire(join(REPO, 'package.json'));
const Database = require('better-sqlite3');

const KEY = process.env.ORCH_AUTH_TOKEN ?? 'k';
const DB = process.env.ORCH_SHOT_DB ?? join(REPO, 'data', 'landing.db');
const TT = 'trailtracker-mobile';
const BK = 'bookinator-wp';
const LD = 'ledgerino-desktop';
const HOST = 'h1';

const db = new Database(DB);

/* ---------- avatars & seats (operator decisions, so SQL is honest) ---------- */

const upProfile = db.prepare(`INSERT INTO agent_profile (agent, persona, gender, shirt, hair, skin)
  VALUES (?,?,?,?,?,?)
  ON CONFLICT(agent) DO UPDATE SET persona=excluded.persona, gender=excluded.gender,
    shirt=excluded.shirt, hair=excluded.hair, skin=excluded.skin`);
const upSeat = db.prepare(`INSERT INTO personas (channel, agent, seat) VALUES (?,?,?)
  ON CONFLICT(channel, agent) DO UPDATE SET seat=excluded.seat`);

// agent, persona, gender, shirt, hair, skin — one look per agent, every floor.
const cast = {
  'project-manager':    ['Project Manager',    'female', '#e8b84a', '#e8c99b', '#f7dece'],
  'designer':           ['Designer',           'female', '#e77edc', '#5a4130', '#d5ab88'],
  'app-developer':      ['App Developer',      'male',   '#7aa2ff', '#5a4130', '#af7e57'],
  'api-developer':      ['API Developer',      'male',   '#6fd08c', '#c0392b', '#f7dece'],
  'marketing-site-dev': ['Marketing Site Dev', 'female', '#b39bfa', '#e8c99b', '#f7dece'],
  'qa-engineer':        ['QA Engineer',        'male',   '#8fd36a', '#3a2a1e', '#8d5524'],
  'wp-developer':       ['Plugin Developer',   'female', '#f28b82', '#5a4130', '#d5ab88'],
  'desktop-dev':        ['Desktop Developer',  'male',   '#7aa2ff', '#3a2a1e', '#af7e57'],
};
for (const [agent, [persona, gender, shirt, hair, skin]] of Object.entries(cast)) {
  upProfile.run(agent, persona, gender, shirt, hair, skin);
}
const seats = {
  [TT]: ['project-manager', 'designer', 'app-developer', 'api-developer', 'marketing-site-dev', 'qa-engineer'],
  [BK]: ['wp-developer', 'qa-engineer', 'project-manager'],
  [LD]: ['desktop-dev', 'designer'],
};
for (const [channel, agents] of Object.entries(seats)) agents.forEach((a, i) => upSeat.run(channel, a, i));

/* ---------- the host and the nine desks it runs ---------- */

const home = '/Users/sam/dev';
const desks = [
  { channel: TT, agent: 'project-manager',    cwd: `${home}/trailtracker/trailtracker-pm`,     window: 'tt-pm' },
  { channel: TT, agent: 'designer',           cwd: `${home}/trailtracker/design-system`,      window: 'tt-design' },
  { channel: TT, agent: 'app-developer',      cwd: `${home}/trailtracker/trailtracker-app`,   window: 'tt-app' },
  { channel: TT, agent: 'api-developer',      cwd: `${home}/trailtracker/trailtracker-api`,   window: 'tt-api' },
  { channel: TT, agent: 'marketing-site-dev', cwd: `${home}/trailtracker/trailtracker-site`,  window: 'tt-site' },
  { channel: TT, agent: 'qa-engineer',        cwd: `${home}/trailtracker/trailtracker-qa`,    window: 'tt-qa' },
  { channel: BK, agent: 'wp-developer',       cwd: `${home}/bookinator/bookinator-plugin`,    window: 'bk-plugin' },
  { channel: BK, agent: 'qa-engineer',        cwd: `${home}/bookinator/bookinator-qa`,        window: 'bk-qa' },
  { channel: BK, agent: 'project-manager',    cwd: `${home}/bookinator/bookinator-pm`,        window: 'bk-pm' },
];
const deskOf = (channel, agent) => desks.find((d) => d.channel === channel && d.agent === agent);

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

await post('/api/host/register', { host_id: HOST, name: 'studio-mac', tmux: 'orch', desks: desks.map((d) => ({ ...d, scope: 'project' })) });

/* ---------- MCP sessions: presence, statuses, mail, tasks, the contract ---------- */

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

const tt = {};
for (const a of seats[TT]) tt[a] = await mcp(TT, a);
const bk = {};
for (const a of seats[BK]) bk[a] = await mcp(BK, a);

// The sign shows the DETAIL line, so every status carries one worth reading.
await tt['api-developer'].call('set_status',      { status: 'working', detail: 'Auditing token storage for the security write-up', ttl_seconds: 3600 });
await tt['app-developer'].call('set_status',      { status: 'working', detail: 'Capturing the App Store screenshot set', ttl_seconds: 3600 });
await tt['designer'].call('set_status',           { status: 'working', detail: 'App Store listing artwork', ttl_seconds: 3600 });
await tt['marketing-site-dev'].call('set_status', { status: 'waiting', detail: 'Waiting on security details for the launch page', ttl_seconds: 3600 });
await tt['project-manager'].call('set_status',    { status: 'working', detail: 'Launch checklist — 3 items left for Thursday', ttl_seconds: 3600 });
await tt['qa-engineer'].call('set_status',        { status: 'idle',    detail: 'Next: release-candidate regression run', ttl_seconds: 3600 });
await bk['project-manager'].call('set_status',    { status: 'idle',    detail: 'Standing by — TrailTracker launch has priority', ttl_seconds: 3600 });
await bk['qa-engineer'].call('set_status',        { status: 'working', detail: 'Regression run on WP 6.9 multisite', ttl_seconds: 3600 });
await bk['wp-developer'].call('set_status',       { status: 'working', detail: 'Porting the booking widget to the block editor', ttl_seconds: 3600 });

/* Tasks, oldest first; ids are assigned in this order and the activity log is
   read newest-first. TrailTracker: 2 open · 1 claimed; Bookinator: 1 open;
   Ledgerino: 1 done (seeded below, by SQL, because nobody there is on line). */
await tt['project-manager'].call('open_task', { title: 'Capture App Store screenshots (6.7-inch phone + 13-inch iPad)',
  body: 'Fresh set from the release build, all four launch locales.', assignee: 'app-developer' });          // 1
await tt['project-manager'].call('open_task', { title: 'Stage the release-candidate regression run', assignee: 'qa-engineer' }); // 2
await bk['wp-developer'].call('open_task', { title: 'Verify refund flow against WooCommerce 10.2', assignee: 'qa-engineer' });  // 3
await bk['wp-developer'].call('send_message', { to: 'qa-engineer', body: 'Multisite fixtures are refreshed — rerun whenever.' });
await tt['marketing-site-dev'].call('open_task', { title: 'Confirm security claims for the marketing page', assignee: 'api-developer' }); // 4
await tt['marketing-site-dev'].call('send_message', { to: 'api-developer',
  body: 'For the security page — can we say "all sync tokens are encrypted at rest"? Need a yes/no and one sentence of specifics.' });
await tt['designer'].call('send_message', { to: 'app-developer',
  body: 'Need the 6.7-inch screenshot set for the store listing — matching the new onboarding flow, please.' });
await tt['api-developer'].call('claim_task', { id: 4 });
await tt['marketing-site-dev'].call('send_message', { to: 'app-developer',
  body: 'Which onboarding screens are final? The landing-page hero uses the first three.' });
await tt['api-developer'].call('set_contract', { key: 'security.claims',
  value: { tokens_at_rest: 'AES-256 (keychain-wrapped)', transport: 'TLS 1.3', last_audit: '2026-08' } });

/* Ledgerino: a done task from three weeks ago, nobody on line since. The agents
   rows carry an old last_seen so the signs read the derived `idle` rather than
   nothing — a desk with no sign is a desk the board has never heard of. */
db.prepare(`INSERT INTO agents (channel, agent, last_seen) VALUES (?,?,datetime('now','-2 days'))
  ON CONFLICT(channel, agent) DO UPDATE SET last_seen=excluded.last_seen`).run(LD, 'desktop-dev');
db.prepare(`INSERT INTO agents (channel, agent, last_seen) VALUES (?,?,datetime('now','-2 days'))
  ON CONFLICT(channel, agent) DO UPDATE SET last_seen=excluded.last_seen`).run(LD, 'designer');
db.prepare(`INSERT INTO tasks (channel, title, body, assignee, status, claimed_by, note, created_by, created_at, updated_at)
  VALUES (?,?,?,?,?,?,?,?,datetime('now','-21 days'),datetime('now','-16 days'))`)
  .run(LD, 'Q3 reconciliation export formats', null, 'desktop-dev', 'done', 'desktop-dev', 'Shipped in 1.8.2', 'project-manager');

/* Ages. The activity log reads newest-first with a relative time on every row,
   and a log that says "0m ago" twelve times is a fixture, not a morning. */
const age = (table, id, minutes) =>
  db.prepare(`UPDATE ${table} SET created_at = datetime('now', ?) WHERE id = ?`).run(`-${minutes} minutes`, id);
age('tasks', 1, 56); age('tasks', 2, 56); age('tasks', 3, 45); age('tasks', 4, 24);
// An open task whose updated_at is later than its created_at reads in the
// activity log as "task reopened" (the stale-claim case). Backdating only
// created_at made three of those; the open ones move both.
db.prepare(`UPDATE tasks SET updated_at = created_at WHERE status = 'open'`).run();
age('messages', 1, 37); age('messages', 2, 23); age('messages', 3, 20); age('messages', 4, 12);
db.prepare(`UPDATE tasks SET updated_at = datetime('now', '-14 minutes') WHERE id = 4`).run();
db.prepare(`UPDATE contract_history SET updated_at = datetime('now', '-4 minutes')`).run();
db.prepare(`UPDATE contracts SET updated_at = datetime('now', '-4 minutes')`).run();

/* ---------- the windows, their hook state, and the conversations ---------- */

const sessions = desks.map((d) => ({ ...d, session_id: `sess-${d.window}`, branch: d.agent === 'app-developer' ? 'release/2.0' : 'main' }));

await post('/api/host/events', { host_id: HOST,
  events: sessions.map(({ channel, agent, session_id, cwd }) => ({ type: 'session', channel, agent, session_id, cwd })) });

const ingest = (s, event, extra = {}) =>
  post('/api/ingest', { channel: s.channel, agent: s.agent, session_id: s.session_id, cwd: s.cwd, git_branch: s.branch,
    model: 'claude-opus-5-5', permission_mode: 'default', hook_event_name: event, ...extra });

/* `working` is the host's state: a UserPromptSubmit starts it and a Stop ends
   it. The desks that read as working (thought trail, typing monitor) get no
   Stop; the ones standing by get one. */
const working = new Set(['project-manager', 'designer', 'app-developer', 'api-developer', 'wp-developer']);
const bkWorking = new Set(['wp-developer', 'qa-engineer']);
for (const s of sessions) {
  await ingest(s, 'UserPromptSubmit');
  const w = s.channel === TT ? working.has(s.agent) : bkWorking.has(s.agent);
  if (!w) await ingest(s, 'Stop');
}

/* Conversations. The bubble takes the newest assistant-or-thinking text and a
   user turn newer than it reads as "Thinking…", so every desk ends on the
   agent's words; the monitor types the latest tool turn. */
const T = (s, role, text, tool_name = null, tool_input = null) =>
  ({ type: 'turn', channel: s.channel, agent: s.agent, session_id: s.session_id, role, text, tool_name, tool_input });
const S = (channel, agent) => sessions.find((x) => x.channel === channel && x.agent === agent);

const app = S(TT, 'app-developer'), api = S(TT, 'api-developer'), pm = S(TT, 'project-manager'), des = S(TT, 'designer');
const site = S(TT, 'marketing-site-dev'), qa = S(TT, 'qa-engineer');
const bkp = S(BK, 'wp-developer'), bkq = S(BK, 'qa-engineer'), bkpm = S(BK, 'project-manager');

await post('/api/host/events', { host_id: HOST, events: [
  // Capture 1's panel: the App Developer, mid-capture, about to ask permission.
  T(app, 'user', 'Release build is green. Capture the App Store screenshot set — 6.7-inch phone and 13-inch iPad — and drop them in the launch folder.'),
  T(app, 'assistant', 'Build verified on the release scheme. Running the capture across all four launch locales now.'),
  T(app, 'tool', null, 'Bash', { command: "bundle exec fastlane snapshot --devices 'iPhone 17 Pro Max,iPad Pro 13-inch'" }),

  // Capture 4's panel: the API Developer, a four-turn conversation, no prompt.
  T(api, 'user', 'Marketing needs a yes/no on "all sync tokens are encrypted at rest" for the security page, plus one sentence of specifics.'),
  T(api, 'assistant', 'Checking the token store on both platforms before I answer — iOS is keychain-wrapped, Android I need to confirm.'),
  T(api, 'tool', null, 'Read', { file_path: 'Sources/Sync/TokenStore.swift' }),
  T(api, 'assistant', 'Token audit so far: keychain on device, AES-256 at rest, TLS 1.3 in transit. Confirming the Android Keystore path next.'),

  T(pm, 'user', 'Where are we on the Thursday launch checklist?'),
  T(pm, 'assistant', 'Launch checklist updated — App Store screenshots and the security claims are the two open items; QA is staged.'),
  T(pm, 'tool', null, 'Read', { file_path: 'launch/checklist.md' }),

  T(des, 'user', 'Export the store listing artwork at 2048 and hand the app developer the screenshot brief.'),
  T(des, 'assistant', 'Store listing artwork exported — asked App Developer for the 6.7-inch screenshot set to match.'),
  T(des, 'tool', null, 'Bash', { command: 'sips -Z 2048 exports/*.png' }),

  T(site, 'user', 'Draft the launch page and get the security claims confirmed before it goes up.'),
  T(site, 'assistant', 'Launch page draft is up — holding the security section until the API Developer confirms the claims.'),

  T(qa, 'user', 'Stage the regression run for the release candidate.'),
  T(qa, 'assistant', 'Standing by for the release candidate — the regression suite is staged and ready.'),

  T(bkp, 'user', 'Port the booking widget to the block editor.'),
  T(bkp, 'assistant', 'Block-editor port compiles clean — wiring the availability picker to the new block attributes now.'),
  T(bkp, 'tool', null, 'Edit', { file_path: 'src/blocks/booking-widget/edit.js' }),

  T(bkq, 'user', 'Run the multisite regression on WP 6.9.'),
  T(bkq, 'assistant', 'Multisite regression on WP 6.9 under way.'),
  T(bkq, 'tool', null, 'Bash', { command: 'wp-env run tests-cli wp plugin list' }),

  T(bkpm, 'user', 'Anything for you here this week?'),
  T(bkpm, 'assistant', 'Standing by. Nudge me when you need me.'),
] });

/* The badge: an ordinary tool permission on the App Developer's desk. The
   server queues a 'prompt' work item asking the host to read the window's
   options; no host answers here, so `read` stays false and the panel draws
   Approve / Deny / Cancel — the menu, which is what a permission request is. */
await ingest(app, 'PermissionRequest', { tool_name: 'Bash',
  tool_input: { command: "bundle exec fastlane snapshot --devices 'iPhone 17 Pro Max,iPad Pro 13-inch'" } });
db.prepare(`UPDATE agent_sessions SET awaiting_since = datetime('now', '-4 minutes') WHERE session_id = ?`).run(app.session_id);

/* A morning, not a fixture: statuses set a few minutes ago, conversations a
   little older than the prompt they led to. The MCP sessions stay live, so
   presence still reads CONNECTED; only the ages move. */
db.prepare(`UPDATE agents SET status_at = datetime('now', '-4 minutes'), last_action_at = datetime('now', '-4 minutes') WHERE status IS NOT NULL`).run();
db.prepare(`UPDATE turns SET created_at = datetime('now', '-11 minutes') WHERE role = 'user'`).run();
db.prepare(`UPDATE turns SET created_at = datetime('now', '-10 minutes') WHERE role != 'user'`).run();

console.log('seeded. verifying through /api/floor:');
const floor = await (await fetch(`${BASE}/api/floor`)).json();
for (const room of floor.channels) {
  console.log(`${room.channel}: ${room.live}/${room.desks.length} here · ${room.awaiting} need you`);
  for (const d of room.desks) {
    const deskState = !d.live ? 'away' : d.session?.awaiting_kind ? 'needs-you' : d.working ? 'working' : 'here';
    console.log(
      `  ${d.agent.padEnd(19)} ${deskState.padEnd(9)}`,
      `plate="${d.hosted ? (d.hosted.live ? 'ready' : 'host offline') : d.reporting ? '' : 'not reporting'}"`,
      `sign="${(d.board?.state?.detail ?? d.board?.state?.label ?? '').slice(0, 36)}"`,
      `pills=[u${d.board?.unread ?? 0} a${d.board?.assigned_open ?? 0} c${d.board?.claimed_tasks?.length ?? 0}]`,
      `bell=${d.nudge?.ok ? 'live' : 'BLOCKED'}`,
      `bubble="${(d.heard ? 'Thinking…' : d.last_message?.text ?? '').slice(0, 36)}"`,
    );
  }
}
console.log(`header: ${floor.totals?.floors ?? floor.channels.length} floors · ${JSON.stringify(floor.totals ?? {})}`);

setInterval(() => db.prepare(`UPDATE hosts SET last_seen=datetime('now') WHERE host_id=?`).run(HOST), 2000);
console.log('heartbeat running — leave this process up while shooting');

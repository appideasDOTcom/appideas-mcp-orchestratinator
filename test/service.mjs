// The board's half of the service round (2026-11-24; contracts service.plan
// and board.relay, mirrored in docs/service/): buildings, and a request
// relayed through the desktop app's tunnel. Two real servers: one with no
// relay secret (every Docker board) and one with one (the app's built-in
// board). Every refusal is read off the server's own answer.
//   npm run test:service
import './../src/node-floor.js';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.SERVICE_TEST_PORT ?? 8903);
const PORT2 = PORT + 1;
const SECRET = 'a'.repeat(32) + 'b'.repeat(32);
const KEY = 'service-suite-key';
const DBS = [`./data/service-${process.pid}.db`, `./data/service-relay-${process.pid}.db`];

let failures = 0;
const assert = (cond, msg, extra = '') => { console.log(`  ${cond ? '✓' : '✗'} ${msg}${cond || !extra ? '' : `  (${extra})`}`); if (!cond) failures++; };
const eq = (a, b, msg) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  assert(ok, ok ? msg : `${msg}\n      got  ${JSON.stringify(a)}\n      want ${JSON.stringify(b)}`);
};
const rmDb = () => { for (const d of DBS) for (const ext of ['', '-wal', '-shm']) rmSync(d + ext, { force: true }); };

function start(port, db, extra = {}) {
  const out = { text: '' };
  const proc = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_PATH: db, ORCH_AUTH_TOKEN: KEY, ORCH_AUTH_MODE: 'enforce', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => { out.text += d; });
  proc.stderr.on('data', (d) => { out.text += d; });
  return { proc, out };
}
async function up(port) {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true; } catch { /* not yet */ } await sleep(100); }
  return false;
}

const sign = (payload, secret = SECRET) => {
  const raw = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return { 'x-orch-relay': raw, 'x-orch-relay-sig': createHmac('sha256', secret).update(raw, 'utf8').digest('hex') };
};
const ORIGIN = `http://b7k2.localhost:8780`;
const owner = (over = {}) => ({ v: 1, op: 'op_chris', name: 'Chris', role: 'owner', origin: ORIGIN, iat: Date.now(), ...over });

rmDb();
const plain = start(PORT, DBS[0], { ORCH_RELAY_SECRET: '' });
const relayed = start(PORT2, DBS[1], { ORCH_RELAY_SECRET: SECRET });
const A = `http://127.0.0.1:${PORT}`;
const B = `http://127.0.0.1:${PORT2}`;
const post = (base, path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const json = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });
const mcpPost = (base, channel, agent, body) => fetch(`${base}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-orchestratinator-key': KEY, 'x-channel': channel, 'x-agent': agent },
  body: JSON.stringify(body),
});
/** Make a floor the way an agent does: an MCP connect and one message. */
async function floor(base, channel) {
  const init = await mcpPost(base, channel, 'dev', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  const sid = init.headers.get('mcp-session-id');
  await init.text();
  const r = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-orchestratinator-key': KEY, 'x-channel': channel, 'x-agent': 'dev', 'mcp-session-id': sid },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'send_message', arguments: { body: `hello from ${channel}` } } }),
  });
  await r.text();
}

try {
  assert(await up(PORT) && await up(PORT2), 'both boards came up');

  console.log('\nbuildings: a board from before has one, and every floor is in it');
  {
    await floor(A, 'alpha');
    await floor(A, 'beta');
    const { body } = await json(await fetch(`${A}/api/buildings`));
    eq(body.buildings.length, 1, 'one building');
    const main = body.buildings[0];
    eq([main.name, main.default, main.floors], ['Headquarters', true, ['alpha', 'beta']], 'it is the default, "Headquarters", and holds every floor');
    assert(/^b_[a-z2-7]{10}$/.test(main.id), `its id is opaque, b_ and ten base32 (${main.id})`);
    const st = await (await fetch(`${A}/api/state`)).json();
    const fl = await (await fetch(`${A}/api/floor`)).json();
    eq([st.buildings.length, fl.buildings.length], [1, 1], 'both payloads list it');
    eq([...st.channels.map((c) => c.building), ...fl.channels.map((c) => c.building)], Array(4).fill(main.id), 'every floor on both payloads names it');
  }

  console.log('\nbuildings: make, rename, move a floor, and the refusals');
  {
    const made = await json(await post(A, '/api/admin/building/create', { name: '  Lab  ' }));
    eq([made.status, made.body.name], [200, 'Lab'], 'a building is made, its name trimmed');
    const lab = made.body.id;
    eq((await json(await post(A, '/api/admin/building/create', { name: 'lab' }))).body, { error: 'There is already a building called "Lab".', code: 'bad_name' }, 'a name taken in another case is refused, naming the one there');
    eq((await json(await post(A, '/api/admin/building/create', { name: '   ' }))).status, 400, 'an empty name is refused');
    eq((await json(await post(A, '/api/admin/building/create', { name: 'x'.repeat(61) }))).status, 400, 'a name over 60 characters is refused');
    eq((await json(await post(A, '/api/admin/building/create', { name: 'two\nlines' }))).status, 400, 'a name of two lines is refused');
    eq((await json(await post(A, '/api/admin/floor/building', { channel: 'beta', building: lab }))).body, { ok: true, channel: 'beta', building: lab, moved: true }, 'a floor moves to it');
    const { body } = await json(await fetch(`${A}/api/buildings`));
    eq(body.buildings.map((b) => [b.name, b.floors]), [['Headquarters', ['alpha']], ['Lab', ['beta']]], 'each building holds its own floors, the default first');
    const st = await (await fetch(`${A}/api/state`)).json();
    eq(st.channels.find((c) => c.channel === 'beta').building, lab, 'the board payload says where the floor went');
    eq((await json(await post(A, '/api/admin/floor/building', { channel: 'nowhere', building: lab }))).status, 404, 'a floor the board does not have is refused');
    eq((await json(await post(A, '/api/admin/floor/building', { channel: 'alpha', building: 'b_nope' }))).status, 404, 'a building the board does not have is refused');
    const del = await json(await post(A, '/api/admin/building/delete', { id: lab }));
    eq([del.status, del.body.code, del.body.floors], [409, 'building_not_empty', ['beta']], 'a building with a floor is not deleted, and says which');
    const mainId = body.buildings[0].id;
    eq((await json(await post(A, '/api/admin/building/delete', { id: mainId }))).body.code, 'default_building', 'the default building is never deleted');
    eq((await json(await post(A, '/api/admin/building/rename', { id: mainId, name: 'Home' }))).body.name, 'Home', 'the default can be renamed');
    await post(A, '/api/admin/channel/archive', { channel: 'beta' });
    eq((await json(await post(A, '/api/admin/building/delete', { id: lab }))).body.code, 'building_not_empty', 'an archived floor still holds its building');
    await post(A, '/api/admin/floor/building', { channel: 'beta', building: mainId });
    eq((await json(await post(A, '/api/admin/building/delete', { id: lab }))).body, { ok: true, id: lab, deleted: true }, 'an empty building is deleted');
    // The default is a checkmark that moves (costmo, 2026-11-27). Floors in
    // the old default stay where they are: only floors that arrive later
    // land in the new one.
    const garage = (await json(await post(A, '/api/admin/building/create', { name: 'Garage' }))).body.id;
    eq((await json(await post(A, '/api/admin/building/default', { id: garage }))).body, { ok: true, id: garage, name: 'Garage', moved: true }, 'another building can be made the default');
    const after = (await json(await fetch(`${A}/api/buildings`))).body.buildings;
    eq(after.map((b) => [b.name, b.default, b.floors]), [['Garage', true, []], ['Home', false, ['alpha', 'beta']]], 'the new default lists first and empty, and the old one keeps its floors');
    eq((await json(await post(A, '/api/admin/building/delete', { id: mainId }))).body.code, 'building_not_empty', 'the old default is an ordinary building now: refused only for its floors');
    eq((await json(await post(A, '/api/admin/building/delete', { id: garage }))).body.code, 'default_building', 'and the new default is the one that cannot be deleted');
    eq((await json(await post(A, '/api/admin/building/default', { id: 'b_nope' }))).status, 404, 'a building the board does not have cannot be made the default');
    eq((await json(await post(A, '/api/admin/building/default', { id: garage }))).body.moved, false, 'making the default the default changes nothing');
    await post(A, '/api/admin/building/default', { id: mainId });
    eq((await json(await post(A, '/api/admin/building/delete', { id: garage }))).status, 200, 'the default moved back, the empty building goes');
    const acts = (await (await fetch(`${A}/api/activity?limit=200`)).json()).rows.map((r) => r.kind);
    for (const k of ['admin.building.create', 'admin.building.rename', 'admin.building.delete', 'admin.floor.building', 'admin.building.default']) assert(acts.includes(k), `the audit trail has ${k}`);
    const cross = await json(await post(A, '/api/admin/building/create', { name: 'Evil' }, { origin: 'https://evil.example' }));
    eq(cross.status, 403, 'a building is not made from another site (the CSRF lock covers the new routes)');
  }

  console.log('\nbuildings: a backup carries them, and a one-floor restore keeps where the floor is here');
  {
    const lab = (await json(await post(A, '/api/admin/building/create', { name: 'Lab' }))).body.id;
    await post(A, '/api/admin/floor/building', { channel: 'alpha', building: lab });
    const backup = await (await fetch(`${A}/api/admin/backup`)).json();
    assert(Array.isArray(backup.tables.buildings) && backup.tables.buildings.length === 2, 'a backup holds the buildings table');
    const old = JSON.parse(JSON.stringify(backup));
    delete old.tables.buildings;
    for (const r of old.tables.channel_flags) delete r.building_id;
    const restore = await json(await post(A, '/api/admin/backup/restore', { confirm: 'RESTORE', backup: old }));
    eq(restore.status, 200, 'a backup from before buildings restores');
    const after = (await (await fetch(`${A}/api/buildings`)).json()).buildings;
    eq(after.filter((b) => b.default).length, 1, 'and there is still exactly one default after it');
    eq(after.find((b) => b.default).floors.includes('alpha'), true, 'a floor the file filed nowhere is in the default');
    const emptied = JSON.parse(JSON.stringify(backup));
    emptied.tables.buildings = [];
    eq((await json(await post(A, '/api/admin/backup/restore', { confirm: 'RESTORE', backup: emptied }))).status, 200, 'a file whose buildings table is empty restores');
    const made = (await (await fetch(`${A}/api/buildings`)).json()).buildings;
    eq([made.length, made[0]?.default, made[0]?.name, made[0]?.floors], [1, true, 'Headquarters', ['alpha', 'beta']], 'and a default is made, holding every floor (their building ids name nothing here)');
    const whole = await json(await post(A, '/api/admin/backup/restore', { confirm: 'RESTORE', backup }));
    eq(whole.status, 200, 'a backup with buildings restores');
    const back = (await (await fetch(`${A}/api/buildings`)).json()).buildings;
    eq(back.map((b) => [b.id, b.floors]), backup.tables.buildings.map((b) => [b.id, b.id === lab ? ['alpha'] : ['beta']]), 'the file\'s buildings, ids and floors come back as they were');
    // One floor from a file whose building ids are another board's.
    const foreign = JSON.parse(JSON.stringify(backup));
    for (const r of foreign.tables.channel_flags) if (r.channel === 'alpha') r.building_id = 'b_elsewhere0';
    const one = await json(await post(A, '/api/admin/backup/restore-floor', { channel: 'alpha', confirm: 'alpha', backup: foreign }));
    eq(one.status, 200, 'one floor restores from a file whose building ids are another board\'s');
    const still = (await (await fetch(`${A}/api/buildings`)).json()).buildings;
    eq(still.find((b) => b.id === lab)?.floors, ['alpha'], 'and the floor stays in the building it is in here');
  }

  console.log('\nTake a desk: a new floor is made in the building shown, and an existing one is not moved');
  {
    const src = readFileSync('src/floor.js', 'utf8');
    assert(src.includes("if (building && !store.listAllChannels().includes(channel) && store.listBuildings().some((b) => b.id === building))"), 'the take route files only a floor that does not exist yet, in a building that does');
    const app = readFileSync('src/ui/app.js', 'utf8');
    assert(app.includes("return fm.channel === '__new__' && b ? { building: b } : {};"), 'the dialog sends the building only for a floor typed new');
  }

  console.log('\nthe page: what it decides about buildings');
  {
    const src = readFileSync('src/ui/app.js', 'utf8');
    const a = src.indexOf('/* ---------- buildings: what the page decides ---------- */');
    const b = src.indexOf('/* ---------- end buildings ---------- */');
    const p = src.indexOf('/* ---------- put away: what the pills read ---------- */');
    const q = src.indexOf('/* ---------- put away: the pills ---------- */');
    assert(a > 0 && b > a && p > 0 && q > p, 'both sections are where their markers say');
    const tmp = `./data/buildings-${process.pid}.mjs`;
    const escFn = `const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));\n`;
    writeFileSync(tmp, `${escFn}${src.slice(p, q)}\n${src.slice(a, b)}\nexport { onBoard, putAway, buildingNow, inBuildingNow, buildingChips, buildingHref };\n`);
    let m;
    try { m = await import(new URL(tmp, `file://${process.cwd()}/`)); } finally { rmSync(tmp, { force: true }); }
    const bs = [{ id: 'b_main', name: 'Headquarters', default: true }, { id: 'b_lab', name: 'Lab', default: false }];
    eq(m.buildingNow(bs, 'b_lab'), 'b_lab', 'the building asked for, when the board has it');
    eq(m.buildingNow(bs, 'b_gone'), 'b_main', 'else the default (a building deleted, or another board\'s address)');
    eq(m.buildingNow(bs, null), 'b_main', 'and the default when nothing is asked');
    eq(m.buildingNow([], 'b_lab'), null, 'nothing before the first payload');
    const chs = [{ channel: 'a', building: 'b_main' }, { channel: 'b', building: 'b_lab' }, { channel: 'c', building: 'b_lab', archived: true }, { channel: 'd' }, { channel: 'e', building: 'b_main', archived: true }];
    eq(m.onBoard(chs, 'b_lab').map((c) => c.channel), ['b', 'd'], 'the building\'s floors are its cards, and a floor filed nowhere is never lost');
    eq(m.putAway(chs, 'b_lab').map((c) => c.channel), ['c'], 'and its pills, not another building\'s');
    eq(m.onBoard(chs, 'b_main').map((c) => c.channel), ['a', 'd'], 'the other building shows its own');
    eq(m.onBoard(chs).map((c) => c.channel), ['a', 'b', 'd'], 'with no building known, every floor, as before buildings');
    eq(m.buildingChips([bs[0]], 'b_main'), '', 'one building draws no picker');
    const chips = m.buildingChips(bs, 'b_lab');
    assert(chips.includes('data-building="b_lab"') && chips.includes('class="chip on"') && (chips.match(/<a /g) ?? []).length === 2, 'two buildings draw a chip each, the one shown lit');
    assert(chips.includes(`href="${m.buildingHref('b_main').replace(/&/g, '&amp;')}"`) && m.buildingHref('b_main') === '?building=b_main&floor=', 'each chip is a link to its building on all floors, so ⌘-click opens it elsewhere');
    assert(m.buildingChips([{ id: 'x', name: '<b>', default: true }, { id: 'y', name: 'y' }], 'x').includes('&lt;b&gt;'), 'a building\'s name is escaped');
    // Seen remotely, the page says where the building is (costmo, 2026-11-25).
    const one = m.buildingChips([bs[0]], 'b_main', 'costmo4.local');
    assert(one.includes('Headquarters') && one.includes('at costmo4.local') && !one.includes('<a '), 'remotely, one building reads "Headquarters at costmo4.local", as a label and not a chip');
    const two = m.buildingChips(bs, 'b_lab', 'costmo4.local');
    assert((two.match(/<a /g) ?? []).length === 2 && two.endsWith('<span class="muted bld-at">at costmo4.local</span>'), 'with two, the chips and then "at costmo4.local"');
    assert(!m.buildingChips(bs, 'b_lab').includes(' at '), 'at the keyboard, no machine is named');
  }

  console.log('\nthe page: the boards this operator was invited into (costmo, 2026-11-27)');
  {
    const src = readFileSync('src/ui/app.js', 'utf8');
    const a = src.indexOf('/* ---------- guest boards: what the page decides ---------- */');
    const b = src.indexOf('/* ---------- end guest boards ---------- */');
    assert(a > 0 && b > a, 'the section is where its markers say');
    const tmp = `./data/guest-boards-${process.pid}.mjs`;
    const escFn = `const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));\n`;
    writeFileSync(tmp, `${escFn}${src.slice(a, b)}\nexport { guestBoardsList, guestBoardTitle, guestBoardUrl, guestBoardsHtml, guestBoardHere };\n`);
    let m;
    try { m = await import(new URL(tmp, `file://${process.cwd()}/`)); } finally { rmSync(tmp, { force: true }); }
    eq(m.guestBoardsList(null), [], 'nothing said is no boards');
    const list = m.guestBoardsList([
      { id: 'brd_a', name: 'Pat\'s Mac', label: '  Design  ', state: 'available' },
      { id: 'brd_b', name: 'Studio', state: 'blocked', why: 'The owner turned sharing off.' },
      { id: 'brd_c', state: 'weird' },
      { id: 'brd_a', name: 'again' },
      { name: 'no id' },
    ]);
    eq(list.map((x) => [x.id, x.label, x.state]), [['brd_a', 'Design', 'available'], ['brd_b', 'Studio', 'blocked'], ['brd_c', 'brd_c', 'unknown']],
      'a label wins over the name, the name over the id; a state the page does not know is unknown; a repeated or missing id is dropped');
    const t = m.guestBoardTitle(list[0]);
    assert(t.startsWith('Design — Available') && t.includes("(Pat's Mac)") && t.includes('Right-click to rename'), 'the hover says the state in words and the board\'s own name under a label');
    assert(m.guestBoardTitle(list[1]).includes('The owner turned sharing off.'), 'and the app\'s reason when it gives one');
    eq(m.guestBoardUrl('/', 'brd_a'), '/?guest_board=brd_a', 'open is the board id on this page\'s address');
    eq(m.guestBoardUrl('/', 'brd_a', ' Ops & Co '), '/?guest_board=brd_a&label=Ops+%26+Co', 'a label is trimmed and encoded');
    eq(m.guestBoardUrl('/', 'brd_a', ''), '/?guest_board=brd_a&label=', 'an empty label asks for the board\'s own name back');
    const html = m.guestBoardsHtml(list);
    for (const [state, glyph] of [['available', '✓'], ['blocked', '!'], ['unknown', '–']]) assert(html.includes(`class="gb ${state}"`) && html.includes(`>${glyph}</span>`), `${state} is an outline class and a glyph (${glyph}), never a colour alone`);
    assert(m.guestBoardsHtml(m.guestBoardsList([{ id: 'x', name: '<img>' }])).includes('&lt;img&gt;'), 'a board\'s name is escaped');
    // The board this window shows is a label, never a button that opens a second copy of it (costmo, 2026-11-28).
    const two = m.guestBoardsList([{ id: 'a', name: 'A', here: true, state: 'available' }, { id: 'b', name: 'B', here: true }, { id: 'c', name: 'C', here: 'yes' }]);
    eq(two.map((x) => x.here), [true, false, false], 'one board at most is here, and only when the app says true');
    eq(m.guestBoardHere(two)?.id, 'a', 'and the page can name it');
    eq(m.guestBoardHere(m.guestBoardsList([{ id: 'a' }])), null, 'none, in the person\'s own window');
    const hh = m.guestBoardsHtml(two);
    const hereChip = hh.slice(0, hh.indexOf('data-guest-board="b"'));
    assert(hereChip.includes('aria-current="page"') && !hereChip.includes('data-gb="open"') && !hereChip.includes('<button'), 'the board here is a label: no button, nothing that opens');
    assert(hh.slice(hh.indexOf('data-guest-board="b"')).includes('data-gb="open"'), 'the others still open');
    assert(m.guestBoardTitle(two[0]).includes('You are on this board'), 'its hover says so');
  }

  console.log('\nthe page: what it says when its board does not answer');
  {
    const src = readFileSync('src/ui/floor.js', 'utf8');
    const fn = src.match(/  function boardDownWords\(status, code\) \{[\s\S]*?\n  \}\n/)?.[0];
    assert(!!fn, 'boardDownWords is in floor.js');
    const words = new Function(`${fn}; return boardDownWords;`)();
    assert(/offline, or its Orchestratinator app was quit/.test(words(503, 'board_offline')), 'the service\'s board_offline: the computer is offline or the app was quit');
    assert(/session for this board has ended/.test(words(401, 'session_required')), 'a session that ended: sign in again');
    assert(/isn.t answering/.test(words(0, null)) && /isn.t answering/.test(words(502, 'board_unreachable')), 'no answer at all, or the tunnel dropped: the board is not answering');
    for (const w of [words(503, 'board_offline'), words(401, null), words(0, null)]) assert(/Nothing can be sent|Sign in again/.test(w), `each says what follows from it: "${w.slice(0, 40)}…"`);
    assert(src.includes('const canChat = !!h?.live && !held && !ui.boardDown;'), 'and the desk\'s box takes nothing while it stands');
  }

  console.log('\nbuildings: the default is Headquarters, and a board from the first day is renamed once');
  {
    const { openDb, makeStore } = await import('../src/db.js');
    const path = `./data/service-mig-${process.pid}.db`;
    for (const ext of ['', '-wal', '-shm']) rmSync(path + ext, { force: true });
    let db = openDb(path);
    eq(makeStore(db).listBuildings().map((b) => b.name), ['Headquarters'], 'a new board\'s default is Headquarters');
    // The board 4bdd410 made: a default called Main, and no migration row.
    db.prepare("UPDATE buildings SET name = 'Main' WHERE is_default = 1").run();
    db.prepare("DELETE FROM settings WHERE key = 'migration.headquarters'").run();
    db.close();
    db = openDb(path);
    eq(makeStore(db).listBuildings().map((b) => b.name), ['Headquarters'], 'a default still called Main takes the new name at the next start');
    db.prepare("UPDATE buildings SET name = 'Main' WHERE is_default = 1").run();
    db.close();
    db = openDb(path);
    eq(makeStore(db).listBuildings().map((b) => b.name), ['Main'], 'once: a building the operator names Main afterwards keeps it');
    db.close();
    for (const ext of ['', '-wal', '-shm']) rmSync(path + ext, { force: true });
  }

  console.log('\nrelay: a board with no secret refuses a relayed request, never serves it as local');
  {
    const r = await json(await fetch(`${A}/api/floor`, { headers: sign(owner()) }));
    eq([r.status, r.body.code], [403, 'relay_not_configured'], 'a well-signed request to a Docker board is refused');
    const half = await json(await fetch(`${A}/api/state`, { headers: { 'x-orch-relay-sig': 'ab' } }));
    eq(half.body.code, 'relay_not_configured', 'a signature header alone is refused too');
    assert(plain.out.text.includes('relay     OFF'), 'its start says relay OFF');
    eq((await fetch(`${A}/api/state`)).status, 200, 'and a request with neither header is as it always was');
  }

  console.log('\nrelay: the app\'s board verifies, and refuses each fault in its own words');
  {
    assert(relayed.out.text.includes('relay     ON (secret set, 64 chars)') && !relayed.out.text.includes(SECRET), 'its start says relay ON with the secret\'s length, never the secret');
    eq((await fetch(`${B}/api/state`, { headers: sign(owner()) })).status, 200, 'an owner\'s signed request is served');
    eq((await fetch(`${B}/api/state`)).status, 200, 'a request with no relay header is served as before');
    const code = async (headers, path = '/api/state') => (await json(await fetch(`${B}${path}`, { headers }))).body?.code;
    eq(await code(sign(owner(), 'z'.repeat(64))), 'relay_bad_signature', 'signed with another secret: refused');
    const good = sign(owner());
    eq(await code({ ...good, 'x-orch-relay-sig': good['x-orch-relay-sig'].toUpperCase() }), 'relay_bad_signature', 'an uppercase signature is not the contract\'s: refused');
    eq(await code({ 'x-orch-relay': good['x-orch-relay'] }), 'relay_bad_signature', 'a payload with no signature: refused');
    const tampered = Buffer.from(JSON.stringify({ ...owner(), name: 'Mallory' })).toString('base64url');
    eq(await code({ 'x-orch-relay': tampered, 'x-orch-relay-sig': good['x-orch-relay-sig'] }), 'relay_bad_signature', 'a payload changed after signing: refused');
    // The key is the secret string's bytes, not its decoded value (msg 4397).
    const raw = Buffer.from(JSON.stringify(owner())).toString('base64url');
    const decodedKey = createHmac('sha256', Buffer.from(SECRET, 'hex')).update(raw).digest('hex');
    eq(await code({ 'x-orch-relay': raw, 'x-orch-relay-sig': decodedKey }), 'relay_bad_signature', 'signed with the secret\'s decoded bytes: refused (the key is the string as given)');
    eq(await code(sign({ ...owner(), v: 2 })), 'relay_bad_signature', 'an unknown version: refused');
    for (const f of ['op', 'name', 'origin', 'iat', 'role']) {
      const p = owner(); delete p[f];
      eq(await code(sign(p)), 'relay_bad_signature', `no ${f}: refused`);
    }
    eq(await code(sign(owner({ op: 'x'.repeat(65) }))), 'relay_bad_signature', 'an op over 64 characters: refused');
    eq(await code(sign(owner({ origin: `${ORIGIN}/` }))), 'relay_bad_signature', 'an origin with a trailing slash is not an origin: refused');
    eq(await code(sign(owner({ origin: 'javascript:alert(1)' }))), 'relay_bad_signature', 'an origin that is not http(s): refused');
    eq(await code(sign(owner({ role: 'admin' }))), 'relay_role', 'a role other than owner or guest: refused');
    eq(await code(sign(owner({ role: 'guest' }))), 'relay_bad_signature', 'a guest with no buildings: refused as malformed');
    eq(await code(sign(owner({ role: 'guest', buildings: ['x'.repeat(65)] }))), 'relay_bad_signature', 'a guest building id over 64 characters: refused');
    const viewer = (await (await fetch(`${B}/api/floor`, { headers: sign(owner()) })).json()).viewer;
    eq([viewer.remote, viewer.name, typeof viewer.machine === 'string' && viewer.machine.length > 0, viewer.role], [true, 'Chris', true, 'owner'], 'a remote viewer is told it is remote, its name, its role, and the board\'s computer');
    eq((await (await fetch(`${B}/api/state`)).json()).viewer, { remote: false }, 'at the keyboard, not remote and no machine named');
    eq(await code(sign(owner({ iat: Date.now() - 301_000 }))), 'relay_stale', 'signed more than five minutes ago: refused');
    eq(await code(sign(owner({ iat: Date.now() + 301_000 }))), 'relay_stale', 'signed more than five minutes ahead: refused');
    eq(await code({ ...sign(owner()), origin: 'https://evil.example' }), 'relay_cross_origin', 'a page on another site than the one served: refused');
    eq((await fetch(`${B}/api/state`, { headers: { ...sign(owner()), origin: ORIGIN } })).status, 200, 'from the origin it was served on: served');
    const notJson = Buffer.from('not json').toString('base64url');
    eq(await code({ 'x-orch-relay': notJson, 'x-orch-relay-sig': createHmac('sha256', SECRET).update(notJson).digest('hex') }), 'relay_bad_signature', 'a signed payload that is not JSON: refused');
  }

  console.log('\nrelay: the CSRF lock reads the relayed origin, and the remote owner acts as the keyboard does');
  {
    // Host is the loopback; Origin is the public page. Locally that is a
    // cross-origin write and refused; relayed with that origin it is the page.
    const plainCross = await json(await post(B, '/api/admin/building/create', { name: 'NoSig' }, { origin: ORIGIN }));
    eq(plainCross.status, 403, 'unsigned, a write from the public origin is cross-origin and refused');
    const made = await json(await post(B, '/api/admin/building/create', { name: 'Remote' }, { ...sign(owner()), origin: ORIGIN }));
    eq([made.status, made.body.name], [200, 'Remote'], 'signed, the same write from the page it was served on is the owner\'s, and done');
    const rows = (await (await fetch(`${B}/api/activity?limit=50`)).json()).rows;
    const row = rows.find((r) => r.kind === 'admin.building.create');
    eq(row?.actor, 'Chris (remote)', 'the audit row names the remote operator, not the literal "operator"');
    await post(B, '/api/admin/building/create', { name: 'Local' });
    const local = (await (await fetch(`${B}/api/activity?limit=50`)).json()).rows.find((r) => r.kind === 'admin.building.create' && r.detail?.includes('Local'));
    eq(local?.actor, 'operator', 'a write at the keyboard is still "operator"');
  }

  console.log('\nrelay: what opens on the board machine\'s own screen is refused remotely, in words');
  {
    for (const path of ['/api/floor/attach', '/api/floor/claude', '/api/floor/handback', '/api/floor/pick', '/api/floor/signin']) {
      const r = await json(await post(B, path, { channel: 'x', agent: 'y', host_id: 'h' }, { ...sign(owner()), origin: ORIGIN }));
      eq([r.status, r.body.code], [409, 'relay_local_only'], `${path}: 409 relay_local_only`);
      assert(typeof r.body.error === 'string' && /computer the board runs on/.test(r.body.error), `${path}: says why, and what to do instead`);
    }
    const open = await json(await post(B, '/api/floor/open', { channel: 'x', agent: 'y' }, { ...sign(owner()), origin: ORIGIN }));
    assert(open.body?.code !== 'relay_local_only', 'Open on the floor is not one of them (it opens nothing on that screen)');
    const local = await json(await post(B, '/api/floor/attach', { channel: 'x', agent: 'y' }));
    assert(local.body?.code !== 'relay_local_only', 'at the keyboard, Open in Claude is as it was');
  }

  console.log('\nM2: a guest sees only its card\'s buildings, and none of the board\'s administration');
  const hdr = (p) => ({ ...sign(p), origin: ORIGIN });
  const shared = (await json(await post(B, '/api/admin/building/create', { name: 'Shared' }))).body.id;
  await floor(B, 'open-floor');
  await floor(B, 'private');
  await post(B, '/api/admin/floor/building', { channel: 'open-floor', building: shared });
  const guest = (over = {}) => owner({ op: 'op_g', name: 'Gail', role: 'guest', buildings: [shared], ...over });
  {
    const f = await (await fetch(`${B}/api/floor`, { headers: hdr(guest()) })).json();
    eq(f.channels.map((c) => c.channel), ['open-floor'], 'its floor payload holds the shared building\'s floor alone');
    eq(f.buildings.map((b) => b.id), [shared], 'and that building alone');
    eq([f.viewer.role, f.viewer.op], ['guest', 'op_g'], 'and says it is a guest, by its operator id');
    const st = await (await fetch(`${B}/api/state`, { headers: hdr(guest()) })).json();
    eq(st.channels.map((c) => c.channel), ['open-floor'], 'its board payload holds the same floor');
    eq(Object.keys(st.server).sort(), ['now', 'version'], 'and nothing of the board\'s machine: no db path, port or commit');
    const act = (await (await fetch(`${B}/api/activity?limit=100`, { headers: hdr(guest()) })).json()).rows;
    assert(act.length > 0 && act.every((r) => r.channel === 'open-floor'), 'its activity feed is its floors\' only');
    eq((await (await fetch(`${B}/api/buildings`, { headers: hdr(guest()) })).json()).buildings.map((b) => b.id), [shared], 'GET /api/buildings: its building only');
    await post(B, '/api/admin/prompt/create', { title: 'Owner only', content: 'the owner\'s own words' });
    eq((await (await fetch(`${B}/api/prompts`)).json()).prompts.length, 1, 'the fixture: the owner has a saved prompt');
    eq((await (await fetch(`${B}/api/prompts`, { headers: hdr(guest()) })).json()).prompts, [], 'the owner\'s saved prompts are not its');
    // Bounded: a route that wrongly lets the guest through may be a stream
    // that never ends, and that is a red row, not a hung suite.
    const scope = async (method, path, body) => {
      const r = await fetch(`${B}${path}`, { method, signal: AbortSignal.timeout(5000), headers: { ...hdr(guest()), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }).catch((e) => ({ status: 0, json: async () => ({ code: `no answer: ${e.name}` }) }));
      if (/event-stream/.test(r.headers?.get?.('content-type') ?? '')) { r.body?.cancel?.().catch(() => {}); return 'a stream opened'; }
      return (await json(r)).body?.code;
    };
    eq(await scope('POST', '/api/admin/building/create', { name: 'Mine' }), 'relay_guest_scope', 'building admin: refused');
    eq(await scope('GET', '/api/admin/backup'), 'relay_guest_scope', 'a backup: refused');
    eq(await scope('GET', '/api/floor/history/recent'), 'relay_guest_scope', 'history across the owner\'s hosts: refused');
    eq(await scope('GET', '/api/floor/turns?channel=private&agent=dev'), 'relay_guest_scope', 'a floor outside its card, read: refused');
    eq(await scope('POST', '/api/floor/chat', { channel: 'private', agent: 'dev', text: 'hi' }), 'relay_guest_scope', 'a floor outside its card, written: refused');
    eq(await scope('GET', `/api/floor/stream?desks=${encodeURIComponent(JSON.stringify([['open-floor', 'dev'], ['private', 'dev']]))}`), 'relay_guest_scope', 'a stream naming a floor outside its card: refused');
    eq((await json(await fetch(`${B}/api/floor/turns?channel=open-floor&agent=dev`, { headers: hdr(guest()) }))).status, 200, 'its own building\'s floor: read');
    const other = await (await fetch(`${B}/api/floor`, { headers: hdr(guest({ buildings: ['b_unknown000'] })) })).json();
    eq(other.channels.length, 0, 'a card naming a building this board does not have opens nothing');
  }

  console.log('\nM2: whose a desk is, and who may act on it');
  const work = async (hostId, p) => (await (await fetch(`${B}/api/host/work?host_id=${encodeURIComponent(hostId)}&wait=0`, { headers: { 'x-orchestratinator-key': KEY, ...(p ? sign(p) : {}) } })).json()).work ?? [];
  {
    const reg = (hostId, desks, p) => fetch(`${B}/api/host/register`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestratinator-key': KEY, ...(p ? sign(p) : {}) }, body: JSON.stringify({ host_id: hostId, name: hostId, protocol: JSON.parse(readFileSync('package.json', 'utf8')).protocol, desks }) });
    eq((await json(await reg('evil', [], guest()))).body?.code, 'relay_host_id', 'a guest\'s host with an id not its own: refused');
    eq((await json(await reg('op_g~mac', [{ channel: 'open-floor', agent: 'gdev', cwd: '/g/gdev' }, { channel: 'private', agent: 'gx', cwd: '/g/x' }], guest()))).status, 200, 'its own host registers through the relay');
    eq((await json(await reg('h-own', [{ channel: 'open-floor', agent: 'odev', cwd: '/o/odev' }]))).status, 200, 'and the owner\'s host at the keyboard');
    const f = await (await fetch(`${B}/api/floor`)).json();
    const desk = (ch, ag) => f.channels.find((c) => c.channel === ch)?.desks.find((d) => d.agent === ag);
    eq(desk('open-floor', 'gdev')?.hosted?.operator, { op: 'op_g', name: 'Gail' }, 'the guest\'s desk is the guest\'s');
    eq(desk('open-floor', 'odev')?.hosted?.operator, null, 'the owner\'s is the owner\'s');
    eq(desk('private', 'gx')?.hosted ?? null, null, 'a desk the guest\'s host named outside its card was not filed');
    eq([desk('open-floor', 'odev')?.mine, desk('open-floor', 'gdev')?.mine], [true, false], 'for the owner, its own desk is mine and the guest\'s is not');
    const gf = await (await fetch(`${B}/api/floor`, { headers: hdr(guest()) })).json();
    const gdesk = (ag) => gf.channels.find((c) => c.channel === 'open-floor').desks.find((d) => d.agent === ag);
    eq([gdesk('odev')?.mine, gdesk('gdev')?.mine], [false, true], 'for the guest, the other way round');
    // A question on the owner's desk is the owner's to answer: it needs the
    // owner, and not the guest (desktop-dev's walk, Pat's "1 need you").
    await fetch(`${B}/api/host/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestratinator-key': KEY },
      body: JSON.stringify({ host_id: 'h-own', events: [{ type: 'ask', channel: 'open-floor', agent: 'odev', session_id: 's-odev', request_id: 'q-own', kind: 'permission', tool: 'Write', tool_input: { file_path: 'x' }, summary: 'Write: x', options: [{ n: 1, text: 'Yes' }, { n: 3, text: 'No' }] }] }) });
    const asks = async (p) => { const j = await (await fetch(`${B}/api/floor`, { headers: p ? hdr(p) : {} })).json(); return [j.queue.map((q) => q.agent), j.totals.awaiting, j.channels.find((c) => c.channel === 'open-floor').awaiting]; };
    eq(await asks(), [['odev'], 1, 1], 'the owner\'s floor counts its own desk\'s question as needing it');
    eq(await asks(guest()), [[], 0, 0], 'the guest\'s floor does not');
    eq((await json(await reg('op_g~mac', [{ channel: 'open-floor', agent: 'gdev', cwd: '/g/gdev' }, { channel: 'open-floor', agent: 'odev', cwd: '/g/steal' }], guest()))).status, 200, 'the guest\'s host naming the owner\'s desk registers');
    eq((await (await fetch(`${B}/api/floor`)).json()).channels.find((c) => c.channel === 'open-floor').desks.find((d) => d.agent === 'odev').hosted.host_id, 'h-own', 'and the owner\'s desk stays the owner\'s host\'s');
    const act = async (path, body, p) => (await json(await fetch(`${B}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(p ? hdr(p) : {}) }, body: JSON.stringify(body) }))).body?.code;
    eq(await act('/api/floor/interrupt', { channel: 'open-floor', agent: 'gdev' }), 'desk_not_yours', 'the owner at the keyboard cannot stop the guest\'s agent');
    const words = (await json(await fetch(`${B}/api/floor/interrupt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'open-floor', agent: 'gdev' }) }))).body?.error ?? '';
    assert(words.startsWith('That desk is Gail\'s:'), 'and is told whose it is, in a sentence', words);
    eq(await act('/api/floor/interrupt', { channel: 'open-floor', agent: 'odev' }, guest()), 'desk_not_yours', 'the guest cannot stop the owner\'s');
    eq(await act('/api/floor/permission', { channel: 'open-floor', agent: 'odev', request_id: 'r', decision: 'allow' }, guest()), 'desk_not_yours', 'nor answer its prompt');
    eq(await act('/api/floor/permission', { channel: 'open-floor', agent: 'gdev', request_id: 'r', decision: 'allow' }, owner()), 'desk_not_yours', 'nor the owner, relayed, the guest\'s');
    assert(await act('/api/floor/interrupt', { channel: 'open-floor', agent: 'gdev' }, guest()) !== 'desk_not_yours', 'the guest stops its own agent');
    eq(await act('/api/floor/chat', { channel: 'open-floor', agent: 'odev', text: '/model sonnet' }, guest()), 'desk_not_yours', 'a /model from the guest to the owner\'s agent: refused');
    eq(await act('/api/floor/chat', { channel: 'open-floor', agent: 'odev', text: '/compact' }, guest()), 'desk_not_yours', 'any command from the guest to the owner\'s agent: refused');
    // v5 (desktop-dev, 4431): work for a host is its own operator's.
    eq(await act('/api/floor/desk', { host_id: 'op_g~mac', path: '/g/x', channel: 'open-floor', agent: 'z' }), 'host_not_yours', 'the owner cannot take a desk on the guest\'s computer');
    eq(await act('/api/floor/browse', { host_id: 'op_g~mac', path: '/g' }), 'host_not_yours', 'nor browse its folders');
    eq(await act('/api/floor/pick', { host_id: 'op_g~mac' }), 'host_not_yours', 'nor open its folder dialog');
    eq(await act('/api/floor/read', { channel: 'open-floor', agent: 'gdev', session_id: 's' }), 'desk_not_yours', 'nor read the guest\'s agent\'s conversation off its disk');
    eq(await act('/api/floor/browse', { host_id: 'h-own', path: '/o' }, guest()), 'relay_host_id', 'and the guest not the owner\'s host');
    // A name another operator holds is refused at the take, in words, not
    // taken and then silently left unfiled (desktop-dev's M3 walk, b).
    const takeName = await json(await fetch(`${B}/api/floor/desk`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host_id: 'h-own', path: '/o/x', channel: 'open-floor', agent: 'gdev' }) }));
    assert(takeName.status === 403 && takeName.body.code === 'desk_not_yours' && /gdev on open-floor is Gail's desk/.test(takeName.body.error), 'taking a desk under a name the guest holds is refused, naming whose it is', JSON.stringify(takeName.body));
    const folders = async (p) => (await (await fetch(`${B}/api/floor/folders`, { headers: p ? hdr(p) : {} })).json()).hosts.map((h) => h.host_id).sort();
    eq(await folders(), ['h-own'], 'the owner\'s folder lists are its own hosts\'');
    eq(await folders(guest()), ['op_g~mac'], 'the guest\'s are its own');
    assert(await act('/api/floor/browse', { host_id: 'op_g~mac', path: '/g' }, guest()) !== 'host_not_yours', 'the guest browses its own computer');
  }

  console.log('\nM2: every message names its sender when it is not the desk\'s own operator');
  {
    eq((await json(await fetch(`${B}/api/relay/hello`, { headers: sign(guest()) }))).body?.code, 'relay_role', 'a guest cannot say who the owner is');
    eq((await json(await fetch(`${B}/api/relay/hello`, { headers: sign(owner()) }))).body?.owner, { op: 'op_chris', name: 'Chris' }, 'the owner\'s hello names the owner');
    const chat = (agent, text, p) => fetch(`${B}/api/floor/chat`, { method: 'POST', headers: { 'content-type': 'application/json', ...(p ? hdr(p) : {}) }, body: JSON.stringify({ channel: 'open-floor', agent, text }) });
    await work('h-own'); await work('op_g~mac', guest());
    eq((await chat('odev', 'from the guest', guest())).status, 200, 'the guest messages the owner\'s agent');
    eq((await work('h-own')).map((w) => w.payload?.text), ['From Gail:\n\nfrom the guest'], 'and the owner\'s agent is told it is from Gail');
    const ownerChat = await chat('gdev', 'from the owner');
    eq(ownerChat.status, 200, 'the owner at the keyboard messages the guest\'s agent', ownerChat.status === 200 ? '' : await ownerChat.text());
    eq((await work('op_g~mac', guest())).map((w) => w.payload?.text), ['From Chris:\n\nfrom the owner'], 'and the guest\'s agent is told it is from Chris, the name the hello gave');
    await chat('odev', 'my own');
    eq((await work('h-own')).map((w) => w.payload?.text), ['my own'], 'the owner to its own agent: the words alone');
    await chat('gdev', 'my own too', guest());
    eq((await work('op_g~mac', guest())).map((w) => w.payload?.text), ['my own too'], 'the guest to its own agent: the words alone');
    // The turn the agent's transcript records comes back to the page split.
    await fetch(`${B}/api/host/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestratinator-key': KEY }, body: JSON.stringify({ host_id: 'h-own', events: [{ type: 'turn', channel: 'open-floor', agent: 'odev', session_id: 's-odev', role: 'user', text: 'From Gail:\n\nfrom the guest' }] }) });
    const rows = (await (await fetch(`${B}/api/floor/turns?channel=open-floor&agent=odev`)).json()).rows.filter((r) => r.role === 'user');
    eq(rows.map((r) => [r.from ?? null, r.text]), [['Gail', 'from the guest']], 'the page is handed the sender and the words, apart');
    eq((await (await fetch(`${B}/api/floor`)).json()).channels.find((c) => c.channel === 'open-floor').desks.find((d) => d.agent === 'odev').last_turn?.from, 'Gail', 'and the desk\'s last turn says it too');
  }

  console.log('\nM2: an agent through the relay is who its operator\'s host runs');
  {
    const mcp = async (ch, ag, p) => (await json(await fetch(`${B}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...sign(p), 'x-orchestratinator-key': KEY, 'x-channel': ch, 'x-agent': ag }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) }))).body?.code;
    eq(await mcp('private', 'gx', guest()), 'relay_guest_scope', 'a guest\'s agent on a floor outside its card: refused');
    eq(await mcp('open-floor', 'odev', guest()), 'desk_not_yours', 'a guest\'s agent claiming the owner\'s desk: refused');
    // 503, not 403: Claude Code caches a 401/403 on an MCP server as "needs
    // authentication" under its name, which every desk shares (the M3 walk).
    const st = (await fetch(`${B}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...sign(guest()), 'x-orchestratinator-key': KEY, 'x-channel': 'open-floor', 'x-agent': 'odev' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) })).status;
    eq(st, 503, 'and the refusal on /mcp is a 503, which Claude Code does not remember as an auth failure for every desk');
    eq((await fetch(`${B}/api/floor/interrupt`, { method: 'POST', headers: { 'content-type': 'application/json', ...hdr(guest()) }, body: JSON.stringify({ channel: 'open-floor', agent: 'odev' }) })).status, 403, 'off /mcp, the same refusal stays a 403');
    // The relay's own refusals too (QA, PR #66 L3): a hop whose secret
    // drifted, or a stale clock, must not mark every desk needs-auth.
    const forged = Object.fromEntries(Object.entries(sign(guest())).map(([k, v]) => [k, /sig/i.test(k) ? `x${v.slice(1)}` : v]));
    const bad = await fetch(`${B}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...forged, 'x-orchestratinator-key': KEY, 'x-channel': 'open-floor', 'x-agent': 'gdev' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
    eq([bad.status, (await bad.json()).code], [503, 'relay_bad_signature'], 'a signature that does not verify, on /mcp: 503, its code still said');
    eq((await fetch(`${B}/api/floor`, { headers: forged })).status, 403, 'and off /mcp the same signature stays a 403');
    assert(!['desk_not_yours', 'relay_guest_scope'].includes(await mcp('open-floor', 'gdev', guest())), 'its own desk, on its own floor: let through');
    const fresh = await mcp('open-floor', 'newcomer', guest());
    assert(!['desk_not_yours', 'relay_guest_scope'].includes(fresh), `a name no desk holds, on its floor: let through (${fresh})`);
  }

  console.log('\nM3: a guest\'s desk starts reading where its name became that guest\'s');
  {
    // desktop-dev's walk (2026-11-25): a new partner's partner-agent read a
    // meeting room's broadcast from an earlier walk's desk of the same name.
    // A name is the board's whole idea of who an agent is, so a guest's desk
    // under a name the board already knows is handed nothing from before it.
    const session = async (ch, ag, p) => {
      const h = (sid) => ({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-orchestratinator-key': KEY, 'x-channel': ch, 'x-agent': ag, ...(p ? sign(p) : {}), ...(sid ? { 'mcp-session-id': sid } : {}) });
      const init = await fetch(`${B}/mcp`, { method: 'POST', headers: h(), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) });
      const sid = init.headers.get('mcp-session-id'); await init.text();
      let id = 1;
      return async (name, args = {}) => {
        const r = await fetch(`${B}/mcp`, { method: 'POST', headers: h(sid), body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
        const t = await r.text();
        const line = t.split('\n').find((l) => l.startsWith('data:'));
        const msg = JSON.parse(line ? line.slice(5) : t);
        return JSON.parse(msg.result?.content?.[0]?.text ?? 'null') ?? msg;
      };
    };
    const dev = await session('open-floor', 'dev');
    // reuse was somebody's before: it read, then was sent more it never read.
    const before = await session('open-floor', 'reuse');
    await before('poll_messages', {});
    await dev('send_message', { to: 'reuse', body: 'for the reuse that was here before' });
    await dev('send_message', { body: 'a broadcast from before' });
    const bodies = (r) => (r.messages ?? []).map((m) => m.body);
    const unreadOf = async (ag) => (await (await fetch(`${B}/api/state`)).json()).channels.find((c) => c.channel === 'open-floor')?.agents?.find((a) => a.agent === ag)?.unread_list?.length ?? null;
    eq(await unreadOf('reuse'), 2, 'the fixture: the name has two unread on the board');
    const gail = await session('open-floor', 'reuse', guest());
    // Read before any poll: a poll writes its own cursor down.
    eq(await unreadOf('reuse'), 0, 'once a guest\'s agent connects under it, the board counts none of it unread for the desk');
    const fresh = await session('open-floor', 'gnew', guest());
    eq(await unreadOf('gnew'), 0, 'nor for a guest\'s agent under a name new to the board, which starts at the newest message too');
    eq(bodies(await fresh('poll_messages', {})), [], 'and is handed nothing from before');
    const first = await gail('poll_messages', {});
    eq(bodies(first), [], 'the guest\'s desk under that name is handed none of it, with no since');
    eq(bodies(await gail('poll_messages', { since: 0 })), [], 'nor with since 0');
    await dev('send_message', { to: 'reuse', body: 'for Gail\'s reuse' });
    eq(bodies(await gail('poll_messages', {})), ['for Gail\'s reuse'], 'what is sent to it after is its own');
    // The same guest again (its host's events name the desk on every batch)
    // keeps where it started.
    await dev('send_message', { to: 'reuse', body: 'kept' });
    await fetch(`${B}/api/host/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestratinator-key': KEY, ...sign(guest()) }, body: JSON.stringify({ host_id: 'op_g~mac', events: [{ type: 'state', channel: 'open-floor', agent: 'reuse', state: 'idle' }] }) });
    eq(bodies(await gail('poll_messages', { since: first.cursor })), ['for Gail\'s reuse', 'kept'], 'the same guest\'s host naming the desk again moves nothing: mail sent meanwhile is still there');
    // The owner's own agents read as they always have.
    const own = await session('open-floor', 'ownnew');
    assert(bodies(await own('poll_messages', {})).includes('a broadcast from before'), 'an owner\'s agent new to the floor still reads its earlier broadcasts');
  }

  console.log('\nM3: an agent sends another a file (board.files)');
  {
    const UP = await import('../host/uploads.js');
    const proto = JSON.parse(readFileSync('package.json', 'utf8')).protocol;
    const reg = (hostId, desks, extra = {}) => fetch(`${B}/api/host/register`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestratinator-key': KEY }, body: JSON.stringify({ host_id: hostId, name: hostId, protocol: proto, desks, ...extra }) });
    eq((await reg('h-own', [{ channel: 'open-floor', agent: 'odev', cwd: '/o/odev' }, { channel: 'open-floor', agent: 'ofile', cwd: '/o/ofile' }], { files: true })).status, 200, 'the fixture: the owner\'s host runs odev and ofile, and says it sends files');
    eq((await reg('h-old', [{ channel: 'open-floor', agent: 'oold', cwd: '/o/oold' }])).status, 200, 'and an older host runs oold, saying nothing about files');
    const work = async (hostId) => (await (await fetch(`${B}/api/host/work?host_id=${encodeURIComponent(hostId)}&wait=0`, { headers: { 'x-orchestratinator-key': KEY } })).json()).work ?? [];
    await work('h-own'); await work('h-old');
    // An MCP session as odev, as its Claude Code would have.
    const mh = (sid) => ({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-orchestratinator-key': KEY, 'x-channel': 'open-floor', 'x-agent': 'odev', ...(sid ? { 'mcp-session-id': sid } : {}) });
    const init = await fetch(`${B}/mcp`, { method: 'POST', headers: mh(), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) });
    const sid = init.headers.get('mcp-session-id'); await init.text();
    const call = async (args, id = 2) => {
      const r = await fetch(`${B}/mcp`, { method: 'POST', headers: mh(sid), body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'send_file', arguments: args } }) });
      const t = await r.text();
      const line = t.split('\n').find((l) => l.startsWith('data:'));
      const msg = JSON.parse(line ? line.slice(5) : t);
      return JSON.parse(msg.result?.content?.[0]?.text ?? 'null') ?? msg;
    };
    eq((await call({ to: 'nobody', path: '/x' })).code, 'no_recipient', 'to an agent not on the floor: refused in words');
    eq((await call({ to: 'odev', path: '/x' })).code, 'no_recipient', 'to itself: refused');
    const dir = mkdtempSync(join(tmpdir(), 'orch-files-'));
    const file = join(dir, 'report.txt');
    const bytes = 'A REPORT\n'.repeat(5000);
    writeFileSync(file, bytes);
    // The tool waits on odev's host, which this test plays with the host's own code.
    const pending = call({ to: 'ofile', path: 'report.txt', note: 'please review' }, 3);
    let item = null;
    for (let i = 0; i < 40 && !item; i++) { item = (await work('h-own')).find((w) => w.kind === 'send_file'); if (!item) await sleep(100); }
    eq([item?.agent, item?.payload?.path], ['odev', 'report.txt'], 'odev\'s host is asked to read the path odev named, for odev');
    const sent = await UP.sendFile({ url: B, token: KEY, hostId: 'h-own', transfer: item.payload.transfer, path: item.payload.path, cwd: dir });
    eq(sent.ok, true, 'the host reads it, relative to the desk\'s folder, and streams it to the board', JSON.stringify(sent));
    const res = await pending;
    eq([res.sent, res.to, res.name, res.size], [true, 'ofile', 'report.txt', bytes.length], 'the tool answers: sent, to whom, the name and the size');
    const chat = (await work('h-own')).find((w) => w.kind === 'chat' && w.agent === 'ofile');
    assert(chat?.payload?.text?.startsWith('From odev:\n\nA file: report.txt (') && chat.payload.text.endsWith('please review'), 'ofile is sent a message from odev naming the file, with the note', chat?.payload?.text);
    eq([chat?.payload?.attached_by, chat?.payload?.files?.length], ['odev', 1], 'carrying the file, attached by odev');
    const got = await fetch(`${B}/api/host/upload?host_id=h-own&id=${chat.payload.files[0].id}`, { headers: { 'x-orchestratinator-key': KEY } });
    eq(await got.text(), bytes, 'and ofile\'s host fetches the same bytes');
    const listed = UP.withAttachments('From odev:\n\nA file.', ['/u/x/report.txt'], 'odev');
    assert(listed.endsWith('Attached by odev:\n- /u/x/report.txt'), 'the receiving host lists it as attached by odev, not the operator');
    // A file the host cannot send: its words reach the agent that asked.
    const missing = call({ to: 'ofile', path: 'nope.txt' }, 4);
    let item2 = null;
    for (let i = 0; i < 40 && !item2; i++) { item2 = (await work('h-own')).find((w) => w.kind === 'send_file'); if (!item2) await sleep(100); }
    await UP.sendFile({ url: B, token: KEY, hostId: 'h-own', transfer: item2.payload.transfer, path: item2.payload.path, cwd: dir });
    const m = await missing;
    assert(m.sent === false && m.code === 'file' && /nope\.txt does not exist on this computer/.test(m.error) && /Nothing reached ofile/.test(m.error), 'a missing file: the agent is told, in the host\'s words, and nothing reaches the receiver', JSON.stringify(m));
    const folder = call({ to: 'ofile', path: dir }, 5);
    let item3 = null;
    for (let i = 0; i < 40 && !item3; i++) { item3 = (await work('h-own')).find((w) => w.kind === 'send_file'); if (!item3) await sleep(100); }
    await UP.sendFile({ url: B, token: KEY, hostId: 'h-own', transfer: item3.payload.transfer, path: item3.payload.path, cwd: dir });
    assert(/is a folder; send one file/.test((await folder).error ?? ''), 'a folder: refused, one file at a time');
    // Another host offering bytes for a transfer still open: refused, and
    // the transfer is still the asked host's to finish.
    const live = call({ to: 'ofile', path: 'report.txt' }, 6);
    let item4 = null;
    for (let i = 0; i < 40 && !item4; i++) { item4 = (await work('h-own')).find((w) => w.kind === 'send_file'); if (!item4) await sleep(100); }
    const wrongHost = await fetch(`${B}/api/host/file?host_id=h-old&transfer=${item4.payload.transfer}&name=forged.txt`, { method: 'POST', headers: { 'x-orchestratinator-key': KEY }, body: 'forged' });
    eq(wrongHost.status, 404, 'bytes for an open transfer from a host the board did not ask are refused');
    await UP.sendFile({ url: B, token: KEY, hostId: 'h-own', transfer: item4.payload.transfer, path: item4.payload.path, cwd: dir });
    eq([(await live).sent, (await live).name], [true, 'report.txt'], 'and the asked host still completes it with the real file');
    // oold's host never said it sends files.
    const mo = (sid2) => ({ ...mh(sid2), 'x-agent': 'oold' });
    const i2 = await fetch(`${B}/mcp`, { method: 'POST', headers: mo(), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) });
    const sid2 = i2.headers.get('mcp-session-id'); await i2.text();
    const r2 = await fetch(`${B}/mcp`, { method: 'POST', headers: mo(sid2), body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'send_file', arguments: { to: 'ofile', path: '/x' } } }) });
    const t2 = await r2.text(); const l2 = t2.split('\n').find((l) => l.startsWith('data:'));
    eq(JSON.parse(JSON.parse(l2 ? l2.slice(5) : t2).result.content[0].text).code, 'host_no_files', 'from a desk whose host predates files: refused, saying to update it');
    rmSync(dir, { recursive: true, force: true });
  }

  console.log('\nM2: a card revoked or a building unshared ends the guest\'s desks at once (v6)');
  {
    const access = async (body, p) => json(await fetch(`${B}/api/relay/access`, { method: 'POST', headers: { 'content-type': 'application/json', ...hdr(p) }, body: JSON.stringify(body) }));
    // The walk's leftover: a guest's desk no host of it runs, kept live only
    // by its own window's hook session (desktop-dev, 4448).
    const hook = (ev) => fetch(`${B}/api/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestratinator-key': KEY, ...sign(guest()), 'x-channel': 'open-floor', 'x-agent': 'ghost' },
      body: JSON.stringify({ channel: 'open-floor', agent: 'ghost', session_id: 's-ghost', cwd: '/g/ghost', hook_event_name: ev }) });
    eq([(await hook('SessionStart')).status, (await hook('UserPromptSubmit')).status], [200, 200], 'the fixture: the guest\'s window reports a desk, ghost, with no host');
    const ghostLive = async () => (await (await fetch(`${B}/api/floor`)).json()).channels.find((c) => c.channel === 'open-floor').desks.find((d) => d.agent === 'ghost');
    eq([(await ghostLive())?.live, (await ghostLive())?.hosted ?? null], [true, null], 'the fixture: ghost reads live, run by no host');
    eq((await access({ op: 'op_g', buildings: [] }, guest())).body?.code, 'relay_role', 'a guest cannot change its own access');
    eq((await access({ op: 'op_g', buildings: [shared] }, owner())).body?.dropped, [], 'still holding the shared building: nothing leaves');
    // A pause (the owner's subscription lapsed): the guest's desks go offline
    // where they stand, and come back with the guest's host after a renewal
    // (desktop-dev's M3 walk, note a).
    const floorDesk = async (ag) => (await (await fetch(`${B}/api/floor`)).json()).channels.find((c) => c.channel === 'open-floor').desks.find((d) => d.agent === ag);
    const pause = await access({ op: 'op_g', buildings: [], paused: true }, owner());
    eq([pause.status, pause.body.paused?.map((d) => d.agent).includes('gdev'), pause.body.dropped], [200, true, undefined], 'paused: the guest\'s desks are listed as paused, not dropped');
    const pd = await floorDesk('gdev');
    eq([pd?.hosted?.host_id, pd?.hosted?.live], ['op_g~mac', false], 'gdev keeps its seat and host, offline');
    eq((await json(await fetch(`${B}/api/floor/desk`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host_id: 'h-own', path: '/o/x', channel: 'open-floor', agent: 'gdev' }) }))).body?.code, 'desk_not_yours', 'and its name stays the guest\'s while paused');
    const back = await fetch(`${B}/api/host/register`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestratinator-key': KEY, ...sign(guest()) }, body: JSON.stringify({ host_id: 'op_g~mac', name: 'gails-mac', protocol: JSON.parse(readFileSync('package.json', 'utf8')).protocol, files: true, desks: [{ channel: 'open-floor', agent: 'gdev', cwd: '/g/gdev' }] }) });
    eq(back.status, 200, 'after a renewal, the guest\'s host registers again');
    eq((await floorDesk('gdev'))?.hosted?.live, true, 'and gdev is back, live, without being taken again');
    const gone = await access({ op: 'op_g', buildings: [] }, owner());
    eq([gone.status, gone.body.dropped.map((d) => d.agent).sort(), gone.body.hosts_offline], [200, ['gdev', 'ghost', 'gnew', 'newcomer', 'reuse'], ['op_g~mac']], 'no card left: its desks leave the floor (the hosted one, and those it was known by with no host) and its host goes offline');
    eq((await ghostLive())?.live ?? false, false, 'ghost no longer reads live: its sessions are ended');
    const own = await json(await fetch(`${B}/api/floor/desk`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host_id: 'h-own', path: '/o/ghost', channel: 'open-floor', agent: 'ghost' }) }));
    assert(own.body?.code !== 'desk_not_yours', 'and its name is free again: a take of it is no longer refused as the guest\'s (the M3 walk, b)', JSON.stringify(own.body));
    const f = await (await fetch(`${B}/api/floor`)).json();
    eq(f.channels.find((c) => c.channel === 'open-floor').desks.find((d) => d.agent === 'gdev')?.hosted ?? null, null, 'the owner\'s floor no longer shows the guest\'s desk as hosted');
    const gd = f.channels.find((c) => c.channel === 'open-floor').desks.find((d) => d.agent === 'gdev');
    eq(gd ? gd.live : false, false, 'and not as live either: its board connection is closed and its agent row retired');
    const st = await (await fetch(`${B}/api/state`)).json();
    const ag = st.channels.find((c) => c.channel === 'open-floor');
    assert(!ag.agents.some((a) => a.agent === 'gdev') && ag.retired_agents.some((a) => a.agent === 'gdev'), 'the board lists gdev as retired, not as an agent on the floor');
    assert(f.channels.find((c) => c.channel === 'open-floor').desks.find((d) => d.agent === 'odev')?.hosted?.host_id === 'h-own', 'and the owner\'s own desk is untouched');
    const hostsNow = Object.fromEntries(f.hosts.map((h) => [h.host_id, h.live]));
    eq([hostsNow['op_g~mac'], hostsNow['h-own']], [false, true], 'the guest\'s host reads offline at once, the owner\'s live');
    const row = (await (await fetch(`${B}/api/activity?limit=50`)).json()).rows.find((r) => r.kind === 'admin.relay.access');
    eq(row?.actor, 'Chris (remote)', 'the audit row says it, as the owner\'s');
  }

  console.log('\nM2: a room holding two operators\' agents names both operators');
  {
    const { roomNoticeText } = await import('../src/floor.js');
    const one = roomNoticeText('enter', ['bo'], []);
    assert(/with bo and the operator\./.test(one), 'one operator: as it always read');
    const two = roomNoticeText('enter', ['desk-ask'], ['Owner Walk', 'Guest Walk']);
    assert(/with desk-ask and their operators, Owner Walk and Guest Walk\./.test(two) && /either operator sends/.test(two), 'two: "their operators, Owner Walk and Guest Walk"', two);
    assert(/The operators' messages/.test(roomNoticeText('leave', [], ['Gail', 'Chris'])), 'and the way back out says operators');
    const src = readFileSync('src/floor.js', 'utf8');
    assert(src.includes("roomNoticeText(n.kind, n.others, n.kind === 'enter' ? operatorsIn(n.channel, n.room) : operatorsOfDesk(n.channel, n.agent))"), 'the board hands the room\'s operators to the note');
  }

  console.log('\nrelay: a short secret fails the start');
  {
    const short = start(PORT + 2, `./data/service-short-${process.pid}.db`, { ORCH_RELAY_SECRET: 'x'.repeat(42) });
    const code = await new Promise((res) => { short.proc.on('exit', res); setTimeout(() => res('still running'), 8000); });
    if (code === 'still running') short.proc.kill('SIGKILL');
    assert(code !== 'still running' && code !== 0, `a 42-character secret ends the board at start (exit ${code})`);
    assert(/ORCH_RELAY_SECRET is set but 42 characters long/.test(short.out.text) && !short.out.text.includes('x'.repeat(42)), 'and says why, without printing it');
    for (const ext of ['', '-wal', '-shm']) rmSync(`./data/service-short-${process.pid}.db${ext}`, { force: true });
  }
} finally {
  plain.proc.kill();
  relayed.proc.kill();
  await sleep(300);
  rmDb();
}

console.log(failures ? `\nFAIL ❌ — ${failures} failure(s)` : '\nPASS ✅ — 0 failure(s)');
process.exit(failures ? 1 : 0);

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
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

const PORT = Number(process.env.SERVICE_TEST_PORT ?? 8903);
const PORT2 = PORT + 1;
const SECRET = 'a'.repeat(32) + 'b'.repeat(32);
const KEY = 'service-suite-key';
const DBS = [`./data/service-${process.pid}.db`, `./data/service-relay-${process.pid}.db`];

let failures = 0;
const assert = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) failures++; };
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
    eq([main.name, main.default, main.floors], ['Main', true, ['alpha', 'beta']], 'it is the default, "Main", and holds every floor');
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
    eq(body.buildings.map((b) => [b.name, b.floors]), [['Main', ['alpha']], ['Lab', ['beta']]], 'each building holds its own floors, the default first');
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
    const acts = (await (await fetch(`${A}/api/activity?limit=200`)).json()).rows.map((r) => r.kind);
    for (const k of ['admin.building.create', 'admin.building.rename', 'admin.building.delete', 'admin.floor.building']) assert(acts.includes(k), `the audit trail has ${k}`);
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
    eq([made.length, made[0]?.default, made[0]?.name, made[0]?.floors], [1, true, 'Main', ['alpha', 'beta']], 'and a default is made, holding every floor (their building ids name nothing here)');
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
    const bs = [{ id: 'b_main', name: 'Main', default: true }, { id: 'b_lab', name: 'Lab', default: false }];
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
    eq(await code(sign(owner({ role: 'guest' }))), 'relay_role', 'the guest role is M2\'s, and refused until then');
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

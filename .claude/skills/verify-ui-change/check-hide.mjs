#!/usr/bin/env node
/**
 * Drive the floor through issue #20 against the fixture seed-hide.mjs builds,
 * and print what the page drew at every step. The assertions are in
 * test/floor.mjs ("an empty desk is not drawn; a hidden desk is a pill");
 * this is the page, which only a browser can show. Measured 2026-11-03.
 *
 *   node --experimental-websocket .claude/skills/verify-ui-change/check-hide.mjs http://localhost:8905 [out-dir] [db]
 *
 * Steps, in order: the building (every storey collapsed) and then alpha on
 * its own — which desks are drawn and which nameplates are left; the
 * nameplate card on a live desk and its "Hide desk"; the pill that replaces
 * the desk, with its unread count, under the last desk; the storey's `N/M
 * here` not moving; an empty desk hidden by API and restored by its pill;
 * the live desk restored by its pill; an empty desk coming back on its own
 * when its host does (a DB touch, the way the host suite ages one); archive
 * with a hidden desk on it (no desk, no pill), and the pill back on
 * restore; the pill under a collapsed storey in the building; and Enter on a
 * focused pill. Shots go to out-dir, the building with `full: true`.
 */
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { open } from './drive.mjs';

const base = process.argv[2] ?? 'http://localhost:8905';
const out = process.argv[3] ?? tmpdir();
const DB = process.argv[4] ?? './data/scratch.db';
const REPO = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const Database = createRequire(`${REPO}/package.json`)('better-sqlite3');
const db = new Database(DB);
const P = fileURLToPath(new URL('./probe-hide.js', import.meta.url));
const say = (label, j) => {
  const r = JSON.parse(j);
  console.log(`\n## ${label}`);
  console.log(`  chips ${JSON.stringify(r.chips)} | away ${JSON.stringify(r.floorAway)} | totals "${r.totals}"${r.empty ? ` | empty copy "${r.empty}"` : ''}`);
  for (const room of r.rooms) {
    console.log(`  ${room.ch}${room.collapsed ? ' (collapsed)' : ''} h=${room.h} "${room.meta}" desks ${JSON.stringify(room.desks)} plates ${JSON.stringify(room.plates)}`);
    if (room.pills.length) console.log(`    pills ${JSON.stringify(room.pills.map((p) => `${p.agent}${p.count ? `(${p.count})` : ''}@${p.left},${p.top} w${p.w}`))} | last desk bottom ${room.lastDeskBottom} | room bottom ${room.bottom}`);
    for (const p of room.pills) if (p.title) console.log(`    title: ${p.title}`);
  }
  if (r.pop) console.log(`  CARD ${r.pop.head} | ${r.pop.window} | ${JSON.stringify(r.pop.buttons)}`);
  console.log(`  focused ${r.focused}`);
};
const api = (path, body) => fetch(`${base}/api/admin/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.status);
const floorDesk = async (agent, ch = 'alpha') => (await fetch(`${base}/api/floor`).then((r) => r.json())).channels.find((c) => c.channel === ch)?.desks.find((d) => d.agent === agent);

let page = await open({ base, view: 'floor', floor: '' });
await page.waitFor("document.querySelectorAll('#floor-rooms svg.room').length === 3");
say('building: start — three storeys, empty desks not drawn', await page.probe(P));
await page.shot(`${out}/hide-building-start.png`, null, { full: true });

await page.click('#floor-pick [data-floor="alpha"]');
await page.waitFor("document.querySelectorAll('#floor-rooms svg.room').length === 1 && !document.querySelector('#floor-rooms svg.room.collapsed')");
say('alpha: two desks drawn of five', await page.probe(P));
await page.shot(`${out}/hide-alpha-start.png`, '#floor-rooms');

await page.click('.desk[data-agent="ed"] .plateHit');
await page.waitFor("!!document.querySelector('#desk-pop [data-act=\"hide-desk\"]')");
say('alpha: the nameplate card on ed, with Hide desk under Open conversation', await page.probe(P));
await page.shot(`${out}/hide-card.png`, null);
await page.click('#desk-pop [data-act="hide-desk"]');
await page.waitFor("!!document.querySelector('#floor-rooms .deskPill[data-agent=\"ed\"]') && !document.getElementById('desk-pop')", { timeout: 10000 });
say('alpha: ed hidden — a pill with its unread count, the card closed, "N/M here" unchanged', await page.probe(P));
console.log('  api says hidden:', (await floorDesk('ed'))?.hidden);
await page.shot(`${out}/hide-alpha-ed-pill.png`, '#floor-rooms');

console.log('\nhide bob (empty) by API:', await api('desk/hide', { channel: 'alpha', agent: 'bob' }));
await page.waitFor("document.querySelectorAll('#floor-rooms .deskPill').length === 2", { timeout: 10000 });
say('alpha: an empty desk hidden by hand is a pill too', await page.probe(P));
await page.click('#floor-rooms .deskPill[data-agent="bob"]');
await page.waitFor("!document.querySelector('#floor-rooms .deskPill[data-agent=\"bob\"]')", { timeout: 10000 });
say('alpha: bob\'s pill clicked — no pill, and no desk either (it is empty)', await page.probe(P));
console.log('  api says hidden:', (await floorDesk('bob'))?.hidden);

await page.click('#floor-rooms .deskPill[data-agent="ed"]');
await page.waitFor("!!document.querySelector('#floor-rooms .desk[data-agent=\"ed\"]') && !document.querySelector('#floor-rooms .deskPill')", { timeout: 10000 });
say('alpha: ed\'s pill clicked — the desk is back, same seat', await page.probe(P));

db.prepare(`UPDATE hosts SET last_seen = datetime('now') WHERE host_id = 'h2'`).run();
await page.waitFor("!!document.querySelector('#floor-rooms .desk[data-agent=\"cy\"]')", { timeout: 10000 });
say('alpha: cy\'s host came back — the desk is drawn with nothing clicked', await page.probe(P));
db.prepare(`UPDATE hosts SET last_seen = datetime('now', '-2 days') WHERE host_id = 'h2'`).run();
await page.waitFor("!document.querySelector('#floor-rooms .desk[data-agent=\"cy\"]')", { timeout: 10000 });
say('alpha: and gone again when it went quiet', await page.probe(P));

console.log('\nhide ed by API, then archive alpha:', await api('desk/hide', { channel: 'alpha', agent: 'ed' }), await api('channel/archive', { channel: 'alpha' }));
await page.waitFor("!!document.querySelector('#floor-away .min-pill[data-channel=\"alpha\"]')", { timeout: 10000 });
say('alpha archived under us — all floors, no storey, no desk pill anywhere', await page.probe(P));
await page.click('#floor-away .min-pill[data-channel="alpha"]');
await page.waitFor("!!document.querySelector('#floor-rooms svg.room[data-channel=\"alpha\"] .deskPill[data-agent=\"ed\"]')", { timeout: 10000 });
say('building: alpha restored — ed\'s pill is back under the collapsed storey', await page.probe(P));
await page.shot(`${out}/hide-building-pill.png`, null, { full: true });

await page.evalJs("document.querySelector('#floor-rooms .deskPill[data-agent=\"ed\"]').focus(); 'ok'");
await page.evalJs("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); 'ok'");
await page.waitFor("!document.querySelector('#floor-rooms .deskPill')", { timeout: 10000 });
say('building: Enter on the focused pill restored it', await page.probe(P));
console.log('  api says hidden:', (await floorDesk('ed'))?.hidden);

await page.close();
db.close();
console.log(`\nshots in ${out}`);

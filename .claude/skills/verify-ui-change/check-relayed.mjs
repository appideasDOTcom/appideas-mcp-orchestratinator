#!/usr/bin/env node
/**
 * The board's page, served from a relayed origin (contract board.relay), as
 * a remote owner's browser will see it through the service.
 *
 *   run-check-relayed.sh <dir>       # the whole fixture; see there
 *
 * relay-hop.mjs stands in for the app's hop. The browser is on
 * http://b7k2.localhost:<hop port>, never the board's own port. What is read:
 * the floor draws its rooms; a write (Settings ▸ Add building) passes the
 * CSRF lock and its audit row names the remote owner; the floor's event
 * stream opens and carries its first event; an upload streams through; and
 * the folder dialog is refused in the board's words.
 */
import { open } from './drive.mjs';

const base = process.argv[2];
const shots = process.argv[3] ?? '/tmp';
const direct = process.argv[4];
let fails = 0;
let total = 0;
const ok = (cond, msg, extra = '') => { total++; console.log(`  ${cond ? '✓' : '✗'} ${msg}${cond || !extra ? '' : `  (${extra})`}`); if (!cond) fails++; };
const stopped = (e) => { total++; fails++; console.log(`  ✗ the check stopped on: ${String(e?.message ?? e).split('\n')[0]}`); console.log(`\nFAIL · ${fails} of ${total} red`); process.exit(1); };
process.on('uncaughtException', stopped);
process.on('unhandledRejection', stopped);
const until = (page, expr, what, timeout = 10000) => page.waitFor(expr, { timeout })
  .catch(async () => { throw new Error(`${what} — not in ${timeout / 1000} s; body: ${String(await page.evalJs(`document.body.innerText.slice(0, 300)`)).replace(/\s+/g, ' ')}`); });

console.log(`\nthe page at ${base}`);
const p = await open({ base, view: 'floor', floor: '' });
ok(await p.evalJs('location.origin') === base, 'the browser is on the relayed origin', await p.evalJs('location.origin'));
await until(p, `document.querySelectorAll('#floor-rooms [data-channel]').length > 0`, 'the floor draws');
ok(true, 'the floor draws its rooms through the hop');

console.log('\na write passes the lock as the remote owner');
await p.click('#open-settings');
await until(p, `!!document.querySelector('#building-new')`, 'Settings has Buildings');
await p.evalJs(`document.querySelector('#building-new').focus()`);
await p.type('Remote');
await p.click('[data-set="building-create"]');
await until(p, `document.querySelectorAll('#building-pick [data-building]').length === 2`, 'the building is made');
const row = await p.evalJs(`fetch('./api/activity?limit=20').then((r) => r.json()).then((j) => JSON.stringify(j.rows.find((r) => r.kind === 'admin.building.create')))`).then(JSON.parse);
ok(row?.actor === 'Remote Owner (remote)', 'its audit row names the remote owner', JSON.stringify(row));
await p.key('Escape');

console.log('\nthe floor\'s event stream and an upload, through the hop');
// The stream sends an event only when a desk has something going on, and
// this fixture has no host, so what is read is its first bytes, `retry:
// 2000`, arriving while the response is still open: streamed, not buffered
// by the hop until the end. Then EventSource's own open, held for 3 s.
const first = await p.evalJs(`(async () => { const ctl = new AbortController();
  const r = await fetch('./api/floor/stream?desks=' + encodeURIComponent(JSON.stringify([['alpha', 'dev']])), { signal: ctl.signal });
  const rd = r.body.getReader(); const t = setTimeout(() => ctl.abort(), 5000);
  try { const { value } = await rd.read(); clearTimeout(t); ctl.abort(); return r.status + ' ' + r.headers.get('content-type') + ' ' + new TextDecoder().decode(value).trim(); }
  catch (e) { return 'no bytes: ' + e.message; } })()`);
ok(/^200 text\/event-stream retry: 2000$/.test(first), 'the floor\'s event stream sends its first bytes through the hop while it is open', first);
const held = await p.evalJs(`new Promise((res) => { const es = new EventSource('./api/floor/stream?desks=' + encodeURIComponent(JSON.stringify([['alpha', 'dev']])));
  let opened = false; es.onopen = () => { opened = true; };
  es.onerror = () => { es.close(); res('error after open=' + opened); };
  setTimeout(() => { es.close(); res(opened ? 'open 3 s' : 'never opened'); }, 3000); })`);
ok(held === 'open 3 s', 'and an EventSource opens on it and stays open', held);
const up = await p.evalJs(`fetch('./api/floor/upload?name=note.txt&type=text/plain', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x'.repeat(300000) }).then(async (r) => r.status + ' ' + (await r.text()).slice(0, 120))`);
ok(/^200 /.test(up) && /"size":300000/.test(up), 'a 300 KB upload streams through and is staged whole', up);

console.log('\nwhat opens on the board machine\'s screen is refused in words');
const pick = await p.evalJs(`fetch('./api/floor/pick', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"host_id":"h"}' }).then(async (r) => r.status + ' ' + (await r.text()))`);
ok(/^409 /.test(pick) && /relay_local_only/.test(pick) && /Choose the folder from the list/.test(pick), 'the folder dialog: 409, and says to use the list', pick);

console.log('\na desk\'s panel: the handoffs to this machine\'s screen are absent remotely, there at the keyboard');
const links = (page) => page.evalJs(`JSON.stringify([...document.querySelectorAll('#floor-panel .p-links [data-act]')].filter((b) => !b.classList.contains('hidden')).map((b) => b.dataset.act))`).then(JSON.parse);
const openAnn = async (page) => {
  await until(page, `!!document.querySelector('#floor-rooms .desk[data-agent="ann"]')`, 'ann\'s desk is drawn');
  await page.click('#floor-rooms .desk[data-agent="ann"]');
  await until(page, `document.getElementById('floor-panel').dataset.agent === 'ann'`, 'ann\'s panel opens');
  await new Promise((r) => setTimeout(r, 600));
};
const k = await open({ base: `${direct}/?floor=alpha`, view: 'floor', floor: 'alpha' });
await openAnn(k);
const here = await links(k);
ok(here.includes('handback') && here.includes('claude'), 'at the keyboard, ann\'s panel offers Open in VS Code and Open in Claude (the fixture is a desk they apply to)', JSON.stringify(here));
await p.goto(`${base}/?floor=alpha`);
await openAnn(p);
const there = await links(p);
ok(!there.includes('handback') && !there.includes('claude'), 'remotely, neither is drawn', JSON.stringify(there));
ok(await p.evalJs(`fetch('./api/floor').then((r) => r.json()).then((j) => JSON.stringify(j.viewer))`) === '{"remote":true,"name":"Remote Owner"}', 'the floor payload says the viewer is remote, by name');
ok(await k.evalJs(`fetch('./api/floor').then((r) => r.json()).then((j) => JSON.stringify(j.viewer))`) === '{"remote":false}', 'and at the keyboard, not');
await p.shot(`${shots}/relayed-floor.png`, null, { scale: 1 });

console.log(fails ? `\nFAIL · ${fails} of ${total} red` : `\nPASS · ${total} of ${total}`);
process.exit(fails ? 1 : 0);

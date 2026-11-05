// check-popout-session.mjs — issue #46: a new session, then detach, must not
// show the session before it. Against seed-desk.mjs's lab/bo desk:
//   node --experimental-websocket check-popout-session.mjs http://localhost:8941 [runs]
// Red before the fix in 2 of 3 runs once and 1 of 8 since (the popout's first, unscoped turns fetch
// landing after the first poll's scoped reset); green 8 of 8 after.
import { open, attach, targets } from './drive.mjs';
const [base, runs = '3'] = process.argv.slice(2);
const ev = (events) => fetch(`${base}/api/host/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestratinator-key': 'k' }, body: JSON.stringify({ host_id: 'h1', events }) }).then((r) => r.json());
const read = (p) => p.evalJs(`JSON.stringify({ n: document.querySelectorAll('#p-turns .t').length, ids: [...document.querySelectorAll('#p-turns .t')].slice(0,3).map(t => (t.textContent||'').slice(0,40)) })`).then(JSON.parse);
await ev([{ type: 'session', channel: 'lab', agent: 'bo', session_id: 'sess-bo', cwd: '/repo/bo' }]);
const floor = await open({ base, view: 'floor', floor: 'lab' });
await floor.resize(1500, 1000);
await floor.click(`#floor-rooms .desk[data-agent="bo"] .deskHit`);
await floor.waitFor(`document.querySelector('#floor-panel')?.dataset.agent === 'bo' && document.querySelector('#p-turns .t')`);
console.log('floor before:', JSON.stringify(await read(floor)));
let bad = 0;
for (let i = 0; i < Number(runs); i++) {
  const id = `sess-new-${Date.now()}`;
  console.log('session event', id, JSON.stringify(await ev([{ type: 'session', channel: 'lab', agent: 'bo', session_id: id, cwd: '/repo/bo' }])));
  await floor.waitFor(`!document.querySelector('#p-turns .t')`, { timeout: 10000 });
  console.log(' floor after the new session:', JSON.stringify(await read(floor)));
  await floor.press('#floor-panel [data-act="detach"]');
  const pop = await attach((u) => u.includes('popout=1') && u.includes('agent=bo'));
  await pop.waitFor(`document.querySelector('#floor-panel')?.dataset.agent === 'bo'`);
  const first = await read(pop);
  await new Promise((r) => setTimeout(r, 5000));
  const later = await read(pop);
  const wrong = first.n > 0 || later.n > 0;
  if (wrong) bad++;
  console.log(` popout: at first ${JSON.stringify(first)}  after 5s ${JSON.stringify(later)}  ${wrong ? 'OLD SESSION SHOWN' : 'ok'}`);
  await pop.close();
  await floor.waitFor(`!document.querySelector('#floor-panel [data-act="bring-back"]')`, { timeout: 15000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
}
console.log(bad ? `FAIL · ${bad} of ${runs}` : `PASS · ${runs} of ${runs}`);
await floor.close();
process.exit(bad ? 1 : 0);

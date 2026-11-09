#!/usr/bin/env node
/**
 * Take a desk on a folder bound to another instance: the release, on the
 * page (task 292, 2026-11-08). The rules are in test/floor.mjs ("releasing a
 * folder from another instance") and the host's half in test/host.mjs; this
 * is what the dialog draws and what it waits on, which only a browser shows.
 *
 *   run-check-release.sh <dir>        # the fixture, this check, teardown
 *
 * Against answering-host.mjs as two hosts: `testbox`, which can release and
 * has a folder dialog, and `oldbox`, which says neither. The folder is
 * `mars-elsewhere`, bound to http://10.0.0.9:8787 as y on x and the newest
 * in the host's list. Steps: Take a desk, the host's own dialog choosing
 * that folder; what the form says and fills (the agent from the folder, the
 * floor the dialog was opened from); that the folder is not in
 * Recently opened; a floor typed by name reaching the note; a release the
 * host refuses (the wait said in the dialog, then the host's words, the
 * dialog still open); one it makes (the dialog gone, the desk hosted); what
 * the host was sent each time; and a host that cannot, with its button
 * disabled.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { open } from './drive.mjs';

const args = process.argv.slice(2);
const base = args[0] ?? 'http://localhost:8961';
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const ANSWERS = flag('answers', null);
const WORK = flag('work', null);
const OUT = flag('out', tmpdir());
const ELSE = 'http://10.0.0.9:8787';
const DIR = '/repo/deep/nest/mars-elsewhere';

let pass = 0;
let fail = 0;
const ok = (cond, what, got) => {
  if (cond) { pass++; console.log(`  ✓ ${what}`); } else { fail++; console.log(`  ✗ ${what}${got === undefined ? '' : ` — got ${typeof got === 'string' ? got : JSON.stringify(got)}`}`); }
};
const answers = (a) => writeFileSync(ANSWERS, JSON.stringify(a));
const work = () => readFileSync(WORK, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The floor: Take a desk is the floor's button (its click is floor.js's).
// Standing on `lab`, the fixture's own floor, so "the floor it was opened
// from" is a floor and not the absence of one.
const page = await open({ base, view: 'floor', floor: 'lab' });
const read = async () => JSON.parse(await page.evalJs(`JSON.stringify((() => {
  const d = document.querySelector('#dlg');
  const q = (s) => d.querySelector(s);
  const go = q('[data-do="desk-take"]');
  return {
    open: d.open,
    title: q('.dlg-head h3')?.textContent ?? null,
    self: q('.dlg-self')?.textContent.trim() ?? null,
    note: q('.dlg-note')?.textContent.trim() ?? null,
    agent: q('#desk-agent')?.value ?? null,
    agentLocked: q('#desk-agent')?.readOnly ?? null,
    floor: q('#desk-channel')?.value ?? null,
    floors: [...(q('#desk-channel')?.options ?? [])].map((o) => o.value),
    go: go ? { text: go.textContent.trim(), disabled: go.disabled } : null,
    recent: [...d.querySelectorAll('.recent-row .dir-name')].map((e) => e.textContent),
    err: q('.dlg-err:not([hidden])')?.textContent.trim() ?? null,
  };
})())`));

console.log('\n## Take a desk, on a folder bound to another instance');
answers({ pick: { mode: 'chosen', path: DIR, delay: 600 } });
await page.click('#take-desk');
// Two hosts on this board, and the dialog opens on whichever is first: say
// which one, the way a person would, before reading anything off it.
await page.waitFor(`document.querySelector('#dlg').open && !!document.querySelector('#dlg #desk-host')`);
await page.evalJs(`(() => { const s = document.querySelector('#dlg #desk-host'); if (s.value !== 'h1') { s.value = 'h1'; s.dispatchEvent(new Event('change', { bubbles: true })); } return 'ok'; })()`);
await page.waitFor(`!!document.querySelector('#dlg [data-do="desk-pick"]') && !document.querySelector('#dlg [data-do="desk-pick"]').disabled`);
let r = await read();
ok(r.recent.length > 0 && !r.recent.includes('mars-elsewhere'), 'Recently opened lists the host\'s folders, and not the one bound elsewhere, though it is the newest', r.recent);
await page.click('#dlg [data-do="desk-pick"]');
await page.waitFor(`/another instance/.test(document.querySelector('#dlg .dlg-self')?.textContent ?? '')`, { timeout: 14000 });
r = await read();
console.log(`  title  "${r.title}"\n  self   "${r.self}"\n  note   "${r.note}"\n  button "${r.go?.text}" disabled=${r.go?.disabled} · agent "${r.agent}" locked=${r.agentLocked} · floor "${r.floor}" of ${JSON.stringify(r.floors)}`);
ok(r.title === `Release y from ${ELSE}`, 'the title says it is a release, of whom, from which instance', r.title);
ok(r.self.includes(`is y on x at ${ELSE}, another instance`) && !/Change it there/.test(r.self), 'the folder\'s own line says where it is bound, and sends nobody away to change it', r.self);
ok(r.note.startsWith(`Releases it from ${ELSE} and seats it here as y on lab`) && /comes out of the folder's \.mcp\.json/.test(r.note) && r.note.includes(`Its messages and tasks on ${ELSE} stay there`), 'the note names the instance, the file that changes, and what stays behind', r.note);
ok(r.agent === 'y' && r.agentLocked === true, 'the agent is the folder\'s, and locked', [r.agent, r.agentLocked]);
ok(r.floor === 'lab' && !r.floors.includes('x'), 'the floor is the one the dialog was opened from: the floor it had on the other instance is not proposed, or offered', [r.floor, r.floors]);
ok(r.go?.text === 'Release and seat here' && r.go.disabled === false, 'the button says what it does, and can be pressed', r.go);
await page.shot(`${OUT}/release-dialog.png`, '#dlg');

console.log('\n## a floor typed by name');
await page.evalJs(`(() => { const s = document.querySelector('#dlg #desk-channel'); s.value = '__new__'; s.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
await page.waitFor(`!!document.querySelector('#dlg #desk-new-channel')`);
r = await read();
ok(r.go.disabled === true, 'with no name typed there is nothing to press', r.go);
await page.evalJs(`document.querySelector('#dlg #desk-new-channel').focus(); 'ok'`);
await page.type('landing');
r = await read();
ok(r.note.includes('seats it here as y on landing') && r.go.disabled === false, 'the note follows the name as it is typed, and the button comes back', [r.note.slice(0, 90), r.go]);

console.log('\n## a release the host refuses');
const said = `not released from ${ELSE} — the window is still working: ✳ Baking… (esc to interrupt)`;
answers({ bind: { mode: 'refused', error: said, delay: 1800 } });
const before = work().length;
r = await read();
ok(r.go.disabled === false, 'the button is one a person could press', r.go);
await page.click('#dlg [data-do="desk-take"]');
await page.waitFor(`/waiting for it to sit down on landing/.test(document.querySelector('#dlg .dlg-note')?.textContent ?? '')`);
r = await read();
ok(r.note === `Asked testbox to release y from ${ELSE} — waiting for it to sit down on landing…` && r.open, 'while the host has it, the dialog says who was asked and for what', r.note);
await page.waitFor(`!!document.querySelector('#dlg .dlg-err:not([hidden])')`, { timeout: 14000 });
r = await read();
ok(r.err === said, 'the refusal is shown in the host\'s own words', r.err);
ok(r.open && r.note.startsWith(`Releases it from ${ELSE}`), 'and the dialog stays, saying again what a release does', [r.open, r.note.slice(0, 60)]);
let sent = work().slice(before).filter((w) => w.kind === 'bind');
ok(sent.length === 1 && sent[0].payload.release?.board === ELSE && sent[0].payload.from === null && sent[0].channel === 'landing' && sent[0].payload.path === DIR,
  'the host was sent one bind, naming the instance being left and no desk to move from', sent.map((w) => w.payload));
const floorNow = async () => (await fetch(`${base}/api/floor`).then((x) => x.json())).channels.find((c) => c.channel === 'landing')?.desks.find((d) => d.agent === 'y') ?? null;
ok(!(await floorNow())?.hosted, 'and nothing is hosted on that floor');

console.log('\n## a release the host makes');
answers({ bind: { mode: 'bound', delay: 900, session_id: 'sess-released' } });
await page.click('#dlg [data-do="desk-take"]');
await page.waitFor(`!document.querySelector('#dlg').open`, { timeout: 14000 });
await sleep(400);
const desk = await floorNow();
ok(desk?.hosted?.live === true && desk.hosted.session_id === 'sess-released', 'the dialog closes once the host has seated it: the desk is hosted here, on the conversation the host named', desk?.hosted);
const take = (await fetch(`${base}/api/floor/take?host_id=h1&channel=landing&agent=y`).then((x) => x.json())).take;
ok(take?.state === 'seated' && take.from_board === ELSE, 'and the take on record reads seated, released from that instance', take);
const where = JSON.parse(await page.evalJs(`JSON.stringify({ view: document.body.className, panel: document.querySelector('#floor-panel')?.dataset.agent ?? null })`));
console.log(`  the page is now: ${JSON.stringify(where)}`);
ok(where.panel === 'y', 'and the page has gone to the desk', where);

console.log('\n## a host from before releases');
await page.evalJs(`deskDialog({ hostId: 'h2', path: ${JSON.stringify(DIR)} }); 'ok'`);
await page.waitFor(`/another instance/.test(document.querySelector('#dlg .dlg-self')?.textContent ?? '')`, { timeout: 14000 });
r = await read();
console.log(`  note   "${r.note}"`);
ok(/^oldbox runs a build from before a folder could be released from another instance/.test(r.note), 'the note says that host cannot release, by name', r.note);
ok(r.go.disabled === true, 'and its button cannot be pressed', r.go);
await page.shot(`${OUT}/release-old-host.png`, '#dlg');

const errs = (await page.console()).filter((e) => !/favicon/.test(JSON.stringify(e)));
ok(errs.length === 0, 'no console warnings or errors on the way', errs.slice(0, 3));
await page.close();
console.log(`\n${fail ? 'FAIL' : 'PASS'} · ${pass} of ${pass + fail}`);
process.exit(fail ? 1 : 0);

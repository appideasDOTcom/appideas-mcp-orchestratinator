#!/usr/bin/env node
/**
 * Move a probe desk to another floor while its real window is held, and
 * watch the target floor in a real page meanwhile. Written for issue #24
 * (task 253, 2026-11-03): the live refusals needed a window slow to answer
 * its hangup, and this is how one was made — `kill -STOP` on the window's
 * pid before the move, `kill -CONT` HOLD ms after it.
 *
 *   ORCH_CDP_PORT=9253 node --experimental-websocket held-move.mjs \
 *     <board-url> <host-id> <folder> <tmux-wrapper> <agent> <from-floor> <to-floor> <hold-ms|0> <out-dir> [card]
 *
 *   card   move through the nameplate card's route (POST /api/floor/desk/move)
 *          instead of Take a desk's (POST /api/floor/desk, which needs the
 *          folder's parent browsed first — this does that)
 *
 * Prints, ms-stamped: the window's pid, the target storey as the page draws
 * it on every change (meta, the desk's classes and nameplate), three shots
 * of the storey, and the desk's panel at the end. Read it beside
 * rec-floor.mjs, rec-roster.mjs and the host's ms-stamped log.
 *
 * Not deterministic, and say so when quoting it: something other than the
 * stopped process removes its session file 6–14 ms after the kill, so a held
 * window was refused once and not the next time (see SKILL.md, "How long a
 * closed window stays in the roster"). The host suite's linger.flag is the
 * red you can rely on.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { open } from '../../verify-ui-change/drive.mjs';

const [base, hostId, folder, tmuxw, agent, FROM, TO, HOLD = '0', OUT, door] = process.argv.slice(2);
if (!OUT) { console.error('usage: held-move.mjs <board> <host-id> <folder> <tmux-wrapper> <agent> <from> <to> <hold-ms> <out-dir> [card]'); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const log = join(OUT, 'held-move.log'); writeFileSync(log, '');
const stamp = () => new Date().toISOString().slice(11, 23);
const say = (s) => { const l = `${stamp()} ${s}`; console.log(l); appendFileSync(log, `${l}\n`); };
const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => `${r.status} ${await r.text()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const page = await open({ base, view: 'floor', floor: TO });
await page.resize(1400, 900);
const probe = `JSON.stringify((() => {
  const room = [...document.querySelectorAll('#floor-rooms svg.room')].find((r) => r.dataset.channel === ${JSON.stringify(TO)});
  if (!room) return { room: null };
  const d = room.querySelector('.desk[data-agent=${JSON.stringify(agent)}]');
  return { room: true, meta: room.querySelector('.roomMeta')?.textContent ?? null,
    desk: d ? { cls: d.getAttribute('class'), plates: [...d.querySelectorAll('text')].map((t) => t.textContent).filter(Boolean).slice(0, 6) } : null };
})())`;

if (door !== 'card') { await post('/api/floor/browse', { host_id: hostId, path: dirname(folder) }); await sleep(1500); }
const pid = Number(execFileSync(tmuxw, ['list-panes', '-a', '-F', '#{pane_pid} #{pane_current_path}'], { encoding: 'utf8' })
  .trim().split('\n').map((l) => l.split(' ')).find(([, p]) => p === folder)?.[0]);
if (!pid) { say(`no pane in ${folder} — open the desk's window first`); await page.close(); process.exit(1); }
say(`window pid ${pid}; ${TO} before: ${await page.evalJs(probe)}`);
const hold = Number(HOLD);
if (hold > 0) { process.kill(pid, 'SIGSTOP'); say(`SIGSTOP ${pid}`); }
say(door === 'card'
  ? `card move -> ${await post('/api/floor/desk/move', { channel: FROM, agent, to: TO })}`
  : `take move -> ${await post('/api/floor/desk', { host_id: hostId, path: folder, channel: TO, agent })}`);
const t0 = Date.now();
const shots = [1500, 4000, 12000];
let last = '', continued = hold <= 0;
try {
  while (Date.now() - t0 < 16000) {
    const el = Date.now() - t0;
    if (!continued && el >= hold) { try { process.kill(pid, 'SIGCONT'); } catch { /* gone */ } say(`SIGCONT ${pid}`); continued = true; }
    const now = await page.evalJs(probe);
    if (now !== last) { say(`+${el}ms ${now}`); last = now; }
    if (shots.length && el >= shots[0]) { const s = shots.shift(); await page.shot(join(OUT, `${TO}-${s}ms.png`), `#floor-rooms svg.room[data-channel="${TO}"]`, { scale: 1 }).catch((e) => say(`shot failed: ${e.message}`)); }
    await sleep(300);
  }
} finally {
  // Never leave a window stopped with its pane gone.
  if (!continued) { try { process.kill(pid, 'SIGCONT'); } catch { /* gone */ } }
}
try {
  await page.click(`#floor-rooms svg.room[data-channel="${TO}"] .desk[data-agent="${agent}"] .deskHit`);
  await page.waitFor(`document.getElementById('floor-panel')?.dataset?.agent === ${JSON.stringify(agent)}`, { timeout: 8000 });
  await sleep(1500);
  say(`panel: ${await page.evalJs(`JSON.stringify([...document.querySelectorAll('#floor-panel *')].filter((n) => n.children.length === 0 && n.textContent.trim()).map((n) => n.textContent.trim()).slice(-14))`)}`);
} catch (e) { say(`panel: ${e.message}`); }
await page.close();

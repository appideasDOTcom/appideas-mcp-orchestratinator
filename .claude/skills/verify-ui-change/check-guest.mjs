#!/usr/bin/env node
/**
 * A guest in an owner's building, on the page (board.relay v5, M2).
 *
 *   run-check-guest.sh <dir>       # the whole fixture; see there
 *
 * One board, seed-select.mjs's floors and owner's host (h1: alpha, and
 * beta's fay), beta moved into a building "Shared", and a guest's host
 * (op_guest~mac, Gail's) running gwen on beta. Two relay-hop.mjs stand-ins:
 * one signs as the owner, one as the guest Gail with Shared on her card.
 * What a person sees and does:
 * - Gail sees beta alone, under "Shared at <machine>", and Settings has none
 *   of the board's own sections.
 * - On the owner's fay, Gail's panel offers no seat links, and its stop sign
 *   and model are dimmed with whose they are; she can message it, and the
 *   owner, at the keyboard, reads that message as from Gail.
 * - On Gail's gwen, the owner's panel does the same the other way, and a
 *   prompt gwen raises is shown to the owner without a way to answer it.
 */
import { open } from './drive.mjs';

const [ownerBase, guestBase, direct, shots, machine] = process.argv.slice(2);
let fails = 0;
let total = 0;
const ok = (cond, msg, extra = '') => { total++; console.log(`  ${cond ? '✓' : '✗'} ${msg}${cond || !extra ? '' : `  (${extra})`}`); if (!cond) fails++; };
const stopped = (e) => { total++; fails++; console.log(`  ✗ the check stopped on: ${String(e?.message ?? e).split('\n')[0]}`); console.log(`\nFAIL · ${fails} of ${total} red`); process.exit(1); };
process.on('uncaughtException', stopped);
process.on('unhandledRejection', stopped);
const until = (page, expr, what, timeout = 10000) => page.waitFor(expr, { timeout })
  .catch(async () => { throw new Error(`${what} — not in ${timeout / 1000} s; body: ${String(await page.evalJs(`document.body.innerText.slice(0, 300)`)).replace(/\s+/g, ' ')}`); });
const panel = (page) => page.evalJs(`JSON.stringify((() => {
  const p = document.getElementById('floor-panel');
  const stop = p.querySelector('[data-act="stop"]');
  const model = p.querySelector('[data-act="set-model"]');
  return {
    agent: p.dataset.agent,
    links: [...p.querySelectorAll('.p-links [data-act], [data-act="sessions"], [data-act="leave-desk"]')].filter((b) => !b.classList.contains('hidden')).map((b) => b.dataset.act),
    stop: { disabled: stop?.disabled, title: stop?.title },
    model: { disabled: model?.disabled, title: model?.title },
    send: p.querySelector('[data-act="send"]')?.disabled,
    alert: { text: p.querySelector('.p-alert-slot')?.textContent.replace(/\\s+/g, ' ').trim().slice(0, 160), enabled: [...p.querySelectorAll('.p-alert-slot button')].filter((b) => !b.disabled).length },
  };
})())`).then(JSON.parse);
const openDesk = async (page, channel, agent) => {
  await until(page, `!!document.querySelector('svg.room[data-channel="${channel}"] .desk[data-agent="${agent}"]')`, `${agent}'s desk is drawn`);
  await page.click(`svg.room[data-channel="${channel}"] .desk[data-agent="${agent}"] .deskHit`);
  await until(page, `document.getElementById('floor-panel')?.dataset.agent === '${agent}'`, `${agent}'s panel opens`);
  await new Promise((r) => setTimeout(r, 700));
};

console.log('\nthe guest: only its card\'s building');
const g = await open({ base: `${guestBase}/?floor=beta`, view: 'floor', floor: 'beta' });
await until(g, `!!document.querySelector('svg.room[data-channel="beta"]')`, 'beta is drawn');
ok(await g.evalJs(`!document.querySelector('svg.room[data-channel="alpha"]')`), 'alpha, outside the card, is not drawn');
const floors = await g.evalJs(`fetch('./api/floor').then((r) => r.json()).then((j) => JSON.stringify(j.channels.map((c) => c.channel)))`);
ok(floors === '["beta"]', 'and its payload holds beta alone', floors);
const where = await g.evalJs(`document.getElementById('building-pick').textContent.replace(/\\s+/g, ' ').trim()`);
ok(where === `Shared at ${machine}`, 'the header reads "Shared at <the board\'s computer>"', where);
await g.click('#open-settings');
await until(g, `document.getElementById('settings-dlg').open`, 'Settings opens');
const secs = await g.evalJs(`JSON.stringify([...document.querySelectorAll('#set-body > .set-tool, #set-body > #set-updates')].map((s) => s.id || s.querySelector('.set-h')?.textContent.trim()))`);
ok(!/set-buildings|set-updates|Export|Recover/.test(secs), 'Settings has none of the board\'s own sections', secs);
await g.key('Escape');

console.log('\nthe guest on the owner\'s desk');
await openDesk(g, 'beta', 'fay');
let p = await panel(g);
ok(p.links.length === 0, 'no seat links, sessions or leave', JSON.stringify(p.links));
ok(p.stop.disabled && /can stop Fay/.test(p.stop.title), 'the stop sign is dimmed, saying who can', p.stop.title);
ok(p.model.disabled && /model and effort are .*'s to change/.test(p.model.title), 'the model is dimmed, saying whose it is', p.model.title);
ok(p.send === false, 'and the message box takes a message (talk runs both ways)');
await g.evalJs(`(() => { const t = document.getElementById('p-text'); t.focus(); t.value = 'hello from the guest'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await g.click('#floor-panel [data-act="send"]');
await until(g, `[...document.querySelectorAll('#floor-panel .t-user[data-id]')].some((n) => /^\\d+$/.test(n.dataset.id) && /hello from the guest/.test(n.textContent))`, 'the message comes back as a recorded turn', 15000);
const mine = await g.evalJs(`[...document.querySelectorAll('#floor-panel .t-user[data-id]')].filter((n) => /^\\d+$/.test(n.dataset.id) && /hello from the guest/.test(n.textContent)).map((n) => n.querySelector('.t-who').firstChild.textContent.trim()).pop()`);
ok(mine === 'you', 'in Gail\'s own panel, her message is "you"', mine);
await g.shot(`${shots}/guest-on-owner-desk.png`, null, { scale: 1 });

console.log('\nthe owner, at the keyboard, reads it as from Gail');
const shared = await g.evalJs(`fetch('./api/buildings').then((r) => r.json()).then((j) => j.buildings[0].id)`);
const o = await open({ base: `${direct}/?building=${shared}&floor=beta`, view: 'floor', floor: 'beta' });
await openDesk(o, 'beta', 'fay');
await until(o, `[...document.querySelectorAll('#floor-panel .t-user')].some((n) => /hello from the guest/.test(n.textContent))`, 'the owner\'s panel has the message');
const turn = await o.evalJs(`JSON.stringify([...document.querySelectorAll('#floor-panel .t-user[data-id]')].filter((n) => /hello from the guest/.test(n.textContent)).map((n) => ({ who: n.querySelector('.t-who').firstChild.textContent.trim(), body: n.querySelector('.t-body').textContent })).pop())`).then(JSON.parse);
ok(turn.who === 'Gail' && turn.body === 'hello from the guest', 'the bubble says Gail, and the words without the attribution line', JSON.stringify(turn));
p = await panel(o);
ok(p.links.includes('sessions') || p.links.length > 0, 'and on its own desk the owner keeps its controls', JSON.stringify(p.links));

console.log('\nthe owner on the guest\'s desk');
// Gwen mid-turn, so her stop sign is live for Gail: dimmed for the owner
// only because she is not the owner's to stop.
await fetch(`${direct}/api/host/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestratinator-key': 'k' },
  body: JSON.stringify({ host_id: 'op_guest~mac', events: [{ type: 'state', channel: 'beta', agent: 'gwen', session_id: 's-gwen', state: 'working' }] }) });
await until(o, `fetch('./api/floor').then((r) => r.json()).then((j) => { window.__gw = j.channels.find((c) => c.channel === 'beta').desks.find((d) => d.agent === 'gwen'); return window.__gw?.stop?.ok === true; })`, 'the board says Gwen can be stopped (the fixture)');
await openDesk(o, 'beta', 'gwen');
await new Promise((r) => setTimeout(r, 2500));
p = await panel(o);
ok(p.links.length === 0, 'no seat links, sessions or leave', JSON.stringify(p.links));
ok(p.stop.disabled && /Only Gail can stop Gwen/.test(p.stop.title), 'the stop sign names Gail', p.stop.title);
await g.goto(`${guestBase}/?floor=beta`);
await openDesk(g, 'beta', 'gwen');
const gs = await panel(g);
ok(gs.stop.disabled === false, 'and at the same moment Gail\'s stop sign on her own working agent is live (the owner\'s was ownership, not idleness)', JSON.stringify(gs.stop));
await fetch(`${direct}/api/host/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestratinator-key': 'k' },
  body: JSON.stringify({ host_id: 'op_guest~mac', events: [{ type: 'ask', channel: 'beta', agent: 'gwen', session_id: 's-gwen', request_id: 'g-1', kind: 'permission', tool: 'Bash', tool_input: { command: 'rm -rf build' }, summary: 'Bash: rm -rf build', options: [{ n: 1, text: 'Yes' }, { n: 3, text: 'No' }] }] }) });
await until(o, `/rm -rf build/.test(document.querySelector('#floor-panel .p-alert-slot')?.textContent ?? '')`, 'gwen\'s prompt is shown to the owner');
p = await panel(o);
ok(p.alert.enabled === 0, 'with nothing in it the owner can press', JSON.stringify(p.alert));
ok(/Gail answers Gwen's prompts/.test(p.alert.text), 'and a line saying Gail answers it', p.alert.text);
const ph = await o.evalJs(`document.getElementById('p-text').placeholder`);
ok(/asking Gail something .* once they answer/.test(ph), 'the box says a message waits for Gail\'s answer, not "yours"', ph);
await o.shot(`${shots}/owner-on-guest-desk.png`, null, { scale: 1 });

console.log('\nGail answers her own agent\'s prompt');
await g.goto(`${guestBase}/?floor=beta`);
await openDesk(g, 'beta', 'gwen');
await until(g, `!!document.querySelector('#floor-panel .p-alert-slot button:not([disabled])')`, 'Gail\'s panel has the prompt, answerable');
p = await panel(g);
ok(p.alert.enabled > 0 && !/answers Gwen/.test(p.alert.text), 'her own agent\'s prompt is hers to answer', JSON.stringify(p.alert));
ok(p.links.length > 0 || !p.stop.disabled, 'and her own desk\'s controls are hers', JSON.stringify([p.links, p.stop]));

console.log(fails ? `\nFAIL · ${fails} of ${total} red` : `\nPASS · ${total} of ${total}`);
process.exit(fails ? 1 : 0);

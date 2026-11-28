// The boards an invitee is in, as buttons on the invitee's own floor (costmo, 2026-11-27;
// contract orchestratinator.guest_boards). Green with the owner sharing; red once the owner
// pauses; green again; a click opens the owner's floor in a new window; a right-click names it.
//   node guest-row.mjs <owner port> <invitee port> <label>
import { app, pane, tab, SHOTS } from './lib.mjs';
const [oport, gport, label] = process.argv.slice(2);
const ga = await app(Number(gport));
const floor = await ga.find((u) => /127\.0\.0\.1:\d+\/\?floor=/.test(u));
await floor.setViewportSize({ width: 1300, height: 800 });
let fails = 0;
const ok = (c, m, x = '') => { console.log(`  ${c ? '✓' : '✗'} ${m}${c || !x ? '' : `  (${x})`}`); if (!c) fails++; };
const pills = () => floor.evaluate(() => [...document.querySelectorAll('#guest-boards .gb')].map((g) => ({ id: g.dataset.guestBoard, state: g.className.replace('gb ', ''), label: g.querySelector('.gb-label')?.textContent, title: g.querySelector('.gb-open')?.title })));
const waitState = async (want, ms) => { const end = Date.now() + ms; let last; for (;;) { last = await pills(); if (last.length && last.every((x) => x.state === want)) return { ok: true, last, s: Math.round((ms - (end - Date.now())) / 1000) }; if (Date.now() > end) return { ok: false, last }; await floor.waitForTimeout(1000); } };
let r = await waitState('available', 90000);
ok(r.ok, `the invitee's floor shows the owner's board, green (${r.s ?? '-'} s)`, JSON.stringify(r.last));
await floor.screenshot({ path: `${SHOTS}${label}-g1-available.png` });
const o = await pane(Number(oport));
await tab(o, 'sharing');
await o.getByTestId('settings-sharing-on').click();
await o.waitForTimeout(4000);
r = await waitState('blocked', 150000);
ok(r.ok, `the owner pauses sharing: the pill turns red (${r.s ?? '-'} s)`, JSON.stringify(r.last));
if (r.last[0]) console.log('  hover:', r.last[0].title.replace(/\s+/g, ' '));
await floor.screenshot({ path: `${SHOTS}${label}-g2-paused.png` });
await o.getByTestId('settings-sharing-on').click();
await o.waitForTimeout(4000);
r = await waitState('available', 150000);
ok(r.ok, `the owner shares again: green (${r.s ?? '-'} s)`, JSON.stringify(r.last));
const before = ga.pages().map((x) => x.url());
await floor.locator('#guest-boards .gb-open').first().click();
let win = null;
for (let i = 0; i < 40 && !win; i++) { await floor.waitForTimeout(500); win = ga.pages().find((x) => !before.includes(x.url()) && /ngrok\.dev/.test(x.url())); }
ok(!!win, 'a click opens the owner\'s floor in a new window', ga.pages().map((x) => x.url()).join(' '));
if (win) { await win.setViewportSize({ width: 1300, height: 850 }); await win.waitForTimeout(5000); await win.screenshot({ path: `${SHOTS}${label}-g3-opened.png` }); }
await floor.bringToFront().catch(() => {});
await floor.locator('#guest-boards .gb-open').first().click({ button: 'right' });
await floor.locator('#guest-boards .gb-input').waitFor({ timeout: 5000 });
await floor.keyboard.type('Owner HQ'); // the field opens with the label selected
await floor.keyboard.press('Enter');
await floor.waitForTimeout(6000);
await floor.reload();
await floor.locator('#guest-boards .gb').first().waitFor({ timeout: 60000 });
const after = await pills();
ok(after[0]?.label === 'Owner HQ', 'a right-click names it, and the app keeps the name across a reload', JSON.stringify(after));
await floor.screenshot({ path: `${SHOTS}${label}-g4-renamed.png` });
await floor.locator('#guest-boards .gb-open').first().click({ button: 'right' });
await floor.locator('#guest-boards .gb-input').waitFor({ timeout: 5000 });
await floor.keyboard.press('Backspace'); // selected on open
await floor.keyboard.press('Enter');
await floor.waitForTimeout(4000);
console.log('  after clearing the label:', JSON.stringify((await pills()).map((x) => x.label)));
console.log(fails ? `FAIL ${fails}` : 'PASS');
process.exit(fails ? 1 : 0);

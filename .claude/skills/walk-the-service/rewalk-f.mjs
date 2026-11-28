// Re-walk of the first UI/UX walk's findings (2026-11-27), on the same two apps.
//   node rewalk-f.mjs <owner port> <invitee port> <label>
import { app, pane, tab, SHOTS } from './lib.mjs';
const [oport, gport, label] = process.argv.slice(2).map((x, i) => (i < 2 ? Number(x) : x));
let fails = 0;
const ok = (c, m, x = '') => { console.log(`  ${c ? '✓' : '✗'} ${m}${c || !x ? '' : `  (${x})`}`); if (!c) fails++; };
const ga = await app(gport); const oa = await app(oport);
const floor = await ga.find((u) => /127\.0\.0\.1:\d+\/\?floor=/.test(u));
const ofloor = await oa.find((u) => /127\.0\.0\.1:\d+\/\?floor=/.test(u));
const pills = () => floor.evaluate(() => [...document.querySelectorAll('#guest-boards .gb')].map((g) => ({ state: g.className.replace('gb ', ''), label: g.querySelector('.gb-label')?.textContent })));
const guestLive = () => ofloor.evaluate(async () => (await (await fetch('./api/floor')).json()).hosts.filter((h) => /~/.test(h.host_id ?? h.id ?? '')).map((h) => h.live));
const until = async (fn, ms) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return Math.round((Date.now() - t0) / 1000); if (Date.now() - t0 > ms) return null; await floor.waitForTimeout(1000); } };

console.log('\nF3: the pill names whose board it is');
await until(async () => (await pills()).length > 0, 90000);
const first = await pills();
console.log('  pills:', JSON.stringify(first));
ok(first.some((p) => /Walk Owner.s costmo4\.local/.test(p.label) || p.label === 'Owner HQ'), 'the default name is "Walk Owner’s costmo4.local" (or the label kept from the first walk)', JSON.stringify(first));
if (first[0]?.label === 'Owner HQ') {
  await floor.locator('#guest-boards .gb-open').first().click({ button: 'right' });
  await floor.locator('#guest-boards .gb-input').waitFor({ timeout: 5000 });
  await floor.keyboard.press('Backspace');
  await floor.keyboard.press('Enter');
  const s = await until(async () => /Walk Owner.s costmo4\.local/.test((await pills())[0]?.label ?? ''), 20000);
  ok(s !== null, `clearing the label puts back "Walk Owner’s costmo4.local" (${s} s)`, JSON.stringify(await pills()));
}
await floor.screenshot({ path: `${SHOTS}${label}-f3-name.png` });

console.log('\nF1: pause, then share again: the guest comes back with Settings agreeing');
let s = await until(async () => (await guestLive()).some(Boolean), 120000);
ok(s !== null, `before: the invitee's host is live on the owner's board (${s} s)`);
const o = await pane(oport);
await tab(o, 'sharing');
await o.getByTestId('settings-sharing-on').click();
s = await until(async () => (await pills()).every((p) => p.state === 'blocked'), 150000);
ok(s !== null, `paused: the pill turns red (${s} s)`);
await o.getByTestId('settings-sharing-on').click();
const t0 = Date.now();
s = await until(async () => (await pills()).every((p) => p.state === 'available'), 150000);
ok(s !== null, `shared again: the pill is green (${s} s)`);
const back = await until(async () => (await guestLive()).some(Boolean), 120000);
ok(back !== null, `and the invitee's host is live on the owner's board again (${Math.round((Date.now() - t0) / 1000)} s after the share)`, JSON.stringify(await guestLive()));
const gs = await pane(gport); await tab(gs, 'sharing');
const words = await until(async () => { const t = await gs.getByTestId('settings-service-guests').innerText(); return !/paused/i.test(t) && /\bOpen\b/.test(t); }, 60000);
ok(words !== null, 'and the invitee\'s Settings agrees: no "paused", Open is back', (await gs.getByTestId('settings-service-guests').innerText()).replace(/\s+/g, ' '));
await gs.screenshot({ path: `${SHOTS}${label}-f1-settings.png` });

console.log('\nF2: ⚙ in the owner\'s floor window opens the app\'s Settings');
await gs.close(); await floor.waitForTimeout(1500);
const before = ga.pages().map((p) => p.url());
await floor.locator('#guest-boards .gb-open').first().click();
let win = null;
for (let i = 0; i < 40 && !win; i++) { await floor.waitForTimeout(500); win = ga.pages().find((x) => /ngrok\.dev\/\?floor=/.test(x.url())); }
ok(!!win, 'the owner\'s floor is open in a window');
const n0 = ga.pages().length;
await win.locator('#open-settings').click();
let opened = null;
for (let i = 0; i < 20 && !opened; i++) { await floor.waitForTimeout(500); opened = ga.pages().find((x) => x.url().endsWith('/settings.html')); }
ok(!!opened, 'its ⚙ opens the app\'s Settings pane', ga.pages().map((p) => p.url()).join(' '));
ok(!ga.pages().some((x) => /ngrok\.dev\/\?settings=1/.test(x.url())), 'and no window of the owner\'s settings page');

console.log('\nF4: spacing in Sharing (owner)');
const gaps = await o.evaluate(() => {
  const parts = [...document.querySelectorAll('#panel-sharing .settings__part')].filter((e) => e.offsetParent);
  const between = parts.slice(1).map((e, i) => Math.round(e.getBoundingClientRect().top - parts[i].getBoundingClientRect().bottom));
  const rows = [...document.querySelectorAll('#panel-sharing li')].filter((e) => e.offsetParent).map((e) => Math.round(e.getBoundingClientRect().height));
  const sub = [...document.querySelectorAll('#panel-sharing .settings__subheading')].filter((e) => e.offsetParent).map((h) => { const l = h.nextElementSibling; return l ? Math.round(l.getBoundingClientRect().top - h.getBoundingClientRect().bottom) : null; });
  return { between, rows, sub };
});
console.log('  measured:', JSON.stringify(gaps));
ok(gaps.between.every((g) => g >= 16) && gaps.rows.every((h) => h >= 26) && gaps.sub.every((g) => g === null || g >= 6), 'parts ≥16 px apart, rows ≥26 px, heading to list ≥6 px');
await o.screenshot({ path: `${SHOTS}${label}-f4-sharing.png` });
console.log(fails ? `FAIL ${fails}` : 'PASS');
process.exit(fails ? 1 : 0);

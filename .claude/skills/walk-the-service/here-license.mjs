// The round's last two items (costmo, 2026-11-28), on the same two apps:
// - in a window on the owner's board, its own pill is a label (HERE), opens nothing, and the window's
//   title names the board;
// - the invitee, connected with no license, finds "Share my buildings" disabled with why, and Add a license
//   goes to About ▸ License.   node here-license.mjs <owner port> <invitee port> <label>
import { app, pane, tab, SHOTS } from './lib.mjs';
const [oport, gport, label] = process.argv.slice(2).map((x, i) => (i < 2 ? Number(x) : x));
let fails = 0;
const ok = (c, m, x = '') => { console.log(`  ${c ? '✓' : '✗'} ${m}${c || !x ? '' : `  (${x})`}`); if (!c) fails++; };
const ga = await app(gport);
const floor = await ga.find((u) => /127\.0\.0\.1:\d+\/\?floor=/.test(u));
await floor.locator('#guest-boards .gb').first().waitFor({ timeout: 90000 });

console.log('\nHERE: the board this window shows');
let win = ga.pages().find((x) => /ngrok\.dev\/\?floor=/.test(x.url()));
if (!win) {
  await floor.locator('#guest-boards .gb-open').first().click();
  for (let i = 0; i < 40 && !win; i++) { await floor.waitForTimeout(500); win = ga.pages().find((x) => /ngrok\.dev\/\?floor=/.test(x.url())); }
}
ok(!!win, 'the owner\'s floor is open in a window of the invitee\'s app');
await win.setViewportSize({ width: 1300, height: 800 });
await win.locator('#guest-boards .gb.here').waitFor({ timeout: 30000 }).catch(() => {});
const here = await win.evaluate(() => { const g = document.querySelector('#guest-boards .gb.here'); return g ? { label: g.querySelector('.gb-label')?.textContent, button: !!g.querySelector('button'), current: !!g.querySelector('[aria-current="page"]') } : null; });
ok(!!here && !here.button && here.current, 'its own pill is a label: aria-current, no button', JSON.stringify(here));
const before = ga.pages().length;
await win.locator('#guest-boards .gb.here .gb-open').click().catch(() => {});
await win.locator('#guest-boards .gb.here .gb-open').click({ button: 'right' }).catch(() => {});
await win.waitForTimeout(2000);
ok(ga.pages().length === before && !(await win.locator('#guest-boards .gb-input').count()), 'a click or right-click on it opens and renames nothing', `${before} → ${ga.pages().length}`);
const title = await win.title();
ok(here && title.endsWith(` · ${here.label}`), 'the window\'s title names the board, after the floor', title);
await win.screenshot({ path: `${SHOTS}${label}-h1-here.png` });

console.log('\nShare my buildings: disabled with no license');
const gs = await pane(gport); await tab(gs, 'about');
const lic = (await gs.getByTestId('settings-license-title').innerText()).trim();
console.log('  the invitee\'s license:', lic);
await tab(gs, 'sharing');
const box = gs.getByTestId('settings-sharing-on');
ok(/no license/i.test(lic) && await box.isDisabled(), 'connected with no license: the checkbox is disabled', `license "${lic}", disabled ${await box.isDisabled()}`);
const words = (await gs.getByTestId('settings-sharing').innerText()).replace(/\s+/g, ' ');
ok(/needs a license/i.test(words), 'and says why', words.slice(0, 300));
await gs.screenshot({ path: `${SHOTS}${label}-h2-sharing-disabled.png` });
await gs.getByRole('button', { name: /add a license/i }).click();
await gs.getByTestId('settings-panel-about').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
ok(await gs.getByTestId('settings-panel-about').isVisible(), 'Add a license goes to About ▸ License');
const o = await pane(oport); await tab(o, 'sharing');
ok(await o.getByTestId('settings-sharing-on').isEnabled(), 'the owner, licensed, still has it enabled');
console.log(fails ? `FAIL ${fails}` : 'PASS');
process.exit(fails ? 1 : 0);

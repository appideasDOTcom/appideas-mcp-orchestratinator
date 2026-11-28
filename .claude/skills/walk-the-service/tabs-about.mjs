// The Settings tabs as a person meets them (costmo, 2026-11-27): General, Sharing, About.
// About: the logo drawn, the name, the version, the two links. Shots of each tab.
//   node tabs-about.mjs <port> <label> <scratch name>
import { pane, shot, tab, urls } from './lib.mjs';
const [port, label, scratch] = process.argv.slice(2);
const p = await pane(Number(port));
let fails = 0;
const ok = (c, m, x = '') => { console.log(`  ${c ? '✓' : '✗'} ${m}${c || !x ? '' : `  (${x})`}`); if (!c) fails++; };
ok(await p.getByTestId('settings-panel-general').isVisible(), 'Settings opens on General');
await shot(p, `${label}-t1-general`);
await tab(p, 'sharing');
ok(!(await p.getByTestId('settings-panel-general').isVisible()), 'Sharing hides General');
await shot(p, `${label}-t2-sharing`);
await tab(p, 'about');
const name = await p.getByTestId('settings-about-name').innerText();
ok(name.trim() === 'APP(ideas) MCP Orchestratinator', 'the app is named as costmo wrote it', name);
const version = await p.getByTestId('settings-about-version').innerText();
ok(/\d+\.\d+\.\d+/.test(version), 'the version is shown', version);
ok(await p.getByTestId('settings-about-logo').evaluate((i) => i.complete && i.naturalWidth > 0), 'the logo is drawn');
// Each link is a button the app opens in the person's browser; a hidden app writes the address instead.
const opened = async (testid) => { const n = urls(scratch).length; await p.getByTestId(testid).click(); for (let i = 0; i < 20 && urls(scratch).length === n; i++) await p.waitForTimeout(250); return urls(scratch).slice(n)[0] ?? null; };
const gh = await opened('settings-about-github');
const site = await opened('settings-about-site');
ok(/github\.com\//.test(gh ?? ''), 'a GitHub link', gh);
ok(/appideas\.com\/orchestratinator\/?$/.test(site ?? ''), 'an appideas.com/orchestratinator/ link', site);
ok(await p.getByTestId('settings-license').isVisible(), 'the License section is there');
console.log('  license:', (await p.getByTestId('settings-license').innerText()).replace(/\s+/g, ' '));
await shot(p, `${label}-t3-about`);
console.log(fails ? `FAIL ${fails}` : 'PASS');
process.exit(fails ? 1 : 0);

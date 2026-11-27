// The Settings tabs as a person meets them (costmo, 2026-11-27): General, Sharing, About.
// About: the logo drawn, the name, the version, the two links. Shots of each tab.
//   node tabs-about.mjs <port> <label>
import { pane, shot, tab } from './lib.mjs';
const [port, label] = process.argv.slice(2);
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
const gh = await p.getByTestId('settings-about-github').getAttribute('href');
const site = await p.getByTestId('settings-about-site').getAttribute('href');
ok(/github\.com\//.test(gh ?? ''), 'a GitHub link', gh);
ok(/appideas\.com\/orchestratinator\/?$/.test(site ?? ''), 'an appideas.com/orchestratinator/ link', site);
ok(await p.getByTestId('settings-license').isVisible(), 'the License section is there');
console.log('  license:', (await p.getByTestId('settings-license').innerText()).replace(/\s+/g, ' '));
await shot(p, `${label}-t3-about`);
console.log(fails ? `FAIL ${fails}` : 'PASS');
process.exit(fails ? 1 : 0);

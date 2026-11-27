// the invitee presses Open: the owner's floor should come up in a window of the invitee's own app.
import { app, SHOTS, pane, urls, tab } from './lib.mjs';

const [port, name] = process.argv.slice(2);
const a = await app(Number(port));
const p = await pane(Number(port));
await tab(p, 'sharing');
const before = a.pages().map((x) => x.url());
const ub = urls(name).length;
await p.getByRole('button', { name: /^open$/i }).first().click();
let win = null;
for (let i = 0; i < 40 && !win; i++) { await p.waitForTimeout(500); win = a.pages().find((x) => !before.includes(x.url()) && /^https?:/.test(x.url())); }
console.log('new pages:', a.pages().map((x) => x.url()).filter((u) => !before.includes(u)), 'urls opened:', urls(name).slice(ub));
if (win) { await win.setViewportSize({ width: 1300, height: 850 }); await win.waitForTimeout(6000); await win.screenshot({ path: SHOTS + 'c17-invitee-owner-floor.png' }); console.log((await win.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 500)); }
process.exit(0);

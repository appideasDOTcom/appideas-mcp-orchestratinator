import { app, SHOTS } from './lib.mjs';
const [port, label] = process.argv.slice(2);
const b = (await app(Number(port))).browser;
const pages = b.contexts().flatMap((c) => c.pages());
for (const [i, p] of pages.entries()) { console.log(i, p.url()); await p.screenshot({ path: `${SHOTS}${label}-${i}.png` }); console.log((await p.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 400)); }
process.exit(0);

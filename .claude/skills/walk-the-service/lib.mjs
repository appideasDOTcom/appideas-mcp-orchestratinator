// Shared by the walk's scripts: a scratch app's pages over its DevTools port,
// its Settings pane, a shot of it, and the person's browser for the sign-in.
// Everything runs hidden or headless: nothing may appear on costmo's screen
// or take focus (2026-11-27: he types into windows that do).
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
const DESKTOP = new URL('../../../../orchestratinator-desktop/', import.meta.url).pathname;
const { chromium } = await import(`${DESKTOP}node_modules/playwright-core/index.mjs`);
const TMP = realpathSync(tmpdir()) + '/';
export const DIR = process.env.WALK_DIR ?? `${TMP}walk-the-service/`;
export const SHOTS = `${DIR}shots/`;
mkdirSync(SHOTS, { recursive: true });
export const text = async (p) => (await p.locator('body').innerText()).replace(/\s+/g, ' ');
/** What a hidden scratch app would have opened in the person's browser (start-scratch's --open-urls-to). */
export function urls(name) {
  const file = `${TMP}orch-desktop-scratch/${name}/opened-urls.txt`;
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}
/** One app's pages, through its DevTools port. */
export async function app(port) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const pages = () => browser.contexts().flatMap((c) => c.pages());
  const find = async (test, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      const found = pages().find((p) => test(p.url()));
      if (found) return found;
      if (Date.now() > end) throw new Error('no page (is the app past its first-run screen? see SKILL.md, --claude-from)');
      await new Promise((r) => setTimeout(r, 300));
    }
  };
  /** Settings, opened the way the floor's own ⚙ opens it (CDP alone can't reach the app's menu). */
  const settings = async () => {
    const open = pages().find((p) => p.url().endsWith('/settings.html'));
    if (open) return open;
    const floor = await find((u) => u.includes('?floor='));
    await floor.evaluate(() => window.open(`${location.pathname}?settings=1`, '_blank'));
    return find((u) => u.endsWith('/settings.html'));
  };
  return { browser, pages, find, settings };
}
/** The Settings pane of a scratch app, sized as a person's window would be. */
export async function pane(port) {
  const p = await (await app(port)).settings();
  await p.setViewportSize({ width: 620, height: 1000 });
  await p.waitForTimeout(1200);
  return p;
}
/** A full-page shot of the pane, and what it says, for the record. */
export async function shot(p, label) {
  await p.waitForTimeout(600);
  await p.screenshot({ path: `${SHOTS}${label}.png`, fullPage: true });
  console.log(`[${label}] ${(await text(p)).replace(/^.*?(Orchestratinator service)/, '$1').slice(0, 700)}`);
}
/** Plays the person in a headless browser: appideas.com's sign-in, then Continue as. */
export async function browserSignIn(address, user, password, label) {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 800 } })).newPage();
  await page.goto(address);
  let step = 1;
  const s = async (what) => { await page.screenshot({ path: `${SHOTS}${label}-browser-${step++}-${what}.png` }); console.log(`  browser [${what}] ${page.url().replace(/\?.*/, '')} — ${(await text(page)).slice(0, 200)}`); };
  await s('first');
  for (let guard = 0; guard < 8; guard++) {
    if (page.url().startsWith('http://127.0.0.1')) break;
    if (await page.locator('#user_login').count()) {
      await page.fill('#user_login', user); await page.fill('#user_pass', password);
      await Promise.all([page.waitForLoadState(), page.click('#wp-submit')]); await page.waitForTimeout(1500);
      await s('after-login'); continue;
    }
    const named = /^(continue as|continue|log in)\b/i;
    const button = page.getByRole('button', { name: named }).or(page.getByRole('link', { name: named })).first();
    await button.waitFor({ timeout: 20000 }).catch(() => undefined);
    if (!(await button.count())) { await s('stuck'); break; }
    const name = (await button.innerText()).trim();
    await Promise.all([page.waitForLoadState(), button.click()]); await page.waitForTimeout(1500);
    await s(`after-${name.replace(/\W+/g, '-').toLowerCase().slice(0, 24)}`);
  }
  await browser.close();
}

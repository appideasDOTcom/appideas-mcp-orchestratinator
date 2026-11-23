#!/usr/bin/env node
/**
 * The protocol probe's banner on the floor (task 351): a host whose Claude
 * Code answered the probe differently shows the version, the host and each
 * row that differed, in the probe's own words; one that matched shows
 * nothing; one that could not be checked says why. The host's result arrives
 * as a `canary` event (host/index.js canaryCheck), posted here as that host.
 *
 *   .claude/skills/verify-ui-change/run-check-canary.sh <repo copy>
 */
import { open } from './drive.mjs';

await import('../../../src/node-floor.js').catch((e) => { if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e; });
const base = process.argv[2] ?? 'http://localhost:8953';
const SHOTS = process.argv[3];
let fails = 0;
let total = 0;
const ok = (cond, msg, extra = '') => { total++; console.log(`  ${cond ? '✓' : '✗'} ${msg}${cond || !extra ? '' : `  (${extra})`}`); if (!cond) fails++; };
const stopped = (e) => { total++; fails++; console.log(`  ✗ the check stopped on: ${String(e?.message ?? e).split('\n')[0]}`); console.log(`\nFAIL · ${fails} of ${total} red`); process.exit(1); };
process.on('uncaughtException', stopped);
process.on('unhandledRejection', stopped);
const say = (canary) => fetch(`${base}/api/host/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestratinator-key': 'k' }, body: JSON.stringify({ host_id: 'h1', events: [{ type: 'canary', canary }] }) }).then((r) => r.status);
const banner = (p) => p.evalJs(`JSON.stringify((() => { const b = document.getElementById('floor-canary'); return { shown: !!b && !b.classList.contains('hidden') && b.getBoundingClientRect().height > 0, text: b?.textContent.replace(/\\s+/g, ' ').trim() ?? '' }; })())`).then(JSON.parse);
const waitBanner = (p, pred, what) => p.waitFor(`(() => { const b = document.getElementById('floor-canary'); const t = b?.textContent ?? ''; const shown = !!b && !b.classList.contains('hidden'); return (${pred})(shown, t); })()`, { timeout: 12000 }).catch(async () => { throw new Error(`${what} — not in 12 s; the banner reads ${JSON.stringify(await banner(p))}`); });

console.log('\nthe floor with every host\'s probe matching, or none run');
const page = await open({ base, view: 'floor', floor: 'alpha' });
await page.waitFor(`!!document.querySelector('.desk[data-agent="bo"]')`, { timeout: 12000 });
let b = await banner(page);
ok(!b.shown, 'no banner while nothing differed', JSON.stringify(b));

console.log('\na Claude Code that answered differently');
ok((await say({ version: '2.1.999', ok: false, total: 32, differed: [{ what: "command_lifecycle records are sent (the host's receipt)", saw: 'none seen' }, { what: 'an init names the session', saw: '{}' }] })) === 200, 'the fixture: the host says its probe found two rows different');
await waitBanner(page, '(s, t) => s && /2\\.1\\.999/.test(t)', 'the banner appears');
b = await banner(page);
ok(b.shown && /Claude Code 2\.1\.999 on testbox/.test(b.text), 'a banner names the version and the host', b.text);
ok(/answered 2 of the floor's 32 protocol checks differently/.test(b.text), 'and how many of the checks differed', b.text);
ok(/command_lifecycle records are sent \(the host's receipt\)/.test(b.text) && /none seen/.test(b.text) && /an init names the session/.test(b.text), 'and each row, in the probe\'s own words, with what it saw', b.text);
ok(/Desks keep running/.test(b.text), 'and says the desks are not held by it', b.text);
if (SHOTS) await page.shot(`${SHOTS}/canary-differed.png`).catch(() => {});

console.log('\nthe same Claude Code once it matches');
ok((await say({ version: '2.1.999', ok: true, total: 32, differed: [] })) === 200, 'the fixture: the host says its probe matched');
await waitBanner(page, '(s) => !s', 'the banner goes');
ok(!(await banner(page)).shown, 'and the banner is gone');

console.log('\na probe that could not run');
ok((await say({ version: '2.1.999', error: 'its first message did not come back (Not logged in · Please run /login), so nothing could be compared' })) === 200, 'the fixture: the host says its probe could not run');
await waitBanner(page, '(s, t) => s && /could not be checked/.test(t)', 'the banner says it could not be checked');
b = await banner(page);
ok(/could not be checked with the floor's protocol probe: its first message did not come back \(Not logged in/.test(b.text), 'and why, in the host\'s words, never as a difference', b.text);

await page.close?.();
console.log(`\n${fails ? 'FAIL' : 'PASS'} · ${total - fails} of ${total}`);
process.exit(fails ? 1 : 0);

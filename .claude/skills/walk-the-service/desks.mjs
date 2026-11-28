// a desk on each side of the owner's floor: the owner's own (its host), and the invitee's (its host, through the relay).
import { app, SHOTS } from './lib.mjs';
const [oport, pport] = process.argv.slice(2).map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const o = await (await app(oport)).find((u) => /127\.0\.0\.1:\d+\/\?floor=/.test(u));
const g = await (await app(pport)).find((u) => /orchestratinator-dev\.ngrok\.dev/.test(u));
const api = (page, path, body) => page.evaluate(async ([path, body]) => { const r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}); return { status: r.status, body: await r.json().catch(() => null) }; }, [path, body]);
const hostsOf = async (page) => ((await api(page, './api/floor')).body?.hosts ?? []).map((h) => ({ id: h.id ?? h.host_id, name: h.name ?? h.label, live: h.live, operator: h.operator }));
console.log('owner sees hosts', JSON.stringify(await hostsOf(o)));
console.log('guest sees hosts', JSON.stringify(await hostsOf(g)));
const ownHost = (await hostsOf(o)).find((h) => h.live && !/~/.test(h.id))?.id;
const guestHost = (await hostsOf(g)).find((h) => h.live && /~/.test(h.id))?.id;
console.log({ ownHost, guestHost });
for (const [page, host, path, agent] of [[o, ownHost, (process.env.OWNER_DIR ?? '/private/tmp/cw-owner-agent'), 'owner-agent'], [g, guestHost, (process.env.PARTNER_DIR ?? '/private/tmp/cw-partner-agent'), 'partner-agent']]) {
  console.log(agent, 'browse', JSON.stringify(await api(page, './api/floor/browse', { host_id: host, path })).slice(0, 200));
  await sleep(2500);
  console.log(agent, 'desk', JSON.stringify(await api(page, './api/floor/desk', { host_id: host, path, channel: 'walk', agent })).slice(0, 300));
}
await sleep(15000);
const d = (await api(o, './api/floor')).body.channels.map((c) => c.channel + ': ' + c.desks.map((x) => `${x.agent}[${x.hosted?.live ? 'live' : '-'} op=${x.operator ?? x.hosted?.operator ?? ''}]`).join(' '));
console.log(d.join('\n'));
await o.screenshot({ path: SHOTS + 'c18-owner-floor-two-desks.png' });
await g.screenshot({ path: SHOTS + 'c19-invitee-window-two-desks.png' });
process.exit(0);

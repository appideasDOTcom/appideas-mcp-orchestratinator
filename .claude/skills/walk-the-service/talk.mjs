// owner-agent and partner-agent talk through the board, each driven from its own operator's window.
import { app, SHOTS } from './lib.mjs';
const [oport, pport] = process.argv.slice(2).map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const o = await (await app(oport)).find((u) => /127\.0\.0\.1:\d+\/\?floor=/.test(u));
const g = await (await app(pport)).find((u) => /orchestratinator-dev\.ngrok\.dev/.test(u));
const api = (page, path, body) => page.evaluate(async ([path, body]) => { const r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}); return r.json().catch(() => ({})); }, [path, body]);
const CH = 'walk';
const rows = async (page, agent) => (await api(page, `./api/floor/turns?channel=${CH}&agent=${agent}&limit=500`)).rows ?? [];
let fails = 0; const row = (ok, what, saw = '') => { if (!ok) fails++; console.log(`  ${ok ? '✓' : '✗'} ${what}${saw ? `  — ${String(saw).replace(/\s+/g, ' ').slice(0, 260)}` : ''}`); };
const allowed = new Set();
const until = async (fn, ms = 240000) => { const end = Date.now() + ms; for (;;) {
  for (const [page, mine] of [[o, 'owner-agent'], [g, 'partner-agent']]) {
    const d = (await api(page, './api/floor')).channels?.find((c) => c.channel === CH)?.desks?.find((x) => x.agent === mine);
    if (d?.permission && !allowed.has(d.permission.request_id)) { allowed.add(d.permission.request_id); console.log(`    (${mine}'s operator allows: ${String(d.permission.summary).slice(0, 80)})`); await api(page, './api/floor/permission', { channel: CH, agent: mine, request_id: d.permission.request_id, decision: 'allow' }); }
  }
  const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(2000); } };
const say = async (page, agent, text) => { const n = (await rows(page, agent)).length; const r = await api(page, './api/floor/chat', { channel: CH, agent, text }); return { n, r }; };
const reply = (page, agent, n, re) => until(async () => (await rows(page, agent)).slice(n).find((t) => t.role === 'assistant' && re.test(t.text ?? '')));
const PING = `PING-${Date.now()}`, PONG = `PONG-${Date.now()}`;

let s = await say(o, 'owner-agent', `Use the orchestratinator board's send_message tool to send the agent partner-agent exactly this message: ${PING}. Then reply with exactly SENT.`);
row(!s.r.error, 'the owner\'s window sends owner-agent a message', JSON.stringify(s.r));
let r = await reply(o, 'owner-agent', s.n, /SENT|error|could not/i);
row(/SENT/.test(r?.text ?? ''), 'owner-agent sent partner-agent a message on the board', r?.text);

s = await say(g, 'partner-agent', `Use the orchestratinator board's poll_messages tool. Reply with exactly the text of the newest message from owner-agent. Then use send_message to send owner-agent exactly: ${PONG}.`);
row(!s.r.error, 'the invitee\'s window (through the relay) sends partner-agent a message', JSON.stringify(s.r));
r = await reply(g, 'partner-agent', s.n, new RegExp(`${PING}|error|nothing|no message`, 'i'));
row(new RegExp(PING).test(r?.text ?? ''), 'partner-agent, on the invitee\'s computer, read owner-agent\'s message', r?.text);

await sleep(20000);
s = await say(o, 'owner-agent', 'Use the orchestratinator board\'s poll_messages tool and reply with exactly the text of the newest message from partner-agent.');
r = await reply(o, 'owner-agent', s.n, new RegExp(`${PONG}|nothing|no message|error`, 'i'));
row(new RegExp(PONG).test(r?.text ?? ''), 'owner-agent read partner-agent\'s answer', r?.text);

const seen = (await rows(o, 'partner-agent')).filter((t) => t.role === 'assistant').slice(-1)[0];
row(new RegExp(PING).test(seen?.text ?? ''), 'and the owner\'s floor shows what partner-agent said', seen?.text);
await o.screenshot({ path: SHOTS + 'c20-owner-floor-after-talk.png' });
await g.screenshot({ path: SHOTS + 'c21-invitee-window-after-talk.png' });
console.log(fails ? `FAIL ${fails}` : 'PASS');
process.exit(0);

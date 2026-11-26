#!/usr/bin/env node
// Real inboxes for walking the service's emails: a real address on the
// internet that SendGrid delivers to like any other, read over mail.tm's
// public API. So a walk sends real mail and clicks the link a person would
// get, never a file the service wrote instead (costmo, 2026-11-25: "Send
// real damn emails to test emails").
//
//   node real-inbox.mjs new [label]          make an address; prints it
//   node real-inbox.mjs wait <address> [--subject <regex>] [--timeout <s>]
//                                              wait for a new message; prints
//                                              its from, subject, text, links
//   node real-inbox.mjs list                  the addresses made here
//
// Each address's password and token are kept in
// ~/.config/orchestratinator/inboxes/<address>.json (0600), outside every
// repo. `wait` prints only messages that arrived after the last `wait` for
// that address returned, so one walk step reads one email.
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

const API = 'https://api.mail.tm';
const DIR = join(homedir(), '.config', 'orchestratinator', 'inboxes');
const die = (m) => { console.error(m); process.exit(1); };

async function call(path, opts = {}, tries = 6) {
  // mail.tm answers 429 when asked too often; wait and ask again.
  for (let i = 0; ; i++) {
    try { return await call1(path, opts); }
    catch (e) { if (!/ 429 /.test(e.message) || i >= tries) throw e; await new Promise((r) => setTimeout(r, 2000 * (i + 1))); }
  }
}
async function call1(path, { method = 'GET', body, token } = {}) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
const members = (x) => (Array.isArray(x) ? x : x?.['hydra:member'] ?? []);
const file = (address) => join(DIR, `${address}.json`);
const load = (address) => { if (!existsSync(file(address))) die(`no inbox ${address} here (node real-inbox.mjs list)`); return JSON.parse(readFileSync(file(address), 'utf8')); };
const save = (rec) => { mkdirSync(DIR, { recursive: true, mode: 0o700 }); writeFileSync(file(rec.address), JSON.stringify(rec, null, 2), { mode: 0o600 }); chmodSync(file(rec.address), 0o600); };

async function token(rec) {
  const t = await call('/token', { method: 'POST', body: { address: rec.address, password: rec.password } });
  return t.token;
}

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name, dflt) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : dflt; };

if (cmd === 'new') {
  const label = (rest[0] ?? 'walker').toLowerCase().replace(/[^a-z]/g, '').slice(0, 12) || 'walker';
  const domain = members(await call('/domains')).find((d) => d.isActive && !d.isPrivate)?.domain;
  if (!domain) die('mail.tm offers no domain right now');
  // mail.tm turns down some usernames for reasons it doesn't give (422
  // "is not valid" on one random name, a new account on the next), so a few
  // are tried.
  const password = randomBytes(18).toString('base64url');
  let address = null;
  for (let i = 0; i < 6 && !address; i++) {
    const tryAddress = `${label}${100000 + (randomBytes(3).readUIntBE(0, 3) % 900000)}@${domain}`;
    try { await call('/accounts', { method: 'POST', body: { address: tryAddress, password } }); address = tryAddress; }
    catch (e) { if (!/ 422 /.test(e.message)) throw e; await new Promise((r) => setTimeout(r, 1500)); }
  }
  if (!address) die('mail.tm refused six addresses in a row');
  save({ address, password, seen: [], made: new Date().toISOString() });
  console.log(address);
} else if (cmd === 'wait') {
  const address = rest[0] ?? die('wait <address>');
  const rec = load(address);
  const re = opt('subject') ? new RegExp(opt('subject'), 'i') : null;
  const until = Date.now() + Number(opt('timeout', 180)) * 1000;
  const tk = await token(rec);
  for (;;) {
    const list = members(await call('/messages', { token: tk }));
    const fresh = list.filter((m) => !rec.seen.includes(m.id) && (!re || re.test(m.subject ?? '')))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    if (fresh.length) {
      const m = await call(`/messages/${fresh[0].id}`, { token: tk });
      rec.seen.push(m.id); save(rec);
      const text = m.text ?? '';
      const links = [...new Set([...text.matchAll(/https?:\/\/[^\s)<>"]+/g)].map((x) => x[0]))];
      console.log(JSON.stringify({ from: m.from?.address, subject: m.subject, received: m.createdAt, text, links }, null, 2));
      break;
    }
    if (Date.now() > until) die(`nothing new at ${address} in ${opt('timeout', 180)} s`);
    await new Promise((r) => setTimeout(r, 6000));
  }
} else if (cmd === 'list') {
  if (existsSync(DIR)) for (const f of readdirSync(DIR).filter((f) => f.endsWith('.json'))) console.log(f.replace(/\.json$/, ''));
} else {
  die('usage: real-inbox.mjs new [label] | wait <address> [--subject re] [--timeout s] | list');
}

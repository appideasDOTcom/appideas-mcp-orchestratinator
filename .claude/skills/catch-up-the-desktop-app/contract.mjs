#!/usr/bin/env node
/**
 * Read, or change one field of, a contract on the board this folder's window
 * is bound to, without retyping the rest of it.
 *
 *   node contract.mjs get   <channel> <key> [--out file.json]
 *   node contract.mjs patch <channel> <key> <dotted.path> <json value> [--dry]
 *   node contract.mjs set   <channel> <key> <file.json> [--dry]
 *
 * e.g. node .claude/skills/catch-up-the-desktop-app/contract.mjs patch \
 *        orchestratinator-desktop orchestratinator.consumed \
 *        pin.what_is_where '"As of …: origin/develop is 8d246e0 …"'
 *
 * Why it exists: there is no HTTP route for contracts, and set_contract
 * replaces the whole value, so moving one line of orchestratinator.consumed
 * (about 15 KB) meant sending all of it back through a tool call by hand.
 * On 2026-11-19 that was put off rather than risked, and a commit name went
 * stale in it. This talks to the board's /mcp itself, as this folder's
 * window does: the URL and headers are the binding Claude Code holds for
 * this directory (~/.claude.json, projects[<cwd>].mcpServers.orchestratinator),
 * so it is the same board and the same identity `whoami` reports, and the
 * key is never printed. Run it from the repo root (or pass ORCH_BIND_DIR).
 *
 * patch walks the dotted path into the value (creating objects on the way),
 * sets the leaf to the JSON given, and sends the whole value back. --dry
 * prints what would change and sends nothing. Every write prints the
 * version before and after, so a concurrent write by the app's agent shows
 * up as a jump of more than one.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

const [cmd, channel, key, ...rest] = process.argv.slice(2);
const flag = (f) => rest.includes(f);
const args = rest.filter((a) => !a.startsWith('--'));
const die = (s) => { console.error(s); process.exit(2); };
if (!['get', 'patch', 'set'].includes(cmd) || !channel || !key) die('usage: contract.mjs get|patch|set <channel> <key> …  (see the header)');

const dir = process.env.ORCH_BIND_DIR ?? process.cwd();
const bind = JSON.parse(readFileSync(`${homedir()}/.claude.json`, 'utf8')).projects?.[dir]?.mcpServers?.orchestratinator;
if (!bind?.url) die(`no orchestratinator binding for ${dir} in ~/.claude.json (local scope); run from the repo root or set ORCH_BIND_DIR`);

let session = null;
let id = 0;
async function rpc(method, params, notify = false) {
  const r = await fetch(bind.url, {
    method: 'POST',
    headers: {
      ...bind.headers,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(session ? { 'mcp-session-id': session } : {}),
    },
    body: JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++id, method, params }),
    signal: AbortSignal.timeout(15000),
  }).catch((e) => die(`${bind.url}: ${e.cause?.code ?? e.message} (is the board up? after an app restart the binding needs /mcp in a window, but this script needs only the board)`));
  session ??= r.headers.get('mcp-session-id');
  if (notify) return null;
  const text = await r.text();
  if (!r.ok) die(`${method} → HTTP ${r.status}: ${text.slice(0, 300)}`);
  // The reply is JSON, or one SSE event whose data line is the JSON.
  const json = text.trimStart().startsWith('{') ? text : text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('');
  const msg = JSON.parse(json);
  if (msg.error) die(`${method}: ${JSON.stringify(msg.error)}`);
  return msg.result;
}
async function tool(name, a) {
  const res = await rpc('tools/call', { name, arguments: a });
  const out = res?.content?.find((c) => c.type === 'text')?.text ?? '';
  if (res?.isError) die(`${name}: ${out}`);
  try { return JSON.parse(out); } catch { return out; }
}

await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'contract.mjs', version: '1' } });
await rpc('notifications/initialized', {}, true);

const got = await tool('get_contract', { channel, key });
const entry = got?.entry ?? null;
if (cmd === 'get') {
  if (!entry) die(`no ${key} on ${channel}`);
  const out = JSON.stringify(entry.value, null, 2);
  const to = rest[rest.indexOf('--out') + 1];
  if (flag('--out') && to) { writeFileSync(to, `${out}\n`); console.log(`${key} v${entry.version} (by ${entry.updated_by}, ${entry.updated_at}) → ${to}`); } else console.log(out);
  process.exit(0);
}

let value;
if (cmd === 'set') {
  value = JSON.parse(readFileSync(args[0] ?? die('set needs a file'), 'utf8'));
} else {
  const [path, raw] = args;
  if (!path || raw === undefined) die('patch needs <dotted.path> <json value>');
  if (!entry) die(`no ${key} on ${channel} to patch; use set for a new key`);
  let leaf;
  try { leaf = JSON.parse(raw); } catch { die(`the value is not JSON: ${raw.slice(0, 80)} (a string needs its own quotes: '"…"')`); }
  value = structuredClone(entry.value);
  const parts = path.split('.');
  let at = value;
  for (const p of parts.slice(0, -1)) { if (typeof at[p] !== 'object' || at[p] === null) at[p] = {}; at = at[p]; }
  const last = parts.at(-1);
  console.log(`${path}:\n  was ${JSON.stringify(at[last])?.slice(0, 400) ?? '(absent)'}\n  now ${JSON.stringify(leaf).slice(0, 400)}`);
  at[last] = leaf;
}
if (flag('--dry')) { console.log(`--dry: nothing sent (${key} is v${entry?.version ?? 'new'})`); process.exit(0); }
const done = await tool('set_contract', { channel, key, value });
console.log(`${key} on ${channel}: v${entry?.version ?? '(new)'} → v${done?.version ?? '?'}`);

#!/usr/bin/env node
/**
 * Post a patch on the board as this folder's desk, in one message: a header
 * line, then the diff. The MCP tool takes a body as a tool argument, so a
 * diff of a thousand lines would otherwise pass through the agent's own
 * context to be retyped; this reads the file and calls send_message over the
 * binding's own MCP endpoint, headers and key and all.
 *
 *   node .claude/skills/post-a-patch/post-patch.mjs <to> <diff file> "<header>"
 *
 * Run from the repo root: the binding is the local-scope entry for the
 * current folder in ~/.claude.json (CLAUDE_CONFIG_DIR's, when set), as
 * Claude Code itself reads it. Prints the board's answer (the message id).
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [to, file, header] = process.argv.slice(2);
if (!to || !file || !header) { console.error('usage: post-patch.mjs <to> <diff file> "<header>"'); process.exit(2); }
const cfg = JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json'), 'utf8'));
const b = cfg.projects?.[process.cwd()]?.mcpServers?.orchestratinator;
if (!b) { console.error(`no orchestratinator binding for ${process.cwd()} in local scope`); process.exit(2); }
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...b.headers };
const rpc = async (body, sid) => {
  const r = await fetch(b.url, { method: 'POST', headers: { ...H, ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(body) });
  return { sid: r.headers.get('mcp-session-id') ?? sid, text: await r.text(), status: r.status };
};
const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'post-patch', version: '0' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, init.sid);
const sent = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'send_message', arguments: { to, body: `${header}\n\n${readFileSync(file, 'utf8')}` } } }, init.sid);
console.log(sent.status, sent.text.slice(0, 300));

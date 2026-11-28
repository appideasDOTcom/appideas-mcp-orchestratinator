#!/usr/bin/env node
/**
 * A stand-in for the desktop app's relay hop (contract board.relay), so the
 * board's page can be seen served from a relayed origin before the real
 * service and app exist. Not the app's code: the app's hop is desktop-dev's.
 * It does what the contract says the hop does, and nothing more:
 * strips every inbound credential and relay header, adds the board key, and
 * signs a payload naming one operator as owner, with the origin the browser
 * is on (http://<anything>.localhost:<port>).
 *
 *   node relay-hop.mjs <listen port> <board url> <board key> <relay secret> [name]
 *
 * Streams both ways (SSE, uploads), as an http.request pipe.
 */
import http from 'node:http';
import { createHmac } from 'node:crypto';

const [port, board, key, secret, name = 'Remote Owner'] = process.argv.slice(2);
// A guest (board.relay v5): HOP_ROLE=guest HOP_OP=<op> HOP_BUILDINGS=<b_…,b_…>.
const ROLE = process.env.HOP_ROLE === 'guest' ? 'guest' : 'owner';
const OP = process.env.HOP_OP ?? (ROLE === 'guest' ? 'op_guest' : 'op_standin');
const BUILDINGS = (process.env.HOP_BUILDINGS ?? '').split(',').filter(Boolean);
const target = new URL(board);
const STRIP = /^(x-orch-|x-orchestratinator-|authorization$|cookie$|forwarded$|x-forwarded-|x-channel$|x-agent$|connection$|keep-alive$|te$|upgrade$|proxy-)/i;
// x-channel / x-agent and their aliases pass on an agent's routes only (v5).
const AGENT_ROUTE = /^\/(mcp|api\/ingest)(\/|\?|$)/;
const PASS = /^(x-channel|x-agent|x-orchestratinator-channel|x-orchestratinator-agent)$/i;

http.createServer((req, res) => {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if ((!STRIP.test(k) || (PASS.test(k) && AGENT_ROUTE.test(req.url))) && k !== 'host') headers[k] = v;
  const origin = `http://${req.headers.host}`;
  const raw = Buffer.from(JSON.stringify({ v: 1, op: OP, name, role: ROLE, origin, iat: Date.now(), ...(ROLE === 'guest' ? { buildings: BUILDINGS } : {}) }), 'utf8').toString('base64url');
  headers['x-orchestratinator-key'] = key;
  headers['x-orch-relay'] = raw;
  headers['x-orch-relay-sig'] = createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
  headers.host = target.host;
  const up = http.request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', (e) => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: `board_unreachable: ${e.message}` })); });
  req.pipe(up);
  res.on('close', () => up.destroy());
}).listen(Number(port), '127.0.0.1', () => console.log(`relay-hop on ${port} → ${board}`));

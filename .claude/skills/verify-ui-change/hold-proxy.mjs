#!/usr/bin/env node
/**
 * A stand-in for a forwarder in front of a board, for check-poll-timeout.mjs:
 * the page talks to this port, this talks to the board. With HOLD=1 a
 * browser's connection is NOT closed when the board behind it goes away —
 * the request on it simply never gets an answer, which is one way a page
 * request hangs across a board's restart (task 264).
 *
 *   HOLD=1 node hold-proxy.mjs <listen port> <board port> <log file>
 *
 * The log is one line per request (`#<conn> GET /api/floor`) and per close,
 * and `upstream error ECONNREFUSED` for a request the board was not there to
 * take — which is how the check tells a poll that reached a fresh board from
 * one that is being held.
 */
import net from 'node:net';
import { appendFileSync } from 'node:fs';

const [, , listen, upstream, logFile] = process.argv;
const hold = process.env.HOLD === '1';
const log = (s) => appendFileSync(logFile, `${new Date().toISOString()} ${s}\n`);
let n = 0;
net.createServer((c) => {
  const id = ++n;
  const u = net.connect(Number(upstream), '127.0.0.1');
  c.on('data', (d) => { const m = /^(GET|POST) (\S+)/.exec(d.toString('latin1')); if (m) log(`#${id} ${m[1]} ${m[2].split('?')[0]}`); });
  c.pipe(u);
  u.pipe(c);
  u.on('error', (e) => log(`#${id} upstream error ${e.code}`));
  u.on('close', () => { log(`#${id} upstream closed${hold ? ', client held open' : ''}`); if (!hold) c.end(); });
  c.on('error', () => {});
  c.on('close', () => { log(`#${id} client closed`); u.destroy(); });
}).listen(Number(listen), '127.0.0.1', () => log(`proxy ${listen} → ${upstream} hold=${hold}`));

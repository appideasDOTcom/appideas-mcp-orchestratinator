#!/usr/bin/env node
/**
 * One agent's desk on EVERY floor, as /api/floor serves it, every 100 ms,
 * written on change with millisecond UTC stamps. floor-recorder.sh's sibling
 * for a desk that changes floors — a move — where the half-second, one-channel
 * recorder misses the moment the desk is on neither floor, or on both.
 *
 *   node rec-floor.mjs <out-file> <board-url> <agent> <seconds>
 *   16:28:38.291 [{"ch":"coord-probe-b","live":true,"hosted":{"live":true,"held":null,"window_open":false,…}}]
 *
 * An empty list is a finding: the desk is in no floor's payload (task 253: a
 * move back to a floor whose agent row was retired, with the reopen refused).
 */
import { writeFileSync, appendFileSync } from 'node:fs';

const [out, base, agent, secs = '600'] = process.argv.slice(2);
if (!out || !base || !agent) { console.error('usage: rec-floor.mjs <out> <board-url> <agent> [seconds]'); process.exit(2); }
writeFileSync(out, '');
const stamp = () => new Date().toISOString().slice(11, 23);
const end = Date.now() + Number(secs) * 1000;
let last = '';
while (Date.now() < end) {
  try {
    const j = await (await fetch(`${base}/api/floor`)).json();
    const rows = [];
    for (const c of j.channels ?? []) for (const d of c.desks ?? []) if (d.agent === agent) {
      rows.push({ ch: c.channel, archived: c.archived ?? null, live: d.live, hidden: d.hidden ?? null,
        hosted: d.hosted && { live: d.hosted.live, state: d.hosted.state, held: d.hosted.held, window_open: d.hosted.window_open, holders: d.hosted.holders, sid: d.hosted.session_id?.slice(0, 8) },
        last: d.last_turn && { id: d.last_turn.id, role: d.last_turn.role, text: String(d.last_turn.text ?? '').slice(0, 70) } });
    }
    const now = JSON.stringify(rows);
    if (now !== last) { appendFileSync(out, `${stamp()} ${now}\n`); last = now; }
  } catch (e) { appendFileSync(out, `${stamp()} err ${e.message}\n`); }
  await new Promise((r) => setTimeout(r, 100));
}

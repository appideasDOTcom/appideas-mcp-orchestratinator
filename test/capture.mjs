// The burst capture's summary — the text its alert posts on the channel —
// read against a fixture capture directory (PR #34 review, findings 1 and 2).
//
// Two things are held here. The summary is READINGS ONLY: it counts the host
// log and never quotes it, because the run loop's warning can carry any
// words, and the alert goes to everyone on the channel. So a marker string
// sits in every place a quoted host line would carry it — a query, a failure
// that is not a board request, an over-limit timeout — and must not come out.
// And it says what the VM's kernel did: an OOM kill was issue #5's cause, and
// a real capture that saved three such lines once summarised none of them.
//
// summarise() is pure over the directory it is given, so this needs no
// server, no ports and no Docker.
//   npm run test:capture
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarise } from '../.claude/skills/capture-a-burst/capture.mjs';

let failures = 0;
const assert = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures++;
};

const MARK = 'MARKER-7f3a-typed-words';
const dir = mkdtempSync(join(tmpdir(), 'orch-capture-test-'));
const at = (s) => `2026-11-03T10:00:${s}.000Z`;
writeFileSync(join(dir, 'host.log'), [
  `[host] ${at('00')} free/desk: queued a message behind the running turn — ${MARK}`,
  `[host] ${at('01')} GET http://localhost:8787/api/host/work?host_id=${MARK}&wait=1 timed out after 25000ms (limit 10700ms); retrying in 1s`,
  `[host] ${at('02')} the window said ${MARK}; retrying in 1s`,
  `[host] ${at('03')} events not delivered (POST http://localhost:8787/api/host/events?x=${MARK} → 503 after 4ms); will retry with the next batch`,
  '',
].join('\n'));
writeFileSync(join(dir, 'docker-vm-init.log'), [
  `{"component":"kmsg","level":"info","msg":"containerd invoked oom-killer: gfp_mask=0x140cca, order=0","time":"${at('04').replace('.000Z', '.639115201Z')}"}`,
  `{"component":"kmsg","level":"info","msg":"Out of memory: Killed process 4242 (mysqld) total-vm:2517788kB","time":"${at('04').replace('.000Z', '.659223243Z')}"}`,
  `{"component":"apiproxy","level":"info","msg":">> GET /v1.56/containers/json","time":"${at('05')}"}`,
  '',
].join('\n'));
writeFileSync(join(dir, 'docker-host-com.docker.backend.log'), [
  `[${at('06')}][com.docker.backend.ports] exposer.Add(43349cc3, /aiss-e2e-single-public-alpha, [TCP 0.0.0.0:8091 -> 172.24.0.4:80])`,
  `[${at('07')}][com.docker.backend.ports] exposer.Add(20d16fdc, /appideas-orchestratinator, [])`,
  '',
].join('\n'));

let out = '';
try {
  out = summarise({ dir, start: Date.parse(at('00')) - 60_000, firstFailure: Date.parse(at('01')), lastFailure: Date.parse(at('03')) }, Date.parse(at('10')), '');
} catch (err) {
  console.error(err);
  failures++;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('capture: the summary an alert posts');
assert(!out.includes(MARK), 'never a word of a host-log line — the marker in a query, a failure and an over-limit wait does not come out');
assert(/3 failure lines/.test(out) && /\b1\s+another run-loop failure/.test(out), 'though every failure line is counted, the one that is not a board request among them');
assert(/10:00:01\.000Z \/api\/host\/work waited 25000ms, limit 10700ms/.test(out), 'and a timeout past its limit is its time, route and two numbers');
assert(/OOM kills in the VM in the window: 1 \(2 kernel lines\)/.test(out), "the VM's out-of-memory kill is counted");
assert(/10:00:04\.659223243Z Out of memory: Killed process 4242 \(mysqld\)/.test(out), 'and said with its time and what it killed');
assert(/com\.docker\.backend\.log: 2 lines in the window, 1 about 8787/.test(out), "and the board's own container is the only exposer counted as about 8787");

if (failures) console.log(`\n--- summary ---\n${out}---------------`);
console.log(failures ? `\ncapture: ${failures} failed` : '\ncapture: all passed');
process.exit(failures ? 1 : 0);

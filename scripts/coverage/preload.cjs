// V8 coverage that survives the suites' own way of ending processes, for
// `npm run coverage` (scripts/coverage/run.sh). Loaded into every node process
// of a run through NODE_OPTIONS=--require <this>, with NODE_V8_COVERAGE set.
// QA's validated instrument from the milestone audit (2026-11-17), kept as it
// was measured: the coverage reading it gave is the baseline (costmo's ruling,
// item B), and a changed instrument would move the baseline, not the code.
//
// The problem (measured by QA and by coordinator, 2026-11-17): Node writes
// coverage only at a normal exit. src/server.js has no signal handler, and
// the suites end servers and often hosts with SIGKILL or a bare kill(), so
// their coverage was lost and those tiers read as dark although they ran.
//
// The fix keeps the suites' behaviour exactly (a SIGKILL is still a SIGKILL)
// and changes only the measurement:
//  1. In every process: SIGWINCH (ignored by default, used by nothing here)
//     takes a coverage snapshot. SIGTERM takes one too; if nothing else
//     listens for SIGTERM, the default (exit) is reproduced (143). A 10 s
//     interval takes one as a backup. Each take RESETS V8's counters, so every
//     file is kept and c8 sums them: deleting older ones lost data (QA's first
//     cut did, measured 5, then 3, then 0).
//  2. In every process that kills others (the suites): a SIGKILL to a node
//     process first sends SIGWINCH and waits (synchronously, up to 1.5 s) for
//     that pid's new snapshot file, then sends the SIGKILL as written.
//  3. The page sections test/floor.mjs (and others) lift into
//     ./data/<name>-<pid>.mjs are kept instead of deleted, so the report can
//     credit their lines back to src/ui (scripts/coverage/report.mjs).
// Measurement only: nothing here changes what a suite asserts.
'use strict';
const dir = process.env.NODE_V8_COVERAGE;
if (dir) {
  const v8 = require('node:v8');
  const fs = require('node:fs');
  const path = require('node:path');
  const cp = require('node:child_process');
  const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const filesOf = (pid) => { try { return fs.readdirSync(dir).filter((f) => f.startsWith(`coverage-${pid}-`)); } catch { return []; } };
  // Each take RESETS V8's counters (measured: 5, then 3, then 0 at exit), so every snapshot is an increment and
  // none may be deleted; c8 sums them. The file is named <pid>-<ms>, so two takes in one millisecond would collide:
  // never take twice in the same millisecond.
  let lastTake = 0;
  const take = () => {
    try {
      while (Date.now() === lastTake) sleepSync(1);
      v8.takeCoverage();
      lastTake = Date.now();
    } catch { /* never let measurement break the process */ }
  };
  process.on('SIGWINCH', take);
  const onTerm = () => {
    take();
    if (process.listenerCount('SIGTERM') === 1) process.exit(143);
  };
  process.on('SIGTERM', onTerm);
  setInterval(take, Number(process.env.COV_TAKE_MS || 10000)).unref();

  // 2. Snapshot a node child before a SIGKILL reaches it.
  const isNode = (pid) => {
    try { return /^\S*node(\s|$)/.test(cp.execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim()); } catch { return false; }
  };
  const snapshotBeforeKill = (pid) => {
    if (!pid || pid === process.pid || !isNode(pid)) return;
    const had = new Set(filesOf(pid));
    try { process.kill(pid, 'SIGWINCH'); } catch { return; }
    const until = Date.now() + 1500;
    while (Date.now() < until) {
      if (filesOf(pid).some((f) => !had.has(f))) { sleepSync(30); return; }
      sleepSync(25);
    }
  };
  const isKill = (s) => s === 'SIGKILL' || s === 9;
  const origProcKill = process.kill.bind(process);
  process.kill = function (pid, sig) {
    if (isKill(sig) && Number(pid) > 0) snapshotBeforeKill(Number(pid));
    return origProcKill(pid, sig);
  };
  const origChildKill = cp.ChildProcess.prototype.kill;
  cp.ChildProcess.prototype.kill = function (sig) {
    if (isKill(sig) && this.pid && this.exitCode === null && this.signalCode === null) snapshotBeforeKill(this.pid);
    return origChildKill.call(this, sig);
  };

  // 3. Keep the page sections the suites lift into ./data/<name>-<pid>.mjs (coordinator's trap b, msg 3379).
  //    They are imported, run, and deleted in a finally; deleted, c8 cannot read them and their lines cannot be
  //    credited back to src/ui. Only files of exactly that shape are kept; every other delete is untouched.
  const LIFTED = /(^|\/)data\/[A-Za-z0-9-]+-\d+\.mjs$/;
  const keep = (p) => LIFTED.test(String(p ?? ''));
  for (const name of ['rmSync', 'unlinkSync']) {
    const orig = fs[name];
    fs[name] = function (p, ...rest) { if (keep(p)) return undefined; return orig.call(fs, p, ...rest); };
  }
  try { require('node:module').syncBuiltinESMExports(); } catch { /* older node */ }
}

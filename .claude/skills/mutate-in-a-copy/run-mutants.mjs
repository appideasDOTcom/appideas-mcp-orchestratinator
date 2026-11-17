#!/usr/bin/env node
/**
 * Run a list of mutants, one after another, in a fresh copy of the repo —
 * so the old and new strings can hold backticks, `${}` and both kinds of
 * quote without a round of shell escaping. Written on 2026-11-02 after the
 * ninth mutant of a round was spent on quoting.
 *
 *   node .claude/skills/mutate-in-a-copy/run-mutants.mjs mutants.json [--dest <dir>] [--control] [--logs <dir>]
 *
 * mutants.json is an array of [name, suite, file, old, new]:
 *   [["a pill is not the restore control", "floor", "src/ui/app.js",
 *     "data-act=\"unarchive\" data-channel", "data-act=\"restore\" data-channel"]]
 *
 * Per mutant: how long the suite ran, the count of failing assertions, and
 * every one of them (up to eight) — not only the first, because the report
 * names the assertion each mutant was meant for, and a cascade's first red
 * is not always it. 0 failing is a survivor — read SKILL.md before believing
 * either result; and a run much shorter than its siblings is not by itself a
 * short run: reds wait out timeouts, so a mutant that cascades runs long and
 * a clean pass runs at the suite's own speed (task 253: 74 s green against
 * 104–267 s for the killed ones — it was a real survivor, the full 263 ✓).
 *
 * --dest puts the copy somewhere other than copy-repo.sh's default. Two
 * runs at once must not share a copy: the default directory is one path,
 * and a second copy-repo.sh deletes it under the first. Different suites
 * use different ports (floor 8897, host 8896), so a floor mutant can run
 * beside a host mutant run — in its own --dest.
 *
 * --control runs each suite named in the list once more at the end, with
 * nothing mutated, and prints its reds. Ask for it whenever a mutant shows
 * a red you did not predict. On 2026-11-14 a host mutant read 3 failing:
 * the one predicted, and two in "hearing the desk while a message is still
 * going in", 500 lines from the change, at load 5.5. Run again beside a
 * control, the control read 320 ✓ and the mutant its one red. That control
 * was a list entry whose new text was the old plus a space, which is a
 * no-op by another name; this flag is the honest form of it.
 *
 * --logs keeps every run's whole output in <dir>, as <n>-<suite>.log for
 * the list's nth mutant and control-<suite>.log. Only eight reds are
 * printed, and nothing else of a run was kept: on 2026-11-16 a host mutant
 * read "9 failing" beside eight printed rows, QA had predicted eight, and
 * the ninth could only be had by running the three minutes again.
 *
 * The copy is made once, outside the repo; the runner never touches the
 * working tree, and puts each file back whatever the suite did.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, copyFileSync, renameSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const D = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const spec = args.find((a) => !a.startsWith('--') && !['--dest', '--logs'].includes(args[args.indexOf(a) - 1]));
const control = args.includes('--control');
const destAt = args.indexOf('--dest');
const dest = destAt >= 0 ? args[destAt + 1] : null;
const logsAt = args.indexOf('--logs');
const logs = logsAt >= 0 ? args[logsAt + 1] : null;
if (logs) mkdirSync(logs, { recursive: true });
const keep = (name, out) => { if (logs) writeFileSync(join(logs, name), out); };
if (!spec) { console.error('usage: run-mutants.mjs <mutants.json> [--dest <dir>] [--control] [--logs <dir>]'); process.exit(1); }
// A red and a green, as the suites print them: ✗ and ✓ for most, and
// `FAIL <name>` / `ok   <name>` at the start of a line for test:renew.
// Counting ✗ alone read a renew mutant its suite had failed twice as
// "0 failing — SURVIVED (0 ✓)" (2026-11-16; run-mutant.sh has counted both
// since PR #54, and this runner had not been used on that suite). A count
// of 0 ✓ beside 0 failing is a suite this cannot read, not a survivor.
const isRed = (l) => l.includes('✗') || /^FAIL /.test(l);
const isGreen = (l) => l.includes('✓') || /^ok {2,}/.test(l);
const M = JSON.parse(readFileSync(spec, 'utf8'));
const copy = execFileSync(`${D}/copy-repo.sh`, dest ? [dest] : [], { encoding: 'utf8' }).trim();
console.log('copy:', copy);
for (const [n, [name, suite, file, oldS, newS]] of M.entries()) {
  const f = join(copy, file);
  copyFileSync(f, `${f}.unmutated`);
  try {
    const applied = spawnSync('python3', [`${D}/mutate.py`, f, oldS, newS], { encoding: 'utf8' });
    if (applied.status !== 0) { console.log(`MUTANT [${name}]: DID NOT APPLY — ${(applied.stderr || applied.stdout).trim()}`); continue; }
    const t0 = Date.now();
    const run = spawnSync('npm', ['run', `test:${suite}`], { cwd: copy, encoding: 'utf8', maxBuffer: 64e6 });
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    keep(`${n + 1}-${suite}.log`, out);
    const red = out.split('\n').filter(isRed);
    const green = out.split('\n').filter(isGreen).length;
    console.log(`MUTANT [${name}] (${suite}, ${Math.round((Date.now() - t0) / 1000)}s): ${red.length} failing${red.length ? '' : ` — SURVIVED (${green} ✓)`}`);
    for (const l of red.slice(0, 8)) console.log(`    ${l.trim().slice(0, 220)}`);
    const threw = !red.length && out.match(/(TypeError|ReferenceError|SyntaxError)[^\n]*/);
    if (threw) console.log(`    (no ✗, but the run threw: ${threw[0].slice(0, 160)})`);
  } finally {
    renameSync(`${f}.unmutated`, f);
  }
}
if (control) {
  for (const suite of [...new Set(M.map((m) => m[1]))]) {
    const t0 = Date.now();
    const run = spawnSync('npm', ['run', `test:${suite}`], { cwd: copy, encoding: 'utf8', maxBuffer: 64e6 });
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    keep(`control-${suite}.log`, out);
    const red = out.split('\n').filter(isRed);
    const green = out.split('\n').filter(isGreen).length;
    console.log(`CONTROL [nothing mutated] (${suite}, ${Math.round((Date.now() - t0) / 1000)}s): ${red.length} failing, ${green} ✓${red.length ? ' — THE COPY IS RED WITHOUT A MUTANT: these are not the mutants\' reds' : ''}`);
    for (const l of red.slice(0, 8)) console.log(`    ${l.trim().slice(0, 220)}`);
  }
}

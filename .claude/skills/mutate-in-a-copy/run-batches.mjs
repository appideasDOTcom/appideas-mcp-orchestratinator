#!/usr/bin/env node
/**
 * Two runs a mutation report needs that run-mutants.mjs does not do: the new
 * tests against the OLD code ("red at <sha>"), and several mutants in one
 * suite run when their assertions cannot overlap. Written after task 255
 * (issue #5, 2026-11-03), where fourteen host-suite mutants one at a time
 * would have been fourteen runs. Instead they went as six: one base run and
 * five batches. Every red landed on the assertion predicted for it.
 *
 *   node .claude/skills/mutate-in-a-copy/run-batches.mjs batches.json \
 *        [--base <sha> --base-suite <suite> --base-paths host/,src/x.js] [--dest <dir>]
 *
 * batches.json is an array of [label, suite, [[name, file, old, new], …]]:
 *   [["R1", "host", [["a timeout is said without its limit", "host/log.js", "const limit = /timed…", "const limit = '';"],
 *                    ["an unregister the board refused goes unsaid", "host/index.js", "catch (err) { warn(…); }", "catch { }"]]]]
 * An empty list of mutations is a control: the suite on the copy as it is,
 * which must be green before any red below it means anything.
 *
 * --base runs first, in its own fresh copy: every file under --base-paths is
 * replaced by its content at <sha>; a file that did not exist then is
 * removed, and one that did and is gone now is put back. The tests are
 * today's. What it should show is the tests for the new behaviour red and the
 * ones guarding what did not change green — say which is which in the
 * report, because QA predicts both.
 *
 * Batch only mutants whose assertions are disjoint, and predict the reds per
 * mutant before the run (SKILL.md, "Choosing the mutants"). A batch's reds
 * are printed in full, and the whole log of each run is written beside the
 * copy as <dest>-<label>.log. The mutations of a batch all apply or the batch
 * does not run. Files are put back whatever the suite did.
 *
 * Same rules as the other tools here: the copy is outside the repo
 * (copy-repo.sh refuses otherwise), mutate.py refuses a git checkout and any
 * old text that does not occur exactly once, and the host and window suites
 * share this machine's ports with the repo and with QA's clone — say so on
 * the channel first.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, renameSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const D = dirname(fileURLToPath(import.meta.url));
const REPO = join(D, '../../..');
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const spec = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!spec) { console.error('usage: run-batches.mjs <batches.json> [--base <sha> --base-suite <suite> --base-paths <p,…>] [--dest <dir>]'); process.exit(1); }
const dest = opt('--dest');
const fresh = () => execFileSync(`${D}/copy-repo.sh`, dest ? [dest] : [], { encoding: 'utf8' }).trim();

function suite(copy, name, label) {
  const t0 = Date.now();
  const run = spawnSync('npm', ['run', `test:${name}`], { cwd: copy, encoding: 'utf8', maxBuffer: 64e6 });
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  writeFileSync(`${copy}-${label.replace(/[^\w.-]+/g, '_')}.log`, out);
  const red = out.split('\n').filter((l) => l.includes('✗'));
  const green = out.split('\n').filter((l) => l.includes('✓')).length;
  console.log(`${label} (${name}, ${Math.round((Date.now() - t0) / 1000)}s): ${red.length} failing, ${green} ✓`);
  for (const l of red) console.log(`    ${l.trim().slice(0, 220)}`);
  const threw = out.match(/^(TypeError|ReferenceError|SyntaxError|Error)[^\n]*/m);
  if (threw) console.log(`    (the run threw: ${threw[0].slice(0, 160)})`);
}

const base = opt('--base');
if (base) {
  const paths = (opt('--base-paths') ?? '').split(',').filter(Boolean);
  const name = opt('--base-suite');
  if (!paths.length || !name) { console.error('--base needs --base-paths and --base-suite'); process.exit(1); }
  const copy = fresh();
  console.log('copy:', copy);
  const git = (...a) => execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8', maxBuffer: 64e6 });
  for (const p of paths) {
    const then = new Set(git('ls-tree', '-r', '--name-only', base, '--', p).split('\n').filter(Boolean));
    const now = new Set(git('ls-files', '--cached', '--others', '--exclude-standard', '--', p).split('\n').filter(Boolean));
    for (const f of now) if (!then.has(f)) rmSync(join(copy, f), { force: true });
    for (const f of then) {
      mkdirSync(dirname(join(copy, f)), { recursive: true });
      writeFileSync(join(copy, f), execFileSync('git', ['-C', REPO, 'show', `${base}:${f}`], { maxBuffer: 64e6 }));
    }
  }
  suite(copy, name, `base: ${paths.join(',')} at ${base}, today's tests`);
}

const batches = JSON.parse(readFileSync(spec, 'utf8'));
if (batches.length) {
  const copy = fresh();
  console.log('copy:', copy);
  for (const [label, name, muts] of batches) {
    const files = [...new Set(muts.map((m) => m[1]))];
    for (const f of files) copyFileSync(join(copy, f), join(copy, `${f}.unmutated`));
    try {
      const missed = muts.map(([m, f, o, n]) => [m, spawnSync('python3', [`${D}/mutate.py`, join(copy, f), o, n], { encoding: 'utf8' })])
        .filter(([, r]) => r.status !== 0);
      if (missed.length) { for (const [m, r] of missed) console.log(`${label}: [${m}] DID NOT APPLY — ${(r.stderr || r.stdout).trim()}`); continue; }
      console.log(`${label}: ${muts.length ? muts.map((m) => m[0]).join(' · ') : 'control — no mutation'}`);
      suite(copy, name, label);
    } finally {
      for (const f of files) if (existsSync(join(copy, `${f}.unmutated`))) renameSync(join(copy, `${f}.unmutated`), join(copy, f));
    }
  }
}

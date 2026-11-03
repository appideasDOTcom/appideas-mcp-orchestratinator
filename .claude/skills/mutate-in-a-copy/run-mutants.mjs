#!/usr/bin/env node
/**
 * Run a list of mutants, one after another, each through run-mutant.sh in a
 * fresh copy of the repo — so the old and new strings can hold backticks,
 * `${}` and both kinds of quote without a round of shell escaping. Written
 * on 2026-11-02 after the ninth mutant of a round was spent on quoting.
 *
 *   node .claude/skills/mutate-in-a-copy/run-mutants.mjs mutants.json
 *
 * mutants.json is an array of [name, suite, file, old, new]:
 *   [["a pill is not the restore control", "floor", "src/ui/app.js",
 *     "data-act=\"unarchive\" data-channel", "data-act=\"restore\" data-channel"]]
 *
 * One line per mutant on stdout, as run-mutant.sh prints it: the count of
 * failing assertions and the first one. 0 failing is a survivor — read
 * SKILL.md before believing either result. The copy is made once, outside
 * the repo; the runner never touches the working tree.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const D = dirname(fileURLToPath(import.meta.url));
const spec = process.argv[2];
if (!spec) { console.error('usage: run-mutants.mjs <mutants.json>'); process.exit(1); }
const M = JSON.parse(readFileSync(spec, 'utf8'));
const copy = execFileSync(`${D}/copy-repo.sh`, { encoding: 'utf8' }).trim();
console.log('copy:', copy);
for (const [name, suite, file, oldS, newS] of M) {
  try {
    process.stdout.write(execFileSync(`${D}/run-mutant.sh`, [name, suite, file, oldS, newS], { cwd: copy, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (e) {
    process.stdout.write(`${e.stdout ?? ''}${e.stderr ?? ''}\nMUTANT [${name}]: runner failed\n`);
  }
}

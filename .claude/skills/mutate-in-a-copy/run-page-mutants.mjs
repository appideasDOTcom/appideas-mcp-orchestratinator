#!/usr/bin/env node
/**
 * A list of PAGE mutants, each through run-page-mutant.sh in one copy of the
 * tree, then the check once more unmutated as the control. The page twin of
 * run-mutants.mjs.
 *
 *   node .claude/skills/mutate-in-a-copy/run-page-mutants.mjs <mutants.json> '<check command>' [--dest <dir>]
 *   # mutants.json: [["what is now wrong", "src/ui/floor.js", "<old>", "<new>"], …]
 *   # check, issue #13's:  'PORT=8916 CDP=9266 .claude/skills/verify-ui-change/run-check-chatbox.sh "$PWD"'
 *
 * No shell sits between the JSON and the mutation, so old and new text may
 * hold backticks, `${}` and both quotes (they did, on PR #39). The check
 * command runs in the copy, so the copy is what is served. Use a runner that
 * starts and kills its own server and Chrome (run-check-*.sh), and a
 * PORT/CDP nothing else holds.
 *
 * A check's verdict line must not contain ✗: run-page-mutant.sh counts that
 * character as a red, so "58 ✓ · 0 ✗ · PASS" read as one failure on a
 * green run. Print `PASS · N of N` / `FAIL · M of N red`, as the
 * run-check-*.sh runners expect.
 *
 * Built for issue #13 and PR #39 (2026-11-04): 8, 3, 4 and 3 mutants in four
 * batches, about a minute each.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const destAt = args.indexOf('--dest');
const dest = destAt >= 0 ? args[destAt + 1] : join(tmpdir(), 'orch-page-copy');
const [spec, check] = args.filter((a, i) => a !== '--dest' && i !== destAt + 1);
if (!spec || !check) {
  console.error("usage: run-page-mutants.mjs <mutants.json> '<check command>' [--dest <dir>]");
  process.exit(2);
}
const list = JSON.parse(readFileSync(spec, 'utf8'));
const copy = execFileSync(join(HERE, 'copy-repo.sh'), [dest], { encoding: 'utf8' }).trim();
console.log(`copy: ${copy}`);
for (const [name, file, oldText, newText] of list) {
  try {
    process.stdout.write(execFileSync(join(HERE, 'run-page-mutant.sh'), [name, file, oldText, newText, check], { cwd: copy, encoding: 'utf8' }));
  } catch (e) {
    process.stdout.write(`${e.stdout ?? ''}PAGE MUTANT [${name}]: ERROR ${e.message}\n`);
  }
}
// The control: the same check on the same copy with nothing applied. A red
// here means every red above is in doubt.
let out = '';
try { out = execFileSync('bash', ['-c', check], { cwd: copy, encoding: 'utf8' }); } catch (e) { out = e.stdout ?? ''; }
console.log(`control: ${out.split('\n').find((l) => /^(PASS|FAIL) /.test(l)) ?? 'THE CHECK DID NOT FINISH'}`);

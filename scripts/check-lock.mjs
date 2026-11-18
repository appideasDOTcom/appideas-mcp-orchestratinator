#!/usr/bin/env node
/**
 * Is what is installed exactly what package-lock.json names?
 *
 *   node scripts/check-lock.mjs [project dir]     exit 0 when it is, 1 with each difference
 *
 * The release gate's packages step (scripts/release-gate.sh). `npm ls --all`
 * answers a weaker question, whether each installed version satisfies the
 * range that asked for it, so a node_modules holding 1.4.0 where the lock
 * says 1.2.3 passed it whenever the range was ^1.2.0 (QA, the milestone
 * audit's re-measure, L2, on a fabricated project). The image installs with
 * `npm ci`, which installs the lock's versions exactly, so "tested what
 * ships" needs the same test: every package the lock lists, by its path in
 * node_modules, at the lock's version.
 *
 * Left alone: an optional package absent from disk (a platform's binary that
 * is not this platform's), and the lock's links (workspaces), which have no
 * version of their own.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? '.');
let lock;
try { lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')); } catch (err) {
  console.error(`no package-lock.json to read in ${dir} (${err.code ?? err.message})`);
  process.exit(1);
}
const wrong = [];
let checked = 0;
for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (!path || entry.link || !entry.version) continue;
  const manifest = join(dir, path, 'package.json');
  if (!existsSync(manifest)) {
    if (!entry.optional) wrong.push(`${path}: not installed (the lock has ${entry.version})`);
    continue;
  }
  checked++;
  let have;
  try { have = JSON.parse(readFileSync(manifest, 'utf8')).version; } catch { have = '(unreadable)'; }
  if (have !== entry.version) wrong.push(`${path}: ${have} installed, the lock has ${entry.version}`);
}
if (wrong.length) {
  console.log(`${wrong.length} of ${checked + wrong.filter((w) => w.includes('not installed')).length} differ from package-lock.json:`);
  for (const w of wrong) console.log(`  ${w}`);
  process.exit(1);
}
console.log(`${checked} of ${checked} installed packages are the lock's versions`);

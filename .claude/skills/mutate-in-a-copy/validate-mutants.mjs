#!/usr/bin/env node
/**
 * Does every mutant in a list still apply? A list kept beside its check
 * goes stale as the code moves, and a stale entry is found one at a time,
 * minutes apart, in the middle of a batch. This reads the list against a
 * directory and names each entry whose old text is not there exactly once,
 * which is mutate.py's own rule, in under a second.
 *
 *   node .claude/skills/mutate-in-a-copy/validate-mutants.mjs <mutants.json> [<dir>]
 *   # page list:  [["what is now wrong", "src/ui/floor.js", "<old>", "<new>"], …]
 *   # suite list: [["what is now wrong", "floor", "src/ui/floor.js", "<old>", "<new>"], …]
 *
 * Exit 0 when every entry applies; 1 with the entries that do not, and how
 * many times each old text was found. It changes nothing: reading the tree
 * is not mutating it. Run it before a batch, and after any edit to a file a
 * kept list names.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const [spec, dir = process.cwd()] = process.argv.slice(2);
if (!spec) { console.error('usage: validate-mutants.mjs <mutants.json> [<dir>]'); process.exit(2); }
const list = JSON.parse(readFileSync(spec, 'utf8'));
const bad = [];
for (const m of list) {
  // A suite entry carries the suite's name before the file; a page entry does not.
  const [name, file, oldText, newText] = m.length === 5 ? [m[0], m[2], m[3], m[4]] : m;
  const path = resolve(dir, file);
  if (!existsSync(path)) { bad.push(`${name}: ${file} is not in ${dir}`); continue; }
  const n = readFileSync(path, 'utf8').split(oldText).length - 1;
  if (n !== 1) bad.push(`${name}: its old text is in ${file} ${n} times, not once`);
  else if (oldText === newText) bad.push(`${name}: its new text is its old text`);
}
console.log(bad.length ? `${bad.length} of ${list.length} do not apply:\n  ${bad.join('\n  ')}` : `all ${list.length} apply, each exactly once`);
process.exit(bad.length ? 1 : 0);

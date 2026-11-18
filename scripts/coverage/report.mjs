#!/usr/bin/env node
/**
 * One coverage reading of the orchestratinator, from the suites' V8 data and
 * the page checks' Chrome data.
 *
 *   node scripts/coverage/report.mjs <repo> <node cov dir> <page cov dir | -> <out dir>
 *
 * Normally run by scripts/coverage/run.sh (`npm run coverage`). A port, line
 * for line, of the report QA validated in the milestone audit (2026-11-17,
 * cov-report.py in the QA repo's scripts/audit-2026-11-17/): costmo ruled
 * that the project owns a coverage reading and that the audit's numbers are
 * the baseline (item B), so the counting rules below are the audit's and are
 * not to be "improved" without moving the baseline on purpose.
 *
 *  1. Page snapshots carry http://localhost:<port>/<file>.js URLs. Each is
 *     rewritten to the src/ui file of the same name, and kept only if that
 *     file exists; other URLs (Chrome's own, inline scripts) are dropped and
 *     counted.
 *  2. c8 (10.1.3, pinned in package.json) turns the node and page snapshots
 *     into istanbul's coverage-final.json, with --all, so a file no process
 *     loaded reads 0 rather than being absent.
 *  3. Lifted page sections (data/<name>-<pid>.mjs: test/floor.mjs imports a
 *     slice of src/ui/*.js, and the preload keeps the file) are credited to
 *     the src/ui lines they came from: at each line, the longest verbatim run
 *     (3 lines or more, leading spaces ignored) found in a src/ui file. Lines
 *     found nowhere are the test's own stubs and are not credited.
 *  4. Per file: code lines (blank and comment-only lines are not code: this
 *     codebase is comment-heavy, and c8 scores a comment line by its
 *     enclosing function), functions, branches. For src/ui files the page
 *     and the lifted sections are given apart and as a union (lines only: a
 *     lifted run has no page branches).
 *
 * Output: <out>/table.md, <out>/per-file.json, <out>/node+page/coverage-final.json.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [repoArg, ncovArg, pcovArg, outArg] = process.argv.slice(2);
if (!repoArg || !ncovArg || !pcovArg || !outArg) { console.error('usage: report.mjs <repo> <node cov dir> <page cov dir | -> <out dir>'); process.exit(2); }
const clone = resolve(repoArg);
const ncov = resolve(ncovArg);
const pcov = pcovArg === '-' ? null : resolve(pcovArg);
const out = resolve(outArg);
const C8 = process.env.C8 ?? join(clone, 'node_modules/.bin/c8');
mkdirSync(out, { recursive: true });
const merged = join(out, 'merged');
rmSync(merged, { recursive: true, force: true });
mkdirSync(merged);
const nodeFiles = readdirSync(ncov).filter((f) => f.endsWith('.json'));
for (const f of nodeFiles) symlinkSync(join(ncov, f), join(merged, f));
const ui = Object.fromEntries(readdirSync(join(clone, 'src/ui')).filter((f) => f.endsWith('.js')).sort().map((f) => [f, join(clone, 'src/ui', f)]));

// 1. Page snapshots → src/ui files.
const dropped = {};
let kept = 0;
if (pcov) {
  for (const f of readdirSync(pcov).filter((x) => /^page-.*\.json$/.test(x)).sort()) {
    const d = JSON.parse(readFileSync(join(pcov, f), 'utf8'));
    const res = [];
    for (const r of d.result) {
      const m = /^https?:\/\/[^/]+\/(?:.*\/)?([^/?#]+\.js)(?:[?#].*)?$/.exec(r.url || '');
      if (m && ui[m[1]]) { r.url = pathToFileURL(ui[m[1]]).href; res.push(r); }
      else { const u = (r.url || '(inline)').slice(0, 80); dropped[u] = (dropped[u] ?? 0) + 1; }
    }
    if (res.length) { writeFileSync(join(merged, `coverage-page-${basename(f, '.json')}.json`), JSON.stringify({ result: res })); kept++; }
  }
}

// 2. c8 → istanbul.
const rep = join(out, 'node+page');
rmSync(rep, { recursive: true, force: true });
try {
  execFileSync(C8, ['report', '--temp-directory', merged, '--reports-dir', rep, '-r', 'json', '-r', 'json-summary',
    '--all', '--src', clone, '--exclude-node-modules',
    '--include', 'src/**/*.js', '--include', 'host/**/*.js', '--include', 'plugin/**/*.mjs',
    '--include', 'scripts/**/*.mjs', '--include', 'data/*.mjs'], { cwd: clone, stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 1 << 28 });
} catch (err) { console.error(`c8 failed: ${String(err.stderr ?? err.message).slice(-800)}`); process.exit(1); }
const cov = JSON.parse(readFileSync(join(rep, 'coverage-final.json'), 'utf8'));

/** 1-based numbers of the lines that hold code (the audit's stated heuristic). */
function codeLines(text) {
  const res = new Set();
  let inblock = false;
  text.split('\n').forEach((line, n) => {
    const i = n + 1;
    const s = line.trim();
    if (inblock) {
      if (s.includes('*/')) {
        inblock = false;
        const rest = s.split('*/').slice(1).join('*/').trim();
        if (rest && !rest.startsWith('//')) res.add(i);
      }
      return;
    }
    if (!s || s.startsWith('//')) return;
    if (s.startsWith('/*')) {
      if (!s.slice(2).includes('*/')) { inblock = true; return; }
      const rest = s.split('*/').slice(1).join('*/').trim();
      if (rest && !rest.startsWith('//')) res.add(i);
      return;
    }
    if (s.startsWith('*')) return;
    res.add(i);
  });
  return res;
}

function lineHits(fc) {
  const hit = new Set();
  const seen = new Set();
  for (const [k, loc] of Object.entries(fc.statementMap)) {
    const ln = loc.start.line;
    seen.add(ln);
    if (fc.s[k] > 0) hit.add(ln);
  }
  return { seen, hit };
}

const perfile = {};
const liftedCredit = {};
for (const [path, fc] of Object.entries(cov)) {
  const rel = relative(clone, path);
  if (rel.startsWith('data/')) continue;
  const code = codeLines(readFileSync(path, 'utf8'));
  const { hit } = lineHits(fc);
  const fnTotal = Object.keys(fc.fnMap).length;
  const fnHit = Object.values(fc.f).filter((c) => c > 0).length;
  const brTotal = Object.values(fc.b).reduce((n, v) => n + v.length, 0);
  const brHit = Object.values(fc.b).reduce((n, v) => n + v.filter((c) => c > 0).length, 0);
  perfile[rel] = { code: code.size, code_hit: [...code].filter((l) => hit.has(l)).length, fn: fnTotal, fn_hit: fnHit, br: brTotal, br_hit: brHit, _hit: hit, _code: code };
}

// 3. Lifted sections → src/ui lines.
const srcIdx = Object.fromEntries(Object.entries(ui).map(([n, p]) => {
  const L = readFileSync(p, 'utf8').split('\n').map((l) => l.trimStart());
  const idx = new Map();
  L.forEach((t, j) => { if (!idx.has(t)) idx.set(t, []); idx.get(t).push(j); });
  return [n, { L, idx }];
}));
const liftlog = [];
for (const [path, fc] of Object.entries(cov)) {
  const rel = relative(clone, path);
  if (!rel.startsWith('data/')) continue;
  let D = readFileSync(path, 'utf8').split('\n');
  D = D.length && D[D.length - 1] === '' ? D.slice(0, -2) : D.slice(0, -1); // the export line
  const { hit } = lineHits(fc);
  let i = 0;
  let stubs = 0;
  const chunks = [];
  while (i < D.length) {
    const t = D[i].trimStart();
    let best = [0, null, null];
    if (t) {
      for (const [n, { L, idx }] of Object.entries(srcIdx)) {
        for (const j of idx.get(t) ?? []) {
          let k = 0;
          while (i + k < D.length && j + k < L.length && D[i + k].trimStart() === L[j + k]) k++;
          if (k > best[0]) best = [k, n, j];
        }
      }
    }
    if (best[0] >= 3) {
      const [k, n, j] = best;
      const credit = new Set([...hit].filter((ln) => i < ln && ln <= i + k).map((ln) => j + 1 + (ln - 1 - i)));
      const key = `src/ui/${n}`;
      liftedCredit[key] ??= new Set();
      for (const c of credit) liftedCredit[key].add(c);
      chunks.push(`src/ui/${n}:${j + 1}-${j + k} (${credit.size} run)`);
      i += k;
    } else {
      if (t) stubs++;
      i++;
    }
  }
  liftlog.push(`${rel} → ${chunks.join('; ') || 'nothing matched'}${stubs ? ` · ${stubs} stub line(s) not credited` : ''}`);
}

// 4. The table.
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) : '—');
const lines = ['| file | code lines | run | % | functions | run | % | branches | run | % |', '|---|---|---|---|---|---|---|---|---|---|'];
const tot = { code: 0, code_hit: 0, fn: 0, fn_hit: 0, br: 0, br_hit: 0 };
for (const rel of Object.keys(perfile).sort()) {
  const p = perfile[rel];
  if (liftedCredit[rel]) {
    const union = new Set([...p._hit, ...liftedCredit[rel]].filter((l) => p._code.has(l)));
    p.code_hit_page_only = p.code_hit;
    p.code_hit_lifted_only = [...liftedCredit[rel]].filter((l) => p._code.has(l)).length;
    p.code_hit = union.size;
  }
  for (const k of Object.keys(tot)) tot[k] += p[k];
  const extra = 'code_hit_page_only' in p ? ` (page ${p.code_hit_page_only}, lifted ${p.code_hit_lifted_only})` : '';
  lines.push(`| ${rel} | ${p.code} | ${p.code_hit}${extra} | ${pct(p.code_hit, p.code)} | ${p.fn} | ${p.fn_hit} | ${pct(p.fn_hit, p.fn)} | ${p.br} | ${p.br_hit} | ${pct(p.br_hit, p.br)} |`);
}
lines.push(`| **all** | ${tot.code} | ${tot.code_hit} | ${pct(tot.code_hit, tot.code)} | ${tot.fn} | ${tot.fn_hit} | ${pct(tot.fn_hit, tot.fn)} | ${tot.br} | ${tot.br_hit} | ${pct(tot.br_hit, tot.br)} |`);
const note = [
  `node snapshot files: ${nodeFiles.length}; page snapshot files kept: ${kept}`,
  `dropped page URLs (count): ${Object.entries(dropped).sort(([a], [b]) => (a < b ? -1 : 1)).slice(0, 12).map(([u, n]) => `${u} ×${n}`).join(', ')}`,
  'lifted sections:', ...liftlog.map((l) => `  ${l}`),
];
writeFileSync(join(out, 'table.md'), `${lines.join('\n')}\n\n${note.join('\n')}\n`);
writeFileSync(join(out, 'per-file.json'), JSON.stringify(Object.fromEntries(Object.entries(perfile).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([kk]) => !kk.startsWith('_')))])), null, 1));
console.log(lines.join('\n'));
console.log(note.join('\n'));
if (!existsSync(join(out, 'table.md'))) process.exit(1);

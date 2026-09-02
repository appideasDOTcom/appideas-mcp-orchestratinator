#!/usr/bin/env node
/*
 * Set the version of every part of the orchestratinator at once.
 *
 *   npm run set-version 0.9.2
 *
 * Three files carry a version and they are three different kinds of thing: an
 * npm package, another npm package, and a Claude Code plugin manifest. None of
 * them can read another at install time — the plugin manifest is parsed by
 * Claude Code straight off disk, so its number has to be a literal — which
 * means "one source of truth" is not available here and the honest version of
 * it is "one action that writes all three".
 *
 * They drifted the way you would expect: the plugin was bumped on its own
 * whenever a hook changed (0.6.0), the host was never bumped at all (0.1.0),
 * and the dashboard went on reporting package.json (0.9.0) — correctly, and
 * about only one of the three.
 *
 * The edit is a substitution rather than a JSON round-trip on purpose: parsing
 * and re-stringifying reformats a file that a human maintains, and a version
 * bump that also reindents the manifest makes the diff useless for the one
 * thing you want to read it for.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Every file holding the product version, and where in it. */
export const VERSIONED = [
  // First, and the one the dashboard reports: src/server.js reads this file at
  // startup rather than carrying a copy.
  'package.json',
  'host/package.json',
  'plugin/.claude-plugin/plugin.json',
];

const root = new URL('../', import.meta.url);
export const versionIn = (rel) => JSON.parse(readFileSync(new URL(rel, root), 'utf8')).version;

export function setVersion(next) {
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(next)) throw new Error(`not a version: ${next}`);
  const changed = [];
  for (const rel of VERSIONED) {
    const path = new URL(rel, root);
    const before = readFileSync(path, 'utf8');
    const after = before.replace(/("version"\s*:\s*")[^"]*(")/, `$1${next}$2`);
    if (after === before && versionIn(rel) !== next) {
      throw new Error(`${rel} has no "version" field to set`);
    }
    if (after !== before) { writeFileSync(path, after); changed.push(rel); }
    // Read back rather than trust the substitution: a regex that matched the
    // wrong "version" would otherwise report success on the wrong line.
    if (versionIn(rel) !== next) throw new Error(`${rel} still reads ${versionIn(rel)} — check which "version" it matched`);
  }
  return changed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const next = process.argv[2];
  if (!next) {
    console.error('usage: npm run set-version <x.y.z>');
    console.error(`current: ${VERSIONED.map((f) => `${f} ${versionIn(f)}`).join('\n         ')}`);
    process.exit(1);
  }
  const changed = setVersion(next);
  console.log(changed.length ? `set ${next} in:\n  ${changed.join('\n  ')}` : `already ${next} everywhere`);
  console.log('\nthe dashboard reads package.json at startup, so it needs the server rebuilt:');
  console.log('  docker compose up -d --build');
}

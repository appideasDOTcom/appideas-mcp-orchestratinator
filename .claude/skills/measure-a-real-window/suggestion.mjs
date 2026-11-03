#!/usr/bin/env node
/**
 * Does the host's `send()` land cleanly on top of a prompt suggestion?
 *
 *   suggestion.mjs <dir>
 *
 * Claude Code 2.1.300 draws a suggested next prompt as dim ghost text a few
 * seconds after a turn ends. This gives the probe a work-shaped turn (three
 * Bash calls — a one-word reply drew no suggestion in 60 s), waits for the
 * dim row, reports what `composerOf` makes of it and where the cursor sits,
 * then pastes a message through `send()` and reads the user record back.
 *
 * Measured 2026-11-02: suggestion "cat notes.txt" after 2 s, cursor at
 * column 2, composerOf " cat notes.txt"; send() ok in 3.2 s; exactly one
 * user record, the host's own words, nothing of the suggestion in it; and a
 * new suggestion drawn after that turn too. Run it again before believing
 * any of that on a newer Claude Code.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const [dir] = process.argv.slice(2);
if (!dir) { console.error('usage: suggestion.mjs <dir>'); process.exit(1); }
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SOCK = process.env.PROBE_SOCKET ?? 'probe';
if (!process.env.ORCH_TMUX) {
  const wrapper = join(resolve(dir), '.tmux-probe.sh');
  if (!existsSync(wrapper)) { writeFileSync(wrapper, `#!/bin/bash\nexec tmux -L ${SOCK} "$@"\n`); chmodSync(wrapper, 0o755); }
  process.env.ORCH_TMUX = wrapper;
}
process.env.ORCH_TMUX_SESSION = 'p';
const W = await import(`${REPO}/host/window.js`);
const t = (...a) => execFileSync('tmux', ['-L', SOCK, ...a], { encoding: 'utf8' });
const cap = (e) => t('capture-pane', '-p', ...(e ? ['-e'] : []), '-t', 'p:probe');
// The composer is the last ❯ row on screen, positionally — not the first one found.
const composerRow = (e) => { const rows = cap(e).split('\n'); for (let i = rows.length - 1; i >= 0; i--) if (/❯/.test(rows[i])) return rows[i]; return ''; };
const users = () => {
  const d = join(homedir(), '.claude', 'projects', resolve(dir).replace(/[/.]/g, '-'));
  const f = readdirSync(d).filter((x) => x.endsWith('.jsonl')).map((x) => ({ x, m: statSync(join(d, x)).mtimeMs })).sort((a, b) => b.m - a.m)[0];
  return readFileSync(join(d, f.x), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.type === 'user' && typeof r.message?.content === 'string').map((r) => `${r.timestamp} ${JSON.stringify(r.message.content).slice(0, 140)}`);
};

t('send-keys', '-t', 'p:probe', '-l', 'Probe fixture, not work: run these as three SEPARATE Bash calls, one at a time: echo alpha; echo beta; echo gamma. Then write the three words to notes.txt in this directory and reply done.');
await sleep(800); t('send-keys', '-t', 'p:probe', 'Enter');
await sleep(3000);
for (let i = 0; i < 240 && /esc to interrupt/i.test(W.footOf(cap())); i++) await sleep(500);
console.log(`turn ended     → ${new Date().toISOString()}; composer row ${JSON.stringify(composerRow())}`);
let ghost = null; const t1 = Date.now();
for (let i = 0; i < 90 && !ghost; i++) { await sleep(1000); const row = composerRow(true); if (/\x1b\[2m/.test(row) && W.composerOf(cap())?.trim()) ghost = row; }
console.log(`suggestion     → ${ghost ? `after ${((Date.now() - t1) / 1000).toFixed(1)} s: ${JSON.stringify(ghost).slice(0, 160)}` : 'NONE in 90 s'}`);
console.log(`composerOf     → ${JSON.stringify(W.composerOf(cap()))}; cursor ${t('display', '-p', '-t', 'p:probe', '#{cursor_x},#{cursor_y}').trim()}`);
const n0 = users().length; const t0 = Date.now();
const r = await W.send(resolve(dir), 'PING: probe fixture, reply with exactly the word PONG.');
console.log(`send()         → ${JSON.stringify({ ok: r.ok, code: r.code, error: r.error })} in ${Date.now() - t0} ms`);
await sleep(4000);
const added = users().slice(n0);
console.log(`user records   → ${added.length} added`);
for (const u of added) console.log(`                 ${u}`);
for (let i = 0; i < 60 && !/PONG/.test(cap()); i++) await sleep(500);
console.log(`composer after → ${JSON.stringify(composerRow())}`);

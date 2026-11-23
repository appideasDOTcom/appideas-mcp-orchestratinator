/**
 * Which Claude Code this machine runs, and saying when that changes (0.14.6,
 * docs/robustness-review.md item 4; costmo's ruling the same day: Anthropic's
 * stable channel, nobody held to a version the floor was checked against,
 * so this reports and never gates or pins).
 *
 * Every screen the host reads is drawn by Claude Code, and an update is when
 * one moves: eight times in three weeks by the review's count, and each time
 * the first sign on the floor was a desk behaving differently with nothing to
 * say why. So the host reads `claude --version` at each heartbeat (about 10 ms
 * on 2.1.330, measured), keeps the last reading for this host in its own
 * folder, and when it changes says so on every desk it runs, in one line
 * labeled host: which version, which before it, and where to look. A host
 * meeting a version for the first time says nothing: there is nothing to
 * compare it with.
 *
 * What it does not do, and why: it starts no probe window to re-measure the
 * readers. That needs a model turn on the operator's account at every update,
 * and `/model` in a probe writes the machine's default (this repo's memory
 * of 2026-11-21). What stands in for it is the screen reading itself: since
 * 0.14.6 a screen the host does not know reaches the desk as "needs you",
 * with its lines, so an update that moves a screen shows up there.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { claudeEnv } from './auth.js';

const CLAUDE = process.env.ORCH_HOST_CLAUDE ?? 'claude';
const VERSION_TIMEOUT_MS = Number(process.env.ORCH_CLAUDE_VERSION_TIMEOUT_MS ?? 5_000);
const STATE = process.env.ORCH_CLAUDE_VERSION_FILE ?? join(homedir(), '.orchestratinator', 'claude-version.json');

/** The version in what `claude --version` printed ("2.1.330 (Claude Code)"), or null. */
export function versionOf(output) {
  const m = /(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][\w.]+)?)\b/.exec(String(output ?? ''));
  return m ? m[1] : null;
}

/** What `claude --version` says now, or null when it says nothing usable within the timeout. */
export function claudeVersion() {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const end = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn(CLAUDE, ['--version'], { env: claudeEnv(), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch { end(null); return; }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } end(null); }, VERSION_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); end(null); });
    child.on('close', () => { clearTimeout(timer); end(versionOf(out)); });
  });
}

/** A change worth saying: both readings known and different. */
export function versionChange(before, now) {
  return before && now && before !== now ? { from: before, to: now } : null;
}

/** The line each desk is told. */
export function versionWords(hostName, change) {
  return `Claude Code on ${hostName} is now ${change.to} (it was ${change.from}). The host checks a new version with the floor's protocol probe, and says here what it found.`;
}

/** The last version this host read, from its own file; null when it has none. */
export function lastVersion(hostId, file = STATE) {
  try { return JSON.parse(readFileSync(file, 'utf8'))?.[hostId] ?? null; } catch { return null; }
}

/** Keep this host's reading. A file that cannot be written is said nowhere: the next heartbeat reads again. */
export function keepVersion(hostId, version, file = STATE) {
  let all = {};
  try { all = JSON.parse(readFileSync(file, 'utf8')) ?? {}; } catch { /* first one */ }
  if (all[hostId] === version) return;
  all[hostId] = version;
  try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`); } catch { /* read again next time */ }
}

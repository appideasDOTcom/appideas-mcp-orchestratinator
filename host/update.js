/*
 * The host's half of an update (issue #40): what it says about itself on
 * every registration, and the steps it carries out when the board asks.
 *
 * The host is the one part that can reach everything an update touches. The
 * server runs in a container with no clone and no Docker access; the clone
 * is the directory the host runs from (host/install.sh points launchd at
 * host/index.js inside it), and Docker and Claude Code are on this machine.
 *
 * The steps, in order, each reported to the board as it starts and ends:
 *   preflight  supervised by launchd (not the desktop app, which updates its
 *              own host), the clone clean and on the followed branch
 *   fetch      the branch from GitHub over HTTPS (public: no key, no ssh agent,
 *              which a LaunchAgent does not have), and the commit an
 *              ancestor-or-equal of nothing local: HEAD must be behind it
 *   checkout   `git merge --ff-only <commit>` — never a reset onto it
 *   server     `docker compose up -d --build`, then /health answering as the
 *              commit. A failed build puts the clone back (`git reset --keep`)
 *              so the clone and the board stay on the build that is running
 *   plugin     `claude plugin update` when plugin/ differs between the two
 *              commits; the marketplace is this clone, so it installs what
 *              the checkout just put there
 *   host       exit, and launchd starts the new code (KeepAlive). The board
 *              closes the run when this host registers again as the commit.
 *
 * Refusals happen before anything is touched and say why. A dirty clone is a
 * refusal, never a stash: on this machine the clone is also a developer's
 * working tree (the deploy skill: "a question for the channel, not a stash").
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CLONE = resolve(process.env.ORCH_HOST_CLONE || resolve(HERE, '..'));
export const LAUNCH_LABEL = 'com.appideas.orchestratinator-host';
const DOCKER = process.env.ORCH_HOST_DOCKER || 'docker';
const CLAUDE = process.env.ORCH_HOST_CLAUDE || 'claude';
const GIT = 'git';
const PLUGIN = 'orchestratinator-floor@appideas-orchestratinator';
const BUILD_TIMEOUT_MS = Number(process.env.ORCH_UPDATE_BUILD_TIMEOUT_MS ?? 15 * 60_000);
const HEALTH_TIMEOUT_MS = Number(process.env.ORCH_UPDATE_HEALTH_TIMEOUT_MS ?? 3 * 60_000);
const FETCH_TIMEOUT_MS = 2 * 60_000;

/** One command, never through a shell. Resolves with what it said; never throws. */
export function sh(cmd, args, { cwd = CLONE, timeout = 30_000 } = {}) {
  return new Promise((done) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024, env: process.env }, (err, stdout, stderr) => {
      done({
        ok: !err,
        code: err ? (typeof err.code === 'number' ? err.code : err.killed ? 'timeout' : err.code ?? 'failed') : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      });
    });
  });
}

/** What the board's /health says it is, as a commit and a phrase for the page. */
async function boardCommit(boardUrl) {
  try {
    const res = await fetch(`${boardUrl}/health`, { signal: AbortSignal.timeout(3000) });
    const h = await res.json();
    return { commit: h.commit ?? null, answer: `${h.version ?? '?'} at ${String(h.commit ?? '').slice(0, 7) || 'an unknown commit'}` };
  } catch (err) {
    return { commit: null, answer: `nothing (${err.cause?.code ?? err.name})` };
  }
}

/** The last few non-empty lines of what a command said, for a sentence on the page. */
export function tail(r, n = 3) {
  return `${r.stderr}\n${r.stdout}`.split('\n').map((l) => l.trim()).filter(Boolean).slice(-n).join(' · ') || `exit ${r.code}`;
}

/** The commit, version and protocol of the code this process is running — read once, at start. */
const PKG = (() => { try { return JSON.parse(readFileSync(resolve(HERE, 'package.json'), 'utf8')); } catch { return {}; } })();
export const BUILD = {
  version: PKG.version ?? null,
  // The host<->board protocol this code speaks: `protocol` in host/package.json,
  // compared by the board at every registration and refused in words when it
  // is not the board's (protocolRefusal in src/floor.js says what the number
  // covers). ORCH_HOST_PROTOCOL is the suites' stand-in for a host from
  // another build; nothing installed sets it.
  protocol: process.env.ORCH_HOST_PROTOCOL != null && process.env.ORCH_HOST_PROTOCOL !== '' ? Number(process.env.ORCH_HOST_PROTOCOL) : PKG.protocol ?? null,
  commit: null,
};
export async function readBuild() {
  const r = await sh(GIT, ['rev-parse', 'HEAD']);
  BUILD.commit = r.ok ? r.stdout.trim() : null;
  return BUILD;
}

/**
 * Who starts this host again after it exits, or null for nobody.
 *
 *   'launchd'  the LaunchAgent (XPC_SERVICE_NAME is its label), or a suite
 *              saying so with ORCH_HOST_SUPERVISED=1
 *   'app'      the desktop app, which runs host/index.js as a child it keeps
 *              running (ORCH_HOST_SUPERVISOR=app)
 *   <word>     anything else named in ORCH_HOST_SUPERVISOR — letters, digits
 *              and dashes, so the board can say it back
 *
 * Reported on every registration as `supervisor` (and `supervised`, which
 * older boards read). The page's update (issue #40) is for launchd's host
 * only: it moves a git clone and restarts through launchd's KeepAlive. An
 * app-run host has no clone to move — the app carries the host's code and
 * updates it itself — so the board offers no update for it and this code
 * refuses one at preflight, in the same words (task #289 on the desktop
 * channel). A host nobody restarts is refused as before.
 */
export const supervisor = () => {
  if (process.env.XPC_SERVICE_NAME === LAUNCH_LABEL || process.env.ORCH_HOST_SUPERVISED === '1') return 'launchd';
  const named = String(process.env.ORCH_HOST_SUPERVISOR ?? '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,39}$/.test(named) ? named : null;
};
/** Is a restart something that will come back. */
export const supervised = () => supervisor() !== null;
/** The words an app-run host is refused an update in, at the board and at preflight. */
export const APP_UPDATES_ITSELF = 'this host is run by the Orchestratinator app, which carries its code and updates it; the board does not update it';

/** The clone as it stands: branch, HEAD, and anything uncommitted (untracked files included). */
export async function cloneState() {
  const [b, h, s] = await Promise.all([
    sh(GIT, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    sh(GIT, ['rev-parse', 'HEAD']),
    sh(GIT, ['status', '--porcelain', '--untracked-files=normal']),
  ]);
  if (!h.ok) return { path: CLONE, error: `git rev-parse HEAD in ${CLONE}: ${tail(h, 1)}` };
  if (!s.ok) return { path: CLONE, error: `git status in ${CLONE}: ${tail(s, 1)}` };
  const changes = s.stdout.split('\n').filter((l) => l.trim()).map((l) => l.slice(3));
  return { path: CLONE, branch: b.ok ? b.stdout.trim() : null, head: h.stdout.trim(), dirty: changes.length > 0, changes: changes.slice(0, 20) };
}

/**
 * The board's container, if this clone's compose project runs one here.
 * Asked of Docker by label rather than through `docker compose ps`, which
 * reads .env and fails on a clone without one.
 */
export async function boardContainer() {
  const r = await sh(DOCKER, ['ps', '-q', '--no-trunc',
    '--filter', `label=com.docker.compose.project.working_dir=${CLONE}`,
    '--filter', 'label=com.docker.compose.service=orchestratinator'], { timeout: 5000 });
  return r.ok ? (r.stdout.split('\n').map((l) => l.trim()).find(Boolean) ?? null) : null;
}

/** What runUpdate understands beyond the first cut: `finish` (and its `from`). */
export const CAPABILITIES = ['finish'];

/** What the host says about itself, beside its desks, on every registration. */
export async function selfReport() {
  const [clone, container] = await Promise.all([cloneState(), boardContainer()]);
  // What this code can do for an update, so the board does not ask a host
  // for something its code would get quietly wrong (PR #42 N1: a Finish
  // carried out by a host from before Finish existed).
  return { build: { ...BUILD }, protocol: BUILD.protocol, clone, board_container: container, supervised: supervised(), supervisor: supervisor(), capabilities: CAPABILITIES };
}

/**
 * Carry out one update. `say(step, state, detail)` reports to the board;
 * `restart()` is called last, once every step before it is done.
 * Returns the outcome for the log.
 */
export async function runUpdate({ commit, branch, repo, from: startedFrom = null, finish = false }, { say, boardUrl, restart }) {
  const fetchUrl = process.env.ORCH_UPDATE_FETCH_URL || `https://github.com/${repo}.git`;
  const s7 = (sha) => String(sha ?? '').slice(0, 7);
  const refuse = async (step, why) => { await say(step, 'refused', why); return { ok: false, step, why }; };
  const fail = async (step, why) => { await say(step, 'failed', why); return { ok: false, step, why }; };

  // preflight
  await say('preflight', 'running', null);
  if (!/^[0-9a-f]{40}$/.test(String(commit))) return refuse('preflight', `"${commit}" is not a commit`);
  if (supervisor() === 'app') return refuse('preflight', APP_UPDATES_ITSELF);
  if (supervisor() !== 'launchd') return refuse('preflight', 'this host is not running as its LaunchAgent, so nothing would start it again after the update');
  const clone = await cloneState();
  if (clone.error) return refuse('preflight', clone.error);
  if (clone.dirty) return refuse('preflight', `the clone at ${CLONE} has local changes (${clone.changes.slice(0, 3).join(', ')}${clone.changes.length > 3 ? `, +${clone.changes.length - 3} more` : ''})`);
  if (clone.branch !== branch) return refuse('preflight', `the clone at ${CLONE} is on ${clone.branch ? `"${clone.branch}"` : 'a detached HEAD'}, not ${branch}`);
  const from = clone.head;
  await say('preflight', 'done', `${CLONE} is clean and on ${branch} at ${s7(from)}`);

  // fetch
  await say('fetch', 'running', fetchUrl);
  const f = await sh(GIT, ['fetch', '--quiet', '--no-tags', fetchUrl, `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { timeout: FETCH_TIMEOUT_MS });
  if (!f.ok) return fail('fetch', `git fetch ${fetchUrl} ${branch}: ${tail(f)}`);
  if (!(await sh(GIT, ['cat-file', '-e', `${commit}^{commit}`])).ok) return fail('fetch', `${s7(commit)} is not in what GitHub has for ${branch}`);
  if (from === commit) {
    await say('fetch', 'done', `the clone is already at ${s7(commit)}`);
  } else {
    if (!(await sh(GIT, ['merge-base', '--is-ancestor', from, commit])).ok) {
      return refuse('fetch', `the clone has commits that are not on ${branch} (${s7(from)} is not behind ${s7(commit)}), so it cannot be moved forward without losing them`);
    }
    await say('fetch', 'done', `${s7(commit)} fetched`);
  }

  // checkout
  await say('checkout', 'running', null);
  if (from !== commit) {
    const m = await sh(GIT, ['merge', '--ff-only', '--quiet', commit]);
    if (!m.ok) return fail('checkout', `git merge --ff-only ${s7(commit)}: ${tail(m)}`);
  }
  await say('checkout', 'done', `${s7(from)} → ${s7(commit)}`);
  // Anything that stops before the server is rebuilt puts the clone back, so
  // the clone, the host and the board all stay on the build that is running.
  const putBack = async () => {
    if (from === commit) return '';
    const r = await sh(GIT, ['reset', '--keep', from]);
    return r.ok ? ` The clone is back on ${s7(from)}.` : ` Putting the clone back on ${s7(from)} failed too: ${tail(r, 1)}.`;
  };

  // server
  // A board that already answers as the commit is not rebuilt: that is
  // Finish the update after a run stopped past the rebuild (PR #42 finding
  // 1), and a rebuild of an unchanged tree would only say "Running" and fail.
  const already = await boardCommit(boardUrl);
  if (already.commit === commit) {
    await say('server', 'skipped', `the board already answers as ${already.answer}`);
  } else {
    await say('server', 'running', 'docker compose up -d --build — the board goes away while its container is replaced');
    const d = await sh(DOCKER, ['compose', 'up', '-d', '--build'], { timeout: BUILD_TIMEOUT_MS });
    if (!d.ok) return fail('server', `docker compose up -d --build ${d.code === 'timeout' ? `did not finish in ${BUILD_TIMEOUT_MS / 60_000} minutes` : `exited ${d.code}`}: ${tail(d)}. The board is still the build it was.${await putBack()}`);
    // "Running" alone means compose found nothing to change: the old container
    // is still the one serving (deploy-both-halves: it must say Recreated).
    const said = `${d.stdout}\n${d.stderr}`;
    if (!/\b(Recreated|Recreate|Started|Created)\b/.test(said)) {
      return fail('server', `docker compose did not replace the container (it said: ${tail(d, 2)}). The board is still the build it was.${await putBack()}`);
    }
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    let answer = 'nothing';
    for (;;) {
      const b = await boardCommit(boardUrl);
      answer = b.answer;
      if (b.commit === commit) break;
      if (Date.now() > deadline) return fail('server', `the container was replaced, but in ${HEALTH_TIMEOUT_MS / 1000}s the board never answered as ${s7(commit)} — it last answered ${answer}`);
      await sleep(1000);
    }
    await say('server', 'done', `the board answers as ${answer}`);
  }

  // plugin
  // Compared from where the update started. That is the clone's HEAD before
  // the checkout, except when finishing: the clone is at the commit by then,
  // and the plugin is still whatever the stopped run left it.
  const pluginFrom = finish && /^[0-9a-f]{40}$/.test(String(startedFrom)) ? startedFrom : from;
  const same = await sh(GIT, ['diff', '--quiet', pluginFrom, commit, '--', 'plugin/']);
  if (same.ok) {
    await say('plugin', 'skipped', 'plugin/ is the same in both commits');
  } else {
    await say('plugin', 'running', `claude plugin update ${PLUGIN}`);
    const p = await sh(CLAUDE, ['plugin', 'update', PLUGIN], { timeout: 2 * 60_000 });
    const out = tail(p, 2);
    if (!p.ok && /not (installed|found)/i.test(out)) {
      await say('plugin', 'skipped', `the plugin is not installed on this machine (${out})`);
    } else if (!p.ok) {
      return fail('plugin', `claude plugin update exited ${p.code}: ${out}. The board is on ${s7(commit)}; the host was not restarted and runs the code it started with.`);
    } else {
      await say('plugin', 'done', `${out}. Open windows keep the hooks they started with until they restart.`);
    }
  }

  // host
  await say('host', 'running', 'restarting the host — the relay pauses for a few seconds');
  await restart();
  return { ok: true };
}

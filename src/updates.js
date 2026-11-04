/*
 * Updates (issue #40): the board checks GitHub for a newer build, says so in
 * the page header, and on one click has the host beside it bring every part
 * on the machine — server, host and plugin — to that commit.
 *
 * Who does what, and why it is split this way:
 *   - The board checks. Settings are per board (a `settings` row, not
 *     localStorage), so the daily check runs once per board rather than once
 *     per open tab, and turning checking off stops every contact with GitHub
 *     except a press of Check now.
 *   - The host updates. The server runs in a container with no clone and no
 *     Docker access; the clone and the host's process are on the operator's
 *     machine, and the host runs from the clone (host/install.sh), so it is
 *     the one part that can reach all three. The board never connects to a
 *     machine: the update is a work item like any other, and the host reports
 *     each step back as an event.
 *   - Which host: the one whose registration names this server's own
 *     container. Inside Docker the hostname is the container's short id, and
 *     the host asks Docker for the container its clone's compose project runs
 *     (host/update.js). Nothing else joins a host to "the machine the board
 *     is on" without guessing.
 *
 * A new version is the newest commit on the followed branch, never a bigger
 * version number (Decided: two merges to main kept their version, develop's
 * last five commits all read 0.10.18). The version is fetched only to show.
 *
 * GitHub's unauthenticated API allows 60 requests an hour (measured). A check
 * costs one — the branch's last 100 commits, which says both what is newest
 * and how far behind this build is — and a second only when this build is not
 * among them (a compare). Contacts are at least MIN_GAP_MS apart however often
 * Check now is pressed, and a press inside the gap answers with the result in
 * hand and says when it may ask again. The version comes from
 * raw.githubusercontent.com, which is not the API and not counted.
 */
import express from 'express';
import { hostname } from 'node:os';
import { SERVER_CHANNEL } from './auth.js';

export const UPDATE_REPO_DEFAULT = 'appideasDOTcom/appideas-mcp-orchestratinator';
const DAY_MS = 24 * 60 * 60 * 1000;
// A failed automatic check is tried again after an hour, not a day: a laptop
// that was offline at the daily moment should not wait until tomorrow.
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;
const GITHUB_TIMEOUT_MS = 10_000;

/** The branch the board follows: main, or develop when the operator asked for it. */
export const branchOf = (dev) => (dev ? 'develop' : 'main');
export const short = (sha) => (typeof sha === 'string' ? sha.slice(0, 7) : null);

/**
 * Where this build stands against the last check of the followed branch.
 * Pure, so a finished update reads "You have the latest" the moment the new
 * build answers, from the list already in hand, with nothing fetched.
 *   unchecked — nothing checked on this branch yet
 *   unknown   — this build does not know its commit, or it is not on GitHub
 *   latest    — this build is the newest commit
 *   ahead     — this build is ahead of the branch (a local commit on top of it)
 *   behind    — the branch has commits this build does not
 *   diverged  — both have commits the other does not (built from another branch)
 */
export function standingOf(running, last, branch) {
  if (!last?.head?.sha || last.branch !== branch) return { state: 'unchecked', behind_by: null };
  if (!running) return { state: 'unknown', behind_by: null, why: 'this build does not know which commit it was built from' };
  if (running === last.head.sha) return { state: 'latest', behind_by: 0 };
  const at = Array.isArray(last.recent) ? last.recent.indexOf(running) : -1;
  if (at > 0) return { state: 'behind', behind_by: at };
  const c = last.compared?.[running];
  if (c?.status === 'behind') return { state: 'behind', behind_by: c.behind_by ?? null };
  if (c?.status === 'ahead' || c?.status === 'identical') return { state: c.status === 'identical' ? 'latest' : 'ahead', behind_by: 0 };
  if (c?.status === 'diverged') return { state: 'diverged', behind_by: c.behind_by ?? null };
  if (c?.status === 'missing') return { state: 'unknown', behind_by: null, why: `this build's commit ${short(running)} is not on GitHub` };
  return { state: 'unknown', behind_by: null, why: 'not compared yet — check again' };
}

/** Is there something to update to: a commit on the branch this build lacks. */
export const isNewer = (standing) => standing.state === 'behind' || standing.state === 'diverged';

/** A run still going. A run stays "going" only while the host keeps talking. */
export const runActive = (run) => !!run && (run.state === 'queued' || run.state === 'running');

/**
 * A run that stopped after the board was rebuilt (PR #42 finding 1). The
 * board already answers as its commit, so nothing is "newer" any more and the
 * offer is gone, but the plugin and the host may still be on the old build:
 * a plugin update that failed, or a host that never came back from its
 * restart. Such a run is what the header shows ("Update stopped") until a run
 * finishes it, and it is what Finish the update finishes. `from` is the build
 * the update started from, kept by a finishing run too, so a finish that
 * stops again is still this.
 */
export function stoppedOf(run, commit) {
  if (!run || !commit || (run.state !== 'failed' && run.state !== 'refused')) return null;
  return run.commit === commit && run.from !== commit ? run : null;
}

/**
 * Why an update would be refused before anything is touched, in words for the
 * page, or null. `finishing` is Finish the update on a stopped run: its commit
 * is the running build, so nothing about the check applies to it. The host checks its clone again when it starts — this is
 * what the board can say from the host's last report, so the confirmation
 * shows the refusal instead of an Update button that would only be refused.
 */
export function refusalOf({ check, standing, branch, self, host, report, run, finishing = false }) {
  if (runActive(run)) return 'An update is already under way.';
  if (!finishing && (!check?.head?.sha || check.branch !== branch)) return `Nothing has been checked on ${branch} yet. Press Check now first.`;
  if (!finishing && !isNewer(standing)) return standing.state === 'latest' ? 'This board is already on the newest commit.' : `There is nothing newer on ${branch} to update to.`;
  if (!self.container) return 'This board is not running in a Docker container, so there is no build for a host to replace. It updates only when it runs from docker-compose.yml.';
  if (!host) return 'No host on this board\'s machine has reported in. The update is carried out by the host running beside the board\'s container, and none is live.';
  if (!report.supervised) return `The host on ${host.name} is not running as its LaunchAgent, so nothing would start it again after the update. Restarting a host is macOS-only today (issues #26, #28).`;
  const c = report.clone ?? {};
  if (c.error) return `The host could not read its clone: ${c.error}`;
  if (c.dirty) return `The clone at ${c.path} has local changes (${c.changes?.length ? c.changes.slice(0, 3).join(', ') + (c.changes.length > 3 ? `, +${c.changes.length - 3} more` : '') : 'uncommitted'}). It is not updated while it has them.`;
  if (c.branch !== branch) return `The clone at ${c.path} is on ${c.branch ? `"${c.branch}"` : 'no branch (a detached HEAD)'}, not ${branch}. It is updated only on the branch the board follows.`;
  return null;
}

export function createUpdates({ store, sessions = {}, version, commit, env = process.env, fetchImpl = fetch, hostStaleSeconds = 90 }) {
  const REPO = env.ORCH_UPDATE_REPO || UPDATE_REPO_DEFAULT;
  const API = (env.ORCH_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
  const RAW = (env.ORCH_GITHUB_RAW || 'https://raw.githubusercontent.com').replace(/\/+$/, '');
  const MIN_GAP_MS = Math.max(0, Number(env.ORCH_UPDATE_MIN_GAP_MS ?? 60_000));
  const TICK_MS = Math.max(1000, Number(env.ORCH_UPDATE_TICK_MS ?? 10 * 60_000));
  const RUN_SILENT_MS = Math.max(1000, Number(env.ORCH_UPDATE_SILENT_MS ?? 20 * 60_000));
  // Inside Docker the hostname is the container's short id. ORCH_BOARD_CONTAINER
  // is for the suites, which run the server bare and stand in for a container.
  const container = (() => {
    const given = (env.ORCH_BOARD_CONTAINER ?? '').trim();
    if (given) return given;
    const h = hostname();
    return /^[0-9a-f]{12}$/.test(h) ? h : null;
  })();
  const self = { version, commit, container };
  // What each host last said about itself: its build, its clone, the container
  // it found. In memory, like the folder lists: it is re-sent every minute and
  // a server rebuilt mid-update hears it again within seconds.
  const reports = new Map();

  const get = (k, d) => store.getSetting(`updates.${k}`, d);
  const put = (k, v) => store.setSetting(`updates.${k}`, v);
  const settings = () => ({ check: get('check', true) !== false, dev: get('dev', false) === true });
  const log = (action, target, detail) => store.logAdmin(SERVER_CHANNEL, action, { actor: 'operator', target, detail });
  const sysLog = (action, target, detail) => store.logAdmin(SERVER_CHANNEL, action, { actor: 'system', target, detail });

  const matches = (found) => !!(found && container && (found.startsWith(container) || container.startsWith(found)));
  const liveHosts = (nowMs = Date.now()) => store.listHosts().filter((h) => {
    const seen = Date.parse(`${String(h.last_seen).replace(' ', 'T')}Z`);
    return Number.isFinite(seen) && (nowMs - seen) / 1000 < hostStaleSeconds;
  });
  /** The live host that runs beside this board's container, and what it last said. */
  function updater(nowMs = Date.now()) {
    for (const h of liveHosts(nowMs)) {
      const r = reports.get(h.host_id);
      if (r && matches(r.board_container)) return { host: h, report: r };
    }
    return { host: null, report: null };
  }

  /* ───────── the check ───────── */

  const headers = { 'user-agent': `appideas-orchestratinator/${version}`, accept: 'application/vnd.github+json' };
  async function getJson(url) {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) });
    let body = null;
    try { body = await res.json(); } catch { /* an error page */ }
    return { res, body };
  }
  const limitReset = (res) => {
    if (res.status !== 403 && res.status !== 429) return null;
    if (res.headers.get('x-ratelimit-remaining') !== '0' && res.status !== 429) return null;
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    return Number.isFinite(reset) && reset > 0 ? reset * 1000 : Date.now() + 60 * 60_000;
  };
  const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16) + ' UTC';

  /**
   * Ask GitHub, unless the last contact was too recent or the limit is spent.
   * Every outcome is stored and returned in words; nothing is thrown.
   */
  async function check({ by = 'operator', nowMs = Date.now() } = {}) {
    const { dev } = settings();
    const branch = branchOf(dev);
    const contact = get('contact', {});
    if (contact.reset_at && nowMs < contact.reset_at) {
      return { ok: false, throttled: true, error: `GitHub's limit for unauthenticated checks is used up until ${hhmm(contact.reset_at)}.` };
    }
    if (contact.at && nowMs - contact.at < MIN_GAP_MS) {
      const wait = Math.ceil((MIN_GAP_MS - (nowMs - contact.at)) / 1000);
      return { ok: true, throttled: true, retry_in_s: wait, note: `Checked ${Math.round((nowMs - contact.at) / 1000)}s ago. GitHub allows 60 checks an hour, so the next is in ${wait}s.` };
    }
    put('contact', { at: nowMs, by });
    const prev = get('last', null);
    const keep = prev?.branch === branch ? prev : null;
    const fail = (error, resetAt = null) => {
      if (resetAt) put('contact', { at: nowMs, by, reset_at: resetAt });
      put('last', { ...(keep ?? { branch }), branch, error, error_at: new Date(nowMs).toISOString(), tried_at: new Date(nowMs).toISOString() });
      if (by !== 'daily') log('update.check', branch, `failed: ${error}`);
      else sysLog('update.check', branch, `failed: ${error}`);
      return { ok: false, error };
    };
    let list;
    try {
      const { res, body } = await getJson(`${API}/repos/${REPO}/commits?sha=${encodeURIComponent(branch)}&per_page=100`);
      const reset = limitReset(res);
      if (reset) return fail(`GitHub's limit for unauthenticated checks is used up until ${hhmm(reset)}.`, reset);
      if (res.status === 404) return fail(`GitHub has no branch "${branch}" in ${REPO}.`);
      if (!res.ok) return fail(`GitHub answered ${res.status}${body?.message ? `: ${body.message}` : ''}.`);
      if (!Array.isArray(body) || !body[0]?.sha) return fail('GitHub answered with no commits.');
      list = body;
    } catch (err) {
      return fail(`GitHub could not be reached (${err.name === 'TimeoutError' ? `no answer in ${GITHUB_TIMEOUT_MS / 1000}s` : err.cause?.code ?? err.message}).`);
    }
    const head = list[0];
    const recent = list.map((c) => c.sha);
    // Kept from the previous check when the head has not moved, so a build
    // that needed a compare is not compared again on every press.
    const compared = keep?.head?.sha === head.sha ? { ...(keep.compared ?? {}) } : {};
    if (commit && !recent.includes(commit) && !compared[commit]) {
      try {
        const { res, body } = await getJson(`${API}/repos/${REPO}/compare/${head.sha}...${commit}`);
        if (res.status === 404) compared[commit] = { status: 'missing' };
        else if (res.ok && body?.status) compared[commit] = { status: body.status, behind_by: Number(body.behind_by) || 0, ahead_by: Number(body.ahead_by) || 0 };
      } catch { /* standing says "not compared yet" */ }
    }
    let headVersion = null;
    try {
      const res = await fetchImpl(`${RAW}/${REPO}/${head.sha}/package.json`, { headers: { 'user-agent': headers['user-agent'] }, signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) });
      if (res.ok) headVersion = (await res.json())?.version ?? null;
    } catch { /* the version is only for show */ }
    const at = new Date(nowMs).toISOString();
    const last = {
      branch,
      at,
      tried_at: at,
      error: null,
      head: {
        sha: head.sha,
        version: typeof headVersion === 'string' ? headVersion : null,
        date: head.commit?.committer?.date ?? head.commit?.author?.date ?? null,
        message: String(head.commit?.message ?? '').split('\n')[0].slice(0, 200),
        url: head.html_url ?? `https://github.com/${REPO}/commit/${head.sha}`,
      },
      recent,
      compared,
    };
    put('last', last);
    const st = standingOf(commit, last, branch);
    const detail = `${branch} is at ${short(head.sha)}${last.head.version ? ` (${last.head.version})` : ''}; this build ${short(commit) ?? '(unknown)'} is ${st.state}${st.behind_by ? ` by ${st.behind_by}` : ''}`;
    if (by === 'daily') sysLog('update.check', branch, detail); else log('update.check', branch, detail);
    return { ok: true, standing: st };
  }

  /** The daily check: only while checking is on, at most once a day per board. */
  async function tick(nowMs = Date.now()) {
    const { check: on, dev } = settings();
    if (!on) return null;
    const last = get('last', null);
    const branch = branchOf(dev);
    const okAt = last?.branch === branch && last.at ? Date.parse(last.at) : 0;
    const triedAt = last?.branch === branch && last.tried_at ? Date.parse(last.tried_at) : 0;
    if (nowMs - okAt < DAY_MS) return null;
    if (triedAt > okAt && nowMs - triedAt < RETRY_AFTER_FAILURE_MS) return null;
    return check({ by: 'daily', nowMs });
  }

  /* ───────── the update ───────── */

  const getRun = () => get('run', null);
  const putRun = (run) => { put('run', { ...run, updated_at: new Date().toISOString() }); };
  const stepOf = (run, step) => run.steps.find((s) => s.step === step);
  function addStep(run, step, state, detail = null) {
    const at = new Date().toISOString();
    const s = stepOf(run, step);
    if (s) Object.assign(s, { state, detail: detail ?? s.detail, at });
    else run.steps.push({ step, state, detail, at });
    run.step = step;
  }
  function finish(run, state, error = null) {
    run.state = state;
    run.error = error;
    run.ended_at = new Date().toISOString();
    putRun(run);
    sysLog(`update.${state}`, short(run.commit), error ?? `server, host and plugin are on ${short(run.commit)}`);
  }

  /**
   * A run nobody is talking about is over. The host emits at every step, and
   * the longest step (the image build) is minutes, so twenty silent minutes
   * means the host is gone or wedged — said as that, with the last step.
   */
  function settleRun(nowMs = Date.now()) {
    const run = getRun();
    if (!runActive(run)) return run;
    const quiet = nowMs - Date.parse(run.updated_at ?? run.started_at);
    if (quiet > RUN_SILENT_MS) {
      const last = run.steps.at(-1);
      const span = quiet < 120_000 ? `${Math.round(quiet / 1000)} seconds` : `${Math.round(quiet / 60_000)} minutes`;
      finish(run, 'failed', `No word from the host on ${run.host_name} for ${span}${last ? `; the last step it reported was "${last.step}" (${last.state})` : '; it never picked the update up'}.`);
      return getRun();
    }
    return run;
  }

  // A server that starts as the build a run asked for is the server step's
  // proof, whatever the host managed to say before the old one went away.
  {
    const run = getRun();
    const was = stepOf(run ?? { steps: [] }, 'server')?.state;
    // Only a step not yet said, or said to be running: a finish skips the
    // server step, and that word must not be overwritten with "done".
    if (runActive(run) && commit && run.commit === commit && (!was || was === 'running')) {
      addStep(run, 'server', 'done', `the board answers as ${short(commit)}`);
      run.state = 'running';
      putRun(run);
    }
  }

  function start({ commit: wanted, nowMs = Date.now() }) {
    const { check: _on, dev } = settings();
    const branch = branchOf(dev);
    const last = get('last', null);
    const standing = standingOf(commit, last, branch);
    const { host, report } = updater(nowMs);
    const run = settleRun(nowMs);
    // Finish the update: the stopped run's own commit, which the board is
    // already on. The steps are the same; the host skips the rebuild when the
    // board already answers as the commit, and compares plugin/ from where
    // the update started rather than from the clone, which is at the commit.
    const stopped = stoppedOf(run, commit);
    const finishing = !!stopped && wanted === stopped.commit;
    const refusal = refusalOf({ check: last, standing, branch, self, host, report: report ?? {}, run, finishing });
    if (refusal) return { ok: false, error: refusal };
    if (!finishing && wanted !== last.head.sha) return { ok: false, error: `${short(wanted) ?? 'That commit'} is not the newest commit on ${branch} as last checked (${short(last.head.sha)}). Check again.` };
    const next = {
      id: `${nowMs.toString(36)}-${short(wanted)}`,
      commit: wanted,
      version: finishing ? stopped.version : last.head.version,
      branch,
      from: finishing ? stopped.from : commit,
      finishing,
      from_version: version,
      host_id: host.host_id,
      host_name: host.name,
      state: 'queued',
      step: null,
      steps: [],
      error: null,
      started_at: new Date(nowMs).toISOString(),
      ended_at: null,
    };
    putRun(next);
    store.enqueueHostWork(host.host_id, '*', '*', 'update', {
      run_id: next.id, commit: wanted, branch, from: next.from, repo: REPO, finish: finishing,
    });
    log('update.start', short(wanted), finishing
      ? `finishing the update to ${short(wanted)} that stopped at "${stopped.step}", by the host on ${host.name}`
      : `${short(commit) ?? '?'} → ${short(wanted)} on ${branch}${last.head.version ? ` (${last.head.version})` : ''}, by the host on ${host.name}`);
    return { ok: true, run: getRun() };
  }

  const STEPS = new Set(['preflight', 'fetch', 'checkout', 'server', 'plugin', 'host']);
  const STEP_STATES = new Set(['running', 'done', 'skipped', 'failed', 'refused']);
  const text = (v, max = 600) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

  /** A step reported by the host carrying out a run. Anything else is dropped. */
  function applyEvent(hostId, ev) {
    const run = getRun();
    if (!run || run.id !== ev.run_id || run.host_id !== hostId) return false;
    if (!runActive(run)) return false;
    const step = text(ev.step);
    const state = text(ev.state);
    if (!STEPS.has(step) || !STEP_STATES.has(state)) return false;
    addStep(run, step, state, text(ev.detail));
    if (state === 'failed' || state === 'refused') {
      finish(run, state, `${step}: ${text(ev.detail) ?? state}`);
      return true;
    }
    run.state = 'running';
    putRun(run);
    return true;
  }

  /**
   * What a host says about itself on each registration. A host that comes back
   * as the build a run asked for, after that run reached its restart, is the
   * last step done.
   */
  function noteHost(hostId, body) {
    const clone = body?.clone && typeof body.clone === 'object' ? body.clone : null;
    const report = {
      at: new Date().toISOString(),
      build: { version: text(body?.build?.version, 40), commit: text(body?.build?.commit, 40) },
      board_container: text(body?.board_container, 80),
      supervised: body?.supervised === true,
      clone: clone ? {
        path: text(clone.path, 400),
        branch: text(clone.branch, 200),
        head: text(clone.head, 40),
        dirty: clone.dirty === true,
        changes: Array.isArray(clone.changes) ? clone.changes.slice(0, 20).map((c) => text(String(c), 200)).filter(Boolean) : [],
        error: text(clone.error),
      } : null,
    };
    reports.set(hostId, report);
    const run = getRun();
    if (runActive(run) && run.host_id === hostId && report.build.commit === run.commit && stepOf(run, 'host')) {
      addStep(run, 'host', 'done', `the host is back as ${short(run.commit)}`);
      finish(run, 'done');
      return;
    }
    // A run that gave up waiting on its host after the restart (settleRun),
    // whose host then does come back as the commit: every step before it was
    // done, so the update is too, late. Not a run that stopped earlier — a
    // failed plugin step leaves the host on its old build, which this never sees.
    const late = stoppedOf(run, commit);
    if (late && late.host_id === hostId && report.build.commit === late.commit && stepOf(late, 'host')?.state === 'running') {
      addStep(late, 'host', 'done', `the host came back as ${short(late.commit)} after the run had given up on it`);
      finish(late, 'done');
    }
  }

  /** Everything the page draws, on every /api/state. */
  function view(nowMs = Date.now()) {
    const s = settings();
    const branch = branchOf(s.dev);
    const last = get('last', null);
    const shown = last?.branch === branch ? last : null;
    const standing = standingOf(commit, last, branch);
    const run = settleRun(nowMs);
    const { host, report } = updater(nowMs);
    const stopped = stoppedOf(run, commit);
    const contact = get('contact', {});
    // What the update would interrupt, for the confirmation to name.
    const hosted = host ? store.listHostedDesks().filter((d) => d.host_id === host.host_id && d.state !== 'offline') : [];
    return {
      check: s.check,
      dev: s.dev,
      branch,
      repo: REPO,
      current: { version, commit, container },
      latest: shown?.head ?? null,
      checked_at: shown?.at ?? null,
      tried_at: shown?.tried_at ?? null,
      error: shown?.error ?? null,
      standing,
      next_check_at: contact.at ? new Date(contact.at + MIN_GAP_MS).toISOString() : null,
      limit_until: contact.reset_at && contact.reset_at > nowMs ? new Date(contact.reset_at).toISOString() : null,
      // Only while checking is on (issue item 5): off, the header shows nothing,
      // even about a check pressed by hand.
      available: s.check && isNewer(standing),
      // A run that stopped past the rebuild (stoppedOf): shown until a run
      // finishes it, and its refusal is Finish the update's, not the offer's.
      stopped,
      refusal: refusalOf({ check: last, standing, branch, self, host, report: report ?? {}, run, finishing: !!stopped }),
      host: host ? {
        name: host.name,
        build: report.build,
        clone: report.clone,
        supervised: report.supervised,
      } : null,
      interrupts: {
        sessions: Object.keys(sessions ?? {}).length,
        windows: hosted.filter((d) => d.window_id).map((d) => `${d.channel}/${d.agent}`),
      },
      run,
    };
  }

  /* ───────── routes (operator writes; the view rides on /api/state) ───────── */

  function router(auth) {
    const r = express.Router();
    r.use(auth.adminGuard);
    r.post('/settings', async (req, res) => {
      const before = settings();
      const changed = [];
      for (const k of ['check', 'dev']) {
        if (req.body?.[k] === undefined) continue;
        if (typeof req.body[k] !== 'boolean') return res.status(400).json({ error: `${k} must be true or false` });
        if (req.body[k] !== before[k]) { put(k, req.body[k]); changed.push(k); }
      }
      for (const k of changed) {
        const on = settings()[k];
        log('update.settings', k, k === 'check'
          ? (on ? 'checking for updates turned on' : 'checking for updates turned off — no contact with GitHub except Check now')
          : (on ? 'following develop' : 'following main'));
      }
      // A new branch has not been checked. Checked now, when checking is on,
      // rather than leaving "nothing checked" until tomorrow's tick.
      if (changed.includes('dev') && settings().check) await check({ by: 'operator' });
      res.json({ ok: true, update: view() });
    });
    r.post('/check', async (_req, res) => {
      const result = await check({ by: 'operator' });
      res.json({ ...result, update: view() });
    });
    r.post('/start', (req, res) => {
      const wanted = text(req.body?.commit, 40);
      if (!wanted) return res.status(400).json({ error: 'commit is required' });
      const out = start({ commit: wanted });
      res.status(out.ok ? 200 : 409).json({ ...out, update: view() });
    });
    return r;
  }

  let timer = null;
  /**
   * The daily check runs only for a board in a container — the only kind a
   * host can update. A board run bare is a developer's (`npm start`) or a
   * suite's, and every suite starts a server or several: each would spend
   * the operator's sixty requests an hour from his own address, and make the
   * suites depend on reaching GitHub. Check now works on any board.
   */
  function startTimer() {
    if (!container) return false;
    const go = () => tick().catch((err) => console.warn(`[orchestratinator] update check: ${err.message}`));
    // Soon after start, then on the tick. Due only once a day, so a rebuild
    // does not mean a check; the first look just catches a board that was off.
    setTimeout(go, Math.min(TICK_MS, 30_000)).unref();
    timer = setInterval(go, TICK_MS);
    timer.unref();
    return true;
  }

  return { self, check, tick, start, applyEvent, noteHost, view, router, startTimer, settings, reports };
}

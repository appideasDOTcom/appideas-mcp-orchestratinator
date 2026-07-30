/* orchestratinator dashboard — polls /api/state and /api/activity. */
'use strict';

const REFRESH_MS = 2500;
const PAGE = 200;

const $ = (id) => document.getElementById(id);
const el = {
  dot: $('live-dot'),
  version: $('version'),
  meta: $('server-meta'),
  totals: $('totals'),
  channels: $('channels'),
  logBody: $('log-body'),
  logScroll: $('log-scroll'),
  logCount: $('log-count'),
  filterChannel: $('filter-channel'),
  filterKinds: $('filter-kinds'),
  filterText: $('filter-text'),
  loadMore: $('load-more'),
  autorefresh: $('autorefresh'),
  refreshNow: $('refresh-now'),
  adminState: $('admin-state'),
  dlg: $('dlg'),
  dlgBody: $('dlg-body'),
};

const ui = {
  limit: PAGE,
  kinds: new Set(['message', 'task', 'contract', 'admin']),
  text: '',
  channel: '',
  expanded: new Set(),
  lastLogSig: null,
  lastChannelSig: null,
  hasMore: false,
  showRetired: false,
  showArchived: false,
  // Operator actions are locked until GET /api/admin/token hands us one, which
  // it only does for a browser holding the shared secret.
  admin: { token: null, locked: true },
  state: null,   // the most recent /api/state, so a dialog can read live counts
};

/* ---------- formatting ---------- */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function relTime(iso) {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const absTime = (iso) => (iso ? new Date(iso).toLocaleString() : 'never');

function duration(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Message bodies and contract values arrive JSON-encoded; show them readably. */
function decode(raw) {
  if (raw == null || raw === '') return '';
  try {
    const v = JSON.parse(raw);
    if (typeof v === 'string') return v;
    if (v === null) return '';
    return JSON.stringify(v);
  } catch {
    return String(raw); // truncated by the server, or never was JSON
  }
}

function pretty(raw) {
  if (raw == null || raw === '') return '';
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return String(raw); }
}

const clip = (s, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);

/* ---------- channels & agents ---------- */

const TONE_CLASS = { busy: 'busy', waiting: 'waiting', blocked: 'blocked', idle: 'idle' };
const PRESENCE_DOT = { connected: '', recent: 'stale', offline: 'down' };

/** A timestamp that re-renders itself on every tick, so an age can never go stale on screen. */
const age = (iso) => `<span class="age" data-age-ts="${esc(iso ?? '')}">${relTime(iso)}</span>`;

/** Rewrite every live age in place — the cheap half of a render, safe to run on every tick. */
function refreshAges(root) {
  for (const node of root.querySelectorAll('[data-age-ts]')) node.textContent = relTime(node.dataset.ageTs);
}

/** An operator affordance: a real button when unlocked, plain text when not. */
function actionable(label, act, data, title) {
  const attrs = Object.entries(data).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ');
  if (ui.admin.locked) return `<span title="${esc(title)}">${esc(label)}</span>`;
  return `<button type="button" class="mini" data-act="${esc(act)}" ${attrs} title="${esc(title)}">${esc(label)}</button>`;
}

function agentSub(a, channel) {
  const bits = [];
  // The detail line is the whole point of a self-reported status — lead with it.
  if (a.state.detail) bits.push(`<span class="state-detail">${esc(a.state.detail)}</span>`);
  if (a.last_action) bits.push(`${esc(a.last_action)} · ${age(a.last_action_at)}`);
  else bits.push(`seen ${age(a.last_seen)}`);
  if (a.unread) {
    bits.push(actionable(
      `${a.unread} unread`,
      'unread',
      { channel, agent: a.agent },
      `nudge ${a.agent}, or mark the backlog read on its behalf`
    ));
  }
  if (a.assigned_open) {
    bits.push(actionable(
      `${a.assigned_open} assigned`,
      'tasks',
      { channel, agent: a.agent },
      `close or reassign ${a.agent}'s open tasks`
    ));
  }
  return bits.join('  ·  ');
}

/**
 * The state chip. A self-reported state carries its age so a wrong one is
 * self-evident: "waiting · 40m ago" reads as suspect in a way "waiting" cannot.
 */
function stateChip(a) {
  const tone = a.presence === 'offline' ? 'off' : (TONE_CLASS[a.state.tone] ?? 'idle');
  if (a.state.source !== 'reported') {
    return `<span class="state ${tone}" title="derived from the task board — ${esc(a.agent)} has not reported a status">${esc(a.state.label)}</span>`;
  }
  const title = `self-reported at ${absTime(a.reported_at)}` +
    (a.reported_expires_at ? ` · believed until ${absTime(a.reported_expires_at)}` : '');
  return `<span class="state ${tone}" title="${esc(title)}">${esc(a.state.label)} · ${age(a.reported_at)}</span>`;
}

/** One agent row. `retired` rows get a restore button instead of a trash can. */
function agentRow(c, a) {
  const at = `data-channel="${esc(c.channel)}" data-agent="${esc(a.agent)}"`;
  // Nudge sits on every live row, not just rows with unread: the agent worth
  // poking is usually the quiet one with an empty backlog.
  const acts = ui.admin.locked ? '' : a.retired
    ? `<button type="button" class="row-act" data-act="unretire" ${at} title="Put ${esc(a.agent)} back on the board">↩</button>`
    : `<button type="button" class="row-act" data-act="nudge" ${at} title="Nudge ${esc(a.agent)} — ask it to check in and respond">👋</button>
       <button type="button" class="row-act" data-act="retire" ${at} title="Clear ${esc(a.agent)}'s backlog and take it off the board">🗑</button>`;
  const trash = acts ? `<div class="row-acts">${acts}</div>` : '';
  return `
            <div class="agent${a.retired ? ' retired' : ''}">
              <span class="dot ${PRESENCE_DOT[a.presence]}" title="${esc(a.presence)} · last seen ${esc(absTime(a.last_seen))}"></span>
              <div>
                <div class="agent-line">
                  <span class="agent-name">${esc(a.agent)}</span>
                  <span class="presence" title="${a.sessions} live MCP session${a.sessions === 1 ? '' : 's'}">${esc(a.presence)}${a.sessions > 1 ? ` ×${a.sessions}` : ''}</span>
                  ${a.retired ? `<span class="state off" title="retired by the operator ${esc(absTime(a.retired_at))} — it returns by itself if it calls a tool">retired</span>` : stateChip(a)}
                </div>
                <div class="agent-sub">${agentSub(a, c.channel)}</div>
              </div>
              ${trash}
            </div>`;
}

function renderChannels(state) {
  const sig = JSON.stringify(state.channels) + JSON.stringify(state.totals) +
    `|${ui.admin.locked}|${ui.showRetired}|${ui.showArchived}`;
  if (sig === ui.lastChannelSig) {
    // Same data — but the ages still have to keep counting up.
    refreshAges(el.channels);
    return;
  }
  ui.lastChannelSig = sig;

  const t = state.totals;
  el.totals.textContent =
    `${t.channels} channel${t.channels === 1 ? '' : 's'} · ${t.agents} agent${t.agents === 1 ? '' : 's'} · ` +
    `${t.connected} connected · ${t.open_tasks} open / ${t.claimed_tasks} claimed`;

  if (!state.channels.length) {
    el.channels.innerHTML = '<div class="empty">No channels yet. Connect an agent with an <code>X-Channel</code> header and it will show up here.</div>';
    return;
  }

  const shown = state.channels.filter((c) => ui.showArchived || !c.archived);
  // Archived channels and retired agents are never dropped silently — the count
  // is always on screen, even when the rows aren't.
  const bar = t.archived_channels
    ? `<div class="reveal-bar">
         <button type="button" class="chip${ui.showArchived ? ' on' : ''}" data-act="toggle-archived">
           ${t.archived_channels} archived channel${t.archived_channels === 1 ? '' : 's'}
         </button>
       </div>`
    : '';

  el.channels.innerHTML = bar + shown.map((c) => {
    const retired = c.retired_agents ?? [];
    const rows = c.agents.map((a) => agentRow(c, a)).join('');
    const retiredRows = ui.showRetired ? retired.map((a) => agentRow(c, a)).join('') : '';
    const agents = rows || retiredRows
      ? rows + retiredRows
      : '<div class="empty">no agents seen yet</div>';
    const retiredChip = retired.length
      ? `<button type="button" class="chip tiny${ui.showRetired ? ' on' : ''}" data-act="toggle-retired" title="agents the operator took off this board">
           ${retired.length} retired
         </button>`
      : '';
    const openCount = c.tasks.open + c.tasks.claimed;
    const tasksCell = openCount && !ui.admin.locked
      ? `<button type="button" class="mini" data-act="tasks" data-channel="${esc(c.channel)}" title="close or reassign unfinished tasks"><b>${c.tasks.open}</b> open · <b>${c.tasks.claimed}</b> claimed</button>`
      : `<b>${c.tasks.open}</b> open · <b>${c.tasks.claimed}</b> claimed`;

    return `
      <div class="channel${c.archived ? ' archived' : ''}">
        <div class="channel-head">
          <span class="channel-name">${esc(c.channel)}</span>
          ${c.archived ? `<span class="state off" title="archived ${esc(absTime(c.archived_at))} — nothing was deleted">archived</span>` : ''}
          ${retiredChip}
          <span class="channel-stats">
            ${tasksCell} · <b>${c.tasks.done}</b> done ·
            <b>${c.contracts}</b> contracts · <b>${c.messages}</b> msgs
          </span>
          ${ui.admin.locked ? '' : `<button type="button" class="row-act" data-act="channel" data-channel="${esc(c.channel)}" title="Archive or delete this channel">🗑</button>`}
        </div>
        ${agents}
      </div>`;
  }).join('');
}

function renderServer(state) {
  const s = state.server;
  el.version.textContent = `v${s.version}`;
  el.meta.textContent = `up ${duration(s.uptime_seconds)} · port ${s.port} · db ${s.db_path} · claim ttl ${s.claim_ttl_minutes}m · ${s.now.replace('T', ' ').slice(0, 19)}Z`;
  // Connection churn is a client trait, not a coordination fact — keep it out of
  // the way, but reachable when a session count looks surprising.
  const st = s.session_stats ?? {};
  el.meta.title =
    `${state.totals.live_sessions} live session(s) · session ttl ${s.session_ttl_minutes}m\n` +
    `since start: ${st.opened ?? 0} opened, ${st.superseded ?? 0} superseded, ${st.expired ?? 0} expired`;
}

function syncChannelFilter(state) {
  const names = state.channels.map((c) => c.channel);
  const current = [...el.filterChannel.options].slice(1).map((o) => o.value);
  if (JSON.stringify(names) === JSON.stringify(current)) return;
  const selected = el.filterChannel.value;
  el.filterChannel.innerHTML =
    '<option value="">all channels</option>' + names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  el.filterChannel.value = names.includes(selected) ? selected : '';
}

/* ---------- activity log ---------- */

const KIND_LABEL = {
  'message': ['message', 'message'],
  'task.opened': ['task opened', 'opened'],
  'task.open': ['task reopened', 'opened'],
  'task.claimed': ['task claimed', 'claimed'],
  'task.done': ['task done', 'done'],
  'contract.set': ['contract set', 'contract'],
  // Operator actions. These share one badge tone: what matters when you're
  // scanning the log is that a human reached in, not which button they pressed.
  'admin.advance': ['marked read', 'admin'],
  'admin.nudge': ['nudged', 'admin'],
  'admin.retire': ['agent retired', 'admin'],
  'admin.unretire': ['agent restored', 'admin'],
  'admin.task.close': ['task closed', 'admin'],
  'admin.task.reassign': ['task reassigned', 'admin'],
  'admin.channel.archive': ['channel archived', 'admin'],
  'admin.channel.unarchive': ['channel restored', 'admin'],
  'admin.channel.delete': ['channel deleted', 'admin'],
};

/** Turn one feed row into the "who" and "what" cells. */
function describe(r) {
  const detail = decode(r.detail);
  if (r.kind === 'message') {
    const who = `${esc(r.actor)}<span class="arrow">→</span>${r.target ? esc(r.target) : '<span class="muted">all</span>'}`;
    return { who, what: `<span class="detail">${esc(clip(detail))}</span>`, raw: r.detail };
  }
  if (r.kind.startsWith('admin.')) {
    const who = `${esc(r.actor ?? 'operator')}${r.target ? `<span class="arrow">→</span>${esc(r.target)}` : ''}`;
    return { who, what: `<span class="detail">${esc(clip(detail))}</span>`, raw: r.detail };
  }
  if (r.kind === 'contract.set') {
    const who = esc(r.actor ?? '—');
    const what =
      `<span class="title">${esc(r.title)}</span> <span class="ref">v${r.version}</span> ` +
      `<span class="detail">= ${esc(clip(detail))}</span>`;
    return { who, what, raw: r.detail };
  }
  // task.*
  const who = r.target && r.kind === 'task.opened'
    ? `${esc(r.actor ?? '—')}<span class="arrow">→</span>${esc(r.target)}`
    : esc(r.actor ?? '—');
  const what =
    `<span class="ref">#${r.ref_id}</span> <span class="title">${esc(r.title)}</span>` +
    (detail ? ` <span class="detail">— ${esc(clip(detail))}</span>` : '');
  return { who, what, raw: r.detail };
}

function passesFilters(r) {
  if (!ui.kinds.has(r.kind.split('.')[0])) return false;
  if (ui.text) {
    const hay = `${r.kind} ${r.channel} ${r.actor ?? ''} ${r.target ?? ''} ${r.title ?? ''} ${r.detail ?? ''}`.toLowerCase();
    if (!hay.includes(ui.text)) return false;
  }
  return true;
}

function renderLog(rows) {
  const visible = rows.filter(passesFilters);
  // Re-render only when the data actually changed. Every mutation moves a row's
  // ts (or adds/removes one), so identity + timestamp is enough to notice.
  const sig = `${ui.text}|${ui.channel}|${[...ui.kinds].sort()}|${[...ui.expanded].sort()}|` +
    visible.map((r) => `${r.kind}${r.ref_id}${r.ts}`).join(',');
  if (sig === ui.lastLogSig) {
    // Same data — just keep the relative timestamps honest.
    for (const td of el.logBody.querySelectorAll('td.when')) td.firstChild.textContent = relTime(td.dataset.ts);
    return;
  }
  ui.lastLogSig = sig;

  el.logCount.textContent = `${visible.length} of ${rows.length} loaded`;
  el.loadMore.parentElement.classList.toggle('hidden', !ui.hasMore);

  if (!visible.length) {
    el.logBody.innerHTML = '<tr><td colspan="5" class="empty">Nothing logged yet.</td></tr>';
    return;
  }

  const top = el.logScroll.scrollTop;
  el.logBody.innerHTML = visible.map((r) => {
    const [label, cls] = KIND_LABEL[r.kind] ?? [r.kind, ''];
    const { who, what, raw } = describe(r);
    const key = `${r.kind}:${r.channel}:${r.ref_id}`;
    const open = ui.expanded.has(key);
    const expandable = raw && raw.length > 0;
    return `
      <tr data-key="${esc(key)}" class="${expandable ? 'expand' : ''}">
        <td class="when" data-ts="${esc(r.ts)}" title="${esc(absTime(r.ts))}">${relTime(r.ts)}</td>
        <td class="chan">${esc(r.channel)}</td>
        <td><span class="badge ${cls}">${esc(label)}</span></td>
        <td class="who">${who}</td>
        <td class="what">${what}${open ? `<pre class="raw">${esc(pretty(raw))}</pre>` : ''}</td>
      </tr>`;
  }).join('');
  el.logScroll.scrollTop = top;
}

/* ---------- operator actions ---------- */

/**
 * Ask for the per-process admin token. A 401 here isn't an error state — it's the
 * normal condition for a browser that hasn't presented the shared secret, and it
 * simply leaves every affordance rendered as plain text.
 */
async function loadAdminToken() {
  try {
    const res = await fetch('./api/admin/token');
    const json = await res.json().catch(() => ({}));
    ui.admin.token = res.ok ? json.token ?? null : null;
  } catch {
    ui.admin.token = null;
  }
  ui.admin.locked = !ui.admin.token;
  el.adminState.textContent = ui.admin.locked ? 'read-only · open as /?key=… to enable operator actions' : '';
  el.adminState.classList.toggle('hidden', !ui.admin.locked);
  ui.lastChannelSig = null;   // affordances appear/disappear with this flag
}

async function admin(path, body) {
  const res = await fetch(`./api/admin/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-orch-admin-token': ui.admin.token ?? '' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

const findChannel = (name) => (ui.state?.channels ?? []).find((c) => c.channel === name) ?? null;
const findAgent = (channel, agent) => {
  const c = findChannel(channel);
  if (!c) return null;
  return [...(c.agents ?? []), ...(c.retired_agents ?? [])].find((a) => a.agent === agent) ?? null;
};

function openDialog(html) {
  el.dlgBody.innerHTML = html;
  // The error belongs with the thing that failed, above the buttons — appended at
  // the end it lands under "Cancel", where it reads as unrelated.
  const err = document.createElement('div');
  err.className = 'dlg-err';
  err.hidden = true;
  const foot = el.dlgBody.querySelector('.dlg-foot');
  if (foot) el.dlgBody.insertBefore(err, foot);
  else el.dlgBody.append(err);
  if (!el.dlg.open) el.dlg.showModal();
}
function closeDialog() {
  if (el.dlg.open) el.dlg.close();
  el.dlgBody.innerHTML = '';
}

/** Somewhere to put a word from an action with no dialog left behind it. */
let notifyTimer = null;
function notify(message, { error = true } = {}) {
  clearTimeout(notifyTimer);
  el.adminState.textContent = message;
  el.adminState.classList.toggle('err', error);
  el.adminState.classList.remove('hidden');
  notifyTimer = setTimeout(() => {
    el.adminState.classList.remove('err');
    el.adminState.textContent = ui.admin.locked ? 'read-only · open as /?key=… to enable operator actions' : '';
    el.adminState.classList.toggle('hidden', !ui.admin.locked);
  }, 6000);
}

/**
 * Run one operator action: lock the dialog while it's in flight, surface the
 * server's own error message rather than a generic one, and refresh the board on
 * success so the result shows immediately instead of up to a poll interval later.
 * Returns whether it succeeded, so a caller keeping the dialog open knows whether
 * it's safe to re-render over the error message.
 */
async function act(fn, { keepOpen = false } = {}) {
  const scoped = el.dlg.open;
  const toggle = (disabled) => el.dlgBody.querySelectorAll('button, select, input').forEach((b) => { b.disabled = disabled; });
  if (scoped) toggle(true);
  try {
    await fn();
  } catch (e) {
    const err = scoped ? el.dlgBody.querySelector('.dlg-err') : null;
    if (err) { err.textContent = String(e.message ?? e); err.hidden = false; }
    else notify(String(e.message ?? e));
    if (scoped) toggle(false);
    return false;
  }
  if (!keepOpen) closeDialog();
  await tick();
  if (keepOpen && scoped) toggle(false);
  return true;
}

/**
 * Send one nudge and say so, since the dialog closes behind it.
 *
 * Anything typed in the box wins over the template — but only for the plain
 * nudge. "Catch up quietly" has wording of its own, and quietly swapping a
 * half-finished sentence in for it would send something you didn't mean.
 */
async function sendNudge(d) {
  const typed = el.dlgBody.querySelector('#nudge-text')?.value.trim();
  const body = { channel: d.channel, agent: d.agent, style: d.style ?? 'normal' };
  if (typed && body.style === 'normal') body.text = typed;
  let ahead = 0;
  const ok = await act(async () => { ahead = (await admin('agent/nudge', body)).queued_behind_unread ?? 0; });
  // How far back in the queue it landed is the one thing worth saying out loud: a
  // nudge behind 40 unread messages is not the prompt reply you were expecting.
  if (ok) {
    notify(
      `nudged ${d.agent}` + (ahead ? ` · behind ${ahead} unread message${ahead === 1 ? '' : 's'}` : ''),
      { error: false }
    );
  }
}

/**
 * Nudge an agent, and — when it has a backlog — deal with that backlog.
 *
 * Reached from the agent row's 👋 and from the unread count, so the same dialog
 * serves both "say something to this agent" and "clean up after it". Nudge is
 * first and primary because it's the one you press to avoid typing into another
 * window; the backlog options only appear when there is a backlog to answer for.
 */
function nudgeDialog(channel, agent) {
  const a = findAgent(channel, agent);
  if (!a) return;
  const upTo = a.unread_max_id ?? 0;
  const at = `data-channel="${esc(channel)}" data-agent="${esc(agent)}"`;
  const n = (count) => (count === 1 ? '' : 's');
  const backlog = a.unread > 0
    ? `
    <div class="dlg-choice">
      <button type="button" class="btn" data-do="nudge" data-style="quiet" ${at}>Catch up quietly</button>
      <p>Same delivery, quieter instruction: skim the ${a.unread} message${n(a.unread)}, act only on what is urgent or addressed directly to it, and reply only if a reply is genuinely needed.</p>
    </div>
    <div class="dlg-choice">
      <button type="button" class="btn" data-do="advance" data-up-to="${upTo}" ${at}>Mark read (operator)</button>
      <p>Moves the cursor to #${upTo}. ${esc(agent)} never sees these ${a.unread} message${n(a.unread)}, and the board stops counting them.</p>
    </div>`
    : '';
  openDialog(`
    <h3>${esc(agent)}${a.unread ? ` · ${a.unread} unread` : ''}</h3>
    <p class="dlg-sub">
      on <span class="mono">${esc(channel)}</span> · ${esc(a.presence)}${a.sessions ? ` · ${a.sessions} live session${n(a.sessions)}` : ''} · seen ${age(a.last_seen)}
    </p>
    <div class="dlg-choice">
      <button type="button" class="btn primary" data-do="nudge" data-style="normal" ${at}>Nudge</button>
      <div>
        <p>Sends what you would have typed in ${esc(agent)}'s own window: poll your messages, look at the board, handle what's yours, respond normally. Or type your own words below.</p>
        <input class="input dlg-say" id="nudge-text" type="text" autocomplete="off" placeholder="optional — your own message to ${esc(agent)}, then Enter">
      </div>
    </div>${backlog}
    <p class="dlg-note">A nudge is a queued message, delivered on ${esc(agent)}'s next poll — MCP gives the server no way to wake a window that has stopped asking. An agent running <span class="mono">/loop</span> picks it up within one loop interval; one sitting idle at a prompt will not.</p>
    <div class="dlg-foot"><button type="button" class="btn" data-do="cancel">Cancel</button></div>
  `);
  el.dlgBody.querySelector('#nudge-text')?.focus();
}

function retireDialog(channel, agent) {
  const a = findAgent(channel, agent);
  if (!a) return;
  openDialog(`
    <h3>Remove ${esc(agent)} from the board?</h3>
    <p class="dlg-sub">on <span class="mono">${esc(channel)}</span></p>
    <ul class="dlg-list">
      <li>marks its ${a.unread} unread message${a.unread === 1 ? '' : 's'} read</li>
      <li>closes its ${a.sessions} live MCP session${a.sessions === 1 ? '' : 's'}</li>
      <li>hides the row behind a “retired” chip — nothing is deleted</li>
    </ul>
    <p class="dlg-note">If that agent is still alive it will reconnect, un-retire itself and reappear. Only a window that is really gone stays gone.</p>
    <div class="dlg-foot">
      <button type="button" class="btn" data-do="cancel">Cancel</button>
      <button type="button" class="btn primary" data-do="retire" data-channel="${esc(channel)}" data-agent="${esc(agent)}">Remove</button>
    </div>
  `);
}

function taskDialog(channel, agent) {
  const c = findChannel(channel);
  if (!c) return;
  // Remembered so an action that keeps the dialog open can rebuild it against
  // the refreshed state instead of leaving a stale row on screen.
  ui.dlgCtx = { channel, agent: agent ?? null };
  const all = c.task_list ?? [];
  const list = agent ? all.filter((t) => t.assignee === agent || t.claimed_by === agent) : all;
  const names = (c.agents ?? []).map((a) => a.agent);
  const rows = list.length ? list.map((t) => `
    <div class="task-row">
      <div>
        <span class="ref">#${t.id}</span> <span class="title">${esc(t.title)}</span>
        <span class="badge ${t.status === 'claimed' ? 'claimed' : 'opened'}">${esc(t.status)}</span>
        <div class="muted mono tiny">${t.claimed_by ? `claimed by ${esc(t.claimed_by)}` : t.assignee ? `assigned to ${esc(t.assignee)}` : 'unassigned'} · ${age(t.updated_at)}</div>
      </div>
      <div class="task-acts">
        <select class="input" data-reassign="${t.id}" title="reassign">
          <!-- "no assignee" rather than "unassigned": a claimed task has no
               assignee but is very much someone's, and the row says who. -->
          <option value="">— no assignee —</option>
          ${names.map((n) => `<option value="${esc(n)}"${t.assignee === n ? ' selected' : ''}>${esc(n)}</option>`).join('')}
        </select>
        <button type="button" class="btn" data-do="close-task" data-channel="${esc(channel)}" data-id="${t.id}">close</button>
      </div>
    </div>`).join('') : '<div class="empty">nothing unfinished here</div>';

  openDialog(`
    <h3>Unfinished tasks${agent ? ` · ${esc(agent)}` : ''}</h3>
    <p class="dlg-sub">on <span class="mono">${esc(channel)}</span>${c.task_list_total > all.length ? ` · showing ${all.length} of ${c.task_list_total}` : ''}</p>
    <div class="task-list">${rows}</div>
    <p class="dlg-note">Closing marks the task done with a note attributed to <span class="mono">operator</span> — it is not deleted, and the log keeps the record. Changing the dropdown reassigns immediately.</p>
    <div class="dlg-foot"><button type="button" class="btn" data-do="cancel">Done</button></div>
  `);
}

function channelDialog(channel) {
  const c = findChannel(channel);
  if (!c) return;
  const agents = (c.agents?.length ?? 0) + (c.retired_agents?.length ?? 0);
  openDialog(`
    <h3>${esc(channel)}</h3>
    <p class="dlg-sub">${agents} agent${agents === 1 ? '' : 's'} · ${c.messages} message${c.messages === 1 ? '' : 's'} · ${c.contracts} contract${c.contracts === 1 ? '' : 's'} · ${c.tasks.open + c.tasks.claimed} unfinished task${c.tasks.open + c.tasks.claimed === 1 ? '' : 's'}</p>
    <div class="dlg-choice">
      <button type="button" class="btn primary" data-do="${c.archived ? 'unarchive' : 'archive'}" data-channel="${esc(channel)}">${c.archived ? 'Restore' : 'Archive'}</button>
      <p>${c.archived
        ? 'Puts the channel back on the board. Nothing was lost while it was hidden — agents could keep working on it the whole time.'
        : 'Hides it from the board. Nothing is deleted and agents on it keep working; restore it any time from the “archived” chip.'}</p>
    </div>
    <div class="dlg-danger">
      <h4>Delete permanently</h4>
      <p>Destroys ${c.messages} message${c.messages === 1 ? '' : 's'}, every task, and all ${c.contracts} contract${c.contracts === 1 ? '' : 's'} with their version history. There is no undo and no backup other than the Docker volume.</p>
      <div class="dlg-confirm">
        <input class="input mono" id="confirm-name" type="text" autocomplete="off" spellcheck="false" placeholder="type the channel name">
        <button type="button" class="btn danger" data-do="delete" data-channel="${esc(channel)}">Delete</button>
      </div>
    </div>
    <div class="dlg-foot"><button type="button" class="btn" data-do="cancel">Cancel</button></div>
  `);
}

/* ---------- polling ---------- */

let inFlight = false;

async function tick({ background = false } = {}) {
  if (inFlight) return;
  if (background && document.hidden) return; // don't poll a tab nobody is looking at
  inFlight = true;
  try {
    const qs = new URLSearchParams({ limit: String(ui.limit) });
    if (ui.channel) qs.set('channel', ui.channel);
    const [state, activity] = await Promise.all([
      fetch('./api/state').then((r) => r.json()),
      fetch(`./api/activity?${qs}`).then((r) => r.json()),
    ]);
    ui.hasMore = activity.count >= ui.limit;
    ui.state = state;
    renderServer(state);
    syncChannelFilter(state);
    renderChannels(state);
    renderLog(activity.rows);
    el.dot.className = 'dot';
    el.dot.title = `connected · updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    el.dot.className = 'dot down';
    el.dot.title = `cannot reach the server: ${err}`;
  } finally {
    inFlight = false;
  }
}

/* ---------- events ---------- */

el.filterKinds.addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  const kind = btn.dataset.kind;
  if (ui.kinds.has(kind)) ui.kinds.delete(kind); else ui.kinds.add(kind);
  btn.classList.toggle('on', ui.kinds.has(kind));
  ui.lastLogSig = null;
  tick();
});

el.filterText.addEventListener('input', () => {
  ui.text = el.filterText.value.trim().toLowerCase();
  ui.lastLogSig = null;
  tick();
});

el.filterChannel.addEventListener('change', () => {
  ui.channel = el.filterChannel.value;
  ui.lastLogSig = null;
  tick();
});

el.loadMore.addEventListener('click', () => {
  ui.limit += PAGE;
  ui.lastLogSig = null;
  tick();
});

el.refreshNow.addEventListener('click', () => tick());

// Clicking a row reveals the full stored value (message body, task note,
// contract value) pretty-printed.
el.logBody.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-key]');
  if (!tr || !tr.classList.contains('expand')) return;
  const key = tr.dataset.key;
  if (ui.expanded.has(key)) ui.expanded.delete(key); else ui.expanded.add(key);
  ui.lastLogSig = null;
  tick();
});

// Channel and agent affordances. Delegated, because renderChannels replaces the
// whole grid on every change and directly-bound listeners would go with it.
el.channels.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const { channel, agent } = btn.dataset;
  const action = btn.dataset.act;

  // The reveal toggles are view state, not operator actions — they work whether
  // or not this browser can write.
  if (action === 'toggle-archived' || action === 'toggle-retired') {
    if (action === 'toggle-archived') ui.showArchived = !ui.showArchived;
    else ui.showRetired = !ui.showRetired;
    ui.lastChannelSig = null;
    tick();
    return;
  }
  if (ui.admin.locked) return;

  if (action === 'unread' || action === 'nudge') nudgeDialog(channel, agent);
  else if (action === 'tasks') taskDialog(channel, agent ?? null);
  else if (action === 'retire') retireDialog(channel, agent);
  else if (action === 'channel') channelDialog(channel);
  // Restoring is trivially reversible and self-explanatory, so it skips the
  // confirmation step the other actions get.
  else if (action === 'unretire') act(() => admin('agent/unretire', { channel, agent }));
});

el.dlgBody.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-do]');
  if (!btn) return;
  const d = btn.dataset;
  const reRender = (ok) => { if (ok && el.dlg.open && ui.dlgCtx) taskDialog(ui.dlgCtx.channel, ui.dlgCtx.agent); };

  switch (d.do) {
    case 'cancel':
      closeDialog();
      break;
    case 'advance':
      act(() => admin('agent/advance', { channel: d.channel, agent: d.agent, up_to_id: Number(d.upTo) }));
      break;
    case 'nudge':
      sendNudge(d);
      break;
    case 'retire':
      act(() => admin('agent/retire', { channel: d.channel, agent: d.agent }));
      break;
    case 'close-task':
      act(() => admin('task/close', { channel: d.channel, id: Number(d.id) }), { keepOpen: true }).then(reRender);
      break;
    case 'archive':
      act(() => admin('channel/archive', { channel: d.channel }));
      break;
    case 'unarchive':
      act(() => admin('channel/unarchive', { channel: d.channel }));
      break;
    case 'delete': {
      // Sent as typed. The server compares it too — this is a confirmation, not
      // the check itself, so a UI bug can't be what lets a channel through.
      const typed = el.dlgBody.querySelector('#confirm-name')?.value ?? '';
      act(() => admin('channel/delete', { channel: d.channel, confirm: typed.trim() }));
      break;
    }
    default:
      break;
  }
});

// Enter in the nudge box sends it. The box exists so a poke never costs more than
// a keystroke — making you reach for the mouse to finish would defeat it.
el.dlgBody.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.closest('#nudge-text')) return;
  e.preventDefault();
  const btn = el.dlgBody.querySelector('[data-do="nudge"][data-style="normal"]');
  if (btn) sendNudge(btn.dataset);
});

// Reassign applies on change rather than behind a save button: there's one field,
// and the log records every move.
el.dlgBody.addEventListener('change', (e) => {
  const sel = e.target.closest('[data-reassign]');
  if (!sel || !ui.dlgCtx) return;
  const { channel, agent } = ui.dlgCtx;
  act(
    () => admin('task/reassign', { channel, id: Number(sel.dataset.reassign), assignee: sel.value || null }),
    { keepOpen: true }
  ).then((ok) => { if (ok && el.dlg.open) taskDialog(channel, agent); });
});

// Clicking the backdrop closes. <dialog> already handles Esc.
el.dlg.addEventListener('click', (e) => { if (e.target === el.dlg) closeDialog(); });
el.dlg.addEventListener('close', () => { el.dlgBody.innerHTML = ''; });

const poll = () => tick({ background: true });
let timer = setInterval(poll, REFRESH_MS);
el.autorefresh.addEventListener('change', () => {
  clearInterval(timer);
  if (el.autorefresh.checked) { timer = setInterval(poll, REFRESH_MS); tick(); }
});
// Catch up as soon as the tab is looked at again.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && el.autorefresh.checked) tick();
});

// Token first, so the very first render already knows whether to draw the
// operator affordances — otherwise they'd flicker in a beat later.
loadAdminToken().then(() => tick());

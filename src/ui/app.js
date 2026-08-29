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
  openSettings: $('open-settings'),
  setDlg: $('settings-dlg'),
  setBody: $('set-body'),
};

/*
 * Minimizing a channel is a view preference, not a claim about the work, so it
 * lives in this browser and nowhere else — that is the whole difference from
 * archiving, which is a shared, audited statement everyone sees. Kept across
 * reloads, because a board you have to re-tidy on every refresh isn't tidy.
 */
const MIN_KEY = 'orch.minimized';
function loadMinimized() {
  try {
    const raw = JSON.parse(localStorage.getItem(MIN_KEY) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((s) => typeof s === 'string') : []);
  } catch {
    return new Set();   // private mode, or someone put junk in there
  }
}
function saveMinimized() {
  try { localStorage.setItem(MIN_KEY, JSON.stringify([...ui.minimized])); } catch { /* not worth failing over */ }
}

const ui = {
  limit: PAGE,
  minimized: loadMinimized(),
  kinds: new Set(['message', 'task', 'contract', 'admin']),
  text: '',
  channel: '',
  expanded: new Set(),
  lastLogSig: null,
  lastChannelSig: null,
  hasMore: false,
  showRetired: false,
  showArchived: false,
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

/** An operator affordance. Always a real button — this board has no read-only mode. */
function actionable(label, act, data, title) {
  const attrs = Object.entries(data).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ');
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
      `mark ${a.agent}'s backlog read on its behalf`
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
  // Work the agent is holding, not merely work pointed at it. Without this it
  // shows up only in the derived state label — which a live self-reported
  // status suppresses — so an agent that reports diligently while holding three
  // claimed tasks said nothing about them anywhere on this row. The dialog
  // behind it already listed them: taskDialog filters on claimed_by too.
  if (a.claimed_tasks?.length) {
    bits.push(actionable(
      `${a.claimed_tasks.length} claimed`,
      'tasks',
      { channel, agent: a.agent },
      `${a.agent} is holding ${a.claimed_tasks.length} claimed task${a.claimed_tasks.length === 1 ? '' : 's'}`
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
  const acts = a.retired
    ? `<button type="button" class="row-act" data-act="unretire" ${at} title="Put ${esc(a.agent)} back on the board">↩</button>`
    : `<button type="button" class="row-act" data-act="retire" ${at} title="Clear ${esc(a.agent)}'s backlog and take it off the board">🗑</button>`;
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

/** One channel card: the header line, its affordances, and every agent row. */
function channelCard(c) {
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
  const tasksCell = openCount
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
          <div class="row-acts">
            <!-- Minimize is view state, and private to this browser — unlike archive,
                 which is a shared statement everyone on the board sees. -->
            <button type="button" class="row-act" data-act="minimize" data-channel="${esc(c.channel)}" title="Minimize ${esc(c.channel)} — folds it into a pill below so you can focus. This browser only; nobody else sees it, and nothing is archived.">–</button>
            <button type="button" class="row-act" data-act="channel" data-channel="${esc(c.channel)}" title="Archive or delete this channel">🗑</button>
          </div>
        </div>
        ${agents}
      </div>`;
}

function renderChannels(state) {
  const sig = JSON.stringify(state.channels) + JSON.stringify(state.totals) +
    `|${ui.showRetired}|${ui.showArchived}|${[...ui.minimized].sort().join('\n')}`;
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

  const onBoard = state.channels.filter((c) => ui.showArchived || !c.archived);
  const shown = onBoard.filter((c) => !ui.minimized.has(c.channel));
  const minimized = onBoard.filter((c) => ui.minimized.has(c.channel));
  // Archived channels and retired agents are never dropped silently — the count
  // is always on screen, even when the rows aren't.
  const bar = t.archived_channels
    ? `<div class="reveal-bar">
         <button type="button" class="chip${ui.showArchived ? ' on' : ''}" data-act="toggle-archived">
           ${t.archived_channels} archived channel${t.archived_channels === 1 ? '' : 's'}
         </button>
       </div>`
    : '';

  // A minimized channel keeps whatever it is carrying on screen. A pill that hid
  // an unread count would make the board lie by omission, which is the one thing
  // it must not do — same reason archived channels keep a count.
  const pills = minimized.length
    ? `<div class="min-bar">${minimized.map((c) => {
        const unread = (c.agents ?? []).reduce((sum, a) => sum + a.unread, 0);
        const unfinished = c.tasks.open + c.tasks.claimed;
        const title = `${c.channel} — click to restore · ${unread} unread · ` +
          `${unfinished} unfinished task${unfinished === 1 ? '' : 's'} · ${c.messages} message${c.messages === 1 ? '' : 's'}`;
        return `<button type="button" class="min-pill" data-act="restore" data-channel="${esc(c.channel)}" title="${esc(title)}">
            <span class="min-name">${esc(c.channel)}</span>
            ${c.archived ? '<span class="min-flag">archived</span>' : ''}
            ${unread ? `<span class="min-count">${unread}</span>` : ''}
          </button>`;
      }).join('')}${minimized.length > 1
        ? `<button type="button" class="min-pill min-all" data-act="restore-all" title="Bring all ${minimized.length} minimized channels back">show all</button>`
        : ''}</div>`
    : '';

  const cards = !shown.length && minimized.length
    ? '<div class="empty">every channel is minimized — click a pill to bring one back</div>'
    : shown.map(channelCard).join('');

  // Pills last, so they land on their own row beneath the cards.
  el.channels.innerHTML = bar + cards + pills;
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
  'admin.retire': ['agent retired', 'admin'],
  'admin.unretire': ['agent restored', 'admin'],
  'admin.task.close': ['task closed', 'admin'],
  'admin.task.reassign': ['task reassigned', 'admin'],
  'admin.channel.archive': ['channel archived', 'admin'],
  'admin.channel.unarchive': ['channel restored', 'admin'],
  'admin.channel.delete': ['channel deleted', 'admin'],
  // Server-wide operator actions. They carry the `(server)` channel because
  // admin_events is channel-scoped and none of these belong to one.
  'admin.user.create': ['user added', 'admin'],
  'admin.user.update': ['user changed', 'admin'],
  'admin.user.enable': ['user enabled', 'admin'],
  'admin.user.disable': ['user disabled', 'admin'],
  'admin.user.delete': ['user deleted', 'admin'],
  'admin.backup.export': ['backup exported', 'admin'],
  'admin.backup.restore': ['backup restored', 'admin'],
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
 * POST an operator action.
 *
 * No credential to attach: the server's only check is that the request is
 * same-origin, which a fetch from this page satisfies by construction.
 */
async function admin(path, body) {
  const res = await fetch(`./api/admin/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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

/**
 * Somewhere to put a word from an action with no dialog left behind it.
 *
 * The slot is empty and hidden the rest of the time — it used to carry a standing
 * "read-only" note, and with the sign-in gone there is no standing state to
 * report.
 */
let notifyTimer = null;
function notify(message, { error = true } = {}) {
  clearTimeout(notifyTimer);
  el.adminState.textContent = message;
  el.adminState.classList.toggle('err', error);
  el.adminState.classList.remove('hidden');
  notifyTimer = setTimeout(() => {
    el.adminState.classList.remove('err');
    el.adminState.textContent = '';
    el.adminState.classList.add('hidden');
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
 * Deal with an agent's backlog on its behalf.
 *
 * Reached from the unread count. Marking read is an operator bookkeeping action,
 * not a message: it moves the agent's cursor so the board stops counting mail the
 * agent is never going to answer. Nothing here talks to the agent — the board has
 * no way to make another window take a turn, and no longer pretends to.
 */
function backlogDialog(channel, agent) {
  const a = findAgent(channel, agent);
  if (!a || !a.unread) return;
  const upTo = a.unread_max_id ?? 0;
  const at = `data-channel="${esc(channel)}" data-agent="${esc(agent)}"`;
  const n = (count) => (count === 1 ? '' : 's');
  openDialog(`
    <h3>${esc(agent)} · ${a.unread} unread</h3>
    <p class="dlg-sub">
      on <span class="mono">${esc(channel)}</span> · ${esc(a.presence)}${a.sessions ? ` · ${a.sessions} live session${n(a.sessions)}` : ''} · seen ${age(a.last_seen)}
    </p>
    <div class="dlg-choice">
      <button type="button" class="btn primary" data-do="advance" data-up-to="${upTo}" ${at}>Mark read (operator)</button>
      <p>Moves the cursor to #${upTo}. ${esc(agent)} never sees these ${a.unread} message${n(a.unread)}, and the board stops counting them.</p>
    </div>
    <p class="dlg-note">To get ${esc(agent)}'s attention, type in its own window, or put it on <span class="mono">/loop</span> so it polls this board itself.</p>
    <div class="dlg-foot"><button type="button" class="btn" data-do="cancel">Cancel</button></div>
  `);
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

/* ---------- settings: export and restore ---------- */

/**
 * Settings keeps its own state rather than deriving from /api/state, because none
 * of it is coordination data: it is what you have chosen and not yet committed.
 */
const set = {
  backup: null,       // a chosen file, parsed and vetted, awaiting confirmation
  backupName: null,
  restored: null,     // the report from a completed restore
};

const setErr = (msg) => {
  const box = el.setBody.querySelector('.set-err');
  if (!box) return;
  box.textContent = String(msg ?? '');
  box.hidden = !msg;
};
const setNote = (msg) => {
  const box = el.setBody.querySelector('.set-note-live');
  if (!box) return;
  box.textContent = String(msg ?? '');
  box.hidden = !msg;
};

function toolsPanel() {
  const t = ui.state?.totals;
  const b = set.backup;
  const counted = b ? Object.entries(b.counts ?? {}).filter(([, n]) => n > 0) : [];

  const chosen = b
    ? `<div class="set-file">
         <div class="set-file-head">${esc(set.backupName ?? 'backup')}</div>
         <div class="muted mono tiny">
           taken ${esc(b.created_at ? new Date(b.created_at).toLocaleString() : 'at an unrecorded time')} ·
           from v${esc(b.server?.version ?? '?')} ·
           ${counted.length ? counted.map(([k, n]) => `${n} ${k}`).join(' · ') : 'no rows at all'}
         </div>
         ${b.auth?.shared_secret_fingerprint
           ? `<div class="muted mono tiny">its agents used shared secret ${esc(b.auth.shared_secret_fingerprint)} — the key itself is not in the file</div>`
           : ''}
       </div>
       <div class="dlg-confirm">
         <input class="input mono" id="restore-confirm" type="text" autocomplete="off" spellcheck="false" placeholder="type RESTORE">
         <button type="button" class="btn danger" data-set="restore">Restore</button>
       </div>`
    : '';

  const done = set.restored
    ? `<div class="set-done">
         <b>Restored ${set.restored.rows} rows.</b>
         ${(set.restored.notes ?? []).map((n) => `<div>${esc(n)}</div>`).join('')}
         <div>${set.restored.snapshot?.saved
           ? `The board as it was is saved at <span class="mono">${esc(set.restored.snapshot.path)}</span>.`
           : 'The pre-restore snapshot could not be written.'}</div>
       </div>`
    : '';

  return `
    <div class="set-tool">
      <div>
        <h4 class="set-h">Export a backup</h4>
        <p>Downloads this whole board as one JSON file: every message, task, contract with its history, agent,
          channel flag, and operator-action record.
          ${t ? `Right now that is ${t.channels + t.archived_channels} channel(s) and ${t.agents + t.retired_agents} agent(s).` : ''}</p>
        <p><b>One thing is deliberately not in it:</b> the shared MCP secret — only a fingerprint of it, so you can
          check the new host has the same one. Everything else in the file is board data, and there are no
          dashboard accounts to carry.</p>
      </div>
      <button type="button" class="btn primary" data-set="export">Export</button>
    </div>

    <div class="set-tool">
      <div>
        <h4 class="set-h risky">Recover from a backup</h4>
        <p>Replaces everything on this board with the contents of a backup file. Not a merge: ids are per-board, so
          blending two histories would give you one task <span class="mono">#14</span> that means two different things.</p>
        <p>Before overwriting, the current board is written to the data directory next to the database, so a restore
          you regret is recoverable. Live agent sessions are closed and reconnect by themselves.</p>
        <label class="set-picker">
          <input type="file" id="restore-file" accept=".json,application/json">
        </label>
        ${chosen}
        ${done}
      </div>
    </div>
    <div class="set-err" hidden></div>
    <p class="set-note-live" hidden></p>
    <p class="dlg-note">Moving to a new host: export here, start the new instance with the same
      <span class="mono">ORCH_AUTH_TOKEN</span> in its <span class="mono">.env</span> (that part does not travel in the
      file), then restore there. Agents keep the same <span class="mono">.mcp.json</span> apart from the URL.</p>`;
}

function renderSettings() {
  el.setBody.innerHTML = toolsPanel();
}

function openSettings() {
  set.restored = null;
  set.backup = null;
  set.backupName = null;
  renderSettings();
  if (!el.setDlg.open) el.setDlg.showModal();
}

/**
 * Download the backup.
 *
 * Fetched rather than linked so the failure is a sentence in the panel instead of
 * a browser error page. The blob round-trip is what turns the response back into
 * a file the browser will save.
 */
async function exportBackup() {
  setErr(null);
  setNote('preparing…');
  try {
    const res = await fetch('./api/admin/backup');
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'orchestratinator-backup.json';
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    setNote(`saved ${name} · ${(blob.size / 1024).toFixed(0)} kB`);
    tick();   // the export is itself a logged operator action
  } catch (e) {
    setNote(null);
    setErr(e.message ?? e);
  }
}

/**
 * Vet the chosen file in the browser before anything is sent.
 *
 * The server validates it again — that check is the real one. This exists so that
 * picking the wrong file is a sentence on screen rather than a destructive request
 * that happens to get refused, and so you can read what you are about to overwrite
 * your board with while there is still nothing to undo.
 */
async function chooseBackupFile(file) {
  set.backup = null;
  set.backupName = null;
  set.restored = null;
  setErr(null);
  setNote(null);
  try {
    const doc = JSON.parse(await file.text());
    if (doc?.format !== 'orchestratinator-backup') throw new Error('that file is not an orchestratinator backup');
    if (!doc.tables || typeof doc.tables !== 'object') throw new Error('that backup has no tables in it');
    set.backup = doc;
    set.backupName = file.name;
  } catch (e) {
    renderSettings();
    setErr(`could not read ${file.name}: ${e.message ?? e}`);
    return;
  }
  renderSettings();
}

async function restoreBackup() {
  const typed = el.setBody.querySelector('#restore-confirm')?.value.trim() ?? '';
  setErr(null);
  setNote('restoring…');
  const buttons = [...el.setBody.querySelectorAll('button, input')];
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const res = await fetch('./api/admin/backup/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: typed, backup: set.backup }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    set.restored = json;
    set.backup = null;
    set.backupName = null;
    renderSettings();
    ui.lastChannelSig = null;
    ui.lastLogSig = null;
    tick();
  } catch (e) {
    buttons.forEach((b) => { b.disabled = false; });
    setNote(null);
    setErr(e.message ?? e);
  }
}

el.openSettings.addEventListener('click', () => openSettings());

el.setDlg.addEventListener('click', (e) => {
  if (e.target === el.setDlg) { el.setDlg.close(); return; }
  const btn = e.target.closest('[data-set]');
  if (!btn) return;

  switch (btn.dataset.set) {
    case 'close': el.setDlg.close(); break;
    case 'export': exportBackup(); break;
    case 'restore': restoreBackup(); break;
    default: break;
  }
});

el.setBody.addEventListener('change', (e) => {
  const input = e.target.closest('#restore-file');
  if (!input?.files?.[0]) return;
  chooseBackupFile(input.files[0]);
});

el.setDlg.addEventListener('close', () => { set.backup = null; set.backupName = null; });

/* ---------- polling ---------- */

let inFlight = false;

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function tick({ background = false } = {}) {
  if (inFlight) return;
  if (background && document.hidden) return; // don't poll a tab nobody is looking at
  inFlight = true;
  try {
    const qs = new URLSearchParams({ limit: String(ui.limit) });
    if (ui.channel) qs.set('channel', ui.channel);
    const [state, activity] = await Promise.all([
      getJson('./api/state'),
      getJson(`./api/activity?${qs}`),
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

  // So is minimizing, and it never leaves the browser — so it re-renders from the
  // state already in hand rather than waiting on a fetch that would return the
  // same thing. Changing what you're looking at should feel instant.
  if (action === 'minimize' || action === 'restore' || action === 'restore-all') {
    if (action === 'minimize') ui.minimized.add(channel);
    else if (action === 'restore') ui.minimized.delete(channel);
    else ui.minimized.clear();
    saveMinimized();
    ui.lastChannelSig = null;
    if (ui.state) renderChannels(ui.state); else tick();
    return;
  }

  if (action === 'unread') backlogDialog(channel, agent);
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

tick();

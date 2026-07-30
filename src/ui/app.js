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
  whoami: $('whoami'),
  setDlg: $('settings-dlg'),
  setBody: $('set-body'),
  setTabs: $('set-tabs'),
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
  // Operator actions are locked until GET /api/admin/token hands us one, which it
  // only does for a browser holding a login or the shared secret.
  admin: { token: null, locked: true },
  // Who the server says we are. `user` is null on a board with no accounts, and on
  // one reached with the shared secret instead of a sign-in.
  session: { user: null, loginRequired: false, sharedSecret: false, users: 0 },
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
          <div class="row-acts">
            <!-- Minimize is view state, so unlike the trash can it is there even on
                 a read-only board. -->
            <button type="button" class="row-act" data-act="minimize" data-channel="${esc(c.channel)}" title="Minimize ${esc(c.channel)} — folds it into a pill below so you can focus. This browser only; nobody else sees it, and nothing is archived.">–</button>
            ${ui.admin.locked ? '' : `<button type="button" class="row-act" data-act="channel" data-channel="${esc(c.channel)}" title="Archive or delete this channel">🗑</button>`}
          </div>
        </div>
        ${agents}
      </div>`;
}

function renderChannels(state) {
  const sig = JSON.stringify(state.channels) + JSON.stringify(state.totals) +
    `|${ui.admin.locked}|${ui.showRetired}|${ui.showArchived}|${[...ui.minimized].sort().join('\n')}`;
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
  'admin.nudge': ['nudged', 'admin'],
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

/** Why the affordances are missing, phrased for whichever door this board has. */
const lockedNote = () =>
  ui.session.loginRequired
    ? 'read-only · sign in to enable operator actions'
    : 'read-only · open as /?key=… to enable operator actions';

/**
 * Ask for the per-process admin token. A 401 here isn't an error state — it's the
 * normal condition for a browser that has presented no credential, and it simply
 * leaves every affordance rendered as plain text.
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
  el.adminState.textContent = ui.admin.locked ? lockedNote() : '';
  el.adminState.classList.toggle('hidden', !ui.admin.locked);
  ui.lastChannelSig = null;   // affordances appear/disappear with this flag
}

/**
 * Who we are, and whether this server asks. Read before the first paint so the
 * header doesn't announce a name a beat after the board arrives.
 */
async function loadSession() {
  try {
    const res = await fetch('./api/session');
    const json = res.ok ? await res.json() : {};
    ui.session = {
      user: json.user ?? null,
      loginRequired: !!json.login_required,
      sharedSecret: !!json.shared_secret,
      users: json.users ?? 0,
    };
  } catch {
    /* offline — leave whatever we last knew */
  }
  const s = ui.session;
  // A shared-secret browser gets a name too, because "who is this operator row
  // attributed to" has a different answer for it: nobody in particular.
  const label = s.user ?? (s.sharedSecret ? 'shared key' : null);
  el.whoami.innerHTML = label
    ? `<span class="who-name" title="${s.user ? `signed in as ${esc(s.user)}` : 'authenticated with the shared secret, not as a named user'}">${esc(label)}</span>` +
      `<button type="button" class="link" id="sign-out" title="Sign out of this browser">sign out</button>`
    : '';
  el.whoami.classList.toggle('hidden', !label);
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
    el.adminState.textContent = ui.admin.locked ? lockedNote() : '';
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

/* ---------- settings: users and tools ---------- */

/**
 * Settings keeps its own state rather than deriving from /api/state, because none
 * of it is coordination data: the user list is a server read of its own, and the
 * rest is what you have typed and not yet committed.
 */
const set = {
  tab: 'users',
  users: null,        // null until fetched, so "no users" and "not loaded" differ
  you: null,
  sessionDays: null,
  editing: null,      // a username being edited, or NEW for the add-a-user row
  pendingDelete: null,
  loadError: null,
  backup: null,       // a chosen file, parsed and vetted, awaiting confirmation
  backupName: null,
  restored: null,     // the report from a completed restore
};
const NEW = ' new';   // can't collide with a username

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

async function loadUsers() {
  set.loadError = null;
  try {
    const res = await fetch('./api/admin/users', { headers: { 'x-orch-admin-token': ui.admin.token ?? '' } });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    set.users = json.users ?? [];
    set.you = json.you ?? null;
    set.sessionDays = json.session_days ?? null;
  } catch (e) {
    set.users = null;
    set.loadError = String(e.message ?? e);
  }
}

/** One row: the username, or the edit form that replaces it. */
function userRow(u) {
  const self = u.username === set.you;
  const editing = set.editing === u.username;
  if (editing) {
    return `
      <div class="user-row editing">
        <div class="user-edit">
          <label>username<input class="input" data-f="username" type="text" value="${esc(u.username)}" autocapitalize="none" spellcheck="false"></label>
          <label>new password<input class="input" data-f="password" type="password" autocomplete="new-password" placeholder="leave blank to keep"></label>
          <label>verify<input class="input" data-f="verify" type="password" autocomplete="new-password" placeholder="repeat it"></label>
        </div>
        <div class="user-acts">
          <button type="button" class="btn primary" data-set="save" data-username="${esc(u.username)}">Save</button>
          <button type="button" class="btn" data-set="cancel-edit">Cancel</button>
        </div>
      </div>`;
  }
  if (set.pendingDelete === u.username) {
    return `
      <div class="user-row danger">
        <span class="user-name">${esc(u.username)}</span>
        <span class="user-warn">Delete this account? Their sessions end immediately.</span>
        <div class="user-acts">
          <button type="button" class="btn danger" data-set="delete" data-username="${esc(u.username)}">Delete</button>
          <button type="button" class="btn" data-set="cancel-delete">Keep</button>
        </div>
      </div>`;
  }
  // Why a control is unavailable belongs on the control. The server refuses these
  // two as well — this is the explanation, not the enforcement.
  const why = 'you cannot do this to the account you are signed in as';
  return `
    <div class="user-row${u.enabled ? '' : ' off'}">
      <span class="user-name">${esc(u.username)}</span>
      ${self ? '<span class="user-tag">you</span>' : ''}
      <span class="user-meta">${u.last_login ? `last in ${age(u.last_login)}` : 'never signed in'}</span>
      <div class="user-acts">
        <button type="button" class="toggle${u.enabled ? ' on' : ''}" data-set="toggle"
          data-username="${esc(u.username)}" data-enabled="${u.enabled ? '0' : '1'}"
          ${self ? `disabled title="${why}"` : `title="${u.enabled ? 'Disable' : 'Enable'} ${esc(u.username)}"`}>
          <span class="toggle-track"><span class="toggle-knob"></span></span>${u.enabled ? 'enabled' : 'disabled'}
        </button>
        <button type="button" class="row-act bare" data-set="edit" data-username="${esc(u.username)}" title="Change ${esc(u.username)}'s username or password">✎</button>
        <button type="button" class="row-act bare" data-set="ask-delete" data-username="${esc(u.username)}"
          ${self ? `disabled title="${why}"` : `title="Delete ${esc(u.username)}"`}>🗑</button>
      </div>
    </div>`;
}

function usersTab() {
  if (ui.admin.locked) {
    return `<p class="set-blocked">This browser is read-only, so it cannot manage accounts.
      ${ui.session.loginRequired
        ? 'Sign in first.'
        : 'Open the dashboard once as <span class="mono">/?key=&lt;shared secret&gt;</span> — that is also how the very first account gets created.'}</p>`;
  }
  if (set.loadError) return `<div class="set-err">${esc(set.loadError)}</div>`;
  if (!set.users) return '<div class="empty">loading…</div>';

  const adding = set.editing === NEW;
  const rows = set.users.length
    ? set.users.map(userRow).join('')
    : '<div class="empty">No accounts yet. The dashboard is open to anyone who can reach it.</div>';
  const addRow = adding
    ? `<div class="user-row editing">
         <div class="user-edit">
           <label>username<input class="input" data-f="username" type="text" autocapitalize="none" spellcheck="false" placeholder="a name you'll recognise"></label>
           <label>password<input class="input" data-f="password" type="password" autocomplete="new-password"></label>
           <label>verify<input class="input" data-f="verify" type="password" autocomplete="new-password"></label>
         </div>
         <div class="user-acts">
           <button type="button" class="btn primary" data-set="create">Add</button>
           <button type="button" class="btn" data-set="cancel-edit">Cancel</button>
         </div>
       </div>`
    : '';

  const enabled = set.users.filter((u) => u.enabled).length;
  return `
    <div class="set-bar">
      <span class="muted">${set.users.length} account${set.users.length === 1 ? '' : 's'}${
        set.users.length ? ` · ${enabled} enabled` : ''}</span>
      <button type="button" class="btn primary" data-set="add"${adding ? ' disabled' : ''}>+ Add user</button>
    </div>
    <div class="user-list">${rows}${addRow}</div>
    <div class="set-err" hidden></div>
    <p class="set-note-live" hidden></p>
    <p class="dlg-note">
      Every account here is an admin — there are no roles, and anyone who signs in can do anything on this
      board. ${enabled
        ? `A sign-in lasts ${set.sessionDays ?? 30} days per browser, and disabling someone ends theirs on their next request.`
        : 'While no account is <em>enabled</em>, nobody is asked to sign in at all.'}
      Passwords are stored as scrypt hashes; nothing here can show you an existing one.
    </p>`;
}

function toolsTab() {
  if (ui.admin.locked) {
    return `<p class="set-blocked">This browser is read-only, so it cannot export or restore.
      ${ui.session.loginRequired ? 'Sign in first.' : 'Open the dashboard once as <span class="mono">/?key=&lt;shared secret&gt;</span>.'}</p>`;
  }
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
          channel flag, operator-action record, and dashboard account.
          ${t ? `Right now that is ${t.channels + t.archived_channels} channel(s) and ${t.agents + t.retired_agents} agent(s).` : ''}</p>
        <p><b>Two things are deliberately not in it.</b> The shared MCP secret — only a fingerprint of it, so you can
          check the new host has the same one — and live sign-in cookies. It <em>does</em> carry password hashes,
          so treat the file as a credential.</p>
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
  for (const t of el.setTabs.querySelectorAll('.tab')) t.classList.toggle('on', t.dataset.tab === set.tab);
  el.setBody.innerHTML = set.tab === 'users' ? usersTab() : toolsTab();
}

async function openSettings() {
  set.tab = 'users';
  set.editing = null;
  set.pendingDelete = null;
  set.restored = null;
  set.backup = null;
  set.backupName = null;
  set.users = null;
  renderSettings();
  if (!el.setDlg.open) el.setDlg.showModal();
  if (!ui.admin.locked) {
    await loadUsers();
    if (el.setDlg.open && set.tab === 'users') renderSettings();
  }
}

/** POST a settings action, then reload the user list so the panel can't drift. */
async function userAction(path, body, { after } = {}) {
  setErr(null);
  setNote(null);
  const buttons = [...el.setBody.querySelectorAll('button, input')];
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const res = await fetch(`./api/admin/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-orch-admin-token': ui.admin.token ?? '' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    set.editing = null;
    set.pendingDelete = null;
    await loadUsers();
    // Adding the first account turns sign-in on, and deleting the last turns it
    // off. Both change what the header should say about you.
    await loadSession();
    renderSettings();
    if (after) setNote(after(json));
    tick();
  } catch (e) {
    buttons.forEach((b) => { b.disabled = false; });
    setErr(e.message ?? e);
  }
}

const fieldOf = (row, name) => row?.querySelector(`[data-f="${name}"]`)?.value ?? '';

/**
 * Download the backup.
 *
 * Fetched rather than linked, because the export needs the admin token in a header
 * and an anchor cannot send one. The blob round-trip is what turns the response
 * back into a file the browser will save.
 */
async function exportBackup() {
  setErr(null);
  setNote('preparing…');
  try {
    const res = await fetch('./api/admin/backup', { headers: { 'x-orch-admin-token': ui.admin.token ?? '' } });
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
      headers: { 'content-type': 'application/json', 'x-orch-admin-token': ui.admin.token ?? '' },
      body: JSON.stringify({ confirm: typed, backup: set.backup }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    set.restored = json;
    set.backup = null;
    set.backupName = null;
    // The restore may have replaced the account this browser is signed in as, in
    // which case the next poll gets a 401 and getJson reloads into the sign-in
    // form. Ask now rather than letting that arrive as a surprise.
    await loadSession();
    await loadAdminToken();
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

el.whoami.addEventListener('click', async (e) => {
  if (!e.target.closest('#sign-out')) return;
  try { await fetch('./api/logout', { method: 'POST' }); } catch { /* reload anyway */ }
  location.reload();
});

el.setDlg.addEventListener('click', (e) => {
  if (e.target === el.setDlg) { el.setDlg.close(); return; }
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    set.tab = tab.dataset.tab;
    set.editing = null;
    set.pendingDelete = null;
    renderSettings();
    if (set.tab === 'users' && !set.users && !ui.admin.locked) loadUsers().then(renderSettings);
    return;
  }
  const btn = e.target.closest('[data-set]');
  if (!btn) return;
  const row = btn.closest('.user-row');
  const name = btn.dataset.username;

  switch (btn.dataset.set) {
    case 'close': el.setDlg.close(); break;
    case 'add': set.editing = NEW; renderSettings(); el.setBody.querySelector('[data-f="username"]')?.focus(); break;
    case 'edit': set.editing = name; set.pendingDelete = null; renderSettings(); el.setBody.querySelector('[data-f="password"]')?.focus(); break;
    case 'cancel-edit': set.editing = null; renderSettings(); break;
    case 'ask-delete': set.pendingDelete = name; set.editing = null; renderSettings(); break;
    case 'cancel-delete': set.pendingDelete = null; renderSettings(); break;
    case 'create':
      userAction('users/create', {
        username: fieldOf(row, 'username'),
        password: fieldOf(row, 'password'),
        verify: fieldOf(row, 'verify'),
      }, { after: (j) => `added ${j.username}` });
      break;
    case 'save': {
      const password = fieldOf(row, 'password');
      userAction('users/update', {
        username: name,
        new_username: fieldOf(row, 'username'),
        // Blank means "leave it", so don't send the verify field either — an empty
        // verify against an empty password is not a mismatch worth reporting.
        ...(password ? { password, verify: fieldOf(row, 'verify') } : {}),
      }, { after: (j) => (j.changed ?? []).join('; ') });
      break;
    }
    case 'toggle':
      userAction('users/enabled', { username: name, enabled: btn.dataset.enabled === '1' });
      break;
    case 'delete':
      userAction('users/delete', { username: name }, { after: (j) => j.warning ?? `deleted ${j.username}` });
      break;
    case 'export': exportBackup(); break;
    case 'restore': restoreBackup(); break;
    default: break;
  }
});

// Enter anywhere in an edit row commits it, so adding a colleague is three fields
// and a keystroke.
el.setBody.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const row = e.target.closest('.user-row.editing');
  if (!row) return;
  e.preventDefault();
  row.querySelector('[data-set="save"], [data-set="create"]')?.click();
});

el.setBody.addEventListener('change', (e) => {
  const input = e.target.closest('#restore-file');
  if (!input?.files?.[0]) return;
  chooseBackupFile(input.files[0]);
});

el.setDlg.addEventListener('close', () => { set.editing = null; set.pendingDelete = null; });

/* ---------- polling ---------- */

let inFlight = false;

/**
 * A poll that notices being signed out.
 *
 * A session that expires (or an account someone disables) turns every poll into a
 * 401 while the page goes on displaying the last board it saw — which is the worst
 * possible failure for a monitoring screen, because a frozen board and a quiet
 * board look identical. Reloading lands on the sign-in form, which is the truth.
 */
async function getJson(url) {
  const res = await fetch(url);
  if (res.status === 401) {
    const json = await res.json().catch(() => ({}));
    if (json.login_required) { location.reload(); throw new Error('signed out'); }
  }
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

// Identity and token first, so the very first render already knows who you are and
// whether to draw the operator affordances — otherwise both flicker in a beat later.
Promise.all([loadSession(), loadAdminToken()])
  // loadAdminToken words its explanation differently depending on whether this
  // server asks for a sign-in, and it can finish before the answer arrives.
  .then(() => { if (ui.admin.locked) el.adminState.textContent = lockedNote(); })
  .then(() => tick());

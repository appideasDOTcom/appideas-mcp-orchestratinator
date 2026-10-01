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

/**
 * Which channels this browser has folded away — the floor's copy of the same
 * fact, so a channel minimized here is not a storey there either.
 *
 * A function, because `ui` is a top-level `const` and so is not on `window` at
 * all; a top-level `function` in a classic script is. A copy of the names
 * rather than the Set itself, because handing the other surface the live one
 * makes it possible to minimize a channel from the floor by accident — and
 * minimizing stays a board control. floor.js only ever asks.
 */
function minimizedChannels() { return [...ui.minimized]; }

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
  // The saved-prompt library while its manager is open, and which row is being
  // edited — an id, 'new', or null for the plain list. Outside the dialog's DOM
  // because every save redraws the whole thing.
  promptRows: [],
  promptEdit: null,
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

/**
 * A message body as one readable line.
 *
 * Bodies are JSON-encoded and may be a string or a structured object, so the
 * raw column is quoted or braced and reads badly in a list. Unwrap a plain
 * string; leave anything else as compact JSON rather than guessing at a shape.
 */
function excerpt(body, n = 90) {
  let text = String(body ?? '');
  try {
    const v = JSON.parse(text);
    text = typeof v === 'string' ? v : JSON.stringify(v);
  } catch { /* not JSON — show it as it is */ }
  return clip(text.replace(/\s+/g, ' ').trim(), n) || '(empty)';
}

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
      { channel, agent: a.agent, kind: 'assigned' },
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
      { channel, agent: a.agent, kind: 'claimed' },
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

/**
 * An agent's name, the id underneath it, and the way to change the name.
 *
 * Both are shown because they answer different questions: the name is what
 * people say out loud, the id is what routes a message and what appears in
 * `.mcp.json`. Showing only the name would repeat the mistake this replaced —
 * an arbitrary label standing in for an identifier — and showing only the id
 * makes the board a wall of slugs.
 *
 * The pencil is hidden until the name is hovered. It is a real button rather
 * than a click handler on the name itself so it reaches the keyboard, and it
 * carries the agent's *current* name so the dialog can open already filled in.
 */
function nameplate(channel, a) {
  const name = a.persona ?? a.agent;
  return `<span class="named">
            <span class="agent-name">${esc(name)}</span>
            <button type="button" class="pencil" data-act="rename"
                    data-channel="${esc(channel)}" data-agent="${esc(a.agent)}" data-persona="${esc(name)}"
                    title="Rename ${esc(name)}" aria-label="Rename ${esc(name)}">\u270e</button>
          </span>
          <span class="agent-id mono" title="X-Agent — what routes messages to this desk">${esc(a.agent)}</span>`;
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
                  ${nameplate(c.channel, a)}
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
  'admin.message.reassign': ['message re-addressed', 'admin'],
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
/**
 * The floor's endpoints, from the board. Same origin, so the same guard lets it
 * through — the board is nudging into a window the floor owns, which is exactly
 * the kind of thing only the operator should be able to do.
 */
async function floorPost(path, body) {
  const res = await fetch(`./api/floor/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

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

/**
 * What to call an agent, and how to write it where the id also matters.
 *
 * `personas` ships per channel rather than only on agent rows, because a task's
 * requester may have no row here — retired, or on a channel the board is not
 * showing. Falling back to the id is correct rather than defensive: an agent
 * with no persona row yet genuinely has no name but its own.
 */
const nameOf = (channel, agent) =>
  (agent ? findChannel(channel)?.personas?.[agent] : null) ?? agent ?? '';
/** "Appideas Qa (appideas-qa)" — collapses to one when the name adds nothing. */
const nameAndId = (channel, agent) => {
  const name = nameOf(channel, agent);
  return !agent || name === agent ? String(agent ?? '') : `${name} (${agent})`;
};

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
/**
 * Re-draw whichever dialog is open — or close it, if what it was showing is gone.
 *
 * Every one of these dialogs is opened from a count on the board, so when that
 * count reaches zero the pill that opened it has gone too and there is nothing
 * left in here to act on. Closing is not just tidier than an empty list: it
 * removes the state where a re-render is skipped and the dialog is left showing
 * rows that have already moved somewhere else, which is exactly what reassigning
 * the last message used to do.
 *
 * The channel-scoped list has no count behind it, so it stays open and says it
 * is empty.
 */
function refreshDialog() {
  if (!el.dlg.open || !ui.dlgCtx) return;
  const { channel, agent, kind } = ui.dlgCtx;
  // Not every dialog is a list. A rename has no count behind it and nothing to
  // redraw, so leave it exactly as the operator is using it. The prompt manager
  // is the same: it reads its own endpoint and redraws after each change, and a
  // poll-driven redraw would throw away whatever is half-typed in it.
  // The take-a-desk and leave-desk dialogs hold typing and a choice; a poll
  // must not redraw either.
  if (kind === 'rename' || kind === 'prompts' || kind === 'desk' || kind === 'leave' || kind === 'sessions' || kind === 'history') return;
  if (agent) {
    const a = findAgent(channel, agent);
    const left = !a ? 0
      : kind === 'unread' ? a.unread
      : kind === 'claimed' ? (a.claimed_tasks?.length ?? 0)
      : kind === 'assigned' ? a.assigned_open
      : 1;
    if (!left) { closeDialog(); return; }
  }
  if (kind === 'unread') backlogDialog(channel, agent);
  else taskDialog(channel, agent, kind);
}

async function act(fn, { keepOpen = false } = {}) {
  const scoped = el.dlg.open;
  // Only the controls this call actually disabled are re-enabled afterwards.
  // A blanket re-enable switches on anything that was disabled deliberately —
  // the Nudge button on a desk with no window to type into, for one — and it
  // survives whenever the re-draw that would have rebuilt it is skipped.
  const held = scoped
    ? [...el.dlgBody.querySelectorAll('button, select, input')].filter((b) => !b.disabled)
    : [];
  const toggle = (disabled) => held.forEach((b) => { b.disabled = disabled; });
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
// What the operator is told when the button cannot be pressed. The full
// sentence is on the button's tooltip; this is the version that fits a line.
const NUDGE_BLOCKED = {
  held_by_editor: 'the floor needs this conversation — close it in your editor, or move it back with “Open in VS Code”.',
  host_offline: 'that desk’s host is offline, so nothing can be typed into its window.',
  not_hosted: 'no host is running this repo, so this desk has no window to type into.',
};

/**
 * "Nudge agent" — types the word into the desk's own window, which is the thing
 * the operator would otherwise go and do by hand. A desk with no window gets
 * one opened first, resuming its conversation, and the title says so before
 * the click — see nudgeable() on the server.
 *
 * Disabled in fact and not only in appearance: `disabled` on the button, so a
 * click cannot fire at all. The reason comes from the server, computed by the
 * same function the chat endpoint refuses with, so the greyed-out state and the
 * refusal can never tell different stories.
 */
function nudgeHead(channel, agent, a) {
  if (!agent) return { button: '', note: '' };
  const n = a?.nudge ?? { ok: false, code: 'not_hosted', reason: 'Nothing is known about this desk yet.' };
  const at = `data-channel="${esc(channel)}" data-agent="${esc(agent)}"`;
  const title = !n.ok ? n.reason
    : n.opens ? `Opens ${agent}'s window on ${n.host} — resuming its conversation — and types “nudge”`
    : `Types “nudge” into ${agent}'s window on ${n.host}`;
  return {
    button: `<button type="button" class="btn nudge" data-do="nudge" ${at}${n.ok ? '' : ' disabled'} title="${esc(title)}">Nudge agent</button>`,
    note: n.ok ? '' : `<p class="dlg-note nudge-why">Can’t nudge — ${esc(NUDGE_BLOCKED[n.code] ?? n.reason)}</p>`,
  };
}

function backlogDialog(channel, agent) {
  const a = findAgent(channel, agent);
  if (!a || !a.unread) return;
  const upTo = a.unread_max_id ?? 0;
  const at = `data-channel="${esc(channel)}" data-agent="${esc(agent)}"`;
  const n = (count) => (count === 1 ? '' : 's');
  ui.dlgCtx = { channel, agent, kind: 'unread' };
  const c = findChannel(channel);
  const names = (c?.agents ?? []).map((x) => x.agent);
  const who = nameAndId(channel, agent);
  const list = a.unread_list ?? [];

  const rows = list.length ? list.map((m) => `
    <div class="task-row">
      <div>
        <span class="ref">#${m.id}</span> <span class="title">${esc(excerpt(m.body))}</span>
        <span class="badge ${m.to ? 'opened' : 'claimed'}">${m.to ? 'direct' : 'broadcast'}</span>
        <div class="muted mono tiny">sent by ${esc(nameOf(channel, m.from))} · ${age(m.created_at)}</div>
      </div>
      <div class="task-acts">
        <select class="input" data-reassign-msg="${m.id}" title="point this message at someone else">
          <option value="">— everyone —</option>
          ${names.map((x) => `<option value="${esc(x)}"${m.to === x ? ' selected' : ''}>${esc(nameAndId(channel, x))}</option>`).join('')}
        </select>
        <button type="button" class="btn" data-do="read-to" data-channel="${esc(channel)}" data-agent="${esc(agent)}" data-up-to="${m.id}"
          title="marks this one read, and anything older — read is a single cursor, not a per-message flag">close</button>
      </div>
    </div>`).join('') : '<div class="empty">nothing unread here</div>';

  const nudge = nudgeHead(channel, agent, a);
  openDialog(`
    <div class="dlg-head"><h3>Unread messages · ${esc(who)}</h3>${nudge.button}</div>
    ${nudge.note}
    <p class="dlg-sub">
      on <span class="mono">${esc(channel)}</span> · ${esc(a.presence)}${a.sessions ? ` · ${a.sessions} live session${n(a.sessions)}` : ''} · seen ${age(a.last_seen)}${a.unread > list.length ? ` · showing ${list.length} of ${a.unread}` : ''}
    </p>
    <div class="task-list">${rows}</div>
    <p class="dlg-note">
      Whether an agent has seen a message is one cursor, not a flag per message — so <b>close</b> marks that
      message read <b>and anything older than it</b>. Closing the top row is the same as marking all read.
      Either way ${esc(nameOf(channel, agent))} never sees them, and the log keeps the record. Changing the dropdown re-addresses
      the message immediately.
    </p>
    <div class="dlg-foot">
      <button type="button" class="btn" data-do="cancel">Cancel</button>
      <button type="button" class="btn primary" data-do="advance" data-up-to="${upTo}" ${at}>Mark all read (operator)</button>
    </div>
  `);
}

/**
 * Rename an agent.
 *
 * The name is an operator decision stored on the server, so everyone looking at
 * this board sees the same one — it is not a per-browser nickname. Deliberately
 * unguarded: no uniqueness check, and no protection against overwriting a name
 * somebody else chose. Both were considered and refused. A guard could only
 * refuse the operator something they asked for on purpose, and the id under the
 * name is what actually distinguishes two desks.
 *
 * Clearing the field restores the derived default rather than leaving a desk
 * blank, which is the only reason this needs a note at all.
 */
const GENDERS = [
  ['neutral', 'Neutral', 'no hair — the figure as it has always been drawn'],
  ['male', 'Male', 'a short, swept cut'],
  ['female', 'Female', 'long hair, past the shoulders'],
];

/**
 * One colour choice: the current value as a swatch, and the choices behind it.
 *
 * The grid is in the markup from the start rather than built on demand, hidden
 * until asked for. It means the chosen value lives in the DOM the whole time —
 * `aria-checked` on a radio — so saving reads the same place whether or not the
 * operator ever opened the picker, and there is no state to keep in step.
 *
 * No contrast rule between the three. An operator may put brown hair on a brown
 * shirt; that is their business, and a picker that refuses combinations is
 * harder to explain than one that does not.
 */
function swatchRow(kind, label, current) {
  const choices = ui.state?.palette?.[kind] ?? [];
  const value = choices.includes(current) ? current : (choices[0] ?? '#888888');
  return `
    <div class="swatch-row" data-kind="${esc(kind)}">
      <span class="swatch-label">${esc(label)}</span>
      <button type="button" class="swatch current" data-do="open-swatches"
              style="--c:${esc(value)}" aria-expanded="false"
              aria-label="${esc(label)} colour, ${esc(value)} — choose another"></button>
      <div class="swatches" role="radiogroup" aria-label="${esc(label)} colour" hidden>
        ${choices.map((c) => `
          <button type="button" class="swatch" role="radio" data-do="pick-swatch" data-color="${esc(c)}"
                  aria-checked="${c === value}" style="--c:${esc(c)}"
                  title="${esc(c)}" aria-label="${esc(c)}"></button>`).join('')}
      </div>
    </div>`;
}

function renameDialog(channel, agent) {
  ui.dlgCtx = { channel, agent, kind: 'rename' };
  const current = nameOf(channel, agent);
  const a = findAgent(channel, agent);
  const gender = a?.gender ?? 'neutral';
  openDialog(`
    <div class="dlg-head"><h3>${esc(current)}</h3></div>
    <p class="dlg-sub">on <span class="mono">${esc(channel)}</span> · <span class="mono">${esc(agent)}</span></p>
    <label class="field">
      <span>Display name</span>
      <input id="persona-name" class="input" type="text" maxlength="40" value="${esc(current)}"
             placeholder="${esc(agent)}" autocomplete="off" spellcheck="false">
    </label>
    <div class="field">
      <span>Avatar</span>
      <select id="persona-gender" class="input">
        ${GENDERS.map(([v, label, why]) =>
          `<option value="${esc(v)}"${gender === v ? ' selected' : ''}>${esc(label)} — ${esc(why)}</option>`).join('')}
      </select>
      ${swatchRow('shirt', 'Shirt', a?.shirt)}
      ${swatchRow('hair', 'Hair', a?.hair)}
      ${swatchRow('skin', 'Skin', a?.skin)}
    </div>
    <p class="dlg-note">
      Everyone sees all of this, and it follows <span class="mono">${esc(agent)}</span> everywhere on the board
      and the floor — the id itself never changes, so messages and tasks keep routing exactly as they do now.
      Leave the name empty to go back to <b>${esc(defaultName(agent))}</b>. Hair and skin show on the floor's
      figures; a neutral avatar has no hair to colour.
    </p>
    <div class="dlg-foot">
      <button type="button" class="btn" data-do="cancel">Cancel</button>
      <button type="button" class="btn primary" data-do="rename-save"
              data-channel="${esc(channel)}" data-agent="${esc(agent)}">Save</button>
    </div>
  `);
  const input = el.dlgBody.querySelector('#persona-name');
  input?.focus();
  input?.select();
  // Enter saves, because a one-field dialog that needs a mouse is a chore.
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); el.dlgBody.querySelector('[data-do="rename-save"]')?.click(); }
  });
}

/**
 * The name an agent gets when nobody has chosen one — the same derivation the
 * server does in `humanName`. Duplicated here only so the dialog can *name* the
 * default it is offering to restore; the server remains the one that assigns it.
 */
function defaultName(agent) {
  const words = String(agent ?? '').split(/[^a-zA-Z0-9]+/).filter(Boolean);
  return words.length ? words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') : String(agent ?? '');
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

/**
 * The task list behind a count pill.
 *
 * `kind` is which pill was clicked, and it decides both the heading and the
 * rows. It used to decide neither: one list matched `assignee === agent ||
 * claimed_by === agent` under a single "Unfinished tasks" heading, so an agent
 * holding one of each got both in one list under a title true of neither, and
 * the dialog's contents did not match the number on the pill that opened it.
 *
 * The filters below are deliberately the same conditions `agentTaskLoad` counts
 * on the server — assigned means open-and-assigned, claimed means claimed-by.
 * A dialog that disagreed with the pill you pressed to reach it is worse than
 * no dialog.
 */
/**
 * Confirm stopping a turn. Opened from the stop sign in the floor's chat panel,
 * which is the only caller — but it lives here because app.js owns the dialogs
 * on this page, the same reason the desk pills call in rather than growing a
 * second copy.
 *
 * It says what Escape does, because "stop" is vaguer than what happens: the
 * turn ends where it is, the work already done stays done, and the conversation
 * is still there to carry on from. Nobody should have to find that out by
 * trying it on an agent they care about.
 *
 * `persona` is passed in rather than looked up: the floor opened this from a
 * desk it is drawing right now, so it holds the better name.
 */
function stopDialog(channel, agent, persona) {
  const who = persona || nameOf(channel, agent);
  openDialog(`
    <h3>Stop ${esc(who)}?</h3>
    <p class="dlg-sub">on <span class="mono">${esc(channel)}</span></p>
    <ul class="dlg-list">
      <li>presses <span class="mono">Escape</span> in its window — the same key you would</li>
      <li>ends the turn where it is; anything already written or run stays</li>
      <li>leaves the conversation open, so you can say what to do instead</li>
    </ul>
    <p class="dlg-note">Claude Code records this in the transcript as <span class="mono">[Request interrupted by user]</span>, so the agent can see it was stopped rather than that it finished.</p>
    <div class="dlg-foot">
      <button type="button" class="btn" data-do="cancel">Cancel</button>
      <button type="button" class="btn danger" data-do="stop-desk" data-channel="${esc(channel)}" data-agent="${esc(agent)}">Stop ${esc(who)}</button>
    </div>
  `);
}

/**
 * The saved-prompt library: list, add, edit, delete.
 *
 * Board-wide, so it takes no channel and no agent — an operator's ten prompts
 * are the operator's, not a channel's. Opened from the floor's compose row,
 * which is the only place a prompt can be used; app.js owns it for the same
 * reason it owns every other dialog on this page.
 *
 * One dialog that redraws itself rather than a stack of them. `ui.promptEdit`
 * is which row is open for editing — an id, the string 'new', or null for the
 * plain list — and it lives outside the DOM because every save redraws the lot.
 *
 * Split in two, and the split is load-bearing. A top-level `function foo` in a
 * classic script IS `window.foo`, so a later `window.foo = () => …` does not
 * publish an entry point beside it — it replaces the declaration, and every
 * internal call to `foo` follows. Written that way, the loader called the entry
 * point, which called the loader, forever: no error, no dialog, and a fetch
 * every round. The drawing keeps its own name and the exported one only opens.
 */
function renderPromptManager() {
  ui.dlgCtx = { kind: 'prompts' };
  const editing = ui.promptEdit ?? null;
  const rows = ui.promptRows ?? [];
  const current = editing !== null && editing !== 'new' ? rows.find((p) => p.id === editing) : null;

  // Plain buttons in the rows; the red one is on the confirmation, which is the
  // click that actually destroys something. A column of red Deletes makes a list
  // you keep prompts in look like a list you empty.
  const list = rows.length
    ? `<ul class="dlg-list prompt-list">${rows.map((p) => `
        <li class="prompt-row${p.id === editing ? ' editing' : ''}">
          <span class="prompt-title">${esc(p.title)}</span>
          <span class="prompt-preview mono">${esc(clip(p.content, 60))}</span>
          <span class="prompt-acts">
            <button type="button" class="btn" data-do="prompt-edit" data-id="${p.id}">Edit</button>
            <button type="button" class="btn" data-do="prompt-ask-delete" data-id="${p.id}">Delete</button>
          </span>
        </li>`).join('')}</ul>`
    : '<p class="dlg-sub">Nothing saved yet. Add the first one below.</p>';

  const form = editing === null ? '' : `
    <div class="prompt-form">
      <label class="field">
        <span>Title</span>
        <input id="prompt-title" class="input" type="text" autocomplete="off" spellcheck="false"
               value="${esc(current?.title ?? '')}" placeholder="What you would call it">
      </label>
      <label class="field">
        <span>Content</span>
        <textarea id="prompt-content" class="input" rows="6"
                  placeholder="The message this puts in the box">${esc(current?.content ?? '')}</textarea>
      </label>
    </div>`;

  openDialog(`
    <div class="dlg-head"><h3>Saved prompts</h3></div>
    <p class="dlg-sub">Shared by every desk on this board. Picking one puts its content in the compose box, where you can edit it before sending.</p>
    ${list}
    ${form}
    <div class="dlg-foot">
      ${editing === null
        ? `<button type="button" class="btn" data-do="cancel">Close</button>
           <button type="button" class="btn primary" data-do="prompt-new">New prompt</button>`
        : `<button type="button" class="btn" data-do="prompt-cancel-edit">Cancel</button>
           <button type="button" class="btn primary" data-do="prompt-save"${editing === 'new' ? '' : ` data-id="${editing}"`}>Save</button>`}
    </div>
  `);
  const title = el.dlgBody.querySelector('#prompt-title');
  title?.focus();
  title?.select();
}

/** Read the library, then draw the manager. Every change comes back through here. */
async function loadPrompts({ edit } = {}) {
  const res = await fetch('./api/prompts', { headers: { accept: 'application/json' } });
  ui.promptRows = res.ok ? ((await res.json()).prompts ?? []) : [];
  if (edit !== undefined) ui.promptEdit = edit;
  renderPromptManager();
  // The floor's picker holds its own copy so it can draw without waiting; tell
  // it the library moved rather than letting it show yesterday's list.
  window.floorPromptsChanged?.();
}

/** What the floor's "Manage…" calls. Declared, not assigned — see above. */
function promptManager() {
  ui.promptEdit = null;
  loadPrompts();
}

/**
 * Confirm a deletion. Its own dialog rather than a state inside the manager:
 * the manager is a list you scan, and a confirmation you can scroll away from
 * is one you answer without reading. Cancel goes back to the list.
 */
function promptDeleteDialog(id) {
  const p = (ui.promptRows ?? []).find((x) => x.id === id);
  if (!p) return;
  openDialog(`
    <h3>Delete “${esc(p.title)}”?</h3>
    <p class="dlg-sub">${esc(clip(p.content, 200))}</p>
    <p class="dlg-note">There is no undo, and nothing else keeps a copy — a backup taken before now would still have it.</p>
    <div class="dlg-foot">
      <button type="button" class="btn" data-do="prompt-cancel-delete">Cancel</button>
      <button type="button" class="btn danger" data-do="prompt-delete" data-id="${p.id}">Delete</button>
    </div>
  `);
}

function taskDialog(channel, agent, kind = null) {
  const c = findChannel(channel);
  if (!c) return;
  // Remembered so an action that keeps the dialog open can rebuild it against
  // the refreshed state instead of leaving a stale row on screen.
  ui.dlgCtx = { channel, agent: agent ?? null, kind };
  const all = c.task_list ?? [];
  const mine = kind === 'claimed'
    ? (t) => t.claimed_by === agent
    : kind === 'assigned'
      ? (t) => t.assignee === agent && t.status === 'open'
      : (t) => t.assignee === agent || t.claimed_by === agent;
  const list = agent ? all.filter(mine) : all;
  const names = (c.agents ?? []).map((a) => a.agent);
  const rows = list.length ? list.map((t) => `
    <div class="task-row">
      <div>
        <span class="ref">#${t.id}</span> <span class="title">${esc(t.title)}</span>
        <span class="badge ${t.status === 'claimed' ? 'claimed' : 'opened'}">${esc(t.status)}</span>
        <!-- Who asked for it. "assigned to X" restated the dropdown sitting
             beside it, and "claimed by X" under a heading about claims read as
             a riddle. Neither told you the one thing the row could not
             otherwise show. -->
        <div class="muted mono tiny">${t.created_by ? `requested by ${esc(nameOf(channel, t.created_by))}` : 'no requester recorded'} · ${age(t.updated_at)}</div>
      </div>
      <div class="task-acts">
        <select class="input" data-reassign="${t.id}" title="reassign">
          <!-- "no assignee" rather than "unassigned": a claimed task has no
               assignee but is very much someone's, and the row says who. -->
          <option value="">— no assignee —</option>
          ${names.map((n) => `<option value="${esc(n)}"${t.assignee === n ? ' selected' : ''}>${esc(nameAndId(channel, n))}</option>`).join('')}
        </select>
        <button type="button" class="btn" data-do="close-task" data-channel="${esc(channel)}" data-id="${t.id}">close</button>
      </div>
    </div>`).join('') : `<div class="empty">${kind === 'claimed' ? 'nothing claimed here' : kind === 'assigned' ? 'nothing assigned here' : 'nothing unfinished here'}</div>`;

  const nudge = nudgeHead(channel, agent, agent ? findAgent(channel, agent) : null);
  openDialog(`
    <div class="dlg-head"><h3>${kind === 'claimed' ? 'Pending claims' : kind === 'assigned' ? 'Pending tasks' : 'Unfinished tasks'}${agent ? ` · ${esc(nameAndId(channel, agent))}` : ''}</h3>${nudge.button}</div>
    ${nudge.note}
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
  else if (action === 'tasks') taskDialog(channel, agent ?? null, btn.dataset.kind ?? null);
  else if (action === 'rename') renameDialog(channel, agent);
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
  const reRender = (ok) => { if (ok) refreshDialog(); };

  switch (d.do) {
    case 'cancel':
      closeDialog();
      break;
    // --- saved prompts. The list is already in hand, so moving between the list
    // and the form is a redraw, not a fetch; only a write re-reads.
    case 'prompt-new':
      ui.promptEdit = 'new';
      renderPromptManager();
      break;
    case 'prompt-edit':
      ui.promptEdit = Number(d.id);
      renderPromptManager();
      break;
    case 'prompt-cancel-edit':
      ui.promptEdit = null;
      renderPromptManager();
      break;
    case 'prompt-save': {
      // Deliberately not checked here first. "Not empty" and "no duplicate
      // title" are the server's rules — it has the unique index behind it — and
      // a copy in the form would be a second place for them to drift. A refusal
      // arrives in .dlg-err with whatever the operator typed still in the boxes.
      const title = el.dlgBody.querySelector('#prompt-title')?.value ?? '';
      const content = el.dlgBody.querySelector('#prompt-content')?.value ?? '';
      const id = d.id ? Number(d.id) : null;
      act(() => (id === null
        ? admin('prompt/create', { title, content })
        : admin('prompt/update', { id, title, content })
      ).then(() => loadPrompts({ edit: null })), { keepOpen: true });
      break;
    }
    case 'prompt-ask-delete':
      promptDeleteDialog(Number(d.id));
      break;
    case 'prompt-cancel-delete':
      ui.promptEdit = null;
      loadPrompts();
      break;
    case 'prompt-delete':
      act(() => admin('prompt/delete', { id: Number(d.id) })
        .then(() => loadPrompts({ edit: null })), { keepOpen: true });
      break;
    case 'advance':
      act(() => admin('agent/advance', { channel: d.channel, agent: d.agent, up_to_id: Number(d.upTo) }));
      break;
    // --- take a desk / leave a desk. See deskDialog below.
    case 'desk-look':
      // The folder the picker stands in, listed again by the host.
      readDeskForm();
      browseTo(ui.deskForm?.path ?? null);
      break;
    case 'desk-pick':
      // The host's own folder dialog, on its own screen.
      readDeskForm();
      pickFolder();
      break;
    case 'desk-take': {
      readDeskForm();
      const body = takeBody(ui.deskForm);
      // Where this folder sits is where the next dialog opens — however it
      // was chosen, the dialog, a recent row or the page's own list.
      rememberDir(localStorage, body.host_id, ui.deskForm.listing?.parent ?? null);
      act(() => floorPost('desk', body).then(() => { window.floorOpenDesk?.(body.channel, body.agent); }));
      break;
    }
    case 'desk-leave':
      act(() => floorPost('desk/leave', { channel: d.channel, agent: d.agent }));
      break;
    // --- the session picker. See sessionDialog below. The floor is told the
    // moment the reopen is queued so its link can spin until the desk's
    // conversation actually changes — the receipt for the click is there,
    // not here.
    case 'session-resume': {
      const fm = ui.sessForm;
      if (!fm) break;
      const id = d.id;
      act(() => floorPost('reopen', { channel: fm.channel, agent: fm.agent, session_id: id })
        .then(() => { window.floorReopen?.(fm.channel, fm.agent, id, fm.current); }));
      break;
    }
    case 'session-new': {
      const fm = ui.sessForm;
      if (!fm) break;
      act(() => floorPost('reopen', { channel: fm.channel, agent: fm.agent, session_id: null })
        .then(() => { window.floorReopen?.(fm.channel, fm.agent, null, fm.current); }));
      break;
    }
    case 'session-look':
      askSessions();
      break;
    // --- history across every desk. See historyDialog below.
    case 'history-search':
      runHistorySearch();
      break;
    case 'history-clear':
      if (ui.histForm) { ui.histForm.search = null; ui.histForm.query = ''; ui.histForm.seq++; renderHistoryDialog(); }
      break;
    case 'history-look':
      askRecent();
      break;
    case 'history-read': {
      // Opened to read in its own desk's panel — the floor script's, which
      // owns the panel. The dialog closes: the conversation is the answer.
      const find = ui.histForm?.search ? ui.histForm.search.query : null;
      closeDialog();
      window.floorRead?.(d.channel, d.agent, d.id, d.title || null, { find });
      break;
    }
    case 'retire':
      act(() => admin('agent/retire', { channel: d.channel, agent: d.agent }));
      break;
    case 'close-task':
      act(() => admin('task/close', { channel: d.channel, id: Number(d.id) }), { keepOpen: true }).then(reRender);
      break;
    // The word, into the window, via the host — the same path the floor's own
    // compose box uses. Not typed into a textarea and submitted: that would
    // depend on a panel being open and would fail in ways the endpoint does not.
    //
    // Unlike every other action in here, this one closes the dialog on success
    // rather than re-rendering it. Nudging changes nothing the dialog is
    // showing, so a dialog left open after the click is a dialog that looks
    // like it did nothing: the operator clicks Nudge, sees no change, clicks
    // Done, and the floor updates as they land back on it — which reads as
    // though Done is what sent it. Closing is the acknowledgement. A nudge that
    // is refused keeps the dialog, because then there is a reason to show.
    case 'nudge':
      act(() => floorPost('chat', { channel: d.channel, agent: d.agent, text: 'nudge' }))
        .then((ok) => { if (ok) window.floorNudged?.(d.channel, d.agent, 'nudge'); });
      break;
    // Escape, into the window, via the host. Closes on success like the nudge
    // above and for the same reason — the change it makes is on the floor
    // behind this dialog, not in it. A refusal keeps it open: by the time the
    // prompt has been read the turn may simply have ended, and "nothing is
    // running at this desk right now" is the answer, not an error to swallow.
    case 'stop-desk':
      act(() => floorPost('interrupt', { channel: d.channel, agent: d.agent }));
      break;
    // Same endpoint as "Mark all read", a different cursor. Closing one row is
    // "read to here", which is the only thing a single cursor can mean.
    case 'read-to':
      act(
        () => admin('agent/advance', { channel: d.channel, agent: d.agent, up_to_id: Number(d.upTo) }),
        { keepOpen: true }
      ).then(reRender);
      break;
    // An empty field means "give it back the derived name" rather than "leave it
    // blank" — the endpoint requires a non-empty persona, so send the default.
    // Opening one picker closes any other: two grids open at once in a dialog
    // this size pushes the buttons off the bottom.
    case 'open-swatches': {
      const row = btn.closest('.swatch-row');
      const grid = row.querySelector('.swatches');
      const opening = grid.hidden;
      for (const g of el.dlgBody.querySelectorAll('.swatches')) g.hidden = true;
      for (const b of el.dlgBody.querySelectorAll('[data-do="open-swatches"]')) b.setAttribute('aria-expanded', 'false');
      grid.hidden = !opening;
      btn.setAttribute('aria-expanded', String(opening));
      if (opening) grid.querySelector('[aria-checked="true"]')?.focus();
      break;
    }
    case 'pick-swatch': {
      const row = btn.closest('.swatch-row');
      for (const b of row.querySelectorAll('[data-do="pick-swatch"]')) b.setAttribute('aria-checked', 'false');
      btn.setAttribute('aria-checked', 'true');
      const swatch = row.querySelector('.swatch.current');
      swatch.style.setProperty('--c', btn.dataset.color);
      swatch.setAttribute('aria-expanded', 'false');
      row.querySelector('.swatches').hidden = true;
      swatch.focus();
      break;
    }
    case 'rename-save': {
      const typed = (el.dlgBody.querySelector('#persona-name')?.value ?? '').trim();
      const persona = typed || defaultName(d.agent);
      const gender = el.dlgBody.querySelector('#persona-gender')?.value ?? 'neutral';
      const colour = (kind) =>
        el.dlgBody.querySelector(`.swatch-row[data-kind="${kind}"] [aria-checked="true"]`)?.dataset.color;
      const patch = { channel: d.channel, agent: d.agent, persona, gender };
      // Only fields with a value are sent — omitting one means "leave it", and
      // sending undefined would be the same as sending nothing anyway.
      for (const kind of ['shirt', 'hair', 'skin']) {
        const c = colour(kind);
        if (c) patch[kind] = c;
      }
      // One request, so a dialog that changed several things cannot half-succeed.
      act(() => floorPost('profile', patch));
      break;
    }
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
  if (!ui.dlgCtx) return;
  const { channel, agent, kind } = ui.dlgCtx;

  const msg = e.target.closest('[data-reassign-msg]');
  if (msg) {
    act(
      () => admin('message/reassign', { channel, id: Number(msg.dataset.reassignMsg), to: msg.value || null }),
      { keepOpen: true }
    ).then(reassigned => { if (reassigned) refreshDialog(); });
    return;
  }

  const sel = e.target.closest('[data-reassign]');
  if (!sel) return;
  act(
    () => admin('task/reassign', { channel, id: Number(sel.dataset.reassign), assignee: sel.value || null }),
    { keepOpen: true }
  ).then((ok) => { if (ok) refreshDialog(); });
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

/* ---------- take a desk: what the dialog reads ---------- */

/** How many recent folders the dialog offers. Short on purpose: the flat list
 *  of every candidate was taken out of this dialog for being 95 names from
 *  nowhere, and a recent list that grows is that list again. */
const RECENT_MAX = 5;

/**
 * The folders to offer as "Recently opened": the ones Claude Code has
 * actually been run in, newest first, a handful of them.
 *
 * A folder nobody has opened is not recent, whatever its place in the host's
 * list, and one bound to another board cannot be taken from here — a row
 * whose only answer is a refusal is not worth one of five places. Sorted
 * here as well as by the host, so the order does not depend on every hop
 * between the two keeping it.
 */
function recentFolders(folders, max = RECENT_MAX) {
  return (Array.isArray(folders) ? folders : [])
    .filter((f) => f && f.path && f.last_active && !f.other_board)
    .sort((a, b) => String(b.last_active).localeCompare(String(a.last_active)))
    .slice(0, max);
}

/**
 * The name somebody has saved for an agent, or null when nobody has.
 *
 * Names are kept by agent id for the whole board, so this is the name the
 * desk will carry the moment it is seated. Null is drawn as "none" rather
 * than as the name the board would derive from the id: the dialog says what
 * is saved, and nothing is saved.
 */
function savedName(names, agent) {
  const id = String(agent ?? '').trim();
  const name = id && names && Object.hasOwn(names, id) ? names[id] : null;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

/** Where this browser keeps the folder the last choice was made in, per host. */
const DESK_DIR_KEY = 'orch.desk.dir';

/**
 * The folder the last choice on this host was made in, or null.
 *
 * Per host, because a path is a path on one machine; per browser, like the
 * floor filter and the view, because it is this person's habit and nobody
 * else's. Anything in the store that is not an absolute path is no memory at
 * all — the store is the browser's and can hold whatever was once put there.
 */
function rememberedDir(storage, hostId) {
  try {
    const dir = JSON.parse(storage.getItem(DESK_DIR_KEY) ?? '{}')?.[hostId];
    return typeof dir === 'string' && dir.startsWith('/') ? dir : null;
  } catch { return null; }
}

/**
 * Remember where a choice was made: the chosen folder's parent, which is
 * where its siblings are — seating several agents in a row is choosing
 * neighbours, and the dialog should open among them, not back at home.
 *
 * Only ever a hint. The host opens the nearest folder that still exists, so
 * a remembered folder that has since gone costs nothing but being wrong.
 */
function rememberDir(storage, hostId, dir) {
  if (!hostId || typeof dir !== 'string' || !dir.startsWith('/')) return;
  try {
    let all = {};
    try { all = JSON.parse(storage.getItem(DESK_DIR_KEY) ?? '{}') ?? {}; } catch { /* unreadable: start again */ }
    if (typeof all !== 'object' || Array.isArray(all)) all = {};
    all[hostId] = dir;
    storage.setItem(DESK_DIR_KEY, JSON.stringify(all));
  } catch { /* not worth failing over */ }
}

/**
 * What a take sends: the host, the folder, the floor and the agent.
 *
 * No name. The dialog reads the one the agent already carries, and a take
 * that sends none makes no change to it — so seating an agent can never
 * rename it on every floor it sits on, which a typed field here could.
 */
function takeBody(fm) {
  const channel = fm.channel === '__new__' ? fm.newChannel.trim() : fm.channel;
  return { host_id: fm.hostId, path: fm.path, channel, agent: fm.agent.trim(), open: true };
}

/* ---------- take a desk: the dialog ---------- */

/**
 * Take a desk: pick the folder the agent lives in, and it becomes a desk on a
 * floor — no file to edit, no terminal.
 *
 * The folder is chosen in the operating system's own folder dialog, opened
 * by the host on the machine it runs on — the operator's — because that is
 * the dialog a person already knows, and the folders are that machine's.
 * "Choose folder…" asks for it (`POST /api/floor/pick`) and the page reads
 * where it has got to: the host says the dialog is open, and from then on
 * the wait is for the person rather than for a clock. It opens in the folder
 * the last choice was made in, which this browser remembers per host.
 *
 * A host with no dialog of its own (see host/dialog.js: only macOS has one
 * so far) gets the picker this dialog had before, drawn here: it opens on
 * the host's home folder and shows the folders inside it, and you open
 * folders until you are standing in the agent's. Each level is one round
 * trip (`POST /api/floor/browse`, then the GET until the host's time on it
 * moves). So does a host whose dialog failed, with what it said. The first
 * version of all was a flat list of every folder that might be a desk, by
 * its last path segment — 95 names from nowhere, on the first machine it ran
 * on (2026-09-10).
 *
 * Either way it goes anywhere that account can read; the roots in host.json
 * are where the host looks for desks on its own, not a limit on what you may
 * pick.
 *
 * The folder you stand in fills the form. A folder that already names its
 * agent (in its .mcp.json, or in Claude Code's local scope) fixes the agent:
 * the field is locked, because "my agent lives in this directory" is the
 * whole idea, and only the floor is yours to choose. Change the floor and
 * the take becomes a move; keep it and it is an import into local scope; an
 * unbound folder asks for a name. One dialog, three modes, decided by what
 * the folder says and what you pick.
 *
 * Two things beside the picker are read rather than asked for. The agent's
 * name is the one it already carries on the board — shown, not typed, and
 * "none" when nobody has saved one — and above the picker sits a short
 * "Recently opened" list: the top of the host's own folder list, which it
 * already sorts newest activity first, so the folder somebody was just in is
 * one click instead of a walk down from home.
 *
 * Drawn by renderDeskDialog and redrawn on every choice, so the operator's
 * picks live in ui.deskForm rather than in the DOM. The poll never redraws
 * it: 'desk' is in refreshDialog's skip list.
 */
function deskDialog({ channel = null, hostId = null, path = null } = {}) {
  ui.dlgCtx = { kind: 'desk' };
  ui.deskForm = {
    hosts: null, names: {}, hostId, path, listing: null, waiting: false, seq: 0,
    // picking: null | 'asking' | 'open' — where the host's own dialog has got
    // to. listMode: the page's list is drawn although the host has a dialog,
    // because that dialog failed, and pickError is what it said.
    picking: null, listMode: false, pickError: null, pickNote: null,
    wantChannel: channel, channel, newChannel: '', agent: '', prefilled: null, error: null,
  };
  renderDeskDialog();
  loadFolders();
}

/** The hosts with their roots and folder lists, and the names saved on this
 *  board, read when the dialog opens: where a picker can start, what was
 *  opened recently, and what each agent is called. */
async function loadFolders() {
  const fm = ui.deskForm;
  if (!fm) return;
  try {
    const res = await fetch('./api/floor/folders');
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    fm.hosts = json.hosts ?? [];
    fm.names = json.names ?? {};
    fm.error = null;
  } catch (e) {
    fm.hosts = [];
    fm.names = {};
    fm.error = `Could not read the host list — ${e.message}`;
  }
  if (ui.dlgCtx?.kind !== 'desk' || ui.deskForm !== fm) return;
  const live = fm.hosts.filter((h) => h.live);
  if (!fm.hostId || !fm.hosts.some((h) => h.host_id === fm.hostId)) fm.hostId = live[0]?.host_id ?? fm.hosts[0]?.host_id ?? null;
  const host = fm.hosts.find((h) => h.host_id === fm.hostId) ?? null;
  renderDeskDialog();
  // A host with a dialog of its own is asked for nothing until somebody
  // presses the button — unless the caller named a folder, which is looked at
  // to fill the form. One without lists its home folder here, as before.
  if (host?.live && (fm.path || !host.dialog)) browseTo(fm.path ?? null);
}

/**
 * Ask the host to open its own folder dialog, and wait for the choice.
 *
 * Two waits, and only the first is on a clock. The host has 8 s to say the
 * dialog is open — a host that cannot be reached must not leave a button
 * spinning — and once it has, the wait is for a person, who takes as long as
 * they take: it ends when the host says chosen, cancelled or failed, or when
 * this dialog is closed. (The host closes a dialog nobody touches, after ten
 * minutes, and says cancelled.)
 *
 * A dialog that fails, or a host that never opens one, falls back to the
 * page's own list with what was said — a way forward rather than a dead
 * button. A chosen folder arrives as the host's own listing of it, the same
 * record the list would have produced, so the form below is filled one way.
 */
async function pickFolder() {
  const fm = ui.deskForm;
  if (!fm || !fm.hostId || fm.picking) return;
  const seq = ++fm.seq;
  const hostName = (fm.hosts ?? []).find((h) => h.host_id === fm.hostId)?.name ?? fm.hostId;
  const mine = () => ui.dlgCtx?.kind === 'desk' && ui.deskForm === fm && fm.seq === seq;
  const get = async (what, extra = '') => {
    const res = await fetch(`./api/floor/${what}?host_id=${encodeURIComponent(fm.hostId)}${extra}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json;
  };
  const toList = (why) => {
    fm.picking = null;
    fm.pickError = why;
    fm.listMode = true;
    browseTo(fm.path ?? null);
  };
  fm.picking = 'asking';
  fm.listMode = false;
  fm.waiting = false;
  fm.error = null;
  fm.pickError = null;
  fm.pickNote = null;
  renderDeskDialog();
  try {
    let last = (await get('pick')).at ?? null;
    const start = rememberedDir(localStorage, fm.hostId);
    await floorPost('pick', { host_id: fm.hostId, ...(start ? { start } : {}) });
    const asked = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 500));
      if (!mine()) return;
      const got = await get('pick').catch(() => null);
      if (!mine()) return;
      if (got && got.at && got.at !== last) {
        last = got.at;
        if (got.state === 'open') {
          fm.picking = 'open';
          renderDeskDialog();
        } else if (got.state === 'chosen') {
          const listing = await get('browse', `&path=${encodeURIComponent(got.path)}`);
          if (!mine()) return;
          if (!listing.at) throw new Error(`${hostName} chose ${got.path} and did not say what is in it`);
          rememberDir(localStorage, fm.hostId, got.parent ?? listing.parent ?? null);
          fm.picking = null;
          takeListing(fm, listing);
          renderDeskDialog();
          return;
        } else if (got.state === 'cancelled') {
          fm.picking = null;
          fm.pickNote = got.why ? `The folder dialog was closed — ${got.why}.` : null;
          renderDeskDialog();
          return;
        } else if (got.state === 'failed') {
          toList(got.error ?? 'The folder dialog failed.');
          return;
        }
      }
      if (fm.picking === 'asking' && Date.now() - asked > 8000) {
        toList(`${hostName} did not open its folder dialog in 8 s.`);
        return;
      }
    }
  } catch (e) {
    if (!mine()) return;
    toList(String(e.message ?? e));
  }
}

/**
 * Open one folder on the host: ask, then read until the host has answered.
 *
 * `keep` is for a folder taken from the recent list. That list is the host's
 * last report and a folder on it can have gone since — so the open is tried,
 * and when the host says it cannot, the picker stays standing where it was
 * and says which path failed, in the host's own words. Without it a failed
 * open is where the picker now stands: no crumbs, no rows, and no way back.
 */
async function browseTo(path, { keep = false } = {}) {
  const fm = ui.deskForm;
  if (!fm || !fm.hostId) return;
  const seq = ++fm.seq;
  const stood = { path: fm.path, listing: fm.listing };
  // Opening a folder here is the choice now: a host dialog still on screen
  // has nobody waiting on it (its seq is stale), so the form stops saying one is.
  fm.picking = null;
  fm.waiting = true;
  fm.error = null;
  fm.path = path;
  renderDeskDialog();
  const mine = () => ui.dlgCtx?.kind === 'desk' && ui.deskForm === fm && fm.seq === seq;
  const read = async () => {
    const res = await fetch(`./api/floor/browse?host_id=${encodeURIComponent(fm.hostId)}${path ? `&path=${encodeURIComponent(path)}` : ''}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json;
  };
  try {
    const before = (await read()).at ?? null;
    await floorPost('browse', { host_id: fm.hostId, ...(path ? { path } : {}) });
    for (let i = 0; i < 16 && mine(); i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (!mine()) return;
      const got = await read().catch(() => null);
      if (got && got.at && got.at !== before) {
        if (keep && got.error) {
          fm.path = stood.path;
          fm.listing = stood.listing;
          fm.error = got.error;
        } else {
          takeListing(fm, got);
        }
        fm.waiting = false;
        renderDeskDialog();
        return;
      }
    }
    if (!mine()) return;
    fm.waiting = false;
    fm.error = 'The host did not answer in 8 s.';
  } catch (e) {
    if (!mine()) return;
    fm.waiting = false;
    fm.error = String(e.message ?? e);
  }
  // Unanswered, a recent folder is not where the picker stands either: the
  // form is still the old folder's, and a take must not carry the new path.
  if (keep) { fm.path = stood.path; fm.listing = stood.listing; }
  renderDeskDialog();
}

/** What the host listed, and the form filled from the folder it stands in. */
function takeListing(fm, got) {
  fm.listing = got;
  if (got.path) fm.path = got.path;
  // Filled once per folder: the folder's own binding fixes the agent and
  // proposes the floor; an unbound folder asks for a name, on the floor the
  // dialog was opened from. Typed values survive a redraw, not a new folder.
  if (fm.prefilled !== fm.path) {
    const b = got.self?.bound ?? null;
    fm.agent = b ? b.agent : '';
    if (b) fm.channel = b.channel;
    else if (fm.wantChannel) fm.channel = fm.wantChannel;
    fm.prefilled = fm.path;
  }
}

/** Copy what is in the boxes into ui.deskForm, so a redraw keeps it. */
function readDeskForm() {
  const fm = ui.deskForm;
  if (!fm) return;
  const v = (id) => el.dlgBody.querySelector(`#${id}`)?.value;
  if (v('desk-host') !== undefined) fm.hostId = v('desk-host') || null;
  if (v('desk-channel') !== undefined) fm.channel = v('desk-channel') || null;
  if (v('desk-new-channel') !== undefined) fm.newChannel = v('desk-new-channel') ?? '';
  if (v('desk-agent') !== undefined) fm.agent = v('desk-agent') ?? '';
}

const agoText = (isoStr) => {
  if (!isoStr) return 'never opened';
  const s = Math.max(0, (Date.now() - Date.parse(isoStr)) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

/** The path from the root to here, one crumb per folder. */
function crumbsOf(root, path) {
  const base = root && path.startsWith(root) ? root : path;
  const rest = path.slice(base.length).split('/').filter(Boolean);
  const out = [{ name: base.split('/').filter(Boolean).pop() ?? base, path: base }];
  let p = base;
  for (const part of rest) {
    p = `${p}/${part}`;
    out.push({ name: part, path: p });
  }
  return out;
}

function renderDeskDialog() {
  const fm = ui.deskForm;
  if (!fm) return;
  const hosts = fm.hosts ?? [];
  const liveHosts = hosts.filter((h) => h.live);
  const host = hosts.find((h) => h.host_id === fm.hostId) ?? null;
  const L = fm.listing && !fm.listing.error ? fm.listing : null;
  const self = L?.self ?? null;
  const bound = self?.bound ?? null;
  const channelNow = fm.channel === '__new__' ? fm.newChannel.trim() : fm.channel;
  const mode = !bound ? 'take' : bound.channel === channelNow ? 'import' : 'move';
  const channels = [...new Set([...(ui.state?.channels ?? []).map((c) => c.channel), ...(fm.channel && fm.channel !== '__new__' ? [fm.channel] : [])])].sort();
  if (!fm.channel && channels.length) fm.channel = channels[0];
  const crumbs = L ? crumbsOf(L.root, L.path) : [];
  const dirs = L?.entries ?? [];
  const recent = recentFolders(host?.folders);
  const name = savedName(fm.names, fm.agent);
  // Which picker is drawn: the host's own dialog behind a button, or the
  // page's list — for a host with no dialog, and for one whose dialog failed.
  const native = host?.dialog === true && !fm.listMode;
  const onHost = hosts.length > 1 ? ` on ${esc(host?.name ?? '')}` : '';
  const pickState = fm.picking === 'asking' ? `Asking ${esc(host?.name ?? 'the host')} to open its folder dialog…`
    : fm.picking === 'open' ? `The folder dialog is open on ${esc(host?.name ?? 'the host')} — choose there.`
    : fm.waiting ? 'looking…'
    : fm.pickNote ? esc(fm.pickNote)
    : '';

  const title = mode === 'import' ? `Bring ${esc(self.name)} onto the floor` : mode === 'move' ? `Move ${esc(bound.agent)} to ${esc(channelNow || '…')}` : 'Take a desk';
  const primary = mode === 'import' ? 'Bring onto the floor' : mode === 'move' ? `Move to ${esc(channelNow || '…')}` : 'Take desk';
  const dirRow = (f) => {
    const marks = [
      f.bound && !f.other_board ? `${f.bound.channel} / ${f.bound.agent}` : null,
      f.other_board ? 'another board' : null,
      f.sessions > 0 ? 'opened by Claude' : null,
    ].filter(Boolean);
    return `<button type="button" class="dir-row" data-go="${esc(f.path)}" title="Open ${esc(f.name)}"><span class="dir-name">${esc(f.name)}</span><span class="dir-marks">${marks.map(esc).join(' · ')}</span></button>`;
  };
  // A recent folder carries its path as well as its name — a name alone is
  // what made the old flat list unreadable — and opens like any other row,
  // except that a path which has gone leaves the picker where it stands.
  const recentRow = (f) => {
    const marks = [
      f.bound ? `${f.bound.channel} / ${f.bound.agent}` : null,
      agoText(f.last_active),
    ].filter(Boolean);
    return `<button type="button" class="dir-row recent-row" data-go="${esc(f.path)}" data-recent="1" title="Open ${esc(f.path)}"><span class="recent-what"><span class="dir-name">${esc(f.name)}</span><span class="recent-path mono"><bdi>${esc(f.path)}</bdi></span></span><span class="dir-marks">${marks.map(esc).join(' · ')}</span></button>`;
  };
  // What the folder you are standing in says about itself: the sentence the
  // form is filled from, so the two can never disagree.
  let here = '';
  if (self) {
    const where = bound?.scope === 'project' ? 'its .mcp.json' : "Claude Code's local scope";
    if (self.other_board) here = `<b>${esc(self.name)}</b> is bound to <span class="mono">${esc(self.other_board)}</span>, not this board. Change it there.`;
    else if (bound) here = `<b>${esc(self.name)}</b> is <span class="mono">${esc(bound.agent)}</span> on <span class="mono">${esc(bound.channel)}</span>, according to ${where}.`;
    else here = `<b>${esc(self.name)}</b> is not a desk yet.${self.sessions > 0 ? ` Claude Code has opened it before (${self.sessions} conversation${self.sessions === 1 ? '' : 's'}).` : ''}`;
  }
  const notes = [];
  if (fm.error) notes.push(`<b>${esc(fm.error)}</b>`);
  else if (fm.hosts === null) notes.push('Reading the host list…');
  else if (!hosts.length) notes.push('No host is registered on this board, so there is nobody to bind a folder. Install the host on a machine that has the repos.');
  else if (!liveHosts.length) notes.push('Every host on this board is offline right now.');
  else if (fm.listing?.error) notes.push(`<b>${esc(fm.listing.error)}</b>`);
  if (self && !self.other_board) {
    if (mode === 'take') {
      notes.push(`Binds this folder as the agent you name, on the floor you pick, and opens a window there. Nothing in the folder is edited.${self.trusted ? '' : ' Claude Code has not opened it before, so its window will ask the folder-trust question — on the desk, for you to answer.'}`);
    } else if (mode === 'import') {
      notes.push(`Brings it onto the floor as it is. The binding moves into Claude Code's local scope${bound.scope === 'project' ? ' and the orchestratinator entry comes out of its .mcp.json (other servers stay)' : ''}. A window already open there is not touched.`);
    } else {
      notes.push(`Moves it: rebinds the folder as <span class="mono">${esc(bound.agent)}</span> on <span class="mono">${esc(channelNow)}</span>, and if the floor holds its window, closes it and reopens it on the same conversation. Its seat leaves <span class="mono">${esc(bound.channel)}</span>. Refused while a turn is running.`);
    }
  }
  const canGo = !!(host?.live && self && !self.other_board && channelNow && fm.agent.trim() && !fm.waiting && !fm.picking);
  openDialog(`
    <div class="dlg-head"><h3>${title}</h3></div>
    <p class="dlg-sub">${native ? 'choose' : 'open'} the folder your agent lives in, then pick its floor</p>
    ${hosts.length > 1 ? `
    <label class="field">
      <span>Host</span>
      <select id="desk-host" class="input">
        ${hosts.map((h) => `<option value="${esc(h.host_id)}"${h.host_id === fm.hostId ? ' selected' : ''}${h.live ? '' : ' disabled'}>${esc(h.name)}${h.live ? '' : ' — offline'}</option>`).join('')}
      </select>
    </label>` : ''}
    ${recent.length ? `
    <div class="dlg-recent-head">Recently opened</div>
    <div class="dlg-dirs dlg-recent" role="list" aria-label="Recently opened">
      ${recent.map(recentRow).join('')}
    </div>` : ''}
    ${native ? `
    <div class="desk-pick">
      <button type="button" class="btn" data-do="desk-pick"${host?.live && !fm.picking && !fm.waiting ? '' : ' disabled'}>${L ? 'Choose another folder' : 'Choose folder'}${onHost}…</button>
      <span class="muted desk-pick-state">${pickState}</span>
    </div>
    ${L ? `<p class="desk-chosen mono" title="${esc(L.path)}"><bdi>${esc(L.path)}</bdi></p>` : ''}` : `
    ${fm.pickError ? `<p class="dlg-note desk-pick-failed"><b>${esc(fm.pickError)}</b> Its folders are listed here instead.</p>` : ''}
    <div class="dlg-crumbs" aria-label="Where you are">
      ${crumbs.map((c, i) => `${i ? '<span class="sep">/</span>' : ''}<button type="button" class="crumb${i === crumbs.length - 1 ? ' here' : ''}"${i === crumbs.length - 1 ? ' disabled' : ` data-go="${esc(c.path)}"`}>${esc(c.name)}</button>`).join('')}
      ${fm.waiting ? '<span class="muted">· looking…</span>' : ''}
    </div>
    <div class="dlg-dirs" role="list">
      ${dirs.length ? dirs.map(dirRow).join('') : `<div class="dir-empty">${fm.listing === null ? (fm.waiting ? 'Asking the host…' : '') : 'No folders inside this one.'}</div>`}
    </div>
    <div class="desk-folder-meta">
      <span>${L ? `${dirs.length} folder${dirs.length === 1 ? '' : 's'} in ${esc(crumbs[crumbs.length - 1]?.name ?? '')}` : ''}</span>
      <button type="button" class="btn" data-do="desk-look" title="Ask the host to look at this folder again now"${fm.waiting || !host?.live ? ' disabled' : ''}>Look again</button>
      ${host?.dialog ? `<button type="button" class="btn" data-do="desk-pick" title="Ask the host to open its own folder dialog again"${fm.waiting || !host?.live ? ' disabled' : ''}>Folder dialog…</button>` : ''}
    </div>`}
    <p class="dlg-self">${here || '&nbsp;'}</p>
    <label class="field">
      <span>Agent${bound ? ' — set by the folder' : ''}</span>
      <input id="desk-agent" class="input" type="text" maxlength="64" value="${esc(fm.agent)}" placeholder="developer" autocomplete="off" spellcheck="false"${bound ? ' readonly' : ''}>
    </label>
    <label class="field">
      <span>Floor</span>
      <select id="desk-channel" class="input">
        ${channels.map((c) => `<option value="${esc(c)}"${c === fm.channel ? ' selected' : ''}>${esc(c)}</option>`).join('')}
        <option value="__new__"${fm.channel === '__new__' ? ' selected' : ''}>new floor…</option>
      </select>
    </label>
    ${fm.channel === '__new__' ? `
    <label class="field">
      <span>New floor's name</span>
      <input id="desk-new-channel" class="input" type="text" maxlength="64" value="${esc(fm.newChannel)}" placeholder="my-project" autocomplete="off" spellcheck="false">
    </label>` : ''}
    <div class="field desk-name">
      <span>Name</span>
      <output id="desk-name" class="desk-name-read${name ? '' : ' none'}" title="The name saved for this agent on the board">${name ? esc(name) : 'none'}</output>
    </div>
    <p class="dlg-note">${notes.join(' ') || '&nbsp;'}</p>
    <div class="dlg-foot">
      <button type="button" class="btn" data-do="cancel">Cancel</button>
      <button type="button" class="btn primary" data-do="desk-take"${canGo ? '' : ' disabled'}>${primary}</button>
    </div>
  `);
}

/** Leave a desk: a confirmation that says exactly what goes and what stays. */
function leaveDeskDialog(channel, agent, persona, scope) {
  ui.dlgCtx = { kind: 'leave', channel, agent };
  const where = scope === 'local' ? "Claude Code's local scope" : scope === 'project' ? 'its .mcp.json' : 'wherever it is bound';
  openDialog(`
    <div class="dlg-head"><h3>Leave desk — ${esc(persona ?? agent)}</h3></div>
    <p class="dlg-sub">on <span class="mono">${esc(channel)}</span> · <span class="mono">${esc(agent)}</span></p>
    <p class="dlg-note">
      Removes this desk's binding (${esc(where)}) and closes the floor's window there. The folder and its
      conversations stay where they are. The seat stays on the floor as not hosted — remove the agent from the
      board if it is gone for good. A chat open in your editor keeps running, without the board.
    </p>
    <div class="dlg-foot">
      <button type="button" class="btn" data-do="cancel">Cancel</button>
      <button type="button" class="btn danger" data-do="desk-leave" data-channel="${esc(channel)}" data-agent="${esc(agent)}">Leave desk</button>
    </div>
  `);
}

// Opening a folder — a row, or a crumb back up the path.
el.dlgBody.addEventListener('click', (e) => {
  if (ui.dlgCtx?.kind !== 'desk') return;
  const go = e.target.closest('[data-go]');
  if (!go || go.disabled) return;
  readDeskForm();
  browseTo(go.dataset.go, { keep: go.dataset.recent === '1' });
});
// A choice redraws the take-a-desk dialog (the title, the note and the button
// depend on it); typing only records itself, so the caret is never taken away
// mid-word. Changing host starts the picker again at that host's root.
el.dlgBody.addEventListener('change', (e) => {
  if (ui.dlgCtx?.kind !== 'desk') return;
  if (!e.target.matches('#desk-host, #desk-channel')) return;
  readDeskForm();
  if (e.target.matches('#desk-host')) {
    const fm = ui.deskForm;
    fm.listing = null;
    fm.prefilled = null;
    fm.path = null;
    fm.picking = null;
    fm.listMode = false;
    fm.pickError = null;
    fm.pickNote = null;
    // Whatever was being waited for was the other host's: its loop sees the
    // seq move and stops, and nothing else would ever clear the flag — which
    // left the new host's button disabled and saying "looking…" for good.
    fm.waiting = false;
    fm.seq++;
    // Another machine: its own dialog waits to be asked for, its list does not.
    if ((fm.hosts ?? []).find((h) => h.host_id === fm.hostId)?.dialog) renderDeskDialog();
    else browseTo(null);
    return;
  }
  renderDeskDialog();
});
el.dlgBody.addEventListener('input', (e) => {
  if (ui.dlgCtx?.kind !== 'desk') return;
  if (!e.target.matches('#desk-agent, #desk-new-channel')) return;
  readDeskForm();
  const fm = ui.deskForm;
  // The name follows the id as it is typed, without a redraw: an unbound
  // folder's agent is whatever is in the box, and so is whose name this is.
  const shown = el.dlgBody.querySelector('#desk-name');
  if (shown) {
    const name = savedName(fm.names, fm.agent);
    shown.textContent = name ?? 'none';
    shown.classList.toggle('none', !name);
  }
  const channelNow = fm.channel === '__new__' ? fm.newChannel.trim() : fm.channel;
  const go = el.dlgBody.querySelector('[data-do="desk-take"]');
  if (go && !go.dataset.held) go.disabled = !(fm.listing?.self && !fm.listing.self.other_board && channelNow && fm.agent.trim() && !fm.waiting && !fm.picking);
});

/* ---------- sessions: what a row says ---------- */

/**
 * How long a conversation ran, from the first thing the person said to the
 * last thing anybody said — or null when either end is missing or the two
 * are the wrong way round, which is no length at all rather than a guess.
 *
 * Wall-clock, not working time: a conversation picked up again the next
 * morning is a day long, and that is the true answer to "how long has this
 * one been going".
 */
function spanText(startIso, endIso) {
  const a = Date.parse(startIso ?? '');
  const b = Date.parse(endIso ?? '');
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  const mins = Math.floor((b - a) / 60000);
  if (mins < 1) return 'under a minute';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return mins % 60 ? `${hours}h ${mins % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/**
 * The detail under a row's title: how long it ran, its branch, its model —
 * each only when the transcript said, in that order. A row with none of the
 * three (a tab opened and closed, nothing said) has no detail line at all,
 * not three dashes.
 */
function sessionDetail(r) {
  const span = spanText(r?.started_at, r?.last_at);
  const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return [span ? `${span} long` : null, text(r?.branch), text(r?.model)].filter(Boolean);
}

/* ---------- sessions: the dialog ---------- */

/**
 * The session picker: a folder's recent conversations, for the desk's window
 * to be reopened on — or a fresh one. The last of the three doors the floor
 * opens without a terminal (start, resume, move), and the smallest surface
 * that proves a reopen.
 *
 * The list is the host's. It is asked for when the dialog opens, and the
 * dialog polls the GET each second until the host's time on the list moves —
 * eight seconds, then it says the host did not answer — drawing whatever list
 * it already has meanwhile, because a list a minute old beats a spinner. Rows
 * the board cannot act on are drawn disabled with the reason as their title:
 * the conversation the desk is on now, and one an editor holds, since a
 * resume closes a window the floor must hold. The filter is by title only
 * (decided 2026-09-08); there is no search of what was said.
 *
 * Each row says, under its title, how long the conversation ran, the branch
 * it was last on and the model it last spoke with — read by the host off the
 * transcript itself, so a conversation the hook never reported has them too.
 *
 * Kind 'sessions' is in refreshDialog's skip list, and typing redraws only
 * the rows: the poll must never take the caret out of the filter box.
 */
function sessionDialog(channel, agent, persona) {
  ui.dlgCtx = { kind: 'sessions', channel, agent };
  ui.sessForm = {
    channel, agent, persona: persona ?? agent,
    rows: null, at: null, current: null, editorPid: null,
    filter: '', waiting: true, error: null, note: null,
  };
  renderSessionDialog();
  askSessions();
}

async function readSessions(fm) {
  const res = await fetch(`./api/floor/sessions?channel=${encodeURIComponent(fm.channel)}&agent=${encodeURIComponent(fm.agent)}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

function takeSessions(fm, got) {
  fm.rows = Array.isArray(got.rows) ? got.rows : [];
  fm.at = got.at ?? null;
  fm.current = got.current ?? null;
  fm.editorPid = got.editor_pid ?? null;
}

async function askSessions() {
  const fm = ui.sessForm;
  if (!fm) return;
  fm.waiting = true;
  fm.error = null;
  fm.note = null;
  const mine = () => ui.dlgCtx?.kind === 'sessions' && ui.sessForm === fm;
  let before = null;
  try {
    const held = await readSessions(fm);
    before = held.at ?? null;
    takeSessions(fm, held);
    if (mine()) renderSessionDialog();
    const asked = await floorPost('sessions', { channel: fm.channel, agent: fm.agent });
    // Within the host's throttle the list in hand is the answer — seconds old.
    if (asked.asked === false) { fm.waiting = false; if (mine()) renderSessionDialog(); return; }
  } catch (e) {
    fm.waiting = false;
    fm.error = String(e.message ?? e);
    if (mine()) renderSessionDialog();
    return;
  }
  for (let i = 0; i < 8 && mine(); i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (!mine()) return;
    const got = await readSessions(fm).catch(() => null);
    if (got && got.at && got.at !== before) {
      takeSessions(fm, got);
      fm.waiting = false;
      renderSessionDialog();
      return;
    }
  }
  if (!mine()) return;
  fm.waiting = false;
  fm.note = fm.rows?.length ? `The host did not answer in 8 s — this list is from ${agoText(fm.at)}.` : 'The host did not answer in 8 s.';
  renderSessionDialog();
}

/** The floor's stream heard a host list sessions: read it now rather than at the next second. */
function sessionsArrived() {
  const fm = ui.sessForm;
  if (!fm || ui.dlgCtx?.kind !== 'sessions') return;
  readSessions(fm).then((got) => {
    if (ui.sessForm !== fm) return;
    takeSessions(fm, got);
    fm.waiting = false;
    fm.note = null;
    renderSessionDialog();
  }).catch(() => { /* the poll in askSessions will say so */ });
}

const EDITOR_HOLDS = 'This conversation is open in your editor. Close it there first — one app holds a conversation at a time.';

function sessionRowsHtml(fm) {
  const rows = fm.rows ?? [];
  const q = fm.filter.trim().toLowerCase();
  const shown = q ? rows.filter((r) => (r.title ?? '').toLowerCase().includes(q)) : rows;
  if (!shown.length) {
    const why = fm.rows === null ? 'Reading…'
      : !rows.length ? (fm.waiting ? 'Asking the host…' : 'Claude Code has not opened this folder yet, so there is nothing to resume. Start new opens its first conversation.')
      : 'No title matches.';
    return `<p class="muted sess-empty">${esc(why)}</p>`;
  }
  return shown.map((r) => {
    const current = r.id === fm.current;
    const editor = r.held === 'editor';
    const why = current ? 'This is the conversation on the desk now.' : editor ? EDITOR_HOLDS : 'Reopen the desk\'s window on this conversation';
    const title = r.title ?? (r.spoken ? '(untitled)' : '(nothing said yet)');
    const marks = [
      current ? 'current' : null,
      r.live && !current ? (editor ? 'in your editor' : 'open') : null,
      r.title_source === 'custom' ? 'named' : null,
    ].filter(Boolean);
    const detail = sessionDetail(r);
    return `<button type="button" class="sess-row${current ? ' current' : ''}" data-do="session-resume" data-id="${esc(r.id)}" title="${esc(why)}"${current || editor ? ' disabled' : ''}>
      <span class="sess-title">${esc(title)}</span>
      <span class="sess-meta">${esc(agoText(r.last_at ?? r.modified_at))}${marks.length ? ` · ${marks.map(esc).join(' · ')}` : ''}</span>
      ${detail.length ? `<span class="sess-detail">${detail.map(esc).join(' · ')}</span>` : ''}
    </button>`;
  }).join('');
}

function sessionCountText(fm) {
  const rows = fm.rows ?? [];
  const q = fm.filter.trim().toLowerCase();
  const shown = q ? rows.filter((r) => (r.title ?? '').toLowerCase().includes(q)) : rows;
  const n = rows.length;
  const base = n === 1 ? '1 conversation' : `${n} conversations`;
  return `${q ? `${shown.length} of ${base}` : base} · newest first${fm.at ? ` · listed ${agoText(fm.at)}` : ''}`;
}

function renderSessionDialog() {
  const fm = ui.sessForm;
  if (!fm) return;
  const notes = [];
  if (fm.error) notes.push(`<b>${esc(fm.error)}</b>`);
  else if (fm.waiting) notes.push('Asking the host for a fresh list…');
  else if (fm.note) notes.push(esc(fm.note));
  notes.push('Picking one closes the desk\'s window and reopens it with <span class="mono">--resume</span>; the conversation carries on where it left off. Refused while a turn is running.');
  openDialog(`
    <div class="dlg-head"><h3>Sessions — ${esc(fm.persona)}</h3></div>
    <p class="dlg-sub">on <span class="mono">${esc(fm.channel)}</span> · <span class="mono">${esc(fm.agent)}</span> · this folder's conversations</p>
    <label class="field">
      <span>Filter by title</span>
      <input id="sess-filter" class="input" type="text" value="${esc(fm.filter)}" placeholder="part of a title" autocomplete="off" spellcheck="false">
    </label>
    <div class="dlg-sessions" role="list" aria-label="Conversations">${sessionRowsHtml(fm)}</div>
    <div class="desk-folder-meta">
      <span class="sess-count">${esc(sessionCountText(fm))}</span>
      <button type="button" class="btn" data-do="session-look" title="Ask the host to list this folder's conversations again now">Look again</button>
    </div>
    <p class="dlg-note">${notes.join(' ')}</p>
    <div class="dlg-foot">
      <button type="button" class="btn" data-do="cancel">Close</button>
      <button type="button" class="btn primary" data-do="session-new" title="Close the desk's window and open a fresh conversation in this folder">Start new</button>
    </div>
  `);
}

// Typing in the filter redraws the rows and the count, never the box.
el.dlgBody.addEventListener('input', (e) => {
  if (ui.dlgCtx?.kind !== 'sessions' || !e.target.matches('#sess-filter')) return;
  const fm = ui.sessForm;
  if (!fm) return;
  fm.filter = e.target.value;
  const list = el.dlgBody.querySelector('.dlg-sessions');
  if (list) list.innerHTML = sessionRowsHtml(fm);
  const count = el.dlgBody.querySelector('.sess-count');
  if (count) count.textContent = sessionCountText(fm);
});

/* ---------- history: what the dialog says about its answer ---------- */

/**
 * Which hosts an answer covers, in words — the line under the list.
 *
 * History is read off each host's own disk, so an answer is only ever about
 * the hosts that gave one, and the ones that did not are the part somebody
 * would otherwise assume was searched. Each is named: answered (with how
 * much it read, for a search), failed and what it said, asked and not yet
 * back, on the board but not asked, and offline — whose conversations are
 * simply not in this list.
 */
function coverageText(hosts, kind = 'recent') {
  // No answer read yet is not "no hosts": it says nothing until it knows.
  if (!Array.isArray(hosts)) return [];
  const list = hosts;
  const names = (xs) => xs.map((h) => h.name).join(', ');
  const out = [];
  const answered = list.filter((h) => h.at && !h.error);
  const failed = list.filter((h) => h.error);
  const waiting = list.filter((h) => h.live && h.asked && !h.at && !h.error);
  const unasked = list.filter((h) => h.live && !h.asked);
  const offline = list.filter((h) => !h.live);
  if (answered.length) {
    out.push(kind === 'search'
      ? answered.map((h) => `${h.name} read ${h.files ?? '?'} conversation${h.files === 1 ? '' : 's'}${Number.isFinite(h.ms) ? ` in ${(h.ms / 1000).toFixed(1)} s` : ''}`).join(', ')
      : `from ${names(answered)}`);
  }
  for (const h of failed) out.push(`${h.name}: ${h.error}`);
  if (waiting.length) out.push(`waiting for ${names(waiting)}`);
  if (unasked.length) out.push(`${names(unasked)} ${unasked.length === 1 ? 'has' : 'have'} not been asked`);
  if (offline.length) out.push(`${names(offline)} ${offline.length === 1 ? 'is' : 'are'} offline — ${offline.length === 1 ? 'its' : 'their'} conversations are not covered`);
  if (!list.length) out.push('no host is on this board, and the conversations are on the hosts\' disks');
  return out;
}

/** "3 turns matched", and "100 or more" is not claimed: the count is the host's. */
function hitsText(n) {
  const k = Math.max(0, Number(n) || 0);
  return `${k} turn${k === 1 ? '' : 's'} matched`;
}

/**
 * A snippet with every occurrence of the search marked. `safe` is the
 * escaper: the text is escaped piece by piece around the matches, so a
 * snippet that contains markup is drawn as the characters it is.
 */
function markHits(text, query, safe) {
  const t = String(text ?? '');
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return safe(t);
  const low = t.toLowerCase();
  let out = '';
  let from = 0;
  for (;;) {
    const at = low.indexOf(q, from);
    if (at < 0) break;
    out += `${safe(t.slice(from, at))}<mark>${safe(t.slice(at, at + q.length))}</mark>`;
    from = at + q.length;
  }
  return out + safe(t.slice(from));
}

/* ---------- history: the dialog ---------- */

/**
 * History: every desk's conversations in one list, the most recently spoken
 * in first, with a search of what was said in them over the top.
 *
 * Both are the hosts' — read off the transcripts on each machine, because
 * the board's own copy is a tail and its session table has no titles (the
 * numbers are in host/history.js). So this dialog asks, and waits: the list
 * it already holds is drawn at once, and the line under it says which hosts
 * the answer is from and which it is not. A search is asked for with Enter
 * or the button, never per keystroke — it is a walk of every transcript on
 * every host — and by default it looks at what the person and the agent
 * said; the switch adds tool calls, thoughts and subagents.
 *
 * A row opens that conversation to read, in its own desk's panel on the
 * floor (window.floorRead). It does not resume it: nothing here moves a desk
 * onto a conversation — that stays the Sessions dialog's, on the desk.
 */
function historyDialog() {
  ui.dlgCtx = { kind: 'history' };
  ui.histForm = { hosts: null, rows: null, query: '', deep: false, search: null, waiting: true, error: null, note: null, seq: 0 };
  renderHistoryDialog();
  askRecent();
}

async function getHistory(path) {
  const res = await fetch(`./api/floor/history/${path}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

/** Ask every host for its recent conversations, and read until each has answered. */
async function askRecent() {
  const fm = ui.histForm;
  if (!fm) return;
  const seq = ++fm.seq;
  const mine = () => ui.dlgCtx?.kind === 'history' && ui.histForm === fm && fm.seq === seq;
  fm.waiting = true;
  fm.error = null;
  fm.note = null;
  fm.search = null;
  try {
    const held = await getHistory('recent');
    if (!mine()) return;
    fm.hosts = held.hosts;
    fm.rows = held.rows;
    renderHistoryDialog();
    const before = new Map(held.hosts.map((h) => [h.host_id, h.at]));
    const asked = await floorPost('history/recent', {});
    // Inside the throttle nobody is asked, and the list in hand is seconds old.
    if (!asked.asked?.length) { fm.waiting = false; if (mine()) renderHistoryDialog(); return; }
    for (let i = 0; i < 12 && mine(); i++) {
      await new Promise((r) => setTimeout(r, 700));
      if (!mine()) return;
      const got = await getHistory('recent').catch(() => null);
      if (!got) continue;
      fm.hosts = got.hosts;
      fm.rows = got.rows;
      const pending = got.hosts.filter((h) => h.live && h.asked && h.at === before.get(h.host_id));
      if (!pending.length) { fm.waiting = false; renderHistoryDialog(); return; }
      renderHistoryDialog();
    }
    if (!mine()) return;
    fm.waiting = false;
    fm.note = 'Not every host answered in 8 s — the list is what the others gave.';
  } catch (e) {
    if (!mine()) return;
    fm.waiting = false;
    fm.error = String(e.message ?? e);
  }
  renderHistoryDialog();
}

/** Search what was said: asked once, on Enter or the button, and read until every host has answered. */
async function runHistorySearch() {
  const fm = ui.histForm;
  if (!fm) return;
  const query = fm.query.trim();
  // An empty box is the way back to the recent list.
  if (!query) { fm.search = null; fm.seq++; renderHistoryDialog(); return; }
  const seq = ++fm.seq;
  const mine = () => ui.dlgCtx?.kind === 'history' && ui.histForm === fm && fm.seq === seq;
  fm.search = { query, deep: fm.deep, hosts: null, rows: [], done: false };
  fm.waiting = true;
  fm.error = null;
  fm.note = null;
  renderHistoryDialog();
  try {
    const asked = await floorPost('history/search', { query, deep: fm.deep });
    for (let i = 0; i < 60 && mine(); i++) {
      const got = await getHistory(`search?id=${encodeURIComponent(asked.id)}`);
      if (!mine()) return;
      fm.search = { query: got.query, deep: got.deep, hosts: got.hosts, rows: got.rows, done: got.done };
      if (got.done) { fm.waiting = false; renderHistoryDialog(); return; }
      renderHistoryDialog();
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!mine()) return;
    fm.waiting = false;
    fm.note = 'Not every host answered in 30 s — these are the results from the ones that did.';
  } catch (e) {
    if (!mine()) return;
    fm.waiting = false;
    fm.error = String(e.message ?? e);
  }
  renderHistoryDialog();
}

function historyRowsHtml(fm) {
  const searching = !!fm.search;
  const rows = (searching ? fm.search.rows : fm.rows) ?? [];
  const manyHosts = new Set(rows.map((r) => r.host_id)).size > 1;
  if (!rows.length) {
    const why = searching
      ? (fm.waiting ? 'Searching…' : `Nothing ${fm.search.deep ? 'in any conversation' : 'anybody said'} matches “${fm.search.query}”.${fm.search.deep ? '' : ' Tool calls and thinking were not searched.'}`)
      : (fm.rows === null || fm.waiting ? 'Asking the hosts…' : 'No conversations yet.');
    return `<p class="muted sess-empty">${esc(why)}</p>`;
  }
  return rows.map((r) => {
    const title = r.title ?? (r.spoken ? '(untitled)' : '(nothing said yet)');
    const marks = [
      `${r.persona ?? r.agent} · ${r.channel}/${r.agent}`,
      manyHosts ? r.host : null,
      agoText(r.last_at ?? r.modified_at),
      r.live ? (r.held === 'editor' ? 'in your editor' : 'open') : null,
    ].filter(Boolean);
    const detail = sessionDetail(r);
    const snips = searching ? (r.snippets ?? []).map((sn) => {
      const who = sn.role === 'user' ? 'you' : sn.role === 'assistant' ? (sn.via ? `agent · ${sn.via}` : 'agent') : sn.role;
      return `<span class="hist-snip"><b>${esc(who)}</b> ${markHits(sn.text, fm.search.query, esc)}</span>`;
    }).join('') : '';
    return `<button type="button" class="sess-row hist-row" data-do="history-read" data-channel="${esc(r.channel)}" data-agent="${esc(r.agent)}" data-id="${esc(r.id)}" data-title="${esc(r.title ?? '')}" title="Open this conversation to read, in ${esc(r.persona ?? r.agent)}'s panel — it is not resumed">
      <span class="sess-title">${esc(title)}</span>
      <span class="sess-meta">${marks.map(esc).join(' · ')}</span>
      ${detail.length ? `<span class="sess-detail">${detail.map(esc).join(' · ')}</span>` : ''}
      ${searching ? `<span class="hist-hits">${esc(hitsText(r.hits))}</span>${snips}` : ''}
    </button>`;
  }).join('');
}

function renderHistoryDialog() {
  const fm = ui.histForm;
  if (!fm) return;
  const searching = !!fm.search;
  const rows = (searching ? fm.search.rows : fm.rows) ?? [];
  const hosts = searching ? fm.search.hosts : fm.hosts;
  const count = searching
    ? `${rows.length} conversation${rows.length === 1 ? '' : 's'} ${fm.search.deep ? 'with a match, tool calls and thinking included' : 'where somebody said it'}`
    : `${rows.length} conversation${rows.length === 1 ? '' : 's'} · most recently spoken in first`;
  const notes = [];
  if (fm.error) notes.push(`<b>${esc(fm.error)}</b>`);
  else if (fm.waiting) notes.push(searching ? 'Searching every host\'s transcripts…' : 'Asking every host for a fresh list…');
  else if (fm.note) notes.push(esc(fm.note));
  notes.push('A row opens that conversation to read, in its desk\'s panel on the floor. It is not resumed — to put a desk on one, use that desk\'s Sessions.');
  const cover = coverageText(hosts, searching ? 'search' : 'recent').join(' · ');
  // An answer arriving redraws the list and the lines under it, never the
  // box: the hosts answer on their own clocks, and a redraw of the whole
  // dialog every poll would take the caret out of a search being typed.
  const mode = searching ? 'search' : 'recent';
  const list = ui.dlgCtx?.kind === 'history' ? el.dlgBody.querySelector('.hist-rows') : null;
  if (list && fm.drawn === mode) {
    list.innerHTML = historyRowsHtml(fm);
    el.dlgBody.querySelector('.hist-count').textContent = count;
    el.dlgBody.querySelector('.hist-cover').textContent = cover;
    el.dlgBody.querySelector('.dlg-note').innerHTML = notes.join(' ');
    return;
  }
  fm.drawn = mode;
  const hadFocus = document.activeElement?.id === 'hist-query';
  openDialog(`
    <div class="dlg-head"><h3>History</h3></div>
    <p class="dlg-sub">every desk's conversations, read off the hosts' own transcripts</p>
    <div class="hist-search">
      <input id="hist-query" class="input" type="search" value="${esc(fm.query)}" placeholder="search what was said" autocomplete="off" spellcheck="false" maxlength="200">
      <button type="button" class="btn" data-do="history-search">Search</button>
    </div>
    <label class="hist-deep"><input type="checkbox" id="hist-deep"${fm.deep ? ' checked' : ''}> include tool calls and thinking</label>
    <div class="dlg-sessions hist-rows" role="list" aria-label="${searching ? 'Search results' : 'Recent conversations'}">${historyRowsHtml(fm)}</div>
    <div class="desk-folder-meta">
      <span class="hist-count">${esc(count)}</span>
      ${searching
        ? '<button type="button" class="btn" data-do="history-clear" title="Leave the search and show the recent list">Back to recent</button>'
        : '<button type="button" class="btn" data-do="history-look" title="Ask every host for its recent conversations again now">Look again</button>'}
    </div>
    <p class="hist-cover muted">${esc(cover)}</p>
    <p class="dlg-note">${notes.join(' ')}</p>
    <div class="dlg-foot">
      <button type="button" class="btn" data-do="cancel">Close</button>
    </div>
  `);
  if (hadFocus) {
    const box = el.dlgBody.querySelector('#hist-query');
    box?.focus();
    box?.setSelectionRange(box.value.length, box.value.length);
  }
}

// What is typed, and the switch, live in ui.histForm so a redraw keeps them.
el.dlgBody.addEventListener('input', (e) => {
  if (ui.dlgCtx?.kind !== 'history' || !ui.histForm) return;
  if (e.target.matches('#hist-query')) ui.histForm.query = e.target.value;
  if (e.target.matches('#hist-deep')) ui.histForm.deep = e.target.checked;
});
// Enter in the box searches. Typing alone does not: a search is a walk of
// every transcript on every host, and one per keystroke would be a dozen.
el.dlgBody.addEventListener('keydown', (e) => {
  if (ui.dlgCtx?.kind !== 'history' || e.key !== 'Enter' || !e.target.matches('#hist-query')) return;
  e.preventDefault();
  runHistorySearch();
});

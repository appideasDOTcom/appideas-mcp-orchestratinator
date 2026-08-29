/**
 * What the board says about an agent, in a form the floor can draw too.
 *
 * This started life inside web.js, where it was the board's private business.
 * It moved here the moment the floor needed to show the same facts on a desk:
 * two surfaces deriving "is this agent working or idle" from the same columns
 * by different code is exactly the drift this repo spends its comments warning
 * about. Both callers now import the derivation rather than reimplement it, so
 * a desk and its row on the board cannot disagree about what an agent is doing.
 *
 * Nothing here reads the clock on its own — callers pass `nowMs` so a single
 * response is internally consistent, rather than aging by a millisecond
 * between the first agent rendered and the last.
 */

// The agent told us its state, so map it straight to a chip tone rather than
// guessing from the words. `blocked` is deliberately distinct from `waiting`:
// waiting resolves on its own, blocked needs a human.
export const STATE_TONE = { working: 'busy', waiting: 'waiting', blocked: 'blocked', idle: 'idle' };

// Fallback expiry for statuses written before `status_expires_at` existed.
// Current writes carry their own expiry — see set_status's ttl_seconds.
export const LEGACY_STATUS_TTL_MINUTES = 30;

/** SQLite `datetime('now')` is UTC without a zone marker — make it a real ISO string. */
export const iso = (s) => (s ? `${String(s).replace(' ', 'T')}Z` : null);

export const ageMinutes = (isoStr, nowMs) => (isoStr ? (nowMs - Date.parse(isoStr)) / 60000 : Infinity);

/** Group rows into a Map keyed by one column. */
export function index(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

// The same NUL-joined compound key both surfaces use — neither a channel nor an
// agent name can contain one, so a pair can never collide.
const NUL = String.fromCharCode(0);
export const agentKey = (channel, agent) => [channel, agent].join(NUL);

/**
 * Has this agent's self-reported status outlived the window it asked for?
 *
 * Prefer the expiry the agent chose; rows predating that column fall back to the
 * old server-wide window so they still age off.
 */
export function statusExpired(row, nowMs) {
  const expiresAt = iso(row.status_expires_at);
  if (expiresAt) return Date.parse(expiresAt) <= nowMs;
  return ageMinutes(iso(row.status_at), nowMs) > LEGACY_STATUS_TTL_MINUTES;
}

/**
 * Best-effort answer to "what is this agent doing right now?".
 *
 * A live self-reported status (via the `set_status` tool) always wins — only
 * the agent knows whether a quiet stretch is work, a wait, or a crash. Once it
 * expires we treat it as absent and infer from what the agent holds on the task
 * board and what's waiting in its mailbox.
 *
 * Note what is deliberately NOT inferred: nothing here reads a long gap since
 * `last_action` as "waiting". That gap looks identical whether the agent is
 * blocked, crashed, or finished and quiet, so it can only produce a confident
 * wrong answer.
 */
export function deriveState({ reported, reportedDetail, expired, claimed, assignedOpen, unread }) {
  if (reported && !expired) {
    return {
      label: reported,
      detail: reportedDetail ?? null,
      tone: STATE_TONE[reported] ?? 'busy',
      source: 'reported',
    };
  }
  // No age here on purpose: `reported_at` is the fact and the client derives the
  // age from it. Baking a minute-counter into this payload would change it every
  // minute and defeat the dashboard's re-render memo.
  const derived = (label, tone) => ({ label, detail: null, tone, source: 'derived' });
  if (claimed.length) {
    const t = claimed[0];
    return derived(
      claimed.length > 1 ? `working — ${claimed.length} claimed tasks` : `working — #${t.id} ${t.title}`,
      'busy'
    );
  }
  if (unread > 0) {
    return derived(`waiting — ${unread} unread message${unread === 1 ? '' : 's'}`, 'waiting');
  }
  if (assignedOpen > 0) {
    return derived(`waiting — ${assignedOpen} task${assignedOpen === 1 ? '' : 's'} assigned`, 'waiting');
  }
  return derived('idle', 'idle');
}

/**
 * The three per-agent workload queries, indexed once per response.
 *
 * Shared rather than rebuilt per caller for the same reason as the derivation:
 * `claimedTasks()` filtered on `claimed_by` in one file and on `assignee` in
 * another would give a desk and its board row different ideas of "working", and
 * that difference would be invisible until someone compared the two on screen.
 * The raw rows come back alongside the maps because the board needs buckets the
 * floor does not.
 */
export function agentLoadIndex(store) {
  const claimed = store.claimedTasks();
  const unread = store.unreadCounts();
  const load = store.agentTaskLoad();

  const claimedByAgent = index(claimed.filter((t) => t.claimed_by), (t) => agentKey(t.channel, t.claimed_by));
  const unreadByAgent = new Map(unread.map((r) => [agentKey(r.channel, r.agent), r.unread]));
  const unreadMaxByAgent = new Map(unread.map((r) => [agentKey(r.channel, r.agent), r.unread_max_id]));

  const assignedByAgent = new Map();
  const unassignedByChannel = new Map();
  for (const r of load) {
    if (r.bucket === 'unassigned') unassignedByChannel.set(r.channel, r.n);
    else if (r.agent) {
      const k = agentKey(r.channel, r.agent);
      assignedByAgent.set(k, { ...(assignedByAgent.get(k) ?? {}), [r.bucket]: r.n });
    }
  }

  return { claimed, unread, load, claimedByAgent, unreadByAgent, unreadMaxByAgent, assignedByAgent, unassignedByChannel };
}

/**
 * Everything the board shows about one agent in its row, as data.
 *
 * The board renders this as a chip plus a sub-line; the floor renders the same
 * fields as a rotating sign plus a pill tray. Same numbers, two depictions —
 * which only holds because they both come from here.
 */
export function agentBoard(row, idx, nowMs) {
  const k = agentKey(row.channel, row.agent);
  const claimed = idx.claimedByAgent.get(k) ?? [];
  const unread = idx.unreadByAgent.get(k) ?? 0;
  const assignedOpen = idx.assignedByAgent.get(k)?.assigned ?? 0;
  const expired = statusExpired(row, nowMs);

  return {
    state: deriveState({
      reported: row.status,
      reportedDetail: row.status_detail,
      expired,
      claimed,
      assignedOpen,
      unread,
    }),
    reported_status: row.status,
    reported_detail: row.status_detail ?? null,
    reported_at: iso(row.status_at),
    reported_expires_at: iso(row.status_expires_at),
    reported_expired: !!row.status && expired,
    last_action: row.last_action,
    last_action_at: iso(row.last_action_at),
    last_seen: iso(row.last_seen),
    unread,
    // The id "mark read" has to advance to. The browser echoes this back so a
    // message that arrives between render and click isn't swallowed.
    unread_max_id: idx.unreadMaxByAgent.get(k) ?? null,
    assigned_open: assignedOpen,
    claimed_tasks: claimed.map((t) => ({ id: t.id, title: t.title })),
  };
}

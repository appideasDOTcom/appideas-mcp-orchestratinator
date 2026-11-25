import { createHmac, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * A request relayed from somewhere else: the board's half of contract
 * `board.relay` (the service round, 2026-11-24; docs/service/board-relay.md).
 *
 * The board trusts its own machine. The page is open behind a CSRF lock, and
 * x-channel/x-agent are whatever a client says (src/auth.js). The desktop
 * app's relay hop reaches the board on loopback, so a request that came
 * through the service from a phone or a browser elsewhere would otherwise
 * read as the person at the keyboard. So the hop signs, on every relayed
 * request, who it is from (the service's operator for the Key that opened the
 * tunnel), and the board checks it here, ahead of every route.
 *
 * The rules, each the opposite of a way it could fail open:
 * - No secret (every Docker board): a request carrying either header is
 *   refused, never served as local. A forged header must not be quietly
 *   ignored, because ignored is "served as the keyboard".
 * - A secret that is set but short fails the start, as a typo'd auth mode
 *   does: a door that looks locked and is not is the failure to avoid.
 * - The HMAC key is the secret string's UTF-8 bytes as given, never decoded
 *   (desktop-dev, msg 4397): both sides sign the same bytes.
 * - The signature is compared in constant time, on the exact header string.
 * - A request with neither header is exactly as it was before this existed.
 *   On the app's board the hop is the only thing that adds one, and it
 *   strips any that came from outside.
 */
export const RELAY_HEADER = 'x-orch-relay';
export const RELAY_SIG_HEADER = 'x-orch-relay-sig';
/** At least 32 random bytes, which as hex is 64 characters and as base64url 43. */
const SECRET_MIN = 43;
const IAT_WINDOW_MS = 300_000;
const ROLES = new Set(['owner', 'guest']);
const BUILDINGS_MAX = 200;

/**
 * Actions that put something on the board machine's own screen: a terminal,
 * the editor, the native folder dialog, a browser for Claude's sign-in. A
 * remote operator is not in front of that screen, and the desk's Claude Code
 * would be ended to open it there. The page draws its own folder list where
 * the dialog is refused, so Take a desk still works remotely.
 */
export const LOCAL_ONLY = new Map([
  ['POST /api/floor/attach', 'Open in Claude opens a terminal on the computer the board runs on, and you are not at it. Keep working here, or open it when you are back at that computer.'],
  ['POST /api/floor/claude', 'Open in Claude opens a terminal on the computer the board runs on, and you are not at it. Keep working here, or open it when you are back at that computer.'],
  ['POST /api/floor/handback', 'Open in VS Code opens the editor on the computer the board runs on, and you are not at it. Keep working here, or open it when you are back at that computer.'],
  ['POST /api/floor/pick', 'The folder dialog opens on the computer the board runs on. Choose the folder from the list instead.'],
  ['POST /api/floor/signin', 'Sign in to Claude opens a browser on the computer the board runs on. Sign in there when you are back at it.'],
]);

const als = new AsyncLocalStorage();
/** Who the request being handled was relayed from, or null for this machine. */
export const relayedBy = () => als.getStore() ?? null;

const header = (req, name) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

const fromB64url = (s) => {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try { return Buffer.from(s, 'base64url').toString('utf8'); } catch { return null; }
};

const str = (v, max) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);

/** An origin exactly as a browser sends it: scheme://host[:port], no path, no slash. */
function originOf(v) {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin === v ? v : null;
  } catch { return null; }
}

/**
 * What a relayed request's headers say, checked. Pure, so the suite can run
 * every refusal without a server. Returns { payload } or { status, code, error }.
 */
export function checkRelay({ headers, secret, now = Date.now() }) {
  const raw = headers[RELAY_HEADER];
  const sig = headers[RELAY_SIG_HEADER];
  if (raw == null && sig == null) return { payload: null };
  const refuse = (code, error, status = 403) => ({ status, code, error });
  if (!secret) return refuse('relay_not_configured', 'This board takes no relayed requests: it was started without a relay secret.');
  if (typeof raw !== 'string' || typeof sig !== 'string') return refuse('relay_bad_signature', 'A relayed request needs both X-Orch-Relay and X-Orch-Relay-Sig.');
  const want = createHmac('sha256', secret).update(raw, 'utf8').digest();
  const got = /^[0-9a-f]{64}$/.test(sig) ? Buffer.from(sig, 'hex') : null;
  if (!got || !timingSafeEqual(want, got)) return refuse('relay_bad_signature', 'The relayed request\'s signature does not verify.');
  let p;
  try { p = JSON.parse(fromB64url(raw) ?? ''); } catch { p = null; }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return refuse('relay_bad_signature', 'The relayed request\'s identity does not parse.');
  if (p.v !== 1) return refuse('relay_bad_signature', `The relayed request's identity is version ${JSON.stringify(p.v)}, and this board reads version 1.`);
  const op = str(p.op, 64);
  const name = str(p.name, 80);
  const origin = originOf(p.origin);
  if (!op || !name || !origin || typeof p.iat !== 'number' || typeof p.role !== 'string') {
    return refuse('relay_bad_signature', 'The relayed request\'s identity is missing a field (op, name, role, origin, iat).');
  }
  if (!ROLES.has(p.role)) return refuse('relay_role', `This board serves the relayed roles "owner" and "guest", not "${p.role.slice(0, 20)}".`);
  // A guest carries the building ids its Key Card opens (board.relay v4). An
  // id the board doesn't have opens nothing; a guest with none is malformed.
  let buildings = null;
  if (p.role === 'guest') {
    if (!Array.isArray(p.buildings) || p.buildings.length > BUILDINGS_MAX || !p.buildings.every((b) => str(b, 64))) {
      return refuse('relay_bad_signature', 'A guest\'s relayed identity is missing the buildings its card opens.');
    }
    buildings = [...new Set(p.buildings)];
  }
  if (Math.abs(now - p.iat) > IAT_WINDOW_MS) return refuse('relay_stale', 'The relayed request was signed more than five minutes from this board\'s clock.');
  const reqOrigin = headers.origin;
  if (reqOrigin != null && reqOrigin !== origin) return refuse('relay_cross_origin', 'This request came from another site than the one the board was opened on.');
  return { payload: { op, name, role: p.role, origin, iat: p.iat, ...(buildings ? { buildings } : {}) } };
}

/**
 * The desk actions only a desk's own operator takes (board.relay v4, "desk
 * ownership"): its prompts, its stop sign, opening, reopening, moving,
 * leaving or seating it, handing it to an editor or a terminal, its sign-in.
 * Everyone in the building may message, nudge and meet it.
 */
export const OWN_ROUTES = new Set([
  'POST /api/floor/permission', 'POST /api/floor/answer', 'POST /api/floor/interrupt',
  'POST /api/floor/open', 'POST /api/floor/reopen', 'POST /api/floor/desk/move', 'POST /api/floor/desk/leave',
  'POST /api/floor/desk/twin', 'POST /api/floor/handback', 'POST /api/floor/attach', 'POST /api/floor/claude',
  'POST /api/floor/sessions', 'POST /api/floor/signin', 'POST /api/floor/rescan', 'POST /api/floor/read',
]);

/** Whose work a request asks for (board.relay v5): a guest's own op, or null for the owner's. */
export const requesterOp = (req) => (req?.relay?.role === 'guest' ? req.relay.op : null);
/** What a guest never reaches: the board's own administration and history across the owner's hosts. */
const GUEST_DENY = [/^\/api\/admin(\/|$)/, /^\/api\/floor\/history(\/|$)/];
/** Routes that act on a host by its id: a guest's must be its own (`<op>~…`). */
const HOST_ID_ROUTES = /^\/api\/(host\/|floor\/(browse|pick|desk)$)/;
/** A model or effort change is the desk's own operator's, like its other settings. */
const SETTING_COMMAND = /^\s*\/(model|effort)\b/i;

/** The channels a request names: body, query, a move's target, a stream's desks, a room's agents. */
function channelsNamed(req) {
  const out = [];
  const add = (c) => { if (typeof c === 'string' && c.trim()) out.push(c.trim()); };
  add(req.body?.channel); add(req.body?.to); add(req.query?.channel);
  if (typeof req.query?.desks === 'string') {
    try { for (const p of JSON.parse(req.query.desks)) if (Array.isArray(p)) add(p[0]); } catch { /* the route refuses it */ }
  }
  for (const a of Array.isArray(req.body?.agents) ? req.body.agents : []) add(a?.channel ?? (Array.isArray(a) ? a[0] : null));
  if (/^\/(mcp|api\/ingest)(\/|$)/.test(req.path)) add(header(req, 'x-channel') ?? header(req, 'x-orchestratinator-channel') ?? req.body?.channel);
  return out;
}

/**
 * Who may do what, once the body is parsed (board.relay v4). Runs for every
 * request, the keyboard's too: the owner at the keyboard cannot answer a
 * guest's agent's prompt either.
 */
export function createScope({ store }) {
  const requester = (req) => (req.relay?.role === 'guest' ? { op: req.relay.op, name: req.relay.name } : { op: null, name: req.relay?.name ?? null });
  const inBuildings = (req, channel) => req.relay.buildings.includes(store.floorBuildings([channel]).get(channel));
  return function scope(req, res, next) {
    const what = `${req.method} ${req.path}`;
    const me = requester(req);
    const guest = req.relay?.role === 'guest';
    // On /mcp a refusal is 503, never 401 or 403 (desktop-dev's M3 walk,
    // measured on Claude Code 2.1.331): Claude Code remembers a 401/403 on
    // an MCP server as "needs authentication" under the server's NAME, and
    // every desk's binding is called orchestratinator, so one refused desk
    // left every desk on that computer unable to reach its board, its own
    // included. A 503 is read as "failed" and not remembered. The body says
    // why, as for any other route.
    const onMcp = /^\/mcp(\/|$)/.test(req.path);
    const refuse = (status, code, error) => res.status(onMcp && (status === 401 || status === 403) ? 503 : status).json({ error, code });
    if (guest) {
      if (GUEST_DENY.some((rx) => rx.test(req.path))) return refuse(403, 'relay_guest_scope', `A guest of this board does not reach ${req.path}: it is the board owner's.`);
      if (HOST_ID_ROUTES.test(req.path)) {
        const hid = req.body?.host_id ?? req.query?.host_id;
        if (hid != null && !String(hid).startsWith(`${me.op}~`)) return refuse(403, 'relay_host_id', `A guest acts only on its own host (an id starting "${me.op}~"), not "${String(hid).slice(0, 40)}".`);
        if (hid == null && /^\/api\/host\//.test(req.path)) return refuse(403, 'relay_host_id', 'A guest\'s host names itself on every call.');
      }
      for (const c of channelsNamed(req)) {
        if (!inBuildings(req, c)) return refuse(403, 'relay_guest_scope', `The floor "${c}" is not in a building this guest's card opens.`);
      }
    }
    // Work for a host is its own operator's to ask for (board.relay v5,
    // desktop-dev's 4431): nobody else takes a desk on it, browses or picks
    // its folders. Its own /api/host/* calls are the host itself.
    if (HOST_ID_ROUTES.test(req.path) && !/^\/api\/host\//.test(req.path)) {
      const hid = req.body?.host_id ?? req.query?.host_id;
      if (hid != null) {
        const owner = store.hostOperator(String(hid));
        if ((owner.op ?? null) !== me.op) return refuse(403, 'host_not_yours', `That host is ${owner.op ? (owner.name ?? 'a guest') + '\'s' : (store.ownerName?.() ?? 'the board owner') + '\'s'}: only its own operator gives it work.`);
      }
    }
    // A desk's own operator's actions, and an agent's or hook's identity.
    const desk = (channel, agent) => (channel && agent ? store.deskOperator(String(channel), String(agent)) : null);
    const notYours = (who) => refuse(403, 'desk_not_yours', `That desk is ${who.name ? `${who.name}'s` : (who.op ? 'a guest\'s' : 'the board owner\'s')}: only its own operator can do that.`);
    if (OWN_ROUTES.has(what) || (what === 'POST /api/floor/chat' && SETTING_COMMAND.test(String(req.body?.text ?? '')))) {
      const who = desk(req.body?.channel, req.body?.agent);
      if (who && who.op !== me.op && (who.op || me.op)) return notYours(who.op ? who : { op: null, name: store.ownerName?.() ?? null });
    }
    if (req.relay && /^\/(mcp|api\/ingest)(\/|$)/.test(req.path)) {
      const ch = header(req, 'x-channel') ?? header(req, 'x-orchestratinator-channel') ?? req.body?.channel;
      const ag = header(req, 'x-agent') ?? header(req, 'x-orchestratinator-agent') ?? req.body?.agent;
      const who = desk(ch, ag);
      if (who && who.op !== me.op) return notYours(who.op ? who : { op: null, name: store.ownerName?.() ?? null });
      // A guest's agent arriving as a name nobody holds is that guest's from
      // now on (board.relay v6), so a revoke can find it later.
      if (!who && guest && ch && ag) store.setDeskOperator?.(String(ch), String(ag), me.op, me.name);
    }
    return next();
  };
}

export function createRelay({ env = process.env } = {}) {
  const secret = String(env.ORCH_RELAY_SECRET ?? '').trim();
  if (secret && secret.length < SECRET_MIN) {
    throw new Error(`ORCH_RELAY_SECRET is set but ${secret.length} characters long; it must be at least ${SECRET_MIN} (32 random bytes as hex or base64url).`);
  }

  /** Ahead of every route: verify, refuse, or let the request through as it was. */
  function middleware(req, res, next) {
    const headers = {
      [RELAY_HEADER]: header(req, RELAY_HEADER),
      [RELAY_SIG_HEADER]: header(req, RELAY_SIG_HEADER),
      origin: header(req, 'origin'),
    };
    const r = checkRelay({ headers, secret });
    if (r.error) return res.status(r.status).json({ error: r.error, code: r.code });
    if (!r.payload) return next();
    req.relay = r.payload;
    const refusal = LOCAL_ONLY.get(`${req.method} ${req.path}`);
    if (refusal) return res.status(409).json({ error: refusal, code: 'relay_local_only' });
    return als.run(r.payload, next);
  }

  return {
    middleware,
    // Presence and length only, never the value (board.relay, "secret").
    describe: () => (secret ? `relay     ON (secret set, ${secret.length} chars)` : 'relay     OFF (no ORCH_RELAY_SECRET — relayed requests are refused)'),
  };
}

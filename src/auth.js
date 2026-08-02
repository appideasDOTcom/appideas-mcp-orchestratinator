import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * A single shared secret that agents present on every MCP request.
 *
 * This is a doorlock, not a security model: one key for every agent, no
 * rotation, no per-agent identity (the X-Agent header is still self-asserted —
 * anyone holding the key can claim to be anyone). It exists so that something
 * which stumbles onto the port can't start driving the board, and so that a
 * misconfigured client fails loudly instead of quietly writing to the wrong
 * place.
 *
 * It guards `/mcp` and nothing else. The dashboard is deliberately open: this
 * server runs on one trusted machine on one trusted network, and a login screen
 * in front of a board only that machine's owner can reach was ceremony, not
 * security. See adminGuard for the one thing that is still checked, and why it
 * is not authentication.
 *
 * Modes, chosen by ORCH_AUTH_MODE:
 *   off     — no token configured. Every request passes, which is what the
 *             server did before this existed.
 *   warn    — a bad or missing key is logged and let through. This is the
 *             rollout mode: restart the server in `warn`, watch the log until
 *             no agent is failing, then flip to `enforce`. It means bringing
 *             auth up can't strand an agent that's mid-task on an old config.
 *   enforce — a bad or missing key is 401.
 */

/** Clients send the secret here. `Authorization: Bearer <token>` also works. */
export const AUTH_HEADER = 'x-orchestratinator-key';
const VALID_MODES = new Set(['off', 'warn', 'enforce']);
/** Per-identity log throttle, so one misconfigured agent in a retry loop can't flood. */
const LOG_EVERY_MS = 10_000;
const LOG_KEYS_MAX = 200;

/**
 * Where server-wide operator actions are recorded, since `admin_events.channel`
 * is NOT NULL and none of these belong to a channel. Parenthesised so it can't be
 * mistaken for one, and invisible on the board either way: listAllChannels
 * derives channels from the data tables and never reads this one.
 */
export const SERVER_CHANNEL = '(server)';

const digest = (s) => createHash('sha256').update(String(s)).digest();
/** Constant-time, and length-agnostic because both sides are hashed first. */
const tokensMatch = (a, b) => timingSafeEqual(digest(a), digest(b));

const header = (req, name) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/** How the caller identifies itself — for the log line only, never trusted. */
function describe(req) {
  const channel = header(req, 'x-channel') || header(req, 'x-orchestratinator-channel');
  const agent = header(req, 'x-agent') || header(req, 'x-orchestratinator-agent');
  if (channel || agent) return `${channel ?? '?'}/${agent ?? '?'}`;
  return req.ip ?? 'unknown';
}

export function createAuth({ env = process.env } = {}) {
  const token = (env.ORCH_AUTH_TOKEN ?? '').trim();
  const mode = token ? (env.ORCH_AUTH_MODE ?? 'enforce').trim().toLowerCase() : 'off';
  // A typo'd mode must not fail open — a silently unlocked door is the whole
  // failure this is meant to prevent, so refuse to start instead.
  if (!VALID_MODES.has(mode)) {
    throw new Error(`ORCH_AUTH_MODE must be one of ${[...VALID_MODES].join(', ')} (got "${env.ORCH_AUTH_MODE}")`);
  }

  const lastLogged = new Map();
  function warn(key, line) {
    const now = Date.now();
    if (now - (lastLogged.get(key) ?? 0) < LOG_EVERY_MS) return;
    if (lastLogged.size > LOG_KEYS_MAX) lastLogged.clear();
    lastLogged.set(key, now);
    console.warn(line);
  }

  /** True if this request carries the right key. */
  function authorized(req) {
    const candidates = [];
    const h = header(req, AUTH_HEADER);
    if (h) candidates.push(h);
    const bearer = header(req, 'authorization');
    if (bearer && /^bearer\s+/i.test(bearer)) candidates.push(bearer.replace(/^bearer\s+/i, '').trim());
    return candidates.some((c) => tokensMatch(c, token));
  }

  /**
   * Reject anything a browser tells us came from another site.
   *
   * `Origin` is absent on same-origin GETs (and on curl), so absence can't be
   * treated as hostile — but when it's present it must match the host we were
   * reached on.
   */
  function sameOrigin(req) {
    if (String(req.headers['sec-fetch-site'] ?? '') === 'cross-site') return false;
    const origin = header(req, 'origin');
    if (!origin) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }

  /**
   * Guards the mutating dashboard endpoints (/api/admin/*).
   *
   * This is a CSRF lock, not authentication — there is no longer any dashboard
   * credential for it to check. It exists because "open to this machine" and
   * "open to every page this machine's browser happens to load" are very
   * different statements, and only the first one was intended. Any web page you
   * visit can fire a request at this port; none of them may drive the board.
   *
   * Deliberately not doing the other half of the job: something running locally
   * with curl can take any operator action. On a single-user box behind a
   * firewall that is the intended trade, and the shared secret on /mcp is what
   * still keeps a stray agent from wandering in.
   */
  function adminGuard(req, res, next) {
    if (sameOrigin(req)) return next();
    warn(`admin:${describe(req)}`, `[orchestratinator] admin DENY: cross-origin ${req.method} ${req.path}`);
    return res.status(403).json({ error: 'cross-origin admin request refused' });
  }

  /** Guards /mcp. Registered before the body parser so a reject never parses 4mb. */
  function mcpGuard(req, res, next) {
    if (mode === 'off' || authorized(req)) return next();
    const who = describe(req);
    if (mode === 'warn') {
      warn(`mcp:${who}`, `[orchestratinator] auth WARN: ${who} sent no valid ${AUTH_HEADER} (allowed — mode=warn)`);
      return next();
    }
    warn(`mcp:${who}`, `[orchestratinator] auth DENY: ${who} sent no valid ${AUTH_HEADER}`);
    return res.status(401).json({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32002,
        message: `Unauthorized: send the shared secret in the ${AUTH_HEADER} header (set it under "headers" in your .mcp.json).`,
      },
    });
  }

  return {
    mode,
    mcpGuard,
    adminGuard,
    /** One startup line, so the mode is never something you have to infer. */
    describeStartup() {
      if (mode === 'off') {
        return 'auth      OFF (no ORCH_AUTH_TOKEN set — any client may connect) · dashboard open';
      }
      return `auth      ${mode.toUpperCase()} on /mcp via ${AUTH_HEADER} · dashboard open (same-origin only)`;
    },
  };
}

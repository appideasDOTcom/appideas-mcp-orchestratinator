import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * A single shared secret that clients present on every MCP request.
 *
 * This is a doorlock, not a security model: one key for every agent, no
 * rotation, no per-agent identity (the X-Agent header is still self-asserted —
 * anyone holding the key can claim to be anyone). It exists so that something
 * which stumbles onto the port can't just start reading and writing the board.
 * The compose file still publishes on 127.0.0.1 only; this is the second lock,
 * not a licence to remove the first.
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
/** Set on the dashboard once, so a browser doesn't need the key in every URL. */
const UI_COOKIE = 'orch_key';
const VALID_MODES = new Set(['off', 'warn', 'enforce']);
/** Per-identity log throttle, so one misconfigured agent in a retry loop can't flood. */
const LOG_EVERY_MS = 10_000;
const LOG_KEYS_MAX = 200;

const digest = (s) => createHash('sha256').update(String(s)).digest();
/** Constant-time, and length-agnostic because both sides are hashed first. */
const tokensMatch = (a, b) => timingSafeEqual(digest(a), digest(b));

const header = (req, name) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/** Read one cookie without pulling in cookie-parser for a single value. */
function cookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return undefined; }
  }
  return undefined;
}

/** How the caller identifies itself — for the log line only, never trusted. */
function describe(req) {
  const channel = header(req, 'x-channel') || header(req, 'x-orchestratinator-channel');
  const agent = header(req, 'x-agent') || header(req, 'x-orchestratinator-agent');
  if (channel || agent) return `${channel ?? '?'}/${agent ?? '?'}`;
  return req.ip ?? 'unknown';
}

export function createAuth(env = process.env) {
  const token = (env.ORCH_AUTH_TOKEN ?? '').trim();
  const mode = token ? (env.ORCH_AUTH_MODE ?? 'enforce').trim().toLowerCase() : 'off';
  // A typo'd mode must not fail open — a silently unlocked door is the whole
  // failure this is meant to prevent, so refuse to start instead.
  if (!VALID_MODES.has(mode)) {
    throw new Error(`ORCH_AUTH_MODE must be one of ${[...VALID_MODES].join(', ')} (got "${env.ORCH_AUTH_MODE}")`);
  }
  const protectUi = mode !== 'off' && /^(1|true|yes|on)$/i.test(String(env.ORCH_AUTH_PROTECT_UI ?? ''));

  const lastLogged = new Map();
  function warn(key, line) {
    const now = Date.now();
    if (now - (lastLogged.get(key) ?? 0) < LOG_EVERY_MS) return;
    if (lastLogged.size > LOG_KEYS_MAX) lastLogged.clear();
    lastLogged.set(key, now);
    console.warn(line);
  }

  /** True if this request carries the right key. `extra` adds browser-only sources. */
  function authorized(req, extra = false) {
    const candidates = [];
    const h = header(req, AUTH_HEADER);
    if (h) candidates.push(h);
    const bearer = header(req, 'authorization');
    if (bearer && /^bearer\s+/i.test(bearer)) candidates.push(bearer.replace(/^bearer\s+/i, '').trim());
    if (extra) {
      const c = cookie(req, UI_COOKIE);
      if (c) candidates.push(c);
      if (typeof req.query?.key === 'string') candidates.push(req.query.key);
    }
    return candidates.some((c) => tokensMatch(c, token));
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

  /**
   * Guards the dashboard and its /api/* endpoints. Off unless
   * ORCH_AUTH_PROTECT_UI is set, because a browser can't send a custom header:
   * you open `/?key=<secret>` once, which drops a cookie and redirects to a
   * clean URL so the secret doesn't linger in the address bar or a Referer.
   */
  function uiGuard(req, res, next) {
    if (!protectUi) return next();
    if (!authorized(req, true)) {
      const who = describe(req);
      if (mode === 'warn') {
        warn(`ui:${who}`, `[orchestratinator] auth WARN: dashboard request from ${who} had no valid key (allowed — mode=warn)`);
        return next();
      }
      warn(`ui:${who}`, `[orchestratinator] auth DENY: dashboard request from ${who} had no valid key`);
      return res.status(401).type('text/plain').send('Unauthorized — open this page as /?key=<shared secret>\n');
    }
    if (typeof req.query?.key === 'string' && req.method === 'GET') {
      res.cookie(UI_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 180 * 24 * 60 * 60 * 1000,
      });
      return res.redirect(req.path);
    }
    return next();
  }

  return {
    mode,
    protectUi,
    mcpGuard,
    uiGuard,
    /** One startup line, so the mode is never something you have to infer. */
    describeStartup() {
      if (mode === 'off') return 'auth      OFF (no ORCH_AUTH_TOKEN set — any client may connect)';
      const ui = protectUi ? ', dashboard protected' : ', dashboard open';
      return `auth      ${mode.toUpperCase()} via ${AUTH_HEADER}${ui}`;
    },
  };
}

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

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
/**
 * The dashboard sends this on every mutating request. It's a fresh random value
 * per server process, handed to the page by GET /api/admin/token — which itself
 * requires the shared secret (header, or the cookie a `/?key=…` visit drops).
 *
 * Two separate jobs, which is why it isn't just the shared secret again:
 *  - It's a *custom* header, so a cross-origin POST from any other page needs a
 *    CORS preflight. We answer no preflights, so the browser never sends the
 *    real request. That's the CSRF lock, and a cookie alone cannot provide it —
 *    cookies are precisely what CSRF rides on.
 *  - It's readable by the page's JavaScript, which the httpOnly cookie is not.
 * A foreign page can still *fire* the token request, but it can't read the
 * response (no CORS headers are ever sent), and SameSite=lax withholds the
 * cookie from cross-site fetches, so it gets a 401 and nothing else.
 */
export const ADMIN_HEADER = 'x-orch-admin-token';
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
  // Regenerated on every restart, so a token that leaks into a log or a devtools
  // panel stops working the next time the container comes up.
  const adminToken = randomBytes(32).toString('base64url');
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

  /**
   * Belt to the custom header's braces: reject anything a browser tells us came
   * from another site. `Origin` is absent on same-origin GETs (and on curl), so
   * absence can't be treated as hostile — but when it's present it must match
   * the host we were reached on, which holds through the ngrok tunnel too since
   * both sides are then the tunnel hostname.
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
   * Unlike `uiGuard` this is never optional and never honours `warn` mode: reads
   * being open is a config choice, but "anyone who can reach the port may delete
   * a channel" is not a choice worth offering. The only exception is a server
   * with no secret configured at all (mode `off`), where there is no key to
   * demand — there, the CSRF lock is all that's left, and it still applies.
   */
  function adminGuard(req, res, next) {
    if (!sameOrigin(req)) {
      warn(`admin:${describe(req)}`, `[orchestratinator] admin DENY: cross-origin ${req.method} ${req.path}`);
      return res.status(403).json({ error: 'cross-origin admin request refused' });
    }
    const presented = header(req, ADMIN_HEADER);
    if (presented && tokensMatch(presented, adminToken)) return next();
    if (mode !== 'off' && authorized(req)) return next();
    warn(`admin:${describe(req)}`, `[orchestratinator] admin DENY: ${req.method} ${req.path} without a valid admin token`);
    return res.status(401).json({
      error: mode === 'off'
        ? `Unauthorized: send the per-process admin token in the ${ADMIN_HEADER} header (GET /api/admin/token).`
        : `Unauthorized: send the ${ADMIN_HEADER} header (GET /api/admin/token) or the shared secret in ${AUTH_HEADER}.`,
    });
  }

  /**
   * Guards GET /api/admin/token — the one thing that hands out write access, so
   * it wants the shared secret even when the dashboard itself is open. In
   * practice that means visiting `/?key=<secret>` once per browser; `uiGuard`
   * drops the cookie on that visit in either mode.
   */
  function adminTokenGuard(req, res, next) {
    if (!sameOrigin(req)) return res.status(403).json({ error: 'cross-origin admin request refused' });
    if (mode === 'off' || authorized(req, true)) return next();
    return res.status(401).json({
      error: 'Unauthorized: open the dashboard once as /?key=<shared secret> to enable operator actions.',
    });
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
    // The cookie drop happens in both modes, ahead of the protectUi check: with
    // the dashboard open the cookie isn't what lets you *read* the board, but it
    // is what lets you take an operator action, and `/?key=…` has to be able to
    // establish that either way.
    const dropCookie = () => {
      if (!token || req.method !== 'GET' || typeof req.query?.key !== 'string') return false;
      // Only the dashboard page gets the cookie-and-redirect treatment. On an API
      // route a redirect would be actively unhelpful: `?key=` there is a caller
      // authenticating one request (curl, a script), and `authorized(req, true)`
      // already accepts it — bouncing it to a keyless URL would just 401.
      if (req.path.startsWith('/api/')) return false;
      if (!tokensMatch(req.query.key, token)) return false;
      res.cookie(UI_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 180 * 24 * 60 * 60 * 1000,
      });
      // Redirect to a clean URL so the secret doesn't linger in the address bar,
      // the history, or a Referer header on the next request out.
      res.redirect(req.path);
      return true;
    };

    if (!protectUi) return dropCookie() ? undefined : next();
    if (!authorized(req, true)) {
      const who = describe(req);
      if (mode === 'warn') {
        warn(`ui:${who}`, `[orchestratinator] auth WARN: dashboard request from ${who} had no valid key (allowed — mode=warn)`);
        return next();
      }
      warn(`ui:${who}`, `[orchestratinator] auth DENY: dashboard request from ${who} had no valid key`);
      return res.status(401).type('text/plain').send('Unauthorized — open this page as /?key=<shared secret>\n');
    }
    if (dropCookie()) return undefined;
    return next();
  }

  return {
    mode,
    protectUi,
    adminToken,
    mcpGuard,
    uiGuard,
    adminGuard,
    adminTokenGuard,
    /** One startup line, so the mode is never something you have to infer. */
    describeStartup() {
      if (mode === 'off') {
        return 'auth      OFF (no ORCH_AUTH_TOKEN set — any client may connect; operator actions need only the admin token)';
      }
      const ui = protectUi ? ', dashboard protected' : ', dashboard open';
      return `auth      ${mode.toUpperCase()} via ${AUTH_HEADER}${ui}, operator actions ENFORCED (open /?key=… once per browser)`;
    },
  };
}

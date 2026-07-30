import express from 'express';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
/** A signed-in human's session id. Rows live in `ui_sessions`; see loginRequired. */
const SESSION_COOKIE = 'orch_session';
const VALID_MODES = new Set(['off', 'warn', 'enforce']);
/** Per-identity log throttle, so one misconfigured agent in a retry loop can't flood. */
const LOG_EVERY_MS = 10_000;
const LOG_KEYS_MAX = 200;

const LOGIN_PAGE = fileURLToPath(new URL('./ui/login.html', import.meta.url));

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

/* ---------- passwords ---------- */

/**
 * scrypt from node:crypto, so adding human logins adds no dependency — and no
 * native build to go wrong on the box this eventually lives on.
 *
 * Parameters travel in the stored string rather than being read from a constant
 * at verify time. That's what lets them be raised later without invalidating
 * every existing password: an old hash keeps verifying against the cost it was
 * written with, and gets rewritten at the new cost next time it's changed.
 */
const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 64 };
// N=16384, r=8 needs 128 * N * r = 16MB. The ceiling is here so that a cost
// parameter arriving from a restored backup can't ask for an unbounded
// allocation — scrypt throws, verify catches, the password simply doesn't match.
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export function hashPassword(plain) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(plain), salt, SCRYPT.keylen, { ...SCRYPT, maxmem: SCRYPT_MAXMEM });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export function verifyPassword(plain, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  try {
    const want = Buffer.from(hash, 'base64url');
    const got = scryptSync(String(plain), Buffer.from(salt, 'base64url'), want.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT_MAXMEM,
    });
    return want.length === got.length && timingSafeEqual(want, got);
  } catch {
    return false;   // unparseable cost, or a length scrypt won't produce
  }
}

/**
 * A password verification that always fails, for a username that doesn't exist.
 *
 * Without it, "no such user" returns in microseconds while a wrong password
 * takes ~60ms, and the difference tells anyone who asks which of your colleagues
 * has an account. Computed once, on the first miss, rather than at import.
 */
let decoyHash = null;
const burnTime = (plain) => verifyPassword(plain, decoyHash ??= hashPassword(randomBytes(18).toString('hex')));

/** Lower-cased, so "Costmo" and "costmo" can't become two accounts. */
export const normalizeUsername = (v) => String(v ?? '').trim().toLowerCase();

const USERNAME_RE = /^[a-z0-9][a-z0-9._@+-]{1,63}$/;
export const PASSWORD_MIN = 8;
// Capped because scrypt hashes whatever it's handed, and an unbounded password
// is an unbounded amount of work for an unauthenticated caller to ask for.
export const PASSWORD_MAX = 200;

/** Null if the name is usable, otherwise the reason it isn't — shown verbatim. */
export function usernameProblem(name) {
  if (!name) return 'a username is required';
  if (name.length > 64) return 'that username is too long (64 characters max)';
  if (!USERNAME_RE.test(name)) {
    return 'usernames may use letters, digits, and . _ - + @ — starting with a letter or digit';
  }
  return null;
}

export function passwordProblem(password) {
  if (typeof password !== 'string' || !password) return 'a password is required';
  if (password.length < PASSWORD_MIN) return `passwords need at least ${PASSWORD_MIN} characters`;
  if (password.length > PASSWORD_MAX) return `passwords are limited to ${PASSWORD_MAX} characters`;
  return null;
}

/* ---------- login attempt throttle ---------- */

// Not a lockout on the account — a brake on the (username, source) pair, so one
// person guessing can't cost a real user their access by getting them locked out.
const ATTEMPT_WINDOW_MS = 10 * 60_000;
const ATTEMPT_MAX = 8;
const ATTEMPT_KEYS_MAX = 500;

function makeThrottle() {
  const tries = new Map();
  const prune = (now) => {
    for (const [k, v] of tries) if (now - v.first > ATTEMPT_WINDOW_MS) tries.delete(k);
  };
  return {
    /** Seconds the caller must wait, or 0 if it may try now. */
    retryAfter(key) {
      const now = Date.now();
      const v = tries.get(key);
      if (!v) return 0;
      if (now - v.first > ATTEMPT_WINDOW_MS) { tries.delete(key); return 0; }
      if (v.n < ATTEMPT_MAX) return 0;
      return Math.ceil((ATTEMPT_WINDOW_MS - (now - v.first)) / 1000);
    },
    fail(key) {
      const now = Date.now();
      if (tries.size > ATTEMPT_KEYS_MAX) prune(now);
      const v = tries.get(key);
      if (!v || now - v.first > ATTEMPT_WINDOW_MS) tries.set(key, { n: 1, first: now });
      else v.n++;
    },
    pass(key) { tries.delete(key); },
  };
}

/** SQLite compares `expires_at > datetime('now')` as text, so match its format. */
const stamp = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const parseStamp = (s) => (s ? Date.parse(`${String(s).replace(' ', 'T')}Z`) : 0);

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

export function createAuth({ store = null, env = process.env } = {}) {
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

  const sessionDays = Math.max(1, Number(env.ORCH_SESSION_DAYS ?? 30));
  const sessionMs = sessionDays * 24 * 60 * 60 * 1000;
  // Sliding expiry, but not on every request: the dashboard polls twice every
  // 2.5 seconds, and a write per poll to move a timestamp nobody reads is pure
  // noise in the WAL.
  const SESSION_TOUCH_MS = 5 * 60_000;
  // Unset means "secure when the request arrived over TLS", which is right in
  // both places this runs: plain http on a laptop, https behind a proxy. Set it
  // to force the issue once there's a certificate in front of this for good.
  const forceSecure = env.ORCH_COOKIE_SECURE == null || env.ORCH_COOKIE_SECURE === ''
    ? null
    : /^(1|true|yes|on)$/i.test(String(env.ORCH_COOKIE_SECURE));
  const secureFor = (req) =>
    forceSecure ?? (req.secure || String(header(req, 'x-forwarded-proto') ?? '').split(',')[0].trim() === 'https');
  const cookieOpts = (req, maxAge) => ({
    httpOnly: true, sameSite: 'lax', path: '/', secure: secureFor(req), maxAge,
  });

  const throttle = makeThrottle();
  const loginHtml = (() => {
    try { return readFileSync(LOGIN_PAGE, 'utf8'); } catch { return null; }
  })();

  /**
   * Whether a human needs to sign in — true as soon as one enabled user exists.
   *
   * Adding the first user is therefore what turns human auth on, and deleting the
   * last one turns it back off. That's deliberate: the alternative is a separate
   * "require login" switch that can disagree with the user list, and a server
   * that is unlocked because a flag says so while a full user table implies
   * otherwise is exactly the kind of quiet failure this shouldn't have.
   *
   * Cached, because it is consulted on every request including each static asset.
   * User mutations bust it explicitly; the TTL is the backstop for a change that
   * arrived some other way (a restore, a hand-edited database).
   */
  let usersCache = { at: 0, n: 0 };
  const USERS_TTL_MS = 5000;
  function enabledUsers() {
    if (!store) return 0;
    const now = Date.now();
    if (now - usersCache.at > USERS_TTL_MS) usersCache = { at: now, n: store.countEnabledUsers() };
    return usersCache.n;
  }
  const loginRequired = () => enabledUsers() > 0;
  const usersChanged = () => { usersCache = { at: 0, n: 0 }; };

  /**
   * The signed-in human, or null. Memoised per request: several guards ask, and
   * each answer is a database read plus a possible timestamp write.
   */
  function sessionUser(req) {
    if (req.orchUser !== undefined) return req.orchUser;
    let user = null;
    const sid = cookie(req, SESSION_COOKIE);
    if (sid && store) {
      const row = store.getUiSession(sid);
      if (row) {
        user = row.username;
        if (Date.now() - parseStamp(row.last_seen) > SESSION_TOUCH_MS) {
          store.touchUiSession(sid, stamp(Date.now() + sessionMs));
        }
      }
    }
    req.orchUser = user;
    return user;
  }

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
   * it wants a real credential even when the dashboard itself is open.
   *
   * A signed-in human counts, which is the point of adding logins: every user is
   * an admin here, so proving you are one of them is proving you may operate the
   * board. The `/?key=<shared secret>` route stays as the way in for a browser
   * with no account and for scripts, and as the way back in after a forgotten
   * password.
   */
  function adminTokenGuard(req, res, next) {
    if (!sameOrigin(req)) return res.status(403).json({ error: 'cross-origin admin request refused' });
    if (sessionUser(req)) return next();
    if (mode === 'off' || authorized(req, true)) return next();
    return res.status(401).json({
      error: loginRequired()
        ? 'Unauthorized: sign in to enable operator actions.'
        : 'Unauthorized: open the dashboard once as /?key=<shared secret> to enable operator actions.',
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
   * Turn away a browser with no credential.
   *
   * A page request gets the sign-in form — the useful answer, and the reason it
   * carries a 401 rather than a 200 is that the request for the dashboard really
   * was refused; saying so keeps the status line honest for anything reading it
   * that isn't a person. An /api/* request gets JSON with `login_required`, which
   * is what an already-open tab whose session expired reacts to by reloading into
   * the form instead of quietly showing a board that has stopped updating.
   */
  function denyHuman(req, res) {
    const who = describe(req);
    warn(`login:${who}`, `[orchestratinator] dashboard DENY: ${req.method} ${req.path} from ${who} — not signed in`);
    res.set('Cache-Control', 'no-store');
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Sign in to use the dashboard.', login_required: true });
    }
    if (req.method === 'GET' && loginHtml) return res.status(401).type('html').send(loginHtml);
    return res.status(401).type('text/plain').send('Unauthorized — sign in at / to use the dashboard.\n');
  }

  /**
   * Guards the dashboard and its /api/* endpoints.
   *
   * Two independent ways in, because they answer different questions. A login
   * says *who* you are, and is required the moment any enabled user exists —
   * adding the first account is what closes the door. The shared secret says only
   * that you hold the key, and still works: it's what curl and the tests use, and
   * it's the way back in when nobody can remember a password.
   *
   * With no users configured this behaves exactly as it did before logins
   * existed: open unless ORCH_AUTH_PROTECT_UI is set, and `/?key=<secret>` drops
   * a cookie so the secret doesn't have to live in the address bar.
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
      res.cookie(UI_COOKIE, token, cookieOpts(req, 180 * 24 * 60 * 60 * 1000));
      // Redirect to a clean URL so the secret doesn't linger in the address bar,
      // the history, or a Referer header on the next request out.
      res.redirect(req.path);
      return true;
    };

    // Human logins, once there are any. Checked ahead of protectUi because it is
    // a stronger statement than that flag makes: a named account, revocable on
    // its own, rather than the one key everybody shares.
    if (loginRequired()) {
      if (sessionUser(req)) return dropCookie() ? undefined : next();
      if (authorized(req, true)) return dropCookie() ? undefined : next();
      return denyHuman(req, res);
    }

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

  /**
   * Sign in, sign out, and "who am I".
   *
   * Mounted ahead of `uiGuard` in server.js rather than inside the dashboard
   * router, so the guard needs no exemptions: the three routes a locked-out
   * browser must be able to reach are simply not behind it. Every one of them
   * still insists on same-origin — a login form on someone else's page must not
   * be able to spend a cookie this server issued.
   */
  function createAuthRouter() {
    const router = express.Router();

    router.use((req, res, next) => {
      if (!sameOrigin(req)) return res.status(403).json({ error: 'cross-origin request refused' });
      res.set('Cache-Control', 'no-store');
      return next();
    });

    // What the page needs to know before it draws anything: who you are, and
    // whether signing in is even a thing on this server.
    router.get('/api/session', (req, res) => {
      res.json({
        user: sessionUser(req),
        login_required: loginRequired(),
        users: store ? store.countUsers() : 0,
        // True when this browser holds the shared secret — the dashboard uses it
        // to explain why it has operator powers without a name attached to them.
        shared_secret: !sessionUser(req) && mode !== 'off' && authorized(req, true),
        auth_mode: mode,
      });
    });

    router.post('/api/login', (req, res) => {
      if (!store) return res.status(503).json({ error: 'no user store on this server' });
      const username = normalizeUsername(req.body?.username);
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      // Throttled on the pair, so guessing at one name from one place can't cost
      // that person their own access from somewhere else.
      const key = `${username}|${req.ip ?? '?'}`;
      const wait = throttle.retryAfter(key);
      if (wait) {
        return res.status(429)
          .set('Retry-After', String(wait))
          .json({ error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`, retry_after_seconds: wait });
      }
      // One message for every failure. Which half was wrong is information the
      // person typing already has, and information an attacker does not.
      const refuse = () => {
        throttle.fail(key);
        return res.status(401).json({ error: 'That username and password do not match an enabled account.' });
      };
      if (!username || !password || password.length > PASSWORD_MAX) return refuse();

      const row = store.getUserSecret(username);
      if (!row || !row.enabled) { burnTime(password); return refuse(); }
      if (!verifyPassword(password, row.password)) return refuse();

      throttle.pass(key);
      const id = randomBytes(32).toString('base64url');
      store.createUiSession(id, row.username, stamp(Date.now() + sessionMs), header(req, 'user-agent') ?? null);
      store.touchUserLogin(row.username);
      res.cookie(SESSION_COOKIE, id, cookieOpts(req, sessionMs));
      res.json({ ok: true, user: row.username, expires_in_days: sessionDays });
    });

    router.post('/api/logout', (req, res) => {
      const sid = cookie(req, SESSION_COOKIE);
      if (sid && store) store.deleteUiSession(sid);
      res.clearCookie(SESSION_COOKIE, { path: '/', sameSite: 'lax', httpOnly: true, secure: secureFor(req) });
      // The shared-secret cookie goes too. Otherwise "sign out" leaves a browser
      // that still has every operator power, which is not what the word means.
      res.clearCookie(UI_COOKIE, { path: '/', sameSite: 'lax', httpOnly: true, secure: secureFor(req) });
      res.json({ ok: true });
    });

    return router;
  }

  return {
    mode,
    protectUi,
    adminToken,
    mcpGuard,
    uiGuard,
    adminGuard,
    adminTokenGuard,
    createAuthRouter,
    /** Who took this action, for the audit trail. Null for a shared-secret caller. */
    actor: (req) => sessionUser(req),
    /** This browser's session id, so a password change can spare the browser making it. */
    sessionIdOf: (req) => (sessionUser(req) ? cookie(req, SESSION_COOKIE) : null),
    /**
     * Sign a browser in without a password.
     *
     * Exists for exactly one caller: a restore that has just replaced the users
     * table out from under the person performing it. Dropping them at the sign-in
     * form is technically defensible and practically wrong — they'd never see the
     * report of what they just did, and they hold the operator token, so they
     * could create an account for themselves anyway. The caller must check that
     * the name still exists and is enabled in the *restored* table first, which
     * is what keeps this from being a way to become someone else.
     */
    issueSession(req, res, username) {
      if (!store) return null;
      const id = randomBytes(32).toString('base64url');
      store.createUiSession(id, username, stamp(Date.now() + sessionMs), header(req, 'user-agent') ?? null);
      res.cookie(SESSION_COOKIE, id, cookieOpts(req, sessionMs));
      return id;
    },
    loginRequired,
    /** Called by the user routes so the login-required cache can't lag a change. */
    usersChanged,
    sessionDays,
    /** One startup line, so the mode is never something you have to infer. */
    describeStartup() {
      const people = store ? store.countEnabledUsers() : 0;
      const humans = people
        ? `${people} dashboard user${people === 1 ? '' : 's'} (sign-in required)`
        : 'no dashboard users (sign-in off)';
      if (mode === 'off') {
        return `auth      OFF (no ORCH_AUTH_TOKEN set — any client may connect) · ${humans}`;
      }
      const ui = protectUi ? ', dashboard protected' : ', dashboard open';
      return `auth      ${mode.toUpperCase()} via ${AUTH_HEADER}${ui}, operator actions ENFORCED · ${humans}`;
    },
  };
}

/**
 * Create the first account from the environment, if there is no account at all.
 *
 * Only ever fires on an empty table, so it can't undo a password change or
 * resurrect a user you deleted on purpose — but deleting *every* user does bring
 * it back on the next restart, which is the intended way out of locking yourself
 * out of the dashboard. Returns a line for the startup log, or null.
 */
export function seedFirstUser(store, env = process.env) {
  const username = normalizeUsername(env.ORCH_ADMIN_USER);
  const password = env.ORCH_ADMIN_PASSWORD ?? '';
  if (!username && !password) return null;
  if (store.countUsers() > 0) return null;
  const problem = usernameProblem(username) ?? passwordProblem(password);
  if (problem) return `users     NOT seeded — ORCH_ADMIN_USER/ORCH_ADMIN_PASSWORD rejected: ${problem}`;
  store.createUser(username, hashPassword(password), true);
  store.logAdmin(SERVER_CHANNEL, 'user.create', {
    actor: 'server',
    target: username,
    detail: 'first account, created from ORCH_ADMIN_USER/ORCH_ADMIN_PASSWORD',
  });
  return `users     seeded first account "${username}" from the environment — change its password`;
}

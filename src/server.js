import express from 'express';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { openDb, makeStore } from './db.js';
import { registerTools } from './tools.js';
import { createWebRouter } from './web.js';
import { createAuth } from './auth.js';

// Pick up ./.env for bare `npm start` runs. Under Docker the values arrive
// through compose's `environment:` block instead, so a missing file is normal.
// Real environment variables win over the file either way.
try { process.loadEnvFile(); } catch { /* no .env — environment only */ }

const NAME = 'appideas-orchestratinator';
// Read rather than duplicated: a hand-maintained copy of the version drifts from
// package.json the first time one of them is bumped alone, and the dashboard
// header then confidently reports a build that doesn't exist.
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const PORT = Number(process.env.PORT ?? 8787);
// Inside Docker the process must bind 0.0.0.0 to be reachable through the port
// mapping; compose publishes it on 127.0.0.1 only. Set HOST=127.0.0.1 when
// running bare on your machine if you want the kernel to enforce that too.
const HOST = process.env.HOST ?? '0.0.0.0';
const DB_PATH = process.env.DB_PATH ?? './data/orchestratinator.db';
// How long an untouched MCP session is kept before it's closed. Re-initialising
// is free (all state lives in SQLite and identity rides on the headers), so this
// can be aggressive; it exists to bound memory and to keep "connected" honest.
const SESSION_TTL_MINUTES = Number(process.env.SESSION_TTL_MINUTES ?? 15);
const SWEEP_MS = 60_000;
const STARTED_AT = new Date().toISOString();

const db = openDb(DB_PATH);
const store = makeStore(db);
const auth = createAuth();

const app = express();
// Only affects what req.ip reports, which is what the auth warnings name when an
// agent presents a bad key. Left configurable because those log lines are useless
// if every request appears to come from a proxy.
app.set('trust proxy', process.env.TRUST_PROXY ?? 'loopback');
// Ahead of the body parser: an unauthorized caller shouldn't get 4mb of parsing
// done on its behalf. /health stays open — the container healthcheck uses it.
app.use('/mcp', auth.mcpGuard);
// A restored backup is one JSON document holding an entire board, so it needs
// headroom no other route should get. Chosen per-path rather than by raising the
// limit globally: 4mb stays the ceiling for everything an agent can post.
const jsonBody = express.json({ limit: process.env.BODY_LIMIT ?? '4mb' });
const jsonRestore = express.json({ limit: process.env.RESTORE_BODY_LIMIT ?? '128mb' });
app.use((req, res, next) =>
  (req.path === '/api/admin/backup/restore' ? jsonRestore : jsonBody)(req, res, next));

// One transport per MCP session (keyed by the mcp-session-id header).
const transports = Object.create(null);
// Parallel registry of who each live session belongs to. `agents.last_seen` in
// the database only tells us when an agent last *called* something; this tells
// the dashboard which windows are actually connected right now.
const sessions = Object.create(null);
// Lifetime counters. `superseded` is the interesting one: a client that opens a
// fresh session per turn instead of reusing one will run it up fast.
const sessionStats = { opened: 0, superseded: 0, expired: 0 };

const header = (req, name) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/** Drop a session. Closing the transport fires onclose, which clears both maps. */
function closeSession(sid) {
  const transport = transports[sid];
  delete transports[sid];
  delete sessions[sid];
  if (transport) Promise.resolve(transport.close()).catch(() => { /* already gone */ });
}

/**
 * Some clients open a brand-new MCP session for every turn rather than reusing
 * one, and never DELETE the old ones (Claude Code on a `/loop` does exactly
 * this — two sessions per iteration). Left alone the registry, the per-session
 * `McpServer` instances, and the dashboard's connection count all grow forever.
 *
 * A channel+agent pair is one logical identity here, so once a new session
 * claims it, any earlier idle session for it is by definition abandoned. Closing
 * it is safe because an unknown session id now answers 404, which is the spec's
 * "start over" signal — a client that does come back just re-initialises.
 */
function supersede(sid, channel, agent) {
  if (!channel || !agent) return;
  for (const [otherId, s] of Object.entries(sessions)) {
    if (otherId === sid || s.channel !== channel || s.agent !== agent) continue;
    if (s.inflight > 0 || s.streaming) continue; // still in use — leave it alone
    sessionStats.superseded++;
    closeSession(otherId);
  }
}

/**
 * Close every live session bound to a channel, or to one agent on it.
 *
 * The dashboard's retire and delete actions need this: the session registry is a
 * second source of presence (buildState synthesises a row for any live session),
 * so a database-only change would be undone by the next tick. An unknown session
 * id answers 404, which is the spec's "re-initialise" signal, so a client that is
 * still alive reconnects and reappears — which is the intended behaviour, not a
 * leak. Returns how many it closed.
 */
function closeSessionsFor({ channel, agent = null, all = false }) {
  let closed = 0;
  for (const [sid, s] of Object.entries(sessions)) {
    if (!all) {
      if (s.channel !== channel) continue;
      if (agent && s.agent !== agent) continue;
    }
    closeSession(sid);
    closed++;
  }
  return closed;
}

/** Backstop for sessions no successor ever supersedes (unbound or last of their kind). */
function sweepIdleSessions() {
  const cutoff = Date.now() - SESSION_TTL_MINUTES * 60_000;
  for (const [sid, s] of Object.entries(sessions)) {
    if (s.inflight > 0 || s.streaming) continue;
    if (Date.parse(s.last_seen) > cutoff) continue;
    sessionStats.expired++;
    closeSession(sid);
  }
}
setInterval(sweepIdleSessions, SWEEP_MS).unref();

/**
 * Trim the floor's stored conversation to the newest turns per desk.
 *
 * Unlike the session sweep this is housekeeping on disk, not on memory: turns
 * arrive at every turn boundary from every window on the network, so without
 * this the database grows for as long as anyone is working. Run on the same
 * timer because it is cheap and because a prune that only happens at startup is
 * a prune that never happens on a server that stays up for months.
 */
setInterval(() => {
  try {
    const removed = store.pruneTurns();
    if (removed) console.log(`[orchestratinator] pruned ${removed} old turn${removed === 1 ? '' : 's'}`);
    // Work a host has already taken is only kept for a day, to answer "did that
    // message ever get delivered" — after that it is just rows.
    store.pruneHostWork();
  } catch (err) {
    console.warn(`[orchestratinator] turn prune failed: ${err.message}`);
  }
}, SWEEP_MS).unref();

const markBusy = (sid) => {
  const s = sid ? sessions[sid] : undefined;
  if (s) { s.inflight++; s.last_seen = new Date().toISOString(); }
};
const markIdle = (sid) => {
  const s = sid ? sessions[sid] : undefined;
  if (s) { s.inflight = Math.max(0, s.inflight - 1); s.last_seen = new Date().toISOString(); }
};

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    name: NAME,
    version: VERSION,
    sessions: Object.keys(transports).length,
    session_stats: { ...sessionStats },
    ts: new Date().toISOString(),
  });
});

// Client -> server messages (and the initialize handshake).
app.post('/mcp', async (req, res) => {
  const sessionId = header(req, 'mcp-session-id');
  let transport = sessionId ? transports[sessionId] : undefined;

  if (transport) {
    markBusy(sessionId);
  } else {
    if (sessionId) {
      // The client knows a session we don't: it expired or was superseded. 404 is
      // what the spec tells clients to re-initialise on, so this self-heals.
      return res.status(404).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32001, message: 'Session not found' },
      });
    }
    if (!isInitializeRequest(req.body)) {
      return res.status(400).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'No valid session. Send an initialize request first.' },
      });
    }

    // Bind this connection's channel/agent from headers set in the client's
    // .mcp.json. Tools inherit these unless a call overrides them.
    const context = {
      channel: header(req, 'x-channel') || header(req, 'x-orchestratinator-channel') || undefined,
      agent: header(req, 'x-agent') || header(req, 'x-orchestratinator-agent') || undefined,
    };

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
        const now = new Date().toISOString();
        sessions[sid] = {
          id: sid,
          channel: context.channel ?? null,
          agent: context.agent ?? null,
          connected_at: now,
          last_seen: now,
          inflight: 1,       // this initialize request; markIdle clears it
          streaming: false,  // true while an SSE GET stream is open
        };
        sessionStats.opened++;
        supersede(sid, context.channel, context.agent);
        // Record presence immediately so a freshly connected window appears on
        // the dashboard before it calls its first tool.
        if (context.channel && context.agent) {
          try { store.touchAgent(context.channel, context.agent, 'connect'); } catch { /* best-effort */ }
        }
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
        delete sessions[transport.sessionId];
      }
    };

    const server = new McpServer({ name: NAME, version: VERSION });
    registerTools(server, { store, context });
    await server.connect(transport);
  }

  try {
    await transport.handleRequest(req, res, req.body);
  } finally {
    // `transport.sessionId` is only assigned once handleRequest has run the
    // initialize handshake, so this covers new and existing sessions alike.
    markIdle(transport.sessionId);
  }
});

// Server -> client stream (GET) and session teardown (DELETE).
async function handleSessionRequest(req, res) {
  const sessionId = header(req, 'mcp-session-id');
  const transport = sessionId ? transports[sessionId] : undefined;
  if (!transport) {
    return res
      .status(sessionId ? 404 : 400)
      .json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found' } });
  }
  const s = sessions[sessionId];
  if (s) {
    s.last_seen = new Date().toISOString();
    // A held-open notification stream is the one real liveness signal we get;
    // don't let the idle sweeper cut it.
    if (req.method === 'GET') {
      s.streaming = true;
      res.on('close', () => { s.streaming = false; s.last_seen = new Date().toISOString(); });
    }
  }
  await transport.handleRequest(req, res);
}
app.get('/mcp', handleSessionRequest);
app.delete('/mcp', handleSessionRequest);

// Dashboard at `/` (+ its /api/* endpoints). Mounted last so it can never shadow
// an MCP route. There is no guard in front of it: the board is open to anything
// that can reach this port, which is the whole model on a single machine behind a
// firewall. The operator endpoints under /api/admin still refuse a cross-origin
// request, so a page you happen to visit can't drive the board on your behalf.
app.use(createWebRouter({
  store,
  sessions,
  sessionStats,
  auth,
  closeSessionsFor,
  meta: {
    name: NAME,
    version: VERSION,
    port: PORT,
    dbPath: DB_PATH,
    claimTtlMinutes: Number(process.env.CLAIM_TTL_MINUTES ?? 15),
    sessionTtlMinutes: SESSION_TTL_MINUTES,
    startedAt: STARTED_AT,
  },
}));

app.listen(PORT, HOST, () => {
  console.log(`[orchestratinator] MCP       http://localhost:${PORT}/mcp`);
  console.log(`[orchestratinator] dashboard http://localhost:${PORT}/   (db: ${DB_PATH})`);
  console.log(`[orchestratinator] ${auth.describeStartup()}`);
});

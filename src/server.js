import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { openDb, makeStore } from './db.js';
import { registerTools } from './tools.js';
import { createWebRouter } from './web.js';

const NAME = 'appideas-orchestratinator';
const VERSION = '0.2.0';
const PORT = Number(process.env.PORT ?? 8787);
// Inside Docker the process must bind 0.0.0.0 to be reachable through the port
// mapping; compose publishes it on 127.0.0.1 only. Set HOST=127.0.0.1 when
// running bare on your machine if you want the kernel to enforce that too.
const HOST = process.env.HOST ?? '0.0.0.0';
const DB_PATH = process.env.DB_PATH ?? './data/orchestratinator.db';
const STARTED_AT = new Date().toISOString();

const db = openDb(DB_PATH);
const store = makeStore(db);

const app = express();
app.use(express.json({ limit: '4mb' }));

// One transport per MCP session (keyed by the mcp-session-id header).
const transports = Object.create(null);
// Parallel registry of who each live session belongs to. `agents.last_seen` in
// the database only tells us when an agent last *called* something; this tells
// the dashboard which windows are actually connected right now.
const sessions = Object.create(null);

const header = (req, name) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

app.get('/health', (_req, res) => {
  res.json({ ok: true, name: NAME, version: VERSION, sessions: Object.keys(transports).length, ts: new Date().toISOString() });
});

// Client -> server messages (and the initialize handshake).
app.post('/mcp', async (req, res) => {
  const sessionId = header(req, 'mcp-session-id');
  let transport = sessionId ? transports[sessionId] : undefined;

  if (transport) {
    if (sessions[sessionId]) sessions[sessionId].last_seen = new Date().toISOString();
  } else {
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
        };
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

  await transport.handleRequest(req, res, req.body);
});

// Server -> client stream (GET) and session teardown (DELETE).
async function handleSessionRequest(req, res) {
  const sessionId = header(req, 'mcp-session-id');
  const transport = sessionId ? transports[sessionId] : undefined;
  if (!transport) return res.status(400).send('Unknown or missing session id.');
  if (sessions[sessionId]) sessions[sessionId].last_seen = new Date().toISOString();
  await transport.handleRequest(req, res);
}
app.get('/mcp', handleSessionRequest);
app.delete('/mcp', handleSessionRequest);

// Read-only dashboard at `/` (+ its /api/* endpoints). Mounted last so it can
// never shadow an MCP route.
app.use(createWebRouter({
  store,
  sessions,
  meta: {
    name: NAME,
    version: VERSION,
    port: PORT,
    dbPath: DB_PATH,
    claimTtlMinutes: Number(process.env.CLAIM_TTL_MINUTES ?? 15),
    startedAt: STARTED_AT,
  },
}));

app.listen(PORT, HOST, () => {
  console.log(`[orchestratinator] MCP       http://localhost:${PORT}/mcp`);
  console.log(`[orchestratinator] dashboard http://localhost:${PORT}/   (db: ${DB_PATH})`);
});

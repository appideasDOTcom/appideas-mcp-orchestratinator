import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { openDb, makeStore } from './db.js';
import { registerTools } from './tools.js';

const PORT = Number(process.env.PORT ?? 8787);
const DB_PATH = process.env.DB_PATH ?? './data/orchestratinator.db';

const db = openDb(DB_PATH);
const store = makeStore(db);

const app = express();
app.use(express.json({ limit: '4mb' }));

// One transport per MCP session (keyed by the mcp-session-id header).
const transports = Object.create(null);

const header = (req, name) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

app.get('/health', (_req, res) => {
  res.json({ ok: true, name: 'appideas-orchestratinator', sessions: Object.keys(transports).length, ts: new Date().toISOString() });
});

// Client -> server messages (and the initialize handshake).
app.post('/mcp', async (req, res) => {
  const sessionId = header(req, 'mcp-session-id');
  let transport = sessionId ? transports[sessionId] : undefined;

  if (!transport) {
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
      onsessioninitialized: (sid) => { transports[sid] = transport; },
    });
    transport.onclose = () => {
      if (transport.sessionId) delete transports[transport.sessionId];
    };

    const server = new McpServer({ name: 'appideas-orchestratinator', version: '0.1.0' });
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
  await transport.handleRequest(req, res);
}
app.get('/mcp', handleSessionRequest);
app.delete('/mcp', handleSessionRequest);

app.listen(PORT, () => {
  console.log(`[orchestratinator] listening on http://localhost:${PORT}/mcp  (db: ${DB_PATH})`);
});

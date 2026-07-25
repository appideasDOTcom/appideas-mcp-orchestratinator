import { z } from 'zod';
import { STATUS_TTL_SECONDS } from './db.js';

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const safeParse = (s) => { try { return JSON.parse(s); } catch { return s; } };

/**
 * Resolve which channel/agent a call applies to.
 * Precedence: explicit tool argument > value bound to the connection via
 * X-Channel / X-Agent headers (see server.js) > default.
 */
function resolve(args, context) {
  const channel = (args.channel && String(args.channel)) || context.channel;
  const agent = (args.agent && String(args.agent)) || context.agent || 'anon';
  if (!channel) {
    throw new Error(
      "No channel bound to this connection. Set an 'X-Channel' header in your .mcp.json " +
      "(recommended — see README) or pass a 'channel' argument explicitly."
    );
  }
  return { channel, agent };
}

/**
 * Register every coordination tool on a per-session McpServer instance.
 * `context` carries the channel/agent this connection is bound to.
 */
export function registerTools(server, { store, context }) {
  // Presence is best-effort: recording who called what powers the dashboard's
  // "last-known state", but must never fail a real tool call.
  const touch = (channel, agent, action) => {
    try { store.touchAgent(channel, agent, action ?? null); } catch { /* ignore */ }
  };

  server.tool(
    'whoami',
    'Report the channel and agent identity bound to this connection, and list the agents currently present on the channel. Call this first to confirm your wiring.',
    {
      channel: z.string().optional().describe('Override the channel bound via header.'),
      agent: z.string().optional().describe('Override the agent identity bound via header.'),
    },
    async (args) => {
      const { channel, agent } = resolve(args, context);
      touch(channel, agent, 'whoami');
      return ok({
        channel,
        agent,
        boundViaHeader: { channel: context.channel ?? null, agent: context.agent ?? null },
        present: store.listAgents(channel),
      });
    }
  );

  server.tool(
    'set_status',
    'Report what you are currently doing. Shows on the dashboard at the server root so a human can see at a glance whether you are working, waiting or stuck — the one thing nothing else can tell them, because a gap between tool calls looks identical whether you are blocked, crashed, or just finished. Nothing reads it back. Call it whenever your state changes meaningfully, and especially before anything long-running.',
    {
      status: z.enum(['working', 'waiting', 'blocked', 'idle'])
        .describe('working = making progress; waiting = expecting something that should arrive on its own (a test run, another agent); blocked = cannot proceed without intervention; idle = nothing in hand.'),
      detail: z.string().max(200).optional()
        .describe('One short line a human will actually read, e.g. "e2e public tier, ~8m". This is the part that makes the status useful — include it.'),
      ttl_seconds: z.number().int().min(30).max(3600).optional()
        .describe(`How long this status stays believable (default ${STATUS_TTL_SECONDS}s). Past it the dashboard shows a derived state instead, so a crash cannot strand a stale label. Set it to roughly how long you expect the work to take.`),
      channel: z.string().optional(),
      agent: z.string().optional(),
    },
    async (args) => {
      const { channel, agent } = resolve(args, context);
      touch(channel, agent, 'set_status');
      const detail = args.detail?.trim() || null;
      const ttl = args.ttl_seconds ?? STATUS_TTL_SECONDS;
      store.setAgentStatus(channel, agent, args.status, detail, ttl);
      return ok({ set: true, channel, agent, status: args.status, detail, ttl_seconds: ttl });
    }
  );

  server.tool(
    'send_message',
    'Post a message to the channel. Omit "to" to broadcast to everyone; set "to" (e.g. "pro") to direct-message one agent. The recipient receives it on their next poll_messages.',
    {
      body: z.any().describe('Message content: a string or a structured object.'),
      to: z.string().optional().describe('Recipient agent name. Omit to broadcast.'),
      channel: z.string().optional(),
      agent: z.string().optional().describe('Sender identity override.'),
    },
    async (args) => {
      const { channel, agent } = resolve(args, context);
      touch(channel, agent, 'send_message');
      const id = store.insertMessage(channel, agent, args.to ?? null, JSON.stringify(args.body ?? null));
      return ok({ sent: true, id, channel, from: agent, to: args.to ?? null });
    }
  );

  server.tool(
    'poll_messages',
    'Fetch messages addressed to you (direct messages, plus broadcasts from others) newer than "since". Pass the returned "cursor" as "since" next time so you never re-read the same message.',
    {
      since: z.number().int().optional().describe('Highest message id you have already seen. Defaults to 0 (everything).'),
      limit: z.number().int().min(1).max(500).optional(),
      channel: z.string().optional(),
      agent: z.string().optional(),
    },
    async (args) => {
      const { channel, agent } = resolve(args, context);
      touch(channel, agent, 'poll_messages');
      const rows = store.pollMessages(channel, agent, args.since ?? 0, args.limit ?? 100);
      const messages = rows.map((r) => ({ ...r, body: safeParse(r.body) }));
      const cursor = messages.length ? messages[messages.length - 1].id : (args.since ?? 0);
      // Remember how far this agent has read so the dashboard can show a
      // meaningful unread count. Best-effort — never fail the poll over it.
      try { store.advancePollCursor(channel, agent, cursor); } catch { /* ignore */ }
      return ok({ channel, agent, count: messages.length, cursor, messages });
    }
  );

  server.tool(
    'set_contract',
    'Create or update a shared contract entry — the interface both plugins agree on (filter/hook signatures, option keys, payload shapes, versions). Bumps the version and records history.',
    {
      key: z.string().describe('Contract key, e.g. "filters.sync_payload".'),
      value: z.any().describe('The agreed value: a string or a structured object.'),
      channel: z.string().optional(),
      agent: z.string().optional(),
    },
    async (args) => {
      const { channel, agent } = resolve(args, context);
      touch(channel, agent, 'set_contract');
      const { version } = store.setContract(channel, args.key, JSON.stringify(args.value ?? null), agent);
      return ok({ set: true, channel, key: args.key, version, updated_by: agent });
    }
  );

  server.tool(
    'get_contract',
    'Read one contract entry by key, or every entry on the channel if key is omitted.',
    {
      key: z.string().optional(),
      channel: z.string().optional(),
      agent: z.string().optional(),
    },
    async (args) => {
      const { channel, agent } = resolve(args, context);
      touch(channel, agent, 'get_contract');
      if (args.key) {
        const row = store.getContract(channel, args.key);
        return ok({ channel, entry: row ? { ...row, value: safeParse(row.value) } : null });
      }
      const entries = store.listContracts(channel).map((r) => ({ ...r, value: safeParse(r.value) }));
      return ok({ channel, count: entries.length, entries });
    }
  );

  server.tool(
    'open_task',
    'Open a coordination task for the channel, optionally assigned to a specific agent.',
    {
      title: z.string(),
      body: z.string().optional(),
      assignee: z.string().optional(),
      channel: z.string().optional(),
      agent: z.string().optional(),
    },
    async (args) => {
      const { channel, agent } = resolve(args, context);
      touch(channel, agent, 'open_task');
      const id = store.openTask(channel, args.title, args.body ?? null, args.assignee ?? null, agent);
      return ok({ opened: true, id, channel, title: args.title, assignee: args.assignee ?? null, created_by: agent });
    }
  );

  server.tool(
    'list_tasks',
    'List tasks on the channel. Filter by status ("open" | "claimed" | "done") and/or mine=true (assigned to or claimed by you). Stale claims (older than CLAIM_TTL_MINUTES) auto-reopen when you list open/actionable tasks.',
    {
      status: z.enum(['open', 'claimed', 'done']).optional(),
      mine: z.boolean().optional(),
      channel: z.string().optional(),
      agent: z.string().optional(),
    },
    async (args) => {
      const { channel, agent } = resolve(args, context);
      touch(channel, agent, 'list_tasks');
      const status = args.status ?? null;
      // Self-heal: revert abandoned claims to `open` so they can't sit invisibly
      // in `claimed`. Only on actionable queries — never mutate a `status=claimed`
      // inspection, which is meant to show claims as-is.
      const reopened = status && status !== 'open' ? 0 : store.reapStaleClaims(channel);
      const tasks = store.listTasks(channel, status, args.mine ? agent : null);
      return ok({ channel, count: tasks.length, ...(reopened ? { reopened_stale_claims: reopened } : {}), tasks });
    }
  );

  server.tool(
    'claim_task',
    'Claim an open task so the other agent knows you are handling it.',
    {
      id: z.number().int(),
      channel: z.string().optional(),
      agent: z.string().optional(),
    },
    async (args) => {
      const { channel, agent } = resolve(args, context);
      touch(channel, agent, 'claim_task');
      const changed = store.claimTask(channel, args.id, agent);
      return ok({ claimed: changed > 0, id: args.id, by: agent, ...(changed ? {} : { note: 'Task not found or not open.' }) });
    }
  );

  server.tool(
    'complete_task',
    'Mark a task done, with an optional closing note (e.g. a PR link).',
    {
      id: z.number().int(),
      note: z.string().optional(),
      channel: z.string().optional(),
      agent: z.string().optional(),
    },
    async (args) => {
      const { channel, agent } = resolve(args, context);
      touch(channel, agent, 'complete_task');
      const changed = store.completeTask(channel, args.id, args.note ?? null, agent);
      return ok({ completed: changed > 0, id: args.id, by: agent, ...(changed ? {} : { note: 'Task not found or already done.' }) });
    }
  );
}

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
 * Which of an agent's sessions a name means, when `sender` writes it.
 *
 * One agent can have two sessions on a floor (desk_twins in db.js): qa at
 * its desk and qa-2 in a meeting room. An agent that writes to plain "qa"
 * knows one QA agent, not which session it is speaking with. costmo's ruling
 * (2026-11-16): the one in the sender's room. If the sender is in a live
 * meeting room with one of that agent's sessions, that session is who it
 * means; otherwise the name is the agent's first desk, as written. A name
 * written out in full ("qa-2") always goes exactly there, and a name that
 * is in the sender's room under itself is itself.
 *
 * Two readings were offered and not chosen: always the first desk (a review
 * asked for in the room would land with the session outside it), and every
 * session (each would have to decide whether a message was its own).
 */
export function addressed(store, channel, sender, name) {
  if (!name || store.twinOf(channel, name)) return name;
  const room = store.liveMeetingOf(channel, sender);
  if (!room) return name;
  const here = room.participants.filter((p) => !p.absent).map((p) => p.agent);
  if (here.includes(name)) return name;
  return here.find((a) => store.twinOf(channel, a)?.base === name) ?? name;
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
      // A second session of an agent on this floor is told so: its folder's
      // own instructions name the agent, and the name it carries here is
      // that with a number after it.
      const twin = store.twinOf(channel, agent);
      return ok({
        channel,
        agent,
        boundViaHeader: { channel: context.channel ?? null, agent: context.agent ?? null },
        ...(twin ? {
          session_of: twin.base,
          note: `You are a second session of ${twin.base} on this channel, running beside its first. Other agents know you as ${agent}: sign and address yourself by that name here. Messages and tasks addressed to ${agent} are yours; ones addressed to ${twin.base} are yours only when their sender is in a meeting room with you.`,
        } : {}),
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
    'Post a message to the channel. Omit "to" to broadcast to everyone; set "to" (e.g. "pro") to direct-message one agent. The recipient receives it on their next poll_messages. While the operator has you in a meeting room, a broadcast reaches only the room\'s other participants, and the reply names them (meeting_room.reached).',
    {
      body: z.any().describe('Message content: a string or a structured object.'),
      to: z.string().optional().describe('Recipient agent name. Omit to broadcast.'),
      channel: z.string().optional(),
      agent: z.string().optional().describe('Sender identity override.'),
    },
    async (args) => {
      const { channel, agent } = resolve(args, context);
      // A message with nothing in it is refused, not stored as null: \`body\`
      // is z.any(), so a call that names the field anything else (\`content\`,
      // \`message\`) passed validation, was filed as the text "null" and
      // answered sent: true, and the recipient read an empty message
      // (2026-11-22, two of the coordinator's to desktop-dev).
      const empty = args.body === undefined || args.body === null || (typeof args.body === 'string' && !args.body.trim());
      if (empty) {
        const other = Object.keys(args).filter((k) => !['body', 'to', 'channel', 'agent'].includes(k));
        return ok({ sent: false, error: `Nothing was sent: the message goes in "body"${other.length ? `, and this call named ${other.map((k) => `"${k}"`).join(', ')} instead` : ', and this call had none'}.` });
      }
      touch(channel, agent, 'send_message');
      // A broadcast from an agent in an open meeting room reaches that room
      // and nobody else on the floor (issue #44: a room's conversation is
      // contained). A direct message goes where it is addressed. The reply
      // says who a contained broadcast reached, so the agent is not left
      // believing the whole channel heard it.
      // And a name means the session of that agent the sender is in a room
      // with, when the agent has two on this floor (addressed, above).
      const to = args.to ? addressed(store, channel, agent, String(args.to)) : null;
      const room = to ? null : store.liveMeetingOf(channel, agent);
      // The room's desks, not its absent ones: those are on the floor and
      // hear the floor's broadcasts, not the room's (QA, PR #49 finding 1).
      const audience = room ? room.participants.filter((p) => !p.absent).map((p) => p.agent) : null;
      const id = store.insertMessage(channel, agent, to, JSON.stringify(args.body ?? null), audience);
      return ok({
        sent: true, id, channel, from: agent, to,
        ...(to && to !== args.to ? { addressed_as: args.to, note: `${args.to} has more than one session on this channel; this went to ${to}, the one in your meeting room.` } : {}),
        ...(audience ? { meeting_room: { id: room.id, reached: audience.filter((a) => a !== agent) } } : {}),
      });
    }
  );

  server.tool(
    'poll_messages',
    'Fetch messages addressed to you (direct messages, plus broadcasts from others) newer than "since". Pass the returned "cursor" as "since" next time so you never re-read the same message. A "since" above the newest id this instance has issued is a cursor from another instance: the reply says so (since_ahead) and reads from this instance\'s own record of what you were given.',
    {
      since: z.number().int().optional().describe('Highest message id you have already seen. Defaults to 0 (everything).'),
      limit: z.number().int().min(1).max(500).optional(),
      channel: z.string().optional(),
      agent: z.string().optional(),
    },
    async (args) => {
      const { channel, agent } = resolve(args, context);
      touch(channel, agent, 'poll_messages');
      // A cursor from another instance. Ids count up on each instance
      // separately, so a `since` above the highest id this one has ever
      // issued was never one of its cursors — it is what an agent remembers
      // from the instance its folder was released from. Taken at its word
      // it returned nothing, for ever and without a word, and worse: the
      // empty poll handed the number back as the cursor and the line below
      // wrote it down, so this instance then showed the agent as having read
      // everything it would ever be sent. So it is not taken at its word:
      // the poll reads from this instance's own record of what the agent has
      // been given, and says so.
      const asked = args.since ?? 0;
      const newest = store.messageHighWater();
      const ahead = asked > newest;
      // And a second session reads nothing from before it was made, whatever
      // `since` it sends: its first poll, with none, used to hand it the
      // floor's oldest hundred broadcasts, which its agent's first desk has
      // (QA, PR #57 finding 2; desk_twins.start_cursor in src/db.js).
      const since = Math.max(ahead ? store.pollCursorOf(channel, agent) : asked, store.twinOf(channel, agent)?.start_cursor ?? 0);
      const rows = store.pollMessages(channel, agent, since, args.limit ?? 100);
      const messages = rows.map((r) => ({ ...r, body: safeParse(r.body) }));
      const cursor = messages.length ? messages[messages.length - 1].id : since;
      // Remember how far this agent has read so the dashboard can show a
      // meaningful unread count. Best-effort — never fail the poll over it.
      try { store.advancePollCursor(channel, agent, cursor); } catch { /* ignore */ }
      return ok({
        channel, agent, count: messages.length, cursor, messages,
        ...(ahead ? {
          since_ahead: {
            asked, newest, read_from: since,
            note: `"since" ${asked} is above the newest message id this instance has issued (${newest}), so it is a cursor from another instance. Read from this instance's own record of what ${agent} has been given (${since}) instead. Use the cursor returned here from now on.`,
          },
        } : {}),
      });
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
      // The session of the assignee the opener is in a room with (addressed).
      const assignee = args.assignee ? addressed(store, channel, agent, String(args.assignee)) : null;
      const id = store.openTask(channel, args.title, args.body ?? null, assignee, agent);
      return ok({
        opened: true, id, channel, title: args.title, assignee, created_by: agent,
        ...(assignee && assignee !== args.assignee ? { addressed_as: args.assignee, note: `${args.assignee} has more than one session on this channel; this is assigned to ${assignee}, the one in your meeting room.` } : {}),
      });
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

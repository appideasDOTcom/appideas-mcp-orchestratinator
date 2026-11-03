// Which channels each source on the live board yields, with the names in the
// differences — the measurement issues #21 and #6 were decided on (2026-11-02:
// listAllChannels 16, personas 18, channel_flags 0; the gap was exactly the two
// persona-only channels). Run it with board-query.sh; read-only.
//   .claude/skills/measure-live-data/board-query.sh .claude/skills/measure-live-data/channel-sets.js
const db = new (require('better-sqlite3'))(process.env.DB_PATH, { readonly: true });
const col = (sql) => db.prepare(sql).all().map((r) => r.channel).filter((c) => c != null);
const sets = {
  // The board's list as src/db.js defines it since 8f4a703 (issue #6: personas
  // are in the union). Keep this in step with listAllChannels in src/db.js —
  // a stale copy here reported 16 against a server counting 18 (2026-11-03).
  listAllChannels: col(`SELECT channel FROM (
     SELECT channel FROM agents UNION SELECT channel FROM messages
     UNION SELECT channel FROM tasks UNION SELECT channel FROM contracts
     UNION SELECT channel FROM personas
   ) WHERE channel IS NOT NULL ORDER BY channel`),
  // The list before 8f4a703, for comparison: what the board showed when it
  // and the floor disagreed.
  listAllChannels_pre_8f4a703: col(`SELECT channel FROM (
     SELECT channel FROM agents UNION SELECT channel FROM messages
     UNION SELECT channel FROM tasks UNION SELECT channel FROM contracts
   ) WHERE channel IS NOT NULL ORDER BY channel`),
  agents: col(`SELECT DISTINCT channel FROM agents ORDER BY channel`),
  agents_unretired: col(`SELECT DISTINCT channel FROM agents WHERE retired_at IS NULL ORDER BY channel`),
  messages: col(`SELECT DISTINCT channel FROM messages ORDER BY channel`),
  tasks: col(`SELECT DISTINCT channel FROM tasks ORDER BY channel`),
  contracts: col(`SELECT DISTINCT channel FROM contracts ORDER BY channel`),
  personas: col(`SELECT DISTINCT channel FROM personas ORDER BY channel`),
  channel_flags: col(`SELECT channel FROM channel_flags ORDER BY channel`),
  channel_flags_archived: col(`SELECT channel FROM channel_flags WHERE archived_at IS NOT NULL ORDER BY channel`),
  hosted_desks: col(`SELECT DISTINCT channel FROM hosted_desks ORDER BY channel`),
  agent_sessions: col(`SELECT DISTINCT channel FROM agent_sessions ORDER BY channel`),
  turns: col(`SELECT DISTINCT channel FROM turns ORDER BY channel`),
};
for (const [k, v] of Object.entries(sets)) console.log(`${k.padEnd(24)} ${String(v.length).padStart(3)}  ${v.join(', ')}`);
const diff = (a, b) => sets[a].filter((c) => !sets[b].includes(c));
console.log('\n--- differences ---');
console.log('personas − listAllChannels :', diff('personas', 'listAllChannels'), ' (pre-8f4a703 list:', diff('personas', 'listAllChannels_pre_8f4a703'), ')');
console.log('listAllChannels − personas :', diff('listAllChannels', 'personas'));
console.log('agents − personas          :', diff('agents', 'personas'));
console.log('personas − agents          :', diff('personas', 'agents'));
console.log('hosted_desks − personas    :', diff('hosted_desks', 'personas'));
console.log('personas − hosted_desks    :', diff('personas', 'hosted_desks'));
console.log('channel_flags − personas   :', diff('channel_flags', 'personas'));
console.log('channel_flags − listAll    :', diff('channel_flags', 'listAllChannels'));
console.log('\n--- per-channel rows for the persona-only channels ---');
for (const c of diff('personas', 'listAllChannels')) {
  const n = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE channel = ?`).get(c).n;
  console.log(c, { personas: n('personas'), agents: n('agents'), messages: n('messages'), tasks: n('tasks'), contracts: n('contracts'), hosted_desks: n('hosted_desks'), agent_sessions: n('agent_sessions'), turns: n('turns') },
    db.prepare(`SELECT agent, seat, assigned_at FROM personas WHERE channel = ?`).all(c));
}
console.log('\n--- admin_events archive history ---');
console.log(db.prepare(`SELECT id, channel, action, actor, target, created_at FROM admin_events WHERE action LIKE '%archiv%' OR action LIKE '%channel.delete%' ORDER BY id`).all());
console.log('\n--- personas rows total:', db.prepare(`SELECT COUNT(*) AS n FROM personas`).get().n, ' agents rows total:', db.prepare(`SELECT COUNT(*) AS n FROM agents`).get().n);

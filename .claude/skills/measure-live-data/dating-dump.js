// Everything timed the board holds, for dating things that happened before
// a log carried times (task 262, issue #5). Read-only; run through
// board-query.sh, which runs it inside the server's container:
//
//   .claude/skills/measure-live-data/board-query.sh .claude/skills/measure-live-data/dating-dump.js > /tmp/board.json
//
// turns: arrival on the board's clock (created_at is not in the INSERT);
// admin_events: the operator's actions, to the second — the anchors
// align-host-log.mjs pins the host log to; messages: write rate.
const db = new (require('better-sqlite3'))(process.env.DB_PATH, { readonly: true });
const clip = (o) => { for (const k of Object.keys(o)) if (typeof o[k] === 'string' && o[k].length > 300) o[k] = o[k].slice(0, 300); return o; };
process.stdout.write(JSON.stringify({
  turns: db.prepare('SELECT id, channel, agent, session_id, role, substr(text, 1, 200) AS text, tool_name, via, created_at FROM turns ORDER BY id').all(),
  admin: db.prepare('SELECT * FROM admin_events ORDER BY id').all().map((r) => clip({ ...r })),
  messages: db.prepare('SELECT id, channel, from_agent, to_agent, created_at FROM messages ORDER BY id').all(),
}));

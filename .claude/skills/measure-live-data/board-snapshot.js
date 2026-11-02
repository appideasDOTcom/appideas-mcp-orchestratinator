// What the board holds about conversations, read-only — run through
// board-query.sh. Prints a summary, then one line starting @@JSON@@ carrying
// every session, every session with turns, and every hosted desk, for
// disk-join.mjs to set against the transcripts on a host's disk.
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH, { readonly: true });
const one = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);
console.log('TURN_RETENTION:', process.env.TURN_RETENTION ?? '(unset → 400 rows a desk)', '| DB MB:', (require('fs').statSync(process.env.DB_PATH).size / 1e6).toFixed(1));
console.log('turns:', JSON.stringify(one(`SELECT COUNT(*) n, COUNT(DISTINCT channel || '|' || agent) desks, COUNT(DISTINCT session_id) sessions, MIN(created_at) oldest, MAX(created_at) newest, SUM(LENGTH(text)) chars FROM turns`)));
for (const r of all(`SELECT role, COUNT(*) n, SUM(LENGTH(text)) chars FROM turns GROUP BY role ORDER BY n DESC`)) console.log('  role', JSON.stringify(r));
console.log('desks at the retention cap:', all(`SELECT COUNT(*) n FROM turns GROUP BY channel, agent`).filter((r) => r.n >= Number(process.env.TURN_RETENTION ?? 400)).length);
console.log('agent_sessions:', JSON.stringify(one(`SELECT COUNT(*) n, COUNT(DISTINCT channel || '|' || agent) desks, MIN(started_at) oldest, MAX(updated_at) newest, SUM(transcript IS NOT NULL) with_transcript, SUM(model IS NOT NULL) with_model, SUM(git_branch IS NOT NULL) with_branch FROM agent_sessions`)));
console.log('hosts:', JSON.stringify(all(`SELECT host_id, name, last_seen FROM hosts`)), '| hosted_desks:', one(`SELECT COUNT(*) n FROM hosted_desks`).n);
const sessions = all(`SELECT s.session_id, s.channel, s.agent, s.cwd, s.transcript, s.model, s.git_branch, s.started_at, s.updated_at, s.ended_at, (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.session_id) turns FROM agent_sessions s`);
const turnSessions = all(`SELECT session_id, channel, agent, COUNT(*) turns, MIN(created_at) first, MAX(created_at) last FROM turns GROUP BY session_id`);
const desks = all(`SELECT channel, agent, host_id, cwd, state, sdk_session_id FROM hosted_desks`);
console.log(`@@JSON@@${JSON.stringify({ sessions, turnSessions, desks })}`);

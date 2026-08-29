import Database from 'better-sqlite3';
const db = new Database('./data/marquee.db');
const CH = 'appideas-orchestratinator-ui';

const agent = db.prepare(`INSERT OR REPLACE INTO agents
  (channel, agent, last_seen, poll_cursor, status, status_detail, status_at, status_expires_at, last_action, last_action_at)
  VALUES (@ch, @agent, datetime('now', @seen), @cursor, @status, @detail,
          datetime('now', @statusAt), datetime('now', @expires), @action, datetime('now', @actionAt))`);
const msg = db.prepare(`INSERT INTO messages (channel, from_agent, to_agent, body) VALUES (?, ?, ?, ?)`);
const task = db.prepare(`INSERT INTO tasks (channel, title, status, created_by, assignee, claimed_by) VALUES (?, ?, ?, ?, ?, ?)`);
const persona = db.prepare(`INSERT OR REPLACE INTO personas (channel, agent, persona, seat) VALUES (?, ?, ?, ?)`);

// Ada: reported status, a long detail line, no mail, nothing on the board.
agent.run({ ch: CH, agent: 'coordinator', seen: '-20 seconds', cursor: 99999,
  status: 'working', detail: 'porting the board row onto the desk — sign, tray, and the shared derivation behind both',
  statusAt: '-4 minutes', expires: '+26 minutes', action: 'send_message', actionAt: '-28 seconds' });
persona.run(CH, 'coordinator', 'Ada', 0);

// Bo: reported status, unread mail, and open tasks assigned — both pills.
agent.run({ ch: CH, agent: 'appideas-qa', seen: '-1 minute', cursor: 0,
  status: 'waiting', detail: 'second agent for the interface test — messaging only this session, standing by for a nudge',
  statusAt: '-15 minutes', expires: '+15 minutes', action: 'poll_messages', actionAt: '-6 minutes' });
persona.run(CH, 'appideas-qa', 'Bo', 1);

// Cy: status long expired, so the sign shows the derived label instead.
agent.run({ ch: CH, agent: 'builder', seen: '-3 minutes', cursor: 0,
  status: 'working', detail: 'this detail is stale and must not be shown',
  statusAt: '-90 minutes', expires: '-60 minutes', action: 'claim_task', actionAt: '-52 minutes' });
persona.run(CH, 'builder', 'Cy', 2);

// Di: never reported a status at all, and nothing waiting — one card only.
agent.run({ ch: CH, agent: 'scribe', seen: '-40 minutes', cursor: 99999,
  status: null, detail: null, statusAt: '-40 minutes', expires: '-40 minutes',
  action: 'get_contract', actionAt: '-40 minutes' });
persona.run(CH, 'scribe', 'Di', 3);

msg.run(CH, 'coordinator', 'appideas-qa', JSON.stringify('no-op, no action required'));
msg.run(CH, 'coordinator', null, JSON.stringify('broadcast: first UI change is in'));
msg.run(CH, 'coordinator', 'builder', JSON.stringify('one'));
msg.run(CH, 'coordinator', 'builder', JSON.stringify('two'));

task.run(CH, 'verify the sign renders in both themes', 'open', 'coordinator', 'appideas-qa', null);
task.run(CH, 'check the tray against a narrow window', 'open', 'coordinator', 'appideas-qa', null);
task.run(CH, 'rebuild the container', 'claimed', 'coordinator', 'builder', 'builder');

console.log('seeded');

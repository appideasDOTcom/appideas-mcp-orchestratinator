#!/usr/bin/env node
/*
 * The README fixture's host taking work: what landing-seed.mjs's host does
 * not do. Run beside it for the captures that need a desk to answer — the
 * meeting room (README meeting-room.png), where every message the room sends
 * is one chat per desk and each desk's delivery is read off its own turns.
 *
 *   node .claude/skills/verify-ui-change/landing-host.mjs &
 *
 * A chat comes back the way host/index.js reports one: the words as the
 * desk's user turn, then the desk's reply. The replies are scripted per
 * agent and per message (REPLIES below), in the fixture's own story — the
 * TrailTracker 2.0 launch — so a capture reads as a team at work and says
 * nothing about any real product. A message the script does not know gets a
 * plain acknowledgement, so a stray send still settles rather than spinning.
 *
 * Without this, a meeting room's message sits at "sending" on every desk:
 * the board queues the chat and nothing takes it.
 */
const BASE = process.env.ORCH_SHOT_BASE ?? 'http://localhost:8906';
const KEY = process.env.ORCH_AUTH_TOKEN ?? 'k';
const HOST = 'h1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The windows landing-seed.mjs registers, by channel/agent: the session id is
// `sess-<window>` there, and a turn must name it to land in the desk's panel.
const WINDOW = {
  'trailtracker-mobile/project-manager': 'tt-pm',
  'trailtracker-mobile/designer': 'tt-design',
  'trailtracker-mobile/app-developer': 'tt-app',
  'trailtracker-mobile/api-developer': 'tt-api',
  'trailtracker-mobile/marketing-site-dev': 'tt-site',
  'trailtracker-mobile/qa-engineer': 'tt-qa',
  'bookinator-wp/wp-developer': 'bk-plugin',
  'bookinator-wp/qa-engineer': 'bk-qa',
  'bookinator-wp/project-manager': 'bk-pm',
};

/* Keyed by a word in the message, then by agent. */
const REPLIES = [
  {
    when: /App Review/i,
    'project-manager': 'Checklist is down to three: the screenshot set (App Developer, capturing now), the security sentence for the launch page (API Developer), and the RC regression (QA). Nothing else blocks Thursday.',
    'api-developer': 'One open item on my side: confirming the Android Keystore path. iOS is confirmed — keychain, AES-256 at rest. The sentence for the launch page is within the hour.',
    'qa-engineer': 'Ready to start the regression the moment the RC is tagged. The full run is about forty minutes; results go to the channel.',
  },
  {
    when: /regression/i,
    'qa-engineer': 'On it — watching for the 2.0 RC tag, and I will post the run to the channel as soon as it finishes.',
  },
];
const replyTo = (agent, text) => REPLIES.find((r) => r.when.test(text) && r[agent])?.[agent] ?? 'Got it.';

const events = (evs) => fetch(`${BASE}/api/host/events`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestratinator-key': KEY },
  body: JSON.stringify({ host_id: HOST, events: evs }),
}).then((r) => r.json()).catch((e) => ({ error: String(e) }));
let uuid = 0;
const turn = (channel, agent, role, text) => ({
  type: 'turn', channel, agent, session_id: `sess-${WINDOW[`${channel}/${agent}`]}`,
  role, text, at: new Date().toISOString(), uuid: `lh${process.pid}-${++uuid}`,
});

async function handle({ channel, agent, kind, payload }) {
  if (kind !== 'chat' || !WINDOW[`${channel}/${agent}`]) return;
  const text = payload?.text ?? '';
  await sleep(300);
  await events([turn(channel, agent, 'user', text)]);
  await sleep(900 + Math.floor(Math.random() * 900));
  await events([turn(channel, agent, 'assistant', replyTo(agent, text))]);
}

console.error(`landing host ${HOST} taking work on ${BASE}`);
for (;;) {
  try {
    const r = await fetch(`${BASE}/api/host/work?host_id=${HOST}&wait=2`, { headers: { 'x-orchestratinator-key': KEY } });
    const got = await r.json();
    for (const item of got.work ?? []) {
      console.log(JSON.stringify({ at: Date.now(), kind: item.kind, channel: item.channel, agent: item.agent }));
      handle(item).catch((e) => console.error(`handling ${item.kind}: ${e}`));
    }
  } catch (e) {
    console.error(`work poll: ${e}`);
    await sleep(500);
  }
}

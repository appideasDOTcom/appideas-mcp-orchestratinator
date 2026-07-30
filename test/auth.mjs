// End-to-end test for the human half of the door: dashboard sign-in, the accounts
// behind it, and export/restore.
//
// Three properties matter more than the happy paths and are asserted first in each
// block: (1) agents are unaffected by any of it — they authenticate with the shared
// secret and must keep coordinating whether or not a person is signed in; (2) a
// disabled or deleted account stops working *now*, not when its cookie expires;
// (3) nothing here can strand the person at the keyboard outside their own board.
//   npm run test:auth
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { readdirSync, rmSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = Number(process.env.AUTH_TEST_PORT ?? 8898);
const DB_PATH = `./data/auth-${process.pid}.db`;
const HOST = `http://localhost:${PORT}`;
const CHANNEL = 'auth-test';
const KEY = 'auth-shared-secret';
const AUTH_HEADER = 'X-Orchestratinator-Key';
const ADMIN_HEADER = 'X-Orch-Admin-Token';
const SEED_USER = 'costmo';
const SEED_PASS = 'passw0rd';

let failures = 0;
const assert = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures++;
};
const eq = (actual, expected, msg) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? '✓' : '✗'} ${msg}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
  if (!ok) failures++;
};

const parse = (res) => JSON.parse(res.content[0].text);
const call = (client, name, args = {}) => client.callTool({ name, arguments: args }).then(parse);

async function waitHealthy() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${HOST}/health`)).ok) return true; } catch { /* retry */ }
    await sleep(100);
  }
  return false;
}
async function makeClient(agent) {
  const transport = new StreamableHTTPClientTransport(new URL(`${HOST}/mcp`), {
    requestInit: { headers: { 'X-Channel': CHANNEL, 'X-Agent': agent, [AUTH_HEADER]: KEY } },
  });
  const client = new Client({ name: `auth-${agent}`, version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
}
const close = async (t) => { try { await t.close(); } catch { /* already gone */ } };
const rmDb = (p) => { for (const ext of ['', '-wal', '-shm']) { try { rmSync(p + ext); } catch { /* ignore */ } } };

/** Just enough of a cookie jar to hold one browser's worth of state. */
function jar() {
  const cookies = new Map();
  return {
    take(res) {
      for (const line of res.headers.getSetCookie?.() ?? []) {
        const [pair] = line.split(';');
        const eqAt = pair.indexOf('=');
        const name = pair.slice(0, eqAt).trim();
        const value = pair.slice(eqAt + 1).trim();
        if (!value || /Expires=Thu, 01 Jan 1970/i.test(line)) cookies.delete(name);
        else cookies.set(name, value);
      }
      return res;
    },
    header() { return [...cookies].map(([k, v]) => `${k}=${v}`).join('; '); },
    has(name) { return cookies.has(name); },
    get(name) { return cookies.get(name); },
    clear() { cookies.clear(); },
  };
}

const get = (browser, path, headers = {}, init = {}) =>
  browser.take ? fetch(`${HOST}${path}`, { headers: { ...(browser.header() ? { cookie: browser.header() } : {}), ...headers }, ...init }).then((r) => browser.take(r))
    : fetch(`${HOST}${path}`, { headers, ...init });

/**
 * Visit `/?key=…` the way the cookie-drop is meant to work.
 *
 * `redirect: 'manual'` is load-bearing: the drop happens on the 302, and fetch
 * following it would hand back only the final response's headers — so the cookie
 * this is testing for would be thrown away before the jar ever saw it.
 */
const visitWithKey = (browser) => get(browser, `/?key=${KEY}`, {}, { redirect: 'manual' });
const post = (browser, path, body, headers = {}) =>
  fetch(`${HOST}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(browser?.header?.() ? { cookie: browser.header() } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  }).then((r) => (browser?.take ? browser.take(r) : r));

const json = async (res) => ({ status: res.status, json: await res.json().catch(() => ({})) });

/** Sign in and return the browser's jar, or throw with the server's reason. */
async function signIn(username, password) {
  const b = jar();
  const { status, json: body } = await json(await post(b, '/api/login', { username, password }));
  if (status !== 200) throw new Error(body.error ?? `HTTP ${status}`);
  return b;
}

/** An authenticated admin call, using whatever this browser is holding. */
async function adminPost(browser, path, body, token) {
  return json(await post(browser, `/api/admin/${path}`, body, token ? { [ADMIN_HEADER]: token } : { [AUTH_HEADER]: KEY }));
}

const server = spawn('node', ['src/server.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH,
    ORCH_AUTH_TOKEN: KEY,
    ORCH_AUTH_MODE: 'enforce',
    // Off, so every refusal below is the *login* refusing — not the shared-secret
    // dashboard guard, which has its own coverage.
    ORCH_AUTH_PROTECT_UI: 'false',
    ORCH_ADMIN_USER: SEED_USER,
    ORCH_ADMIN_PASSWORD: SEED_PASS,
    ORCH_SESSION_DAYS: '30',
  },
  stdio: 'inherit',
});

let alpha;
const snapshots = [];

try {
  if (!(await waitHealthy())) throw new Error('server did not become healthy');
  console.log('server healthy\n');

  console.log('agents are not affected by any of this');
  {
    // The whole point of a separate human door. If this ever fails, adding logins
    // has broken coordination, which is worse than the dashboard being open.
    alpha = await makeClient('alpha');
    const who = await call(alpha.client, 'whoami');
    eq(who.channel, CHANNEL, 'an agent with the shared secret still connects and works');
    await call(alpha.client, 'send_message', { body: 'something for the backup' });
    await call(alpha.client, 'set_contract', { key: 'iface.v1', value: { args: ['a'] } });
    await call(alpha.client, 'open_task', { title: 'work worth backing up' });

    const health = await fetch(`${HOST}/health`);
    eq(health.status, 200, '/health stays open for the container healthcheck');
  }

  console.log('\nthe seeded first account');
  {
    const s = await json(await get(jar(), '/api/session'));
    eq([s.status, s.json.login_required, s.json.user], [200, true, null], 'ORCH_ADMIN_USER seeded an account, so a sign-in is required');
    eq(s.json.users, 1, 'and it is the only one');
  }

  console.log('\nwhat an unauthenticated browser gets');
  {
    const page = await fetch(`${HOST}/`);
    const html = await page.text();
    eq(page.status, 401, 'the dashboard refuses a browser with no credential');
    assert(/name="password"/.test(html) && /orchestratinator/.test(html), 'and answers with the sign-in form');
    assert(!/api\/state/.test(html), 'which is self-contained — it is not the dashboard with a form on top');

    const api = await json(await fetch(`${HOST}/api/state`));
    eq([api.status, api.json.login_required], [401, true], '/api/state says login_required, so an open tab knows to reload');

    const tok = await json(await fetch(`${HOST}/api/admin/token`));
    eq(tok.status, 401, 'and no operator token is handed out');
  }

  console.log('\nsigning in');
  {
    const b = jar();
    const wrong = await json(await post(b, '/api/login', { username: SEED_USER, password: 'not-it' }));
    eq(wrong.status, 401, 'a wrong password is refused');
    assert(!b.has('orch_session'), 'and drops no session cookie');
    assert(!/password/i.test(wrong.json.error) || /do not match/i.test(wrong.json.error),
      'the refusal does not say which half was wrong');

    const ghost = await json(await post(jar(), '/api/login', { username: 'nobody-here', password: 'not-it' }));
    eq(ghost.json.error, wrong.json.error, 'an unknown username gets the identical message — no account enumeration');

    const cross = await json(await post(jar(), '/api/login', { username: SEED_USER, password: SEED_PASS }, { origin: 'https://evil.example' }));
    eq(cross.status, 403, 'a login fired from another origin → 403');

    const ok = await json(await post(b, '/api/login', { username: SEED_USER, password: SEED_PASS }));
    eq([ok.status, ok.json.user], [200, SEED_USER], 'the right password signs in');
    assert(b.has('orch_session'), 'and drops a session cookie');

    const state = await json(await get(b, '/api/state'));
    eq(state.status, 200, 'the board is readable with it');

    // The reason to have logins at all: no more `/?key=` per browser.
    const tok = await json(await get(b, '/api/admin/token'));
    assert(tok.status === 200 && typeof tok.json.token === 'string', 'a sign-in alone buys the operator token');

    const s = await json(await get(b, '/api/session'));
    eq([s.json.user, s.json.shared_secret], [SEED_USER, false], 'and /api/session names you rather than the shared key');
  }

  console.log('\nthe shared secret is still a way in');
  {
    // Break-glass: this is what gets you back to the board when the password is
    // gone, and what curl and the other test suites use.
    const viaKey = await fetch(`${HOST}/api/state`, { headers: { [AUTH_HEADER]: KEY } });
    eq(viaKey.status, 200, 'the shared secret reads the board without any account');

    const b = jar();
    const visit = await visitWithKey(b);
    assert(b.has('orch_key'), '/?key=… still drops its cookie with sign-in switched on');
    eq(visit.status, 302, 'and redirects to a clean URL so the secret leaves the address bar');
    eq((await get(b, '/')).status, 200, 'after which the cookie alone reaches the dashboard');
    const s = await json(await get(b, '/api/session'));
    eq([s.json.user, s.json.shared_secret], [null, true], 'that browser is authenticated but nameless');
  }

  const me = await signIn(SEED_USER, SEED_PASS);
  const token = (await json(await get(me, '/api/admin/token'))).json.token;

  console.log('\nmanaging accounts');
  {
    const list = await json(await get(me, '/api/admin/users', { [ADMIN_HEADER]: token }));
    eq([list.json.users.length, list.json.you], [1, SEED_USER], 'the list names you, so the UI knows which row is yours');
    assert(!('password' in list.json.users[0]), 'and never carries a password hash');

    const short = await adminPost(me, 'users/create', { username: 'dana', password: 'short' }, token);
    eq(short.status, 400, 'a password under 8 characters → 400');
    const mismatch = await adminPost(me, 'users/create', { username: 'dana', password: 'longenough', verify: 'longenouhg' }, token);
    eq(mismatch.status, 400, 'a mistyped verify → 400');
    const shouty = await adminPost(me, 'users/create', { username: 'Da na!', password: 'longenough' }, token);
    eq(shouty.status, 400, 'a username with spaces and punctuation → 400');

    const made = await adminPost(me, 'users/create', { username: 'DANA', password: 'dana-password', verify: 'dana-password' }, token);
    eq([made.status, made.json.username], [200, 'dana'], 'a new account is created, lower-cased');
    const dupe = await adminPost(me, 'users/create', { username: 'dana', password: 'another-one' }, token);
    eq(dupe.status, 409, 'a duplicate username → 409');

    const dana = await signIn('dana', 'dana-password');
    eq((await json(await get(dana, '/api/state'))).status, 200, 'the new account can sign in and read the board');

    // Disabling has to bite immediately. A toggle that waits for a cookie to
    // expire is not a way to take someone's access away.
    const off = await adminPost(me, 'users/enabled', { username: 'dana', enabled: false }, token);
    eq([off.status, off.json.user.enabled], [200, false], 'disabling is accepted');
    eq((await json(await get(dana, '/api/state'))).status, 401, "and dana's existing session stops working at once");
    const blocked = await post(jar(), '/api/login', { username: 'dana', password: 'dana-password' });
    eq(blocked.status, 401, 'a disabled account cannot sign in either');

    const on = await adminPost(me, 'users/enabled', { username: 'dana', enabled: true }, token);
    eq(on.status, 200, 're-enabling is accepted');
    eq((await json(await get(dana, '/api/state'))).status, 200, 'and the same cookie works again — nobody had to reissue a password');
  }

  console.log('\nthe two rules that stop you locking yourself out');
  {
    const self = await adminPost(me, 'users/enabled', { username: SEED_USER, enabled: false }, token);
    eq(self.status, 400, 'you cannot disable the account you are signed in as');
    assert(/signed in as/.test(self.json.error), 'and are told why');
    const gone = await adminPost(me, 'users/delete', { username: SEED_USER }, token);
    eq(gone.status, 400, 'nor delete it');
    eq((await json(await get(me, '/api/state'))).status, 200, 'so you are still on the board');

    // A shared-secret caller has no account of its own to strand, and is the way
    // back in when someone does. It is deliberately unrestricted.
    const viaKey = await adminPost(jar(), 'users/enabled', { username: SEED_USER, enabled: false });
    eq(viaKey.status, 200, 'the shared secret may disable any account, including that one');
    await adminPost(jar(), 'users/enabled', { username: SEED_USER, enabled: true });
    eq((await json(await get(me, '/api/state'))).status, 200, 'and re-enabling puts it back');
  }

  console.log('\nrenaming and changing a password');
  {
    const renamed = await adminPost(me, 'users/update', { username: 'dana', new_username: 'dana.k' }, token);
    eq([renamed.status, renamed.json.username], [200, 'dana.k'], 'an account can be renamed');
    const nothing = await adminPost(me, 'users/update', { username: 'dana.k' }, token);
    eq(nothing.status, 400, 'an update that changes nothing → 400');
    const collide = await adminPost(me, 'users/update', { username: 'dana.k', new_username: SEED_USER }, token);
    eq(collide.status, 409, 'renaming onto an existing account → 409');

    // Two browsers signed in as the same person, so "signs out the others" has
    // something to prove.
    const one = await signIn('dana.k', 'dana-password');
    const two = await signIn('dana.k', 'dana-password');
    eq((await json(await get(two, '/api/state'))).status, 200, 'a second browser signs in as dana.k');

    // The password change comes from `one`, so `one` is the browser that survives.
    const tokenOne = (await json(await get(one, '/api/admin/token'))).json.token;
    const changed = await adminPost(one, 'users/update', { username: 'dana.k', password: 'a-brand-new-one', verify: 'a-brand-new-one' }, tokenOne);
    eq(changed.status, 200, 'a password change is accepted');
    eq((await json(await get(one, '/api/state'))).status, 200, 'the browser that made the change stays signed in');
    eq((await json(await get(two, '/api/state'))).status, 401, 'every other browser for that account is signed out');
    assert(/signing out [1-9]\d* other browser session/.test((changed.json.changed ?? []).join(' ')), 'and it says so rather than leaving it to be discovered');

    const old = await post(jar(), '/api/login', { username: 'dana.k', password: 'dana-password' });
    eq(old.status, 401, 'the old password no longer works');
    const fresh = await signIn('dana.k', 'a-brand-new-one');
    eq((await json(await get(fresh, '/api/state'))).status, 200, 'the new one does');

    // Renaming is not a credential change, so it must not sign anyone out.
    const tokenFresh = (await json(await get(fresh, '/api/admin/token'))).json.token;
    await adminPost(fresh, 'users/update', { username: 'dana.k', new_username: 'dana' }, tokenFresh);
    eq((await json(await get(fresh, '/api/state'))).status, 200, 'a rename carries its own session along with it');
    eq((await json(await get(fresh, '/api/session'))).json.user, 'dana', 'and the session reports the new name');
  }

  console.log('\nsigning out, and deleting an account');
  {
    const dana = await signIn('dana', 'a-brand-new-one');
    const out = await post(dana, '/api/logout', {});
    eq(out.status, 200, 'sign-out is accepted');
    assert(!dana.has('orch_session'), 'and the cookie is cleared');

    // Sign-out has to take the shared-secret cookie too, or "sign out" leaves a
    // browser holding every operator power.
    const both = jar();
    await visitWithKey(both);
    await post(both, '/api/login', { username: SEED_USER, password: SEED_PASS });
    assert(both.has('orch_key') && both.has('orch_session'), 'a browser can hold both credentials at once');
    await post(both, '/api/logout', {});
    assert(!both.has('orch_key') && !both.has('orch_session'), 'and sign-out clears both');

    const live = await signIn('dana', 'a-brand-new-one');
    const del = await adminPost(me, 'users/delete', { username: 'dana' }, token);
    eq([del.status, del.json.enabled_users_left], [200, 1], 'deleting an account is accepted, and says how many remain');
    eq((await json(await get(live, '/api/state'))).status, 401, "and that account's live session dies with it");
    const missing = await adminPost(me, 'users/delete', { username: 'dana' }, token);
    eq(missing.status, 404, 'deleting an account that does not exist → 404');
  }

  console.log('\nthe login throttle');
  {
    // Keyed on a name nobody has, so a burst of guessing can't cost a real user
    // their own access — which is exactly what a per-account lockout would do.
    let last = 0;
    for (let i = 0; i < 10; i++) {
      last = (await post(jar(), '/api/login', { username: 'ghost', password: `guess-${i}` })).status;
      if (last === 429) break;
    }
    eq(last, 429, 'repeated failures are throttled');
    const still = await post(me, '/api/session', {});
    assert(still.status !== 429, 'and the throttle is on the attempt, not on the server');
    const real = await signIn(SEED_USER, SEED_PASS);
    eq((await json(await get(real, '/api/state'))).status, 200, 'a real account elsewhere is unaffected');
  }

  console.log('\nexporting a backup');
  {
    const res = await get(me, '/api/admin/backup', { [ADMIN_HEADER]: token });
    const doc = await res.json();
    eq(res.status, 200, 'the export is served');
    assert(/attachment; filename="orchestratinator-backup-/.test(res.headers.get('content-disposition') ?? ''), 'as a download with a dated filename');
    eq(doc.format, 'orchestratinator-backup', 'and identifies its own format');
    assert(doc.counts.messages > 0 && doc.counts.tasks > 0 && doc.counts.contracts > 0, 'it carries the board (messages, tasks, contracts)');
    assert(doc.counts.contract_history > 0, 'including contract version history');
    assert(doc.tables.users.length === 1 && typeof doc.tables.users[0].password === 'string', 'and the accounts, with their hashes');

    // The two things that must never be in a file that ends up in a Downloads
    // folder: the key every agent authenticates with, and live login cookies.
    const raw = JSON.stringify(doc);
    assert(!raw.includes(KEY), 'the shared MCP secret is nowhere in the file');
    assert(/^sha256:[0-9a-f]{12}$/.test(doc.auth.shared_secret_fingerprint), 'only a fingerprint of it, to check the far end matches');
    assert(!('ui_sessions' in doc.tables), 'live sign-in cookies are not exported');
    assert(doc.auth.env_required.some((v) => /ORCH_AUTH_TOKEN/.test(v)), 'and it lists what the new host still needs configured');
  }

  console.log('\nrestoring a backup');
  {
    const before = await get(me, '/api/admin/backup', { [ADMIN_HEADER]: token });
    const doc = await before.json();
    const msgsBefore = doc.counts.messages;
    // A second browser on the same account, so "everyone else is signed out" has
    // something to demonstrate rather than merely claim.
    const other = await signIn(SEED_USER, SEED_PASS);

    const wrongWord = await adminPost(me, 'backup/restore', { backup: doc, confirm: 'yes' }, token);
    eq(wrongWord.status, 400, 'a restore without the word RESTORE → 400');
    const notABackup = await adminPost(me, 'backup/restore', { backup: { hello: 'world' }, confirm: 'RESTORE' }, token);
    eq(notABackup.status, 400, 'a file that is not a backup → 400');
    assert(/not an orchestratinator-backup/.test(notABackup.json.error), 'and says so plainly');
    const fromTheFuture = await adminPost(me, 'backup/restore', { backup: { ...doc, format_version: 99 }, confirm: 'RESTORE' }, token);
    eq(fromTheFuture.status, 400, 'a backup from a newer format → 400 rather than a partial load');

    // Move the board away from the backup, so a successful restore has something
    // to actually undo.
    await call(alpha.client, 'send_message', { body: 'written after the backup' });
    await call(alpha.client, 'open_task', { title: 'also after the backup' });
    const drifted = await get(me, '/api/admin/backup', { [ADMIN_HEADER]: token });
    assert((await drifted.json()).counts.messages > msgsBefore, 'the live board has drifted past the backup');

    const done = await adminPost(me, 'backup/restore', { backup: doc, confirm: 'RESTORE' }, token);
    eq(done.status, 200, 'an exact confirmation restores');
    assert(done.json.rows > 0, `and reports the rows it loaded (${done.json.rows})`);
    assert(done.json.snapshot?.saved === true, 'having first written the pre-restore board to disk');
    if (done.json.snapshot?.path) snapshots.push(done.json.snapshot.path);
    assert(done.json.sessions_closed >= 1, 'live agent sessions are closed so they rejoin the restored board');

    // The restore replaced the users table, so every cookie issued against the old
    // one is gone — but the person who pressed the button is handed a fresh session
    // rather than the sign-in form, because the account they were using is in the
    // backup too. Otherwise nobody ever sees the report of what they just did.
    assert(done.json.replaced_users === true, 'the accounts in the backup replaced the live ones');
    assert((done.json.notes ?? []).some((n) => /everyone signs in against the restored accounts/.test(n)), 'which signs every browser out');
    assert((done.json.notes ?? []).some((n) => new RegExp(`kept you signed in as "${SEED_USER}"`).test(n)), 'except this one, and it says so');
    eq((await json(await get(me, '/api/state'))).status, 200, 'so the operator who restored is still on the board');
    eq((await json(await get(other, '/api/state'))).status, 401, 'while a second browser signed in beforehand is out');

    const after = await get(me, '/api/admin/backup', { [ADMIN_HEADER]: token });
    eq((await after.json()).counts.messages, msgsBefore, 'the board is back to what the backup held');
    const board = await json(await get(me, '/api/state'));
    assert(board.json.channels.some((c) => c.channel === CHANNEL), 'with its channel intact');
  }

  const back = me;
  const token2 = (await json(await get(back, '/api/admin/token'))).json.token;

  console.log('\na restore that would leave nobody able to sign in');
  {
    eq((await json(await get(back, '/api/state'))).status, 200, 'the restored credentials still work');
    const doc = await (await get(back, '/api/admin/backup', { [ADMIN_HEADER]: token2 })).json();

    // Restoring this literally is faithful and useless: it produces a server with
    // a sign-in requirement and nobody who can satisfy it.
    const empty = { ...doc, tables: { ...doc.tables, users: [] } };
    const kept = await adminPost(back, 'backup/restore', { backup: empty, confirm: 'RESTORE' }, token2);
    eq(kept.status, 200, 'a backup carrying no accounts still restores its data');
    eq(kept.json.replaced_users, false, 'but does not replace the accounts');
    assert((kept.json.notes ?? []).some((n) => /kept the current dashboard users/.test(n)), 'and says that it kept them');
    if (kept.json.snapshot?.path) snapshots.push(kept.json.snapshot.path);
    eq((await json(await get(back, '/api/state'))).status, 200, 'so this browser is still signed in');
    const users = await json(await get(back, '/api/admin/users', { [ADMIN_HEADER]: token2 }));
    eq(users.json.users.length, 1, 'and the account list is untouched');
  }

  console.log('\naudit trail');
  {
    const feed = await (await get(back, '/api/activity?limit=500')).json();
    const rows = feed.rows.filter((r) => r.kind.startsWith('admin.'));
    const kinds = new Set(rows.map((r) => r.kind));
    // The restore wiped admin_events, so what survives is what happened after it —
    // which is the property worth asserting: the log records the restore itself.
    for (const k of ['admin.backup.restore', 'admin.backup.export']) assert(kinds.has(k), `${k} is in the feed`);
    const restore = rows.find((r) => r.kind === 'admin.backup.restore');
    eq(restore?.channel, '(server)', 'server-wide actions are filed under "(server)"');
    eq(restore?.actor, SEED_USER, 'and are attributed to the person who signed in, not to a generic operator');
    assert(/restored \d+ rows/.test(restore?.detail ?? ''), 'with a detail saying what happened');
    // A channel that only ever appeared in admin_events must not turn into a card.
    const board = await json(await get(back, '/api/state'));
    assert(!board.json.channels.some((c) => c.channel === '(server)'), '"(server)" never shows up as a channel on the board');

    // The account actions from earlier went into the table the restore wiped, so
    // run one of each now and check every kind lands with its own label.
    await adminPost(back, 'users/create', { username: 'temp.user', password: 'temp-password' }, token2);
    await adminPost(back, 'users/update', { username: 'temp.user', new_username: 'temp.user2' }, token2);
    await adminPost(back, 'users/enabled', { username: 'temp.user2', enabled: false }, token2);
    await adminPost(back, 'users/enabled', { username: 'temp.user2', enabled: true }, token2);
    await adminPost(back, 'users/delete', { username: 'temp.user2' }, token2);
    const after = await (await get(back, '/api/activity?limit=500')).json();
    const seen = new Set(after.rows.map((r) => r.kind));
    for (const k of ['admin.user.create', 'admin.user.update', 'admin.user.disable', 'admin.user.enable', 'admin.user.delete']) {
      assert(seen.has(k), `${k} is in the feed`);
    }
    const userRows = after.rows.filter((r) => r.kind.startsWith('admin.user.'));
    // The one row not attributed to a person is the account seeded from the
    // environment at startup, and it must stay distinguishable from one a human
    // created — "the server did this" and "costmo did this" are different facts.
    const seed = userRows.find((r) => r.actor === 'server');
    assert(!!seed && /from ORCH_ADMIN_USER/.test(seed.detail ?? ''), 'the seeded account is attributed to "server", not to a person');
    // Attribution follows whoever was signed in, not whoever owns the board: the
    // rename block did its work from a browser signed in as dana.k, and the log has
    // to say dana.k. A feed where every human action reads "operator" would make
    // this whole surface unauditable.
    const others = userRows.filter((r) => r !== seed);
    assert(others.some((r) => r.actor === SEED_USER) && others.some((r) => r.actor === 'dana.k'),
      'the names differ by who actually did it');
    assert(userRows.every((r) => !!r.actor), 'no row is left unattributed');
    assert(userRows.every((r) => !/scrypt\$/.test(r.detail ?? '')), 'and no password hash reaches the activity log');

    // The one caller with no name to give. Keeping it as the literal "operator" is
    // the honest answer: something holding the shared key did this, and the key
    // says nothing about who was holding it.
    await adminPost(jar(), 'users/create', { username: 'keymade', password: 'key-made-this' });
    const anon = await (await get(back, '/api/activity?limit=500')).json();
    const row = anon.rows.find((r) => r.kind === 'admin.user.create' && r.target === 'keymade');
    eq(row?.actor, 'operator', 'an action taken with the shared secret is attributed to "operator"');
    await adminPost(jar(), 'users/delete', { username: 'keymade' });
  }

  console.log('\nthe session cookie is not a licence to write');
  {
    // The reason to worry: cookies are exactly what CSRF rides on, and this server
    // now has one that means "signed in". It must not be spendable on its own — a
    // write still needs the custom header, which a cross-origin request cannot send
    // without a preflight this server never answers.
    const cookieOnly = await json(await post(back, '/api/admin/users/create', { username: 'sneaky', password: 'sneaky-password' }));
    eq(cookieOnly.status, 401, 'a session cookie alone cannot take an operator action');

    const foreign = await json(await post(
      back,
      '/api/admin/users/create',
      { username: 'sneaky', password: 'sneaky-password' },
      { [ADMIN_HEADER]: token2, origin: 'https://evil.example' }
    ));
    eq(foreign.status, 403, 'and a valid token from a foreign Origin is still refused');

    const tokenCross = await get(back, '/api/admin/token', { origin: 'https://evil.example' });
    eq(tokenCross.status, 403, 'nor can another origin exchange the cookie for a token');

    const list = await json(await get(back, '/api/admin/users', { [ADMIN_HEADER]: token2 }));
    assert(!list.json.users.some((u) => u.username === 'sneaky'), 'so no account was created by either attempt');
  }

  console.log('\ndeleting the last account reopens the board');
  {
    // Stated in the README as the way out of a lockout, so it is worth proving
    // rather than assuming.
    const gone = await adminPost(jar(), 'users/delete', { username: SEED_USER });
    eq([gone.status, gone.json.enabled_users_left], [200, 0], 'the shared secret can delete the last account');
    assert(/no longer requires a sign-in/.test(gone.json.warning ?? ''), 'and warns what that means');
    const open = await fetch(`${HOST}/api/state`);
    eq(open.status, 200, 'with no accounts left, the dashboard is readable again');
    const s = await json(await fetch(`${HOST}/api/session`));
    eq([s.json.login_required, s.json.users], [false, 0], 'and /api/session agrees nobody needs to sign in');
  }
} catch (err) {
  console.error('auth test error:', err);
  failures++;
} finally {
  if (alpha) await close(alpha.transport);
  server.kill('SIGKILL');
  rmDb(DB_PATH);
  for (const p of snapshots) { try { rmSync(p); } catch { /* ignore */ } }
  // Belt to that braces: a failed run may have left snapshots unreported.
  try {
    for (const f of readdirSync('./data')) {
      if (f.startsWith('pre-restore-')) rmSync(`./data/${f}`);
    }
  } catch { /* no data dir */ }
}

console.log(`\n${failures === 0 ? 'PASS ✅' : 'FAIL ❌'} — ${failures} failure(s)`);
process.exit(failures ? 1 : 0);

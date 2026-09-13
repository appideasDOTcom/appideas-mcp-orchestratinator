#!/usr/bin/env node
/**
 * Report one Claude Code hook event to the orchestratinator's floor.
 *
 * This runs inside somebody's session, on the critical path of their work, so
 * the rules it lives by are narrow:
 *
 *   1. Never fail loudly. A hook that prints an error interrupts a person who is
 *      concentrating on something else entirely. Every failure here — no config,
 *      bad JSON, server down, network gone — exits 0 in silence. The floor going
 *      stale is a visible symptom on the floor; a red line in someone's terminal
 *      is a bug report about a feature they didn't ask about.
 *   2. Never block. The wrapper in hooks.json detaches this process, and the
 *      request carries its own short timeout as a second line of defence.
 *   3. Never send more than the floor uses. `tool_input` is reduced to the one
 *      descriptive field that becomes the collapsed line, so a Write of a whole
 *      file does not put that file on the network.
 *
 * What this reports is *state*, not content: a turn started, a prompt is open,
 * the session ended. The conversation itself the floor reads from Claude Code's
 * own transcript (see host/window.js), which is complete and does not depend on
 * a hook firing. Content is still sent, and is still used — but only for a desk
 * whose machine has no host running, where a partial conversation beats none.
 *
 * Identity is not configured. It is read from the repo's own `.mcp.json` — the
 * same file that already declares X-Channel and X-Agent to reach the board — so
 * a workstation that can talk to the orchestratinator at all needs nothing added
 * to talk to its floor. A directory with no such file is not part of this system
 * and is skipped, which is what keeps unrelated projects off the board.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const TIMEOUT_MS = Number(process.env.ORCH_FLOOR_TIMEOUT_MS ?? 2000);
/** How far up from cwd to look for `.mcp.json`, for sessions that have cd'd. */
const MAX_LEVELS = 6;
/** Matches the server's own per-turn cap; no reason to put more on the wire. */
const TEXT_MAX = 20_000;

/** The only tool_input keys the floor's collapsed line ever reads. */
const TOOL_INPUT_KEYS = ['command', 'file_path', 'path', 'pattern', 'description', 'prompt', 'url'];

const clip = (v, max) => (typeof v === 'string' && v.length > max ? v.slice(0, max) : v);

function readStdin() {
  return new Promise((done) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => done(buf));
    process.stdin.on('error', () => done(''));
  });
}

/** Case-insensitive, because a header name in hand-written JSON is whatever the
 *  person typing it felt like that day, and both spellings work over HTTP. */
function header(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want && typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** The orchestratinator entry in a set of MCP servers, or null. An entry
 *  qualifies only if it carries both X-Channel and X-Agent — that pair is the
 *  orchestratinator's signature, and matching on it rather than on a server
 *  name means a repo can call the entry whatever it likes. */
function identityIn(servers) {
  for (const s of Object.values(servers && typeof servers === 'object' ? servers : {})) {
    const channel = header(s?.headers, 'X-Channel');
    const agent = header(s?.headers, 'X-Agent');
    if (channel && agent && typeof s?.url === 'string') {
      return { channel, agent, url: s.url, key: header(s.headers, 'X-Orchestratinator-Key') };
    }
  }
  return null;
}

/** The resolved spelling of a path, or the path itself when it has none.
 *  Claude Code keys `projects` by the resolved path (a cwd of /tmp/x is filed
 *  under /private/tmp/x), and the event's cwd may be spelled either way. */
function real(dir) {
  try { return realpathSync(dir); } catch { return dir; }
}

/**
 * Every directory bound in Claude Code's local scope — `~/.claude.json` →
 * `projects[dir].mcpServers`, which is what `claude mcp add -s local` writes
 * and what the floor binds a desk with (docs/desk-from-the-floor.md).
 * `CLAUDE_CONFIG_DIR` moves the file, so it is honoured. Read once per event;
 * a file that is absent, mid-rewrite, or broken yields an empty map and the
 * walk below falls back to `.mcp.json` alone — never half of something.
 */
function readLocalScope() {
  const out = new Map();
  let projects;
  try {
    projects = JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json'), 'utf8'))?.projects;
  } catch {
    return out;
  }
  if (!projects || typeof projects !== 'object') return out;
  for (const [dir, p] of Object.entries(projects)) {
    const id = identityIn(p?.mcpServers);
    if (id) out.set(dir, id);
  }
  return out;
}

/**
 * Walk up from the session's directory for the binding that names this repo's
 * place on the board. At each level the local-scope entry is read before the
 * directory's `.mcp.json`, because that is Claude Code's own precedence: when
 * both exist, local is the one the window connects with (measured 2026-09-09
 * — `whoami` answers the local identity whatever the file says). The host's
 * `readDesk` in host/identity.js applies the same rule; they cannot share
 * code, so a change here is a change there.
 */
function findIdentity(startDir, local = readLocalScope()) {
  let dir = resolve(startDir);
  for (let i = 0; i < MAX_LEVELS; i++) {
    const mine = local.get(dir) ?? local.get(real(dir));
    if (mine) return { ...mine, root: dir };
    const file = join(dir, '.mcp.json');
    if (existsSync(file)) {
      try {
        const id = identityIn(JSON.parse(readFileSync(file, 'utf8'))?.mcpServers);
        if (id) return { ...id, root: dir };
      } catch {
        // A malformed .mcp.json is already breaking this person's MCP connection
        // and they will hear about it from somewhere that can actually help.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Claude Code's own directory name for a folder: every character that is not
 *  a letter or digit becomes a dash. The host's projectSlug is the same rule. */
const slugOf = (dir) => dir.replace(/[^A-Za-z0-9]/g, '-');

/**
 * The folder a session started in, read off its transcript path.
 *
 * Claude Code keeps every transcript under
 * `~/.claude/projects/<slug of the folder the session started in>/`, so that
 * directory name is the one fact about a session that does not move with it.
 * The walk from `cwd` is not: an agent that works inside another desk's repo
 * — a QA agent auditing the app it sits beside — fires every hook from that
 * repo, the walk finds that repo's binding, and the session is filed under the
 * other desk. Its prompts land on a desk whose window never asked them, and
 * its own desk falls silent; measured 2026-09-11, four days of it.
 *
 * The slug is lossy, so it is matched rather than inverted: against the folder
 * the event stands in and each folder above it (a session started in a
 * subfolder of its repo), then against every local-scope desk. A slug that
 * matches none of those is a session that started somewhere the walk cannot
 * see from here — its memo says where, if it was ever seen there.
 */
function startDirOf(ev, cwd, local) {
  const path = typeof ev.transcript_path === 'string' ? ev.transcript_path : '';
  const slug = path ? basename(dirname(path)) : '';
  if (!slug) return null;
  let dir = resolve(cwd);
  for (;;) {
    if (slugOf(dir) === slug || slugOf(real(dir)) === slug) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const known of local.keys()) {
    if (slugOf(known) === slug || slugOf(real(known)) === slug) return known;
  }
  return null;
}

/**
 * Where a session's repo is remembered, so an event raised from somewhere else
 * can still be reported.
 *
 * A session does not stay in its repo. Agents work in a scratch directory, in
 * /tmp, in another checkout — and findIdentity walks up from the event's cwd, so
 * the moment it is outside, nothing above it has a `.mcp.json` and the hook
 * returns in silence. Measured against a live board with one session id: cwd in
 * the repo raised the alert, cwd in /private/tmp raised nothing at all.
 *
 * That silence is worst exactly when it costs most. The conversation still
 * relays, because the host reads it off the pane and does not care where the
 * session is — so the floor looks healthy while the window sits blocked on a
 * prompt no one can see.
 *
 * What is stored is the directory, not the identity. The channel, the agent and
 * the key are read back out of that repo's own `.mcp.json` every time, so this
 * file never becomes a second copy of a credential, and a repo that changes
 * hands is not remembered as its old self.
 */
const MEMO = join(homedir(), '.orchestratinator', 'sessions.json');
/** Long enough to outlive a working session, short enough that the file does not
 *  accumulate a machine's whole history. */
const MEMO_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MEMO_MAX = 200;

function readMemo() {
  try {
    return JSON.parse(readFileSync(MEMO, 'utf8')) ?? {};
  } catch {
    // Absent, half-written, or hand-edited into nonsense. All the same here: a
    // memo that cannot be read is a memo that has nothing to say.
    return {};
  }
}

/** Remember, prune, and replace atomically — several hooks from several sessions
 *  can be writing this at once, and a torn file would take the memory of every
 *  session with it rather than just this one. */
function remember(sessionId, root) {
  try {
    const now = Date.now();
    const memo = readMemo();
    if (memo[sessionId]?.root === root) return;
    memo[sessionId] = { root, at: now };
    const live = Object.entries(memo)
      .filter(([, v]) => v && typeof v.root === 'string' && now - (Number(v.at) || 0) < MEMO_TTL_MS)
      .sort((a, b) => (Number(b[1].at) || 0) - (Number(a[1].at) || 0))
      .slice(0, MEMO_MAX);
    mkdirSync(dirname(MEMO), { recursive: true });
    const tmp = `${MEMO}.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(live)), { mode: 0o600 });
    renameSync(tmp, MEMO);
  } catch {
    // Reporting is a convenience and remembering is a convenience about a
    // convenience. Never the reason someone's session makes a noise.
  }
}

/** The board is at /mcp on the same origin the floor's ingest lives on. */
function ingestUrl(mcpUrl) {
  try {
    const u = new URL(mcpUrl);
    u.pathname = `${u.pathname.replace(/\/mcp\/?$/, '')}/api/ingest`;
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

/** Read from .git/HEAD rather than shelling out to git — one file read against
 *  a process spawn, on a path that runs many times a minute. */
function gitBranch(root) {
  try {
    const head = readFileSync(join(root, '.git', 'HEAD'), 'utf8').trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function reduceToolInput(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const k of TOOL_INPUT_KEYS) {
    if (typeof input[k] === 'string' && input[k].trim()) out[k] = clip(input[k], 300);
  }
  // An AskUserQuestion's words. The floor used to draw its choices with no
  // question above them — the host reads the choices off the pane, and this
  // was the only carrier of the question, dropped here (2026-09-11). Bounded
  // the same way as everything else in this payload.
  if (Array.isArray(input.questions)) {
    const qs = input.questions.slice(0, 8).map((q) => (q && typeof q === 'object' ? {
      question: clip(typeof q.question === 'string' ? q.question : '', 500),
      header: clip(typeof q.header === 'string' ? q.header : '', 60),
      multiSelect: q.multiSelect === true,
      options: Array.isArray(q.options) ? q.options.slice(0, 12).map((o) => ({
        label: clip(typeof o?.label === 'string' ? o.label : '', 120),
        description: clip(typeof o?.description === 'string' ? o.description : '', 300),
      })) : [],
    } : null)).filter((q) => q && q.question);
    if (qs.length) out.questions = qs;
  }
  return Object.keys(out).length ? out : null;
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return;

  let ev;
  try {
    ev = JSON.parse(raw);
  } catch {
    return;
  }

  const cwd = typeof ev.cwd === 'string' && ev.cwd ? ev.cwd : process.cwd();
  const sessionId = typeof ev.session_id === 'string' ? ev.session_id : null;

  // Which desk this session is. Its transcript path names the folder it
  // started in (startDirOf), and that outranks wherever it is standing now:
  // the walk from cwd files a session standing in another desk's repo under
  // that desk. With the start folder known, the identity is the binding at or
  // above it; a session whose start folder matches nothing visible from here
  // has its memo — written only from a start folder, so it cannot be wrong
  // about which desk — and a memo whose folder is not the one the transcript
  // names is stale and ignored. Without a transcript path (an older payload),
  // the walk from cwd stands, with the memo behind it.
  const local = readLocalScope();
  const transcriptSlug = typeof ev.transcript_path === 'string' && ev.transcript_path ? basename(dirname(ev.transcript_path)) : null;
  let id = null;
  const start = startDirOf(ev, cwd, local);
  if (start) {
    id = findIdentity(start, local);
    if (id && sessionId) remember(sessionId, id.root);
  } else if (transcriptSlug) {
    const root = sessionId ? readMemo()[sessionId]?.root : null;
    // Re-resolved rather than replayed: a remembered repo whose binding has
    // since gone is a repo that has left the board, and should report nothing.
    if (root && (slugOf(root) === transcriptSlug || slugOf(real(root)) === transcriptSlug)) id = findIdentity(root, local);
  } else {
    id = findIdentity(cwd, local);
    if (id && sessionId) remember(sessionId, id.root);
    if (!id && sessionId) {
      const root = readMemo()[sessionId]?.root;
      if (root) id = findIdentity(root, local);
    }
  }
  // Not an orchestratinator repo, and never was one. This is the common case
  // across a machine and is exactly how a user-level install stays out of
  // unrelated projects.
  if (!id) return;

  const url = process.env.ORCH_FLOOR_URL ?? ingestUrl(id.url);
  if (!url) return;

  const payload = {
    channel: process.env.ORCH_CHANNEL ?? id.channel,
    agent: process.env.ORCH_AGENT ?? id.agent,
    session_id: ev.session_id,
    hook_event_name: ev.hook_event_name,
    source: ev.source,
    transcript_path: ev.transcript_path,
    // The repo the identity came from, not wherever the session happens to be
    // standing. Everything downstream reads this as "which desk is this" — the
    // session row, the floor's label — and a desk is a checkout, not a cursor.
    // Sending the raw cwd would file a session under /private/tmp the moment its
    // agent used a scratch directory, which is the same wandering this fixes.
    cwd: id.root,
    permission_mode: ev.permission_mode,
    model: typeof ev.model === 'string' ? ev.model : ev.model?.id ?? null,
    git_branch: gitBranch(id.root),
    // Event-specific, all optional — the server reads only what the event carries.
    message: clip(ev.message, TEXT_MAX),
    last_assistant_message: clip(ev.last_assistant_message, TEXT_MAX),
    tool_name: ev.tool_name,
    tool_input: reduceToolInput(ev.tool_input),
    notification_type: ev.notification_type,
    notification_message: clip(ev.notification_message, 500),
    error_type: ev.error_type,
    error_message: clip(ev.error_message, 2000),
    reason: ev.reason,
  };

  const headers = { 'content-type': 'application/json' };
  if (id.key) headers['x-orchestratinator-key'] = id.key;

  const report = fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => {
    // The floor is a convenience. Nothing about this session depends on it, and
    // a person whose server is down should notice that on the board, not here.
  });

  await report;
}

main().then(() => process.exit(0)).catch(() => process.exit(0));

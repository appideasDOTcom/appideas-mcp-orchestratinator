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
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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

/**
 * Walk up from the session's directory for the `.mcp.json` that names this repo's
 * place on the board. An entry qualifies only if it carries both X-Channel and
 * X-Agent — that pair is the orchestratinator's signature, and matching on it
 * rather than on a server name means a repo can call the entry whatever it likes.
 */
function findIdentity(startDir) {
  let dir = resolve(startDir);
  for (let i = 0; i < MAX_LEVELS; i++) {
    const file = join(dir, '.mcp.json');
    if (existsSync(file)) {
      try {
        const servers = JSON.parse(readFileSync(file, 'utf8'))?.mcpServers ?? {};
        for (const s of Object.values(servers)) {
          const channel = header(s?.headers, 'X-Channel');
          const agent = header(s?.headers, 'X-Agent');
          if (channel && agent && typeof s?.url === 'string') {
            return { channel, agent, url: s.url, key: header(s.headers, 'X-Orchestratinator-Key'), root: dir };
          }
        }
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
  const id = findIdentity(cwd);
  // Not an orchestratinator repo. This is the common case across a machine and
  // is exactly how a user-level install stays out of unrelated projects.
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
    cwd,
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

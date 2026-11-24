#!/usr/bin/env node
/**
 * What does a real Claude Code send on a desk's path for one prompt? Every
 * record, timed, with each control_request's own fields (agent_id,
 * tool_use_id, blocked_path…), and optionally an answer to each permission
 * after a delay. The one probe behind four 0.15.0 measurements (2026-11-23):
 * a subagent's can_use_tool carries agent_id; an allow rule
 * `mcp__orchestratinator` in .claude/settings.local.json lets the board's
 * tools run unasked; a WebSearch ask carries tool_use_id and Claude Code
 * WAITS for its answer; a signed-out turn is isApiErrorMessage with
 * error "authentication_failed".
 *
 *   . scripts/node-floor.sh && node .claude/skills/measure-a-real-window/ask-probe.mjs \
 *       --prompt "Use the Bash tool to run: touch x.txt" \
 *       [--dir <scratch folder>] [--model haiku] [--answer-after 1500 | --no-answer] \
 *       [--deny] [--mcp-config <file>] [--config-dir <scratch CLAUDE_CONFIG_DIR>] [--then "<second prompt>"] [--timeout 180000]
 *
 * It costs real turns on the account `claude` is signed in with. Use a
 * scratch --dir (never a repo), haiku unless the model matters (costmo's
 * WebSearch went through ToolSearch on Opus, not on haiku), and never
 * /model or /effort in a prompt: on this path they save the machine's
 * default (memory: probe-model-writes-user-settings). --config-dir with an
 * empty folder is a signed-out Claude Code without signing anyone out.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const arg = (name, dflt = null) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const has = (name) => process.argv.includes(name);
const prompt = arg('--prompt');
if (!prompt) { console.error('--prompt is required'); process.exit(2); }
const dir = arg('--dir') ?? mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'ask-probe-'));
const answerAfter = has('--no-answer') ? null : Number(arg('--answer-after', '1500'));
const then = arg('--then');
const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio', '--replay-user-messages', '--model', arg('--model', 'haiku')];
if (arg('--mcp-config')) args.push('--mcp-config', arg('--mcp-config'));
const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith('ORCH_')) delete env[k];
if (arg('--config-dir')) { env.CLAUDE_CONFIG_DIR = arg('--config-dir'); delete env.ANTHROPIC_API_KEY; delete env.CLAUDE_CODE_OAUTH_TOKEN; }

console.log(`dir ${dir}`);
const p = spawn('claude', args, { cwd: dir, env, stdio: ['pipe', 'pipe', 'inherit'] });
const t0 = Date.now();
const at = () => String(Date.now() - t0).padStart(6);
const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
const user = (text) => send({ type: 'user', message: { role: 'user', content: text }, uuid: randomUUID() });
const short = (v, n = 160) => JSON.stringify(v ?? null).slice(0, n);
let results = 0;
let buf = '';
p.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let r;
    try { r = JSON.parse(line); } catch { console.log(at(), 'NOT JSON', line.slice(0, 160)); continue; }
    if (r.type === 'control_request') {
      const { permission_suggestions: _s, input, ...rest } = r.request ?? {};
      console.log(at(), 'control_request', r.request_id, short(rest, 400), 'input', short(input, 120));
      if (r.request?.subtype === 'can_use_tool' && answerAfter != null) {
        setTimeout(() => {
          const response = has('--deny') ? { behavior: 'deny', message: 'probe denied' } : { behavior: 'allow', updatedInput: r.request.input };
          console.log(at(), 'ANSWER', response.behavior, r.request_id);
          send({ type: 'control_response', response: { subtype: 'success', request_id: r.request_id, response } });
        }, answerAfter);
      }
    } else if (r.type === 'control_cancel_request') console.log(at(), 'control_cancel_request', short(r, 300));
    else if (r.type === 'assistant') {
      const c = r.message?.content;
      console.log(at(), 'assistant', r.isApiErrorMessage ? `API ERROR ${r.error ?? ''}` : '', short(Array.isArray(c) ? c.map((b) => b.type === 'text' ? `text:${b.text.slice(0, 80)}` : `${b.type}:${b.name ?? ''}${b.id ? `#${b.id}` : ''}`) : c, 300));
    } else if (r.type === 'user') {
      const c = r.message?.content;
      console.log(at(), 'user', r.isReplay ? '(echo)' : '', short(Array.isArray(c) ? c.map((b) => `${b.type}${b.tool_use_id ? `#${b.tool_use_id}` : ''}`) : c, 200));
    } else if (r.type === 'result') {
      results++;
      console.log(at(), 'result', r.subtype, r.is_error ? 'ERROR' : '', short(r.result, 160));
      if (results === 1 && then) user(then);
      else setTimeout(() => p.stdin.end(), 1500);
    } else console.log(at(), r.type, r.subtype ?? r.state ?? '');
  }
});
user(prompt);
setTimeout(() => { console.log(at(), 'TIMEOUT'); p.kill(); }, Number(arg('--timeout', '180000')));
p.on('exit', (code) => { console.log(at(), 'exit', code); process.exit(0); });

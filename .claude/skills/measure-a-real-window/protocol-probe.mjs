#!/usr/bin/env node
/**
 * Does this Claude Code still speak the protocol the host was built on?
 *
 *   . scripts/node-floor.sh && node .claude/skills/measure-a-real-window/protocol-probe.mjs [--claude <path>] [--model haiku] [--keep]
 *
 * The checks are host/canary.js's, the same ones the host runs by itself on
 * each Claude Code version it has not checked (task 351). This prints them.
 * It costs model turns on the account `claude` is signed in with (about a
 * dozen short ones on haiku). `--claude` names another build, for one
 * installed in a scratch npm prefix from the `latest` channel (npm i
 * --prefix <dir> @anthropic-ai/claude-code@latest), so a change is heard
 * before the stable channel brings it to operators.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeClaude } from '../../../host/canary.js';

const arg = (name, dflt = null) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const DIR = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'protocol-probe-'));
const { fails, total, version } = await probeClaude({ claude: arg('--claude', 'claude'), model: arg('--model', 'haiku'), dir: DIR, say: (l) => console.log(l) });
if (!process.argv.includes('--keep')) rmSync(DIR, { recursive: true, force: true });
else console.log(`\nkept: ${DIR}`);
console.log(`\n${fails ? 'DIFFERENT' : 'SAME'} · ${total - fails} of ${total} as measured on Claude Code ${version ?? '(version not said)'}${fails ? `, ${fails} different` : ''}`);
process.exit(fails ? 1 : 0);

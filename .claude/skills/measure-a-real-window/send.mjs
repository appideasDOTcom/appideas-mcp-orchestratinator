#!/usr/bin/env node
/**
 * The host's own send(), from the tree, against the probe window: what our
 * code does with a real Claude Code, without a board or a host in the loop.
 *
 *   printf '#!/bin/sh\nexec tmux -L probe "$@"\n' > "$SP/tmuxw"; chmod +x "$SP/tmuxw"
 *   ORCH_TMUX="$SP/tmuxw" ORCH_TMUX_SESSION=p node .claude/skills/measure-a-real-window/send.mjs "$SP/probe" '/model sonnet' '/effort high'
 *   # "/model sonnet" → {"ok":true,"command":"model","said":"Set model to Sonnet 5.5 and saved as your default for new sessions","model":"Sonnet 5.5","effort":null} 3545 ms
 *
 * Both variables are needed. ORCH_TMUX names a tmux that talks to the
 * probe's socket (the host has no -L of its own). ORCH_TMUX_SESSION is the
 * probe's session name, `p`: the host lists the panes of its own session
 * only, and without it every send reads
 *   {"ok":false,"code":"no_window","error":"no Claude Code window is open for this repo"}
 * which is the red case this was first run into (2026-11-14).
 *
 * Each text is sent in turn and its result printed with how long it took.
 * A send that waits out LAND_TIMEOUT_MS (20 s) and says `not_delivered`
 * while the pane shows the command answered means the receipt is written
 * somewhere send() does not read: that is how "Model 'x' not found" was
 * found to be a `system` record (subtype local_command), not a user one.
 *
 * A /model or /effort here writes the operator's ~/.claude/settings.json.
 * Copy it first and put it back after (SKILL.md, "A model or effort change").
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const [dir, ...texts] = process.argv.slice(2);
if (!dir || !texts.length) { console.error('usage: send.mjs <probe dir> <text> [<text> …]'); process.exit(1); }
const W = await import(`${REPO}/host/window.js`);
for (const text of texts) {
  const t0 = Date.now();
  const r = await W.send(dir, text);
  console.log(JSON.stringify(text), '→', JSON.stringify({ ok: r.ok, code: r.code, command: r.command, said: r.said, model: r.model, effort: r.effort, queued: r.queued, error: r.error }), `${Date.now() - t0} ms`);
}

// The shipped picker, run the way the host runs it: node, started by launchd.
//
//   launch-probe.sh dialog-probe.mjs <start-dir> [timeout-ms]
//
// Opens host/dialog.js's folder dialog at <start-dir> (or the nearest folder
// above it that exists) and appends what happened to out.jsonl beside the
// plist: an `open` line at once, a `done` line when the dialog closes.
import { appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { openFolderDialog, startFor } = await import(`${REPO}/host/dialog.js`);
const [out, asked, timeout] = process.argv.slice(2);
const start = startFor(asked);
const t0 = Date.now();
const o = openFolderDialog(start, { timeoutMs: Number(timeout) || 40_000 });
appendFileSync(out, `${JSON.stringify({ event: 'open', asked, start, ok: o.ok, error: o.error ?? null })}\n`);
if (o.ok) o.done.then((r) => appendFileSync(out, `${JSON.stringify({ event: 'done', ms: Date.now() - t0, ...r })}\n`));

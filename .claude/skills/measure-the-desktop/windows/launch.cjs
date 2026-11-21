// .cjs because the repo's package.json says "type": "module", and this is CommonJS.
// Start the thing under test the way the host does on Windows: execFile, no
// shell, windowsHide (unless --show), stdout and stderr read as UTF-8. Writes a
// start and an end line to out.jsonl in PROBE_DIR (default %TEMP%\orch-desktop-probe).
//
//   node launch.cjs [--out <dir>] [--show] <program> [args...]
//
// --out: where out.jsonl goes. probe-task.ps1 passes it, because a scheduled
// task starts with Task Scheduler's environment, not the shell's, so a
// PROBE_DIR set in your shell never reaches this process.
//
// Run it from probe-task.ps1, which runs it under a hidden scheduled task, or
// you have measured your own window (SKILL.md, "Windows").
//
// --show: windowsHide false. Node's windowsHide passes SW_HIDE to the child,
// and Windows Terminal honours it: wt.exe started with it made a window that
// existed (psmux saw its client attached) and was never shown.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const argv = process.argv.slice(2);
let outDir = null;
if (argv[0] === '--out') { outDir = argv[1]; argv.splice(0, 2); }
const show = argv[0] === '--show';
if (show) argv.shift();
const [program, ...args] = argv;
if (!program) { console.error('usage: node launch.cjs [--out <dir>] [--show] <program> [args...]'); process.exit(2); }

const dir = outDir || process.env.PROBE_DIR || path.join(os.tmpdir(), 'orch-desktop-probe');
fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, 'out.jsonl');
const line = (o) => fs.appendFileSync(out, JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n');

const t0 = Date.now();
line({ event: 'start', pid: process.pid, ppid: process.ppid, program, args, windowsHide: !show });
// A .cmd or .bat is refused here with EINVAL (Node will not spawn one without
// a shell since the CVE-2024-27980 fix): give an .exe, or node.exe itself.
execFile(program, args, { windowsHide: !show, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
  line({ event: 'end', ms: Date.now() - t0, exit: err ? (err.code ?? String(err.message)) : 0, signal: err?.signal ?? null, stdout, stderr });
});

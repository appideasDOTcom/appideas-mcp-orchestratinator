// Answer the form the way the browser does, while recording the pane.
const HOST = 'http://localhost:8787';
const CH = 'appideas-orchestratinator-ui', AG = 'coordinator';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { execFile } = await import('node:child_process');
const { promisify } = await import('node:util');
const { writeFile, appendFile } = await import('node:fs/promises');
const run = promisify(execFile);
const OUT = process.argv[2];
await writeFile(OUT, '');

const target = (await run('tmux', ['list-panes', '-a', '-F', '#{session_name}:#{window_index}.#{pane_index}'])).stdout.trim().split('\n')[0];
let prev = '', stop = false;
(async () => {
  while (!stop) {
    let now = '';
    try { now = (await run('tmux', ['capture-pane', '-p', '-J', '-t', target], { maxBuffer: 1 << 24 })).stdout; } catch {}
    if (now !== prev) { await appendFile(OUT, `\n===== ${new Date().toISOString().slice(11, 23)} =====\n${now}\n`); prev = now; }
    await sleep(150);
  }
})();

const desk = async () => (await (await fetch(`${HOST}/api/floor`)).json())
  .channels.flatMap((c) => c.desks.map((d) => ({ ...d, channel: c.channel })))
  .find((d) => d.channel === CH && d.agent === AG);

// Wait for a form to appear.
let req = null;
for (let i = 0; i < 120; i++) {
  const d = await desk();
  if (d?.permission?.questions?.length) { req = d.permission; break; }
  await sleep(500);
}
if (!req) { await appendFile(OUT, '\nNO FORM APPEARED\n'); stop = true; process.exit(1); }
await appendFile(OUT, `\n### form seen: ${req.request_id} — ${req.questions.map((q) => `${q.tab_title}[${q.kind},${q.options.length}]`).join(' ')}\n`);

// Pick the first real option on each question, exactly as a click would.
const MODE = process.argv[3] ?? 'last';
const real = (q) => q.options.filter((o) => !o.other);
let usedFree = false;
const answers = req.questions.map((q) => {
  const r = real(q);
  const free = q.options.find((o) => o.other);
  if (MODE === 'free' && free && q.kind !== 'multi' && !usedFree) {
    usedFree = true;
    return { choose: [free.n], text: 'typed by the self test' };
  }
  if (q.kind === 'multi') return { choose: r.slice(-2).map((o) => o.n) };
  return { choose: [r[r.length - 1]?.n ?? q.options[0].n] };
});
await appendFile(OUT, `### answering with ${JSON.stringify(answers)}\n`);
const r = await fetch(`${HOST}/api/floor/answer`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ channel: CH, agent: AG, request_id: req.request_id, answers }),
});
await appendFile(OUT, `### POST ${r.status} ${JSON.stringify(await r.json().catch(() => ({})))}\n`);

await sleep(20000);
stop = true;
await appendFile(OUT, '\n### done\n');

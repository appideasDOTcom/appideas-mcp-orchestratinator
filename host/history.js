#!/usr/bin/env node
/**
 * History across every desk on this machine: the conversations most recently
 * spoken in, and a search of what was said in them.
 *
 * Both read the transcripts Claude Code wrote, not the board's copy of them,
 * and that was decided on numbers rather than taste (measured on the first
 * board to have a real history, 2026-10-01: 104 conversations in 19 desk
 * folders, 645 MB of JSONL, 40,465 turns). The board's `turns` table is a
 * live tail — the newest 400 rows a desk — and had any row at all for 41% of
 * those conversations and about a quarter of the turns; its session table
 * had no titles, was missing 10 of the 104, and held 180 rows for
 * transcripts that are not on this disk. A search or a list built on either
 * covers part of the history without saying which part. The files are the
 * whole of it, for every host that is there to read them — and a host that
 * is not is named on the page as not covered.
 *
 * What that costs: listing every desk's conversations is the picker's own
 * bounded head-and-tail read of each file (230 ms for all 104). Searching is
 * reading and parsing every transcript — 2.7 s for all of them, un-indexed —
 * which is why a search runs in a process of its own (this file, run as a
 * script): one 70 MB transcript is a third of a second of JSON.parse, and
 * the host's relay shares an event loop with anything done in-process. A
 * child is also something that can be ended when a newer search replaces it.
 *
 * A raw byte scan would be nine times faster and is the wrong search:
 * "osascript" is in 24 files that way and in 4 conversations as words
 * anybody said, because most of a transcript is tool output.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as W from './window.js';

/** How many conversations a recent list or a search answers with, at most. */
export const HISTORY_MAX = 100;
/** How many of a folder's conversations are listed for the recent list. */
const RECENT_PER_DESK = 30;
/** How many snippets a search result carries, and how long each is. */
const SNIPPETS = 3;
const SNIPPET_CHARS = 160;

/**
 * One desk per folder. A folder is one desk at a time, so this is what a
 * host's own list already is — but a list that named a folder twice would
 * have every conversation in it read twice and listed under both names (seen
 * while measuring this against the board's table of every desk a folder had
 * ever been: 306 files read for 104 conversations, and each result three
 * times over). The first desk to name a folder keeps it.
 */
function oneDeskPerFolder(desks) {
  const seen = new Set();
  const out = [];
  for (const d of Array.isArray(desks) ? desks : []) {
    if (!d || typeof d.cwd !== 'string' || !d.channel || !d.agent) continue;
    const dir = W.canonical(d.cwd);
    if (seen.has(dir)) continue;
    seen.add(dir);
    out.push({ channel: d.channel, agent: d.agent, cwd: dir });
  }
  return out;
}

const byLastSpoken = (a, b) => (Date.parse(b.last_at ?? b.modified_at ?? '') || 0) - (Date.parse(a.last_at ?? a.modified_at ?? '') || 0);

/**
 * Every desk's conversations as the picker lists them, in one list, the most
 * recently spoken in first. Each row says which desk it belongs to — a
 * conversation is opened to read in its desk's panel, so a row that did not
 * say would be a title with nowhere to go.
 */
export async function recentAcross(desks, { perDesk = RECENT_PER_DESK, max = HISTORY_MAX } = {}) {
  const rows = [];
  for (const d of oneDeskPerFolder(desks)) {
    for (const r of await W.sessionsIn(d.cwd, { limit: perDesk })) rows.push({ ...r, channel: d.channel, agent: d.agent });
  }
  return rows.sort(byLastSpoken).slice(0, max);
}

/** The words of one turn that a search looks in. A tool call is its name and
 *  what it was given — the line the floor draws for it — never its output,
 *  which the floor never shows either. */
function searchable(t) {
  if (t.role !== 'tool') return String(t.text ?? '');
  const given = t.tool_input && typeof t.tool_input === 'object' ? Object.values(t.tool_input).filter((v) => typeof v === 'string') : [];
  return [t.tool_name, ...given].filter(Boolean).join(' ');
}

/** A stretch of text around a match, on one line, with the match inside it. */
export function snippetOf(text, at, len, width = SNIPPET_CHARS) {
  const from = Math.max(0, at - Math.floor((width - len) / 2));
  const to = Math.min(text.length, from + width);
  return `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ').trim()}${to < text.length ? '…' : ''}`;
}

/**
 * The conversations in which something matching `query` was said, the most
 * recently spoken in first, each with how many turns matched and the first
 * few of them.
 *
 * What counts as said is the caller's choice and never an accident. Plain: a
 * turn of the person's or the agent's own, in the conversation's own
 * transcript. `deep`: everything the floor would draw for it — tool calls,
 * thoughts, injected context, and the subagents' transcripts beside it. On
 * the board this was measured on, deep roughly doubled the turns hit, added
 * zero to two conversations per query, and was once the only way a
 * conversation was found at all (a word that appeared only in a command).
 *
 * The match is a case-insensitive substring: no index, no ranking, no
 * operators. It is a search of 40,000 turns, and that is quick enough to
 * read all of them every time.
 */
export async function searchAcross(desks, query, { deep = false, max = HISTORY_MAX } = {}) {
  const q = String(query ?? '').trim().toLowerCase();
  const started = Date.now();
  const rows = [];
  let files = 0;
  if (!q) return { rows, files, ms: 0 };
  const wanted = deep ? null : new Set(['user', 'assistant']);
  for (const d of oneDeskPerFolder(desks)) {
    const dir = W.projectDir(d.cwd);
    let count = 0;
    try { count = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).length; } catch { continue; }
    if (!count) continue;
    // The picker's rows for every file in the folder: the title, the times,
    // the branch and the model a result is drawn with.
    for (const row of await W.sessionsIn(d.cwd, { limit: count })) {
      files++;
      const path = join(dir, `${row.id}.jsonl`);
      const main = await W.readTranscript(path);
      if (!main.ok) continue;
      const turns = [...main.turns];
      if (deep) {
        for (const sub of await W.subagentTranscripts(path, { metaGraceMs: 0 })) {
          const r = await W.readTranscript(sub.path, { via: sub.label });
          if (r.ok) turns.push(...r.turns);
        }
      }
      let hits = 0;
      const snippets = [];
      for (const t of turns) {
        if (wanted && !wanted.has(t.role)) continue;
        const text = searchable(t);
        const at = text.toLowerCase().indexOf(q);
        if (at < 0) continue;
        hits++;
        if (snippets.length < SNIPPETS) snippets.push({ role: t.role, at: t.at ?? null, via: t.via ?? null, text: snippetOf(text, at, q.length) });
      }
      if (hits) rows.push({ ...row, channel: d.channel, agent: d.agent, hits, snippets });
    }
  }
  return { rows: rows.sort(byLastSpoken).slice(0, max), files, ms: Date.now() - started };
}

/* Run as a script: one question, asked on stdin as JSON, answered on stdout
   as JSON. The host starts this for every search — see Host.search — and
   `{"op":"recent"}` answers with the recent list instead, which is how the
   host suite asks the module about a list longer than its limit. */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { input += d; });
  process.stdin.on('end', async () => {
    try {
      const ask = JSON.parse(input);
      const desks = Array.isArray(ask.desks) ? ask.desks : [];
      const max = Number.isInteger(ask.max) && ask.max > 0 ? ask.max : HISTORY_MAX;
      const out = ask.op === 'recent'
        ? { rows: await recentAcross(desks, { max }) }
        : await searchAcross(desks, ask.query, { deep: ask.deep === true, max });
      process.stdout.write(`${JSON.stringify(out)}\n`);
    } catch (err) {
      process.stderr.write(`${err?.message ?? err}\n`);
      process.exitCode = 1;
    }
  });
}

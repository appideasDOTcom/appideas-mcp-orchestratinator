#!/usr/bin/env node
/**
 * The orchestratinator host: this workstation's link between the floor and the
 * Claude Code windows running here.
 *
 * There is one conversation per repo and nobody owns it. Claude Code runs in a
 * tmux pane; the floor types into that pane, and so do you, by attaching to it.
 * Switching between the two costs nothing because nothing moves. You never
 * exit a session to hand it over, and you never resume one to get it back.
 *
 * That is the whole of it, and it is why this file is half what it was. The
 * driver/release/fork/TTL/pid-watch machinery it used to carry existed only to
 * work around "a terminal owns its session and cannot be typed into from
 * anywhere else", which was never true. See host/window.js.
 *
 * What this process actually does:
 *
 *   - enumerates the repos here that belong to the board (each one's
 *     `.mcp.json` says which desk it is),
 *   - asks `claude agents --json` which of them have a live window,
 *   - tails each live session's own transcript and sends the turns up, so a
 *     turn you type in your own terminal appears on the floor with nothing
 *     reporting it,
 *   - and does what the floor asks: deliver a message, answer a permission
 *     prompt, stop a turn, open a window.
 *
 * It only ever reaches out. The server never connects to this machine and
 * nothing here listens on a port. If the server is down it retries with
 * backoff; if this host is down the floor says so.
 *
 *   ORCH_HOST_ROOTS   colon-separated directories to look for repos under
 *   ORCH_URL          the board, e.g. http://localhost:8787 (from .mcp.json if unset)
 *   ORCH_AUTH_TOKEN   the shared secret                     (from .mcp.json if unset)
 *   ORCH_HOST_NAME    how this machine shows on the floor   (hostname if unset)
 *   ORCH_TMUX_SESSION the tmux session the desks live in    (orch)
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { discoverDesks, originOf } from './identity.js';
import * as W from './window.js';

const CONFIG_FILE = process.env.ORCH_HOST_CONFIG ?? join(homedir(), '.orchestratinator', 'host.json');
/** How long a queued permission answer stays worth delivering. */
const ANSWER_TTL_MS = Number(process.env.ORCH_ANSWER_TTL_MS ?? 30_000);
const HEARTBEAT_MS = Number(process.env.ORCH_HOST_HEARTBEAT_MS ?? 60_000);
/** How often a startup question still on screen is said to the board again. */
const STARTUP_RESAY_MS = Number(process.env.ORCH_STARTUP_RESAY_MS ?? 60_000);
const WORK_WAIT_S = Math.max(1, Number(process.env.ORCH_HOST_POLL_WAIT ?? 25));
/** How often the roster and the transcripts are re-read. */
const WATCH_MS = Math.max(250, Number(process.env.ORCH_HOST_WATCH_MS ?? 700));
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Which key answers a permission prompt in Claude Code's own dialog. The floor
 * knows a prompt is open because the plugin's PermissionRequest hook says so —
 * structured, not scraped — and this is how the answer is typed back in.
 *
 * Deny is Escape, not a number. Claude Code's prompts do not have a fixed shape:
 * some offer three options ("Yes" / "Yes, and don't ask again" / "No"), some
 * only two ("Yes, allow reading from etc/" / "No"), and the folder-trust dialog
 * has its own. A deny that pressed "3" would do nothing at all on a two-option
 * prompt — leaving it open while the floor reported it answered — and on some
 * other shape could land on an option that is not a refusal. Escape is offered
 * by every one of them ("Esc to cancel") and was verified against a live prompt
 * to produce `The tool use was rejected`.
 *
 * Allow is "1" because the first option is the affirmative in every dialog, and
 * a number is immune to the selection having been moved by whoever is sitting
 * at the window.
 */
// The three that are always offered. Fallbacks only: when the board has read the
// window's own list it sends the option's number instead, because "No" is not
// always 3 and Escape is a different thing from choosing it — the prompt's own
// footer says so ("3. No" beside "Esc to cancel").
const ANSWER_KEY = { allow: '1', deny: 'Escape', cancel: 'Escape' };

/* The same two keys, for a prompt nothing could read. Deliberately only two:
   "interrupt" is not here because it already has its own path, which stops the
   turn rather than guessing at an answer. */
const PRESS_KEY = { yes: '1', no: 'Escape' };

const log = (...a) => console.log('[host]', ...a);
const warn = (...a) => console.warn('[host]', ...a);

/* ───────────────────────── configuration ───────────────────────── */

function loadConfig() {
  let file = {};
  if (existsSync(CONFIG_FILE)) {
    try { file = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { warn(`could not read ${CONFIG_FILE}: ${e.message}`); }
  }
  const roots = (process.env.ORCH_HOST_ROOTS ? process.env.ORCH_HOST_ROOTS.split(':') : file.roots ?? [process.cwd()])
    .map((r) => r.replace(/^~(?=$|\/)/, homedir()))
    .filter(Boolean);
  return {
    roots,
    url: process.env.ORCH_URL ?? file.url ?? null,
    token: process.env.ORCH_AUTH_TOKEN ?? file.token ?? null,
    name: process.env.ORCH_HOST_NAME ?? file.name ?? hostname(),
    hostId: process.env.ORCH_HOST_ID ?? file.host_id ?? hostname(),
  };
}

/* ───────────────────────── one desk ───────────────────────── */

/**
 * A desk is a repo. Not a session, not a process — those come and go, and the
 * desk does not care which one is there. It only tracks how far it has read
 * into whatever conversation is current, so the floor is never told the same
 * turn twice.
 */
class Desk {
  constructor(host, { channel, agent, cwd }) {
    this.host = host;
    this.channel = channel;
    this.agent = agent;
    // Canonical, because everything downstream matches this against the cwd
    // Claude Code reports and against the transcript path derived from it, and
    // a repo reached through a symlink is spelled two ways. See canonical().
    this.cwd = W.canonical(cwd);
    this.sessionId = null;   // whatever conversation is live here now
    // The conversation this desk belongs to, which outlives any window onto
    // it. sessionId goes null the moment a window closes — and that is exactly
    // when the id is needed, to reopen the same conversation rather than start
    // a fresh one. Closing an editor tab is not the end of a conversation.
    this.lastSessionId = null;
    this.holder = null;      // 'floor' | 'editor' | null, as last reported
    this.paneWindow = null;  // a tmux window in this repo, registered session or not
    this.startup = null;     // the startup question the window is sitting on, as last reported
    this.startupSaidAt = 0;
    this.holders = 0;        // live processes claiming this conversation
    this.clients = 0;        // terminals attached to the tmux session
    this.offset = 0;         // bytes of that transcript already sent up
    // When this desk started watching. What it separates is a conversation that
    // began after we were here — genuinely new, and read from its first word —
    // from one that was already running, which is joined at its current end so
    // that hours of history are not replayed onto the floor.
    this.since = Date.now();
  }

  get label() { return `${this.channel}/${this.agent}`; }

  /**
   * Follow whatever session is live in this repo, and send up anything new it
   * has said. A conversation that changes underneath — you ran /clear, or
   * opened a different one — is not a handoff to negotiate; it is simply the
   * conversation now, and the floor is told so.
   */
  /**
   * Start following a conversation, from wherever it has already got to.
   *
   * The offset is snapshotted here and nowhere else. It used to be re-taken
   * every time the *live session* changed — but which process is running a
   * conversation changes every time you switch apps, and re-snapshotting on
   * that skips everything written in between. In the worst case the window
   * opens, `send()` types the message and Claude Code writes it, all inside one
   * watch interval; the next tick then moves the offset past it and the floor
   * never sees the message it just sent.
   */
  async follow(id, fromStart = false) {
    this.lastSessionId = id;
    if (!id) { this.offset = 0; return; }
    this.offset = fromStart ? 0 : await W.transcriptSize(W.transcriptPath(this.cwd, id));
  }

  async watch(live = [], paneByPid = new Map(), allPanes = [], clients = 0) {
    // The conversation this desk is. Kept while it is still running — a desk
    // does not change conversation because another window in the same folder
    // happens to be newer, or because a tab was closed and will be reopened.
    //
    // But it is not kept for ever. `lastSessionId` used to be set once and never
    // reassigned, which made the pin outlive everything: the operator closed
    // every window, opened a new conversation, said "Good morning", and the
    // floor went on relaying the old transcript. Measured — the new sessions
    // registered with zero turns, because nothing was reading them. The only
    // way out was restarting the host, which is a terminal command, which is
    // the thing the floor exists to avoid.
    //
    // So: adopt the newest live conversation whenever the pinned one has
    // stopped running. Which is what the paragraph above follow() has always
    // claimed happens — "a conversation that changes underneath is not a
    // handoff to negotiate; it is simply the conversation now".
    const pinnedLive = this.lastSessionId && live.some((x) => x.sessionId === this.lastSessionId);
    if (!pinnedLive && live.length) {
      const newest = live.reduce((a, b) => ((b.startedAt ?? 0) > (a.startedAt ?? 0) ? b : a));
      if (newest.sessionId !== this.lastSessionId) {
        // Read from the first word if it began after we got here, and from the
        // current end if it was already going. See `since`.
        await this.follow(newest.sessionId, (newest.startedAt ?? 0) >= this.since);
      }
    }
    const session = this.lastSessionId
      ? live.find((x) => x.sessionId === this.lastSessionId) ?? null
      : null;
    const id = session?.sessionId ?? null;
    if (id !== this.sessionId) {
      // Only which process holds it changed. The conversation, and how far the
      // floor has read into it, are the desk's and survive the handover.
      this.sessionId = id;
      this.host.emit({
        type: 'session', channel: this.channel, agent: this.agent,
        session_id: id, cwd: this.cwd, pid: session?.pid ?? null,
      }, true);
    }

    // Who has it: a pane we opened, an editor we cannot type into, or nobody.
    const pane = session ? paneByPid.get(session.pid) ?? null : null;
    const holder = session ? (pane ? 'floor' : 'editor') : null;
    // A window in this repo whether or not a session has registered in it yet,
    // and how many live processes claim this conversation. Neither changes who
    // holds it; both are things the board could not otherwise tell apart from
    // nothing being there. See holderOf().
    const paneHere = W.paneIn(allPanes, this.cwd);
    const holders = this.lastSessionId
      ? live.filter((x) => x.sessionId === this.lastSessionId).length
      : 0;
    // Attached terminals ride along on this event rather than getting one of
    // their own. It is a property of the tmux session, not of a desk, so it is
    // the same number on every desk of this host — but this is the only channel
    // that reports within a watch tick, and the floor needs it within one to
    // settle a spinner on it. The register heartbeat is a minute apart.
    if (holder !== this.holder
        || (paneHere?.window ?? null) !== this.paneWindow
        || holders !== this.holders
        || clients !== this.clients) {
      this.holder = holder;
      this.paneWindow = paneHere?.window ?? null;
      this.holders = holders;
      this.clients = clients;
      this.host.emit({
        type: 'holder', channel: this.channel, agent: this.agent,
        holder, window: pane?.window ?? null, pid: session?.pid ?? null,
        window_open: this.paneWindow, holders, clients,
      }, true);
    }
    // A window here whose process is not in the roster is starting — and one
    // that stays that way is sitting on a question. Read it and put it on the
    // floor, so the person waiting on a desk that says "starting" can see what
    // it wants and answer from where they are. Said again once a minute while
    // it stands, so a server that restarted meanwhile hears it too. Why the
    // host reads these and never answers them is beside startupQuestionOf.
    const booting = paneHere && !live.some((x) => x.pid === paneHere.pid);
    const q = booting ? await W.startupQuestionAt(paneHere.target) : null;
    if (q) {
      const said = `${q.kind}|${q.options.map((o) => o.text).join('|')}`;
      if (this.startup?.said !== said || Date.now() - this.startupSaidAt > STARTUP_RESAY_MS) {
        this.startup = { said, request_id: `startup:${paneHere.window}:${q.kind}` };
        this.startupSaidAt = Date.now();
        this.host.emit({
          type: 'startup', channel: this.channel, agent: this.agent, request_id: this.startup.request_id,
          kind: q.kind, asks: q.asks, options: q.options, window: paneHere.window,
        }, true);
        log(`${this.label}: the window is asking on its way up (${q.kind}): ${q.options.map((o) => o.text).join(' / ')}`);
      }
    } else if (this.startup) {
      this.host.emit({ type: 'startup', channel: this.channel, agent: this.agent, request_id: this.startup.request_id, gone: true }, true);
      this.startup = null;
    }

    // Keep reading the desk's conversation even with no window open on it.
    // Closing a tab does not un-say what was said, and the floor should still
    // be showing it when you come back.
    if (!this.lastSessionId) return;

    const path = W.transcriptPath(this.cwd, this.lastSessionId);
    const r = await W.readTranscript(path, { after: this.offset });
    if (!r.ok) return;
    this.offset = r.offset;
    for (const turn of r.turns) {
      this.host.emit({
        type: 'turn', channel: this.channel, agent: this.agent, session_id: this.lastSessionId,
        role: turn.role, text: turn.text, at: turn.at, uuid: turn.uuid,
        tool_name: turn.tool_name ?? null, tool_input: turn.tool_input ?? null,
      });
    }
  }

  /** Type into this repo's window, opening one if there isn't one. */
  async say(text) {
    // Resume the conversation this desk is, not merely the one that happens to
    // have a window open — those differ for exactly as long as it takes to
    // switch apps, which is when the floor is used.
    const r = await W.send(this.cwd, text, { open: true, resume: this.sessionId ?? this.lastSessionId });
    if (!r.ok) {
      this.host.emit({ type: 'error', channel: this.channel, agent: this.agent, message: r.error, code: r.code ?? null }, true);
    } else if (r.unverified) {
      // Delivered, but with no transcript to check it against. The floor is
      // not told a message failed when it may well have arrived — but this
      // does not pass silently either, because silence is how messages got
      // lost in the first place.
      warn(`${this.label}: typed the message in, but there is no session to confirm it landed`);
    } else if (r.queued) {
      // Queued behind a running turn: the window has it, the conversation has
      // not recorded it yet, and it will be read at the desk's next step.
      //
      // Reported because those two facts look identical from the board, and
      // the difference is what the page is about to tell somebody. Without
      // this the composer has nothing to go on but a clock, and a clock said
      // "not recorded — send again" about a message that was delivered in
      // under a second and answered a second later.
      this.host.emit({
        type: 'delivery', channel: this.channel, agent: this.agent,
        state: 'queued', text, held: !!r.held,
      }, true);
      log(`${this.label}: queued a message behind the running turn${r.held ? ' (after waiting for the window to take it)' : ''}`);
    }
    return r;
  }

  async answer(decision, reason = null) {
    // A number is a choice off the window's own list — "2. Yes, and don't ask
    // again…" and whatever else this particular prompt offers. Approve, deny and
    // cancel are the three that are always there, so they keep names.
    const key = /^[1-9]$/.test(String(decision)) ? String(decision) : ANSWER_KEY[decision];
    if (!key) return { ok: false, error: `unknown decision ${decision}` };
    // Not sendKeys: that reports success as soon as tmux takes the key, and the
    // floor now drops a desk's prompt the moment the operator decides. See
    // answerPrompt — it looks at the window before and after, so an answer that
    // went nowhere says so instead of passing.
    // A refusal with something to say is two acts, not one: the choice opens a
    // field, the words go in it. Only deny carries one — approve and cancel have
    // nothing to explain.
    if (typeof reason === 'string') return W.denyWithReason(this.cwd, key, reason);
    return W.answerPrompt(this.cwd, key);
  }

  /** A startup question is answered by one of its own rows, by number, and
   *  nothing else: there is no approve or deny on a trust dialog. */
  async answerStartup(decision) {
    const n = Number(decision);
    if (!Number.isInteger(n) || n < 1) return { ok: false, error: `a startup question is answered by choosing one of its rows, not "${decision}"` };
    return W.answerStartup(this.cwd, n);
  }

  async interrupt() { return W.interrupt(this.cwd); }
}

/* ───────────────────────── the host ───────────────────────── */

class Host {
  constructor(cfg) {
    this.cfg = cfg;
    this.desks = new Map();
    this.outbox = [];
    this.flushTimer = null;
    this.stopping = false;
  }

  async request(path, { method = 'GET', body, timeout = REQUEST_TIMEOUT_MS } = {}) {
    const res = await fetch(`${this.cfg.url}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-orchestratinator-key': this.cfg.token ?? '' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
    return res.json();
  }

  emit(ev, now = false) {
    this.outbox.push(ev);
    if (now) return this.flush();
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 150);
    return undefined;
  }

  async flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.outbox.length) return;
    const events = this.outbox.splice(0);
    try {
      await this.request('/api/host/events', { method: 'POST', body: { host_id: this.cfg.hostId, events } });
    } catch (err) {
      warn(`events not delivered (${err.message}); will retry with the next batch`);
      this.outbox.unshift(...events);
      if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 1000);
    }
  }

  async register() {
    // Where each desk can be sat at, reported every time rather than once: a
    // window opens, closes and moves, and a stale address is worse than none.
    const desks = [];
    for (const d of this.desks.values()) {
      const held = await W.holderOf(d.cwd, d.lastSessionId).catch(() => null);
      desks.push({
        channel: d.channel, agent: d.agent, cwd: d.cwd,
        session_id: d.lastSessionId,
        window: held?.where === 'floor' ? held.window : null,
        outside_pid: held?.where === 'editor' ? held.pid : null,
        window_open: held?.paneWindow ?? null,
        holders: held?.holders ?? 0,
      });
    }
    const reply = await this.request('/api/host/register', {
      method: 'POST', body: { host_id: this.cfg.hostId, name: this.cfg.name, desks, tmux: W.tmuxSession },
    });
    // Take back the conversation ids the board is holding. A restarted host
    // has none of its own, and without them the next message from the floor
    // starts a new conversation instead of continuing the one on screen.
    for (const d of Array.isArray(reply?.desks) ? reply.desks : []) {
      const desk = this.desks.get(`${d.channel}|${d.agent}`);
      if (desk && !desk.lastSessionId && d.sdk_session_id) await desk.follow(d.sdk_session_id);
    }
    return reply;
  }

  /**
   * Look at the roots again, and take up whatever has appeared, moved or gone
   * since the last look.
   *
   * discoverDesks() used to run once, in main(), and the list it returned was
   * this host's for life. That made the most ordinary thing a person does —
   * point a repo's .mcp.json at this board, or at a new channel, and open
   * Claude Code in it — the one thing the floor could not follow: the hooks
   * reported the desk within a second (they read .mcp.json per event) while
   * the host went on serving the list it had at boot, and the compose box said
   * "No host on this board is running that repo" until somebody restarted a
   * launchd job. Closing the editor, reopening it and reloading the page all
   * correctly changed nothing. Restarting a service is not an acceptable price
   * for editing a file, so the host looks again: before every heartbeat on its
   * own, and on request (a `rescan` work item), which the board sends the
   * moment a session starts in a repo no host runs. The walk is shallow — see
   * discoverDesks — and measured at ~200ms over a real projects directory.
   *
   * A desk that has moved (same name, different repo) is a different desk and
   * gets a fresh Desk: it reads its own transcript from its own offset rather
   * than carrying the old repo's. A desk that is gone is dropped here, and the
   * next register() — which names every desk this host has, every time — is
   * how the board learns to mark it offline.
   */
  async rescan(reason = 'heartbeat') {
    const origin = originOf(this.cfg.url);
    const found = discoverDesks(this.cfg.roots).filter((d) => originOf(d.url) === origin);
    const seen = new Set();
    let changed = false;
    for (const d of found) {
      const k = `${d.channel}|${d.agent}`;
      seen.add(k);
      // A host installed before any repo was bound to its board has no token
      // to talk with. The first desk that appears is where one comes from —
      // the same rule main() applies at boot.
      if (!this.cfg.token && d.key) this.cfg.token = d.key;
      const have = this.desks.get(k);
      if (have && have.cwd === W.canonical(d.cwd)) continue;
      this.desks.set(k, new Desk(this, d));
      log(`${have ? 'moved' : 'found'} desk ${d.channel}/${d.agent}  ${d.cwd}  (${reason})`);
      changed = true;
    }
    for (const [k, desk] of this.desks) {
      if (seen.has(k)) continue;
      this.desks.delete(k);
      log(`dropped desk ${desk.label} — ${desk.cwd} no longer binds it to ${origin}  (${reason})`);
      changed = true;
    }
    return changed;
  }

  /** Re-read the roster and each desk's transcript. This is the whole of how
   *  the floor learns what is happening — no hook has to report a turn. */
  async watch() {
    const r = await W.roster();
    if (!r.ok) return;
    // Every live session per directory, not the newest one.
    //
    // A repo routinely has several conversations open at once — two editor
    // tabs, an old one reopened to look something up. Reducing them to
    // "newest" made a desk change conversation whenever a tab closed: the
    // history on the floor vanished and the next message landed in whichever
    // one happened to win. A desk is one conversation; it picks its own.
    const byCwd = new Map();
    for (const s of r.sessions) {
      if (s.kind !== 'interactive') continue;
      if (!byCwd.has(s.cwd)) byCwd.set(s.cwd, []);
      byCwd.get(s.cwd).push(s);
    }
    // Which pane is running what, read once for all desks. Who is holding a
    // conversation changes the moment somebody closes a tab, and a minute-old
    // answer is worse than none: the floor offers a composer that cannot
    // deliver, which is the failure this whole design exists to avoid.
    const allPanes = await W.panes();
    const paneByPid = new Map(allPanes.map((p) => [p.pid, p]));
    // Once per tick, not once per desk: it is one number for the whole session.
    const clients = await W.clientCount().catch(() => 0);
    for (const desk of this.desks.values()) {
      try { await desk.watch(byCwd.get(desk.cwd) ?? [], paneByPid, allPanes, clients); } catch (err) { warn(`${desk.label}: ${err.message}`); }
    }
  }

  async handle(item) {
    if (item.kind === 'rescan') {
      // Asked for rather than scheduled: the board saw a session start on a
      // desk no host runs, or somebody pressed the button, and this host may
      // be the one whose roots that repo is under. Before the desk lookup,
      // because not having the desk is the whole point. Register straight
      // after a change so the floor hears the answer in this tick rather than
      // at the next heartbeat.
      const why = item.payload?.why ?? 'asked';
      if (await this.rescan(`${why} — ${item.channel}/${item.agent}`)) await this.register();
      return;
    }
    const desk = this.desks.get(`${item.channel}|${item.agent}`);
    if (!desk) return warn(`work for a desk this host doesn't have: ${item.channel}/${item.agent}`);
    switch (item.kind) {
      case 'chat':
        if (typeof item.payload?.text === 'string' && item.payload.text.trim()) await desk.say(item.payload.text);
        break;
      case 'permission': {
        // An answer is only worth giving while the question is still on screen.
        //
        // A decision queued when no window could be reached would otherwise sit
        // there and be delivered later, into whatever window exists by then —
        // as a bare keystroke, to a prompt that is no longer asking. That is how
        // a row of 1s ended up submitted as somebody's message.
        // A startup question is not a menu: its rows have no numbers and the
        // cursor starts somewhere dangerous, so it has its own presser.
        const isStartup = String(item.payload?.request_id ?? '').startsWith('startup:');
        // "The prompt is long gone" is the premise for this drop, and it is
        // false for a startup dialog — that one stands, unlike a permission
        // prompt, until it is answered. `answerStartup` already refuses to
        // press when the dialog has genuinely moved (`no_prompt`,
        // `stale_choice`, `not_taken`), so on this path the TTL can only lose
        // a real answer, and it dropped it silently: no `emit`, so the board
        // never learned the click did nothing.
        const age = Date.now() - (Number(item.payload?.queued_at) || 0);
        if (!isStartup && item.payload?.queued_at && age > ANSWER_TTL_MS) {
          warn(`${desk.label}: dropping a ${Math.round(age / 1000)}s-old permission answer — the prompt is long gone`);
          break;
        }
        const r = isStartup
          ? await desk.answerStartup(item.payload?.decision)
          : await desk.answer(item.payload?.decision, item.payload?.reason ?? null);
        if (!r.ok) {
          warn(`${desk.label}: could not answer the prompt — ${r.error}`);
          // Told to the board, not only to this log. The floor now clears a
          // desk's prompt the moment the operator decides, on the strength of
          // this keystroke being sent; if it was not sent, the window is still
          // sitting at a question nobody can see. Reporting it raises the desk
          // again with the reason, which is the only thing that keeps the early
          // clear honest.
          // What was observed, and which decision it was: the desk re-poses on
          // this, and "your approve did not land, the window still reads X" is
          // something a person can act on where "failed" is not. A startup
          // question is answered by a row number, never approve/deny, so it
          // gets its own wording and its own code — `startup_answer_failed` —
          // so the floor's re-offer (src/floor.js) fires on it too, rather than
          // leaving the desk at a bare error for up to a minute.
          this.emit({
            type: 'error', channel: desk.channel, agent: desk.agent,
            code: isStartup ? 'startup_answer_failed' : null,
            message: isStartup
              ? `your choice did not reach the window — ${r.error}`
              : `your ${item.payload?.decision === 'deny' ? 'deny' : 'approve'} did not land — ${r.error}`,
          }, true);
        }
        break;
      }
      // What the window is offering. Asked for when a prompt opens rather than
      // read on a timer: one capture per prompt instead of one per desk per
      // poll, and it is only ever wanted at that moment.
      case 'prompt': {
        // Two shapes arrive here. A permission prompt is one flat menu; an
        // AskUserQuestion is a form with a tab per question, and only one of
        // them is on screen at a time. The tab strip is what tells them apart,
        // and reading a form costs a walk, so it is only done when there is one.
        const form = await W.readQuestions(desk.cwd);
        const isForm = form.ok && form.questions?.length;
        const r = isForm ? form : await W.readPrompt(desk.cwd);
        // Said out loud, because a form that never reaches the panel is
        // indistinguishable from one that was never read — and the panel falls
        // back to Approve/Deny, which looks like a working answer to the wrong
        // question.
        log(`${desk.channel}/${desk.agent}: read ${isForm
          ? `a form of ${form.questions.length} question(s): ${form.questions.map((q) => `${q.tab_title ?? '?'}[${q.kind},${(q.options ?? []).length}]`).join(' ')}`
          : `${(r.options ?? []).length} option(s)${r.ok ? '' : ` — ${r.error}`}`}`);
        this.emit({
          type: 'prompt', channel: desk.channel, agent: desk.agent,
          request_id: item.payload?.request_id ?? null,
          options: isForm ? [] : (r.ok ? r.options : []),
          questions: isForm ? form.questions : null,
          tabs: isForm ? form.tabs : null,
          reason: r.ok ? null : r.error,
          // The prose above is for the operator; this is for the board. "There
          // is no question on this pane" and "there is a question I could not
          // parse" need opposite handling, and only one of them should ever put
          // guess buttons in front of somebody.
          code: r.ok ? null : (r.code ?? null),
        }, true);
        break;
      }
      // A whole form, played as one sequence. The board worked out the keys from
      // the same reading of the pane the panel was drawn from; the host's job is
      // to press them and to stop the moment the window is no longer asking.
      case 'answer': {
        const steps = Array.isArray(item.payload?.steps) ? item.payload.steps : [];
        const age = Date.now() - (Number(item.payload?.queued_at) || 0);
        if (item.payload?.queued_at && age > ANSWER_TTL_MS) {
          warn(`${desk.label}: dropping a ${Math.round(age / 1000)}s-old answer — the question is long gone`);
          break;
        }
        const r = await W.answerQuestion(desk.cwd, steps);
        if (!r.ok) {
          warn(`${desk.label}: could not answer the question — ${r.error}`);
          this.emit({
            type: 'error', channel: desk.channel, agent: desk.agent, code: 'answer_failed',
            message: `your answers did not land — ${r.error}`,
          }, true);
          break;
        }
        // Success used to log nothing, which is exactly the case that needed a
        // record: a run that played every step and still left the confirmation
        // standing looked identical, from here, to one that worked. The step
        // tail is what says which.
        // Counted apart, because they are not the same thing: the script's steps
        // are what the operator chose, the confirm presses are the host getting
        // the window to take them. "22 of 21" was the first version of this line.
        const confirms = r.done.filter((d) => d === 'Enter(confirm)').length;
        // A form taken by its free-text row was not answered — it was withdrawn,
        // and the words went back as a clarification. Same success, different
        // event, and saying "answered" for it is how the operator comes to
        // expect a reply to choices that were never delivered.
        if (steps.some((st) => st.clarify)) {
          log(`${desk.label}: withdrew the form and sent the words back as a clarification` +
            ` — ${r.done.slice(-3).join(' ')}`);
          break;
        }
        log(`${desk.label}: answered with ${r.done.length - confirms} of ${steps.length} step(s)` +
          `${confirms ? `, confirmed after ${confirms} press${confirms === 1 ? '' : 'es'}` : ''}` +
          `${r.closed ? ' (the form was gone before the end)' : ''} — ${r.done.slice(-4).join(' ')}`);
        break;
      }
      // The floor could not read what the window is asking, and the operator
      // chose an answer anyway rather than be left stuck. Two keys, and the
      // window is the only thing that can say whether either was taken.
      case 'press': {
        const key = PRESS_KEY[String(item.payload?.choice ?? '')];
        if (!key) {
          warn(`${desk.label}: not pressing anything for "${item.payload?.choice}" — only yes and no are keys here`);
          break;
        }
        const r = await W.pressBlind(desk.cwd, key);
        if (!r.ok) {
          warn(`${desk.label}: could not press ${key} — ${r.error}`);
          this.emit({
            type: 'error', channel: desk.channel, agent: desk.agent, code: 'press_failed',
            message: `that did not land — ${r.error}`,
          }, true);
          break;
        }
        log(`${desk.label}: pressed ${key} at a prompt nothing could read`);
        break;
      }
      case 'interrupt':
        await desk.interrupt();
        break;
      case 'handback': {
        // Give the conversation to the editor: close ours first, then open it
        // there. The order matters — the reverse leaves two live copies.
        const shut = await W.closeWindow(desk.cwd);
        if (!shut.ok) {
          this.emit({ type: 'error', channel: desk.channel, agent: desk.agent, message: shut.error }, true);
          break;
        }
        const opened = await W.openInEditor({ sessionId: desk.sessionId ?? desk.lastSessionId });
        if (!opened.ok) {
          this.emit({ type: 'error', channel: desk.channel, agent: desk.agent, message: opened.error }, true);
        }
        break;
      }
      case 'open': {
        const r = await W.open(desk.cwd, { resume: desk.sessionId ?? desk.lastSessionId });
        if (!r.ok) { this.emit({ type: 'error', channel: desk.channel, agent: desk.agent, message: r.error }, true); break; }
        // Wait for it to actually be running, for two reasons: a window that
        // dies on its first line should say so here rather than look open, and
        // a freshly created window holds its pane after exit until something
        // confirms it started — which is what waitReady releases.
        if (r.created) {
          const up = await W.waitReady(desk.cwd, { pid: r.pid, target: r.target });
          // Say what was pressed on the operator's behalf. Answering a question
          // for someone and not telling them is how a system stops being
          // predictable — and this is the log they will read when a window came
          // up in a mode they did not choose.
          for (const a of up.answered ?? []) log(`${desk.channel}/${desk.agent}: answered the ${a.name} question with "${a.chose}"`);
          if (!up.ok) this.emit({ type: 'error', channel: desk.channel, agent: desk.agent, message: up.error, code: up.code ?? null }, true);
        }
        break;
      }
      case 'attach': {
        // The escape hatch, and the only work item that changes nothing. It
        // opens a terminal in front of the operator; the window keeps running
        // and the floor keeps driving it, because tmux allows both.
        const r = await W.attachTerminal();
        if (!r.ok) { this.emit({ type: 'error', channel: desk.channel, agent: desk.agent, message: r.error }, true); break; }
        // Said on the machine that did it, because this is the one action whose
        // result appears somewhere the board cannot see — a window on a desktop.
        log(`${desk.channel}/${desk.agent}: opened ${r.app} attached with \`${r.cmd}\``);
        break;
      }
      case 'claude': {
        // "Open in Claude": put this desk's real window in front of the
        // operator, opening one first if the floor has none. Not a seat change
        // — the window stays here and the floor keeps driving it; the operator
        // gets a terminal sitting on it, which IS claude CLI under their
        // fingers. That is the whole feature: the handoff VS Code needs does
        // not exist in this direction, because the floor's window already is
        // the CLI.
        const opened = await W.open(desk.cwd, { resume: desk.sessionId ?? desk.lastSessionId });
        if (!opened.ok) { this.emit({ type: 'error', channel: desk.channel, agent: desk.agent, message: opened.error }, true); break; }
        // Attach BEFORE waiting for readiness. Readiness gates automated
        // typing, not eyeballs: a window stuck on the trust question is
        // exactly what the operator should be looking at, and waitReady's own
        // timeout advice is "attach and reply" — here they already have.
        const t = await W.attachTerminal({ target: opened.target });
        if (!t.ok) { this.emit({ type: 'error', channel: desk.channel, agent: desk.agent, message: t.error }, true); break; }
        log(`${desk.channel}/${desk.agent}: opened ${t.app} on ${opened.target} with \`${t.cmd}\``);
        if (opened.created) {
          // Same tail as `open`: settle the startup questions the host may
          // answer, release remain-on-exit, and log any key pressed on the
          // operator's behalf — they are watching this pane now, so a press
          // they did not make must be accounted for. answerKnown reads the
          // screen back before committing, so if the operator answers first
          // it gives up rather than double-keying.
          const up = await W.waitReady(desk.cwd, { pid: opened.pid, target: opened.target });
          for (const a of up.answered ?? []) log(`${desk.channel}/${desk.agent}: answered the ${a.name} question with "${a.chose}"`);
          if (!up.ok) this.emit({ type: 'error', channel: desk.channel, agent: desk.agent, message: up.error, code: up.code ?? null }, true);
        }
        break;
      }
      default:
        warn(`unknown work kind ${item.kind}`);
    }
  }

  /**
   * Read the roster and the transcripts, forever, on its own clock.
   *
   * This is deliberately not part of run(). The two used to share one loop, and
   * handling a chat blocked it: send() opens a window, waits up to
   * READY_TIMEOUT_MS for Claude Code to come up, then up to LAND_TIMEOUT_MS for
   * the message to appear in the transcript. For that minute-plus the floor was
   * told nothing at all — no reply, not even the echo of the message it had
   * just sent, which the composer reads as a send that failed. Then the whole
   * minute arrived in a single batch the moment send() returned. Relaying what
   * is happening cannot be behind doing what was asked.
   */
  async watchLoop() {
    while (!this.stopping) {
      try { await this.watch(); } catch (err) { warn(`watch: ${err.message}`); }
      if (this.stopping) break;
      await sleep(WATCH_MS);
    }
  }

  async run() {
    let backoff = 1000;
    let lastRegister = 0;
    let watching = null;
    while (!this.stopping) {
      try {
        if (Date.now() - lastRegister > HEARTBEAT_MS) {
          // Look before saying: the heartbeat names every desk this host has,
          // so a desk bound since the last one is on the board a minute later
          // at the latest, with nothing restarted. See rescan().
          await this.rescan('heartbeat');
          await this.register();
          lastRegister = Date.now();
        }
        // The relay starts only after the first registration has landed, and
        // that order is not tidiness. A desk's first watch tick reports which
        // session is live there and who holds it, and the server files both
        // against a row that register() creates — an event for a desk the
        // server has never heard of is dropped without a word. Started beside
        // register(), the first tick won that race on a desk new to this host
        // (measured 2026-09-02: a session adopted and reported within
        // milliseconds of boot, invisible on the board for a full heartbeat),
        // and neither event is ever re-sent, because from the host's side
        // nothing changed. Still a separate loop once it runs — see watchLoop.
        watching ??= this.watchLoop();
        // The long poll is the pacing for *work*. The transcripts are read by
        // watchLoop() beside this, not between these lines.
        const reply = await this.request(
          `/api/host/work?host_id=${encodeURIComponent(this.cfg.hostId)}&wait=${Math.ceil(WATCH_MS / 1000)}`,
          { timeout: WATCH_MS + 10_000 },
        );
        for (const item of reply.work ?? []) await this.handle(item);
        backoff = 1000;
      } catch (err) {
        if (this.stopping) break;
        warn(`${err.message}; retrying in ${backoff / 1000}s`);
        lastRegister = 0;
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
    if (watching) await watching;
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    log('shutting down');
    // The windows are left running. They are Claude Code sessions in tmux, and
    // they belong to the person at this machine, not to this process.
    await this.flush();
    try { await this.request('/api/host/unregister', { method: 'POST', body: { host_id: this.cfg.hostId }, timeout: 2000 }); } catch { /* best effort */ }
  }
}

/* ───────────────────────── main ───────────────────────── */

async function main() {
  const cfg = loadConfig();

  if (!(await W.tmuxAvailable())) {
    console.error('[host] tmux is not installed. The floor drives Claude Code through it — install it with `brew install tmux` (or your package manager) and start this again.');
    process.exit(1);
  }

  const found = discoverDesks(cfg.roots);
  if (!found.length) {
    warn(`no desks found under ${cfg.roots.join(', ')} — a desk is a directory whose .mcp.json carries X-Channel and X-Agent`);
  }

  // Which board this host serves. A configured url wins; otherwise the desks
  // decide, and only when they agree. Taking the first desk in walk order is
  // what this used to do, and it is how a host ends up bound to a board none of
  // the desks you care about live on: it registers, reports itself healthy, and
  // silently serves nothing, with the only evidence a `skipping` line that
  // scrolls past. Ambiguity is the user's to resolve, so say so and stop.
  const origins = [...new Set(found.map((d) => originOf(d.url)).filter(Boolean))];
  if (!cfg.url && origins.length === 1) cfg.url = origins[0];
  if (!cfg.url && origins.length > 1) {
    console.error(`[host] the desks under ${cfg.roots.join(', ')} point at ${origins.length} different boards, and nothing here says which one this host serves:`);
    for (const o of origins) {
      const names = found.filter((d) => originOf(d.url) === o).map((d) => `${d.channel}/${d.agent}`);
      const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? `, +${names.length - 3} more` : '');
      console.error(`[host]   ${o}  — ${names.length} desk${names.length === 1 ? '' : 's'}: ${shown}`);
    }
    console.error('[host] pick one:  ./host/install.sh --url <board> <your projects dir>');
    console.error(`[host] or set ORCH_URL, or add "url" to ${CONFIG_FILE}`);
    process.exit(1);
  }
  if (!cfg.url) {
    console.error('[host] no server: set ORCH_URL, or put a repo with an orchestratinator .mcp.json under ORCH_HOST_ROOTS');
    process.exit(1);
  }
  cfg.url = cfg.url.replace(/\/+$/, '');
  const origin = originOf(cfg.url);
  const mine = found.filter((d) => originOf(d.url) === origin);
  for (const d of found.filter((d) => originOf(d.url) !== origin)) {
    log(`skipping ${d.channel}/${d.agent} — its board is ${originOf(d.url)}, this host serves ${origin}`);
  }
  // From a desk on the board we actually serve. found[0] was the same bug as
  // the url: a key from another board authenticates against nothing here.
  if (!cfg.token && mine.length) cfg.token = mine[0].key;
  if (found.length && !mine.length) {
    warn(`every desk found points at another board — this host serves ${origin} and has nothing to do`);
  }

  const host = new Host(cfg);
  for (const d of mine) host.desks.set(`${d.channel}|${d.agent}`, new Desk(host, d));

  log(`${cfg.name} (${cfg.hostId}) → ${cfg.url} · tmux ${W.tmuxSession} · ${mine.length} desk${mine.length === 1 ? '' : 's'}`);
  for (const d of mine) log(`  ${d.channel}/${d.agent}  ${d.cwd}`);
  log(`attach to any of them with:  tmux attach -t ${W.tmuxSession}`);

  const stop = () => host.stop().finally(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  await host.run();
}

main().catch((err) => {
  console.error('[host] fatal:', err?.stack ?? err);
  process.exit(1);
});

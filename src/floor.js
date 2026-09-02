import express from 'express';
import { CAST } from './db.js';
import { agentBoard, agentLoadIndex, channelCounts, mcpSessionCounts, ZERO_COUNTS } from './agent-state.js';
import { PALETTE, DEFAULT_HAIR, DEFAULT_SKIN, shirtForSeat } from './palette.js';

/**
 * The floor: what each agent's own Claude Code session is doing — and, for
 * desks a host has claimed, the session itself.
 *
 * The board (see web.js) answers "what have these agents agreed between
 * themselves". It deliberately cannot answer "who is stuck right now", because
 * an MCP server never sees inside an agent's turn — that limit is real and is
 * documented at length in the README. This module closes the gap from two
 * directions:
 *
 *   1. Reporting. A workstation plugin (plugin/) posts hook events here as each
 *      Claude Code session runs, so a window you are not looking at still has
 *      a desk that says what it is doing and whether it needs a human.
 *
 *   2. Hosting. A workstation service (host/) runs each desk's Claude Code in a
 *      tmux pane and connects it to the floor. Those desks are a real chat:
 *      what you type is a user turn in that window, the reply comes back, and a
 *      permission prompt becomes Approve / Deny here. The human is still the one
 *      deciding — from one screen instead of one per agent. Nothing is owned:
 *      you can be attached to the same pane, typing into it, at the same time.
 *
 * Two things follow from the first and shape everything below:
 *
 *   - Reported data arrives by push, not poll. A window that goes quiet stops
 *     posting, which is information, but a window that is *switched off* also
 *     stops posting and looks identical. So nothing here infers "waiting" from
 *     silence. Waiting is only ever what Claude Code explicitly said it was
 *     waiting for, and it is cleared by the next thing that happens.
 *
 *   - It is conversation content. Full prompts and full replies, on a server
 *     whose dashboard has no sign-in. That is a deliberate choice for one
 *     trusted network (see the README's note on the port), but it is a bigger
 *     claim than the board ever made, and it is why `turns` is excluded from
 *     backups and why the ingest and host doors need the same secret as /mcp.
 *
 * And one thing follows from the second: the host is on a workstation, the
 * server is wherever it is, and only the workstation can reach out. So the host
 * talks to this server the same way the plugin does — outbound only — and the
 * server never holds an open port toward anybody's machine. Work for a host
 * waits in a table until the host asks for it.
 */

/** Per-turn cap. Full text was the point, but one pasted logfile shouldn't
 *  become a row every viewer downloads every two seconds for the rest of time. */
const TEXT_MAX = 20_000;

/** How many turns the chat panel asks for at once. */
const TURNS_DEFAULT = 80;
const TURNS_MAX = 500;

/**
 * How long a silent session keeps its seat before the desk shows as away.
 *
 * The floor has no connection to observe — its only signal is hook events — so
 * "live" is a claim about recency, exactly like the board's presence dot: green
 * means "we heard from this window recently", nothing more. A crashed window
 * never sends SessionEnd, and without this its desk would sit there green for
 * days, which is the floor equivalent of the stale `waiting` chip the status
 * TTL exists to prevent. Generous by default because the counter-error is real
 * too: a window that is open while its human reads or thinks for a while emits
 * nothing, and flapping to "away" over lunch would teach people the floor
 * cannot be trusted in the other direction.
 */
const SESSION_STALE_MINUTES = Math.max(1, Number(process.env.FLOOR_SESSION_TTL_MINUTES ?? 60));

/**
 * A host that hasn't been heard from for this long is offline. Hosts long-poll
 * for work in ~25-second requests and re-register once a minute, so the default
 * means two missed check-ins. The chat composer switches to copy-only the
 * moment a host is offline, because "Send" to a host that isn't there is the
 * one lie the floor is not allowed to tell.
 */
const HOST_STALE_SECONDS = Math.max(30, Number(process.env.FLOOR_HOST_TTL_SECONDS ?? 90));

/**
 * How an avatar is drawn. The whole difference is hair, because a head, a pair
 * of shoulders and a chair back is all the character these figures have — there
 * is nowhere else to put a distinction without inventing detail the flat style
 * does not carry.
 *
 * `neutral` is first because it is the default and it draws no hair at all,
 * which is exactly what every desk looked like before this existed.
 */
export const GENDERS = ['neutral', 'male', 'female'];

/** Longest a host's work request is held open before answering "nothing yet". */
const WORK_WAIT_MAX_MS = 25_000;

/** Longest message accepted from the composer. */
const CHAT_MAX = 20_000;

/**
 * How long a "queued" note may stand before it is assumed to have been missed.
 *
 * A backstop, not the mechanism: what retires a note is its message becoming a
 * turn. This is only for the note whose turn never arrives at all — the host
 * was restarted while a message sat in the queue, the window was closed on top
 * of it. Long, because a message queued behind a genuinely long turn is a real
 * thing to be waiting on and the honest thing to say about it is "queued".
 */
const DELIVERY_STALE_MS = 10 * 60_000;

/**
 * The notification types that mean a human is the blocker.
 *
 * Everything else Claude Code notifies about — auth success, an elicitation
 * dialog closing — is news, not a queue item, and putting it in the operator's
 * list would train them to ignore the list.
 */
/**
 * Notifications that mean a human is the blocker.
 *
 * `idle_prompt` used to be in here and is not a blocker: Claude Code fires it
 * after sixty seconds of an idle composer, which is the resting state of every
 * agent that has finished and is waiting to be told what is next. Treated as a
 * prompt it lit the desk, raised the alert above the compose box, and offered
 * nothing to press — a question mark over a desk that had simply gone quiet
 * while somebody read it. There is nothing to answer and nowhere to go; the
 * composer immediately below the alert is the answer, and the desk's own idle
 * state and speech bubble already say the agent is waiting.
 */
const AWAITING_NOTIFICATIONS = new Set(['permission_prompt']);

/**
 * How long after a decision a permission notification is treated as its echo
 * rather than as a new question.
 *
 * The gap between Claude Code's two announcements of one prompt was measured at
 * six seconds. This is generous against that and short enough that a genuinely
 * new prompt, which announces itself with a PermissionRequest of its own, is
 * never mistaken for an echo — only the notification-only path is affected.
 */
const ANSWER_ECHO_MS = 15_000;

/**
 * Events that prove a human is no longer the blocker, because work happened.
 *
 * PreToolUse is in here and PostToolUse is not, which halves how often the hook
 * fires on the busiest path in a session. It is safe in that order because
 * PreToolUse runs *before* the permission decision: the clear lands first, then
 * PermissionRequest and the permission_prompt Notification each set it again. Two
 * independent signals re-raise a live prompt, so the one that arrives early
 * cannot hide it.
 */
const CLEARS_AWAITING = new Set(['SessionStart', 'UserPromptSubmit', 'Stop', 'PreToolUse']);

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
/* Whitespace is not meaningful when matching a message against the turn it
   became: a composer rewraps, and a transcript records what was submitted
   rather than how it was typed. The same rule the host and the browser use, so
   all three agree about when a queued message has arrived. */
const squash = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const clip = (v, max = TEXT_MAX) => {
  if (v === null || v === undefined) return null;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s === null || s === undefined) return null;
  return s.length > max ? `${s.slice(0, max)}\n… [truncated at ${max} characters]` : s;
};
/* SQLite's datetime to ISO. Idempotent: the floor's view of a host carries an
   already-converted timestamp, and running this over it a second time used to
   append a second Z. Date.parse said NaN to that, NaN failed every comparison
   it was put in, and a host ten minutes dead reported as live. */
const iso = (s) => (s ? `${String(s).replace(' ', 'T').replace(/Z*$/, '')}Z` : null);
/* Fails closed. An unparseable timestamp used to make this NaN, and every
   `secondsSince(...) < TTL` test it fed then answered false — so the one thing
   a bad clock value must never do, which is make something look alive, is
   exactly what it did. No timestamp and no sense are both "infinitely long
   ago". */
const secondsSince = (isoStr, nowMs) => {
  const at = isoStr ? Date.parse(isoStr) : NaN;
  return Number.isFinite(at) ? (nowMs - at) / 1000 : Infinity;
};
/* How many recent tool calls a desk carries for its monitor. A shade more than
   the four lines the screen shows, so a browser that missed a poll still has
   the run to type rather than a gap. */
const SCREEN_COMMANDS = 6;

const deskKey = (channel, agent) => `${channel}|${agent}`;

/**
 * Can anything be typed into this desk's window right now, and if not, why not?
 *
 * Pure, and takes the already-fetched row so a caller with a whole list does not
 * make one query per desk. Exported because two surfaces need the same verdict:
 * the chat endpoint enforces it, and the board greys out its Nudge button with
 * it. A button that decided for itself would eventually disagree with the server
 * that actually refuses the work — enabled and 409ing, or greyed out over a
 * window that was perfectly reachable.
 *
 * The one rule underneath all three refusals is the one this whole repo is built
 * on: a conversation is one process, and only the app holding it can type.
 */
export function deliverable(h, nowMs = Date.now()) {
  if (!h) return { error: 'No host on this board is running that repo, so there is nowhere to send this.', code: 'not_hosted' };
  if (h.state === 'offline' || secondsSince(iso(h.host_seen), nowMs) >= HOST_STALE_SECONDS) {
    return { error: `The host for this desk (${h.host_name ?? h.host_id}) is offline.`, code: 'host_offline' };
  }
  // A conversation is one process, and right now an editor has it. Nothing can
  // be typed into it from here — so say that before a message is taken, rather
  // than accepting one and failing to deliver it.
  if (h.outside_pid) {
    return {
      error: 'This conversation is open in your editor. Close it there, or use “Open in VS Code” to move it back, then type here.',
      code: 'held_by_editor',
    };
  }
  return { hosted: h };
}

/**
 * Whether this desk can be *nudged* — the same question as whether it can be
 * sent a message, with one more fact attached: whether ringing will have to
 * open a window first.
 *
 * It used to be stricter. A nudge is not content — it means "there is
 * something waiting on your channel, go and look" — and the rule was that
 * saying it to a desk with no window would silently spin up a whole session
 * to deliver one word, so the bell went dead and said "send a message
 * instead". Measured on the live board 2026-09-02, that saved nothing: the
 * operator's next move was to type the word "nudge" into the composer, which
 * opened the very same window by the very same path (`say()` → `send()` with
 * `open: true`, resuming the desk's conversation). The rule did not prevent a
 * session being opened; it moved one tap to a chat box, on the desk the
 * operator had just been told had work waiting.
 *
 * So the gate is deliverable(), and `opens` says whether the window is still
 * to come. Both nudge surfaces — the board's button and the floor's bell —
 * label themselves from it, so a tap is never a silent session: the bell on
 * an empty desk reads as "opens the window first" before it is pressed. A
 * nudge to a desk with nobody at it is still meaningless; the point is that a
 * desk showing waiting work is not nobody, and opening its conversation is
 * exactly what the operator meant.
 */
export function nudgeable(h, nowMs = Date.now()) {
  const can = deliverable(h, nowMs);
  if (can.error) return can;
  return h.window_id ? can : { ...can, opens: true };
}

/**
 * Can the host open a terminal already attached to this desk's window?
 *
 * The same conditions as a nudge — something has to be running in tmux for
 * there to be anything to attach to — but every sentence is re-worded, because
 * of who is reading it. This is the escape hatch: the person clicking it has
 * usually already decided the floor is not telling them the truth about their
 * window. "Send a message instead — that opens one" is the worst possible
 * advice at that moment, since sending a message is the thing they have just
 * stopped believing in.
 *
 * So each refusal ends with the command, and the machine to run it on. The
 * point of this button is to get somebody to a real prompt; when it cannot do
 * that itself, the next best thing it can do is say how.
 */
export function attachable(h, nowMs = Date.now()) {
  const cmd = `tmux attach -t ${h?.host_tmux ?? 'orch'}`;
  const where = h?.host_name ?? h?.host_id ?? 'the host machine';
  if (!h) {
    return { error: 'No host on this board is running that repo, so there is no tmux session to attach to.', code: 'not_hosted' };
  }
  const can = deliverable(h, nowMs);
  if (can.error && can.code === 'host_offline') {
    // The one refusal that is not really a refusal. The host is a separate
    // process from the windows it opened — killing it deliberately leaves them
    // running — so the session is very likely still there and still attachable.
    // Nothing here can reach out and prove that, and the sentence must not
    // claim it: it says what is known, and hands over the command.
    return {
      error: `The host for this desk (${where}) is offline, so it cannot open a terminal for you. Its tmux session outlives it, so run \`${cmd}\` on ${where} yourself.`,
      code: 'host_offline',
      cmd,
    };
  }
  if (can.error && can.code === 'held_by_editor') {
    return {
      error: 'This conversation is open in your editor, not in tmux, so there is no window to attach to. Close it there, or move it to the floor first.',
      code: 'held_by_editor',
    };
  }
  if (can.error) return { ...can, cmd };
  if (!h.window_id) {
    return {
      error: 'No tmux window is open for this desk, so there is nothing to attach to yet. Open it on the floor first.',
      code: 'no_window',
    };
  }
  return { hosted: h, cmd };
}

/**
 * Can "Open in Claude" put this desk's window in front of the operator?
 *
 * The attach conditions, with one loosened and one re-worded. Loosened:
 * no_window is not a refusal here, because opening the window is half of what
 * the button does — the host runs `open` and then attaches. Re-worded: the
 * held-by-editor sentence, because the process holding it may be an editor OR
 * a claude CLI outside tmux, and this button is the one a CLI person clicks —
 * telling them about "your editor" sends them looking for a window that is a
 * terminal.
 */
export function claudeable(h, nowMs = Date.now()) {
  const base = attachable(h, nowMs);
  if (!base.error) return base;
  const cmd = `tmux attach -t ${h?.host_tmux ?? 'orch'}`;
  if (base.code === 'no_window') return { hosted: h, cmd, opens: true };
  if (base.code === 'held_by_editor') {
    return {
      error: 'This conversation is already open in another app — your editor, or a claude CLI outside tmux. Quit it there first: one app holds a conversation at a time.',
      code: 'held_by_editor',
    };
  }
  return base;
}

/**
 * Is a turn actually running at this desk?
 *
 * Two signals, because the hooks and the transcript agree only eventually. The
 * desk's own state is what Claude Code reported and is authoritative, but it
 * arrives a beat late. A tool call as the newest turn covers that beat:
 * PreToolUse is recorded as the tool *starts*, so a desk halfway through a
 * command reads as working before its next state event lands.
 *
 * Derived here and carried on the payload rather than worked out again in the
 * browser. The floor draws a desk as working from this and lights its stop sign
 * from it; two answers to one question is a desk that is visibly working with a
 * dead sign on it.
 */
export function isWorking(h, lastTurn) {
  return h?.state === 'working' || lastTurn?.role === 'tool';
}

/* Every refusal below is somebody else's sentence, written for sending. The
   conditions are worth sharing — they are the same conditions — but the words
   are not: "send a message instead" is no help at all to someone trying to
   stop one. Same verdict, re-worded by its code. `no_window` is stop's own: a
   nudge opens a window when there is none, a stop cannot. */
const STOP_WHY = {
  not_hosted: 'No host on this board is running that repo, so there is nothing here to stop.',
  held_by_editor: 'This conversation is open in your editor. Stop it there — one app holds a conversation at a time.',
  no_window: 'No window is open for this desk, so there is nothing running to stop.',
};

/**
 * Can this desk's turn be stopped, and if not, why not?
 *
 * Stopping is a keystroke — Escape, the very one a person presses — so it wants
 * a window of ours to press it in, and unlike chat or a nudge it cannot open
 * one: there is nothing to interrupt in a window that does not exist yet. So
 * `window_id` is checked here, on top of deliverable().
 *
 * "Nothing is running" is refused here too, and by the endpoint rather than
 * only greyed out in the browser. A confirmation dialog puts a few seconds
 * between looking and clicking, which is long enough for a turn to end — and
 * being told it already finished is a better answer than an Escape pressed
 * silently into an idle prompt.
 */
export function stoppable(h, lastTurn, nowMs = Date.now()) {
  const can = deliverable(h, nowMs);
  if (can.error) return { ...can, error: STOP_WHY[can.code] ?? can.error };
  if (!h.window_id) return { error: STOP_WHY.no_window, code: 'no_window' };
  if (!isWorking(h, lastTurn)) {
    return { error: 'Nothing is running at this desk right now, so there is nothing to stop.', code: 'not_working' };
  }
  return can;
}

/**
 * The session id a hosted desk's turns are filed under before its SDK session
 * has announced its own. Deterministic, so the message that starts a session
 * and the session it starts can be joined up afterwards — see rekeySession.
 */
const placeholderSession = (hostId, channel, agent) => `host:${hostId}:${channel}:${agent}`;

/**
 * One line describing a tool call, for the collapsed row in the chat panel.
 *
 * The whole reason tool calls are stored as their own rows is so the panel can
 * show them as one line and expand on click. That only pays off if the one line
 * is the useful part — "Bash" tells you nothing, `Bash: npm test` tells you what
 * the agent is actually doing, which is the question the person watching has.
 */
/**
 * The window's own list of choices, sorted into the three that are always there
 * and the rest.
 *
 * Approve is the first "Yes", deny the first "No", and everything else — "Yes,
 * and don't ask again for similar commands in <dir>" and whatever a particular
 * prompt adds — is offered on its own. Cancel is not in here: it is Escape, which
 * no menu lists as a number, and the prompt's own footer treats as separate from
 * "No".
 *
 * Derived here rather than in the panel for the usual reason — the endpoint has
 * to agree with the buttons about which key each one presses, and two
 * derivations of that eventually disagree.
 */
/**
 * Ask the host to read the choices off the window.
 *
 * One capture per prompt, at the moment one opens, rather than polling every
 * desk's pane forever for something that is almost never there. Only for a desk
 * this board's host can actually reach — an editor holds its own window and
 * there is no pane to look at.
 */
function askForOptions(store, live, channel, agent, requestId) {
  if (!requestId) return;
  let h = null;
  try { h = store.hostedDesk(channel, agent); } catch { return; }
  if (!h || h.outside_pid) return;
  store.enqueueHostWork(h.host_id, channel, agent, 'prompt', { request_id: requestId });
  live?.wake(h.host_id);
}

/**
 * The keys that turn a filled-in form into an answered one.
 *
 * Every mechanic here was measured on a real prompt, and two of them are not
 * what you would guess:
 *
 *   - on a single-select a digit only *moves the cursor*; Enter is what selects,
 *     and selecting advances to the next tab by itself;
 *   - on a multi-select a digit *toggles that box outright* and leaves the
 *     cursor where it was, so choices are pressed by number and Enter is never
 *     used — there it would toggle whatever the cursor happens to be on.
 *
 * Positions are counted from the left end rather than detected: which tab is
 * showing is marked by colour, and a plain capture has none. So the sequence
 * starts by walking left past the first tab, which is a no-op once it is there.
 *
 * `answers` is one entry per question: { choose: [n, …], text } — the numbers
 * are the window's own, and `text` is what to type into its free-text choice.
 */
export function answerSteps(questions, answers) {
  const qs = Array.isArray(questions) ? questions : [];
  const steps = [];
  // To a known end. One press per tab is always enough, and pressing left at the
  // left end does nothing.
  for (let i = 0; i <= qs.length; i++) steps.push({ key: 'Left' });

  for (let i = 0; i < qs.length; i++) {
    const q = qs[i];
    const a = answers?.[i] ?? {};
    const chosen = (a.choose ?? []).filter((n) => q.options?.some((o) => o.n === n));
    // Typing into the free-text choice means standing on it first.
    //
    // The thing that makes a multi-select answerable at all — a digit toggles
    // that box and leaves the cursor alone — is exactly what breaks this: the
    // box gets ticked, the field opens, and the words go wherever the cursor
    // happens to be. Measured: "5. [✔] Type something" with the field empty and
    // the cursor still on line 1.
    //
    // Where the cursor is cannot be read (it moves as the sequence runs), so it
    // is normalised the same way the tabs are: to a known end, then down a
    // counted number of rows. Pressing up at the top does nothing.
    const wants = typeof a.text === 'string' && a.text.trim() ? a.text.trim() : null;
    const free = wants ? q.options?.find((o) => o.other && chosen.includes(o.n)) : null;
    const standOn = (opt) => {
      const idx = q.options.findIndex((o) => o.n === opt.n);
      for (let k = 0; k < (q.options?.length ?? 0); k++) steps.push({ key: 'Up' });
      for (let k = 0; k < idx; k++) steps.push({ key: 'Down' });
    };

    if (q.kind === 'multi') {
      for (const n of chosen) steps.push({ key: String(n) });
      if (free) {
        standOn(free);
        steps.push({ text: wants });
        // The field keeps focus once words are in it, and the row grows a "Next"
        // row beneath itself. Neither Tab nor Enter leaves it — both are
        // swallowed, and anything after them is typed into the words. Recorded
        // twice: "❯ 4. [✔] typed into a multi select" with the sequence's Tab
        // gone, and then "typed into a multi select3" where the next question's
        // digit had been appended to the operator's own sentence.
        //
        // So it is walked off: Down onto Next, and Enter to take it.
        steps.push({ key: 'Down' });
        steps.push({ key: 'Enter' });
      } else {
        // Enter would toggle the cursor's box, so the way on is Tab.
        steps.push({ key: 'Tab' });
      }
    } else if (free) {
      // The free-text row on a single-select is not a fourth answer. It is
      // Claude Code's clarify hatch: taking it withdraws the whole form and
      // sends the words back as a clarification, so nothing after it can be
      // played and no later tab gets answered.
      //
      // Selecting it opens no field. Recorded frame by frame: the form is on
      // screen with "❯ 4. Type something." under the cursor, and 318ms after
      // the Enter the pane reads "User declined to answer questions" with a
      // composer cursor beneath it. There is nothing left to type into, which
      // is why typing the words here as further keystrokes could not work —
      // and why the sequence died on the step after this one, every time.
      //
      // So this stops at the decline, and the words go down the ordinary chat
      // path afterwards, where a paste is confirmed and a submission is proven.
      // The operator gets what they asked for either way: the form withdrawn
      // and their sentence in the conversation.
      steps.push({ key: String(free.n) });
      steps.push({ key: 'Enter', final: true, clarify: true });
      return steps;
    } else {
      const n = chosen[0];
      if (n) {
        // One key. The digit *selects* on a single-select — it does not merely
        // move the cursor — and selecting advances to the next tab by itself.
        //
        // There used to be an Enter after it, on the measured-once belief that
        // the digit only moved. Recorded frame by frame, that Enter lands on the
        // tab the digit already advanced to and answers *that* question with
        // whatever sits highlighted there, which is always its first option. So
        // the sequence answered question 2 for the operator before reaching it,
        // and the only rounds that ever looked correct were the ones where the
        // operator had chosen option 1 anyway. The visible half was the last key
        // having nothing to press: "the window stopped asking after 6 of 7
        // steps", reported while the form had in fact submitted.
        steps.push({ key: String(n) });
      } else {
        steps.push({ key: 'Tab' });
      }
    }
  }

  // Nothing. Answering the last question is what lands on Submit.
  //
  // This used to walk there — `qs.length + 1` Tabs, then "1", then Enter — on
  // the theory that the form had to be driven to its Submit tab. Recorded off a
  // real window, it does not: selecting the last answer advances to Submit by
  // itself and the review screen opens with "1. Submit answers" already under
  // the cursor. The walk therefore started from Submit rather than reaching it,
  // and with two entries on that screen an odd number of Tabs lands on
  // "2. Cancel" — so the Enter meant to submit the form cancelled it instead.
  //
  // Frame before: "Ready to submit your answers? / 1. Submit answers / 2.
  // Cancel". Frame after: "User declined to answer questions". Every answer the
  // operator sent was thrown away at the final keystroke, and the floor reported
  // it as "your answers did not land" without being able to say why.
  //
  // Submitting is left to the confirm loop in answerQuestion, which presses
  // Enter only while the pane is actually showing that question. A form that is
  // somewhere else — a question was skipped, say — then goes unsubmitted and is
  // reported as unconfirmed, which is recoverable. Cancelling is not.
  return steps;
}

export function promptChoices(options) {
  const list = Array.isArray(options) ? options.filter((o) => o && Number.isInteger(o.n)) : [];
  const approve = list.find((o) => /^yes\b/i.test(o.text ?? ''))?.n ?? list[0]?.n ?? null;
  const denyOpt = list.find((o) => /^no\b/i.test(o.text ?? '')) ?? null;
  const deny = denyOpt?.n ?? null;
  // Whether refusing invites a sentence, or just refuses.
  //
  // Only some prompts spell it "No, and tell Claude what to do differently", and
  // only that one opens a field to type into. Measured across a day of real
  // captures: every Bash prompt here offered a plain "No", and none offered the
  // other. Showing the operator a reason box for those would be asking them to
  // type into a window with nowhere to put it.
  const denyAsks = /tell claude/i.test(denyOpt?.text ?? '');
  return { approve, deny, denyAsks, extras: list.filter((o) => o.n !== approve && o.n !== deny) };
}

function toolSummary(toolName, toolInput) {
  const i = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const first =
    str(i.command) ??
    str(i.file_path) ??
    str(i.path) ??
    str(i.pattern) ??
    str(i.description) ??
    str(i.prompt) ??
    str(i.url) ??
    null;
  if (!first) return toolName;
  const oneLine = first.replace(/\s+/g, ' ').trim();
  return `${toolName}: ${oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine}`;
}

/**
 * Apply one hook event from the workstation plugin.
 *
 * Every event upserts the session first, because any event at all is proof the
 * window exists — and because most hook payloads carry only the common fields,
 * the upsert COALESCEs rather than overwrites, so a Stop can't blank the model a
 * SessionStart knew.
 */
export function ingestHookEvent(store, body, live = null) {
  const channel = str(body.channel);
  const agent = str(body.agent);
  const sessionId = str(body.session_id);
  if (!channel || !agent || !sessionId) {
    return { ok: false, error: 'channel, agent and session_id are required' };
  }
  const event = str(body.hook_event_name) ?? 'unknown';
  const pid = Number.isInteger(Number(body.pid)) && Number(body.pid) > 0 ? Number(body.pid) : null;

  store.upsertSession({
    session_id: sessionId,
    channel,
    agent,
    cwd: str(body.cwd),
    transcript: str(body.transcript_path),
    model: str(body.model),
    permission_mode: str(body.permission_mode),
    git_branch: str(body.git_branch),
    runner: 'hook',
    pid,
  });
  const persona = store.ensurePersona(channel, agent);

  /**
   * Whether a host is tailing this repo's transcript right now.
   *
   * When one is, it is the authority on conversation *content* — it reads what
   * Claude Code wrote, which is complete and has the tool calls in it — and
   * these hooks would file every turn a second time. When there is no host
   * (its machine is off, the service isn't running), the hooks are the only
   * source there is, and the floor is better off with a partial conversation
   * than an empty desk. Either way the hooks remain the authority on *state*:
   * a prompt is open, a turn started, a turn ended.
   */
  const hosted = store.hostedDesk(channel, agent);
  const mirrored = !!hosted && secondsSince(iso(hosted.host_seen), Date.now()) < HOST_STALE_SECONDS;

  const key = deskKey(channel, agent);
  const state = (s) => {
    if (!hosted) return;
    store.setHostedState(channel, agent, s);
    live?.publish(key, { type: 'state', state: s });
  };

  const turn = (role, text, toolName = null) => {
    const clipped = clip(text);
    if (!clipped && !toolName) return 0;
    const id = store.insertTurn({
      channel, agent, session_id: sessionId, role, text: clipped, tool_name: toolName,
    });
    live?.publish(deskKey(channel, agent), {
      type: 'turn',
      turn: { id, session_id: sessionId, role, text: clipped, tool_name: toolName, created_at: new Date().toISOString() },
    });
    return id;
  };

  // Ordered so the clear happens before anything that might set it again.
  if (CLEARS_AWAITING.has(event)) {
    store.clearAwaiting(sessionId);
    // A prompt that was open is closed by work happening, whether it was
    // answered from the floor or by the person sitting at the window.
    if (live?.pending.has(key)) {
      live.pending.delete(key);
      live.publish(key, { type: 'permission', request: null });
    }
    // Work happening is the proof an answer landed, so there is nothing left to
    // put back. Without this an old answered prompt could be resurrected by a
    // much later failure on the same desk.
    live?.answered.delete(key);
  }

  let recorded = null;
  switch (event) {
    case 'SessionEnd':
      store.endSession(sessionId);
      live?.pending.delete(key);
      state('idle');
      break;

    case 'UserPromptSubmit':
      // The human just typed. By definition they are not the blocker any more,
      // which is why this event clears the queue entry above rather than waiting
      // for the turn to finish.
      if (body.message && !mirrored) recorded = turn('user', body.message);
      state('working');
      break;

    case 'Stop':
      if (body.last_assistant_message && !mirrored) recorded = turn('assistant', body.last_assistant_message);
      state('idle');
      break;

    case 'PreToolUse':
      // Recorded as the tool *starts*, so the floor shows what is happening now
      // rather than what finished a moment ago. PostToolUse would be the honest
      // record of completion, but by then the interesting second has passed.
      if (str(body.tool_name) && !mirrored) {
        recorded = turn('tool', toolSummary(body.tool_name, body.tool_input), body.tool_name);
      }
      state('working');
      break;

    /**
     * A permission prompt, straight from the session that opened it.
     *
     * This is why the floor never has to read a prompt off a screen to know one
     * is open: Claude Code says so. Answering it is a keystroke sent into the
     * window (see host/index.js), which is exactly what the person sitting at
     * it would do — and either of them can be the one who does it.
     */
    case 'PermissionRequest': {
      const summary = str(body.tool_name)
        ? toolSummary(body.tool_name, body.tool_input)
        : 'a tool needs a permission decision';
      store.setAwaiting(sessionId, 'permission_request', summary);
      // The id is only ever used to notice that an answer arrived for a prompt
      // that has since closed — the window itself is answered with a keystroke.
      live?.pending.set(key, {
        request_id: `${sessionId}:${body.tool_name ?? 'tool'}:${Date.parse(new Date().toISOString())}`,
        tool: str(body.tool_name) ?? 'tool',
        // A question is a form, and the form is on the pane rather than in this
        // event — the host has to go and read it, which takes a walk of the tabs
        // and a second or two. Until it comes back there is nothing to show, and
        // showing Approve/Deny/Cancel in the meantime offered an answer to a
        // question that was not the one being asked.
        reading: str(body.tool_name) === 'AskUserQuestion',
        summary: clip(summary, 500),
        message: clip(body.notification_message ?? body.message, 500),
        at: new Date().toISOString(),
      });
      state('awaiting');
      live?.publish(key, { type: 'permission', request: live.pending.get(key) });
      askForOptions(store, live, channel, agent, live?.pending.get(key)?.request_id);
      break;
    }

    case 'Notification': {
      const kind = str(body.notification_type);
      if (!AWAITING_NOTIFICATIONS.has(kind)) break;
      const said = clip(body.notification_message, 500);
      const open = live?.pending.get(key);

      // A notification that is only the tail of a prompt already answered.
      //
      // Claude Code announces a prompt twice: PermissionRequest, then this,
      // about six seconds later. Answer inside those six seconds — which is
      // what answering promptly looks like — and this arrives for a question
      // that is no longer being asked. It used to re-light the desk and, worse,
      // rebuild the prompt below (there is no request outstanding, so the
      // synthesis fired), putting a phantom back on screen seconds after the
      // operator had dealt with the real one. Clicking it earned an error
      // saying the answer had not landed, which was true and thoroughly
      // misleading.
      //
      // A decision this recent, with nothing outstanding, means this is that
      // echo. Ignored entirely — not merely left without buttons.
      const echo = !open ? live?.answered.get(key) : null;
      if (echo && Date.now() - (echo.answered_at ?? 0) < ANSWER_ECHO_MS) break;

      store.setAwaiting(sessionId, kind, said);

      // A permission prompt the floor can see but cannot answer is a dead box.
      //
      // Two hooks announce a prompt: PermissionRequest, which carries what is
      // being asked and is what puts Approve/Deny on the desk, and a
      // Notification six seconds later, which carries neither. They are
      // independent, and when only the second arrives the floor drew an alert
      // with no summary and no buttons — a desk visibly stuck with nothing on
      // screen to do about it, while the window sat holding the question and
      // refused every message sent to it.
      //
      // The request id exists only to notice an answer arriving for a prompt
      // that has since closed; answering is a keystroke into the pane and needs
      // nothing from the hook. So one is made up here. Pressing it when the
      // window is no longer asking is safe: answerPrompt looks at the pane
      // before it sends anything and refuses if no question is on screen.
      if (kind === 'permission_prompt' && live && !open) {
        live.pending.set(key, {
          request_id: `${sessionId}:notification:${Date.now()}`,
          tool: null,
          // Never empty. "permission prompt —" with nothing after it tells the
          // operator less than the desk already told them.
          summary: said || 'the window is waiting for a permission decision',
          message: said,
          at: new Date().toISOString(),
        });
        live.publish(key, { type: 'permission', request: live.pending.get(key) });
        askForOptions(store, live, channel, agent, live.pending.get(key).request_id);
      }
      break;
    }

    case 'StopFailure':
      // An API error is not a human-blocking prompt, but it is the other way a
      // window silently stops making progress, and it reads the same from across
      // the room. It goes in the queue so nobody waits on a dead turn.
      recorded = turn('error', str(body.error_message) ?? str(body.error_type) ?? 'the turn ended with an API error');
      store.setAwaiting(sessionId, 'error', clip(body.error_message ?? body.error_type, 500));
      break;

    default:
      break;
  }

  return { ok: true, event, channel, agent, persona: persona.persona, turn_id: recorded };
}

/**
 * State that is live rather than stored: the text of a reply while it streams,
 * the permission prompts hosts are waiting on, the browsers watching a desk,
 * and the hosts waiting for work. All of it is rebuilt from the hosts within a
 * minute of a restart — they re-register and re-announce anything pending — so
 * a table would be a table of things that are about to be wrong.
 */
export function createLive() {
  const partial = new Map();   // deskKey -> text of the reply so far
  const pending = new Map();   // deskKey -> { request_id, tool, summary, message, at }
  // Prompts the operator has answered, kept only until the answer is known to
  // have landed. The floor drops a desk's prompt the moment a decision is made,
  // so if the keystroke turns out not to have taken there is nothing left to put
  // back — unless it was kept here. See the answer_failed case in
  // applyHostEvent, which is what puts it back.
  const answered = new Map(); // deskKey -> { request_id, tool, summary, message, at }
  /**
   * Messages a window has taken but not yet turned into a turn.
   *
   * A desk that is working queues what you send it and reads it at its next
   * step. Between those two moments the message exists — the window has it,
   * the transcript says so — but it is not in the conversation, so nothing the
   * board draws from turns can show it. Kept here so the composer can say
   * "queued" for those few seconds instead of counting to thirty and calling
   * it lost. Dropped the moment the real turn arrives; see the `turn` case.
   */
  const delivery = new Map(); // deskKey -> { state, text, at, held }
  /**
   * Where the conversation stood when the operator's message was accepted:
   * the id of the desk's last user turn at that moment, per desk.
   *
   * The `delivery` case has to tell "the turn beat the note here" from "an
   * older turn happens to say the same words". Text alone cannot: the most
   * repeated message on this board is the one word "nudge", so a second nudge
   * always finds the first as the desk's last user turn, and matching on words
   * dropped its note every time — the bubble sat on "sending…" and then said
   * "not recorded" about a message the window was holding. A turn counts as
   * this message arriving only if it was recorded after the send.
   */
  const sentAfter = new Map(); // deskKey -> id of the last user turn when the send was accepted
  const watchers = new Map();  // deskKey -> Set<fn>
  const waiters = new Map();   // host_id -> wake fn for a held work request
  return {
    partial,
    pending,
    answered,
    delivery,
    sentAfter,
    subscribe(key, fn) {
      if (!watchers.has(key)) watchers.set(key, new Set());
      watchers.get(key).add(fn);
      return () => watchers.get(key)?.delete(fn);
    },
    publish(key, event) {
      for (const fn of watchers.get(key) ?? []) {
        try { fn(event); } catch { /* a dead browser must not break the rest */ }
      }
    },
    wait(hostId, ms) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => { waiters.delete(hostId); resolve(); }, ms);
        waiters.set(hostId, () => { clearTimeout(timer); waiters.delete(hostId); resolve(); });
      });
    },
    wake(hostId) {
      waiters.get(hostId)?.();
    },
  };
}

/**
 * Apply one event from a host about one of its desks.
 *
 * A hosted session is written into the same tables as a reported one, so the
 * rest of the floor — the queue, the staleness rule, the chat panel — cannot
 * tell the difference and does not need to. The extra state a host has that a
 * hook doesn't (the reply as it streams, a prompt it is holding open) lives in
 * `live`.
 */
function applyHostEvent(store, live, hostId, ev) {
  const channel = str(ev.channel);
  const agent = str(ev.agent);
  if (!channel || !agent) return false;
  const key = deskKey(channel, agent);
  const desk = store.hostedDesk(channel, agent);
  if (!desk || desk.host_id !== hostId) return false;

  const placeholder = placeholderSession(hostId, channel, agent);
  const sessionId = str(ev.session_id) ?? desk.sdk_session_id ?? placeholder;
  const now = new Date().toISOString();
  const turn = (role, text, toolName = null) => {
    const clipped = clip(text);
    if (!clipped && !toolName) return 0;
    const id = store.insertTurn({ channel, agent, session_id: sessionId, role, text: clipped, tool_name: toolName });
    live.publish(key, { type: 'turn', turn: { id, session_id: sessionId, role, text: clipped, tool_name: toolName, created_at: now } });
    return id;
  };
  const state = (s) => {
    store.setHostedState(channel, agent, s);
    live.publish(key, { type: 'state', state: s });
  };

  switch (str(ev.type)) {
    /**
     * Which conversation is live in that repo now — or none, when the window
     * has been closed. Not a handoff and nothing to arbitrate: the host simply
     * reports what `claude agents --json` says is there, and if the person
     * cleared the conversation or started a different one, that is the
     * conversation now.
     */
    case 'holder': {
      // Who is holding this desk's conversation, as of the host's last look.
      // Reported on its own so the floor knows within a poll rather than
      // within a heartbeat.
      store.setHostedHolder(channel, agent, {
        windowId: ev.holder === 'floor' ? (str(ev.window) ?? null) : null,
        outsidePid: ev.holder === 'editor' ? (Number(ev.pid) || null) : null,
        // Not conditioned on `holder`: a window with nobody registered in it
        // has no holder at all, and that is exactly the case these two exist
        // to describe.
        windowOpen: str(ev.window_open) ?? null,
        holders: Number(ev.holders) || 0,
        clients: Number(ev.clients) || 0,
      });
      break;
    }
    case 'session': {
      const live_id = str(ev.session_id);
      if (!live_id) {
        // No window open here. The desk stays, with the last conversation it
        // had, so opening one again continues rather than starts over.
        state('idle');
        break;
      }
      store.upsertSession({
        session_id: live_id, channel, agent, cwd: str(ev.cwd) ?? desk.cwd, runner: 'host', pid: Number(ev.pid) || null,
      });
      // A message sent to a repo with no window was filed under the
      // placeholder while one was opening. This is when the real id is known.
      if (live_id !== placeholder) store.rekeySession(channel, agent, placeholder, live_id);
      if (desk.sdk_session_id !== live_id) {
        store.setHostedSession(channel, agent, live_id);
        live.publish(key, { type: 'session', session_id: live_id });
      }
      store.ensurePersona(channel, agent);
      break;
    }

    /**
     * A turn, read from Claude Code's own transcript by the host.
     *
     * This is the floor's only source of conversation content, and it does not
     * care who typed it. A message you type in your own terminal arrives here
     * exactly like one sent from the floor's composer, because both of them
     * end up in the same transcript. That is the whole reason the floor no
     * longer needs to know which door a desk is being used through.
     */
    case 'turn': {
      const role = str(ev.role);
      if (role === 'tool') turn('tool', toolSummary(str(ev.tool_name) ?? 'tool', ev.tool_input), str(ev.tool_name));
      // Machine-injected context riding a user record — IDE state, slash-command
      // records. Its own role, with the tag in tool_name as the label, so no
      // surface can attribute the system's words to the person.
      else if (role === 'context') turn('context', ev.text, str(ev.tool_name));
      else if (role === 'user' || role === 'assistant') turn(role, ev.text);
      else return false;
      // A queued message stops being queued when it becomes a turn.
      //
      // Matched on the text, for the same reason the browser retires its
      // pending bubble on the text: this turn is the window saying "this is in
      // the conversation now", and that is the only thing that should end the
      // wait. Anything else — a timer, the desk going idle — would clear the
      // note while the message was still sitting in the queue.
      if (role === 'user') {
        const q = live.delivery.get(key);
        if (q && squash(ev.text).includes(squash(q.text))) {
          live.delivery.delete(key);
          live.publish(key, { type: 'delivery', delivery: null });
        }
      }
      store.upsertSession({ session_id: sessionId, channel, agent, cwd: desk.cwd });
      break;
    }

    /**
     * The window has the message; the conversation does not have it yet.
     *
     * Only ever said about a message that was *queued* — one that went straight
     * in needs nothing said about it, because the turn itself arrives a moment
     * later and says it better. This exists for the gap, which on a desk part
     * way through a long turn is the whole of what the operator can see.
     */
    case 'delivery': {
      const text = str(ev.text);
      if (!text) return false;
      // The turn may already have beaten this here, and often does.
      //
      // Two loops run in the host and neither waits for the other: the relay
      // reads the transcript every 700ms, the work loop delivers. A queued
      // message is written down the instant Enter lands, so the relay can
      // publish it as a turn before send() has finished confirming it and said
      // "queued". Handling only the other order left the note standing for ever
      // over a message that was already in the conversation — measured on the
      // real board, and the reason this looks for it rather than assuming.
      //
      // And only a turn recorded since the send counts as that. The desk's
      // last user turn saying the same words is, more often than not, the
      // previous nudge — see `sentAfter`.
      const already = store.deskLastUserTurn(channel, agent);
      const mark = live.sentAfter.get(key) ?? 0;
      if (already && already.id > mark && squash(already.text).includes(squash(text))) {
        if (live.delivery.delete(key)) live.publish(key, { type: 'delivery', delivery: null });
        break;
      }
      live.delivery.set(key, {
        state: str(ev.state) ?? 'queued',
        text,
        held: !!ev.held,
        at: now,
      });
      live.publish(key, { type: 'delivery', delivery: live.delivery.get(key) });
      break;
    }

    // What the window is offering, read off its pane. Attached to the prompt the
    // operator is looking at, and only to that one: by the time this arrives the
    // question may already have been answered and replaced.
    case 'prompt': {
      const req = live?.pending.get(key);
      if (!req) {
        console.log(`[orchestratinator] dropped a prompt reading for ${channel}/${agent} — nothing is pending here any more`);
        break;
      }
      const forThis = !str(ev.request_id) || str(ev.request_id) === req.request_id;
      if (!forThis) {
        console.log(`[orchestratinator] dropped a prompt reading for ${channel}/${agent}` +
          ` — it names ${String(ev.request_id).slice(-8)}, the open one is ${String(req.request_id).slice(-8)}`);
        break;
      }
      // The host looked and there is nothing on the pane to answer. That is not
      // an unreadable prompt, it is a prompt that is over — and treating the two
      // alike is what put the could-not-read buttons up straight after a form
      // that had just been answered 12 of 12. Pressing one of them then reported
      // "that did not land" about an answer that had landed perfectly.
      if (str(ev.code) === 'no_prompt' && !(Array.isArray(ev.questions) && ev.questions.length)) {
        live.pending.delete(key);
        store.clearDeskAwaiting(channel, agent);
        live.publish(key, { type: 'permission', request_id: req.request_id, decision: 'gone', resolved: true });
        console.log(`[orchestratinator] ${channel}/${agent}: nothing is being asked — clearing the alert rather than offering a guess at it`);
        break;
      }
      if (Array.isArray(ev.questions) && ev.questions.length) {
        console.log(`[orchestratinator] ${channel}/${agent}: a form of ${ev.questions.length} question(s) attached to the open prompt`);
      }
      req.options = Array.isArray(ev.options) ? ev.options.filter((o) => o && Number.isInteger(o.n)) : [];
      // An AskUserQuestion is a form rather than one menu: a tab per question,
      // each with its own choices. Carried whole so the panel can draw all of it
      // and the operator answers once, instead of the floor driving a terminal
      // widget one keystroke per click.
      req.questions = Array.isArray(ev.questions) ? ev.questions : null;
      req.tabs = Array.isArray(ev.tabs) ? ev.tabs : null;
      // Read, whatever came back. A form that could not be read falls through to
      // the ordinary buttons rather than spinning for ever.
      req.reading = false;
      // Why there are none, kept so the panel can say something better than
      // offering nothing without explanation.
      req.options_error = req.options.length ? null : (str(ev.reason) ?? null);
      // The host has now looked. Until this arrives, "no choices" means nobody
      // has read the window yet — not that the window offered nothing. Without
      // the distinction the panel showed its could-not-read buttons for the
      // second or two every ordinary prompt spends waiting to be read, and an
      // operator who pressed one got a blind keystroke aimed at a prompt the
      // board had not seen.
      req.read = true;
      live.publish(key, { type: 'permission', request: req });
      break;
    }

    case 'error': {
      // Whatever else this is, nothing is quietly on its way any more. Leaving
      // the note up would have the desk showing "queued" beside the error
      // explaining that it was not — and the browser hands the words back to
      // the compose box on an error turn, so the message is not lost by this.
      if (live.delivery.delete(key)) live.publish(key, { type: 'delivery', delivery: null });
      // An answer that never took is not just an error to report — the window
      // is still holding that question, so offer it again rather than leaving
      // the operator to go and find it. The prompt was kept when they answered;
      // this is the one thing that asks for it back.
      const failed = str(ev.code) === 'answer_failed' ? live?.answered.get(key) : null;
      // Re-offering is right once — an answer that genuinely did not take leaves
      // the window still holding the question. It is wrong twice. A failure that
      // is itself mistaken puts the same form back the instant it is answered,
      // and answering is then the one thing that cannot end it: measured as an
      // unbroken "your answers did not land" loop whose only exit was restarting
      // the server. After one go the error stands on its own and the operator is
      // told where to look, which is worse than a working form and far better
      // than a trap.
      const again = failed && (failed.reoffers ?? 0) < 1 ? failed : null;
      if (again) {
        again.reoffers = (again.reoffers ?? 0) + 1;
        live.answered.delete(key);
        live.pending.set(key, again);
        live.publish(key, { type: 'permission', request: again });
      }
      // One message, said in both places. The chat row and the desk's own
      // awaiting line are read by different people at different moments, and a
      // note that only reaches one of them is a note the operator can miss.
      const said = (str(ev.message) ?? 'the host reported an error') +
        (failed && !again ? ' — this is the second time, so the form is not being offered again. Open the window to see what it is holding.' : '');
      turn('error', said);
      // By desk, not by `sessionId`. A host event carries no session id, so the
      // id above is whatever `hosted_desks` happens to hold — and before the
      // host has reported which conversation it is watching, that is a
      // placeholder. An error written there is invisible on the floor, which is
      // the one place it has to show: this is what a decision the host could
      // not deliver looks like, now that the desk stops asking as soon as the
      // operator answers.
      store.setDeskAwaiting(channel, agent, again ? 'permission_request' : 'error', clip(said, 500));
      state(again ? 'awaiting' : 'idle');
      break;
    }

    default:
      return false;
  }
  return true;
}

/**
 * The floor's view: one entry per channel, one desk per agent.
 *
 * Sessions arrive newest-first, so the first one seen for a (channel, agent) is
 * the current one and the rest are that desk's history. A desk exists as soon as
 * a persona does, which means an agent that has posted a single hook event has a
 * seat — the alternative, waiting for it to also appear on the board, would show
 * an empty room to somebody whose windows are plainly open.
 */
export function buildFloor(store, live = null, sessions = null) {
  const nowMs = Date.now();
  const key = deskKey;

  const current = new Map();     // channel+agent -> newest session row

  const sessionCount = new Map();
  for (const s of store.floorSessions()) {
    const k = key(s.channel, s.agent);

    sessionCount.set(k, (sessionCount.get(k) ?? 0) + 1);
    if (!current.has(k)) current.set(k, s);
  }

  const lastTurn = new Map(store.lastTurns().map((t) => [key(t.channel, t.agent), t]));
  const turnCount = new Map(store.turnCounts().map((r) => [key(r.channel, r.agent), r.n]));

  // Hosted desks, with whether their host is actually there to hear us.
  const hosted = new Map();
  for (const h of store.listHostedDesks()) {
    const seen = iso(h.host_seen);
    hosted.set(key(h.channel, h.agent), {
      host_id: h.host_id,
      host_name: h.host_name ?? h.host_id,
      host_seen: seen,
      live: h.state !== 'offline' && secondsSince(seen, nowMs) < HOST_STALE_SECONDS,
      state: h.state,
      cwd: h.cwd,
      sdk_session_id: h.sdk_session_id,
      // Which window the floor drives, and the editor process holding this
      // conversation instead — the two facts that decide whether it can be
      // typed into from here.
      window_id: h.window_id ?? null,
      outside_pid: h.outside_pid ?? null,
      // A window exists in that repo, registered session or not. Distinct from
      // window_id, which means "a window the floor can type into".
      window_open: h.window_open ?? null,
      holders: h.holders ?? 0,
      clients: h.clients ?? 0,
      // The host's tmux session, carried so the floor can name the command to
      // attach to it. This projection is hand-picked, so a column the query
      // selects is not a column the page gets — which is exactly how this one
      // arrived as null while sitting in the database the whole time.
      host_tmux: h.host_tmux ?? null,
    });
  }

  // Every agent the board knows gets a desk, not only the ones whose windows
  // run the plugin. A floor is a channel, and a channel with four agents on the
  // board and one desk in the room is a room that lies about who works there.
  // The desks without a session are drawn as not reporting, which also happens
  // to be the clearest possible reminder of who still needs the plugin.
  // Retired agents stay off, matching the board's default — and off means the
  // desk, not the persona. The persona is kept through retirement on purpose:
  // it is the chair and the colours, and un-retiring (which any tool call from
  // a live agent does by itself — see touchAgent) should seat the agent back
  // where it was, not deal it a new face. So the filter is at the desk, below,
  // against the same column the board reads. It used to be applied only to the
  // sign, which hid the trash can's effect from the floor entirely: an agent
  // removed on the board kept its desk, its bubble and its place in the queue.
  // Archived channels do
  // not — they are carried with a flag and left out of the building by the page.
  // Dropping them here is what this used to do, and it took the way back in with
  // them: a channel absent from the payload has no chip in the floor picker
  // either, so an archived room could be hidden and then never visited again.
  // Hidden is the whole of what archiving claims to do. What archived channels
  // are kept out of is everything that counts as work — the queue and the
  // totals, both below.
  const archived = new Set(store.listChannelFlags().filter((f) => f.archived_at).map((f) => f.channel));
  // The board's row for each agent, kept rather than discarded: the desk's sign
  // shows what the board shows, and that comes off these same columns. A desk
  // can exist without one — a window can post hook events before its agent has
  // ever called an MCP tool — and then there is simply no sign to paint.
  const agentRows = new Map();
  const retired = new Set();
  for (const a of store.listAllAgents()) {
    if (a.retired_at) { retired.add(key(a.channel, a.agent)); continue; }
    agentRows.set(key(a.channel, a.agent), a);
    store.ensurePersona(a.channel, a.agent);
  }
  const load = agentLoadIndex(store);
  // Keyed with deskKey so it lines up with `k` below, not with agent-state's
  // own NUL key.
  const mcp = mcpSessionCounts(sessions, key);

  // The board's channel-header numbers, so a storey can print the same line.
  // Shaped by agent-state.js rather than here — see channelCounts.
  const counts = channelCounts(store);

  const byChannel = new Map();
  const profiles = store.listProfiles();
  for (const p of store.listPersonas()) {
    if (!byChannel.has(p.channel)) byChannel.set(p.channel, []);
    byChannel.get(p.channel).push(p);
  }

  const queue = [];
  const channels = [...byChannel.keys()].sort().map((channel) => {
    const shelved = archived.has(channel);
    const desks = byChannel
      .get(channel)
      .filter((p) => !retired.has(key(channel, p.agent)))
      .sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0) || a.agent.localeCompare(b.agent))
      .map((p) => {
        const k = key(channel, p.agent);
        const h = hosted.get(k) ?? null;
        const s = current.get(k) ?? null;
        const t = lastTurn.get(k) ?? null;
        // Said and did, kept apart, and looked up per desk — see the note on
        // deskLastMessage in db.js for why these are not one query each.
        const m = store.deskLastMessage(channel, p.agent);
        // Has the agent said anything since it was last spoken to? The bubble
        // shows the newest thing an agent said, and between a request landing
        // and the agent's first words there can be minutes — during which the
        // bubble still shows the answer to the *previous* question, so a desk
        // that has just been given new work is indistinguishable from one still
        // grinding on the old. A fact, reported here; the floor picks the words.
        const u = store.deskLastUserTurn(channel, p.agent);
        const heard = !!u && (!m || u.id > m.id);
        const awaitingSince = iso(s?.awaiting_since);
        // Live means "heard from recently", never "still open" — see
        // SESSION_STALE_MINUTES for why both halves of that matter. The one
        // exemption is a desk waiting on a human: no hooks fire while Claude
        // Code sits at a prompt, so that silence is expected, and aging the
        // longest-waiting person out of the queue that exists to surface them
        // would be exactly backwards. The queue shows the wait's age for the
        // same reason the board shows a status's age — `waiting · 2h` reads as
        // suspect on its own, so a prompt in a window somebody force-quit still
        // gets looked at rather than trusted forever.
        // A hosted desk is live exactly as long as its host is: the host says
        // so once a minute, and it is the one watching that repo's window.
        const heardMinutesAgo = s ? (nowMs - Date.parse(iso(s.updated_at))) / 60000 : Infinity;
        const hookLive = !!s && !s.ended_at && (s.awaiting_kind != null || heardMinutesAgo < SESSION_STALE_MINUTES);
        const live_ = h ? h.live : hookLive;
        const pendingReq = live ? live.pending.get(k) ?? null : null;

        // An archived room does not ask for anything. The desks in it are drawn
        // exactly as they are — an agent on an archived channel keeps working,
        // which is a promise the board already makes — but a prompt in a room
        // the operator has put away is not "N need you" on a floor they are
        // looking at, and counting it there is how a queue stops being a queue.
        if (live_ && s?.awaiting_kind && !shelved) {
          queue.push({
            channel,
            agent: p.agent,
            persona: p.persona,
            kind: s.awaiting_kind,
            message: s.awaiting_message,
            since: awaitingSince,
            waiting_seconds: awaitingSince ? Math.max(0, Math.round((nowMs - Date.parse(awaitingSince)) / 1000)) : null,
            cwd: s.cwd,
            // The name of the window to go to. A full path is correct and
            // unreadable; the last segment is what the tab actually says.
            window: s.cwd ? s.cwd.split('/').filter(Boolean).pop() : null,
            session_id: s.session_id,
            // A hosted prompt can be answered right here — but only if the
            // floor can reach the window that is asking. Answering means
            // pressing a key in it, and a conversation open in an editor has
            // no window we can press a key in. Offering the buttons anyway
            // gave a prompt that swallowed a dozen clicks and never closed.
            hosted: !!h && !h.outside_pid,
            held: h?.outside_pid ? 'editor' : null,
            request_id: pendingReq?.request_id ?? null,
          });
        }

        return {
          agent: p.agent,
          persona: p.persona,
          // How to draw this one. Defaulted here rather than in the drawing code
          // so a desk always states it, and an unset agent cannot be told apart
          // from one deliberately set to neutral — they are the same thing.
          gender: profiles[p.agent]?.gender ?? 'neutral',
          // Resolved here, so a desk always states the colour it is drawn in and
          // the drawing code never has to know what a default is. Shirt is the
          // exception that needs no fallback in practice — it is written down
          // the first time a desk is seen — but one is kept for a profile row
          // that predates that.
          shirt: profiles[p.agent]?.shirt ?? shirtForSeat(p.seat ?? 0),
          hair: profiles[p.agent]?.hair ?? DEFAULT_HAIR,
          skin: profiles[p.agent]?.skin ?? DEFAULT_SKIN,
          seat: p.seat ?? 0,
          live: live_,
          // False until this desk's window has posted a single hook event — the
          // one distinction between "away" and "never installed the plugin".
          reporting: !!s,
          hosted: h
            ? {
                host: h.host_name,
                live: h.live,
                state: h.state,
                window: h.cwd ? h.cwd.split('/').filter(Boolean).pop() : null,
                // The conversation the panel is scoped to — whichever one is
                // live in that repo. Before a window has opened, the
                // placeholder the first message is filed under, so the panel is
                // scoped from the first keystroke rather than the first reply.
                session_id: h.sdk_session_id ?? placeholderSession(h.host_id, channel, p.agent),
                // Who is holding this conversation right now.
                //
                // A conversation is one process. When it is open in an editor,
                // the floor cannot type into it — not a failure, just where it
                // is. The floor says so and offers the move, instead of taking
                // a message it cannot deliver.
                held: h.outside_pid ? 'editor' : (h.window_id ? 'floor' : null),
                held_pid: h.outside_pid ?? null,
                // Whether a window is sitting in that repo at all. `held` says
                // null all through Claude Code's startup — nothing can be typed
                // into a window still asking whether it may use an MCP server —
                // and the floor used that to offer opening a window that was
                // already on screen. This is the fact that tells them apart.
                window_open: !!h.window_open,
                // Terminals attached to that host's tmux session. The floor
                // spins its attach link until this rises, so the spinner ends
                // on a terminal really appearing rather than on a clock.
                clients: h.clients ?? 0,
                // Live processes claiming this conversation. More than one is
                // not prevented anywhere; it is simply not survivable, so the
                // floor says so rather than picking one quietly.
                holders: h.holders ?? 0,
                // The session to attach to, as the host itself reported it.
                // Named rather than assumed: ORCH_TMUX_SESSION moves it, and a
                // page that tells someone to run `tmux attach -t orch` against
                // a host whose session is called something else has sent them
                // to a "no such session" at the exact moment they are already
                // convinced this thing is lying to them.
                tmux: h.host_tmux ?? null,
              }
            : null,
          // Whether the bell on this desk rings, decided here rather than on
          // the floor. A client-side re-derivation of this drifted within a
          // day: it read `held` and so treated "no window at all" as no
          // different from "our own window", and offered to nudge an agent
          // whose session had ended the day before. `opens` carries the
          // difference now: the bell rings on such a desk on purpose, and says
          // first that it will open the window — see nudgeable().
          nudge: (() => {
            const v = nudgeable(h, nowMs);
            return v.error
              ? { ok: false, code: v.code, reason: v.error }
              : { ok: true, host: v.hosted.host_name ?? v.hosted.host_id, opens: !!v.opens };
          })(),
          // Whether a turn is running, said once. The desk is drawn from this
          // and the chat panel's stop sign is lit from it, so they cannot
          // disagree about whether there is anything to stop.
          working: isWorking(h, t),
          // And whether that turn can be stopped, decided here for the same
          // reason `nudge` is: the endpoint refuses on exactly this, so a sign
          // that made its own mind up would eventually be live over a 409.
          stop: (() => {
            const v = stoppable(h, t, nowMs);
            return v.error ? { ok: false, code: v.code, reason: v.error } : { ok: true, host: v.hosted.host_name ?? v.hosted.host_id };
          })(),
          // The prompt, plus which of its choices are the three that always
          // show and which get a row of their own. Sorted here so the panel and
          // the endpoint cannot disagree about what "deny" presses.
          permission: pendingReq
            ? { ...pendingReq, choices: promptChoices(pendingReq.options) }
            : null,
          // A message the window has taken but not yet read. Carried on the
          // desk so a page that arrives mid-queue is in the same state as one
          // that watched it happen — the stream event alone would leave a
          // reload showing "sending…" for something already delivered.
          //
          // Aged out as a backstop, not as the mechanism. What ends a note is
          // the message becoming a turn; this only catches the note whose turn
          // never came — a host restarted mid-queue, a window closed on top of
          // it. Without it one such note sat on a desk indefinitely, describing
          // a message from a run that had long finished. Generous on purpose: a
          // queue behind a genuinely long turn is a real thing to be waiting on,
          // and saying so for ten minutes is better than lying after one.
          delivery: (() => {
            const q = live ? live.delivery.get(k) ?? null : null;
            if (!q) return null;
            if (nowMs - Date.parse(q.at) < DELIVERY_STALE_MS) return q;
            live.delivery.delete(k);
            return null;
          })(),
          session: s
            ? {
                session_id: s.session_id,
                cwd: s.cwd,
                window: s.cwd ? s.cwd.split('/').filter(Boolean).pop() : null,
                model: s.model,
                permission_mode: s.permission_mode,
                git_branch: s.git_branch,
                started_at: iso(s.started_at),
                updated_at: iso(s.updated_at),
                ended_at: iso(s.ended_at),
                awaiting_kind: s.awaiting_kind,
                awaiting_message: s.awaiting_message,
                awaiting_since: awaitingSince,
              }
            : null,
          last_turn: t
            ? { role: t.role, text: t.text, tool_name: t.tool_name, at: iso(t.created_at), id: t.id }
            : null,
          // What this agent last said, which is what its thought bubble shows.
          // Separate from last_turn, which stays because it is what tells the
          // floor whether the desk is mid-tool-call and therefore working.
          last_message: m ? { text: m.text, at: iso(m.created_at), id: m.id } : null,
          // Spoken to, and not yet answered.
          heard: heard ? { at: iso(u.created_at), id: u.id } : null,
          // The last few tool calls, oldest first — the desk's monitor types
          // them out. Ids travel with them so the browser can tell a command it
          // has already typed from one that has just arrived.
          commands: store.deskCommands(channel, p.agent, SCREEN_COMMANDS),
          // What the board says about this agent — status, mailbox, task load.
          // Derived by the board's own code (agent-state.js) rather than
          // re-inferred here, so the sign on a desk and the row on the board
          // cannot drift into disagreeing about the same agent.
          board: agentRows.has(k) ? agentBoard(agentRows.get(k), load, nowMs, mcp.get(k) ?? 0) : null,
          turns: turnCount.get(k) ?? 0,
          sessions: sessionCount.get(k) ?? 0,
        };
      });

    return {
      channel,
      // Hidden from the building, still reachable by name. The page decides
      // what that means; this only says which channels it is true of.
      archived: shelved,
      desks,
      live: desks.filter((d) => d.live).length,
      awaiting: desks.filter((d) => d.live && d.session?.awaiting_kind).length,
      // What the board prints in this channel's header. Same numbers, same
      // source, so the two surfaces cannot report different amounts of work.
      stats: counts.get(channel) ?? ZERO_COUNTS,
    };
  });

  // Longest-waiting first: the queue's only job is to answer "who has been stuck
  // on me the longest", and any other order makes the person reading it do that
  // sort in their head.
  queue.sort((a, b) => (b.waiting_seconds ?? 0) - (a.waiting_seconds ?? 0));

  const hosts = store.listHosts().map((h) => ({
    host_id: h.host_id,
    name: h.name,
    last_seen: iso(h.last_seen),
    live: secondsSince(iso(h.last_seen), nowMs) < HOST_STALE_SECONDS,
  }));

  return {
    now: new Date(nowMs).toISOString(),
    channels,
    queue,
    hosts,
    cast: CAST,
    // The totals line describes the building, so it counts the floors in it —
    // archived channels are excluded here exactly as they are from the board's
    // own totals. A footer reading "5 floors" over a building with four is the
    // kind of small lie that gets someone hunting for a room that is not there.
    totals: (() => {
      const onFloor = channels.filter((c) => !c.archived);
      return {
        channels: onFloor.length,
        desks: onFloor.reduce((n, c) => n + c.desks.length, 0),
        live: onFloor.reduce((n, c) => n + c.live, 0),
        awaiting: queue.length,
        hosted: onFloor.reduce((n, c) => n + c.desks.filter((d) => d.hosted?.live).length, 0),
        // What the picker's tail holds, said by the payload rather than counted
        // in the page: the same number the board's "N archived channels" chip
        // shows, from the same flag.
        archived: channels.length - onFloor.length,
      };
    })(),
  };
}

export function createFloorRouter({ store, auth, sessions = null }) {
  const router = express.Router();
  const live = createLive();

  /* ───────────────────── the plugin's door ───────────────────── */

  /**
   * Where each workstation's hook plugin posts. Guarded by the same shared
   * secret as /mcp — see ingestGuard for why it is the same one.
   *
   * Always answers 200 for a well-formed event, even one it decided to ignore.
   * The caller is a hook running inside somebody's turn; a 4xx it can't act on
   * would only ever become noise in a terminal at the exact moment that person
   * is trying to concentrate on something else.
   */
  router.post('/api/ingest', auth.ingestGuard, (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ ok: false, error: 'expected a JSON object' });
    }
    try {
      const result = ingestHookEvent(store, body, live);
      return res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      console.warn(`[orchestratinator] ingest failed: ${err.message}`);
      return res.status(500).json({ ok: false, error: 'ingest failed' });
    }
  });

  /* ───────────────────── the host's doors ───────────────────── */

  /**
   * A host announces itself and the desks it can run. Called at startup and
   * then once a minute as a heartbeat, carrying any permission prompt it is
   * still holding open — which is how `live.pending` survives a server restart
   * without ever being written down.
   *
   * The reply tells the host which SDK session each desk last had, so a host
   * that restarted can resume the conversation rather than start a new one.
   */
  router.post('/api/host/register', auth.ingestGuard, (req, res) => {
    const hostId = str(req.body?.host_id);
    if (!hostId) return res.status(400).json({ error: 'host_id is required' });
    const name = str(req.body?.name) ?? hostId;
    store.registerHost(hostId, name, str(req.body?.tmux));

    const desks = Array.isArray(req.body?.desks) ? req.body.desks : [];
    const accepted = [];
    for (const d of desks) {
      const channel = str(d?.channel);
      const agent = str(d?.agent);
      const cwd = str(d?.cwd);
      if (!channel || !agent || !cwd) continue;
      store.hostDesk(channel, agent, hostId, cwd, {
        windowId: str(d?.window),
        outsidePid: Number(d?.outside_pid) || null,
        windowOpen: str(d?.window_open),
        holders: Number(d?.holders) || 0,
      });
      store.ensurePersona(channel, agent);
      // The conversation the host is following, when it names one. The desk's
      // `session` event is what normally sets this — but it fires once, when
      // the host first adopts a session, and the host's watch loop starts
      // before its first registration. On a desk this host has never registered
      // (a repo rebound to a new channel, say) that one event reaches
      // applyHostEvent before the row exists and is dropped without a word,
      // and nothing re-sends it, because from the host's side nothing changed.
      // Measured 2026-09-02: the host relayed sixty turns under the real id
      // while the desk still said the placeholder, so the chat panel — scoped
      // to the desk's id — showed an empty conversation, and no restart could
      // fix it because a restart re-runs the same race.
      //
      // The heartbeat already carries the id every minute, which makes it the
      // natural self-heal. Applied through the same handler as the event, so
      // it upserts the session, rekeys anything filed under the placeholder and
      // publishes — exactly what the lost event would have done — and only
      // when the id differs, so a heartbeat is not a minute-by-minute touch on
      // a conversation whose window may have closed. A host that names none (it
      // has just restarted) leaves the stored id alone: handing it back is the
      // reply's job, below.
      const named = str(d?.session_id);
      if (named && named !== store.hostedDesk(channel, agent)?.sdk_session_id) {
        applyHostEvent(store, live, hostId, { type: 'session', channel, agent, session_id: named, cwd });
      }
      const row = store.hostedDesk(channel, agent);
      accepted.push({
        channel, agent, cwd,
        sdk_session_id: row?.sdk_session_id ?? null,
      });
    }

    for (const p of Array.isArray(req.body?.pending) ? req.body.pending : []) {
      applyHostEvent(store, live, hostId, { ...p, type: 'permission_request' });
    }

    res.json({ ok: true, host_id: hostId, desks: accepted, work_wait_max_ms: WORK_WAIT_MAX_MS });
  });

  /** A host going away cleanly. Its desks stay, marked offline, so the session
   *  ids they carry survive for the next time it comes back. */
  router.post('/api/host/unregister', auth.ingestGuard, (req, res) => {
    const hostId = str(req.body?.host_id);
    if (!hostId) return res.status(400).json({ error: 'host_id is required' });
    store.setHostState(hostId, 'offline');
    for (const d of store.listHostedDesks().filter((x) => x.host_id === hostId)) {
      const k = deskKey(d.channel, d.agent);
      live.pending.delete(k);
      live.partial.delete(k);
      live.publish(k, { type: 'state', state: 'offline' });
    }
    res.json({ ok: true });
  });

  /**
   * Work for a host: chat messages to deliver, permission decisions to apply,
   * interrupts. Held open for up to `wait` seconds so the host learns about a
   * message within milliseconds of it being typed without polling in a tight
   * loop, and without this server ever connecting *to* a workstation.
   */
  router.get('/api/host/work', auth.ingestGuard, async (req, res) => {
    const hostId = str(req.query.host_id);
    if (!hostId) return res.status(400).json({ error: 'host_id is required' });
    store.touchHost(hostId);
    const waitMs = Math.min(WORK_WAIT_MAX_MS, Math.max(0, Number(req.query.wait) || 0) * 1000);

    let items = store.takeHostWork(hostId);
    if (!items.length && waitMs > 0) {
      let gone = false;
      req.on('close', () => { gone = true; live.wake(hostId); });
      await live.wait(hostId, waitMs);
      if (gone) return;
      items = store.takeHostWork(hostId);
      store.touchHost(hostId);
    }
    res.json({ work: items });
  });

  /** What a host's desks are doing. A batch, because a streaming reply would
   *  otherwise be one HTTP request per token. */
  router.post('/api/host/events', auth.ingestGuard, (req, res) => {
    const hostId = str(req.body?.host_id);
    if (!hostId) return res.status(400).json({ error: 'host_id is required' });
    store.touchHost(hostId);
    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    let applied = 0;
    for (const ev of events) {
      try {
        if (ev && typeof ev === 'object' && applyHostEvent(store, live, hostId, ev)) applied++;
      } catch (err) {
        console.warn(`[orchestratinator] host event failed: ${err.message}`);
      }
    }
    res.json({ ok: true, applied });
  });

  /* ───────────────────── the browser's doors ───────────────────── */

  router.get('/api/floor', (_req, res) => {
    res.json(buildFloor(store, live, sessions));
  });

  /**
   * One desk's conversation. `since` is a turn id, so the panel can poll for
   * just what's new rather than refetching a whole conversation every couple of
   * seconds while somebody reads it.
   */
  router.get('/api/floor/turns', (req, res) => {
    const channel = str(req.query.channel);
    const agent = str(req.query.agent);
    if (!channel || !agent) return res.status(400).json({ error: 'channel and agent are required' });
    const since = Math.max(0, Number(req.query.since) || 0);
    const limit = Math.min(TURNS_MAX, Math.max(1, Number(req.query.limit) || TURNS_DEFAULT));
    const session = str(req.query.session);
    // A conversation can span session ids — a fork carries its parent's
    // history — so the filter is the chain, not the one id.
    const sessions = session ? store.sessionChain(session) : null;
    const rows = store.recentTurns(channel, agent, { since, limit, sessions }).map((r) => ({
      ...r,
      created_at: iso(r.created_at),
    }));
    res.json({ channel, agent, since, session, sessions, count: rows.length, rows, partial: live.partial.get(deskKey(channel, agent)) ?? '' });
  });

  /**
   * A desk, live. Server-sent events: each new turn, the reply as it streams,
   * state changes, and permission prompts as they open and close. Read-only,
   * like every other GET here, and it degrades to the two-second poll if a
   * proxy in the way doesn't like long responses.
   */
  router.get('/api/floor/stream', (req, res) => {
    const channel = str(req.query.channel);
    const agent = str(req.query.agent);
    if (!channel || !agent) return res.status(400).json({ error: 'channel and agent are required' });
    const key = deskKey(channel, agent);

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const send = (ev) => { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* closed */ } };

    // What's true right now, so a panel that just opened doesn't wait for the
    // next event to learn there is a reply mid-stream or a prompt open.
    if (live.partial.get(key)) send({ type: 'partial', text: live.partial.get(key) });
    if (live.pending.get(key)) send({ type: 'permission', request: live.pending.get(key) });
    if (live.delivery.get(key)) send({ type: 'delivery', delivery: live.delivery.get(key) });

    const unsubscribe = live.subscribe(key, send);
    const heartbeat = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* closed */ } }, 15_000);
    req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
  });

  /**
   * Rename whoever sits at a desk. An operator action, so it takes the same CSRF
   * guard as the rest of them and is written where every viewer will see it —
   * a cast that only one browser agrees with is worse than no cast at all.
   */
  router.post('/api/floor/persona', auth.adminGuard, (req, res) => {
    const channel = str(req.body?.channel);
    const agent = str(req.body?.agent);
    const persona = str(req.body?.persona);
    if (!channel || !agent || !persona) {
      return res.status(400).json({ error: 'channel, agent and persona are required' });
    }
    if (persona.length > 40) return res.status(400).json({ error: 'persona must be 40 characters or fewer' });
    const changes = store.setProfile(channel, agent, { persona });
    store.logAdmin(channel, 'persona.set', { target: agent, detail: persona });
    res.json({ ok: true, changes, channel, agent, persona });
  });

  /**
   * Everything an operator chooses about an agent, in one edit.
   *
   * Both fields are optional and only what is sent is written, so the dialog can
   * save a name and an avatar together without either having to know the other's
   * current value. Applies to every channel at once, like the name it extends.
   */
  router.post('/api/floor/profile', auth.adminGuard, (req, res) => {
    const channel = str(req.body?.channel);
    const agent = str(req.body?.agent);
    if (!channel || !agent) return res.status(400).json({ error: 'channel and agent are required' });

    const patch = {};
    if (req.body?.persona !== undefined) {
      const persona = str(req.body.persona);
      if (!persona) return res.status(400).json({ error: 'persona cannot be empty — omit it to leave the name alone' });
      if (persona.length > 40) return res.status(400).json({ error: 'persona must be 40 characters or fewer' });
      patch.persona = persona;
    }
    if (req.body?.gender !== undefined) {
      const gender = str(req.body.gender);
      // Refused rather than silently coerced: a value this does not know would
      // otherwise be stored and then draw as neutral forever, looking saved.
      if (!GENDERS.includes(gender)) {
        return res.status(400).json({ error: `gender must be one of ${GENDERS.join(', ')}` });
      }
      patch.gender = gender;
    }
    // Colours are checked against the same lists the picker is drawn from, so
    // the only values that reach the database are ones an operator could have
    // clicked. An arbitrary hex would render — which is exactly why it has to
    // be refused here rather than trusted: nothing downstream would notice.
    for (const field of ['shirt', 'hair', 'skin']) {
      if (req.body?.[field] === undefined) continue;
      const value = str(req.body[field]);
      if (!PALETTE[field].includes(value)) {
        return res.status(400).json({ error: `${field} must be one of the ${PALETTE[field].length} colours offered for it` });
      }
      patch[field] = value;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to change' });

    const changes = store.setProfile(channel, agent, patch);
    for (const [k, v] of Object.entries(patch)) {
      store.logAdmin(channel, k === 'persona' ? 'persona.set' : 'avatar.set', { target: agent, detail: `${k}: ${v}` });
    }
    res.json({ ok: true, changes, channel, agent, ...patch });
  });

  /** A hosted desk that can take a message right now, or the reason it can't. */
  const hostedOrWhyNot = (channel, agent) => deliverable(store.hostedDesk(channel, agent));

  /**
   * Say something to a hosted desk. The message is a user turn in that session:
   * recorded here, handed to the host, and answered in the same conversation.
   * Refused, with the reason, when nothing is there to receive it — the floor
   * would rather say "the host is offline" than swallow a message.
   */
  router.post('/api/floor/chat', auth.adminGuard, (req, res) => {
    const channel = str(req.body?.channel);
    const agent = str(req.body?.agent);
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!channel || !agent || !text) return res.status(400).json({ error: 'channel, agent and text are required' });
    if (text.length > CHAT_MAX) return res.status(400).json({ error: `text must be ${CHAT_MAX} characters or fewer` });
    const check = hostedOrWhyNot(channel, agent);
    if (check.error) return res.status(409).json(check);

    const h = check.hosted;
    // The message is not written down here.
    //
    // It used to be, the moment it was accepted, and it was then written a
    // second time when the mirror read it back out of the window's own
    // transcript — so every message you sent appeared on the floor twice. The
    // deeper problem was that the first copy was a claim rather than a fact:
    // it appeared identically whether the window took the message or dropped
    // it. The conversation is what the window recorded, and nothing else, so
    // this enqueues the work and lets the mirror say what actually happened.
    // The page shows your message as sending until it comes back.
    // The host does the delivery: it types this into the desk's window, the
    // same window the person's own terminal is attached to. Nothing has to be
    // handed over first, so there is nothing to say here about whose turn it is.
    //
    // Mark where the conversation stood, so the delivery report can tell this
    // message's turn from an older one that says the same words — see sentAfter.
    live.sentAfter.set(deskKey(channel, agent), store.deskLastUserTurn(channel, agent)?.id ?? 0);
    store.enqueueHostWork(h.host_id, channel, agent, 'chat', { text });
    live.wake(h.host_id);
    res.json({ ok: true, host: h.host_name ?? h.host_id });
  });

  /**
   * Move this desk's conversation into the editor.
   *
   * One process holds a conversation. If the floor has it open in a window of
   * its own, that window is closed first — two processes on one transcript is
   * the bug that made a message get answered by a copy nobody was watching.
   */
  router.post('/api/floor/handback', auth.adminGuard, (req, res) => {
    const channel = str(req.body?.channel);
    const agent = str(req.body?.agent);
    if (!channel || !agent) return res.status(400).json({ error: 'channel and agent are required' });
    const h = store.hostedDesk(channel, agent);
    if (!h) return res.status(409).json({ error: 'No host on this board is running that repo.', code: 'not_hosted' });
    store.enqueueHostWork(h.host_id, channel, agent, 'handback', {});
    live.wake(h.host_id);
    res.json({ ok: true });
  });


  /**
   * Move this desk's conversation onto the floor: open a window for it here.
   *
   * The other half of handback, and it was missing. The host has always known
   * how to do this — `case 'open'` opens the window and waits for it to come
   * up — but nothing ever asked, so the only way back from an editor was to
   * close the tab and then say something, because delivering a message opens a
   * window as a side effect. That left a desk sitting with no window and no way
   * to be given one, which reads as the floor having lost it.
   *
   * Refused while an editor still holds it. A conversation is one process, and
   * opening a window for one the editor has open is how you get two live copies
   * of the same transcript — the thing handback closes its own window to avoid.
   */
  router.post('/api/floor/open', auth.adminGuard, (req, res) => {
    const channel = str(req.body?.channel);
    const agent = str(req.body?.agent);
    if (!channel || !agent) return res.status(400).json({ error: 'channel and agent are required' });
    const h = store.hostedDesk(channel, agent);
    if (!h) return res.status(409).json({ error: 'No host on this board is running that repo.', code: 'not_hosted' });
    if (h.outside_pid) {
      return res.status(409).json({
        error: 'This conversation is open in your editor. Close it there first — one app holds a conversation at a time.',
        code: 'held_by_editor',
      });
    }
    if (h.window_id) return res.json({ ok: true, already: true });
    store.enqueueHostWork(h.host_id, channel, agent, 'open', {});
    live.wake(h.host_id);
    res.json({ ok: true });
  });

  /**
   * Open a terminal on the host, already attached to its tmux session.
   *
   * The escape hatch. Every other control on this page works by the floor
   * reading a pane and typing into it, which means every one of them fails the
   * same way: when the parse is wrong, the page is confidently wrong, and there
   * is no way from here to see what is actually on screen. This is that way.
   *
   * Deliberately *not* a seat change, and this is the whole design of it.
   * `open` and `handback` move which app holds the conversation, because a
   * conversation is one process and only its holder can type. Attaching moves
   * nothing: tmux is built for many clients on one session, so this adds a
   * second pair of eyes on the window the floor already holds. `held` does not
   * change, no window is opened or closed, and nothing in the UI waits for a
   * seat that is never going to move.
   *
   * It also does not stop being useful when the rest of this does. The refusals
   * carry the command precisely so a 409 here still gets somebody to a prompt.
   */
  router.post('/api/floor/attach', auth.adminGuard, (req, res) => {
    const channel = str(req.body?.channel);
    const agent = str(req.body?.agent);
    if (!channel || !agent) return res.status(400).json({ error: 'channel and agent are required' });
    const can = attachable(store.hostedDesk(channel, agent));
    if (can.error) return res.status(409).json({ error: can.error, code: can.code, cmd: can.cmd ?? null });
    store.enqueueHostWork(can.hosted.host_id, channel, agent, 'attach', {});
    live.wake(can.hosted.host_id);
    // Queued, and said as queued. The host opens the terminal on its next poll;
    // if that fails it says so in its own error turn on this desk, which is the
    // only place that can honestly report it.
    res.json({ ok: true, queued: true, cmd: can.cmd });
  });

  /**
   * Open this desk in claude CLI: a terminal landed on the desk's own window,
   * opened first if the floor has none.
   *
   * Deliberately not a seat change, same as attach — the window stays on the
   * floor, which keeps driving it, and closing the terminal is always safe
   * because closing a tmux client is a detach, not an exit. The "hand the
   * conversation to a bare `claude --resume` outside tmux" version of this
   * button was considered and rejected: it buys nothing (the floor's window IS
   * claude CLI) and closing that terminal would SIGHUP the conversation dead.
   */
  router.post('/api/floor/claude', auth.adminGuard, (req, res) => {
    const channel = str(req.body?.channel);
    const agent = str(req.body?.agent);
    if (!channel || !agent) return res.status(400).json({ error: 'channel and agent are required' });
    const can = claudeable(store.hostedDesk(channel, agent));
    if (can.error) return res.status(409).json({ error: can.error, code: can.code, cmd: can.cmd ?? null });
    store.enqueueHostWork(can.hosted.host_id, channel, agent, 'claude', {});
    live.wake(can.hosted.host_id);
    res.json({ ok: true, queued: true, cmd: can.cmd });
  });

  /**
   * Answer a permission prompt a hosted desk is holding open. This is the
   * human-in-the-middle, done from the floor: the same decision the window
   * would have asked for, recorded as an operator action so the log can say
   * who allowed what.
   */
  router.post('/api/floor/permission', auth.adminGuard, (req, res) => {
    const channel = str(req.body?.channel);
    const agent = str(req.body?.agent);
    const requestId = str(req.body?.request_id);
    const decision = str(req.body?.decision);
    // Only a refusal carries one, and only up to a length a terminal will take
    // in one paste. Null and empty are different: null is "no box was opened",
    // empty is "the operator opened it and sent nothing", and both must still
    // submit — a reason box left standing is the state this exists to end.
    const reason = decision === 'deny' && typeof req.body?.reason === 'string'
      ? clip(req.body.reason, 2000)
      : null;
    // Three named answers and, when the board has read the window's list, any
    // numbered choice on it. The number is validated against that list below
    // rather than trusted: this ends as a keystroke in somebody's window.
    const named = ['allow', 'deny', 'cancel'].includes(decision);
    if (!channel || !agent || !requestId || !(named || /^[1-9]$/.test(decision ?? ''))) {
      return res.status(400).json({
        error: 'channel, agent, request_id and a decision of allow, deny, cancel or a choice number are required',
      });
    }
    const check = hostedOrWhyNot(channel, agent);
    if (check.error) return res.status(409).json(check);
    const key = deskKey(channel, agent);
    const pendingReq = live.pending.get(key);
    if (!pendingReq || pendingReq.request_id !== requestId) {
      return res.status(409).json({ error: 'That prompt is no longer open.', code: 'stale_request' });
    }

    // Turn the answer into the key the window will actually take.
    //
    // "No" is not always 3, and Escape is not the same as choosing it — the
    // prompt's own footer lists them apart. So when the options have been read,
    // approve and deny become that prompt's own numbers; when they have not,
    // they fall back to the host's defaults, which is what happened before any
    // of this existed.
    const choices = promptChoices(pendingReq.options);
    let send = decision;
    if (decision === 'allow' && choices.approve) send = String(choices.approve);
    else if (decision === 'deny' && choices.deny) send = String(choices.deny);
    else if (!named) {
      const known = (pendingReq.options ?? []).some((o) => String(o.n) === decision);
      if (!known) {
        return res.status(409).json({
          error: 'that choice is not on the window any more',
          code: 'stale_choice',
        });
      }
    }

    // One decision per prompt, taken here rather than queued once per click.
    //
    // Every click used to enqueue its own work item. When the window that
    // asked could not be reached, nothing visibly happened, so the button got
    // pressed again — and once a window did exist, twenty-nine queued
    // approvals arrived in it as twenty-nine keystrokes, which submitted
    // themselves as a message. Clearing the prompt first makes the second
    // click a no-op instead of a stored one.
    live.pending.delete(key);
    // Kept, not dropped: this is the only copy of the question, and if the host
    // reports that the keystroke never took it is what gets offered again.
    live.answered.set(key, { ...pendingReq, answered_at: Date.now() });
    // And the desk stops asking, now, rather than when the window gets round to
    // saying so.
    //
    // `awaiting_kind` is the hook's word, and the hook only clears it once
    // Claude Code has actually moved on — a host round trip and a poll later.
    // For those seconds the board kept the alert up, the exclamation mark on the
    // desk, and the count in the header, all describing a decision that had
    // already been made. With prompts arriving back to back that is worse than
    // untidy: the indicator for the one you answered is indistinguishable from
    // the one for the next, so the next goes unnoticed.
    //
    // Cleared here rather than in each browser so every watcher agrees, and
    // because "someone decided" is a fact about the board, not about a tab.
    //
    // The risk this takes is that a decision the host cannot deliver goes quiet.
    // That is covered at the other end: the host reports a failed answer as an
    // error event, which raises awaiting again with what went wrong (see
    // host/index.js, case 'permission').
    store.clearDeskAwaiting(channel, agent);
    live.publish(key, { type: 'permission', request_id: requestId, decision, resolved: true });
    store.enqueueHostWork(check.hosted.host_id, channel, agent, 'permission', {
      request_id: requestId, decision: send, message: str(req.body?.message), reason, queued_at: Date.now(),
    });
    live.wake(check.hosted.host_id);
    // A row reading "permission.3" tells nobody anything a year later, so a
    // numbered choice is logged by what it said.
    const chosen = named ? null : (pendingReq.options ?? []).find((o) => String(o.n) === decision);
    store.logAdmin(channel, `permission.${named ? decision : 'choice'}`, {
      target: agent,
      detail: chosen ? `${chosen.text} — ${pendingReq.summary}` : pendingReq.summary,
    });
    res.json({ ok: true, request_id: requestId, decision, sent: send });
  });

  /**
   * Answer a whole AskUserQuestion form in one go.
   *
   * Deliberately not one request per click. Answering a question is a sequence
   * of keystrokes into a live widget — digits, Tab, Enter, typed text — and
   * driving that a click at a time would put every intermediate state on the
   * network, with the window free to move underneath between them. The operator
   * fills the form in on the floor, presses once, and the host plays the whole
   * thing with a check before every key.
   */
  router.post('/api/floor/answer', auth.adminGuard, (req, res) => {
    const channel = str(req.body?.channel);
    const agent = str(req.body?.agent);
    const requestId = str(req.body?.request_id);
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : null;
    if (!channel || !agent || !requestId || !answers) {
      return res.status(400).json({ error: 'channel, agent, request_id and an answers array are required' });
    }
    const check = hostedOrWhyNot(channel, agent);
    if (check.error) return res.status(409).json(check);
    const key = deskKey(channel, agent);
    const pendingReq = live.pending.get(key);
    if (!pendingReq || pendingReq.request_id !== requestId) {
      return res.status(409).json({ error: 'That prompt is no longer open.', code: 'stale_request' });
    }
    if (!pendingReq.questions?.length) {
      return res.status(409).json({ error: 'That prompt is not a question form.', code: 'not_a_form' });
    }

    const steps = answerSteps(pendingReq.questions, answers);
    live.pending.delete(key);
    live.answered.set(key, { ...pendingReq, answered_at: Date.now() });
    store.clearDeskAwaiting(channel, agent);
    live.publish(key, { type: 'permission', request_id: requestId, decision: 'answered', resolved: true });
    store.enqueueHostWork(check.hosted.host_id, channel, agent, 'answer', {
      request_id: requestId, steps, queued_at: Date.now(),
    });
    live.wake(check.hosted.host_id);
    // What was chosen, in the window's own words, so the log is readable later.
    const said = pendingReq.questions.map((q, i) => {
      const a = answers[i] ?? {};
      const picked = (a.choose ?? []).map((n) => q.options?.find((o) => o.n === n)?.text ?? `#${n}`);
      return `${q.question ?? `question ${i + 1}`}: ${[...picked, a.text].filter(Boolean).join(', ') || '(nothing)'}`;
    }).join(' · ');
    // Taking a single-select's free-text row withdraws the form rather than
    // answering it, so this is a different event from an answer and is recorded
    // as one — the choices on the other tabs were never delivered.
    const clarify = steps.some((st) => st.clarify);
    // Queued after the answer, and read in order by the host, so the words
    // arrive at a composer that the decline has just put there.
    if (clarify) {
      const words = answers.map((a) => (typeof a?.text === 'string' ? a.text.trim() : '')).find(Boolean);
      if (words) store.enqueueHostWork(check.hosted.host_id, channel, agent, 'chat', { text: clip(words, 4000) });
    }
    store.logAdmin(channel, clarify ? 'permission.clarified' : 'permission.answered',
      { target: agent, detail: clip(said, 500) });
    res.json({ ok: true, request_id: requestId, steps: steps.length, clarify });
  });

  /** Stop the current turn on a hosted desk. */
  /**
   * Press yes or no at a prompt the floor could not read.
   *
   * Every other answer route matches a request_id, because it is answering
   * something the board parsed and drew. This one exists for when that failed:
   * the desk reports it is waiting, and nothing here can say on what. There is
   * no request to name, so there is none required.
   *
   * That makes it looser than the others by design, and the safety lives one
   * layer down instead: the host refuses to send anything at a window that is
   * back at its composer. What is refused *here* is only what the panel already
   * knows — a desk with no reachable window, and a desk that is not waiting at
   * all, so a stale page cannot press keys into a conversation that moved on.
   */
  router.post('/api/floor/press', auth.adminGuard, (req, res) => {
    const channel = str(req.body?.channel);
    const agent = str(req.body?.agent);
    const choice = str(req.body?.choice);
    if (!channel || !agent) return res.status(400).json({ error: 'channel and agent are required' });
    if (choice !== 'yes' && choice !== 'no') {
      return res.status(400).json({ error: 'choice must be yes or no', code: 'bad_choice' });
    }
    const check = hostedOrWhyNot(channel, agent);
    if (check.error) return res.status(409).json(check);
    // The newest window on the desk, which is the one the panel drew from.
    const waiting = store.liveHookSessions(channel, agent).some((s) => s.awaiting_kind);
    if (!waiting) {
      return res.status(409).json({ error: 'That desk is not waiting on anything.', code: 'not_waiting' });
    }
    store.enqueueHostWork(check.hosted.host_id, channel, agent, 'press', { choice, queued_at: Date.now() });
    live.wake(check.hosted.host_id);
    store.logAdmin(channel, 'permission.pressed', { target: agent, detail: `${choice} at an unreadable prompt` });
    res.json({ ok: true, choice });
  });

  router.post('/api/floor/interrupt', auth.adminGuard, (req, res) => {
    const channel = str(req.body?.channel);
    const agent = str(req.body?.agent);
    if (!channel || !agent) return res.status(400).json({ error: 'channel and agent are required' });
    // stoppable(), not deliverable(): this ends in Escape being pressed in a
    // tmux pane, so there has to be one, and there has to be something in it to
    // interrupt. Both facts are what the panel's sign was drawn from — checking
    // anything looser here is how a live sign and a refusing server drift apart.
    const check = stoppable(store.hostedDesk(channel, agent), store.deskLastTurn(channel, agent));
    if (check.error) return res.status(409).json(check);
    store.enqueueHostWork(check.hosted.host_id, channel, agent, 'interrupt', {});
    live.wake(check.hosted.host_id);
    store.logAdmin(channel, 'interrupt', { target: agent });
    res.json({ ok: true });
  });

  return router;
}
